/**
 * IT-T20f-01, part (a) (docs/prompts/Task20): drives the real security settings admin
 * router over HTTP against the throwaway TrackAI database — settings → dry run (nothing
 * written) → publish → a signed rule bundle that `verifyTrusted` accepts (policy_bundle,
 * platform, production) with the exact stored bytes, the monotonic epoch, a data-only
 * change that makes no bundle, a concurrent publish refused as stale, signing unavailable
 * writing nothing, append-only history, the audit rows, and Company A / Company B.
 * Part (b) (leases, the machine routes, the authority and ingest) extends this file.
 *
 * Run: IT_PG_DATABASES=trackai_task20f_signing_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20f_signing_live \
 *        scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api
 * The Supabase JWT layer is replaced by an injected authorizer that sets the tenant and
 * subject (the guards themselves are covered by the auditor sweep and admin.test.ts).
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  securityAuditEvents,
  securityDataSettingsVersions,
  securityRuleBundles,
  securityRuleSettingsVersions,
  ssoTenants,
} from '../../core/db/schema';
import { registerDeveloperMachine } from '../../core/security/machine-security-service';
import type { DsseEnvelope } from '../attesta/dsse';
import { createSecuritySettingsAdminRouter } from './admin.routes';
import { bundleEnvelopeByDigest } from './service';
import { SecuritySigningUnavailable, type SecurityDocumentSigner } from './signing';
import { trustFixture } from './testing/trust-fixture';

interface HttpResult {
  status: number;
  cacheControl: string | null;
  body: Record<string, unknown>;
}

async function call(base: string, method: 'GET' | 'PUT', tenantId: string, body?: unknown): Promise<HttpResult> {
  const response = await fetch(`${base}/api/admin/security/settings`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-tenant': tenantId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> };
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await db.select({ action: securityAuditEvents.action }).from(securityAuditEvents)
    .where(eq(securityAuditEvents.tenantId, tenantId));
  return rows.map(row => row.action).filter(action => action.startsWith('security.') || action.startsWith('policy.')).sort();
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (it-db.sh sets it)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) || databaseUrl.pathname !== '/trackai_task20f_signing_live') {
    throw new Error('Task20f live verification requires the exact disposable local database');
  }

  const fixture = trustFixture(new Date());
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const suffix = randomUUID();
  const actorId = 'task20f-live-verifier';
  let signer: SecurityDocumentSigner = fixture.signer('policy_bundle');
  const authorize: RequestHandler = (req, _res, next) => {
    req.tenantId = req.get('x-test-tenant');
    req.user = { sub: '55555555-5555-4555-8555-555555555555' } as typeof req.user;
    next();
  };
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin/security', createSecuritySettingsAdminRouter({
    authorizeRead: authorize, authorizeWrite: authorize, signer: () => signer, log: () => undefined,
  }));
  let server: Server | undefined;
  try {
    await db.insert(ssoTenants).values([
      { id: tenantA, companyName: 'Task20f Live A', domain: `task20f-live-a-${suffix}.invalid`, supabaseProviderId: `task20f-live-a-${suffix}` },
      { id: tenantB, companyName: 'Task20f Live B', domain: `task20f-live-b-${suffix}.invalid`, supabaseProviderId: `task20f-live-b-${suffix}` },
    ]);
    for (const [tenantId, name] of [[tenantA, 'x'], [tenantA, 'y'], [tenantB, 'x']] as const) {
      await registerDeveloperMachine({ tenantId, installationId: `task20f-live-${name}-${tenantId}`, displayName: `Task20f ${name}`, actorId });
    }
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // 1. Defaults: the default policy (44 of 51 on), all data switches off, monitor off, no bundle.
    const initial = await call(base, 'GET', tenantA);
    assert.equal(initial.status, 200);
    assert.equal(initial.cacheControl, 'no-store');
    assert.equal(initial.body.rule_settings_version, 0);
    assert.equal((initial.body.rules as Array<{ enabled: boolean }>).filter(rule => rule.enabled).length, 44);
    assert.equal(initial.body.bundle, null);
    assert.deepEqual(initial.body.monitor, { mode: 'off', version: 0 });

    // 2. Dry run: the plan names the change and the machine count, and writes nothing.
    const change = { reason: 'turn on monitoring', monitor_mode: 'monitor', rules: { 'secrets.agent_read_env': { enabled: true } } };
    const plan = await call(base, 'PUT', tenantA, { dry_run: true, ...change });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.publishes_bundle, true);
    assert.equal(plan.body.active_machine_count, 2);
    assert.deepEqual((plan.body.rule_changes as Array<{ id: string }>).map(rule => rule.id), ['secrets.agent_read_env']);
    const [{ value: bundlesAfterPlan }] = await db.select({ value: sql<number>`count(*)::int` }).from(securityRuleBundles)
      .where(eq(securityRuleBundles.tenantId, tenantA));
    assert.equal(bundlesAfterPlan, 0, 'dry run wrote no bundle');
    assert.deepEqual(await auditActions(tenantA), [], 'dry run wrote no audit row');

    // 3. Signing unavailable: 503, nothing written.
    signer = { purpose: 'policy_bundle', resolve: async () => { throw new SecuritySigningUnavailable('no key'); } };
    const refused = await call(base, 'PUT', tenantA, { dry_run: false, ...change });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'SECURITY_SETTINGS_SIGNING_UNAVAILABLE');
    assert.deepEqual(await auditActions(tenantA), [], 'unavailable signing wrote nothing');
    signer = fixture.signer('policy_bundle');

    // 4. Publish: rule settings v1, monitor v1, bundle v1 epoch 1, three audit rows.
    const published = await call(base, 'PUT', tenantA, { dry_run: false, ...change });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const bundle1 = published.body.bundle as { epoch: number; digest: string; bundle_version: number };
    assert.deepEqual([published.body.rule_settings_version, published.body.monitor_version, bundle1.bundle_version, bundle1.epoch], [1, 1, 1, 1]);
    assert.deepEqual(await auditActions(tenantA), ['policy.bundle.published', 'security.monitor.changed', 'security.settings.changed']);

    // 5. The stored bytes are the signed envelope; verifyTrusted accepts them; the digest is SHA-256 of the payload.
    const stored = await bundleEnvelopeByDigest(tenantA, bundle1.digest);
    assert.ok(stored);
    const envelope = JSON.parse(stored.toString('utf8')) as DsseEnvelope;
    const payload = Buffer.from(envelope.payload, 'base64');
    assert.equal(createHash('sha256').update(payload).digest('hex'), bundle1.digest);
    const parsed = JSON.parse(payload.toString('utf8')) as { tenant_id: string; epoch: number; issued_at: string; agents: Record<string, { enabled_rule_ids: string[] }> };
    assert.equal(parsed.tenant_id, tenantA);
    assert.equal(parsed.agents.codex.enabled_rule_ids.length, 45, 'one noisy rule re-enabled');
    const verdict = fixture.verify({ envelope, purpose: 'policy_bundle', signedAt: parsed.issued_at, now: new Date() });
    assert.equal(verdict.status, 'verified', verdict.code);

    // 6. A data-only change: data settings v1, no new bundle.
    const data = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'paths', data_settings: { file_paths: true }, agents: ['claude-code', 'codex'] });
    assert.equal(data.status, 200);
    assert.equal(data.body.data_settings_version, 1);
    assert.equal((data.body.bundle as { epoch: number }).epoch, 1);
    const [dataRow] = await db.select().from(securityDataSettingsVersions).where(eq(securityDataSettingsVersions.tenantId, tenantA));
    assert.deepEqual([dataRow.filePaths, dataRow.commandPreviews, dataRow.agents], [true, false, ['claude-code', 'codex']]);

    // 7. Concurrent publishes: the slow one finds the settings moved and is refused; the epoch only goes up.
    const slow: SecurityDocumentSigner = {
      purpose: 'policy_bundle',
      resolve: async () => { await new Promise(resolve => setTimeout(resolve, 400)); return fixture.signer('policy_bundle').resolve(); },
    };
    signer = slow;
    const first = call(base, 'PUT', tenantA, { dry_run: false, reason: 'slow', rules: { 'exec.agent_runtime_bypass_flags': { enabled: true } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    signer = fixture.signer('policy_bundle');
    const second = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'fast', rules: { 'persistence.git_hook_write': { enabled: true } } });
    const slowResult = await first;
    assert.equal(second.status, 200);
    assert.equal((second.body.bundle as { epoch: number }).epoch, 2);
    assert.equal(slowResult.status, 409);
    assert.equal(slowResult.body.code, 'SECURITY_SETTINGS_CONFLICT');
    const third = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'retry', rules: { 'exec.agent_runtime_bypass_flags': { enabled: true } } });
    assert.equal((third.body.bundle as { epoch: number }).epoch, 3);
    assert.equal(third.body.rule_settings_version, 3);

    // 8. Company B sees none of it, and cannot fetch A's bundle by digest.
    const other = await call(base, 'GET', tenantB);
    assert.equal(other.body.rule_settings_version, 0);
    assert.equal(other.body.bundle, null);
    assert.equal(await bundleEnvelopeByDigest(tenantB, bundle1.digest), null);
    assert.deepEqual(await auditActions(tenantB), []);

    // 9. History is append-only.
    for (const statement of [
      sql`update security_rule_bundles set epoch = epoch + 100 where tenant_id = ${tenantA}::uuid`,
      sql`delete from security_rule_settings_versions where tenant_id = ${tenantA}::uuid`,
      sql`delete from security_data_settings_versions where tenant_id = ${tenantA}::uuid`,
    ]) {
      // Drizzle wraps the driver error; the trigger's message is on its cause.
      await assert.rejects(db.execute(statement), (error: unknown) => /append-only/.test(String((error as { cause?: Error }).cause?.message)));
    }
    const versions = await db.select({ version: securityRuleSettingsVersions.version }).from(securityRuleSettingsVersions)
      .where(and(eq(securityRuleSettingsVersions.tenantId, tenantA)));
    assert.deepEqual(versions.map(row => row.version).sort(), [1, 2, 3]);

    // 10. An invalid change is a 400 problem that names no value.
    const invalid = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'x', rules: { 'not.a.rule': { enabled: false } } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'SECURITY_SETTINGS_INVALID');
    assert.ok(!JSON.stringify(invalid.body).includes('not.a.rule'));

    console.log('settings_defaults=44_of_51_on_no_bundle');
    console.log('dry_run=nothing_written');
    console.log('signing_unavailable=nothing_written');
    console.log('bundle=verifyTrusted_verified_exact_stored_bytes');
    console.log('epoch=monotonic_1_2_3_concurrent_publish_refused');
    console.log('history=append_only');
    console.log('tenant_isolation=company_b_sees_nothing');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => (error ? reject(error) : resolve())));
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task20f live verification failed');
  process.exitCode = 1;
});
