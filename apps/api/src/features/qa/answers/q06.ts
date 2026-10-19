import { pullRequestIntelligence } from '../../telemetry/task2-lifecycle-read';
import { finishEnvelope, inPeriod, periodMs, rawAnswer, type ComputeInput } from './common';
import { pullRequestCommitIds, repositoryIdsInScope } from '../drilldown';
import type { QaAnswerer, QaEnvelope, QaFigure } from '../types';

export function computeQ6({ context, ctx }: ComputeInput): QaEnvelope {
  const { fromMs, toMs } = periodMs(ctx.scope);
  const repositoryIds = new Set(repositoryIdsInScope(context, ctx));
  const prs = context.pullRequests.filter((pr) =>
    repositoryIds.has(pr.repositoryId)
    && (!ctx.scope.pull_request_id || pr.id === ctx.scope.pull_request_id)
    && inPeriod(pr.mergedAt, fromMs, toMs)
    && (pullRequestIntelligence(context, pr.id)?.finalAiLines ?? 0) > 0);
  const countFor = (selected: typeof prs) => {
    const ids = new Set(selected.flatMap((pr) => [...pullRequestCommitIds(context, pr.id)]));
    return {
      ai_assisted_merged_prs: selected.length,
      merged_by_author: selected.filter((pr) => pr.mergedByProviderId
        && pr.mergedByProviderId === pr.authorProviderId).length,
      merged_by_someone_else: selected.filter((pr) => pr.mergedByProviderId
        && pr.mergedByProviderId !== pr.authorProviderId).length,
      merger_unknown: selected.filter((pr) => !pr.mergedByProviderId).length,
      committer_known: context.commits.filter((commit) => ids.has(commit.id) && commit.authorEmail).length,
    };
  };
  const counts = countFor(prs);
  const unknown = counts.merger_unknown;
  const figures: QaFigure[] = Object.entries(counts).map(([key, count]) => ({
    key,
    availability: unknown > 0 && (key === 'merged_by_author' || key === 'merged_by_someone_else')
      ? 'partial' : 'recorded',
    reasons: unknown > 0 && (key === 'merged_by_author' || key === 'merged_by_someone_else')
      ? [{ code: 'not_captured_yet', gap: 'G4' }] : [],
    value: { type: 'count', count },
    ...(ctx.breakdown === 'repository' ? { breakdown: [...repositoryIds].sort().map((repositoryId) => ({
      dimension: 'repository' as const,
      key: repositoryId,
      value: { type: 'count' as const, count: countFor(prs.filter((pr) => pr.repositoryId === repositoryId))[key as keyof typeof counts] },
    })) } : {}),
  }));
  return finishEnvelope(ctx, context, figures);
}

export const answererQ6: QaAnswerer = rawAnswer(computeQ6);
