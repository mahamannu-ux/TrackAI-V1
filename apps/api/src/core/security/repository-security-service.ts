import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '../db';
import {
  developerMachines,
  machineRepositoryGrants,
  repositoryBackfillAuthorizations,
  repositoryEnrollments,
  scmRepositories,
  securityAuditEvents,
} from '../db/schema';
import { normalizeRepositoryBranchPatterns, repositoryGrantAllows } from './repository-grant';
import { validateBackfillAuthorizationWindow } from './admin-lifecycle-policy';

export interface EnrollRepositoryInput {
  tenantId: string;
  repositoryId: string;
  actorId: string;
  reason?: string;
  effectiveFrom?: Date;
  effectiveUntil?: Date;
  generationSessionEvidenceFrom?: Date;
  commitNoteEvidenceFrom?: Date;
}

export interface AuthorizeRepositoryBackfillInput {
  tenantId: string;
  enrollmentId: string;
  evidenceFamily: 'generation_session' | 'commit_note';
  occurredFrom: Date;
  occurredUntil: Date;
  expiresAt: Date;
  actorId: string;
  reason: string;
  now?: Date;
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

export interface ReplaceRepositoryGrantBranchScopeInput {
  tenantId: string;
  grantId: string;
  branchPatterns: string[];
  actorId: string;
  reason: string;
}

function validateInterval(from: Date, until?: Date): void {
  if (until && until.getTime() <= from.getTime()) {
    throw new Error('Policy effectiveUntil must be later than effectiveFrom');
  }
}

export async function enrollRepository(input: EnrollRepositoryInput) {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  validateInterval(effectiveFrom, input.effectiveUntil);
  const generationSessionEvidenceFrom = input.generationSessionEvidenceFrom ?? effectiveFrom;
  const commitNoteEvidenceFrom = input.commitNoteEvidenceFrom ?? effectiveFrom;
  if (generationSessionEvidenceFrom.getTime() < effectiveFrom.getTime()
    || commitNoteEvidenceFrom.getTime() < effectiveFrom.getTime()) {
    throw new Error('Enrollment watermarks cannot predate policy activation');
  }
  return db.transaction(async (transaction) => {
    const [repository] = await transaction.select({ id: scmRepositories.id })
      .from(scmRepositories).where(and(
        eq(scmRepositories.tenantId, input.tenantId),
        eq(scmRepositories.id, input.repositoryId),
      )).limit(1);
    if (!repository) throw new Error('Tenant repository was not found');

    const [existing] = await transaction.select({
      id: repositoryEnrollments.id,
      status: repositoryEnrollments.status,
    }).from(repositoryEnrollments).where(and(
      eq(repositoryEnrollments.tenantId, input.tenantId),
      eq(repositoryEnrollments.repositoryId, input.repositoryId),
    )).limit(1);
    if (existing?.status === 'active') {
      throw new Error('Repository is already actively enrolled');
    }
    const [enrollment] = existing
      ? await transaction.update(repositoryEnrollments).set({
        status: 'active',
        effectiveFrom,
        generationSessionEvidenceFrom,
        commitNoteEvidenceFrom,
        effectiveUntil: input.effectiveUntil,
        enrolledBy: input.actorId,
        reason: input.reason,
        updatedAt: new Date(),
      }).where(and(
        eq(repositoryEnrollments.tenantId, input.tenantId),
        eq(repositoryEnrollments.id, existing.id),
        eq(repositoryEnrollments.status, 'revoked'),
      )).returning()
      : await transaction.insert(repositoryEnrollments).values({
        tenantId: input.tenantId,
        repositoryId: input.repositoryId,
        effectiveFrom,
        generationSessionEvidenceFrom,
        commitNoteEvidenceFrom,
        effectiveUntil: input.effectiveUntil,
        enrolledBy: input.actorId,
        reason: input.reason,
      }).returning();
    if (!enrollment) throw new Error('Repository enrollment state changed during update');
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: existing ? 'repository.reenrolled' : 'repository.enrolled',
      targetType: 'repository_enrollment',
      targetId: enrollment.id,
      details: {
        repositoryId: input.repositoryId,
        effectiveFrom: effectiveFrom.toISOString(),
        generationSessionEvidenceFrom: generationSessionEvidenceFrom.toISOString(),
        commitNoteEvidenceFrom: commitNoteEvidenceFrom.toISOString(),
        effectiveUntil: input.effectiveUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });
    return enrollment;
  });
}

export async function authorizeRepositoryBackfill(input: AuthorizeRepositoryBackfillInput) {
  const now = input.now ?? new Date();

  return db.transaction(async (transaction) => {
    const [enrollment] = await transaction.select({
      id: repositoryEnrollments.id,
      generationSessionEvidenceFrom: repositoryEnrollments.generationSessionEvidenceFrom,
      commitNoteEvidenceFrom: repositoryEnrollments.commitNoteEvidenceFrom,
    }).from(repositoryEnrollments).where(and(
      eq(repositoryEnrollments.tenantId, input.tenantId),
      eq(repositoryEnrollments.id, input.enrollmentId),
      eq(repositoryEnrollments.status, 'active'),
    )).limit(1).for('update');
    if (!enrollment) throw new Error('Active repository enrollment was not found');
    const watermark = input.evidenceFamily === 'generation_session'
      ? enrollment.generationSessionEvidenceFrom
      : enrollment.commitNoteEvidenceFrom;
    const reason = validateBackfillAuthorizationWindow({
      occurredFrom: input.occurredFrom,
      occurredUntil: input.occurredUntil,
      expiresAt: input.expiresAt,
      watermark,
      reason: input.reason,
      now,
    });

    const [existingAuthorization] = await transaction.select({
      id: repositoryBackfillAuthorizations.id,
    }).from(repositoryBackfillAuthorizations).where(and(
      eq(repositoryBackfillAuthorizations.tenantId, input.tenantId),
      eq(repositoryBackfillAuthorizations.enrollmentId, input.enrollmentId),
      eq(repositoryBackfillAuthorizations.evidenceFamily, input.evidenceFamily),
      eq(repositoryBackfillAuthorizations.status, 'active'),
      gt(repositoryBackfillAuthorizations.expiresAt, now),
    )).limit(1);
    if (existingAuthorization) {
      throw new Error('An active backfill authorization already exists for this evidence family');
    }

    const [authorization] = await transaction.insert(repositoryBackfillAuthorizations).values({
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      evidenceFamily: input.evidenceFamily,
      occurredFrom: input.occurredFrom,
      occurredUntil: input.occurredUntil,
      expiresAt: input.expiresAt,
      authorizedBy: input.actorId,
      reason,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'repository_backfill.authorized',
      targetType: 'repository_backfill_authorization',
      targetId: authorization.id,
      details: {
        enrollmentId: input.enrollmentId,
        evidenceFamily: input.evidenceFamily,
        occurredFrom: input.occurredFrom.toISOString(),
        occurredUntil: input.occurredUntil.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        reason,
      },
    });
    return authorization;
  });
}

export async function grantMachineRepository(input: GrantRepositoryInput) {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const branchPatterns = normalizeRepositoryBranchPatterns(input.branchPatterns ?? []);
  validateInterval(effectiveFrom, input.effectiveUntil);

  return db.transaction(async (transaction) => {
    const [machine] = await transaction.select({ id: developerMachines.id })
      .from(developerMachines).where(and(
        eq(developerMachines.tenantId, input.tenantId),
        eq(developerMachines.id, input.machineId),
        eq(developerMachines.status, 'active'),
      )).limit(1).for('update');
    if (!machine) throw new Error('Active developer machine was not found');

    const [enrollment] = await transaction.select({ id: repositoryEnrollments.id })
      .from(repositoryEnrollments).where(and(
        eq(repositoryEnrollments.tenantId, input.tenantId),
        eq(repositoryEnrollments.id, input.enrollmentId),
        eq(repositoryEnrollments.status, 'active'),
    )).limit(1);
    if (!enrollment) throw new Error('Active repository enrollment was not found');

    const [existingGrant] = await transaction.select({ id: machineRepositoryGrants.id })
      .from(machineRepositoryGrants).where(and(
        eq(machineRepositoryGrants.tenantId, input.tenantId),
        eq(machineRepositoryGrants.machineId, input.machineId),
        eq(machineRepositoryGrants.enrollmentId, input.enrollmentId),
        eq(machineRepositoryGrants.status, 'active'),
        or(
          isNull(machineRepositoryGrants.effectiveUntil),
          gt(machineRepositoryGrants.effectiveUntil, effectiveFrom),
        ),
      )).limit(1);
    if (existingGrant) {
      throw new Error('This machine already has active access to the repository');
    }

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

export async function replaceMachineRepositoryGrantBranchScope(
  input: ReplaceRepositoryGrantBranchScopeInput,
) {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Branch-scope replacement reason is required');
  const branchPatterns = normalizeRepositoryBranchPatterns(input.branchPatterns);

  return db.transaction(async transaction => {
    const [previous] = await transaction.select({
      id: machineRepositoryGrants.id,
      machineId: machineRepositoryGrants.machineId,
      enrollmentId: machineRepositoryGrants.enrollmentId,
      branchPatterns: machineRepositoryGrants.branchPatterns,
    }).from(machineRepositoryGrants).where(and(
      eq(machineRepositoryGrants.tenantId, input.tenantId),
      eq(machineRepositoryGrants.id, input.grantId),
      eq(machineRepositoryGrants.status, 'active'),
    )).limit(1).for('update');
    if (!previous) throw new Error('Active machine repository grant was not found');

    const unchanged = previous.branchPatterns.length === branchPatterns.length
      && previous.branchPatterns.every((pattern, index) => pattern === branchPatterns[index]);
    if (unchanged) throw new Error('Branch scope is unchanged');

    const replacedAt = new Date();
    const [revoked] = await transaction.update(machineRepositoryGrants).set({
      status: 'revoked', revokedAt: replacedAt,
    }).where(and(
      eq(machineRepositoryGrants.tenantId, input.tenantId),
      eq(machineRepositoryGrants.id, previous.id),
      eq(machineRepositoryGrants.status, 'active'),
    )).returning({ id: machineRepositoryGrants.id });
    if (!revoked) throw new Error('Repository grant state changed during branch-scope replacement');

    const [replacement] = await transaction.insert(machineRepositoryGrants).values({
      tenantId: input.tenantId,
      machineId: previous.machineId,
      enrollmentId: previous.enrollmentId,
      branchPatterns,
      effectiveFrom: replacedAt,
      grantedBy: input.actorId,
      reason,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'repository_grant.branch_scope_replaced',
      targetType: 'machine_repository_grant',
      targetId: replacement.id,
      details: {
        previousGrantId: previous.id,
        machineId: previous.machineId,
        enrollmentId: previous.enrollmentId,
        previousBranchPatterns: previous.branchPatterns,
        branchPatterns,
        reason,
      },
    });
    return replacement;
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

export async function revokeRepositoryBackfillAuthorization(
  tenantId: string,
  authorizationId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new Error('Backfill authorization revocation reason is required');
  await db.transaction(async transaction => {
    const revokedAt = new Date();
    const [authorization] = await transaction.update(repositoryBackfillAuthorizations).set({
      status: 'revoked', revokedAt,
    }).where(and(
      eq(repositoryBackfillAuthorizations.tenantId, tenantId),
      eq(repositoryBackfillAuthorizations.id, authorizationId),
      eq(repositoryBackfillAuthorizations.status, 'active'),
    )).returning({
      id: repositoryBackfillAuthorizations.id,
      enrollmentId: repositoryBackfillAuthorizations.enrollmentId,
      evidenceFamily: repositoryBackfillAuthorizations.evidenceFamily,
    });
    if (!authorization) throw new Error('Active backfill authorization was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'repository_backfill.revoked',
      targetType: 'repository_backfill_authorization',
      targetId: authorization.id,
      details: {
        enrollmentId: authorization.enrollmentId,
        evidenceFamily: authorization.evidenceFamily,
        reason: reason.trim(),
      },
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
    const revokedAt = new Date();
    const [enrollment] = await transaction.update(repositoryEnrollments).set({
      status: 'revoked', updatedAt: revokedAt,
    }).where(and(
      eq(repositoryEnrollments.tenantId, tenantId),
      eq(repositoryEnrollments.id, enrollmentId),
      eq(repositoryEnrollments.status, 'active'),
    )).returning({ id: repositoryEnrollments.id, repositoryId: repositoryEnrollments.repositoryId });
    if (!enrollment) throw new Error('Active repository enrollment was not found');
    const revokedGrants = await transaction.update(machineRepositoryGrants).set({
      status: 'revoked', revokedAt,
    }).where(and(
      eq(machineRepositoryGrants.tenantId, tenantId),
      eq(machineRepositoryGrants.enrollmentId, enrollmentId),
      eq(machineRepositoryGrants.status, 'active'),
    )).returning({ id: machineRepositoryGrants.id });
    await transaction.update(repositoryBackfillAuthorizations).set({
      status: 'revoked', revokedAt,
    }).where(and(
      eq(repositoryBackfillAuthorizations.tenantId, tenantId),
      eq(repositoryBackfillAuthorizations.enrollmentId, enrollmentId),
      eq(repositoryBackfillAuthorizations.status, 'active'),
    ));
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'repository.revoked',
      targetType: 'repository_enrollment',
      targetId: enrollment.id,
      details: {
        repositoryId: enrollment.repositoryId,
        reason,
        grantsRevoked: revokedGrants.length,
        backfillAuthorizationsRevoked: true,
      },
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
  return Boolean(await machineRepositoryIngestionPolicy(input));
}

export interface MachineRepositoryIngestionPolicy {
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

export async function machineRepositoryIngestionPolicy(input: {
  tenantId: string;
  machineId: string;
  repositoryId: string;
  branch: string | null;
  now?: Date;
}): Promise<MachineRepositoryIngestionPolicy | null> {
  const now = input.now ?? new Date();
  const rows = await db.select({
    tenantId: machineRepositoryGrants.tenantId,
    machineId: machineRepositoryGrants.machineId,
    repositoryId: repositoryEnrollments.repositoryId,
    status: machineRepositoryGrants.status,
    branchPatterns: machineRepositoryGrants.branchPatterns,
    effectiveFrom: machineRepositoryGrants.effectiveFrom,
    effectiveUntil: machineRepositoryGrants.effectiveUntil,
    enrollmentId: repositoryEnrollments.id,
    generationSessionEvidenceFrom: repositoryEnrollments.generationSessionEvidenceFrom,
    commitNoteEvidenceFrom: repositoryEnrollments.commitNoteEvidenceFrom,
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
  const grant = rows.find((candidate) => repositoryGrantAllows(candidate, { ...input, now }));
  if (!grant) return null;
  const backfillAuthorizations = await db.select({
    id: repositoryBackfillAuthorizations.id,
    evidenceFamily: repositoryBackfillAuthorizations.evidenceFamily,
    occurredFrom: repositoryBackfillAuthorizations.occurredFrom,
    occurredUntil: repositoryBackfillAuthorizations.occurredUntil,
    expiresAt: repositoryBackfillAuthorizations.expiresAt,
  }).from(repositoryBackfillAuthorizations).where(and(
    eq(repositoryBackfillAuthorizations.tenantId, input.tenantId),
    eq(repositoryBackfillAuthorizations.enrollmentId, grant.enrollmentId),
    eq(repositoryBackfillAuthorizations.status, 'active'),
    gt(repositoryBackfillAuthorizations.expiresAt, now),
  ));
  return {
    enrollmentId: grant.enrollmentId,
    generationSessionEvidenceFrom: grant.generationSessionEvidenceFrom,
    commitNoteEvidenceFrom: grant.commitNoteEvidenceFrom,
    backfillAuthorizations: backfillAuthorizations.flatMap((authorization) => (
      authorization.evidenceFamily === 'generation_session'
        || authorization.evidenceFamily === 'commit_note'
        ? [{ ...authorization, evidenceFamily: authorization.evidenceFamily }]
        : []
    )),
  };
}
