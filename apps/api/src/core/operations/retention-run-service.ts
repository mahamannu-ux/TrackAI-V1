import { and, countDistinct, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import {
  evidenceArchiveEntries,
  evidenceExportJobs,
  providerEventDeliveries,
  telemetryMetricEvents,
  tenantRetentionPolicies,
} from '../db/schema';
import {
  DEFAULT_RETENTION_POLICY,
  retentionArchiveCoverage,
} from './task4-operations-contract';

export async function planTenantRetentionRun(input: {
  tenantId: string;
  evaluatedAt?: Date;
}) {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) throw new Error('Retention evaluation time is invalid');
  const [policy] = await db.select({
    id: tenantRetentionPolicies.id,
    version: tenantRetentionPolicies.version,
    mode: tenantRetentionPolicies.mode,
    retentionDays: tenantRetentionPolicies.retentionDays,
    effectiveFrom: tenantRetentionPolicies.effectiveFrom,
  }).from(tenantRetentionPolicies).where(and(
    eq(tenantRetentionPolicies.tenantId, input.tenantId),
    eq(tenantRetentionPolicies.status, 'active'),
  )).limit(1);

  if (!policy || policy.mode === 'retain') {
    return {
      policy: policy ?? {
        id: null,
        version: 0,
        mode: DEFAULT_RETENTION_POLICY.mode,
        retentionDays: DEFAULT_RETENTION_POLICY.retentionDays,
        effectiveFrom: null,
      },
      evaluatedAt,
      cutoffAt: null,
      dueCounts: { telemetry_metric_evidence: 0, provider_delivery_evidence: 0 },
      archivedCounts: { telemetry_metric_evidence: 0, provider_delivery_evidence: 0 },
      blockedCounts: { telemetry_metric_evidence: 0, provider_delivery_evidence: 0 },
      decision: 'retain' as const,
      databaseChanges: 'none' as const,
    };
  }

  const cutoffAt = new Date(evaluatedAt.getTime() - policy.retentionDays! * 86_400_000);
  const [[metricDue], [providerDue], [metricArchived], [providerArchived]] = await Promise.all([
    db.select({ value: countDistinct(telemetryMetricEvents.id) })
      .from(telemetryMetricEvents).where(and(
        eq(telemetryMetricEvents.tenantId, input.tenantId),
        lt(telemetryMetricEvents.eventTimestamp, cutoffAt),
      )),
    db.select({ value: countDistinct(providerEventDeliveries.id) })
      .from(providerEventDeliveries).where(and(
        eq(providerEventDeliveries.tenantId, input.tenantId),
        lt(providerEventDeliveries.receivedAt, cutoffAt),
      )),
    db.select({ value: countDistinct(telemetryMetricEvents.id) })
      .from(telemetryMetricEvents)
      .innerJoin(evidenceArchiveEntries, and(
        eq(evidenceArchiveEntries.tenantId, telemetryMetricEvents.tenantId),
        eq(evidenceArchiveEntries.evidenceId, telemetryMetricEvents.id),
        eq(evidenceArchiveEntries.evidenceFamily, 'telemetry_metric_evidence'),
      ))
      .innerJoin(evidenceExportJobs, and(
        eq(evidenceExportJobs.tenantId, evidenceArchiveEntries.tenantId),
        eq(evidenceExportJobs.id, evidenceArchiveEntries.exportJobId),
        eq(evidenceExportJobs.status, 'completed'),
        eq(evidenceExportJobs.archivePurpose, true),
      )).where(and(
        eq(telemetryMetricEvents.tenantId, input.tenantId),
        lt(telemetryMetricEvents.eventTimestamp, cutoffAt),
      )),
    db.select({ value: countDistinct(providerEventDeliveries.id) })
      .from(providerEventDeliveries)
      .innerJoin(evidenceArchiveEntries, and(
        eq(evidenceArchiveEntries.tenantId, providerEventDeliveries.tenantId),
        eq(evidenceArchiveEntries.evidenceId, providerEventDeliveries.id),
        eq(evidenceArchiveEntries.evidenceFamily, 'provider_delivery_evidence'),
      ))
      .innerJoin(evidenceExportJobs, and(
        eq(evidenceExportJobs.tenantId, evidenceArchiveEntries.tenantId),
        eq(evidenceExportJobs.id, evidenceArchiveEntries.exportJobId),
        eq(evidenceExportJobs.status, 'completed'),
        eq(evidenceExportJobs.archivePurpose, true),
      )).where(and(
        eq(providerEventDeliveries.tenantId, input.tenantId),
        lt(providerEventDeliveries.receivedAt, cutoffAt),
      )),
  ]);
  const dueCounts = {
    telemetry_metric_evidence: Number(metricDue?.value ?? 0),
    provider_delivery_evidence: Number(providerDue?.value ?? 0),
  };
  const archivedCounts = {
    telemetry_metric_evidence: Number(metricArchived?.value ?? 0),
    provider_delivery_evidence: Number(providerArchived?.value ?? 0),
  };
  const metricCoverage = retentionArchiveCoverage(
    dueCounts.telemetry_metric_evidence, archivedCounts.telemetry_metric_evidence,
  );
  const providerCoverage = retentionArchiveCoverage(
    dueCounts.provider_delivery_evidence, archivedCounts.provider_delivery_evidence,
  );
  const blockedCounts = {
    telemetry_metric_evidence: metricCoverage.blocked,
    provider_delivery_evidence: providerCoverage.blocked,
  };
  return {
    policy,
    evaluatedAt,
    cutoffAt,
    dueCounts,
    archivedCounts,
    blockedCounts,
    decision: metricCoverage.decision === 'archive_required'
      || providerCoverage.decision === 'archive_required'
      ? 'archive_required' as const : 'archive_ready' as const,
    databaseChanges: 'none' as const,
  };
}
