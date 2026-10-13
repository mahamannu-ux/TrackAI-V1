/**
 * Attesta evidence API, read side (Task15i, A15.9 part 1; docs/contracts/attesta/api.md).
 *
 * Query parsing, the opaque cursor, `anchor_status`, the tenant-bound queries and the
 * audited verify. Route handlers (attesta.routes.ts) stay thin.
 *
 * Ported from SushiCorp AP-1 @ 0bd67a5 (catalog AP-1): keyset paging with one page per
 * request, `limit` 1..200, an opaque cursor that is validated (a bad cursor is a 400,
 * never a 500), strict filters (tests/unit/api/test_api_gaps.py). Deviations:
 *  1. Unknown query parameters are refused (ATTESTA_API_INVALID_QUERY), not ignored.
 *  2. Errors are 400 (errors.md §API), not SushiCorp's 422.
 *  3. The cursor is base64url JSON `{"r": recorded_at, "s": seq}` exactly as api.md
 *     names it; the page boundary is `seq` (gap-free and the chain order), `r` is
 *     checked for shape only.
 *
 * Every query binds `tenant_id` explicitly (as ledger.ts and verify-chain.ts do) and
 * none selects `attesta_envelopes.credential_id`. Times are read as text with
 * microseconds, never through a JS Date; `seq` is converted from the bigint string.
 */
import type { KeyObject } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../core/db';
import { securityAuditEvents } from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { isProduction } from './anchor-contract';
import { anchorFromEnv, platformAnchorKeysFromEnv, type AnchorVerifyMaterial } from './anchor-env';
import { deriveStatementColumns, parseSeq } from './ledger';
import { publishedKeysFor } from './trust-resolver';
import type { TrustStore } from './trust-inventory';
import {
  ANCHOR_TIME_SKEW_MS, DEFAULT_ANCHOR_WINDOW_MS, verifyChain,
  type ChainReadExecutor, type ChainReport, type VerifyChainOptions,
} from './verify-chain';

/** The anchoring window `anchor_status` uses: the anchoring worker's and verifyChain's default (Task15f2). */
export const ANCHOR_WINDOW_MS = DEFAULT_ANCHOR_WINDOW_MS;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MAX_SUBJECT_STATEMENTS = 200;
export const MAX_VERIFY_RANGE = 10_000;

export const STATEMENT_KINDS = ['commit_observed', 'pr_merged', 'deployed', 'period_report'] as const;
export type StatementKindFilter = typeof STATEMENT_KINDS[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Lowercase 40 hex (SHA-1); also 64 hex (SHA-256 repositories), as the attesta_records
 * check allows (deviation from the prompt's "40 hex": strictly the column's own domain).
 */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;
/** The cursor's `r`: recorded_at as this service prints it (UTC, microseconds). */
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SEQ_TEXT_RE = /^(?:0|[1-9]\d{0,14})$/;
const MAX_CURSOR_LENGTH = 256;

/** A request the API refuses with 400 ATTESTA_API_INVALID_QUERY. Never carries the value. */
export class AttestaQueryError extends Error {
  constructor(readonly reason: string) {
    super(`invalid query: ${reason}`);
    this.name = 'AttestaQueryError';
  }
}

// ---------------------------------------------------------------------------
// anchor_status: a database fact, not a verification

export type ListAnchorStatus = 'anchored' | 'pending' | 'missing';

/**
 * `anchored` when the record has an `anchored` row of both types (rekor and tsa);
 * otherwise `pending` while recorded_at is inside the anchoring window (and not
 * further ahead of the clock than the skew), else `missing`. The same rule as
 * verifyChain's AnchorChecker, but from the rows alone: nothing is verified here.
 * Proving the anchors is the verify route's job.
 */
export function anchorStatusOf(
  anchored: { rekor: boolean; tsa: boolean },
  recordedAt: string,
  now: Date,
  windowMs: number = ANCHOR_WINDOW_MS,
): ListAnchorStatus {
  if (anchored.rekor && anchored.tsa) return 'anchored';
  const age = now.getTime() - Date.parse(recordedAt);
  return !Number.isNaN(age) && age <= windowMs && age >= -ANCHOR_TIME_SKEW_MS ? 'pending' : 'missing';
}

// ---------------------------------------------------------------------------
// Query parsing

function single(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new AttestaQueryError(`${name} must be one non-empty value`);
  return value;
}

function onlyKnown(query: Record<string, unknown>, known: readonly string[]): void {
  for (const name of Object.keys(query)) {
    if (!known.includes(name)) throw new AttestaQueryError('unknown parameter');
  }
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** RFC 3339 date-time with a real calendar date; returns the instant in ms. */
export function parseRfc3339(value: string, name: string): number {
  const m = RFC3339_RE.exec(value);
  if (!m) throw new AttestaQueryError(`${name} must be an RFC 3339 date-time`);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const offsetOk = m[8] === 'Z' || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59 || !offsetOk || y < 1970) {
    throw new AttestaQueryError(`${name} must be an RFC 3339 date-time`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new AttestaQueryError(`${name} must be an RFC 3339 date-time`);
  return ms;
}

function parseSeqParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!SEQ_TEXT_RE.test(value)) throw new AttestaQueryError(`${name} must be a non-negative integer`);
  return Number(value);
}

export interface Cursor { r: string; s: number }

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ r: cursor.r, s: cursor.s }), 'utf8').toString('base64url');
}

/** Any cursor this service did not print is a 400, never a 500. */
export function decodeCursor(raw: string): Cursor {
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new AttestaQueryError('cursor is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AttestaQueryError('cursor is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new AttestaQueryError('cursor is invalid');
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== 'r' || keys[1] !== 's') throw new AttestaQueryError('cursor is invalid');
  if (typeof obj.r !== 'string' || !CURSOR_TIME_RE.test(obj.r) || Number.isNaN(Date.parse(obj.r))) {
    throw new AttestaQueryError('cursor is invalid');
  }
  if (typeof obj.s !== 'number' || !Number.isSafeInteger(obj.s) || obj.s < 0) throw new AttestaQueryError('cursor is invalid');
  // Re-encoding must give the same text: one cursor per position.
  if (encodeCursor({ r: obj.r, s: obj.s }) !== raw) throw new AttestaQueryError('cursor is invalid');
  return { r: obj.r, s: obj.s };
}

export interface ListFilter {
  repositoryId?: string;
  kind?: StatementKindFilter;
  subjectSha?: string;
  /** RFC 3339 text, inclusive. */
  from?: string;
  /** RFC 3339 text, inclusive. */
  to?: string;
}

export interface ListQuery { filter: ListFilter; limit: number; cursor: Cursor | null }

const LIST_PARAMS = ['repository_id', 'kind', 'subject_sha', 'from', 'to', 'limit', 'cursor'] as const;

export function parseListQuery(query: Record<string, unknown>): ListQuery {
  onlyKnown(query, LIST_PARAMS);
  const filter: ListFilter = {};
  const repositoryId = single(query, 'repository_id');
  if (repositoryId !== undefined) {
    if (!UUID_RE.test(repositoryId)) throw new AttestaQueryError('repository_id must be a lowercase UUID');
    filter.repositoryId = repositoryId;
  }
  const kind = single(query, 'kind');
  if (kind !== undefined) {
    if (!(STATEMENT_KINDS as readonly string[]).includes(kind)) throw new AttestaQueryError('kind is not a statement kind');
    filter.kind = kind as StatementKindFilter;
  }
  const subjectSha = single(query, 'subject_sha');
  if (subjectSha !== undefined) {
    if (!SHA_RE.test(subjectSha)) throw new AttestaQueryError('subject_sha must be lowercase hex');
    filter.subjectSha = subjectSha;
  }
  const from = single(query, 'from');
  const to = single(query, 'to');
  const fromMs = from === undefined ? undefined : parseRfc3339(from, 'from');
  const toMs = to === undefined ? undefined : parseRfc3339(to, 'to');
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw new AttestaQueryError('from is after to');
  if (from !== undefined) filter.from = from;
  if (to !== undefined) filter.to = to;
  const limitRaw = single(query, 'limit');
  let limit = DEFAULT_PAGE_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(limitRaw) || Number(limitRaw) > MAX_PAGE_LIMIT) {
      throw new AttestaQueryError(`limit must be 1..${MAX_PAGE_LIMIT}`);
    }
    limit = Number(limitRaw);
  }
  const cursorRaw = single(query, 'cursor');
  return { filter, limit, cursor: cursorRaw === undefined ? null : decodeCursor(cursorRaw) };
}

export function parseDigest(value: string): string {
  if (!DIGEST_RE.test(value)) throw new AttestaQueryError('statement digest must be sha256:<64 lowercase hex>');
  return value;
}

export function parseSubject(repositoryId: string, sha: string): { repositoryId: string; sha: string } {
  if (!UUID_RE.test(repositoryId)) throw new AttestaQueryError('repository_id must be a lowercase UUID');
  if (!SHA_RE.test(sha)) throw new AttestaQueryError('sha must be lowercase hex');
  return { repositoryId, sha };
}

export interface VerifyQuery { fromSeq?: number; toSeq?: number }

export function parseVerifyQuery(query: Record<string, unknown>): VerifyQuery {
  onlyKnown(query, ['from_seq', 'to_seq']);
  const fromSeq = parseSeqParam(single(query, 'from_seq'), 'from_seq');
  const toSeq = parseSeqParam(single(query, 'to_seq'), 'to_seq');
  if (fromSeq !== undefined && toSeq !== undefined) {
    if (fromSeq > toSeq) throw new AttestaQueryError('from_seq is after to_seq');
    if (toSeq - fromSeq + 1 > MAX_VERIFY_RANGE) throw new AttestaQueryError('range is too large');
  }
  return { fromSeq, toSeq };
}

// ---------------------------------------------------------------------------
// The store: rows as the database holds them

/** One record's typed columns, as every list-like route returns them. */
export interface StatementRow {
  statementDigest: string;
  seq: number;
  /** UTC, microseconds, `Z`. */
  recordedAt: string;
  statementKind: string | null;
  predicateType: string;
  repositoryId: string;
  subjectSha: string | null;
  rekorAnchored: boolean;
  tsaAnchored: boolean;
}

export interface SubjectRow extends StatementRow { statementCanonical: string }

export interface AnchorRowOut {
  anchor_type: string;
  status: string;
  inclusion_proof: unknown;
  rekor_entry_uuid: string | null;
  tsa_token_b64: string | null;
  error_code: string | null;
  created_at: string;
}

export interface StatementDetailRow {
  seq: number;
  prevHash: string;
  recordedAt: string;
  recordHash: string;
  canonicalRecord: string;
  statementCanonical: string;
  /** The stored envelope JSON (never the credential). */
  envelope: unknown | null;
  anchors: AnchorRowOut[];
}

export interface VerifyAuditInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  requestId: string;
  fromSeq: number;
  /** null when the range ran to the end of an empty chain, or the verify failed before it was known. */
  toSeq: number | null;
  ok: boolean;
  checked: number;
  breakCount: number;
  /** true when the verify did not complete (an error, e.g. broken anchor configuration). */
  failed?: boolean;
}

export interface AttestaReadStore {
  /** Up to `limit` rows after `after`, `seq` ascending, matching `filter`. */
  listStatements(tenantId: string, filter: ListFilter, after: Cursor | null, limit: number): Promise<StatementRow[]>;
  getStatement(tenantId: string, digest: string): Promise<StatementDetailRow | null>;
  /** Up to `limit` statements about (repository, sha), `seq` ascending. */
  subjectStatements(tenantId: string, repositoryId: string, sha: string, limit: number): Promise<SubjectRow[]>;
  /** The last seq the tenant's chain knows (head or a stored record), -1 when empty. */
  chainExtent(tenantId: string): Promise<number>;
  recordVerifyAudit(input: VerifyAuditInput): Promise<void>;
}

export interface ReadExecutor { execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }> }

const TIME_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const STATEMENT_COLUMNS = sql`
  r.statement_digest, r.seq::text as seq,
  to_char(r.recorded_at at time zone 'UTC', ${sql.raw(`'${TIME_US}'`)}) as recorded_at,
  r.statement_kind, r.predicate_type, r.repository_id::text as repository_id, r.subject_sha,
  exists (select 1 from attesta_anchors a where a.tenant_id = r.tenant_id and a.record_id = r.id
          and a.anchor_type = 'rekor' and a.status = 'anchored') as rekor_anchored,
  exists (select 1 from attesta_anchors t where t.tenant_id = r.tenant_id and t.record_id = r.id
          and t.anchor_type = 'tsa' and t.status = 'anchored') as tsa_anchored`;

function toStatementRow(r: Record<string, unknown>): StatementRow {
  return {
    statementDigest: str(r.statement_digest),
    seq: parseSeq(r.seq),
    recordedAt: str(r.recorded_at),
    statementKind: strOrNull(r.statement_kind),
    predicateType: str(r.predicate_type),
    repositoryId: str(r.repository_id),
    subjectSha: strOrNull(r.subject_sha),
    rekorAnchored: r.rekor_anchored === true,
    tsaAnchored: r.tsa_anchored === true,
  };
}

/** The PostgreSQL store. Every statement names the tenant; `executor` is a test seam. */
export function pgReadStore(executor: ReadExecutor = db): AttestaReadStore {
  return {
    async listStatements(tenantId, filter, after, limit) {
      const where: SQL[] = [sql`r.tenant_id = ${tenantId}`];
      if (filter.repositoryId) where.push(sql`r.repository_id = ${filter.repositoryId}`);
      // A period_report is a record with no statement_kind (tables.md).
      if (filter.kind === 'period_report') where.push(sql`r.statement_kind is null`);
      else if (filter.kind) where.push(sql`r.statement_kind = ${filter.kind}`);
      if (filter.subjectSha) where.push(sql`r.subject_sha = ${filter.subjectSha}`);
      if (filter.from) where.push(sql`r.recorded_at >= ${filter.from}::timestamptz`);
      if (filter.to) where.push(sql`r.recorded_at <= ${filter.to}::timestamptz`);
      if (after) where.push(sql`r.seq > ${after.s}`);
      const result = await executor.execute(sql`
        select ${STATEMENT_COLUMNS}
        from attesta_records r
        where ${sql.join(where, sql` and `)}
        order by r.seq
        limit ${limit}`);
      return result.rows.map(toStatementRow);
    },

    async getStatement(tenantId, digest) {
      const found = await executor.execute(sql`
        select r.id::text as id, r.seq::text as seq, r.prev_hash,
               to_char(r.recorded_at at time zone 'UTC', ${sql.raw(`'${TIME_US}'`)}) as recorded_at,
               r.record_hash, r.canonical_record, r.statement_canonical, e.envelope
        from attesta_records r
        left join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
        where r.tenant_id = ${tenantId} and r.statement_digest = ${digest}`);
      const row = found.rows[0];
      if (!row) return null;
      const anchors = await executor.execute(sql`
        select anchor_type, status, inclusion_proof, rekor_entry_uuid, tsa_token_b64, error_code,
               to_char(created_at at time zone 'UTC', ${sql.raw(`'${TIME_US}'`)}) as created_at
        from attesta_anchors
        where tenant_id = ${tenantId} and record_id = ${str(row.id)}::uuid
        order by created_at, id`);
      return {
        seq: parseSeq(row.seq),
        prevHash: str(row.prev_hash),
        recordedAt: str(row.recorded_at),
        recordHash: str(row.record_hash),
        canonicalRecord: str(row.canonical_record),
        statementCanonical: str(row.statement_canonical),
        envelope: row.envelope ?? null,
        anchors: anchors.rows.map((a) => ({
          anchor_type: str(a.anchor_type),
          status: str(a.status),
          inclusion_proof: a.inclusion_proof ?? null,
          rekor_entry_uuid: strOrNull(a.rekor_entry_uuid),
          tsa_token_b64: strOrNull(a.tsa_token_b64),
          error_code: strOrNull(a.error_code),
          created_at: str(a.created_at),
        })),
      };
    },

    async subjectStatements(tenantId, repositoryId, sha, limit) {
      const result = await executor.execute(sql`
        select ${STATEMENT_COLUMNS}, r.statement_canonical
        from attesta_records r
        where r.tenant_id = ${tenantId} and r.repository_id = ${repositoryId} and r.subject_sha = ${sha}
        order by r.seq
        limit ${limit}`);
      return result.rows.map((r) => ({ ...toStatementRow(r), statementCanonical: str(r.statement_canonical) }));
    },

    async chainExtent(tenantId) {
      const result = await executor.execute(sql`
        select (select next_seq::text from chain_head where tenant_id = ${tenantId}) as next_seq,
               (select max(seq)::text from attesta_records where tenant_id = ${tenantId}) as max_seq`);
      const row = result.rows[0] ?? {};
      const head = typeof row.next_seq === 'string' ? parseSeq(row.next_seq, 'chain_head.next_seq') - 1 : -1;
      const max = typeof row.max_seq === 'string' ? parseSeq(row.max_seq, 'max seq') : -1;
      return Math.max(head, max);
    },

    async recordVerifyAudit(input) {
      await withTenant(db, input.tenantId).insert(securityAuditEvents, {
        actorType: input.actorRole,
        actorId: input.actorId,
        action: 'attesta.verify',
        targetType: 'attesta_chain',
        targetId: `${input.fromSeq}-${input.toSeq ?? 'end'}`,
        details: {
          request_id: input.requestId, ok: input.ok, checked: input.checked, break_count: input.breakCount,
          ...(input.failed ? { failed: true } : {}),
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Responses

export interface StatementItem {
  statement_digest: string;
  seq: number;
  recorded_at: string;
  statement_kind: string | null;
  predicate_type: string;
  repository_id: string;
  subject_sha: string | null;
  /** A database fact (anchor rows exist), not a verification; see anchorStatusOf. */
  anchor_status: ListAnchorStatus;
}

function item(row: StatementRow, now: Date): StatementItem {
  return {
    statement_digest: row.statementDigest,
    seq: row.seq,
    recorded_at: row.recordedAt,
    statement_kind: row.statementKind,
    predicate_type: row.predicateType,
    repository_id: row.repositoryId,
    subject_sha: row.subjectSha,
    anchor_status: anchorStatusOf({ rekor: row.rekorAnchored, tsa: row.tsaAnchored }, row.recordedAt, now),
  };
}

export async function listStatements(
  store: AttestaReadStore, tenantId: string, query: ListQuery, now: Date,
): Promise<{ statements: StatementItem[]; next_cursor: string | null }> {
  const rows = await store.listStatements(tenantId, query.filter, query.cursor, query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    statements: page.map((r) => item(r, now)),
    next_cursor: rows.length > query.limit && last ? encodeCursor({ r: last.recordedAt, s: last.seq }) : null,
  };
}

export async function getStatement(store: AttestaReadStore, tenantId: string, digest: string) {
  const row = await store.getStatement(tenantId, digest);
  if (!row) return null;
  return {
    record: {
      seq: row.seq,
      prev_hash: row.prevHash,
      recorded_at: row.recordedAt,
      record_hash: row.recordHash,
      canonical_record: row.canonicalRecord,
    },
    statement: JSON.parse(row.statementCanonical) as unknown,
    envelope: row.envelope,
    anchors: row.anchors,
  };
}

export async function subjectStatements(
  store: AttestaReadStore, tenantId: string, repositoryId: string, sha: string, now: Date,
): Promise<{ statements: Array<StatementItem & { previous: string[] }> } | null> {
  const rows = await store.subjectStatements(tenantId, repositoryId, sha, MAX_SUBJECT_STATEMENTS);
  if (rows.length === 0) return null;
  return {
    statements: rows.map((r) => ({ ...item(r, now), previous: deriveStatementColumns(r.statementCanonical).previous })),
  };
}

// ---------------------------------------------------------------------------
// Verify

export interface PublishedKey { keyid: string; publicKey: KeyObject }

/**
 * Where the verify route gets the tenant's published statement keys. `null` means none
 * are published: verifyChain then reports ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED and the
 * report is never `ok` for a non-empty range.
 */
export type VerifyKeySource = (tenantId: string) => Promise<PublishedKey[] | null>;
export const noPublishedKeys: VerifyKeySource = async () => null;

/**
 * The production key source (Task15i2): every statement key the tenant ever had
 * (retired and revoked included, `publishedKeysFor`), so statements signed before a
 * rotation still verify. A tenant with no key yet → null (not checked, never "unknown key").
 */
export function publishedKeySource(store: () => TrustStore): VerifyKeySource {
  return async (tenantId) => {
    const keys = (await publishedKeysFor(store(), tenantId)).keys;
    const list = Object.entries(keys).map(([keyid, publicKey]) => ({ keyid, publicKey }));
    return list.length === 0 ? null : list;
  };
}

/** The anchor verify material, or null when anchoring is not configured. */
export type AnchorMaterialSource = () => Promise<AnchorVerifyMaterial | null>;

/**
 * Anchor material from the environment (anchor-env.ts). Not configured (neither
 * ATTESTA_REKOR_URL nor ATTESTA_TSA_URL set) → null, and the report says anchors
 * `not_checked`. Configured but broken → rejects (AnchorConfigError), and the route
 * answers 500: a half-configured verifier never silently skips anchors.
 * The log key and TSA anchors are built once; in production the anchoring keys are
 * re-read for every call as windows from the trust-verified root
 * (`platformAnchorKeysFromEnv` → `platformKeyWindows`, Task15l2 "Integration notes"),
 * never a bare SPKI list and never a startup snapshot, so a root import takes effect
 * without a restart.
 */
export function anchorMaterialFromEnv(env: NodeJS.ProcessEnv = process.env,
  windows: () => Promise<AnchorVerifyMaterial['anchorKeyWindows']> = () => platformAnchorKeysFromEnv(env)): AnchorMaterialSource {
  let cached: Promise<AnchorVerifyMaterial | null> | null = null;
  return async () => {
    if (!cached) {
      const configured = Boolean(env.ATTESTA_REKOR_URL?.trim() || env.ATTESTA_TSA_URL?.trim());
      cached = configured ? anchorFromEnv(env).then((a) => a.verify) : Promise.resolve(null);
      cached.catch(() => { cached = null; });
    }
    const base = await cached;
    if (!base || !isProduction(env)) return base;
    return { ...base, anchorKeysSpkiDer: [], anchorKeyWindows: await windows() };
  };
}

export type ChainVerifier = (tenantId: string, options: VerifyChainOptions) => Promise<ChainReport>;
export const dbChainVerifier = (executor: ChainReadExecutor = db): ChainVerifier =>
  (tenantId, options) => verifyChain(executor, tenantId, options);

export interface VerifyDeps {
  store: AttestaReadStore;
  verifier: ChainVerifier;
  keys: VerifyKeySource;
  anchors: AnchorMaterialSource;
  now: () => Date;
}

export interface VerifyInput extends VerifyQuery {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  requestId: string;
}

/**
 * Verify a range of the tenant's chain and write one audit row. A missing `to_seq`
 * means the chain's last known record; the range is at most MAX_VERIFY_RANGE records
 * (else AttestaQueryError). The report is verifyChain's (version 2), unchanged.
 */
export async function verifyRange(deps: VerifyDeps, input: VerifyInput): Promise<ChainReport> {
  const fromSeq = input.fromSeq ?? 0;
  let toSeq = input.toSeq;
  if (toSeq === undefined) {
    const extent = await deps.store.chainExtent(input.tenantId);
    if (extent >= fromSeq) toSeq = extent;
  }
  if (toSeq !== undefined && toSeq - fromSeq + 1 > MAX_VERIFY_RANGE) throw new AttestaQueryError('range is too large');
  const audit = { tenantId: input.tenantId, actorId: input.actorId, actorRole: input.actorRole, requestId: input.requestId };
  let report: ChainReport;
  try {
    const [published, material] = await Promise.all([deps.keys(input.tenantId), deps.anchors()]);
    const options: VerifyChainOptions = { fromSeq };
    // No to_seq past an empty chain: verifyChain then reports the empty range itself.
    if (toSeq !== undefined) options.toSeq = toSeq;
    if (published) options.keys = Object.fromEntries(published.map((k) => [k.keyid, k.publicKey]));
    if (material) options.anchors = { ...material, windowMs: ANCHOR_WINDOW_MS, now: deps.now() };
    report = await deps.verifier(input.tenantId, options);
  } catch (err) {
    // Every verify is recorded (api.md), the failed ones too; the original error wins.
    await deps.store.recordVerifyAudit({
      ...audit, fromSeq, toSeq: toSeq ?? null, ok: false, checked: 0, breakCount: 0, failed: true,
    }).catch(() => undefined);
    throw err;
  }
  await deps.store.recordVerifyAudit({
    ...audit,
    fromSeq: report.range.from_seq,
    toSeq: report.range.to_seq >= report.range.from_seq ? report.range.to_seq : null,
    ok: report.ok,
    checked: report.checked,
    breakCount: report.breaks.length,
  });
  return report;
}
