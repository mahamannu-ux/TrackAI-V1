// Rekor (Sigstore transparency log) anchoring adapter, API v1, `hashedrekord`.
//
// `anchor(root, batchId)` logs one entry whose artifact is the 32-byte batch
// Merkle root, signed by the platform anchoring credential (anchor-contract.ts).
// Only SHA-256(root), our signature and our public key reach the public log:
// no tenant ID, batch ID or record data.
//
// Nothing the log says is trusted without proof. `verifyRekorEntry` checks:
//  1. the entry ID is the RFC 6962 leaf hash of the entry body (binds ref to body),
//     and an 80-hex ID's tree-ID prefix agrees with the checkpoint origin;
//  2. the inclusion proof recomputes the stated root hash (`rootFromPath`);
//  3. the checkpoint (signed tree head) is signed by the pinned log key and
//     commits to that same root hash and tree size;
//  4. entry.logIndex (signed by the SET) equals the proof position (plus a pinned
//     shard offset), `logID` is the pinned key's ID and the Signed Entry Timestamp (SET) over
//     the canonical {body, integratedTime, logID, logIndex} verifies;
//  5. the body is a hashedrekord v0.0.1 over sha256(root), carrying exactly our
//     anchoring key, and its signature verifies over the root.
// An unreachable or failing log raises ATTESTA_ANCHOR_LOG_UNAVAILABLE: never a pass.
//
// Ported from SushiCorp A2 adapters/anchor/rekor.py @ 0bd67a5 (catalog EV-2).
// Deviations: (1) `AnchorError` with errors.md codes: transport, 5xx and
// "duplicate but cannot fetch it" → LOG_UNAVAILABLE; an answer that does not
// verify (including malformed JSON) → LOG_PROOF_INVALID; the log refusing our
// submission (400/422) → ATTESTA_ANCHOR_LOG_REJECTED, terminal (added to
// errors.md 2026-10-13; Task15f2 switched to it); (2) no pinned log key →
// ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED at construction, in the adapter itself;
// trust on first use needs an explicit dev-only option and is refused in
// production;
// (3) signing goes through `AnchorSigner` (the frozen SigningAdapter), not a
// key file, so signatures are not deterministic: see anchor-contract.ts;
// (4) added check 1b (tree-ID prefix vs checkpoint origin); (5) the batch cache
// is bounded (A2b limitation #11); (6) results carry the whole entry object
// (stored as `inclusion_proof.anchor.rekor_entry`) instead of JSON bytes;
// (7) bounded response reads (1 MiB) and redirects refused; (8) a new entry's
// integratedTime must fall in the request window (± clock skew), as Sigstore
// clients check; (9) `artifact` and `anchorKeySpkiDer` are checked together.
// Not covered (Rekor v1 has no consistency proofs or witnesses): a log
// operator holding the pinned key could show us a view it never published.

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalize } from './canonical';
import { leafHash, rootFromPath } from './merkle';
import {
  AnchorError,
  AnchorInputError,
  BoundedCache,
  assertAnchorInput,
  fetchWithTimeout,
  isProduction,
  readCapped,
  type AnchorSigner,
  type FetchLike,
} from './anchor-contract';

export const REKOR_ENTRIES_PATH = '/api/v1/log/entries';
export const REKOR_LOG_INFO_PATH = '/api/v1/log';
export const REKOR_PUBLIC_KEY_PATH = '/api/v1/log/publicKey';
export const DEFAULT_REKOR_TIMEOUT_MS = 10_000;
export const DEFAULT_ANCHOR_CACHE_SIZE = 1024;
export const MAX_REKOR_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_REKOR_CLOCK_SKEW_MS = 5 * 60_000;

/** An entry, proof or signature failed verification. The message is a reason, never a raw value. */
export class RekorVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RekorVerificationError';
  }
}

export interface Checkpoint {
  origin: string;
  size: number;
  rootHash: Buffer;
  other: string[];
}

export interface VerifiedRekorEntry {
  /** 64-hex leaf hash of the body. */
  uuid: string;
  /** Global log index (`entry.logIndex`). */
  logIndex: number;
  integratedTime: number;
  treeSize: number;
  rootHash: Buffer;
}

/** What `RekorAnchor.anchor` returns: verified before it is returned. */
export interface RekorAnchorResult {
  type: 'rekor';
  /** Lowercase entry ID as the log named it (80 hex: tree ID + leaf hash; or 64). */
  entryId: string;
  uuid: string;
  logIndex: number;
  integratedTime: number;
  /** RFC 3339 form of `integratedTime`. */
  anchoredAt: string;
  /** The whole log entry, verbatim, so the anchor verifies offline after a log reset. */
  entry: Record<string, unknown>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ENTRY_ID = /^(?:[0-9a-f]{16})?[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function b64(value: unknown, what: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !B64.test(value)) {
    throw new RekorVerificationError(`${what} is not base64`);
  }
  return Buffer.from(value, 'base64');
}

function safeInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RekorVerificationError(`${what} is not a non-negative integer`);
  }
  return value;
}

/** A log key from PEM: ECDSA (P-256/P-384) or Ed25519. */
export function loadLogPublicKey(pem: string | Buffer): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new RekorVerificationError('unreadable public key');
  }
  if (key.asymmetricKeyType === 'ed25519') return key;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType === 'ec' && (curve === 'prime256v1' || curve === 'secp384r1')) return key;
  throw new RekorVerificationError('unsupported log key type');
}

function spkiDer(key: KeyObject): Buffer {
  return Buffer.from(key.export({ type: 'spki', format: 'der' }));
}

/** Rekor's logID: hex SHA-256 of the log's DER public key. */
export function logIdOf(key: KeyObject): string {
  return createHash('sha256').update(spkiDer(key)).digest('hex');
}

function verifySig(key: KeyObject, signature: Buffer, message: Buffer): boolean {
  try {
    if (key.asymmetricKeyType === 'ed25519') return verify(null, message, key, signature);
    const hash = key.asymmetricKeyDetails?.namedCurve === 'secp384r1' ? 'sha384' : 'sha256';
    return verify(hash, message, { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

/** Parse a signed note and verify it is signed by `key` (Rekor signed_note.go). */
export function verifyCheckpoint(text: string, key: KeyObject): Checkpoint {
  if (typeof text !== 'string') throw new RekorVerificationError('checkpoint missing');
  const split = text.lastIndexOf('\n\n');
  if (split < 0 || !text.endsWith('\n')) throw new RekorVerificationError('malformed checkpoint: no signature block');
  const note = text.slice(0, split + 1);
  const sigBlock = text.slice(split + 2);
  const hint = createHash('sha256').update(spkiDer(key)).digest().subarray(0, 4);
  let verified = false;
  const lines = sigBlock.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new RekorVerificationError('malformed checkpoint: no signature line');
  for (const line of lines) {
    const parts = line.split(' ');
    if (parts.length !== 3 || parts[0] !== '—' || parts[1].length === 0) {
      throw new RekorVerificationError('malformed checkpoint signature line');
    }
    const raw = b64(parts[2], 'checkpoint signature');
    if (raw.length < 5) throw new RekorVerificationError('checkpoint signature too short');
    if (raw.subarray(0, 4).equals(hint) && verifySig(key, raw.subarray(4), Buffer.from(note, 'utf8'))) verified = true;
  }
  if (!verified) throw new RekorVerificationError('checkpoint is not signed by the pinned log key');
  const body = note.split('\n');
  if (body.length < 4 || !body[0]) throw new RekorVerificationError('malformed checkpoint body');
  if (!/^[0-9]{1,16}$/.test(body[1])) throw new RekorVerificationError('malformed checkpoint size');
  const size = Number(body[1]);
  if (!Number.isSafeInteger(size)) throw new RekorVerificationError('malformed checkpoint size');
  const rootHash = b64(body[2], 'checkpoint root hash');
  return { origin: body[0], size, rootHash, other: body.slice(3).filter((l) => l.length > 0) };
}

/** Rekor verify.go VerifySignedEntryTimestamp: the log's signature over JCS(bundle). */
export function verifySignedEntryTimestamp(entry: Record<string, unknown>, key: KeyObject): void {
  const verification = entry.verification;
  if (!isRecord(verification)) throw new RekorVerificationError('entry lacks a signed entry timestamp');
  const signature = b64(verification.signedEntryTimestamp, 'signed entry timestamp');
  if (typeof entry.body !== 'string' || typeof entry.logID !== 'string') {
    throw new RekorVerificationError('entry lacks a readable signed entry timestamp');
  }
  const payload = {
    body: entry.body,
    integratedTime: safeInt(entry.integratedTime, 'integratedTime'),
    logID: entry.logID,
    logIndex: safeInt(entry.logIndex, 'logIndex'),
  };
  if (!verifySig(key, signature, Buffer.from(canonicalize(payload), 'utf8'))) {
    throw new RekorVerificationError('signed entry timestamp does not verify');
  }
}

export interface VerifyRekorEntryOptions {
  logKey: KeyObject;
  /** The anchored Merkle root; the body must commit to sha256(artifact) and its signature must verify over it. */
  artifact?: Buffer;
  /** SPKI DER of our anchoring key; the body must carry exactly this key. */
  anchorKeySpkiDer?: Buffer;
  /**
   * Pinned per-shard offsets, keyed by 16-hex tree ID: entry.logIndex must equal
   * proof.logIndex + offset. Absent tree → offset 0 (strict equality).
   */
  logIndexOffsets?: Readonly<Record<string, number>>;
}

/**
 * Verify everything listed at the top of this file; throws RekorVerificationError
 * on any failure. With neither `artifact` nor `anchorKeySpkiDer` only the
 * log-level checks run (a third party's entry, such as the sigstage vector).
 */
export function verifyRekorEntry(entryId: string, entry: unknown, opts: VerifyRekorEntryOptions): VerifiedRekorEntry {
  // "Our anchor" means our key AND a signature over this root: never one without the other.
  if ((opts.artifact === undefined) !== (opts.anchorKeySpkiDer === undefined)) {
    throw new RekorVerificationError('artifact and anchoring key must be checked together');
  }
  if (!isRecord(entry)) throw new RekorVerificationError('malformed log entry');
  const verification = entry.verification;
  const proof = isRecord(verification) ? verification.inclusionProof : undefined;
  if (!isRecord(proof)) throw new RekorVerificationError('entry lacks an inclusion proof');
  const body = b64(entry.body, 'entry body');
  const proofIndex = safeInt(proof.logIndex, 'inclusion proof logIndex');
  const treeSize = safeInt(proof.treeSize, 'inclusion proof treeSize');
  if (typeof proof.rootHash !== 'string' || !HEX64.test(proof.rootHash)) {
    throw new RekorVerificationError('inclusion proof root hash is not 32 bytes of lowercase hex');
  }
  const rootHash = Buffer.from(proof.rootHash, 'hex');
  if (!Array.isArray(proof.hashes) || !proof.hashes.every((h): h is string => typeof h === 'string' && HEX64.test(h))) {
    throw new RekorVerificationError('inclusion proof hashes are not 32-byte lowercase hex');
  }
  const path = proof.hashes.map((h) => Buffer.from(h, 'hex'));
  const logIndex = safeInt(entry.logIndex, 'logIndex');
  const integratedTime = safeInt(entry.integratedTime, 'integratedTime');

  const uuid = leafHash(body).toString('hex');
  const id = typeof entryId === 'string' ? entryId.toLowerCase() : '';
  if (!ENTRY_ID.test(id) || !id.endsWith(uuid)) {
    throw new RekorVerificationError('entry UUID is not the leaf hash of the entry body');
  }
  let computed: Buffer;
  try {
    computed = rootFromPath(leafHash(body), proofIndex, treeSize, path);
  } catch {
    throw new RekorVerificationError('inclusion proof malformed');
  }
  if (!computed.equals(rootHash)) throw new RekorVerificationError('inclusion proof does not reach the stated root hash');
  const checkpoint = verifyCheckpoint(proof.checkpoint as string, opts.logKey);
  if (!checkpoint.rootHash.equals(rootHash) || checkpoint.size !== treeSize) {
    throw new RekorVerificationError('signed checkpoint does not commit to the proof root and size');
  }
  const origin = /^.+ - ([0-9]{1,20})$/.exec(checkpoint.origin);
  if (id.length === 80 && (!origin || BigInt(origin[1]).toString(16).padStart(16, '0') !== id.slice(0, 16))) {
    throw new RekorVerificationError('entry tree ID does not match the checkpoint origin');
  }
  // The SET signs entry.logIndex; the proof places the leaf at proof.logIndex. Bind the two:
  // equal, unless this tree is a pinned shard whose global index starts at a configured offset
  // (Rekor v1 shards: global index = shard-local index + entries in earlier shards).
  const treeHex = origin ? BigInt(origin[1]).toString(16).padStart(16, '0') : null;
  const offset = treeHex !== null && opts.logIndexOffsets && Object.prototype.hasOwnProperty.call(opts.logIndexOffsets, treeHex)
    ? opts.logIndexOffsets[treeHex] : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || logIndex !== proofIndex + offset) {
    throw new RekorVerificationError('entry logIndex does not match the inclusion proof position');
  }
  if (entry.logID !== logIdOf(opts.logKey)) throw new RekorVerificationError("entry logID is not the pinned log's key ID");
  verifySignedEntryTimestamp(entry, opts.logKey);
  verifyBody(body, opts);
  return { uuid, logIndex, integratedTime, treeSize, rootHash };
}

function verifyBody(body: Buffer, opts: VerifyRekorEntryOptions): void {
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString('utf8'));
  } catch {
    throw new RekorVerificationError('malformed entry body');
  }
  if (!isRecord(doc) || doc.kind !== 'hashedrekord' || doc.apiVersion !== '0.0.1') {
    throw new RekorVerificationError('entry is not a hashedrekord v0.0.1');
  }
  const spec = doc.spec;
  const data = isRecord(spec) ? spec.data : undefined;
  const hash = isRecord(data) ? data.hash : undefined;
  const sig = isRecord(spec) ? spec.signature : undefined;
  const pub = isRecord(sig) ? sig.publicKey : undefined;
  if (!isRecord(hash) || !isRecord(sig) || !isRecord(pub)) throw new RekorVerificationError('malformed entry body');
  if (hash.algorithm !== 'sha256' || typeof hash.value !== 'string') throw new RekorVerificationError('entry digest is not sha256');
  if (opts.artifact !== undefined && hash.value !== createHash('sha256').update(opts.artifact).digest('hex')) {
    throw new RekorVerificationError('entry does not commit to this Merkle root');
  }
  if (opts.artifact === undefined && opts.anchorKeySpkiDer === undefined) return; // log-level checks only
  const signature = b64(sig.content, 'entry signature');
  let signer: KeyObject;
  try {
    signer = createPublicKey(b64(pub.content, 'entry public key').toString('utf8'));
  } catch {
    throw new RekorVerificationError('entry public key is unreadable');
  }
  if (opts.anchorKeySpkiDer !== undefined && !spkiDer(signer).equals(opts.anchorKeySpkiDer)) {
    throw new RekorVerificationError('entry was not signed by the anchoring key');
  }
  if (opts.artifact !== undefined) {
    const p256 = signer.asymmetricKeyType === 'ec' && signer.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    if (!p256 || !verifySig(signer, signature, opts.artifact)) {
      throw new RekorVerificationError('entry signature over the Merkle root does not verify');
    }
  }
}

function spkiPem(der: Buffer): string {
  return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
}

/** The hashedrekord v0.0.1 request body for `artifact`. */
export function proposedEntry(artifact: Buffer, signatureDer: Buffer, publicKeySpkiDer: Buffer): Record<string, unknown> {
  return {
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: { hash: { algorithm: 'sha256', value: createHash('sha256').update(artifact).digest('hex') } },
      signature: {
        content: signatureDer.toString('base64'),
        publicKey: { content: Buffer.from(spkiPem(publicKeySpkiDer), 'utf8').toString('base64') },
      },
    },
  };
}

export interface RekorAnchorOptions {
  /** Base URL, e.g. `https://rekor.sigstage.dev`. */
  url: string;
  signer: AnchorSigner;
  /** PEM of the log's public key. Required in production. */
  logPublicKeyPem?: string;
  /** Pinned shard offsets (see `VerifyRekorEntryOptions.logIndexOffsets`); configured with the log key. */
  logIndexOffsets?: Readonly<Record<string, number>>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * Treat this process as production. Can only add strictness: NODE_ENV=production
   * always counts, and `false` never downgrades it.
   */
  production?: boolean;
  /**
   * Development only: with no pinned key, fetch the log's key once and trust
   * it. Off by default, so a deployment that forgets NODE_ENV still refuses to
   * run unpinned; refused in production even when set.
   */
  allowTrustOnFirstUse?: boolean;
  cacheSize?: number;
  /** Allowed difference between the log's clock and ours (integratedTime check). */
  maxClockSkewMs?: number;
  now?: () => Date;
}

/**
 * Rekor v1 anchoring adapter. One per process: it holds the pinned (or
 * first-use) log key and a bounded `batchId → result` cache.
 */
export class RekorAnchor {
  private readonly url: string;
  private readonly signer: AnchorSigner;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private pinned: KeyObject | null;
  private readonly batches: BoundedCache<string, { root: Buffer; result: RekorAnchorResult }>;
  private readonly skewMs: number;
  private readonly now: () => Date;
  private readonly logIndexOffsets?: Readonly<Record<string, number>>;
  /** `pinned` when configured, `first_use` once a dev log's key was fetched and trusted. */
  logKeySource: 'pinned' | 'first_use' | null;

  constructor(opts: RekorAnchorOptions) {
    if (!opts.url) throw new RangeError('a Rekor anchor needs a URL');
    const production = isProduction() || opts.production === true;
    if (opts.logPublicKeyPem === undefined || opts.logPublicKeyPem.trim() === '') {
      if (production) {
        throw new AnchorError('ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED', 'production requires a pinned Rekor log key');
      }
      if (opts.allowTrustOnFirstUse !== true) {
        throw new AnchorError('ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED', 'no pinned Rekor log key (trust on first use not enabled)');
      }
      this.pinned = null;
      this.logKeySource = null;
    } else {
      try {
        this.pinned = loadLogPublicKey(opts.logPublicKeyPem);
      } catch {
        throw new AnchorError('ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED', 'the pinned Rekor log key is unreadable');
      }
      this.logKeySource = 'pinned';
    }
    this.url = opts.url.replace(/\/+$/, '');
    this.signer = opts.signer;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REKOR_TIMEOUT_MS;
    this.batches = new BoundedCache(opts.cacheSize ?? DEFAULT_ANCHOR_CACHE_SIZE);
    this.skewMs = opts.maxClockSkewMs ?? DEFAULT_REKOR_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.skewMs) || this.skewMs < 0) throw new RangeError('maxClockSkewMs must be a non-negative integer');
    this.now = opts.now ?? (() => new Date());
    this.logIndexOffsets = opts.logIndexOffsets;
  }

  /** Log `root` for `batchId` and return the verified entry. Idempotent on `batchId` in-process. */
  async anchor(root: Buffer, batchId: string): Promise<RekorAnchorResult> {
    assertAnchorInput(root, batchId);
    const seen = this.batches.get(batchId);
    if (seen) {
      if (!seen.root.equals(root)) throw new AnchorInputError('batch_id was already anchored with a different root');
      return seen.result;
    }
    const [signature, spki] = [await this.signer.sign(root), await this.signer.publicKeySpkiDer()];
    const started = this.now().getTime();
    const { entryId, entry, created } = await this.submit(proposedEntry(root, signature, spki));
    const ended = this.now().getTime();
    const logKey = await this.logKey();
    let verified: VerifiedRekorEntry;
    try {
      verified = verifyRekorEntry(entryId, entry, { logKey, artifact: root, anchorKeySpkiDer: spki, logIndexOffsets: this.logIndexOffsets });
    } catch (err) {
      if (!(err instanceof RekorVerificationError)) throw err;
      throw new AnchorError('ATTESTA_ANCHOR_LOG_PROOF_INVALID', `log returned an entry that does not verify: ${err.message}`);
    }
    // A new entry is integrated while we wait; an existing one (409) earlier. Never in the future.
    const integratedMs = verified.integratedTime * 1000;
    if (integratedMs > ended + this.skewMs || (created && integratedMs < started - this.skewMs)) {
      throw new AnchorError('ATTESTA_ANCHOR_LOG_PROOF_INVALID', 'log integratedTime is outside the request window');
    }
    const result: RekorAnchorResult = {
      type: 'rekor',
      entryId: entryId.toLowerCase(),
      uuid: verified.uuid,
      logIndex: verified.logIndex,
      integratedTime: verified.integratedTime,
      anchoredAt: new Date(verified.integratedTime * 1000).toISOString(),
      entry: structuredClone(entry),
    };
    this.batches.set(batchId, { root: Buffer.from(root), result });
    return result;
  }

  /**
   * True iff entry `entryId` provably logs `root` under our anchoring key.
   * False for an unknown entry or a proof that is wrong; throws
   * ATTESTA_ANCHOR_LOG_UNAVAILABLE when the log cannot be asked.
   */
  async verifyInclusion(entryId: string, root: Buffer): Promise<boolean> {
    const found = await this.getEntry(entryId);
    if (found === null) return false;
    const logKey = await this.logKey();
    try {
      verifyRekorEntry(entryId, found, {
        logIndexOffsets: this.logIndexOffsets,
        logKey,
        artifact: root,
        anchorKeySpkiDer: await this.signer.publicKeySpkiDer(),
      });
    } catch (err) {
      if (err instanceof RekorVerificationError) return false;
      throw err;
    }
    return true;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}${REKOR_LOG_INFO_PATH}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** The log key in use (pinned, or learned on first use outside production). */
  async logKey(): Promise<KeyObject> {
    if (this.pinned) return this.pinned;
    const res = await fetchWithTimeout(this.fetchImpl, `${this.url}${REKOR_PUBLIC_KEY_PATH}`, {}, this.timeoutMs,
      'ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor');
    if (res.status !== 200) throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', `cannot fetch the rekor public key: HTTP ${res.status}`);
    const pem = (await this.read(res)).toString('utf8');
    let key: KeyObject;
    try {
      key = loadLogPublicKey(pem);
    } catch {
      throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor served an unreadable public key');
    }
    // Trust on first use (dev only; the constructor refuses this in production).
    this.pinned = key;
    this.logKeySource = 'first_use';
    return key;
  }

  private read(res: Response): Promise<Buffer> {
    return readCapped(res, MAX_REKOR_RESPONSE_BYTES,
      { unavailable: 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', tooLarge: 'ATTESTA_ANCHOR_LOG_PROOF_INVALID' }, 'rekor');
  }

  private async readJson(res: Response): Promise<unknown> {
    const text = (await this.read(res)).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private async submit(body: Record<string, unknown>): Promise<{ entryId: string; entry: Record<string, unknown>; created: boolean }> {
    const res = await fetchWithTimeout(this.fetchImpl, `${this.url}${REKOR_ENTRIES_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }, this.timeoutMs, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor');
    if (res.status === 201) return { ...singleEntry(await this.readJson(res)), created: true };
    if (res.status === 409) {
      const existing = existingEntryId(res.headers.get('location'), await this.readJson(res));
      const entry = await this.getEntry(existing);
      if (entry === null) {
        throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor reported a duplicate but cannot return it');
      }
      return { entryId: existing, entry, created: false };
    }
    if (res.status === 400 || res.status === 422) {
      throw new AnchorError('ATTESTA_ANCHOR_LOG_REJECTED', `rekor rejected the entry: HTTP ${res.status}`);
    }
    throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', `rekor returned HTTP ${res.status}`);
  }

  private async getEntry(entryId: string): Promise<Record<string, unknown> | null> {
    if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId.toLowerCase())) return null;
    const res = await fetchWithTimeout(this.fetchImpl, `${this.url}${REKOR_ENTRIES_PATH}/${entryId.toLowerCase()}`, {},
      this.timeoutMs, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor');
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res.status !== 200) throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', `rekor returned HTTP ${res.status}`);
    const { entryId: returned, entry } = singleEntry(await this.readJson(res));
    if (!returned.toLowerCase().endsWith(entryId.toLowerCase().slice(-64))) {
      throw new AnchorError('ATTESTA_ANCHOR_LOG_PROOF_INVALID', 'rekor returned a different entry than requested');
    }
    return entry;
  }
}

function singleEntry(payload: unknown): { entryId: string; entry: Record<string, unknown> } {
  if (!isRecord(payload) || Object.keys(payload).length !== 1) {
    throw new AnchorError('ATTESTA_ANCHOR_LOG_PROOF_INVALID', 'rekor returned an unexpected entry payload');
  }
  const [entryId, entry] = Object.entries(payload)[0];
  if (!ENTRY_ID.test(entryId.toLowerCase()) || !isRecord(entry)) {
    throw new AnchorError('ATTESTA_ANCHOR_LOG_PROOF_INVALID', 'rekor returned an unexpected entry payload');
  }
  return { entryId: entryId.toLowerCase(), entry };
}

function existingEntryId(location: string | null, payload: unknown): string {
  if (location) {
    const last = location.replace(/\/+$/, '').split('/').pop() ?? '';
    if (ENTRY_ID.test(last.toLowerCase())) return last.toLowerCase();
  }
  const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : '';
  const match = /with UUID ([0-9a-fA-F]{64,80})\s*$/.exec(message);
  if (match && ENTRY_ID.test(match[1].toLowerCase())) return match[1].toLowerCase();
  throw new AnchorError('ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'rekor reported a duplicate without identifying it');
}
