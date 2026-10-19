import { loadContext } from '../../telemetry/task2-lifecycle-read';
import { githubBlame, type BlameResult } from '../../scm/github-blame';
import { QA_REGISTRY_VERSION } from '../registry';
import type { QaAnswerContext, QaAnswerer, QaDrilldown, QaEnvelope, QaFigure, QaReason } from '../types';

type Context = Awaited<ReturnType<typeof loadContext>>;
type Commit = Context['commits'][number];

/** Walks rewrite and merge edges, accepting only a unique nearest known commit. */
export function resolveOriginCommit(context: Context, repositoryId: string, sha: string): Commit | null {
  const direct = context.commits.find((commit) => commit.repositoryId === repositoryId && commit.sha === sha);
  if (direct) return direct;
  const known = new Map(context.commits.filter((commit) => commit.repositoryId === repositoryId)
    .map((commit) => [commit.sha, commit]));
  const seen = new Set([sha]);
  let frontier = [sha];
  for (let depth = 0; depth < 32 && frontier.length; depth += 1) {
    const next = new Set<string>();
    for (const current of frontier) {
      for (const edge of context.commitLineage) {
        if (edge.repositoryId !== repositoryId) continue;
        if (edge.predecessorSha === current) next.add(edge.successorSha);
        if (edge.successorSha === current) next.add(edge.predecessorSha);
      }
      for (const edge of context.mergeLineage) {
        if (edge.resultSha !== current) continue;
        const source = context.commits.find((commit) => commit.id === edge.sourceCommitId
          && commit.repositoryId === repositoryId);
        if (source) next.add(source.sha);
      }
    }
    const unvisited = [...next].filter((candidate) => !seen.has(candidate));
    const matches = unvisited.flatMap((candidate) => known.get(candidate) ?? []);
    if (matches.length) return matches.length === 1 ? matches[0] : null;
    unvisited.forEach((candidate) => seen.add(candidate));
    frontier = unvisited;
  }
  return null;
}

function unavailable(ctx: QaAnswerContext, reason: QaReason): QaEnvelope {
  const figures: QaFigure[] = ['line_written_by_ai', 'originating_commit_known',
    'file_ai_lines', 'file_human_lines'].map((key) => ({
      key, availability: 'unavailable', reasons: [reason], value: null,
    }));
  return {
    question_id: 'Q2', registry_version: QA_REGISTRY_VERSION, kind: 'live', as_of: ctx.now,
    scope: ctx.scope, availability: 'unavailable', reasons: [reason], figures,
    wording: ['metadata_only'], drilldown: [],
  };
}

export function computeQ2(ctx: QaAnswerContext, context: Context, blame: BlameResult): QaEnvelope {
  if (blame.status !== 'ok') return unavailable(ctx, { code: 'answer_not_built' });
  if (!blame.originSha) return unavailable(ctx, { code: 'partial_linkage' });
  const repositoryId = ctx.scope.repository_id!;
  const origin = resolveOriginCommit(context, repositoryId, blame.originSha);
  if (!origin) return unavailable(ctx, { code: 'partial_linkage' });
  const requested = context.commits.find((commit) => commit.repositoryId === repositoryId
    && commit.sha === ctx.scope.commit_sha);
  const requestedFile = context.files.find((file) => file.id === ctx.scope.file_id
    && file.commitId === requested?.id);
  const file = context.files.find((candidate) => candidate.commitId === origin.id
    && candidate.path === requestedFile?.path);
  if (!file) return unavailable(ctx, { code: 'partial_linkage' });
  const exact = origin.id === requested?.id;
  const ranges = Array.isArray(file.attributionRanges) ? file.attributionRanges : [];
  const range = exact ? ranges.find((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    return typeof value.startLine === 'number' && typeof value.endLine === 'number'
      && ctx.scope.line! >= value.startLine && ctx.scope.line! <= value.endLine;
  }) as Record<string, unknown> | undefined : undefined;
  const reason: QaReason = { code: 'partial_linkage' };
  const figure = (key: string, count: number | null, isPartial = false): QaFigure => ({
    key,
    availability: count === null ? 'unavailable' : isPartial ? 'partial' : 'recorded',
    reasons: count === null || isPartial ? [reason] : [],
    value: count === null ? null : { type: 'count', count },
  });
  const sessionIds = new Set(!exact ? context.commitSessions.filter((row) => row.commitId === origin.id)
    .map((row) => row.sessionId) : []);
  if (exact && typeof range?.sessionId === 'string') {
    const matching = context.sessions.find((session) => session.gitAiSessionId === range.sessionId
      || session.externalSessionId === range.sessionId);
    if (matching) sessionIds.add(matching.id);
  }
  const drilldown: QaDrilldown[] = [
    { scope: 'commit' as const, id: origin.id, label: origin.sha.slice(0, 12) },
    ...[...sessionIds].sort().map((id) => ({ scope: 'session' as const, id, label: id })),
  ].slice(0, 20);
  const figures: QaFigure[] = [
    figure('line_written_by_ai', exact && (range?.kind === 'ai' || range?.kind === 'human')
      ? (range.kind === 'ai' ? 1 : 0) : null),
    figure('originating_commit_known', 1),
    figure('file_ai_lines', file.observedAiLines, !exact),
    figure('file_human_lines', file.observedHumanLines, !exact),
  ];
  const reasons = [...new Map(figures.flatMap((item) => item.reasons)
    .map((item) => [JSON.stringify(item), item])).values()];
  return {
    question_id: 'Q2', registry_version: QA_REGISTRY_VERSION, kind: 'live', as_of: ctx.now,
    scope: ctx.scope,
    availability: reasons.length ? 'partial' : 'recorded', reasons, figures,
    wording: ['metadata_only'], drilldown,
  };
}

export function createQ2Answerer(
  load: typeof loadContext = loadContext,
  blameFor: typeof githubBlame = githubBlame,
): QaAnswerer { return async (ctx) => {
  const context = await load(ctx.tenantId);
  const repository = context.repositories.find((row) => row.id === ctx.scope.repository_id);
  const commit = context.commits.find((row) => row.repositoryId === repository?.id
    && row.sha === ctx.scope.commit_sha);
  const file = context.files.find((row) => row.id === ctx.scope.file_id && row.commitId === commit?.id);
  if (!repository || !commit || !file) return unavailable(ctx, { code: 'answer_not_built' });
  if (repository.provider !== 'github') return unavailable(ctx, { code: 'answer_not_built' });
  const blame = await blameFor({
    tenantId: ctx.tenantId, repositoryId: repository.id, repositoryUrl: repository.url,
    commitSha: commit.sha, fileId: file.id, path: file.path, line: ctx.scope.line!,
  });
  return computeQ2(ctx, context, blame);
}; }

export const answererQ2 = createQ2Answerer();
