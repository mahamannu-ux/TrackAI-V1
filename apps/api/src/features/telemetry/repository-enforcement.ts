import { decodeAttributes, validateMetricEvent } from './decoder';
import { normalizeRepositoryUrl } from './repository-url';
import type { GitAiMetricsBatch } from './types';
import {
  evaluateEvidenceWatermark,
  type EvidenceArrivalClass,
  type EvidenceFamily,
} from './watermark-policy';

export type RepositoryGrantLookup = (
  normalizedRepository: string,
  branch: string | null,
) => Promise<boolean>;

export type RepositoryScopeError = { index: number; error: string };

export interface ManagedRepositoryIngestionPolicy {
  enrollmentId: string;
  generationSessionEvidenceFrom: Date;
  commitNoteEvidenceFrom: Date;
  backfillAuthorizations: Array<{
    id: string;
    evidenceFamily: 'generation_session' | 'commit_note';
    occurredFrom: Date;
    occurredUntil: Date;
    expiresAt: Date;
  }>;
}

export interface MetricIngestionLabel {
  index: number;
  enrollmentId: string;
  evidenceFamily: EvidenceFamily;
  arrivalClass: Exclude<EvidenceArrivalClass, 'rejected'>;
  backfillAuthorizationId: string | null;
}

export interface ManagedMachineIngestionDecision {
  errors: RepositoryScopeError[];
  labels: MetricIngestionLabel[];
}

export interface AuthorizedMetricsPartition {
  batch: GitAiMetricsBatch;
  originalIndexes: number[];
}

/**
 * Validate every repository-bearing event for an authenticated managed machine.
 * Malformed event shapes remain the ordinary decoder's responsibility.
 */
export async function validateManagedMachineRepositoryScope(
  batch: GitAiMetricsBatch,
  grantAllows: RepositoryGrantLookup,
): Promise<RepositoryScopeError[]> {
  const errors: RepositoryScopeError[] = [];
  for (const [index, rawEvent] of batch.events.entries()) {
    let event;
    try {
      event = validateMetricEvent(rawEvent);
    } catch {
      continue;
    }

    const attributes = decodeAttributes(event.a);
    if (!attributes.repoUrl) {
      errors.push({ index, error: 'Repository is required for managed machine telemetry' });
      continue;
    }

    let normalizedRepository: string;
    try {
      normalizedRepository = normalizeRepositoryUrl(attributes.repoUrl);
    } catch {
      errors.push({ index, error: 'Repository URL is invalid' });
      continue;
    }

    if (!await grantAllows(normalizedRepository, attributes.branch)) {
      errors.push({ index, error: 'Machine repository or branch grant is not active' });
    }
  }
  return errors;
}

export async function evaluateManagedMachineIngestionPolicy(
  batch: GitAiMetricsBatch,
  policyLookup: (
    normalizedRepository: string,
    branch: string | null,
  ) => Promise<ManagedRepositoryIngestionPolicy | null>,
  receivedAt = new Date(),
): Promise<ManagedMachineIngestionDecision> {
  const errors: RepositoryScopeError[] = [];
  const labels: MetricIngestionLabel[] = [];
  for (const [index, rawEvent] of batch.events.entries()) {
    let event;
    try {
      event = validateMetricEvent(rawEvent);
    } catch {
      continue;
    }
    const attributes = decodeAttributes(event.a);
    if (!attributes.repoUrl) {
      errors.push({ index, error: 'Repository is required for managed machine telemetry' });
      continue;
    }
    let normalizedRepository: string;
    try {
      normalizedRepository = normalizeRepositoryUrl(attributes.repoUrl);
    } catch {
      errors.push({ index, error: 'Repository URL is invalid' });
      continue;
    }
    const policy = await policyLookup(normalizedRepository, attributes.branch);
    if (!policy) {
      errors.push({ index, error: 'Machine repository or branch grant is not active' });
      continue;
    }
    const baseInput = {
      event,
      watermarks: {
        generationSessionFrom: policy.generationSessionEvidenceFrom,
        commitNoteFrom: policy.commitNoteEvidenceFrom,
      },
      receivedAt,
    };
    let decision = evaluateEvidenceWatermark(baseInput);
    let backfillAuthorizationId: string | null = null;
    if (decision.arrivalClass === 'rejected') {
      for (const authorization of policy.backfillAuthorizations) {
        const candidate = evaluateEvidenceWatermark({
          ...baseInput,
          authorization,
        });
        if (candidate.arrivalClass === 'backfill') {
          decision = candidate;
          backfillAuthorizationId = authorization.id;
          break;
        }
      }
    }
    if (decision.arrivalClass === 'rejected') {
      errors.push({ index, error: 'Evidence predates the repository enrollment watermark' });
      continue;
    }
    labels.push({
      index,
      enrollmentId: policy.enrollmentId,
      evidenceFamily: decision.family,
      arrivalClass: decision.arrivalClass,
      backfillAuthorizationId,
    });
  }
  return { errors, labels };
}

function validatedErrorIndexes(
  errors: readonly RepositoryScopeError[],
  batchSize: number,
): Set<number> {
  const indexes = new Set<number>();
  for (const error of errors) {
    if (!Number.isInteger(error.index) || error.index < 0 || error.index >= batchSize
      || indexes.has(error.index)) {
      throw new Error('Upload error indexes must be unique and inside the source batch');
    }
    indexes.add(error.index);
  }
  return indexes;
}

export function partitionAuthorizedMetricsBatch(
  batch: GitAiMetricsBatch,
  scopeErrors: readonly RepositoryScopeError[],
): AuthorizedMetricsPartition {
  const rejectedIndexes = validatedErrorIndexes(scopeErrors, batch.events.length);
  const originalIndexes: number[] = [];
  const events = batch.events.filter((_event, index) => {
    if (rejectedIndexes.has(index)) return false;
    originalIndexes.push(index);
    return true;
  });
  return { batch: { ...batch, events }, originalIndexes };
}

export function remapAuthorizedUploadErrors(
  scopeErrors: readonly RepositoryScopeError[],
  authorizedErrors: readonly RepositoryScopeError[],
  partition: AuthorizedMetricsPartition,
): RepositoryScopeError[] {
  validatedErrorIndexes(authorizedErrors, partition.originalIndexes.length);
  return [
    ...scopeErrors,
    ...authorizedErrors.map((error) => ({
      index: partition.originalIndexes[error.index],
      error: error.error,
    })),
  ].sort((left, right) => left.index - right.index);
}
