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
import { rotateGitHubAppCredential } from '../../core/security/github-app-security-service';
import { appJwt } from '../scm/github-app';
import { readOwnerOnlyFile } from './task4-wave4-local-file';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function validateGitHubKey(
  appId: string,
  privateKey: string,
  installationIds: string[],
): Promise<void> {
  const authorization = `Bearer ${appJwt(appId, privateKey)}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: authorization,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TrackAI',
  };
  const appResponse = await fetch('https://api.github.com/app', { headers });
  if (!appResponse.ok) throw new Error(`Replacement GitHub App key validation failed (${appResponse.status})`);
  const app = await appResponse.json() as { id?: number };
  if (String(app.id) !== appId) throw new Error('Replacement key belongs to a different GitHub App');
  for (const installationId of installationIds) {
    const response = await fetch(`https://api.github.com/app/installations/${installationId}`, { headers });
    if (!response.ok) throw new Error(`Replacement key cannot read installation ${installationId}`);
    const installation = await response.json() as { id?: number; suspended_at?: string | null };
    if (String(installation.id) !== installationId || installation.suspended_at) {
      throw new Error('Replacement key resolved an invalid or suspended installation');
    }
  }
}

async function main(): Promise<void> {
  const privateKeyPath = required('TASK4_WAVE4_GITHUB_PRIVATE_KEY_FILE');
  if (!path.isAbsolute(privateKeyPath)) {
    throw new Error('TASK4_WAVE4_GITHUB_PRIVATE_KEY_FILE must be absolute');
  }
  const privateKey = await readOwnerOnlyFile(privateKeyPath);
  const appId = required('GITHUB_APP_ID');
  if (!/^\d+$/.test(appId)) throw new Error('GITHUB_APP_ID must be numeric');
  const overlapHours = Number(process.env.TASK4_WAVE4_GITHUB_ROTATION_OVERLAP_HOURS ?? '24');
  if (!Number.isInteger(overlapHours) || overlapHours < 1 || overlapHours > 168) {
    throw new Error('Rotation overlap must be an integer from 1 through 168 hours');
  }
  const apply = process.env.TASK4_WAVE4_GITHUB_ROTATION_APPLY === '1';

  const installations = await db.select({
    id: githubAppInstallations.id,
    tenantId: githubAppInstallations.tenantId,
    appId: githubAppInstallations.appId,
    installationExternalId: githubAppInstallations.installationExternalId,
    accountLogin: githubAppInstallations.accountLogin,
  }).from(githubAppInstallations).where(eq(githubAppInstallations.status, 'active'));
  if (installations.length !== 2 || installations.some(row => row.appId !== appId)) {
    throw new Error('Exactly two active installations for GITHUB_APP_ID are required');
  }

  const prepared = prepareGitHubAppCredential(privateKey, {
    tenantId: installations[0].tenantId,
    credentialId: randomUUID(),
  });
  await validateGitHubKey(
    appId,
    privateKey,
    installations.map(row => row.installationExternalId),
  );

  const credentialRows = await db.select({
    installationId: githubAppCredentialVersions.installationId,
    status: githubAppCredentialVersions.status,
    credentialFingerprint: githubAppCredentialVersions.credentialFingerprint,
  }).from(githubAppCredentialVersions).where(and(
    inArray(githubAppCredentialVersions.installationId, installations.map(row => row.id)),
    inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
  ));

  const plans = installations.map(installation => {
    const rows = credentialRows.filter(row => row.installationId === installation.id);
    let state: 'pending' | 'staged' | 'complete';
    try {
      state = planGitHubCredentialRotation(
        rows as Array<{ status: 'active' | 'retiring'; credentialFingerprint: string }>,
        prepared.credentialFingerprint,
      );
    } catch {
      throw new Error(`Installation ${installation.accountLogin} has an unsafe rotation state`);
    }
    return { installation, state };
  });
  if (plans.every(plan => plan.state === 'complete')) {
    throw new Error('Replacement GitHub App key is already fully active');
  }

  const overlapUntil = new Date(Date.now() + overlapHours * 60 * 60 * 1_000);
  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`logical_installations=${plans.length}`);
  for (const plan of plans.sort((left, right) => (
    left.installation.accountLogin.localeCompare(right.installation.accountLogin)
  ))) {
    console.log(`${plan.installation.accountLogin}.rotation_state=${plan.state}`);
  }
  console.log(`overlap_hours=${overlapHours}`);
  console.log('replacement_key=github-authenticated-not-printed');
  console.log('installation_tokens=not-created');
  if (!apply) {
    console.log('database_changes=none');
    console.log('next=rerun-with-explicit-apply-after-reviewed-backup');
    return;
  }

  let staged = 0;
  for (const plan of plans) {
    if (plan.state !== 'pending') continue;
    await rotateGitHubAppCredential({
      tenantId: plan.installation.tenantId,
      installationId: plan.installation.id,
      privateKey,
      actorId: 'task4-wave4-github-rotation',
      overlapUntil,
    });
    staged += 1;
  }
  console.log(`credential_versions_staged=${staged}`);
  console.log('rotation_overlap=active');
  console.log('audit_events=written');
  console.log('private_key=encrypted-not-printed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'GitHub App rotation staging failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
