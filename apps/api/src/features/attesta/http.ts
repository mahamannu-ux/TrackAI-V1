/**
 * HTTP conventions for the Attesta evidence API (Task15i, A15.9; api.md §Conventions,
 * errors.md §API): RFC 7807 problems, the X-Request-ID, `Cache-Control: no-store`.
 *
 * Ported from SushiCorp AP-1 @ 0bd67a5 api/problems.py (`problem()`: one body shape,
 * `type` = base + code, a stable `code`, the request id, 5xx generic) and
 * api/security.py (`request_id_middleware`: accept the caller's id, else mint one).
 * Deviations:
 *  1. The body is exactly {type, title, status, code, request_id}: no `detail`,
 *     `instance` or `extra` (nothing that could carry a raw value or a path); the
 *     title is fixed per code.
 *  2. The caller's X-Request-ID is accepted when it is a bounded token
 *     (`^[A-Za-z0-9._-]{1,64}$`, api.md "bounded token"), not only a UUID; anything
 *     else is replaced by a fresh UUID, never rejected.
 *  3. Scoped to the Attesta router (other TrackAI routes keep their JSON errors,
 *     AGENTS.md §10 "Existing routes are not migrated"): the shared admin middleware's
 *     401/403/503 are rewritten here by `problemizeAuth`, without changing it.
 *  4. The rate-limit table of api/rate_limit.py is not ported (no table in 15i): the
 *     verify route has an in-process one-per-tenant guard instead (attesta.routes.ts).
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-ID';
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://trackai.dev/problems/';

/** errors.md §API (frozen). */
export type AttestaApiCode =
  | 'ATTESTA_API_FORBIDDEN'
  | 'ATTESTA_API_NOT_FOUND'
  | 'ATTESTA_API_INVALID_QUERY'
  | 'ATTESTA_API_RATE_LIMITED'
  | 'ATTESTA_API_INTERNAL';

const TITLES: Readonly<Record<AttestaApiCode, string>> = {
  ATTESTA_API_FORBIDDEN: 'Administrator or auditor access is required',
  ATTESTA_API_NOT_FOUND: 'Not found',
  ATTESTA_API_INVALID_QUERY: 'The request parameters are invalid',
  ATTESTA_API_RATE_LIMITED: 'Too many requests',
  ATTESTA_API_INTERNAL: 'The service could not complete the request',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: AttestaApiCode;
  request_id: string;
}

/** The request id of this request (set by `attestaHttp`). */
export function requestIdOf(res: Response): string {
  const id = res.locals.attestaRequestId;
  return typeof id === 'string' ? id : '';
}

/**
 * First middleware of the Attesta router: picks the request id and sets the two
 * headers every response carries, errors included.
 */
export function attestaHttp(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get(REQUEST_ID_HEADER);
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.attestaRequestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function problemBody(status: number, code: AttestaApiCode, requestId: string): Problem {
  return { type: PROBLEM_TYPE_BASE + code, title: TITLES[code], status, code, request_id: requestId };
}

export function sendProblem(
  res: Response, status: number, code: AttestaApiCode, headers: Record<string, string> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problemBody(status, code, requestIdOf(res))));
}

/** Success bodies: JSON with no-store (set again in case a later middleware cleared it). */
export function sendJson(res: Response, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

/**
 * Logs a server-side failure with the request id and code only (AGENTS.md §10: never
 * the message, which may carry values).
 */
export type AttestaLog = (line: string) => void;
export const defaultLog: AttestaLog = (line) => console.error(line);

export function logFailure(log: AttestaLog, res: Response, code: AttestaApiCode, cause: string): void {
  log(`attesta-api ${code} request_id=${requestIdOf(res)} cause=${cause}`);
}

/**
 * Wraps an authorization middleware that answers with `res.status(n).json({error})`
 * (core/middleware/admin.ts `requireAdminAction`) so its refusals become problems:
 * 403 → ATTESTA_API_FORBIDDEN; 401 → 401 with ATTESTA_API_FORBIDDEN (errors.md has no
 * unauthenticated code; /api's JWT middleware answers first in practice); 503 or any
 * other status → 503 ATTESTA_API_INTERNAL. The middleware's own text never reaches
 * the client.
 */
export function problemizeAuth(middleware: RequestHandler): RequestHandler {
  return function attestaAuthorize(req, res, next) {
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
      if (pending === 401 || pending === 403) sendProblem(res, pending, 'ATTESTA_API_FORBIDDEN');
      else sendProblem(res, 503, 'ATTESTA_API_INTERNAL');
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
  };
}
