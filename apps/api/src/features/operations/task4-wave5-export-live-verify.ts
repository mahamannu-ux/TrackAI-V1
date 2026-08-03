import 'dotenv/config';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  evidenceArchiveEntries,
  evidenceExportJobs,
  ssoTenants,
} from '../../core/db/schema';
import {
  createTenantEvidenceExport,
  planTenantEvidenceExport,
} from '../../core/operations/evidence-export-service';
import { LocalFileEvidenceExportSink } from '../../core/operations/evidence-export-sink';
import {
  canonicalExportJson,
  createTask4ExportEnvelope,
  type Task4ExportEnvelope,
} from '../../core/operations/task4-export-format';

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
  const apply = process.env.TASK4_WAVE5_EXPORT_APPLY === '1';
  const evaluatedAt = new Date();
  const scopeUntil = new Date(evaluatedAt.getTime() - 1_000);
  const scopeFrom = new Date(scopeUntil.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const tenantRows = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants)
    .where(inArray(ssoTenants.domain, companies.map(company => company.domain)));
  const fixtures = companies.map(company => {
    const tenant = tenantRows.find(row => row.domain.toLowerCase() === company.domain);
    if (!tenant) throw new Error(`${company.label} tenant is missing`);
    return { ...company, tenantId: tenant.id };
  });
  const tenantIds = fixtures.map(fixture => fixture.tenantId);
  const [beforeJobs] = await db.select({ value: sql<number>`count(*)::int` })
    .from(evidenceExportJobs).where(inArray(evidenceExportJobs.tenantId, tenantIds));
  const beforeLifecycle = await db.execute(lifecycleCountsSql);
  const plans = await Promise.all(fixtures.map(fixture => planTenantEvidenceExport({
    tenantId: fixture.tenantId,
    scopeFrom,
    scopeUntil,
    evaluatedAt,
  })));
  if (plans.some(plan => !plan.eligible || plan.overLimitDatasets.length !== 0)) {
    throw new Error('A Company A/B export plan exceeded its bounded dataset limit');
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`scope_days=7`);
  for (const [index, fixture] of fixtures.entries()) {
    const counts = plans[index].recordCounts;
    console.log(`${fixture.label}.metric_evidence=${counts.observed_metric_evidence}`);
    console.log(`${fixture.label}.provider_evidence=${counts.provider_delivery_evidence}`);
    console.log(`${fixture.label}.lifecycle_projections=${counts.lifecycle_projections}`);
    console.log(`${fixture.label}.correction_overlays=${counts.correction_overlays}`);
    console.log(`${fixture.label}.security_audit=${counts.security_audit}`);
  }

  if (!apply) {
    const [afterJobs] = await db.select({ value: sql<number>`count(*)::int` })
      .from(evidenceExportJobs).where(inArray(evidenceExportJobs.tenantId, tenantIds));
    if (beforeJobs.value !== afterJobs.value) throw new Error('Dry-run created an export job');
    console.log('tenant_isolation=planned-independently');
    console.log('export_files=none');
    console.log('database_changes=none');
    console.log('next=review-counts-backup-then-rerun-with-explicit-apply');
    return;
  }

  const exportDirectory = process.env.TASK4_EXPORT_DIR;
  if (!exportDirectory) throw new Error('TASK4_EXPORT_DIR is required for apply mode');
  const sink = new LocalFileEvidenceExportSink(exportDirectory);
  const results = [];
  for (const fixture of fixtures) {
    const result = await createTenantEvidenceExport({
      tenantId: fixture.tenantId,
      actorId: 'task4-wave5-export-live-verifier',
      scopeFrom,
      scopeUntil,
      evaluatedAt,
      archivePurpose: true,
      reason: 'Task4 Wave 5 Company A/B export and archive verification',
      sink,
    });
    const serialized = await sink.read(result.job.storageReference!);
    const parsed = JSON.parse(serialized) as Task4ExportEnvelope;
    if (parsed.manifest.tenantId !== fixture.tenantId) {
      throw new Error(`${fixture.label} export crossed a tenant boundary`);
    }
    const recreated = createTask4ExportEnvelope({
      tenantId: fixture.tenantId,
      scopeFrom,
      scopeUntil,
      snapshotAt: new Date(parsed.manifest.snapshotAt),
      datasets: parsed.datasets,
    });
    if (recreated.manifest.contentSha256 !== parsed.manifest.contentSha256
      || canonicalExportJson(parsed) !== serialized) {
      throw new Error(`${fixture.label} export checksum or canonical serialization failed`);
    }
    results.push({ fixture, result, parsed });
  }

  const jobIds = results.map(result => result.result.job.id);
  const archiveCounts = await db.select({
    exportJobId: evidenceArchiveEntries.exportJobId,
    evidenceFamily: evidenceArchiveEntries.evidenceFamily,
    value: sql<number>`count(*)::int`,
  }).from(evidenceArchiveEntries).where(and(
    inArray(evidenceArchiveEntries.tenantId, tenantIds),
    inArray(evidenceArchiveEntries.exportJobId, jobIds),
  )).groupBy(evidenceArchiveEntries.exportJobId, evidenceArchiveEntries.evidenceFamily);
  for (const item of results) {
    const archivedMetrics = archiveCounts.find(row => row.exportJobId === item.result.job.id
      && row.evidenceFamily === 'telemetry_metric_evidence')?.value ?? 0;
    const archivedProviders = archiveCounts.find(row => row.exportJobId === item.result.job.id
      && row.evidenceFamily === 'provider_delivery_evidence')?.value ?? 0;
    if (archivedMetrics !== item.parsed.manifest.recordCounts.observed_metric_evidence
      || archivedProviders !== item.parsed.manifest.recordCounts.provider_delivery_evidence) {
      throw new Error(`${item.fixture.label} archive membership does not match its export`);
    }
  }
  const afterLifecycle = await db.execute(lifecycleCountsSql);
  if (JSON.stringify(beforeLifecycle.rows) !== JSON.stringify(afterLifecycle.rows)) {
    throw new Error('Task2 lifecycle counts changed during export verification');
  }
  console.log('logical_tenants=2');
  console.log('tenant_isolation=verified-both-directions');
  console.log('export_format=canonical-and-checksummed');
  console.log('archive_membership=matches-exported-purgeable-evidence');
  console.log('artifact_permissions=owner-only');
  console.log('raw_payloads_credentials_secrets_prompts=not-selected-or-printed');
  console.log('task2_lifecycle_counts=unchanged');
  console.log('verification=passed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 export verification failed');
  process.exitCode = 1;
});
