/**
 * IT-T20f-01, part (a) (docs/prompts/Task20): drives the real security settings admin
 * router over HTTP against the throwaway TrackAI database — settings → dry run (nothing
 * written) → publish → a signed rule bundle that `verifyTrusted` accepts (policy_bundle,
 * platform, production) with the exact stored bytes, the monotonic epoch, a data-only
 * change that makes no bundle, a concurrent publish refused as stale, signing unavailable
 * writing nothing, append-only history, the audit rows, and Company A / Company B.
 * Part (b) continues against the same database with real machine credentials over HTTP:
 * a signed lease (`activation_lease`) issued lazily and reused, `GET /lease` and
 * `GET /bundles/{sha256}` exact bytes, acknowledgements, a Task20d ingest upload accepted
 * through the real authority and real storage, expiry and `off` refused, machine X/Y and
 * Company A/B (api.md cases 3–8), append-only lease history, the audit rows, and fleet
 * configuration v3 through the database check.
 *
 * Run: IT_PG_DATABASES=trackai_task20f_signing_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20f_signing_live \
 *        scripts/it-db.sh npm run verify:task20f-signing-live -w apps/api
 * The Supabase JWT layer is replaced by an injected authorizer that sets the tenant and
 * subject (the guards themselves are covered by the auditor sweep and admin.test.ts).
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  fleetConfigurations,
  securityAcknowledgements,
  securityActivationLeases,
  securityAuditEvents,
  securityDataSettingsVersions,
  securityRuleBundles,
  securityRuleSettingsVersions,
  ssoTenants,
  tenantSecurityMonitorSettings,
} from '../../core/db/schema';
import { authenticateMachine } from '../../core/middleware/machine-auth';
import { issueMachineCredential, registerDeveloperMachine } from '../../core/security/machine-security-service';
import { assignFleetConfiguration, createFleetConfiguration, FleetServiceError, getFleetConfiguration } from '../fleet/service';
import { createSecurityFindingsRouter } from '../security-findings/security-findings.routes';
import { SECURITY_V2_NUMBAT_SCHEMA } from '../security-findings/v2-contract';
import { createSecurityV2Authority } from './authority';
import { LEASE_VALIDITY_MS } from './lease';
import { pgSecurityLeaseStore } from './lease-store';
import { createSecurityLeaseRouter } from './lease.routes';
import type { DsseEnvelope } from '../attesta/dsse';
import { createSecuritySettingsAdminRouter } from './admin.routes';
import { pinnedCatalogue } from './catalogue';
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

interface MachineResult {
  status: number;
  cacheControl: string | null;
  bytes: Buffer;
  json(): Record<string, unknown>;
}

async function machineCall(base: string, credential: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<MachineResult> {
  const response = await fetch(`${base}/worker/security/v2${path}`, {
    method,
    headers: { 'x-api-key': credential, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status, cacheControl: response.headers.get('cache-control'), bytes,
    json: () => JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
  };
}

function leaseOf(bytes: Buffer): { envelope: DsseEnvelope; payload: Record<string, unknown> } {
  const envelope = JSON.parse(bytes.toString('utf8')) as DsseEnvelope;
  return { envelope, payload: JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Record<string, unknown> };
}

function findingUnder(leaseId: unknown, detectedAt: Date) {
  return {
    schema_version: 'trackai.security-upload/2',
    records: [{
      kind: 'finding', record_id: `sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`, rule_id: 'nb.cmd.dangerous_deletion',
      rule_version: 'r1', severity: 'high', title: 'Destructive deletion was observed', source_agent: 'claude-code', source_type: 'hook',
      confidence: 'high', detected_at: detectedAt.toISOString(), numbat_schema_version: SECURITY_V2_NUMBAT_SCHEMA,
      bundle_digest: 'a'.repeat(64), lease_id: leaseId, found_at_rest: false, repository: { kind: 'not_enrolled' },
    }],
  };
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
  // Lease clock: real time, moved back only to issue an already-expired lease (step 14).
  let leaseClock: () => Date = () => new Date();
  const leaseStore = pgSecurityLeaseStore();
  const app = express();
  app.use('/worker', authenticateMachine);
  app.use('/worker/security', createSecurityFindingsRouter({
    v2Dependencies: {
      authority: createSecurityV2Authority(leaseStore),
      leaseRoutes: createSecurityLeaseRouter({ store: leaseStore, signer: fixture.signer('activation_lease'), now: () => leaseClock(), log: () => undefined }),
      log: () => undefined,
    },
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/admin/security', createSecuritySettingsAdminRouter({
    authorizeRead: authorize, authorizeWrite: authorize, signer: () => signer, log: () => undefined,
  }));
  const keyDirectory = mkdtempSync(join(tmpdir(), 'task20f-live-'));
  let server: Server | undefined;
  try {
    await db.insert(ssoTenants).values([
      { id: tenantA, companyName: 'Task20f Live A', domain: `task20f-live-a-${suffix}.invalid`, supabaseProviderId: `task20f-live-a-${suffix}` },
      { id: tenantB, companyName: 'Task20f Live B', domain: `task20f-live-b-${suffix}.invalid`, supabaseProviderId: `task20f-live-b-${suffix}` },
    ]);
    const machines: Record<'ax' | 'ay' | 'bx', { id: string; credential: string }> = {} as never;
    for (const [tenantId, name] of [[tenantA, 'ax'], [tenantA, 'ay'], [tenantB, 'bx']] as const) {
      const machine = await registerDeveloperMachine({ tenantId, installationId: `task20f-live-${name}-${tenantId}`, displayName: `Task20f ${name}`, actorId });
      const credential = await issueMachineCredential({ tenantId, machineId: machine.id, actorId });
      machines[name] = { id: machine.id, credential: credential.plaintext };
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
    // The v2 switch never touches Task6.a's activation row (AGENTS.md §9 item 11).
    const task6a = await db.select().from(tenantSecurityMonitorSettings).where(eq(tenantSecurityMonitorSettings.tenantId, tenantA));
    assert.equal(task6a.length, 0, 'Task6.a monitor settings untouched');

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
    // Version 1 was written by the monitor switch; this is version 2, still monitoring.
    assert.equal(data.body.data_settings_version, 2);
    assert.equal((data.body.bundle as { epoch: number }).epoch, 1);
    const [dataRow] = await db.select().from(securityDataSettingsVersions)
      .where(and(eq(securityDataSettingsVersions.tenantId, tenantA), eq(securityDataSettingsVersions.version, 2)));
    assert.deepEqual([dataRow.filePaths, dataRow.commandPreviews, dataRow.agents, dataRow.monitorMode], [true, false, ['claude-code', 'codex'], 'monitor']);

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

    // 7b. Too large for the 1 MiB signer cap: the dry run says so, and the apply refuses and writes nothing.
    const many = Object.fromEntries(pinnedCatalogue().manifest.rules.slice(0, 40).map(rule => [rule.id, { severity: rule.severity === 'info' ? 'low' : 'info' }]));
    const bigPlan = await call(base, 'PUT', tenantA, { dry_run: true, reason: 'big', rules: many });
    assert.equal(bigPlan.body.exceeds_signer_limit, true);
    const bigApply = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'big', rules: many });
    assert.equal(bigApply.status, 413);
    assert.equal(bigApply.body.code, 'SECURITY_SETTINGS_TOO_LARGE');
    assert.equal((await call(base, 'GET', tenantA)).body.rule_settings_version, 3, 'nothing written');

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

    // --- Part (b): leases, machine routes, authority, ingest, fleet v3 ------------------
    const X = machines.ax;
    const Y = machines.ay;
    const BX = machines.bx;
    const bundle3 = third.body.bundle as { digest: string; epoch: number };

    // 11. GET /lease (X): issued lazily, exact stored bytes, signed and verified, bound to the current bundle.
    const leaseResponse = await machineCall(base, X.credential, 'GET', '/lease');
    assert.equal(leaseResponse.status, 200, leaseResponse.bytes.toString());
    assert.equal(leaseResponse.cacheControl, 'no-store');
    const leaseX = leaseOf(leaseResponse.bytes);
    assert.deepEqual([leaseX.payload.tenant_id, leaseX.payload.machine_id, leaseX.payload.mode, leaseX.payload.bundle_digest],
      [tenantA, X.id, 'monitor', bundle3.digest]);
    assert.deepEqual(leaseX.payload.agents, ['claude-code', 'codex']);
    assert.equal((leaseX.payload.data_settings as { file_paths: boolean }).file_paths, true);
    const [storedLease] = await db.select().from(securityActivationLeases).where(eq(securityActivationLeases.id, String(leaseX.payload.lease_id)));
    assert.ok(storedLease.envelope.equals(leaseResponse.bytes), 'served bytes are the stored bytes');
    const leaseVerdict = fixture.verify({ envelope: leaseX.envelope, purpose: 'activation_lease', signedAt: String(leaseX.payload.issued_at), now: new Date() });
    assert.equal(leaseVerdict.status, 'verified', leaseVerdict.code);
    const tamperedLease = { ...leaseX.envelope, payload: Buffer.from(JSON.stringify({ ...leaseX.payload, machine_id: Y.id })).toString('base64') };
    assert.equal(fixture.verify({ envelope: tamperedLease, purpose: 'activation_lease', signedAt: String(leaseX.payload.issued_at), now: new Date() }).status, 'rejected');
    const reused = await machineCall(base, X.credential, 'GET', '/lease');
    assert.ok(reused.bytes.equals(leaseResponse.bytes), 'a fresh lease is reused');

    // 12. GET /bundles/{sha256}: own digest exact bytes; Company B's machine gets the same 404 as a missing digest (case 4).
    const bundleResponse = await machineCall(base, X.credential, 'GET', `/bundles/${bundle3.digest}`);
    assert.equal(bundleResponse.status, 200);
    assert.ok(bundleResponse.bytes.equals((await bundleEnvelopeByDigest(tenantA, bundle3.digest))!));
    const bundlePayload = Buffer.from((JSON.parse(bundleResponse.bytes.toString('utf8')) as DsseEnvelope).payload, 'base64');
    assert.equal(createHash('sha256').update(bundlePayload).digest('hex'), bundle3.digest, 'the lease digest names this payload');
    for (const path of [`/bundles/${bundle3.digest}`, `/bundles/${'0'.repeat(64)}`, '/bundles/NOT-HEX']) {
      const answer = await machineCall(base, BX.credential, 'GET', path);
      assert.deepEqual([answer.status, answer.json().code], [404, 'SECURITY_V2_NOT_FOUND']);
    }

    // 13. Acknowledgement (applied) and an ingest upload accepted through the real authority and storage.
    const ack = (lease: Record<string, unknown>, extra: Record<string, unknown> = { result: 'applied' }) => ({
      schema_version: 'trackai.security-acknowledgement/1', lease_id: lease.lease_id, bundle_digest: lease.bundle_digest, ...extra,
    });
    assert.equal((await machineCall(base, X.credential, 'POST', '/acknowledgements', ack(leaseX.payload))).status, 204);
    const accepted = await machineCall(base, X.credential, 'POST', '/records', findingUnder(leaseX.payload.lease_id, new Date()));
    assert.equal(accepted.status, 200, accepted.bytes.toString());
    assert.deepEqual((accepted.json().results as Array<{ result: string }>).map(row => row.result), ['accepted']);

    // 14. Machine Y: an already-expired lease (issued 73 h ago) refuses uploads; its refusal is stored and audited.
    leaseClock = () => new Date(Date.now() - LEASE_VALIDITY_MS - 3_600_000);
    const expired = leaseOf((await machineCall(base, Y.credential, 'GET', '/lease')).bytes).payload;
    leaseClock = () => new Date();
    assert.equal(expired.machine_id, Y.id);
    assert.notEqual(expired.lease_id, leaseX.payload.lease_id, 'case 3: Y never receives X\'s lease');
    const yUpload = await machineCall(base, Y.credential, 'POST', '/records', findingUnder(expired.lease_id, new Date()));
    assert.deepEqual([yUpload.status, yUpload.json().code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
    assert.equal((await machineCall(base, Y.credential, 'POST', '/acknowledgements',
      ack(expired, { result: 'refused', refusal_code: 'LEASE_EXPIRED' }))).status, 204);

    // 15. Cases 5–8: other machine's or tenant's lease → 404, nothing written; identity in the body → 400; B cannot upload under A's lease.
    const acknowledgementsBefore = (await db.select().from(securityAcknowledgements)).length;
    for (const [credential, body] of [[Y.credential, ack(leaseX.payload)], [BX.credential, ack(leaseX.payload)]] as const) {
      const answer = await machineCall(base, credential, 'POST', '/acknowledgements', body);
      assert.deepEqual([answer.status, answer.json().code], [404, 'SECURITY_V2_NOT_FOUND']);
    }
    const selector = await machineCall(base, X.credential, 'POST', '/acknowledgements', { ...ack(leaseX.payload), machine_id: Y.id });
    assert.deepEqual([selector.status, selector.json().code], [400, 'SECURITY_V2_UNKNOWN_FIELD']);
    assert.equal((await db.select().from(securityAcknowledgements)).length, acknowledgementsBefore, 'no acknowledgement written');
    const bLease = await machineCall(base, BX.credential, 'GET', '/lease');
    assert.deepEqual([bLease.status, bLease.json().code], [404, 'SECURITY_V2_LEASE_NOT_ISSUED'], 'Company B has no bundle yet');
    const bUpload = await machineCall(base, BX.credential, 'POST', '/records', findingUnder(leaseX.payload.lease_id, new Date()));
    assert.deepEqual([bUpload.status, bUpload.json().code], [403, 'SECURITY_V2_LEASE_REQUIRED']);

    // 16. Fleet configuration v3 (D6): created while monitoring is on, served with X's current lease; B (monitoring off) stays v2.
    const leaseKeyFile = join(keyDirectory, 'lease.pem');
    writeFileSync(leaseKeyFile, fixture.lease.privateKeyPem, { mode: 0o600 });
    process.env.SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID = fixture.lease.credentialId;
    process.env.SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE = leaseKeyFile;
    const release = {
      schemaVersion: 2 as const,
      clientCompatibility: { minimumVersion: '1.6.19', maximumVersion: '1.6.20' },
      desiredRelease: {
        version: '1.6.20', releaseTag: 'v1.6.20', manifestSha256: 'b'.repeat(64),
        manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS',
      },
      channel: 'enterprise-latest' as const, ring: null, validUntil: null, reason: 'Task20f live v3',
    };
    const v3 = await createFleetConfiguration({ tenantId: tenantA, actorId, configuration: release });
    const v2 = await createFleetConfiguration({ tenantId: tenantB, actorId, configuration: release });
    assert.deepEqual([v3.schemaVersion, v2.schemaVersion], [3, 2]);
    await assignFleetConfiguration({ tenantId: tenantA, actorId, assignment: { configurationId: v3.id, machineIds: [X.id], reason: 'live' } });
    const served = await getFleetConfiguration(tenantA, X.id);
    assert.ok(served && served.schemaVersion === 3);
    assert.deepEqual(served.securityLease, {
      leaseId: leaseX.payload.lease_id, bundleDigest: bundle3.digest, expiresAt: leaseX.payload.expires_at,
    });
    assert.equal('securityActivation' in served, false);
    await assert.rejects(getFleetConfiguration(tenantA, X.id, async () => null),
      (error: unknown) => error instanceof FleetServiceError && error.status === 409);
    for (const statement of [
      sql`insert into fleet_configurations (tenant_id, epoch, schema_version, generated_at, generated_by, target_client_version, channel, snapshot)
          values (${tenantA}::uuid, 900, 3, now(), 'live', '1.6.20', 'latest', '{"repositoryPolicies":[],"securityActivation":{"mode":"off","version":0}}'::jsonb)`,
      sql`insert into fleet_configurations (tenant_id, epoch, schema_version, generated_at, generated_by, target_client_version,
            client_minimum_version, client_maximum_version, release_tag, manifest_url, manifest_sha256, channel, snapshot)
          values (${tenantA}::uuid, 901, 4, now(), 'live', '1.6.20', '1.6.19', '1.6.20', 'v1.6.20',
            'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS', ${'b'.repeat(64)}, 'latest',
            '{"repositoryPolicies":[],"securityActivation":{"mode":"off","version":0}}'::jsonb)`,
    ]) {
      await assert.rejects(db.execute(statement), (error: unknown) => /check constraint/.test(String((error as { cause?: Error }).cause?.message)));
    }
    const [v3Row] = await db.select().from(fleetConfigurations).where(eq(fleetConfigurations.id, v3.id));
    assert.equal(v3Row.schemaVersion, 3);

    // 17. Off: the next lease is an off lease with no agents, and uploads stop at once.
    const offChange = await call(base, 'PUT', tenantA, { dry_run: false, reason: 'pause', monitor_mode: 'off' });
    assert.equal(offChange.status, 200);
    const offLease = leaseOf((await machineCall(base, X.credential, 'GET', '/lease')).bytes).payload;
    assert.deepEqual([offLease.mode, offLease.agents], ['off', []]);
    const offUpload = await machineCall(base, X.credential, 'POST', '/records', findingUnder(leaseX.payload.lease_id, new Date()));
    assert.deepEqual([offUpload.status, offUpload.json().code], [403, 'SECURITY_V2_LEASE_REQUIRED']);

    // 18. Lease history and acknowledgements are append-only.
    for (const statement of [
      sql`update security_activation_leases set mode = 'monitor' where tenant_id = ${tenantA}::uuid`,
      sql`delete from security_activation_leases where tenant_id = ${tenantA}::uuid`,
      sql`delete from security_acknowledgements where tenant_id = ${tenantA}::uuid`,
    ]) {
      await assert.rejects(db.execute(statement), (error: unknown) => /append-only/.test(String((error as { cause?: Error }).cause?.message)));
    }
    const leaseHistory = await db.select().from(securityActivationLeases).where(eq(securityActivationLeases.tenantId, tenantA));
    // X's monitor lease (reused by the fleet fetch), Y's expired lease, X's off lease.
    assert.equal(leaseHistory.length, 3, 'every issued lease is kept');

    // 19. Audit rows (machine actor), and none for Company B.
    const leaseAudit = await db.select().from(securityAuditEvents)
      .where(and(eq(securityAuditEvents.tenantId, tenantA), eq(securityAuditEvents.actorType, 'machine')));
    assert.deepEqual(leaseAudit.map(row => row.action).sort(), [
      'fleet.lease.issued', 'fleet.lease.issued', 'fleet.lease.issued', 'fleet.lease.refused', 'policy.bundle.acknowledged',
    ]);
    const refusedRow = leaseAudit.find(row => row.action === 'fleet.lease.refused')!;
    assert.deepEqual([refusedRow.actorId, (refusedRow.details as { refusal: string }).refusal], [Y.id, 'LEASE_EXPIRED']);
    assert.deepEqual(await auditActions(tenantB), []);

    console.log('settings_defaults=44_of_51_on_no_bundle');
    console.log('dry_run=nothing_written');
    console.log('signing_unavailable=nothing_written');
    console.log('bundle=verifyTrusted_verified_exact_stored_bytes');
    console.log('epoch=monotonic_1_2_3_concurrent_publish_refused');
    console.log('oversize=flagged_in_dry_run_refused_413_nothing_written');
    console.log('task6a_activation=untouched');
    console.log('history=append_only');
    console.log('tenant_isolation=company_b_sees_nothing');
    console.log('lease=verifyTrusted_verified_exact_stored_bytes_reused_under_1h');
    console.log('bundle_route=exact_bytes_foreign_missing_malformed_same_404');
    console.log('acknowledgement=applied_and_refused_stored_and_audited_cases_5_6_7_nothing_written');
    console.log('ingest=accepted_under_lease_refused_expired_off_and_foreign');
    console.log('fleet_v3=created_while_monitoring_served_with_current_lease_db_check_holds');
    console.log('lease_history=append_only');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => (error ? reject(error) : resolve())));
    rmSync(keyDirectory, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task20f live verification failed');
  process.exitCode = 1;
});
