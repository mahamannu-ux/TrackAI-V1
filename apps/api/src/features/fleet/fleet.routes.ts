import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAdminAction } from '../../core/middleware/admin';
import {
  parseCreateFleetConfiguration,
  parseFleetAssignment,
  parseFleetOffboard,
  parseFleetReport,
} from './contract';
import {
  applyFleetOffboard,
  assignFleetConfiguration,
  createFleetConfiguration,
  FleetServiceError,
  getFleetConfiguration,
  listFleetMachines,
  previewFleetOffboard,
  recordFleetReport,
} from './service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FleetDependencies {
  getConfiguration: typeof getFleetConfiguration;
  recordReport: typeof recordFleetReport;
  listMachines: typeof listFleetMachines;
  createConfiguration: typeof createFleetConfiguration;
  assignConfiguration: typeof assignFleetConfiguration;
  previewOffboard: typeof previewFleetOffboard;
  applyOffboard: typeof applyFleetOffboard;
  now(): Date;
  logError(message: string): void;
}

const defaultDependencies: FleetDependencies = {
  getConfiguration: getFleetConfiguration,
  recordReport: recordFleetReport,
  listMachines: listFleetMachines,
  createConfiguration: createFleetConfiguration,
  assignConfiguration: assignFleetConfiguration,
  previewOffboard: previewFleetOffboard,
  applyOffboard: applyFleetOffboard,
  now: () => new Date(),
  logError: message => console.error(message),
};

function managedIdentity(req: Request, res: Response): { tenantId: string; machineId: string } | null {
  if (req.managedMachineCredential !== true || !req.tenantId || !req.machineId) {
    res.status(403).json({ error: 'managed_machine_required' });
    return null;
  }
  return { tenantId: req.tenantId, machineId: req.machineId };
}

function adminIdentity(req: Request, res: Response): { tenantId: string; actorId: string } | null {
  if (!req.tenantId || !req.user?.sub) {
    res.status(401).json({ error: 'authentication_required' });
    return null;
  }
  return { tenantId: req.tenantId, actorId: req.user.sub };
}

function machineId(value: string): string {
  if (!UUID.test(value)) throw new Error('invalid machine id');
  return value;
}

function safeError(res: Response, error: unknown, logError: (message: string) => void): void {
  if (error instanceof FleetServiceError) {
    res.status(error.status).json({ error: error.category });
    return;
  }
  logError('Fleet operation failed');
  res.status(503).json({ error: 'fleet_unavailable' });
}

function invalidRequest(res: Response): void {
  res.status(400).json({ error: 'invalid_request' });
}

export function createFleetWorkerRouter(
  dependencies: FleetDependencies = defaultDependencies,
): Router {
  const router = Router();
  router.get('/configuration', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = managedIdentity(req, res);
    if (!identity) return;
    try {
      const configuration = await dependencies.getConfiguration(
        identity.tenantId,
        identity.machineId,
      );
      if (!configuration) {
        res.status(204).send();
        return;
      }
      res.status(200).json(configuration);
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  router.post('/report', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = managedIdentity(req, res);
    if (!identity) return;
    let report;
    try {
      report = parseFleetReport(req.body, dependencies.now());
    } catch {
      invalidRequest(res);
      return;
    }
    try {
      await dependencies.recordReport({ ...identity, report });
      res.status(200).json({ ok: true });
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  return router;
}

export function createFleetAdminRouter(
  dependencies: FleetDependencies = defaultDependencies,
  authorize: RequestHandler = requireAdminAction('machine.manage'),
): Router {
  const router = Router();
  router.use(authorize);
  router.get('/machines', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = adminIdentity(req, res);
    if (!identity) return;
    try {
      res.status(200).json(await dependencies.listMachines(identity.tenantId, dependencies.now()));
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  router.post('/configurations', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = adminIdentity(req, res);
    if (!identity) return;
    let configuration;
    try {
      configuration = parseCreateFleetConfiguration(req.body, dependencies.now());
    } catch {
      invalidRequest(res);
      return;
    }
    try {
      res.status(201).json({ configuration: await dependencies.createConfiguration({
        ...identity,
        configuration,
      }) });
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  router.post('/assignments', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = adminIdentity(req, res);
    if (!identity) return;
    let assignment;
    try {
      assignment = parseFleetAssignment(req.body);
    } catch {
      invalidRequest(res);
      return;
    }
    try {
      await dependencies.assignConfiguration({
        ...identity,
        assignment,
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  router.post('/machines/:id/offboard/preview', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = adminIdentity(req, res);
    if (!identity) return;
    let parsedMachineId;
    try {
      parsedMachineId = machineId(req.params.id);
    } catch {
      invalidRequest(res);
      return;
    }
    try {
      res.status(200).json(await dependencies.previewOffboard(
        identity.tenantId,
        parsedMachineId,
      ));
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  router.post('/machines/:id/offboard', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const identity = adminIdentity(req, res);
    if (!identity) return;
    let offboard;
    let parsedMachineId;
    try {
      offboard = parseFleetOffboard(req.body);
      parsedMachineId = machineId(req.params.id);
    } catch {
      invalidRequest(res);
      return;
    }
    try {
      res.status(200).json(await dependencies.applyOffboard({
        ...identity,
        machineId: parsedMachineId,
        reason: offboard.reason,
      }));
    } catch (error) {
      safeError(res, error, dependencies.logError);
    }
  });
  return router;
}

export const fleetWorkerRouter = createFleetWorkerRouter();
export const fleetAdminRouter = createFleetAdminRouter();
