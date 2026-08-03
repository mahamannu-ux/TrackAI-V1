import { sql } from 'drizzle-orm';
import { db } from '../db';
import { machineDeliveryHealthReports } from '../db/schema';
import type { ClientDeliveryHealthReport } from './client-delivery-health-contract';

export async function recordClientDeliveryHealth(input: {
  tenantId: string;
  machineId: string;
  report: ClientDeliveryHealthReport;
  receivedAt?: Date;
}): Promise<{ accepted: boolean }> {
  const receivedAt = input.receivedAt ?? new Date();
  const values = {
    tenantId: input.tenantId,
    machineId: input.machineId,
    schemaVersion: input.report.version,
    observedAt: input.report.observedAt,
    receivedAt,
    pendingRetryable: input.report.pendingRetryable,
    waitingRetry: input.report.waitingRetry,
    processing: input.report.processing,
    quarantined: input.report.quarantined,
    rowsWithErrors: input.report.rowsWithErrors,
    oldestPendingAt: input.report.oldestPendingAt,
    lastDeliveredAt: input.report.lastDeliveredAt,
  };
  const rows = await db.insert(machineDeliveryHealthReports).values(values)
    .onConflictDoUpdate({
      target: [machineDeliveryHealthReports.tenantId, machineDeliveryHealthReports.machineId],
      set: values,
      setWhere: sql`excluded.observed_at >= ${machineDeliveryHealthReports.observedAt}`,
    }).returning({ id: machineDeliveryHealthReports.id });
  return { accepted: rows.length === 1 };
}
