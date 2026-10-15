/**
 * HTTP conventions for the audit read API (Task16c, A16.6): RFC 7807 problems,
 * the X-Request-ID, `Cache-Control: no-store`.
 *
 * Ported from SushiCorp AP-1 @ 0bd67a5 (catalog AP-1), via features/attesta/http.ts
 * (`problem()`: one body shape, `type` = base + code, a stable `code`, the request
 * id, 5xx generic; `request_id_middleware`: accept the caller's id, else mint one).
 * Deviations: the same two as the Attesta port (exactly
 * {type, title, status, code, request_id} with a fixed title per code; the caller's
 * X-Request-ID is accepted when it is a bounded token, otherwise replaced, never
 * rejected). Scoped to the audit router; the shared admin middleware's 401/403/503
 * are rewritten here by `problemizeAuth`, without changing it.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { copyAdminAction } from '../../core/middleware/admin';

export const REQUEST_ID_HEADER = 'X-Request-ID';
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://trackai.dev/problems/';

/** Prompt §2.2 item 2 (frozen). */
export type AuditApiCode =
  | 'AUDIT_API_UNAUTHENTICATED'
  | 'AUDIT_API_FORBIDDEN'
  | 'AUDIT_FILTER_INVALID'
  | 'AUDIT_CURSOR_INVALID'
  | 'AUDIT_EVENT_NOT_FOUND'
  | 'AUDIT_API_UNAVAILABLE';

const STATUSES: Readonly<Record<AuditApiCode, number>> = {
  AUDIT_API_UNAUTHENTICATED: 401,
  AUDIT_API_FORBIDDEN: 403,
  AUDIT_FILTER_INVALID: 400,
  AUDIT_CURSOR_INVALID: 400,
  AUDIT_EVENT_NOT_FOUND: 404,
  AUDIT_API_UNAVAILABLE: 503,
};

const TITLES: Readonly<Record<AuditApiCode, string>> = {
  AUDIT_API_UNAUTHENTICATED: 'Authentication is required',
  AUDIT_API_FORBIDDEN: 'Administrator or auditor access is required',
  AUDIT_FILTER_INVALID: 'The request parameters are invalid',
  AUDIT_CURSOR_INVALID: 'The page cursor is invalid',
  AUDIT_EVENT_NOT_FOUND: 'Not found',
  AUDIT_API_UNAVAILABLE: 'The service is temporarily unavailable',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: AuditApiCode;
  request_id: string;
}

/** The request id of this request (set by `auditHttp`). */
export function requestIdOf(res: Response): string {
  const id = res.locals.auditRequestId;
  return typeof id === 'string' ? id : '';
}

/**
 * First middleware of the audit router: picks the request id and sets the two
 * headers every response carries, errors included.
 */
export function auditHttp(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get(REQUEST_ID_HEADER);
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.auditRequestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function problemBody(status: number, code: AuditApiCode, requestId: string): Problem {
  return { type: PROBLEM_TYPE_BASE + code, title: TITLES[code], status, code, request_id: requestId };
}

export function sendProblem(res: Response, code: AuditApiCode, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.status(STATUSES[code]).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problemBody(STATUSES[code], code, requestIdOf(res))));
}

/** Success bodies: JSON with no-store (set again in case a later middleware cleared it). */
export function sendJson(res: Response, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

/** Logs a server-side failure with the request id and code only, never details or SQL. */
export type AuditLog = (line: string) => void;
export const defaultLog: AuditLog = (line) => console.error(line);

export function logFailure(log: AuditLog, res: Response, code: AuditApiCode, cause: string): void {
  log(`audit-api ${code} request_id=${requestIdOf(res)} cause=${cause}`);
}

/**
 * Wraps an authorization middleware that answers with `res.status(n).json({error})`
 * (core/middleware/admin.ts `requireAdminAction`) so its refusals become problems:
 * 401 → AUDIT_API_UNAUTHENTICATED; 403 → AUDIT_API_FORBIDDEN; 503 or any other
 * status → 503 AUDIT_API_UNAVAILABLE. The middleware's own text never reaches the client.
 */
export function problemizeAuth(middleware: RequestHandler): RequestHandler {
  // The guard's action travels with the wrapper (Task16b), so the auditor sweep reads it.
  return copyAdminAction(middleware, function auditAuthorize(req, res, next) {
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
      if (pending === 401) sendProblem(res, 'AUDIT_API_UNAUTHENTICATED');
      else if (pending === 403) sendProblem(res, 'AUDIT_API_FORBIDDEN');
      else sendProblem(res, 'AUDIT_API_UNAVAILABLE');
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
      if (out && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err) => done(err));
      }
    } catch (err) {
      done(err);
    }
  });
}
