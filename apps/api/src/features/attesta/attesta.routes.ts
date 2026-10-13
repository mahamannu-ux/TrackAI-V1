/**
 * Attesta evidence API routes (Task15i, A15.9 part 1; docs/contracts/attesta/api.md).
 * Mounted at /api/attesta behind /api's JWT and tenant middleware (app.ts).
 *
 *   GET /statements                         pages of typed columns + anchor_status
 *   GET /statements/:digest                 record, statement, envelope, anchors
 *   GET /subjects/:repository_id/:sha       every statement about a commit, with previous
 *   GET /verify?from_seq=&to_seq=           verifyChain's report (version 2), audited
 *
 * Every route needs `attesta.read` (tenant_admin, tenant_auditor). Handlers are thin;
 * queries live in read-service.ts. The writes (period reports, evidence packs, the
 * anchor-resume action) are Task15i2 and get their own classification in the route
 * sweep (attesta-api.test.ts EXPECTED_ROUTES).
 *
 * Ported from SushiCorp AU-1 / AP-1 @ 0bd67a5 (api/security.py, api/app.py): one
 * authorization dependency on every route, problems for every error. Deviation: the
 * per-tenant Postgres rate limiter is not ported; verify has a one-at-a-time guard
 * per tenant in this process (429 ATTESTA_API_RATE_LIMITED, Retry-After: 5).
 */
import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { requireAdminAction } from '../../core/middleware/admin';
import {
  attestaHttp, defaultLog, logFailure, problemizeAuth, requestIdOf, sendJson, sendProblem, type AttestaLog,
} from './http';
import {
  AttestaQueryError, anchorMaterialFromEnv, dbChainVerifier, getStatement, listStatements, noPublishedKeys,
  parseDigest, parseListQuery, parseSubject, parseVerifyQuery, pgReadStore, subjectStatements, verifyRange,
  type AnchorMaterialSource, type AttestaReadStore, type ChainVerifier, type VerifyKeySource,
} from './read-service';

export const VERIFY_RETRY_AFTER_SECONDS = 5;

export interface AttestaRouterDeps {
  store?: AttestaReadStore;
  /** Authorization; answers like requireAdminAction (its refusals become problems). */
  authorize?: RequestHandler;
  verifier?: ChainVerifier;
  keys?: VerifyKeySource;
  anchors?: AnchorMaterialSource;
  now?: () => Date;
  log?: AttestaLog;
}

type Role = 'tenant_admin' | 'tenant_auditor';

function actor(req: Request): { tenantId: string; actorId: string; role: Role } | null {
  const tenantId = req.tenantId;
  const actorId = req.user?.sub;
  const role = req.adminRole;
  if (!tenantId || !actorId || (role !== 'tenant_admin' && role !== 'tenant_auditor')) return null;
  return { tenantId, actorId, role };
}

const query = (req: Request) => req.query as Record<string, unknown>;

function param(req: Request, name: string): string {
  const value: unknown = req.params[name];
  if (typeof value !== 'string') throw new AttestaQueryError('path parameter is invalid');
  return value;
}

export function createAttestaRouter(deps: AttestaRouterDeps = {}): Router {
  const store = deps.store ?? pgReadStore();
  const verifier = deps.verifier ?? dbChainVerifier();
  const keys = deps.keys ?? noPublishedKeys;
  const anchors = deps.anchors ?? anchorMaterialFromEnv(process.env);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const verifying = new Set<string>();

  const router = Router();
  router.use(attestaHttp);
  router.use(problemizeAuth(deps.authorize ?? requireAdminAction('attesta.read')));

  /** Runs a handler with the actor; maps query errors to 400 and anything else to 500. */
  const handle = (fn: (req: Request, res: Response, who: NonNullable<ReturnType<typeof actor>>) => Promise<void>): RequestHandler =>
    async (req, res) => {
      const who = actor(req);
      if (!who) {
        sendProblem(res, 403, 'ATTESTA_API_FORBIDDEN');
        return;
      }
      try {
        await fn(req, res, who);
      } catch (err) {
        if (err instanceof AttestaQueryError) {
          sendProblem(res, 400, 'ATTESTA_API_INVALID_QUERY');
          return;
        }
        logFailure(log, res, 'ATTESTA_API_INTERNAL', err instanceof Error ? err.name : 'unknown');
        if (!res.headersSent) sendProblem(res, 500, 'ATTESTA_API_INTERNAL');
      }
    };

  router.get('/statements', handle(async (req, res, who) => {
    const parsed = parseListQuery(query(req));
    sendJson(res, await listStatements(store, who.tenantId, parsed, now()));
  }));

  router.get('/statements/:digest', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    const digest = parseDigest(param(req, 'digest'));
    // Another tenant's digest and an unknown digest take the same path: one tenant-bound
    // query that finds nothing, the same 404 body (api.md: never 403).
    const found = await getStatement(store, who.tenantId, digest);
    if (!found) {
      sendProblem(res, 404, 'ATTESTA_API_NOT_FOUND');
      return;
    }
    sendJson(res, found);
  }));

  router.get('/subjects/:repository_id/:sha', handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    const subject = parseSubject(param(req, 'repository_id'), param(req, 'sha'));
    const found = await subjectStatements(store, who.tenantId, subject.repositoryId, subject.sha, now());
    if (!found) {
      sendProblem(res, 404, 'ATTESTA_API_NOT_FOUND');
      return;
    }
    sendJson(res, found);
  }));

  router.get('/verify', handle(async (req, res, who) => {
    const range = parseVerifyQuery(query(req));
    if (verifying.has(who.tenantId)) {
      sendProblem(res, 429, 'ATTESTA_API_RATE_LIMITED', { 'Retry-After': String(VERIFY_RETRY_AFTER_SECONDS) });
      return;
    }
    verifying.add(who.tenantId);
    try {
      const report = await verifyRange({ store, verifier, keys, anchors, now }, {
        ...range, tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, requestId: requestIdOf(res),
      });
      sendJson(res, report);
    } finally {
      verifying.delete(who.tenantId);
    }
  }));

  // Anything else under /api/attesta (unknown path, or a method no route serves).
  router.use((_req, res) => sendProblem(res, 404, 'ATTESTA_API_NOT_FOUND'));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    logFailure(log, res, 'ATTESTA_API_INTERNAL', err instanceof Error ? err.name : 'unknown');
    if (!res.headersSent) sendProblem(res, 500, 'ATTESTA_API_INTERNAL');
  };
  router.use(onError);
  return router;
}

/** The router app.ts mounts: real store, real middleware, keys from VerifyKeySource (none yet). */
export const attestaRouter = createAttestaRouter();
