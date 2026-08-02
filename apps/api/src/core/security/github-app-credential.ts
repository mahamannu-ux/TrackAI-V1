import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  decryptEnvelope,
  encryptEnvelope,
  type EncryptedValue,
} from './envelope-encryption';
import type { MasterKeyring } from './master-key';

const PURPOSE = 'github-app-private-key';

export interface GitHubAppCredentialContext {
  tenantId: string;
  credentialId: string;
}

export interface PreparedGitHubAppCredential {
  encryptedCredential: EncryptedValue;
  masterKeyVersion: string;
  credentialFingerprint: string;
}

export interface GitHubAppCredentialState {
  id: string;
  installationId: string;
  masterKeyVersion: string;
  credentialFingerprint: string;
  status: 'active' | 'retiring' | 'revoked';
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  revokedAt: Date | null;
}

export type GitHubAppCredentialMetadata = Omit<GitHubAppCredentialState, never>;

function envelopeContext(context: GitHubAppCredentialContext) {
  return {
    tenantId: context.tenantId,
    purpose: PURPOSE,
    resourceId: context.credentialId,
  };
}

function canonicalPrivateKey(privateKeyPem: string): string {
  if (!privateKeyPem.trim()) throw new Error('GitHub App private key is required');
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error('GitHub App private key must be an RSA private key');
    }
    return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be an RSA')) throw error;
    throw new Error('GitHub App private key is invalid');
  }
}

function publicKeyFingerprint(canonicalPem: string): string {
  const publicDer = createPublicKey(canonicalPem).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(publicDer).digest('hex');
}

export function prepareGitHubAppCredential(
  privateKeyPem: string,
  context: GitHubAppCredentialContext,
  keyring?: MasterKeyring,
): PreparedGitHubAppCredential {
  const canonicalPem = canonicalPrivateKey(privateKeyPem);
  const encryptedCredential = encryptEnvelope(canonicalPem, envelopeContext(context), keyring);
  return {
    encryptedCredential,
    masterKeyVersion: encryptedCredential.masterKeyVersion,
    credentialFingerprint: publicKeyFingerprint(canonicalPem),
  };
}

export function decryptGitHubAppCredential(
  encryptedCredential: EncryptedValue,
  expectedFingerprint: string,
  context: GitHubAppCredentialContext,
  keyring?: MasterKeyring,
): string {
  const privateKeyPem = decryptEnvelope(
    encryptedCredential,
    envelopeContext(context),
    keyring,
  );
  if (publicKeyFingerprint(privateKeyPem) !== expectedFingerprint) {
    throw new Error('GitHub App credential fingerprint does not match');
  }
  return privateKeyPem;
}

export function githubAppCredentialIsUsable(
  credential: Pick<
    GitHubAppCredentialState,
    'status' | 'effectiveFrom' | 'effectiveUntil' | 'revokedAt'
  >,
  now = new Date(),
): boolean {
  return (
    (credential.status === 'active' || credential.status === 'retiring')
    && credential.revokedAt === null
    && credential.effectiveFrom <= now
    && (credential.effectiveUntil === null || credential.effectiveUntil > now)
  );
}

/** Never return ciphertext or private-key material through an administration API. */
export function githubAppCredentialMetadata(
  credential: GitHubAppCredentialState,
): GitHubAppCredentialMetadata {
  return {
    id: credential.id,
    installationId: credential.installationId,
    masterKeyVersion: credential.masterKeyVersion,
    credentialFingerprint: credential.credentialFingerprint,
    status: credential.status,
    effectiveFrom: credential.effectiveFrom,
    effectiveUntil: credential.effectiveUntil,
    revokedAt: credential.revokedAt,
  };
}

export function githubAppPermissionsAreReadOnly(
  permissions: Record<string, string>,
): boolean {
  if (permissions.contents !== 'read' || permissions.pull_requests !== 'read') return false;
  return Object.values(permissions).every(value => value === 'read' || value === 'none');
}
