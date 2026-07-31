import 'dotenv/config';

import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { scmRepositories, ssoTenants } from '../../core/db/schema';
import {
  issueMachineCredential,
  registerDeveloperMachine,
  revokeDeveloperMachine,
} from '../../core/security/machine-security-service';
import {
  enrollRepository,
  grantMachineRepository,
  revokeMachineRepositoryGrant,
  revokeRepositoryEnrollment,
} from '../../core/security/repository-security-service';

const FIXTURES = [
  {
    label: 'company_a',
    domain: 'purpletealabs.net',
    normalizedUrl: 'github.com/mahamannu-ai/git-ai-teamz-lab',
    repositoryUrl: 'https://github.com/mahamannu-ai/git-ai-teamz-lab',
  },
  {
    label: 'company_b',
    domain: 'customer-b-oidc.com',
    normalizedUrl: 'github.com/customer-b-corp-ai/concurrency_engine_for_webhook_tests',
    repositoryUrl: 'https://github.com/customer-b-corp-ai/concurrency_engine_for_webhook_tests',
  },
] as const;

type SetupEntry = {
  label: string;
  tenantId: string;
  repositoryId: string;
  repositoryUrl: string;
  machineId: string;
  credentialId: string;
  keyId: string;
  enrollmentId: string;
  grantId: string;
};

type ProvisionedEntry = SetupEntry & { plaintext: string };

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function main(): Promise<void> {
  const runtimeDirValue = process.env.TASK4_WAVE2_RUNTIME_DIR?.trim();
  if (!runtimeDirValue) throw new Error('TASK4_WAVE2_RUNTIME_DIR is required');
  const apiBaseUrl = (process.env.TASK4_WAVE2_API_BASE_URL ?? 'http://127.0.0.1:8080')
    .trim().replace(/\/$/, '');
  const parsedApiUrl = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(parsedApiUrl.protocol)
    || parsedApiUrl.username || parsedApiUrl.password
    || parsedApiUrl.search || parsedApiUrl.hash) {
    throw new Error('TASK4_WAVE2_API_BASE_URL must be a credential-free HTTP(S) URL');
  }

  const runtimeDir = resolve(runtimeDirValue);
  const policyPath = join(runtimeDir, 'trackai-delivery-policy.json');
  const credentialPath = join(runtimeDir, 'trackai-machine-credentials.json');
  const manifestPath = join(runtimeDir, 'task4-wave2-client-manifest.json');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  for (const path of [policyPath, credentialPath, manifestPath]) {
    if (await fileExists(path)) {
      throw new Error(`Refusing to overwrite existing Wave 2 runtime file: ${path}`);
    }
  }

  const actorId = `task4-wave2-live-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const provisioned: ProvisionedEntry[] = [];
  const writtenFiles: string[] = [];
  const createdMachines: Array<{ tenantId: string; id: string }> = [];
  const createdEnrollments: Array<{ tenantId: string; id: string }> = [];
  const createdGrants: Array<{ tenantId: string; id: string }> = [];

  try {
    for (const fixture of FIXTURES) {
      const [row] = await db.select({
        tenantId: ssoTenants.id,
        repositoryId: scmRepositories.id,
      }).from(ssoTenants).innerJoin(scmRepositories, and(
        eq(scmRepositories.tenantId, ssoTenants.id),
        eq(scmRepositories.normalizedUrl, fixture.normalizedUrl),
      )).where(sql`lower(${ssoTenants.domain}) = ${fixture.domain}`).limit(1);
      if (!row) throw new Error(`Tenant repository fixture is missing for ${fixture.label}`);

      const machine = await registerDeveloperMachine({
        tenantId: row.tenantId,
        installationId: `${actorId}-${fixture.label}`,
        displayName: `Task4 Wave 2 ${fixture.label}`,
        platform: 'single-mac-two-logical-profiles',
        actorId,
      });
      createdMachines.push({ tenantId: row.tenantId, id: machine.id });
      const credential = await issueMachineCredential({
        tenantId: row.tenantId,
        machineId: machine.id,
        actorId,
        expiresAt,
      });
      const enrollment = await enrollRepository({
        tenantId: row.tenantId,
        repositoryId: row.repositoryId,
        actorId,
        reason: 'Task4 Wave 2 live client verification',
      });
      createdEnrollments.push({ tenantId: row.tenantId, id: enrollment.id });
      const grant = await grantMachineRepository({
        tenantId: row.tenantId,
        machineId: machine.id,
        enrollmentId: enrollment.id,
        branchPatterns: ['task4-wave2/*'],
        actorId,
        reason: 'Task4 Wave 2 live client verification',
      });
      createdGrants.push({ tenantId: row.tenantId, id: grant.id });
      provisioned.push({
        label: fixture.label,
        tenantId: row.tenantId,
        repositoryId: row.repositoryId,
        repositoryUrl: fixture.repositoryUrl,
        machineId: machine.id,
        credentialId: credential.id,
        keyId: credential.keyId,
        enrollmentId: enrollment.id,
        grantId: grant.id,
        plaintext: credential.plaintext,
      });
    }

    const policy = {
      version: 1,
      repositories: provisioned.map(entry => ({
        repository_url: entry.repositoryUrl,
        tenant_id: entry.tenantId,
        api_base_url: apiBaseUrl,
        credential_key_id: entry.keyId,
      })),
    };
    const keyring = {
      version: 1,
      credentials: provisioned.map(entry => entry.plaintext),
    };
    const manifest = {
      version: 1,
      actorId,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      apiBaseUrl,
      policyPath,
      credentialPath,
      entries: provisioned.map(({ plaintext: _plaintext, ...entry }) => entry),
    };

    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    writtenFiles.push(policyPath);
    await writeFile(credentialPath, `${JSON.stringify(keyring, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    writtenFiles.push(credentialPath);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    writtenFiles.push(manifestPath);

    console.log('setup=complete');
    console.log(`runtime_dir=${runtimeDir}`);
    console.log(`policy_file=${policyPath}`);
    console.log(`credential_file=${credentialPath}`);
    console.log('credential_permissions=600');
    for (const entry of provisioned) console.log(`${entry.label}_key_id=${entry.keyId}`);
    console.log(`cleanup_manifest=${manifestPath}`);
    console.log('plaintext_credentials=written-not-printed');
  } catch (error) {
    for (const path of writtenFiles.reverse()) {
      try { await unlink(path); } catch {}
    }
    for (const grant of createdGrants.reverse()) {
      try {
        await revokeMachineRepositoryGrant(
          grant.tenantId, grant.id, actorId, 'Wave 2 setup rollback',
        );
      } catch {}
    }
    for (const enrollment of createdEnrollments.reverse()) {
      try {
        await revokeRepositoryEnrollment(
          enrollment.tenantId, enrollment.id, actorId, 'Wave 2 setup rollback',
        );
      } catch {}
    }
    for (const machine of createdMachines.reverse()) {
      try {
        await revokeDeveloperMachine(
          machine.tenantId, machine.id, actorId, 'Wave 2 setup rollback',
        );
      } catch {}
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 client setup failed');
  process.exitCode = 1;
});
