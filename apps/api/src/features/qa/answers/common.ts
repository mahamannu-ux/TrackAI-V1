/**
 * Shared helpers for Task19b live code answerers (T19.3).
 *
 * Every rule here comes from the session prompt §2.1: Task2 LifecycleValue
 * mapping, ratio shares, envelope fields, breakdown buckets, envelope drill-down
 * (first 20 items of the drill-down route's first page), signed-evidence links
 * and metadata-only labels. Pure functions take a loaded Task2 context plus
 * scope facts the thin answerer computed through Task2's functions; they never
 * touch the database. Scope and listing helpers live in ../drilldown.ts.
 */
import {
  audited,
  lifecycleForModel,
  lifecycleForTenant,
  loadContext,
} from '../../telemetry/task2-lifecycle-read';
import {
  calculateLifecycleScopeTotals,
  isCommittedLineReworkEvidence,
} from '../../telemetry/lifecycle';
import type { LifecycleSummary, LifecycleValue } from '../../telemetry/lifecycle';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from '../registry';
import type {
  QaAnswerContext,
  QaAnswerer,
  QaAvailability,
  QaDrilldown,
  QaEnvelope,
  QaFigure,
  QaQuestionId,
  QaReason,
  QaSignedEvidenceLink,
  QaValue,
} from '../types';
import { listDrilldownItems, pullRequestCommitIds, repositoryIdsInScope } from '../drilldown';

/** loadContext's result: the raw rows every pure function reads. */
export type QaContext = Awaited<ReturnType<typeof loadContext>>;

/** One scope's Task2 facts, computed by the thin answerer through lifecycleForTenant. */
export interface ScopeFacts {
  summary: LifecycleSummary;
  totals: { sessions: number; commits: number; finalAiLines: number; finalHumanLines: number };
  /** lifecycleForTenant(...).evidence.deployments: the deployment count. */
  deployments: number;
}

/** Per-bucket Task2 facts for a requested breakdown, same source as the scope facts. */
export interface BreakdownFacts {
  repositories: Array<{ id: string; scope: ScopeFacts }>;
  models: Array<{ key: string; tool: string; summary: LifecycleSummary }>;
}

/** Everything a pure compute function gets: no database access inside. */
export interface ComputeInput {
  context: QaContext;
  ctx: QaAnswerContext;
  /** Absent for Q13/Q18, which aggregate raw tables, and for Q14 (PR intelligence). */
  scope?: ScopeFacts;
  breakdownFacts?: BreakdownFacts;
  /** Q20 only: the previous period's facts, with the same figure keys. */
  previous?: { from: string; to: string; scope: ScopeFacts; breakdownFacts: BreakdownFacts };
}

export function periodMs(scope: { from: string; to: string }): { fromMs: number; toMs: number } {
  return { fromMs: Date.parse(scope.from), toMs: Date.parse(scope.to) };
}

export function inPeriod(value: Date | null, fromMs: number, toMs: number): boolean {
  if (!value) return false;
  const ms = value.getTime();
  return ms >= fromMs && ms <= toMs;
}

/** Task2 LifecycleValue → envelope figure core (§2.1 rule 3). Never turns null into 0. */
export function lifecycleFigure(value: LifecycleValue, reasons?: QaReason[]): {
  availability: QaAvailability; reasons: QaReason[]; value: QaValue | null;
} {
  if (value.availability === 'recorded') {
    return {
      availability: 'recorded',
      reasons: [],
      value: value.value === null ? null : { type: 'count', count: value.value },
    };
  }
  // Partial keeps Task2's availability; its free-text reason has no envelope
  // code, so the generic missing-evidence code applies unless the caller passes
  // a more specific one.
  return {
    availability: value.availability,
    reasons: reasons ?? [{ code: 'answer_not_built' }],
    value: null,
  };
}

/** A share as a ratio, never a float (§2.1 rule 5). Null when the denominator is 0 or missing. */
export function ratioFigure(numerator: number | null, denominator: number | null): QaValue | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return { type: 'ratio', numerator, denominator };
}

function sameReason(a: QaReason, b: QaReason): boolean {
  return a.code === b.code && a.gap === b.gap;
}

/** The union of figure reasons without duplicates (§2.1 rule 6). */
export function unionReasons(figures: QaFigure[]): QaReason[] {
  const out: QaReason[] = [];
  for (const figure of figures) {
    for (const reason of figure.reasons) {
      if (!out.some((seen) => sameReason(seen, reason))) out.push(reason);
    }
  }
  return out;
}

/** Questions whose live answers link to signed evidence (RP-1, §2.1 rule 9). */
const SIGNED_EVIDENCE_QUESTIONS: readonly QaQuestionId[] = ['Q1', 'Q3', 'Q9', 'Q13'];

function signedEvidence(ctx: QaAnswerContext): QaSignedEvidenceLink | undefined {
  if (!SIGNED_EVIDENCE_QUESTIONS.includes(ctx.questionId)) return undefined;
  return {
    path: '/api/attesta/statements',
    query: {
      ...(ctx.scope.repository_id ? { repository_id: ctx.scope.repository_id } : {}),
      from: ctx.scope.from,
      to: ctx.scope.to,
    },
  };
}

/**
 * Assembles the envelope (§2.1 rule 6): as_of, scope, kind live, registry
 * version, exact registry wording, worst-of availability, union reasons, and
 * the first 20 drill-down items. No kind and no subject_sha on the evidence link.
 *
 * One deviation the frozen schema forces: top-level `unavailable` means every
 * figure is unavailable (answer-v1.schema.json), so a mix of recorded and
 * unavailable figures tops out at `partial` instead of the literal worst.
 * The union reasons still name every gap.
 */
export function finishEnvelope(
  ctx: QaAnswerContext,
  context: QaContext,
  figures: QaFigure[],
  previous?: QaEnvelope['previous'],
): QaEnvelope {
  const question = QA_QUESTIONS_BY_ID.get(ctx.questionId);
  if (!question) throw new Error(`Task19b: unknown question ${ctx.questionId}`);
  // The frozen schema reads top-level `unavailable` as "every figure is
  // unavailable", so that level applies only when nothing is available; any
  // other mix with a gap tops out at `partial`.
  const availability: QaAvailability = figures.length > 0 && figures.every((figure) => figure.availability === 'unavailable')
    ? 'unavailable'
    : figures.some((figure) => figure.availability !== 'recorded') ? 'partial' : 'recorded';
  const reasons = unionReasons(figures);
  const drilldown: QaDrilldown[] = listDrilldownItems(context, ctx).slice(0, 20);
  const envelope: QaEnvelope = {
    question_id: ctx.questionId,
    registry_version: QA_REGISTRY_VERSION,
    kind: 'live',
    as_of: ctx.now,
    scope: ctx.scope,
    availability,
    reasons,
    figures,
    ...(previous ? { previous } : {}),
    wording: [...question.wording],
    drilldown,
  };
  const link = signedEvidence(ctx);
  if (link) envelope.signed_evidence = link;
  return envelope;
}

/**
 * Loads one scope's Task2 facts plus the per-bucket facts for a requested
 * breakdown. Lifecycle figures come only from Task2's functions (rule 8):
 * lifecycleForTenant for the scope and each repository bucket, and
 * lifecycleForModel on a period-filtered copy of the context for each model
 * bucket (input filtering, the same as lifecycleForTenant's inTime helper).
 */
export async function loadScopeFacts(
  tenantId: string,
  context: QaContext,
  ctx: QaAnswerContext,
): Promise<{ scope: ScopeFacts; breakdownFacts: BreakdownFacts }> {
  const filter = {
    ...(ctx.scope.repository_id ? { repositoryId: ctx.scope.repository_id } : {}),
    ...(ctx.scope.pull_request_id ? { pullRequestId: ctx.scope.pull_request_id } : {}),
    from: new Date(ctx.scope.from),
    to: new Date(ctx.scope.to),
  };
  const live = await lifecycleForTenant(tenantId, filter);
  // Null only when a contributor filter names no contributor; Task19b never
  // passes one, so this is a server-side failure (503 QA_UNAVAILABLE).
  if (!live) throw new Error('Task19b: lifecycle scope not found');
  const scope: ScopeFacts = {
    summary: live.summary,
    // lifecycleForTenant's totals are all-time, so the period share comes
    // from Task2's own totals function on period-filtered commits (below).
    totals: periodTotals(context, ctx),
    deployments: live.evidence.deployments,
  };
  const breakdownFacts: BreakdownFacts = { repositories: [], models: [] };
  if (ctx.breakdown === 'repository') {
    for (const id of repositoryIdsInScope(context, ctx)) {
      const per = await lifecycleForTenant(tenantId, { ...filter, repositoryId: id });
      if (!per) throw new Error('Task19b: lifecycle scope not found');
      const repoCtx: QaAnswerContext = { ...ctx, scope: { ...ctx.scope, repository_id: id } };
      breakdownFacts.repositories.push({
        id,
        scope: {
          summary: per.summary,
          totals: periodTotals(context, repoCtx),
          deployments: per.evidence.deployments,
        },
      });
    }
  }
  if (ctx.breakdown === 'model' || ctx.breakdown === 'tool') {
    const filtered = periodFilteredContext(context, ctx);
    for (const { key, tool } of modelKeysInScope(context, ctx)) {
      breakdownFacts.models.push({
        key,
        tool,
        summary: lifecycleForModel(filtered, key).summary,
      });
    }
  }
  return { scope, breakdownFacts };
}

type ModelRow = QaContext['modelLifecycleEvents'][number];

function modelRowInScope(context: QaContext, ctx: QaAnswerContext, row: ModelRow): boolean {
  if (ctx.scope.repository_id && row.repositoryId !== ctx.scope.repository_id) return false;
  if (ctx.scope.pull_request_id) {
    const commits = pullRequestCommitIds(context, ctx.scope.pull_request_id);
    if (row.pullRequestId !== ctx.scope.pull_request_id
      && (row.commitId === null || !commits.has(row.commitId))) return false;
  }
  if (ctx.scope.commit_sha && ctx.scope.repository_id) {
    const commit = context.commits.find((c) => c.repositoryId === ctx.scope.repository_id && c.sha === ctx.scope.commit_sha);
    if (!commit || row.commitId !== commit.id) return false;
  }
  return true;
}

/** Distinct model keys with rows in the request's scope and period, with each key's tool. */
export function modelKeysInScope(
  context: QaContext,
  ctx: QaAnswerContext,
): Array<{ key: string; tool: string }> {
  const { fromMs, toMs } = periodMs(ctx.scope);
  const rows = context.modelLifecycleEvents.filter((row) =>
    inPeriod(row.occurredAt, fromMs, toMs) && modelRowInScope(context, ctx, row));
  return [...new Set(rows.map((row) => row.modelKey))].sort().map((key) => {
    const tools = [...new Set(rows.filter((row) => row.modelKey === key).map((row) => row.tool))].sort();
    return { key, tool: tools[0] ?? 'unknown' };
  });
}

/**
 * Retained-lines totals for the request's scope *and period*.
 * lifecycleForTenant's dates reach its lifecycle rows but not its totals, so
 * the period share calls Task2's own calculateLifecycleScopeTotals directly,
 * with Task2's identical input mapping (task2-lifecycle-read.ts) plus a
 * committedAt period filter on the commits. The selection, the audited
 * corrections and the rework deduction are Task2's; only the period input
 * filter is ours — the same input filtering the prompt blesses for model rows.
 */
export function periodTotals(context: QaContext, ctx: QaAnswerContext): ScopeFacts['totals'] {
  const { fromMs, toMs } = periodMs(ctx.scope);
  const repositoryIds = ctx.scope.repository_id ? new Set([ctx.scope.repository_id]) : null;
  // PR membership selection exactly as lifecycleForTenant scopes it: the PR's
  // memberships, active only.
  const pullRequestIds = ctx.scope.pull_request_id ? new Set([ctx.scope.pull_request_id]) : null;
  const scopedMemberships = context.memberships
    .filter((row) => !pullRequestIds || pullRequestIds.has(row.pullRequestId));
  const pullRequestCommitIds = pullRequestIds
    ? new Set(scopedMemberships.filter((row) => row.active).map((row) => row.commitId))
    : null;
  const totals = calculateLifecycleScopeTotals({
    commits: context.commits
      .filter((commit) => inPeriod(commit.committedAt, fromMs, toMs))
      .map((commit) => ({
        id: commit.id,
        repositoryId: commit.repositoryId,
        reachability: commit.reachability,
        finalAiLines: audited(context.corrections, 'commit', commit.id, 'observedAiLines', commit.observedAiLines).auditedValue,
        finalHumanLines: audited(context.corrections, 'commit', commit.id, 'observedHumanLines', commit.observedHumanLines).auditedValue,
      })),
    commitSessions: context.commitSessions,
    sessionRepositories: context.sessionRepositories,
    allSessionIds: context.sessions.map((session) => session.id),
    repositoryIds,
    pullRequestCommitIds,
    contributorCommitIds: null,
    reworkRows: context.lifecycleEvents
      .filter((row) => row.stage === 'reworked' && isCommittedLineReworkEvidence(row.evidenceType))
      .map((row) => ({ commitId: row.commitId, lineCount: row.lineCount, evidenceType: row.evidenceType })),
  });
  return {
    sessions: totals.sessions,
    commits: totals.commits,
    finalAiLines: totals.finalAiLines,
    finalHumanLines: totals.finalHumanLines,
  };
}

/**
 * The period- and scope-filtered copy of the context §2.1 rule 2 blesses:
 * input filtering, the same as lifecycleForTenant's inTime helper, not a new
 * calculation. Model breakdowns stay inside the requested repository, PR or
 * commit: the same model's events elsewhere never leak in.
 */
export function periodFilteredContext(context: QaContext, ctx: QaAnswerContext): QaContext {
  const { fromMs, toMs } = periodMs(ctx.scope);
  return {
    ...context,
    modelLifecycleEvents: context.modelLifecycleEvents.filter((row) =>
      inPeriod(row.occurredAt, fromMs, toMs) && modelRowInScope(context, ctx, row)),
  };
}

/** Thin answerer: loads the context and the Task2 scope facts, then computes purely. */
export function liveAnswer(compute: (input: ComputeInput) => QaEnvelope): QaAnswerer {
  return async (ctx) => {
    const context = await loadContext(ctx.tenantId);
    const { scope, breakdownFacts } = await loadScopeFacts(ctx.tenantId, context, ctx);
    return compute({ context, ctx, scope, breakdownFacts });
  };
}

/** Thin answerer for raw-table questions (Q13, Q18): context only, no lifecycle facts. */
export function rawAnswer(compute: (input: ComputeInput) => QaEnvelope): QaAnswerer {
  return async (ctx) => {
    const context = await loadContext(ctx.tenantId);
    return compute({ context, ctx });
  };
}

/**
 * Production deployments in the request's scope and period (review fix 3).
 * Task2's evidence.deployments counts the whole repository all-time; the
 * period cut is input filtering on the same rows. No Task2 calculation maps
 * deployments to one pull request, so at PR scope the caller must answer
 * answer_not_built instead of calling this.
 */
export function deploymentsInScope(context: QaContext, ctx: QaAnswerContext): number {
  const { fromMs, toMs } = periodMs(ctx.scope);
  const repos = new Set(repositoryIdsInScope(context, ctx));
  return context.deployments.filter((row) =>
    repos.has(row.repositoryId) && inPeriod(row.deployedAt, fromMs, toMs)).length;
}
