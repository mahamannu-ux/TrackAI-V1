/**
 * Security live answerers (Task19c, T19.4): S5, S6, S7, S8, S9, S10, S11, S12,
 * S15, S17, S18 and Q11, registered for kind `live`.
 *
 * Every figure is metadata only, every answer is worded `monitor_only_observed`
 * (the registry adds it) and nothing is ever called "blocked" without an
 * enforcement `deny` — and even then it is "denied by request". S1, S14 and S16
 * stay `answer_not_built` until their gaps close. Task19j added S2, S3, S4 and the
 * lease half of S13, and extended S10, from the Task20 coverage data (G7, G8, G11).
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
import {
  loadSecurityContext, type LeaseRow, type SecurityContext, type SecurityFindingRow, type StatusReportRow,
} from './security-read';
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
function distinctPerBucket<T>(
  dimension: QaDimension,
  rows: T[],
  bucket: (row: T) => string,
  value: (row: T) => string,
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

// --- S10: rule-pack versions in force, machines reporting status, up to date (Task19j: G7 data) ---

export function computeS10(input: SecurityInput): QaEnvelope {
  const { ctx, security } = input;
  const findings = scopedFindings(ctx, security.findings);
  const reporting = distinct(security.statusSnapshots, (row) => row.machineId);
  const byMachine = ctx.breakdown === 'machine';
  const machines = machinesInScope(ctx, security);
  const reports = security.statusReports.filter((row) => machines.has(row.machineId));
  // A rule pack is in force on a machine when a finding names it or a status report names its
  // bundle: v2 stores rule_pack_version as `bundle:` + the digest's first 16 hex digits
  // (security-findings/v2-storage.ts), so a report maps exactly; machines with no finding count.
  const packOfDigest = (digest: string) => `bundle:${digest.slice(0, 16)}`;
  const packPairs = [
    ...findings.map((row) => ({ machineId: row.machineId, pack: row.rulePackVersion })),
    ...reports.filter((row) => row.activeBundleDigest !== null)
      .map((row) => ({ machineId: row.machineId, pack: packOfDigest(row.activeBundleDigest as string) })),
  ];
  const versions = distinct(packPairs, (row) => row.pack);
  const machineBreakdown = byMachine
    ? distinctPerBucket('machine', packPairs, (row) => row.machineId, (row) => row.pack)
    : [];
  const latest = latestReports(reports);
  const notReporting = [...machines].filter((id) => !latest.has(id));
  const bundle = latestBundle(security, Date.parse(ctx.scope.to));
  /** Distinct reported values per machine (a machine reporting two digests in the period counts 2). */
  const perMachine = (value: (row: StatusReportRow) => string | null): QaBreakdownItem[] => {
    if (!byMachine) return [];
    const sets = new Map<string, Set<string>>();
    for (const row of reports) {
      const v = value(row);
      if (v === null) continue;
      const set = sets.get(row.machineId) ?? new Set<string>();
      set.add(v);
      sets.set(row.machineId, set);
    }
    return [...sets.entries()].sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([key, set]) => ({ dimension: 'machine' as const, key, value: { type: 'count' as const, count: set.size } }));
  };
  const upToDate = [...latest.values()].filter((row) => bundle !== null && row.activeBundleDigest === bundle.digest);
  const notUpToDate = [...latest.values()].filter((row) => bundle !== null && row.activeBundleDigest !== bundle.digest);
  const gap: QaReason[] = [{ code: 'not_monitored' }];
  const upToDateFigure = (key: string, rows: StatusReportRow[]): QaFigure => {
    if (bundle === null || machines.size === 0 || latest.size === 0) return unavailableFigure(key, gap);
    const breakdown = byMachine ? bucketCounts('machine', rows.map((row) => row.machineId)) : [];
    return notReporting.length > 0 ? partialCountFigure(key, rows.length, gap, breakdown) : countFigure(key, rows.length, breakdown);
  };
  const q = (figure: QaFigure) => scopeQualified(ctx, figure);
  return finishSecurity(ctx, [
    countFigure('rule_pack_versions_in_force', versions.size, machineBreakdown),
    // Unchanged since Task19c: every machine reporting in the period, tenant-wide.
    countFigure('machines_reporting_status', reporting.size),
    q(upToDateFigure('machines_up_to_date', upToDate)),
    q(upToDateFigure('machines_not_up_to_date', notUpToDate)),
    q(countFigure('machines_not_reporting', notReporting.length, byMachine ? bucketCounts('machine', notReporting) : [])),
    q(reports.length === 0 ? unavailableFigure('bundle_digests_in_force', gap)
      : countFigure('bundle_digests_in_force', distinct(reports.filter((r) => r.activeBundleDigest !== null), (r) => r.activeBundleDigest ?? '').size,
        perMachine((row) => row.activeBundleDigest))),
    q(reports.length === 0 ? unavailableFigure('numbat_versions_in_force', gap)
      : countFigure('numbat_versions_in_force', distinct(reports, (r) => r.numbatVersion).size, perMachine((row) => row.numbatVersion))),
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

// --- S19, S20: Endpoint agent inventory and the day-one scan (Task19h) ---

/** Counts and breakdown buckets over string keys, sorted. */
function bucketCounts(dimension: QaDimension, keys: string[]): QaBreakdownItem[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => ({ dimension, key, value: { type: 'count' as const, count } }));
}

/**
 * S19: what the latest inventory snapshot of each reporting machine shows. An agent
 * is "detected" when its configuration or its session files are present. Versions
 * are never claimed: Numbat does not report them. The tenant has no approved-agent
 * list yet (G2).
 */
export function computeS19({ ctx, security }: SecurityInput): QaEnvelope {
  const machines = security.inventory;
  const detected = machines.flatMap((machine) => machine.agents
    .filter((agent) => agent.config === 'present' || agent.artifacts === 'present')
    .map((agent) => ({ machineId: machine.machineId, ...agent })));
  const noReports: QaReason[] = [{ code: 'not_monitored' }];
  const agentFigure = (key: string, rows: typeof detected): QaFigure => machines.length === 0
    ? unavailableFigure(key, noReports)
    : countFigure(key, rows.length,
      ctx.breakdown === 'agent_family' ? bucketCounts('agent_family', rows.map((row) => row.agent))
        : ctx.breakdown === 'machine' ? bucketCounts('machine', rows.map((row) => row.machineId)) : []);
  return finishSecurity(ctx, [
    countFigure('machines_reporting', machines.length,
      ctx.breakdown === 'operating_system'
        ? bucketCounts('operating_system', machines.map((machine) => security.machinePlatforms.get(machine.machineId) ?? 'unavailable'))
        : []),
    agentFigure('agents_detected', detected),
    agentFigure('agents_wired', detected.filter((row) => row.wired === 'yes')),
    agentFigure('agents_detected_not_wired', detected.filter((row) => row.wired === 'no')),
    agentFigure('agents_wiring_unknown', detected.filter((row) => row.wired !== 'yes' && row.wired !== 'no')),
    unavailableFigure('agent_versions', [{ code: 'vendor_does_not_report' }]),
    unavailableFigure('agents_not_on_approved_list', notCaptured('G2')),
  ]);
}

/**
 * S20: the opt-in day-one scan of agent session files already on the machine. A
 * scan summary with status `error` and no artifacts scanned means the scan found no
 * session files for the agent it ran for (the summary does not name the agent).
 * Findings "at rest" describe what old sessions requested, not confirmed outcomes.
 */
export function computeS20({ ctx, security }: SecurityInput): QaEnvelope {
  const scans = security.scanSummaries;
  const findings = security.atRestFindings;
  if (scans.length === 0 && findings.length === 0) {
    return finishSecurity(ctx, ['machines_scanned', 'scans_complete', 'scans_partial', 'scans_no_session_files',
      'scans_failed', 'artifacts_scanned', 'findings_at_rest'].map((key) => unavailableFigure(key, [{ code: 'not_monitored' }])));
  }
  const noFiles = scans.filter((row) => row.status === 'error' && row.artifactsScanned === 0);
  const failed = scans.filter((row) => row.status === 'error' && row.artifactsScanned > 0);
  return finishSecurity(ctx, [
    countFigure('machines_scanned', new Set(scans.map((row) => row.machineId)).size),
    countFigure('scans_complete', scans.filter((row) => row.status === 'complete').length),
    countFigure('scans_partial', scans.filter((row) => row.status === 'partial').length),
    countFigure('scans_no_session_files', noFiles.length),
    countFigure('scans_failed', failed.length),
    countFigure('artifacts_scanned', scans.reduce((sum, row) => sum + row.artifactsScanned, 0)),
    countFigure('findings_at_rest', findings.length,
      ctx.breakdown === 'rule_category' ? bucketCounts('rule_category', findings.map((row) => row.ruleCategory))
        : ctx.breakdown === 'severity' ? bucketCounts('severity', findings.map((row) => row.ruleSeverity)) : []),
  ]);
}

// --- Task19j: S2, S3, S4 and S13 from the Task20 coverage data ---

/** The platforms monitoring is validated on (D6.2; as S9). */
const VALIDATED_PLATFORMS = new Set(['macos']);
const DAY_MS = 86_400_000;

/**
 * The machines an answer covers. Tenant: every enrolled machine. Repository: the
 * machines whose findings name the repository in the period, because an Endpoint
 * status report or lease never names a repository.
 */
function machinesInScope(ctx: QaAnswerContext, security: SecurityContext): Set<string> {
  const enrolled = new Set(enrolledInPeriod(ctx, security).map((row) => row.machineId));
  if (ctx.scope.repository_id) {
    return new Set(security.findings.filter((row) => row.repositoryId === ctx.scope.repository_id && enrolled.has(row.machineId))
      .map((row) => row.machineId));
  }
  return enrolled;
}

/** Machines enrolled at some time in the period: enrolled by its end, not revoked before its start. */
function enrolledInPeriod(ctx: QaAnswerContext, security: SecurityContext): SecurityContext['machines'] {
  const fromMs = Date.parse(ctx.scope.from);
  const toMs = Date.parse(ctx.scope.to);
  return security.machines.filter((row) => row.enrolledAt.getTime() <= toMs
    && (row.revokedAt === null || row.revokedAt.getTime() >= fromMs));
}

/**
 * At repository scope a machine belongs to the repository only through its findings, so
 * machines that worked there without one are not seen: every machine figure is then
 * `partial` with `partial_linkage`, never a clean "no gaps" (review, Task19j).
 */
function scopeQualified(ctx: QaAnswerContext, figure: QaFigure): QaFigure {
  if (!ctx.scope.repository_id || figure.availability === 'unavailable') return figure;
  const reasons = figure.reasons.some((r) => r.code === 'partial_linkage') ? figure.reasons : [...figure.reasons, { code: 'partial_linkage' as const }];
  return { ...figure, availability: 'partial', reasons };
}

/** The validated platform rule (D6.2): a known platform outside the set is not monitored. */
function onUnvalidatedPlatform(security: SecurityContext, machineId: string): boolean {
  const platform = security.machinePlatforms.get(machineId);
  return platform !== undefined && platform !== null && !VALIDATED_PLATFORMS.has(platform);
}

/** Each machine's newest lease in force at `atMs` (a new lease can overlap the old one). */
function newestLeaseInForce(leases: LeaseRow[], atMs: number): Map<string, LeaseRow> {
  const out = new Map<string, LeaseRow>();
  for (const lease of leases.filter((row) => leaseCovers(row, atMs))) {
    const current = out.get(lease.machineId);
    if (!current || lease.issuedAt.getTime() > current.issuedAt.getTime()) out.set(lease.machineId, lease);
  }
  return out;
}

/** Each machine's latest status report in the period. */
function latestReports(rows: StatusReportRow[]): Map<string, StatusReportRow> {
  const latest = new Map<string, StatusReportRow>();
  for (const row of rows) {
    const current = latest.get(row.machineId);
    if (!current || row.observedAt.getTime() > current.observedAt.getTime()) latest.set(row.machineId, row);
  }
  return latest;
}

/** The tenant's newest signed bundle issued by `atMs` (highest epoch, then version). */
function latestBundle(security: SecurityContext, atMs: number): SecurityContext['bundles'][number] | null {
  return security.bundles.filter((row) => row.issuedAt.getTime() <= atMs)
    .sort((a, b) => (b.epoch - a.epoch) || (b.bundleVersion - a.bundleVersion))[0] ?? null;
}

const healthOk = (row: StatusReportRow): boolean =>
  row.health.hook === 'ok' && row.health.view === 'ok' && row.health.local === 'ok' && row.health.forwarder === 'ok';
const healthFailed = (row: StatusReportRow): boolean => Object.values(row.health).includes('failed');
const leaseCovers = (lease: LeaseRow, atMs: number): boolean =>
  lease.issuedAt.getTime() <= atMs && lease.expiresAt.getTime() >= atMs;

/** UTC days that overlap [fromMs, toMs], as day numbers. */
function utcDays(fromMs: number, toMs: number): number[] {
  const days: number[] = [];
  for (let day = Math.floor(fromMs / DAY_MS); day <= Math.floor(toMs / DAY_MS); day += 1) days.push(day);
  return days;
}

/**
 * S2: was monitoring on, and where were the gaps. A machine-day with no status
 * report is "not reported": counted as such, never as healthy and never as zero;
 * continuity is `partial` whenever any is missing (founder decision, 2026-11-26:
 * answer from what is captured, never block on a complete daily history). A
 * machine outside the validated platforms is "not monitored". "Monitoring on" means
 * the machine's latest report has all four health layers `ok` and a lease in force
 * then, in a mode other than off: an observation of the layers, not a claim that
 * anything was prevented.
 */
export function computeS2({ ctx, security }: SecurityInput): QaEnvelope {
  const fromMs = Date.parse(ctx.scope.from);
  const toMs = Date.parse(ctx.scope.to);
  const machines = machinesInScope(ctx, security);
  const enrolled = enrolledInPeriod(ctx, security).filter((row) => machines.has(row.machineId));
  const reports = security.statusReports.filter((row) => machines.has(row.machineId));
  const latest = latestReports(reports);
  const notReporting = enrolled.map((row) => row.machineId).filter((id) => !latest.has(id));
  // Each reporting machine's state from its latest report and the newest lease in force then:
  // on (validated platform, all four layers ok, lease mode not off); off (that lease is off:
  // confirmed by the signed lease); otherwise unverified (a layer `unavailable` or `failed`, no
  // lease, or an unknown platform). Unvalidated platforms are counted on their own, never on.
  const stateOf = (row: StatusReportRow): 'on' | 'off' | 'unverified' | 'unvalidated' => {
    if (onUnvalidatedPlatform(security, row.machineId)) return 'unvalidated';
    const lease = newestLeaseInForce(security.leases.filter((l) => l.machineId === row.machineId), row.observedAt.getTime())
      .get(row.machineId);
    if (lease?.mode === 'off') return 'off';
    const platformKnown = VALIDATED_PLATFORMS.has(security.machinePlatforms.get(row.machineId) ?? '');
    return lease && platformKnown && healthOk(row) ? 'on' : 'unverified';
  };
  const inState = (state: ReturnType<typeof stateOf>) => [...latest.values()].filter((row) => stateOf(row) === state);
  const monitoringOn = inState('on');
  const failed = [...latest.values()].filter(healthFailed);
  const platformOf = (id: string) => security.machinePlatforms.get(id) ?? 'unavailable';
  const notMonitoredPlatform = enrolled.filter((row) => onUnvalidatedPlatform(security, row.machineId));
  // Machine-days: from the later of the period start and enrolment.
  const reportedDays = new Set(reports.map((row) => `${row.machineId}:${Math.floor(row.observedAt.getTime() / DAY_MS)}`));
  // Expected from the later of the period start and enrolment, to the earlier of its end and revocation.
  const perMachine = enrolled.map((row) => {
    const days = utcDays(Math.max(fromMs, row.enrolledAt.getTime()), Math.min(toMs, row.revokedAt?.getTime() ?? toMs));
    return { machineId: row.machineId, expected: days.length,
      reported: days.filter((day) => reportedDays.has(`${row.machineId}:${day}`)).length };
  });
  const expected = perMachine.reduce((sum, row) => sum + row.expected, 0);
  const reported = perMachine.reduce((sum, row) => sum + row.reported, 0);
  const gap: QaReason[] = [{ code: 'not_monitored' }];
  const byMachine = ctx.breakdown === 'machine';
  const byOs = ctx.breakdown === 'operating_system';
  // By repository: the repositories each machine's findings name in the period (the only link there is).
  const reposOf = (id: string) => [...new Set(security.findings.filter((row) => row.machineId === id).map(repositoryBucket))];
  const machineBuckets = (ids: string[]): QaBreakdownItem[] => byMachine ? bucketCounts('machine', ids)
    : byOs ? bucketCounts('operating_system', ids.map(platformOf))
      : ctx.breakdown === 'repository' ? bucketCounts('repository', ids.flatMap(reposOf)) : [];
  // Missing days, or days on an unvalidated platform, make continuity partial: neither is "monitored".
  const continuityPartial = reported < expected || notMonitoredPlatform.length > 0;
  const continuity: QaFigure = expected === 0
    ? unavailableFigure('machine_days_reported', gap)
    : {
      key: 'machine_days_reported',
      availability: continuityPartial ? 'partial' : 'recorded',
      reasons: continuityPartial ? gap : [],
      value: { type: 'ratio', numerator: reported, denominator: expected },
      ...(byMachine ? { breakdown: perMachine.filter((row) => row.expected > 0).sort((a, b) => (a.machineId < b.machineId ? -1 : 1))
        .map((row) => ({ dimension: 'machine' as const, key: row.machineId,
          value: { type: 'ratio' as const, numerator: row.reported, denominator: row.expected } })) } : {}),
    };
  return finishSecurity(ctx, [
    countFigure('machines_enrolled', enrolled.length, machineBuckets(enrolled.map((row) => row.machineId))),
    countFigure('machines_reporting', latest.size, machineBuckets([...latest.keys()])),
    countFigure('machines_not_reporting', notReporting.length, machineBuckets(notReporting)),
    countFigure('machines_monitoring_on', monitoringOn.length, machineBuckets(monitoringOn.map((row) => row.machineId))),
    countFigure('machines_monitoring_off', inState('off').length, machineBuckets(inState('off').map((row) => row.machineId))),
    countFigure('machines_monitoring_unverified', inState('unverified').length,
      machineBuckets(inState('unverified').map((row) => row.machineId))),
    countFigure('machines_health_failed', failed.length, machineBuckets(failed.map((row) => row.machineId))),
    countFigure('machines_on_unvalidated_platforms', notMonitoredPlatform.length,
      machineBuckets(notMonitoredPlatform.map((row) => row.machineId))),
    continuity,
    // A tenant-wide setting: at repository scope it cannot be tied to the repository.
    countFigure('monitoring_switched_off', security.securityAudit
      .filter((row) => row.action === 'security.monitor.changed' && row.mode === 'off').length),
  ].map((figure) => scopeQualified(ctx, figure)));
}

/**
 * S3: did anyone switch off or tamper with the guardrails. Settings and monitor-mode
 * changes come from the audited settings writer (Task20f, G8); who made them is
 * never shown. Tamper findings are Numbat's `tamper.*` rules (first wave; G9
 * cancelled). A refused lease is counted because a machine refusing its signed
 * policy is one sign of tampering, never proof of it.
 */
export function computeS3({ ctx, security }: SecurityInput): QaEnvelope {
  const audit = security.securityAudit;
  const tamper = security.findings.filter((row) => row.ruleCategory === 'tamper');
  const refusals = audit.filter((row) => row.action === 'fleet.lease.refused');
  const findingBuckets = (rows: SecurityFindingRow[]): QaBreakdownItem[] =>
    ctx.breakdown === 'machine' ? tally('machine', rows, (row) => row.machineId)
      : ctx.breakdown === 'repository' ? tally('repository', rows, repositoryBucket) : [];
  return finishSecurity(ctx, [
    countFigure('monitor_mode_changes', audit.filter((row) => row.action === 'security.monitor.changed').length),
    countFigure('monitoring_switched_off', audit.filter((row) => row.action === 'security.monitor.changed' && row.mode === 'off').length),
    countFigure('settings_changes', audit.filter((row) => row.action === 'security.settings.changed').length),
    countFigure('tamper_findings', tamper.length, findingBuckets(tamper)),
    countFigure('lease_refusals', refusals.length,
      ctx.breakdown === 'machine' ? bucketCounts('machine', refusals.map((row) => row.machineId ?? 'unknown')) : []),
  ]);
}

/** The sequence rules in which a secret read is followed by egress (Numbat's first-wave chains). */
export const SECRET_THEN_EGRESS_RULES = new Set(['chain.secret_read_then_egress', 'chain.secret_manager_read_then_egress']);

/**
 * S4: did an agent read secrets, and did data leave the machine afterwards.
 * "Afterwards" is answered only from Numbat's sequence (chain) findings, which see
 * the read and the egress in one session; it is never inferred from timing alone.
 * Every finding is a requested action, not a confirmed outcome.
 */
export function computeS4({ ctx, security }: SecurityInput): QaEnvelope {
  const findings = scopedFindings(ctx, security.findings);
  const buckets = (rows: SecurityFindingRow[]): QaBreakdownItem[] =>
    ctx.breakdown === 'rule' ? tally('rule', rows, (row) => row.ruleId)
      : ctx.breakdown === 'machine' ? tally('machine', rows, (row) => row.machineId)
        : ctx.breakdown === 'repository' ? tally('repository', rows, repositoryBucket) : [];
  const secrets = findings.filter((row) => row.ruleCategory === 'secrets');
  const exfil = findings.filter((row) => row.ruleCategory === 'exfil');
  const sequences = findings.filter((row) => SECRET_THEN_EGRESS_RULES.has(row.ruleId));
  return finishSecurity(ctx, [
    countFigure('secret_read_findings', secrets.length, buckets(secrets)),
    countFigure('exfiltration_findings', exfil.length, buckets(exfil)),
    countFigure('secret_read_then_egress_sequences', sequences.length, buckets(sequences)),
  ]);
}

/**
 * S13, the lease half: which signed activation lease and rule bundle were in force
 * on each machine (Task20f signed lease history, issued and refused events; G11).
 * The organization-policy half stays unbuilt: G2 is shelved.
 */
export function computeS13({ ctx, security }: SecurityInput): QaEnvelope {
  const fromMs = Date.parse(ctx.scope.from);
  const toMs = Date.parse(ctx.scope.to);
  const machines = machinesInScope(ctx, security);
  const leases = security.leases.filter((lease) => machines.has(lease.machineId));
  const inForceAtEnd = [...newestLeaseInForce(leases, toMs).values()];
  const withLease = new Set(inForceAtEnd.map((lease) => lease.machineId));
  const without = [...machines].filter((id) => !withLease.has(id));
  const findings = scopedFindings(ctx, security.findings).filter((row) => machines.has(row.machineId));
  // Under a lease only when the finding's own recorded lease exists, belongs to its machine and
  // was valid when it occurred; a coincident lease is never assigned. Task6.a rows and unmatched
  // references are unknown, never "without a lease".
  const recordedLease = (row: SecurityFindingRow) => row.leaseId === null ? undefined
    : leases.find((lease) => lease.id === row.leaseId && lease.machineId === row.machineId && leaseCovers(lease, row.occurredAt.getTime()));
  const covered = findings.filter((row) => recordedLease(row) !== undefined);
  const unknown = findings.filter((row) => recordedLease(row) === undefined);
  const refusals = security.securityAudit.filter((row) => row.action === 'fleet.lease.refused'
    && row.machineId !== null && machines.has(row.machineId));
  const issued = leases.filter((lease) => lease.issuedAt.getTime() >= fromMs && lease.issuedAt.getTime() <= toMs);
  const byMachine = ctx.breakdown === 'machine';
  const machineBuckets = (ids: string[]) => (byMachine ? bucketCounts('machine', ids) : []);
  const q = (figure: QaFigure) => scopeQualified(ctx, figure);
  return finishSecurity(ctx, [
    countFigure('machines_with_lease_in_force', withLease.size, machineBuckets([...withLease])),
    countFigure('machines_without_lease_in_force', without.length, machineBuckets(without)),
    countFigure('bundles_in_force', new Set(inForceAtEnd.map((lease) => lease.bundleDigest)).size),
    countFigure('leases_issued', issued.length, machineBuckets(issued.map((lease) => lease.machineId))),
    countFigure('lease_refusals', refusals.length, machineBuckets(refusals.map((row) => row.machineId ?? 'unknown'))),
    unknown.length > 0
      ? partialCountFigure('findings_under_lease', covered.length, [{ code: 'partial_linkage' }],
        byMachine ? tally('machine', covered, (row) => row.machineId) : [])
      : countFigure('findings_under_lease', covered.length, byMachine ? tally('machine', covered, (row) => row.machineId) : []),
    countFigure('findings_lease_unknown', unknown.length, byMachine ? tally('machine', unknown, (row) => row.machineId) : []),
    unavailableFigure('organization_policy_in_force', notCaptured('G2')),
  ].map(q));
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

/** Registers the live security answerers in the app registry. */
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
  registerAnswerer('S19', 'live', securityAnswer(computeS19));
  registerAnswerer('S20', 'live', securityAnswer(computeS20));
  registerAnswerer('S2', 'live', securityAnswer(computeS2));
  registerAnswerer('S3', 'live', securityAnswer(computeS3));
  registerAnswerer('S4', 'live', securityAnswer(computeS4));
  registerAnswerer('S13', 'live', securityAnswer(computeS13));
  registerAnswerer('Q11', 'live', linkedAnswer(computeQ11));
}

// Self-registers on import (like ./answers/register-code): qa.routes.ts imports
// this module for its side effect only.
registerSecurityAnswerers();
