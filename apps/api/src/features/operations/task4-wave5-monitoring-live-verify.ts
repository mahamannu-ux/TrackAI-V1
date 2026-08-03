import 'dotenv/config';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  evidenceExportJobs,
  machineDeliveryHealthReports,
  retentionRuns,
  ssoTenants,
  telemetryMetricEvents,
} from '../../core/db/schema';
import { getTenantOperationalMonitoring } from '../../core/operations/operational-monitoring-service';

const companies = [
  { label: 'company_a', domain: 'purpletealabs.net' },
  { label: 'company_b', domain: 'customer-b-oidc.com' },
] as const;

const lifecycleCountsSql = sql`
  SELECT
    (SELECT count(*)::text FROM telemetry_metric_events) AS telemetry_metric_events,
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_session_usage) AS ai_session_usage,
    (SELECT count(*)::text FROM ai_generation_observations) AS ai_generation_observations,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events
`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const tenants = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants).where(inArray(
      ssoTenants.domain, companies.map(company => company.domain),
    ));
  const fixtures = companies.map(company => {
    const tenant = tenants.find(row => row.domain.toLowerCase() === company.domain);
    if (!tenant) throw new Error(`${company.label} tenant is missing`);
    return { ...company, tenantId: tenant.id };
  });
  const tenantIds = fixtures.map(fixture => fixture.tenantId);
  const [[beforeRuns], [beforeExports], beforeLifecycle] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(retentionRuns)
      .where(inArray(retentionRuns.tenantId, tenantIds)),
    db.select({ value: sql<number>`count(*)::int` }).from(evidenceExportJobs)
      .where(inArray(evidenceExportJobs.tenantId, tenantIds)),
    db.execute(lifecycleCountsSql),
  ]);
  const evaluatedAt = new Date();
  const monitoring = await Promise.all(fixtures.map(fixture => (
    getTenantOperationalMonitoring({ tenantId: fixture.tenantId, evaluatedAt })
  )));
  for (const [index, fixture] of fixtures.entries()) {
    const [metricCounts] = await db.select({
      normalized: sql<number>`count(*) filter (where ${telemetryMetricEvents.normalizationStatus} = 'normalized')::int`,
      pending: sql<number>`count(*) filter (where ${telemetryMetricEvents.normalizationStatus} = 'pending')::int`,
      failed: sql<number>`count(*) filter (where ${telemetryMetricEvents.normalizationStatus} = 'failed')::int`,
    }).from(telemetryMetricEvents).where(eq(telemetryMetricEvents.tenantId, fixture.tenantId));
    const actual = monitoring[index];
    if (actual.metrics.normalized !== metricCounts.normalized
      || actual.metrics.pending !== metricCounts.pending
      || actual.metrics.failed !== metricCounts.failed) {
      throw new Error(`${fixture.label} monitoring did not match its tenant evidence`);
    }
    const [completedExports] = await db.select({ value: sql<number>`count(*)::int` })
      .from(evidenceExportJobs).where(and(
        eq(evidenceExportJobs.tenantId, fixture.tenantId),
        eq(evidenceExportJobs.status, 'completed'),
      ));
    if (actual.exports.completed !== completedExports.value
      || actual.retention.decision !== 'retain') {
      throw new Error(`${fixture.label} export or retention monitoring is inconsistent`);
    }
    if (actual.providers.recentFailureCodes.some(row => (
      !/^[a-z0-9_-]+$/.test(row.code) || !Number.isSafeInteger(row.value) || row.value < 0
    ))) {
      throw new Error(`${fixture.label} monitoring exposed an unsafe failure value`);
    }
    const [healthReportCount] = await db.select({ value: sql<number>`count(*)::int` })
      .from(machineDeliveryHealthReports)
      .where(eq(machineDeliveryHealthReports.tenantId, fixture.tenantId));
    if (actual.clients.currentReports + actual.clients.staleReports > healthReportCount.value) {
      throw new Error(`${fixture.label} monitoring crossed its tenant health-report boundary`);
    }
    if (actual.clients.machines.some(machine => (
      !Number.isSafeInteger(machine.pendingRetryable) || machine.pendingRetryable < 0
      || !Number.isSafeInteger(machine.waitingRetry) || machine.waitingRetry < 0
      || !Number.isSafeInteger(machine.processing) || machine.processing < 0
      || !Number.isSafeInteger(machine.quarantined) || machine.quarantined < 0
      || !Number.isSafeInteger(machine.rowsWithErrors) || machine.rowsWithErrors < 0
    ))) {
      throw new Error(`${fixture.label} monitoring exposed invalid client delivery counts`);
    }
    if (fixture.label === 'company_a' && actual.clients.currentReports < 1) {
      throw new Error('company_a current machine delivery-health evidence is missing');
    }
    const latestClientReceivedAt = actual.clients.machines.reduce<Date | null>((latest, machine) => (
      machine.receivedAt !== null && (latest === null || machine.receivedAt > latest)
        ? machine.receivedAt
        : latest
    ), null);
    console.log(`${fixture.label}.health=${actual.health}`);
    console.log(`${fixture.label}.normalized=${actual.metrics.normalized}`);
    console.log(`${fixture.label}.pending=${actual.metrics.pending}`);
    console.log(`${fixture.label}.failed=${actual.metrics.failed}`);
    console.log(`${fixture.label}.completed_exports=${actual.exports.completed}`);
    console.log(`${fixture.label}.retention=${actual.retention.decision}`);
    console.log(`${fixture.label}.client_health_rows=${healthReportCount.value}`);
    console.log(`${fixture.label}.client_current_reports=${actual.clients.currentReports}`);
    console.log(`${fixture.label}.client_stale_reports=${actual.clients.staleReports}`);
    console.log(`${fixture.label}.client_unreported_machines=${actual.clients.unreportedMachines}`);
    console.log(`${fixture.label}.client_ready=${actual.clients.pendingRetryable}`);
    console.log(`${fixture.label}.client_waiting=${actual.clients.waitingRetry}`);
    console.log(`${fixture.label}.client_processing=${actual.clients.processing}`);
    console.log(`${fixture.label}.client_quarantined=${actual.clients.quarantined}`);
    console.log(`${fixture.label}.client_latest_received_at=${latestClientReceivedAt?.toISOString() ?? 'none'}`);
  }
  const [[afterRuns], [afterExports], afterLifecycle] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(retentionRuns)
      .where(inArray(retentionRuns.tenantId, tenantIds)),
    db.select({ value: sql<number>`count(*)::int` }).from(evidenceExportJobs)
      .where(inArray(evidenceExportJobs.tenantId, tenantIds)),
    db.execute(lifecycleCountsSql),
  ]);
  if (beforeRuns.value !== afterRuns.value || beforeExports.value !== afterExports.value) {
    throw new Error('Monitoring read changed operations metadata');
  }
  if (JSON.stringify(beforeLifecycle.rows) !== JSON.stringify(afterLifecycle.rows)) {
    throw new Error('Task2 lifecycle counts changed during monitoring verification');
  }
  console.log('logical_tenants=2');
  console.log('tenant_counts=reconciled-independently');
  console.log('safe_codes_only=verified');
  console.log('client_delivery_health=tenant-bound-counts-only');
  console.log('raw_evidence=never-returned-or-printed');
  console.log('operations_rows_created=0');
  console.log('task2_lifecycle_counts=unchanged');
  console.log('verification=read-only-complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 monitoring verification failed');
  process.exitCode = 1;
});
