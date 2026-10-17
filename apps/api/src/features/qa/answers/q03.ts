/**
 * Q3 live answer (Task19b, T19.3): the share of merged changes that are AI-assisted.
 *
 * `merged_ai_lines` comes from Task2's summary.merged (lifecycleForTenant);
 * the share divides Task2's retained scope totals. A merged-only denominator
 * does not exist in Task2: an open issue for Task2 (handoff). Breakdowns
 * `model`, `tool` and `repository` sit only on `merged_ai_lines`; the bucket
 * `unknown` stays whenever the data has it.
 */
import {
  finishEnvelope,
  lifecycleFigure,
  liveAnswer,
  ratioFigure,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ3(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q3: lifecycle scope facts are required');
  const merged = lifecycleFigure(scope.summary.merged);
  const breakdown: QaBreakdownItem[] = [];
  if (merged.availability !== 'unavailable' && breakdownFacts) {
    if (ctx.breakdown === 'model' || ctx.breakdown === 'tool') {
      for (const model of breakdownFacts.models) {
        const bucket = lifecycleFigure(model.summary.merged);
        if (bucket.availability !== 'recorded' || bucket.value === null) continue;
        breakdown.push({
          dimension: ctx.breakdown,
          key: ctx.breakdown === 'model' ? model.key : model.tool,
          value: bucket.value,
        });
      }
    }
    if (ctx.breakdown === 'repository') {
      for (const repo of breakdownFacts.repositories) {
        const bucket = lifecycleFigure(repo.scope.summary.merged);
        if (bucket.availability !== 'recorded' || bucket.value === null) continue;
        breakdown.push({ dimension: 'repository', key: repo.id, value: bucket.value });
      }
    }
  }
  const mergedFigure: QaFigure = {
    key: 'merged_ai_lines',
    availability: merged.availability,
    reasons: merged.reasons,
    value: merged.value,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  const share = ratioFigure(
    scope.totals.finalAiLines,
    scope.totals.finalAiLines + scope.totals.finalHumanLines,
  );
  const shareFigure: QaFigure = share === null
    ? { key: 'ai_share_of_retained_lines', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null }
    : { key: 'ai_share_of_retained_lines', availability: 'recorded', reasons: [], value: share };
  return finishEnvelope(ctx, context, [mergedFigure, shareFigure]);
}

export function answerQ3(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ3)(ctx);
}

export const answererQ3: QaAnswerer = (ctx) => answerQ3(ctx);
