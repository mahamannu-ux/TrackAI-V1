import {
  machineCredentialIsUsable,
  parseMachineCredential,
  verifyMachineCredentialSecret,
} from './machine-credential';

export interface StoredManagedMachineCredential {
  tenantId: string;
  machineId: string;
  keyId: string;
  secretHash: string;
  credentialStatus: string;
  expiresAt: Date | null;
  credentialRevokedAt: Date | null;
  machineStatus: string;
  machineRevokedAt: Date | null;
}

export interface ManagedMachineIdentity {
  tenantId: string;
  machineId: string;
  keyId: string;
}

export type ManagedCredentialLookup = (
  keyId: string,
) => Promise<StoredManagedMachineCredential | null>;

export function isManagedMachineCredential(value: string): boolean {
  return value.startsWith('trk_v1.');
}

export async function resolveManagedMachineCredential(
  plaintext: string,
  lookup: ManagedCredentialLookup,
  now = new Date(),
): Promise<ManagedMachineIdentity | null> {
  let parsed;
  try {
    parsed = parseMachineCredential(plaintext);
  } catch {
    return null;
  }

  const stored = await lookup(parsed.keyId);
  if (!stored
    || stored.keyId !== parsed.keyId
    || stored.machineStatus !== 'active'
    || stored.machineRevokedAt !== null
    || !machineCredentialIsUsable({
      status: stored.credentialStatus,
      expiresAt: stored.expiresAt,
      revokedAt: stored.credentialRevokedAt,
    }, now)
    || !verifyMachineCredentialSecret(parsed.secret, stored.secretHash)) {
    return null;
  }

  return {
    tenantId: stored.tenantId,
    machineId: stored.machineId,
    keyId: stored.keyId,
  };
}
