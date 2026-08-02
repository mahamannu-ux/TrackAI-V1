import 'dotenv/config';

import path from 'node:path';
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  developerMachines,
  machineCredentials,
  machineRepositoryGrants,
  repositoryEnrollments,
  scmRepositories,
  ssoTenants,
} from '../../core/db/schema';
import { canonicalRepositoryUrl } from '../telemetry/repository-url';
import {
  assertOwnerOnlyDirectory,
  atomicWriteOwnerOnly,
  readOwnerOnlyFile,
} from './task4-wave4-local-file';

const CREDENTIAL_PATTERN = /^trk_v1\.([A-Za-z0-9_-]{16})\.[A-Za-z0-9_-]{43}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedApiBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Client policy API URL cannot contain credentials, query, or fragment');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Client policy API URL must use HTTPS except for local loopback');
  }
  return url.toString().replace(/\/$/, '');
}

async function main(): Promise<void> {
  const domain = required('TASK4_CLIENT_POLICY_TENANT_DOMAIN').toLowerCase();
  const installationId = required('TASK4_CLIENT_POLICY_INSTALLATION_ID');
  const apiBaseUrl = normalizedApiBaseUrl(required('TASK4_CLIENT_POLICY_API_BASE_URL'));
  const runtimeDir = required('TASK4_MACHINE_KEYRING_DIR');
  const requestedKeyId = process.env.TASK4_CLIENT_POLICY_CREDENTIAL_KEY_ID?.trim();
  const apply = process.env.TASK4_CLIENT_POLICY_APPLY === '1';
  if (!path.isAbsolute(runtimeDir)) throw new Error('TASK4_MACHINE_KEYRING_DIR must be absolute');

  const [tenant] = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants).where(eq(ssoTenants.domain, domain)).limit(1);
  if (!tenant) throw new Error('Client policy tenant was not found');
  const [machine] = await db.select({ id: developerMachines.id })
    .from(developerMachines).where(and(
      eq(developerMachines.tenantId, tenant.id),
      eq(developerMachines.installationId, installationId),
      eq(developerMachines.status, 'active'),
      isNull(developerMachines.revokedAt),
    )).limit(1);
  if (!machine) throw new Error('Active client policy machine was not found');

  const credentials = await db.select({ keyId: machineCredentials.keyId })
    .from(machineCredentials).where(and(
      eq(machineCredentials.tenantId, tenant.id),
      eq(machineCredentials.machineId, machine.id),
      eq(machineCredentials.status, 'active'),
      isNull(machineCredentials.revokedAt),
      or(isNull(machineCredentials.expiresAt), gt(machineCredentials.expiresAt, new Date())),
    )).orderBy(desc(machineCredentials.issuedAt));
  if (credentials.length === 0 || credentials.length > 2) {
    throw new Error('Client policy machine must have one active credential or one staged overlap');
  }
  const selectedCredential = requestedKeyId
    ? credentials.find(credential => credential.keyId === requestedKeyId)
    : credentials.length === 1 ? credentials[0] : undefined;
  if (!selectedCredential) {
    throw new Error(credentials.length === 2
      ? 'TASK4_CLIENT_POLICY_CREDENTIAL_KEY_ID must select one active overlap key'
      : 'Requested client policy credential is not active');
  }

  const now = new Date();
  const grantRows = await db.select({
    repositoryUrl: scmRepositories.normalizedUrl,
    fallbackUrl: scmRepositories.url,
    branchPatterns: machineRepositoryGrants.branchPatterns,
  }).from(machineRepositoryGrants).innerJoin(repositoryEnrollments, and(
    eq(repositoryEnrollments.tenantId, machineRepositoryGrants.tenantId),
    eq(repositoryEnrollments.id, machineRepositoryGrants.enrollmentId),
  )).innerJoin(scmRepositories, and(
    eq(scmRepositories.tenantId, repositoryEnrollments.tenantId),
    eq(scmRepositories.id, repositoryEnrollments.repositoryId),
  )).where(and(
    eq(machineRepositoryGrants.tenantId, tenant.id),
    eq(machineRepositoryGrants.machineId, machine.id),
    eq(machineRepositoryGrants.status, 'active'),
    lte(machineRepositoryGrants.effectiveFrom, now),
    or(isNull(machineRepositoryGrants.effectiveUntil), gt(machineRepositoryGrants.effectiveUntil, now)),
    eq(repositoryEnrollments.status, 'active'),
    lte(repositoryEnrollments.effectiveFrom, now),
    or(isNull(repositoryEnrollments.effectiveUntil), gt(repositoryEnrollments.effectiveUntil, now)),
  ));
  if (grantRows.length === 0) throw new Error('Client policy machine has no active repository grants');

  const keyringPath = path.join(runtimeDir, 'trackai-machine-credentials.json');
  await assertOwnerOnlyDirectory(runtimeDir);
  const keyring = JSON.parse(await readOwnerOnlyFile(keyringPath)) as {
    version?: unknown; credentials?: unknown;
  };
  if (keyring.version !== 1 || !Array.isArray(keyring.credentials)) {
    throw new Error('Client machine keyring is invalid');
  }
  const keyIds = keyring.credentials.map(value => {
    if (typeof value !== 'string') throw new Error('Client machine keyring is invalid');
    const match = CREDENTIAL_PATTERN.exec(value);
    if (!match) throw new Error('Client machine keyring is invalid');
    return match[1];
  });
  if (!keyIds.includes(selectedCredential.keyId)) {
    throw new Error('Active server credential is absent from the local keyring');
  }

  const repositories = [...new Set(grantRows.map(row => (
    canonicalRepositoryUrl(row.repositoryUrl ?? row.fallbackUrl)
  )))]
    .sort().map(repositoryUrl => ({
      repository_url: repositoryUrl,
      tenant_id: tenant.id,
      api_base_url: apiBaseUrl,
      credential_key_id: selectedCredential.keyId,
    }));
  const policyPath = path.join(runtimeDir, 'trackai-delivery-policy.json');
  let policyExists = false;
  try {
    const currentPolicy = JSON.parse(await readOwnerOnlyFile(policyPath)) as {
      version?: unknown;
      repositories?: Array<{ tenant_id?: unknown }>;
    };
    if (currentPolicy.version !== 1 || !Array.isArray(currentPolicy.repositories)
      || currentPolicy.repositories.some(repository => repository.tenant_id !== tenant.id)) {
      throw new Error('Existing client policy does not belong entirely to the selected tenant');
    }
    policyExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`tenant=${tenant.domain}`);
  console.log(`installation_id=${installationId}`);
  console.log(`active_key_id=${selectedCredential.keyId}`);
  console.log(`active_server_credentials=${credentials.length}`);
  console.log(`repositories=${repositories.length}`);
  for (const repository of repositories) console.log(`repository=${repository.repository_url}`);
  console.log(`api_base_url=${apiBaseUrl}`);
  console.log('keyring=owner-only-and-matching');
  console.log(`policy_file=${policyPath}`);
  if (!apply) {
    console.log('filesystem_changes=none');
    console.log('database_changes=none');
    console.log('next=rerun-with-explicit-apply-after-review');
    return;
  }

  await atomicWriteOwnerOnly(
    policyPath,
    `${JSON.stringify({ version: 1, repositories }, null, 2)}\n`,
  );
  console.log(`policy=${policyExists ? 'replaced' : 'created'}`);
  console.log('policy_permissions=600');
  console.log('credential_value=never-printed-or-copied');
  console.log('database_changes=none');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Client policy installation failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
