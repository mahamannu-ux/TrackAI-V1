/**
 * The shared trust verifier (Task15l, A15.12): `verifyTrusted` from
 * trust-contract.ts, implementing docs/contracts/attesta/trust.md "Verification"
 * step by step. Pure: no database, no network, no clock (`state.now`), never throws.
 *
 * Status rule: tampering evidence → `rejected`; absent trust information →
 * `unavailable`, never `verified` (catalog TR-1, AGENTS.md §9 item 19).
 *
 * Ported from SushiCorp B4 core/trust/{revocation,verdict}.py @ 0bd67a5 (catalog
 * TR-1): three states, UNKNOWN never CLEAN, stale or future-dated sources UNKNOWN.
 * New (reasons in trust.md "Provenance"): purposes and audiences, TUF-style root
 * chain by threshold of old and new keys, forward-only key sets, compromise bound
 * to time evidence over this exact signature (or this tenant's ledger statement), customer pins.
 */
import { sha256Prefixed } from './canonical';
import { pae } from './dsse';
import {
  ARTIFACT_PURPOSES,
  PLATFORM_SCOPE,
  TRUST_CODE_STATUS,
  TRUST_DEFAULT_CLOCK_SKEW_MS,
  TRUST_MAX_DOCUMENTS_PER_SCOPE,
  TRUST_MAX_SCOPES,
  TRUST_MAX_SIGNED_BYTES,
  TRUST_MAX_TOTAL_DOCUMENT_BYTES,
  type ArtifactPurpose,
  type TimeEvidence,
  type TrustCode,
  type TrustState,
  type TrustVerdict,
  type TrustedDocumentRef,
  type VerifyTrustedInput,
} from './trust-contract';
import {
  DIGEST_RE,
  TrustDocumentError,
  UUID_RE,
  decodeBase64Strict,
  documentSignedBy,
  forwardOnlyViolation,
  keyValidityViolation,
  parseKeyEntry,
  parseTimestamp,
  parseTrustDocument,
  validDocumentSigners,
  verifySignature,
  type ParsedDocument,
  type ParsedKey,
} from './trust-documents';

const MAX_SKEW_MS = 3_600_000;
const MAX_PINS = 16;

class Stop extends Error {
  constructor(readonly code: TrustCode) {
    super(code);
  }
}

function verdict(code: TrustCode, extra: Partial<TrustVerdict> = {}): TrustVerdict {
  return { status: TRUST_CODE_STATUS[code], code, ...extra };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

interface Checked {
  payload: Buffer;
  payloadType: string;
  keyid: string;
  sig: Buffer;
  purpose: ArtifactPurpose;
  audience: string;
  signedAt: number;
  now: number;
  skew: number;
  timeEvidence: TimeEvidence | undefined;
  state: TrustState;
  floor: number | null;
}

/** Step 1: the call itself, bounded. Any breach → INPUT_INVALID. */
function checkInput(input: VerifyTrustedInput): Checked {
  const fail = () => new Stop('ATTESTA_TRUST_INPUT_INVALID');
  if (!isRecord(input) || !isRecord(input.state) || !isRecord(input.envelope)) throw fail();
  const { payload, payloadType, envelope, purpose, audience, state } = input;
  if (!Buffer.isBuffer(payload) || payload.length > TRUST_MAX_SIGNED_BYTES) throw fail();
  if (typeof payloadType !== 'string' || payloadType.length === 0 || payloadType.length > 256) throw fail();
  if (envelope.payloadType !== payloadType) throw fail();
  const decoded = decodeBase64Strict(envelope.payload, TRUST_MAX_SIGNED_BYTES);
  if (decoded === null || !decoded.equals(payload)) throw fail();
  const sigs = envelope.signatures;
  if (!Array.isArray(sigs) || sigs.length !== 1 || !isRecord(sigs[0])) throw fail();
  const { keyid, sig: sigB64 } = sigs[0] as { keyid: unknown; sig: unknown };
  const sig = decodeBase64Strict(sigB64, 256);
  if (typeof keyid !== 'string' || !DIGEST_RE.test(keyid) || sig === null || sig.length === 0) throw fail();
  if (typeof purpose !== 'string' || !(ARTIFACT_PURPOSES as readonly string[]).includes(purpose)) throw fail();
  if (purpose === 'statement' ? typeof audience !== 'string' || !UUID_RE.test(audience) : audience !== PLATFORM_SCOPE) throw fail();
  const signedAt = parseTimestamp(input.signedAt);
  const now = parseTimestamp(state.now);
  if (signedAt === null || now === null) throw fail();
  const skew = state.clockSkewMs ?? TRUST_DEFAULT_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_SKEW_MS) throw fail();
  let timeEvidence: TimeEvidence | undefined;
  if (input.timeEvidence !== undefined) {
    const te = input.timeEvidence;
    // Exact shape: a malformed object is a caller error, never silently ignored.
    if (!isRecord(te) || Object.keys(te).some((k) => !['kind', 'time', 'binds', 'digest'].includes(k)) ||
        (te.kind !== 'tsa_gen_time' && te.kind !== 'rekor_integrated_time') ||
        (te.binds !== 'signature' && te.binds !== 'ledger_statement') ||
        (te.binds === 'ledger_statement' && purpose !== 'statement') ||
        parseTimestamp(te.time) === null || typeof te.digest !== 'string' || !DIGEST_RE.test(te.digest)) throw fail();
    timeEvidence = te;
  }
  if (typeof state.production !== 'boolean') throw fail();
  let floor: number | null = null;
  if (state.trustedTimeFloor !== undefined) {
    floor = parseTimestamp(state.trustedTimeFloor);
    if (floor === null) throw fail();
  }
  if (!Array.isArray(state.pinnedRootKeyids) || state.pinnedRootKeyids.length > MAX_PINS ||
      state.pinnedRootKeyids.some((k) => typeof k !== 'string' || !DIGEST_RE.test(k))) throw fail();
  const pinThreshold = state.pinnedRootThreshold ?? 1;
  if (!Number.isSafeInteger(pinThreshold) || pinThreshold < 1 || pinThreshold > MAX_PINS) throw fail();
  if (!Array.isArray(state.rootDocuments) || state.rootDocuments.length > TRUST_MAX_DOCUMENTS_PER_SCOPE) throw fail();
  if (!isRecord(state.keysetDocuments) || Object.keys(state.keysetDocuments).length > TRUST_MAX_SCOPES) throw fail();
  // Total work bound before any parsing: the sum of every held payload's base64 length.
  let total = 0;
  const count = (env: unknown) => {
    total += isRecord(env) && typeof env.payload === 'string' ? env.payload.length : 0;
  };
  state.rootDocuments.forEach(count);
  for (const docs of Object.values(state.keysetDocuments)) {
    if (!Array.isArray(docs) || docs.length > TRUST_MAX_DOCUMENTS_PER_SCOPE) throw fail();
    docs.forEach(count);
  }
  if (total > TRUST_MAX_TOTAL_DOCUMENT_BYTES) throw fail();
  if (!isRecord(state.lastTrusted) || Object.keys(state.lastTrusted).length > TRUST_MAX_SCOPES + 1) throw fail();
  for (const ref of Object.values(state.lastTrusted)) {
    if (!isRecord(ref) || !Number.isSafeInteger(ref.version) || (ref.version as number) < 1 ||
        typeof ref.digest !== 'string' || !DIGEST_RE.test(ref.digest)) throw fail();
  }
  if (state.customerPins !== undefined &&
      (!isRecord(state.customerPins) || Object.keys(state.customerPins).length > TRUST_MAX_SCOPES)) throw fail();
  return { payload, payloadType, keyid, sig, purpose: purpose as ArtifactPurpose, audience, signedAt, now, skew, timeEvidence, state, floor };
}

function parseAll(envelopes: readonly unknown[], kind: 'root' | 'keyset', scope: string): ParsedDocument[] {
  return envelopes.map((env) => {
    const doc = parseTrustDocument(env);
    if (doc.kind !== kind || doc.body.scope !== scope) {
      throw new TrustDocumentError('ATTESTA_TRUST_DOCUMENT_MALFORMED', 'document of another kind or scope');
    }
    return doc;
  });
}

/** One document per version (byte-identical duplicates collapse); two different ones conflict. */
function byVersion(docs: ParsedDocument[]): Map<number, ParsedDocument> {
  const out = new Map<number, ParsedDocument>();
  for (const d of docs) {
    const seen = out.get(d.body.version);
    if (seen && seen.digest !== d.digest) throw new Stop('ATTESTA_TRUST_DOCUMENT_CONFLICT');
    out.set(d.body.version, d);
  }
  return out;
}

/** The document this verifier accepted before for `scope`, if any. */
function lastTrustedRef(c: Checked, scope: string): TrustedDocumentRef | null {
  return hasOwn(c.state.lastTrusted, scope) ? c.state.lastTrusted[scope] : null;
}

/**
 * Where a chain must start when the verifier accepted a document of this scope
 * before: at exactly that document. Older held versions are ignored; a different
 * document at that version is a fork; nothing at or above it is a rollback.
 */
function anchoredStart(versions: Map<number, ParsedDocument>, ref: TrustedDocumentRef): ParsedDocument {
  const at = versions.get(ref.version);
  if (at) {
    if (at.digest !== ref.digest) throw new Stop('ATTESTA_TRUST_DOCUMENT_CONFLICT');
    return at;
  }
  const max = Math.max(...versions.keys());
  if (max < ref.version) throw new Stop('ATTESTA_TRUST_ROLLBACK');
  throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
}

function checkNotExpired(doc: ParsedDocument, c: Checked): void {
  if (c.now > doc.expires + c.skew) throw new Stop('ATTESTA_TRUST_DOCUMENT_EXPIRED');
}

function checkNotFromFuture(docs: ParsedDocument[], c: Checked): void {
  for (const d of docs) if (d.issuedAt > c.now + c.skew) throw new Stop('ATTESTA_TRUST_DOCUMENT_FROM_FUTURE');
}

function activeRootKeys(doc: ParsedDocument): Map<string, ParsedKey> {
  return new Map([...doc.keys].filter(([, k]) => k.entry.purpose === 'root' && k.entry.status === 'active'));
}

/** Step 3–4: the root chain from the pin to the newest root document. */
function verifyRootChain(c: Checked): ParsedDocument {
  const { state } = c;
  const pinned = state.pinnedRootKeyids;
  if (pinned.length === 0 && (state.production || state.allowUnpinnedRoot !== true)) throw new Stop('ATTESTA_TRUST_ROOT_NOT_PINNED');
  const docs = parseAll(state.rootDocuments, 'root', PLATFORM_SCOPE);
  if (docs.length === 0) throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
  const versions = byVersion(docs);
  checkNotFromFuture(docs, c);
  const ordered = [...versions.values()].sort((a, b) => a.body.version - b.body.version);
  let start: ParsedDocument | undefined;
  const ref = lastTrustedRef(c, PLATFORM_SCOPE);
  if (ref) {
    // Accepted before (after its own chain check): start there, so a root key
    // rotated out since then can no longer fork from an older version.
    start = anchoredStart(versions, ref);
  } else if (pinned.length > 0) {
    const pinSet = new Set(pinned);
    start = ordered.find((d) => [...activeRootKeys(d).keys()].some((k) => pinSet.has(k)));
    if (!start) throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
    const pinnedKeys = new Map([...activeRootKeys(start)].filter(([k]) => pinSet.has(k)));
    const need = Math.max(start.body.threshold as number, state.pinnedRootThreshold ?? 1);
    if (validDocumentSigners(start, pinnedKeys, 'root').size < need) throw new Stop('ATTESTA_TRUST_THRESHOLD_NOT_MET');
  } else {
    // Development only (checked above): trust the lowest held root on first use.
    start = ordered[0];
    if (validDocumentSigners(start, activeRootKeys(start), 'root').size < (start.body.threshold as number)) {
      throw new Stop('ATTESTA_TRUST_THRESHOLD_NOT_MET');
    }
  }
  let cur = start;
  const max = ordered[ordered.length - 1].body.version;
  for (let v = start.body.version + 1; v <= max; v++) {
    const next = versions.get(v);
    if (!next) throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
    if (next.body.previous !== cur.digest) throw new Stop('ATTESTA_TRUST_DOCUMENT_CONFLICT');
    // TUF root rotation: k of the previous root AND k' of its own root keys.
    if (validDocumentSigners(next, activeRootKeys(cur), 'root').size < (cur.body.threshold as number) ||
        validDocumentSigners(next, activeRootKeys(next), 'root').size < (next.body.threshold as number)) {
      throw new Stop('ATTESTA_TRUST_THRESHOLD_NOT_MET');
    }
    const regression = forwardOnlyViolation(cur, next);
    if (regression) throw new Stop(regression);
    cur = next;
  }
  checkNotExpired(cur, c);
  return cur;
}

/** A key set is signed by a `tenant_keyset` key of the current root, valid at its issued_at. */
function checkKeysetSignature(doc: ParsedDocument, root: ParsedDocument, c: Checked): void {
  let firstViolation: TrustCode | null = null;
  for (const s of doc.signatures) {
    const k = root.keys.get(s.keyid);
    if (!k || k.entry.purpose !== 'tenant_keyset' || !documentSignedBy(doc, k.key, s.sig)) continue;
    // Documents carry no time evidence: a compromised keyset key never vouches.
    const violation = keyValidityViolation(k, doc.issuedAt, c.now, c.skew, undefined, null);
    if (violation === null) return;
    firstViolation ??= violation;
  }
  throw new Stop(firstViolation ?? 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID');
}

/** Step 5: the audience's key sets, contiguous, signed, forward-only, fresh. */
function verifyKeysets(c: Checked, root: ParsedDocument): ParsedDocument {
  const all = c.state.keysetDocuments;
  const envs = hasOwn(all, c.audience) ? all[c.audience] : [];
  if (envs.length === 0) throw new Stop('ATTESTA_TRUST_REVOCATION_UNKNOWN');
  const docs = parseAll(envs, 'keyset', c.audience);
  const versions = byVersion(docs);
  checkNotFromFuture(docs, c);
  const ref = lastTrustedRef(c, c.audience);
  let ordered = [...versions.values()].sort((a, b) => a.body.version - b.body.version);
  if (ref) {
    const start = anchoredStart(versions, ref);
    ordered = ordered.filter((d) => d.body.version >= start.body.version);
  } else if (ordered[0].body.version !== 1) {
    // First use: the full history from version 1, so a lone forged document
    // (a stolen tenant_keyset key) cannot hide an earlier revocation.
    throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
  }
  for (let i = 0; i < ordered.length; i++) {
    const d = ordered[i];
    if (i > 0) {
      const prev = ordered[i - 1];
      if (d.body.version !== prev.body.version + 1) throw new Stop('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
      if (d.body.previous !== prev.digest) throw new Stop('ATTESTA_TRUST_DOCUMENT_CONFLICT');
    }
    if (i > 0) {
      const regression = forwardOnlyViolation(ordered[i - 1], d);
      if (regression) throw new Stop(regression);
    }
  }
  // Only the newest needs a signer valid under the current root: each `previous`
  // digest authenticates the one before, so older history stays valid after its
  // tenant_keyset key is retired or compromised (and forged history still needs a
  // currently valid key to sign the newest).
  const newest = ordered[ordered.length - 1];
  checkKeysetSignature(newest, root, c);
  checkNotExpired(newest, c);
  return newest;
}

/** Customer pins for the audience (statement only), validated as key entries. */
function pinnedKeys(c: Checked): Map<string, ParsedKey> | null {
  const pins = c.state.customerPins;
  if (c.purpose !== 'statement' || pins === undefined || !hasOwn(pins, c.audience)) return null;
  const list = pins[c.audience];
  if (!Array.isArray(list) || list.length > TRUST_MAX_DOCUMENTS_PER_SCOPE * 16) throw new Stop('ATTESTA_TRUST_INPUT_INVALID');
  const out = new Map<string, ParsedKey>();
  for (const raw of list) {
    let k: ParsedKey;
    try {
      k = parseKeyEntry(raw, ['statement']);
    } catch {
      throw new Stop('ATTESTA_TRUST_INPUT_INVALID');
    }
    if (out.has(k.entry.keyid)) throw new Stop('ATTESTA_TRUST_INPUT_INVALID');
    out.set(k.entry.keyid, k);
  }
  return out;
}

/** For the rejection code only: is this keyid listed in another tenant's key set? */
function listedForOtherTenant(c: Checked): boolean {
  for (const [tenant, envs] of Object.entries(c.state.keysetDocuments)) {
    if (tenant === c.audience) continue;
    for (const env of envs) {
      try {
        if (parseTrustDocument(env).keys.has(c.keyid)) return true;
      } catch {
        // Unparseable documents of other tenants say nothing about this key.
      }
    }
  }
  return false;
}

function run(input: VerifyTrustedInput): TrustVerdict {
  const c = checkInput(input);
  // A clock behind the persisted floor (beyond skew) cannot judge expiry or validity.
  if (c.floor !== null && c.now < c.floor - c.skew) throw new Stop('ATTESTA_TRUST_CLOCK_BEHIND');
  let keys: Map<string, ParsedKey>;
  let trusted: Record<string, TrustedDocumentRef> = {};
  let root: ParsedDocument | null = null;
  const pins = pinnedKeys(c);
  if (pins) {
    keys = pins;
  } else {
    root = verifyRootChain(c);
    trusted = { [PLATFORM_SCOPE]: { version: root.body.version, digest: root.digest } };
    if (c.purpose === 'statement') {
      const keyset = verifyKeysets(c, root);
      trusted[c.audience] = { version: keyset.body.version, digest: keyset.digest };
      keys = keyset.keys;
    } else {
      keys = new Map([...root.keys].filter(([, k]) => k.entry.purpose !== 'root'));
    }
  }
  const key = keys.get(c.keyid);
  if (!key) {
    if (pins) throw new Stop('ATTESTA_TRUST_KEY_UNKNOWN');
    if (root?.keys.has(c.keyid)) throw new Stop('ATTESTA_TRUST_PURPOSE_MISMATCH');
    if (listedForOtherTenant(c)) {
      throw new Stop(c.purpose === 'statement' ? 'ATTESTA_TRUST_AUDIENCE_MISMATCH' : 'ATTESTA_TRUST_PURPOSE_MISMATCH');
    }
    throw new Stop('ATTESTA_TRUST_KEY_UNKNOWN');
  }
  if (key.entry.purpose !== c.purpose) throw new Stop('ATTESTA_TRUST_PURPOSE_MISMATCH');
  if (!verifySignature(key.key, pae(c.payloadType, c.payload), c.sig)) throw new Stop('ATTESTA_TRUST_SIGNATURE_INVALID');
  const violation = keyValidityViolation(key, c.signedAt, c.now, c.skew, c.timeEvidence,
    { purpose: c.purpose, signatureDigest: sha256Prefixed(c.sig), payloadDigest: sha256Prefixed(c.payload) });
  if (violation) throw new Stop(violation);
  const trustedTime = new Date(Math.max(c.now, c.floor ?? c.now)).toISOString();
  return verdict('ATTESTA_TRUST_VERIFIED', { keyid: c.keyid, trusted, trustedTime });
}

/** trust-contract.ts `VerifyTrusted`. */
export function verifyTrustedImpl(input: VerifyTrustedInput): TrustVerdict {
  try {
    return run(input);
  } catch (err) {
    if (err instanceof Stop || err instanceof TrustDocumentError) return verdict(err.code);
    // An unexpected error is a malformed call that slipped past the checks: fail closed.
    return verdict('ATTESTA_TRUST_INPUT_INVALID');
  }
}
