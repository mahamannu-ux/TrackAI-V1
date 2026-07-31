import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'trk_v1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface CreatedMachineCredential {
  plaintext: string;
  keyId: string;
  secretHash: string;
}

export interface ParsedMachineCredential {
  keyId: string;
  secret: string;
}

export interface MachineCredentialState {
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function createMachineCredential(): CreatedMachineCredential {
  const keyId = randomBytes(12).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    plaintext: `${TOKEN_PREFIX}.${keyId}.${secret}`,
    keyId,
    secretHash: hashSecret(secret),
  };
}

export function parseMachineCredential(value: string): ParsedMachineCredential {
  const [prefix, keyId, secret, extra] = value.split('.');
  if (prefix !== TOKEN_PREFIX || extra !== undefined
    || !KEY_ID_PATTERN.test(keyId ?? '') || !SECRET_PATTERN.test(secret ?? '')) {
    throw new Error('Machine credential has an invalid format');
  }
  return { keyId, secret };
}

export function verifyMachineCredentialSecret(secret: string, storedHash: string): boolean {
  if (!SECRET_PATTERN.test(secret) || !HASH_PATTERN.test(storedHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashSecret(secret), 'hex'),
    Buffer.from(storedHash, 'hex'),
  );
}

export function machineCredentialIsUsable(
  credential: MachineCredentialState,
  now = new Date(),
): boolean {
  return credential.status === 'active'
    && credential.revokedAt === null
    && (credential.expiresAt === null || credential.expiresAt.getTime() > now.getTime());
}
