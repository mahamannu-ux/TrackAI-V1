/**
 * Q&A routes (Task19a, T19.2; docs/contracts/qa/api.md):
 *
 *   GET /questions                  the registry, unpaged (a fixed catalogue, at most 100 entries)
 *   GET /questions/:id              one entry, and per kind whether an answer is built
 *   GET /questions/:id/answer       one envelope (answer-v1.schema.json)
 *   GET /questions/:id/drilldown    defined now; 501 QA_DRILLDOWN_NOT_BUILT until Task19b
 *
 * Mounted in app.ts as `/api/qa`, after `/api`'s JWT and tenant middleware. The whole
 * router uses requireAdminAction('qa.read') (admins and auditors); the service refuses
 * `kind=live` to auditors (D2). Handlers stay thin; logic lives in service.ts.
 * Reading an answer is not audited (aggregates, like /api/metrics/lifecycle).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAdminAction } from '../../core/middleware/admin';
import { defaultAnswerers, type AnswererRegistry } from './answerers';
import './answers/register-code';
import './security-answerers';
import './auditor/register-auditor';
import type { QaContext } from './answers/common';
import { defaultLog, logFailure, problemizeAuth, qaHttp, sendJson, sendProblem, type QaLog } from './http';
import { QA_QUESTIONS, QA_REGISTRY_VERSION } from './registry';
import {
  QaProblem, answerDrilldown, answerQuestion, checkDrilldownRequest, describeQuestion, findQuestion, pgScopeStore,
  type QaScopeStore,
} from './service';
import type { QaRole } from './types';

export interface QaRouterDeps {
  authorize?: RequestHandler;
  answerers?: AnswererRegistry;
  scopes?: QaScopeStore;
  log?: QaLog;
  now?: () => Date;
  /** Loads the Task2 context for drill-downs; tests inject a synthetic one. */
  contextLoader?: (tenantId: string) => Promise<QaContext>;
}

interface Who { tenantId: string; role: QaRole }

function actor(req: Request): Who | null {
  const tenantId = req.tenantId;
  const subject = req.user?.sub;
  const role = req.adminRole;
  if (!tenantId || !subject || (role !== 'tenant_admin' && role !== 'tenant_auditor')) return null;
  return { tenantId, role };
}

const query = (req: Request) => req.query as Record<string, unknown>;
const idParam = (req: Request): string => String(req.params.id);

export function createQaRouter(deps: QaRouterDeps = {}): Router {
  const answerers = deps.answerers ?? defaultAnswerers;
  const scopes = deps.scopes ?? pgScopeStore;
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const contextLoader = deps.contextLoader;

  const router = Router();
  router.use(qaHttp);
  router.use(problemizeAuth(deps.authorize ?? requireAdminAction('qa.read')));

  /** Runs a handler with the actor; QaProblem → its problem, anything else → 503. */
  const handle = (fn: (req: Request, res: Response, who: Who) => Promise<void> | void): RequestHandler =>
    async (req, res) => {
      const who = actor(req);
      if (!who) {
        sendProblem(res, 'QA_FORBIDDEN');
        return;
      }
      try {
        await fn(req, res, who);
      } catch (err) {
        const code = err instanceof QaProblem ? err.code : 'QA_UNAVAILABLE';
        if (code === 'QA_ANSWER_INVALID' || code === 'QA_UNAVAILABLE') {
          const cause = err instanceof QaProblem ? err.cause_ ?? code : (err instanceof Error ? err.name : 'unknown');
          logFailure(log, res, code, cause);
        }
        if (!res.headersSent) sendProblem(res, code);
      }
    };

  router.get('/questions', handle((_req, res) => {
    sendJson(res, { registry_version: QA_REGISTRY_VERSION, items: QA_QUESTIONS });
  }));

  router.get('/questions/:id', handle((req, res) => {
    sendJson(res, describeQuestion(findQuestion(idParam(req)), answerers));
  }));

  router.get('/questions/:id/answer', handle(async (req, res, who) => {
    const envelope = await answerQuestion({ answerers, scopes }, {
      tenantId: who.tenantId, role: who.role, questionId: idParam(req), query: query(req), now: now(),
    });
    sendJson(res, envelope);
  }));

  router.get('/questions/:id/drilldown', handle(async (req, res, who) => {
    checkDrilldownRequest({
      tenantId: who.tenantId, role: who.role, questionId: idParam(req), query: query(req), now: now(),
    });
    const page = await answerDrilldown({ answerers, scopes, ...(contextLoader ? { contextLoader } : {}) }, {
      tenantId: who.tenantId, role: who.role, questionId: idParam(req), query: query(req), now: now(),
    });
    sendJson(res, page);
  }));

  return router;
}

export const qaRouter = createQaRouter();
