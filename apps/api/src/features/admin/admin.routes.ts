import { Router, type Request, type Response } from 'express';
import { requireAdminAction } from '../../core/middleware/admin';
import { lookupAdminMembership } from '../../core/security/admin-security-service';
import {
  listAdminBackfillAuthorizations,
  listAdminMachines,
  listAdminRepositoryPolicies,
  listSecurityAuditEvents,
} from '../../core/security/admin-resource-service';
import {
  issueMachineCredential,
  registerDeveloperMachine,
  revokeDeveloperMachine,
  revokeMachineCredential,
} from '../../core/security/machine-security-service';
import {
  authorizeRepositoryBackfill,
  enrollRepository,
  grantMachineRepository,
  replaceMachineRepositoryGrantBranchScope,
  revokeMachineRepositoryGrant,
  revokeRepositoryBackfillAuthorization,
  revokeRepositoryEnrollment,
} from '../../core/security/repository-security-service';
import {
  createGitHubAppInstallation,
  finishGitHubAppCredentialRotation,
  listGitHubAppInstallations,
  revokeGitHubAppInstallation,
  rotateGitHubAppCredential,
} from '../../core/security/github-app-security-service';
import {
  listTenantRetentionPolicies,
  replaceTenantRetentionPolicy,
} from '../../core/operations/retention-policy-service';
import {
  createTenantEvidenceExport,
  listTenantEvidenceExports,
  planTenantEvidenceExport,
  readTenantEvidenceExport,
} from '../../core/operations/evidence-export-service';
import { LocalFileEvidenceExportSink } from '../../core/operations/evidence-export-sink';
import { planTenantRetentionRun } from '../../core/operations/retention-run-service';
import { getTenantOperationalMonitoring } from '../../core/operations/operational-monitoring-service';

const router = Router();
const requireGitHubAdmin = requireAdminAction('github_app.manage');
const requireMachineAdmin = requireAdminAction('machine.manage');
const requireRepositoryAdmin = requireAdminAction('repository.manage');
const requireBackfillAdmin = requireAdminAction('backfill.manage');
const requireAuditRead = requireAdminAction('audit.read');
const requireOperationsRead = requireAdminAction('operations.read');
const requireRetentionAdmin = requireAdminAction('retention.manage');
const requireExportAdmin = requireAdminAction('export.manage');

function requiredString(value: unknown, name: string, maxLength = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32 || entries.some(([key, item]) => (
    !/^[a-z_]{1,64}$/.test(key) || typeof item !== 'string'
  ))) {
    throw new Error(`${name} is invalid`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

function dateValue(value: unknown, name: string): Date {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed;
}

function optionalDateValue(value: unknown, name: string): Date | undefined {
  return value === undefined || value === null || value === '' ? undefined : dateValue(value, name);
}

function uuidValue(value: unknown, name: string): string {
  const parsed = requiredString(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error(`${name} must be a UUID`);
  }
  return parsed;
}

function requestIdentity(req: Request): { tenantId: string; actorId: string } {
  if (!req.tenantId || !req.user?.sub) throw new Error('Administrator identity is unavailable');
  return { tenantId: req.tenantId, actorId: req.user.sub };
}

function badRequest(res: Response, error: unknown): void {
  res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
}

// This only reports the caller's own verified identity and membership. It does
// not grant access; operators use the exact subject for fail-closed bootstrap.
router.get('/context', async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const membership = await lookupAdminMembership(identity.tenantId, identity.actorId);
    res.json({
      tenantId: identity.tenantId,
      subject: identity.actorId,
      email: req.user?.email ?? null,
      membership: membership ? {
        id: membership.id,
        role: membership.role,
        status: membership.status,
        revokedAt: membership.revokedAt,
      } : null,
    });
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/machines', requireMachineAdmin, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await listAdminMachines(tenantId));
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/repository-policies', requireRepositoryAdmin, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await listAdminRepositoryPolicies(tenantId));
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/backfill-authorizations', requireBackfillAdmin, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json({ authorizations: await listAdminBackfillAuthorizations(tenantId) });
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/audit', requireAuditRead, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    const requested = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const limit = Number.isFinite(requested) ? requested : 100;
    res.json({ events: await listSecurityAuditEvents(tenantId, limit) });
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/operations/retention-policy', requireOperationsRead, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await listTenantRetentionPolicies(tenantId));
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/operations/retention-policy', requireRetentionAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const mode = requiredString(req.body?.mode, 'mode');
    if (mode !== 'retain' && mode !== 'archive_then_purge') {
      throw new Error('mode must be retain or archive_then_purge');
    }
    const retentionDaysValue = req.body?.retentionDays;
    const retentionDays = retentionDaysValue === null || retentionDaysValue === undefined
      ? null
      : Number(retentionDaysValue);
    if (retentionDays !== null && !Number.isInteger(retentionDays)) {
      throw new Error('retentionDays must be an integer');
    }
    const policy = await replaceTenantRetentionPolicy({
      ...identity,
      mode,
      retentionDays,
      reason: requiredString(req.body?.reason, 'reason', 1_000),
    });
    res.status(201).json({ policy });
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/operations/retention-plan', requireOperationsRead, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await planTenantRetentionRun({ tenantId }));
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/operations/monitoring', requireOperationsRead, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await getTenantOperationalMonitoring({ tenantId }));
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/operations/exports', requireOperationsRead, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json({ exports: await listTenantEvidenceExports(tenantId) });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/operations/exports/plan', requireExportAdmin, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json(await planTenantEvidenceExport({
      tenantId,
      scopeFrom: dateValue(req.body?.scopeFrom, 'scopeFrom'),
      scopeUntil: dateValue(req.body?.scopeUntil, 'scopeUntil'),
    }));
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/operations/exports', requireExportAdmin, async (req, res) => {
  try {
    if (req.body?.apply !== true) throw new Error('apply must be true after reviewing an export plan');
    const exportDirectory = process.env.TASK4_EXPORT_DIR;
    if (!exportDirectory) throw new Error('TASK4_EXPORT_DIR is required');
    const identity = requestIdentity(req);
    const result = await createTenantEvidenceExport({
      ...identity,
      scopeFrom: dateValue(req.body?.scopeFrom, 'scopeFrom'),
      scopeUntil: dateValue(req.body?.scopeUntil, 'scopeUntil'),
      archivePurpose: req.body?.archivePurpose === true,
      reason: requiredString(req.body?.reason, 'reason', 1_000),
      sink: new LocalFileEvidenceExportSink(exportDirectory),
    });
    res.status(201).json(result);
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/operations/exports/:id/download', requireExportAdmin, async (req, res) => {
  try {
    const exportDirectory = process.env.TASK4_EXPORT_DIR;
    if (!exportDirectory) throw new Error('TASK4_EXPORT_DIR is required');
    const { tenantId } = requestIdentity(req);
    const result = await readTenantEvidenceExport({
      tenantId,
      exportJobId: uuidValue(req.params.id, 'exportJobId'),
      sink: new LocalFileEvidenceExportSink(exportDirectory),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trackai-evidence-export-${result.job.id}.json"`);
    res.send(result.content);
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/machines', requireMachineAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const machine = await registerDeveloperMachine({
      ...identity,
      installationId: requiredString(req.body?.installationId, 'installationId'),
      displayName: requiredString(req.body?.displayName, 'displayName'),
      platform: req.body?.platform === undefined
        ? undefined
        : requiredString(req.body.platform, 'platform'),
    });
    res.status(201).json({ machine });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/machines/:id/credentials', requireMachineAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const credential = await issueMachineCredential({
      ...identity,
      machineId: uuidValue(req.params.id, 'machineId'),
      expiresAt: optionalDateValue(req.body?.expiresAt, 'expiresAt'),
      rotatedFromCredentialId: req.body?.rotatedFromCredentialId === undefined
        ? undefined
        : uuidValue(req.body.rotatedFromCredentialId, 'rotatedFromCredentialId'),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ credential });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/machine-credentials/:id/revoke', requireMachineAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeMachineCredential(
      identity.tenantId,
      uuidValue(req.params.id, 'credentialId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/machines/:id/revoke', requireMachineAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeDeveloperMachine(
      identity.tenantId,
      uuidValue(req.params.id, 'machineId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/repository-enrollments', requireRepositoryAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const enrollment = await enrollRepository({
      ...identity,
      repositoryId: uuidValue(req.body?.repositoryId, 'repositoryId'),
      reason: req.body?.reason === undefined ? undefined : requiredString(req.body.reason, 'reason', 1_000),
      effectiveFrom: optionalDateValue(req.body?.effectiveFrom, 'effectiveFrom'),
      effectiveUntil: optionalDateValue(req.body?.effectiveUntil, 'effectiveUntil'),
      generationSessionEvidenceFrom: optionalDateValue(
        req.body?.generationSessionEvidenceFrom,
        'generationSessionEvidenceFrom',
      ),
      commitNoteEvidenceFrom: optionalDateValue(
        req.body?.commitNoteEvidenceFrom,
        'commitNoteEvidenceFrom',
      ),
    });
    res.status(201).json({ enrollment });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/repository-enrollments/:id/revoke', requireRepositoryAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeRepositoryEnrollment(
      identity.tenantId,
      uuidValue(req.params.id, 'enrollmentId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/repository-grants', requireRepositoryAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const grant = await grantMachineRepository({
      ...identity,
      machineId: uuidValue(req.body?.machineId, 'machineId'),
      enrollmentId: uuidValue(req.body?.enrollmentId, 'enrollmentId'),
      branchPatterns: stringArray(req.body?.branchPatterns, 'branchPatterns'),
      reason: req.body?.reason === undefined ? undefined : requiredString(req.body.reason, 'reason', 1_000),
      effectiveFrom: optionalDateValue(req.body?.effectiveFrom, 'effectiveFrom'),
      effectiveUntil: optionalDateValue(req.body?.effectiveUntil, 'effectiveUntil'),
    });
    res.status(201).json({ grant });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/repository-grants/:id/revoke', requireRepositoryAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeMachineRepositoryGrant(
      identity.tenantId,
      uuidValue(req.params.id, 'grantId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/repository-grants/:id/branch-scope', requireRepositoryAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const grant = await replaceMachineRepositoryGrantBranchScope({
      ...identity,
      grantId: uuidValue(req.params.id, 'grantId'),
      branchPatterns: stringArray(req.body?.branchPatterns, 'branchPatterns'),
      reason: requiredString(req.body?.reason, 'reason', 1_000),
    });
    res.status(201).json({ grant });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/backfill-authorizations', requireBackfillAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const evidenceFamily = requiredString(req.body?.evidenceFamily, 'evidenceFamily');
    if (evidenceFamily !== 'generation_session' && evidenceFamily !== 'commit_note') {
      throw new Error('evidenceFamily must be generation_session or commit_note');
    }
    const authorization = await authorizeRepositoryBackfill({
      ...identity,
      enrollmentId: uuidValue(req.body?.enrollmentId, 'enrollmentId'),
      evidenceFamily,
      occurredFrom: dateValue(req.body?.occurredFrom, 'occurredFrom'),
      occurredUntil: dateValue(req.body?.occurredUntil, 'occurredUntil'),
      expiresAt: dateValue(req.body?.expiresAt, 'expiresAt'),
      reason: requiredString(req.body?.reason, 'reason', 1_000),
    });
    res.status(201).json({ authorization });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/backfill-authorizations/:id/revoke', requireBackfillAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeRepositoryBackfillAuthorization(
      identity.tenantId,
      uuidValue(req.params.id, 'authorizationId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.get('/github-app/installations', requireGitHubAdmin, async (req, res) => {
  try {
    const { tenantId } = requestIdentity(req);
    res.json({ installations: await listGitHubAppInstallations(tenantId) });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/github-app/installations', requireGitHubAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const privateKey = requiredString(req.body?.privateKey, 'privateKey', 32_768);
    const result = await createGitHubAppInstallation({
      ...identity,
      providerHost: req.body?.providerHost === undefined
        ? undefined
        : requiredString(req.body.providerHost, 'providerHost'),
      appId: requiredString(req.body?.appId, 'appId'),
      installationExternalId: requiredString(
        req.body?.installationExternalId,
        'installationExternalId',
      ),
      accountLogin: requiredString(req.body?.accountLogin, 'accountLogin'),
      permissions: stringRecord(req.body?.permissions, 'permissions'),
      subscribedEvents: stringArray(req.body?.subscribedEvents, 'subscribedEvents'),
      privateKey,
    });
    res.status(201).json(result);
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/github-app/installations/:id/credentials/rotate', requireGitHubAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    const credential = await rotateGitHubAppCredential({
      ...identity,
      installationId: requiredString(req.params.id, 'installationId'),
      privateKey: requiredString(req.body?.privateKey, 'privateKey', 32_768),
      overlapUntil: dateValue(req.body?.overlapUntil, 'overlapUntil'),
    });
    res.status(201).json({ credential });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/github-app/installations/:id/credentials/finish', requireGitHubAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await finishGitHubAppCredentialRotation(
      identity.tenantId,
      requiredString(req.params.id, 'installationId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

router.post('/github-app/installations/:id/revoke', requireGitHubAdmin, async (req, res) => {
  try {
    const identity = requestIdentity(req);
    await revokeGitHubAppInstallation(
      identity.tenantId,
      requiredString(req.params.id, 'installationId'),
      identity.actorId,
      requiredString(req.body?.reason, 'reason', 1_000),
    );
    res.json({ ok: true });
  } catch (error) {
    badRequest(res, error);
  }
});

export default router;
