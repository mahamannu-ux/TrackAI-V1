/**
 * Attesta anchoring worker (Task15f2, A15.5 part 2): batches each tenant's chain
 * records into RFC 6962 Merkle trees and anchors every batch root in Rekor and an
 * RFC 3161 TSA (dual, all or nothing), then records one row per record, anchor type
 * and attempt (docs/contracts/attesta/tables.md §attesta_anchor_batches and
 * attesta_anchors; errors.md §Anchoring).
 *
 * Three steps per batch, never a network call inside a transaction (AGENTS.md §9
 * item 18): plan (one read-only transaction holding a per-tenant advisory try-lock,
 * no lock on the chain) → submit (`DualAnchor.anchor`, no transaction) → record (one
 * write transaction). Only the 32-byte root leaves the tenant. Anchoring never
 * touches `attesta_records` and never changes `record_hash` (§9 item 17).
 *
 * Ported from SushiCorp EV-2 @ 0bd67a5: `services/anchoring/service.py` (pass and
 * drain, stop on an outage, lost race is not an error) and `core/evidence/anchoring.py`
 * (deterministic batch_id, re-plan a failed batch with the same members and root,
 * backoff from the count of failed attempts, a rejected batch skipped until an
 * operator acts). Kept: deterministic batches, re-plan to the same root, idempotency
 * on batch_id, all-or-nothing dual mode, no network inside a lock.
 * Deviations:
 *  1. One row per record and anchor type (tables.md), so backoff and terminal state
 *     are per batch and type; a batch is due when every failed type's backoff passed.
 *  2. Batches are tenant-scoped and contiguous: a batch starts right after the
 *     tenant's last batch (the 0018 guard refuses anything else with ATA01), and a
 *     written batch is re-planned from its stored range, never re-cut.
 *  3. Terminal codes (`TERMINAL_ANCHOR_CODES`: LOG_KEY_NOT_PINNED, LOG_REJECTED) stop
 *     that batch for good: later batches still anchor, a stopped batch never takes a
 *     planning slot or makes its tenant a candidate on its own, and its records show
 *     as ANCHOR_MISSING in the verify report once past the window. Resuming a stopped
 *     batch needs an operator path that does not exist yet (append-only tables; see
 *     the handoff). Every other code, SIGNER_REJECTED included, retries with backoff.
 *  4. The batch row is written in the record step (with its first outcome), not at
 *     planning, so a crash before recording leaves nothing and the next plan re-forms
 *     the same range from the ledger.
 *  5. A lost race (a concurrent worker recorded the same rows) is success: anchored
 *     rows insert with ON CONFLICT DO NOTHING on the partial unique index; a
 *     concurrent batch for the range is `superseded` and re-planned next pass.
 *  6. Many batches per tenant per pass (`maxBatchesPerTenant`), not one per pass.
 * The plan step's advisory try-lock only keeps two planners from reading at once; it is
 * released before submit, so two concurrent passes can both submit one root (two log
 * entries, two tokens). The database is the idempotency: one anchored row per record
 * and type (partial unique index) and one batch per range (0018 guard).
 * Nothing here logs: the caller prints the pass result (codes and counts only).
 */
import { sql, type SQL } from 'drizzle-orm';
import { TERMINAL_ANCHOR_CODES } from './anchor-contract';
import { anchorProofJson, type AnchorType, type DualAnchor, type DualAnchorOutcome } from './anchor-dual';
import { inclusionPath, merkleRoot, proofToJson } from './merkle';
import { parseSeq } from './ledger';
import type { WorkerDatabase, WorkerExecutor } from './worker';

export const DEFAULT_MAX_BATCH = 256;
export const MAX_BATCH_LIMIT = 4096; // the 0018 shape check bounds leaf_count
export const DEFAULT_PARTIAL_AFTER_MS = 600_000;
export const DEFAULT_MAX_BATCHES_PER_TENANT = 16;
export const ANCHOR_BACKOFF_BASE_MS = 30_000;
export const ANCHOR_BACKOFF_MAX_MS = 3_600_000;
export const ANCHOR_TYPES: readonly AnchorType[] = ['rekor', 'tsa'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
/** Unavailable codes: the service is down for everyone, so the pass stops (no hammering). */
const OUTAGE_CODES: ReadonlySet<string> = new Set(['ATTESTA_ANCHOR_LOG_UNAVAILABLE', 'ATTESTA_ANCHOR_TSA_UNAVAILABLE',
  'ATTESTA_SIGNER_UNAVAILABLE']);

// ---------------------------------------------------------------------------
// Store contract (the Postgres store is below; unit tests use an in-memory one)
// ---------------------------------------------------------------------------

/** One chain record as the planner sees it. */
export interface AnchorRecordRef {
  id: string;
  seq: number;
  /** `sha256:<hex>`; the leaf data is its 32 raw bytes. */
  recordHash: string;
  /** Millisecond ISO form. */
  recordedAt: string;
}

export interface TypeFailures {
  /** Failed rows for this batch and type. */
  count: number;
  /** created_at of the latest one (ms ISO), or null. */
  lastAt: string | null;
  /** The latest terminal code among them, or null. */
  terminalCode: string | null;
}

export interface StoredBatchState {
  batchId: string;
  seqFrom: number;
  seqTo: number;
  merkleRoot: string;
  leafCount: number;
  failures: Record<AnchorType, TypeFailures>;
  /** The batch's records, seq order. */
  records: AnchorRecordRef[];
}

export interface TenantPlanInput {
  /** seq_to of the tenant's last batch, or -1. */
  lastBatchedSeq: number;
  /** Written batches without an anchored row per record in both types: due ones first, stopped ones last. */
  incomplete: StoredBatchState[];
  /** Records after the last batch, seq order (bounded). */
  unbatched: AnchorRecordRef[];
}

export interface AnchorRowInput {
  recordId: string;
  anchorType: AnchorType;
  status: 'anchored' | 'failed';
  inclusionProof: unknown | null;
  rekorEntryUuid: string | null;
  tsaTokenB64: string | null;
  errorCode: string | null;
}

export interface BatchRowInput {
  batchId: string;
  seqFrom: number;
  seqTo: number;
  merkleRoot: string;
  leafCount: number;
}

export type RecordResult =
  | {
      status: 'recorded';
      anchoredInserted: number;
      /** Records that got at least one new anchored row from this write. */
      anchoredRecords: number;
      anchoredExisting: number;
      failedInserted: number;
    }
  /** Another worker recorded a different batch for this range first (ATA01): re-plan. */
  | { status: 'superseded' };

export interface AnchorStore {
  /** Tenants with anchoring work (unbatched records or a batch not anchored in both types). */
  tenants(opts: { tenantId?: string; limit?: number }): Promise<string[]>;
  /** One read transaction under a per-tenant try-lock; null when another planner holds it. */
  loadPlan(tenantId: string, limits: { unbatched: number; incomplete: number }): Promise<TenantPlanInput | null>;
  /** One write transaction: the batch row (if new, read back and compared) and the anchor rows. */
  record(tenantId: string, batch: BatchRowInput, rows: AnchorRowInput[]): Promise<RecordResult>;
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export interface AnchorPassOptions {
  maxBatch?: number;
  partialAfterMs?: number;
  /** Only this tenant. */
  tenantId?: string;
  /** At most this many tenants per pass. */
  limitTenants?: number;
  maxBatchesPerTenant?: number;
}

export interface AnchorWorkerDeps {
  anchor: DualAnchor;
  now?: () => Date;
}

export interface PlannedBatch {
  batch: BatchRowInput;
  records: AnchorRecordRef[];
  leaves: Buffer[];
  /** true when the batch row is already stored (re-planned with its stored range and root). */
  existing: boolean;
}

export interface TenantPlan {
  work: PlannedBatch[];
  /** Written batches skipped because a terminal code stopped them. */
  stopped: Array<{ batchId: string; code: string }>;
  /** Written batches whose backoff has not passed. */
  backoff: number;
  /** Unbatched records left waiting for a full batch or for partialAfterMs. */
  waiting: number;
}

/** Exponential backoff after `failures` failed attempts: 30 s doubling, at most 1 h. */
export function anchorBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const exp = Math.min(failures - 1, 30);
  return Math.min(ANCHOR_BACKOFF_MAX_MS, ANCHOR_BACKOFF_BASE_MS * 2 ** exp);
}

/** `"<tenant_id>:<seq_from>-<seq_to>"`, as the 0018 check requires. */
export function anchorBatchId(tenantId: string, seqFrom: number, seqTo: number): string {
  return `${tenantId}:${seqFrom}-${seqTo}`;
}

/** Leaf data: the 32 raw bytes of each record_hash. */
export function batchLeaves(records: AnchorRecordRef[]): Buffer[] {
  return records.map((r) => {
    if (!HASH_RE.test(r.recordHash)) throw new AnchorWorkerError(`record seq ${r.seq} has a malformed record_hash`);
    return Buffer.from(r.recordHash.slice(7), 'hex');
  });
}

/** A planning or recording invariant broke: the worker stops on this tenant (never a pass). */
export class AnchorWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorWorkerError';
  }
}

function assertContiguous(records: AnchorRecordRef[], from: number, to: number): void {
  if (records.length !== to - from + 1 || records.some((r, i) => r.seq !== from + i)) {
    throw new AnchorWorkerError(`records ${from}-${to} are not contiguous`);
  }
}

function formBatch(tenantId: string, records: AnchorRecordRef[], existing: StoredBatchState | null): PlannedBatch {
  const seqFrom = records[0].seq;
  const seqTo = records[records.length - 1].seq;
  assertContiguous(records, seqFrom, seqTo);
  const leaves = batchLeaves(records);
  const merkleRootHex = `sha256:${merkleRoot(leaves).toString('hex')}`;
  const batch = { batchId: anchorBatchId(tenantId, seqFrom, seqTo), seqFrom, seqTo, merkleRoot: merkleRootHex, leafCount: records.length };
  if (existing) {
    // Never re-cut: the stored range and root must come out again exactly.
    if (existing.batchId !== batch.batchId || existing.merkleRoot !== batch.merkleRoot || existing.leafCount !== batch.leafCount) {
      throw new AnchorWorkerError(`stored batch ${existing.batchId} does not re-form from the ledger`);
    }
  }
  return { batch, records, leaves, existing: existing !== null };
}

/**
 * Decide what to anchor for one tenant: due written batches first (stored range,
 * same root), then new contiguous batches of `maxBatch` records, and a last partial
 * batch only once its oldest record waited `partialAfterMs`.
 */
export function planTenant(
  tenantId: string, input: TenantPlanInput, now: Date, opts: Required<Pick<AnchorPassOptions, 'maxBatch' | 'partialAfterMs' | 'maxBatchesPerTenant'>>,
): TenantPlan {
  const plan: TenantPlan = { work: [], stopped: [], backoff: 0, waiting: 0 };
  const nowMs = now.getTime();
  for (const b of input.incomplete) {
    const terminal = ANCHOR_TYPES.map((t) => b.failures[t].terminalCode).find((c) => c !== null) ?? null;
    if (terminal !== null) {
      plan.stopped.push({ batchId: b.batchId, code: terminal });
      continue;
    }
    const due = ANCHOR_TYPES.every((t) => {
      const f = b.failures[t];
      return f.count === 0 || f.lastAt === null || Date.parse(f.lastAt) + anchorBackoffMs(f.count) <= nowMs;
    });
    if (!due) {
      plan.backoff += 1;
      continue;
    }
    if (plan.work.length >= opts.maxBatchesPerTenant) continue;
    if (b.records.length === 0 || b.records[0].seq !== b.seqFrom) {
      throw new AnchorWorkerError(`stored batch ${b.batchId} has lost records`);
    }
    plan.work.push(formBatch(tenantId, b.records, b));
  }
  const rest = input.unbatched;
  if (rest.length > 0 && rest[0].seq !== input.lastBatchedSeq + 1) {
    throw new AnchorWorkerError(`the first unbatched record is seq ${rest[0].seq}, expected ${input.lastBatchedSeq + 1}`);
  }
  let i = 0;
  while (i < rest.length && plan.work.length < opts.maxBatchesPerTenant) {
    const chunk = rest.slice(i, i + opts.maxBatch);
    const full = chunk.length === opts.maxBatch;
    if (!full && nowMs - Date.parse(chunk[0].recordedAt) < opts.partialAfterMs) break;
    plan.work.push(formBatch(tenantId, chunk, null));
    i += chunk.length;
  }
  plan.waiting = rest.length - i;
  return plan;
}

/** Rows to write for one submit outcome (worker step 3). `skipped` writes nothing. */
export function rowsForOutcome(planned: PlannedBatch, outcome: DualAnchorOutcome): AnchorRowInput[] {
  const rows: AnchorRowInput[] = [];
  const n = planned.records.length;
  if (outcome.complete) {
    if (outcome.rekor.status !== 'anchored' || outcome.tsa.status !== 'anchored') {
      throw new AnchorWorkerError('a complete outcome without both anchors');
    }
    const rekor = outcome.rekor.result;
    const tsa = outcome.tsa.result;
    const tokenB64 = tsa.tokenDer.toString('base64');
    planned.records.forEach((r, i) => {
      const merkle = proofToJson(i, n, inclusionPath(planned.leaves, i));
      rows.push({ recordId: r.id, anchorType: 'rekor', status: 'anchored', inclusionProof: anchorProofJson(merkle, rekor),
        rekorEntryUuid: rekor.entryId, tsaTokenB64: null, errorCode: null });
      rows.push({ recordId: r.id, anchorType: 'tsa', status: 'anchored', inclusionProof: anchorProofJson(merkle, tsa),
        rekorEntryUuid: null, tsaTokenB64: tokenB64, errorCode: null });
    });
    return rows;
  }
  // Not complete: nothing is anchored (dual is all or nothing). A type that verified
  // while the other failed writes nothing; its result is reused in-process on retry.
  for (const type of ANCHOR_TYPES) {
    const attempt = outcome[type];
    if (attempt.status !== 'failed') continue;
    for (const r of planned.records) {
      rows.push({ recordId: r.id, anchorType: type, status: 'failed', inclusionProof: null,
        rekorEntryUuid: null, tsaTokenB64: null, errorCode: attempt.code });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface AnchorPassResult {
  tenants: number;
  /** Tenants skipped because another planner held their lock. */
  busy: number;
  batchesAnchored: number;
  recordsAnchored: number;
  /** Batches that got failed rows this pass. */
  batchesFailed: number;
  /** Written batches stopped by a terminal code (not retried). */
  batchesStopped: number;
  /** Written batches waiting for their backoff. */
  batchesBackoff: number;
  /** Batches another worker recorded first (re-planned next pass). */
  superseded: number;
  /** Anchored rows another worker had already written (a lost race: success). */
  alreadyAnchored: number;
  /** Records waiting for a full batch or for the partial-batch delay. */
  recordsWaiting: number;
  /** Tenants whose pass ended on an unexpected error (no rows written for that batch). */
  tenantErrors: number;
  /** true when an outage code stopped the pass early. */
  stoppedOnOutage: boolean;
  /** Failure and stop codes with counts (per batch, not per row). No IDs, no content. */
  codes: Record<string, number>;
}

function resolveOptions(opts: AnchorPassOptions) {
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const partialAfterMs = opts.partialAfterMs ?? DEFAULT_PARTIAL_AFTER_MS;
  const maxBatchesPerTenant = opts.maxBatchesPerTenant ?? DEFAULT_MAX_BATCHES_PER_TENANT;
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > MAX_BATCH_LIMIT) throw new RangeError(`maxBatch must be 1-${MAX_BATCH_LIMIT}`);
  if (!Number.isSafeInteger(partialAfterMs) || partialAfterMs < 0) throw new RangeError('partialAfterMs must be ≥ 0');
  if (!Number.isSafeInteger(maxBatchesPerTenant) || maxBatchesPerTenant < 1 || maxBatchesPerTenant > 1000) {
    throw new RangeError('maxBatchesPerTenant must be 1-1000');
  }
  if (opts.tenantId !== undefined && !UUID_RE.test(opts.tenantId)) throw new RangeError('tenantId must be a lowercase UUID');
  if (opts.limitTenants !== undefined && (!Number.isSafeInteger(opts.limitTenants) || opts.limitTenants < 1)) {
    throw new RangeError('limitTenants must be ≥ 1');
  }
  return { maxBatch, partialAfterMs, maxBatchesPerTenant };
}

/**
 * One anchoring pass over every tenant with work (or `opts.tenantId`): plan →
 * submit → record per batch. Accepts the Drizzle database (the Postgres store) or
 * any `AnchorStore`.
 */
export async function runAnchorPass(
  db: WorkerDatabase | AnchorStore,
  deps: AnchorWorkerDeps,
  opts: AnchorPassOptions = {},
): Promise<AnchorPassResult> {
  const o = resolveOptions(opts);
  const store = isAnchorStore(db) ? db : pgAnchorStore(db);
  const now = deps.now ?? (() => new Date());
  const result: AnchorPassResult = {
    tenants: 0, busy: 0, batchesAnchored: 0, recordsAnchored: 0, batchesFailed: 0, batchesStopped: 0,
    batchesBackoff: 0, superseded: 0, alreadyAnchored: 0, recordsWaiting: 0, tenantErrors: 0,
    stoppedOnOutage: false, codes: {},
  };
  const count = (code: string) => { result.codes[code] = (result.codes[code] ?? 0) + 1; };
  const tenants = await store.tenants({ tenantId: opts.tenantId, limit: opts.limitTenants });
  for (const tenantId of tenants) {
    if (result.stoppedOnOutage) break;
    result.tenants += 1;
    try {
      const input = await store.loadPlan(tenantId, {
        unbatched: o.maxBatch * o.maxBatchesPerTenant, incomplete: o.maxBatchesPerTenant * 4,
      });
      if (input === null) { result.busy += 1; continue; }
      const plan = planTenant(tenantId, input, now(), o);
      result.batchesStopped += plan.stopped.length;
      for (const s of plan.stopped) count(s.code);
      result.batchesBackoff += plan.backoff;
      result.recordsWaiting += plan.waiting;
      for (const planned of plan.work) {
        // Submit: network only, no transaction open.
        const outcome = await deps.anchor.anchor(merkleRoot(planned.leaves), planned.batch.batchId);
        const rows = rowsForOutcome(planned, outcome);
        const recorded = await store.record(tenantId, planned.batch, rows);
        if (recorded.status === 'superseded') {
          result.superseded += 1;
          break; // this tenant's next range moved; the next pass re-plans it
        }
        result.alreadyAnchored += recorded.anchoredExisting;
        if (outcome.complete) {
          // Counted from what this pass inserted: a race lost in full anchors nothing new.
          if (recorded.anchoredInserted > 0) result.batchesAnchored += 1;
          result.recordsAnchored += recorded.anchoredRecords;
          continue;
        }
        result.batchesFailed += 1;
        const codes = ANCHOR_TYPES.map((t) => outcome[t]).flatMap((a) => (a.status === 'failed' ? [a.code] : []));
        for (const c of codes) count(c);
        if (codes.some((c) => OUTAGE_CODES.has(c))) result.stoppedOnOutage = true;
        break; // a failing batch blocks nothing, but hammering a failing service helps nobody
      }
    } catch (err) {
      // One tenant's broken invariant never stops the others; nothing was recorded for it.
      result.tenantErrors += 1;
      count(err instanceof AnchorWorkerError ? 'anchor_worker_invariant' : 'unexpected_error');
    }
  }
  return result;
}

function isAnchorStore(x: WorkerDatabase | AnchorStore): x is AnchorStore {
  return typeof (x as AnchorStore).loadPlan === 'function';
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const terminalList = sql`(${sql.join([...TERMINAL_ANCHOR_CODES].map((c) => sql`${c}`), sql`, `)})`;
const str = (v: unknown, label: string): string => {
  if (typeof v !== 'string') throw new AnchorWorkerError(`${label} missing`);
  return v;
};

function toRecordRef(r: Record<string, unknown>): AnchorRecordRef {
  return {
    id: str(r.id, 'record id'), seq: parseSeq(r.seq), recordHash: str(r.record_hash, 'record_hash'),
    recordedAt: str(r.recorded_at, 'recorded_at'),
  };
}

const anchoredCount = (type: AnchorType) => sql`(select count(*) from attesta_anchors a where a.tenant_id = b.tenant_id
  and a.batch_id = b.batch_id and a.anchor_type = ${type} and a.status = 'anchored')`;
/** Batch `b` lacks an anchored row for some record in some type. */
const incompleteBatch = sql`(${anchoredCount('rekor')} < b.leaf_count or ${anchoredCount('tsa')} < b.leaf_count)`;
/** Batch `b` has a terminal failure (stopped for good). */
const stoppedBatch = sql`exists (select 1 from attesta_anchors f where f.tenant_id = b.tenant_id and f.batch_id = b.batch_id
  and f.status = 'failed' and f.error_code in ${terminalList})`;

const recordColumns = sql.raw(`r.id::text as id, r.seq::text as seq, r.record_hash,
  to_char(r.recorded_at at time zone 'UTC', ${TS_MS}) as recorded_at`);

/** True when the error (or its cause) carries this SQLSTATE. */
function hasSqlState(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The anchoring store over the Drizzle database. Every query is bound to one tenant. */
export function pgAnchorStore(db: WorkerDatabase): AnchorStore {
  return {
    async tenants({ tenantId, limit }) {
      const only = tenantId ? sql`and h.tenant_id = ${tenantId}` : sql``;
      const lim = limit ? sql`limit ${limit}` : sql``;
      // Work = records after the last batch, or a written batch short of an anchored row per
      // record in some type that no terminal code stopped (a stopped batch alone is no work).
      const r = await db.execute(sql`/* anchor:tenants */
        select h.tenant_id::text as tenant_id from chain_head h
        where h.next_seq > 0 ${only} and (
          h.next_seq > coalesce((select max(b.seq_to) + 1 from attesta_anchor_batches b where b.tenant_id = h.tenant_id), 0)
          or exists (
            select 1 from attesta_anchor_batches b where b.tenant_id = h.tenant_id and ${incompleteBatch} and not ${stoppedBatch}))
        order by h.tenant_id ${lim}`);
      return r.rows.map((x) => str(x.tenant_id, 'tenant_id'));
    },

    async loadPlan(tenantId, limits) {
      return db.transaction(async (tx) => {
        const locked = await tx.execute(sql`/* anchor:plan_lock */
          select pg_try_advisory_xact_lock(hashtextextended(${'attesta_anchor_plan:' + tenantId}, 0)) as ok`);
        if (locked.rows[0]?.ok !== true) return null;
        const last = await tx.execute(sql`/* anchor:last_batch */
          select coalesce(max(seq_to), -1)::text as seq_to from attesta_anchor_batches where tenant_id = ${tenantId}`);
        const lastBatchedSeq = Number(str(last.rows[0]?.seq_to, 'last seq_to'));
        // Stopped batches sort last, so they never crowd due retries out of the limit.
        const batches = await tx.execute(sql`/* anchor:incomplete */
          select b.batch_id, b.seq_from::text as seq_from, b.seq_to::text as seq_to, b.merkle_root, b.leaf_count
          from attesta_anchor_batches b
          where b.tenant_id = ${tenantId} and ${incompleteBatch}
          order by ${stoppedBatch}, b.seq_from limit ${limits.incomplete}`);
        const incomplete: StoredBatchState[] = [];
        for (const b of batches.rows) {
          const batchId = str(b.batch_id, 'batch_id');
          const seqFrom = parseSeq(b.seq_from);
          const seqTo = parseSeq(b.seq_to);
          const failures = await tx.execute(sql`/* anchor:failures */
            select a.anchor_type, count(*)::int as n,
              ${sql.raw(`to_char(max(a.created_at) at time zone 'UTC', ${TS_MS})`)} as last_at,
              (array_agg(a.error_code order by a.created_at desc) filter (where a.error_code in ${terminalList}))[1] as terminal_code
            from attesta_anchors a
            where a.tenant_id = ${tenantId} and a.batch_id = ${batchId} and a.status = 'failed'
            group by a.anchor_type`);
          const f: Record<AnchorType, TypeFailures> = {
            rekor: { count: 0, lastAt: null, terminalCode: null }, tsa: { count: 0, lastAt: null, terminalCode: null },
          };
          for (const row of failures.rows) {
            const type = row.anchor_type === 'rekor' || row.anchor_type === 'tsa' ? row.anchor_type : null;
            if (type === null) continue;
            // Failed rows are one per record: an attempt is one batch-wide set of rows.
            f[type] = {
              count: 0, lastAt: typeof row.last_at === 'string' ? row.last_at : null,
              terminalCode: typeof row.terminal_code === 'string' ? row.terminal_code : null,
            };
            f[type].count = Math.ceil(Number(row.n) / Math.max(1, Number(b.leaf_count)));
          }
          const records = await tx.execute(sql`/* anchor:batch_records */
            select ${recordColumns} from attesta_records r
            where r.tenant_id = ${tenantId} and r.seq between ${seqFrom} and ${seqTo} order by r.seq`);
          incomplete.push({
            batchId, seqFrom, seqTo, merkleRoot: str(b.merkle_root, 'merkle_root'), leafCount: Number(b.leaf_count),
            failures: f, records: records.rows.map(toRecordRef),
          });
        }
        const unbatched = await tx.execute(sql`/* anchor:unbatched */
          select ${recordColumns} from attesta_records r
          where r.tenant_id = ${tenantId} and r.seq > ${lastBatchedSeq} order by r.seq limit ${limits.unbatched}`);
        return { lastBatchedSeq, incomplete, unbatched: unbatched.rows.map(toRecordRef) };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async record(tenantId, batch, rows) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`/* anchor:batch_insert */
            insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count)
            values (${tenantId}, ${batch.batchId}, ${batch.seqFrom}, ${batch.seqTo}, ${batch.merkleRoot}, ${batch.leafCount})
            on conflict (batch_id) do nothing`);
          const back = await tx.execute(sql`/* anchor:batch_read_back */
            select tenant_id::text as tenant_id, seq_from::text as seq_from, seq_to::text as seq_to, merkle_root, leaf_count
            from attesta_anchor_batches where batch_id = ${batch.batchId}`);
          const b = back.rows[0];
          if (!b || b.tenant_id !== tenantId || parseSeq(b.seq_from) !== batch.seqFrom || parseSeq(b.seq_to) !== batch.seqTo ||
              b.merkle_root !== batch.merkleRoot || Number(b.leaf_count) !== batch.leafCount) {
            throw new AnchorWorkerError(`batch ${batch.batchId} is stored with another range or root`);
          }
          return insertAnchorRows(tx, tenantId, batch.batchId, rows);
        });
      } catch (err) {
        if (hasSqlState(err, 'ATA01')) return { status: 'superseded' };
        throw err;
      }
    },
  };
}

const INSERT_CHUNK = 128;

async function insertAnchorRows(
  tx: WorkerExecutor, tenantId: string, batchId: string, rows: AnchorRowInput[],
): Promise<RecordResult> {
  let anchoredInserted = 0;
  let failedInserted = 0;
  const anchoredIds = new Set<string>();
  const anchoredTotal = rows.filter((r) => r.status === 'anchored').length;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values: SQL[] = chunk.map((r) => sql`(${tenantId}, ${batchId}, ${r.recordId}::uuid, ${r.anchorType}, ${r.status},
      ${r.inclusionProof === null ? null : JSON.stringify(r.inclusionProof)}::jsonb, ${r.rekorEntryUuid}, ${r.tsaTokenB64},
      ${r.errorCode})`);
    // A concurrent worker that already anchored a record and type won: not an error.
    const inserted = await tx.execute(sql`/* anchor:rows_insert */
      insert into attesta_anchors (tenant_id, batch_id, record_id, anchor_type, status, inclusion_proof,
        rekor_entry_uuid, tsa_token_b64, error_code)
      values ${sql.join(values, sql`, `)}
      on conflict (tenant_id, record_id, anchor_type) where status = 'anchored' do nothing
      returning status, record_id::text as record_id`);
    for (const row of inserted.rows) {
      if (row.status === 'anchored') {
        anchoredInserted += 1;
        anchoredIds.add(String(row.record_id));
      } else failedInserted += 1;
    }
  }
  return {
    status: 'recorded', anchoredInserted, anchoredRecords: anchoredIds.size,
    anchoredExisting: anchoredTotal - anchoredInserted, failedInserted,
  };
}
