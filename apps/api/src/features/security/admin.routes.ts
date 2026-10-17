/**
 * Security settings admin API (Task20f, T20.8), the base Task20i builds the console on:
 *
 *   GET /api/admin/security/settings   security_findings.read (admins and auditors)
 *   PUT /api/admin/security/settings   security.settings.manage (admins only); dry_run first
 *
 * AP-1 (SushiCorp AP-1 via features/qa/http.ts, copied rather than imported so each
 * feature keeps its own codes): RFC 7807 problems {type, title, status, code, request_id}
 * with fixed titles, the X-Request-ID echo, `Cache-Control: no-store` on every response,
 * and logs that carry codes only. The PUT is audited inside the publish transaction
 * (service.ts). Raw content never passes through here: settings are switches only.
 */
import { randomUUID } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { copyAdminAction, requireAdminAction } from '../../core/middleware/admin';
import { pinnedCatalogue } from './catalogue';
import { CompilerError } from './compiler';
import {
  SecuritySettingsConflict,
  applySecuritySettings,
  parseSettingsChange,
  planSecuritySettings,
  readSecuritySettings,
  type CurrentSecuritySettings,
  type SecuritySettingsPlan,
} from './service';
import { SecuritySettingsError } from './settings';
import { SecurityDocumentTooLarge, SecuritySigningUnavailable, type SecurityDocumentSigner } from './signing';
import { securitySignerFromEnv } from './signing-env';

export type SecuritySettingsCode =
  | 'SECURITY_SETTINGS_UNAUTHENTICATED'
  | 'SECURITY_SETTINGS_FORBIDDEN'
  | 'SECURITY_SETTINGS_INVALID'
  | 'SECURITY_SETTINGS_CONFLICT'
  | 'SECURITY_SETTINGS_TOO_LARGE'
  | 'SECURITY_SETTINGS_SIGNING_UNAVAILABLE'
  | 'SECURITY_SETTINGS_UNAVAILABLE';

const STATUS: Readonly<Record<SecuritySettingsCode, number>> = {
  SECURITY_SETTINGS_UNAUTHENTICATED: 401,
  SECURITY_SETTINGS_FORBIDDEN: 403,
  SECURITY_SETTINGS_INVALID: 400,
  SECURITY_SETTINGS_CONFLICT: 409,
  SECURITY_SETTINGS_TOO_LARGE: 413,
  SECURITY_SETTINGS_SIGNING_UNAVAILABLE: 503,
  SECURITY_SETTINGS_UNAVAILABLE: 503,
};

const TITLES: Readonly<Record<SecuritySettingsCode, string>> = {
  SECURITY_SETTINGS_UNAUTHENTICATED: 'Authentication is required',
  SECURITY_SETTINGS_FORBIDDEN: 'Administrator access is required',
  SECURITY_SETTINGS_INVALID: 'The settings change is invalid',
  SECURITY_SETTINGS_CONFLICT: 'The settings changed since this plan; plan again',
  SECURITY_SETTINGS_TOO_LARGE: 'The compiled rule bundle is too large to sign; override fewer rules',
  SECURITY_SETTINGS_SIGNING_UNAVAILABLE: 'Signing is unavailable; nothing was published',
  SECURITY_SETTINGS_UNAVAILABLE: 'The service is temporarily unavailable',
};

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function requestIdOf(res: Response): string {
  const id = res.locals.securitySettingsRequestId;
  return typeof id === 'string' ? id : '';
}

function http(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('X-Request-ID');
  const id = typeof supplied === 'string' && REQUEST_ID_RE.test(supplied) ? supplied : randomUUID();
  res.locals.securitySettingsRequestId = id;
  res.setHeader('X-Request-ID', id);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function sendProblem(res: Response, code: SecuritySettingsCode): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(STATUS[code]).type('application/problem+json').send(JSON.stringify({
    type: `https://trackai.dev/problems/${code}`, title: TITLES[code], status: STATUS[code], code, request_id: requestIdOf(res),
  }));
}

/** requireAdminAction answers with res.status(n).json(...): rewrite those to problems, keeping its action label. */
function problemizeAuth(middleware: RequestHandler): RequestHandler {
  return copyAdminAction(middleware, function securitySettingsAuthorize(req, res, next) {
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
      sendProblem(res, pending === 401 ? 'SECURITY_SETTINGS_UNAUTHENTICATED'
        : pending === 403 ? 'SECURITY_SETTINGS_FORBIDDEN' : 'SECURITY_SETTINGS_UNAVAILABLE');
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

/** The GET body: every rule with its upstream value beside it, the lease settings, the monitor mode and the bundle. */
export function settingsView(current: CurrentSecuritySettings) {
  const catalogue = pinnedCatalogue();
  return {
    schema_version: 'trackai.security-settings-view/1',
    numbat_commit: catalogue.manifest.numbat_commit,
    rule_settings_version: current.ruleSettingsVersion,
    rules: catalogue.manifest.rules.map(rule => ({
      id: rule.id,
      group: rule.group,
      enabled: current.rules[rule.id].enabled,
      severity: current.rules[rule.id].severity,
      upstream: { enabled: rule.enabled, severity: rule.severity, version: rule.version },
    })),
    data_settings_version: current.dataSettingsVersion,
    data_settings: current.lease.data,
    agents: current.lease.agents,
    day_one_scan: current.lease.dayOneScan,
    monitor: current.monitor,
    bundle: current.bundle ? {
      bundle_version: current.bundle.bundleVersion,
      epoch: current.bundle.epoch,
      digest: current.bundle.digest,
      issued_at: current.bundle.issuedAt.toISOString(),
      enabled_rule_count: current.bundle.enabledRuleCount,
    } : null,
  };
}

/** The dry-run body: what would change, and how many active machines it reaches. */
export function planView(plan: SecuritySettingsPlan) {
  return {
    schema_version: 'trackai.security-settings-plan/1',
    dry_run: true,
    rule_changes: plan.ruleChanges,
    data_settings_changed: plan.leaseChanged,
    monitor: { from: plan.current.monitor.mode, to: plan.monitorMode },
    publishes_bundle: plan.publishesBundle,
    next: {
      rule_settings_version: plan.next.ruleSettingsVersion,
      data_settings_version: plan.next.dataSettingsVersion,
      monitor_version: plan.next.monitorVersion,
      bundle_version: plan.next.bundleVersion,
      epoch: plan.next.epoch,
    },
    active_machine_count: plan.activeMachineCount,
  };
}

export interface SecuritySettingsRouterDeps {
  /** Test seams; production uses requireAdminAction and the environment's policy_bundle signer. */
  authorizeRead?: RequestHandler;
  authorizeWrite?: RequestHandler;
  signer?: () => SecurityDocumentSigner;
  log?: (line: string) => void;
}

export function createSecuritySettingsAdminRouter(deps: SecuritySettingsRouterDeps = {}): Router {
  const log = deps.log ?? ((line: string) => console.error(line));
  const signer = deps.signer ?? (() => securitySignerFromEnv('policy_bundle'));
  const router = Router();
  router.use(http);
  router.use(express.json({ limit: '256kb' }));

  router.get('/settings', problemizeAuth(deps.authorizeRead ?? requireAdminAction('security_findings.read')), async (req, res) => {
    try {
      res.status(200).json(settingsView(await readSecuritySettings(req.tenantId as string)));
    } catch {
      log(`security-settings code=SECURITY_SETTINGS_UNAVAILABLE request_id=${requestIdOf(res)}`);
      sendProblem(res, 'SECURITY_SETTINGS_UNAVAILABLE');
    }
  });

  router.put('/settings', problemizeAuth(deps.authorizeWrite ?? requireAdminAction('security.settings.manage')), async (req, res) => {
    let parsed: ReturnType<typeof parseSettingsChange>;
    try {
      parsed = parseSettingsChange(req.body);
    } catch {
      sendProblem(res, 'SECURITY_SETTINGS_INVALID');
      return;
    }
    const tenantId = req.tenantId as string;
    try {
      if (parsed.dryRun) {
        res.status(200).json(planView(await planSecuritySettings(tenantId, parsed.change)));
        return;
      }
      const applied = await applySecuritySettings({
        tenantId,
        // The write guard admits tenant administrators only (security.settings.manage).
        actor: { type: 'tenant_admin', id: req.user?.sub as string },
        change: parsed.change,
        requestId: requestIdOf(res),
      }, { signer: signer() });
      res.status(200).json({
        schema_version: 'trackai.security-settings-applied/1',
        dry_run: false,
        changed: applied.changed,
        rule_settings_version: applied.ruleSettingsVersion,
        data_settings_version: applied.dataSettingsVersion,
        monitor_version: applied.monitorVersion,
        bundle: applied.bundle ? {
          bundle_version: applied.bundle.bundleVersion,
          epoch: applied.bundle.epoch,
          digest: applied.bundle.digest,
          issued_at: applied.bundle.issuedAt.toISOString(),
        } : null,
      });
    } catch (err) {
      const code: SecuritySettingsCode = err instanceof SecuritySettingsError || err instanceof CompilerError ? 'SECURITY_SETTINGS_INVALID'
        : err instanceof SecuritySettingsConflict ? 'SECURITY_SETTINGS_CONFLICT'
          : err instanceof SecurityDocumentTooLarge ? 'SECURITY_SETTINGS_TOO_LARGE'
          : err instanceof SecuritySigningUnavailable ? 'SECURITY_SETTINGS_SIGNING_UNAVAILABLE'
            : 'SECURITY_SETTINGS_UNAVAILABLE';
      log(`security-settings code=${code} request_id=${requestIdOf(res)}`);
      sendProblem(res, code);
    }
  });

  router.use(((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    sendProblem(res, (err as { type?: string } | null)?.type === 'entity.parse.failed' || (err as { type?: string } | null)?.type === 'entity.too.large'
      ? 'SECURITY_SETTINGS_INVALID' : 'SECURITY_SETTINGS_UNAVAILABLE');
  }) as express.ErrorRequestHandler);
  return router;
}

export const securitySettingsAdminRouter = createSecuritySettingsAdminRouter();
