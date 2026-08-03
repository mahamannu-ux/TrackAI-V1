import { and, desc, eq, max } from 'drizzle-orm';
import { db } from '../db';
import {
  securityAuditEvents,
  tenantRetentionPolicies,
} from '../db/schema';
import {
  DEFAULT_RETENTION_POLICY,
  TASK4_RETENTION_POLICY_VERSION,
  validateRetentionPolicy,
  type RetentionMode,
} from './task4-operations-contract';

export interface ReplaceTenantRetentionPolicyInput {
  tenantId: string;
  actorId: string;
  mode: RetentionMode;
  retentionDays: number | null;
  reason: string;
  now?: Date;
}

export async function listTenantRetentionPolicies(tenantId: string) {
  const policies = await db.select({
    id: tenantRetentionPolicies.id,
    version: tenantRetentionPolicies.version,
    mode: tenantRetentionPolicies.mode,
    retentionDays: tenantRetentionPolicies.retentionDays,
    status: tenantRetentionPolicies.status,
    createdBy: tenantRetentionPolicies.createdBy,
    reason: tenantRetentionPolicies.reason,
    effectiveFrom: tenantRetentionPolicies.effectiveFrom,
    supersededAt: tenantRetentionPolicies.supersededAt,
    createdAt: tenantRetentionPolicies.createdAt,
  }).from(tenantRetentionPolicies).where(eq(tenantRetentionPolicies.tenantId, tenantId))
    .orderBy(desc(tenantRetentionPolicies.version));
  const active = policies.find(policy => policy.status === 'active') ?? null;
  return {
    active: active ?? {
      id: null,
      version: 0,
      mode: DEFAULT_RETENTION_POLICY.mode,
      retentionDays: DEFAULT_RETENTION_POLICY.retentionDays,
      status: 'default' as const,
      createdBy: null,
      reason: 'Task4 fail-safe default: retain evidence until an explicit policy is configured.',
      effectiveFrom: null,
      supersededAt: null,
      createdAt: null,
    },
    history: policies,
  };
}

export async function replaceTenantRetentionPolicy(input: ReplaceTenantRetentionPolicyInput) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 1_000) throw new Error('Retention policy reason is required');
  const contract = validateRetentionPolicy({
    version: TASK4_RETENTION_POLICY_VERSION,
    mode: input.mode,
    retentionDays: input.retentionDays,
  });
  const now = input.now ?? new Date();

  return db.transaction(async transaction => {
    const [current] = await transaction.select().from(tenantRetentionPolicies).where(and(
      eq(tenantRetentionPolicies.tenantId, input.tenantId),
      eq(tenantRetentionPolicies.status, 'active'),
    )).limit(1).for('update');
    if (current
      && current.mode === contract.mode
      && current.retentionDays === contract.retentionDays) {
      throw new Error('Retention policy is already active with these settings');
    }
    const [latest] = await transaction.select({
      version: max(tenantRetentionPolicies.version),
    }).from(tenantRetentionPolicies).where(eq(tenantRetentionPolicies.tenantId, input.tenantId));
    const nextVersion = (latest?.version ?? 0) + 1;

    if (current) {
      const [superseded] = await transaction.update(tenantRetentionPolicies).set({
        status: 'superseded',
        supersededAt: now,
      }).where(and(
        eq(tenantRetentionPolicies.tenantId, input.tenantId),
        eq(tenantRetentionPolicies.id, current.id),
        eq(tenantRetentionPolicies.status, 'active'),
      )).returning({ id: tenantRetentionPolicies.id });
      if (!superseded) throw new Error('Active retention policy changed during replacement');
    }

    const [policy] = await transaction.insert(tenantRetentionPolicies).values({
      tenantId: input.tenantId,
      version: nextVersion,
      mode: contract.mode,
      retentionDays: contract.retentionDays,
      createdBy: input.actorId,
      reason,
      effectiveFrom: now,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: current ? 'retention_policy.replaced' : 'retention_policy.created',
      targetType: 'tenant_retention_policy',
      targetId: policy.id,
      details: {
        previousPolicyId: current?.id ?? null,
        version: policy.version,
        mode: policy.mode,
        retentionDays: policy.retentionDays,
        reason,
      },
    });
    return policy;
  });
}
