/**
 * Q18 live answer (Task19b, T19.3): what AI cost (tokens, money).
 *
 * Not lifecycle semantics: raw-table aggregates. Sessions in scope are the
 * ones linked (commitSessions) to retained commits in scope and period.
 * A null token is missing, never 0: any usage row with a null token, or any
 * in-scope session without usage, makes that figure partial with
 * `vendor_does_not_report`; no usage at all is unavailable with the same
 * reason. Cost is an integer count of millionths per cost unit (lowercase),
 * rounded per row then summed. Breakdowns `model`, `tool` and `repository`
 * sit only on `output_tokens`; a session linked to anything but exactly one
 * repository buckets as `unknown` rather than double-counted.
 */
import { commitsInScope } from '../drilldown';
import {
  finishEnvelope,
  rawAnswer,
  type ComputeInput,
  type QaContext,
} from './common';
import type {
  QaAnswerContext,
  QaAnswerer,
  QaBreakdownItem,
  QaEnvelope,
  QaFigure,
  QaValue,
} from '../types';

const TOKEN_FIGURES = [
  { key: 'input_tokens', pick: (row: UsageRow) => row.inputTokens },
  { key: 'output_tokens', pick: (row: UsageRow) => row.outputTokens },
  { key: 'reasoning_tokens', pick: (row: UsageRow) => row.reasoningTokens },
  { key: 'cache_read_tokens', pick: (row: UsageRow) => row.cacheReadTokens },
  { key: 'cache_write_tokens', pick: (row: UsageRow) => row.cacheWriteTokens },
] as const;

type UsageRow = QaContext['usage'][number];

const VENDOR: { code: 'vendor_does_not_report' } = { code: 'vendor_does_not_report' };

export function computeQ18(input: ComputeInput): QaEnvelope {
  const { context, ctx } = input;
  const inScopeCommits = new Set(commitsInScope(context, ctx).map((row) => row.id));
  const sessionIds = new Set(context.commitSessions
    .filter((link) => inScopeCommits.has(link.commitId))
    .map((link) => link.sessionId));
  const rows = context.usage.filter((row) => sessionIds.has(row.sessionId));
  const withUsage = new Set(rows.map((row) => row.sessionId));
  const missing = [...sessionIds].some((id) => !withUsage.has(id));
  const tokenFigures: QaFigure[] = TOKEN_FIGURES.map(({ key, pick }): QaFigure => {
    if (rows.length === 0) {
      return { key, availability: 'unavailable', reasons: [VENDOR], value: null };
    }
    const values = rows.map((row) => pick(row));
    const sum: number = values.reduce<number>((total, v) => total + (v ?? 0), 0);
    if (!missing && values.every((v) => v !== null)) {
      return { key, availability: 'recorded', reasons: [], value: { type: 'count', count: sum } };
    }
    return { key, availability: 'partial', reasons: [VENDOR], value: null };
  });
  // Cost per unit, only for units with at least one reported amount. A row
  // with a null amount or unit may hide money in any unit, so every cost
  // figure it touches is partial.
  const unattributed = rows.some((row) => row.costAmount === null || row.costUnit === null);
  const units = [...new Set(rows
    .filter((row) => row.costUnit !== null && row.costAmount !== null)
    .map((row) => (row.costUnit as string).toLowerCase()))].sort();
  const costFigures: QaFigure[] = units.map((unit) => {
    const sum = rows
      .filter((row) => row.costUnit !== null && row.costUnit.toLowerCase() === unit && row.costAmount !== null)
      .reduce((total, row) => total + Math.round(Number(row.costAmount) * 1e6), 0);
    const value: QaValue = { type: 'count', count: sum };
    if (!missing && !unattributed) {
      return { key: `cost_micro_${unit}`, availability: 'recorded' as const, reasons: [], value };
    }
    return { key: `cost_micro_${unit}`, availability: 'partial' as const, reasons: [VENDOR], value: null };
  });
  const output = tokenFigures.find((figure) => figure.key === 'output_tokens');
  if (output && output.availability !== 'unavailable'
    && (ctx.breakdown === 'model' || ctx.breakdown === 'tool' || ctx.breakdown === 'repository')) {
    const dimension = ctx.breakdown;
    const buckets = new Map<string, number>();
    for (const row of rows) {
      if (row.outputTokens === null) continue;
      const key = bucketKey(context, ctx, row);
      buckets.set(key, (buckets.get(key) ?? 0) + row.outputTokens);
    }
    const breakdown: QaBreakdownItem[] = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, count]) => ({ dimension, key, value: { type: 'count' as const, count } }));
    if (breakdown.length > 0) output.breakdown = breakdown;
  }
  return finishEnvelope(ctx, context, [...tokenFigures, ...costFigures]);
}

function bucketKey(context: QaContext, ctx: QaAnswerContext, row: UsageRow): string {
  if (ctx.breakdown === 'model') return row.model ?? 'unknown';
  if (ctx.breakdown === 'tool') {
    return context.sessions.find((session) => session.id === row.sessionId)?.tool ?? 'unknown';
  }
  const repos = context.sessionRepositories
    .filter((link) => link.sessionId === row.sessionId)
    .map((link) => link.repositoryId);
  const unique = [...new Set(repos)];
  return unique.length === 1 ? unique[0] : 'unknown';
}

export function answerQ18(ctx: QaAnswerContext): Promise<QaEnvelope> {
  return rawAnswer(computeQ18)(ctx);
}

export const answererQ18: QaAnswerer = (ctx) => answerQ18(ctx);
