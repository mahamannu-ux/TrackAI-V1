/**
 * Security v2 machine API (Task20d; docs/contracts/security-v2/api.md,
 * errors.md). Only POST /records is built here; Task20f adds lease, bundle and
 * acknowledgement routes beside it. The HTTP convention is Attesta's pattern
 * (features/attesta/http.ts, SushiCorp AP-1) copied, not imported: RFC 7807
 * problems with fixed titles, the X-Request-ID echo, no-store, and logs that
 * carry codes and counts only — never a value, a record or an id.
 */
import { randomUUID } from 'node:crypto';
import express, {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  SECURITY_V2_MAX_UPLOAD_BYTES,
  SecurityV2ValidationError,
  validateSecurityUploadV2,
  type SecurityDataSettingsV1,
  type SecurityV2ErrorCode,
  type SecurityV2RecordResult,
  type SecurityUploadV2,
} from './v2-contract';
import type { SecurityV2Authority } from './v2-authority';
import { unavailableSecurityV2Authority } from './v2-authority';
import { persistSecurityV2Upload } from './v2-storage';

const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const PROBLEM_TYPE_BASE = 'https://trackai.dev/problems/';
const UPLOAD_RESULT_SCHEMA = 'trackai.security-upload-result/2' as const;

/** errors.md (frozen): the fixed title of every API code a problem body may carry. */
const SECURITY_V2_TITLES: Readonly<Record<SecurityV2ErrorCode, string>> = {
  SECURITY_V2_INVALID_BODY: 'Security request is invalid',
  SECURITY_V2_UNSUPPORTED_SCHEMA: 'Security schema is not supported',
  SECURITY_V2_UNKNOWN_FIELD: 'Security request contains an unknown field',
  SECURITY_V2_FIELD_NOT_PERMITTED: 'Security field is not permitted',
  SECURITY_V2_LEASE_REQUIRED: 'A valid security lease is required',
  SECURITY_V2_LEASE_MISMATCH: 'Security record does not match its lease',
  SECURITY_V2_PAYLOAD_TOO_LARGE: 'Security payload is too large',
  SECURITY_V2_RECORD_CONFLICT: 'Security record conflicts with prior state',
  SECURITY_V2_NOT_FOUND: 'Security resource was not found',
  SECURITY_V2_LEASE_NOT_ISSUED: 'Security lease has not been issued',
  SECURITY_V2_RATE_LIMITED: 'Security request rate limit exceeded',
  SECURITY_V2_INTERNAL: 'Security service is unavailable',
};

export interface SecurityV2Problem {
  type: string;
  title: string;
  status: number;
  code: SecurityV2ErrorCode;
  request_id: string;
}

interface SecurityV2RouteRequest extends Request {
  body: unknown;
}

type SecurityV2RouteResponse = Response & {
  locals: { securityV2RequestId?: string };
};

/** The request id of this request (set by `securityV2Http`). */
export function requestIdOf(res: SecurityV2RouteResponse): string {
  const id = res.locals.securityV2RequestId;
  return typeof id === 'string' ? id : '';
}

/**
 * First middleware of the v2 router: picks the request id and sets the two
 * headers every response carries, errors included.
 */
function securityV2Http(req: Request, res: SecurityV2RouteResponse, next: NextFunction): void {
  const supplied = req.get(REQUEST_ID_HEADER);
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.securityV2RequestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function sendProblem(
  res: SecurityV2RouteResponse,
  status: number,
  code: SecurityV2ErrorCode,
): void {
  res.setHeader('Cache-Control', 'no-store');
  const body: SecurityV2Problem = {
    type: PROBLEM_TYPE_BASE + code,
    title: SECURITY_V2_TITLES[code],
    status,
    code,
    request_id: requestIdOf(res),
  };
  res.status(status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
}

export type SecurityV2Log = (line: string) => void;
export const defaultLog: SecurityV2Log = (line) => console.error(line);

export type SecurityV2Persist = (input: {
  tenantId: string;
  machineId: string;
  upload: SecurityUploadV2;
  settings: SecurityDataSettingsV1 | null;
  authority: SecurityV2Authority;
  receivedAt: Date;
}) => Promise<SecurityV2RecordResult[]>;

export interface SecurityV2RouterDependencies {
  authority: SecurityV2Authority;
  persist: SecurityV2Persist;
  log: SecurityV2Log;
}

/**
 * Admission order step 2: the fixed 4 MiB body limit. The app-level parser
 * (app.ts, 5 mb) runs first and express.json skips an already-parsed body, so
 * this guard carries the limit; the router's own express.json({ limit }) is the
 * prompt's decision, kept for when the router runs without the app parser.
 */
function bodyLimitGuard(req: Request, res: SecurityV2RouteResponse, next: NextFunction): void {
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > SECURITY_V2_MAX_UPLOAD_BYTES) {
    sendProblem(res, 413, 'SECURITY_V2_PAYLOAD_TOO_LARGE');
    return;
  }
  next();
}

/**
 * The v2 router. Credentials, authority and storage are injected so tests and
 * live verifies run the real router in-process; production uses the unavailable
 * authority (fail-closed) until Task20f supplies the lease store.
 */
export function createSecurityV2Router(
  dependencies: Partial<SecurityV2RouterDependencies> = {},
): Router {
  const resolved: SecurityV2RouterDependencies = {
    authority: dependencies.authority ?? unavailableSecurityV2Authority,
    // Production storage. The unavailable authority answers LEASE_REQUIRED
    // before storage runs, so this stays unreachable until Task20f's lease
    // store supplies a real authority.
    persist: dependencies.persist ?? persistSecurityV2Upload,
    log: dependencies.log ?? defaultLog,
  };
  const router = Router();
  router.use(securityV2Http);
  // Credential identity comes only from the managed machine credential
  // (core/middleware/machine-auth, wired at app level); checked before the
  // body is read. A missing credential answers like a missing lease: 403,
  // never 401 with details.
  router.use(((req, res, next) => {
    if (req.managedMachineCredential !== true || !req.tenantId || !req.machineId) {
      sendProblem(res as SecurityV2RouteResponse, 403, 'SECURITY_V2_LEASE_REQUIRED');
      return;
    }
    next();
  }) as RequestHandler);
  router.use(((req, res, next) => {
    bodyLimitGuard(req, res as SecurityV2RouteResponse, next);
  }) as RequestHandler);
  router.use(express.json({ limit: '4mb' }));
  router.post('/records', (req, res, next) => {
    void handleRecords(req as SecurityV2RouteRequest, res as SecurityV2RouteResponse, next, resolved);
  });
  router.use(((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _req;
    void _next;
    const type = (error as { type?: string } | null)?.type;
    if (res.headersSent) return;
    if (type === 'entity.too.large') {
      sendProblem(res as SecurityV2RouteResponse, 413, 'SECURITY_V2_PAYLOAD_TOO_LARGE');
      return;
    }
    sendProblem(res as SecurityV2RouteResponse, 500, 'SECURITY_V2_INTERNAL');
  }) as ErrorRequestHandler);
  return router;
}

async function handleRecords(
  req: SecurityV2RouteRequest,
  res: SecurityV2RouteResponse,
  next: NextFunction,
  dependencies: SecurityV2RouterDependencies,
): Promise<void> {
  const requestId = requestIdOf(res);
  const log = dependencies.log;
  try {
    if (!req.tenantId || !req.machineId) {
      sendProblem(res, 403, 'SECURITY_V2_LEASE_REQUIRED');
      return;
    }
    let upload: SecurityUploadV2;
    try {
      upload = validateSecurityUploadV2(req.body);
    } catch (error) {
      if (error instanceof SecurityV2ValidationError) {
        sendProblem(res, 400, error.code);
        return;
      }
      throw error;
    }

    const receivedAt = new Date();
    // Admission order: a current lease first — its absence refuses the whole
    // request (api.md "POST"). Data settings default to all-off on null.
    const settings: SecurityDataSettingsV1 | null = await dependencies.authority.currentDataSettings(req.tenantId);
    const lease = await dependencies.authority.currentLease(req.tenantId, req.machineId, receivedAt);
    if (!lease) {
      sendProblem(res, 403, 'SECURITY_V2_LEASE_REQUIRED');
      return;
    }
    const results = await dependencies.persist({
      tenantId: req.tenantId,
      machineId: req.machineId,
      upload,
      settings,
      authority: dependencies.authority,
      receivedAt,
    });
    const counts = results.reduce<Record<string, number>>((acc, result) => {
      acc[result.result] = (acc[result.result] ?? 0) + 1;
      return acc;
    }, {});
    log(`security-v2 request_id=${requestId} records=${results.length} accepted=${counts.accepted ?? 0} duplicate=${counts.duplicate ?? 0} rejected=${counts.rejected ?? 0}`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      schema_version: UPLOAD_RESULT_SCHEMA,
      results,
    });
  } catch (error) {
    if (res.headersSent) {
      next(error);
      return;
    }
    log(`security-v2 request_id=${requestId} code=SECURITY_V2_INTERNAL`);
    sendProblem(res, 500, 'SECURITY_V2_INTERNAL');
  }
}
