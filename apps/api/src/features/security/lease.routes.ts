/**
 * The three Task20f machine routes (security-v2 api.md; design note D4). This router is
 * mounted inside `createSecurityV2Router` (dependency injection only), so it runs behind
 * the v2 router's credential check, `no-store`, `X-Request-ID`, body limit and JSON
 * parser, and answers with the same closed RFC 7807 problems. Tenant and machine come
 * only from the managed machine credential; a foreign resource answers exactly like a
 * missing one. Logs carry codes only, never an id or a value.
 */
import { Router, type Request, type Response } from 'express';
import { defaultLog, requestIdOf, sendProblem, type SecurityV2Log } from '../security-findings/v2.routes';
import {
  AcknowledgementParseError,
  SecurityAcknowledgementNotFound,
  SecurityLeaseNotIssued,
  currentOrIssueLease,
  parseAcknowledgement,
  recordLeaseAcknowledgement,
  type SecurityLeaseStore,
} from './lease';
import type { SecurityDocumentSigner } from './signing';

export interface SecurityLeaseRouteDependencies {
  store: SecurityLeaseStore;
  /** The activation_lease signer, resolved per signature (signing-env.ts). */
  signer: SecurityDocumentSigner;
  now?: () => Date;
  log?: SecurityV2Log;
}

type V2Response = Response & { locals: { securityV2RequestId?: string } };

function identity(req: Request): { tenantId: string; machineId: string } | null {
  return req.managedMachineCredential === true && req.tenantId && req.machineId
    ? { tenantId: req.tenantId, machineId: req.machineId }
    : null;
}

function sendEnvelope(res: Response, envelope: Buffer): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).type('application/json').send(envelope);
}

export function createSecurityLeaseRouter(dependencies: SecurityLeaseRouteDependencies): Router {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLog;
  const router = Router();

  const fail = (res: V2Response, route: string, error: unknown) => {
    log(`security-v2 request_id=${requestIdOf(res)} route=${route} code=SECURITY_V2_INTERNAL${error instanceof Error ? ` error=${error.name}` : ''}`);
    if (!res.headersSent) sendProblem(res, 500, 'SECURITY_V2_INTERNAL');
  };

  router.get('/lease', async (req, res) => {
    const caller = identity(req);
    if (!caller) return sendProblem(res as V2Response, 403, 'SECURITY_V2_LEASE_REQUIRED');
    try {
      const lease = await currentOrIssueLease({ store: dependencies.store, signer: dependencies.signer, ...caller, now: now() });
      sendEnvelope(res, lease.envelope);
    } catch (error) {
      if (error instanceof SecurityLeaseNotIssued) return sendProblem(res as V2Response, 404, 'SECURITY_V2_LEASE_NOT_ISSUED');
      // SecuritySigningUnavailable and SecurityLeaseStateMoved land here too: never an
      // unsigned or stale lease.
      fail(res as V2Response, 'lease', error);
    }
  });

  router.get('/bundles/:sha256', async (req, res) => {
    const caller = identity(req);
    if (!caller) return sendProblem(res as V2Response, 403, 'SECURITY_V2_LEASE_REQUIRED');
    try {
      const digest = req.params.sha256;
      const envelope = /^[a-f0-9]{64}$/.test(digest)
        ? await dependencies.store.bundleEnvelope(caller.tenantId, digest)
        : null;
      if (!envelope) return sendProblem(res as V2Response, 404, 'SECURITY_V2_NOT_FOUND');
      sendEnvelope(res, envelope);
    } catch (error) {
      fail(res as V2Response, 'bundles', error);
    }
  });

  router.post('/acknowledgements', async (req, res) => {
    const caller = identity(req);
    if (!caller) return sendProblem(res as V2Response, 403, 'SECURITY_V2_LEASE_REQUIRED');
    try {
      const acknowledgement = parseAcknowledgement(req.body);
      await recordLeaseAcknowledgement({ store: dependencies.store, ...caller, acknowledgement, now: now() });
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
    } catch (error) {
      if (error instanceof AcknowledgementParseError) return sendProblem(res as V2Response, 400, error.code);
      if (error instanceof SecurityAcknowledgementNotFound) return sendProblem(res as V2Response, 404, 'SECURITY_V2_NOT_FOUND');
      fail(res as V2Response, 'acknowledgements', error);
    }
  });

  return router;
}
