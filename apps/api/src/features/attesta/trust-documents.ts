/**
 * Trust documents (Task15l, A15.12): bounded parsing and strict validation of root
 * documents and key sets, building and signing them, the forward-only rule between
 * versions, and the per-key validity rule. Pure: no database, no network, no clock.
 *
 * The validator is hand-written (it mirrors trust-document-v1.schema.json; the test
 * cross-checks both) so the verifier needs no schema file at run time and ports
 * one-to-one to GitAI's Rust verifier.
 *
 * Ported from SushiCorp B4 core/trust/revocation.py @ 0bd67a5 (catalog TR-1): a
 * stale, missing or future-dated source is UNKNOWN (here `unavailable`), never
 * CLEAN. Deviation: a document that is present but forged, garbled or under-signed
 * is `rejected` (tamper evidence), where SushiCorp's CRL path reports UNKNOWN;
 * neither ever verifies. Key purposes, key-set documents and the forward-only rule
 * are new (trust.md "Provenance").
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalize, CanonicalizationError, sha256Prefixed } from './canonical';
import { pae, type DsseEnvelope } from './dsse';
import {
  KEYSET_PAYLOAD_TYPE,
  KEYSET_TYPE,
  KEY_PURPOSES,
  PLATFORM_ONLINE_PURPOSES,
  PLATFORM_SCOPE,
  TRUST_MAX_DOCUMENT_BYTES,
  TRUST_MAX_KEYS_PER_DOCUMENT,
  TRUST_MAX_KEYSET_LIFETIME_MS,
  TRUST_MAX_ROOT_LIFETIME_MS,
  TRUST_MAX_SIGNATURES_PER_DOCUMENT,
  TRUST_ROOT_PAYLOAD_TYPE,
  TRUST_ROOT_TYPE,
  type KeyPurpose,
  type KeyStatus,
  type TimeEvidence,
  type TrustCode,
  type TrustDocumentBody,
  type TrustKeyEntry,
} from './trust-contract';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TS_RE = /^(19|20|21)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const SPKI_B64_RE = /^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE[A-Za-z0-9+/]{85}[AQgw]==$/;
const BASE64_RE = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KEY_FIELDS = new Set(['keyid', 'purpose', 'spki_der_b64', 'not_before', 'not_after', 'status', 'revoked_at', 'revocation_reason', 'compromised_since']);
const DOC_FIELDS = new Set(['_type', 'scope', 'version', 'issued_at', 'expires', 'previous', 'threshold', 'keys']);
const STATUS_ORDER: Record<KeyStatus, number> = { active: 0, retired: 1, revoked: 2 };

/** A trust code with a short reason for logs (never raw values). */
export class TrustDocumentError extends Error {
  constructor(readonly code: TrustCode, message: string) {
    super(message);
    this.name = 'TrustDocumentError';
  }
}

/** RFC 3339 UTC with milliseconds and a real instant; returns epoch ms or null. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !TS_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null;
  return ms;
}

export function decodeBase64Strict(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64_RE.test(value)) return null;
  return Buffer.from(value, 'base64');
}

export function keyidOf(spkiDer: Buffer): string {
  return sha256Prefixed(spkiDer);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A key entry with its parsed times and public key. */
export interface ParsedKey {
  entry: TrustKeyEntry;
  key: KeyObject;
  notBefore: number;
  notAfter: number;
  revokedAt: number | null;
  compromisedSince: number | null;
}

/** Validate one key entry (document or customer pin). Throws DOCUMENT_MALFORMED. */
export function parseKeyEntry(raw: unknown, allowed: readonly KeyPurpose[]): ParsedKey {
  const bad = (why: string) => new TrustDocumentError('ATTESTA_TRUST_DOCUMENT_MALFORMED', `key entry: ${why}`);
  if (!isRecord(raw)) throw bad('not an object');
  for (const k of Object.keys(raw)) if (!KEY_FIELDS.has(k)) throw bad('unknown field');
  const { keyid, purpose, spki_der_b64: spkiB64, status, revocation_reason: reason } = raw;
  if (typeof keyid !== 'string' || !DIGEST_RE.test(keyid)) throw bad('keyid');
  if (typeof purpose !== 'string' || !(KEY_PURPOSES as readonly string[]).includes(purpose)) throw bad('purpose');
  if (!allowed.includes(purpose as KeyPurpose)) throw bad('purpose not allowed in this document');
  if (typeof spkiB64 !== 'string' || !SPKI_B64_RE.test(spkiB64)) throw bad('spki_der_b64');
  const spki = Buffer.from(spkiB64, 'base64');
  if (keyidOf(spki) !== keyid) throw bad('keyid is not the SHA-256 of the SPKI');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw bad('SPKI does not parse');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw bad('not P-256');
  const notBefore = parseTimestamp(raw.not_before);
  const notAfter = parseTimestamp(raw.not_after);
  if (notBefore === null || notAfter === null || notBefore >= notAfter) throw bad('validity');
  if (status !== 'active' && status !== 'retired' && status !== 'revoked') throw bad('status');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  let revokedAt: number | null = null;
  let compromisedSince: number | null = null;
  if (status === 'active') {
    if (has('revoked_at') || has('revocation_reason') || has('compromised_since')) throw bad('active key with revocation fields');
  } else {
    revokedAt = parseTimestamp(raw.revoked_at);
    if (revokedAt === null) throw bad('revoked_at');
    if (status === 'retired') {
      if (has('revocation_reason') || has('compromised_since')) throw bad('retired key with a revocation reason');
    } else if (reason === 'superseded') {
      if (has('compromised_since')) throw bad('superseded key with compromised_since');
    } else if (reason === 'compromised') {
      compromisedSince = parseTimestamp(raw.compromised_since);
      if (compromisedSince === null || compromisedSince > revokedAt) throw bad('compromised_since');
    } else {
      throw bad('revocation_reason');
    }
  }
  return {
    entry: raw as unknown as TrustKeyEntry,
    key, notBefore, notAfter, revokedAt, compromisedSince,
  };
}

export type DocumentKind = 'root' | 'keyset';

/** A trust document that passed bounded parsing and validation (not yet its signatures). */
export interface ParsedDocument {
  kind: DocumentKind;
  envelope: DsseEnvelope;
  payload: Buffer;
  /** `sha256:` of the payload bytes: what the next version's `previous` names. */
  digest: string;
  body: TrustDocumentBody;
  issuedAt: number;
  expires: number;
  keys: Map<string, ParsedKey>;
  /** Signatures in the envelope, shape-checked, keyids distinct. */
  signatures: Array<{ keyid: string; sig: Buffer }>;
}

/**
 * Parse a trust document envelope: bounds first, then base64, JSON, its RFC 8785
 * form, the closed shape, every key entry (keyid recomputed, P-256), time order.
 * Signatures are only shape-checked here. Throws TrustDocumentError (MALFORMED).
 */
export function parseTrustDocument(envelope: unknown): ParsedDocument {
  const bad = (why: string) => new TrustDocumentError('ATTESTA_TRUST_DOCUMENT_MALFORMED', `trust document: ${why}`);
  if (!isRecord(envelope)) throw bad('envelope is not an object');
  for (const k of Object.keys(envelope)) if (!['payload', 'payloadType', 'signatures'].includes(k)) throw bad('envelope has an unknown field');
  const { payloadType, signatures } = envelope;
  let kind: DocumentKind;
  if (payloadType === TRUST_ROOT_PAYLOAD_TYPE) kind = 'root';
  else if (payloadType === KEYSET_PAYLOAD_TYPE) kind = 'keyset';
  else throw bad('payloadType');
  const payload = decodeBase64Strict(envelope.payload, TRUST_MAX_DOCUMENT_BYTES);
  if (payload === null || payload.length === 0 || payload.length > TRUST_MAX_DOCUMENT_BYTES) throw bad('payload size or base64');
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > TRUST_MAX_SIGNATURES_PER_DOCUMENT) throw bad('signature count');
  const sigs: Array<{ keyid: string; sig: Buffer }> = [];
  const sigIds = new Set<string>();
  for (const s of signatures) {
    if (!isRecord(s) || Object.keys(s).some((k) => k !== 'keyid' && k !== 'sig')) throw bad('signature entry');
    const sig = decodeBase64Strict(s.sig, 256);
    if (typeof s.keyid !== 'string' || !DIGEST_RE.test(s.keyid) || sig === null || sig.length === 0) throw bad('signature entry');
    if (sigIds.has(s.keyid)) throw bad('two signatures with one keyid');
    sigIds.add(s.keyid);
    sigs.push({ keyid: s.keyid, sig });
  }
  const text = payload.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad('payload is not JSON');
  }
  try {
    if (canonicalize(parsed) !== text || !Buffer.from(text, 'utf8').equals(payload)) throw bad('payload is not its RFC 8785 form');
  } catch (err) {
    if (err instanceof CanonicalizationError) throw bad('payload cannot be canonicalized');
    throw err;
  }
  if (!isRecord(parsed)) throw bad('payload is not an object');
  const body = parsed;
  for (const k of Object.keys(body)) if (!DOC_FIELDS.has(k)) throw bad('unknown field');
  const expectedType = kind === 'root' ? TRUST_ROOT_TYPE : KEYSET_TYPE;
  if (body._type !== expectedType) throw bad('_type does not match payloadType');
  const { scope, version, previous, threshold, keys } = body;
  if (kind === 'root' ? scope !== PLATFORM_SCOPE : typeof scope !== 'string' || !UUID_RE.test(scope)) throw bad('scope');
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw bad('version');
  if (version === 1 ? previous !== null : typeof previous !== 'string' || !DIGEST_RE.test(previous)) throw bad('previous');
  const issuedAt = parseTimestamp(body.issued_at);
  const expires = parseTimestamp(body.expires);
  if (issuedAt === null || expires === null || issuedAt >= expires) throw bad('issued_at / expires');
  // A bounded lifetime: issued_at is the signer's own claim, so without this a
  // retired signing key could back-date a document that never expires.
  if (expires - issuedAt > (kind === 'root' ? TRUST_MAX_ROOT_LIFETIME_MS : TRUST_MAX_KEYSET_LIFETIME_MS)) throw bad('lifetime too long');
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > TRUST_MAX_KEYS_PER_DOCUMENT) throw bad('keys count');
  const allowed: readonly KeyPurpose[] = kind === 'root' ? ['root', ...PLATFORM_ONLINE_PURPOSES] : ['statement'];
  const parsedKeys = new Map<string, ParsedKey>();
  for (const raw of keys) {
    const k = parseKeyEntry(raw, allowed);
    if (parsedKeys.has(k.entry.keyid)) throw bad('a keyid appears twice');
    if ((k.revokedAt !== null && k.revokedAt > issuedAt) || (k.compromisedSince !== null && k.compromisedSince > issuedAt)) {
      throw bad('revocation after issued_at');
    }
    parsedKeys.set(k.entry.keyid, k);
  }
  if (kind === 'root') {
    const activeRoots = [...parsedKeys.values()].filter((k) => k.entry.purpose === 'root' && k.entry.status === 'active').length;
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 || threshold > activeRoots) {
      throw bad('threshold');
    }
  } else if (Object.prototype.hasOwnProperty.call(body, 'threshold')) {
    throw bad('key set with threshold');
  }
  return {
    kind,
    envelope: envelope as unknown as DsseEnvelope,
    payload,
    digest: sha256Prefixed(payload),
    body: body as unknown as TrustDocumentBody,
    issuedAt,
    expires,
    keys: parsedKeys,
    signatures: sigs,
  };
}

/** True when `sig` is a valid ES256 DER signature by `key` over the document's PAE. */
export function documentSignedBy(doc: ParsedDocument, key: KeyObject, sig: Buffer): boolean {
  return verifySignature(key, pae(doc.envelope.payloadType, doc.payload), sig);
}

export function verifySignature(key: KeyObject, data: Buffer, sig: Buffer): boolean {
  try {
    return verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}

/**
 * Distinct keyids among `candidates` (active keys of `purpose`, valid at the
 * document's issued_at) whose signature on `doc` verifies. Unknown or failing
 * signatures are ignored, not fatal.
 */
export function validDocumentSigners(doc: ParsedDocument, candidates: Map<string, ParsedKey>, purpose: KeyPurpose): Set<string> {
  const ok = new Set<string>();
  for (const s of doc.signatures) {
    const k = candidates.get(s.keyid);
    if (!k || k.entry.purpose !== purpose || k.entry.status !== 'active') continue;
    if (doc.issuedAt < k.notBefore || doc.issuedAt > k.notAfter) continue;
    if (documentSignedBy(doc, k.key, s.sig)) ok.add(s.keyid);
  }
  return ok;
}

/**
 * Forward-only rule between consecutive documents of one scope (trust.md "Key sets
 * only move forward"). Root keys of a root document may be dropped; every other key
 * must stay. Returns null or KEYSET_REGRESSION.
 */
export function forwardOnlyViolation(prev: ParsedDocument, next: ParsedDocument): TrustCode | null {
  for (const [keyid, p] of prev.keys) {
    if (p.entry.purpose === 'root') continue;
    const n = next.keys.get(keyid);
    if (!n) return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    const pe = p.entry;
    const ne = n.entry;
    if (ne.purpose !== pe.purpose || ne.spki_der_b64 !== pe.spki_der_b64 || n.notBefore !== p.notBefore || n.notAfter > p.notAfter) {
      return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    }
    if (STATUS_ORDER[ne.status] < STATUS_ORDER[pe.status]) return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    if (pe.revocation_reason === 'compromised' && ne.revocation_reason !== 'compromised') return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    if (p.revokedAt !== null && (n.revokedAt === null || n.revokedAt > p.revokedAt)) return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    if (p.compromisedSince !== null && (n.compromisedSince === null || n.compromisedSince > p.compromisedSince)) {
      return 'ATTESTA_TRUST_KEYSET_REGRESSION';
    }
  }
  if (next.issuedAt < prev.issuedAt) return 'ATTESTA_TRUST_KEYSET_REGRESSION';
  return null;
}

/** What a signature's time evidence may be checked against (trust.md step 8). */
export interface SignatureFacts {
  purpose: KeyPurpose;
  /** `sha256:` of the DER signature bytes. */
  signatureDigest: string;
  /** `sha256:` of the signed payload. */
  payloadDigest: string;
}

/** Time from evidence that is bound to this signature (or, for statements, this ledger statement); else null. */
function boundEvidenceTime(ev: TimeEvidence | undefined, facts: SignatureFacts | null): number | null {
  if (!ev || !facts || (ev.kind !== 'tsa_gen_time' && ev.kind !== 'rekor_integrated_time')) return null;
  const bound =
    (ev.binds === 'signature' && ev.digest === facts.signatureDigest) ||
    (ev.binds === 'ledger_statement' && facts.purpose === 'statement' && ev.digest === facts.payloadDigest);
  return bound ? parseTimestamp(ev.time) : null;
}

/**
 * Was `key` valid for a signature claimed at `signedAt`? (trust.md step 8.)
 * Time evidence counts only when it is bound to this signature (or, for a
 * statement, to this ledger statement); documents pass `facts = null` (they
 * carry no evidence). Returns null (valid) or the rejection code.
 */
export function keyValidityViolation(
  key: ParsedKey,
  signedAt: number,
  nowMs: number,
  skewMs: number,
  timeEvidence: TimeEvidence | undefined,
  facts: SignatureFacts | null,
): TrustCode | null {
  if (signedAt < key.notBefore || signedAt > key.notAfter || signedAt > nowMs + skewMs) return 'ATTESTA_TRUST_KEY_NOT_VALID_AT';
  const e = key.entry;
  if (e.status === 'retired') {
    return signedAt < (key.revokedAt as number) ? null : 'ATTESTA_TRUST_KEY_NOT_VALID_AT';
  }
  if (e.status === 'revoked' && e.revocation_reason === 'superseded') {
    return signedAt < (key.revokedAt as number) ? null : 'ATTESTA_TRUST_KEY_REVOKED';
  }
  if (e.status === 'revoked') {
    // Compromised: the signer could back-date signedAt, so only independent time
    // evidence over these exact bytes counts.
    const evTime = boundEvidenceTime(timeEvidence, facts);
    if (evTime === null || evTime > nowMs + skewMs) return 'ATTESTA_TRUST_KEY_REVOKED';
    if (evTime >= (key.compromisedSince as number) || evTime < key.notBefore || evTime > key.notAfter) return 'ATTESTA_TRUST_KEY_REVOKED';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building and signing (CLIs, offline root tool, tests)
// ---------------------------------------------------------------------------

/** One signer of a document: returns a DER ES256 signature over the PAE bytes. */
export interface DocumentSigner {
  keyid: string;
  sign(paeBytes: Buffer): Promise<Buffer> | Buffer;
}

/**
 * Canonical payload bytes of `body`, refused unless they parse back as a valid
 * document of the matching kind (so the builder can never sign what the verifier
 * would refuse).
 */
export function trustDocumentPayload(body: TrustDocumentBody): { payloadType: string; payload: Buffer } {
  const payloadType = body._type === TRUST_ROOT_TYPE ? TRUST_ROOT_PAYLOAD_TYPE : KEYSET_PAYLOAD_TYPE;
  const payload = Buffer.from(canonicalize(body), 'utf8');
  // Validate with a placeholder signature: shape only.
  parseTrustDocument({ payload: payload.toString('base64'), payloadType, signatures: [{ keyid: 'sha256:' + '0'.repeat(64), sig: 'AA==' }] });
  return { payloadType, payload };
}

/** Sign a document body with each signer (offline root tool: several root keys). */
export async function signTrustDocument(body: TrustDocumentBody, signers: readonly DocumentSigner[]): Promise<DsseEnvelope> {
  if (signers.length === 0 || signers.length > TRUST_MAX_SIGNATURES_PER_DOCUMENT) {
    throw new TrustDocumentError('ATTESTA_TRUST_DOCUMENT_MALFORMED', 'signer count');
  }
  const { payloadType, payload } = trustDocumentPayload(body);
  const bytes = pae(payloadType, payload);
  const signatures: DsseEnvelope['signatures'] = [];
  for (const s of signers) {
    const sig = await s.sign(bytes);
    if (!Buffer.isBuffer(sig)) throw new TrustDocumentError('ATTESTA_TRUST_DOCUMENT_MALFORMED', 'signer returned no signature');
    signatures.push({ keyid: s.keyid, sig: sig.toString('base64') });
  }
  return { payload: payload.toString('base64'), payloadType, signatures };
}

/** SHA-256 hex of bytes (helpers for CLIs that print digests only). */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
