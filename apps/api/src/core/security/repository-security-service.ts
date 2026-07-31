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
import { branchPatternIsValid, repositoryGrantAllows } from './repository-grant';

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

const MAX_BACKFILL_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_BACKFILL_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

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
  if (!input.reason.trim()) throw new Error('Backfill authorization reason is required');
  if (input.occurredUntil.getTime() < input.occurredFrom.getTime()) {
    throw new Error('Backfill occurredUntil must not precede occurredFrom');
  }
  if (input.occurredUntil.getTime() - input.occurredFrom.getTime() > MAX_BACKFILL_WINDOW_MS) {
    throw new Error('Backfill window cannot exceed 31 days');
  }
  if (input.expiresAt.getTime() <= now.getTime()
    || input.expiresAt.getTime() - now.getTime() > MAX_BACKFILL_AUTHORIZATION_TTL_MS) {
    throw new Error('Backfill authorization must expire within 24 hours');
  }

  return db.transaction(async (transaction) => {
    const [enrollment] = await transaction.select({
      id: repositoryEnrollments.id,
      generationSessionEvidenceFrom: repositoryEnrollments.generationSessionEvidenceFrom,
      commitNoteEvidenceFrom: repositoryEnrollments.commitNoteEvidenceFrom,
    }).from(repositoryEnrollments).where(and(
      eq(repositoryEnrollments.tenantId, input.tenantId),
      eq(repositoryEnrollments.id, input.enrollmentId),
      eq(repositoryEnrollments.status, 'active'),
    )).limit(1);
    if (!enrollment) throw new Error('Active repository enrollment was not found');
    const watermark = input.evidenceFamily === 'generation_session'
      ? enrollment.generationSessionEvidenceFrom
      : enrollment.commitNoteEvidenceFrom;
    if (input.occurredUntil.getTime() >= watermark.getTime()) {
      throw new Error('Backfill window must end before its enrollment watermark');
    }

    const [authorization] = await transaction.insert(repositoryBackfillAuthorizations).values({
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
      evidenceFamily: input.evidenceFamily,
      occurredFrom: input.occurredFrom,
      occurredUntil: input.occurredUntil,
      expiresAt: input.expiresAt,
      authorizedBy: input.actorId,
      reason: input.reason.trim(),
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
        reason: input.reason.trim(),
      },
    });
    return authorization;
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
    const revokedAt = new Date();
    const [enrollment] = await transaction.update(repositoryEnrollments).set({
      status: 'revoked', updatedAt: revokedAt,
    }).where(and(
      eq(repositoryEnrollments.tenantId, tenantId),
      eq(repositoryEnrollments.id, enrollmentId),
      eq(repositoryEnrollments.status, 'active'),
    )).returning({ id: repositoryEnrollments.id, repositoryId: repositoryEnrollments.repositoryId });
    if (!enrollment) throw new Error('Active repository enrollment was not found');
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
