/**
 * Task20i-a unit tests: the admin and auditor read API over v2 security
 * records. Query parsing, the allowlisted shapes, keyset paging, the honest
 * coverage states, the preview-table source scan and the real router's auth,
 * problems, no-store and X-Request-ID all run against an in-memory store (the
 * SQL path is proven by IT-T20i-01 on a real database).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import test from 'node:test';
import { adminActionOf } from '../../core/middleware/admin';
import { createSecuritySettingsAdminRouter } from '../security/admin.routes';
import { createSecurityV2ReadRouter } from './v2-read.routes';
import {
  encodeCoverageCursor,
  encodeFindingsCursor,
  parseCoverageQuery,
  parseFindingId,
  parseFindingsQuery,
  SECURITY_READ_FINDING_COLUMNS,
  toFindingItem,
  toNearbyIndicator,
  type SecurityCoverageRow,
  type SecurityFindingDetail,
  type SecurityFindingItem,
  type SecurityFindingsFilters,
  type SecurityReaderRole,
  type SecurityV2ReadStore,
} from './v2-read';

const TENANT = randomUUID();
const NOW = new Date('2026-10-10T12:00:00Z');

function findingRow(overrides: Record<string, unknown> = {}): Parameters<typeof toFindingItem>[0] {
  return {
    id: randomUUID(),
    tenantId: TENANT,
    machineId: randomUUID(),
    recordGeneration: 'v2',
    ruleId: 'nb.cmd.dangerous_deletion',
    ruleVersion: '2.1',
    ruleCategory: 'nb',
    ruleSeverity: 'high',
    effect: 'monitor',
    occurredAt: new Date(NOW.getTime()),
    rulePackVersion: `bundle:${'ab'.repeat(8)}`,
    receivedAt: new Date(NOW.getTime()),
    repositoryId: null,
    findingId: null,
    deliveryId: null,
    sessionId: 'session-1',
    sourceEventId: null,
    correlationId: null,
    routeId: null,
    agentFamily: null,
    hostSurface: null,
    hostMode: null,
    captureChannel: null,
    operatingSystem: null,
    timing: null,
    nativeEffect: null,
    activation: null,
    phase: null,
    availability: null,
    completeness: null,
    resultCategory: null,
    clientVersion: null,
    recordId: 'sha256:' + 'a'.repeat(64),
    sourceAgent: 'claude-code',
    sourceType: 'hook',
    model: 'sonnet',
    modelProvider: null,
    parentSessionId: null,
    subAgentId: null,
    confidence: 'high',
    title: 'Destructive deletion was observed',
    tags: null,
    foundAtRest: false,
    detectedAt: new Date(NOW.getTime()),
    numbatSchemaVersion: '0.5.0',
    bundleDigest: 'ab'.repeat(32),
    leaseId: 'lease-1',
    repositoryKind: 'not_enrolled',
    ...overrides,
  } as Parameters<typeof toFindingItem>[0];
}

test('Task20i-a: toFindingItem maps both generations to the pinned allowlist', () => {
  const v2 = toFindingItem(findingRow());
  assert.deepEqual(Object.keys(v2).sort(), [...SECURITY_READ_FINDING_COLUMNS].sort());
  assert.deepEqual(
    [v2.generation, v2.agent, v2.model, v2.repository_id, v2.repository_kind, v2.phase, v2.result_category],
    ['v2', 'claude-code', 'sonnet', null, 'not_enrolled', null, null],
  );
  assert.equal(v2.title, 'Destructive deletion was observed');
  const task6a = toFindingItem(findingRow({
    recordGeneration: 'task6a',
    agentFamily: 'opencode',
    sourceAgent: null,
    model: 'sonnet',
    repositoryId: randomUUID(),
    repositoryKind: null,
    phase: 'observed_result',
    resultCategory: 'success',
    title: null,
    bundleDigest: null,
    leaseId: null,
    foundAtRest: null,
  }));
  assert.deepEqual(Object.keys(task6a).sort(), [...SECURITY_READ_FINDING_COLUMNS].sort());
  assert.deepEqual(
    [task6a.generation, task6a.agent, task6a.model, task6a.phase, task6a.result_category, task6a.title],
    ['task6a', 'opencode', null, 'observed_result', 'success', null],
  );
  assert.ok(typeof task6a.repository_id === 'string' && task6a.repository_kind === null);
});

test('Task20i-a: the read modules never name the preview table in code', () => {
  for (const file of ['v2-read.ts', 'v2-read.routes.ts']) {
    const stripped = readFileSync(`${__dirname}/${file}`, 'utf8').replace(/^\s*\*.*$/gm, '');
    assert.ok(!/securityFindingPreviews|security_finding_previews/.test(stripped), `${file} names the preview table`);
  }
});

test('Task20i-a: findings query parsing refuses unknown or invalid parameters', () => {
  const base = parseFindingsQuery({}, NOW);
  assert.equal(base.limit, 50);
  assert.equal(base.cursor, null);
  assert.equal(base.filters.from.toISOString(), new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
  assert.equal(base.filters.to.toISOString(), NOW.toISOString());
  assert.throws(() => parseFindingsQuery({ unknown: 'x' }, NOW), /unknown parameter unknown/);
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'many' }, { severity: 'extreme' },
    { generation: 'v3' }, { machine_id: 'not-a-uuid' }, { repository_id: 'elsewhere' },
    { from: 'not-a-date' }, { from: NOW.toISOString(), to: NOW.toISOString() },
    { from: '2020-01-01T00:00:00Z', to: NOW.toISOString() },
    { severity: ['high', 'low'] }, { limit: ['10', '20'] }]) {
    assert.throws(() => parseFindingsQuery(query as Record<string, unknown>, NOW), /SECURITY_READ_INVALID_QUERY/, JSON.stringify(query));
  }
  const cursor = encodeFindingsCursor(NOW.toISOString(), randomUUID(), base.filterHash);
  assert.deepEqual(parseFindingsQuery({ cursor }, NOW).cursor?.i.length, 36);
  assert.throws(() => parseFindingsQuery({ cursor: '!!!' }, NOW), /cursor does not decode/);
  assert.throws(
    () => parseFindingsQuery({ cursor, severity: 'high' }, NOW),
    /cursor binds other filters/,
  );
  assert.throws(() => parseFindingId('nope'), /id is invalid/);
  assert.equal(parseFindingId(randomUUID()).length, 36);
  const coverage = parseCoverageQuery({ limit: '10' });
  assert.deepEqual([coverage.limit, coverage.cursor], [10, null]);
  assert.throws(() => parseCoverageQuery({ unknown: 'x' }), /unknown parameter/);
  assert.throws(() => parseCoverageQuery({ cursor: '!!!' }), /cursor does not decode/);
  const machineCursor = encodeCoverageCursor(randomUUID());
  assert.equal(parseCoverageQuery({ cursor: machineCursor }).cursor?.length, 36);
});

// --- In-memory store (mirrors the SQL semantics; the live verify proves them). ---

interface MemoryFinding extends Omit<SecurityFindingItem, 'occurred_at' | 'received_at'> {
  occurredAt: Date;
  receivedAt: Date;
}

interface MemoryState {
  findings: MemoryFinding[];
  indicators: Array<{ machineId: string; type: string; value: string; count: number; firstSeen: Date; lastSeen: Date }>;
  enforcement: Array<{
    id: string; machineId: string; sessionId: string | null; decision: string; mode: string;
    occurredAt: Date; toolName: string | null;
  }>;
  machines: string[];
  status: Record<string, SecurityCoverageRow['status']>;
  inventory: Record<string, SecurityCoverageRow['inventory']>;
  lease: Record<string, Exclude<SecurityCoverageRow['lease'], 'no_lease'>>;
  acknowledgement: Record<string, Exclude<SecurityCoverageRow['acknowledgement'], 'not_acknowledged'>>;
  platform: Record<string, string>;
  audits: Array<{ limit: number; returned: number }>;
}

function memoryItem(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const row = findingRow();
  const item = toFindingItem(row);
  const { occurred_at: _o, received_at: _r, ...rest } = item;
  return {
    ...rest,
    id: row.id,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    ...overrides,
  };
}

function matchesFilters(item: MemoryFinding, filters: SecurityFindingsFilters): boolean {
  if (item.occurredAt < filters.from || item.occurredAt > filters.to) return false;
  if (filters.severity !== null && item.rule_severity !== filters.severity) return false;
  if (filters.category !== null && item.rule_category !== filters.category) return false;
  if (filters.ruleId !== null && item.rule_id !== filters.ruleId) return false;
  if (filters.agent !== null && item.agent !== filters.agent) return false;
  if (filters.machineId !== null && item.machine_id !== filters.machineId) return false;
  if (filters.repositoryId !== null && item.repository_id !== filters.repositoryId) return false;
  if (filters.repositoryNotEnrolled && item.repository_kind !== 'not_enrolled') return false;
  if (filters.generation !== null && item.generation !== filters.generation) return false;
  return true;
}

function orderFindings(items: MemoryFinding[]): MemoryFinding[] {
  return [...items].sort((a, b) => (
    b.occurredAt.getTime() - a.occurredAt.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
  ));
}

function memoryStore(state: MemoryState): SecurityV2ReadStore {
  const toJson = (item: MemoryFinding): SecurityFindingItem => ({
    ...item,
    occurred_at: item.occurredAt.toISOString(),
    received_at: item.receivedAt.toISOString(),
  });
  return {
    async listFindingsAndAudit(input) {
      let items = orderFindings(state.findings.filter(item => matchesFilters(item, input.filters)));
      if (input.cursor) {
        items = items.filter(item => (
          item.occurredAt.toISOString() < input.cursor!.o
          || (item.occurredAt.toISOString() === input.cursor!.o && item.id < input.cursor!.i)
        ));
      }
      const page = items.slice(0, input.limit);
      const last = page[page.length - 1];
      state.audits.push({ limit: input.limit, returned: page.length });
      return {
        items: page.map(toJson),
        next_cursor: items.length > input.limit && last
          ? encodeFindingsCursor(last.occurredAt.toISOString(), last.id, input.filterHash)
          : null,
      };
    },
    async getFindingAndAudit(input) {
      const found = state.findings.find(item => item.id === input.id) ?? null;
      if (!found) {
        state.audits.push({ limit: 1, returned: 0 });
        return null;
      }
      const detail: SecurityFindingDetail = {
        finding: toJson(found),
        machine_indicators_nearby: state.indicators
          .filter(indicator => indicator.machineId === found.machine_id
            && indicator.firstSeen <= new Date(found.occurredAt.getTime() + 5 * 60_000)
            && indicator.lastSeen >= new Date(found.occurredAt.getTime() - 5 * 60_000))
          .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
          .slice(0, 100)
          .map(toNearbyIndicator),
        nearby_enforcement: found.session_id === null ? [] : state.enforcement
          .filter(decision => decision.machineId === found.machine_id
            && decision.sessionId === found.session_id
            && Math.abs(decision.occurredAt.getTime() - found.occurredAt.getTime()) <= 5 * 60 * 1_000)
          .map(decision => ({
            id: decision.id,
            decision: decision.decision,
            mode: decision.mode,
            occurred_at: decision.occurredAt.toISOString(),
            tool_name: decision.toolName,
            session_id: decision.sessionId,
          })),
      };
      state.audits.push({ limit: 1, returned: 1 });
      return detail;
    },
    async listCoverageAndAudit(input) {
      let machines = [...state.machines].sort();
      if (input.cursor) machines = machines.filter(id => id > input.cursor!);
      const page = machines.slice(0, input.limit);
      const last = page[page.length - 1];
      state.audits.push({ limit: input.limit, returned: page.length });
      return {
        rows: page.map(machineId => ({
          machine_id: machineId,
          platform: state.platform[machineId] ?? 'unreported',
          status: state.status[machineId] ?? 'unreported',
          inventory: state.inventory[machineId] ?? 'unreported',
          lease: state.lease[machineId] ?? 'no_lease',
          acknowledgement: state.acknowledgement[machineId] ?? 'not_acknowledged',
        })),
        next_cursor: machines.length > input.limit && last ? encodeCoverageCursor(last) : null,
      };
    },
  };
}

function emptyState(): MemoryState {
  return {
    findings: [], indicators: [], enforcement: [], machines: [],
    status: {}, inventory: {}, lease: {}, acknowledgement: {}, platform: {}, audits: [],
  };
}

function authorizeAs(role: SecurityReaderRole | 'member', tenantId: string): RequestHandler {
  return (req, res, next) => {
    if (role === 'member') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    req.tenantId = tenantId;
    req.user = { sub: `${role}-subject` } as typeof req.user;
    req.adminRole = role;
    next();
  };
}

interface TestContext {
  baseUrl: string;
  state: MemoryState;
  close: () => Promise<void>;
}

async function startServer(role: SecurityReaderRole | 'member', state: MemoryState): Promise<TestContext> {
  const app = express();
  app.use('/api/admin/security/v2', createSecurityV2ReadRouter({
    authorize: authorizeAs(role, TENANT),
    store: () => memoryStore(state),
    log: () => undefined,
  }));
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
    state,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

async function get(ctx: TestContext, path: string, requestId?: string) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    headers: requestId === undefined ? {} : { 'X-Request-ID': requestId },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return {
    status: response.status,
    requestId: response.headers.get('x-request-id'),
    cacheControl: response.headers.get('cache-control'),
    body,
  };
}

test('Task20i-a: every filter selects, paging is stable with equal timestamps', async () => {
  const state = emptyState();
  const machineA = randomUUID();
  const machineB = randomUUID();
  const repository = randomUUID();
  for (let index = 0; index < 5; index += 1) {
    state.findings.push(memoryItem({ machine_id: machineA, rule_severity: 'high', agent: 'claude-code' as string }));
  }
  state.findings.push(memoryItem({
    machine_id: machineB, rule_severity: 'critical', rule_category: 'execution',
    rule_id: 'trackai.exec.reverse_shell', agent: 'opencode', generation: 'task6a',
    repository_id: repository, repository_kind: null, model: null,
  }));
  state.findings.push(memoryItem({ machine_id: machineB, agent: 'codex', rule_severity: 'low' }));
  const ctx = await startServer('tenant_admin', state);
  try {
    const first = await get(ctx, '/api/admin/security/v2/findings?limit=2');
    assert.equal(first.status, 200);
    assert.equal((first.body as { items: unknown[] }).items.length, 2);
    assert.ok((first.body as { next_cursor: string }).next_cursor);
    const ids = new Set<string>();
    let path: string | null = '/api/admin/security/v2/findings?limit=2';
    while (path) {
      const page = await get(ctx, path);
      for (const item of (page.body as { items: SecurityFindingItem[] }).items) ids.add(item.id);
      const cursor = (page.body as { next_cursor: string | null }).next_cursor;
      path = cursor ? `/api/admin/security/v2/findings?limit=2&cursor=${encodeURIComponent(cursor)}` : null;
    }
    assert.equal(ids.size, 7, 'paging over equal timestamps returns every row once');
    for (const [filter, expected] of [
      ['severity=critical', 1], ['generation=task6a', 1], ['generation=v2', 6],
      [`machine_id=${machineB}`, 2], ['repository_id=not_enrolled', 6],
      [`repository_id=${repository}`, 1], ['agent=codex', 1], ['category=execution', 1],
      ['rule_id=trackai.exec.reverse_shell', 1],
    ] as const) {
      const filtered = await get(ctx, `/api/admin/security/v2/findings?${filter}`);
      assert.equal((filtered.body as { items: unknown[] }).items.length, expected, filter);
    }
    const audits = state.audits;
    assert.ok(audits.every(audit => Object.keys(audit).sort().join(',') === 'limit,returned'));
    assert.deepEqual(audits[0], { limit: 2, returned: 2 });
  } finally {
    await ctx.close();
  }
});

test('Task20i-a: detail returns nearby machine indicators and enforcement, 404 audits then refuses', async () => {
  const state = emptyState();
  const machine = randomUUID();
  const found = memoryItem({ machine_id: machine, session_id: 'session-9' });
  const noSession = memoryItem({ machine_id: machine, session_id: null });
  state.findings.push(found, noSession);
  state.indicators.push(
    {
      machineId: machine, type: 'domain', value: 'tracker.example.internal', count: 3,
      firstSeen: new Date(NOW.getTime() - 600_000), lastSeen: new Date(NOW.getTime() + 60_000),
    },
    {
      machineId: machine, type: 'url', value: 'https://tracker.example.internal/secret', count: 1,
      firstSeen: new Date(NOW.getTime() - 120_000), lastSeen: new Date(NOW.getTime() - 60_000),
    },
    {
      machineId: machine, type: 'email', value: 'someone@example.internal', count: 2,
      firstSeen: new Date(NOW.getTime() - 60_000), lastSeen: new Date(NOW.getTime() + 120_000),
    },
    {
      machineId: machine, type: 'domain', value: 'stale.example.internal', count: 9,
      firstSeen: new Date(NOW.getTime() - 3_600_000), lastSeen: new Date(NOW.getTime() - 1_800_000),
    },
    {
      machineId: randomUUID(), type: 'domain', value: 'other.example.internal', count: 1,
      firstSeen: new Date(NOW.getTime() - 60_000), lastSeen: NOW,
    },
  );
  state.enforcement.push(
    {
      id: randomUUID(), machineId: machine, sessionId: 'session-9', decision: 'no_override',
      mode: 'monitor', occurredAt: new Date(NOW.getTime() + 60_000), toolName: 'bash',
    },
    {
      id: randomUUID(), machineId: machine, sessionId: 'session-9', decision: 'no_override',
      mode: 'monitor', occurredAt: new Date(NOW.getTime() + 60 * 60_000), toolName: 'bash',
    },
    {
      id: randomUUID(), machineId: machine, sessionId: 'other', decision: 'no_override',
      mode: 'monitor', occurredAt: new Date(NOW.getTime()), toolName: 'bash',
    },
  );
  const ctx = await startServer('tenant_auditor', state);
  try {
    const detail = await get(ctx, `/api/admin/security/v2/findings/${found.id}`);
    assert.equal(detail.status, 200);
    const body = detail.body as SecurityFindingDetail;
    assert.equal(body.finding.id, found.id);
    assert.deepEqual(body.machine_indicators_nearby, [
      { type: 'email', value: null, count: 2 },
      { type: 'domain', value: 'tracker.example.internal', count: 3 },
      { type: 'url', value: null, count: 1 },
    ]);
    assert.deepEqual(
      body.machine_indicators_nearby.flatMap(indicator => Object.keys(indicator)),
      ['type', 'value', 'count', 'type', 'value', 'count', 'type', 'value', 'count'],
    );
    assert.equal(body.nearby_enforcement.length, 1);
    assert.deepEqual(Object.keys(body.nearby_enforcement[0]!).sort(),
      ['decision', 'id', 'mode', 'occurred_at', 'session_id', 'tool_name']);
    const bare = await get(ctx, `/api/admin/security/v2/findings/${noSession.id}`);
    assert.deepEqual([(bare.body as SecurityFindingDetail).machine_indicators_nearby.length,
      (bare.body as SecurityFindingDetail).nearby_enforcement.length], [3, 0]);
    const missing = await get(ctx, `/api/admin/security/v2/findings/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code: string }).code, 'SECURITY_READ_NOT_FOUND');
    assert.deepEqual(state.audits.at(-1), { limit: 1, returned: 0 });
    const invalid = await get(ctx, '/api/admin/security/v2/findings/not-a-uuid');
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body as { code: string }).code, 'SECURITY_READ_INVALID_QUERY');
  } finally {
    await ctx.close();
  }
});

test('Task20i-a: coverage uses the literal honest states and keysets by machine', async () => {
  const state = emptyState();
  const full = randomUUID();
  const partial = randomUUID();
  const bare = randomUUID();
  state.machines.push(full, partial, bare);
  state.platform[full] = 'macos';
  state.status[full] = {
    observed_at: NOW.toISOString(), numbat_version: '0.2.0', wired_agents: ['claude-code'],
    active_bundle_digest: 'ab'.repeat(32), lease_id: 'lease-1', last_record_at: NOW.toISOString(),
    hook_status: 'ok', agent_effective_view: 'ok', local_record: 'ok', forwarder_ack: 'ok',
  };
  state.inventory[full] = { observed_at: NOW.toISOString(), agents: [{ agent: 'claude-code' }] };
  state.lease[full] = { mode: 'monitor', expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(), bundle_epoch: 3 };
  state.acknowledgement[full] = { result: 'applied', refusal_code: null, received_at: NOW.toISOString() };
  state.inventory[partial] = { observed_at: NOW.toISOString(), agents: [] };
  state.lease[partial] = { mode: 'monitor', expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(), bundle_epoch: 'unknown' };
  const ctx = await startServer('tenant_admin', state);
  try {
    const first = await get(ctx, '/api/admin/security/v2/coverage?limit=2');
    assert.equal(first.status, 200);
    const rows = (first.body as { rows: SecurityCoverageRow[] }).rows;
    assert.equal(rows.length, 2);
    assert.ok((first.body as { next_cursor: string }).next_cursor);
    const second = await get(ctx,
      `/api/admin/security/v2/coverage?limit=2&cursor=${encodeURIComponent((first.body as { next_cursor: string }).next_cursor)}`);
    assert.equal((second.body as { rows: unknown[] }).rows.length, 1);
    const byId = new Map([...rows, ...(second.body as { rows: SecurityCoverageRow[] }).rows].map(row => [row.machine_id, row]));
    assert.equal(byId.get(full)?.platform, 'macos');
    assert.equal(typeof byId.get(full)?.status, 'object');
    assert.deepEqual(byId.get(partial)?.status, 'unreported');
    assert.deepEqual(byId.get(partial)?.acknowledgement, 'not_acknowledged');
    assert.deepEqual(byId.get(bare)?.platform, 'unreported');
    assert.deepEqual(byId.get(bare)?.lease, 'no_lease');
    assert.deepEqual(state.audits.at(-1), { limit: 2, returned: 1 });
    for (const row of byId.values()) {
      assert.ok(row.platform !== null && row.status !== null && row.lease !== null && row.acknowledgement !== null);
    }
  } finally {
    await ctx.close();
  }
});

test('Task20i-a: auth, problems, no-store and X-Request-ID through the real router', async () => {
  const admin = await startServer('tenant_admin', emptyState());
  const auditor = await startServer('tenant_auditor', emptyState());
  const member = await startServer('member', emptyState());
  try {
    for (const ctx of [admin, auditor]) {
      const ok = await get(ctx, '/api/admin/security/v2/findings', 'req-1');
      assert.equal(ok.status, 200);
      assert.equal(ok.requestId, 'req-1');
      assert.equal(ok.cacheControl, 'no-store');
    }
    const refused = await get(member, '/api/admin/security/v2/findings', 'req-2');
    assert.equal(refused.status, 403);
    assert.equal((refused.body as { code: string }).code, 'SECURITY_READ_FORBIDDEN');
    assert.equal(refused.requestId, 'req-2');
    assert.equal(refused.cacheControl, 'no-store');
    const bad = await get(admin, '/api/admin/security/v2/findings?limit=500');
    assert.equal(bad.status, 400);
    const problem = bad.body as { type: string; title: string; status: number; code: string; request_id: string };
    assert.deepEqual(Object.keys(problem).sort(), ['code', 'request_id', 'status', 'title', 'type']);
    assert.equal(problem.type, 'https://trackai.dev/problems/SECURITY_READ_INVALID_QUERY');
    assert.ok(typeof bad.requestId === 'string' && bad.requestId.length > 0, 'a request id is always minted');
    const unavailable = await get(admin, '/api/admin/security/v2/findings?limit=1');
    assert.equal(unavailable.status, 200);
  } finally {
    await admin.close();
    await auditor.close();
    await member.close();
  }
});

test('Task20i-a: the default router guards every route with security_findings.read', () => {
  const router = createSecurityV2ReadRouter({ store: () => memoryStore(emptyState()), log: () => undefined });
  const stack = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }> }).stack;
  const guarded = stack.filter(layer => layer.route).map(layer => ({
    path: layer.route!.path as string,
    actions: layer.route!.stack
      .map(item => adminActionOf(item.handle))
      .filter((action): action is NonNullable<typeof action> => action !== undefined),
    handles: layer.route!.stack.length,
  }));
  assert.deepEqual(guarded.map(route => route.path).sort(), ['/coverage', '/findings', '/findings/:id']);
  for (const route of guarded) {
    assert.deepEqual(route.actions, ['security_findings.read'], route.path);
    assert.equal(route.handles, 2, `${route.path}: exactly the guard and the handler`);
  }
});

test('Task20i-a: both the v2 reads and the settings routers answer on one app', async () => {
  const app = express();
  app.use('/api/admin/security/v2', createSecurityV2ReadRouter({
    authorize: authorizeAs('tenant_admin', TENANT),
    store: () => memoryStore(emptyState()),
    log: () => undefined,
  }));
  app.use('/api/admin/security', createSecuritySettingsAdminRouter({
    authorizeRead: authorizeAs('tenant_admin', TENANT),
    log: () => undefined,
  }));
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${(address as { port: number }).port}`;
    const reads = await fetch(`${base}/api/admin/security/v2/coverage`);
    assert.equal(reads.status, 200);
    // The mount reaches the settings router with or without a database.
    const settings = await fetch(`${base}/api/admin/security/settings`);
    assert.ok(settings.status === 200 || settings.status === 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
