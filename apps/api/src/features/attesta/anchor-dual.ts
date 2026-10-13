// Dual anchoring (Rekor + RFC 3161 TSA), the stored proof format, and the
// offline check of a stored proof.
//
// `DualAnchor.anchor(root, batchId)` is all or nothing per batch: Rekor goes
// first (no TSA token is spent while the log is down), then the TSA; the
// outcome reports each type separately so the worker (A15.5 part 2) writes
// `anchored` rows only when both verified, and a `failed` row with its
// errors.md code for each type that was attempted and failed. A retry reuses
// the in-process Rekor result for the same `batchId` (bounded cache).
//
// `anchorProofJson` builds the EV-2 v1 `inclusion_proof` JSON of
// `docs/contracts/attesta/tables.md`; `verifyStoredAnchor` checks one stored
// row offline: the Merkle path from the record's `record_hash` to the batch
// root, then the Rekor entry (pinned log key, our anchoring key) or the TSA
// token (pinned trust anchors). Material that is missing (no key, no anchors,
// no entry) is `not_checkable`, never valid.
//
// Ported from SushiCorp A2b adapters/anchor/dual.py and B3
// core/evidence/anchoring.py (proof JSON) @ 0bd67a5 (catalog EV-2).
// Deviations: (1) one row per record and anchor type (tables.md) instead of
// one `rekor+tsa` row, so the outcome is per type rather than one merged
// AnchorResult and no `rekor+tsa` type exists; (2) additive keys in the TSA
// proof: `gen_time`, `serial_number`, `policy` and `revocation` (status and
// reason, so `unknown` is stated, never implied clean); (3) `proof_b64` and
// `rekor_entry` are null for TSA rows (the token is the `tsa_token_b64`
// column); (4) the offline check returns errors.md verify codes instead of
// raising, accepts current and retired anchoring keys, and reports TSA
// revocation as `unknown` (the stored value is unsigned, so it is never
// re-asserted as clean).

import type { KeyObject } from 'node:crypto';
import type * as pkijs from 'pkijs';
import { canonicalize } from './canonical';
import { proofFromJson, verifyInclusion, type InclusionProofJson } from './merkle';
import { AnchorError, AnchorInputError, type AnchorErrorCode } from './anchor-contract';
import {
  RekorVerificationError,
  verifyRekorEntry,
  type RekorAnchor,
  type RekorAnchorResult,
  type VerifiedRekorEntry,
} from './anchor-rekor';
import {
  TimestampVerificationError,
  tsaTokenRef,
  verifyTimestampToken,
  type RevocationResult,
  type TsaAnchor,
  type TsaAnchorResult,
} from './anchor-tsa';

export const ANCHOR_PROOF_VERSION = 1;
export type AnchorType = 'rekor' | 'tsa';

export type AnchorAttempt<T> =
  | { status: 'anchored'; result: T }
  | { status: 'failed'; code: AnchorErrorCode; retryable: boolean }
  | { status: 'skipped' };

export interface DualAnchorOutcome {
  /** true only when both anchors verified: the only case in which anything is recorded as anchored. */
  complete: boolean;
  rekor: AnchorAttempt<RekorAnchorResult>;
  /** `skipped` when Rekor failed first (no token spent). */
  tsa: AnchorAttempt<TsaAnchorResult>;
}

async function attempt<T>(fn: () => Promise<T>): Promise<AnchorAttempt<T>> {
  try {
    return { status: 'anchored', result: await fn() };
  } catch (err) {
    if (err instanceof AnchorError) return { status: 'failed', code: err.code, retryable: err.retryable };
    throw err; // input errors and bugs surface; they are never stored as anchor failures
  }
}

export class DualAnchor {
  constructor(readonly rekor: RekorAnchor, readonly tsa: TsaAnchor) {}

  async anchor(root: Buffer, batchId: string): Promise<DualAnchorOutcome> {
    const rekor = await attempt(() => this.rekor.anchor(root, batchId));
    if (rekor.status !== 'anchored') return { complete: false, rekor, tsa: { status: 'skipped' } };
    const tsa = await attempt(() => this.tsa.anchor(root, batchId));
    return { complete: tsa.status === 'anchored', rekor, tsa };
  }

  async health(): Promise<boolean> {
    const [r, t] = await Promise.all([this.rekor.health(), this.tsa.health()]);
    return r && t;
  }
}

// ---------------------------------------------------------------------------
// Stored proof (EV-2 v1)
// ---------------------------------------------------------------------------

export interface RekorProofJson {
  version: 1;
  merkle: InclusionProofJson;
  anchor: {
    type: 'rekor';
    ref: string;
    log_index: number;
    /** base64 of the JSON inclusion proof the log returned. */
    proof_b64: string;
    rekor_entry: Record<string, unknown>;
  };
}

export interface TsaProofJson {
  version: 1;
  merkle: InclusionProofJson;
  anchor: {
    type: 'tsa';
    ref: string;
    log_index: null;
    proof_b64: null;
    /** Present for the contract's fixed shape; the token is the `tsa_token_b64` column. */
    rekor_entry: null;
    gen_time: string;
    serial_number: string;
    policy: string;
    revocation: RevocationResult;
  };
}

export type AnchorProofJson = RekorProofJson | TsaProofJson;

/** The `inclusion_proof` column for one record and one anchor. */
export function anchorProofJson(merkle: InclusionProofJson, result: RekorAnchorResult | TsaAnchorResult): AnchorProofJson {
  const m: InclusionProofJson = { leaf_index: merkle.leaf_index, tree_size: merkle.tree_size, path: [...merkle.path] };
  if (result.type === 'rekor') {
    const proof = (result.entry.verification as Record<string, unknown> | undefined)?.inclusionProof;
    if (proof === undefined) throw new AnchorInputError('rekor result carries no inclusion proof');
    return {
      version: ANCHOR_PROOF_VERSION,
      merkle: m,
      anchor: {
        type: 'rekor',
        ref: result.entryId,
        log_index: result.logIndex,
        proof_b64: Buffer.from(canonicalize(proof), 'utf8').toString('base64'),
        rekor_entry: structuredClone(result.entry),
      },
    };
  }
  return {
    version: ANCHOR_PROOF_VERSION,
    merkle: m,
    anchor: {
      type: 'tsa',
      ref: result.ref,
      log_index: null,
      proof_b64: null,
      rekor_entry: null,
      gen_time: result.anchoredAt,
      serial_number: result.serialNumber,
      policy: result.policy,
      revocation: { ...result.revocation },
    },
  };
}

export interface StoredAnchorRow {
  anchorType: string;
  /** The `inclusion_proof` column as stored (parsed JSON). */
  proof: unknown;
  /** `sha256:<hex>` of the record (the Merkle leaf data is its 32 raw bytes). */
  recordHash: string;
  /** `sha256:<hex>` batch root from `attesta_anchor_batches`. */
  merkleRoot: string;
  rekorEntryUuid?: string | null;
  tsaTokenB64?: string | null;
}

export interface StoredAnchorKeys {
  rekorLogKey?: KeyObject;
  /** Pinned Rekor shard offsets (see `VerifyRekorEntryOptions.logIndexOffsets`). */
  rekorLogIndexOffsets?: Readonly<Record<string, number>>;
  /** SPKI DER of the platform anchoring keys, current and retired (rotation keeps old anchors checkable). */
  anchorKeysSpkiDer?: Buffer[];
  /**
   * Task15l2 (trust.md step 8): the anchoring keys with the window in which each
   * could sign, from the trust-verified root (`platformKeyWindows`). When present it
   * replaces `anchorKeysSpkiDer`: a Rekor anchor counts only if the log's
   * `integratedTime` (independent time evidence bound to the signature) lies in
   * [notBefore, notAfter] and before `untilMs` (`revoked_at` of a retired or
   * superseded key, `compromised_since` of a compromised one). So a retired or
   * stolen anchor key cannot make a fresh anchor that verifies. Production always
   * passes windows.
   */
  anchorKeyWindows?: AnchorKeyWindow[];
  tsaAnchors?: pkijs.Certificate[];
}

export interface AnchorKeyWindow {
  spkiDer: Buffer;
  notBeforeMs: number;
  notAfterMs: number;
  /** Exclusive cutoff, or null for a key still active. */
  untilMs: number | null;
}

/** True when a log time (seconds) lies inside the key's signing window. */
export function anchorKeyWindowCovers(w: AnchorKeyWindow, integratedTimeSec: number): boolean {
  const t = integratedTimeSec * 1000;
  return Number.isFinite(t) && t >= w.notBeforeMs && t <= w.notAfterMs && (w.untilMs === null || t < w.untilMs);
}

export type StoredAnchorCheck =
  | {
      status: 'valid';
      /**
       * TSA only. Always `unknown` offline: the stored proof holds no signed
       * revocation evidence, so a stored "clean" cannot be re-checked and is
       * never reported as clean (AGENTS.md §9 #19).
       */
      revocation?: RevocationResult;
      /** TSA only: what the row says was found at anchor time. Unverified; shown for context. */
      recordedRevocation?: RevocationResult;
    }
  | { status: 'invalid'; code: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID' | 'ATTESTA_VERIFY_ANCHOR_INVALID' }
  | { status: 'not_checkable'; code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };

const PREFIXED = /^sha256:[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const INVALID_MERKLE = { status: 'invalid', code: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID' } as const;
const INVALID_ANCHOR = { status: 'invalid', code: 'ATTESTA_VERIFY_ANCHOR_INVALID' } as const;
const NOT_CHECKABLE = { status: 'not_checkable', code: 'ATTESTA_VERIFY_NOT_CHECKABLE' } as const;

/** Check one stored anchor row offline, from its stored proof only (no network). */
const PROOF_KEYS = ['anchor', 'merkle', 'version'];
const MERKLE_KEYS = ['leaf_index', 'path', 'tree_size'];
const REKOR_ANCHOR_KEYS = ['log_index', 'proof_b64', 'ref', 'rekor_entry', 'type'];
const TSA_ANCHOR_KEYS = ['gen_time', 'log_index', 'policy', 'proof_b64', 'ref', 'rekor_entry', 'revocation', 'serial_number', 'type'];
const REVOCATION_KEYS = ['reason', 'status'];

function hasExactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(v).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
}

/**
 * Check one stored anchor row offline, from its stored proof only (no network).
 * The row and proof must have the EV-2 v1 shape for their kind exactly: a Rekor
 * row carries its entry UUID and no token, a TSA row its token and no entry
 * UUID, and neither proof carries the other kind's fields or any extra key.
 * A row of the wrong shape is ANCHOR_INVALID; missing keys or trust anchors on
 * the verifier's side are NOT_CHECKABLE; nothing missing is ever valid.
 */
export function verifyStoredAnchor(row: StoredAnchorRow, keys: StoredAnchorKeys): StoredAnchorCheck {
  if (!PREFIXED.test(row.recordHash) || !PREFIXED.test(row.merkleRoot)) return INVALID_MERKLE;
  const proof = row.proof;
  if (!isRecord(proof) || !hasExactKeys(proof, PROOF_KEYS) || proof.version !== ANCHOR_PROOF_VERSION || !isRecord(proof.anchor)) {
    return INVALID_ANCHOR;
  }
  if (!isRecord(proof.merkle) || !hasExactKeys(proof.merkle, MERKLE_KEYS)) return INVALID_MERKLE;
  const root = Buffer.from(row.merkleRoot.slice(7), 'hex');
  let merkle: ReturnType<typeof proofFromJson>;
  try {
    merkle = proofFromJson(proof.merkle);
  } catch {
    return INVALID_MERKLE;
  }
  if (!verifyInclusion(Buffer.from(row.recordHash.slice(7), 'hex'), merkle.leafIndex, merkle.treeSize, merkle.path, root)) {
    return INVALID_MERKLE;
  }
  const anchor = proof.anchor;
  if (anchor.type !== row.anchorType || typeof anchor.ref !== 'string') return INVALID_ANCHOR;

  if (anchor.type === 'rekor') {
    const entry = anchor.rekor_entry;
    if (!hasExactKeys(anchor, REKOR_ANCHOR_KEYS) || !isRecord(entry) || typeof anchor.proof_b64 !== 'string' ||
        typeof anchor.log_index !== 'number') return INVALID_ANCHOR;
    // Row columns for this kind: the entry UUID is required and must match; no token.
    if (typeof row.rekorEntryUuid !== 'string' || row.rekorEntryUuid.toLowerCase() !== anchor.ref.toLowerCase()) return INVALID_ANCHOR;
    if (row.tsaTokenB64 !== null && row.tsaTokenB64 !== undefined) return INVALID_ANCHOR;
    const candidates: Array<{ spkiDer: Buffer; window: AnchorKeyWindow | null }> = keys.anchorKeyWindows
      ? keys.anchorKeyWindows.map((w) => ({ spkiDer: w.spkiDer, window: w }))
      : (keys.anchorKeysSpkiDer ?? []).map((spkiDer) => ({ spkiDer, window: null }));
    if (!keys.rekorLogKey || candidates.length === 0) return NOT_CHECKABLE;
    let verified: VerifiedRekorEntry | null = null;
    for (const candidate of candidates) {
      let v: VerifiedRekorEntry;
      try {
        v = verifyRekorEntry(anchor.ref, entry, {
          logKey: keys.rekorLogKey, artifact: root, anchorKeySpkiDer: candidate.spkiDer, logIndexOffsets: keys.rekorLogIndexOffsets,
        });
      } catch (err) {
        if (!(err instanceof RekorVerificationError)) throw err;
        continue;
      }
      // Signed by this key, but outside its window (retired, revoked, compromised, expired): not an anchor.
      if (candidate.window && !anchorKeyWindowCovers(candidate.window, v.integratedTime)) continue;
      verified = v;
      break;
    }
    if (verified === null) return INVALID_ANCHOR;
    const inclusion = (entry.verification as Record<string, unknown>).inclusionProof;
    if (anchor.log_index !== verified.logIndex) return INVALID_ANCHOR;
    if (anchor.proof_b64 !== Buffer.from(canonicalize(inclusion), 'utf8').toString('base64')) return INVALID_ANCHOR;
    return { status: 'valid' };
  }

  if (anchor.type === 'tsa') {
    const rev = anchor.revocation;
    if (!hasExactKeys(anchor, TSA_ANCHOR_KEYS) || anchor.rekor_entry !== null || anchor.log_index !== null ||
        anchor.proof_b64 !== null || typeof anchor.gen_time !== 'string' || typeof anchor.serial_number !== 'string' ||
        typeof anchor.policy !== 'string' || !isRecord(rev) || !hasExactKeys(rev, REVOCATION_KEYS) ||
        !(rev.status === 'revoked' || rev.status === 'clean' || rev.status === 'unknown') || typeof rev.reason !== 'string') {
      return INVALID_ANCHOR;
    }
    // Row columns for this kind: the token is required; no entry UUID.
    if (row.rekorEntryUuid !== null && row.rekorEntryUuid !== undefined) return INVALID_ANCHOR;
    if (typeof row.tsaTokenB64 !== 'string' || row.tsaTokenB64.length === 0 || !B64.test(row.tsaTokenB64)) return INVALID_ANCHOR;
    const token = Buffer.from(row.tsaTokenB64, 'base64');
    if (anchor.ref !== tsaTokenRef(token)) return INVALID_ANCHOR;
    if (rev.status === 'revoked') return INVALID_ANCHOR;
    if (!keys.tsaAnchors || keys.tsaAnchors.length === 0) return NOT_CHECKABLE;
    try {
      const info = verifyTimestampToken(token, root, keys.tsaAnchors);
      if (anchor.gen_time !== info.genTime.toISOString() || anchor.serial_number !== info.serialNumber ||
          anchor.policy !== info.policy) return INVALID_ANCHOR;
    } catch (err) {
      if (err instanceof TimestampVerificationError) return INVALID_ANCHOR;
      throw err;
    }
    return {
      status: 'valid',
      revocation: { status: 'unknown', reason: 'not_rechecked_offline' },
      recordedRevocation: { status: rev.status, reason: rev.reason },
    };
  }
  return INVALID_ANCHOR;
}
