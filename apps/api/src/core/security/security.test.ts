import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decryptEnvelope, encryptEnvelope } from './envelope-encryption';
import {
  createMachineCredential,
  machineCredentialIsUsable,
  parseMachineCredential,
  verifyMachineCredentialSecret,
} from './machine-credential';
import { resolveManagedMachineCredential } from './managed-machine-auth';
import { loadMasterKeyring } from './master-key';
import {
  branchPatternIsValid,
  normalizeRepositoryBranchPatterns,
  repositoryGrantAllows,
} from './repository-grant';
import { ADMIN_ACTIONS, adminMembershipAllows } from './admin-authorization';
import {
  DEFAULT_RETENTION_POLICY,
  MAX_EXPORT_ARTIFACT_BYTES,
  MAX_EXPORT_WINDOW_MS,
  TASK4_EXPORT_DATASETS,
  CLIENT_DELIVERY_HEALTH_STALE_MS,
  classifyClientDeliveryHealthStatus,
  classifyOperationalEvidence,
  classifyTenantOperationalHealth,
  exportFieldIsAllowed,
  planRetentionCandidate,
  pendingNormalizationIsEligible,
  retentionArchiveCoverage,
  validateExportWindow,
  validateExportArtifactBytes,
  validateRetentionPolicy,
} from '../operations/task4-operations-contract';
import {
  canonicalExportJson,
  createTask4ExportEnvelope,
  restoreTask4ExportEnvelope,
} from '../operations/task4-export-format';
import { LocalFileEvidenceExportSink } from '../operations/evidence-export-sink';
import {
  MAX_CLIENT_DELIVERY_HEALTH_COUNT,
  validateClientDeliveryHealthReport,
} from '../operations/client-delivery-health-contract';
import {
  MAX_BACKFILL_AUTHORIZATION_TTL_MS,
  MAX_BACKFILL_WINDOW_MS,
  planGitHubCredentialRotation,
  validateBackfillAuthorizationWindow,
  validateMachineCredentialIssuance,
} from './admin-lifecycle-policy';
import {
  decryptGitHubAppCredential,
  githubAppCredentialIsUsable,
  githubAppCredentialMetadata,
  githubAppPermissionsAreReadOnly,
  prepareGitHubAppCredential,
} from './github-app-credential';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  githubAppCredentialVersions,
  githubAppInstallations,
  evidenceArchiveEntries,
  evidenceExportJobs,
  machineDeliveryHealthReports,
  providerEventDeliveries,
  providerProjectionCursors,
  retentionRuns,
  repositoryBackfillAuthorizations,
  repositoryEnrollments,
  tenantAdminMemberships,
  tenantRetentionPolicies,
} from '../db/schema';

function encodedKey(): string {
  return randomBytes(32).toString('base64');
}

function rsaPrivateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

test('master keyring fails closed for missing, malformed, and short keys', () => {
  assert.throws(() => loadMasterKeyring({}), /not configured/);
  assert.throws(() => loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: '[]',
  }), /JSON object/);
  assert.throws(() => loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: Buffer.alloc(16).toString('base64') }),
  }), /32 bytes/);
});

test('master keyring selects the active version without exposing key material', () => {
  const secretKey = encodedKey();
  const keyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: '2026-07',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ '2026-07': secretKey }),
  });
  assert.equal(keyring.activeVersion, '2026-07');
  assert.equal(keyring.keyCount, 1);
  assert.equal(JSON.stringify(keyring).includes(secretKey), false);
});

test('envelope encryption round-trips and randomizes identical plaintext', () => {
  const keyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: encodedKey() }),
  });
  const context = { tenantId: 'tenant-a', purpose: 'github-app-private-key', resourceId: 'installation-a' };
  const first = encryptEnvelope('credential-value', context, keyring);
  const second = encryptEnvelope('credential-value', context, keyring);

  assert.equal(decryptEnvelope(first, context, keyring), 'credential-value');
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.wrappedDataKey.ciphertext, second.wrappedDataKey.ciphertext);
});

test('envelope encryption rejects tampering and context crossing', () => {
  const keyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: encodedKey() }),
  });
  const context = { tenantId: 'tenant-a', purpose: 'machine-secret', resourceId: 'machine-1' };
  const envelope = encryptEnvelope('credential-value', context, keyring);

  assert.throws(() => decryptEnvelope(envelope, { ...context, tenantId: 'tenant-b' }, keyring));
  assert.throws(() => decryptEnvelope({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, context, keyring));
});

test('old envelopes remain readable during staged master-key rotation', () => {
  const oldKey = encodedKey();
  const newKey = encodedKey();
  const oldKeyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: oldKey }),
  });
  const rotatedKeyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v2',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: oldKey, v2: newKey }),
  });
  const context = { tenantId: 'tenant-a', purpose: 'github-app-private-key', resourceId: 'installation-a' };
  const oldEnvelope = encryptEnvelope('old-credential', context, oldKeyring);
  const newEnvelope = encryptEnvelope('new-credential', context, rotatedKeyring);

  assert.equal(decryptEnvelope(oldEnvelope, context, rotatedKeyring), 'old-credential');
  assert.equal(newEnvelope.masterKeyVersion, 'v2');
  assert.throws(() => decryptEnvelope(newEnvelope, context, oldKeyring), /unavailable/);
});

test('machine credentials store only a lookup id and strong secret hash', () => {
  const first = createMachineCredential();
  const second = createMachineCredential();
  const parsed = parseMachineCredential(first.plaintext);

  assert.equal(parsed.keyId, first.keyId);
  assert.equal(verifyMachineCredentialSecret(parsed.secret, first.secretHash), true);
  assert.equal(verifyMachineCredentialSecret(parsed.secret, second.secretHash), false);
  assert.equal(first.secretHash.includes(parsed.secret), false);
  assert.notEqual(first.plaintext, second.plaintext);
});

test('machine credential status, expiry, and revocation fail closed', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  assert.equal(machineCredentialIsUsable({ status: 'active', expiresAt: null, revokedAt: null }, now), true);
  assert.equal(machineCredentialIsUsable({ status: 'revoked', expiresAt: null, revokedAt: now }, now), false);
  assert.equal(machineCredentialIsUsable({ status: 'active', expiresAt: new Date(now.getTime() - 1), revokedAt: null }, now), false);
});

test('machine credential parsing rejects truncation, extra fields, and unsafe characters', () => {
  const credential = createMachineCredential();
  const [prefix, keyId, secret] = credential.plaintext.split('.');

  for (const malformed of [
    '', `${keyId}.${secret}`, `trk_v2.${keyId}.${secret}`,
    `${prefix}.${keyId}.${secret}.extra`, `${prefix}.${keyId}.${secret.slice(1)}`,
    `${prefix}.${keyId.slice(1)}.${secret}`, `${prefix}.${keyId}.${secret.slice(0, -1)}+`,
  ]) {
    assert.throws(() => parseMachineCredential(malformed), /invalid format/);
  }
  assert.equal(verifyMachineCredentialSecret(secret, credential.secretHash), true);
  assert.equal(verifyMachineCredentialSecret(secret, 'not-a-sha256-hash'), false);
});

test('machine credential expiry boundary is exclusive and revokedAt always wins', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  assert.equal(machineCredentialIsUsable({
    status: 'active', expiresAt: new Date(now.getTime() + 1), revokedAt: null,
  }, now), true);
  assert.equal(machineCredentialIsUsable({
    status: 'active', expiresAt: now, revokedAt: null,
  }, now), false);
  assert.equal(machineCredentialIsUsable({
    status: 'active', expiresAt: new Date(now.getTime() + 60_000), revokedAt: now,
  }, now), false);
});

test('credential issuance permits only an initial key or one bounded rotation overlap', () => {
  assert.equal(validateMachineCredentialIssuance([]), 'initial');
  assert.throws(() => validateMachineCredentialIssuance([
    { id: 'credential-a', rotatedFromCredentialId: null },
  ]), /stage rotation/);
  assert.equal(validateMachineCredentialIssuance([
    { id: 'credential-a', rotatedFromCredentialId: null },
  ], 'credential-a'), 'rotation');
  assert.throws(() => validateMachineCredentialIssuance([
    { id: 'credential-a', rotatedFromCredentialId: null },
  ], 'credential-b'), /not found/);
  assert.throws(() => validateMachineCredentialIssuance([
    { id: 'credential-a', rotatedFromCredentialId: null },
    { id: 'credential-b', rotatedFromCredentialId: 'credential-a' },
  ], 'credential-a'), /rotation overlap/);
});

test('GitHub App rotation planning is resumable and rejects ambiguous overlap', () => {
  assert.equal(planGitHubCredentialRotation([
    { status: 'active', credentialFingerprint: 'old' },
  ], 'new'), 'pending');
  assert.equal(planGitHubCredentialRotation([
    { status: 'active', credentialFingerprint: 'new' },
    { status: 'retiring', credentialFingerprint: 'old' },
  ], 'new'), 'staged');
  assert.equal(planGitHubCredentialRotation([
    { status: 'active', credentialFingerprint: 'new' },
  ], 'new'), 'complete');
  assert.throws(() => planGitHubCredentialRotation([
    { status: 'active', credentialFingerprint: 'old' },
    { status: 'retiring', credentialFingerprint: 'older' },
  ], 'new'), /unsafe credential rotation state/);
  assert.throws(() => planGitHubCredentialRotation([
    { status: 'active', credentialFingerprint: 'new' },
    { status: 'active', credentialFingerprint: 'other' },
  ], 'new'), /unsafe credential rotation state/);
});

test('repository grants bind tenant, machine, repository, branch, and time', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  const grant = {
    tenantId: 'tenant-a', machineId: 'machine-1', repositoryId: 'repo-a', status: 'active',
    branchPatterns: ['main', 'feature/*'], effectiveFrom: new Date(now.getTime() - 1_000), effectiveUntil: null,
  };

  assert.equal(repositoryGrantAllows(grant, {
    tenantId: 'tenant-a', machineId: 'machine-1', repositoryId: 'repo-a', branch: 'refs/heads/feature/demo', now,
  }), true);
  assert.equal(repositoryGrantAllows(grant, {
    tenantId: 'tenant-b', machineId: 'machine-1', repositoryId: 'repo-a', branch: 'feature/demo', now,
  }), false);
  assert.equal(repositoryGrantAllows(grant, {
    tenantId: 'tenant-a', machineId: 'machine-1', repositoryId: 'repo-b', branch: 'feature/demo', now,
  }), false);
  assert.equal(repositoryGrantAllows(grant, {
    tenantId: 'tenant-a', machineId: 'machine-1', repositoryId: 'repo-a', branch: 'release/prod', now,
  }), false);
});

test('repository grant revocation and time boundaries fail closed', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  const grant = {
    tenantId: 'tenant-a', machineId: 'machine-a', repositoryId: 'repo-a', status: 'active',
    branchPatterns: [] as string[], effectiveFrom: new Date(now.getTime() - 1), effectiveUntil: null,
  };
  const request = {
    tenantId: 'tenant-a', machineId: 'machine-a', repositoryId: 'repo-a', branch: null, now,
  };

  assert.equal(repositoryGrantAllows(grant, request), true);
  assert.equal(repositoryGrantAllows({ ...grant, status: 'revoked' }, request), false);
  assert.equal(repositoryGrantAllows({ ...grant, effectiveFrom: new Date(now.getTime() + 1) }, request), false);
  assert.equal(repositoryGrantAllows({ ...grant, effectiveUntil: now }, request), false);
  assert.equal(repositoryGrantAllows({ ...grant, effectiveUntil: new Date(now.getTime() + 1) }, request), true);
});

test('repository branch policy is exact, normalized, and fail-closed for malformed patterns', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  const grant = {
    tenantId: 'tenant-a', machineId: 'machine-a', repositoryId: 'repo-a', status: 'active',
    branchPatterns: ['main', 'feature/*'], effectiveFrom: new Date(now.getTime() - 1), effectiveUntil: null,
  };
  const request = { tenantId: 'tenant-a', machineId: 'machine-a', repositoryId: 'repo-a', now };

  assert.equal(repositoryGrantAllows(grant, { ...request, branch: 'refs/heads/main' }), true);
  assert.equal(repositoryGrantAllows(grant, { ...request, branch: 'feature/a' }), true);
  assert.equal(repositoryGrantAllows(grant, { ...request, branch: 'feature' }), false);
  assert.equal(repositoryGrantAllows(grant, { ...request, branch: null }), false);
  assert.equal(repositoryGrantAllows({ ...grant, branchPatterns: ['feature/**'] }, {
    ...request, branch: 'feature/a',
  }), false);

  for (const invalid of ['', '/main', 'refs/heads/main', '../main', 'feature/**', 'feat*']) {
    assert.equal(branchPatternIsValid(invalid), false);
  }
  for (const valid of ['main', 'release/2026', 'feature/*']) {
    assert.equal(branchPatternIsValid(valid), true);
  }
  assert.deepEqual(normalizeRepositoryBranchPatterns([
    ' main ', 'feature/*', 'main', ' release/2026 ',
  ]), ['main', 'feature/*', 'release/2026']);
  assert.deepEqual(normalizeRepositoryBranchPatterns([]), []);
  assert.throws(() => normalizeRepositoryBranchPatterns(['main', 'feature/**']), /exact names/);
});

test('controlled backfill accepts only bounded past windows with short-lived authorization', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  const watermark = new Date('2026-07-31T09:00:00.000Z');
  const valid = {
    occurredFrom: new Date(watermark.getTime() - 24 * 60 * 60 * 1_000),
    occurredUntil: new Date(watermark.getTime() - 1),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    watermark,
    reason: '  recover saved offline evidence  ',
    now,
  };

  assert.equal(validateBackfillAuthorizationWindow(valid), 'recover saved offline evidence');
  assert.throws(() => validateBackfillAuthorizationWindow({ ...valid, reason: '   ' }), /reason/);
  assert.throws(() => validateBackfillAuthorizationWindow({
    ...valid, occurredFrom: new Date(valid.occurredUntil.getTime() + 1),
  }), /must not precede/);
  assert.throws(() => validateBackfillAuthorizationWindow({
    ...valid, occurredFrom: new Date(valid.occurredUntil.getTime() - MAX_BACKFILL_WINDOW_MS - 1),
  }), /31 days/);
  assert.throws(() => validateBackfillAuthorizationWindow({ ...valid, expiresAt: now }), /within 24 hours/);
  assert.throws(() => validateBackfillAuthorizationWindow({
    ...valid, expiresAt: new Date(now.getTime() + MAX_BACKFILL_AUTHORIZATION_TTL_MS + 1),
  }), /within 24 hours/);
  assert.throws(() => validateBackfillAuthorizationWindow({
    ...valid, occurredUntil: watermark,
  }), /before its enrollment watermark/);
});

test('managed credentials resolve two logical installations without a mutable machine header', async () => {
  const machineA = createMachineCredential();
  const machineB = createMachineCredential();
  const records = new Map([
    [machineA.keyId, {
      tenantId: 'tenant-a', machineId: 'machine-a', keyId: machineA.keyId,
      secretHash: machineA.secretHash, credentialStatus: 'active', expiresAt: null,
      credentialRevokedAt: null, machineStatus: 'active', machineRevokedAt: null,
    }],
    [machineB.keyId, {
      tenantId: 'tenant-b', machineId: 'machine-b', keyId: machineB.keyId,
      secretHash: machineB.secretHash, credentialStatus: 'active', expiresAt: null,
      credentialRevokedAt: null, machineStatus: 'active', machineRevokedAt: null,
    }],
  ]);
  const lookup = async (keyId: string) => records.get(keyId) ?? null;

  assert.deepEqual(await resolveManagedMachineCredential(machineA.plaintext, lookup), {
    tenantId: 'tenant-a', machineId: 'machine-a', keyId: machineA.keyId,
  });
  assert.deepEqual(await resolveManagedMachineCredential(machineB.plaintext, lookup), {
    tenantId: 'tenant-b', machineId: 'machine-b', keyId: machineB.keyId,
  });
});

test('managed credentials reject a wrong secret and revoked machine', async () => {
  const issued = createMachineCredential();
  const record = {
    tenantId: 'tenant-a', machineId: 'machine-a', keyId: issued.keyId,
    secretHash: issued.secretHash, credentialStatus: 'active', expiresAt: null,
    credentialRevokedAt: null, machineStatus: 'active', machineRevokedAt: null,
  };
  const lookup = async () => record;
  const wrongSecret = createMachineCredential().plaintext.split('.')[2];

  assert.equal(await resolveManagedMachineCredential(
    `trk_v1.${issued.keyId}.${wrongSecret}`, lookup,
  ), null);
  assert.equal(await resolveManagedMachineCredential(issued.plaintext, async () => ({
    ...record, machineStatus: 'revoked', machineRevokedAt: new Date(),
  })), null);
});

test('provider delivery ledger and projection cursor persist portable idempotency state', () => {
  const delivery = getTableConfig(providerEventDeliveries);
  const cursor = getTableConfig(providerProjectionCursors);
  const deliveryColumns = new Set(delivery.columns.map((column) => column.name));
  const cursorColumns = new Set(cursor.columns.map((column) => column.name));

  assert.deepEqual([...deliveryColumns].sort(), [
    'delivery_id', 'error_code', 'event_fingerprint', 'event_type', 'id',
    'processed_at', 'processing_started_at', 'processing_status', 'provider', 'provider_occurred_at',
    'raw_event', 'received_at', 'repository_id', 'tenant_id',
  ].sort());
  assert.deepEqual([...cursorColumns].sort(), [
    'id', 'last_delivery_id', 'last_event_fingerprint', 'last_provider_occurred_at',
    'projection_key', 'projection_type', 'provider', 'tenant_id', 'updated_at',
  ].sort());
  for (const column of [...deliveryColumns, ...cursorColumns]) {
    assert.equal(/secret|token|api_key|private_key/.test(column), false);
  }
  assert.equal(delivery.uniqueConstraints.length, 1);
  assert.equal(delivery.indexes.length, 2);
  assert.equal(cursor.uniqueConstraints.length, 1);
});

test('repository enrollment persists independent watermarks and bounded backfill approvals', () => {
  const enrollment = getTableConfig(repositoryEnrollments);
  const authorization = getTableConfig(repositoryBackfillAuthorizations);
  const enrollmentColumns = new Set(enrollment.columns.map((column) => column.name));
  const authorizationColumns = new Set(authorization.columns.map((column) => column.name));

  assert.equal(enrollmentColumns.has('generation_session_evidence_from'), true);
  assert.equal(enrollmentColumns.has('commit_note_evidence_from'), true);
  assert.deepEqual([...authorizationColumns].sort(), [
    'authorized_by', 'created_at', 'enrollment_id', 'evidence_family', 'expires_at', 'id',
    'occurred_from', 'occurred_until', 'reason', 'revoked_at', 'status', 'tenant_id',
  ].sort());
  for (const column of authorizationColumns) {
    assert.equal(/secret|token|api_key|private_key/.test(column), false);
  }
  assert.equal(authorization.foreignKeys.length, 2);
  assert.equal(authorization.indexes.length, 1);
  assert.equal(authorization.checks.length, 3);
});

test('tenant administration fails closed and keeps auditors read-only', () => {
  const admin = {
    tenantId: 'tenant-a', subject: 'user-a', role: 'tenant_admin' as const,
    status: 'active' as const, revokedAt: null,
  };
  const auditor = { ...admin, subject: 'auditor-a', role: 'tenant_auditor' as const };

  assert.equal(adminMembershipAllows(admin, {
    tenantId: 'tenant-a', subject: 'user-a', action: 'github_app.manage',
  }), true);
  assert.equal(adminMembershipAllows(admin, {
    tenantId: 'tenant-b', subject: 'user-a', action: 'github_app.manage',
  }), false);
  assert.equal(adminMembershipAllows({ ...admin, status: 'revoked', revokedAt: new Date() }, {
    tenantId: 'tenant-a', subject: 'user-a', action: 'repository.manage',
  }), false);
  assert.equal(adminMembershipAllows(auditor, {
    tenantId: 'tenant-a', subject: 'auditor-a', action: 'audit.read',
  }), true);
  assert.equal(adminMembershipAllows(auditor, {
    tenantId: 'tenant-a', subject: 'auditor-a', action: 'machine.manage',
  }), false);
  assert.equal(adminMembershipAllows(null, {
    tenantId: 'tenant-a', subject: 'user-a', action: 'audit.read',
  }), false);
});

test('tenant admin and auditor action matrix cannot cross tenant or subject boundaries', () => {
  const admin = {
    tenantId: 'tenant-a', subject: 'admin-a', role: 'tenant_admin' as const,
    status: 'active' as const, revokedAt: null,
  };
  const auditor = { ...admin, subject: 'auditor-a', role: 'tenant_auditor' as const };

  for (const action of ADMIN_ACTIONS) {
    assert.equal(adminMembershipAllows(admin, {
      tenantId: 'tenant-a', subject: 'admin-a', action,
    }), true, `tenant admin should be allowed ${action}`);
    assert.equal(adminMembershipAllows(admin, {
      tenantId: 'tenant-b', subject: 'admin-a', action,
    }), false, `tenant crossing should block ${action}`);
    assert.equal(adminMembershipAllows(admin, {
      tenantId: 'tenant-a', subject: 'different-subject', action,
    }), false, `subject crossing should block ${action}`);
    assert.equal(adminMembershipAllows(auditor, {
      tenantId: 'tenant-a', subject: 'auditor-a', action,
    }), action === 'audit.read' || action === 'operations.read',
    `auditor decision mismatch for ${action}`);
  }
});

test('Task4 retention defaults to no deletion and requires archive before explicit purge', () => {
  const evaluatedAt = new Date('2026-08-02T00:00:00.000Z');
  const oldEvidence = new Date('2026-06-01T00:00:00.000Z');
  assert.deepEqual(validateRetentionPolicy(DEFAULT_RETENTION_POLICY), {
    version: 1,
    mode: 'retain',
    retentionDays: null,
  });
  assert.equal(planRetentionCandidate({
    policy: DEFAULT_RETENTION_POLICY,
    occurredAt: oldEvidence,
    evaluatedAt,
    archiveCompletedAt: null,
    apply: true,
  }), 'retain');

  const archiveThenPurge = {
    version: 1 as const,
    mode: 'archive_then_purge' as const,
    retentionDays: 30,
  };
  assert.equal(planRetentionCandidate({
    policy: archiveThenPurge,
    occurredAt: oldEvidence,
    evaluatedAt,
    archiveCompletedAt: null,
    apply: true,
  }), 'blocked_archive_required');
  assert.equal(planRetentionCandidate({
    policy: archiveThenPurge,
    occurredAt: oldEvidence,
    evaluatedAt,
    archiveCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
    apply: false,
  }), 'dry_run_candidate');
  assert.equal(planRetentionCandidate({
    policy: archiveThenPurge,
    occurredAt: oldEvidence,
    evaluatedAt,
    archiveCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
    apply: true,
  }), 'purge_candidate');
  assert.throws(() => validateRetentionPolicy({
    version: 1,
    mode: 'archive_then_purge',
    retentionDays: 0,
  }), /between 1 and 3650/);
});

test('Task4 exports use explicit datasets and reject secret, prompt, and raw payload fields', () => {
  assert.deepEqual(TASK4_EXPORT_DATASETS, [
    'observed_metric_evidence',
    'provider_delivery_evidence',
    'lifecycle_projections',
    'correction_overlays',
    'security_audit',
  ]);
  for (const field of [
    'credential', 'machine_credential_hash', 'private_key', 'installation_token',
    'webhook_secret', 'master_key', 'prompt', 'raw_payload', 'provider_raw_event',
  ]) {
    assert.equal(exportFieldIsAllowed(field), false, `${field} must not be exported`);
  }
  for (const field of [
    'tenant_id', 'repository_id', 'occurred_at', 'availability', 'observed_value',
    'audited_value', 'correction_reason', 'safe_error_code',
  ]) {
    assert.equal(exportFieldIsAllowed(field), true, `${field} should be exportable`);
  }
});

test('Task4 export windows are bounded, historical, and half-open', () => {
  const evaluatedAt = new Date('2026-08-02T00:00:00.000Z');
  assert.doesNotThrow(() => validateExportWindow({
    scopeFrom: new Date(evaluatedAt.getTime() - MAX_EXPORT_WINDOW_MS),
    scopeUntil: evaluatedAt,
    evaluatedAt,
  }));
  assert.throws(() => validateExportWindow({
    scopeFrom: new Date(evaluatedAt.getTime() - MAX_EXPORT_WINDOW_MS - 1),
    scopeUntil: evaluatedAt,
    evaluatedAt,
  }), /at most 31 days/);
  assert.throws(() => validateExportWindow({
    scopeFrom: new Date('2026-08-01T00:00:00.000Z'),
    scopeUntil: new Date('2026-08-02T00:00:00.001Z'),
    evaluatedAt,
  }), /cannot end in the future/);
});

test('Task4 single-file exports fail closed on total encoded bytes', () => {
  assert.doesNotThrow(() => validateExportArtifactBytes(MAX_EXPORT_ARTIFACT_BYTES));
  assert.throws(
    () => validateExportArtifactBytes(MAX_EXPORT_ARTIFACT_BYTES + 1),
    /maximum 32 MiB single-file limit/,
  );
  assert.throws(() => validateExportArtifactBytes(-1), /byte length is invalid/);
});

test('client delivery health accepts bounded counts and rejects identity or raw fields', () => {
  const receivedAt = new Date('2026-08-02T12:00:00.000Z');
  const valid = {
    version: 1,
    observedAt: '2026-08-02T11:59:00.000Z',
    pendingRetryable: 2,
    waitingRetry: 3,
    processing: 1,
    quarantined: 4,
    rowsWithErrors: 5,
    oldestPendingAt: '2026-08-01T00:00:00.000Z',
    lastDeliveredAt: '2026-08-02T11:58:00.000Z',
  };
  const parsed = validateClientDeliveryHealthReport(valid, receivedAt);
  assert.equal(parsed.pendingRetryable, 2);
  assert.equal(parsed.quarantined, 4);
  for (const forbidden of ['tenantId', 'machineId', 'credential', 'rawEvent', 'reason']) {
    assert.throws(
      () => validateClientDeliveryHealthReport({ ...valid, [forbidden]: 'forbidden' }, receivedAt),
      /unsupported field/,
    );
  }
  assert.throws(() => validateClientDeliveryHealthReport({
    ...valid, pendingRetryable: MAX_CLIENT_DELIVERY_HEALTH_COUNT + 1,
  }, receivedAt), /integer between/);
  assert.throws(() => validateClientDeliveryHealthReport({
    ...valid, observedAt: '2026-08-02T12:06:00.000Z',
  }, receivedAt), /too far in the future/);
  assert.throws(() => validateClientDeliveryHealthReport({
    ...valid, oldestPendingAt: '2026-08-02T12:00:01.000Z',
  }, receivedAt), /cannot be later/);
});

test('client delivery health distinguishes unreported, current, boundary, and stale machines', () => {
  const evaluatedAt = new Date('2026-08-02T12:00:00.000Z');
  assert.equal(classifyClientDeliveryHealthStatus({ receivedAt: null, evaluatedAt }), 'unreported');
  assert.equal(classifyClientDeliveryHealthStatus({
    receivedAt: new Date(evaluatedAt.getTime() - 1), evaluatedAt,
  }), 'current');
  assert.equal(classifyClientDeliveryHealthStatus({
    receivedAt: new Date(evaluatedAt.getTime() - CLIENT_DELIVERY_HEALTH_STALE_MS), evaluatedAt,
  }), 'current');
  assert.equal(classifyClientDeliveryHealthStatus({
    receivedAt: new Date(evaluatedAt.getTime() - CLIENT_DELIVERY_HEALTH_STALE_MS - 1), evaluatedAt,
  }), 'stale');
  assert.throws(() => classifyClientDeliveryHealthStatus({
    receivedAt: new Date('invalid'), evaluatedAt,
  }), /receipt time is invalid/);
});

test('Task4 export envelopes are deterministic across input ordering', () => {
  const common = {
    tenantId: 'tenant-a',
    scopeFrom: new Date('2026-07-01T00:00:00.000Z'),
    scopeUntil: new Date('2026-08-01T00:00:00.000Z'),
    snapshotAt: new Date('2026-08-02T00:00:00.000Z'),
  };
  const first = createTask4ExportEnvelope({
    ...common,
    datasets: {
      observed_metric_evidence: [
        { id: 'b', occurredAt: '2026-07-03T00:00:00.000Z', data: { value: 2 } },
        { id: 'a', occurredAt: '2026-07-02T00:00:00.000Z', data: { value: 1 } },
      ],
      correction_overlays: [{
        id: 'c', occurredAt: '2026-07-04T00:00:00.000Z',
        data: { reason: 'reviewed', audited_value: 1 },
      }],
    },
  });
  const second = createTask4ExportEnvelope({
    ...common,
    datasets: {
      correction_overlays: [{
        id: 'c', occurredAt: '2026-07-04T00:00:00.000Z',
        data: { audited_value: 1, reason: 'reviewed' },
      }],
      observed_metric_evidence: [
        { id: 'a', occurredAt: '2026-07-02T00:00:00.000Z', data: { value: 1 } },
        { id: 'b', occurredAt: '2026-07-03T00:00:00.000Z', data: { value: 2 } },
      ],
    },
  });
  assert.equal(first.manifest.contentSha256, second.manifest.contentSha256);
  assert.equal(canonicalExportJson(first), canonicalExportJson(second));
  assert.equal(first.manifest.recordCounts.observed_metric_evidence, 2);
  assert.equal(first.manifest.recordCounts.security_audit, 0);
});

test('Task4 export envelopes reject forbidden nested fields and duplicate records', () => {
  const base = {
    tenantId: 'tenant-a', scopeFrom: null, scopeUntil: null,
    snapshotAt: new Date('2026-08-02T00:00:00.000Z'),
  };
  assert.throws(() => createTask4ExportEnvelope({
    ...base,
    datasets: { observed_metric_evidence: [{
      id: 'a', occurredAt: '2026-08-01T00:00:00.000Z',
      data: { nested: { raw_payload: 'not allowed' } },
    }] },
  }), /raw_payload is forbidden/);
  assert.throws(() => createTask4ExportEnvelope({
    ...base,
    datasets: { security_audit: [
      { id: 'a', occurredAt: '2026-08-01T00:00:00.000Z', data: {} },
      { id: 'a', occurredAt: '2026-08-01T00:00:01.000Z', data: {} },
    ] },
  }), /record id is duplicated/);
});

test('local export sink writes atomically with owner-only directory and file permissions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'trackai-wave5-export-'));
  const exportDirectory = join(parent, 'exports');
  try {
    const sink = new LocalFileEvidenceExportSink(exportDirectory);
    const result = await sink.write(randomUUID(), '{"safe":true}');
    assert.equal(result.storageReference.startsWith('local-file:trackai-export-'), true);
    assert.equal(result.bytes, 13);
    assert.equal(await sink.read(result.storageReference), '{"safe":true}');
    assert.equal((await stat(exportDirectory)).mode & 0o777, 0o700);
    const fileName = result.storageReference.slice('local-file:'.length);
    assert.equal((await stat(join(exportDirectory, fileName))).mode & 0o777, 0o600);
    await assert.rejects(() => sink.read('local-file:../outside.json'), /invalid/);
    await sink.remove(result.storageReference);
    await assert.rejects(() => sink.read(result.storageReference));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('export restore validates checksum, manifest, counts, and tampering', () => {
  const envelope = createTask4ExportEnvelope({
    tenantId: 'tenant-a',
    scopeFrom: new Date('2026-08-01T00:00:00.000Z'),
    scopeUntil: new Date('2026-08-02T00:00:00.000Z'),
    snapshotAt: new Date('2026-08-02T00:01:00.000Z'),
    datasets: { lifecycle_projections: [{
      id: 'code:1', occurredAt: '2026-08-01T01:00:00.000Z',
      data: { projectionKind: 'code', stage: 'generated', lineCount: 7 },
    }] },
  });
  const serialized = canonicalExportJson(envelope);
  assert.deepEqual(restoreTask4ExportEnvelope(serialized), envelope);
  assert.throws(
    () => restoreTask4ExportEnvelope(serialized.replace('"lineCount":7', '"lineCount":8')),
    /checksum|manifest/,
  );
  assert.throws(
    () => restoreTask4ExportEnvelope(
      serialized.replace('"lifecycle_projections":1', '"lifecycle_projections":2'),
    ),
    /checksum|manifest/,
  );
});

test('Task4 operational monitoring distinguishes terminal and actionable states', () => {
  const evaluatedAt = new Date('2026-08-02T00:00:00.000Z');
  const base = {
    deliveredAt: null,
    quarantinedAt: null,
    attempts: 0,
    nextRetryAt: null,
    firstObservedAt: new Date('2026-08-01T23:59:30.000Z'),
    evaluatedAt,
    delayedAfterMs: 60_000,
  };
  assert.equal(classifyOperationalEvidence({
    ...base, deliveredAt: new Date('2026-08-01T23:59:50.000Z'),
  }), 'delivered');
  assert.equal(classifyOperationalEvidence({
    ...base, quarantinedAt: new Date('2026-08-01T23:59:50.000Z'),
  }), 'quarantined');
  assert.equal(classifyOperationalEvidence({
    ...base, attempts: 2, nextRetryAt: new Date('2026-08-02T00:01:00.000Z'),
  }), 'retrying');
  assert.equal(classifyOperationalEvidence({
    ...base, firstObservedAt: new Date('2026-08-01T23:58:00.000Z'),
  }), 'delayed');
  assert.equal(classifyOperationalEvidence(base), 'unresolved');
});

test('tenant operational health prioritizes failures, expired work, and delay', () => {
  assert.equal(classifyTenantOperationalHealth({
    failed: 0, expiredWork: 0, delayedWork: 0,
  }), 'healthy');
  assert.equal(classifyTenantOperationalHealth({
    failed: 0, expiredWork: 0, delayedWork: 1,
  }), 'attention');
  assert.equal(classifyTenantOperationalHealth({
    failed: 1, expiredWork: 0, delayedWork: 10,
  }), 'critical');
  assert.equal(classifyTenantOperationalHealth({
    failed: 0, expiredWork: 1, delayedWork: 0,
  }), 'critical');
  assert.throws(() => classifyTenantOperationalHealth({
    failed: -1, expiredWork: 0, delayedWork: 0,
  }), /non-negative/);
});

test('pending normalization recovery is delayed and status bound', () => {
  const evaluatedAt = new Date('2026-08-02T10:00:00.000Z');
  assert.equal(pendingNormalizationIsEligible({
    status: 'pending', createdAt: new Date('2026-08-02T09:54:59.000Z'),
    evaluatedAt, delayMs: 5 * 60 * 1_000,
  }), true);
  assert.equal(pendingNormalizationIsEligible({
    status: 'pending', createdAt: new Date('2026-08-02T09:59:00.000Z'),
    evaluatedAt, delayMs: 5 * 60 * 1_000,
  }), false);
  assert.equal(pendingNormalizationIsEligible({
    status: 'failed', createdAt: new Date('2026-08-02T09:00:00.000Z'),
    evaluatedAt, delayMs: 5 * 60 * 1_000,
  }), false);
});

test('retention coverage fails closed until every due record has archive proof', () => {
  assert.deepEqual(retentionArchiveCoverage(10, 4), {
    blocked: 6,
    decision: 'archive_required',
  });
  assert.deepEqual(retentionArchiveCoverage(10, 10), {
    blocked: 0,
    decision: 'archive_ready',
  });
  assert.throws(() => retentionArchiveCoverage(2, 3), /invalid/);
  assert.throws(() => retentionArchiveCoverage(-1, 0), /invalid/);
});

test('Wave 5 operations schema is tenant-bound, metadata-only, and archive-before-purge', () => {
  const policy = getTableConfig(tenantRetentionPolicies);
  const exportJob = getTableConfig(evidenceExportJobs);
  const archiveEntry = getTableConfig(evidenceArchiveEntries);
  const retentionRun = getTableConfig(retentionRuns);
  const clientHealth = getTableConfig(machineDeliveryHealthReports);

  assert.equal(policy.indexes.some(indexConfig => indexConfig.config.unique), true);
  assert.equal(policy.checks.length, 4);
  assert.equal(exportJob.checks.length, 4);
  assert.equal(archiveEntry.foreignKeys.length, 2);
  assert.equal(archiveEntry.checks.length, 2);
  assert.equal(retentionRun.foreignKeys.length, 3);
  assert.equal(retentionRun.checks.length, 4);
  assert.equal(clientHealth.foreignKeys.length, 2);
  assert.equal(clientHealth.checks.length, 3);

  const allColumnNames = [policy, exportJob, archiveEntry, retentionRun, clientHealth]
    .flatMap(table => table.columns.map(column => column.name));
  for (const columnName of allColumnNames) {
    assert.equal(
      /credential|private_key|token|secret|prompt|raw_event|raw_payload/.test(columnName),
      false,
      `${columnName} must not store sensitive or raw customer content`,
    );
  }
  for (const table of [policy, exportJob, archiveEntry, retentionRun, clientHealth]) {
    assert.equal(table.columns.some(column => column.name === 'tenant_id'), true);
  }
});

test('admin membership and GitHub App credential schema remain tenant-bound and ciphertext-only', () => {
  const membership = getTableConfig(tenantAdminMemberships);
  const installation = getTableConfig(githubAppInstallations);
  const credential = getTableConfig(githubAppCredentialVersions);
  const membershipColumns = new Set(membership.columns.map(column => column.name));
  const installationColumns = new Set(installation.columns.map(column => column.name));
  const credentialColumns = new Set(credential.columns.map(column => column.name));

  assert.deepEqual([...membershipColumns].sort(), [
    'email', 'granted_at', 'granted_by', 'id', 'revoked_at', 'role', 'status',
    'subject', 'tenant_id',
  ].sort());
  assert.deepEqual([...installationColumns].sort(), [
    'account_login', 'app_id', 'created_at', 'created_by', 'id',
    'installation_external_id', 'permissions', 'provider_host', 'revoked_at',
    'status', 'subscribed_events', 'tenant_id', 'updated_at',
  ].sort());
  assert.deepEqual([...credentialColumns].sort(), [
    'created_at', 'created_by', 'credential_fingerprint', 'effective_from',
    'effective_until', 'encrypted_credential', 'id', 'installation_id',
    'master_key_version', 'revoked_at', 'rotated_from_credential_id', 'status',
    'tenant_id',
  ].sort());
  for (const column of [...installationColumns, ...credentialColumns]) {
    assert.equal(/plaintext|access_token|private_key|webhook_secret/.test(column), false);
  }
  assert.equal(membership.checks.length, 2);
  assert.equal(installation.uniqueConstraints.length, 3);
  assert.equal(credential.foreignKeys.length, 3);
  assert.equal(credential.checks.length, 3);
});

test('GitHub App private keys are validated, tenant-bound, and fingerprint-verified', () => {
  const keyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: encodedKey() }),
  });
  const privateKey = rsaPrivateKey();
  const context = { tenantId: 'tenant-a', credentialId: 'credential-a' };
  const prepared = prepareGitHubAppCredential(privateKey, context, keyring);

  assert.match(prepared.credentialFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(prepared.masterKeyVersion, 'v1');
  assert.match(decryptGitHubAppCredential(
    prepared.encryptedCredential,
    prepared.credentialFingerprint,
    context,
    keyring,
  ), /BEGIN PRIVATE KEY/);
  assert.throws(() => decryptGitHubAppCredential(
    prepared.encryptedCredential,
    prepared.credentialFingerprint,
    { ...context, tenantId: 'tenant-b' },
    keyring,
  ));
  assert.throws(() => decryptGitHubAppCredential(
    prepared.encryptedCredential,
    '0'.repeat(64),
    context,
    keyring,
  ), /fingerprint/);
});

test('GitHub App credential preparation rejects malformed and non-RSA keys', () => {
  const keyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: 'v1',
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: encodedKey() }),
  });
  const ecPrivateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const context = { tenantId: 'tenant-a', credentialId: 'credential-a' };

  assert.throws(() => prepareGitHubAppCredential('not-a-key', context, keyring), /invalid/);
  assert.throws(() => prepareGitHubAppCredential(ecPrivateKey, context, keyring), /RSA/);
});

test('GitHub App credential metadata and lifecycle never expose ciphertext', () => {
  const now = new Date('2026-07-31T10:00:00.000Z');
  const credential = {
    id: 'credential-a', installationId: 'installation-a', masterKeyVersion: 'v2',
    credentialFingerprint: 'a'.repeat(64), status: 'retiring' as const,
    effectiveFrom: new Date(now.getTime() - 1_000), effectiveUntil: null, revokedAt: null,
  };
  const metadata = githubAppCredentialMetadata(credential);

  assert.equal(githubAppCredentialIsUsable(credential, now), true);
  assert.equal(githubAppCredentialIsUsable({
    ...credential, status: 'revoked', revokedAt: now,
  }, now), false);
  assert.equal(JSON.stringify(metadata).includes('encrypted'), false);
  assert.equal(JSON.stringify(metadata).includes('private'), false);
});

test('GitHub App permission contract rejects write access and missing reads', () => {
  assert.equal(githubAppPermissionsAreReadOnly({
    contents: 'read', pull_requests: 'read', metadata: 'read', deployments: 'read',
  }), true);
  assert.equal(githubAppPermissionsAreReadOnly({
    contents: 'write', pull_requests: 'read',
  }), false);
  assert.equal(githubAppPermissionsAreReadOnly({ contents: 'read' }), false);
});
