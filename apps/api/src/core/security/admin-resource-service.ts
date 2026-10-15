import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { AUDIT_CATALOG_BY_ACTION, AUDIT_CATALOG_VERSION } from '../audit/catalog';
import { recordAuditEvent } from '../audit/record';
import {
  developerMachines,
  machineCredentials,
  machineRepositoryGrants,
  repositoryBackfillAuthorizations,
  repositoryEnrollments,
  scmRepositories,
  securityAuditEvents,
} from '../db/schema';

/** Returns lifecycle metadata only; machine secret hashes never leave storage. */
export async function listAdminMachines(tenantId: string) {
  const [machines, credentials] = await Promise.all([
    db.select({
      id: developerMachines.id,
      installationId: developerMachines.installationId,
      displayName: developerMachines.displayName,
      platform: developerMachines.platform,
      status: developerMachines.status,
      lastSeenAt: developerMachines.lastSeenAt,
      revokedAt: developerMachines.revokedAt,
      createdAt: developerMachines.createdAt,
      updatedAt: developerMachines.updatedAt,
    }).from(developerMachines).where(eq(developerMachines.tenantId, tenantId))
      .orderBy(desc(developerMachines.createdAt)),
    db.select({
      id: machineCredentials.id,
      machineId: machineCredentials.machineId,
      keyId: machineCredentials.keyId,
      status: machineCredentials.status,
      rotatedFromCredentialId: machineCredentials.rotatedFromCredentialId,
      issuedAt: machineCredentials.issuedAt,
      expiresAt: machineCredentials.expiresAt,
      lastUsedAt: machineCredentials.lastUsedAt,
      revokedAt: machineCredentials.revokedAt,
    }).from(machineCredentials).where(eq(machineCredentials.tenantId, tenantId))
      .orderBy(desc(machineCredentials.issuedAt)),
  ]);
  return { machines, credentials };
}

export async function listAdminRepositoryPolicies(tenantId: string) {
  const [repositories, enrollments, grants] = await Promise.all([
    db.select({
      id: scmRepositories.id,
      provider: scmRepositories.provider,
      externalId: scmRepositories.externalId,
      name: scmRepositories.name,
      url: scmRepositories.url,
      normalizedUrl: scmRepositories.normalizedUrl,
      createdAt: scmRepositories.createdAt,
    }).from(scmRepositories).where(eq(scmRepositories.tenantId, tenantId))
      .orderBy(scmRepositories.name),
    db.select({
      id: repositoryEnrollments.id,
      repositoryId: repositoryEnrollments.repositoryId,
      status: repositoryEnrollments.status,
      effectiveFrom: repositoryEnrollments.effectiveFrom,
      generationSessionEvidenceFrom: repositoryEnrollments.generationSessionEvidenceFrom,
      commitNoteEvidenceFrom: repositoryEnrollments.commitNoteEvidenceFrom,
      effectiveUntil: repositoryEnrollments.effectiveUntil,
      reason: repositoryEnrollments.reason,
      createdAt: repositoryEnrollments.createdAt,
      updatedAt: repositoryEnrollments.updatedAt,
    }).from(repositoryEnrollments).where(eq(repositoryEnrollments.tenantId, tenantId))
      .orderBy(desc(repositoryEnrollments.createdAt)),
    db.select({
      id: machineRepositoryGrants.id,
      machineId: machineRepositoryGrants.machineId,
      enrollmentId: machineRepositoryGrants.enrollmentId,
      branchPatterns: machineRepositoryGrants.branchPatterns,
      status: machineRepositoryGrants.status,
      effectiveFrom: machineRepositoryGrants.effectiveFrom,
      effectiveUntil: machineRepositoryGrants.effectiveUntil,
      reason: machineRepositoryGrants.reason,
      revokedAt: machineRepositoryGrants.revokedAt,
      createdAt: machineRepositoryGrants.createdAt,
    }).from(machineRepositoryGrants).where(eq(machineRepositoryGrants.tenantId, tenantId))
      .orderBy(desc(machineRepositoryGrants.createdAt)),
  ]);
  return { repositories, enrollments, grants };
}

export async function listAdminBackfillAuthorizations(tenantId: string) {
  return db.select({
    id: repositoryBackfillAuthorizations.id,
    enrollmentId: repositoryBackfillAuthorizations.enrollmentId,
    evidenceFamily: repositoryBackfillAuthorizations.evidenceFamily,
    occurredFrom: repositoryBackfillAuthorizations.occurredFrom,
    occurredUntil: repositoryBackfillAuthorizations.occurredUntil,
    expiresAt: repositoryBackfillAuthorizations.expiresAt,
    status: repositoryBackfillAuthorizations.status,
    authorizedBy: repositoryBackfillAuthorizations.authorizedBy,
    reason: repositoryBackfillAuthorizations.reason,
    revokedAt: repositoryBackfillAuthorizations.revokedAt,
    createdAt: repositoryBackfillAuthorizations.createdAt,
  }).from(repositoryBackfillAuthorizations)
    .where(eq(repositoryBackfillAuthorizations.tenantId, tenantId))
    .orderBy(desc(repositoryBackfillAuthorizations.createdAt));
}

/**
 * The legacy admin audit list (Task16c, A16.6 item 11): its path, query and
 * camelCase shape stay, each row gains `severity` and `catalogVersion`, and the
 * call writes one `audit.events.read` event in the same transaction it reads in
 * (select first, so the read's own event is never in its own result; a failed
 * audit write fails the call with no rows).
 */
export async function listSecurityAuditEvents(input: {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  requestedLimit: number;
}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(input.requestedLimit)));
  return db.transaction(async transaction => {
    const rows = await transaction.select({
      id: securityAuditEvents.id,
      actorType: securityAuditEvents.actorType,
      actorId: securityAuditEvents.actorId,
      action: securityAuditEvents.action,
      targetType: securityAuditEvents.targetType,
      targetId: securityAuditEvents.targetId,
      details: securityAuditEvents.details,
      occurredAt: securityAuditEvents.occurredAt,
    }).from(securityAuditEvents).where(eq(securityAuditEvents.tenantId, input.tenantId))
      .orderBy(desc(securityAuditEvents.occurredAt)).limit(limit);
    const events = rows.map(row => ({
      ...row,
      severity: AUDIT_CATALOG_BY_ACTION.get(row.action)?.severity ?? 'high',
      catalogVersion: AUDIT_CATALOG_VERSION,
    }));
    await recordAuditEvent(transaction, input.tenantId, {
      action: 'audit.events.read',
      actorType: input.actorRole,
      actorId: input.actorId,
      targetType: 'security_audit_events',
      targetId: input.tenantId,
      details: { limit, returned: events.length, filters: ['limit'] },
    });
    return events;
  });
}
