import 'dotenv/config';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  githubAppCredentialVersions,
  githubAppInstallations,
} from '../../core/db/schema';
import { planGitHubCredentialRotation } from '../../core/security/admin-lifecycle-policy';
import { prepareGitHubAppCredential } from '../../core/security/github-app-credential';
import { finishGitHubAppCredentialRotation } from '../../core/security/github-app-security-service';
import { readOwnerOnlyFile } from './task4-wave4-local-file';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const privateKeyPath = required('TASK4_WAVE4_GITHUB_PRIVATE_KEY_FILE');
  if (!path.isAbsolute(privateKeyPath)) {
    throw new Error('TASK4_WAVE4_GITHUB_PRIVATE_KEY_FILE must be absolute');
  }
  const privateKey = await readOwnerOnlyFile(privateKeyPath);
  const reason = required('TASK4_WAVE4_GITHUB_ROTATION_FINISH_REASON');
  const apply = process.env.TASK4_WAVE4_GITHUB_ROTATION_FINISH_APPLY === '1';
  if (apply && process.env.TASK4_WAVE4_GITHUB_RESTORE_VERIFIED !== '1') {
    throw new Error('Encrypted restore verification must be explicitly confirmed before finish');
  }

  const installations = await db.select({
    id: githubAppInstallations.id,
    tenantId: githubAppInstallations.tenantId,
    accountLogin: githubAppInstallations.accountLogin,
  }).from(githubAppInstallations).where(eq(githubAppInstallations.status, 'active'));
  if (installations.length !== 2) throw new Error('Exactly two active GitHub App installations are required');
  const prepared = prepareGitHubAppCredential(privateKey, {
    tenantId: installations[0].tenantId,
    credentialId: randomUUID(),
  });
  const rows = await db.select({
    installationId: githubAppCredentialVersions.installationId,
    status: githubAppCredentialVersions.status,
    credentialFingerprint: githubAppCredentialVersions.credentialFingerprint,
  }).from(githubAppCredentialVersions).where(and(
    inArray(githubAppCredentialVersions.installationId, installations.map(row => row.id)),
    inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
  ));
  const plans = installations.map(installation => ({
    installation,
    state: planGitHubCredentialRotation(
      rows.filter(row => row.installationId === installation.id) as Array<{
        status: 'active' | 'retiring'; credentialFingerprint: string;
      }>,
      prepared.credentialFingerprint,
    ),
  }));
  if (plans.some(plan => plan.state === 'pending')) {
    throw new Error('GitHub App replacement key has not been staged for every installation');
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`logical_installations=${plans.length}`);
  for (const plan of plans.sort((left, right) => (
    left.installation.accountLogin.localeCompare(right.installation.accountLogin)
  ))) {
    console.log(`${plan.installation.accountLogin}.rotation_state=${plan.state}`);
  }
  console.log('replacement_key=validated-not-printed');
  console.log('finish_reason=present-not-printed');
  if (!apply) {
    console.log('database_changes=none');
    console.log('next=complete-live-and-encrypted-restore-gates-then-rerun-with-explicit-apply');
    return;
  }

  let finished = 0;
  for (const plan of plans) {
    if (plan.state !== 'staged') continue;
    await finishGitHubAppCredentialRotation(
      plan.installation.tenantId,
      plan.installation.id,
      'task4-wave4-github-rotation',
      reason,
    );
    finished += 1;
  }
  console.log(`rotations_finished=${finished}`);
  console.log('retiring_credentials=revoked');
  console.log('replacement_credentials=active');
  console.log('audit_events=written');
  console.log('private_key=never-printed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'GitHub App rotation finish failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
