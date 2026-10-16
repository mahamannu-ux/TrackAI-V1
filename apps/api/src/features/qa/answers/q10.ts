/**
 * Q10 live answer (Task19b, T19.3): how much AI code was reworked, and by whom.
 *
 * Rework comes from Task2's summary.reworked and summary.reworkByActor. A
 * missing actor key reads as 0 only when Task2's reworked value is recorded;
 * otherwise the bucket is unavailable. Churned is never written by any Task2
 * writer, so it stays unavailable with `never_written`. Breakdown
 * `repository` only on `reworked_ai_lines`.
 */
import {
  finishEnvelope,
  lifecycleFigure,
  liveAnswer,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ10(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q10: lifecycle scope facts are required');
  const reworked = lifecycleFigure(scope.summary.reworked);
  const breakdown: QaBreakdownItem[] = [];
  if (reworked.availability !== 'unavailable' && ctx.breakdown === 'repository' && breakdownFacts) {
    for (const repo of breakdownFacts.repositories) {
      const bucket = lifecycleFigure(repo.scope.summary.reworked);
      if (bucket.availability !== 'recorded' || bucket.value === null) continue;
      breakdown.push({ dimension: 'repository', key: repo.id, value: bucket.value });
    }
  }
  const reworkedFigure: QaFigure = {
    key: 'reworked_ai_lines',
    availability: reworked.availability,
    reasons: reworked.reasons,
    value: reworked.value,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  // Actor buckets partition the reworked lines; any other actor kind Task2
  // reports folds into unknown (unattributed), so the three buckets still sum
  // to the reworked figure.
  const byActor = (actor: 'ai' | 'human' | 'unknown'): QaFigure => {
    const key = actor === 'ai' ? 'reworked_by_ai' : actor === 'human' ? 'reworked_by_human' : 'reworked_by_unknown';
    if (scope.summary.reworked.availability !== 'recorded') {
      return { key, availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null };
    }
    const extra = actor === 'unknown'
      ? Object.entries(scope.summary.reworkByActor)
        .filter(([name]) => name !== 'ai' && name !== 'human' && name !== 'unknown')
        .reduce((sum, [, n]) => sum + n, 0)
      : 0;
    return {
      key,
      availability: 'recorded',
      reasons: [],
      value: { type: 'count', count: (scope.summary.reworkByActor[actor] ?? 0) + extra },
    };
  };
  const churned: QaFigure = {
    key: 'churned_ai_lines',
    availability: 'unavailable',
    reasons: [{ code: 'never_written' }],
    value: null,
  };
  return finishEnvelope(ctx, context, [
    reworkedFigure, byActor('ai'), byActor('human'), byActor('unknown'), churned,
  ]);
}

export function answerQ10(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ10)(ctx);
}

export const answererQ10: QaAnswerer = (ctx) => answerQ10(ctx);
