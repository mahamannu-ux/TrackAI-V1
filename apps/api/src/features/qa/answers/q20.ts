/**
 * Q20 live answer (Task19b, T19.3): which repositories use AI most, and how it changes.
 *
 * Committed AI lines come from Task2's scope totals (lifecycleForTenant),
 * with `previous` carrying the same figure keys over previousPeriod. There is
 * no team entity anywhere, so the team figure — and any `team` breakdown —
 * stays unavailable with `answer_not_built` (an open issue for the lead,
 * TASK19.md §3.1). Breakdown `repository` sits on both periods' committed
 * figure. Q20 is tenant scope only.
 */
import { loadContext } from '../../telemetry/task2-lifecycle-read';
import { previousPeriod } from '../service';
import {
  finishEnvelope,
  loadScopeFacts,
  type ComputeInput,
  type ScopeFacts,
} from './common';
import type {
  QaAnswerContext,
  QaAnswerer,
  QaBreakdownItem,
  QaEnvelope,
  QaFigure,
} from '../types';

function committedFigure(
  totals: ScopeFacts['totals'],
  ctx: QaAnswerContext,
  repos: Array<{ id: string; scope: ScopeFacts }>,
): QaFigure {
  const breakdown: QaBreakdownItem[] = [];
  if (ctx.breakdown === 'repository') {
    for (const repo of repos) {
      breakdown.push({
        dimension: 'repository',
        key: repo.id,
        value: { type: 'count', count: repo.scope.totals.finalAiLines },
      });
    }
    breakdown.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  return {
    key: 'ai_committed_lines',
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count: totals.finalAiLines },
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
}

function teamFigure(): QaFigure {
  return {
    key: 'team',
    availability: 'unavailable',
    reasons: [{ code: 'answer_not_built' }],
    value: null,
  };
}

export function computeQ20(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts, previous } = input;
  if (!scope) throw new Error('Task19b Q20: lifecycle scope facts are required');
  const figures: QaFigure[] = [
    committedFigure(scope.totals, ctx, breakdownFacts?.repositories ?? []),
    teamFigure(),
  ];
  const { from, to } = previousPeriod(ctx.scope);
  const prevFigures: QaFigure[] = [
    committedFigure(
      previous?.scope.totals ?? scope.totals,
      ctx,
      previous?.breakdownFacts.repositories ?? [],
    ),
    teamFigure(),
  ];
  return finishEnvelope(ctx, context, figures, { from, to, figures: prevFigures });
}

export async function answerQ20(ctx: QaAnswerContext): Promise<QaEnvelope> {
  const context = await loadContext(ctx.tenantId);
  const { scope, breakdownFacts } = await loadScopeFacts(ctx.tenantId, context, ctx);
  const { from, to } = previousPeriod(ctx.scope);
  const prevCtx: QaAnswerContext = { ...ctx, scope: { ...ctx.scope, from, to } };
  const prev = await loadScopeFacts(ctx.tenantId, context, prevCtx);
  return computeQ20({
    context,
    ctx,
    scope,
    breakdownFacts,
    previous: { from, to, scope: prev.scope, breakdownFacts: prev.breakdownFacts },
  });
}

export const answererQ20: QaAnswerer = (ctx) => answerQ20(ctx);
