/**
 * Security reads v2 admin API (Task20i-a, T20.7b): the findings list and detail
 * plus the Endpoint coverage view the security console (Task20i-b) calls.
 *
 *   GET /findings       security_findings.read (administrators and auditors)
 *   GET /findings/:id   security_findings.read (administrators and auditors)
 *   GET /coverage       security_findings.read (administrators and auditors)
 *
 * AP-1 (copied from features/security/admin.routes.ts, not imported, so each
 * feature keeps its own codes): RFC 7807 problems {type, title, status, code,
 * request_id} with fixed titles, the X-Request-ID echo, `Cache-Control:
 * no-store` on every response, and logs that carry codes only. Every read is
 * audited inside its transaction (v2-read.ts). Raw content never passes through
 * here: previews are deferred and never selected.
 */
import { randomUUID } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { copyAdminAction, requireAdminAction } from '../../core/middleware/admin';
import {
  parseCoverageQuery,
  parseFindingId,
  parseFindingsQuery,
  pgSecurityV2ReadStore,
  type SecurityReaderRole,
  type SecurityV2ReadStore,
} from './v2-read';

export type SecurityReadCode =
  | 'SECURITY_READ_INVALID_QUERY'
  | 'SECURITY_READ_FORBIDDEN'
  | 'SECURITY_READ_NOT_FOUND'
  | 'SECURITY_READ_UNAVAILABLE';

const STATUS: Readonly<Record<SecurityReadCode, number>> = {
  SECURITY_READ_INVALID_QUERY: 400,
  SECURITY_READ_FORBIDDEN: 403,
  SECURITY_READ_NOT_FOUND: 404,
  SECURITY_READ_UNAVAILABLE: 503,
};

const TITLES: Readonly<Record<SecurityReadCode, string>> = {
  SECURITY_READ_INVALID_QUERY: 'The request parameters are invalid',
  SECURITY_READ_FORBIDDEN: 'Administrator or auditor access is required',
  SECURITY_READ_NOT_FOUND: 'Not found',
  SECURITY_READ_UNAVAILABLE: 'The service is temporarily unavailable',
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function requestIdOf(res: Response): string {
  const id = res.locals.securityReadRequestId;
  return typeof id === 'string' ? id : '';
}

function http(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('X-Request-ID');
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.securityReadRequestId = id;
  res.setHeader('X-Request-ID', id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function sendProblem(res: Response, code: SecurityReadCode): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(STATUS[code]).type('application/problem+json').send(JSON.stringify({
    type: `https://trackai.dev/problems/${code}`, title: TITLES[code], status: STATUS[code], code, request_id: requestIdOf(res),
  }));
}

/** requireAdminAction answers with res.status(n).json(...): rewrite those to problems, keeping its action label. */
function problemizeAuth(middleware: RequestHandler): RequestHandler {
  return copyAdminAction(middleware, function securityReadAuthorize(req, res, next) {
    const originalStatus = res.status.bind(res);
    const originalJson = res.json.bind(res);
    let pending = 200;
    const restore = () => {
      res.status = originalStatus;
      res.json = originalJson;
    };
    res.status = ((code: number) => {
      pending = code;
      return res;
    }) as Response['status'];
    res.json = ((_body: unknown) => {
      restore();
      // The enumerated codes carry no 401: without an identity the caller is
      // refused as forbidden, like every other non-administrator.
      sendProblem(res, pending === 403 || pending === 401 ? 'SECURITY_READ_FORBIDDEN' : 'SECURITY_READ_UNAVAILABLE');
      return res;
    }) as Response['json'];
    let called = false;
    const done: NextFunction = (err?: unknown) => {
      if (called) return;
      called = true;
      restore();
      next(err as Error | undefined);
    };
    try {
      const out = middleware(req, res, done) as unknown;
      if (out && typeof (out as Promise<void>).catch === 'function') (out as Promise<void>).catch((err) => done(err));
    } catch (err) {
      done(err);
    }
  });
}

export interface SecurityV2ReadRouterDeps {
  /** Test seams; production uses requireAdminAction and the Postgres store. */
  authorize?: RequestHandler;
  store?: () => SecurityV2ReadStore;
  log?: (line: string) => void;
}

export function createSecurityV2ReadRouter(deps: SecurityV2ReadRouterDeps = {}): Router {
  const log = deps.log ?? ((line: string) => console.error(line));
  const storeOf = deps.store ?? (() => pgSecurityV2ReadStore);
  const authorize = problemizeAuth(deps.authorize ?? requireAdminAction('security_findings.read'));
  const router = Router();
  router.use(http);

  function identity(req: Request): { tenantId: string; actorId: string; actorRole: SecurityReaderRole } | null {
    if (!req.tenantId || !req.user?.sub || !req.adminRole) return null;
    return { tenantId: req.tenantId, actorId: req.user.sub, actorRole: req.adminRole };
  }

  router.get('/findings', authorize, async (req, res) => {
    const caller = identity(req);
    if (!caller) {
      sendProblem(res, 'SECURITY_READ_FORBIDDEN');
      return;
    }
    let parsed: ReturnType<typeof parseFindingsQuery>;
    try {
      parsed = parseFindingsQuery(req.query as Record<string, unknown>);
    } catch {
      log(`security-read code=SECURITY_READ_INVALID_QUERY request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_INVALID_QUERY');
      return;
    }
    try {
      const page = await storeOf().listFindingsAndAudit({ ...caller, ...parsed });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ items: page.items, next_cursor: page.next_cursor });
    } catch {
      log(`security-read code=SECURITY_READ_UNAVAILABLE request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_UNAVAILABLE');
    }
  });

  router.get('/findings/:id', authorize, async (req, res) => {
    const caller = identity(req);
    if (!caller) {
      sendProblem(res, 'SECURITY_READ_FORBIDDEN');
      return;
    }
    let id: string;
    try {
      id = parseFindingId(req.params.id);
    } catch {
      log(`security-read code=SECURITY_READ_INVALID_QUERY request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_INVALID_QUERY');
      return;
    }
    try {
      const detail = await storeOf().getFindingAndAudit({ ...caller, id });
      if (!detail) {
        // Another tenant's finding id answers the same 404 as a missing one.
        sendProblem(res, 'SECURITY_READ_NOT_FOUND');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(detail);
    } catch {
      log(`security-read code=SECURITY_READ_UNAVAILABLE request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_UNAVAILABLE');
    }
  });

  router.get('/coverage', authorize, async (req, res) => {
    const caller = identity(req);
    if (!caller) {
      sendProblem(res, 'SECURITY_READ_FORBIDDEN');
      return;
    }
    let parsed: ReturnType<typeof parseCoverageQuery>;
    try {
      parsed = parseCoverageQuery(req.query as Record<string, unknown>);
    } catch {
      log(`security-read code=SECURITY_READ_INVALID_QUERY request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_INVALID_QUERY');
      return;
    }
    try {
      const page = await storeOf().listCoverageAndAudit({ ...caller, ...parsed });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ rows: page.rows, next_cursor: page.next_cursor });
    } catch {
      log(`security-read code=SECURITY_READ_UNAVAILABLE request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_READ_UNAVAILABLE');
    }
  });

  router.use(((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    sendProblem(res, 'SECURITY_READ_UNAVAILABLE');
  }) as express.ErrorRequestHandler);
  return router;
}

export const securityV2ReadAdminRouter = createSecurityV2ReadRouter();
