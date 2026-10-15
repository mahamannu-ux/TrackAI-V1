/**
 * Audit read API routes (Task16c, A16.6): the tenant's audit trail for auditors.
 *
 *   GET /events       filter, keyset-page and read back audit events (audited)
 *   GET /events/:id   one audit event by id (audited)
 *   GET /catalog      the catalog's actions for the console's filters (not audited)
 *
 * Mounted in app.ts as `/api/audit`, after the Attesta mount, so `/api`'s JWT and
 * tenant middleware run first. The whole router uses requireAdminAction('audit.read')
 * (admins and auditors); services stay thin and the store does the work.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { AUDIT_CATALOG, AUDIT_CATALOG_VERSION } from '../../core/audit/catalog';
import { requireAdminAction } from '../../core/middleware/admin';
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

  return router;
}

export const auditRouter = createAuditRouter();
