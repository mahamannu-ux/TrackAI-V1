/**
 * The auditor's verifiable code answers (A16.13a, Task16h; prompt items 3 and 6.3).
 *
 * Every figure is computed only from signed Attesta statements, and every
 * recorded or partial figure carries evidence: the records behind it with an
 * RFC 6962 root, the same root kind Attesta signs. The report-path questions
 * (Q1, Q3, Q9, Q13) run exactly the computation the signed period report runs
 * (computeReportDocument) and map the document's figures; the direct questions
 * (Q4, Q7, Q8, Q11, Q14, Q16) read the stored statements themselves.
 *
 * Reading a verifiable answer writes no audit row (prompt item 6), so Q7 runs
 * Attesta's own verify with a no-op audit sink while the chain verification
 * itself is unchanged (api.md "Audit" leaves this choice to A16.13).
 *
 * Interpretations the registry's frozen reason codes force (recorded in the
 * handoff; the new codes are not_sealed_yet, evidence_broken, report_not_built
 * and evidence_truncated):
 *  - the document's figure reasons (`source_missing`,
 *    `only_some_sources_reported`) are not Q&A codes, and most verifiable
 *    questions have no matching open gap, so the mapped reason is
 *    `vendor_does_not_report`: the statement's emitter did not report the
 *    field the figure sums (Q1's whole-repository share keeps its G1 code,
 *    Q4's approval its G2);
 *  - a scope whose statement kind never appears in the window figures as
 *    `unavailable`, not as an unobserved 0 (nothing was recorded to count);
 *  - Q7's honest-but-incomplete report (signatures or anchors could not be
 *    checked, or the range was capped) is `partial` with `partial_linkage`.
 */
import { sql, eq, type SQL } from 'drizzle-orm';
import { db } from '../../../core/db';
import { scmPullRequests } from '../../../core/db/schema';
import { withTenant } from '../../../core/db/tenant';
import { sha256Prefixed } from '../../attesta/canonical';
import {
  AI_PROVENANCE_TYPE, MAX_REPORT_STATEMENTS, REPORT_SETTLE_MS, basisPoints, computeReportDocument,
  type LineCounts, type ModelLines, type ReportDocument, type ReportInput,
} from '../../attesta/period-report-rules';
import { ReportJobError, pgReportStore, type ReportDatabase } from '../../attesta/period-report-service';
import {
  MAX_VERIFY_RANGE, anchorMaterialFromEnv, dbChainVerifier, pgReadStore, publishedKeySource, verifyRange,
} from '../../attesta/read-service';
import { pgTrustStore, type TrustDb } from '../../attesta/trust-inventory';
import { trustConfigFromEnv } from '../../attesta/trust-resolver';
import { evidenceOf, type EvidenceRecordInput } from './evidence';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from '../registry';
import type {
  QaAnswerContext, QaAnswerer, QaBreakdownItem, QaDrilldown, QaEnvelope,
  QaFigure, QaReason, QaValue,
} from '../types';

/** At most 200 repositories per tenant-scope answer (prompt item 3). */
export const MAX_REPOSITORIES = 200;
/** One statement read stops there: beyond it the evidence cannot be listed whole. */
const MAX_STATEMENTS_READ = 50_000;

type Reported = 'recorded' | 'partial' | 'unavailable';

/** Worst-of (answers/common.ts finishEnvelope): unavailable only when nothing is available. */
export function worstOf(availability: Reported[]): Reported {
  if (availability.length === 0 || availability.every((a) => a === 'unavailable')) return 'unavailable';
  return availability.some((a) => a !== 'recorded') ? 'partial' : 'recorded';
}

/** recorded_at holds microseconds: truncate to the envelope's millisecond form, never round-trip a Date. */
export function msTime(microTime: string | null | undefined): string | null {
  if (!microTime) return null;
  return `${microTime.slice(0, 23)}Z`;
}

const count = (v: number): QaValue => ({ type: 'count', count: v });
const bpRatio = (bp: number): QaValue => ({ type: 'ratio', numerator: bp, denominator: 10_000 });

/** The interpretation reason (file comment): the emitter did not report the field. */
const notReported: QaReason[] = [{ code: 'vendor_does_not_report' }];

// ---------------------------------------------------------------------------
// The envelope

export interface FigureSeed {
  key: string;
  availability: Reported;
  reasons: QaReason[];
  value: QaValue | null;
  breakdown?: QaBreakdownItem[];
  evidence?: EvidenceRecordInput[];
}

export function finishAuditor(ctx: QaAnswerContext, seeds: FigureSeed[], asOf: string, drilldown: QaDrilldown[] = []): QaEnvelope {
  const question = QA_QUESTIONS_BY_ID.get(ctx.questionId);
  if (!question) throw new Error(`Task16h: unknown question ${ctx.questionId}`);
  const figures: QaFigure[] = seeds.map((seed): QaFigure => ({
    key: seed.key,
    availability: seed.availability,
    reasons: seed.reasons,
    value: seed.value,
    ...(seed.breakdown && seed.breakdown.length > 0 ? { breakdown: seed.breakdown } : {}),
    ...(seed.availability !== 'unavailable' && seed.evidence ? { evidence: evidenceOf(seed.evidence) } : {}),
  }));
  const reasons: QaReason[] = [];
  for (const figure of figures) {
    for (const reason of figure.reasons) {
      if (!reasons.some((r) => r.code === reason.code && r.gap === reason.gap)) reasons.push(reason);
    }
  }
  return {
    question_id: ctx.questionId,
    registry_version: QA_REGISTRY_VERSION,
    kind: ctx.kind,
    as_of: asOf,
    scope: ctx.scope,
    availability: worstOf(figures.map((f) => f.availability)),
    reasons,
    figures,
    wording: [...question.wording],
    drilldown,
  };
}

// ---------------------------------------------------------------------------
// The report path (Q1, Q3, Q9, Q13): the same computation the period report runs

const reportStore = pgReportStore(db as unknown as ReportDatabase);

/** Clock skew allowed between the API and the database when clamping to the settled part. */
const SETTLE_SKEW_MS = 60_000;

/**
 * The part of the request's period the report computation may read. readSnapshot
 * refuses a `to` inside the settle margin; the Questions screen's default `to`
 * is "now", so the verifiable answer counts only the settled part and says so
 * (`not_sealed_yet`, contract rule 4) instead of failing the request.
 */
interface ReportWindow { from: string; to: string; unsettled: boolean }

function settledWindow(ctx: QaAnswerContext): ReportWindow | null {
  const limitMs = Date.parse(ctx.now) - REPORT_SETTLE_MS - SETTLE_SKEW_MS;
  if (Date.parse(ctx.scope.to) <= limitMs) return { from: ctx.scope.from, to: ctx.scope.to, unsettled: false };
  if (limitMs < Date.parse(ctx.scope.from)) return null;
  return { from: ctx.scope.from, to: new Date(limitMs).toISOString(), unsettled: true };
}

export interface ScopeDoc { repositoryId: string; doc: ReportDocument; truncated: boolean }

/** What qualifies every figure of a report-path answer. */
export interface Flags { truncated: boolean; unsettled: boolean }

/**
 * One repository's statements as the signed period report reads them. Above
 * MAX_REPORT_STATEMENTS readSnapshot refuses the scope; the answer then counts
 * the first MAX_REPORT_STATEMENTS statements in seq order and says so
 * (`evidence_truncated`, prompt item 1). An unsettled `to` still fails loudly
 * (settledWindow keeps the request clear of it).
 */
async function reportInputs(tenantId: string, repositoryId: string, win: ReportWindow): Promise<{ inputs: ReportInput[]; truncated: boolean }> {
  const scope = { repository_id: repositoryId, from: win.from, to: win.to, basis: 'recorded_at' as const };
  try {
    return { inputs: (await reportStore.readSnapshot(tenantId, scope)).inputs, truncated: false };
  } catch (err) {
    if (err instanceof ReportJobError && err.code === 'ATTESTA_API_INVALID_QUERY' && /too many statements/.test(err.message)) {
      const { rows } = await readStatements(tenantId, { repositoryId }, win.from, win.to);
      const inputs = rows.slice(0, MAX_REPORT_STATEMENTS).map((r) => ({ seq: r.seq, digest: r.digest, canonical: r.canonical }));
      return { inputs, truncated: true };
    }
    throw err;
  }
}

function docOf(tenantId: string, repositoryId: string, win: ReportWindow, inputs: ReportInput[]): ReportDocument {
  return computeReportDocument({ tenantId, scope: { repository_id: repositoryId, from: win.from, to: win.to, basis: 'recorded_at' }, inputs });
}

/** Repositories with ai-provenance statements in the window, ordered; at most MAX_REPOSITORIES. */
async function repositoriesInWindow(tenantId: string, from: string, to: string): Promise<{ repositories: string[]; truncated: boolean }> {
  const found = await db.execute(sql`select distinct r.repository_id::text as repository_id
    from attesta_records r where r.tenant_id = ${tenantId} and r.predicate_type = ${AI_PROVENANCE_TYPE}
    and r.recorded_at >= ${from}::timestamptz and r.recorded_at <= ${to}::timestamptz
    order by repository_id limit ${MAX_REPOSITORIES + 1}`);
  const repositories = found.rows
    .map((row: Record<string, unknown>) => row.repository_id)
    .filter((v): v is string => typeof v === 'string');
  return { repositories: repositories.slice(0, MAX_REPOSITORIES), truncated: repositories.length > MAX_REPOSITORIES };
}

/**
 * The documents behind a report-path answer. Tenant scope: one per repository
 * with statements (at most MAX_REPOSITORIES); repository scope: that one;
 * PR and commit scopes: the repository's document over that subject's
 * statements only (prompt item 3). Null when nothing of the period is settled.
 */
async function reportDocs(ctx: QaAnswerContext): Promise<{ docs: ScopeDoc[]; flags: Flags; win: ReportWindow } | null> {
  const win = settledWindow(ctx);
  if (!win) return null;
  if (ctx.scopeLevel === 'tenant') {
    const { repositories, truncated } = await repositoriesInWindow(ctx.tenantId, win.from, win.to);
    const docs = await Promise.all(repositories.map(async (id): Promise<ScopeDoc> => {
      const read = await reportInputs(ctx.tenantId, id, win);
      return { repositoryId: id, doc: docOf(ctx.tenantId, id, win, read.inputs), truncated: read.truncated };
    }));
    return { docs, win, flags: { truncated: truncated || docs.some((d) => d.truncated), unsettled: win.unsettled } };
  }
  const repositoryId = ctx.scope.repository_id as string;
  const read = await reportInputs(ctx.tenantId, repositoryId, win);
  let inputs = read.inputs;
  if (ctx.scopeLevel === 'commit' || ctx.scopeLevel === 'pull_request') {
    const subjectSha = ctx.scopeLevel === 'commit'
      ? ctx.scope.commit_sha as string
      : await mergeShaOf(ctx.tenantId, ctx.scope.pull_request_id as string);
    // An unmerged pull request has no subject: nothing of the repository counts for it.
    inputs = subjectSha === null ? [] : inputs.filter((input) => subjectShaOf(input) === subjectSha);
  }
  return {
    docs: [{ repositoryId, doc: docOf(ctx.tenantId, repositoryId, win, inputs), truncated: read.truncated }],
    win,
    flags: { truncated: read.truncated, unsettled: win.unsettled },
  };
}

/** The PR's merge commit sha: the subject every stored statement of a merged change carries. */
async function mergeShaOf(tenantId: string, pullRequestId: string): Promise<string | null> {
  const rows = await withTenant(db, tenantId).select(scmPullRequests, eq(scmPullRequests.id, pullRequestId));
  return typeof rows[0]?.mergeCommitSha === 'string' ? rows[0].mergeCommitSha : null;
}

/** The subject sha stored in a statement's canonical subject (cheap pre-parse for the scope filters). */
function subjectShaOf(input: ReportInput): string | null {
  let s: unknown;
  try {
    s = JSON.parse(input.canonical);
  } catch {
    throw new Error('Task16h: a stored statement is not JSON');
  }
  if (typeof s !== 'object' || s === null) return null;
  const subject = Array.isArray((s as { subject?: unknown }).subject)
    ? ((s as { subject: unknown[] }).subject[0] as { digest?: { gitCommit?: unknown } } | null | undefined) ?? null
    : null;
  return typeof subject?.digest?.gitCommit === 'string' ? subject.digest.gitCommit : null;
}

/**
 * A mapped figure's availability and reasons under the answer's flags: a
 * truncated or partly unsettled count is `partial` with its reason (contract
 * rule 4), never `recorded`; an unavailable figure stays unavailable.
 */
function qualified(availability: Reported, flags: Flags): { availability: Reported; reasons: QaReason[] } {
  const base = availability === 'recorded' ? [] : notReported;
  if (availability === 'unavailable') return { availability, reasons: base };
  const extra: QaReason[] = [
    ...(flags.unsettled ? [{ code: 'not_sealed_yet' as const }] : []),
    ...(flags.truncated ? [{ code: 'evidence_truncated' as const }] : []),
  ];
  return { availability: extra.length > 0 ? 'partial' : availability, reasons: [...base, ...extra] };
}

/** Every figure of a report-path answer when no part of the period is settled yet. */
function unsettledAnswer(ctx: QaAnswerContext, keys: string[], extra: FigureSeed[] = []): QaEnvelope {
  return finishAuditor(ctx, [
    ...keys.map((key): FigureSeed => ({ key, availability: 'unavailable', reasons: [{ code: 'not_sealed_yet' }], value: null })),
    ...extra,
  ], ctx.now);
}

// ---------------------------------------------------------------------------
// Accumulators over the report document's figures

interface Agg {
  availability: Reported[];
  /** The figure's summed numbers (or merged line counts). */
  numbers: { total: number; ai: number; human: number; unknown: number };
  byKey: Map<string, { tool: string; model: string | null; aiLines: number }>;
  records: EvidenceRecordInput[];
}

function emptyAgg(): Agg {
  return { availability: [], numbers: { total: 0, ai: 0, human: 0, unknown: 0 }, byKey: new Map(), records: [] };
}

const byKeyAsc = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** A figure's parts for one document: its mapped availability, its value pieces and its contributing records. */
function figureParts(doc: ReportDocument, name: keyof ReportDocument['figures']): {
  availability: Reported; value: unknown; records: EvidenceRecordInput[];
} {
  const figure = doc.figures[name];
  // A figure whose input kind never appears in a window (`inputs === 0`)
  // figures as unavailable: nothing was recorded to count, and 0 would claim
  // otherwise.
  if (doc.completeness[name].inputs === 0) return { availability: 'unavailable', value: undefined, records: [] };
  return {
    availability: figure.availability,
    value: figure.value,
    records: figure.contributions.records.map((r) => ({ seq: r.seq, digest: r.digest })),
  };
}

/** One integer figure across a scope's documents. */
function aggregateInt(docs: ScopeDoc[], name: keyof ReportDocument['figures']): Agg {
  const agg = emptyAgg();
  for (const { doc } of docs) {
    const parts = figureParts(doc, name);
    agg.availability.push(parts.availability);
    if (parts.availability === 'unavailable') continue;
    agg.numbers.total += typeof parts.value === 'number' ? parts.value : 0;
    agg.records.push(...parts.records);
  }
  return agg;
}

/** One line-count figure (lines_changed, merged_lines) across a scope's documents. */
function aggregateLines(docs: ScopeDoc[], name: keyof ReportDocument['figures']): Agg {
  const agg = emptyAgg();
  for (const { doc } of docs) {
    const parts = figureParts(doc, name);
    agg.availability.push(parts.availability);
    if (parts.availability === 'unavailable') continue;
    const v = parts.value as LineCounts;
    agg.numbers.ai += v?.ai ?? 0;
    agg.numbers.human += v?.human ?? 0;
    agg.numbers.unknown += v?.unknown ?? 0;
    agg.records.push(...parts.records);
  }
  return agg;
}

/** The merged AI lines by tool and model (model keys + per-tool sums), across a scope's documents. */
function aggregateModels(docs: ScopeDoc[]): Agg {
  const agg = emptyAgg();
  for (const { doc } of docs) {
    const parts = figureParts(doc, 'merged_ai_lines_by_model');
    agg.availability.push(parts.availability);
    if (parts.availability === 'unavailable') continue;
    for (const row of (Array.isArray(parts.value) ? parts.value : []) as ModelLines[]) {
      agg.numbers.total += row.ai_lines;
      const prior = agg.byKey.get(row.model_key);
      if (prior) prior.aiLines += row.ai_lines;
      else agg.byKey.set(row.model_key, { tool: row.tool, model: row.model, aiLines: row.ai_lines });
    }
    agg.records.push(...parts.records);
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Reading stored statements directly (Q4, Q7, Q8, Q11, Q14, Q16)

interface StoredStatement {
  seq: number;
  digest: string;
  /** UTC microseconds, `Z`; never round-tripped through a Date. */
  recordedAt: string;
  kind: string | null;
  repositoryId: string | null;
  subjectSha: string | null;
  canonical: string;
}

interface ReadWindow {
  repositoryId?: string;
  subjectSha?: string[];
  kind?: string;
}

function whereOf(tenantId: string, window: ReadWindow, from: string, to: string, predicateType?: string): SQL[] {
  const where: SQL[] = [
    sql`r.tenant_id = ${tenantId}`,
    sql`r.recorded_at >= ${from}::timestamptz`,
    sql`r.recorded_at <= ${to}::timestamptz`,
  ];
  if (predicateType) where.push(sql`r.predicate_type = ${predicateType}`);
  if (window.repositoryId) where.push(sql`r.repository_id = ${window.repositoryId}`);
  if (window.subjectSha) {
    // An empty subject list matches nothing (an unmerged pull request has no subject), never everything.
    where.push(window.subjectSha.length > 0
      ? sql`r.subject_sha in (${sql.join(window.subjectSha.map((sha) => sql`${sha}`), sql`, `)})`
      : sql`false`);
  }
  if (window.kind) where.push(sql`r.statement_kind = ${window.kind}`);
  return where;
}

/** The newest record's recorded_at for a window (ai-provenance when a predicate type is given); null when none. */
async function newestRecordedAt(tenantId: string, window: ReadWindow, from: string, to: string, predicateType?: string): Promise<string | null> {
  const found = await db.execute(sql`select ${sql.raw(`to_char(max(r.recorded_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)} as at
    from attesta_records r where ${sql.join(whereOf(tenantId, window, from, to, predicateType), sql` and `)}`);
  const row = found.rows[0] ?? {};
  return typeof row.at === 'string' && row.at.startsWith('2') ? row.at : null;
}

/** The window's min and max seq over the tenant's records, for Q7's chain range (every record, not only statements). */
async function seqRangeOf(tenantId: string, from: string, to: string): Promise<{ fromSeq: number; toSeq: number } | null> {
  const found = await db.execute(sql`select (select min(r.seq)::text from attesta_records r
      where r.tenant_id = ${tenantId} and r.recorded_at >= ${from}::timestamptz and r.recorded_at <= ${to}::timestamptz) as from_seq,
    (select max(r.seq)::text from attesta_records r
      where r.tenant_id = ${tenantId} and r.recorded_at >= ${from}::timestamptz and r.recorded_at <= ${to}::timestamptz) as to_seq`);
  const row = found.rows[0] ?? {};
  if (typeof row.from_seq !== 'string' || typeof row.to_seq !== 'string') return null;
  return { fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq) };
}

/** The rows of one ledger range (seq and digest), `seq` ascending: the evidence for Q7's figures. */
async function seqRows(tenantId: string, fromSeq: number, toSeq: number): Promise<EvidenceRecordInput[]> {
  const found = await db.execute(sql`select r.seq::text as seq, r.statement_digest as statement_digest
    from attesta_records r where r.tenant_id = ${tenantId} and r.seq >= ${fromSeq} and r.seq <= ${toSeq}
    order by r.seq`);
  return found.rows.map((row: Record<string, unknown>) => ({
    seq: Number(row.seq),
    digest: typeof row.statement_digest === 'string' ? row.statement_digest : '',
  }));
}

/**
 * The ai-provenance statements of a window, `seq` ascending, with their stored
 * bytes, tenant-bound exactly as the attesta read-service reads. The unread
 * tail keeps the answer honest: truncated means at least one statement in the
 * window was not read, so the figures are partial with `evidence_truncated`.
 */
async function readStatements(tenantId: string, window: ReadWindow, from: string, to: string): Promise<{ rows: StoredStatement[]; truncated: boolean }> {
  const found = await db.execute(sql`select r.seq::text as seq, r.statement_digest as statement_digest,
      to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
      r.statement_kind as statement_kind, r.repository_id::text as repository_id, r.subject_sha as subject_sha,
      r.statement_canonical as statement_canonical
    from attesta_records r where ${sql.join(whereOf(tenantId, window, from, to, AI_PROVENANCE_TYPE), sql` and `)}
    order by r.seq limit ${MAX_STATEMENTS_READ + 1}`);
  const rows = found.rows.map((r: Record<string, unknown>): StoredStatement => ({
    seq: Number(r.seq),
    digest: typeof r.statement_digest === 'string' ? r.statement_digest : '',
    recordedAt: typeof r.recorded_at === 'string' ? r.recorded_at : '',
    kind: typeof r.statement_kind === 'string' ? r.statement_kind : null,
    repositoryId: typeof r.repository_id === 'string' ? r.repository_id : null,
    subjectSha: typeof r.subject_sha === 'string' ? r.subject_sha : null,
    canonical: typeof r.statement_canonical === 'string' ? r.statement_canonical : '',
  }));
  return { rows: rows.slice(0, MAX_STATEMENTS_READ), truncated: rows.length > MAX_STATEMENTS_READ };
}

/** A stored statement, parsed as fields.md defines the predicate; a broken row fails loudly (503 QA_UNAVAILABLE). */
interface Parsed {
  seq: number;
  digest: string;
  recordedAt: string;
  kind: string;
  repositoryId: string;
  subjectSha: string;
  predicate: Record<string, unknown>;
}

function parseStatement(row: StoredStatement): Parsed {
  let s: unknown;
  try {
    s = JSON.parse(row.canonical);
  } catch {
    throw new Error('Task16h: a stored statement is not JSON');
  }
  if (typeof s !== 'object' || s === null) throw new Error('Task16h: a stored statement is not an object');
  const statement = s as Record<string, unknown>;
  if (statement.predicateType !== AI_PROVENANCE_TYPE) throw new Error('Task16h: a stored statement is not ai-provenance');
  if (sha256Prefixed(row.canonical) !== row.digest) throw new Error('Task16h: a stored statement does not hash to its digest');
  const predicate = (typeof statement.predicate === 'object' && statement.predicate !== null && !Array.isArray(statement.predicate))
    ? statement.predicate as Record<string, unknown>
    : {};
  const subject = Array.isArray(statement.subject) && typeof statement.subject[0] === 'object' && statement.subject[0] !== null
    ? (statement.subject[0] as { digest?: { gitCommit?: unknown } })
    : null;
  const repository = typeof predicate.repository === 'object' && predicate.repository !== null
    ? (predicate.repository as { id?: unknown }).id
    : undefined;
  return {
    seq: row.seq,
    digest: row.digest,
    recordedAt: row.recordedAt,
    kind: row.kind ?? '',
    repositoryId: typeof repository === 'string' ? repository : row.repositoryId ?? '',
    subjectSha: typeof subject?.digest?.gitCommit === 'string' ? subject.digest.gitCommit : row.subjectSha ?? '',
    predicate,
  };
}

type WrappedField = { availability: Reported; value: unknown };

/** A predicate field as fields.md wraps it; a field that is not there reads unavailable (a row is data, never trusted). */
function wrappedField(predicate: Record<string, unknown>, name: string): WrappedField {
  const field = predicate[name];
  if (field === null || typeof field !== 'object' || Array.isArray(field)) return { availability: 'unavailable', value: undefined };
  const f = field as { availability?: unknown; value?: unknown };
  return f.availability === 'recorded' || f.availability === 'partial' || f.availability === 'unavailable'
    ? f as WrappedField
    : { availability: 'unavailable', value: undefined };
}

function plainNumberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, v] of Object.entries(value)) if (typeof v === 'number') out[key] = v;
  return out;
}

/** The models field's rows, merged per model_key (sessions summed), as the period report's own reader does. */
function modelsOf(parsed: Parsed): ModelLines[] {
  const field = wrappedField(parsed.predicate, 'models');
  const rows = (Array.isArray(field.value) ? field.value : []).filter((m): m is ModelLines =>
    typeof m === 'object' && m !== null && typeof (m as ModelLines).tool === 'string'
    && typeof (m as ModelLines).model_key === 'string' && typeof (m as ModelLines).ai_lines === 'number');
  const byKey = new Map<string, ModelLines>();
  for (const row of rows) {
    const prior = byKey.get(row.model_key);
    if (prior) prior.ai_lines += row.ai_lines;
    else byKey.set(row.model_key, { ...row });
  }
  return [...byKey.values()];
}

function findingsOf(parsed: Parsed): { total: number | null; byCategory: Record<string, number>; bySeverity: Record<string, number> } {
  const field = wrappedField(parsed.predicate, 'security_findings_observed');
  const v = (typeof field.value === 'object' && field.value !== null && !Array.isArray(field.value) ? field.value : {}) as Record<string, unknown>;
  return {
    total: typeof v.total === 'number' && Number.isSafeInteger(v.total) ? v.total : null,
    byCategory: plainNumberMap(v.by_category),
    bySeverity: plainNumberMap(v.by_severity),
  };
}

function pullRequestIdOf(parsed: Parsed): string | null {
  const field = wrappedField(parsed.predicate, 'pull_request');
  const v = (typeof field.value === 'object' && field.value !== null && !Array.isArray(field.value) ? field.value : {}) as Record<string, unknown>;
  return typeof v.id === 'string' ? v.id : null;
}

function mergeLineageOf(parsed: Parsed): string[] {
  const field = wrappedField(parsed.predicate, 'merge_lineage');
  const rows = Array.isArray(field.value) ? field.value : [];
  return rows.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const sha = (entry as { source_sha?: unknown }).source_sha;
    return typeof sha === 'string' ? [sha] : [];
  });
}

/** The latest statement (highest seq) per subject: the one-statement-per-subject rule. */
function latestPerSubject(parsed: Parsed[]): Parsed[] {
  const latest = new Map<string, Parsed>();
  for (const statement of parsed) {
    const key = `${statement.repositoryId}/${statement.subjectSha}`;
    const prior = latest.get(key);
    if (!prior || prior.seq < statement.seq) latest.set(key, statement);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** A direct answer's own read window, from the request's scope. */
async function directWindow(ctx: QaAnswerContext): Promise<{ window: ReadWindow; subjects: string[] }> {
  const repositoryId = ctx.scope.repository_id;
  if (ctx.scopeLevel === 'commit') return { window: { repositoryId, subjectSha: [ctx.scope.commit_sha as string] }, subjects: [ctx.scope.commit_sha as string] };
  if (ctx.scopeLevel === 'pull_request') {
    const mergeSha = await mergeShaOf(ctx.tenantId, ctx.scope.pull_request_id as string);
    return { window: mergeSha ? { repositoryId, subjectSha: [mergeSha] } : { repositoryId, subjectSha: [] }, subjects: mergeSha ? [mergeSha] : [] };
  }
  return { window: repositoryId ? { repositoryId } : {}, subjects: [] };
}

/** Every answer's as_of: the newest record of its own window; the query time when the window holds none. */
async function asOfFor(ctx: QaAnswerContext, window: ReadWindow = {}): Promise<string> {
  return msTime(await newestRecordedAt(ctx.tenantId, window, ctx.scope.from, ctx.scope.to, AI_PROVENANCE_TYPE)) ?? ctx.now;
}

// ---------------------------------------------------------------------------
// Q1

export const answerQ1: QaAnswerer = (ctx) => answerQ1v(ctx);
export const answerQ3: QaAnswerer = (ctx) => answerQ3v(ctx);
export const answerQ4: QaAnswerer = (ctx) => answerQ4v(ctx);
export const answerQ7: QaAnswerer = (ctx) => answerQ7v(ctx);
export const answerQ8: QaAnswerer = (ctx) => answerQ8v(ctx);
export const answerQ9: QaAnswerer = (ctx) => answerQ9v(ctx);
export const answerQ11: QaAnswerer = (ctx) => answerQ11v(ctx);
export const answerQ13: QaAnswerer = (ctx) => answerQ13v(ctx);
export const answerQ14: QaAnswerer = (ctx) => answerQ14v(ctx);
export const answerQ16: QaAnswerer = (ctx) => answerQ16v(ctx);

/** A report-path answer's as_of: the newest ai-provenance record of the settled window it counted. */
async function reportAsOf(ctx: QaAnswerContext, win: ReportWindow): Promise<string> {
  const repositoryId = ctx.scopeLevel === 'tenant' ? undefined : ctx.scope.repository_id;
  return msTime(await newestRecordedAt(ctx.tenantId, repositoryId ? { repositoryId } : {}, win.from, win.to, AI_PROVENANCE_TYPE)) ?? ctx.now;
}

const G1_FIGURE: FigureSeed = { key: 'ai_share_of_repository', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G1' }], value: null };

function q1Figures(docs: ScopeDoc[], flags: Flags): FigureSeed[] {
  const lines = aggregateLines(docs, 'lines_changed');
  const lineState = qualified(worstOf(lines.availability), flags);
  const { ai, human, unknown } = lines.numbers;
  const denominator = ai + human + unknown;
  const available = lineState.availability !== 'unavailable';
  const seeds: FigureSeed[] = ([
    ['ai_lines_changed', count(ai)],
    ['human_lines_changed', count(human)],
    ['unknown_lines_changed', count(unknown)],
  ] as Array<[string, QaValue]>).map(([key, value]): FigureSeed => ({
    key, ...lineState, value: available ? value : null, evidence: [...lines.records],
  }));
  // The share is a different figure with its own availability: no lines, no share.
  const shareState = available && denominator > 0 ? lineState : qualified('unavailable', flags);
  seeds.push({
    key: 'ai_share_of_changed_lines',
    ...shareState,
    value: shareState.availability === 'unavailable' ? null : bpRatio(basisPoints(ai, denominator)),
    evidence: [...lines.records],
  });
  // The whole-repository share is not a report figure: G1, honestly unavailable.
  seeds.push(G1_FIGURE);
  return seeds;
}

// ---------------------------------------------------------------------------
// Q3

function q3Figures(ctx: QaAnswerContext, docs: ScopeDoc[], flags: Flags): FigureSeed[] {
  const prs = aggregateInt(docs, 'prs_merged');
  const merged = aggregateModels(docs);
  const mergedLines = aggregateLines(docs, 'merged_lines');
  const mergedAi = merged.numbers.total;
  const allMerged = mergedLines.numbers.ai + mergedLines.numbers.human + mergedLines.numbers.unknown;
  const prsState = qualified(worstOf(prs.availability), flags);
  const mergedState = qualified(worstOf(merged.availability), flags);
  const linesAvailability = worstOf(mergedLines.availability);
  // The share needs both its parts and a non-zero denominator; otherwise it is unavailable, never 0.
  const shareState = mergedState.availability !== 'unavailable' && linesAvailability !== 'unavailable' && allMerged > 0
    ? qualified(worstOf([worstOf(merged.availability), linesAvailability]), flags)
    : qualified('unavailable', flags);
  // One breakdown item per model key (dimension `model`), or per tool with
  // its keys summed (dimension `tool`), exactly the requested dimension.
  const breakdown: QaBreakdownItem[] = [];
  if (ctx.breakdown === 'model' || ctx.breakdown === 'tool') {
    const buckets = new Map<string, number>();
    for (const [key, row] of [...merged.byKey.entries()].sort(byKeyAsc)) {
      const bucket = ctx.breakdown === 'model' ? key : row.tool;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + row.aiLines);
    }
    for (const [key, lines_] of [...buckets.entries()].sort(byKeyAsc)) breakdown.push({ dimension: ctx.breakdown, key, value: count(lines_) });
  }
  return [
    {
      key: 'prs_merged',
      ...prsState,
      value: prsState.availability === 'unavailable' ? null : count(prs.numbers.total),
      evidence: [...prs.records],
    },
    {
      key: 'merged_ai_lines',
      ...mergedState,
      value: mergedState.availability === 'unavailable' ? null : count(mergedAi),
      evidence: [...merged.records],
      ...(mergedState.availability !== 'unavailable' && breakdown.length > 0 ? { breakdown } : {}),
    },
    {
      key: 'ai_share_of_merged_lines',
      ...shareState,
      value: shareState.availability === 'unavailable' ? null : bpRatio(basisPoints(mergedAi, allMerged)),
      evidence: [...merged.records, ...mergedLines.records],
    },
  ];
}

// ---------------------------------------------------------------------------
// Q9

function q9Figures(docs: ScopeDoc[], flags: Flags): FigureSeed[] {
  const deployments = aggregateInt(docs, 'production_deployments');
  const state = qualified(worstOf(deployments.availability), flags);
  return [
    {
      key: 'production_deployments',
      ...state,
      value: state.availability === 'unavailable' ? null : count(deployments.numbers.total),
      evidence: [...deployments.records],
    },
  ];
}

// ---------------------------------------------------------------------------
// Q13

function q13Figures(docs: ScopeDoc[], flags: Flags): FigureSeed[] {
  const commits = aggregateInt(docs, 'commits_observed');
  const lines = aggregateLines(docs, 'lines_changed');
  const commitState = qualified(worstOf(commits.availability), flags);
  const lineState = qualified(worstOf(lines.availability), flags);
  const statements = docs.flatMap((d) => d.doc.statements.map((s) => ({ seq: s.seq, digest: s.digest })));
  const { inputs, partial, unavailable } = docs.reduce(
    (sum, d) => {
      const c = d.doc.completeness.lines_changed;
      return { inputs: sum.inputs + c.inputs, partial: sum.partial + c.partial, unavailable: sum.unavailable + c.unavailable };
    },
    { inputs: 0, partial: 0, unavailable: 0 },
  );
  // The completeness counts are over every statement in the window, so their
  // own evidence is the window's statement list as a whole; they read recorded
  // 0 honestly (that is a real count), unavailable only with no statements.
  const completeness = qualified(inputs === 0 ? 'unavailable' : 'recorded', flags);
  const completenessValue = (n: number) => (completeness.availability === 'unavailable' ? null : count(n));
  return [
    {
      key: 'commits_observed',
      ...commitState,
      value: commitState.availability === 'unavailable' ? null : count(commits.numbers.total),
      evidence: [...commits.records],
    },
    {
      key: 'unknown_lines_changed',
      ...lineState,
      value: lineState.availability === 'unavailable' ? null : count(lines.numbers.unknown),
      evidence: [...lines.records],
    },
    { key: 'inputs_partial', ...completeness, value: completenessValue(partial), evidence: statements },
    { key: 'inputs_unavailable', ...completeness, value: completenessValue(unavailable), evidence: statements },
  ];
}

// ---------------------------------------------------------------------------
// The report-path answers, and the figures signed.ts maps from a stored report

/** The figure keys of each report-path question, in envelope order. */
export const REPORT_FIGURE_KEYS: Record<'Q1' | 'Q3' | 'Q9' | 'Q13', string[]> = {
  Q1: ['ai_lines_changed', 'human_lines_changed', 'unknown_lines_changed', 'ai_share_of_changed_lines', 'ai_share_of_repository'],
  Q3: ['prs_merged', 'merged_ai_lines', 'ai_share_of_merged_lines'],
  Q9: ['production_deployments'],
  Q13: ['commits_observed', 'unknown_lines_changed', 'inputs_partial', 'inputs_unavailable'],
};

/**
 * A report-path question's figures over report documents (the item 3
 * mapping). The verifiable answers pass the documents they computed; the
 * signed answers (signed.ts) pass the one stored, signed document with no
 * flags, so both kinds map figures the same way.
 */
export function reportFigures(ctx: QaAnswerContext, docs: ScopeDoc[], flags: Flags): FigureSeed[] {
  switch (ctx.questionId) {
    case 'Q1': return q1Figures(docs, flags);
    case 'Q3': return q3Figures(ctx, docs, flags);
    case 'Q9': return q9Figures(docs, flags);
    case 'Q13': return q13Figures(docs, flags);
    default: throw new Error(`Task16h: ${ctx.questionId} is not a report-path question`);
  }
}

async function reportAnswer(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const read = await reportDocs(ctx);
  if (!read) {
    const keys = REPORT_FIGURE_KEYS[ctx.questionId as keyof typeof REPORT_FIGURE_KEYS];
    // Q1's G1 figure is unavailable for its own reason, settled or not.
    return ctx.questionId === 'Q1'
      ? unsettledAnswer(ctx, keys.filter((key) => key !== G1_FIGURE.key), [G1_FIGURE])
      : unsettledAnswer(ctx, keys);
  }
  return finishAuditor(ctx, reportFigures(ctx, read.docs, read.flags), await reportAsOf(ctx, read.win));
}

const answerQ1v = reportAnswer;
const answerQ3v = reportAnswer;
const answerQ9v = reportAnswer;
const answerQ13v = reportAnswer;

// ---------------------------------------------------------------------------
// Q7: the chain verify over the scope's seq range

const noop = async () => {};

async function answerQ7v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const range = await seqRangeOf(ctx.tenantId, ctx.scope.from, ctx.scope.to);
  if (!range || range.toSeq < range.fromSeq) {
    return finishAuditor(ctx, [
      { key: 'statements_checked', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'breaks', availability: 'unavailable', reasons: notReported, value: null },
    ], ctx.now);
  }
  // The verify route's cap: beyond MAX_VERIFY_RANGE records only a prefix is
  // checked, and the answer says so (`evidence_truncated`).
  const toSeq = Math.min(range.toSeq, range.fromSeq + MAX_VERIFY_RANGE - 1);
  const truncated = toSeq < range.toSeq;
  // A verifiable answer writes no audit row (prompt item 6): the verify and
  // its verifier wiring are Attesta's own, only the audit sink is a no-op.
  const now = () => new Date();
  const report = await verifyRange({
    store: { ...pgReadStore(), recordVerifyAudit: noop },
    verifier: dbChainVerifier(),
    keys: publishedKeySource(() => pgTrustStore(db as unknown as TrustDb), () => trustConfigFromEnv(process.env), now),
    anchors: anchorMaterialFromEnv(),
    now,
  }, {
    tenantId: ctx.tenantId,
    actorId: ctx.tenantId,
    actorRole: ctx.role,
    requestId: `qa:${ctx.questionId}`,
    fromSeq: range.fromSeq,
    toSeq,
  });
  const rows = await seqRows(ctx.tenantId, report.range.from_seq, report.range.to_seq);
  const incomplete = truncated || report.signatures === 'not_checked' || report.anchors.status === 'not_checked';
  // The verified figures stay recorded when the report is complete: the break
  // count is the honest answer even with breaks. When part of the verify
  // could not run (no published key set, no anchor material, a capped range)
  // the figure is partial (`partial_linkage`; a capped range adds
  // `evidence_truncated`).
  const reasons: QaReason[] = [];
  if (report.signatures === 'not_checked' || report.anchors.status === 'not_checked') reasons.push({ code: 'partial_linkage' });
  if (truncated) reasons.push({ code: 'evidence_truncated' });
  const availability: Reported = incomplete ? 'partial' : 'recorded';
  return finishAuditor(ctx, [
    { key: 'statements_checked', availability, reasons, value: count(report.checked), evidence: rows },
    { key: 'breaks', availability, reasons, value: count(report.breaks.length), evidence: rows },
  ], msTime(await newestRecordedAt(ctx.tenantId, {}, ctx.scope.from, ctx.scope.to)) ?? ctx.now);
}

// ---------------------------------------------------------------------------
// Q4, Q8, Q11, Q14, Q16: the stored statements themselves

async function answerQ4v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const { window } = await directWindow(ctx);
  const { rows, truncated } = await readStatements(ctx.tenantId, { ...window, kind: 'commit_observed' }, ctx.scope.from, ctx.scope.to);
  const commits = latestPerSubject(rows.map(parseStatement));
  if (commits.length === 0) {
    return finishAuditor(ctx, [
      { key: 'commits_by_model', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'approved_at_the_time', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G2' }], value: null },
    ], ctx.now);
  }
  const availability: Reported = truncated ? 'partial' : 'recorded';
  const reasons: QaReason[] = truncated ? [{ code: 'evidence_truncated' }] : [];
  const breakdown: QaBreakdownItem[] = [];
  if (ctx.breakdown === 'model' || ctx.breakdown === 'tool') {
    const buckets = new Map<string, number>();
    let withoutModel = 0;
    for (const commit of commits) {
      const modelRows = modelsOf(commit);
      if (modelRows.length === 0) {
        withoutModel += 1;
        continue;
      }
      for (const row of modelRows) {
        const key = ctx.breakdown === 'model' ? row.model_key : row.tool;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }
    for (const [key, total] of [...buckets.entries()].sort(byKeyAsc)) breakdown.push({ dimension: ctx.breakdown, key, value: count(total) });
    // `unknown` is its own bucket (unknown_model_explicit): a commit whose
    // statement carries no model attribution counts there, not nowhere.
    if (withoutModel > 0) breakdown.push({ dimension: ctx.breakdown, key: 'unknown', value: count(withoutModel) });
  }
  if (ctx.breakdown === 'repository') {
    const buckets = new Map<string, number>();
    for (const commit of commits) buckets.set(commit.repositoryId, (buckets.get(commit.repositoryId) ?? 0) + 1);
    for (const [key, total] of [...buckets.entries()].sort(byKeyAsc)) breakdown.push({ dimension: 'repository', key, value: count(total) });
  }
  return finishAuditor(ctx, [
    {
      key: 'commits_by_model',
      availability,
      reasons,
      value: count(commits.length),
      evidence: commits.map((s) => ({ seq: s.seq, digest: s.digest })),
      ...(breakdown.length > 0 ? { breakdown } : {}),
    },
    // Approval capture does not exist yet: G2, honestly unavailable.
    { key: 'approved_at_the_time', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G2' }], value: null },
  ], await asOfFor(ctx, window));
}

async function answerQ8v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  // Q8 is commit-scoped by the registry, so the window is always the one sha.
  const { window } = await directWindow(ctx);
  const { rows, truncated } = await readStatements(ctx.tenantId, window, ctx.scope.from, ctx.scope.to);
  if (rows.length === 0) {
    return finishAuditor(ctx, [
      { key: 'statements', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'first_seen_to_signed_ms', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'signed_late_statements', availability: 'unavailable', reasons: notReported, value: null },
    ], ctx.now);
  }
  const parsed = rows.map(parseStatement);
  const availability: Reported = truncated ? 'partial' : 'recorded';
  const reasons: QaReason[] = truncated ? [{ code: 'evidence_truncated' }] : [];
  // The signing delay is the latest statement's own span: the one the commit
  // stands on now (one statement per subject).
  const latest = parsed[parsed.length - 1];
  const firstSeen = wrappedField(latest.predicate, 'first_seen');
  const at = (typeof firstSeen.value === 'object' && firstSeen.value !== null && !Array.isArray(firstSeen.value)
    ? (firstSeen.value as Record<string, unknown>).at : undefined);
  const seenAt = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  const durationMs = seenAt ? Date.parse(msTime(latest.recordedAt) as string) - Date.parse(seenAt) : null;
  const signedLate = parsed.filter((statement) => {
    const field = wrappedField(statement.predicate, 'signed_late');
    return field.availability !== 'unavailable'
      && (field.value as Record<string, unknown> | undefined)?.value === true;
  }).length;
  return finishAuditor(ctx, [
    { key: 'statements', availability, reasons, value: count(rows.length), evidence: parsed.map((s) => ({ seq: s.seq, digest: s.digest })) },
    {
      key: 'first_seen_to_signed_ms',
      availability: durationMs === null ? 'unavailable' : availability,
      reasons: durationMs === null ? notReported : reasons,
      value: durationMs === null ? null : ({ type: 'duration_ms', ms: durationMs } satisfies QaValue),
      evidence: [{ seq: latest.seq, digest: latest.digest }],
    },
    { key: 'signed_late_statements', availability, reasons, value: count(signedLate), evidence: parsed.map((s) => ({ seq: s.seq, digest: s.digest })) },
  ], await asOfFor(ctx, window));
}

async function answerQ11v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const { window } = await directWindow(ctx);
  const { rows, truncated } = await readStatements(ctx.tenantId, { ...window, kind: 'commit_observed' }, ctx.scope.from, ctx.scope.to);
  const commits = latestPerSubject(rows.map(parseStatement))
    .map((commit) => ({ commit, findings: findingsOf(commit) }))
    .filter(({ findings }) => findings.total !== null);
  if (commits.length === 0) {
    return finishAuditor(ctx, [
      { key: 'findings_observed', availability: 'unavailable', reasons: notReported, value: null },
    ], ctx.now);
  }
  const total = commits.reduce((sum, { findings }) => sum + (findings.total as number), 0);
  const breakdown: QaBreakdownItem[] = [];
  if (ctx.breakdown === 'rule_category' || ctx.breakdown === 'severity') {
    const buckets = new Map<string, number>();
    for (const { findings } of commits) {
      const map = ctx.breakdown === 'rule_category' ? findings.byCategory : findings.bySeverity;
      for (const [key, n] of Object.entries(map)) buckets.set(key, (buckets.get(key) ?? 0) + n);
    }
    for (const [key, n] of [...buckets.entries()].sort(byKeyAsc)) breakdown.push({ dimension: ctx.breakdown, key, value: count(n) });
  }
  if (ctx.breakdown === 'repository') {
    const buckets = new Map<string, number>();
    for (const { commit, findings } of commits) buckets.set(commit.repositoryId, (buckets.get(commit.repositoryId) ?? 0) + (findings.total as number));
    for (const [key, n] of [...buckets.entries()].sort(byKeyAsc)) breakdown.push({ dimension: 'repository', key, value: count(n) });
  }
  return finishAuditor(ctx, [
    {
      // The field itself is partial by contract (linked by session string).
      key: 'findings_observed',
      availability: 'partial',
      reasons: truncated ? [{ code: 'partial_linkage' }, { code: 'evidence_truncated' }] : [{ code: 'partial_linkage' }],
      value: count(total),
      evidence: commits.map(({ commit }) => ({ seq: commit.seq, digest: commit.digest })),
      ...(breakdown.length > 0 ? { breakdown } : {}),
    },
  ], await asOfFor(ctx, window));
}

async function answerQ14v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const mergeSha = await mergeShaOf(ctx.tenantId, ctx.scope.pull_request_id as string);
  if (!mergeSha) {
    // An unmerged pull request: no chain to show, every figure honestly says so.
    return finishAuditor(ctx, [
      { key: 'commits_with_statements', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'pr_merged_statements', availability: 'unavailable', reasons: notReported, value: null },
      { key: 'deployed_statements', availability: 'unavailable', reasons: notReported, value: null },
    ], ctx.now);
  }
  const { rows, truncated } = await readStatements(ctx.tenantId, { subjectSha: [mergeSha] }, ctx.scope.from, ctx.scope.to);
  const prId = ctx.scope.pull_request_id as string;
  const prMerged = latestPerSubject(rows
    .filter((row) => row.kind === 'pr_merged' && pullRequestIdOf(parseStatement(row)) === prId)
    .map(parseStatement));
  const deployed = latestPerSubject(rows
    .filter((row) => row.kind === 'deployed' && pullRequestIdOf(parseStatement(row)) === prId)
    .map(parseStatement));
  const mergeStatement = prMerged[0];
  let sourceShas: string[] = [];
  if (mergeStatement) {
    const sources = new Set(mergeLineageOf(mergeStatement));
    sources.delete(mergeSha);
    sourceShas = [...sources].sort();
  }
  // The PR's source commits (from the pr_merged statement's lineage) that
  // have a commit_observed statement in the period, one per commit (the
  // latest statement per subject).
  const withStatements = sourceShas.length > 0
    ? latestPerSubject((await readStatements(ctx.tenantId, {
      repositoryId: mergeStatement.repositoryId,
      subjectSha: sourceShas,
      kind: 'commit_observed',
    }, ctx.scope.from, ctx.scope.to)).rows.map(parseStatement))
    : [];
  const asOf = await asOfFor(ctx, { subjectSha: [mergeSha] });
  const drilldown: QaDrilldown[] = sourceShas.map((sha) => ({ scope: 'commit' as const, id: sha, label: sha }));
  return finishAuditor(ctx, [
    {
      key: 'commits_with_statements',
      availability: mergeStatement ? (truncated ? 'partial' : 'recorded') : 'unavailable',
      reasons: mergeStatement ? (truncated ? [{ code: 'evidence_truncated' }] : []) : notReported,
      value: mergeStatement ? count(withStatements.length) : null,
      evidence: [...withStatements.map((s) => ({ seq: s.seq, digest: s.digest })), ...prMerged.map((s) => ({ seq: s.seq, digest: s.digest }))],
    },
    {
      key: 'pr_merged_statements',
      availability: truncated ? 'partial' : 'recorded',
      reasons: truncated ? [{ code: 'evidence_truncated' }] : [],
      value: count(prMerged.length),
      evidence: prMerged.map((s) => ({ seq: s.seq, digest: s.digest })),
    },
    {
      key: 'deployed_statements',
      availability: truncated ? 'partial' : 'recorded',
      reasons: truncated ? [{ code: 'evidence_truncated' }] : [],
      value: count(deployed.length),
      evidence: deployed.map((s) => ({ seq: s.seq, digest: s.digest })),
    },
  ], asOf, drilldown);
}

async function answerQ16v(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const { window } = await directWindow(ctx);
  const { rows, truncated } = await readStatements(ctx.tenantId, window, ctx.scope.from, ctx.scope.to);
  if (rows.length === 0) {
    return finishAuditor(ctx, [
      { key: 'statements_in_scope', availability: 'unavailable', reasons: notReported, value: null },
    ], ctx.now);
  }
  return finishAuditor(ctx, [
    {
      key: 'statements_in_scope',
      availability: truncated ? 'partial' : 'recorded',
      reasons: truncated ? [{ code: 'evidence_truncated' }] : [],
      value: count(rows.length),
      evidence: rows.map((s) => ({ seq: s.seq, digest: s.digest })),
    },
  ], await asOfFor(ctx, window));
}
