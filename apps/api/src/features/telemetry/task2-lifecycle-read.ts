/**
 * Task2's lifecycle read model, moved unchanged out of read.routes.ts (Task19a,
 * TASK19.md §7 item 3) so other features can reuse Task2's semantics instead of
 * re-deriving them (AGENTS.md rule 8). Owner: Task2. The only change is the
 * `export` keyword on each declaration; read.routes.ts imports them back.
 * features/qa/ may import this file and lifecycle.ts (AGENTS.md §7 boundary
 * exception); nothing else outside Task2 should.
 */
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiCommitModelAttributions,
  aiCodeLifecycleEvents,
  aiGenerationObservations,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  aiModelLifecycleEvents,
  scmCommitFiles,
  scmCommitLineage,
  scmCommits,
  scmContributors,
  scmDeployments,
  scmMergeLineage,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
  telemetryCorrections,
} from '../../core/db/schema';
import { applyAuditedValue } from './audit';
import {
  calculateLifecycleScopeTotals,
  calculateLifecycleSummary,
  contributorMatchesCommit,
  generationEvidenceForScope,
  generationCoverageForScope,
  currentRetainedAiLines,
  isCommittedLineReworkEvidence,
  lifecycleEvidenceMatchesPullRequestScope,
} from './lifecycle';

export type CorrectionRow = typeof telemetryCorrections.$inferSelect;

export function correctionMap(rows: CorrectionRow[]) {
  return new Map(rows.map((row) => [
    `${row.targetType}:${row.targetKey}:${row.fieldName}`,
    row,
  ]));
}

export function audited<T>(
  corrections: Map<string, CorrectionRow>,
  targetType: string,
  targetKey: string,
  fieldName: string,
  observedValue: T,
) {
  return applyAuditedValue(
    corrections.get(`${targetType}:${targetKey}:${fieldName}`),
    observedValue,
  );
}

export function contributesToCurrentCommittedState(reachability: string) {
  return reachability !== 'superseded' && reachability !== 'unreachable';
}

export async function loadContext(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits, corrections,
    generationObservations, lifecycleEvents, memberships, commitLineage,
    mergeLineage, deployments, commitModelAttributions, modelLifecycleEvents] = await Promise.all([
    tenantDb.select(scmRepositories),
    tenantDb.select(scmPullRequests),
    tenantDb.select(scmContributors),
    tenantDb.select(aiSessions),
    tenantDb.select(aiSessionRepositories),
    tenantDb.select(aiSessionUsage),
    tenantDb.select(scmCommits),
    tenantDb.select(scmCommitFiles),
    tenantDb.select(aiCommitSessions),
    tenantDb.select(scmPullRequestCommits),
    tenantDb.select(telemetryCorrections),
    tenantDb.select(aiGenerationObservations),
    tenantDb.select(aiCodeLifecycleEvents),
    tenantDb.select(scmPullRequestCommitMemberships),
    tenantDb.select(scmCommitLineage),
    tenantDb.select(scmMergeLineage),
    tenantDb.select(scmDeployments),
    tenantDb.select(aiCommitModelAttributions),
    tenantDb.select(aiModelLifecycleEvents),
  ]);
  return {
    repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits,
    generationObservations, lifecycleEvents, memberships, commitLineage,
    mergeLineage, deployments, commitModelAttributions, modelLifecycleEvents,
    corrections: correctionMap(corrections),
  };
}

export type LifecycleFilter = {
  repositoryId?: string;
  pullRequestId?: string;
  contributorId?: string;
  from?: Date;
  to?: Date;
};

export async function lifecycleForTenant(tenantId: string, filter: LifecycleFilter) {
  const context = await loadContext(tenantId);
  let repositoryIds = filter.repositoryId ? new Set([filter.repositoryId]) : null;
  let pullRequestIds = filter.pullRequestId ? new Set([filter.pullRequestId]) : null;
  let contributorCommitIds: Set<string> | null = null;
  if (filter.contributorId) {
    const contributor = context.contributors.find((row) => row.id === filter.contributorId);
    if (!contributor) return null;
    repositoryIds = new Set([contributor.repositoryId]);
    contributorCommitIds = new Set(context.commits
      .filter((commit) => commit.repositoryId === contributor.repositoryId)
      .filter((commit) => contributorMatchesCommit(contributor, commit))
      .map((commit) => commit.id));
  }
  const inTime = (dateValue: Date) => (!filter.from || dateValue >= filter.from)
    && (!filter.to || dateValue <= filter.to);
  const scopedMemberships = context.memberships.filter((row) =>
    (!pullRequestIds || pullRequestIds.has(row.pullRequestId))
    && (!contributorCommitIds || contributorCommitIds.has(row.commitId)));
  const scopedMembershipCommitIds = new Set(scopedMemberships.map((row) => row.commitId));
  const retainedCommitIds = new Set(context.commits
    .filter((commit) => contributesToCurrentCommittedState(commit.reachability))
    .filter((commit) => !repositoryIds || repositoryIds.has(commit.repositoryId))
    .map((commit) => commit.id));
  const lifecycleRows = context.lifecycleEvents.filter((row) =>
    (!repositoryIds || repositoryIds.has(row.repositoryId))
    && (!pullRequestIds || lifecycleEvidenceMatchesPullRequestScope(
      row,
      pullRequestIds,
      scopedMembershipCommitIds,
    ))
    && (!contributorCommitIds
      || (row.commitId !== null && contributorCommitIds.has(row.commitId)))
    && inTime(row.occurredAt)
    && row.stage !== 'generated'
    && (row.stage !== 'committed'
      || row.commitId === null
      || retainedCommitIds.has(row.commitId)));
  const generationCommitIds = pullRequestIds
    ? new Set(scopedMemberships.map((row) => row.commitId))
    : contributorCommitIds;
  const generationRows = generationEvidenceForScope({
    observations: context.generationObservations
      .filter((row) => (!repositoryIds
        || (row.repositoryId !== null && repositoryIds.has(row.repositoryId)))
        && inTime(row.generatedAt))
      .map((row) => ({ lineCount: row.generatedLines, evidenceType: row.evidenceSource })),
    commitLinked: context.lifecycleEvents
      .filter((row) => row.stage === 'generated'
        && (!repositoryIds || repositoryIds.has(row.repositoryId))
        && inTime(row.occurredAt))
      .map((row) => ({
        commitId: row.commitId,
        lineCount: row.lineCount,
        evidenceType: row.evidenceType,
      })),
    commitIds: generationCommitIds,
  });
  const openPullRequestIds = new Set(context.pullRequests
    .filter((row) => row.state.toLowerCase() === 'open').map((row) => row.id));
  const activeMemberships = context.memberships.filter((row) => row.active
    && openPullRequestIds.has(row.pullRequestId)
    && (!pullRequestIds || pullRequestIds.has(row.pullRequestId))
    && (!contributorCommitIds || contributorCommitIds.has(row.commitId)));
  const activeMembershipCommitIds = new Set(activeMemberships.map((row) => row.commitId));
  const activeMembershipCommittedAi = context.commits
    .filter((commit) => activeMembershipCommitIds.has(commit.id))
    .reduce((sum, commit) => sum + commit.observedAiLines, 0);
  const inPrRows = activeMemberships.length > 0 ? [{
    stage: 'in_pr',
    lineCount: currentRetainedAiLines(
      activeMembershipCommittedAi,
      context.lifecycleEvents.filter((row) => row.commitId !== null
        && activeMembershipCommitIds.has(row.commitId) && row.stage === 'reworked'),
    ),
    actorKind: null,
    evidenceType: 'github_pr_commits_api_current_head',
  }] : [];
  const committedRows = pullRequestIds ? scopedMemberships
    .filter((membership) => membership.active && retainedCommitIds.has(membership.commitId))
    .map((membership) => ({
    stage: 'committed',
    lineCount: context.commits.find((commit) => commit.id === membership.commitId)?.observedAiLines ?? 0,
    actorKind: null,
    evidenceType: 'git_ai_authorship',
    })) : [];
  const pullRequestCommitIds = pullRequestIds
    ? new Set(scopedMemberships.filter((row) => row.active).map((row) => row.commitId))
    : null;
  const selectedCommitIds = pullRequestCommitIds ?? contributorCommitIds ?? (repositoryIds
    ? new Set(context.commits.filter((row) => repositoryIds!.has(row.repositoryId)).map((row) => row.id))
    : null);
  const committedByCommit = context.lifecycleEvents
    .filter((row) => row.stage === 'committed' && row.commitId !== null)
    .reduce((result, row) => {
      result.set(row.commitId!, (result.get(row.commitId!) ?? 0) + row.lineCount);
      return result;
    }, new Map<string, number>());
  const generationCoverage = generationCoverageForScope({
    commits: context.commits.map((commit) => ({
      id: commit.id,
      reachability: commit.reachability,
      finalAiLines: committedByCommit.get(commit.id) ?? 0,
    })),
    generatedRows: context.lifecycleEvents
      .filter((row) => row.stage === 'generated')
      .map((row) => ({ commitId: row.commitId, lineCount: row.lineCount })),
    commitIds: selectedCommitIds,
  });
  const summary = calculateLifecycleSummary([
    ...generationRows.map((row) => ({
      stage: 'generated', lineCount: row.lineCount,
      actorKind: 'ai', evidenceType: row.evidenceType,
    })),
    ...lifecycleRows,
    ...committedRows,
    ...inPrRows,
  ], generationCoverage);
  const totals = calculateLifecycleScopeTotals({
    commits: context.commits.map((commit) => ({
      id: commit.id,
      repositoryId: commit.repositoryId,
      reachability: commit.reachability,
      finalAiLines: audited(
        context.corrections,
        'commit',
        commit.id,
        'observedAiLines',
        commit.observedAiLines,
      ).auditedValue,
      finalHumanLines: audited(
        context.corrections,
        'commit',
        commit.id,
        'observedHumanLines',
        commit.observedHumanLines,
      ).auditedValue,
    })),
    commitSessions: context.commitSessions,
    sessionRepositories: context.sessionRepositories,
    allSessionIds: context.sessions.map((session) => session.id),
    repositoryIds,
    pullRequestCommitIds,
    contributorCommitIds,
    reworkRows: context.lifecycleEvents
      .filter((row) => row.stage === 'reworked' && isCommittedLineReworkEvidence(row.evidenceType))
      .map((row) => ({
        commitId: row.commitId,
        lineCount: row.lineCount,
        evidenceType: row.evidenceType,
      })),
  });
  return {
    summary,
    totals,
    generationCoverage,
    scope: {
      repositoryIds: repositoryIds ? [...repositoryIds] : [],
      pullRequestIds: pullRequestIds ? [...pullRequestIds] : [],
      contributorId: filter.contributorId ?? null,
      from: filter.from?.toISOString() ?? null,
      to: filter.to?.toISOString() ?? null,
    },
    evidence: {
      generationObservations: generationRows.length,
      lifecycleEvents: lifecycleRows.length,
      activePullRequestMemberships: activeMemberships.length,
      deployments: context.deployments.filter((row) => !repositoryIds || repositoryIds.has(row.repositoryId)).length,
    },
  };
}

export function lifecycleForModel(context: Awaited<ReturnType<typeof loadContext>>, key: string) {
  const rows = context.modelLifecycleEvents.filter((row) => row.modelKey === key);
  const committedIds = new Set(rows
    .filter((row) => row.stage === 'committed' && row.commitId !== null)
    .map((row) => row.commitId!));
  const retainedCommitIds = new Set(context.commits
    .filter((commit) => contributesToCurrentCommittedState(commit.reachability))
    .filter((commit) => committedIds.has(commit.id))
    .map((commit) => commit.id));
  const lifecycleRows = rows.filter((row) => row.stage !== 'committed'
    || row.commitId === null || retainedCommitIds.has(row.commitId));
  const committedAttributions = context.commitModelAttributions
    .filter((row) => row.modelKey === key && retainedCommitIds.has(row.commitId));
  const reworked = rows.filter((row) => row.stage === 'reworked'
    && row.commitId !== null && retainedCommitIds.has(row.commitId))
    .reduce((sum, row) => sum + row.lineCount, 0);
  const sessions = new Set(rows.map((row) => row.sessionId).filter(Boolean));
  const generatedCommitIds = new Set(rows
    .filter((row) => row.stage === 'generated' && row.commitId !== null)
    .map((row) => row.commitId!));
  const missingCommitIds = [...retainedCommitIds].filter((id) => !generatedCommitIds.has(id));
  return {
    summary: calculateLifecycleSummary(lifecycleRows, {
      complete: missingCommitIds.length === 0,
      requiredCommitCount: retainedCommitIds.size,
      coveredCommitCount: retainedCommitIds.size - missingCommitIds.length,
      missingCommitIds,
    }),
    totals: {
      sessions: sessions.size,
      commits: retainedCommitIds.size,
      finalAiLines: Math.max(0,
        committedAttributions.reduce((sum, row) => sum + row.observedAiLines, 0) - reworked),
      finalHumanLines: 0,
    },
    generationCoverage: {
      complete: missingCommitIds.length === 0,
      requiredCommitCount: retainedCommitIds.size,
      coveredCommitCount: retainedCommitIds.size - missingCommitIds.length,
      missingCommitIds,
    },
    scope: { modelKey: key },
    evidence: { modelLifecycleEvents: rows.length, commitModelAttributions: committedAttributions.length },
  };
}
