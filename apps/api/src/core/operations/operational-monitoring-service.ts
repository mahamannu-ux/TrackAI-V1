import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  evidenceExportJobs,
  developerMachines,
  machineDeliveryHealthReports,
  providerEventDeliveries,
  telemetryMetricEvents,
} from '../db/schema';
import { PROVIDER_DELIVERY_LEASE_MS } from '../../features/scm/provider-event';
import {
  classifyClientDeliveryHealthStatus,
  classifyTenantOperationalHealth,
} from './task4-operations-contract';
import { planTenantRetentionRun } from './retention-run-service';

const METRIC_DELAY_MS = 5 * 60 * 1_000;

async function groupedCounts(table: any, tenantColumn: any, statusColumn: any, tenantId: string) {
  return db.select({ status: statusColumn, value: sql<number>`count(*)::int` })
    .from(table).where(eq(tenantColumn, tenantId)).groupBy(statusColumn);
}

function countFor(rows: Array<{ status: string; value: number }>, status: string): number {
  return Number(rows.find(row => row.status === status)?.value ?? 0);
}

export async function getTenantOperationalMonitoring(input: {
  tenantId: string;
  evaluatedAt?: Date;
}) {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  if (!Number.isFinite(evaluatedAt.getTime())) throw new Error('Monitoring evaluation time is invalid');
  const metricDelayedBefore = new Date(evaluatedAt.getTime() - METRIC_DELAY_MS);
  const providerLeaseBefore = new Date(evaluatedAt.getTime() - PROVIDER_DELIVERY_LEASE_MS);
  const [metricStatuses, providerStatuses, exportStatuses, [delayedMetrics],
    [expiredProviderWork], providerFailureCodes, retention, clientRows] = await Promise.all([
    groupedCounts(
      telemetryMetricEvents, telemetryMetricEvents.tenantId,
      telemetryMetricEvents.normalizationStatus, input.tenantId,
    ),
    groupedCounts(
      providerEventDeliveries, providerEventDeliveries.tenantId,
      providerEventDeliveries.processingStatus, input.tenantId,
    ),
    groupedCounts(
      evidenceExportJobs, evidenceExportJobs.tenantId,
      evidenceExportJobs.status, input.tenantId,
    ),
    db.select({ value: sql<number>`count(*)::int` }).from(telemetryMetricEvents).where(and(
      eq(telemetryMetricEvents.tenantId, input.tenantId),
      eq(telemetryMetricEvents.normalizationStatus, 'pending'),
      lt(telemetryMetricEvents.createdAt, metricDelayedBefore),
    )),
    db.select({ value: sql<number>`count(*)::int` }).from(providerEventDeliveries).where(and(
      eq(providerEventDeliveries.tenantId, input.tenantId),
      eq(providerEventDeliveries.processingStatus, 'received'),
      or(
        isNull(providerEventDeliveries.processingStartedAt),
        lt(providerEventDeliveries.processingStartedAt, providerLeaseBefore),
      ),
    )),
    db.select({
      code: providerEventDeliveries.errorCode,
      value: sql<number>`count(*)::int`,
    }).from(providerEventDeliveries).where(and(
      eq(providerEventDeliveries.tenantId, input.tenantId),
      eq(providerEventDeliveries.processingStatus, 'failed'),
      gte(providerEventDeliveries.receivedAt, new Date(evaluatedAt.getTime() - 24 * 60 * 60 * 1_000)),
    )).groupBy(providerEventDeliveries.errorCode),
    planTenantRetentionRun({ tenantId: input.tenantId, evaluatedAt }),
    db.select({
      machineId: developerMachines.id,
      displayName: developerMachines.displayName,
      platform: developerMachines.platform,
      observedAt: machineDeliveryHealthReports.observedAt,
      receivedAt: machineDeliveryHealthReports.receivedAt,
      pendingRetryable: machineDeliveryHealthReports.pendingRetryable,
      waitingRetry: machineDeliveryHealthReports.waitingRetry,
      processing: machineDeliveryHealthReports.processing,
      quarantined: machineDeliveryHealthReports.quarantined,
      rowsWithErrors: machineDeliveryHealthReports.rowsWithErrors,
      oldestPendingAt: machineDeliveryHealthReports.oldestPendingAt,
      lastDeliveredAt: machineDeliveryHealthReports.lastDeliveredAt,
    }).from(developerMachines).leftJoin(machineDeliveryHealthReports, and(
      eq(machineDeliveryHealthReports.tenantId, developerMachines.tenantId),
      eq(machineDeliveryHealthReports.machineId, developerMachines.id),
    )).where(and(
      eq(developerMachines.tenantId, input.tenantId),
      eq(developerMachines.status, 'active'),
    )),
  ]);
  const metrics = {
    normalized: countFor(metricStatuses, 'normalized'),
    pending: countFor(metricStatuses, 'pending'),
    failed: countFor(metricStatuses, 'failed'),
    delayedPending: Number(delayedMetrics?.value ?? 0),
  };
  const providers = {
    received: countFor(providerStatuses, 'received'),
    projected: countFor(providerStatuses, 'projected'),
    applied: countFor(providerStatuses, 'applied'),
    duplicate: countFor(providerStatuses, 'duplicate'),
    stale: countFor(providerStatuses, 'stale'),
    conflict: countFor(providerStatuses, 'conflict'),
    unsequenced: countFor(providerStatuses, 'unsequenced'),
    failed: countFor(providerStatuses, 'failed'),
    expiredWork: Number(expiredProviderWork?.value ?? 0),
    recentFailureCodes: providerFailureCodes.map(row => ({
      code: row.code ?? 'unclassified', value: Number(row.value),
    })),
  };
  const exports = {
    planned: countFor(exportStatuses, 'planned'),
    running: countFor(exportStatuses, 'running'),
    completed: countFor(exportStatuses, 'completed'),
    failed: countFor(exportStatuses, 'failed'),
  };
  const clients = {
    machines: clientRows.map(row => {
      const status = classifyClientDeliveryHealthStatus({
        receivedAt: row.receivedAt,
        evaluatedAt,
      });
      return {
        ...row,
        status,
        pendingRetryable: Number(row.pendingRetryable ?? 0),
        waitingRetry: Number(row.waitingRetry ?? 0),
        processing: Number(row.processing ?? 0),
        quarantined: Number(row.quarantined ?? 0),
        rowsWithErrors: Number(row.rowsWithErrors ?? 0),
      };
    }),
  };
  const currentClientRows = clients.machines.filter(row => row.status === 'current');
  const clientTotals = currentClientRows.reduce((totals, row) => ({
    pendingRetryable: totals.pendingRetryable + row.pendingRetryable,
    waitingRetry: totals.waitingRetry + row.waitingRetry,
    processing: totals.processing + row.processing,
    quarantined: totals.quarantined + row.quarantined,
    rowsWithErrors: totals.rowsWithErrors + row.rowsWithErrors,
  }), { pendingRetryable: 0, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0 });
  const staleReports = clients.machines.filter(row => row.status === 'stale').length;
  const unreportedMachines = clients.machines.filter(row => row.status === 'unreported').length;
  const clientSummary = {
    ...clientTotals,
    activeMachines: clients.machines.length,
    currentReports: currentClientRows.length,
    staleReports,
    unreportedMachines,
    machines: clients.machines,
  };
  const failed = metrics.failed + providers.failed + exports.failed;
  const health = classifyTenantOperationalHealth({
    failed,
    expiredWork: providers.expiredWork,
    delayedWork: metrics.delayedPending + exports.running
      + clientTotals.pendingRetryable + clientTotals.waitingRetry
      + clientTotals.processing + clientTotals.quarantined
      + staleReports + unreportedMachines,
  });
  return {
    evaluatedAt,
    health,
    metrics,
    providers,
    exports,
    clients: clientSummary,
    retention,
    limitations: {
      clientQueue: clients.machines.length === 0
        ? 'No active developer machine is enrolled for this tenant.'
        : unreportedMachines > 0 || staleReports > 0
          ? 'One or more active machines have not supplied a current counts-only delivery report.'
          : 'Current counts-only reports are available for every active machine.',
      rawEvidence: 'Monitoring exposes counts and safe codes only; raw events are never returned.',
    },
  };
}
