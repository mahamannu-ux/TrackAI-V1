import { Router } from 'express';
import { validateSecurityFindingUploadBatch } from './contract';
import {
  persistSecurityFindingBatch,
  type PersistSecurityFindingBatchResult,
} from './storage-service';
import { createSecurityActivationHandler } from './activation';

interface SecurityFindingRouteRequest {
  body: unknown;
  tenantId?: string;
  machineId?: string;
  managedMachineCredential?: boolean;
}

interface SecurityFindingRouteResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(payload: unknown): unknown };
  json(payload: unknown): unknown;
}

interface SecurityFindingRouteDependencies {
  persist(input: {
    tenantId: string;
    machineId: string;
    batch: ReturnType<typeof validateSecurityFindingUploadBatch>;
    receivedAt: Date;
  }): Promise<PersistSecurityFindingBatchResult>;
  logError(message: string): void;
}

const SAFE_STORAGE_ERRORS: Record<
  PersistSecurityFindingBatchResult['errors'][number]['error'],
  string
> = {
  monitor_inactive: 'security_monitoring_not_active',
  repository_grant_inactive: 'repository_not_authorized',
  identity_collision: 'finding_identity_collision',
};

export function createSecurityFindingUploadHandler(
  dependencies: SecurityFindingRouteDependencies = {
    persist: persistSecurityFindingBatch,
    logError: message => console.error(message),
  },
) {
  return async (
    req: SecurityFindingRouteRequest,
    res: SecurityFindingRouteResponse,
  ): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.managedMachineCredential !== true || !req.tenantId || !req.machineId) {
      res.status(403).json({ error: 'Managed machine authentication is required' });
      return;
    }

    let batch;
    try {
      batch = validateSecurityFindingUploadBatch(req.body);
    } catch {
      res.status(400).json({ error: 'Invalid security finding upload' });
      return;
    }

    try {
      const result = await dependencies.persist({
        tenantId: req.tenantId,
        machineId: req.machineId,
        batch,
        receivedAt: new Date(),
      });
      res.status(200).json({
        errors: result.errors.map(error => ({
          index: error.index,
          error: SAFE_STORAGE_ERRORS[error.error],
        })),
      });
    } catch {
      dependencies.logError('Security finding storage failed');
      res.status(503).json({ error: 'Security finding storage is temporarily unavailable' });
    }
  };
}

const securityFindingsRouter = Router();
const uploadSecurityFindings = createSecurityFindingUploadHandler();
const readSecurityActivation = createSecurityActivationHandler();
securityFindingsRouter.get('/activation', (req, res) => readSecurityActivation(req, res));
securityFindingsRouter.post('/findings', (req, res) => uploadSecurityFindings(req, res));

export default securityFindingsRouter;
