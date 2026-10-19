/**
 * The auditor's verifiable security answers (A16.13b, Task16h; prompt item 4).
 *
 * Every figure is computed only from rows the security-finding seals cover, and
 * every recorded or partial figure carries the covering seals' ledger records
 * as evidence (the `evidenceOf` shape). The per-seal loop is the prompt's, not
 * the 31-day dashboard verifier: each seal overlapping the period is re-parsed
 * against its own columns and re-checked against the rows now in its window.
 * Any break — a changed, removed or added row inside a sealed window, or a seal
 * document that fails its own digest — makes the whole answer `unavailable`
 * with `evidence_broken`. A period whose head or tail runs past the covering
 * seal windows is `partial` with `not_sealed_yet` (only sealed rows count); a
 * period with no seal at all is `unavailable` with `not_sealed_yet`.
 *
 * The figure computations are Task19c's (security-answerers.ts) conventions
 * over a `SecurityContext` whose findings are the verified rows and whose other
 * arrays are empty. Figures that would come from those empty arrays are built
 * here instead, because a recorded 0 with nothing behind it would claim
 * "observed zero" (AGENTS.md rule 7):
 *  - S10 `machines_reporting_status` and S12 `denied_by_request`: status
 *    snapshots and enforcement decisions are not finding rows, so no seal
 *    covers them; they are `unavailable` with `answer_not_built`,
 *  - S9's `operating_system` breakdown: a platform is machine state, not a
 *    finding field, so the sealed rows bucket as `unavailable` honestly,
 *  - S15 reads the audit trail through `withAuditReader` (the auditor role,
 *    prompt item 7) and its own audit seals; the prompt's `actor_type`
 *    breakdown is impossible under the frozen registry — S15 declares no
 *    dimensions — so no breakdown is emitted (recorded in the handoff).
 *
 * Reading a verifiable answer writes no audit row (prompt item 6).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../../core/db';
import { withAuditReader } from '../../../core/db/audit-reader';
import {
  MAX_SECURITY_SEAL_ROWS, checkSecuritySealRows, parseSecuritySealDocument, readSecurityRows,
  type SecurityFindingRow as SealedRow,
} from '../../attesta/security-seal-service';
import {
  checkSealRows, parseSealDocument, readAuditRows,
  type StoredAuditRow,
} from '../../attesta/audit-seal-service';
import { usOf } from '../../attesta/security-report-rules';
import { previousPeriod } from '../service';
import { evidenceOf, type EvidenceRecordInput } from './evidence';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from '../registry';
import type { SecurityContext, SecurityFindingRow } from '../security-read';
import type {
  QaAnswerContext, QaAnswerer, QaBreakdownItem, QaDimension, QaEnvelope,
  QaFigure, QaGapId, QaReason, QaValue,
} from '../types';

type Reported = 'recorded' | 'partial' | 'unavailable';

function worstOf(availability: Reported[]): Reported {
  if (availability.length === 0 || availability.every((a) => a === 'unavailable')) return 'unavailable';
  return availability.some((a) => a !== 'recorded') ? 'partial' : 'recorded';
}

/** recorded_at holds microseconds: truncate to the envelope's millisecond form, never round-trip a Date. */
function msTime(microTime: string | null | undefined): string | null {
  if (!microTime) return null;
  return `${microTime.slice(0, 23)}Z`;
}

const count = (v: number): QaValue => ({ type: 'count', count: v });

const NOT_BUILT: QaReason[] = [{ code: 'answer_not_built' }];
const SEALED: QaReason = { code: 'not_sealed_yet' };
const BROKEN: QaReason = { code: 'evidence_broken' };
const TRUNCATED: QaReason = { code: 'evidence_truncated' };
const notCaptured = (gap: QaGapId): QaReason => ({ code: 'not_captured_yet', gap });

// ---------------------------------------------------------------------------
// Loading a period's sealed rows

/** At most this many overlapping seals are verified for one answer. */
const MAX_SEALS_VERIFIED = 1000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface VerifiedShape {
  kind: 'ok' | 'no_seals' | 'broken';
  /** The covering seals' chained ledger records: the evidence for every figure. */
  seals: Array<{ seq: number | null; statementDigest: string }>;
  /** Verified rows inside sealed windows ∩ [from, to). */
  rows: SecurityFindingRow[];
  /** Part of the period (head or tail) has no covering seal window. */
  partial: boolean;
  /** More overlapping seals than MAX_SEALS_VERIFIED: the rest stays unverified. */
  truncated: boolean;
  newestAt: string | null;
}

/**
 * A period's verified security findings. The per-seal ago loop reads each
 * seal's whole window (an added or changed row outside the answer's period is
 * still a tamper inside a sealed window) and cuts the figure rows to the
 * answer's range afterwards.
 */
async function sealedPeriod(src: SealSource, tenantId: string, from: string, to: string): Promise<VerifiedShape> {
  const fromUs = usOf(from);
  const toUs = usOf(to);
  const found = { rows: await src.findingSeals(tenantId, from, to, MAX_SEALS_VERIFIED + 1) };
  if (found.rows.length === 0) {
    return { kind: 'no_seals', seals: [], rows: [], partial: false, truncated: false, newestAt: null };
  }
  const truncated = found.rows.length > MAX_SEALS_VERIFIED;
  const verified = found.rows.slice(0, MAX_SEALS_VERIFIED);
  const seals: VerifiedShape['seals'] = [];
  const rows: SealedRow[] = [];
  for (const raw of verified) {
    const windowFrom = str(raw.window_from);
    const windowTo = str(raw.window_to);
    const rowCount = Number(raw.row_count);
    const doc = parseSecuritySealDocument({
      windowFrom, windowTo, rowCount,
      task6aCount: Number(raw.task6a_count), v2Count: Number(raw.v2_count),
      previousDigest: typeof raw.previous_digest === 'string' ? raw.previous_digest : null,
      sealDocument: str(raw.seal_document), sealDigest: str(raw.seal_digest), tenantId,
    });
    // A seal that cannot be re-parsed against its columns stands for a whole
    // window no one can prove: nothing of the answer survives that.
    if (doc === null) {
      return { kind: 'broken', seals: [], rows: [], partial: false, truncated: false, newestAt: null };
    }
    const limit = rowCount + MAX_SECURITY_SEAL_ROWS;
    const windowRows = await src.findingRows(tenantId, windowFrom, windowTo, limit);
    // Hitting the bound means more rows now than the seal lists (or a flood so
    // large the read was cut): the sealed-window invariant says unsealed rows
    // are a break, and a cut read cannot be told apart from one.
    if (windowRows.length === limit || checkSecuritySealRows(doc, str(raw.seal_digest), windowRows).length > 0) {
      return { kind: 'broken', seals: [], rows: [], partial: false, truncated: false, newestAt: null };
    }
    seals.push({ seq: typeof raw.seq === 'string' ? Number(raw.seq) : null, statementDigest: str(raw.statement_digest) });
    rows.push(...windowRows.filter((row) => row.received_at >= fromUs && row.received_at < toUs));
  }
  // The exact-µs window texts order like instants: head/tail outside them is
  // unsealed and makes the answer partial.
  const head = str((verified[0] as { window_from: string }).window_from) > fromUs;
  const tail = str((verified[verified.length - 1] as { window_to: string }).window_to) < toUs;
  return {
    kind: 'ok',
    seals,
    rows: rows.map(qaFindingOf),
    partial: head || tail,
    truncated,
    newestAt: rows.reduce<string | null>((newest, row) => (newest === null || row.received_at > newest ? row.received_at : newest), null),
  };
}

/** What the security answers read. Every call is tenant-bound. */
export interface SealSource {
  /**
   * The security-finding seals overlapping [from, to), window_from ascending, at most `limit`:
   * window texts in exact µs, the stored seal columns, and the seal's ledger seq (text, or null).
   */
  findingSeals(tenantId: string, from: string, to: string, limit: number): Promise<Array<Record<string, unknown>>>;
  /** The finding rows now in one seal window, as the sealer reads them (readSecurityRows). */
  findingRows(tenantId: string, windowFrom: string, windowTo: string, limit: number): Promise<SealedRow[]>;
  /** S15: the audit seals and rows of [from, to), each row checked against its seal. */
  auditPeriod(tenantId: string, from: string, to: string): Promise<AuditShape>;
}

/** The seal windows are stored as exact µs text (the sealer's own form), so they are selected as is. */
async function pgFindingSeals(tenantId: string, from: string, to: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const found = await db.execute(sql`select s.window_from as window_from,
      s.window_to as window_to, s.row_count::int as row_count, s.task6a_count::int as task6a_count,
      s.v2_count::int as v2_count, s.previous_digest as previous_digest, s.seal_document as seal_document,
      s.seal_digest as seal_digest, s.statement_digest as statement_digest, s.record_id::text as record_id,
      r.seq::text as seq
    from attesta_security_finding_seals s
    left join attesta_records r on r.tenant_id = s.tenant_id and r.id = s.record_id
    where s.tenant_id = ${tenantId}::uuid
      and s.window_from::timestamptz < ${to}::timestamptz and s.window_to::timestamptz > ${from}::timestamptz
    order by s.window_from limit ${limit}`);
  return found.rows;
}

export const pgSealSource: SealSource = {
  findingSeals: pgFindingSeals,
  findingRows: (tenantId, windowFrom, windowTo, limit) => readSecurityRows(db, tenantId, windowFrom, windowTo, limit),
  auditPeriod: (tenantId, from, to) => auditSealPeriod(tenantId, from, to),
};

/** The verified attesta rows, mapped to Task19's metadata allowlist (never a preview column). */
function qaFindingOf(row: SealedRow): SecurityFindingRow {
  const generation = row.record_generation === 'v2' ? 'v2' as const : 'task6a' as const;
  return {
    id: row.id,
    generation,
    ruleId: row.rule_id,
    ruleCategory: row.rule_category,
    ruleSeverity: row.rule_severity,
    repositoryId: row.repository_id,
    repositoryKind: row.repository_kind === 'not_enrolled' ? 'not_enrolled' : row.repository_kind === 'enrolled' ? 'enrolled' : null,
    machineId: row.machine_id,
    sessionId: row.session_id,
    occurredAt: new Date(row.occurred_at),
    rulePackVersion: row.rule_pack_version,
    agent: generation === 'v2' ? row.source_agent : row.agent_family,
    model: generation === 'v2' ? row.model : null,
    phase: row.phase,
    resultCategory: row.result_category,
  };
}

// ---------------------------------------------------------------------------
// The envelope

type Seed = {
  key: string;
  availability: Reported;
  reasons: QaReason[];
  value: QaValue | null;
  breakdown?: QaBreakdownItem[];
};

/**
 * The verifiable envelope: Task19c's figures with the kind, the verified
 * evidence and the coverage reasons. When kind is not ok, every figure is
 * unavailable with the one reason (no seal, or evidence_broken) and the query
 * time stands as as_of (no trusted input). A figure a compute marks
 * `unavailable` stays unavailable; a recorded or partial figure under a partial
 * period becomes partial with `not_sealed_yet` added.
 */
function verifiedEnvelope(ctx: QaAnswerContext, shape: VerifiedShape, seeds: Seed[]): QaEnvelope {
  const question = QA_QUESTIONS_BY_ID.get(ctx.questionId);
  if (!question) throw new Error(`Task16h: unknown question ${ctx.questionId}`);
  const evidenceRecords = shape.seals.flatMap((seal) => (seal.seq === null ? [] : [{ seq: seal.seq, digest: seal.statementDigest }]));
  const figures: QaFigure[] = shape.kind !== 'ok'
    ? seeds.map((seed): QaFigure => ({
      key: seed.key,
      availability: 'unavailable',
      reasons: [shape.kind === 'broken' ? BROKEN : SEALED],
      value: null,
    }))
    : seeds.map((seed): QaFigure => {
      const coveragePartial = (shape.partial || shape.truncated) && seed.availability !== 'unavailable';
      return {
        key: seed.key,
        availability: coveragePartial ? 'partial' : seed.availability,
        reasons: coveragePartial
          ? [...seed.reasons, ...(shape.partial ? [SEALED] : []), ...(shape.truncated ? [TRUNCATED] : [])]
          : seed.reasons,
        value: seed.value,
        ...(seed.breakdown && seed.breakdown.length > 0 ? { breakdown: seed.breakdown } : {}),
        // Evidence backs a value; an unavailable figure has none to back.
        ...(seed.availability !== 'unavailable' ? { evidence: evidenceOf(evidenceRecords) } : {}),
      };
    });
  const reasons: QaReason[] = [];
  for (const figure of figures) {
    for (const reason of figure.reasons) {
      if (!reasons.some((r) => r.code === reason.code && r.gap === reason.gap)) reasons.push(reason);
    }
  }
  return {
    question_id: ctx.questionId,
    registry_version: QA_REGISTRY_VERSION,
    kind: 'verifiable',
    as_of: shape.kind === 'ok' ? msTime(shape.newestAt) ?? ctx.now : ctx.now,
    scope: ctx.scope,
    availability: worstOf(figures.map((f) => f.availability)),
    reasons,
    figures,
    wording: [...question.wording],
    drilldown: [],
  };
}

// ---------------------------------------------------------------------------
// Local figure helpers (the same shape Task19c's computes work in)

/** Repository scope: the only non-tenant scope a security question accepts. */
function scoped(ctx: QaAnswerContext, findings: SecurityFindingRow[]): SecurityFindingRow[] {
  const repositoryId = ctx.scope.repository_id;
  return repositoryId ? findings.filter((row) => row.repositoryId === repositoryId) : findings;
}

/** One count per bucket key, sorted, for the requested dimension (Task19c's tally). */
function tally(dimension: QaDimension, rows: SecurityFindingRow[], bucket: (row: SecurityFindingRow) => string): QaBreakdownItem[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = bucket(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, n]) => ({ dimension, key, value: { type: 'count' as const, count: n } }));
}

/** Distinct values (not rows) per bucket key, sorted (Task19c's distinctPerBucket). */
function distinctPerBucket(
  dimension: QaDimension,
  rows: SecurityFindingRow[],
  bucket: (row: SecurityFindingRow) => string,
  value: (row: SecurityFindingRow) => string,
): QaBreakdownItem[] {
  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = bucket(row);
    const set = sets.get(key) ?? new Set<string>();
    set.add(value(row));
    sets.set(key, set);
  }
  return [...sets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, set]) => ({ dimension, key, value: { type: 'count' as const, count: set.size } }));
}

const repositoryBucket = (row: SecurityFindingRow): string => row.repositoryId ?? 'unknown';

const plainCount = (seed: Pick<Seed, 'key'>, n: number, breakdown: QaBreakdownItem[] = []): Seed => ({
  ...seed,
  availability: 'recorded',
  reasons: [],
  value: count(n),
  ...(breakdown.length > 0 ? { breakdown } : {}),
});

// ---------------------------------------------------------------------------
// Registered answers

export const answerS1: QaAnswerer = (ctx) => answerS1v(pgSealSource, ctx);
export const answerS7: QaAnswerer = (ctx) => answerS7v(pgSealSource, ctx);
export const answerS8: QaAnswerer = (ctx) => answerS8v(pgSealSource, ctx);
export const answerS9: QaAnswerer = (ctx) => answerS9v(pgSealSource, ctx);
export const answerS10: QaAnswerer = (ctx) => answerS10v(pgSealSource, ctx);
export const answerS11: QaAnswerer = (ctx) => answerS11v(pgSealSource, ctx);
export const answerS12: QaAnswerer = (ctx) => answerS12v(pgSealSource, ctx);
export const answerS15: QaAnswerer = (ctx) => answerS15v(pgSealSource, ctx);

// S1: the register of high or critical findings (a new compute: the registry's
// S1 figure list differs from the live answer_not_built default).

async function answerS1v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const severe = scoped(ctx, load.rows).filter((row) => row.ruleSeverity === 'high' || row.ruleSeverity === 'critical');
  const breakdown =
    ctx.breakdown === 'rule' ? tally('rule', severe, (row) => row.ruleId)
      : ctx.breakdown === 'rule_category' ? tally('rule_category', severe, (row) => row.ruleCategory)
        : ctx.breakdown === 'severity' ? tally('severity', severe, (row) => row.ruleSeverity)
          : ctx.breakdown === 'repository' ? tally('repository', severe, repositoryBucket)
            : [];
  return verifiedEnvelope(ctx, load, [{
    key: 'high_or_critical_findings',
    // The count is of tokens on the rows; the taxonomy itself is not proven
    // complete, so G9 (rule coverage) is named even when recorded (prompt item 4).
    availability: 'recorded',
    reasons: [notCaptured('G9')],
    value: count(severe.length),
    ...(breakdown.length > 0 ? { breakdown } : {}),
  }]);
}

// S7: repositories most affected, versus the previous period. The previous
// window gets its own seal check, evidence and figure (prompt item 4).

function findingsFigure(ctx: QaAnswerContext, rows: SecurityFindingRow[]): Seed {
  const breakdown =
    ctx.breakdown === 'repository' ? tally('repository', rows, repositoryBucket)
      : ctx.breakdown === 'rule_category' ? tally('rule_category', rows, (row) => row.ruleCategory)
        : ctx.breakdown === 'severity' ? tally('severity', rows, (row) => row.ruleSeverity)
          : [];
  return plainCount({ key: 'findings' }, rows.length, breakdown);
}

async function answerS7v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const { from, to } = previousPeriod(ctx.scope);
  const [current, previous] = await Promise.all([
    sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to),
    sealedPeriod(src, ctx.tenantId, from, to),
  ]);
  const envelope = verifiedEnvelope(ctx, current, [findingsFigure(ctx, current.rows)]);
  if (previous.kind === 'ok') {
    return {
      ...envelope,
      previous: {
        from, to,
        figures: [{
          key: 'findings',
          availability: previous.partial || previous.truncated ? 'partial' : 'recorded',
          reasons: previous.partial ? [SEALED] : previous.truncated ? [TRUNCATED] : [],
          value: count(previous.rows.length),
          evidence: evidenceOf(previous.seals.flatMap((seal) => (seal.seq === null ? [] : [{ seq: seal.seq, digest: seal.statementDigest }]))),
        }],
      },
    };
  }
  // No previous seal (or a broken one): the previous figure says so honestly —
  // it does not drag the current answer down with it.
  return {
    ...envelope,
    previous: {
      from, to,
      figures: [{ key: 'findings', availability: 'unavailable', reasons: [previous.kind === 'broken' ? BROKEN : SEALED], value: null }],
    },
  };
}

// S8: agents and models (pure metadata of the verified rows).

async function answerS8v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const findings = scoped(ctx, load.rows);
  const breakdown =
    ctx.breakdown === 'agent_family' ? tally('agent_family', findings, (row) => row.agent ?? 'unknown')
      : ctx.breakdown === 'model' ? tally('model', findings, (row) => row.model ?? 'unknown')
        : [];
  return verifiedEnvelope(ctx, load, [
    plainCount({ key: 'findings' }, findings.length, breakdown),
    // The session link (S8's wording says session_link_partial) is not sealed
    // evidence; the live linkage figure has no key here and stays out.
  ]);
}

// S9: platforms and categories. A platform is machine state, not a finding
// field, so it is not part of the seals: the operating_system buckets read
// `unavailable` over the sealed evidence, the rule_category totals are computed.

async function answerS9v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const breakdown = ctx.breakdown === 'rule_category'
    ? tally('rule_category', load.rows, (row) => row.ruleCategory)
    : ctx.breakdown === 'operating_system'
      ? tally('operating_system', load.rows, () => 'unavailable')
      : [];
  return verifiedEnvelope(ctx, load, [plainCount({ key: 'findings' }, load.rows.length, breakdown)]);
}

// S10: rule packs and machines. Status snapshots are not finding rows, so no
// seal covers the reporting status: those two figures are unavailable rather
// than zeros read from an empty array (the honest-state rule).

async function answerS10v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const findings = scoped(ctx, load.rows);
  const versions = new Set(findings.map((row) => row.rulePackVersion));
  const machineBreakdown = ctx.breakdown === 'machine'
    ? distinctPerBucket('machine', findings, (row) => row.machineId, (row) => row.rulePackVersion)
    : [];
  return verifiedEnvelope(ctx, load, [
    plainCount({ key: 'rule_pack_versions_in_force' }, versions.size, machineBreakdown),
    { key: 'machines_reporting_status', availability: 'unavailable', reasons: NOT_BUILT, value: null },
    { key: 'machines_up_to_date', availability: 'unavailable', reasons: [notCaptured('G7')], value: null },
  ]);
}

// S11: requested actions versus confirmed observed results (Task6.a phases).

async function answerS11v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const findings = scoped(ctx, load.rows);
  const requested = findings.filter((row) => row.generation === 'task6a' && row.phase === 'requested');
  const observed = findings.filter((row) => row.generation === 'task6a' && row.phase === 'observed_result');
  const v2 = findings.filter((row) => row.generation === 'v2');
  const byRule = (rows: SecurityFindingRow[]): QaBreakdownItem[] =>
    ctx.breakdown === 'rule' ? tally('rule', rows, (row) => row.ruleId) : [];
  return verifiedEnvelope(ctx, load, [
    plainCount({ key: 'requested' }, requested.length, byRule(requested)),
    plainCount({ key: 'observed_result' }, observed.length, byRule(observed)),
    plainCount({ key: 'v2_unclassified' }, v2.length, byRule(v2)),
  ]);
}

// S12: blocked or prevented. The seals hold finding rows, not enforcement
// decisions: the request count is unavailable here rather than an unobserved 0,
// and the policy versions come from the verified rows' rule packs.

async function answerS12v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const load = await sealedPeriod(src, ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const findings = scoped(ctx, load.rows);
  const versions = new Set(findings.map((row) => row.rulePackVersion));
  const repositoryBreakdown = ctx.breakdown === 'repository'
    ? distinctPerBucket('repository', findings, repositoryBucket, (row) => row.rulePackVersion)
    : [];
  return verifiedEnvelope(ctx, load, [
    { key: 'denied_by_request', availability: 'unavailable', reasons: NOT_BUILT, value: null },
    { key: 'blocked', availability: 'unavailable', reasons: NOT_BUILT, value: null },
    plainCount({ key: 'policy_versions' }, versions.size, repositoryBreakdown),
  ]);
}

// ---------------------------------------------------------------------------
// S15: the audit trail, under the auditor database role (prompt item 7)

export interface AuditSeal {
  recordId: string;
  statementDigest: string;
  windowFrom: string;
  windowTo: string;
  seq: number | null;
}

export interface AuditShape {
  kind: 'ok' | 'no_seals' | 'broken';
  seals: AuditSeal[];
  rows: Array<{ row: StoredAuditRow; seal: AuditSeal }>;
  partial: boolean;
  truncated: boolean;
  newestAt: string | null;
}

type AuditSeed = { key: string; availability: Reported; reasons: QaReason[]; value: QaValue | null };

/**
 * The audit seals and their rows, selected under `trackai_audit_reader` inside
 * one read-only transaction; each row is checked against its seal document
 * (`auditRowDigest`, exact microsecond `occurred_at`). The seal ledger records
 * (seq, statement_digest) live in `attesta_records`, which the audit reader
 * must not select, so the seqs are joined after the role reset, in the same
 * transaction, on the ordinary API role.
 */
async function auditSealPeriod(tenantId: string, from: string, to: string): Promise<AuditShape> {
  const fromUs = usOf(from);
  const toUs = usOf(to);
  return db.transaction(async (tx) => {
    const inner = await withAuditReader(tx, tenantId, async (reader) => {
      const found = await reader.execute(sql`select s.window_from as window_from,
          s.window_to as window_to, s.row_count::int as row_count,
          s.previous_digest as previous_digest, s.seal_document as seal_document, s.seal_digest as seal_digest,
          s.statement_digest as statement_digest, s.record_id::text as record_id
        from attesta_audit_seals s
        where s.tenant_id = ${tenantId}::uuid
          and s.window_from::timestamptz < ${to}::timestamptz and s.window_to::timestamptz > ${from}::timestamptz
        order by s.window_from limit ${MAX_SEALS_VERIFIED + 1}`);
      if (found.rows.length === 0) {
        return { kind: 'no_seals' as const, seals: [] as AuditSeal[], rows: [] as AuditShape['rows'], partial: false, truncated: false, newestAt: null };
      }
      const truncated = found.rows.length > MAX_SEALS_VERIFIED;
      const seals: AuditSeal[] = [];
      const rows: AuditShape['rows'] = [];
      for (const raw of found.rows.slice(0, MAX_SEALS_VERIFIED)) {
        const windowFrom = str(raw.window_from);
        const windowTo = str(raw.window_to);
        const rowCount = Number(raw.row_count);
        const doc = parseSealDocument({
          windowFrom, windowTo, rowCount,
          previousDigest: typeof raw.previous_digest === 'string' ? raw.previous_digest : null,
          sealDocument: str(raw.seal_document), sealDigest: str(raw.seal_digest), tenantId,
        });
        if (doc === null) {
          return { kind: 'broken' as const, seals: [] as AuditSeal[], rows: [] as AuditShape['rows'], partial: false, truncated: false, newestAt: null };
        }
        // Late audit rows in a sealed window are a break as for findings; the
        // small margin lets the read see the unsealed rows so the check
        // reports them itself.
        const limit = rowCount + 5_000;
        const windowRows = await readAuditRows(reader, tenantId, windowFrom, windowTo, limit);
        if (windowRows.length === limit || checkSealRows(doc, str(raw.seal_digest), windowRows).length > 0) {
          return { kind: 'broken' as const, seals: [] as AuditSeal[], rows: [] as AuditShape['rows'], partial: false, truncated: false, newestAt: null };
        }
        const seal: AuditSeal = { recordId: str(raw.record_id), statementDigest: str(raw.statement_digest), windowFrom, windowTo, seq: null };
        seals.push(seal);
        rows.push(...windowRows
          .filter((row) => row.occurred_at >= fromUs && row.occurred_at < toUs)
          .map((row) => ({ row, seal })));
      }
      const partial = seals[0].windowFrom > fromUs || seals[seals.length - 1].windowTo < toUs;
      const newestAt = rows.reduce<string | null>(
        (newest, { row }) => (newest === null || row.occurred_at > newest ? row.occurred_at : newest), null);
      return { kind: 'ok' as const, seals, rows, partial, truncated, newestAt };
    });
    // Back on the API role (the role reset ran in withAuditReader's finally):
    // the seals' ledger positions. A record gone behind the guards gives no
    // seq, and its seal still figures in the evidence with only its digest.
    let seals = inner.seals;
    if (seals.length > 0) {
      const ledger = await tx.execute(sql`select r.id::text as id, r.seq::text as seq
        from attesta_records r where r.tenant_id = ${tenantId}::uuid
          and r.id in (${sql.join(seals.map((s) => sql`${s.recordId}::uuid`), sql.raw(', '))})`);
      const seqById = new Map(ledger.rows.map((r: Record<string, unknown>) => [str(r.id), str(r.seq)]));
      seals = seals.map((s) => ({ ...s, seq: seqById.has(s.recordId) ? Number(seqById.get(s.recordId)) : null }));
    }
    return { ...inner, seals };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/**
 * S15's figures: the two counts the prompt names. The `actor_type` breakdown
 * of the prompt is impossible under the frozen registry (S15 declares no
 * dimensions), so no breakdown is emitted (handoff, contract-forced).
 */
async function answerS15v(src: SealSource, ctx: QaAnswerContext): Promise<QaEnvelope> {
  const shape = await src.auditPeriod(ctx.tenantId, ctx.scope.from, ctx.scope.to);
  const seeds: AuditSeed[] = [
    { key: 'security_findings_reads', availability: 'recorded', reasons: [], value: count(shape.rows.filter(({ row }) => row.action === 'security_findings.read').length) },
    { key: 'raw_evidence_reveals', availability: 'recorded', reasons: [], value: count(shape.rows.filter(({ row }) => row.action === 'evidence.raw.read').length) },
  ];
  return verifiedEnvelope(
    ctx,
    {
      kind: shape.kind,
      seals: shape.seals,
      rows: [],
      partial: shape.partial,
      truncated: shape.truncated,
      newestAt: shape.newestAt,
    },
    seeds,
  );
}

/** The eight verifiable security answerers over one data source (the tests' seam). */
export function securityVerifiableAnswerers(src: SealSource): Record<'S1' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S15', QaAnswerer> {
  return {
    S1: (ctx) => answerS1v(src, ctx),
    S7: (ctx) => answerS7v(src, ctx),
    S8: (ctx) => answerS8v(src, ctx),
    S9: (ctx) => answerS9v(src, ctx),
    S10: (ctx) => answerS10v(src, ctx),
    S11: (ctx) => answerS11v(src, ctx),
    S12: (ctx) => answerS12v(src, ctx),
    S15: (ctx) => answerS15v(src, ctx),
  };
}
