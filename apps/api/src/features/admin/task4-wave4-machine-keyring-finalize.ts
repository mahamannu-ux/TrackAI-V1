import 'dotenv/config';

import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import { developerMachines, machineCredentials } from '../../core/db/schema';
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

function keyringCredentials(raw: string): Array<{ keyId: string; credential: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Machine keyring is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object'
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { credentials?: unknown }).credentials)) {
    throw new Error('Machine keyring is invalid');
  }
  const credentials = (parsed as { credentials: unknown[] }).credentials.map(credential => {
    if (typeof credential !== 'string') throw new Error('Machine keyring is invalid');
    const match = CREDENTIAL_PATTERN.exec(credential);
    if (!match) throw new Error('Machine keyring contains an invalid credential');
    return { keyId: match[1], credential };
  });
  if (new Set(credentials.map(row => row.keyId)).size !== credentials.length) {
    throw new Error('Machine keyring contains duplicate key IDs');
  }
  return credentials;
}

async function main(): Promise<void> {
  const runtimeDir = required('TASK4_MACHINE_KEYRING_DIR');
  if (!path.isAbsolute(runtimeDir)) throw new Error('TASK4_MACHINE_KEYRING_DIR must be absolute');
  const activeKeyId = required('TASK4_ACTIVE_MACHINE_KEY_ID');
  if (!/^[A-Za-z0-9_-]{16}$/.test(activeKeyId)) throw new Error('Active machine key ID is invalid');
  const apply = process.env.TASK4_MACHINE_KEYRING_ROTATION_APPLY === '1';

  await assertOwnerOnlyDirectory(runtimeDir);
  const keyringPath = path.join(runtimeDir, 'trackai-machine-credentials.json');
  const credentials = keyringCredentials(await readOwnerOnlyFile(keyringPath));
  if (credentials.length !== 2) throw new Error('Finalization requires exactly two staged credentials');
  const retained = credentials.find(row => row.keyId === activeKeyId);
  const retired = credentials.find(row => row.keyId !== activeKeyId);
  if (!retained || !retired) throw new Error('Active machine key ID is absent from the staged keyring');

  const serverRows = await db.select({
    tenantId: machineCredentials.tenantId,
    machineId: machineCredentials.machineId,
    keyId: machineCredentials.keyId,
    credentialStatus: machineCredentials.status,
    credentialRevokedAt: machineCredentials.revokedAt,
    machineStatus: developerMachines.status,
  }).from(machineCredentials).innerJoin(developerMachines, and(
    eq(developerMachines.tenantId, machineCredentials.tenantId),
    eq(developerMachines.id, machineCredentials.machineId),
  )).where(inArray(machineCredentials.keyId, [retained.keyId, retired.keyId]));
  const retainedServer = serverRows.find(row => row.keyId === retained.keyId);
  const retiredServer = serverRows.find(row => row.keyId === retired.keyId);
  if (!retainedServer || !retiredServer
    || retainedServer.tenantId !== retiredServer.tenantId
    || retainedServer.machineId !== retiredServer.machineId
    || retainedServer.machineStatus !== 'active'
    || retainedServer.credentialStatus !== 'active'
    || retainedServer.credentialRevokedAt !== null
    || retiredServer.credentialStatus !== 'revoked'
    || retiredServer.credentialRevokedAt === null) {
    throw new Error('Server credential rotation is not ready for local finalization');
  }

  const policyPath = path.join(runtimeDir, 'trackai-delivery-policy.json');
  const policy = JSON.parse(await readOwnerOnlyFile(policyPath)) as {
    version?: unknown;
    repositories?: Array<{ credential_key_id?: unknown }>;
  };
  if (policy.version !== 1 || !Array.isArray(policy.repositories)
    || policy.repositories.length === 0
    || policy.repositories.some(row => row.credential_key_id !== activeKeyId)) {
    throw new Error('Client policy is not fully switched to the retained key ID');
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`retained_key_id=${retained.keyId}`);
  console.log(`retired_key_id=${retired.keyId}`);
  console.log('policy=fully-switched-to-retained-key');
  console.log(`keyring_file=${keyringPath}`);
  if (!apply) {
    console.log('filesystem_changes=none');
    console.log('next=confirm-old-server-key-is-revoked-then-rerun-with-explicit-apply');
    return;
  }

  await atomicWriteOwnerOnly(keyringPath, `${JSON.stringify({
    version: 1,
    credentials: [retained.credential],
  }, null, 2)}\n`);
  console.log('keyring=rotation-finalized');
  console.log('remaining_keys=1');
  console.log('keyring_permissions=600');
  console.log('credential_values=never-printed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Machine keyring rotation finalization failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
