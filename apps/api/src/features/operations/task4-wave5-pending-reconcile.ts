import 'dotenv/config';

import { eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { securityAuditEvents, ssoTenants } from '../../core/db/schema';
import { reconcilePendingMetricEvents } from '../telemetry/service';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const apply = process.env.TASK4_WAVE5_PENDING_RECONCILE_APPLY === '1';
  const [tenant] = await db.select({ id: ssoTenants.id }).from(ssoTenants)
    .where(eq(ssoTenants.domain, 'purpletealabs.net')).limit(1);
  if (!tenant) throw new Error('Company A tenant is missing');
  const before = await db.execute(sql`
    SELECT
      (SELECT count(*)::text FROM ai_sessions WHERE tenant_id = ${tenant.id}) AS ai_sessions,
      (SELECT count(*)::text FROM ai_session_usage WHERE tenant_id = ${tenant.id}) AS ai_session_usage,
      (SELECT count(*)::text FROM ai_code_lifecycle_events WHERE tenant_id = ${tenant.id}) AS ai_code_lifecycle_events,
      (SELECT count(*)::text FROM ai_model_lifecycle_events WHERE tenant_id = ${tenant.id}) AS ai_model_lifecycle_events
  `);
  const result = await reconcilePendingMetricEvents({
    tenantId: tenant.id,
    apply,
    limit: 100,
  });
  if (apply) {
    await db.insert(securityAuditEvents).values({
      tenantId: tenant.id,
      actorType: 'system_operator',
      actorId: 'task4-wave5-pending-reconciler',
      action: 'telemetry_normalization.reconciled',
      targetType: 'tenant_evidence',
      targetId: tenant.id,
      details: {
        selected: result.selected,
        normalized: result.normalized,
        failed: result.failed,
        eventKinds: result.eventKinds,
      },
    });
  }
  const after = await db.execute(sql`
    SELECT
      (SELECT count(*)::text FROM ai_sessions WHERE tenant_id = ${tenant.id}) AS ai_sessions,
      (SELECT count(*)::text FROM ai_session_usage WHERE tenant_id = ${tenant.id}) AS ai_session_usage,
      (SELECT count(*)::text FROM ai_code_lifecycle_events WHERE tenant_id = ${tenant.id}) AS ai_code_lifecycle_events,
      (SELECT count(*)::text FROM ai_model_lifecycle_events WHERE tenant_id = ${tenant.id}) AS ai_model_lifecycle_events
  `);
  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`selected_rows=${result.selected}`);
  console.log(`event_kinds=${Object.entries(result.eventKinds).map(([kind, count]) => `${kind}:${count}`).join(',') || 'none'}`);
  console.log(`normalized_rows=${result.normalized}`);
  console.log(`failed_rows=${result.failed}`);
  console.log(`projection_counts_changed=${JSON.stringify(before.rows) === JSON.stringify(after.rows) ? 'no' : 'yes-expected-from-recovered-evidence'}`);
  console.log('raw_events=read-internally-not-printed-or-rewritten');
  console.log(`database_changes=${result.databaseChanges}`);
  console.log(apply
    ? 'next=rerun-dry-run-and-monitoring-to-prove-idempotent-convergence'
    : 'next=review-backup-then-rerun-with-explicit-apply');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Pending reconciliation failed');
  process.exitCode = 1;
});
