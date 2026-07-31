import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db';
import {
  developerMachines,
  machineRepositoryGrants,
  repositoryEnrollments,
  scmRepositories,
  securityAuditEvents,
} from '../db/schema';
import { branchPatternIsValid, repositoryGrantAllows } from './repository-grant';

export interface EnrollRepositoryInput {
  tenantId: string;
  repositoryId: string;
  actorId: string;
  reason?: string;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
}

export interface GrantRepositoryInput {
  tenantId: string;
  machineId: string;
  enrollmentId: string;
  branchPatterns?: string[];
  actorId: string;
  reason?: string;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
}

function validateInterval(from: Date, until?: Date): void {
  if (until && until.getTime() <= from.getTime()) {
    throw new Error('Policy effectiveUntil must be later than effectiveFrom');
  }
}

export async function enrollRepository(input: EnrollRepositoryInput) {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  validateInterval(effectiveFrom, input.effectiveUntil);
  return db.transaction(async (transaction) => {
    const [repository] = await transaction.select({ id: scmRepositories.id })
      .from(scmRepositories).where(and(
        eq(scmRepositories.tenantId, input.tenantId),
        eq(scmRepositories.id, input.repositoryId),
      )).limit(1);
    if (!repository) throw new Error('Tenant repository was not found');

    const [enrollment] = await transaction.insert(repositoryEnrollments).values({
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      effectiveFrom,
      effectiveUntil: input.effectiveUntil,
      enrolledBy: input.actorId,
      reason: input.reason,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'repository.enrolled',
      targetType: 'repository_enrollment',
      targetId: enrollment.id,
      details: {
        repositoryId: input.repositoryId,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveUntil: input.effectiveUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });
    return enrollment;
  });
}

export async function grantMachineRepository(input: GrantRepositoryInput) {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const branchPatterns = input.branchPatterns ?? [];
  validateInterval(effectiveFrom, input.effectiveUntil);
  if (branchPatterns.some((pattern) => !branchPatternIsValid(pattern))) {
    throw new Error('Branch patterns must be exact names or a prefix ending in /*');
  }

  return db.transaction(async (transaction) => {
    const [machine] = await transaction.select({ id: developerMachines.id })
      .from(developerMachines).where(and(
        eq(developerMachines.tenantId, input.tenantId),
        eq(developerMachines.id, input.machineId),
        eq(developerMachines.status, 'active'),
      )).limit(1);
    if (!machine) throw new Error('Active developer machine was not found');

    const [enrollment] = await transaction.select({ id: repositoryEnrollments.id })
      .from(repositoryEnrollments).where(and(
        eq(repositoryEnrollments.tenantId, input.tenantId),
        eq(repositoryEnrollments.id, input.enrollmentId),
        eq(repositoryEnrollments.status, 'active'),
      )).limit(1);
    if (!enrollment) throw new Error('Active repository enrollment was not found');

    const [grant] = await transaction.insert(machineRepositoryGrants).values({
      tenantId: input.tenantId,
      machineId: input.machineId,
      enrollmentId: input.enrollmentId,
      branchPatterns,
      effectiveFrom,
      effectiveUntil: input.effectiveUntil,
      grantedBy: input.actorId,
      reason: input.reason,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'repository_grant.issued',
      targetType: 'machine_repository_grant',
      targetId: grant.id,
      details: {
        machineId: input.machineId,
        enrollmentId: input.enrollmentId,
        branchPatterns,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveUntil: input.effectiveUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });
    return grant;
  });
}

export async function revokeMachineRepositoryGrant(
  tenantId: string,
  grantId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const revokedAt = new Date();
    const [grant] = await transaction.update(machineRepositoryGrants).set({
      status: 'revoked', revokedAt,
    }).where(and(
      eq(machineRepositoryGrants.tenantId, tenantId),
      eq(machineRepositoryGrants.id, grantId),
      eq(machineRepositoryGrants.status, 'active'),
    )).returning({ id: machineRepositoryGrants.id, machineId: machineRepositoryGrants.machineId });
    if (!grant) throw new Error('Active machine repository grant was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'repository_grant.revoked',
      targetType: 'machine_repository_grant',
      targetId: grant.id,
      details: { machineId: grant.machineId, reason },
    });
  });
}

export async function revokeRepositoryEnrollment(
  tenantId: string,
  enrollmentId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [enrollment] = await transaction.update(repositoryEnrollments).set({
      status: 'revoked', updatedAt: new Date(),
    }).where(and(
      eq(repositoryEnrollments.tenantId, tenantId),
      eq(repositoryEnrollments.id, enrollmentId),
      eq(repositoryEnrollments.status, 'active'),
    )).returning({ id: repositoryEnrollments.id, repositoryId: repositoryEnrollments.repositoryId });
    if (!enrollment) throw new Error('Active repository enrollment was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'repository.revoked',
      targetType: 'repository_enrollment',
      targetId: enrollment.id,
      details: { repositoryId: enrollment.repositoryId, reason },
    });
  });
}

export async function machineCanAccessRepository(input: {
  tenantId: string;
  machineId: string;
  repositoryId: string;
  branch: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db.select({
    tenantId: machineRepositoryGrants.tenantId,
    machineId: machineRepositoryGrants.machineId,
    repositoryId: repositoryEnrollments.repositoryId,
    status: machineRepositoryGrants.status,
    branchPatterns: machineRepositoryGrants.branchPatterns,
    effectiveFrom: machineRepositoryGrants.effectiveFrom,
    effectiveUntil: machineRepositoryGrants.effectiveUntil,
  }).from(machineRepositoryGrants).innerJoin(developerMachines, and(
    eq(developerMachines.tenantId, machineRepositoryGrants.tenantId),
    eq(developerMachines.id, machineRepositoryGrants.machineId),
  )).innerJoin(repositoryEnrollments, and(
    eq(repositoryEnrollments.tenantId, machineRepositoryGrants.tenantId),
    eq(repositoryEnrollments.id, machineRepositoryGrants.enrollmentId),
  )).where(and(
    eq(machineRepositoryGrants.tenantId, input.tenantId),
    eq(machineRepositoryGrants.machineId, input.machineId),
    eq(developerMachines.status, 'active'),
    isNull(developerMachines.revokedAt),
    eq(repositoryEnrollments.repositoryId, input.repositoryId),
    eq(repositoryEnrollments.status, 'active'),
    lte(repositoryEnrollments.effectiveFrom, now),
    or(isNull(repositoryEnrollments.effectiveUntil), gt(repositoryEnrollments.effectiveUntil, now)),
    eq(machineRepositoryGrants.status, 'active'),
    lte(machineRepositoryGrants.effectiveFrom, now),
    or(isNull(machineRepositoryGrants.effectiveUntil), gt(machineRepositoryGrants.effectiveUntil, now)),
  ));
  return rows.some((grant) => repositoryGrantAllows(grant, { ...input, now }));
}
