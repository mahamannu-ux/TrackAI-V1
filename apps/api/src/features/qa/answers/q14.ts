/**
 * Q14 live answer (Task19b, T19.3): the chain for one pull request.
 *
 * Every figure comes from Task2's pullRequestIntelligence (the moved chain
 * logic, never copied): commit and session counts, retained lines, merged 1
 * or 0 from the merge result, and Task2's lifecycle production value.
 * Sessions are counted, not listed; the drill-down lists the commits.
 */
import { pullRequestIntelligence } from '../../telemetry/task2-lifecycle-read';
import {
  finishEnvelope,
  lifecycleFigure,
  rawAnswer,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaEnvelope, QaFigure } from '../types';

function unavailableFigures(): QaFigure[] {
  const reason = { code: 'answer_not_built' as const };
  return (['commits', 'sessions', 'final_ai_lines', 'final_human_lines', 'merged', 'production_ai_lines'] as const)
    .map((key) => ({ key, availability: 'unavailable' as const, reasons: [reason], value: null }));
}

export function computeQ14(input: ComputeInput): QaEnvelope {
  const { context, ctx } = input;
  const pullRequestId = ctx.scope.pull_request_id;
  const intel = pullRequestId ? pullRequestIntelligence(context, pullRequestId) : null;
  if (!intel) return finishEnvelope(ctx, context, unavailableFigures());
  const count = (key: string, n: number): QaFigure => ({
    key, availability: 'recorded', reasons: [], value: { type: 'count', count: n },
  });
  const production = lifecycleFigure(intel.lifecycle.production);
  return finishEnvelope(ctx, context, [
    count('commits', intel.commits.length),
    count('sessions', intel.sessions.length),
    count('final_ai_lines', intel.finalAiLines),
    count('final_human_lines', intel.finalHumanLines),
    count('merged', intel.mergeResult ? 1 : 0),
    {
      key: 'production_ai_lines',
      availability: production.availability,
      reasons: production.reasons,
      value: production.value,
    },
  ]);
}

export function answerQ14(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return rawAnswer(computeQ14)(ctx);
}

export const answererQ14: QaAnswerer = (ctx) => answerQ14(ctx);
