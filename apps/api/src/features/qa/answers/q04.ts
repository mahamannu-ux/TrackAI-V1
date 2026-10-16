/**
 * Q4 live answer (Task19b, T19.3): which AI tools and models touched production code.
 *
 * Models in production are the model keys whose period-filtered
 * lifecycleForModel summary.production is above 0 (Task2's function on
 * input-filtered rows, never a re-implementation). At commit scope the keys
 * are the commit's attributions; otherwise every key in scope. Approval is G2,
 * honestly unavailable. At commit scope the production figure is the
 * repository's (lifecycleForTenant scopes to repository, never to a commit).
 */
import { lifecycleForModel } from '../../telemetry/task2-lifecycle-read';
import { commitInScope } from '../drilldown';
import {
  finishEnvelope,
  lifecycleFigure,
  liveAnswer,
  modelKeysInScope,
  periodFilteredContext,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ4(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q4: lifecycle scope facts are required');
  const commit = commitInScope(context, ctx);
  const keys = commit
    ? [...new Set(context.commitModelAttributions
      .filter((row) => row.commitId === commit.id)
      .map((row) => row.modelKey))].sort()
    : modelKeysInScope(context, ctx).map(({ key }) => key);
  const filtered = periodFilteredContext(context, ctx);
  let inProduction = 0;
  for (const key of keys) {
    const production = lifecycleForModel(filtered, key).summary.production;
    if (production.value !== null && production.value > 0) inProduction += 1;
  }
  const models: QaFigure = {
    key: 'models_in_production',
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count: inProduction },
  };
  const production = lifecycleFigure(scope.summary.production);
  const breakdown: QaBreakdownItem[] = [];
  if (production.availability !== 'unavailable' && breakdownFacts
    && (ctx.breakdown === 'model' || ctx.breakdown === 'tool')) {
    for (const model of breakdownFacts.models) {
      const bucket = lifecycleFigure(model.summary.production);
      if (bucket.availability !== 'recorded' || bucket.value === null) continue;
      breakdown.push({
        dimension: ctx.breakdown,
        key: ctx.breakdown === 'model' ? model.key : model.tool,
        value: bucket.value,
      });
    }
  }
  const lines: QaFigure = {
    key: 'production_ai_lines',
    availability: production.availability,
    reasons: production.reasons,
    value: production.value,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  const approved: QaFigure = {
    key: 'approved_at_the_time',
    availability: 'unavailable',
    reasons: [{ code: 'not_captured_yet', gap: 'G2' }],
    value: null,
  };
  return finishEnvelope(ctx, context, [models, lines, approved]);
}

export function answerQ4(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ4)(ctx);
}

export const answererQ4: QaAnswerer = (ctx) => answerQ4(ctx);
