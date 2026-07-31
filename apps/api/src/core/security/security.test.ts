import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
import { repositoryGrantAllows } from './repository-grant';

function encodedKey(): string {
  return randomBytes(32).toString('base64');
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
