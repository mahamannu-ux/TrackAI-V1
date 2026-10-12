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
// reason, so `unknown` is stated, never implied clean); (3) `proof_b64` is null
// for TSA rows (the token is the `tsa_token_b64` column); (4) the offline
// check returns errors.md verify codes instead of raising.

import type { KeyObject } from 'node:crypto';
import type * as pkijs from 'pkijs';
import { canonicalize } from './canonical';
import { proofFromJson, verifyInclusion, type InclusionProofJson } from './merkle';
import { AnchorError, AnchorInputError, type AnchorErrorCode } from './anchor-contract';
import { RekorVerificationError, verifyRekorEntry, type RekorAnchor, type RekorAnchorResult } from './anchor-rekor';
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
  /** SPKI DER of the platform anchoring key. */
  anchorKeySpkiDer?: Buffer;
  tsaAnchors?: pkijs.Certificate[];
}

export type StoredAnchorCheck =
  | { status: 'valid'; revocation?: RevocationResult }
  | { status: 'invalid'; code: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID' | 'ATTESTA_VERIFY_ANCHOR_INVALID' }
  | { status: 'not_checkable'; code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };

const PREFIXED = /^sha256:[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const INVALID_MERKLE = { status: 'invalid', code: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID' } as const;
const INVALID_ANCHOR = { status: 'invalid', code: 'ATTESTA_VERIFY_ANCHOR_INVALID' } as const;
const NOT_CHECKABLE = { status: 'not_checkable', code: 'ATTESTA_VERIFY_NOT_CHECKABLE' } as const;

/** Check one stored anchor row offline, from its stored proof only (no network). */
export function verifyStoredAnchor(row: StoredAnchorRow, keys: StoredAnchorKeys): StoredAnchorCheck {
  if (!PREFIXED.test(row.recordHash) || !PREFIXED.test(row.merkleRoot)) return INVALID_MERKLE;
  const proof = row.proof;
  if (!isRecord(proof) || proof.version !== ANCHOR_PROOF_VERSION || !isRecord(proof.anchor)) return INVALID_ANCHOR;
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
  if (anchor.type !== row.anchorType) return INVALID_ANCHOR;

  if (anchor.type === 'rekor') {
    const entry = anchor.rekor_entry;
    if (!isRecord(entry) || typeof anchor.ref !== 'string') return NOT_CHECKABLE;
    if (row.rekorEntryUuid != null && row.rekorEntryUuid.toLowerCase() !== anchor.ref.toLowerCase()) return INVALID_ANCHOR;
    if (!keys.rekorLogKey || !keys.anchorKeySpkiDer) return NOT_CHECKABLE;
    let verified;
    try {
      verified = verifyRekorEntry(anchor.ref, entry, { logKey: keys.rekorLogKey, artifact: root, anchorKeySpkiDer: keys.anchorKeySpkiDer });
    } catch (err) {
      if (err instanceof RekorVerificationError) return INVALID_ANCHOR;
      throw err;
    }
    const inclusion = (entry.verification as Record<string, unknown>).inclusionProof;
    if (anchor.log_index !== verified.logIndex) return INVALID_ANCHOR;
    if (anchor.proof_b64 !== Buffer.from(canonicalize(inclusion), 'utf8').toString('base64')) return INVALID_ANCHOR;
    return { status: 'valid' };
  }

  if (anchor.type === 'tsa') {
    if (typeof row.tsaTokenB64 !== 'string' || row.tsaTokenB64.length === 0) return NOT_CHECKABLE;
    if (!B64.test(row.tsaTokenB64)) return INVALID_ANCHOR;
    const token = Buffer.from(row.tsaTokenB64, 'base64');
    if (anchor.ref !== tsaTokenRef(token)) return INVALID_ANCHOR;
    if (!keys.tsaAnchors || keys.tsaAnchors.length === 0) return NOT_CHECKABLE;
    try {
      const info = verifyTimestampToken(token, root, keys.tsaAnchors);
      if (anchor.gen_time !== info.genTime.toISOString() || anchor.serial_number !== info.serialNumber) return INVALID_ANCHOR;
    } catch (err) {
      if (err instanceof TimestampVerificationError) return INVALID_ANCHOR;
      throw err;
    }
    const rev = anchor.revocation;
    const revocation: RevocationResult = isRecord(rev) && (rev.status === 'revoked' || rev.status === 'clean' || rev.status === 'unknown')
      && typeof rev.reason === 'string'
      ? { status: rev.status, reason: rev.reason }
      : { status: 'unknown', reason: 'not_recorded' };
    if (revocation.status === 'revoked') return INVALID_ANCHOR;
    return { status: 'valid', revocation };
  }
  return INVALID_ANCHOR;
}
