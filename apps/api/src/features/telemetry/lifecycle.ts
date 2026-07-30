export const LIFECYCLE_STAGES = [
  'generated',
  'committed',
  'in_pr',
  'merged',
  'production',
  'reworked',
  'churned',
] as const;

export const NORMALIZED_COMMIT_REACHABILITY = 'reachable';

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

export type LifecycleEvidence = {
  stage: string;
  lineCount: number;
  actorKind?: string | null;
  evidenceType: string;
};

export type LifecycleValue = {
  value: number | null;
  observedValue?: number | null;
  availability: 'recorded' | 'partial' | 'unavailable';
  evidenceTypes: string[];
  reason?: string;
};

export type LifecycleSummary = {
  generated: LifecycleValue;
  committed: LifecycleValue;
  inPullRequests: LifecycleValue;
  merged: LifecycleValue;
  production: LifecycleValue;
  mergedProxy: LifecycleValue;
  reworked: LifecycleValue;
  churned: LifecycleValue;
  reworkByActor: Record<string, number>;
  ratios: {
    generatedToCommitted: number | null;
    generatedToPullRequest: number | null;
    generatedToMerged: number | null;
    generatedToProduction: number | null;
  };
};

export type GenerationCoverage = {
  complete: boolean;
  requiredCommitCount: number;
  coveredCommitCount: number;
  missingCommitIds: string[];
};

export function generationEvidenceMetric(
  observedLines: number | null,
  finalAttributedLines: number,
) {
  if (observedLines === null) {
    return {
      value: null,
      status: 'unavailable',
      reason: 'No eligible checkpoint evidence was received.',
    };
  }
  if (observedLines < finalAttributedLines) {
    return {
      value: null,
      observedValue: observedLines,
      status: 'partial',
      evidence: 'git_ai_checkpoint',
      reason: `Partial checkpoint coverage: ${observedLines} observed generated physical LoC is below ${finalAttributedLines} final attributed AI lines.`,
    };
  }
  return {
    value: observedLines,
    status: 'recorded',
    evidence: 'git_ai_checkpoint',
    reason: 'Observed from eligible checkpoint evidence.',
  };
}

function valueFor(rows: LifecycleEvidence[], stage: string): LifecycleValue {
  const matching = rows.filter((row) => row.stage === stage);
  return {
    value: matching.length ? matching.reduce((sum, row) => sum + row.lineCount, 0) : null,
    availability: matching.length ? 'recorded' : 'unavailable',
    evidenceTypes: [...new Set(matching.map((row) => row.evidenceType))].sort(),
  };
}

function ratio(numerator: LifecycleValue, denominator: LifecycleValue): number | null {
  if (numerator.value === null || denominator.value === null || denominator.value <= 0) return null;
  return numerator.value / denominator.value;
}

/**
 * Produces the customer contract without converting absent evidence into zero.
 * `production` is explicit deployment evidence; `merged_proxy` is intentionally
 * separate and must never be presented as an actual deployment.
 */
export function calculateLifecycleSummary(
  rows: LifecycleEvidence[],
  generationCoverage?: GenerationCoverage,
): LifecycleSummary {
  const committed = valueFor(rows, 'committed');
  const observedGenerated = valueFor(rows, 'generated');
  let generated: LifecycleValue = observedGenerated.value !== null
    && committed.value !== null
    && observedGenerated.value < committed.value
    ? {
      value: null,
      observedValue: observedGenerated.value,
      availability: 'partial',
      evidenceTypes: observedGenerated.evidenceTypes,
      reason: `Only ${observedGenerated.value} generated SLOC was observed, below ${committed.value} retained committed AI lines.`,
    }
    : observedGenerated;
  if (generationCoverage && !generationCoverage.complete) {
    generated = {
      value: null,
      observedValue: observedGenerated.value,
      availability: observedGenerated.value === null ? 'unavailable' : 'partial',
      evidenceTypes: observedGenerated.evidenceTypes,
      reason: `Checkpoint coverage is incomplete for ${generationCoverage.missingCommitIds.length} retained AI commit(s).`,
    };
  }
  const inPullRequests = valueFor(rows, 'in_pr');
  const merged = valueFor(rows, 'merged');
  const production = valueFor(rows, 'production');
  const mergedProxy = valueFor(rows, 'merged_proxy');
  const reworked = valueFor(rows, 'reworked');
  const churned = valueFor(rows, 'churned');
  const reworkByActor = rows.filter((row) => row.stage === 'reworked').reduce((result, row) => {
    const actor = row.actorKind ?? 'unknown';
    result[actor] = (result[actor] ?? 0) + row.lineCount;
    return result;
  }, {} as Record<string, number>);

  return {
    generated, committed, inPullRequests, merged, production, mergedProxy,
    reworked, churned, reworkByActor,
    ratios: {
      generatedToCommitted: ratio(generated, committed),
      generatedToPullRequest: ratio(generated, inPullRequests),
      generatedToMerged: ratio(generated, merged),
      generatedToProduction: ratio(generated, production),
    },
  };
}

export function generationCoverageForScope(input: {
  commits: Array<{ id: string; finalAiLines: number; reachability: string }>;
  generatedRows: Array<{ commitId: string | null; lineCount: number }>;
  commitIds: Set<string> | null;
}): GenerationCoverage {
  const required = input.commits
    .filter((commit) => commit.reachability !== 'superseded' && commit.reachability !== 'unreachable')
    .filter((commit) => !input.commitIds || input.commitIds.has(commit.id))
    .filter((commit) => commit.finalAiLines > 0);
  const generatedByCommit = input.generatedRows.reduce((result, row) => {
    if (row.commitId) result.set(row.commitId, (result.get(row.commitId) ?? 0) + row.lineCount);
    return result;
  }, new Map<string, number>());
  const missingCommitIds = required
    .filter((commit) => (generatedByCommit.get(commit.id) ?? 0) < commit.finalAiLines)
    .map((commit) => commit.id);
  return {
    complete: missingCommitIds.length === 0,
    requiredCommitCount: required.length,
    coveredCommitCount: required.length - missingCommitIds.length,
    missingCommitIds,
  };
}

export function fallbackSessionName(tool: string, startedAt: Date | null, externalId: string): string {
  const day = startedAt ? startedAt.toISOString().slice(0, 10) : 'unknown date';
  return `${tool} session · ${day} · ${externalId.slice(0, 8)}`;
}

/** Combine model-specific Git AI sessions that map to one external conversation. */
export function aggregateExternalSessionLines(
  contributions: Array<{ sessionId: string; lines: number }>,
) {
  const totals = new Map<string, number>();
  for (const contribution of contributions) {
    totals.set(
      contribution.sessionId,
      (totals.get(contribution.sessionId) ?? 0) + contribution.lines,
    );
  }
  return totals;
}

export function diffCommitMembership(previous: string[], current: string[]) {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((sha) => !previousSet.has(sha)),
    retained: current.filter((sha) => previousSet.has(sha)),
    removed: previous.filter((sha) => !currentSet.has(sha)),
  };
}

export function contributorMatchesCommit(
  contributor: { name: string; email: string | null },
  commit: { authorName: string | null; authorEmail: string | null },
) {
  const contributorEmail = contributor.email?.trim().toLowerCase() ?? null;
  if (contributorEmail) {
    return commit.authorEmail?.trim().toLowerCase() === contributorEmail;
  }
  return commit.authorName?.trim().toLowerCase() === contributor.name.trim().toLowerCase();
}

export function operationSupersedesPredecessor(operationKind: string) {
  return operationKind !== 'revert';
}

export function checkpointLifecycleLines(checkpoint: {
  linesAdded: number;
  linesDeleted: number;
  linesAddedSloc: number | null;
  linesDeletedSloc: number | null;
}) {
  return {
    generatedPhysicalLoc: checkpoint.linesAdded,
    deletedPhysicalLoc: checkpoint.linesDeleted,
  };
}

export function checkpointDeletionBuckets(checkpoint: {
  linesDeleted: number;
  aiAuthoredLinesDeleted: number | null;
  humanAuthoredLinesDeleted: number | null;
  unknownAuthoredLinesDeleted: number | null;
}) {
  const noProvenance = checkpoint.aiAuthoredLinesDeleted === null
    && checkpoint.humanAuthoredLinesDeleted === null
    && checkpoint.unknownAuthoredLinesDeleted === null;
  return {
    aiReworkedLines: checkpoint.aiAuthoredLinesDeleted ?? 0,
    unresolvedLines: noProvenance
      ? checkpoint.linesDeleted
      : checkpoint.unknownAuthoredLinesDeleted ?? 0,
  };
}

export function lifecycleEvidenceForPullRequest<TRow extends {
  id: string;
  pullRequestId: string | null;
  commitId: string | null;
  stage: string;
}>(rows: TRow[], pullRequestId: string, commitIds: Set<string>) {
  const pullRequestIds = new Set([pullRequestId]);
  return rows.filter((row) => lifecycleEvidenceMatchesPullRequestScope(
    row,
    pullRequestIds,
    commitIds,
  ));
}

export function lifecycleEvidenceMatchesPullRequestScope(row: {
  pullRequestId: string | null;
  commitId: string | null;
  stage: string;
}, pullRequestIds: Set<string>, commitIds: Set<string>) {
  return (row.pullRequestId !== null && pullRequestIds.has(row.pullRequestId))
    || (row.stage === 'reworked'
      && row.commitId !== null
      && commitIds.has(row.commitId));
}

export function isCommittedLineReworkEvidence(evidenceType: string) {
  return evidenceType === 'git_ai_checkpoint_deletion_with_commit_hunk_attribution'
    || evidenceType === 'git_ai_commit_hunk_deletion';
}

export function currentRetainedAiLines(
  committedAiLines: number,
  reworkRows: Array<{ lineCount: number; evidenceType: string }>,
) {
  const committedLineRework = reworkRows
    .filter((row) => isCommittedLineReworkEvidence(row.evidenceType))
    .reduce((sum, row) => sum + row.lineCount, 0);
  return Math.max(0, committedAiLines - committedLineRework);
}

export function currentRetainedAiLinesForCommit(
  commitId: string,
  committedAiLines: number,
  reworkRows: Array<{ commitId: string | null; lineCount: number; evidenceType: string }>,
) {
  return currentRetainedAiLines(
    committedAiLines,
    reworkRows.filter((row) => row.commitId === commitId),
  );
}

export function committedLinesForOperation(operationKind: string, attributedAiLines: number) {
  return operationKind === 'revert' ? 0 : attributedAiLines;
}

export function rewriteRetainsGenerationEvidence(operationKind: string) {
  return operationKind === 'recommit_after_reset';
}

export function shouldAbandonSiblingTip(candidate: {
  sha: string;
  branch: string | null;
  committedAt: Date | null;
  reachability: string;
}, current: {
  sha: string;
  branch: string | null;
  committedAt: Date;
}) {
  return candidate.sha !== current.sha
    && candidate.branch !== null
    && candidate.branch === current.branch
    && candidate.committedAt !== null
    && candidate.committedAt <= current.committedAt
    && candidate.reachability !== 'superseded'
    && candidate.reachability !== 'unreachable';
}

export function calculateLifecycleScopeTotals(input: {
  commits: Array<{
    id: string;
    repositoryId: string;
    reachability: string;
    finalAiLines: number;
    finalHumanLines: number;
  }>;
  commitSessions: Array<{ commitId: string; sessionId: string }>;
  sessionRepositories: Array<{ sessionId: string; repositoryId: string }>;
  allSessionIds: string[];
  repositoryIds: Set<string> | null;
  pullRequestCommitIds: Set<string> | null;
  contributorCommitIds: Set<string> | null;
  reworkRows?: Array<{ commitId: string | null; lineCount: number; evidenceType: string }>;
}) {
  const retained = (reachability: string) => reachability !== 'superseded'
    && reachability !== 'unreachable';
  const selectedCommits = input.commits
    .filter((commit) => retained(commit.reachability))
    .filter((commit) => !input.repositoryIds || input.repositoryIds.has(commit.repositoryId))
    .filter((commit) => !input.pullRequestCommitIds || input.pullRequestCommitIds.has(commit.id))
    .filter((commit) => !input.contributorCommitIds || input.contributorCommitIds.has(commit.id));
  const selectedCommitIds = new Set(selectedCommits.map((commit) => commit.id));
  const sessionIds = new Set(input.commitSessions
    .filter((link) => selectedCommitIds.has(link.commitId))
    .map((link) => link.sessionId));
  const isTenantScope = !input.repositoryIds
    && !input.pullRequestCommitIds
    && !input.contributorCommitIds;
  if (isTenantScope) input.allSessionIds.forEach((id) => sessionIds.add(id));
  if (input.repositoryIds && !input.pullRequestCommitIds && !input.contributorCommitIds) {
    input.sessionRepositories
      .filter((link) => input.repositoryIds!.has(link.repositoryId))
      .forEach((link) => sessionIds.add(link.sessionId));
  }
  const committedAiLines = selectedCommits.reduce((sum, commit) => sum + commit.finalAiLines, 0);
  const selectedRework = (input.reworkRows ?? [])
    .filter((row) => row.commitId !== null && selectedCommitIds.has(row.commitId));
  return {
    sessions: sessionIds.size,
    commits: selectedCommits.length,
    finalAiLines: currentRetainedAiLines(committedAiLines, selectedRework),
    finalHumanLines: selectedCommits.reduce((sum, commit) => sum + commit.finalHumanLines, 0),
  };
}

export function generationEvidenceForScope(input: {
  observations: Array<{ lineCount: number; evidenceType: string }>;
  commitLinked: Array<{ commitId: string | null; lineCount: number; evidenceType: string }>;
  commitIds: Set<string> | null;
}) {
  if (!input.commitIds) return input.observations;
  return input.commitLinked
    .filter((row) => row.commitId !== null && input.commitIds!.has(row.commitId))
    .map(({ lineCount, evidenceType }) => ({ lineCount, evidenceType }));
}
