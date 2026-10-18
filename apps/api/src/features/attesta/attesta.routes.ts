/**
 * Attesta evidence API routes (Task15i, A15.9 part 1; docs/contracts/attesta/api.md).
 * Mounted at /api/attesta behind /api's JWT and tenant middleware (app.ts).
 *
 *   GET /statements                         pages of typed columns + anchor_status
 *   GET /statements/:digest                 record, statement, envelope, anchors
 *   GET /subjects/:repository_id/:sha       every statement about a commit, with previous
 *   GET /verify?from_seq=&to_seq=           verifyChain's report (version 2), audited
 *
 *   POST /evidence-packs                    202 {id, status}; idempotent on Idempotency-Key + scope (Task15i2)
 *   GET  /evidence-packs/:id                job status (evidence-pack-service.ts packStatusBody)
 *   GET  /evidence-packs/:id/content        {pack, signature} attachment, audited
 *
 *   POST /period-reports                    202 {id, status}; idempotent on Idempotency-Key + scope (Task15i4)
 *   GET  /period-reports/:id                job status, report and statement digests
 *   GET  /period-reports/:id/document       the signed report document (RFC 8785 bytes), audited
 *
 *   GET  /security-seals/verify?from&to     the security-finding seal verify report, audited (Task15op-a)
 *
 * Every route needs `attesta.read`; the evidence-pack and period-report routes also `attesta.export`
 * (both: tenant_admin, tenant_auditor; an auditor's job is to take evidence, and every
 * export and download is audited). Handlers are thin; queries live in read-service.ts
 * and evidence-pack-service.ts. Each route is classified in the route sweep
 * (attesta-api.test.ts EXPECTED_ROUTES / EXPECTED_MUTATING).
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
import { db } from '../../core/db';
import {
  MAX_OPEN_PACKS, MAX_PACK_RECORDS, PackJobError, defaultPackJobDeps, downloadBody, packStatusBody, parseIdempotencyKey,
  parsePackRequest, runEvidencePack, sameRequest, type PackJob, type PackJobDeps,
} from './evidence-pack-service';
import {
  MAX_OPEN_REPORTS, defaultReportJobDeps, documentBody, parseReportIdempotencyKey, parseReportRequest, reportStatusBody,
  runPeriodReport, sameReportRequest, type ReportJob, type ReportJobDeps,
} from './period-report-service';
import { MAX_REPORT_STATEMENTS } from './period-report-rules';
import {
  AttestaQueryError, anchorMaterialFromEnv, dbChainVerifier, getStatement, listStatements,
  parseDigest, parseListQuery, parseSubject, parseVerifyQuery, pgReadStore, publishedKeySource, subjectStatements, verifyRange,
  type AnchorMaterialSource, type AttestaReadStore, type ChainVerifier, type VerifyKeySource,
} from './read-service';
import type { SealDatabase } from './audit-seal-service';
import {
  parseSecurityVerifyQuery, verifySecuritySeals, type SecurityVerifyInput, type SecurityVerifyReport,
} from './security-seal-service';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { trustConfigFromEnv } from './trust-resolver';
import type { AttestaApiCode } from './http';

export const VERIFY_RETRY_AFTER_SECONDS = 5;

export interface AttestaRouterDeps {
  store?: AttestaReadStore;
  /** Authorization; answers like requireAdminAction (its refusals become problems). */
  authorize?: RequestHandler;
  /** Authorization of the evidence-pack routes (default requireAdminAction('attesta.export')). */
  authorizeExport?: RequestHandler;
  verifier?: ChainVerifier;
  /** The tenant's statement keys and windows (default: the newest trust-verified key set, publishedKeyWindowsFor). */
  keys?: VerifyKeySource;
  /** Evidence-pack job dependencies (default: production wiring, defaultPackJobDeps). */
  packs?: PackJobDeps;
  /** Starts a created job (default: in-process after the 202, setImmediate). */
  startPack?: (tenantId: string, packId: string) => void;
  /** Period-report job dependencies (default: production wiring, defaultReportJobDeps). */
  reports?: ReportJobDeps;
  /** Starts a created report job (default: in-process after the 202, setImmediate). */
  startReport?: (tenantId: string, reportId: string) => void;
  anchors?: AnchorMaterialSource;
  /** The security-finding seal verify report (default: verifySecuritySeals on the real database). */
  verifySecuritySeals?: (input: SecurityVerifyInput) => Promise<SecurityVerifyReport>;
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

/** A refusal with its own status and code (409, 429, 503 …). */
class ApiProblem extends Error {
  constructor(readonly status: number, readonly code: AttestaApiCode, readonly headers: Record<string, string> = {}) {
    super(code);
    this.name = 'ApiProblem';
  }
}

const PACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function param(req: Request, name: string): string {
  const value: unknown = req.params[name];
  if (typeof value !== 'string') throw new AttestaQueryError('path parameter is invalid');
  return value;
}

export function createAttestaRouter(deps: AttestaRouterDeps = {}): Router {
  const store = deps.store ?? pgReadStore();
  const verifier = deps.verifier ?? dbChainVerifier();
  const now = deps.now ?? (() => new Date());
  // Keys and their windows from the newest trust-verified key set (Task15i3), pinned by
  // ATTESTA_TRUST_ROOT_KEYIDS (read per call); the `keys` seam stays for tests.
  const keys = deps.keys ?? publishedKeySource(() => pgTrustStore(db as unknown as TrustDb), () => trustConfigFromEnv(process.env), now);
  const anchors = deps.anchors ?? anchorMaterialFromEnv(process.env);
  const packs = deps.packs ?? defaultPackJobDeps(process.env, anchors);
  const reports = deps.reports ?? defaultReportJobDeps(process.env);
  const log = deps.log ?? defaultLog;
  const securityVerify = deps.verifySecuritySeals ?? ((input: SecurityVerifyInput) => verifySecuritySeals(
    { database: db as unknown as SealDatabase, attesta: { store, verifier, keys, anchors, now } }, input));
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
        if (err instanceof ApiProblem) {
          sendProblem(res, err.status, err.code, err.headers);
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

  // --- Security-finding seals (Task15op-a; security-findings-seal.md). attesta.read, like /verify,
  // and the same one-at-a-time guard per tenant (both recompute in memory).
  router.get('/security-seals/verify', handle(async (req, res, who) => {
    const q = parseSecurityVerifyQuery(query(req));
    if (verifying.has(who.tenantId)) {
      sendProblem(res, 429, 'ATTESTA_API_RATE_LIMITED', { 'Retry-After': String(VERIFY_RETRY_AFTER_SECONDS) });
      return;
    }
    verifying.add(who.tenantId);
    try {
      sendJson(res, await securityVerify({
        tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, requestId: requestIdOf(res), query: q,
      }));
    } finally {
      verifying.delete(who.tenantId);
    }
  }));

  // --- Evidence packs (Task15i2; evidence-pack.md, api.md)

  const exportAuth = problemizeAuth(deps.authorizeExport ?? requireAdminAction('attesta.export'));
  const startPack = deps.startPack ?? ((tenantId: string, packId: string) => {
    setImmediate(() => {
      runEvidencePack({ ...packs, log }, tenantId, packId).catch((err: unknown) => {
        log(`attesta-pack ATTESTA_API_INTERNAL pack_id=${packId} cause=${err instanceof Error ? err.name : 'unknown'}`);
      });
    });
  });
  const packIdOf = (req: Request): string => {
    const id = param(req, 'id');
    if (!PACK_ID_RE.test(id)) throw new AttestaQueryError('pack id must be a lowercase UUID');
    return id;
  };
  const scopeDetails = (job: PackJob) => ({ scope: job.scope, mode: job.mode });

  router.post('/evidence-packs', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    // Every header and the body are validated before anything reaches the store (Task15i lesson).
    const key = parseIdempotencyKey(req.get('Idempotency-Key'));
    const request = parsePackRequest(req.body, now());
    const answer = (job: PackJob, replayed: boolean) => {
      res.setHeader('Location', `${req.baseUrl}/evidence-packs/${job.id}`);
      res.status(202).json({ id: job.id, status: job.status, replayed });
    };
    const replay = async (job: PackJob) => {
      // Same key, same scope and mode → the same job; anything else is a conflict, never a second job.
      if (!sameRequest(request, job)) throw new ApiProblem(409, 'ATTESTA_API_CONFLICT');
      await packs.store.audit({ tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'attesta.export.request',
        packId: job.id, details: { request_id: requestIdOf(res), ...scopeDetails(job), replayed: true } });
      answer(job, true);
    };
    const existing = await packs.store.findByKey(who.tenantId, key);
    if (existing) return replay(existing);
    if (request.scope.repository_id && !(await packs.store.repositoryExists(who.tenantId, request.scope.repository_id))) {
      throw new AttestaQueryError('repository_id is not a repository of this tenant');
    }
    if (await packs.store.segmentSize(who.tenantId, request.scope) > MAX_PACK_RECORDS) throw new AttestaQueryError('the period is too large for one pack');
    if (await packs.store.openCount(who.tenantId) >= MAX_OPEN_PACKS) {
      throw new ApiProblem(429, 'ATTESTA_API_RATE_LIMITED', { 'Retry-After': String(VERIFY_RETRY_AFTER_SECONDS * 6) });
    }
    const { job, created } = await packs.store.createOrGet({
      tenantId: who.tenantId, idempotencyKey: key, request, requestedBy: who.actorId, requestId: requestIdOf(res),
    });
    if (!created) return replay(job); // a concurrent request with the same key won the insert
    // Started even when the audit write fails, so a created job is never stranded; the
    // failure still answers 500 and a retry with the same key replays (and audits) it.
    startPack(who.tenantId, job.id);
    await packs.store.audit({ tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'attesta.export.request',
      packId: job.id, details: { request_id: requestIdOf(res), ...scopeDetails(job), replayed: false } });
    answer(job, false);
  }));

  router.get('/evidence-packs/:id', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    // Another tenant's id and an unknown id take the same path (one tenant-bound query, the same 404).
    const job = await packs.store.get(who.tenantId, packIdOf(req));
    if (!job) throw new ApiProblem(404, 'ATTESTA_API_NOT_FOUND');
    sendJson(res, packStatusBody(job, `${req.baseUrl}/evidence-packs`));
  }));

  router.get('/evidence-packs/:id/content', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    const job = await packs.store.get(who.tenantId, packIdOf(req));
    if (!job || job.status !== 'ready' || !job.storageReference) throw new ApiProblem(404, 'ATTESTA_API_NOT_FOUND');
    const sink = packs.sink();
    if (!sink) throw new ApiProblem(503, 'ATTESTA_API_UNAVAILABLE');
    let body: string;
    try {
      body = downloadBody(job, await sink.read(job.storageReference));
    } catch (err) {
      // A missing, unreadable or altered file: never a download of bytes the signature does not cover.
      throw err instanceof PackJobError ? err : new Error('the stored pack cannot be read');
    }
    await packs.store.audit({ tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'attesta.export.download',
      packId: job.id, details: { request_id: requestIdOf(res), ...scopeDetails(job), pack_digest: job.packDigest, counts: job.counts } });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="trackai-evidence-pack-${job.id}.json"`);
    res.status(200).type('application/json').send(body);
  }));

  // --- Period reports (Task15i4; period-report.md). Same job pattern and authorization as packs.

  const startReport = deps.startReport ?? ((tenantId: string, reportId: string) => {
    setImmediate(() => {
      runPeriodReport({ ...reports, log }, tenantId, reportId).catch((err: unknown) => {
        log(`attesta-report ATTESTA_API_INTERNAL report_id=${reportId} cause=${err instanceof Error ? err.name : 'unknown'}`);
      });
    });
  });
  const reportIdOf = (req: Request): string => {
    const id = param(req, 'id');
    if (!PACK_ID_RE.test(id)) throw new AttestaQueryError('report id must be a lowercase UUID');
    return id;
  };

  router.post('/period-reports', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    const key = parseReportIdempotencyKey(req.get('Idempotency-Key'));
    const request = parseReportRequest(req.body, now());
    const answer = (job: ReportJob, replayed: boolean) => {
      res.setHeader('Location', `${req.baseUrl}/period-reports/${job.id}`);
      res.status(202).json({ id: job.id, status: job.status, replayed });
    };
    const audit = (job: ReportJob, replayed: boolean) => reports.store.audit({ tenantId: who.tenantId, actorId: who.actorId,
      actorRole: who.role, action: 'attesta.report.request', reportId: job.id,
      details: { request_id: requestIdOf(res), scope: job.scope, replayed } });
    const replay = async (job: ReportJob) => {
      if (!sameReportRequest(request, job.scope)) throw new ApiProblem(409, 'ATTESTA_API_CONFLICT');
      await audit(job, true);
      answer(job, true);
    };
    const existing = await reports.store.findByKey(who.tenantId, key);
    if (existing) return replay(existing);
    // Another tenant's repository and an unknown one are the same 400.
    if (!(await reports.store.repositoryExists(who.tenantId, request.scope.repository_id))) {
      throw new AttestaQueryError('repository_id is not a repository of this tenant');
    }
    if (await reports.store.inputCount(who.tenantId, request.scope) > MAX_REPORT_STATEMENTS) {
      throw new AttestaQueryError('the period holds too many statements for one report');
    }
    if (await reports.store.openCount(who.tenantId) >= MAX_OPEN_REPORTS) {
      throw new ApiProblem(429, 'ATTESTA_API_RATE_LIMITED', { 'Retry-After': String(VERIFY_RETRY_AFTER_SECONDS * 6) });
    }
    const { job, created } = await reports.store.createOrGet({
      tenantId: who.tenantId, idempotencyKey: key, request, requestedBy: who.actorId, requestId: requestIdOf(res),
    });
    if (!created) return replay(job);
    startReport(who.tenantId, job.id);
    await audit(job, false);
    answer(job, false);
  }));

  router.get('/period-reports/:id', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    // Another tenant's id and an unknown id take the same path (one tenant-bound query, the same 404).
    const job = await reports.store.get(who.tenantId, reportIdOf(req));
    if (!job) throw new ApiProblem(404, 'ATTESTA_API_NOT_FOUND');
    sendJson(res, reportStatusBody(job, `${req.baseUrl}/period-reports`));
  }));

  router.get('/period-reports/:id/document', exportAuth, handle(async (req, res, who) => {
    if (Object.keys(query(req)).length > 0) throw new AttestaQueryError('unknown parameter');
    const id = reportIdOf(req);
    const job = await reports.store.get(who.tenantId, id);
    if (!job || job.status !== 'ready') throw new ApiProblem(404, 'ATTESTA_API_NOT_FOUND');
    // A stored document that does not hash to its digest is a 500, never a download.
    const body = documentBody(job, await reports.store.document(who.tenantId, id));
    await reports.store.audit({ tenantId: who.tenantId, actorId: who.actorId, actorRole: who.role, action: 'attesta.report.download',
      reportId: job.id, details: { request_id: requestIdOf(res), scope: job.scope, report_digest: job.reportDigest, statement_digest: job.statementDigest } });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="trackai-period-report-${job.id}.json"`);
    res.status(200).type('application/json').send(body);
  }));

  // Anything else under /api/attesta (unknown path, or a method no route serves).
  router.use(function attestaNotFound(_req, res) { sendProblem(res, 404, 'ATTESTA_API_NOT_FOUND'); });

  const onError: ErrorRequestHandler = function attestaError(err, _req, res, _next) {
    // Express refuses a malformed percent-encoded path parameter (URIError, status 400)
    // before any handler runs: a bad request, never a 500.
    if (err instanceof URIError || (err as { status?: unknown })?.status === 400) {
      if (!res.headersSent) sendProblem(res, 400, 'ATTESTA_API_INVALID_QUERY');
      return;
    }
    logFailure(log, res, 'ATTESTA_API_INTERNAL', err instanceof Error ? err.name : 'unknown');
    if (!res.headersSent) sendProblem(res, 500, 'ATTESTA_API_INTERNAL');
  };
  router.use(onError);
  return router;
}

/** The router app.ts mounts: real store, real middleware, the tenant's published keys, the real pack job. */
export const attestaRouter = createAttestaRouter();
