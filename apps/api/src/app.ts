import 'dotenv/config';
import cors from 'cors';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import adminRouter from './features/admin/admin.routes';
import { attestaRouter } from './features/attesta/attesta.routes';
import {
  evidenceAdminRouter,
  evidenceReadRouter,
  evidenceWorkerRouter,
} from './features/evidence/evidence.routes';
import scmRouter from './features/scm/scm.routes';
import { fleetAdminRouter, fleetWorkerRouter } from './features/fleet/fleet.routes';
import securityFindingsRouter from './features/security-findings/security-findings.routes';
import { securitySettingsAdminRouter } from './features/security/admin.routes';
import { securityV2ReadAdminRouter } from './features/security-findings/v2-read.routes';
import telemetryIngestRouter from './features/telemetry/ingest.routes';
import telemetryReadRouter from './features/telemetry/read.routes';
import { authenticateJWT } from './core/middleware/auth';
import { authenticateMachine } from './core/middleware/machine-auth';
import { tenantMiddleware } from './core/middleware/tenant';
import { auditRouter } from './features/audit/audit.routes';
import { qaRouter } from './features/qa/qa.routes';

/** Routing is case-insensitive, so the parser skip is too. */
const SECURITY_V2_PATH = /^\/worker\/security\/v2(?:\/|$)/i;

type CreateAppOptions = {
  machineAuthentication?: RequestHandler;
};

export function getAllowedOrigins(): string[] {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').split(',');
}

export const internalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const error = err instanceof Error ? err : new Error('Unknown backend error');
  console.error('❌ Caught Backend Error:', error.message);
  console.error(error.stack);

  // Re-verify the origin header to prevent the browser from masking the error.
  const origin = req.headers.origin;
  if (origin && (process.env.FRONTEND_URL || '').includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.status(500).json({ error: 'Internal Server Error' });
};

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const machineAuthentication = options.machineAuthentication ?? authenticateMachine;

  app.use(cors({
    origin: getAllowedOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-TrackAI-Machine-ID', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Content-Disposition', 'Retry-After'],
  }));

  // Webhooks need their exact bytes for HMAC validation and must be mounted
  // before the global JSON parser. GitHub may send JSON or form-encoded payloads.
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '2mb' }), scmRouter);

  // Parse regular application JSON after the raw webhook receiver. Security v2 is
  // skipped (Task20d decision 3, Task20f D7): its router authenticates the machine,
  // checks its 4 MiB limit and only then parses, so no unauthenticated body is read.
  const jsonParser = express.json({ limit: '5mb' });
  app.use((req, res, next) => (SECURITY_V2_PATH.test(req.path) ? next() : jsonParser(req, res, next)));

  // Native Git AI worker uploads share one tenant-bound machine-auth boundary.
  app.use('/worker', machineAuthentication);
  app.use('/worker/security', securityFindingsRouter);
  app.use('/worker/evidence', evidenceWorkerRouter);
  app.use('/worker/fleet', fleetWorkerRouter);
  app.use('/worker', telemetryIngestRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // All /api/* routes require a valid Supabase JWT and tenant resolution.
  app.use('/api', authenticateJWT, tenantMiddleware);
  app.use('/api/attesta', attestaRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/qa', qaRouter);
  app.use('/api', telemetryReadRouter);
  app.use('/api/evidence', evidenceReadRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin/evidence', evidenceAdminRouter);
  app.use('/api/admin/fleet', fleetAdminRouter);
  app.use('/api/admin/security/v2', securityV2ReadAdminRouter);
  app.use('/api/admin/security', securitySettingsAdminRouter);

  app.use(internalErrorHandler);

  return app;
}
