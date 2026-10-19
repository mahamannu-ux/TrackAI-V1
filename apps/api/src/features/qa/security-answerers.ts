/**
 * Security live answerers (Task19c, T19.4): S5, S6, S7, S8, S9, S10, S11, S12,
 * S15, S17, S18 and Q11, registered for kind `live`.
 *
 * Every figure is metadata only, every answer is worded `monitor_only_observed`
 * (the registry adds it) and nothing is ever called "blocked" without an
 * enforcement `deny` — and even then it is "denied by request". S1, S2, S3, S4,
 * S13, S14 and S16 stay `answer_not_built` until their gaps close.
 *
 * The pure `computeSn` functions read the SecurityContext built by
 * security-read.ts (plus Task2's context for the S6/Q11 session link) and never
 * touch the database. The thin answerers load the context(s).
 *
 * Two deviations from the session prompt, both forced by the frozen contract
 * (docs/contracts/qa/, never edited) and recorded in the handoff:
 * - §2.1 item 4 asks for a `not_enrolled` repository bucket; envelope.ts
 *   `bucketKeyOk` allows a repository bucket to be a UUID or `unknown` only, so
 *   a v2 null-repository row buckets as `unknown`.
 * - §2.2 asks `blocked` to carry reason `monitor_only_observed`, which is a
 *   wording code, not a reason code; the figure is `unavailable` with
 *   `answer_not_built` and the wording carries `monitor_only_observed`.
 *
 * Security answers carry no drill-down: a repository/PR/commit listing is not a
 * drill-down of a security answer, and the drill-down route still answers 501
 * for S questions, so an empty list stays consistent with it.
 */
import { commitsInScope } from './drilldown';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from './registry';
import { previousPeriod } from './service';
import { unionReasons, type QaContext } from './answers/common';
import { loadContext, pullRequestIntelligence } from '../telemetry/task2-lifecycle-read';
import { registerAnswerer } from './answerers';
import { loadSecurityContext, type SecurityContext, type SecurityFindingRow } from './security-read';
import type {
  QaAnswerContext,
  QaAnswerer,
  QaAvailability,
  QaBreakdownItem,
  QaDimension,
  QaEnvelope,
  QaFigure,
  QaGapId,
  QaReason,
} from './types';

/** What a security compute function reads; `context` is Task2's, for S6 and Q11 only. */
export interface SecurityInput {
  ctx: QaAnswerContext;
  security: SecurityContext;
  previous?: SecurityContext;
  context?: QaContext;
}

const NOT_BUILT: QaReason[] = [{ code: 'answer_not_built' }];
const notCaptured = (gap: QaGapId): QaReason[] => [{ code: 'not_captured_yet', gap }];

function countFigure(key: string, count: number, breakdown?: QaBreakdownItem[]): QaFigure {
  return {
    key,
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count },
    ...(breakdown && breakdown.length > 0 ? { breakdown } : {}),
  };
}

/** A partial figure must carry a value: the frozen schema refuses a null outside `unavailable`. */
function partialCountFigure(key: string, count: number, reasons: QaReason[], breakdown?: QaBreakdownItem[]): QaFigure {
  return {
    key,
    availability: 'partial',
    reasons,
    value: { type: 'count', count },
    ...(breakdown && breakdown.length > 0 ? { breakdown } : {}),
  };
}

function unavailableFigure(key: string, reasons: QaReason[] = NOT_BUILT): QaFigure {
  return { key, availability: 'unavailable', reasons, value: null };
}

/** One count per bucket key, sorted, for the requested dimension. */
function tally(dimension: QaDimension, rows: SecurityFindingRow[], bucket: (row: SecurityFindingRow) => string): QaBreakdownItem[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = bucket(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => ({ dimension, key, value: { type: 'count' as const, count } }));
}

/** Distinct values per bucket key, sorted, as the *number of values* per key. */
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

/** The only repository bucket key the frozen validator accepts besides a UUID. */
const repositoryBucket = (row: SecurityFindingRow): string => row.repositoryId ?? 'unknown';

/**
 * Findings cut to the requested repository scope. Every S question's only
 * non-tenant scope is `repository` (the registry), and a v2 `not_enrolled` row
 * (null repository) is never part of a repository's answer. Q11 is scoped by
 * its session link (commitsInScope) instead.
 */
function scopedFindings(ctx: QaAnswerContext, findings: SecurityFindingRow[]): SecurityFindingRow[] {
  const repositoryId = ctx.scope.repository_id;
  return repositoryId ? findings.filter((row) => row.repositoryId === repositoryId) : findings;
}

const distinct = <T>(rows: T[], key: (row: T) => string): Set<string> => new Set(rows.map(key));

function finishSecurity(ctx: QaAnswerContext, figures: QaFigure[], previous?: QaEnvelope['previous']): QaEnvelope {
  const question = QA_QUESTIONS_BY_ID.get(ctx.questionId);
  if (!question) throw new Error(`Task19c: unknown question ${ctx.questionId}`);
  const availability: QaAvailability = figures.length > 0 && figures.every((figure) => figure.availability === 'unavailable')
    ? 'unavailable'
    : figures.some((figure) => figure.availability !== 'recorded') ? 'partial' : 'recorded';
  return {
    question_id: ctx.questionId,
    registry_version: QA_REGISTRY_VERSION,
    kind: 'live',
    as_of: ctx.now,
    scope: ctx.scope,
    availability,
    reasons: unionReasons(figures),
    figures,
    ...(previous ? { previous } : {}),
    wording: [...question.wording],
    drilldown: [],
  };
}

// --- S7: repositories most affected, by category and severity, vs the previous period ---

export function computeS7(input: SecurityInput): QaEnvelope {
  const { ctx, security, previous } = input;
  const breakdownFor = (rows: SecurityFindingRow[]): QaBreakdownItem[] => {
    if (ctx.breakdown === 'repository') return tally('repository', rows, repositoryBucket);
    if (ctx.breakdown === 'rule_category') return tally('rule_category', rows, (row) => row.ruleCategory);
    if (ctx.breakdown === 'severity') return tally('severity', rows, (row) => row.ruleSeverity);
    return [];
  };
  const figure = countFigure('findings', security.findings.length, breakdownFor(security.findings));
  const previousRows = previous?.findings ?? [];
  const { from, to } = previousPeriod(ctx.scope);
  return finishSecurity(ctx, [figure], { from, to, figures: [countFigure('findings', previousRows.length, breakdownFor(previousRows))] });
}

// --- S8: which agent/tool and which model produced the most findings ---

export function computeS8(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const findings = scopedFindings(ctx, security.findings);
  const breakdown = ctx.breakdown === 'agent_family'
    ? tally('agent_family', findings, (row) => row.agent ?? 'unknown')
    : ctx.breakdown === 'model'
      ? tally('model', findings, (row) => row.model ?? 'unknown')
      : [];
  return finishSecurity(ctx, [countFigure('findings', findings.length, breakdown)]);
}

// --- S9: which platforms produced the most findings, and in which categories ---

export function computeS9(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  if (ctx.breakdown === 'rule_category') {
    return finishSecurity(ctx, [
      countFigure('findings', security.findings.length, tally('rule_category', security.findings, (row) => row.ruleCategory)),
    ]);
  }
  if (ctx.breakdown === 'operating_system') {
    // A machine with no platform row buckets as `unavailable`; a platform
    // outside macOS makes the figure `partial` with `not_monitored` (D6.2).
    const breakdown = tally('operating_system', security.findings, (row) =>
      security.machinePlatforms.get(row.machineId) ?? 'unavailable');
    const nonMac = security.findings.some((row) => {
      const platform = security.machinePlatforms.get(row.machineId);
      return platform !== undefined && platform !== null && platform !== 'macos';
    });
    const figure = nonMac
      ? partialCountFigure('findings', security.findings.length, [{ code: 'not_monitored' }], breakdown)
      : countFigure('findings', security.findings.length, breakdown);
    return finishSecurity(ctx, [figure]);
  }
  return finishSecurity(ctx, [countFigure('findings', security.findings.length)]);
}

// --- S10: rule-pack versions in force, machines reporting status, up-to-date (G7) ---

export function computeS10(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const findings = scopedFindings(ctx, security.findings);
  const versions = distinct(findings, (row) => row.rulePackVersion);
  const reporting = distinct(security.statusSnapshots, (row) => row.machineId);
  const machineBreakdown = ctx.breakdown === 'machine'
    ? distinctPerBucket('machine', findings, (row) => row.machineId, (row) => row.rulePackVersion)
    : [];
  return finishSecurity(ctx, [
    countFigure('rule_pack_versions_in_force', versions.size, machineBreakdown),
    countFigure('machines_reporting_status', reporting.size),
    unavailableFigure('machines_up_to_date', notCaptured('G7')),
  ]);
}

// --- S11: confirmed outcomes vs requested-only actions ---

export function computeS11(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const findings = scopedFindings(ctx, security.findings);
  const requested = findings.filter((row) => row.generation === 'task6a' && row.phase === 'requested');
  const observed = findings.filter((row) => row.generation === 'task6a' && row.phase === 'observed_result');
  const v2 = findings.filter((row) => row.generation === 'v2');
  const byRule = (rows: SecurityFindingRow[]): QaBreakdownItem[] =>
    ctx.breakdown === 'rule' ? tally('rule', rows, (row) => row.ruleId) : [];
  return finishSecurity(ctx, [
    countFigure('requested', requested.length, byRule(requested)),
    countFigure('observed_result', observed.length, byRule(observed)),
    countFigure('v2_unclassified', v2.length, byRule(v2)),
  ]);
}

// --- S12: was anything blocked, and under which policy version ---

export function computeS12(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const findings = scopedFindings(ctx, security.findings);
  // An enforcement decision carries no repository, so a repository-scoped answer
  // counts only decisions observed on machines that raised findings there.
  const machines = new Set(findings.map((row) => row.machineId));
  const denied = security.enforcement.filter(
    (row) => row.decision === 'deny' && (!ctx.scope.repository_id || machines.has(row.machineId)),
  ).length;
  const versions = distinct(findings, (row) => row.rulePackVersion);
  const repositoryBreakdown = ctx.breakdown === 'repository'
    ? distinctPerBucket('repository', findings, repositoryBucket, (row) => row.rulePackVersion)
    : [];
  return finishSecurity(ctx, [
    countFigure('denied_by_request', denied),
    unavailableFigure('blocked', NOT_BUILT),
    countFigure('policy_versions', versions.size, repositoryBreakdown),
  ]);
}

// --- S17: machines (or teams) with repeated findings ---

export function computeS17(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  if (ctx.breakdown === 'team') {
    // No team entity exists anywhere (TASK19.md §3.1): honest, not a zero.
    return finishSecurity(ctx, [unavailableFigure('findings', NOT_BUILT)]);
  }
  const findings = scopedFindings(ctx, security.findings);
  const breakdown = ctx.breakdown === 'machine'
    ? tally('machine', findings, (row) => row.machineId)
    : [];
  return finishSecurity(ctx, [countFigure('findings', findings.length, breakdown)]);
}

// --- S18: which rules fire most; noisy rules need triage state (G13) ---

export function computeS18(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const breakdown = ctx.breakdown === 'rule' ? tally('rule', security.findings, (row) => row.ruleId) : [];
  return finishSecurity(ctx, [
    countFigure('findings', security.findings.length, breakdown),
    unavailableFigure('noisy_rules', notCaptured('G13')),
  ]);
}

// --- S5: findings with a session; the commit and PR chain (G10) ---

export function computeS5(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const linkedIds = new Set(security.sessions.map((session) => session.externalSessionId));
  const withSession = scopedFindings(ctx, security.findings).filter((row) => row.sessionId !== null);
  const linked = withSession.filter((row) => linkedIds.has(row.sessionId as string));
  return finishSecurity(ctx, [
    countFigure('findings_with_session', withSession.length),
    countFigure('linked_sessions', distinct(linked, (row) => row.sessionId as string).size),
    unavailableFigure('commits_and_pull_requests', notCaptured('G10')),
  ]);
}

// --- S6: high/critical findings whose session reached a merged PR ---

export function computeS6(input: SecurityInput): QaEnvelope {
  const { ctx, security, context } = input;
  const sessionsOnMergedPrs = new Set<string>();
  if (context) {
    for (const pr of context.pullRequests) {
      if (pr.mergedAt === null && pr.state !== 'merged') continue;
      if (ctx.scope.repository_id && pr.repositoryId !== ctx.scope.repository_id) continue;
      for (const session of pullRequestIntelligence(context, pr.id)?.sessions ?? []) {
        sessionsOnMergedPrs.add(session.externalSessionId);
      }
    }
  }
  const severe = scopedFindings(ctx, security.findings).filter((row) =>
    (row.ruleSeverity === 'high' || row.ruleSeverity === 'critical')
    && row.sessionId !== null && sessionsOnMergedPrs.has(row.sessionId));
  const breakdown = ctx.breakdown === 'repository'
    ? tally('repository', severe, repositoryBucket)
    : ctx.breakdown === 'severity'
      ? tally('severity', severe, (row) => row.ruleSeverity)
      : [];
  return finishSecurity(ctx, [countFigure('high_or_critical_sessions_merged', severe.length, breakdown)]);
}

// --- S15: who looked at findings (audit trail): a link-only placeholder ---

export function computeS15(input: SecurityInput): QaEnvelope {
  return finishSecurity(input.ctx, [unavailableFigure('audit_reads', NOT_BUILT)]);
}

// --- Q11: did the AI sessions behind this code raise security findings ---

export function computeQ11(input: SecurityInput): QaEnvelope {
  const { ctx, security, context } = input;
  const externalSessionIds = new Set<string>();
  if (context) {
    const inScope = new Set(commitsInScope(context, ctx).map((commit) => commit.id));
    const sessionIds = new Set(context.commitSessions
      .filter((link) => inScope.has(link.commitId))
      .map((link) => link.sessionId));
    for (const session of context.sessions) {
      if (sessionIds.has(session.id)) externalSessionIds.add(session.externalSessionId);
    }
  }
  const findings = security.findings.filter((row) =>
    row.sessionId !== null && externalSessionIds.has(row.sessionId));
  const breakdown = ctx.breakdown === 'rule_category'
    ? tally('rule_category', findings, (row) => row.ruleCategory)
    : ctx.breakdown === 'severity'
      ? tally('severity', findings, (row) => row.ruleSeverity)
      : ctx.breakdown === 'repository'
        ? tally('repository', findings, repositoryBucket)
        : [];
  return finishSecurity(ctx, [countFigure('findings_in_linked_sessions', findings.length, breakdown)]);
}

// --- Numbat questions: content-free counts only ---

export function computeS26({ ctx, security }: SecurityInput): QaEnvelope {
  const events = security.permissionEvents;
  const byOutcome = (outcome: string) => events.filter((row) => row.outcome === outcome);
  const count = (key: string, rows: typeof events): QaFigure => countFigure(key, rows.length,
    ctx.breakdown === 'agent_family'
      ? [...new Set(rows.map((row) => row.sourceAgent))].sort().map((key) => ({
        dimension: 'agent_family', key, value: { type: 'count', count: rows.filter((row) => row.sourceAgent === key).length },
      })) : []);
  const approved = byOutcome('approved');
  const denied = byOutcome('denied');
  const findingSessions = new Set(security.findings
    .filter((row) => row.generation === 'v2' && row.sessionId !== null)
    .map((row) => `${row.machineId}\u0000${row.sessionId}`));
  const joined = new Set(approved
    .filter((row) => row.sessionId !== null && findingSessions.has(`${row.machineId}\u0000${row.sessionId}`))
    .map((row) => `${row.machineId}\u0000${row.sessionId}`));
  return finishSecurity(ctx, [
    count('permission_requested', byOutcome('requested')),
    count('permission_approved', approved),
    count('permission_denied', denied),
    approved.length + denied.length === 0
      ? unavailableFigure('approval_rate', [{ code: 'zero_denominator' }])
      : { key: 'approval_rate', availability: 'recorded', reasons: [],
        value: { type: 'ratio', numerator: approved.length, denominator: approved.length + denied.length } },
    partialCountFigure('sessions_with_finding_and_approval', joined.size, [{ code: 'partial_linkage' }]),
  ]);
}

/** Settings at the period start plus every change through the end. Missing history is off. */
function urlsCoverage(security: SecurityContext, from: string, to: string): 'off' | 'partial' | 'on' {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const versions = [...security.dataSettings].filter((row) => row.createdAt.getTime() <= end)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.version - b.version);
  let current = false;
  for (const row of versions) {
    if (row.createdAt.getTime() <= start) current = row.urls;
  }
  let everOn = current;
  let everOff = !current;
  for (const row of versions) {
    if (row.createdAt.getTime() <= start) continue;
    current = row.urls;
    everOn ||= current;
    everOff ||= !current;
  }
  return !everOn ? 'off' : everOff ? 'partial' : 'on';
}

export function computeS23({ ctx, security }: SecurityInput): QaEnvelope {
  const coverage = urlsCoverage(security, ctx.scope.from, ctx.scope.to);
  const keys = ['distinct_domains', 'distinct_urls', 'distinct_ip_addresses', 'indicator_observations'];
  if (coverage === 'off') return finishSecurity(ctx,
    keys.map((key) => unavailableFigure(key, [{ code: 'data_setting_off' }])));
  const rows = security.indicators;
  const countDistinct = (types: string[]) => new Set(rows.filter((row) => types.includes(row.type)).map((row) => row.value)).size;
  const counts = [countDistinct(['domain']), countDistinct(['url']), countDistinct(['ipv4', 'ipv6']),
    rows.reduce((sum, row) => sum + row.count, 0)];
  const figures = keys.map((key, index) => {
    const breakdown = key === 'indicator_observations' && ctx.breakdown === 'agent_family'
      ? [...new Set(rows.map((row) => row.sourceAgent))].sort().map((agent) => ({
        dimension: 'agent_family' as const, key: agent,
        value: { type: 'count' as const, count: rows.filter((row) => row.sourceAgent === agent)
          .reduce((sum, row) => sum + row.count, 0) },
      })) : [];
    return coverage === 'partial'
      ? partialCountFigure(key, counts[index], [{ code: 'data_setting_off' }], breakdown)
      : countFigure(key, counts[index], breakdown);
  });
  return finishSecurity(ctx, figures);
}

export function computeS21({ ctx, security }: SecurityInput): QaEnvelope {
  const findings = security.findings.filter((row) => row.generation === 'v2' && row.ruleId === 'tamper.guardrails_off');
  const sessions = new Set(findings.filter((row) => row.sessionId !== null)
    .map((row) => `${row.machineId}\u0000${row.sessionId}`));
  return finishSecurity(ctx, [
    countFigure('guardrails_off_findings', findings.length,
      ctx.breakdown === 'agent_family' ? tally('agent_family', findings, (row) => row.agent ?? 'unknown') : []),
    countFigure('guardrails_off_sessions', sessions.size),
    unavailableFigure('bypass_flag_launches', notCaptured('G16')),
  ]);
}

// --- Thin answerers ---

/** Loads a tenant's security context for a period; injectable so tests need no database. */
export type SecurityLoader = (tenantId: string, fromMs: number, toMs: number) => Promise<SecurityContext>;
/** Loads Task2's context; injectable, for the same reason. */
export type CodeContextLoader = (tenantId: string) => Promise<QaContext>;

const periodMs = (ctx: QaAnswerContext) => ({ fromMs: Date.parse(ctx.scope.from), toMs: Date.parse(ctx.scope.to) });

/** Loads the security context for the request's period, then computes purely. */
export function securityAnswer(
  compute: (input: SecurityInput) => QaEnvelope,
  load: SecurityLoader = loadSecurityContext,
): QaAnswerer {
  return async (ctx) => {
    const { fromMs, toMs } = periodMs(ctx);
    return compute({ ctx, security: await load(ctx.tenantId, fromMs, toMs) });
  };
}

/** S7: loads the current and the previous period. */
export function comparisonAnswer(
  compute: (input: SecurityInput) => QaEnvelope,
  load: SecurityLoader = loadSecurityContext,
): QaAnswerer {
  return async (ctx) => {
    const { fromMs, toMs } = periodMs(ctx);
    const { from, to } = previousPeriod(ctx.scope);
    const [security, previous] = await Promise.all([
      load(ctx.tenantId, fromMs, toMs),
      load(ctx.tenantId, Date.parse(from), Date.parse(to)),
    ]);
    return compute({ ctx, security, previous });
  };
}

/** S6 and Q11: also load Task2's context for the session link, never a new calculation. */
export function linkedAnswer(
  compute: (input: SecurityInput) => QaEnvelope,
  load: SecurityLoader = loadSecurityContext,
  loadCode: CodeContextLoader = loadContext,
): QaAnswerer {
  return async (ctx) => {
    const { fromMs, toMs } = periodMs(ctx);
    const [security, context] = await Promise.all([
      load(ctx.tenantId, fromMs, toMs),
      loadCode(ctx.tenantId),
    ]);
    return compute({ ctx, security, context });
  };
}

/** Registers the twelve live security answerers in the app registry. */
export function registerSecurityAnswerers(): void {
  registerAnswerer('S5', 'live', linkedAnswer(computeS5));
  registerAnswerer('S6', 'live', linkedAnswer(computeS6));
  registerAnswerer('S7', 'live', comparisonAnswer(computeS7));
  registerAnswerer('S8', 'live', securityAnswer(computeS8));
  registerAnswerer('S9', 'live', securityAnswer(computeS9));
  registerAnswerer('S10', 'live', securityAnswer(computeS10));
  registerAnswerer('S11', 'live', securityAnswer(computeS11));
  registerAnswerer('S12', 'live', securityAnswer(computeS12));
  registerAnswerer('S15', 'live', securityAnswer(computeS15));
  registerAnswerer('S17', 'live', securityAnswer(computeS17));
  registerAnswerer('S18', 'live', securityAnswer(computeS18));
  registerAnswerer('S26', 'live', securityAnswer(computeS26));
  registerAnswerer('S23', 'live', securityAnswer(computeS23));
  registerAnswerer('S21', 'live', securityAnswer(computeS21));
  registerAnswerer('Q11', 'live', linkedAnswer(computeQ11));
}

// Self-registers on import (like ./answers/register-code): qa.routes.ts imports
// this module for its side effect only.
registerSecurityAnswerers();
