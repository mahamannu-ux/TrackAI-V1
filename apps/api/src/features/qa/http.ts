/**
 * HTTP conventions for the Q&A API (Task19a, T19.2): RFC 7807 problems, the
 * X-Request-ID, `Cache-Control: no-store`.
 *
 * Pattern from Task16c `features/audit/http.ts`, catalog AP-1 (itself ported from
 * SushiCorp AP-1 @ 0bd67a5 via features/attesta/http.ts). Copied, not imported,
 * so Task16's module stays inside its boundary. Deviations from the audit copy:
 * the Q&A codes and titles (docs/contracts/qa/api.md "Problems"), the request id
 * in `res.locals.qaRequestId`, and `qa-api` log lines. Same rules otherwise: exactly
 * {type, title, status, code, request_id} with a fixed title per code; a caller's
 * X-Request-ID is accepted when it is a bounded token, otherwise replaced, never
 * rejected; the shared admin middleware's 401/403/503 are rewritten by
 * `problemizeAuth` without changing it.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { copyAdminAction } from '../../core/middleware/admin';

export const REQUEST_ID_HEADER = 'X-Request-ID';
export const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://trackai.dev/problems/';

/** docs/contracts/qa/api.md "Problems" (frozen once merged). */
export type QaApiCode =
  | 'QA_UNAUTHENTICATED'
  | 'QA_FORBIDDEN'
  | 'QA_QUESTION_NOT_FOUND'
  | 'QA_KIND_NOT_OFFERED'
  | 'QA_KIND_NOT_ALLOWED'
  | 'QA_SCOPE_INVALID'
  | 'QA_SCOPE_NOT_FOUND'
  | 'QA_DRILLDOWN_NOT_BUILT'
  | 'QA_ANSWER_INVALID'
  | 'QA_UNAVAILABLE';

export const QA_API_STATUSES: Readonly<Record<QaApiCode, number>> = {
  QA_UNAUTHENTICATED: 401,
  QA_FORBIDDEN: 403,
  QA_QUESTION_NOT_FOUND: 404,
  QA_KIND_NOT_OFFERED: 400,
  QA_KIND_NOT_ALLOWED: 403,
  QA_SCOPE_INVALID: 400,
  QA_SCOPE_NOT_FOUND: 404,
  QA_DRILLDOWN_NOT_BUILT: 501,
  QA_ANSWER_INVALID: 503,
  QA_UNAVAILABLE: 503,
};

const TITLES: Readonly<Record<QaApiCode, string>> = {
  QA_UNAUTHENTICATED: 'Authentication is required',
  QA_FORBIDDEN: 'Administrator or auditor access is required',
  QA_QUESTION_NOT_FOUND: 'Not found',
  QA_KIND_NOT_OFFERED: 'The question does not offer this kind of answer',
  QA_KIND_NOT_ALLOWED: 'This kind of answer is not available to your role',
  QA_SCOPE_INVALID: 'The request parameters are invalid',
  QA_SCOPE_NOT_FOUND: 'Not found',
  QA_DRILLDOWN_NOT_BUILT: 'The drill-down is not available yet',
  QA_ANSWER_INVALID: 'The service is temporarily unavailable',
  QA_UNAVAILABLE: 'The service is temporarily unavailable',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: QaApiCode;
  request_id: string;
}

/** The request id of this request (set by `qaHttp`). */
export function requestIdOf(res: Response): string {
  const id = res.locals.qaRequestId;
  return typeof id === 'string' ? id : '';
}

/**
 * First middleware of the Q&A router: picks the request id and sets the two
 * headers every response carries, errors included.
 */
export function qaHttp(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get(REQUEST_ID_HEADER);
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.qaRequestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function problemBody(status: number, code: QaApiCode, requestId: string): Problem {
  return { type: PROBLEM_TYPE_BASE + code, title: TITLES[code], status, code, request_id: requestId };
}

export function sendProblem(res: Response, code: QaApiCode, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.status(QA_API_STATUSES[code]).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problemBody(QA_API_STATUSES[code], code, requestIdOf(res))));
}

/** Success bodies: JSON with no-store (set again in case a later middleware cleared it). */
export function sendJson(res: Response, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
}

/** Logs a server-side failure with the request id and code only, never details or SQL. */
export type QaLog = (line: string) => void;
export const defaultLog: QaLog = (line) => console.error(line);

export function logFailure(log: QaLog, res: Response, code: QaApiCode, cause: string): void {
  log(`qa-api ${code} request_id=${requestIdOf(res)} cause=${cause}`);
}

/**
 * Wraps an authorization middleware that answers with `res.status(n).json({error})`
 * (core/middleware/admin.ts `requireAdminAction`) so its refusals become problems:
 * 401 → QA_UNAUTHENTICATED; 403 → QA_FORBIDDEN; 503 or any other
 * status → 503 QA_UNAVAILABLE. The middleware's own text never reaches the client.
 */
export function problemizeAuth(middleware: RequestHandler): RequestHandler {
  // The guard's action travels with the wrapper (Task16b), so the auditor sweep reads it.
  return copyAdminAction(middleware, function qaAuthorize(req, res, next) {
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
      if (pending === 401) sendProblem(res, 'QA_UNAUTHENTICATED');
      else if (pending === 403) sendProblem(res, 'QA_FORBIDDEN');
      else sendProblem(res, 'QA_UNAVAILABLE');
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
