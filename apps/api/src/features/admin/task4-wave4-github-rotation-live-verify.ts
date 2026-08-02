import 'dotenv/config';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  githubAppCredentialVersions,
  githubAppInstallations,
} from '../../core/db/schema';
import {
  decryptGitHubAppCredential,
  prepareGitHubAppCredential,
} from '../../core/security/github-app-credential';
import { loadGitHubAppRuntimeCredentials } from '../../core/security/github-app-security-service';
import type { EncryptedValue } from '../../core/security/envelope-encryption';
import { appJwt } from '../scm/github-app';
import {
  assertOwnerOnlyDirectory,
  atomicWriteOwnerOnly,
  readOwnerOnlyFile,
} from './task4-wave4-local-file';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function authenticatedInstallationRead(
  appId: string,
  installationExternalId: string,
  privateKey: string,
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationExternalId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt(appId, privateKey)}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TrackAI',
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub installation read failed (${response.status})`);
  const installation = await response.json() as { id?: number; suspended_at?: string | null };
  if (String(installation.id) !== installationExternalId || installation.suspended_at) {
    throw new Error('GitHub installation read returned invalid state');
  }
}

async function main(): Promise<void> {
  const privateKeyPath = required('TASK4_WAVE4_GITHUB_PRIVATE_KEY_FILE');
  const restoreDirectory = required('TASK4_WAVE4_GITHUB_RESTORE_DIR');
  if (!path.isAbsolute(privateKeyPath) || !path.isAbsolute(restoreDirectory)) {
    throw new Error('GitHub key and restore directory paths must be absolute');
  }
  const privateKey = await readOwnerOnlyFile(privateKeyPath);
  await assertOwnerOnlyDirectory(restoreDirectory);

  const installations = await db.select({
    id: githubAppInstallations.id,
    tenantId: githubAppInstallations.tenantId,
    appId: githubAppInstallations.appId,
    installationExternalId: githubAppInstallations.installationExternalId,
    accountLogin: githubAppInstallations.accountLogin,
  }).from(githubAppInstallations).where(eq(githubAppInstallations.status, 'active'));
  if (installations.length !== 2) throw new Error('Exactly two active GitHub App installations are required');
  const replacement = prepareGitHubAppCredential(privateKey, {
    tenantId: installations[0].tenantId,
    credentialId: randomUUID(),
  });

  for (const installation of installations) {
    const runtime = await loadGitHubAppRuntimeCredentials(
      installation.tenantId,
      installation.accountLogin,
    );
    if (runtime.length !== 2
      || runtime[0].status !== 'active'
      || runtime[0].credentialFingerprint !== replacement.credentialFingerprint
      || runtime[1].status !== 'retiring') {
      throw new Error(`Installation ${installation.accountLogin} is not in a valid overlap`);
    }
    await authenticatedInstallationRead(
      runtime[0].appId,
      runtime[0].installationExternalId,
      runtime[0].privateKey,
    );
  }
  const crossed = await Promise.all([
    loadGitHubAppRuntimeCredentials(installations[0].tenantId, installations[1].accountLogin),
    loadGitHubAppRuntimeCredentials(installations[1].tenantId, installations[0].accountLogin),
  ]);
  if (crossed.some(rows => rows.length !== 0)) {
    throw new Error('Cross-tenant GitHub App credential resolution was not blocked');
  }

  const records = await db.select({
    id: githubAppCredentialVersions.id,
    tenantId: githubAppCredentialVersions.tenantId,
    installationId: githubAppCredentialVersions.installationId,
    encryptedCredential: githubAppCredentialVersions.encryptedCredential,
    masterKeyVersion: githubAppCredentialVersions.masterKeyVersion,
    credentialFingerprint: githubAppCredentialVersions.credentialFingerprint,
    status: githubAppCredentialVersions.status,
  }).from(githubAppCredentialVersions).where(and(
    inArray(githubAppCredentialVersions.installationId, installations.map(row => row.id)),
    inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
  ));
  if (records.length !== 4) throw new Error('Encrypted overlap backup must contain four credentials');

  const backupPath = path.join(
    restoreDirectory,
    `task4-wave4-github-encrypted-restore-${process.pid}-${Date.now()}.json`,
  );
  try {
    await atomicWriteOwnerOnly(backupPath, `${JSON.stringify({ version: 1, records })}\n`);
    const restored = JSON.parse(await readOwnerOnlyFile(backupPath)) as {
      version?: unknown;
      records?: typeof records;
    };
    if (restored.version !== 1 || !Array.isArray(restored.records)
      || restored.records.length !== records.length) {
      throw new Error('Encrypted GitHub App backup restore shape is invalid');
    }
    for (const record of restored.records) {
      const restoredKey = decryptGitHubAppCredential(
        record.encryptedCredential as unknown as EncryptedValue,
        record.credentialFingerprint,
        { tenantId: record.tenantId, credentialId: record.id },
      );
      if (record.status === 'active') {
        const installation = installations.find(row => row.id === record.installationId);
        if (!installation) throw new Error('Restored credential installation is missing');
        await authenticatedInstallationRead(
          installation.appId,
          installation.installationExternalId,
          restoredKey,
        );
      }
    }
  } finally {
    await rm(backupPath, { force: true });
  }

  console.log('logical_installations=2');
  console.log('rotation_overlap=old-retiring-and-new-active');
  console.log('replacement_credentials=github-authenticated');
  console.log('cross_tenant_resolution=blocked-both-directions');
  console.log('encrypted_backup_records=4');
  console.log('encrypted_restore=decrypted-and-github-authenticated');
  console.log('temporary_restore_artifact=removed');
  console.log('tokens_private_keys_ciphertext=never-printed');
  console.log('database_changes=none');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'GitHub App rotation live verification failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
