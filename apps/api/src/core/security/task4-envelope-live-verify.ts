import 'dotenv/config';

import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptEnvelope,
  encryptEnvelope,
  type EncryptedValue,
  type EnvelopeContext,
} from './envelope-encryption';
import { loadMasterKeyring } from './master-key';

interface EnvelopeBackup {
  previous: EncryptedValue;
  current: EncryptedValue;
}

function rejects(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  const activeVersion = process.env.MASTER_ENCRYPTION_KEY_ACTIVE_VERSION;
  const rawKeys = process.env.MASTER_ENCRYPTION_KEYS_JSON;
  if (!activeVersion || !rawKeys) {
    throw new Error('Runtime master encryption keyring is required');
  }

  const currentKeys = JSON.parse(rawKeys) as Record<string, string>;
  const runtimeKeyring = loadMasterKeyring(process.env);
  const syntheticSecret = `task4-envelope-verification-${randomUUID()}`;
  const context: EnvelopeContext = {
    tenantId: 'task4-verification-tenant',
    purpose: 'wave1-envelope-verification',
    resourceId: randomUUID(),
  };
  const previousEnvelope = encryptEnvelope(
    syntheticSecret,
    context,
    runtimeKeyring,
  );

  const rotationVersion = `task4-rotation-${randomUUID()}`;
  const rotatedKeyring = loadMasterKeyring({
    MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: rotationVersion,
    MASTER_ENCRYPTION_KEYS_JSON: JSON.stringify({
      ...currentKeys,
      [rotationVersion]: randomBytes(32).toString('base64'),
    }),
  });
  const currentEnvelope = encryptEnvelope(
    syntheticSecret,
    context,
    rotatedKeyring,
  );

  const oldSurvivesRotation = decryptEnvelope(
    previousEnvelope,
    context,
    rotatedKeyring,
  ) === syntheticSecret;
  const currentDecrypts = decryptEnvelope(
    currentEnvelope,
    context,
    rotatedKeyring,
  ) === syntheticSecret;
  const retiredRejectsCurrent = rejects(() => decryptEnvelope(
    currentEnvelope,
    context,
    runtimeKeyring,
  ));
  const contextCrossingRejected = rejects(() => decryptEnvelope(
    previousEnvelope,
    { ...context, tenantId: 'different-tenant' },
    rotatedKeyring,
  ));
  const serializedKeyring = JSON.stringify(runtimeKeyring);
  const keyMaterialRedacted = Object.values(currentKeys)
    .every(encoded => !serializedKeyring.includes(encoded));

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'trackai-task4-envelope-'),
  );
  const backupFile = join(temporaryDirectory, 'encrypted-envelope-backup.json');
  let backupRestoreVerified = false;
  try {
    chmodSync(temporaryDirectory, 0o700);
    const backup: EnvelopeBackup = {
      previous: previousEnvelope,
      current: currentEnvelope,
    };
    writeFileSync(backupFile, JSON.stringify(backup), { mode: 0o600 });
    const restored = JSON.parse(
      readFileSync(backupFile, 'utf8'),
    ) as EnvelopeBackup;
    backupRestoreVerified = decryptEnvelope(
      restored.previous,
      context,
      rotatedKeyring,
    ) === syntheticSecret && decryptEnvelope(
      restored.current,
      context,
      rotatedKeyring,
    ) === syntheticSecret;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  if (!oldSurvivesRotation
    || !currentDecrypts
    || !retiredRejectsCurrent
    || !contextCrossingRejected
    || !keyMaterialRedacted
    || !backupRestoreVerified) {
    throw new Error('One or more live envelope verification checks failed');
  }

  console.log('runtime_keyring=valid');
  console.log('serialization=key-material-redacted');
  console.log('old_envelope_after_rotation=decryptable');
  console.log('new_envelope=uses-new-active-version');
  console.log('retired_keyring_for_new_envelope=rejected');
  console.log('tenant_context_crossing=rejected');
  console.log('encrypted_backup_restore=verified');
  console.log('temporary_artifacts=removed');
}

try {
  main();
} catch (error) {
  const failure = error as Error & { code?: string };
  console.log('envelope_live_verification=failed');
  console.log(`error_code=${failure.code ?? 'unknown'}`);
  process.exitCode = 1;
}
