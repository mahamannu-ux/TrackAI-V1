import { desc, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { securityAuditEvents, securityFindings } from '../../core/db/schema';

export type SecurityFindingReaderRole = 'tenant_admin' | 'tenant_auditor';

export interface SecurityFindingReadInput {
  tenantId: string;
  actorId: string;
  actorRole: SecurityFindingReaderRole;
  limit: number;
}

export interface SecurityFindingReadStore {
  readAndAudit(input: SecurityFindingReadInput): Promise<Array<Record<string, unknown>>>;
}

const SAFE_FINDING_FIELDS = [
  'id', 'machineId', 'repositoryId', 'findingId', 'deliveryId', 'sessionId',
  'sourceEventId', 'correlationId', 'ruleId', 'ruleVersion', 'ruleCategory',
  'ruleSeverity', 'routeId', 'agentFamily', 'hostSurface', 'hostMode',
  'captureChannel', 'operatingSystem', 'timing', 'nativeEffect', 'activation',
  'effect', 'phase', 'availability', 'completeness', 'resultCategory',
  'occurredAt', 'clientVersion', 'rulePackVersion', 'receivedAt',
] as const;

function safeFindingRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of SAFE_FINDING_FIELDS) {
    if (input[field] !== undefined) output[field] = input[field];
  }
  return output;
}

const databaseStore: SecurityFindingReadStore = {
  async readAndAudit(input) {
    return db.transaction(async transaction => {
      const findings = await transaction.select({
        id: securityFindings.id,
        machineId: securityFindings.machineId,
        repositoryId: securityFindings.repositoryId,
        findingId: securityFindings.findingId,
        deliveryId: securityFindings.deliveryId,
        sessionId: securityFindings.sessionId,
        sourceEventId: securityFindings.sourceEventId,
        correlationId: securityFindings.correlationId,
        ruleId: securityFindings.ruleId,
        ruleVersion: securityFindings.ruleVersion,
        ruleCategory: securityFindings.ruleCategory,
        ruleSeverity: securityFindings.ruleSeverity,
        routeId: securityFindings.routeId,
        agentFamily: securityFindings.agentFamily,
        hostSurface: securityFindings.hostSurface,
        hostMode: securityFindings.hostMode,
        captureChannel: securityFindings.captureChannel,
        operatingSystem: securityFindings.operatingSystem,
        timing: securityFindings.timing,
        nativeEffect: securityFindings.nativeEffect,
        activation: securityFindings.activation,
        effect: securityFindings.effect,
        phase: securityFindings.phase,
        availability: securityFindings.availability,
        completeness: securityFindings.completeness,
        resultCategory: securityFindings.resultCategory,
        occurredAt: securityFindings.occurredAt,
        clientVersion: securityFindings.clientVersion,
        rulePackVersion: securityFindings.rulePackVersion,
        receivedAt: securityFindings.receivedAt,
      }).from(securityFindings)
        .where(eq(securityFindings.tenantId, input.tenantId))
        .orderBy(desc(securityFindings.occurredAt), desc(securityFindings.id))
        .limit(input.limit);
      await transaction.insert(securityAuditEvents).values({
        tenantId: input.tenantId,
        actorType: input.actorRole,
        actorId: input.actorId,
        action: 'security_findings.read',
        targetType: 'security_findings',
        targetId: input.tenantId,
        details: { limit: input.limit, returned: findings.length },
      });
      return findings;
    });
  },
};

export async function readSecurityFindingsWithStore(
  input: SecurityFindingReadInput,
  store: SecurityFindingReadStore = databaseStore,
): Promise<Array<Record<string, unknown>>> {
  const boundedInput = {
    ...input,
    limit: Math.min(200, Math.max(1, Math.trunc(input.limit))),
  };
  const findings = await store.readAndAudit(boundedInput);
  return findings.map(safeFindingRecord);
}

interface AdminReadRequest {
  tenantId?: string;
  user?: { sub?: string };
  adminRole?: SecurityFindingReaderRole;
  query?: Record<string, unknown>;
}

interface AdminReadResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(payload: unknown): unknown };
  json(payload: unknown): unknown;
}

interface AdminReadDependencies {
  read(input: SecurityFindingReadInput): Promise<Array<Record<string, unknown>>>;
  logError(message: string): void;
}

export function createSecurityFindingAdminReadHandler(
  dependencies: AdminReadDependencies = {
    read: readSecurityFindingsWithStore,
    logError: message => console.error(message),
  },
) {
  return async (req: AdminReadRequest, res: AdminReadResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const actorId = req.user?.sub;
    if (!req.tenantId || !actorId || !req.adminRole) {
      res.status(403).json({ error: 'Administrator or auditor access is required' });
      return;
    }
    const requestedLimit = typeof req.query?.limit === 'string'
      ? Number(req.query.limit)
      : 100;
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    try {
      const findings = await dependencies.read({
        tenantId: req.tenantId,
        actorId,
        actorRole: req.adminRole,
        limit,
      });
      res.status(200).json({ findings: findings.map(safeFindingRecord) });
    } catch {
      dependencies.logError('Security finding read failed');
      res.status(503).json({ error: 'Security findings are temporarily unavailable' });
    }
  };
}
