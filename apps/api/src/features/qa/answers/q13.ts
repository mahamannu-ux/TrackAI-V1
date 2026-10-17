/**
 * Q13 live answer (Task19b, T19.3): how complete the evidence is.
 *
 * Not lifecycle semantics: raw-table aggregates over retained commits
 * committed in the period (always through contributesToCurrentCommittedState,
 * via commitsInScope). A null authorship note means no Git AI note.
 * Breakdown `repository` only on `commits`.
 */
import { commitsInScope } from '../drilldown';
import {
  finishEnvelope,
  rawAnswer,
  ratioFigure,
  type ComputeInput,
} from './common';
import type { QaAnswerContext, QaAnswerer, QaBreakdownItem, QaEnvelope, QaFigure } from '../types';

export function computeQ13(input: ComputeInput): QaEnvelope {
  const { context, ctx } = input;
  const commits = commitsInScope(context, ctx);
  const withoutNote = commits.filter((row) => row.authorshipNote === null).length;
  const unknownLines = commits.reduce((sum, row) => sum + row.observedUnknownLines, 0);
  const coverage = ratioFigure(commits.length - withoutNote, commits.length);
  const breakdown: QaBreakdownItem[] = [];
  if (ctx.breakdown === 'repository') {
    const byRepo = new Map<string, number>();
    for (const row of commits) byRepo.set(row.repositoryId, (byRepo.get(row.repositoryId) ?? 0) + 1);
    for (const [id, count] of [...byRepo.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      breakdown.push({ dimension: 'repository', key: id, value: { type: 'count', count } });
    }
  }
  const commitsFigure: QaFigure = {
    key: 'commits',
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count: commits.length },
    ...(breakdown.length > 0 ? { breakdown } : {}),
  };
  const noteFigure: QaFigure = {
    key: 'commits_without_git_ai_note',
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count: withoutNote },
  };
  const unknownFigure: QaFigure = {
    key: 'unknown_lines',
    availability: 'recorded',
    reasons: [],
    value: { type: 'count', count: unknownLines },
  };
  const coverageFigure: QaFigure = coverage === null
    ? { key: 'note_coverage', availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null }
    : { key: 'note_coverage', availability: 'recorded', reasons: [], value: coverage };
  return finishEnvelope(ctx, context, [commitsFigure, noteFigure, unknownFigure, coverageFigure]);
}

export function answerQ13(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return rawAnswer(computeQ13)(ctx);
}

export const answererQ13: QaAnswerer = (ctx) => answerQ13(ctx);
