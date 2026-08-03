import 'dotenv/config';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  evidenceArchiveEntries,
  evidenceExportJobs,
  retentionRuns,
  ssoTenants,
} from '../../core/db/schema';
import { planTenantRetentionRun } from '../../core/operations/retention-run-service';

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
  const [[beforeRuns], beforeLifecycle, completedArchives, archiveCrossings] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(retentionRuns)
      .where(inArray(retentionRuns.tenantId, tenantIds)),
    db.execute(lifecycleCountsSql),
    db.select({
      tenantId: evidenceExportJobs.tenantId,
      value: sql<number>`count(*)::int`,
    }).from(evidenceExportJobs).where(and(
      inArray(evidenceExportJobs.tenantId, tenantIds),
      eq(evidenceExportJobs.status, 'completed'),
      eq(evidenceExportJobs.archivePurpose, true),
    )).groupBy(evidenceExportJobs.tenantId),
    db.select({ value: sql<number>`count(*)::int` }).from(evidenceArchiveEntries)
      .innerJoin(evidenceExportJobs, sql`${evidenceExportJobs.id} = ${evidenceArchiveEntries.exportJobId}`)
      .where(sql`${evidenceExportJobs.tenantId} <> ${evidenceArchiveEntries.tenantId}`),
  ]);
  const evaluatedAt = new Date();
  const plans = await Promise.all(fixtures.map(fixture => planTenantRetentionRun({
    tenantId: fixture.tenantId,
    evaluatedAt,
  })));
  for (const [index, plan] of plans.entries()) {
    if (plan.decision !== 'retain' || plan.cutoffAt !== null
      || Object.values(plan.dueCounts).some(value => value !== 0)
      || Object.values(plan.archivedCounts).some(value => value !== 0)
      || Object.values(plan.blockedCounts).some(value => value !== 0)) {
      throw new Error(`${fixtures[index].label} did not fail safe to retain`);
    }
    if ((completedArchives.find(row => row.tenantId === fixtures[index].tenantId)?.value ?? 0) < 1) {
      throw new Error(`${fixtures[index].label} completed archive is missing`);
    }
  }
  const [[afterRuns], afterLifecycle] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(retentionRuns)
      .where(inArray(retentionRuns.tenantId, tenantIds)),
    db.execute(lifecycleCountsSql),
  ]);
  if (beforeRuns.value !== afterRuns.value) throw new Error('Retention planning created a run');
  if ((archiveCrossings[0]?.value ?? 0) !== 0) throw new Error('Archive proof crossed tenants');
  if (JSON.stringify(beforeLifecycle.rows) !== JSON.stringify(afterLifecycle.rows)) {
    throw new Error('Task2 lifecycle counts changed during retention planning');
  }
  console.log('logical_tenants=2');
  console.log('company_a.policy=retain');
  console.log('company_b.policy=retain');
  console.log('completed_archives=present-both-tenants');
  console.log('archive_does_not_authorize_deletion=verified');
  console.log('cross_tenant_archive_proof=blocked');
  console.log('retention_runs_created=0');
  console.log('evidence_deleted=0');
  console.log('task2_lifecycle_counts=unchanged');
  console.log('verification=read-only-complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 retention verification failed');
  process.exitCode = 1;
});
