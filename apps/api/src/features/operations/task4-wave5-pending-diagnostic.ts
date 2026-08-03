import 'dotenv/config';

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { ssoTenants, telemetryMetricEvents } from '../../core/db/schema';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const [tenant] = await db.select({ id: ssoTenants.id }).from(ssoTenants)
    .where(eq(ssoTenants.domain, 'purpletealabs.net')).limit(1);
  if (!tenant) throw new Error('Company A tenant is missing');
  const groups = await db.select({
    eventKind: telemetryMetricEvents.eventKind,
    evidenceFamily: telemetryMetricEvents.evidenceFamily,
    arrivalClass: telemetryMetricEvents.arrivalClass,
    count: sql<number>`count(*)::int`,
    oldestAt: sql<Date>`min(${telemetryMetricEvents.createdAt})`,
    newestAt: sql<Date>`max(${telemetryMetricEvents.createdAt})`,
  }).from(telemetryMetricEvents).where(and(
    eq(telemetryMetricEvents.tenantId, tenant.id),
    eq(telemetryMetricEvents.normalizationStatus, 'pending'),
  )).groupBy(
    telemetryMetricEvents.eventKind,
    telemetryMetricEvents.evidenceFamily,
    telemetryMetricEvents.arrivalClass,
  ).orderBy(telemetryMetricEvents.eventKind);
  const total = groups.reduce((sum, row) => sum + Number(row.count), 0);
  console.log(`pending_rows=${total}`);
  for (const [index, row] of groups.entries()) {
    console.log(`group_${index + 1}.event_kind=${row.eventKind}`);
    console.log(`group_${index + 1}.evidence_family=${row.evidenceFamily}`);
    console.log(`group_${index + 1}.arrival_class=${row.arrivalClass}`);
    console.log(`group_${index + 1}.rows=${row.count}`);
    console.log(`group_${index + 1}.oldest=${new Date(row.oldestAt).toISOString()}`);
    console.log(`group_${index + 1}.newest=${new Date(row.newestAt).toISOString()}`);
  }
  console.log('raw_events=not-selected-or-printed');
  console.log('database_changes=none');
  console.log('diagnostic=read-only-complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Pending evidence diagnostic failed');
  process.exitCode = 1;
});
