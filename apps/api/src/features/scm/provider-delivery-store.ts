import { and, eq, isNull } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { db } from '../../core/db';
import * as schema from '../../core/db/schema';
import { providerEventDeliveries, providerProjectionCursors } from '../../core/db/schema';
import type { SCMPayload } from './parser';
import {
  classifyProviderDeliveryCollision,
  classifyProviderProjectionEvent,
  planProviderDeliveryClaim,
  type ProviderProjectionDecision,
  type ProviderProjectionIdentity,
  type ProviderDeliveryStatus,
} from './provider-event';

export type ProviderTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface ClaimProviderDeliveryInput {
  tenantId: string;
  repositoryId?: string | null;
  provider: SCMPayload['provider'];
  deliveryId: string;
  eventType: SCMPayload['eventType'];
  fingerprint: string;
  providerOccurredAt: Date | null;
  rawEvent: Record<string, unknown>;
  now?: Date;
}

export type ClaimProviderDeliveryResult =
  | {
    outcome: 'claimed'; action: 'process' | 'resume'; recordId: string; leaseStartedAt: Date;
  }
  | { outcome: 'retry'; recordId: string }
  | { outcome: 'acknowledge'; reason: ProviderDeliveryStatus | 'conflict'; recordId: string };

function providerDeliveryStatus(value: string): ProviderDeliveryStatus {
  switch (value) {
    case 'received':
    case 'projected':
    case 'applied':
    case 'duplicate':
    case 'stale':
    case 'conflict':
    case 'unsequenced':
    case 'failed':
      return value;
    default:
      throw new Error('Provider delivery has an invalid processing status');
  }
}

/**
 * Persists immutable provider evidence and atomically acquires its processing
 * lease. A concurrent request either observes an active lease and retries, or
 * wins a compare-and-swap update after the previous lease expires.
 */
export async function claimProviderDeliveryInTransaction(
  transaction: ProviderTransaction,
  input: ClaimProviderDeliveryInput,
): Promise<ClaimProviderDeliveryResult> {
  const now = input.now ?? new Date();
  const [inserted] = await transaction.insert(providerEventDeliveries).values({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId ?? null,
      provider: input.provider,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      eventFingerprint: input.fingerprint,
      providerOccurredAt: input.providerOccurredAt,
      rawEvent: input.rawEvent,
      processingStatus: 'received',
      processingStartedAt: now,
    }).onConflictDoNothing({
      target: [
        providerEventDeliveries.tenantId,
        providerEventDeliveries.provider,
        providerEventDeliveries.deliveryId,
      ],
    }).returning({ id: providerEventDeliveries.id });

    if (inserted) {
      return {
        outcome: 'claimed', action: 'process', recordId: inserted.id, leaseStartedAt: now,
      };
    }

    const [existing] = await transaction.select({
      id: providerEventDeliveries.id,
      deliveryId: providerEventDeliveries.deliveryId,
      fingerprint: providerEventDeliveries.eventFingerprint,
      processingStatus: providerEventDeliveries.processingStatus,
      processingStartedAt: providerEventDeliveries.processingStartedAt,
    }).from(providerEventDeliveries).where(and(
      eq(providerEventDeliveries.tenantId, input.tenantId),
      eq(providerEventDeliveries.provider, input.provider),
      eq(providerEventDeliveries.deliveryId, input.deliveryId),
    )).limit(1);

    if (!existing) {
      throw new Error('Provider delivery conflict could not be resolved');
    }

    const collision = classifyProviderDeliveryCollision(existing, input);
    if (collision === 'conflict') {
      return { outcome: 'acknowledge', reason: 'conflict', recordId: existing.id };
    }
    if (collision !== 'same') {
      throw new Error('Provider delivery identity resolved to an unrelated record');
    }

    const status = providerDeliveryStatus(existing.processingStatus);
    const plan = planProviderDeliveryClaim(status, existing.processingStartedAt, now);
    if (!plan.claim) {
      return plan.action === 'acknowledge'
        ? { outcome: 'acknowledge', reason: status, recordId: existing.id }
        : { outcome: 'retry', recordId: existing.id };
    }

    const expectedLease = existing.processingStartedAt
      ? eq(providerEventDeliveries.processingStartedAt, existing.processingStartedAt)
      : isNull(providerEventDeliveries.processingStartedAt);
    const nextStatus = plan.action === 'resume' ? 'projected' : 'received';
    const [claimed] = await transaction.update(providerEventDeliveries).set({
      processingStatus: nextStatus,
      processingStartedAt: now,
      errorCode: null,
      processedAt: null,
    }).where(and(
      eq(providerEventDeliveries.id, existing.id),
      eq(providerEventDeliveries.processingStatus, status),
      expectedLease,
    )).returning({ id: providerEventDeliveries.id });

  return claimed
    ? {
      outcome: 'claimed', action: plan.action as 'process' | 'resume',
      recordId: claimed.id, leaseStartedAt: now,
    }
    : { outcome: 'retry', recordId: existing.id };
}

export async function claimProviderDelivery(
  input: ClaimProviderDeliveryInput,
): Promise<ClaimProviderDeliveryResult> {
  return db.transaction(transaction => claimProviderDeliveryInTransaction(transaction, input));
}

export interface ProjectProviderDeliveryInput {
  tenantId: string;
  provider: SCMPayload['provider'];
  deliveryId: string;
  recordId: string;
  leaseStartedAt: Date;
  fingerprint: string;
  occurredAt: Date | null;
  identity: ProviderProjectionIdentity;
  now?: Date;
}

export type ProjectProviderDeliveryResult<T> =
  | { outcome: 'projected'; value: T }
  | { outcome: 'acknowledge'; reason: Exclude<ProviderProjectionDecision, 'apply'> };

async function markProjectionOutcome(
  transaction: ProviderTransaction,
  input: ProjectProviderDeliveryInput,
  status: 'projected' | Exclude<ProviderProjectionDecision, 'apply'>,
  now: Date,
): Promise<void> {
  const terminal = status !== 'projected';
  const [updated] = await transaction.update(providerEventDeliveries).set({
    processingStatus: status,
    processingStartedAt: terminal ? null : input.leaseStartedAt,
    processedAt: terminal ? now : null,
    errorCode: null,
  }).where(and(
    eq(providerEventDeliveries.id, input.recordId),
    eq(providerEventDeliveries.tenantId, input.tenantId),
    eq(providerEventDeliveries.provider, input.provider),
    eq(providerEventDeliveries.deliveryId, input.deliveryId),
    eq(providerEventDeliveries.eventFingerprint, input.fingerprint),
    eq(providerEventDeliveries.processingStatus, 'received'),
    eq(providerEventDeliveries.processingStartedAt, input.leaseStartedAt),
  )).returning({ id: providerEventDeliveries.id });
  if (!updated) throw new Error('Provider delivery processing lease was lost');
}

/**
 * Applies a mutable SCM projection and advances its chronological cursor in
 * one transaction. Stale, conflicting and unsequenced evidence is retained
 * but cannot invoke the projection callback.
 */
export async function projectProviderDeliveryInTransaction<T>(
  transaction: ProviderTransaction,
  input: ProjectProviderDeliveryInput,
  project: (transaction: ProviderTransaction) => Promise<T>,
): Promise<ProjectProviderDeliveryResult<T>> {
  const now = input.now ?? new Date();
  const cursorPredicate = and(
      eq(providerProjectionCursors.tenantId, input.tenantId),
      eq(providerProjectionCursors.provider, input.provider),
      eq(providerProjectionCursors.projectionType, input.identity.projectionType),
      eq(providerProjectionCursors.projectionKey, input.identity.projectionKey),
    );

    let [cursor] = await transaction.select({
      id: providerProjectionCursors.id,
      occurredAt: providerProjectionCursors.lastProviderOccurredAt,
      fingerprint: providerProjectionCursors.lastEventFingerprint,
    }).from(providerProjectionCursors).where(cursorPredicate).limit(1).for('update');

    let decision = classifyProviderProjectionEvent(cursor ?? null, {
      occurredAt: input.occurredAt,
      fingerprint: input.fingerprint,
    });

    if (!cursor && decision === 'apply') {
      const [inserted] = await transaction.insert(providerProjectionCursors).values({
        tenantId: input.tenantId,
        provider: input.provider,
        projectionType: input.identity.projectionType,
        projectionKey: input.identity.projectionKey,
        lastProviderOccurredAt: input.occurredAt,
        lastEventFingerprint: input.fingerprint,
        lastDeliveryId: input.deliveryId,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [
          providerProjectionCursors.tenantId,
          providerProjectionCursors.provider,
          providerProjectionCursors.projectionType,
          providerProjectionCursors.projectionKey,
        ],
      }).returning({ id: providerProjectionCursors.id });

      if (inserted) {
        cursor = { id: inserted.id, occurredAt: input.occurredAt, fingerprint: input.fingerprint };
      } else {
        [cursor] = await transaction.select({
          id: providerProjectionCursors.id,
          occurredAt: providerProjectionCursors.lastProviderOccurredAt,
          fingerprint: providerProjectionCursors.lastEventFingerprint,
        }).from(providerProjectionCursors).where(cursorPredicate).limit(1).for('update');
        if (!cursor) throw new Error('Provider projection cursor conflict could not be resolved');
        decision = classifyProviderProjectionEvent(cursor, {
          occurredAt: input.occurredAt,
          fingerprint: input.fingerprint,
        });
      }
    }

    if (decision !== 'apply') {
      await markProjectionOutcome(transaction, input, decision, now);
      return { outcome: 'acknowledge', reason: decision };
    }

    const value = await project(transaction);
    if (cursor?.fingerprint !== input.fingerprint) {
      await transaction.update(providerProjectionCursors).set({
        lastProviderOccurredAt: input.occurredAt,
        lastEventFingerprint: input.fingerprint,
        lastDeliveryId: input.deliveryId,
        updatedAt: now,
      }).where(eq(providerProjectionCursors.id, cursor!.id));
    }
  await markProjectionOutcome(transaction, input, 'projected', now);
  return { outcome: 'projected', value };
}

export async function projectProviderDelivery<T>(
  input: ProjectProviderDeliveryInput,
  project: (transaction: ProviderTransaction) => Promise<T>,
): Promise<ProjectProviderDeliveryResult<T>> {
  return db.transaction(transaction => projectProviderDeliveryInTransaction(
    transaction,
    input,
    project,
  ));
}

export interface FinishProviderDeliveryInput {
  tenantId: string;
  recordId: string;
  leaseStartedAt: Date;
  now?: Date;
}

export async function completeProviderDeliveryInTransaction(
  transaction: ProviderTransaction,
  input: FinishProviderDeliveryInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [updated] = await transaction.update(providerEventDeliveries).set({
    processingStatus: 'applied',
    processingStartedAt: null,
    processedAt: now,
    errorCode: null,
  }).where(and(
    eq(providerEventDeliveries.id, input.recordId),
    eq(providerEventDeliveries.tenantId, input.tenantId),
    eq(providerEventDeliveries.processingStatus, 'projected'),
    eq(providerEventDeliveries.processingStartedAt, input.leaseStartedAt),
  )).returning({ id: providerEventDeliveries.id });
  return Boolean(updated);
}

export async function completeProviderDelivery(
  input: FinishProviderDeliveryInput,
): Promise<boolean> {
  return db.transaction(transaction => completeProviderDeliveryInTransaction(transaction, input));
}

export interface ReleaseProviderDeliveryInput extends FinishProviderDeliveryInput {
  stage: 'received' | 'projected';
  errorCode: 'projection_failed' | 'enrichment_failed';
}

export async function releaseProviderDeliveryForRetryInTransaction(
  transaction: ProviderTransaction,
  input: ReleaseProviderDeliveryInput,
): Promise<boolean> {
  const [updated] = await transaction.update(providerEventDeliveries).set({
    processingStatus: input.stage === 'received' ? 'failed' : 'projected',
    processingStartedAt: null,
    processedAt: null,
    errorCode: input.errorCode,
  }).where(and(
    eq(providerEventDeliveries.id, input.recordId),
    eq(providerEventDeliveries.tenantId, input.tenantId),
    eq(providerEventDeliveries.processingStatus, input.stage),
    eq(providerEventDeliveries.processingStartedAt, input.leaseStartedAt),
  )).returning({ id: providerEventDeliveries.id });
  return Boolean(updated);
}

export async function releaseProviderDeliveryForRetry(
  input: ReleaseProviderDeliveryInput,
): Promise<boolean> {
  return db.transaction(transaction => releaseProviderDeliveryForRetryInTransaction(
    transaction,
    input,
  ));
}
