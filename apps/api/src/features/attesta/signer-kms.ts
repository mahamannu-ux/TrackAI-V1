// Customer-held cloud KMS signer: one SigningAdapter over AWS KMS and
// Google Cloud KMS providers. TrackAI never holds a customer's private key:
// the cryptographic act happens inside the tenant's own KMS and only public
// material (DER SPKI keys, DER signatures) crosses the boundary. Each
// credential pins the expected public key (`publicKeySha256`): a KMS that
// answers with a different key is refused, and every signature is verified
// locally against the pinned key before it is returned. Payloads and key
// references are never logged and never appear in error messages.
//
// Ported from SushiCorp A1b adapters/signing/{kms,kms_aws,kms_google,
// protocols}.py @ 0bd67a5 (catalog SG-1). Deviations: (1) no certificate
// chain - Attesta verifies against a pinned SPKI hash instead, as in
// Task15b; (2) async methods; (3) the credential carries its `tenantId` and
// `sign` refuses cross-tenant use (SushiCorp scopes by call, not by
// credential); (4) GCP CRC32C integrity checks on public keys and
// signatures; (5) P-256 only, enforced on the fetched key, not just the
// configured chain; (6) public keys are cached per credential for at most 5
// minutes; (7) ES256 only with DER signatures (Attesta/DSSE form).

import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  SigningRejected,
  SigningUnavailable,
  type SigningAdapter,
  type SigningCapabilities,
  type SigningCredential,
  type SigningResult,
} from './signer-contract';

export const KMS_AWS_ADAPTER_NAME = 'kms-aws';
export const KMS_GCP_ADAPTER_NAME = 'kms-gcp';
export const KMS_MAX_PAYLOAD_BYTES = 1_048_576;
export const AWS_CREDENTIAL_PREFIX = 'aws-kms:';
export const GCP_CREDENTIAL_PREFIX = 'gcp-kms:';
/** Public keys are cached per credential for at most 5 minutes. */
export const KMS_PUBLIC_KEY_CACHE_MS = 5 * 60 * 1000;

/**
 * Narrow provider seam: each cloud KMS client does only the vendor-specific
 * remote calls. Payload validation, pin checks and signature verification
 * live in `KmsSigner`, so every path is testable without network access.
 */
export interface KmsProvider {
  readonly name: 'aws' | 'gcp';
  /** DER SubjectPublicKeyInfo bytes of the provider key. Public material only. */
  publicKeySpkiDer(keyReference: string): Promise<Buffer>;
  /** DER-encoded ECDSA P-256 signature over the SHA-256 `digest`. */
  signDigest(keyReference: string, digest: Buffer, requestId: string): Promise<Buffer>;
  /** Cheap liveness check. Never signs. */
  health(): Promise<boolean>;
}

export interface KmsCredentialInput {
  credentialId: string;
  tenantId: string;
  displayName: string;
  /** Vendor key identifier (ARN, resource name). Never logged, never in errors. */
  keyReference: string;
  /** Pinned key: `sha256:` + lowercase hex of the expected DER SPKI. */
  publicKeySha256: string;
}

interface LoadedCredential {
  credentialId: string;
  tenantId: string;
  displayName: string;
  keyReference: string;
  publicKeySha256: string;
}

const CREDENTIAL_FIELDS = [
  'credentialId',
  'tenantId',
  'displayName',
  'keyReference',
  'publicKeySha256',
] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse KMS credentials from a JSON list string, rejecting unknown or
 * missing fields (as `_credentials_from_config` does). Duplicate ids and
 * provider-prefix mismatches are refused by the `KmsSigner` constructor,
 * which knows the provider.
 */
export function kmsCredentialsFromJson(text: string): KmsCredentialInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SigningRejected('KMS credentials_json is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new SigningRejected('KMS credentials_json must be a list');
  }
  const out: KmsCredentialInput[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SigningRejected('each KMS credential must be an object');
    }
    const record = item as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!(CREDENTIAL_FIELDS as readonly string[]).includes(field)) {
        throw new SigningRejected(`KMS credential has an unknown field ${JSON.stringify(field)}`);
      }
    }
    for (const field of CREDENTIAL_FIELDS) {
      if (!isNonEmptyString(record[field])) {
        throw new SigningRejected(`KMS credential is missing ${JSON.stringify(field)}`);
      }
    }
    out.push({
      credentialId: record.credentialId as string,
      tenantId: record.tenantId as string,
      displayName: record.displayName as string,
      keyReference: record.keyReference as string,
      publicKeySha256: record.publicKeySha256 as string,
    });
  }
  return out;
}

function pinOf(spkiDer: Buffer): string {
  return `sha256:${createHash('sha256').update(spkiDer).digest('hex')}`;
}

function checkP256(spkiDer: Buffer, credentialId: string, requestId: string): void {
  let key;
  try {
    key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw new SigningRejected(
      `KMS key for ${JSON.stringify(credentialId)} is not parseable (request ${requestId})`,
    );
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new SigningRejected(
      `KMS key for ${JSON.stringify(credentialId)} is not ECDSA P-256 (request ${requestId})`,
    );
  }
}

export class KmsSigner implements SigningAdapter {
  private readonly provider: KmsProvider;
  private readonly credentials = new Map<string, LoadedCredential>();
  private readonly clock: () => number;
  private readonly keyCache = new Map<string, { spkiDer: Buffer; fetchedAt: number }>();

  constructor(options: {
    provider: KmsProvider;
    credentials: KmsCredentialInput[];
    clock?: () => number;
  }) {
    this.provider = options.provider;
    this.clock = options.clock ?? (() => Date.now());
    if (options.credentials.length === 0) {
      throw new SigningRejected('KMS signer requires at least one credential');
    }
    const expectedPrefix =
      options.provider.name === 'aws' ? AWS_CREDENTIAL_PREFIX : GCP_CREDENTIAL_PREFIX;
    for (const input of options.credentials) {
      if (!input.credentialId.startsWith(expectedPrefix)) {
        throw new SigningRejected(
          `credential ${JSON.stringify(input.credentialId)} does not match provider ${JSON.stringify(options.provider.name)} (must start with ${JSON.stringify(expectedPrefix)})`,
        );
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(input.publicKeySha256)) {
        throw new SigningRejected(
          `credential ${JSON.stringify(input.credentialId)} has an invalid publicKeySha256 pin (must be "sha256:" + 64 hex chars)`,
        );
      }
      if (this.credentials.has(input.credentialId)) {
        throw new SigningRejected(
          `duplicate credential ${JSON.stringify(input.credentialId)}`,
        );
      }
      this.credentials.set(input.credentialId, { ...input });
    }
  }

  capabilities(): SigningCapabilities {
    return {
      adapterName: this.provider.name === 'aws' ? KMS_AWS_ADAPTER_NAME : KMS_GCP_ADAPTER_NAME,
      algorithms: ['ES256'],
      maxPayloadBytes: KMS_MAX_PAYLOAD_BYTES,
      supportsCredentialListing: true,
    };
  }

  async sign(
    payload: Buffer,
    credentialId: string,
    opts: { requestId: string; tenantId: string },
  ): Promise<SigningResult> {
    const credential = this.credentials.get(credentialId);
    if (credential === undefined) {
      throw new SigningRejected(
        `unknown credential ${JSON.stringify(credentialId)} (request ${opts.requestId})`,
      );
    }
    if (credential.tenantId !== opts.tenantId) {
      throw new SigningRejected(
        `credential ${JSON.stringify(credentialId)} does not belong to tenant ${JSON.stringify(opts.tenantId)} (request ${opts.requestId})`,
      );
    }
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
      throw new SigningRejected(
        `payload must be a non-empty Buffer (request ${opts.requestId})`,
      );
    }
    if (payload.length > KMS_MAX_PAYLOAD_BYTES) {
      throw new SigningRejected(
        `payload of ${payload.length} bytes exceeds ${KMS_MAX_PAYLOAD_BYTES} (request ${opts.requestId})`,
      );
    }
    const spkiDer = await this.checkedPublicKey(credential, opts.requestId);
    const digest = createHash('sha256').update(payload).digest();
    let signature: Buffer;
    try {
      signature = await this.provider.signDigest(
        credential.keyReference,
        digest,
        opts.requestId,
      );
    } catch (err) {
      if (err instanceof SigningRejected || err instanceof SigningUnavailable) throw err;
      throw new SigningUnavailable(
        `KMS sign failed with a non-contract error (request ${opts.requestId})`,
      );
    }
    if (!Buffer.isBuffer(signature)) {
      throw new SigningRejected(
        `signature for ${JSON.stringify(credentialId)} is malformed (request ${opts.requestId})`,
      );
    }
    // Verify locally against the pinned key before returning: a signature
    // made by another key (or non-DER garbage) is refused here, not passed on.
    let ok = false;
    try {
      const key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
      ok = verify('sha256', payload, { key, dsaEncoding: 'der' }, signature);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new SigningRejected(
        `signature for ${JSON.stringify(credentialId)} does not verify (request ${opts.requestId})`,
      );
    }
    return {
      signature: Buffer.from(signature),
      algorithm: 'ES256',
      credentialId: credential.credentialId,
      publicKeySpkiDer: Buffer.from(spkiDer),
    };
  }

  async listCredentials(tenantId: string): Promise<SigningCredential[]> {
    const out: SigningCredential[] = [];
    for (const credential of this.credentials.values()) {
      if (credential.tenantId !== tenantId) continue;
      const spkiDer = await this.pinnedPublicKey(credential, 'list-credentials');
      out.push({
        credentialId: credential.credentialId,
        tenantId: credential.tenantId,
        displayName: credential.displayName,
        algorithm: 'ES256',
        publicKeySpkiDer: spkiDer,
      });
    }
    return out;
  }

  async publicKey(credentialId: string): Promise<Buffer> {
    const credential = this.credentials.get(credentialId);
    if (credential === undefined) {
      throw new SigningRejected(`unknown credential ${JSON.stringify(credentialId)}`);
    }
    return this.pinnedPublicKey(credential, 'public-key');
  }

  async health(): Promise<boolean> {
    try {
      if (!(await this.provider.health())) return false;
      for (const credential of this.credentials.values()) {
        const spkiDer = await this.fetchPublicKey(credential, 'health');
        if (pinOf(spkiDer) !== credential.publicKeySha256) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Provider key, cached per credential for at most 5 minutes. */
  private async fetchPublicKey(
    credential: LoadedCredential,
    requestId: string,
  ): Promise<Buffer> {
    const cached = this.keyCache.get(credential.credentialId);
    if (cached !== undefined && this.clock() - cached.fetchedAt < KMS_PUBLIC_KEY_CACHE_MS) {
      return Buffer.from(cached.spkiDer);
    }
    let spkiDer: Buffer;
    try {
      spkiDer = await this.provider.publicKeySpkiDer(credential.keyReference);
    } catch (err) {
      if (err instanceof SigningRejected || err instanceof SigningUnavailable) throw err;
      throw new SigningUnavailable(
        `KMS public key fetch failed with a non-contract error (request ${requestId})`,
      );
    }
    if (!Buffer.isBuffer(spkiDer)) {
      throw new SigningUnavailable('KMS returned a malformed public key');
    }
    this.keyCache.set(credential.credentialId, {
      spkiDer: Buffer.from(spkiDer),
      fetchedAt: this.clock(),
    });
    return Buffer.from(spkiDer);
  }

  /** Fetched key, refused unless its SHA-256 equals the configured pin. */
  private async pinnedPublicKey(
    credential: LoadedCredential,
    requestId: string,
  ): Promise<Buffer> {
    const spkiDer = await this.fetchPublicKey(credential, requestId);
    if (pinOf(spkiDer) !== credential.publicKeySha256) {
      throw new SigningRejected(
        `KMS key for ${JSON.stringify(credential.credentialId)} does not match the pinned public key (request ${requestId})`,
      );
    }
    return spkiDer;
  }

  /** Pinned key, refused unless it parses as ECDSA P-256. */
  private async checkedPublicKey(
    credential: LoadedCredential,
    requestId: string,
  ): Promise<Buffer> {
    const spkiDer = await this.pinnedPublicKey(credential, requestId);
    checkP256(spkiDer, credential.credentialId, requestId);
    return spkiDer;
  }
}
