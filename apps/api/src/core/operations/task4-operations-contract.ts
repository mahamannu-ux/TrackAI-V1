export const TASK4_RETENTION_POLICY_VERSION = 1 as const;
export const TASK4_EXPORT_FORMAT = 'trackai-evidence-export/v1' as const;
export const MAX_EXPORT_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
export const MAX_EXPORT_RECORDS_PER_DATASET = 50_000;
export const MAX_EXPORT_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const CLIENT_DELIVERY_HEALTH_STALE_MS = 15 * 60 * 1_000;

export const RETENTION_PURGEABLE_FAMILIES = [
  'telemetry_metric_evidence',
  'provider_delivery_evidence',
] as const;

export const RETENTION_PROTECTED_FAMILIES = [
  'security_audit',
  'correction_overlay',
  'retention_job',
  'export_manifest',
] as const;

export type RetentionPurgeableFamily = typeof RETENTION_PURGEABLE_FAMILIES[number];
export type RetentionProtectedFamily = typeof RETENTION_PROTECTED_FAMILIES[number];
export type RetentionMode = 'retain' | 'archive_then_purge';

export interface RetentionPolicyContract {
  version: typeof TASK4_RETENTION_POLICY_VERSION;
  mode: RetentionMode;
  retentionDays: number | null;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicyContract = Object.freeze({
  version: TASK4_RETENTION_POLICY_VERSION,
  mode: 'retain',
  retentionDays: null,
});

export function validateRetentionPolicy(
  policy: RetentionPolicyContract,
): RetentionPolicyContract {
  if (policy.version !== TASK4_RETENTION_POLICY_VERSION) {
    throw new Error('Unsupported retention policy version');
  }
  if (policy.mode === 'retain') {
    if (policy.retentionDays !== null) {
      throw new Error('Retain mode must not configure a purge window');
    }
    return { ...policy };
  }
  if (!Number.isInteger(policy.retentionDays)
    || policy.retentionDays === null
    || policy.retentionDays < 1
    || policy.retentionDays > 3_650) {
    throw new Error('Archive-then-purge retention days must be between 1 and 3650');
  }
  return { ...policy };
}

export type RetentionCandidateDecision =
  | 'retain'
  | 'not_due'
  | 'blocked_archive_required'
  | 'dry_run_candidate'
  | 'purge_candidate';

export function planRetentionCandidate(input: {
  policy: RetentionPolicyContract;
  occurredAt: Date;
  evaluatedAt: Date;
  archiveCompletedAt: Date | null;
  apply: boolean;
}): RetentionCandidateDecision {
  const policy = validateRetentionPolicy(input.policy);
  if (policy.mode === 'retain') return 'retain';
  if (!Number.isFinite(input.occurredAt.getTime())
    || !Number.isFinite(input.evaluatedAt.getTime())) {
    throw new Error('Retention timestamps must be valid');
  }
  const cutoff = input.evaluatedAt.getTime() - policy.retentionDays! * 86_400_000;
  if (input.occurredAt.getTime() >= cutoff) return 'not_due';
  if (!input.archiveCompletedAt) return 'blocked_archive_required';
  if (input.archiveCompletedAt.getTime() > input.evaluatedAt.getTime()) {
    throw new Error('Archive completion cannot be in the future');
  }
  return input.apply ? 'purge_candidate' : 'dry_run_candidate';
}

export function retentionArchiveCoverage(due: number, archived: number): {
  blocked: number;
  decision: 'archive_required' | 'archive_ready';
} {
  if (!Number.isSafeInteger(due) || due < 0
    || !Number.isSafeInteger(archived) || archived < 0 || archived > due) {
    throw new Error('Retention archive coverage counts are invalid');
  }
  const blocked = due - archived;
  return { blocked, decision: blocked === 0 ? 'archive_ready' : 'archive_required' };
}

export const TASK4_EXPORT_DATASETS = [
  'observed_metric_evidence',
  'provider_delivery_evidence',
  'lifecycle_projections',
  'correction_overlays',
  'security_audit',
] as const;

export type Task4ExportDataset = typeof TASK4_EXPORT_DATASETS[number];

export const TASK4_EXPORT_FORBIDDEN_FIELDS = [
  'credential',
  'credential_hash',
  'private_key',
  'installation_token',
  'webhook_secret',
  'master_key',
  'prompt',
  'raw_payload',
  'raw_event',
] as const;

export function exportFieldIsAllowed(fieldName: string): boolean {
  const normalized = fieldName.trim().toLowerCase();
  return !TASK4_EXPORT_FORBIDDEN_FIELDS.some(forbidden => (
    normalized === forbidden || normalized.endsWith(`_${forbidden}`)
  ));
}

export function validateExportWindow(input: {
  scopeFrom: Date;
  scopeUntil: Date;
  evaluatedAt: Date;
}): void {
  if (!Number.isFinite(input.scopeFrom.getTime())
    || !Number.isFinite(input.scopeUntil.getTime())
    || !Number.isFinite(input.evaluatedAt.getTime())) {
    throw new Error('Export timestamps must be valid');
  }
  const windowMs = input.scopeUntil.getTime() - input.scopeFrom.getTime();
  if (windowMs <= 0 || windowMs > MAX_EXPORT_WINDOW_MS) {
    throw new Error('Export window must be greater than zero and at most 31 days');
  }
  if (input.scopeUntil.getTime() > input.evaluatedAt.getTime()) {
    throw new Error('Export window cannot end in the future');
  }
}

export function validateExportArtifactBytes(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Export artifact byte length is invalid');
  }
  if (byteLength > MAX_EXPORT_ARTIFACT_BYTES) {
    throw new Error('Export artifact exceeds the maximum 32 MiB single-file limit');
  }
}

export type OperationalEvidenceState =
  | 'delivered'
  | 'quarantined'
  | 'retrying'
  | 'delayed'
  | 'unresolved';

export function classifyOperationalEvidence(input: {
  deliveredAt: Date | null;
  quarantinedAt: Date | null;
  attempts: number;
  nextRetryAt: Date | null;
  firstObservedAt: Date;
  evaluatedAt: Date;
  delayedAfterMs: number;
}): OperationalEvidenceState {
  if (input.deliveredAt) return 'delivered';
  if (input.quarantinedAt) return 'quarantined';
  if (!Number.isInteger(input.attempts) || input.attempts < 0) {
    throw new Error('Delivery attempts must be a non-negative integer');
  }
  if (!Number.isFinite(input.firstObservedAt.getTime())
    || !Number.isFinite(input.evaluatedAt.getTime())
    || !Number.isFinite(input.delayedAfterMs)
    || input.delayedAfterMs < 0) {
    throw new Error('Operational monitoring inputs must be valid');
  }
  if (input.attempts > 0 && input.nextRetryAt) return 'retrying';
  if (input.evaluatedAt.getTime() - input.firstObservedAt.getTime() >= input.delayedAfterMs) {
    return 'delayed';
  }
  return 'unresolved';
}

export function classifyTenantOperationalHealth(input: {
  failed: number;
  expiredWork: number;
  delayedWork: number;
}): 'healthy' | 'attention' | 'critical' {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Operational health counts must be non-negative integers');
    }
  }
  if (input.failed > 0 || input.expiredWork > 0) return 'critical';
  if (input.delayedWork > 0) return 'attention';
  return 'healthy';
}

export function classifyClientDeliveryHealthStatus(input: {
  receivedAt: Date | null;
  evaluatedAt: Date;
  staleAfterMs?: number;
}): 'unreported' | 'current' | 'stale' {
  if (!Number.isFinite(input.evaluatedAt.getTime())) {
    throw new Error('Client delivery-health evaluation time is invalid');
  }
  if (input.receivedAt === null) return 'unreported';
  if (!Number.isFinite(input.receivedAt.getTime())) {
    throw new Error('Client delivery-health receipt time is invalid');
  }
  const staleAfterMs = input.staleAfterMs ?? CLIENT_DELIVERY_HEALTH_STALE_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('Client delivery-health stale interval is invalid');
  }
  return input.receivedAt.getTime() < input.evaluatedAt.getTime() - staleAfterMs
    ? 'stale'
    : 'current';
}

export function pendingNormalizationIsEligible(input: {
  status: string;
  createdAt: Date;
  evaluatedAt: Date;
  delayMs: number;
}): boolean {
  if (!Number.isFinite(input.createdAt.getTime())
    || !Number.isFinite(input.evaluatedAt.getTime())
    || !Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
    throw new Error('Pending normalization eligibility input is invalid');
  }
  return input.status === 'pending'
    && input.createdAt.getTime() <= input.evaluatedAt.getTime() - input.delayMs;
}
