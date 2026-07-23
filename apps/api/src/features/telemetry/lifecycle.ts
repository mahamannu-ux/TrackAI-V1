export const LIFECYCLE_STAGES = [
  'generated',
  'committed',
  'in_pr',
  'merged',
  'production',
  'reworked',
  'churned',
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

export type LifecycleEvidence = {
  stage: string;
  lineCount: number;
  actorKind?: string | null;
  evidenceType: string;
};

export type LifecycleValue = {
  value: number | null;
  availability: 'recorded' | 'unavailable';
  evidenceTypes: string[];
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
export function calculateLifecycleSummary(rows: LifecycleEvidence[]): LifecycleSummary {
  const generated = valueFor(rows, 'generated');
  const committed = valueFor(rows, 'committed');
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

export function fallbackSessionName(tool: string, startedAt: Date | null, externalId: string): string {
  const day = startedAt ? startedAt.toISOString().slice(0, 10) : 'unknown date';
  return `${tool} session · ${day} · ${externalId.slice(0, 8)}`;
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
