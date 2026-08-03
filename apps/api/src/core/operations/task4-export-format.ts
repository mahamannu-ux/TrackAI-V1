import { createHash } from 'node:crypto';
import {
  TASK4_EXPORT_DATASETS,
  TASK4_EXPORT_FORMAT,
  exportFieldIsAllowed,
  validateExportArtifactBytes,
  type Task4ExportDataset,
} from './task4-operations-contract';

export type ExportJsonValue =
  | null
  | boolean
  | number
  | string
  | ExportJsonValue[]
  | { [key: string]: ExportJsonValue };

export interface Task4ExportRecord {
  id: string;
  occurredAt: string;
  data: Record<string, ExportJsonValue>;
}

export interface Task4ExportEnvelope {
  manifest: {
    format: typeof TASK4_EXPORT_FORMAT;
    tenantId: string;
    scopeFrom: string | null;
    scopeUntil: string | null;
    snapshotAt: string;
    recordCounts: Record<Task4ExportDataset, number>;
    contentSha256: string;
  };
  datasets: Record<Task4ExportDataset, Task4ExportRecord[]>;
}

function assertExportValue(value: unknown, depth = 0): asserts value is ExportJsonValue {
  if (depth > 12) throw new Error('Export value nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Export numbers must be finite');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertExportValue(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') throw new Error('Export value is not JSON-safe');
  for (const [key, item] of Object.entries(value)) {
    if (!exportFieldIsAllowed(key)) throw new Error(`Export field ${key} is forbidden`);
    assertExportValue(item, depth + 1);
  }
}

function canonicalize(value: ExportJsonValue): ExportJsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalize(value[key])])) as Record<string, ExportJsonValue>;
}

export function canonicalExportJson(value: unknown): string {
  assertExportValue(value);
  return JSON.stringify(canonicalize(value));
}

export function createTask4ExportEnvelope(input: {
  tenantId: string;
  scopeFrom: Date | null;
  scopeUntil: Date | null;
  snapshotAt: Date;
  datasets: Partial<Record<Task4ExportDataset, Task4ExportRecord[]>>;
}): Task4ExportEnvelope {
  if (!input.tenantId.trim()) throw new Error('Export tenant is required');
  if (!Number.isFinite(input.snapshotAt.getTime())) throw new Error('Export snapshot time is invalid');
  if ((input.scopeFrom === null) !== (input.scopeUntil === null)) {
    throw new Error('Export scope requires both from and until timestamps');
  }
  if (input.scopeFrom && input.scopeUntil
    && input.scopeUntil.getTime() <= input.scopeFrom.getTime()) {
    throw new Error('Export scope until must be later than from');
  }

  const datasets = Object.fromEntries(TASK4_EXPORT_DATASETS.map(dataset => {
    const records = [...(input.datasets[dataset] ?? [])].sort((left, right) => (
      left.id.localeCompare(right.id) || left.occurredAt.localeCompare(right.occurredAt)
    ));
    const ids = new Set<string>();
    for (const record of records) {
      if (!record.id.trim()) throw new Error(`${dataset} export record id is required`);
      if (ids.has(record.id)) throw new Error(`${dataset} export record id is duplicated`);
      ids.add(record.id);
      if (!Number.isFinite(new Date(record.occurredAt).getTime())) {
        throw new Error(`${dataset} export record occurrence time is invalid`);
      }
      assertExportValue(record.data);
    }
    return [dataset, records];
  })) as Record<Task4ExportDataset, Task4ExportRecord[]>;
  const recordCounts = Object.fromEntries(TASK4_EXPORT_DATASETS.map(dataset => (
    [dataset, datasets[dataset].length]
  ))) as Record<Task4ExportDataset, number>;
  const payload = {
    format: TASK4_EXPORT_FORMAT,
    tenantId: input.tenantId,
    scopeFrom: input.scopeFrom?.toISOString() ?? null,
    scopeUntil: input.scopeUntil?.toISOString() ?? null,
    snapshotAt: input.snapshotAt.toISOString(),
    datasets,
  };
  const contentSha256 = createHash('sha256').update(canonicalExportJson(payload)).digest('hex');
  return {
    manifest: {
      format: TASK4_EXPORT_FORMAT,
      tenantId: input.tenantId,
      scopeFrom: input.scopeFrom?.toISOString() ?? null,
      scopeUntil: input.scopeUntil?.toISOString() ?? null,
      snapshotAt: input.snapshotAt.toISOString(),
      recordCounts,
      contentSha256,
    },
    datasets,
  };
}

export function restoreTask4ExportEnvelope(serialized: string): Task4ExportEnvelope {
  validateExportArtifactBytes(Buffer.byteLength(serialized, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Export artifact is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Export artifact must be an object');
  }
  const candidate = parsed as Partial<Task4ExportEnvelope>;
  if (!candidate.manifest || !candidate.datasets
    || candidate.manifest.format !== TASK4_EXPORT_FORMAT
    || typeof candidate.manifest.tenantId !== 'string'
    || typeof candidate.manifest.snapshotAt !== 'string') {
    throw new Error('Export artifact manifest is invalid');
  }
  const scopeFrom = candidate.manifest.scopeFrom === null
    ? null : new Date(candidate.manifest.scopeFrom ?? 'invalid');
  const scopeUntil = candidate.manifest.scopeUntil === null
    ? null : new Date(candidate.manifest.scopeUntil ?? 'invalid');
  const recreated = createTask4ExportEnvelope({
    tenantId: candidate.manifest.tenantId,
    scopeFrom,
    scopeUntil,
    snapshotAt: new Date(candidate.manifest.snapshotAt),
    datasets: candidate.datasets,
  });
  if (candidate.manifest.contentSha256 !== recreated.manifest.contentSha256
    || canonicalExportJson(parsed) !== canonicalExportJson(recreated)) {
    throw new Error('Export artifact checksum or manifest does not match its evidence');
  }
  return recreated;
}
