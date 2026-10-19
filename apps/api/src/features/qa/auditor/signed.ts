/**
 * The auditor's signed answers (A16.13a + A16.13b, Task16h; prompt item 5).
 *
 * A signed answer is the stored, signed period report for exactly the
 * request's scope, named by its statement digest. Nothing is recomputed from
 * live tables: the figures are read from the stored report document, after
 * its bytes are checked against the stored document digest.
 *
 *  - Code (Q1, Q3, Q9, Q13): the newest `ready` Task15i4 period report whose
 *    stored scope is exactly {repository_id, from, to}. The code period report
 *    is per repository, so tenant, pull-request and commit scopes answer
 *    `report_not_built`. Figures map exactly as the verifiable answers map a
 *    computed document (code-verifiable.ts `reportFigures`); the evidence per
 *    figure is that figure's `contributions.records` in the stored document.
 *  - Security (S1, S7–S12): the newest Task15op-b security period report for
 *    exactly {repository_id or tenant, from, to}. The evidence for every figure
 *    is the report's covering seal records. `blocked` stays unavailable (the
 *    report says monitor-only); `denied_by_request` is a request count, never
 *    "blocked".
 *  - No exact report: every figure is `unavailable` with `report_not_built`
 *    (the auditor can request one); the answer then carries no `signed`.
 *  - Stored bytes that no longer hash to their digest: `evidence_broken`.
 *
 * Reading a signed answer writes no audit row (prompt item 6).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../core/db';
import { sha256Prefixed } from '../../attesta/canonical';
import { PERIOD_REPORT_PREDICATE_TYPE, type ReportDocument } from '../../attesta/period-report-rules';
import type { Bucket, SecurityFigure, SecurityReportDocument } from '../../attesta/security-report-rules';
import { QA_QUESTIONS_BY_ID } from '../registry';
import { previousPeriod } from '../service';
import type {
  QaAnswerContext, QaAnswerer, QaBreakdownItem, QaDimension, QaEnvelope, QaFigure, QaReason, QaValue,
} from '../types';
import { REPORT_FIGURE_KEYS, finishAuditor, msTime, reportFigures, type FigureSeed } from './code-verifiable';
import { evidenceOf, type EvidenceRecordInput } from './evidence';

export const SECURITY_REPORT_PREDICATE_TYPE = 'https://trackai.dev/attesta/security-period-report/v1';

const NOT_BUILT_REPORT: QaReason = { code: 'report_not_built' };
const BROKEN: QaReason = { code: 'evidence_broken' };
const count = (n: number): QaValue => ({ type: 'count', count: n });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const usText = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** One stored report: its document bytes, their digest, and the signed statement that names them. */
interface StoredReport {
  document: string;
  documentDigest: string;
  statementDigest: string;
  /** The statement's ledger recorded_at (µs text), or null when the record is gone. */
  recordedAt: string | null;
}

function storedOf(row: Record<string, unknown> | undefined): StoredReport | null {
  if (!row) return null;
  return {
    document: str(row.report_document),
    documentDigest: str(row.report_digest),
    statementDigest: str(row.statement_digest),
    recordedAt: typeof row.recorded_at === 'string' ? row.recorded_at : null,
  };
}

/** The document, when its stored bytes still hash to the stored digest; null otherwise (a break). */
function parsedDocument<T>(stored: StoredReport): T | null {
  if (stored.document === '' || sha256Prefixed(stored.document) !== stored.documentDigest) return null;
  try {
    const parsed: unknown = JSON.parse(stored.document);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

/** Every figure unavailable for one reason; a signed answer with no report names no statement. */
function unavailableAnswer(ctx: QaAnswerContext, keys: string[], reason: QaReason, extra: FigureSeed[] = []): QaEnvelope {
  const seeds: FigureSeed[] = keys.map((key) => ({ key, availability: 'unavailable', reasons: [reason], value: null }));
  return finishAuditor(ctx, [...seeds, ...extra], ctx.now);
}

/** A signed envelope: the figures, the statement named, and the statement's own time as as_of. */
function signedEnvelope(ctx: QaAnswerContext, seeds: FigureSeed[], stored: StoredReport, predicateType: string): QaEnvelope {
  const envelope = finishAuditor(ctx, seeds, msTime(stored.recordedAt) ?? ctx.now);
  // The schema requires `signed` on a recorded or partial signed answer; it
  // names the statement even when every figure the question needs is unavailable.
  return { ...envelope, signed: { statement_digest: stored.statementDigest, predicate_type: predicateType } };
}

// ---------------------------------------------------------------------------
// Code (Q1, Q3, Q9, Q13): the Task15i4 period report

async function codeReport(tenantId: string, repositoryId: string, from: string, to: string): Promise<StoredReport | null> {
  const found = await db.execute(sql`select p.report_document, p.report_digest, p.statement_digest,
      ${usText('r.recorded_at')} as recorded_at
    from attesta_period_reports p
    left join attesta_records r on r.tenant_id = p.tenant_id and r.id = p.record_id
    where p.tenant_id = ${tenantId}::uuid and p.repository_id = ${repositoryId}::uuid and p.status = 'ready'
      and p.report_document is not null and p.statement_digest is not null
      and p.scope->>'repository_id' = ${repositoryId} and p.scope->>'from' = ${from} and p.scope->>'to' = ${to}
    order by p.created_at desc, p.id desc limit 1`);
  return storedOf(found.rows[0]);
}

async function answerCodeSigned(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const keys = REPORT_FIGURE_KEYS[ctx.questionId as keyof typeof REPORT_FIGURE_KEYS];
  if (!keys) throw new Error(`Task16h: ${ctx.questionId} has no signed code answer`);
  // Q1's whole-repository share is G1 whatever the report says.
  const g1: FigureSeed[] = ctx.questionId === 'Q1'
    ? [{ key: 'ai_share_of_repository', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G1' }], value: null }]
    : [];
  const reportKeys = keys.filter((key) => key !== 'ai_share_of_repository');
  // The code period report is per repository: no other scope has one.
  if (ctx.scopeLevel !== 'repository') return unavailableAnswer(ctx, reportKeys, NOT_BUILT_REPORT, g1);
  const repositoryId = ctx.scope.repository_id as string;
  const stored = await codeReport(ctx.tenantId, repositoryId, ctx.scope.from, ctx.scope.to);
  if (!stored) return unavailableAnswer(ctx, reportKeys, NOT_BUILT_REPORT, g1);
  const doc = parsedDocument<ReportDocument>(stored);
  if (!doc || !doc.figures || !doc.completeness || !Array.isArray(doc.statements)) {
    return unavailableAnswer(ctx, keys, BROKEN);
  }
  const seeds = reportFigures(ctx, [{ repositoryId, doc, truncated: false }], { truncated: false, unsettled: false });
  return signedEnvelope(ctx, seeds, stored, PERIOD_REPORT_PREDICATE_TYPE);
}

// ---------------------------------------------------------------------------
// Security (S1, S7–S12): the Task15op-b security period report

async function securityReport(tenantId: string, repositoryId: string | null, from: string, to: string): Promise<StoredReport | null> {
  const found = await db.execute(sql`select p.report_document, p.report_digest, p.statement_digest,
      ${usText('r.recorded_at')} as recorded_at
    from attesta_security_period_reports p
    left join attesta_records r on r.tenant_id = p.tenant_id and r.id = p.record_id
    where p.tenant_id = ${tenantId}::uuid and p.repository_id is not distinct from ${repositoryId}::uuid
      and p.period_from = ${from} and p.period_to = ${to}
    order by p.created_at desc, p.id desc limit 1`);
  return storedOf(found.rows[0]);
}

type Reported = 'recorded' | 'partial' | 'unavailable';

/**
 * A report figure's state in Q&A codes. The report's own reasons are not Q&A
 * codes: `not_sealed` (unsealed decisions) is `not_sealed_yet`; a value read
 * from current machine state or hashed is `partial_linkage`; `source_missing`
 * is `vendor_does_not_report`; any other unavailable reason `answer_not_built`.
 */
function stateOf(figure: SecurityFigure<unknown> | undefined): { availability: Reported; reasons: QaReason[] } {
  if (!figure || figure.availability === 'unavailable') {
    return { availability: 'unavailable', reasons: [figure?.reason === 'source_missing' ? { code: 'vendor_does_not_report' } : { code: 'answer_not_built' }] };
  }
  if (figure.availability === 'partial') {
    return { availability: 'partial', reasons: [figure.partial_reason === 'not_sealed' ? { code: 'not_sealed_yet' } : { code: 'partial_linkage' }] };
  }
  return { availability: 'recorded', reasons: [] };
}

const bucketsOf = (figure: SecurityFigure<unknown> | undefined): Bucket[] =>
  (Array.isArray(figure?.value) ? figure.value : []).filter((b): b is Bucket =>
    typeof b === 'object' && b !== null && typeof (b as Bucket).key === 'string' && Number.isSafeInteger((b as Bucket).count));

/**
 * A document bucket list as Q&A breakdown items. The report's `not_enrolled`
 * repository bucket is the Q&A `unknown` bucket (repository keys are ids).
 */
function breakdownOf(dimension: QaDimension, buckets: Bucket[]): QaBreakdownItem[] {
  const merged = new Map<string, number>();
  for (const b of buckets) {
    const key = dimension === 'repository' && b.key === 'not_enrolled' ? 'unknown' : b.key;
    merged.set(key, (merged.get(key) ?? 0) + b.count);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, n]) => ({ dimension, key, value: count(n) }));
}

/** One mapped figure; the evidence is the covering seals, only when it is available. */
function securitySeed(
  key: string,
  figure: SecurityFigure<unknown> | undefined,
  value: (figure: SecurityFigure<unknown>) => number,
  evidence: EvidenceRecordInput[],
  breakdown: QaBreakdownItem[] = [],
): FigureSeed {
  const state = stateOf(figure);
  if (state.availability === 'unavailable' || !figure) return { key, ...state, value: null };
  return { key, ...state, value: count(value(figure)), evidence, ...(breakdown.length > 0 ? { breakdown } : {}) };
}

const numberOf = (figure: SecurityFigure<unknown>): number => (Number.isSafeInteger(figure.value) ? figure.value as number : 0);
const bucketSum = (keys: string[]) => (figure: SecurityFigure<unknown>): number =>
  bucketsOf(figure).filter((b) => keys.includes(b.key)).reduce((sum, b) => sum + b.count, 0);

const SEVERE = ['high', 'critical'];

/** The figures of one security question from a stored report document (the item 5 mapping). */
function securityFigures(ctx: QaAnswerContext, doc: SecurityReportDocument): FigureSeed[] {
  const f = doc.figures;
  const evidence: EvidenceRecordInput[] = (Array.isArray(doc.seals) ? doc.seals : [])
    .filter((s) => Number.isSafeInteger(s?.seq) && typeof s?.statement_digest === 'string')
    .map((s) => ({ seq: s.seq, digest: s.statement_digest }));
  const by = (dimension: QaDimension, figure: SecurityFigure<unknown> | undefined, keep?: (b: Bucket) => boolean): QaBreakdownItem[] =>
    ctx.breakdown === dimension ? breakdownOf(dimension, bucketsOf(figure).filter(keep ?? (() => true))) : [];
  const findingsBreakdown = (): QaBreakdownItem[] => [
    ...by('repository', f.by_repository), ...by('rule_category', f.by_category), ...by('severity', f.by_severity),
    ...by('agent_family', f.by_agent), ...by('model', f.by_model), ...by('operating_system', f.by_platform),
  ].filter((item) => (QA_QUESTIONS_BY_ID.get(ctx.questionId)?.dimensions ?? []).includes(item.dimension));
  switch (ctx.questionId) {
    case 'S1':
      // The register's count is the high and critical severity buckets. Only
      // the severity breakdown can be cut to them from the document (its rule,
      // category and repository buckets count every severity), so the other
      // breakdowns are not given.
      return [securitySeed('high_or_critical_findings', f.by_severity, bucketSum(SEVERE), evidence,
        by('severity', f.by_severity, (b) => SEVERE.includes(b.key)))];
    case 'S7':
    case 'S8':
    case 'S9':
      return [securitySeed('findings', f.findings, numberOf, evidence, findingsBreakdown())];
    case 'S10':
      return [
        securitySeed('rule_pack_versions_in_force', f.rule_pack_versions, numberOf, evidence),
        // Status snapshots are not in the report: no seal covers them.
        { key: 'machines_reporting_status', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null },
        { key: 'machines_up_to_date', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G7' }], value: null },
      ];
    case 'S11':
      return [
        securitySeed('requested', f.outcomes, bucketSum(['requested']), evidence),
        securitySeed('observed_result', f.outcomes, bucketSum(['observed_result']), evidence),
        securitySeed('v2_unclassified', f.outcomes, bucketSum(['v2_unclassified']), evidence),
      ];
    case 'S12':
      return [
        // A count of deny requests, never "blocked" (the report holds no prevention).
        securitySeed('denied_by_request', f.denied_by_request, numberOf, evidence),
        { key: 'blocked', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null },
        securitySeed('policy_versions', f.rule_pack_versions, numberOf, evidence),
      ];
    default:
      throw new Error(`Task16h: ${ctx.questionId} has no signed security answer`);
  }
}

/** The figure keys of each signed security question, in envelope order. */
const SECURITY_FIGURE_KEYS: Record<string, string[]> = {
  S1: ['high_or_critical_findings'],
  S7: ['findings'],
  S8: ['findings'],
  S9: ['findings'],
  S10: ['rule_pack_versions_in_force', 'machines_reporting_status', 'machines_up_to_date'],
  S11: ['requested', 'observed_result', 'v2_unclassified'],
  S12: ['denied_by_request', 'blocked', 'policy_versions'],
};

function securityDocOf(stored: StoredReport): SecurityReportDocument | null {
  const doc = parsedDocument<SecurityReportDocument>(stored);
  return doc && typeof doc.figures === 'object' && doc.figures !== null ? doc : null;
}

async function answerSecuritySigned(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const keys = SECURITY_FIGURE_KEYS[ctx.questionId];
  if (!keys) throw new Error(`Task16h: ${ctx.questionId} has no signed security answer`);
  const repositoryId = ctx.scope.repository_id ?? null;
  const stored = await securityReport(ctx.tenantId, repositoryId, ctx.scope.from, ctx.scope.to);
  let envelope: QaEnvelope;
  if (!stored) envelope = unavailableAnswer(ctx, keys, NOT_BUILT_REPORT);
  else {
    const doc = securityDocOf(stored);
    envelope = doc
      ? signedEnvelope(ctx, securityFigures(ctx, doc), stored, SECURITY_REPORT_PREDICATE_TYPE)
      : unavailableAnswer(ctx, keys, BROKEN);
  }
  if (ctx.questionId !== 'S7') return envelope;
  // S7 compares with the previous period: that period's own exact report, or
  // report_not_built for it alone (it never drags the current answer down).
  const previous = previousPeriod(ctx.scope);
  const prevStored = await securityReport(ctx.tenantId, repositoryId, previous.from, previous.to);
  const prevDoc = prevStored ? securityDocOf(prevStored) : null;
  const prevFigures: QaFigure[] = prevDoc
    ? securityFigures(ctx, prevDoc).map((seed): QaFigure => ({
      key: seed.key,
      availability: seed.availability,
      reasons: seed.reasons,
      value: seed.value,
      ...(seed.breakdown && seed.breakdown.length > 0 ? { breakdown: seed.breakdown } : {}),
      ...(seed.availability !== 'unavailable' && seed.evidence ? { evidence: evidenceOf(seed.evidence) } : {}),
    }))
    : [{ key: 'findings', availability: 'unavailable', reasons: [prevStored ? BROKEN : NOT_BUILT_REPORT], value: null }];
  return { ...envelope, previous: { from: previous.from, to: previous.to, figures: prevFigures } };
}

// ---------------------------------------------------------------------------
// Registered answers

export const answerCodeSignedQ: QaAnswerer = (ctx) => answerCodeSigned(ctx);
export const answerSecuritySignedQ: QaAnswerer = (ctx) => answerSecuritySigned(ctx);
