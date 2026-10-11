// DSSE (Dead Simple Signing Envelope) v1, after
// https://github.com/secure-systems-lab/dsse. New code: SushiCorp has no
// DSSE envelope (Attesta statements use it to stay compatible with `cosign
// verify-attestation`, Rekor `dsse` entries, and SLSA tooling).
// Signatures are ECDSA P-256 over SHA-256, DER-encoded. Verification never
// throws on malformed input: it reports per-signature errors instead.

import { verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

/**
 * Pre-Authentication Encoding: `"DSSEv1" SP LEN(type) SP type SP LEN(body)
 * SP body`, where lengths are ASCII decimal counts of *bytes*.
 */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  const header = `DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `;
  return Buffer.concat([Buffer.from(header, 'utf8'), payload]);
}

export interface DsseEnvelope {
  /** base64-encoded payload bytes */
  payload: string;
  payloadType: string;
  signatures: Array<{
    keyid: string;
    /** base64-encoded DER signature */
    sig: string;
  }>;
}

export type SignFn = (pae: Buffer) => Promise<{ keyid: string; sig: Buffer }>;

export async function signEnvelope(
  payloadType: string,
  payload: Buffer,
  sign: SignFn,
): Promise<DsseEnvelope> {
  const { keyid, sig } = await sign(pae(payloadType, payload));
  return {
    payload: payload.toString('base64'),
    payloadType,
    signatures: [{ keyid, sig: sig.toString('base64') }],
  };
}

export interface EnvelopeVerification {
  ok: boolean;
  verifiedKeyids: string[];
  errors: string[];
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Strict(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  if (value === '') return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

/**
 * Verify every signature against `keys` (keyed by keyid). `ok` is true only
 * when at least one signature verifies AND no signature uses an unknown
 * keyid. Never throws: malformed envelopes yield `errors`.
 */
export function verifyEnvelope(
  env: DsseEnvelope,
  keys: Record<string, KeyObject>,
): EnvelopeVerification {
  const errors: string[] = [];
  const verifiedKeyids: string[] = [];
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return { ok: false, verifiedKeyids, errors: ['envelope must be an object'] };
  }
  if (typeof env.payloadType !== 'string' || typeof env.payload !== 'string') {
    return { ok: false, verifiedKeyids, errors: ['envelope payload and payloadType must be strings'] };
  }
  if (!Array.isArray(env.signatures) || env.signatures.length === 0) {
    return { ok: false, verifiedKeyids, errors: ['envelope has no signatures'] };
  }
  const payload = decodeBase64Strict(env.payload);
  if (payload === null) {
    return { ok: false, verifiedKeyids, errors: ['envelope payload is not valid base64'] };
  }
  const paeBytes = pae(env.payloadType, payload);
  let unknownKeyid = false;
  for (const entry of env.signatures) {
    if (typeof entry !== 'object' || entry === null) {
      errors.push('signature entry must be an object');
      continue;
    }
    const { keyid, sig } = entry as { keyid: unknown; sig: unknown };
    if (typeof keyid !== 'string' || typeof sig !== 'string') {
      errors.push('signature entry must have string keyid and sig');
      continue;
    }
    const key = keys[keyid];
    if (!key) {
      unknownKeyid = true;
      errors.push(`unknown keyid ${JSON.stringify(keyid)}`);
      continue;
    }
    const sigBytes = decodeBase64Strict(sig);
    if (sigBytes === null) {
      errors.push(`signature for keyid ${JSON.stringify(keyid)} is not valid base64`);
      continue;
    }
    let valid = false;
    try {
      valid = verify('sha256', paeBytes, key, sigBytes);
    } catch {
      valid = false;
    }
    if (valid) {
      verifiedKeyids.push(keyid);
    } else {
      errors.push(`signature for keyid ${JSON.stringify(keyid)} does not verify`);
    }
  }
  const ok = verifiedKeyids.length > 0 && !unknownKeyid;
  return { ok, verifiedKeyids, errors };
}
