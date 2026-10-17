/**
 * Q19 live answer (Task19b, T19.3): the AI acceptance rate.
 *
 * Generated and committed come from Task2's summary (lifecycleForTenant);
 * generated keeps Task2's partial and its missing-evidence reason. Acceptance
 * is the ratio of the two, only when both are recorded. Breakdowns `model`,
 * `tool` and `repository` sit only on `committed_ai_lines`.
 */
import {
  finishEnvelope,
  lifecycleFigure,
  liveAnswer,
  ratioFigure,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ19(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q19: lifecycle scope facts are required');
  const generated = lifecycleFigure(scope.summary.generated);
  const generatedFigure: QaFigure = {
    key: 'generated_lines',
    availability: generated.availability,
    reasons: generated.reasons,
    value: generated.value,
  };
  const committed = lifecycleFigure(scope.summary.committed);
  const breakdown: QaBreakdownItem[] = [];
  if (committed.availability !== 'unavailable' && breakdownFacts) {
    if (ctx.breakdown === 'model' || ctx.breakdown === 'tool') {
      for (const model of breakdownFacts.models) {
        const bucket = lifecycleFigure(model.summary.committed);
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
        const bucket = lifecycleFigure(repo.scope.summary.committed);
        if (bucket.availability !== 'recorded' || bucket.value === null) continue;
        breakdown.push({ dimension: 'repository', key: repo.id, value: bucket.value });
      }
    }
  }
  const committedFigure: QaFigure = {
    key: 'committed_ai_lines',
    availability: committed.availability,
    reasons: committed.reasons,
    value: committed.value,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  const acceptance = scope.summary.generated.value !== null
    && scope.summary.committed.value !== null
    && scope.summary.generated.availability === 'recorded'
    && scope.summary.committed.availability === 'recorded'
    ? ratioFigure(scope.summary.committed.value, scope.summary.generated.value)
    : null;
  const acceptanceFigure: QaFigure = acceptance === null
    ? { key: 'acceptance', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null }
    : { key: 'acceptance', availability: 'recorded', reasons: [], value: acceptance };
  return finishEnvelope(ctx, context, [generatedFigure, committedFigure, acceptanceFigure]);
}

export function answerQ19(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ19)(ctx);
}

export const answererQ19: QaAnswerer = (ctx) => answerQ19(ctx);
