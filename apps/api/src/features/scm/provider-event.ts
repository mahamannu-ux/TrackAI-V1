import { createHash } from 'node:crypto';
import type { SCMPayload } from './parser';

export type ProviderProjectionDecision =
  | 'apply'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'unsequenced';

export type ProviderDeliveryStatus =
  | 'received'
  | 'projected'
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'unsequenced'
  | 'failed';

export type ProviderDeliveryAction = 'process' | 'retry' | 'resume' | 'acknowledge';

export interface ProviderDeliveryClaimPlan {
  action: ProviderDeliveryAction;
  claim: boolean;
}

export interface ProviderDeliveryIdentity {
  deliveryId: string;
  fingerprint: string;
}

export type ProviderDeliveryCollision = 'same' | 'duplicate' | 'conflict' | 'unrelated';

export const PROVIDER_DELIVERY_LEASE_MS = 5 * 60 * 1000;

export interface ProviderProjectionVersion {
  occurredAt: Date | null;
  fingerprint: string;
}

export interface ProviderProjectionIdentity {
  projectionType: 'pull_request' | 'branch' | 'deployment';
  projectionKey: string;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Provider evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('Provider evidence contains a non-JSON value');
}

export function providerEventFingerprint(
  provider: string,
  eventType: string,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ provider, eventType, payload }), 'utf8')
    .digest('hex');
}

function validTimestamp(value: Date | null): value is Date {
  return value !== null && Number.isFinite(value.getTime());
}

export function classifyProviderProjectionEvent(
  current: ProviderProjectionVersion | null,
  incoming: ProviderProjectionVersion,
): ProviderProjectionDecision {
  if (current?.fingerprint === incoming.fingerprint) return 'duplicate';
  if (!validTimestamp(incoming.occurredAt)) return 'unsequenced';
  if (!current) return 'apply';
  if (!validTimestamp(current.occurredAt)) return 'apply';
  const difference = incoming.occurredAt.getTime() - current.occurredAt.getTime();
  if (difference > 0) return 'apply';
  if (difference < 0) return 'stale';
  return 'conflict';
}

export function classifyProviderDeliveryState(
  status: ProviderDeliveryStatus | null,
): ProviderDeliveryAction {
  if (status === null) return 'process';
  if (status === 'received' || status === 'failed') return 'retry';
  if (status === 'projected') return 'resume';
  return 'acknowledge';
}

export function providerDeliveryCanBeClaimed(
  status: ProviderDeliveryStatus | null,
  processingStartedAt: Date | null,
  now: Date,
  leaseMs = PROVIDER_DELIVERY_LEASE_MS,
): boolean {
  if (status === null || status === 'failed') return true;
  if (status !== 'received' && status !== 'projected') return false;
  if (!processingStartedAt) return true;
  return now.getTime() - processingStartedAt.getTime() >= leaseMs;
}

export function normalizeProviderDeliveryId(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 255) return null;
  return /^[A-Za-z0-9._:-]+$/.test(normalized) ? normalized : null;
}

export function planProviderDeliveryClaim(
  status: ProviderDeliveryStatus | null,
  processingStartedAt: Date | null,
  now: Date,
): ProviderDeliveryClaimPlan {
  const action = classifyProviderDeliveryState(status);
  if (action === 'acknowledge') return { action, claim: false };
  if (!providerDeliveryCanBeClaimed(status, processingStartedAt, now)) {
    return { action: 'retry', claim: false };
  }
  return action === 'resume'
    ? { action, claim: true }
    : { action: 'process', claim: true };
}

export function classifyProviderDeliveryCollision(
  existing: ProviderDeliveryIdentity,
  incoming: ProviderDeliveryIdentity,
): ProviderDeliveryCollision {
  const sameDelivery = existing.deliveryId === incoming.deliveryId;
  const sameEvidence = existing.fingerprint === incoming.fingerprint;
  if (sameDelivery && sameEvidence) return 'same';
  if (sameEvidence) return 'duplicate';
  if (sameDelivery) return 'conflict';
  return 'unrelated';
}

export function providerProjectionIdentity(payload: SCMPayload): ProviderProjectionIdentity {
  const repositoryId = payload.repository.externalId;
  if (payload.pullRequest) {
    return {
      projectionType: 'pull_request',
      projectionKey: `${repositoryId}:${payload.pullRequest.externalId}`,
    };
  }
  if (payload.push) {
    return {
      projectionType: 'branch',
      projectionKey: `${repositoryId}:${payload.push.ref}`,
    };
  }
  if (payload.deployment) {
    return {
      projectionType: 'deployment',
      projectionKey: `${repositoryId}:${payload.deployment.externalId}`,
    };
  }
  throw new Error('Provider payload has no supported projection identity');
}
