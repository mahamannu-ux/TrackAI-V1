import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db';
import {
  githubAppCredentialVersions,
  githubAppInstallations,
  securityAuditEvents,
} from '../db/schema';
import {
  githubAppCredentialMetadata,
  githubAppPermissionsAreReadOnly,
  decryptGitHubAppCredential,
  prepareGitHubAppCredential,
} from './github-app-credential';
import type { EncryptedValue } from './envelope-encryption';

const MAX_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const IDENTIFIER_PATTERN = /^\d+$/;
const HOST_PATTERN = /^[a-z0-9.-]+$/;
const ACCOUNT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface CreateGitHubAppInstallationInput {
  tenantId: string;
  providerHost?: string;
  appId: string;
  installationExternalId: string;
  accountLogin: string;
  permissions: Record<string, string>;
  subscribedEvents?: string[];
  privateKey: string;
  actorId: string;
  now?: Date;
}

export interface RotateGitHubAppCredentialInput {
  tenantId: string;
  installationId: string;
  privateKey: string;
  actorId: string;
  overlapUntil: Date;
  now?: Date;
}

function normalizedInstallationInput(input: CreateGitHubAppInstallationInput) {
  const providerHost = (input.providerHost ?? 'github.com').trim().toLowerCase();
  const accountLogin = input.accountLogin.trim().toLowerCase();
  if (!HOST_PATTERN.test(providerHost)) throw new Error('GitHub provider host is invalid');
  if (!IDENTIFIER_PATTERN.test(input.appId)) throw new Error('GitHub App ID is invalid');
  if (!IDENTIFIER_PATTERN.test(input.installationExternalId)) {
    throw new Error('GitHub installation ID is invalid');
  }
  if (!ACCOUNT_PATTERN.test(accountLogin)) throw new Error('GitHub account login is invalid');
  if (!githubAppPermissionsAreReadOnly(input.permissions)) {
    throw new Error('GitHub App permissions must include read-only contents and pull requests');
  }
  const subscribedEvents = [...new Set(input.subscribedEvents ?? [])].sort();
  if (subscribedEvents.some(event => !/^[a-z_]{1,64}$/.test(event))) {
    throw new Error('GitHub App subscribed event is invalid');
  }
  return { providerHost, accountLogin, subscribedEvents };
}

function publicInstallation(installation: typeof githubAppInstallations.$inferSelect) {
  return {
    id: installation.id,
    providerHost: installation.providerHost,
    appId: installation.appId,
    installationExternalId: installation.installationExternalId,
    accountLogin: installation.accountLogin,
    permissions: installation.permissions,
    subscribedEvents: installation.subscribedEvents,
    status: installation.status,
    revokedAt: installation.revokedAt,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

export async function createGitHubAppInstallation(input: CreateGitHubAppInstallationInput) {
  const normalized = normalizedInstallationInput(input);
  const now = input.now ?? new Date();
  const installationId = randomUUID();
  const credentialId = randomUUID();
  const prepared = prepareGitHubAppCredential(input.privateKey, {
    tenantId: input.tenantId,
    credentialId,
  });

  return db.transaction(async transaction => {
    const [installation] = await transaction.insert(githubAppInstallations).values({
      id: installationId,
      tenantId: input.tenantId,
      providerHost: normalized.providerHost,
      appId: input.appId,
      installationExternalId: input.installationExternalId,
      accountLogin: normalized.accountLogin,
      permissions: input.permissions,
      subscribedEvents: normalized.subscribedEvents,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const [credential] = await transaction.insert(githubAppCredentialVersions).values({
      id: credentialId,
      tenantId: input.tenantId,
      installationId: installation.id,
      encryptedCredential: prepared.encryptedCredential as unknown as Record<string, unknown>,
      masterKeyVersion: prepared.masterKeyVersion,
      credentialFingerprint: prepared.credentialFingerprint,
      createdBy: input.actorId,
      effectiveFrom: now,
      createdAt: now,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'github_app.installation_created',
      targetType: 'github_app_installation',
      targetId: installation.id,
      details: {
        providerHost: installation.providerHost,
        appId: installation.appId,
        installationExternalId: installation.installationExternalId,
        accountLogin: installation.accountLogin,
        credentialId: credential.id,
        credentialFingerprint: credential.credentialFingerprint,
        permissions: installation.permissions,
        subscribedEvents: installation.subscribedEvents,
      },
    });
    return {
      installation: publicInstallation(installation),
      credential: githubAppCredentialMetadata(credential),
    };
  });
}

export async function rotateGitHubAppCredential(input: RotateGitHubAppCredentialInput) {
  const now = input.now ?? new Date();
  if (input.overlapUntil <= now
    || input.overlapUntil.getTime() - now.getTime() > MAX_ROTATION_OVERLAP_MS) {
    throw new Error('GitHub App credential overlap must end within 7 days');
  }
  const credentialId = randomUUID();
  const prepared = prepareGitHubAppCredential(input.privateKey, {
    tenantId: input.tenantId,
    credentialId,
  });

  return db.transaction(async transaction => {
    const [installation] = await transaction.select({ id: githubAppInstallations.id })
      .from(githubAppInstallations).where(and(
        eq(githubAppInstallations.tenantId, input.tenantId),
        eq(githubAppInstallations.id, input.installationId),
        eq(githubAppInstallations.status, 'active'),
      )).limit(1);
    if (!installation) throw new Error('Active GitHub App installation was not found');

    const existing = await transaction.select({
      id: githubAppCredentialVersions.id,
      status: githubAppCredentialVersions.status,
    })
      .from(githubAppCredentialVersions).where(and(
        eq(githubAppCredentialVersions.tenantId, input.tenantId),
        eq(githubAppCredentialVersions.installationId, input.installationId),
        inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
      )).orderBy(desc(githubAppCredentialVersions.effectiveFrom));
    const active = existing.filter(row => row.status === 'active');
    if (active.length !== 1 || existing.length !== 1) {
      throw new Error('GitHub App installation must have exactly one active credential before rotation');
    }
    await transaction.update(githubAppCredentialVersions).set({
      status: 'retiring', effectiveUntil: input.overlapUntil,
    }).where(and(
      eq(githubAppCredentialVersions.tenantId, input.tenantId),
      eq(githubAppCredentialVersions.id, active[0].id),
      eq(githubAppCredentialVersions.status, 'active'),
    ));
    const [credential] = await transaction.insert(githubAppCredentialVersions).values({
      id: credentialId,
      tenantId: input.tenantId,
      installationId: input.installationId,
      encryptedCredential: prepared.encryptedCredential as unknown as Record<string, unknown>,
      masterKeyVersion: prepared.masterKeyVersion,
      credentialFingerprint: prepared.credentialFingerprint,
      rotatedFromCredentialId: active[0].id,
      effectiveFrom: now,
      createdBy: input.actorId,
      createdAt: now,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'github_app.credential_rotated',
      targetType: 'github_app_credential',
      targetId: credential.id,
      details: {
        installationId: input.installationId,
        rotatedFromCredentialId: active[0].id,
        overlapUntil: input.overlapUntil.toISOString(),
        credentialFingerprint: credential.credentialFingerprint,
      },
    });
    return githubAppCredentialMetadata(credential);
  });
}

export async function finishGitHubAppCredentialRotation(
  tenantId: string,
  installationId: string,
  actorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  if (!reason.trim()) throw new Error('Credential retirement reason is required');
  await db.transaction(async transaction => {
    const retired = await transaction.update(githubAppCredentialVersions).set({
      status: 'revoked', revokedAt: now,
    }).where(and(
      eq(githubAppCredentialVersions.tenantId, tenantId),
      eq(githubAppCredentialVersions.installationId, installationId),
      eq(githubAppCredentialVersions.status, 'retiring'),
    )).returning({ id: githubAppCredentialVersions.id });
    if (retired.length === 0) throw new Error('Retiring GitHub App credential was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'github_app.rotation_finished',
      targetType: 'github_app_installation',
      targetId: installationId,
      details: { retiredCredentialIds: retired.map(row => row.id), reason: reason.trim() },
    });
  });
}

export async function revokeGitHubAppInstallation(
  tenantId: string,
  installationId: string,
  actorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  if (!reason.trim()) throw new Error('Installation revocation reason is required');
  await db.transaction(async transaction => {
    const [installation] = await transaction.update(githubAppInstallations).set({
      status: 'revoked', revokedAt: now, updatedAt: now,
    }).where(and(
      eq(githubAppInstallations.tenantId, tenantId),
      eq(githubAppInstallations.id, installationId),
      eq(githubAppInstallations.status, 'active'),
    )).returning({ id: githubAppInstallations.id });
    if (!installation) throw new Error('Active GitHub App installation was not found');
    await transaction.update(githubAppCredentialVersions).set({
      status: 'revoked', revokedAt: now,
    }).where(and(
      eq(githubAppCredentialVersions.tenantId, tenantId),
      eq(githubAppCredentialVersions.installationId, installationId),
      inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
    ));
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'github_app.installation_revoked',
      targetType: 'github_app_installation',
      targetId: installation.id,
      details: { credentialsRevoked: true, reason: reason.trim() },
    });
  });
}

export async function listGitHubAppInstallations(tenantId: string) {
  const rows = await db.select().from(githubAppInstallations).where(
    eq(githubAppInstallations.tenantId, tenantId),
  ).orderBy(githubAppInstallations.accountLogin);
  return rows.map(publicInstallation);
}

export interface GitHubAppRuntimeCredential {
  installationId: string;
  installationExternalId: string;
  appId: string;
  privateKey: string;
  credentialFingerprint: string;
  status: 'active' | 'retiring';
}

export async function loadGitHubAppRuntimeCredentials(
  tenantId: string,
  accountLogin: string,
  now = new Date(),
): Promise<GitHubAppRuntimeCredential[]> {
  const rows = await db.select({
    installationId: githubAppInstallations.id,
    installationExternalId: githubAppInstallations.installationExternalId,
    appId: githubAppInstallations.appId,
    credentialId: githubAppCredentialVersions.id,
    encryptedCredential: githubAppCredentialVersions.encryptedCredential,
    credentialFingerprint: githubAppCredentialVersions.credentialFingerprint,
    credentialStatus: githubAppCredentialVersions.status,
  }).from(githubAppInstallations).innerJoin(githubAppCredentialVersions, and(
    eq(githubAppCredentialVersions.tenantId, githubAppInstallations.tenantId),
    eq(githubAppCredentialVersions.installationId, githubAppInstallations.id),
  )).where(and(
    eq(githubAppInstallations.tenantId, tenantId),
    eq(githubAppInstallations.providerHost, 'github.com'),
    eq(githubAppInstallations.accountLogin, accountLogin.trim().toLowerCase()),
    eq(githubAppInstallations.status, 'active'),
    inArray(githubAppCredentialVersions.status, ['active', 'retiring']),
    lte(githubAppCredentialVersions.effectiveFrom, now),
    or(
      isNull(githubAppCredentialVersions.effectiveUntil),
      gt(githubAppCredentialVersions.effectiveUntil, now),
    ),
  )).orderBy(desc(githubAppCredentialVersions.effectiveFrom));

  return rows.sort((left, right) => {
    if (left.credentialStatus === right.credentialStatus) return 0;
    return left.credentialStatus === 'active' ? -1 : 1;
  }).map(row => ({
    installationId: row.installationId,
    installationExternalId: row.installationExternalId,
    appId: row.appId,
    privateKey: decryptGitHubAppCredential(
      row.encryptedCredential as unknown as EncryptedValue,
      row.credentialFingerprint,
      { tenantId, credentialId: row.credentialId },
    ),
    credentialFingerprint: row.credentialFingerprint,
    status: row.credentialStatus as 'active' | 'retiring',
  }));
}
