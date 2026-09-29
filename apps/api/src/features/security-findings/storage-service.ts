import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { db } from '../../core/db';
import * as schema from '../../core/db/schema';
import {
  developerMachines,
  machineRepositoryGrants,
  repositoryEnrollments,
  securityFindings,
  tenantSecurityMonitorSettings,
} from '../../core/db/schema';
import { repositoryGrantAllows as grantAllows } from '../../core/security/repository-grant';
import type {
  CanonicalSecurityFinding,
  SecurityFindingUploadBatch,
  SecurityMonitorAuthorization,
} from './contract';

export interface SecurityFindingStorageTransaction {
  loadAuthorization(tenantId: string): Promise<SecurityMonitorAuthorization | null>;
  repositoryGrantAllows(input: {
    tenantId: string;
    machineId: string;
    repositoryId: string;
    receivedAt: Date;
  }): Promise<boolean>;
  findExisting(input: {
    tenantId: string;
    findingId: string;
    deliveryId: string;
  }): Promise<CanonicalSecurityFinding[]>;
  insertIfAbsent(finding: CanonicalSecurityFinding, receivedAt: Date): Promise<boolean>;
}

export type SecurityFindingTransactionRunner = <T>(
  callback: (transaction: SecurityFindingStorageTransaction) => Promise<T>,
) => Promise<T>;

export interface PersistSecurityFindingBatchResult {
  acknowledged: Array<{
    index: number;
    findingId: string;
    deliveryId: string;
    outcome: 'stored' | 'replayed';
  }>;
  errors: Array<{
    index: number;
    error: 'monitor_inactive' | 'repository_grant_inactive' | 'identity_collision';
  }>;
}

function authorizationIsActive(
  authorization: SecurityMonitorAuthorization | null,
  now: Date,
): boolean {
  return authorization?.mode === 'monitor'
    && authorization.revokedAt === null
    && (authorization.validUntil === null || authorization.validUntil.getTime() > now.getTime());
}

function canonicalFindingMatches(
  existing: CanonicalSecurityFinding,
  candidate: CanonicalSecurityFinding,
): boolean {
  return existing.schemaVersion === candidate.schemaVersion
    && existing.tenantId === candidate.tenantId
    && existing.machineId === candidate.machineId
    && existing.repositoryId === candidate.repositoryId
    && existing.findingId === candidate.findingId
    && existing.deliveryId === candidate.deliveryId
    && existing.sessionId === candidate.sessionId
    && existing.sourceEventId === candidate.sourceEventId
    && existing.correlationId === candidate.correlationId
    && existing.rule.id === candidate.rule.id
    && existing.rule.version === candidate.rule.version
    && existing.rule.category === candidate.rule.category
    && existing.rule.severity === candidate.rule.severity
    && existing.capability.routeId === candidate.capability.routeId
    && existing.capability.agentFamily === candidate.capability.agentFamily
    && existing.capability.hostSurface === candidate.capability.hostSurface
    && existing.capability.hostMode === candidate.capability.hostMode
    && existing.capability.captureChannel === candidate.capability.captureChannel
    && existing.capability.operatingSystem === candidate.capability.operatingSystem
    && existing.capability.timing === candidate.capability.timing
    && existing.capability.nativeEffect === candidate.capability.nativeEffect
    && existing.capability.activation === candidate.capability.activation
    && existing.effect === candidate.effect
    && existing.phase === candidate.phase
    && existing.availability === candidate.availability
    && existing.completeness === candidate.completeness
    && existing.resultCategory === candidate.resultCategory
    && new Date(existing.occurredAt).getTime() === new Date(candidate.occurredAt).getTime()
    && existing.clientVersion === candidate.clientVersion
    && existing.rulePackVersion === candidate.rulePackVersion;
}

function replayOutcome(
  existing: CanonicalSecurityFinding[],
  candidate: CanonicalSecurityFinding,
): 'replayed' | 'identity_collision' | null {
  if (existing.length === 0) return null;
  return existing.length === 1 && canonicalFindingMatches(existing[0], candidate)
    ? 'replayed'
    : 'identity_collision';
}

export async function persistSecurityFindingBatchWithStore(input: {
  tenantId: string;
  machineId: string;
  batch: SecurityFindingUploadBatch;
  receivedAt: Date;
}, runTransaction: SecurityFindingTransactionRunner): Promise<PersistSecurityFindingBatchResult> {
  const acknowledged: PersistSecurityFindingBatchResult['acknowledged'] = [];
  const errors: PersistSecurityFindingBatchResult['errors'] = [];

  for (const [index, finding] of input.batch.findings.entries()) {
    const candidate: CanonicalSecurityFinding = {
      ...finding,
      schemaVersion: 'trackai.security-finding/0.1',
      tenantId: input.tenantId,
      machineId: input.machineId,
    };
    const outcome = await runTransaction(async transaction => {
      const authorization = await transaction.loadAuthorization(input.tenantId);
      if (!authorizationIsActive(authorization, input.receivedAt)) return 'monitor_inactive' as const;
      if (!await transaction.repositoryGrantAllows({
        tenantId: input.tenantId,
        machineId: input.machineId,
        repositoryId: finding.repositoryId,
        receivedAt: input.receivedAt,
      })) return 'repository_grant_inactive' as const;

      const identity = {
        tenantId: input.tenantId,
        findingId: finding.findingId,
        deliveryId: finding.deliveryId,
      };
      const beforeInsert = replayOutcome(await transaction.findExisting(identity), candidate);
      if (beforeInsert) return beforeInsert;
      if (await transaction.insertIfAbsent(candidate, input.receivedAt)) return 'stored' as const;
      return replayOutcome(await transaction.findExisting(identity), candidate)
        ?? 'identity_collision' as const;
    });

    if (outcome === 'stored' || outcome === 'replayed') {
      acknowledged.push({
        index,
        findingId: finding.findingId,
        deliveryId: finding.deliveryId,
        outcome,
      });
    } else {
      errors.push({ index, error: outcome });
    }
  }
  return { acknowledged, errors };
}

type StorageDbTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

function rowToCanonicalFinding(
  row: typeof securityFindings.$inferSelect,
): CanonicalSecurityFinding {
  return {
    schemaVersion: 'trackai.security-finding/0.1',
    tenantId: row.tenantId,
    machineId: row.machineId,
    repositoryId: row.repositoryId,
    findingId: row.findingId,
    deliveryId: row.deliveryId,
    sessionId: row.sessionId,
    sourceEventId: row.sourceEventId,
    correlationId: row.correlationId ?? undefined,
    rule: {
      id: row.ruleId as CanonicalSecurityFinding['rule']['id'],
      version: row.ruleVersion,
      category: 'execution',
      severity: row.ruleSeverity as CanonicalSecurityFinding['rule']['severity'],
    },
    capability: {
      routeId: 'AC-CLI-03',
      agentFamily: 'opencode',
      hostSurface: 'terminal',
      hostMode: 'cli',
      captureChannel: 'provider-plugin',
      operatingSystem: row.operatingSystem as CanonicalSecurityFinding['capability']['operatingSystem'],
      timing: row.timing as CanonicalSecurityFinding['capability']['timing'],
      nativeEffect: 'observe_only',
      activation: row.activation as CanonicalSecurityFinding['capability']['activation'],
    },
    effect: 'monitor',
    phase: row.phase as CanonicalSecurityFinding['phase'],
    availability: row.availability as CanonicalSecurityFinding['availability'],
    completeness: row.completeness as CanonicalSecurityFinding['completeness'],
    resultCategory: row.resultCategory as CanonicalSecurityFinding['resultCategory'],
    occurredAt: row.occurredAt.toISOString(),
    clientVersion: row.clientVersion,
    rulePackVersion: row.rulePackVersion,
  };
}

function databaseStorageTransaction(
  transaction: StorageDbTransaction,
): SecurityFindingStorageTransaction {
  return {
    async loadAuthorization(tenantId) {
      const [setting] = await transaction.select({
        mode: tenantSecurityMonitorSettings.mode,
        validUntil: tenantSecurityMonitorSettings.validUntil,
        revokedAt: tenantSecurityMonitorSettings.revokedAt,
      }).from(tenantSecurityMonitorSettings).where(
        eq(tenantSecurityMonitorSettings.tenantId, tenantId),
      ).limit(1);
      return setting ?? null;
    },
    async repositoryGrantAllows(input) {
      const rows = await transaction.select({
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
        lte(repositoryEnrollments.effectiveFrom, input.receivedAt),
        or(
          isNull(repositoryEnrollments.effectiveUntil),
          gt(repositoryEnrollments.effectiveUntil, input.receivedAt),
        ),
        eq(machineRepositoryGrants.status, 'active'),
        lte(machineRepositoryGrants.effectiveFrom, input.receivedAt),
        or(
          isNull(machineRepositoryGrants.effectiveUntil),
          gt(machineRepositoryGrants.effectiveUntil, input.receivedAt),
        ),
      ));
      return rows.some(grant => grantAllows(grant, {
        tenantId: input.tenantId,
        machineId: input.machineId,
        repositoryId: input.repositoryId,
        branch: null,
        now: input.receivedAt,
      }));
    },
    async findExisting(input) {
      const rows = await transaction.select().from(securityFindings).where(and(
        eq(securityFindings.tenantId, input.tenantId),
        or(
          eq(securityFindings.findingId, input.findingId),
          eq(securityFindings.deliveryId, input.deliveryId),
        ),
      ));
      return rows.map(rowToCanonicalFinding);
    },
    async insertIfAbsent(finding, receivedAt) {
      const [inserted] = await transaction.insert(securityFindings).values({
        tenantId: finding.tenantId,
        machineId: finding.machineId,
        repositoryId: finding.repositoryId,
        findingId: finding.findingId,
        deliveryId: finding.deliveryId,
        sessionId: finding.sessionId,
        sourceEventId: finding.sourceEventId,
        correlationId: finding.correlationId,
        ruleId: finding.rule.id,
        ruleVersion: finding.rule.version,
        ruleCategory: finding.rule.category,
        ruleSeverity: finding.rule.severity,
        routeId: finding.capability.routeId,
        agentFamily: finding.capability.agentFamily,
        hostSurface: finding.capability.hostSurface,
        hostMode: finding.capability.hostMode,
        captureChannel: finding.capability.captureChannel,
        operatingSystem: finding.capability.operatingSystem,
        timing: finding.capability.timing,
        nativeEffect: finding.capability.nativeEffect,
        activation: finding.capability.activation,
        effect: finding.effect,
        phase: finding.phase,
        availability: finding.availability,
        completeness: finding.completeness,
        resultCategory: finding.resultCategory,
        occurredAt: new Date(finding.occurredAt),
        clientVersion: finding.clientVersion,
        rulePackVersion: finding.rulePackVersion,
        receivedAt,
      }).onConflictDoNothing().returning({ id: securityFindings.id });
      return Boolean(inserted);
    },
  };
}

export async function persistSecurityFindingBatch(input: {
  tenantId: string;
  machineId: string;
  batch: SecurityFindingUploadBatch;
  receivedAt?: Date;
}): Promise<PersistSecurityFindingBatchResult> {
  const receivedAt = input.receivedAt ?? new Date();
  return persistSecurityFindingBatchWithStore(
    { ...input, receivedAt },
    callback => db.transaction(transaction => callback(databaseStorageTransaction(transaction))),
  );
}
