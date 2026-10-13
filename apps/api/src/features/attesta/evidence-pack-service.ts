/**
 * Attesta evidence packs (Task15i2, A15.9 part 2; docs/contracts/attesta/evidence-pack.md).
 *
 *   parsePackRequest / parseIdempotencyKey   request validation (400 on anything else)
 *   buildPack                                pure: a stored chain segment → the pack bytes,
 *                                            its digest and manifest (deterministic)
 *   signPack                                 the RP-1 pack signature (DSSE over {manifest, pack_digest})
 *   runEvidencePack                          the job: claim (lease) → read one snapshot →
 *                                            build → sign → write to the sink → ready | failed
 *   pgPackStore                              the tenant-bound PostgreSQL store
 *
 * Ported from SushiCorp @ 0bd67a5 (catalog EV-2, RP-1): services/anchoring/export.py
 * (exact hashed bytes, the predecessor hash, the head when the range reaches it, the
 * batch evidence) and services/reporting/signing.py (sign a small statement naming the
 * digest; never store a signature that does not verify). Deviations:
 *  1. One RFC 8785 document instead of SushiCorp's export layout; DSSE, not a JCS signature.
 *  2. The trust documents travel inside the pack (SushiCorp left keys to the auditor);
 *     the pin stays the user's (`verification_hint` is a hint only).
 *  3. Boundary records and the `repository_only` mode (founder decision 2026-10-13).
 *  4. Built only from stored bytes and the database clock (SushiCorp S4 lesson: the
 *     clock source and counting live rows broke determinism).
 *
 * Every query binds `tenant_id`; none selects `attesta_envelopes.credential_id` or a key's
 * credential reference. No network call inside a transaction: the segment is read in one
 * repeatable-read transaction, signing and the sink write happen after it.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { securityAuditEvents } from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { LocalFileEvidenceExportSink, type EvidenceExportSink } from '../../core/operations/evidence-export-sink';
import type { AnchorVerifyMaterial } from './anchor-env';
import { GENESIS_PREV_HASH, canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import { pae, type DsseEnvelope } from './dsse';
import { parseSeq } from './ledger';
import { AttestaQueryError, anchorMaterialFromEnv, parseRfc3339, type AnchorMaterialSource } from './read-service';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';
import { parseTrustDocument } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, publishedKeysFor, trustConfigFromEnv, type PublishedKeys } from './trust-resolver';

export const EVIDENCE_PACK_FORMAT = 'https://trackai.dev/attesta/evidence-pack/v1';
export const EVIDENCE_PACK_PAYLOAD_TYPE = 'application/vnd.trackai.evidence-pack+json';
/** Records in one segment (so statements per pack); evidence-pack.md "Bounds". */
export const MAX_PACK_RECORDS = 50_000;
export const PACK_LEASE_MS = 600_000;
/** `to` must be this far before generated_at: writers stamp recorded_at just before commit. */
export const PACK_SETTLE_MS = 300_000;
/** Unfinished jobs per tenant before POST answers 429. */
export const MAX_OPEN_PACKS = 4;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,64}$/;

export type PackMode = 'full' | 'repository_only';
export type PackStatus = 'queued' | 'running' | 'ready' | 'failed';

/** The normalized scope (RFC 3339 UTC with ms and Z); what the job row stores. */
export interface PackScope {
  repository_id: string | null;
  from: string;
  to: string;
}

export interface PackRequest { scope: PackScope; mode: PackMode }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A job failure: one errors.md code, and whether a new request can succeed as it is. */
export class PackJobError extends Error {
  constructor(readonly code: PackErrorCode, message: string) {
    super(message);
    this.name = 'PackJobError';
  }
}

export type PackErrorCode =
  | 'ATTESTA_API_INVALID_QUERY'
  | 'ATTESTA_API_INTERNAL'
  | 'ATTESTA_API_UNAVAILABLE'
  | 'ATTESTA_SIGNER_UNAVAILABLE'
  | 'ATTESTA_SIGNER_REJECTED'
  | 'ATTESTA_SIGNER_NO_CREDENTIAL';

/** Codes after which the same request (with a new Idempotency-Key) may succeed unchanged. */
export const RETRYABLE_PACK_CODES: ReadonlySet<string> = new Set([
  'ATTESTA_SIGNER_UNAVAILABLE', 'ATTESTA_API_UNAVAILABLE', 'ATTESTA_API_INTERNAL',
]);

// ---------------------------------------------------------------------------
// Request parsing

export function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new AttestaQueryError('Idempotency-Key must match ^[A-Za-z0-9._-]{8,64}$');
  }
  return raw;
}

/**
 * `{repository_id?, from, to, mode?}`: nothing else. `from`/`to` are RFC 3339 instants
 * (normalized to UTC milliseconds), `from <= to`, and `to` at least PACK_SETTLE_MS
 * before `now` (evidence-pack.md "Which records").
 */
export function parsePackRequest(body: unknown, now: Date): PackRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AttestaQueryError('body must be an object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!['repository_id', 'from', 'to', 'mode'].includes(k)) throw new AttestaQueryError('unknown field');
  }
  let repositoryId: string | null = null;
  if (b.repository_id !== undefined && b.repository_id !== null) {
    if (typeof b.repository_id !== 'string' || !UUID_RE.test(b.repository_id)) throw new AttestaQueryError('repository_id must be a lowercase UUID');
    repositoryId = b.repository_id;
  }
  if (typeof b.from !== 'string' || typeof b.to !== 'string') throw new AttestaQueryError('from and to are required');
  const fromMs = parseRfc3339(b.from, 'from');
  const toMs = parseRfc3339(b.to, 'to');
  if (fromMs > toMs) throw new AttestaQueryError('from is after to');
  if (toMs > now.getTime() - PACK_SETTLE_MS) throw new AttestaQueryError('to must be at least 5 minutes in the past');
  let mode: PackMode = 'full';
  if (b.mode !== undefined) {
    if (b.mode !== 'full' && b.mode !== 'repository_only') throw new AttestaQueryError('mode must be full or repository_only');
    mode = b.mode;
  }
  // recorded_at has millisecond precision; a sub-millisecond bound rounds inward
  // (from up, to down), so the window never includes an instant the caller excluded.
  const subMs = (v: string) => /[1-9]/.test(/T[^.]*\.(\d+)/.exec(v)?.[1]?.slice(3) ?? '');
  const fromIso = new Date(fromMs + (subMs(b.from) ? 1 : 0)).toISOString();
  const toIso = new Date(toMs).toISOString();
  if (fromIso > toIso) throw new AttestaQueryError('from is after to');
  return { scope: { repository_id: repositoryId, from: fromIso, to: toIso }, mode };
}

/** Same scope and mode (what idempotency compares). */
export function sameRequest(a: PackRequest, b: { scope: unknown; mode: string }): boolean {
  return canonicalize(a.scope) === safeCanonical(b.scope) && a.mode === b.mode;
}

function safeCanonical(v: unknown): string | null {
  try {
    return canonicalize(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The segment as the store reads it

export interface SegmentRecord {
  seq: number;
  prevHash: string;
  recordHash: string;
  canonicalRecord: string;
  /** Millisecond ISO, as in canonical_record. */
  recordedAt: string;
  repositoryId: string;
  statementDigest: string;
  /** Present for in-scope records only (the store reads statements for the scope alone). */
  statementCanonical: string | null;
  envelope: unknown | null;
}

export interface SegmentAnchor {
  seq: number;
  anchorType: 'rekor' | 'tsa';
  batchId: string;
  inclusionProof: unknown;
  rekorEntryUuid: string | null;
  tsaTokenB64: string | null;
}

export interface SegmentBatch {
  batchId: string;
  seqFrom: number;
  seqTo: number;
  leafCount: number;
  merkleRoot: string;
}

export interface Segment {
  /** Database clock at the start of the read (ms ISO). */
  generatedAt: string;
  fromSeq: number;
  /** -1 for an empty chain. */
  toSeq: number;
  /** record_hash of fromSeq − 1, or genesis. */
  prevHash: string;
  /** The chain head when the segment reaches it. */
  head: { next_seq: number; head_hash: string } | null;
  records: SegmentRecord[];
  /** anchored rows of in-scope records. */
  anchors: SegmentAnchor[];
  batches: SegmentBatch[];
}

/** The public trust material a pack carries (evidence-pack.md "trust"). */
export interface PackTrust {
  root_documents: DsseEnvelope[];
  keyset_documents: DsseEnvelope[];
  anchoring_keys: Array<{ keyid: string; spki_der_b64: string; root_entry: unknown | null }>;
  rekor_log_key_spki_b64: string | null;
  rekor_log_index_offsets: Record<string, number> | null;
  tsa_anchors_der_b64: string[];
}

export interface PackTrustMaterial {
  trust: PackTrust;
  pinnedRootKeyids: string[];
}

export function inWindow(recordedAt: string, scope: PackScope): boolean {
  return recordedAt >= scope.from && recordedAt <= scope.to;
}

export function inScope(r: { recordedAt: string; repositoryId: string }, scope: PackScope): boolean {
  return inWindow(r.recordedAt, scope) && (scope.repository_id === null || r.repositoryId === scope.repository_id);
}

// ---------------------------------------------------------------------------
// buildPack: pure and deterministic

export interface PackCounts {
  records: number;
  statements: number;
  redacted_records: number;
  anchored: number;
  pending: number;
  anchor_rows: number;
  anchor_batches: number;
}

export interface PackManifest {
  format: typeof EVIDENCE_PACK_FORMAT;
  pack_id: string;
  tenant_id: string;
  scope: PackScope & { mode: PackMode };
  chain_range: { from_seq: number; to_seq: number; prev_hash: string; head: { next_seq: number; head_hash: string } | null };
  generated_at: string;
  completeness: 'provable' | 'not_provable';
  counts: PackCounts;
  sections: Record<(typeof SECTION_NAMES)[number], string>;
}

export const SECTION_NAMES = ['records', 'statements', 'anchors', 'anchor_batches', 'trust', 'verification_hint', 'reports', 'verifier'] as const;

export interface BuildPackInput {
  packId: string;
  tenantId: string;
  scope: PackScope;
  mode: PackMode;
  segment: Segment;
  trust: PackTrustMaterial;
}

export interface BuiltPack {
  /** The RFC 8785 bytes written to the sink. */
  text: string;
  digest: string;
  manifest: PackManifest;
  counts: PackCounts;
}

const internal = (why: string) => new PackJobError('ATTESTA_API_INTERNAL', `evidence pack: ${why}`);
const sectionDigest = (value: unknown) => sha256Prefixed(canonicalize(value));

/**
 * The pack for one segment. Refuses (ATTESTA_API_INTERNAL) a segment that is not what
 * the store promised (a gap, a broken link, a statement that does not hash to its
 * record): a pack is never built over an inconsistent chain; the verify route reports it.
 */
export function buildPack(input: BuildPackInput): BuiltPack {
  const { segment: seg, scope, mode } = input;
  if (!UUID_RE.test(input.packId) || !UUID_RE.test(input.tenantId)) throw internal('ids are not lowercase UUIDs');
  if (!ISO_MS_RE.test(seg.generatedAt)) throw internal('generated_at is malformed');
  if (Date.parse(scope.to) > Date.parse(seg.generatedAt) - PACK_SETTLE_MS) {
    throw new PackJobError('ATTESTA_API_INVALID_QUERY', 'to is not settled at generated_at');
  }
  const length = seg.toSeq - seg.fromSeq + 1;
  if (length > MAX_PACK_RECORDS) throw new PackJobError('ATTESTA_API_INVALID_QUERY', 'the segment exceeds the pack bound');
  if (seg.records.length !== Math.max(0, length)) throw internal('the segment is not gap-free');
  if (seg.fromSeq === 0 && seg.prevHash !== GENESIS_PREV_HASH) throw internal('seq 0 must follow genesis');

  const records: Array<Record<string, unknown>> = [];
  const statements: Array<Record<string, unknown>> = [];
  const anchorsBySeq = new Map<number, SegmentAnchor[]>();
  for (const a of seg.anchors) anchorsBySeq.set(a.seq, [...(anchorsBySeq.get(a.seq) ?? []), a]);
  let prev = seg.prevHash;
  let redacted = 0;
  let anchored = 0;
  const inScopeSeqs = new Set<number>();
  seg.records.forEach((r, i) => {
    if (r.seq !== seg.fromSeq + i) throw internal('the segment is not gap-free');
    if (r.prevHash !== prev) throw internal('a prev_hash link is broken');
    if (computeRecordHash(r.canonicalRecord, r.prevHash) !== r.recordHash) throw internal('a record_hash does not match its bytes');
    prev = r.recordHash;
    const scoped = inScope(r, scope);
    if (scoped || mode === 'full') {
      records.push({ seq: r.seq, prev_hash: r.prevHash, record_hash: r.recordHash, canonical_record: r.canonicalRecord });
    } else {
      records.push({ seq: r.seq, prev_hash: r.prevHash, record_hash: r.recordHash });
      redacted += 1;
    }
    if (!scoped) return;
    if (r.statementCanonical === null || r.envelope === null || r.envelope === undefined) throw internal('an in-scope statement is missing');
    if (sha256Prefixed(r.statementCanonical) !== r.statementDigest) throw internal('a statement does not hash to its record');
    const types = new Set((anchorsBySeq.get(r.seq) ?? []).map((a) => a.anchorType));
    const status = types.has('rekor') && types.has('tsa') ? 'anchored' : 'pending';
    if (status === 'anchored') anchored += 1;
    inScopeSeqs.add(r.seq);
    statements.push({
      seq: r.seq, statement_digest: r.statementDigest, statement_canonical: r.statementCanonical,
      envelope: r.envelope, anchor_status: status,
    });
  });
  if (seg.head !== null && (seg.head.next_seq !== seg.toSeq + 1 || (seg.records.length > 0 && seg.head.head_hash !== prev))) {
    throw internal('the head does not match the segment');
  }

  const anchors = [...seg.anchors]
    .filter((a) => inScopeSeqs.has(a.seq))
    .sort((x, y) => x.seq - y.seq || (x.anchorType < y.anchorType ? -1 : x.anchorType > y.anchorType ? 1 : 0))
    .map((a) => ({
      seq: a.seq, anchor_type: a.anchorType, batch_id: a.batchId, inclusion_proof: a.inclusionProof,
      rekor_entry_uuid: a.rekorEntryUuid, tsa_token_b64: a.tsaTokenB64,
    }));
  const named = new Set(anchors.map((a) => a.batch_id));
  const batches = seg.batches
    .filter((b) => named.has(b.batchId))
    .sort((x, y) => x.seqFrom - y.seqFrom)
    .map((b) => ({ batch_id: b.batchId, seq_from: b.seqFrom, seq_to: b.seqTo, leaf_count: b.leafCount, merkle_root: b.merkleRoot }));
  if (batches.length !== named.size) throw internal('an anchor names a batch that was not read');

  const verificationHint = { pinned_root_keyids: [...input.trust.pinnedRootKeyids] };
  const sectionValues = {
    records, statements, anchors, anchor_batches: batches, trust: input.trust.trust,
    verification_hint: verificationHint, reports: [] as unknown[], verifier: null,
  };
  const counts: PackCounts = {
    records: records.length, statements: statements.length, redacted_records: redacted, anchored,
    pending: statements.length - anchored, anchor_rows: anchors.length, anchor_batches: batches.length,
  };
  const sections = Object.fromEntries(SECTION_NAMES.map((n) => [n, sectionDigest(sectionValues[n])])) as PackManifest['sections'];
  const manifest: PackManifest = {
    format: EVIDENCE_PACK_FORMAT,
    pack_id: input.packId,
    tenant_id: input.tenantId,
    scope: { ...scope, mode },
    chain_range: { from_seq: seg.fromSeq, to_seq: seg.toSeq, prev_hash: seg.prevHash, head: seg.head },
    generated_at: seg.generatedAt,
    completeness: mode === 'full' ? 'provable' : 'not_provable',
    counts,
    sections,
  };
  const text = canonicalize({ manifest, ...sectionValues });
  return { text, digest: sha256Prefixed(text), manifest, counts };
}

/** The RP-1 statement the pack signature covers. */
export function packSignaturePayload(manifest: PackManifest, packDigest: string): Buffer {
  if (!DIGEST_RE.test(packDigest)) throw internal('pack digest is malformed');
  return Buffer.from(canonicalize({ manifest, pack_digest: packDigest }), 'utf8');
}

/**
 * Sign the pack with the tenant's active statement key (inventorySignerResolver in
 * production). signVerified checks the adapter's answer before it is used.
 */
export async function signPack(built: BuiltPack, resolver: SignerResolver, tenantId: string, requestId: string): Promise<DsseEnvelope> {
  const payload = packSignaturePayload(built.manifest, built.digest);
  let resolved;
  try {
    resolved = await resolver.resolve(tenantId);
  } catch (err) {
    throw signerError(err);
  }
  if (!resolved) throw new PackJobError('ATTESTA_SIGNER_NO_CREDENTIAL', 'the tenant has no active statement key');
  try {
    const result = await signVerified(resolved.adapter, pae(EVIDENCE_PACK_PAYLOAD_TYPE, payload), {
      credentialId: resolved.credentialId, tenantId, requestId,
    });
    return {
      payload: payload.toString('base64'),
      payloadType: EVIDENCE_PACK_PAYLOAD_TYPE,
      signatures: [{ keyid: sha256Prefixed(result.publicKeySpkiDer), sig: result.signature.toString('base64') }],
    };
  } catch (err) {
    throw signerError(err);
  }
}

function signerError(err: unknown): PackJobError {
  if (err instanceof PackJobError) return err;
  if (err instanceof SigningRejected) return new PackJobError('ATTESTA_SIGNER_REJECTED', 'the signer refused the pack');
  if (err instanceof SigningUnavailable) return new PackJobError('ATTESTA_SIGNER_UNAVAILABLE', 'the signer is unavailable');
  return new PackJobError('ATTESTA_SIGNER_UNAVAILABLE', 'the signer failed');
}

// ---------------------------------------------------------------------------
// Jobs

export interface PackJob {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  scope: unknown;
  mode: PackMode;
  status: PackStatus;
  requestedBy: string;
  requestId: string;
  attempts: number;
  packDigest: string | null;
  storageReference: string | null;
  bytes: number | null;
  counts: PackCounts | null;
  signatureEnvelope: DsseEnvelope | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface PackAuditInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  action: 'attesta.export.request' | 'attesta.export.download';
  packId: string;
  details: Record<string, unknown>;
}

export interface PackStore {
  /** Inserts a queued job, or returns the existing one for (tenant, key). */
  createOrGet(input: { tenantId: string; idempotencyKey: string; request: PackRequest; requestedBy: string; requestId: string }):
    Promise<{ job: PackJob; created: boolean }>;
  get(tenantId: string, id: string): Promise<PackJob | null>;
  findByKey(tenantId: string, idempotencyKey: string): Promise<PackJob | null>;
  /** queued + running jobs of the tenant. */
  openCount(tenantId: string): Promise<number>;
  repositoryExists(tenantId: string, repositoryId: string): Promise<boolean>;
  /** The segment size a scope would read now (request-time bound). */
  segmentSize(tenantId: string, scope: PackScope): Promise<number>;
  /** queued, or running with an expired lease → running; the new attempts count, or null when not claimable. */
  claim(tenantId: string, id: string, leaseMs: number): Promise<number | null>;
  /** One repeatable-read snapshot (evidence-pack.md "Which records"). */
  readSegment(tenantId: string, scope: PackScope): Promise<Segment>;
  finishReady(tenantId: string, id: string, attempts: number, out: {
    packDigest: string; storageReference: string; bytes: number; counts: PackCounts; signatureEnvelope: DsseEnvelope;
  }): Promise<boolean>;
  finishFailed(tenantId: string, id: string, attempts: number | null, code: PackErrorCode): Promise<boolean>;
  /** Jobs a recovery pass can take: queued, or running past their lease. */
  runnable(limit: number): Promise<Array<{ tenantId: string; id: string }>>;
  audit(input: PackAuditInput): Promise<void>;
}

export interface PackJobDeps {
  store: PackStore;
  /** The export sink (Task4); null when TASK4_EXPORT_DIR is not configured. */
  sink: () => EvidenceExportSink | null;
  /** The pack signer (inventorySignerResolver in production). */
  resolver: () => Promise<SignerResolver>;
  trust: (tenantId: string) => Promise<PackTrustMaterial>;
  log?: (line: string) => void;
  leaseMs?: number;
}

export type PackRunResult = 'ready' | 'failed' | 'not_claimed' | 'lease_lost';

function codeOf(err: unknown): PackErrorCode {
  return err instanceof PackJobError ? err.code : 'ATTESTA_API_INTERNAL';
}

/**
 * Run one job: claim it (a 10-minute lease; an expired lease is retaken), read the
 * segment in one snapshot, build, sign (outside any transaction), write the pack
 * through the sink, then mark it ready with digest, reference and bytes. Any failure
 * marks it failed with one code; a partial pack is never ready (the sink file is
 * removed when the job could not be finished).
 */
export async function runEvidencePack(deps: PackJobDeps, tenantId: string, packId: string): Promise<PackRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const attempts = await deps.store.claim(tenantId, packId, deps.leaseMs ?? PACK_LEASE_MS);
  if (attempts === null) return 'not_claimed';
  const job = await deps.store.get(tenantId, packId);
  let written: { storageReference: string; bytes: number } | null = null;
  let sink: EvidenceExportSink | null = null;
  try {
    if (!job || job.status !== 'running') throw internal('the claimed job is not running');
    const scope = parseStoredScope(job.scope);
    sink = deps.sink();
    if (!sink) throw new PackJobError('ATTESTA_API_UNAVAILABLE', 'the export sink is not configured');
    const segment = await deps.store.readSegment(tenantId, scope);
    let trust: PackTrustMaterial;
    try {
      trust = await deps.trust(tenantId);
    } catch {
      throw new PackJobError('ATTESTA_API_UNAVAILABLE', 'the trust material cannot be read');
    }
    const built = buildPack({ packId, tenantId, scope, mode: job.mode, segment, trust });
    let resolver: SignerResolver;
    try {
      resolver = await deps.resolver();
    } catch {
      throw new PackJobError('ATTESTA_SIGNER_UNAVAILABLE', 'the signer cannot be configured');
    }
    const envelope = await signPack(built, resolver, tenantId, job.requestId);
    try {
      written = await sink.write(packId, built.text);
    } catch {
      throw new PackJobError('ATTESTA_API_UNAVAILABLE', 'the export sink refused the pack');
    }
    const ok = await deps.store.finishReady(tenantId, packId, attempts, {
      packDigest: built.digest, storageReference: written.storageReference, bytes: written.bytes,
      counts: built.counts, signatureEnvelope: envelope,
    });
    if (!ok) {
      await sink.remove(written.storageReference).catch(() => undefined);
      return 'lease_lost';
    }
    return 'ready';
  } catch (err) {
    const code = codeOf(err);
    if (written && sink) await sink.remove(written.storageReference).catch(() => undefined);
    log(`attesta-pack ${code} pack_id=${packId} cause=${err instanceof Error ? err.name : 'unknown'}`);
    const ok = await deps.store.finishFailed(tenantId, packId, attempts, code).catch(() => false);
    return ok ? 'failed' : 'lease_lost';
  }
}

/** The stored scope, re-validated (a row is data, never trusted shape). */
export function parseStoredScope(raw: unknown): PackScope {
  const s = raw as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || Object.keys(s).sort().join(',') !== 'from,repository_id,to' ||
      typeof s.from !== 'string' || !ISO_MS_RE.test(s.from) || typeof s.to !== 'string' || !ISO_MS_RE.test(s.to) ||
      !(s.repository_id === null || (typeof s.repository_id === 'string' && UUID_RE.test(s.repository_id)))) {
    throw internal('the stored scope is malformed');
  }
  return { repository_id: s.repository_id as string | null, from: s.from, to: s.to };
}

/** The status body of GET /evidence-packs/{id}. */
export function packStatusBody(job: PackJob, basePath = '/api/attesta/evidence-packs') {
  return {
    id: job.id,
    status: job.status,
    scope: job.scope,
    mode: job.mode,
    counts: job.counts,
    pack_digest: job.packDigest,
    bytes: job.bytes,
    error_code: job.errorCode,
    retryable: job.errorCode === null ? null : RETRYABLE_PACK_CODES.has(job.errorCode),
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    content_path: job.status === 'ready' ? `${basePath}/${job.id}/content` : null,
  };
}

/**
 * The download body: `{"pack": <stored bytes>, "signature": <envelope>}`. The stored
 * bytes are checked against the job's digest first; a mismatch is a 500, never a
 * download of something the signature does not cover.
 */
export function downloadBody(job: PackJob, stored: string): string {
  if (job.status !== 'ready' || !job.packDigest || !job.signatureEnvelope) throw internal('the job is not ready');
  if (sha256Prefixed(stored) !== job.packDigest) throw internal('the stored pack does not match its digest');
  return `{"pack":${stored},"signature":${JSON.stringify(job.signatureEnvelope)}}`;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

export interface PackDbExecutor { execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }> }
export interface PackDatabase extends PackDbExecutor {
  transaction<T>(fn: (tx: PackDbExecutor) => Promise<T>,
    config?: { isolationLevel?: 'repeatable read'; accessMode?: 'read only' }): Promise<T>;
}

const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const JOB_COLUMNS = sql.raw(`id::text as id, tenant_id::text as tenant_id, idempotency_key, scope, mode, status,
  requested_by, request_id, attempts, pack_digest, storage_reference, bytes::text as bytes, counts, signature_envelope,
  error_code, to_char(created_at at time zone 'UTC', ${TS_MS}) as created_at,
  to_char(finished_at at time zone 'UTC', ${TS_MS}) as finished_at`);

function toJob(r: Record<string, unknown>): PackJob {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), idempotencyKey: str(r.idempotency_key), scope: r.scope,
    mode: r.mode === 'repository_only' ? 'repository_only' : 'full',
    status: str(r.status) as PackStatus, requestedBy: str(r.requested_by), requestId: str(r.request_id),
    attempts: Number(r.attempts), packDigest: strOrNull(r.pack_digest), storageReference: strOrNull(r.storage_reference),
    bytes: typeof r.bytes === 'string' ? Number(r.bytes) : null, counts: (r.counts ?? null) as PackCounts | null,
    signatureEnvelope: (r.signature_envelope ?? null) as DsseEnvelope | null, errorCode: strOrNull(r.error_code),
    createdAt: str(r.created_at), finishedAt: strOrNull(r.finished_at),
  };
}

/** Boundary seqs of a scope: [from_seq, to_seq] and whether the head is reached. */
async function boundaries(tx: PackDbExecutor, tenantId: string, scope: PackScope) {
  const r = (await tx.execute(sql`/* pack:bounds */
    select (select max(seq)::text from attesta_records where tenant_id = ${tenantId} and recorded_at < ${scope.from}::timestamptz) as before,
           (select min(seq)::text from attesta_records where tenant_id = ${tenantId} and recorded_at > ${scope.to}::timestamptz) as after,
           (select next_seq::text from chain_head where tenant_id = ${tenantId}) as next_seq,
           (select head_hash from chain_head where tenant_id = ${tenantId}) as head_hash`)).rows[0] ?? {};
  const nextSeq = typeof r.next_seq === 'string' ? parseSeq(r.next_seq, 'next_seq') : 0;
  const fromSeq = typeof r.before === 'string' ? parseSeq(r.before) : 0;
  const after = typeof r.after === 'string' ? parseSeq(r.after) : null;
  const toSeq = after ?? nextSeq - 1;
  return { fromSeq, toSeq, reachesHead: after === null, nextSeq, headHash: strOrNull(r.head_hash) };
}

export function pgPackStore(db: PackDatabase): PackStore {
  return {
    async createOrGet({ tenantId, idempotencyKey, request, requestedBy, requestId }) {
      const inserted = await db.execute(sql`/* pack:create */
        insert into attesta_evidence_packs (tenant_id, idempotency_key, scope, mode, requested_by, request_id)
        values (${tenantId}, ${idempotencyKey}, ${JSON.stringify(request.scope)}::jsonb, ${request.mode}, ${requestedBy}, ${requestId})
        on conflict (tenant_id, idempotency_key) do nothing
        returning ${JOB_COLUMNS}`);
      if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
      const existing = await db.execute(sql`/* pack:by_key */
        select ${JOB_COLUMNS} from attesta_evidence_packs where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`);
      if (!existing.rows[0]) throw internal('the idempotent job vanished');
      return { job: toJob(existing.rows[0]), created: false };
    },

    async get(tenantId, id) {
      const r = await db.execute(sql`/* pack:get */
        select ${JOB_COLUMNS} from attesta_evidence_packs where tenant_id = ${tenantId} and id = ${id}::uuid`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async findByKey(tenantId, idempotencyKey) {
      const r = await db.execute(sql`/* pack:by_key */
        select ${JOB_COLUMNS} from attesta_evidence_packs where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async openCount(tenantId) {
      const r = await db.execute(sql`/* pack:open */
        select count(*)::int as n from attesta_evidence_packs where tenant_id = ${tenantId} and status in ('queued', 'running')`);
      return Number(r.rows[0]?.n ?? 0);
    },

    async repositoryExists(tenantId, repositoryId) {
      const r = await db.execute(sql`/* pack:repository */
        select 1 as ok from scm_repositories where tenant_id = ${tenantId} and id = ${repositoryId}::uuid`);
      return r.rows.length > 0;
    },

    async segmentSize(tenantId, scope) {
      const b = await boundaries(db, tenantId, scope);
      return Math.max(0, b.toSeq - b.fromSeq + 1);
    },

    async claim(tenantId, id, leaseMs) {
      const r = await db.execute(sql`/* pack:claim */
        update attesta_evidence_packs
        set status = 'running', attempts = attempts + 1, lease_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
        where tenant_id = ${tenantId} and id = ${id}::uuid
          and (status = 'queued' or (status = 'running' and lease_until < now()))
        returning attempts`);
      return r.rows[0] ? Number(r.rows[0].attempts) : null;
    },

    async readSegment(tenantId, scope) {
      return db.transaction(async (tx) => {
        const clock = await tx.execute(sql`/* pack:clock */
          select ${sql.raw(`to_char(now() at time zone 'UTC', ${TS_MS})`)} as generated_at`);
        const generatedAt = str(clock.rows[0]?.generated_at);
        const b = await boundaries(tx, tenantId, scope);
        if (b.toSeq - b.fromSeq + 1 > MAX_PACK_RECORDS) {
          throw new PackJobError('ATTESTA_API_INVALID_QUERY', 'the segment exceeds the pack bound');
        }
        let prevHash = GENESIS_PREV_HASH;
        if (b.fromSeq > 0) {
          const p = await tx.execute(sql`/* pack:prev */
            select record_hash from attesta_records where tenant_id = ${tenantId} and seq = ${b.fromSeq - 1}`);
          if (typeof p.rows[0]?.record_hash !== 'string') throw internal('the predecessor record is missing');
          prevHash = p.rows[0].record_hash as string;
        }
        const repo = scope.repository_id;
        const scoped = sql`(r.recorded_at >= ${scope.from}::timestamptz and r.recorded_at <= ${scope.to}::timestamptz
          ${repo ? sql`and r.repository_id = ${repo}::uuid` : sql``})`;
        const rows = b.toSeq < b.fromSeq ? [] : (await tx.execute(sql`/* pack:records */
          select r.seq::text as seq, r.prev_hash, r.record_hash, r.canonical_record,
                 ${sql.raw(`to_char(r.recorded_at at time zone 'UTC', ${TS_MS})`)} as recorded_at,
                 r.repository_id::text as repository_id, r.statement_digest,
                 case when ${scoped} then r.statement_canonical end as statement_canonical,
                 case when ${scoped} then e.envelope end as envelope
          from attesta_records r
          left join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
          where r.tenant_id = ${tenantId} and r.seq between ${b.fromSeq} and ${b.toSeq}
          order by r.seq`)).rows;
        const anchors = b.toSeq < b.fromSeq ? [] : (await tx.execute(sql`/* pack:anchors */
          select r.seq::text as seq, a.anchor_type, a.batch_id, a.inclusion_proof, a.rekor_entry_uuid, a.tsa_token_b64
          from attesta_anchors a
          join attesta_records r on r.tenant_id = a.tenant_id and r.id = a.record_id
          where a.tenant_id = ${tenantId} and a.status = 'anchored' and r.seq between ${b.fromSeq} and ${b.toSeq} and ${scoped}
          order by r.seq, a.anchor_type`)).rows;
        const batchIds = [...new Set(anchors.map((a) => str(a.batch_id)))];
        const batches = batchIds.length === 0 ? [] : (await tx.execute(sql`/* pack:batches */
          select batch_id, seq_from::text as seq_from, seq_to::text as seq_to, leaf_count, merkle_root
          from attesta_anchor_batches
          where tenant_id = ${tenantId} and batch_id in (${sql.join(batchIds.map((id) => sql`${id}`), sql`, `)})
          order by seq_from`)).rows;
        return {
          generatedAt,
          fromSeq: b.toSeq < b.fromSeq ? 0 : b.fromSeq,
          toSeq: b.toSeq < b.fromSeq ? -1 : b.toSeq,
          prevHash: b.toSeq < b.fromSeq ? GENESIS_PREV_HASH : prevHash,
          head: b.reachesHead && b.headHash !== null ? { next_seq: b.nextSeq, head_hash: b.headHash } : null,
          records: rows.map((r) => ({
            seq: parseSeq(r.seq), prevHash: str(r.prev_hash), recordHash: str(r.record_hash), canonicalRecord: str(r.canonical_record),
            recordedAt: str(r.recorded_at), repositoryId: str(r.repository_id), statementDigest: str(r.statement_digest),
            statementCanonical: strOrNull(r.statement_canonical), envelope: r.envelope ?? null,
          })),
          anchors: anchors.map((a) => ({
            seq: parseSeq(a.seq), anchorType: a.anchor_type === 'tsa' ? 'tsa' as const : 'rekor' as const, batchId: str(a.batch_id),
            inclusionProof: a.inclusion_proof ?? null, rekorEntryUuid: strOrNull(a.rekor_entry_uuid), tsaTokenB64: strOrNull(a.tsa_token_b64),
          })),
          batches: batches.map((x) => ({
            batchId: str(x.batch_id), seqFrom: parseSeq(x.seq_from), seqTo: parseSeq(x.seq_to),
            leafCount: Number(x.leaf_count), merkleRoot: str(x.merkle_root),
          })),
        };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async finishReady(tenantId, id, attempts, out) {
      const r = await db.execute(sql`/* pack:ready */
        update attesta_evidence_packs
        set status = 'ready', lease_until = null, pack_digest = ${out.packDigest}, storage_reference = ${out.storageReference},
            bytes = ${out.bytes}, counts = ${JSON.stringify(out.counts)}::jsonb,
            signature_envelope = ${JSON.stringify(out.signatureEnvelope)}::jsonb, updated_at = now(), finished_at = now()
        where tenant_id = ${tenantId} and id = ${id}::uuid and status = 'running' and attempts = ${attempts}
        returning id`);
      return r.rows.length === 1;
    },

    async finishFailed(tenantId, id, attempts, code) {
      const r = await db.execute(sql`/* pack:failed */
        update attesta_evidence_packs
        set status = 'failed', lease_until = null, error_code = ${code}, updated_at = now(), finished_at = now()
        where tenant_id = ${tenantId} and id = ${id}::uuid
          and ${attempts === null ? sql`status = 'queued'` : sql`status = 'running' and attempts = ${attempts}`}
        returning id`);
      return r.rows.length === 1;
    },

    async runnable(limit) {
      // Across tenants on purpose: the recovery CLI is an operator tool (no request tenant);
      // every row it returns is then claimed and built with its own tenant_id.
      const r = await db.execute(sql`/* pack:runnable */
        select tenant_id::text as tenant_id, id::text as id from attesta_evidence_packs
        where status = 'queued' or (status = 'running' and lease_until < now())
        order by created_at limit ${limit}`);
      return r.rows.map((x) => ({ tenantId: str(x.tenant_id), id: str(x.id) }));
    },

    async audit(input) {
      await withTenant(coreDb, input.tenantId).insert(securityAuditEvents, {
        actorType: input.actorRole,
        actorId: input.actorId,
        action: input.action,
        targetType: 'attesta_evidence_pack',
        targetId: input.packId,
        details: input.details,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Trust material (all public)

/**
 * The pack's `trust` section from what the verify route uses: the stored root
 * documents and the tenant's key sets from version 1 (`publishedKeysFor`), the
 * anchoring keys of the verify material (production: the trust-verified windows) each
 * with its entry in the newest root (null for a development key no root lists), the
 * pinned Rekor log key and shard offsets (decimal tree IDs, as configured), and the
 * TSA trust anchors. Sorted, so the same state gives the same bytes.
 */
export function packTrustFrom(input: {
  published: Pick<PublishedKeys, 'rootDocuments' | 'keysetDocuments'>;
  anchors: AnchorVerifyMaterial | null;
  pinnedRootKeyids: readonly string[];
}): PackTrustMaterial {
  const { published, anchors } = input;
  const newestRoot = published.rootDocuments.length > 0
    ? parseTrustDocument(published.rootDocuments[published.rootDocuments.length - 1]) : null;
  const spkis = anchors ? (anchors.anchorKeyWindows?.map((w) => w.spkiDer) ?? anchors.anchorKeysSpkiDer ?? []) : [];
  const byKeyid = new Map<string, Buffer>();
  for (const spki of spkis) byKeyid.set(sha256Prefixed(spki), spki);
  const anchoringKeys = [...byKeyid.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([keyid, spki]) => ({
    keyid, spki_der_b64: spki.toString('base64'), root_entry: (newestRoot?.keys.get(keyid)?.entry ?? null) as unknown,
  }));
  let offsets: Record<string, number> | null = null;
  if (anchors?.rekorLogIndexOffsets) {
    offsets = {};
    for (const [hex, n] of Object.entries(anchors.rekorLogIndexOffsets).sort()) offsets[BigInt('0x' + hex).toString(10)] = n;
  }
  return {
    trust: {
      root_documents: [...published.rootDocuments],
      keyset_documents: [...published.keysetDocuments],
      anchoring_keys: anchoringKeys,
      rekor_log_key_spki_b64: anchors?.rekorLogKey
        ? Buffer.from(anchors.rekorLogKey.export({ type: 'spki', format: 'der' })).toString('base64') : null,
      rekor_log_index_offsets: offsets,
      tsa_anchors_der_b64: (anchors?.tsaAnchors ?? []).map((c) => Buffer.from(c.toSchema(true).toBER(false)).toString('base64')),
    },
    pinnedRootKeyids: [...input.pinnedRootKeyids].sort(),
  };
}

// ---------------------------------------------------------------------------
// Production wiring

/**
 * The job's production dependencies: the pg store, the Task4 sink in TASK4_EXPORT_DIR
 * (unset → the job fails ATTESTA_API_UNAVAILABLE), the tenant's statement key through
 * `inventorySignerResolver(pgTrustStore(db), await adaptersFromEnv(), trustConfigFromEnv())`
 * (adapters built once; a failed build is retried on the next job), and the trust
 * material from the same inventory and anchor configuration the verify route uses.
 */
export function defaultPackJobDeps(env: NodeJS.ProcessEnv = process.env, anchors: AnchorMaterialSource = anchorMaterialFromEnv(env)): PackJobDeps {
  const trustStore = () => pgTrustStore(coreDb as unknown as TrustDb);
  let resolver: Promise<SignerResolver> | null = null;
  return {
    store: pgPackStore(coreDb as unknown as PackDatabase),
    sink: () => {
      const dir = env.TASK4_EXPORT_DIR?.trim();
      return dir ? new LocalFileEvidenceExportSink(dir) : null;
    },
    resolver: () => {
      if (!resolver) {
        resolver = (async () => inventorySignerResolver(trustStore(), await adaptersFromEnv(env), trustConfigFromEnv(env)))();
        resolver.catch(() => { resolver = null; });
      }
      return resolver;
    },
    trust: async (tenantId) => packTrustFrom({
      published: await publishedKeysFor(trustStore(), tenantId),
      anchors: await anchors(),
      pinnedRootKeyids: trustConfigFromEnv(env).pinnedRootKeyids,
    }),
  };
}

/** A fresh UUID for jobs created outside the database (tests). */
export const newPackId = (): string => randomUUID();
