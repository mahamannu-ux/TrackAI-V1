/**
 * Audit read API routes (Task16c, A16.6): the tenant's audit trail for auditors.
 *
 *   GET /events       filter, keyset-page and read back audit events (audited)
 *   GET /events/:id   one audit event by id (audited)
 *   GET /catalog      the catalog's actions for the console's filters (not audited)
 *
 * Task16e (A16.4, A16.7; docs/contracts/attesta/audit-seal.md, docs/contracts/audit/export.md):
 *   GET  /verify?from&to          the seal verify report (audited: audit.trail.verified)
 *   POST /exports                 202 {id, status, replayed}; idempotent on Idempotency-Key + scope
 *   GET  /exports/:id             the job's status
 *   GET  /exports/:id/content     {export, signature} attachment (audited: audit.export.downloaded)
 *
 * Mounted in app.ts as `/api/audit`, after the Attesta mount, so `/api`'s JWT and
 * tenant middleware run first. The whole router uses requireAdminAction('audit.read')
 * (admins and auditors); services stay thin and the store does the work.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { AUDIT_CATALOG, AUDIT_CATALOG_VERSION } from '../../core/audit/catalog';
import { db } from '../../core/db';
import { requireAdminAction } from '../../core/middleware/admin';
import type { SealDatabase } from '../attesta/audit-seal-service';
import {
  anchorMaterialFromEnv, dbChainVerifier, pgReadStore, publishedKeySource, type VerifyDeps,
} from '../attesta/read-service';
import { pgTrustStore, type TrustDb } from '../attesta/trust-inventory';
import { trustConfigFromEnv } from '../attesta/trust-resolver';
import {
  ExportRequestError, MAX_OPEN_EXPORTS, defaultExportJobDeps, exportDownloadBody, exportStatusBody,
  parseExportIdempotencyKey, parseExportRequest, runAuditExport, type ExportJob, type ExportJobDeps,
} from './export-service';
import { parseAuditVerifyQuery, verifyAuditTrail, type AuditVerifyDeps } from './verify-service';
import {
  auditHttp,
  logFailure,
  defaultLog,
  problemizeAuth,
  requestIdOf,
  sendJson,
  sendProblem,
  type AuditLog,
} from './http';
import {
  AuditQueryError,
  parseAuditId,
  parseAuditListQuery,
  pgAuditStore,
  type AuditReadStore,
  type AuditReaderRole,
} from './read-service';

export interface AuditRouterDeps {
  store?: AuditReadStore;
  authorize?: RequestHandler;
  log?: AuditLog;
  /** Task16e: the verify report's dependencies (default: the database and /api/attesta/verify's). */
  verify?: () => AuditVerifyDeps;
  /** Task16e: the export jobs' dependencies (default: the evidence packs' sink, signer and trust). */
  exports?: () => ExportJobDeps;
  /** Starts a created export job (default: setImmediate → runAuditExport). */
  startExport?: (tenantId: string, exportId: string) => void;
  now?: () => Date;
}

/** A problem a handler answers with directly. */
class AuditProblem extends Error {
  constructor(readonly code: 'AUDIT_EXPORT_NOT_FOUND' | 'AUDIT_EXPORT_CONFLICT' | 'AUDIT_RATE_LIMITED' | 'AUDIT_API_UNAVAILABLE',
    readonly headers: Record<string, string> = {}) {
    super(code);
    this.name = 'AuditProblem';
  }
}

const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function defaultVerifyDeps(): AuditVerifyDeps {
  const now = () => new Date();
  const attesta: VerifyDeps = {
    store: pgReadStore(),
    verifier: dbChainVerifier(),
    keys: publishedKeySource(() => pgTrustStore(db as unknown as TrustDb), () => trustConfigFromEnv(process.env), now),
    anchors: anchorMaterialFromEnv(process.env),
    now,
  };
  return { database: db as unknown as SealDatabase, attesta };
}

function actor(req: Request): { tenantId: string; actorId: string; role: AuditReaderRole } | null {
  const tenantId = req.tenantId;
  const actorId = req.user?.sub;
  const role = req.adminRole;
  if (!tenantId || !actorId || (role !== 'tenant_admin' && role !== 'tenant_auditor')) return null;
  return { tenantId, actorId, role };
}

const query = (req: Request) => req.query as Record<string, unknown>;

function param(req: Request, name: string): unknown {
  return req.params[name];
}

export function createAuditRouter(deps: AuditRouterDeps = {}): Router {
  const store = deps.store ?? pgAuditStore;
  const log = deps.log ?? defaultLog;

  const router = Router();
  router.use(auditHttp);
  router.use(problemizeAuth(deps.authorize ?? requireAdminAction('audit.read')));

  /** Runs a handler with the actor; maps query errors to problems and anything else to 503. */
  const handle = (fn: (req: Request, res: Response, who: NonNullable<ReturnType<typeof actor>>) => Promise<void>): RequestHandler =>
    async (req, res) => {
      const who = actor(req);
      if (!who) {
        sendProblem(res, 'AUDIT_API_FORBIDDEN');
        return;
      }
      try {
        await fn(req, res, who);
      } catch (err) {
        if (err instanceof AuditQueryError) {
          sendProblem(res, err.code);
          return;
        }
        if (err instanceof ExportRequestError) {
          sendProblem(res, 'AUDIT_FILTER_INVALID');
          return;
        }
        if (err instanceof AuditProblem) {
          sendProblem(res, err.code, err.headers);
          return;
        }
        logFailure(log, res, 'AUDIT_API_UNAVAILABLE', err instanceof Error ? err.name : 'unknown');
        if (!res.headersSent) sendProblem(res, 'AUDIT_API_UNAVAILABLE');
      }
    };

  router.get('/events', handle(async (req, res, who) => {
    const { listQuery, limit, cursor, filterHash } = parseAuditListQuery(query(req));
    const { events, nextCursor } = await store.listAndAudit({
      tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role,
      requestId: requestIdOf(res), listQuery, filterHash, limit, cursor,
    });
    sendJson(res, { events, next_cursor: nextCursor, catalog_version: AUDIT_CATALOG_VERSION });
  }));

  router.get('/events/:id', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'unknown parameter');
    const id = parseAuditId(param(req, 'id'));
    // Another tenant's id and an unknown id take the same path: one tenant-bound
    // query that finds nothing, the same 404 body (never a 403 that leaks existence).
    const event = await store.getAndAudit({
      tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role,
      requestId: requestIdOf(res), id,
    });
    if (!event) {
      sendProblem(res, 'AUDIT_EVENT_NOT_FOUND');
      return;
    }
    sendJson(res, { event, catalog_version: AUDIT_CATALOG_VERSION });
  }));

  router.get('/catalog', handle(async (req, res) => {
    if (Object.keys(query(req)).length > 0) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'unknown parameter');
    sendJson(res, {
      catalog_version: AUDIT_CATALOG_VERSION,
      actions: AUDIT_CATALOG.map(entry => ({
        action: entry.action,
        owner: entry.owner,
        severity: entry.severity,
        status: entry.status,
        actor_types: [...entry.actorTypes],
        target_type: entry.targetType,
      })),
    });
  }));

  // --- Task16e: the seal verify report and the signed export

  let verifyDeps: AuditVerifyDeps | null = null;
  router.get('/verify', handle(async (req, res, who) => {
    const q = parseAuditVerifyQuery(query(req));
    verifyDeps ??= (deps.verify ?? defaultVerifyDeps)();
    const report = await verifyAuditTrail(verifyDeps, {
      tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, requestId: requestIdOf(res), query: q,
    });
    sendJson(res, report);
  }));

  let exportDeps: ExportJobDeps | null = null;
  const exportsOf = (): ExportJobDeps => (exportDeps ??= (deps.exports ?? (() => defaultExportJobDeps(process.env)))());
  const now = deps.now ?? (() => new Date());
  const startExport = deps.startExport ?? ((tenantId: string, exportId: string) => {
    setImmediate(() => {
      runAuditExport({ ...exportsOf(), log }, tenantId, exportId).catch((err: unknown) => {
        log(`audit-export AUDIT_EXPORT_INTERNAL export_id=${exportId} cause=${err instanceof Error ? err.name : 'unknown'}`);
      });
    });
  });
  const exportIdOf = (req: Request): string => {
    const id = param(req, 'id');
    // A malformed id answers like an unknown one (no existence leak).
    if (typeof id !== 'string' || !EXPORT_ID_RE.test(id)) throw new AuditProblem('AUDIT_EXPORT_NOT_FOUND');
    return id;
  };
  const scopeDetails = (job: ExportJob) => {
    const scope = job.scope as { from?: string; to?: string };
    return { scope_from: String(scope.from), scope_to: String(scope.to) };
  };

  router.post('/exports', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'unknown parameter');
    const key = parseExportIdempotencyKey(req.get('Idempotency-Key'));
    const scope = parseExportRequest(req.body, now());
    const store = exportsOf().store;
    const answer = (job: ExportJob, replayed: boolean) => {
      res.setHeader('Location', `${req.baseUrl}/exports/${job.id}`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(202).json({ id: job.id, status: job.status, replayed });
    };
    const audit = (job: ExportJob, replayed: boolean) => store.audit({
      tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'audit.export.requested', exportId: job.id,
      details: { ...scopeDetails(job), replayed, request_id: requestIdOf(res) },
    });
    const replay = async (job: ExportJob) => {
      const stored = job.scope as { from?: unknown; to?: unknown };
      if (stored.from !== scope.from || stored.to !== scope.to) throw new AuditProblem('AUDIT_EXPORT_CONFLICT');
      await audit(job, true);
      answer(job, true);
    };
    const existing = await store.findByKey(who.tenantId, key);
    if (existing) return replay(existing);
    if (await store.openCount(who.tenantId) >= MAX_OPEN_EXPORTS) throw new AuditProblem('AUDIT_RATE_LIMITED', { 'Retry-After': '30' });
    const { job, created } = await store.createOrGet({
      tenantId: who.tenantId, idempotencyKey: key, scope, requestedBy: who.actorId, requestId: requestIdOf(res),
    });
    if (!created) return replay(job);
    // Started even when the audit write fails, so a created job is never stranded (the packs' rule).
    startExport(who.tenantId, job.id);
    await audit(job, false);
    answer(job, false);
  }));

  router.get('/exports/:id', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'unknown parameter');
    // Another tenant's id and an unknown id take the same path (one tenant-bound query, the same 404).
    const job = await exportsOf().store.get(who.tenantId, exportIdOf(req));
    if (!job) throw new AuditProblem('AUDIT_EXPORT_NOT_FOUND');
    sendJson(res, exportStatusBody(job, `${req.baseUrl}/exports`));
  }));

  router.get('/exports/:id/content', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'unknown parameter');
    const x = exportsOf();
    const job = await x.store.get(who.tenantId, exportIdOf(req));
    if (!job || job.status !== 'ready' || !job.storageReference) throw new AuditProblem('AUDIT_EXPORT_NOT_FOUND');
    const sink = x.sink();
    if (!sink) throw new AuditProblem('AUDIT_API_UNAVAILABLE');
    // A missing, unreadable or altered file is never downloaded (exportDownloadBody checks the digest).
    const body = exportDownloadBody(job, await sink.read(job.storageReference));
    await x.store.audit({
      tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'audit.export.downloaded', exportId: job.id,
      details: { ...scopeDetails(job), export_digest: job.exportDigest, counts: job.counts, request_id: requestIdOf(res) },
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="trackai-audit-export-${job.id}.json"`);
    res.status(200).type('application/json').send(body);
  }));

  return router;
}

export const auditRouter = createAuditRouter();
