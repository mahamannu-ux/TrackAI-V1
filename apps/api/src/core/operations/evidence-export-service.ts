import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db';
import {
  aiCodeLifecycleEvents,
  aiModelLifecycleEvents,
  evidenceArchiveEntries,
  evidenceExportJobs,
  providerEventDeliveries,
  securityAuditEvents,
  telemetryCorrections,
  telemetryMetricEvents,
} from '../db/schema';
import {
  MAX_EXPORT_RECORDS_PER_DATASET,
  TASK4_EXPORT_FORMAT,
  validateExportArtifactBytes,
  validateExportWindow,
  type Task4ExportDataset,
} from './task4-operations-contract';
import {
  canonicalExportJson,
  createTask4ExportEnvelope,
  restoreTask4ExportEnvelope,
  type ExportJsonValue,
  type Task4ExportRecord,
} from './task4-export-format';
import type { EvidenceExportSink } from './evidence-export-sink';

export interface EvidenceExportScope {
  tenantId: string;
  scopeFrom: Date;
  scopeUntil: Date;
  evaluatedAt?: Date;
}

export interface CreateEvidenceExportInput extends EvidenceExportScope {
  actorId: string;
  reason: string;
  archivePurpose: boolean;
  sink: EvidenceExportSink;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function exportRecord(id: string, occurredAt: Date, data: Record<string, unknown>): Task4ExportRecord {
  return { id, occurredAt: occurredAt.toISOString(), data: data as Record<string, ExportJsonValue> };
}

function recordDigest(record: Task4ExportRecord): string {
  return createHash('sha256').update(canonicalExportJson(record)).digest('hex');
}

function safeFailureCode(error: unknown): string {
  return error instanceof Error && /maximum|limit/i.test(error.message)
    ? 'export_record_limit_exceeded'
    : 'export_execution_failed';
}

export async function planTenantEvidenceExport(input: EvidenceExportScope) {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  validateExportWindow({
    scopeFrom: input.scopeFrom,
    scopeUntil: input.scopeUntil,
    evaluatedAt,
  });
  const tenantWindow = (tenantColumn: any, occurredColumn: any) => and(
    eq(tenantColumn, input.tenantId),
    gte(occurredColumn, input.scopeFrom),
    lt(occurredColumn, input.scopeUntil),
  );
  const [metricEvidenceRows, providerEvidenceRows, codeLifecycleRows, modelLifecycleRows,
    correctionRows, auditRows] = await Promise.all([
    db.select({ value: count() }).from(telemetryMetricEvents).where(
      tenantWindow(telemetryMetricEvents.tenantId, telemetryMetricEvents.eventTimestamp),
    ),
    db.select({ value: count() }).from(providerEventDeliveries).where(
      tenantWindow(providerEventDeliveries.tenantId, providerEventDeliveries.receivedAt),
    ),
    db.select({ value: count() }).from(aiCodeLifecycleEvents).where(
      tenantWindow(aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.occurredAt),
    ),
    db.select({ value: count() }).from(aiModelLifecycleEvents).where(
      tenantWindow(aiModelLifecycleEvents.tenantId, aiModelLifecycleEvents.occurredAt),
    ),
    db.select({ value: count() }).from(telemetryCorrections).where(
      tenantWindow(telemetryCorrections.tenantId, telemetryCorrections.createdAt),
    ),
    db.select({ value: count() }).from(securityAuditEvents).where(
      tenantWindow(securityAuditEvents.tenantId, securityAuditEvents.occurredAt),
    ),
  ]);
  const metricEvidence = Number(metricEvidenceRows[0]?.value ?? 0);
  const providerEvidence = Number(providerEvidenceRows[0]?.value ?? 0);
  const codeLifecycle = Number(codeLifecycleRows[0]?.value ?? 0);
  const modelLifecycle = Number(modelLifecycleRows[0]?.value ?? 0);
  const corrections = Number(correctionRows[0]?.value ?? 0);
  const audit = Number(auditRows[0]?.value ?? 0);
  const recordCounts: Record<Task4ExportDataset, number> = {
    observed_metric_evidence: metricEvidence,
    provider_delivery_evidence: providerEvidence,
    lifecycle_projections: codeLifecycle + modelLifecycle,
    correction_overlays: corrections,
    security_audit: audit,
  };
  const overLimitDatasets = Object.entries(recordCounts)
    .filter(([, value]) => value > MAX_EXPORT_RECORDS_PER_DATASET)
    .map(([dataset]) => dataset as Task4ExportDataset);
  return {
    format: TASK4_EXPORT_FORMAT,
    scopeFrom: input.scopeFrom,
    scopeUntil: input.scopeUntil,
    recordCounts,
    maximumRecordsPerDataset: MAX_EXPORT_RECORDS_PER_DATASET,
    overLimitDatasets,
    eligible: overLimitDatasets.length === 0,
    databaseChanges: 'none' as const,
  };
}

export async function listTenantEvidenceExports(tenantId: string) {
  return db.select({
    id: evidenceExportJobs.id,
    format: evidenceExportJobs.format,
    status: evidenceExportJobs.status,
    archivePurpose: evidenceExportJobs.archivePurpose,
    scopeFrom: evidenceExportJobs.scopeFrom,
    scopeUntil: evidenceExportJobs.scopeUntil,
    reason: evidenceExportJobs.reason,
    recordCounts: evidenceExportJobs.recordCounts,
    contentSha256: evidenceExportJobs.contentSha256,
    failureCode: evidenceExportJobs.failureCode,
    startedAt: evidenceExportJobs.startedAt,
    completedAt: evidenceExportJobs.completedAt,
    createdAt: evidenceExportJobs.createdAt,
  }).from(evidenceExportJobs).where(eq(evidenceExportJobs.tenantId, tenantId))
    .orderBy(desc(evidenceExportJobs.createdAt));
}

export async function readTenantEvidenceExport(input: {
  tenantId: string;
  exportJobId: string;
  sink: EvidenceExportSink;
}) {
  const [job] = await db.select({
    id: evidenceExportJobs.id,
    format: evidenceExportJobs.format,
    status: evidenceExportJobs.status,
    contentSha256: evidenceExportJobs.contentSha256,
    storageReference: evidenceExportJobs.storageReference,
  }).from(evidenceExportJobs).where(and(
    eq(evidenceExportJobs.tenantId, input.tenantId),
    eq(evidenceExportJobs.id, input.exportJobId),
    eq(evidenceExportJobs.status, 'completed'),
  )).limit(1);
  if (!job?.storageReference || !job.contentSha256) {
    throw new Error('Completed evidence export was not found');
  }
  const content = await input.sink.read(job.storageReference);
  const restored = restoreTask4ExportEnvelope(content);
  if (restored.manifest.tenantId !== input.tenantId
    || restored.manifest.contentSha256 !== job.contentSha256) {
    throw new Error('Evidence export artifact does not match its tenant manifest');
  }
  return { job, content };
}


export async function createTenantEvidenceExport(input: CreateEvidenceExportInput) {
  const reason = input.reason.trim();
  if (!input.actorId.trim()) throw new Error('Export actor is required');
  if (!reason || reason.length > 1_000) throw new Error('Export reason is required');
  const snapshotAt = input.evaluatedAt ?? new Date();
  const plan = await planTenantEvidenceExport({
    tenantId: input.tenantId,
    scopeFrom: input.scopeFrom,
    scopeUntil: input.scopeUntil,
    evaluatedAt: snapshotAt,
  });
  if (!plan.eligible) throw new Error('Export exceeds the maximum records per dataset');

  const [job] = await db.insert(evidenceExportJobs).values({
    tenantId: input.tenantId,
    format: TASK4_EXPORT_FORMAT,
    status: 'running',
    archivePurpose: input.archivePurpose,
    scopeFrom: input.scopeFrom,
    scopeUntil: input.scopeUntil,
    requestedBy: input.actorId,
    reason,
    recordCounts: plan.recordCounts,
    startedAt: snapshotAt,
  }).returning();

  let storageReference: string | null = null;
  try {
    const tenantWindow = (tenantColumn: any, occurredColumn: any) => and(
      eq(tenantColumn, input.tenantId),
      gte(occurredColumn, input.scopeFrom),
      lt(occurredColumn, input.scopeUntil),
    );
    const limit = MAX_EXPORT_RECORDS_PER_DATASET + 1;
    const [metrics, providers, codeLifecycle, modelLifecycle, corrections, audit] = await Promise.all([
      db.select({
        id: telemetryMetricEvents.id,
        batchId: telemetryMetricEvents.batchId,
        eventIndex: telemetryMetricEvents.eventIndex,
        eventFingerprint: telemetryMetricEvents.eventFingerprint,
        eventKind: telemetryMetricEvents.eventKind,
        eventTimestamp: telemetryMetricEvents.eventTimestamp,
        enrollmentId: telemetryMetricEvents.enrollmentId,
        evidenceFamily: telemetryMetricEvents.evidenceFamily,
        arrivalClass: telemetryMetricEvents.arrivalClass,
        backfillAuthorizationId: telemetryMetricEvents.backfillAuthorizationId,
        normalizationStatus: telemetryMetricEvents.normalizationStatus,
        normalizationError: telemetryMetricEvents.normalizationError,
        createdAt: telemetryMetricEvents.createdAt,
      }).from(telemetryMetricEvents).where(
        tenantWindow(telemetryMetricEvents.tenantId, telemetryMetricEvents.eventTimestamp),
      ).limit(limit),
      db.select({
        id: providerEventDeliveries.id,
        repositoryId: providerEventDeliveries.repositoryId,
        provider: providerEventDeliveries.provider,
        deliveryId: providerEventDeliveries.deliveryId,
        eventType: providerEventDeliveries.eventType,
        eventFingerprint: providerEventDeliveries.eventFingerprint,
        providerOccurredAt: providerEventDeliveries.providerOccurredAt,
        processingStatus: providerEventDeliveries.processingStatus,
        errorCode: providerEventDeliveries.errorCode,
        receivedAt: providerEventDeliveries.receivedAt,
        processedAt: providerEventDeliveries.processedAt,
      }).from(providerEventDeliveries).where(
        tenantWindow(providerEventDeliveries.tenantId, providerEventDeliveries.receivedAt),
      ).limit(limit),
      db.select().from(aiCodeLifecycleEvents).where(
        tenantWindow(aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.occurredAt),
      ).limit(limit),
      db.select().from(aiModelLifecycleEvents).where(
        tenantWindow(aiModelLifecycleEvents.tenantId, aiModelLifecycleEvents.occurredAt),
      ).limit(limit),
      db.select().from(telemetryCorrections).where(
        tenantWindow(telemetryCorrections.tenantId, telemetryCorrections.createdAt),
      ).limit(limit),
      db.select().from(securityAuditEvents).where(
        tenantWindow(securityAuditEvents.tenantId, securityAuditEvents.occurredAt),
      ).limit(limit),
    ]);

    const datasets = {
      observed_metric_evidence: metrics.map(row => exportRecord(row.id, row.eventTimestamp, {
        batchId: row.batchId,
        eventIndex: row.eventIndex,
        eventFingerprint: row.eventFingerprint,
        eventKind: row.eventKind,
        enrollmentId: row.enrollmentId,
        evidenceFamily: row.evidenceFamily,
        arrivalClass: row.arrivalClass,
        backfillAuthorizationId: row.backfillAuthorizationId,
        normalizationStatus: row.normalizationStatus,
        normalizationError: row.normalizationError,
        createdAt: row.createdAt.toISOString(),
      })),
      provider_delivery_evidence: providers.map(row => exportRecord(row.id, row.receivedAt, {
        repositoryId: row.repositoryId,
        provider: row.provider,
        deliveryId: row.deliveryId,
        eventType: row.eventType,
        eventFingerprint: row.eventFingerprint,
        providerOccurredAt: iso(row.providerOccurredAt),
        processingStatus: row.processingStatus,
        errorCode: row.errorCode,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: iso(row.processedAt),
      })),
      lifecycle_projections: [
        ...codeLifecycle.map(row => exportRecord(`code:${row.id}`, row.occurredAt, {
          projectionKind: 'code', repositoryId: row.repositoryId, sessionId: row.sessionId,
          commitId: row.commitId, pullRequestId: row.pullRequestId, stage: row.stage,
          lineCount: row.lineCount, actorKind: row.actorKind, evidenceType: row.evidenceType,
          evidenceRef: row.evidenceRef, confidence: row.confidence,
          createdAt: row.createdAt.toISOString(),
        })),
        ...modelLifecycle.map(row => exportRecord(`model:${row.id}`, row.occurredAt, {
          projectionKind: 'model', repositoryId: row.repositoryId, sessionId: row.sessionId,
          commitId: row.commitId, pullRequestId: row.pullRequestId, tool: row.tool,
          model: row.model, modelKey: row.modelKey, stage: row.stage, lineCount: row.lineCount,
          actorKind: row.actorKind, actorModelKey: row.actorModelKey,
          evidenceType: row.evidenceType, evidenceRef: row.evidenceRef,
          confidence: row.confidence, createdAt: row.createdAt.toISOString(),
        })),
      ],
      correction_overlays: corrections.map(row => exportRecord(row.id, row.createdAt, {
        targetType: row.targetType,
        targetKey: row.targetKey,
        fieldName: row.fieldName,
        correctedValue: row.correctedValue,
        reason: row.reason,
        evidenceRef: row.evidenceRef,
        createdBy: row.createdBy,
      })),
      security_audit: audit.map(row => exportRecord(row.id, row.occurredAt, {
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        details: row.details,
      })),
    };
    for (const records of Object.values(datasets)) {
      if (records.length > MAX_EXPORT_RECORDS_PER_DATASET) {
        throw new Error('Export exceeds the maximum records per dataset');
      }
    }
    const envelope = createTask4ExportEnvelope({
      tenantId: input.tenantId,
      scopeFrom: input.scopeFrom,
      scopeUntil: input.scopeUntil,
      snapshotAt,
      datasets,
    });
    const content = canonicalExportJson(envelope);
    validateExportArtifactBytes(Buffer.byteLength(content, 'utf8'));
    const writeResult = await input.sink.write(job.id, content);
    storageReference = writeResult.storageReference;

    const archiveEntries = input.archivePurpose ? [
      ...datasets.observed_metric_evidence.map(record => ({
        tenantId: input.tenantId,
        exportJobId: job.id,
        evidenceFamily: 'telemetry_metric_evidence' as const,
        evidenceId: record.id,
        occurredAt: new Date(record.occurredAt),
        contentSha256: recordDigest(record),
      })),
      ...datasets.provider_delivery_evidence.map(record => ({
        tenantId: input.tenantId,
        exportJobId: job.id,
        evidenceFamily: 'provider_delivery_evidence' as const,
        evidenceId: record.id,
        occurredAt: new Date(record.occurredAt),
        contentSha256: recordDigest(record),
      })),
    ] : [];

    const completed = await db.transaction(async transaction => {
      for (let offset = 0; offset < archiveEntries.length; offset += 500) {
        await transaction.insert(evidenceArchiveEntries).values(
          archiveEntries.slice(offset, offset + 500),
        );
      }
      const [updated] = await transaction.update(evidenceExportJobs).set({
        status: 'completed',
        recordCounts: envelope.manifest.recordCounts,
        contentSha256: envelope.manifest.contentSha256,
        storageReference: writeResult.storageReference,
        completedAt: new Date(),
      }).where(and(
        eq(evidenceExportJobs.tenantId, input.tenantId),
        eq(evidenceExportJobs.id, job.id),
        eq(evidenceExportJobs.status, 'running'),
      )).returning();
      if (!updated) throw new Error('Export job changed during completion');
      await transaction.insert(securityAuditEvents).values({
        tenantId: input.tenantId,
        actorType: 'tenant_admin',
        actorId: input.actorId,
        action: 'evidence_export.completed',
        targetType: 'evidence_export_job',
        targetId: job.id,
        details: {
          archivePurpose: input.archivePurpose,
          scopeFrom: input.scopeFrom.toISOString(),
          scopeUntil: input.scopeUntil.toISOString(),
          recordCounts: envelope.manifest.recordCounts,
          contentSha256: envelope.manifest.contentSha256,
          bytes: writeResult.bytes,
          reason,
        },
      });
      return updated;
    });
    return { job: completed, bytes: writeResult.bytes };
  } catch (error) {
    if (storageReference) await input.sink.remove(storageReference).catch(() => undefined);
    const completedAt = new Date();
    const failureCode = safeFailureCode(error);
    await db.transaction(async transaction => {
      await transaction.update(evidenceExportJobs).set({
        status: 'failed', failureCode, completedAt,
      }).where(and(
        eq(evidenceExportJobs.tenantId, input.tenantId),
        eq(evidenceExportJobs.id, job.id),
        eq(evidenceExportJobs.status, 'running'),
      ));
      await transaction.insert(securityAuditEvents).values({
        tenantId: input.tenantId,
        actorType: 'tenant_admin',
        actorId: input.actorId,
        action: 'evidence_export.failed',
        targetType: 'evidence_export_job',
        targetId: job.id,
        details: { failureCode, reason },
      });
    }).catch(() => undefined);
    throw new Error(`Evidence export failed (${failureCode})`);
  }
}
