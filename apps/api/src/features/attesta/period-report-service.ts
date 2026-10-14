/**
 * Attesta period reports (Task15i4, A15.9 part 3; docs/contracts/attesta/period-report.md).
 *
 *   parseReportRequest      request validation (400 on anything else)
 *   runPeriodReport         the job: claim (lease) → read one snapshot → build the document and
 *                           statement (period-report-rules.ts) → sign (no transaction) → chain,
 *                           store the document and mark ready in ONE ledger transaction
 *   pgReportStore           the tenant-bound PostgreSQL store
 *
 * The job, lease and idempotency pattern is the evidence packs' (evidence-pack-service.ts,
 * Task15i2/15i3). Ported from SushiCorp @ 0bd67a5 (catalog RP-1, services/reporting): figures
 * only from signed records, the database clock, regeneration byte-identical, a small signed
 * statement naming the report digest. Deviations: the statement is chained by chainStatement
 * like every statement (SushiCorp chained a decision); the document lives in the job row, not
 * in an export sink, so the document, its digest and the chained record commit together.
 *
 * Every query binds tenant_id. No network call inside a transaction (AGENTS.md §9 item 18):
 * the snapshot is read in a repeatable-read transaction, signing happens after it, and the
 * ledger transaction only writes.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { securityAuditEvents } from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { canonicalize, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import { AttestaLedgerError, chainStatement, mapLedgerDatabaseError, parseSeq, type LedgerExecutor } from './ledger';
import {
  AI_PROVENANCE_TYPE, MAX_REPORT_STATEMENTS, PERIOD_REPORT_PREDICATE_TYPE, PeriodReportError, REPORT_SETTLE_MS,
  buildReportStatement, computeReportDocument, reportSubjectName, type ChainRange, type ReportInput, type ReportScope,
} from './period-report-rules';
import { AttestaQueryError, parseRfc3339 } from './read-service';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';
import { resolveBuilderVersion } from './attesta-build-cli';

export const REPORT_LEASE_MS = 600_000;
/** Unfinished report jobs per tenant before POST answers 429. */
export const MAX_OPEN_REPORTS = 4;
/** Rebuilds after the chain moved under a build (another report for the scope, a head race). */
export const MAX_CHAIN_ATTEMPTS = 3;
export const REPORT_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,64}$/;

export type ReportStatus = 'queued' | 'running' | 'ready' | 'failed';
export type ReportErrorCode =
  | 'ATTESTA_API_INVALID_QUERY' | 'ATTESTA_API_INTERNAL' | 'ATTESTA_API_UNAVAILABLE'
  | 'ATTESTA_SIGNER_UNAVAILABLE' | 'ATTESTA_SIGNER_REJECTED' | 'ATTESTA_SIGNER_NO_CREDENTIAL'
  | 'ATTESTA_BUILDER_NOT_CANONICAL' | 'ATTESTA_BUILDER_SCHEMA_INVALID' | 'ATTESTA_BUILDER_RULE_VIOLATION'
  | 'ATTESTA_LEDGER_HEAD_CONFLICT' | 'ATTESTA_LEDGER_PREVIOUS_STALE' | 'ATTESTA_LEDGER_GUARD_VIOLATION';

/** Codes after which the same request (with a new Idempotency-Key) may succeed unchanged. */
export const RETRYABLE_REPORT_CODES: ReadonlySet<string> = new Set([
  'ATTESTA_SIGNER_UNAVAILABLE', 'ATTESTA_API_UNAVAILABLE', 'ATTESTA_API_INTERNAL',
  'ATTESTA_LEDGER_HEAD_CONFLICT', 'ATTESTA_LEDGER_PREVIOUS_STALE',
]);

export class ReportJobError extends Error {
  constructor(readonly code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'ReportJobError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const internal = (why: string) => new ReportJobError('ATTESTA_API_INTERNAL', `period report: ${why}`);

// ---------------------------------------------------------------------------
// Request parsing

export interface ReportRequest { scope: ReportScope }

export function parseReportIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !REPORT_IDEMPOTENCY_KEY_RE.test(raw)) {
    throw new AttestaQueryError('Idempotency-Key must match ^[A-Za-z0-9._-]{8,64}$');
  }
  return raw;
}

/**
 * `{repository_id, from, to}`: nothing else. `from`/`to` are RFC 3339 instants normalized to
 * UTC milliseconds (a sub-millisecond bound rounds inward), `from <= to`, and `to` at least
 * five minutes before `now` (period-report.md, the evidence-pack settle rule).
 */
export function parseReportRequest(body: unknown, now: Date): ReportRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AttestaQueryError('body must be an object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['repository_id', 'from', 'to'].includes(k)) throw new AttestaQueryError('unknown field');
  if (typeof b.repository_id !== 'string' || !UUID_RE.test(b.repository_id)) throw new AttestaQueryError('repository_id must be a lowercase UUID');
  if (typeof b.from !== 'string' || typeof b.to !== 'string') throw new AttestaQueryError('from and to are required');
  const fromMs = parseRfc3339(b.from, 'from');
  const toMs = parseRfc3339(b.to, 'to');
  if (fromMs > toMs) throw new AttestaQueryError('from is after to');
  if (toMs > now.getTime() - REPORT_SETTLE_MS) throw new AttestaQueryError('to must be at least 5 minutes in the past');
  const subMs = (v: string) => /[1-9]/.test(/T[^.]*\.(\d+)/.exec(v)?.[1]?.slice(3) ?? '');
  const from = new Date(fromMs + (subMs(b.from) ? 1 : 0)).toISOString();
  const to = new Date(toMs).toISOString();
  if (from > to) throw new AttestaQueryError('from is after to');
  return { scope: { repository_id: b.repository_id, from, to, basis: 'recorded_at' } };
}

/** The job row's scope (what idempotency compares): `{repository_id, from, to}`. */
export function storedScopeOf(scope: ReportScope): { repository_id: string; from: string; to: string } {
  return { repository_id: scope.repository_id, from: scope.from, to: scope.to };
}

export function sameReportRequest(a: ReportRequest, storedScope: unknown): boolean {
  try {
    return canonicalize(storedScopeOf(a.scope)) === canonicalize(storedScope);
  } catch {
    return false;
  }
}

/** The stored scope, re-validated (a row is data, never trusted shape). */
export function parseStoredReportScope(raw: unknown): ReportScope {
  const s = raw as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || Object.keys(s).sort().join(',') !== 'from,repository_id,to'
    || typeof s.from !== 'string' || !ISO_MS_RE.test(s.from) || typeof s.to !== 'string' || !ISO_MS_RE.test(s.to)
    || typeof s.repository_id !== 'string' || !UUID_RE.test(s.repository_id)) {
    throw internal('the stored scope is malformed');
  }
  return { repository_id: s.repository_id, from: s.from, to: s.to, basis: 'recorded_at' };
}

// ---------------------------------------------------------------------------
// Jobs

export interface ReportJob {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  repositoryId: string;
  scope: unknown;
  status: ReportStatus;
  requestedBy: string;
  requestId: string;
  attempts: number;
  reportDigest: string | null;
  statementDigest: string | null;
  recordId: string | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** One repeatable-read snapshot (period-report.md "Inputs"). */
export interface ReportSnapshot {
  /** Database clock at the start of the read (ms ISO). */
  asOf: string;
  chainRange: ChainRange;
  inputs: ReportInput[];
  /** Digests of earlier reports for the same subject name, oldest first. */
  previous: string[];
}

export interface ChainReportInput {
  statementCanonical: string;
  envelope: DsseEnvelope;
  credentialId: string;
  keyid: string;
  signatureDer: Buffer;
  publicKeySpkiDer: Buffer;
  previousSeen: string[];
  documentText: string;
  documentDigest: string;
}

export interface ReportAuditInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  action: 'attesta.report.request' | 'attesta.report.download';
  reportId: string;
  details: Record<string, unknown>;
}

export interface ReportStore {
  createOrGet(input: { tenantId: string; idempotencyKey: string; request: ReportRequest; requestedBy: string; requestId: string }):
    Promise<{ job: ReportJob; created: boolean }>;
  get(tenantId: string, id: string): Promise<ReportJob | null>;
  findByKey(tenantId: string, idempotencyKey: string): Promise<ReportJob | null>;
  /** The stored document of a ready job (exact bytes), or null. */
  document(tenantId: string, id: string): Promise<string | null>;
  openCount(tenantId: string): Promise<number>;
  repositoryExists(tenantId: string, repositoryId: string): Promise<boolean>;
  /** Input statements a scope would read now (request-time bound). */
  inputCount(tenantId: string, scope: ReportScope): Promise<number>;
  claim(tenantId: string, id: string, leaseMs: number): Promise<number | null>;
  readSnapshot(tenantId: string, scope: ReportScope): Promise<ReportSnapshot>;
  /**
   * One ledger transaction: the job still ours (running, these attempts) → chainStatement →
   * the job ready with document, digest, record and statement digest. false when the lease
   * was lost (nothing written). Ledger refusals throw AttestaLedgerError.
   */
  chainReady(tenantId: string, id: string, attempts: number, input: ChainReportInput): Promise<{ recordId: string; seq: number } | null>;
  finishFailed(tenantId: string, id: string, attempts: number | null, code: ReportErrorCode): Promise<boolean>;
  runnable(limit: number): Promise<Array<{ tenantId: string; id: string }>>;
  audit(input: ReportAuditInput): Promise<void>;
}

export interface ReportJobDeps {
  store: ReportStore;
  resolver: () => Promise<SignerResolver>;
  builderVersion: () => string;
  log?: (line: string) => void;
  leaseMs?: number;
}

export type ReportRunResult = 'ready' | 'failed' | 'not_claimed' | 'lease_lost';

function codeOf(err: unknown): ReportErrorCode {
  if (err instanceof ReportJobError) return err.code;
  if (err instanceof PeriodReportError) return err.code;
  if (err instanceof AttestaLedgerError) {
    // DUPLICATE and CLAIM_LOST cannot happen for a report (fresh as_of; no outbox claim).
    return err.code === 'ATTESTA_LEDGER_HEAD_CONFLICT' || err.code === 'ATTESTA_LEDGER_PREVIOUS_STALE'
      ? err.code : 'ATTESTA_LEDGER_GUARD_VIOLATION';
  }
  if (err instanceof SigningRejected) return 'ATTESTA_SIGNER_REJECTED';
  if (err instanceof SigningUnavailable) return 'ATTESTA_SIGNER_UNAVAILABLE';
  return 'ATTESTA_API_INTERNAL';
}

/**
 * Run one job: claim it (a 10-minute lease; an expired lease is retaken), then up to
 * MAX_CHAIN_ATTEMPTS times: read the snapshot, build and validate the document and the
 * statement, sign them (outside any transaction), and chain them with the document in one
 * ledger transaction. A head race or a report for the same scope chained meanwhile
 * (ATTESTA_LEDGER_PREVIOUS_STALE) rebuilds from a fresh snapshot; anything else fails the
 * job with one code. A report is never ready without its chained record.
 */
export async function runPeriodReport(deps: ReportJobDeps, tenantId: string, reportId: string): Promise<ReportRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const attempts = await deps.store.claim(tenantId, reportId, deps.leaseMs ?? REPORT_LEASE_MS);
  if (attempts === null) return 'not_claimed';
  try {
    const job = await deps.store.get(tenantId, reportId);
    if (!job || job.status !== 'running') throw internal('the claimed job is not running');
    const scope = parseStoredReportScope(job.scope);
    let resolver: SignerResolver;
    try {
      resolver = await deps.resolver();
    } catch {
      throw new ReportJobError('ATTESTA_SIGNER_UNAVAILABLE', 'the signer cannot be configured');
    }
    const builderVersion = deps.builderVersion();
    for (let round = 1; ; round += 1) {
      const snap = await deps.store.readSnapshot(tenantId, scope);
      const document = computeReportDocument({ tenantId, scope, inputs: snap.inputs });
      const built = buildReportStatement({ document, chainRange: snap.chainRange, asOf: snap.asOf, builderVersion, previous: snap.previous });
      const signer = await resolver.resolve(tenantId);
      if (!signer) throw new ReportJobError('ATTESTA_SIGNER_NO_CREDENTIAL', 'the tenant has no active statement key');
      const payload = Buffer.from(built.statementCanonical, 'utf8');
      if (pae(IN_TOTO_PAYLOAD_TYPE, payload).length > signer.adapter.capabilities().maxPayloadBytes) {
        throw new ReportJobError('ATTESTA_BUILDER_RULE_VIOLATION', 'the report statement does not fit the signer');
      }
      const signed = await signVerified(signer.adapter, pae(IN_TOTO_PAYLOAD_TYPE, payload), {
        credentialId: signer.credentialId, tenantId, requestId: `attesta-report:${reportId}:${attempts}:${round}`,
      });
      const keyid = sha256Prefixed(signed.publicKeySpkiDer);
      try {
        const chained = await deps.store.chainReady(tenantId, reportId, attempts, {
          statementCanonical: built.statementCanonical,
          envelope: { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid, sig: signed.signature.toString('base64') }] },
          credentialId: signer.credentialId, keyid, signatureDer: signed.signature, publicKeySpkiDer: signed.publicKeySpkiDer,
          previousSeen: snap.previous, documentText: built.documentText, documentDigest: built.documentDigest,
        });
        return chained === null ? 'lease_lost' : 'ready';
      } catch (err) {
        if (err instanceof AttestaLedgerError && err.retryable && round < MAX_CHAIN_ATTEMPTS) continue;
        throw err;
      }
    }
  } catch (err) {
    const code = codeOf(err);
    log(`attesta-report ${code} report_id=${reportId} cause=${err instanceof Error ? err.name : 'unknown'}`);
    const ok = await deps.store.finishFailed(tenantId, reportId, attempts, code).catch(() => false);
    return ok ? 'failed' : 'lease_lost';
  }
}

/** The status body of GET /period-reports/{id}. */
export function reportStatusBody(job: ReportJob, basePath = '/api/attesta/period-reports') {
  return {
    id: job.id,
    status: job.status,
    scope: job.scope,
    report_digest: job.reportDigest,
    statement_digest: job.statementDigest,
    error_code: job.errorCode,
    retryable: job.errorCode === null ? null : RETRYABLE_REPORT_CODES.has(job.errorCode),
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    document_path: job.status === 'ready' ? `${basePath}/${job.id}/document` : null,
  };
}

/** The stored document, checked against the job's digest; a mismatch is a 500, never a download. */
export function documentBody(job: ReportJob, stored: string | null): string {
  if (job.status !== 'ready' || !job.reportDigest || stored === null) throw internal('the job is not ready');
  if (sha256Prefixed(stored) !== job.reportDigest) throw internal('the stored document does not match its digest');
  return stored;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

export interface ReportDbExecutor { execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }> }
export interface ReportDatabase extends ReportDbExecutor {
  transaction<T>(fn: (tx: ReportDbExecutor) => Promise<T>,
    config?: { isolationLevel?: 'repeatable read'; accessMode?: 'read only' }): Promise<T>;
}

const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const JOB_COLUMNS = sql.raw(`id::text as id, tenant_id::text as tenant_id, idempotency_key, repository_id::text as repository_id,
  scope, status, requested_by, request_id, attempts, report_digest, statement_digest, record_id::text as record_id, error_code,
  to_char(created_at at time zone 'UTC', ${TS_MS}) as created_at, to_char(finished_at at time zone 'UTC', ${TS_MS}) as finished_at`);

function toJob(r: Record<string, unknown>): ReportJob {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), idempotencyKey: str(r.idempotency_key), repositoryId: str(r.repository_id),
    scope: r.scope, status: str(r.status) as ReportStatus, requestedBy: str(r.requested_by), requestId: str(r.request_id),
    attempts: Number(r.attempts), reportDigest: strOrNull(r.report_digest), statementDigest: strOrNull(r.statement_digest),
    recordId: strOrNull(r.record_id), errorCode: strOrNull(r.error_code), createdAt: str(r.created_at), finishedAt: strOrNull(r.finished_at),
  };
}

/** The evidence-pack boundary rule: the window's records plus one record each side. */
async function boundaries(tx: ReportDbExecutor, tenantId: string, scope: ReportScope) {
  const r = (await tx.execute(sql`/* report:bounds */
    select (select max(seq)::text from attesta_records where tenant_id = ${tenantId} and recorded_at < ${scope.from}::timestamptz) as before,
           (select min(seq)::text from attesta_records where tenant_id = ${tenantId} and recorded_at > ${scope.to}::timestamptz) as after,
           (select next_seq::text from chain_head where tenant_id = ${tenantId}) as next_seq`)).rows[0] ?? {};
  const nextSeq = typeof r.next_seq === 'string' ? parseSeq(r.next_seq, 'next_seq') : 0;
  const fromSeq = typeof r.before === 'string' ? parseSeq(r.before) : 0;
  const toSeq = typeof r.after === 'string' ? parseSeq(r.after) : nextSeq - 1;
  return { fromSeq, toSeq };
}

const inWindow = (tenantId: string, scope: ReportScope) => sql`tenant_id = ${tenantId}
  and repository_id = ${scope.repository_id}::uuid and predicate_type = ${AI_PROVENANCE_TYPE}
  and recorded_at >= ${scope.from}::timestamptz and recorded_at <= ${scope.to}::timestamptz`;

/**
 * `clock` is the ledger's recorded_at clock seam (chainStatement's), for live tests that
 * need a settled report record without waiting; production uses the default.
 */
export function pgReportStore(db: ReportDatabase, options: { clock?: () => Date } = {}): ReportStore {
  return {
    async createOrGet({ tenantId, idempotencyKey, request, requestedBy, requestId }) {
      const inserted = await db.execute(sql`/* report:create */
        insert into attesta_period_reports (tenant_id, idempotency_key, repository_id, scope, requested_by, request_id)
        values (${tenantId}, ${idempotencyKey}, ${request.scope.repository_id}::uuid, ${JSON.stringify(storedScopeOf(request.scope))}::jsonb,
          ${requestedBy}, ${requestId})
        on conflict (tenant_id, idempotency_key) do nothing
        returning ${JOB_COLUMNS}`);
      if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
      const existing = await db.execute(sql`/* report:by_key */
        select ${JOB_COLUMNS} from attesta_period_reports where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`);
      if (!existing.rows[0]) throw internal('the idempotent job vanished');
      return { job: toJob(existing.rows[0]), created: false };
    },

    async get(tenantId, id) {
      const r = await db.execute(sql`/* report:get */
        select ${JOB_COLUMNS} from attesta_period_reports where tenant_id = ${tenantId} and id = ${id}::uuid`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async findByKey(tenantId, idempotencyKey) {
      const r = await db.execute(sql`/* report:by_key */
        select ${JOB_COLUMNS} from attesta_period_reports where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async document(tenantId, id) {
      const r = await db.execute(sql`/* report:document */
        select report_document from attesta_period_reports where tenant_id = ${tenantId} and id = ${id}::uuid and status = 'ready'`);
      return strOrNull(r.rows[0]?.report_document);
    },

    async openCount(tenantId) {
      const r = await db.execute(sql`/* report:open */
        select count(*)::int as n from attesta_period_reports where tenant_id = ${tenantId}
          and ((status = 'queued' and created_at > now() - (${REPORT_LEASE_MS}::int * interval '1 millisecond'))
            or (status = 'running' and lease_until > now()))`);
      return Number(r.rows[0]?.n ?? 0);
    },

    async repositoryExists(tenantId, repositoryId) {
      const r = await db.execute(sql`/* report:repository */
        select 1 as ok from scm_repositories where tenant_id = ${tenantId} and id = ${repositoryId}::uuid`);
      return r.rows.length > 0;
    },

    async inputCount(tenantId, scope) {
      const r = await db.execute(sql`/* report:count */ select count(*)::int as n from attesta_records where ${inWindow(tenantId, scope)}`);
      return Number(r.rows[0]?.n ?? 0);
    },

    async claim(tenantId, id, leaseMs) {
      const r = await db.execute(sql`/* report:claim */
        update attesta_period_reports
        set status = 'running', attempts = attempts + 1, lease_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
        where tenant_id = ${tenantId} and id = ${id}::uuid
          and (status = 'queued' or (status = 'running' and lease_until < now()))
        returning attempts`);
      return r.rows[0] ? Number(r.rows[0].attempts) : null;
    },

    async readSnapshot(tenantId, scope) {
      return db.transaction(async (tx) => {
        const clock = await tx.execute(sql`/* report:clock */ select ${sql.raw(`to_char(now() at time zone 'UTC', ${TS_MS})`)} as as_of`);
        const asOf = str(clock.rows[0]?.as_of);
        if (!ISO_MS_RE.test(asOf)) throw internal('the database clock is malformed');
        // Settled at the database clock too (the request checked the API clock).
        if (Date.parse(scope.to) > Date.parse(asOf) - REPORT_SETTLE_MS) throw new ReportJobError('ATTESTA_API_INVALID_QUERY', 'to is not settled at as_of');
        const b = await boundaries(tx, tenantId, scope);
        const empty = b.toSeq < b.fromSeq;
        let toRecordHash: string | null = null;
        if (!empty) {
          const h = await tx.execute(sql`/* report:to_hash */
            select record_hash from attesta_records where tenant_id = ${tenantId} and seq = ${b.toSeq}`);
          toRecordHash = strOrNull(h.rows[0]?.record_hash);
          if (toRecordHash === null) throw internal('the boundary record is missing');
        }
        const rows = (await tx.execute(sql`/* report:inputs */
          select seq::text as seq, statement_digest, statement_canonical from attesta_records
          where ${inWindow(tenantId, scope)} order by seq limit ${MAX_REPORT_STATEMENTS + 1}`)).rows;
        if (rows.length > MAX_REPORT_STATEMENTS) throw new ReportJobError('ATTESTA_API_INVALID_QUERY', 'too many statements for one report');
        const previous = (await tx.execute(sql`/* report:previous */
          select statement_digest from attesta_records
          where tenant_id = ${tenantId} and repository_id = ${scope.repository_id}::uuid and predicate_type = ${PERIOD_REPORT_PREDICATE_TYPE}
            and (statement_canonical::jsonb)->'subject'->0->>'name' = ${reportSubjectName(scope)}
          order by seq`)).rows.map((r) => str(r.statement_digest));
        return {
          asOf,
          chainRange: empty ? { from_seq: 0, to_seq: -1, to_record_hash: null } : { from_seq: b.fromSeq, to_seq: b.toSeq, to_record_hash: toRecordHash },
          inputs: rows.map((r) => ({ seq: parseSeq(r.seq), digest: str(r.statement_digest), canonical: str(r.statement_canonical) })),
          previous,
        };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async chainReady(tenantId, id, attempts, input) {
      try {
        return await db.transaction(async (tx) => {
          const mine = await tx.execute(sql`/* report:lock */
            select 1 as ok from attesta_period_reports
            where tenant_id = ${tenantId} and id = ${id}::uuid and status = 'running' and attempts = ${attempts} for update`);
          if (mine.rows.length !== 1) return null;
          const chained = await chainStatement(tx as LedgerExecutor, {
            tenantId, statementCanonical: input.statementCanonical, envelope: input.envelope, credentialId: input.credentialId,
            keyid: input.keyid, signatureDer: input.signatureDer, publicKeySpkiDer: input.publicKeySpkiDer, previousSeen: input.previousSeen,
          }, options.clock);
          if (chained.duplicate) throw internal('a fresh report statement was already chained');
          const done = await tx.execute(sql`/* report:ready */
            update attesta_period_reports
            set status = 'ready', lease_until = null, report_document = ${input.documentText}, report_digest = ${input.documentDigest},
                record_id = ${chained.recordId}::uuid, statement_digest = ${chained.statementDigest}, updated_at = now(), finished_at = now()
            where tenant_id = ${tenantId} and id = ${id}::uuid and status = 'running' and attempts = ${attempts}
            returning id`);
          if (done.rows.length !== 1) throw internal('the locked job could not be finished');
          return { recordId: chained.recordId, seq: chained.seq };
        });
      } catch (err) {
        throw mapLedgerDatabaseError(err) ?? err;
      }
    },

    async finishFailed(tenantId, id, attempts, code) {
      const r = await db.execute(sql`/* report:failed */
        update attesta_period_reports
        set status = 'failed', lease_until = null, error_code = ${code}, updated_at = now(), finished_at = now()
        where tenant_id = ${tenantId} and id = ${id}::uuid
          and ${attempts === null ? sql`status = 'queued'` : sql`status = 'running' and attempts = ${attempts}`}
        returning id`);
      return r.rows.length === 1;
    },

    async runnable(limit) {
      // Across tenants on purpose (an operator recovery pass); each row then runs with its own tenant_id.
      const r = await db.execute(sql`/* report:runnable */
        select tenant_id::text as tenant_id, id::text as id from attesta_period_reports
        where status = 'queued' or (status = 'running' and lease_until < now())
        order by created_at limit ${limit}`);
      return r.rows.map((x) => ({ tenantId: str(x.tenant_id), id: str(x.id) }));
    },

    async audit(input) {
      await withTenant(coreDb, input.tenantId).insert(securityAuditEvents, {
        actorType: input.actorRole,
        actorId: input.actorId,
        action: input.action,
        targetType: 'attesta_period_report',
        targetId: input.reportId,
        details: input.details,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Production wiring

/**
 * Production dependencies: the pg store, the tenant's statement key through
 * `inventorySignerResolver(pgTrustStore(db), await adaptersFromEnv(), trustConfigFromEnv())`
 * (built once; a failed build is retried on the next job), and the builder version of the
 * statement builder (`<semver>+<git commit>`, TRACKAI_GIT_COMMIT in production).
 */
export function defaultReportJobDeps(env: NodeJS.ProcessEnv = process.env): ReportJobDeps {
  let resolver: Promise<SignerResolver> | null = null;
  return {
    store: pgReportStore(coreDb as unknown as ReportDatabase),
    resolver: () => {
      if (!resolver) {
        resolver = (async () => inventorySignerResolver(pgTrustStore(coreDb as unknown as TrustDb), await adaptersFromEnv(env), trustConfigFromEnv(env)))();
        resolver.catch(() => { resolver = null; });
      }
      return resolver;
    },
    builderVersion: () => {
      try {
        return resolveBuilderVersion(env);
      } catch {
        throw new ReportJobError('ATTESTA_API_UNAVAILABLE', 'the builder version is not configured');
      }
    },
  };
}

