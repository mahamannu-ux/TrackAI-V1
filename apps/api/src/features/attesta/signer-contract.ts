// Signing adapter contract: the interface every Attesta signer implements.
//
// [CONTRACT - FROZEN] Do not change this file once merged. New signers go in
// sibling modules (starting with `signer-local-dev.ts`); KMS adapters come in
// a later session and implement this same interface with no changes here.
//
// No custody: TrackAI never holds a customer's private key in production.
// The local dev signer below holds its own throwaway keys and refuses to run
// in production; every production signer delegates the cryptographic act to
// the tenant's own KMS/HSM and only ever returns public material. Signing is
// tenant-bound: `sign` takes the tenant it signs for and refuses a
// credential from another tenant, so a credential ID alone never authorizes
// cross-tenant use.
//
// Ported from SushiCorp A1 adapters/signing/base.py rev 1.1 @ 0bd67a5
// (catalog SG-1). Deviations: (1) no X.509 certificate chain - Attesta
// verifies against the raw SPKI public key, so the contract carries
// `publicKeySpkiDer` instead of `cert_chain`/`certificate_chain()`;
// (2) async methods (TrackAI signers may call KMS over the network);
// (3) ES256 only (Attesta statements sign P-256/SHA-256; no Ed25519/PS256);
// (4) the credential carries its `tenantId` (SushiCorp scopes by call, not
// by credential); (5) `signVerified` helper included: every signature is
// verified against the published public key before use.

import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Base class. Never thrown directly; use one of the two subclasses. */
export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

/**
 * Retryable: network failure, timeout, rate limit, KMS down. The caller
 * should retry with backoff and must not persist a partial record.
 */
export class SigningUnavailable extends SigningError {
  constructor(message: string) {
    super(message);
    this.name = 'SigningUnavailable';
  }
}

/**
 * Terminal: unknown/expired/revoked credential, malformed payload,
 * authorization denied. The caller must not retry.
 */
export class SigningRejected extends SigningError {
  constructor(message: string) {
    super(message);
    this.name = 'SigningRejected';
  }
}

/** ECDSA P-256 + SHA-256, DER-encoded signatures. The only algorithm. */
export type SigningAlgorithm = 'ES256';

export interface SigningCredential {
  credentialId: string;
  tenantId: string;
  displayName: string;
  algorithm: SigningAlgorithm;
  /** Raw SPKI DER bytes of the public key. Public material only. */
  publicKeySpkiDer: Buffer;
  /** RFC 3339 timestamps, when the signer knows them. */
  notBefore?: string;
  notAfter?: string;
}

export interface SigningCapabilities {
  adapterName: string;
  algorithms: readonly SigningAlgorithm[];
  maxPayloadBytes: number;
  supportsCredentialListing: boolean;
}

export interface SigningResult {
  /** DER-encoded ECDSA signature over `payload`. */
  signature: Buffer;
  algorithm: SigningAlgorithm;
  credentialId: string;
  /** Raw SPKI DER bytes of the key that signed. No private material. */
  publicKeySpkiDer: Buffer;
}

export interface SigningAdapter {
  /** Static declaration of what this adapter can do. Never signs. */
  capabilities(): SigningCapabilities;
  /**
   * Sign `payload` for `tenantId` with `credentialId`. Throws
   * SigningRejected for an unknown credential, a credential from another
   * tenant, or a malformed payload.
   */
  sign(
    payload: Buffer,
    credentialId: string,
    opts: { requestId: string; tenantId: string },
  ): Promise<SigningResult>;
  /**
   * Credentials available to this tenant. Adapters that cannot enumerate
   * return [] rather than throwing for that reason.
   */
  listCredentials(tenantId: string): Promise<SigningCredential[]>;
  /**
   * SPKI DER bytes of the public key for `credentialId`. Public material
   * only; never signs. Throws SigningRejected for an unknown credential.
   */
  publicKey(credentialId: string): Promise<Buffer>;
  /** Cheap liveness check. Never signs. */
  health(): Promise<boolean>;
}

/**
 * What `signVerified` signs for. One object (not positional strings that are
 * easy to swap): the credential to use, the tenant it signs for, and the
 * caller's request ID.
 */
export interface SignVerifiedRequest {
  credentialId: string;
  tenantId: string;
  requestId: string;
}

/**
 * Sign, then verify before use: fetches the published public key for
 * `credentialId` and throws SigningRejected when the adapter's answer cannot
 * be trusted — a non-Buffer field, a credential ID or algorithm that differs
 * from what was asked, a key that differs from the published one (byte
 * comparison), a published key that is not ECDSA P-256, or a signature that
 * does not verify over `payload`. The adapter answered but with something
 * unverifiable, so retrying cannot help: every failure in this block is
 * terminal. SigningUnavailable/SigningRejected from `sign`/`publicKey` pass
 * through unchanged; any other error (a contract violation by the adapter)
 * becomes SigningUnavailable.
 */
export async function signVerified(
  adapter: SigningAdapter,
  payload: Buffer,
  request: SignVerifiedRequest,
): Promise<SigningResult> {
  const { credentialId, tenantId, requestId } = request;
  let result: SigningResult;
  try {
    result = await adapter.sign(payload, credentialId, { requestId, tenantId });
  } catch (err) {
    if (err instanceof SigningError) throw err;
    throw new SigningUnavailable(
      `signer failed with a non-contract error: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  let published: Buffer;
  try {
    published = await adapter.publicKey(credentialId);
  } catch (err) {
    if (err instanceof SigningError) throw err;
    throw new SigningUnavailable(
      `signer failed with a non-contract error: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  if (
    result === null ||
    typeof result !== 'object' ||
    !Buffer.isBuffer(result.signature) ||
    !Buffer.isBuffer(result.publicKeySpkiDer) ||
    !Buffer.isBuffer(published)
  ) {
    throw new SigningRejected(
      `signature for ${credentialId} is malformed (request ${requestId})`,
    );
  }
  if (result.credentialId !== credentialId) {
    throw new SigningRejected(
      `signature for ${credentialId} came back under ${JSON.stringify(result.credentialId)} (request ${requestId})`,
    );
  }
  if (result.algorithm !== 'ES256') {
    throw new SigningRejected(
      `signature for ${credentialId} claims algorithm ${JSON.stringify(result.algorithm)} (request ${requestId})`,
    );
  }
  if (!result.publicKeySpkiDer.equals(published)) {
    throw new SigningRejected(
      `signature for ${credentialId} carries a key that differs from the published public key (request ${requestId})`,
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: published, format: 'der', type: 'spki' });
  } catch {
    throw new SigningRejected(
      `published public key for ${credentialId} is not parseable (request ${requestId})`,
    );
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new SigningRejected(
      `published public key for ${credentialId} is not ECDSA P-256 (request ${requestId})`,
    );
  }
  let ok: boolean;
  try {
    ok = verify('sha256', payload, { key, dsaEncoding: 'der' }, result.signature);
  } catch {
    throw new SigningRejected(
      `signature for ${credentialId} does not verify (request ${requestId})`,
    );
  }
  if (!ok) {
    throw new SigningRejected(
      `signature for ${credentialId} does not verify (request ${requestId})`,
    );
  }
  return result;
}
