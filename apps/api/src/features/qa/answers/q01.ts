/**
 * Q1 live answer (Task19b, T19.3): the share of changed lines that are AI-assisted.
 *
 * Changed lines come from Task2's scope totals (lifecycleForTenant); the whole
 * repository share is G1, honestly unavailable. Breakdown `repository` only on
 * the changed-lines share.
 */
import {
  finishEnvelope,
  liveAnswer,
  ratioFigure,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaEnvelope, QaFigure } from '../types';

export function computeQ1(input: ComputeInput): QaEnvelope {
  const { context, ctx, scope, breakdownFacts } = input;
  if (!scope) throw new Error('Task19b Q1: lifecycle scope facts are required');
  const denominator = scope.totals.finalAiLines + scope.totals.finalHumanLines;
  const share = ratioFigure(scope.totals.finalAiLines, denominator);
  const changed: QaFigure = share === null
    ? { key: 'ai_share_of_changed_lines', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null }
    : {
      key: 'ai_share_of_changed_lines',
      availability: 'recorded',
      reasons: [],
      value: share,
      ...(ctx.breakdown === 'repository' && breakdownFacts
        ? {
          breakdown: breakdownFacts.repositories.flatMap((repo) => {
            const value = ratioFigure(
              repo.scope.totals.finalAiLines,
              repo.scope.totals.finalAiLines + repo.scope.totals.finalHumanLines,
            );
            return value === null
              ? []
              : [{ dimension: 'repository' as const, key: repo.id, value }];
          }),
        }
        : {}),
    };
  const repository: QaFigure = {
    key: 'ai_share_of_repository',
    availability: 'unavailable',
    reasons: [{ code: 'not_captured_yet', gap: 'G1' }],
    value: null,
  };
  return finishEnvelope(ctx, context, [changed, repository]);
}

export function answerQ1(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return liveAnswer(computeQ1)(ctx);
}

export const answererQ1: QaAnswerer = (ctx) => answerQ1(ctx);
