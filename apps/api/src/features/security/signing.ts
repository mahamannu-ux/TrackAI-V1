/**
 * Signing the two security documents (Task20f, T20.8; security-v2 README "Rule bundle
 * and activation lease"; attesta trust.md "Consumers"):
 *   rule bundle       purpose policy_bundle,    audience platform
 *   activation lease  purpose activation_lease, audience platform
 *
 * Payload bytes are RFC 8785 (attesta/canonical.ts). They travel in Attesta's DSSE
 * envelope (envelope.md) with one signature whose keyid is `sha256:` + hex(SHA-256(SPKI
 * DER)), the form `verifyTrusted` looks up in the root document. Every signature goes
 * through the frozen signer contract's `signVerified` (verified against the published
 * key before use). The stored and served bytes are the exact envelope JSON written
 * here; nothing is ever re-serialized to verify (Task15i2 lesson).
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../attesta/canonical';
import { ATTESTA_PLATFORM_TENANT_ID } from '../attesta/anchor-contract';
import { pae, type DsseEnvelope } from '../attesta/dsse';
import { SigningError, SigningRejected, signVerified, type SigningAdapter } from '../attesta/signer-contract';

/** DSSE payload types (Task20f decision: the frozen contract names none; Task20g checks these). */
export const SECURITY_RULE_BUNDLE_PAYLOAD_TYPE = 'application/vnd.trackai.security-rule-bundle+json';
export const SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE = 'application/vnd.trackai.security-activation-lease+json';

export type SecurityDocumentPurpose = 'policy_bundle' | 'activation_lease';

export const PAYLOAD_TYPE_BY_PURPOSE: Readonly<Record<SecurityDocumentPurpose, string>> = {
  policy_bundle: SECURITY_RULE_BUNDLE_PAYLOAD_TYPE,
  activation_lease: SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE,
};

/** Signing could not happen now (no key, KMS down, payload over the signer's limit). Nothing is written. */
export class SecuritySigningUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecuritySigningUnavailable';
  }
}

/**
 * The document is larger than the signer accepts. Today both Attesta adapters cap a
 * payload at 1 MiB (signer-kms.ts / signer-local-dev.ts) although the bundle contract
 * allows 4 MiB; the KMS adapter hashes locally, so the cap is the adapter's, not KMS's.
 * Nothing is written; the change must override fewer rules until Task15 raises the cap.
 */
export class SecurityDocumentTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityDocumentTooLarge';
  }
}

/** The adapter and credential to sign one purpose with, resolved per signature. */
export interface ResolvedSecuritySigner {
  adapter: SigningAdapter;
  credentialId: string;
}

export interface SecurityDocumentSigner {
  purpose: SecurityDocumentPurpose;
  /** Resolved on every call, so a rotation or revocation applies at once. */
  resolve(): Promise<ResolvedSecuritySigner>;
}

export interface SignedSecurityDocument {
  /** The exact canonical payload bytes that were signed. */
  payload: Buffer;
  /** Hex SHA-256 of `payload`: the bundle digest (never of the envelope). */
  digest: string;
  envelope: DsseEnvelope;
  /** The exact envelope JSON bytes stored and served. */
  envelopeBytes: Buffer;
  keyid: string;
}

export function keyidOf(spkiDer: Buffer): string {
  return `sha256:${createHash('sha256').update(spkiDer).digest('hex')}`;
}

/** Canonicalize, sign through `signVerified`, wrap in DSSE. */
export async function signSecurityDocument(signer: SecurityDocumentSigner, document: unknown): Promise<SignedSecurityDocument> {
  const payload = Buffer.from(canonicalize(document), 'utf8');
  const payloadType = PAYLOAD_TYPE_BY_PURPOSE[signer.purpose];
  const bytesToSign = pae(payloadType, payload);
  let resolved: ResolvedSecuritySigner;
  try {
    resolved = await signer.resolve();
  } catch (err) {
    if (err instanceof SecuritySigningUnavailable) throw err;
    throw new SecuritySigningUnavailable(`no usable ${signer.purpose} key`, { cause: err });
  }
  const limit = resolved.adapter.capabilities().maxPayloadBytes;
  if (bytesToSign.length > limit) {
    throw new SecurityDocumentTooLarge(`the ${signer.purpose} document is ${bytesToSign.length} bytes; the signer accepts at most ${limit}`);
  }
  let signature: Buffer;
  let spki: Buffer;
  try {
    const result = await signVerified(resolved.adapter, bytesToSign, {
      credentialId: resolved.credentialId,
      tenantId: ATTESTA_PLATFORM_TENANT_ID,
      requestId: `${signer.purpose}-${randomUUID()}`,
    });
    signature = result.signature;
    spki = result.publicKeySpkiDer;
  } catch (err) {
    if (err instanceof SigningRejected) throw new SecuritySigningUnavailable(`the ${signer.purpose} key refused to sign`, { cause: err });
    if (err instanceof SigningError) throw new SecuritySigningUnavailable(`the ${signer.purpose} signer is unavailable`, { cause: err });
    throw new SecuritySigningUnavailable(`the ${signer.purpose} signer failed`, { cause: err });
  }
  const keyid = keyidOf(spki);
  const envelope: DsseEnvelope = {
    payload: payload.toString('base64'),
    payloadType,
    signatures: [{ keyid, sig: signature.toString('base64') }],
  };
  return {
    payload,
    digest: createHash('sha256').update(payload).digest('hex'),
    envelope,
    envelopeBytes: Buffer.from(JSON.stringify(envelope), 'utf8'),
    keyid,
  };
}

/** A fixed adapter and credential (tests and the development signer). */
export function fixedSigner(purpose: SecurityDocumentPurpose, adapter: SigningAdapter, credentialId: string): SecurityDocumentSigner {
  return { purpose, resolve: async () => ({ adapter, credentialId }) };
}
