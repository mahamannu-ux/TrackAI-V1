import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadMasterKeyring, MasterKeyring } from './master-key';

const ALGORITHM = 'aes-256-gcm' as const;
const SCHEMA_VERSION = 1 as const;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EnvelopeContext {
  tenantId: string;
  purpose: string;
  resourceId: string;
}

export interface EncryptedValue {
  schemaVersion: typeof SCHEMA_VERSION;
  algorithm: typeof ALGORITHM;
  masterKeyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  wrappedDataKey: {
    iv: string;
    ciphertext: string;
    authTag: string;
  };
}

interface CipherParts {
  iv: string;
  ciphertext: string;
  authTag: string;
}

function authenticatedContext(
  context: EnvelopeContext,
  stage: 'payload' | 'data-key',
  masterKeyVersion: string,
): Buffer {
  for (const [name, value] of Object.entries(context)) {
    if (!value || typeof value !== 'string') throw new Error(`Envelope context '${name}' is required`);
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    algorithm: ALGORITHM,
    masterKeyVersion,
    stage,
    tenantId: context.tenantId,
    purpose: context.purpose,
    resourceId: context.resourceId,
  }), 'utf8');
}

function encryptBytes(plaintext: Buffer, key: Buffer, aad: Buffer): CipherParts {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptBytes(value: CipherParts, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

export function encryptEnvelope(
  plaintext: string,
  context: EnvelopeContext,
  keyring: MasterKeyring = loadRuntimeKeyring(),
): EncryptedValue {
  const masterKeyVersion = keyring.activeVersion;
  const masterKey = keyring.keyFor(masterKeyVersion);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const encryptedPayload = encryptBytes(
      Buffer.from(plaintext, 'utf8'),
      dataKey,
      authenticatedContext(context, 'payload', masterKeyVersion),
    );
    const wrappedDataKey = encryptBytes(
      dataKey,
      masterKey,
      authenticatedContext(context, 'data-key', masterKeyVersion),
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      algorithm: ALGORITHM,
      masterKeyVersion,
      ...encryptedPayload,
      wrappedDataKey,
    };
  } finally {
    masterKey.fill(0);
    dataKey.fill(0);
  }
}

export function decryptEnvelope(
  envelope: EncryptedValue,
  context: EnvelopeContext,
  keyring: MasterKeyring = loadRuntimeKeyring(),
): string {
  if (envelope.schemaVersion !== SCHEMA_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error('Encrypted value uses an unsupported envelope format');
  }
  const masterKey = keyring.keyFor(envelope.masterKeyVersion);
  let dataKey: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    dataKey = decryptBytes(
      envelope.wrappedDataKey,
      masterKey,
      authenticatedContext(context, 'data-key', envelope.masterKeyVersion),
    );
    if (dataKey.length !== DATA_KEY_BYTES) throw new Error('Encrypted data key has an invalid length');
    plaintext = decryptBytes(
      envelope,
      dataKey,
      authenticatedContext(context, 'payload', envelope.masterKeyVersion),
    );
    return plaintext.toString('utf8');
  } finally {
    masterKey.fill(0);
    dataKey?.fill(0);
    plaintext?.fill(0);
  }
}

function loadRuntimeKeyring(): MasterKeyring {
  // Kept behind this small boundary so deployment adapters only inject environment values.
  // PostgreSQL and the encryption format remain independent of any cloud secret service.
  return loadMasterKeyring();
}
