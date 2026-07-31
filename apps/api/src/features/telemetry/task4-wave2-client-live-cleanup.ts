import 'dotenv/config';

import { chmod, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  revokeDeveloperMachine,
} from '../../core/security/machine-security-service';
import {
  revokeMachineRepositoryGrant,
  revokeRepositoryEnrollment,
} from '../../core/security/repository-security-service';

type Manifest = {
  version: number;
  actorId: string;
  policyPath: string;
  credentialPath: string;
  entries: Array<{
    tenantId: string;
    machineId: string;
    enrollmentId: string;
    grantId: string;
  }>;
};

async function main(): Promise<void> {
  const runtimeDirValue = process.env.TASK4_WAVE2_RUNTIME_DIR?.trim();
  if (!runtimeDirValue) throw new Error('TASK4_WAVE2_RUNTIME_DIR is required');
  const manifestPath = resolve(runtimeDirValue, 'task4-wave2-client-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (manifest.version !== 1 || !manifest.actorId || !Array.isArray(manifest.entries)) {
    throw new Error('Wave 2 cleanup manifest is invalid');
  }

  if (process.env.TASK4_WAVE2_CLEANUP_DRY_RUN === '1') {
    console.log(`cleanup_entries=${manifest.entries.length}`);
    console.log('credentials=would-revoke-with-machines');
    console.log('grants=would-revoke');
    console.log('enrollments=would-revoke');
    console.log('runtime_files=would-remove');
    console.log('audit_history=would-retain');
    console.log('cleanup=dry-run-complete');
    return;
  }

  for (const entry of [...manifest.entries].reverse()) {
    await revokeMachineRepositoryGrant(
      entry.tenantId, entry.grantId, manifest.actorId, 'Task4 Wave 2 live verification complete',
    );
    await revokeRepositoryEnrollment(
      entry.tenantId, entry.enrollmentId, manifest.actorId, 'Task4 Wave 2 live verification complete',
    );
    await revokeDeveloperMachine(
      entry.tenantId, entry.machineId, manifest.actorId, 'Task4 Wave 2 live verification complete',
    );
  }

  await chmod(manifest.credentialPath, 0o600);
  await unlink(manifest.credentialPath);
  await unlink(manifest.policyPath);
  await unlink(manifestPath);
  console.log('credentials=revoked');
  console.log('grants=revoked');
  console.log('enrollments=revoked');
  console.log('machines=revoked');
  console.log('local_keyring=removed');
  console.log('audit_history=retained');
  console.log('cleanup=complete');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 client cleanup failed');
  process.exitCode = 1;
});
