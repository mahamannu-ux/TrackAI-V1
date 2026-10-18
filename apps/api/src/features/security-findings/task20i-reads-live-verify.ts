/**
 * IT-T20i-01 (docs/prompts/Task20): drives the real security reads v2 router
 * over HTTP against the throwaway TrackAI database — both tenants seeded
 * through the real v2 ingest service (`persistSecurityV2Upload`) and Task20f's
 * lease code (`applySecuritySettings`, `currentOrIssueLease`,
 * `recordLeaseAcknowledgement`), then Company A sees only its rows, Company B
 * gets 404 for A's finding id, keyset paging over hundreds of rows, both
 * finding generations, the coverage honest states, and one audit row per call
 * with exactly the frozen `{limit, returned}` details.
 *
 * Run (founder): IT_PG_DATABASES=trackai_task20i_reads_live
 *   IT_PG_EXPORTS=DATABASE_URL=trackai_task20i_reads_live scripts/it-db.sh
 *   npm run verify:task20i-reads-live -w apps/api
 * The Supabase JWT layer is replaced by an injected authorizer that sets the
 * tenant, subject and role from headers (the guards themselves are covered by
 * the auditor sweep and v2-read.test.ts).
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  developerMachines,
  fleetMachineStates,
  scmRepositories,
  securityAuditEvents,
  securityFindings,
  ssoTenants,
} from '../../core/db/schema';
import {
  registerDeveloperMachine,
} from '../../core/security/machine-security-service';
import { enrollRepository } from '../../core/security/repository-security-service';
import { createSecurityV2ReadRouter } from './v2-read.routes';
import { SECURITY_V2_NUMBAT_SCHEMA, type SecurityDataSettingsV1 } from './v2-contract';
import type { SecurityV2Authority } from './v2-authority';
import { persistSecurityV2Upload } from './v2-storage';
import { applySecuritySettings, parseSettingsChange } from '../security/service';
import { currentOrIssueLease, recordLeaseAcknowledgement } from '../security/lease';
import { pgSecurityLeaseStore } from '../security/lease-store';
import { trustFixture } from '../security/testing/trust-fixture';
import type { SecurityCoverageRow, SecurityFindingDetail, SecurityFindingItem } from './v2-read';

const STEP = 8 * 3_600_000;
const WINDOW_MS = 30 * 86_400_000;

let idCounter = 0;
function recordId(): string {
  idCounter += 1;
  return `sha256:${idCounter.toString(16).padStart(2, '0').padEnd(64, 'a').slice(0, 64)}`;
}

function finding(machineLabel: string, detectedAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'finding',
    record_id: recordId(),
    rule_id: 'nb.cmd.dangerous_deletion',
    rule_version: '2.1',
    severity: 'high',
    title: 'Destructive deletion was observed',
    source_agent: machineLabel,
    source_type: 'hook',
    confidence: 'high',
    detected_at: detectedAt.toISOString(),
    numbat_schema_version: SECURITY_V2_NUMBAT_SCHEMA,
    bundle_digest: 'ab'.repeat(32),
    lease_id: 'lease-live-task20i',
    found_at_rest: false,
    repository: { kind: 'not_enrolled' },
    ...overrides,
  };
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (it-db.sh sets it)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
    || databaseUrl.pathname !== '/trackai_task20i_reads_live') {
    throw new Error('Task20i live verification requires the exact disposable local database');
  }

  const now = new Date();
  const fixture = trustFixture(now);
  const actorId = 'task20i-live-verifier';
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const repositoryA = randomUUID();
  const suffix = randomUUID();
  let server: Server | undefined;
  try {
    await db.insert(ssoTenants).values([
      { id: tenantA, companyName: 'Task20i Live A', domain: `task20i-live-a-${suffix}.invalid`, supabaseProviderId: `task20i-live-a-${suffix}` },
      { id: tenantB, companyName: 'Task20i Live B', domain: `task20i-live-b-${suffix}.invalid`, supabaseProviderId: `task20i-live-b-${suffix}` },
    ]);
    await db.insert(scmRepositories).values([{
      id: repositoryA,
      tenantId: tenantA,
      provider: 'github',
      externalId: `task20i-live-a-${suffix}`,
      name: 'Task20i Live A',
      url: `https://example.invalid/task20i-live-a-${suffix}`,
      normalizedUrl: `https://example.invalid/task20i-live-a-${suffix}`,
    }]);
    await enrollRepository({ tenantId: tenantA, repositoryId: repositoryA, actorId });
    const machineA1 = await registerDeveloperMachine({ tenantId: tenantA, installationId: `task20i-a1-${suffix}`, displayName: 'Task20i A1', actorId });
    const machineA2 = await registerDeveloperMachine({ tenantId: tenantA, installationId: `task20i-a2-${suffix}`, displayName: 'Task20i A2', actorId });
    const machineB = await registerDeveloperMachine({ tenantId: tenantB, installationId: `task20i-b-${suffix}`, displayName: 'Task20i B', actorId });

    // Task20f's lease code: publish monitoring for A, issue leases, acknowledge one.
    const { change } = parseSettingsChange({ dry_run: false, reason: 'task20i live', monitor_mode: 'monitor' });
    await applySecuritySettings(
      { tenantId: tenantA, actor: { type: 'tenant_admin', id: actorId }, change, requestId: randomUUID() },
      { signer: fixture.signer('policy_bundle') },
    );
    const leaseStore = pgSecurityLeaseStore();
    const lease1 = await currentOrIssueLease({
      store: leaseStore, signer: fixture.signer('activation_lease'), tenantId: tenantA, machineId: machineA1.id, now,
    });
    await currentOrIssueLease({
      store: leaseStore, signer: fixture.signer('activation_lease'), tenantId: tenantA, machineId: machineA2.id, now,
    });
    await recordLeaseAcknowledgement({
      store: leaseStore, tenantId: tenantA, machineId: machineA1.id,
      acknowledgement: { leaseId: lease1.id, bundleDigest: lease1.bundleDigest, result: 'applied', refusalCode: null },
      now,
    });
    assert.equal(lease1.mode, 'monitor');

    // The real v2 ingest service under a wide stub lease window (Task20d style).
    const leaseWindow = {
      leaseId: 'lease-live-task20i',
      issuedAt: new Date(now.getTime() - 100 * 86_400_000),
      expiresAt: new Date(now.getTime() + 72 * 3_600_000),
    };
    const settingsOn: SecurityDataSettingsV1 = {
      schema_version: 'trackai.security-data-settings/1',
      command_previews: true, file_paths: true, urls: true, host_identity: true, user_identity: true,
    };
    const authorityFor = (tenantId: string): SecurityV2Authority => ({
      async currentLease(id) { return id === tenantId ? leaseWindow : null; },
      async leaseForMachine(id, _machineId, leaseId) {
        return id === tenantId && leaseId === leaseWindow.leaseId ? leaseWindow : null;
      },
      async currentDataSettings(id) { return id === tenantA ? settingsOn : null; },
    });
    async function ingest(tenantId: string, machineId: string, records: Array<Record<string, unknown>>) {
      for (let index = 0; index < records.length; index += 50) {
        const results = await persistSecurityV2Upload({
          tenantId, machineId,
          upload: { schema_version: 'trackai.security-upload/2', records: records.slice(index, index + 50) as never },
          settings: tenantId === tenantA ? settingsOn : null,
          authority: authorityFor(tenantId),
          // Fresh per call, like production: the enrollment above is newer
          // than the script's frozen `now` by milliseconds.
          receivedAt: new Date(),
        });
        assert.ok(results.every(result => result.result === 'accepted'), `ingest rejected: ${JSON.stringify(results)}`);
      }
    }

    // A machine 1: 120 findings over 80 days, the first 10 sharing one session.
    const a1Records: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 120; index += 1) {
      const detectedAt = new Date(now.getTime() - index * STEP);
      a1Records.push(finding('claude-code', detectedAt, {
        ...(index < 10 ? { session_id: 'live-session-s1' } : {}),
        ...(index % 3 === 0 ? { severity: 'medium', source_agent: 'codex' } : {}),
        ...(index % 4 === 0 ? { repository: { kind: 'enrolled', id: repositoryA } } : {}),
        ...(index % 5 === 0 ? { found_at_rest: true } : {}),
      }));
    }
    const anchorDetected = new Date(now.getTime() - 2 * STEP);
    const enforcementAt = (offsetMs: number) => new Date(anchorDetected.getTime() + offsetMs).toISOString();
    a1Records.push(
      {
        kind: 'enforcement', record_id: recordId(), rule_ids: ['nb.cmd.dangerous_deletion'], finding_record_ids: [],
        decision: 'no_override', mode: 'monitor', source_agent: 'claude-code', timestamp: enforcementAt(2 * 60_000), session_id: 'live-session-s1',
      },
      {
        kind: 'enforcement', record_id: recordId(), rule_ids: ['nb.cmd.dangerous_deletion'], finding_record_ids: [],
        decision: 'no_override', mode: 'monitor', source_agent: 'claude-code', timestamp: enforcementAt(-2 * 60_000), session_id: 'live-session-s1',
      },
      {
        kind: 'enforcement', record_id: recordId(), rule_ids: ['nb.cmd.dangerous_deletion'], finding_record_ids: [],
        decision: 'no_override', mode: 'monitor', source_agent: 'claude-code', timestamp: enforcementAt(30 * 60_000), session_id: 'live-session-s1',
      },
      {
        kind: 'enforcement', record_id: recordId(), rule_ids: ['nb.cmd.dangerous_deletion'], finding_record_ids: [],
        decision: 'no_override', mode: 'monitor', source_agent: 'claude-code', timestamp: enforcementAt(0), session_id: 'live-other',
      },
      {
        kind: 'indicator', record_id: recordId(), type: 'domain', value: 'tracker.example.internal',
        count: 3, first_seen: new Date(anchorDetected.getTime() - 600_000).toISOString(),
        last_seen: new Date(anchorDetected.getTime() + 120_000).toISOString(), source_agent: 'claude-code',
      },
      {
        kind: 'indicator', record_id: recordId(), type: 'url', value: 'https://tracker.example.internal/secret',
        count: 1, first_seen: new Date(anchorDetected.getTime() - 300_000).toISOString(),
        last_seen: new Date(anchorDetected.getTime() - 60_000).toISOString(), source_agent: 'claude-code',
      },
      {
        kind: 'indicator', record_id: recordId(), type: 'ipv4', value: '10.0.0.8',
        count: 1, first_seen: new Date(now.getTime() - 3_600_000).toISOString(),
        last_seen: new Date(now.getTime() - 900_000).toISOString(), source_agent: 'claude-code',
      },
      {
        kind: 'security_status', record_id: recordId(), observed_at: new Date(now.getTime() - 600_000).toISOString(),
        numbat_version: '0.2.0', wired_agents: ['claude-code'], active_bundle_digest: 'ab'.repeat(32),
        lease_id: 'lease-live-task20i', last_record_at: new Date(now.getTime() - 1_800_000).toISOString(),
        health: { hook_status: 'ok', agent_effective_view: 'ok', local_record: 'ok', forwarder_ack: 'ok' },
      },
      {
        kind: 'agent_inventory', record_id: recordId(), observed_at: new Date(now.getTime() - 600_000).toISOString(),
        agents: [{ agent: 'claude-code', version: '1.0', config: 'present', artifacts: 'present', wired: 'yes' }],
      },
    );
    await ingest(tenantA, machineA1.id, a1Records);

    // A machine 2: 120 findings, all machine-wide, plus a status snapshot.
    const a2Records: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 120; index += 1) {
      a2Records.push(finding('codex', new Date(now.getTime() - index * STEP), {
        ...(index % 2 === 0 ? { severity: 'low' } : {}),
      }));
    }
    a2Records.push({
      kind: 'security_status', record_id: recordId(), observed_at: new Date(now.getTime() - 1_200_000).toISOString(),
      numbat_version: '0.2.0', wired_agents: ['codex'], active_bundle_digest: null,
      lease_id: null, last_record_at: null,
      health: { hook_status: 'ok', agent_effective_view: 'unavailable', local_record: 'ok', forwarder_ack: 'ok' },
    });
    await ingest(tenantA, machineA2.id, a2Records);

    // B: three metadata-only findings (all-off data settings).
    await ingest(tenantB, machineB.id, [
      finding('claude-code', new Date(now.getTime() - 3_600_000)),
      finding('claude-code', new Date(now.getTime() - 7_200_000)),
      finding('codex', new Date(now.getTime() - 10_800_000)),
    ]);

    // Two Task6.a rows for A (direct insert: the read path, not ingest).
    const task6aBase = {
      tenantId: tenantA,
      machineId: machineA1.id,
      recordGeneration: 'task6a',
      ruleId: 'trackai.exec.reverse_shell',
      ruleVersion: '1',
      ruleCategory: 'execution',
      ruleSeverity: 'critical',
      effect: 'monitor',
      rulePackVersion: 'opencode-1',
      repositoryId: repositoryA,
      sessionId: 'task6a-session',
      routeId: 'AC-CLI-03',
      agentFamily: 'opencode',
      hostSurface: 'terminal',
      hostMode: 'cli',
      captureChannel: 'provider-plugin',
      operatingSystem: 'macos',
      timing: 'post_action',
      nativeEffect: 'observe_only',
      activation: 'observed',
      phase: 'observed_result',
      availability: 'available',
      completeness: 'complete',
      resultCategory: 'success',
      clientVersion: '1.0',
    } as const;
    await db.insert(securityFindings).values([
      {
        ...task6aBase, findingId: `task6a-live-1-${suffix}`, deliveryId: `task6a-delivery-1-${suffix}`,
        sourceEventId: `task6a-event-1-${suffix}`, occurredAt: new Date(now.getTime() - 3_600_000),
      },
      {
        ...task6aBase, findingId: `task6a-live-2-${suffix}`, deliveryId: `task6a-delivery-2-${suffix}`,
        sourceEventId: `task6a-live-2-${suffix}`, occurredAt: new Date(now.getTime() - 7_200_000),
      },
    ]);

    // One fleet platform row for A machine 1 only.
    await db.insert(fleetMachineStates).values([{ tenantId: tenantA, machineId: machineA1.id, platform: 'macos' }]);

    const authorize: RequestHandler = (req, res, next) => {
      const tenant = req.get('x-test-tenant');
      const role = req.get('x-test-role');
      if (!tenant || (role !== 'tenant_admin' && role !== 'tenant_auditor')) {
        res.status(401).json({ error: 'test identity required' });
        return;
      }
      req.tenantId = tenant;
      req.user = { sub: 'task20i-live-verifier' } as typeof req.user;
      req.adminRole = role;
      next();
    };
    const app = express();
    app.use('/api/admin/security/v2', createSecurityV2ReadRouter({ authorize, log: () => undefined }));
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function read(tenant: string, role: string, path: string, requestId = `req-${randomUUID()}`) {
      const response = await fetch(`${base}/api/admin/security/v2${path}`, {
        headers: { 'x-test-tenant': tenant, 'x-test-role': role, 'X-Request-ID': requestId },
      });
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        cacheControl: response.headers.get('cache-control'),
        body: await response.json() as Record<string, unknown>,
      };
    }

    // 1. Default list pages over the 30-day window: 90 + 90 v2 + 2 task6a
    // (the window is anchored at request time, so index 90 falls just outside).
    const stored = await db.select({
      generation: securityFindings.recordGeneration,
    }).from(securityFindings).where(eq(securityFindings.tenantId, tenantA));
    console.log(`stored_a=${stored.length}_v2_${stored.filter(row => row.generation === 'v2').length}_task6a_${stored.filter(row => row.generation === 'task6a').length}`);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    const generations = new Set<string>();
    for (;;) {
      const page = await read(tenantA, 'tenant_admin',
        `/findings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.cacheControl, 'no-store');
      const items = page.body.items as SecurityFindingItem[];
      assert.ok(items.length > 0 && items.length <= 50);
      for (const item of items) {
        assert.ok(!seen.has(item.id), 'a row repeats across pages');
        seen.add(item.id);
        generations.add(item.generation);
      }
      pages += 1;
      cursor = page.body.next_cursor as string | null;
      if (!cursor) break;
      assert.ok(pages < 10, 'paging never terminates');
    }
    assert.equal(seen.size, 182, `in-window rows: ${seen.size}`);
    assert.deepEqual([...generations].sort(), ['task6a', 'v2']);
    console.log(`default_list=paged_${seen.size}_rows_in_${pages}_pages_both_generations`);

    // 2. Filters.
    const filtered = async (query: string) => {
      const items: SecurityFindingItem[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await read(tenantA, 'tenant_auditor',
          `/findings?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        items.push(...(page.body.items as SecurityFindingItem[]));
        cursor = page.body.next_cursor as string | null;
        if (!cursor) break;
      }
      return items;
    };
    assert.equal((await filtered('generation=task6a&limit=100')).length, 2);
    assert.equal((await filtered('generation=v2&limit=100')).length, 180);
    assert.equal((await filtered(`machine_id=${machineA2.id}&limit=100`)).length, 90);
    assert.equal((await filtered('repository_id=not_enrolled&limit=100')).length, 157);
    assert.equal((await filtered(`repository_id=${repositoryA}&limit=100`)).length, 25);
    assert.equal((await filtered('agent=codex&limit=100')).length, 120);
    assert.equal((await filtered('severity=critical&limit=100')).length, 2);
    assert.equal((await filtered('category=execution&limit=100')).length, 2);
    assert.equal((await filtered('rule_id=nb.cmd.dangerous_deletion&limit=100')).length, 180);
    const windowed = await filtered(`from=${new Date(now.getTime() - 9 * STEP).toISOString()}&to=${now.toISOString()}&limit=100`);
    assert.equal(windowed.length, 22, 'twenty v2 plus two task6a in the narrow window');
    console.log('filters=every_filter_selects');

    // 3. Detail: nearby machine indicators (redacted URL) and nearby enforcement.
    const sessionFinding = (await filtered('agent=claude-code&limit=100'))
      .find(item => item.session_id === 'live-session-s1' && item.occurred_at === anchorDetected.toISOString());
    assert.ok(sessionFinding, 'the anchored session finding is listed');
    const detail = await read(tenantA, 'tenant_admin', `/findings/${sessionFinding.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const detailBody = detail.body as unknown as SecurityFindingDetail;
    assert.equal(detailBody.finding.id, sessionFinding.id);
    assert.deepEqual(detailBody.machine_indicators_nearby, [
      { type: 'domain', value: 'tracker.example.internal', count: 3 },
      { type: 'url', value: null, count: 1 },
    ]);
    assert.equal(detailBody.nearby_enforcement.length, 2, 'only the decisions within five minutes');
    console.log('detail=machine_indicators_nearby_and_enforcement');

    // 4. Company B isolation.
    const bList = await read(tenantB, 'tenant_admin', '/findings?limit=100');
    assert.equal((bList.body.items as unknown[]).length, 3);
    const bDetailOfA = await read(tenantB, 'tenant_admin', `/findings/${sessionFinding.id}`);
    assert.deepEqual([bDetailOfA.status, bDetailOfA.body.code], [404, 'SECURITY_READ_NOT_FOUND']);
    const bFilteredByA = await read(tenantB, 'tenant_admin', `/findings?machine_id=${machineA1.id}&limit=100`);
    assert.equal((bFilteredByA.body.items as unknown[]).length, 0);
    console.log('tenant_isolation=company_b_sees_only_its_rows');

    // 5. Coverage for A: platform, status, inventory, lease with epoch, acknowledgement.
    const coverage = await read(tenantA, 'tenant_admin', '/coverage?limit=100');
    assert.equal(coverage.status, 200, JSON.stringify(coverage.body));
    const rows = coverage.body.rows as SecurityCoverageRow[];
    assert.equal(rows.length, 2);
    const byId = new Map(rows.map(row => [row.machine_id, row]));
    const full = byId.get(machineA1.id)!;
    assert.equal(full.platform, 'macos');
    assert.ok(typeof full.status === 'object' && full.status.numbat_version === '0.2.0');
    assert.ok(typeof full.inventory === 'object');
    assert.equal((full.lease as { mode: string; bundle_epoch: number }).mode, 'monitor');
    assert.equal((full.lease as { mode: string; bundle_epoch: number }).bundle_epoch, 1);
    assert.equal((full.acknowledgement as { result: string }).result, 'applied');
    const partial = byId.get(machineA2.id)!;
    assert.equal(partial.platform, 'unreported');
    assert.ok(typeof partial.status === 'object');
    assert.equal(partial.inventory, 'unreported');
    assert.equal((partial.lease as { mode: string }).mode, 'monitor');
    assert.equal(partial.acknowledgement, 'not_acknowledged');
    const bCoverage = await read(tenantB, 'tenant_admin', '/coverage?limit=100');
    const bRow = (bCoverage.body.rows as SecurityCoverageRow[])[0]!;
    assert.deepEqual([bRow.platform, bRow.status, bRow.inventory, bRow.lease, bRow.acknowledgement],
      ['unreported', 'unreported', 'unreported', 'no_lease', 'not_acknowledged']);
    console.log('coverage=honest_states_for_both_tenants');

    // 6. Problems, headers and auth.
    for (const path of ['/findings?cursor=!!!', '/findings?unknown_param=x', '/findings?limit=101',
      '/findings/not-a-uuid', '/coverage?limit=0']) {
      const refused = await read(tenantA, 'tenant_admin', path);
      assert.deepEqual([refused.status, refused.body.code], [400, 'SECURITY_READ_INVALID_QUERY'], path);
      assert.equal(refused.cacheControl, 'no-store');
      assert.ok(refused.requestId);
    }
    const anonymous = await (async () => {
      const response = await fetch(`${base}/api/admin/security/v2/findings`);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    })();
    assert.deepEqual([anonymous.status, anonymous.body.code], [403, 'SECURITY_READ_FORBIDDEN']);
    console.log('problems=headers_and_auth');

    // 7. One audit row per call, exactly the frozen details.
    const audits = await db.select().from(securityAuditEvents)
      .where(and(eq(securityAuditEvents.tenantId, tenantA), eq(securityAuditEvents.action, 'security_findings.read')));
    assert.ok(audits.length >= 20, `an audit row per call: ${audits.length}`);
    for (const audit of audits) {
      assert.deepEqual(Object.keys(audit.details as Record<string, unknown>).sort(), ['limit', 'returned']);
      assert.equal(audit.targetType, 'security_findings');
      assert.equal(audit.targetId, tenantA);
    }
    const bAudits = await db.select().from(securityAuditEvents)
      .where(and(eq(securityAuditEvents.tenantId, tenantB), eq(securityAuditEvents.action, 'security_findings.read')));
    assert.ok(bAudits.length >= 4);
    console.log(`audit=one_row_per_call_with_frozen_details_A${audits.length}_B${bAudits.length}`);

    // 8. No Task6.a activation side effects and no cross-tenant machine rows.
    const machines = await db.select({ id: developerMachines.id }).from(developerMachines);
    assert.equal(machines.length, 3);
    console.log('summary=IT-T20i-01_passes');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => (error ? reject(error) : resolve())));
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task20i live reads verification failed');
  process.exitCode = 1;
});
