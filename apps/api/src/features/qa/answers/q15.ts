import { eq } from 'drizzle-orm';
import { db } from '../../../core/db';
import { withTenant } from '../../../core/db/tenant';
import { securityAuditEvents } from '../../../core/db/schema';
import { QA_REGISTRY_VERSION } from '../registry';
import type { QaAnswerer, QaEnvelope, QaFigure } from '../types';

const REASONS = ['repository_missing', 'repository_url_invalid', 'grant_inactive', 'before_watermark'] as const;
type Rejection = typeof securityAuditEvents.$inferSelect;

export function computeQ15(ctx: Parameters<QaAnswerer>[0], allRows: Rejection[]): QaEnvelope {
  const rows = allRows.filter((row) => row.occurredAt >= new Date(ctx.scope.from)
    && row.occurredAt <= new Date(ctx.scope.to));
  const priorCapture = allRows.length > 0;
  const byMachine = (key: string, selected: Rejection[]) => {
    if (ctx.breakdown !== 'machine') return undefined;
    const ids = [...new Set(selected.map((row) => row.actorId))].sort();
    return ids.map((id) => ({
      dimension: 'machine' as const, key: id,
      value: { type: 'count' as const, count: count(key, selected.filter((row) => row.actorId === id)) },
    }));
  };
  const count = (key: string, selected: Rejection[]): number => {
    if (key === 'rejected_uploads') return selected.length;
    if (key === 'rejected_repositories') return new Set(selected.flatMap((row) => {
      const details = row.details as Record<string, unknown>;
      return Array.isArray(details.repository_digests)
        ? details.repository_digests.filter((digest): digest is string => typeof digest === 'string') : [];
    })).size;
    return selected.reduce((sum, row) => {
      const details = row.details as Record<string, unknown>;
      if (key === 'rejected_events') return sum + (Number(details.event_count) || 0);
      const reasonCounts = details.reason_counts as Record<string, unknown> | undefined;
      return sum + (Number(reasonCounts?.[key.slice('rejected_events_'.length)]) || 0);
    }, 0);
  };
  const keys = ['rejected_uploads', 'rejected_events',
    ...REASONS.map((reason) => `rejected_events_${reason}`), 'rejected_repositories'];
  const figures: QaFigure[] = keys.map((key) => {
    if (ctx.breakdown === 'repository' || ctx.scope.repository_id) return {
      key, availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], value: null,
    };
    if (!priorCapture) return {
      key, availability: 'partial', reasons: [{ code: 'not_captured_yet', gap: 'G5' }], value: null,
    };
    return {
      key, availability: 'recorded', reasons: [], value: { type: 'count', count: count(key, rows) },
      ...(ctx.breakdown === 'machine' ? { breakdown: byMachine(key, rows) } : {}),
    };
  });
  const unavailable = ctx.breakdown === 'repository' || Boolean(ctx.scope.repository_id);
  const partial = !priorCapture && !unavailable;
  return {
    question_id: 'Q15', registry_version: QA_REGISTRY_VERSION, kind: 'live', as_of: ctx.now,
    scope: ctx.scope, availability: unavailable ? 'unavailable' : partial ? 'partial' : 'recorded',
    reasons: unavailable ? [{ code: 'answer_not_built' }] : partial ? [{ code: 'not_captured_yet', gap: 'G5' }] : [],
    figures, wording: [], drilldown: [],
  };
}

export const answererQ15: QaAnswerer = async (ctx) => {
  const rows = await withTenant(db, ctx.tenantId).select(securityAuditEvents,
    eq(securityAuditEvents.action, 'telemetry.upload.rejected'));
  return computeQ15(ctx, rows);
};
