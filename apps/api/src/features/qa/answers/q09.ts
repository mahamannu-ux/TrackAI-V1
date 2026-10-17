/**
 * Q9 live answer (Task19b, T19.3): which AI-assisted changes reached production.
 *
 * Production lines come from Task2's summary.production; the merged proxy is
 * its own figure (summary.mergedProxy, never added to production). The
 * deployment count is Task2's deployment rows cut to the scope and period
 * (input filtering; evidence.deployments itself is all-time). No Task2
 * calculation maps deployments to one pull request, so at PR scope the
 * deployment figure is unavailable until Task2 supplies one (review fix 3).
 * Breakdown `repository` only on `production_ai_lines`.
 */
import {
  deploymentsInScope,
  finishEnvelope,
  lifecycleFigure,
  liveAnswer,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ9(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q9: lifecycle scope facts are required');
  const production = lifecycleFigure(scope.summary.production);
  const breakdown: QaBreakdownItem[] = [];
  if (production.availability !== 'unavailable' && ctx.breakdown === 'repository' && breakdownFacts) {
    for (const repo of breakdownFacts.repositories) {
      const bucket = lifecycleFigure(repo.scope.summary.production);
      if (bucket.availability !== 'recorded' || bucket.value === null) continue;
      breakdown.push({ dimension: 'repository', key: repo.id, value: bucket.value });
    }
  }
  const lines: QaFigure = {
    key: 'production_ai_lines',
    availability: production.availability,
    reasons: production.reasons,
    value: production.value,
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  const proxy = lifecycleFigure(scope.summary.mergedProxy);
  const proxyFigure: QaFigure = {
    key: 'merged_not_deployed_proxy_lines',
    availability: proxy.availability,
    reasons: proxy.reasons,
    value: proxy.value,
  };
  const deployments: QaFigure = ctx.scope.pull_request_id
    ? { key: 'production_deployments', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null }
    : {
      key: 'production_deployments',
      availability: 'recorded',
      reasons: [],
      value: { type: 'count', count: deploymentsInScope(context, ctx) },
    };
  return finishEnvelope(ctx, context, [lines, proxyFigure, deployments]);
}

export function answerQ9(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ9)(ctx);
}

export const answererQ9: QaAnswerer = (ctx) => answerQ9(ctx);
