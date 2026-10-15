/**
 * Audit read API (Task16c, A16.6): the real Express router in-process over a
 * fake read store (rows pass the real contract through buildAuditRow).
 *
 * Ported from SushiCorp AP-1 @ 0bd67a5 (catalog AP-1), via
 * features/attesta/attesta-api.test.ts: tests/unit/api/test_api_gaps.py (paging,
 * filters, bad cursor and filters refused, other tenant sees nothing),
 * tests/unit/api/test_api_auditor.py (auditor reads; a non-member gets 403) and
 * api_harness.py (an in-process app with role headers). Deviations: 400 instead
 * of 422; problems carry no `detail`; the cursor binds the request's filters;
 * every read writes one `audit.events.read` event carrying filter names only.
 * No database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';import express, { type RequestHandler, type Router } from 'express';
import { adminMembershipAllows, type AdminAction, type AdminMembershipRecord } from '../../core/security/admin-authorization';
import { AUDIT_CATALOG_BY_ACTION, AUDIT_CATALOG_VERSION, type AuditEvent } from '../../core/audit/catalog';
import { buildAuditRow } from '../../core/audit/record';
import { createAuditRouter, type AuditRouterDeps } from './audit.routes';
import { PROBLEM_TYPE_BASE, REQUEST_ID_RE } from './http';
import {
  encodeAuditCursor,
  toAuditEventV1,
  type AuditEventV1,
  type AuditGetInput,
  type AuditListInput,
  type AuditReadStore,
  type AuditStoredRow,
} from './read-service';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const T0 = '2026-10-14T12:00:00.000000Z';
const T1 = '2026-10-14T12:00:01.000000Z';
const T2 = '2026-10-14T12:00:02.000000Z';

// ---------------------------------------------------------------------------
// Fake store: rows as the tables hold them (every seed row passes the contract)

interface AuditRecord {
  tenantId: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

class MemoryAuditStore implements AuditReadStore {
  rows: AuditStoredRow[] = [];
  audits: AuditRecord[] = [];
  fail: Error | null = null;

  add(tenantId: string, event: AuditEvent, occurredAt: string): AuditStoredRow {
    const row = buildAuditRow(tenantId, event);
    const stored: AuditStoredRow = { id: randomUUID(), ...row, occurredAt };
    this.rows.push(stored);
    return stored;
  }

  private check(): void { if (this.fail) throw this.fail; }

  private sorted(tenantId: string): AuditStoredRow[] {
    return this.rows
      .filter(row => row.tenantId === tenantId)
      .sort((x, y) => y.occurredAt.localeCompare(x.occurredAt) || y.id.localeCompare(x.id));
  }

  async listAndAudit(input: AuditListInput): Promise<{ events: AuditEventV1[]; nextCursor: string | null }> {
    this.check();
    const q = input.listQuery;
    let rows = this.sorted(input.tenantId)
      .filter(row => q.actions === null || q.actions.includes(row.action))
      .filter(row => q.actorType === null || row.actorType === q.actorType)
      .filter(row => q.actorId === null || row.actorId === q.actorId)
      .filter(row => q.targetType === null || row.targetType === q.targetType)
      .filter(row => q.targetId === null || row.targetId === q.targetId)
      .filter(row => q.from === null || Date.parse(row.occurredAt) >= Date.parse(q.from as string))
      .filter(row => q.to === null || Date.parse(row.occurredAt) < Date.parse(q.to as string));
    if (input.cursor !== null) {
      const cursor = input.cursor;
      rows = rows.filter(row => row.occurredAt < cursor.o
        || (row.occurredAt === cursor.o && row.id < cursor.i));
    }
    const page = rows.slice(0, input.limit);
    const events = page.map(toAuditEventV1);
    const last = page[page.length - 1];
    const nextCursor = rows.length > input.limit && last
      ? encodeAuditCursor(last.occurredAt, last.id, input.filterHash)
      : null;
    // The audit write runs after the select; a failure here answers 503 with no rows.
    this.check();
    this.audits.push({
      tenantId: input.tenantId, actorType: input.actorRole, actorId: input.actorId,
      action: 'audit.events.read', targetType: 'security_audit_events', targetId: input.tenantId,
      details: { limit: input.limit, returned: events.length, filters: q.filterNames, request_id: input.requestId },
    });
    return { events, nextCursor };
  }

  async getAndAudit(input: AuditGetInput): Promise<AuditEventV1 | null> {
    this.check();
    // PostgreSQL compares uuid case-insensitively; the memory store mirrors that.
    const row = this.sorted(input.tenantId).find(candidate => candidate.id.toLowerCase() === input.id.toLowerCase()) ?? null;
    const event = row ? toAuditEventV1(row) : null;
    this.check();
    this.audits.push({
      tenantId: input.tenantId, actorType: input.actorRole, actorId: input.actorId,
      action: 'audit.events.read', targetType: 'security_audit_events', targetId: input.tenantId,
      details: { limit: 1, returned: event === null ? 0 : 1, filters: ['id'], request_id: input.requestId },
    });
    return event;
  }
}

const revoked = (id: string): AuditEvent => ({
  action: 'repository_grant.revoked', actorType: 'tenant_admin', actorId: 'admin-a',
  targetType: 'machine_repository_grant', targetId: id,
  details: { machineId: randomUUID(), reason: 'left' },
});
const registered = (id: string): AuditEvent => ({
  action: 'machine.registered', actorType: 'tenant_admin', actorId: 'admin-a',
  targetType: 'developer_machine', targetId: id,
  details: { installationId: 'install-1', displayName: 'Dana laptop' },
});
const failed = (id: string): AuditEvent => ({
  action: 'evidence_export.failed', actorType: 'tenant_admin', actorId: 'admin-a',
  targetType: 'evidence_export_job', targetId: id,
  details: { failureCode: 'export_execution_failed', reason: 'audit' },
});

// ---------------------------------------------------------------------------
// Authorization: the same answers as core/middleware/admin.ts requireAdminAction,
// over a fake membership table, deciding with the real adminMembershipAllows.

type Memberships = Map<string, AdminMembershipRecord | 'unavailable'>;

function fakeRequireAdmin(memberships: Memberships, action: AdminAction = 'audit.read'): RequestHandler {
  return async (req, res, next) => {
    const tenantId = req.tenantId;
    const subject = req.user?.sub;
    if (!tenantId || !subject) {
      res.status(401).json({ error: 'Unauthorized: Missing administrator identity' });
      return;
    }
    const m = memberships.get(`${tenantId}/${subject}`) ?? null;
    if (m === 'unavailable') {
      res.status(503).json({ error: 'Administrator authorization is temporarily unavailable' });
      return;
    }
    if (!adminMembershipAllows(m, { tenantId, subject, action })) {
      res.status(403).json({ error: 'Forbidden: Tenant administrator permission is required' });
      return;
    }
    req.adminRole = m?.role;
    next();
  };
}

const member = (tenantId: string, subject: string, role: 'tenant_admin' | 'tenant_auditor', revokedMember = false): AdminMembershipRecord => ({
  tenantId, subject, role, status: revokedMember ? 'revoked' : 'active', revokedAt: revokedMember ? new Date() : null,
});

function memberships(): Memberships {
  return new Map<string, AdminMembershipRecord | 'unavailable'>([
    [`${A}/admin-a`, member(A, 'admin-a', 'tenant_admin')],
    [`${A}/auditor-a`, member(A, 'auditor-a', 'tenant_auditor')],
    [`${A}/revoked-a`, member(A, 'revoked-a', 'tenant_auditor', true)],
    [`${A}/flaky-a`, 'unavailable'],
    [`${B}/auditor-b`, member(B, 'auditor-b', 'tenant_auditor')],
  ]);
}

// ---------------------------------------------------------------------------
// Harness: a real Express app on a free port

interface Harness {
  url: string;
  store: MemoryAuditStore;
  router: Router;
  logs: string[];
  close(): Promise<void>;
  get(path: string, who?: { tenant?: string; sub?: string }, headers?: Record<string, string>): Promise<Response>;
}

async function harness(over: Partial<AuditRouterDeps> = {}, store = new MemoryAuditStore()): Promise<Harness> {
  const logs: string[] = [];
  const router = createAuditRouter({
    store, authorize: fakeRequireAdmin(memberships()), log: (l) => logs.push(l), ...over,
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Stands in for /api's JWT + tenant middleware.
    const tenant = req.get('x-test-tenant');
    const sub = req.get('x-test-sub');
    if (tenant) req.tenantId = tenant;
    if (sub) req.user = { sub } as Express.AuthenticatedUser;
    next();
  });
  app.use('/api/audit', router);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/audit`;
  const headersFor = (who: { tenant?: string; sub?: string }) =>
    ({ ...(who.tenant ? { 'x-test-tenant': who.tenant } : {}), ...(who.sub ? { 'x-test-sub': who.sub } : {}) });
  return {
    url, store, router, logs,
    get: (path, who = { tenant: A, sub: 'auditor-a' }, headers = {}) => fetch(url + path, {
      headers: { ...headersFor(who), ...headers },
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

const ADMIN = { tenant: A, sub: 'admin-a' };
const AUDITOR = { tenant: A, sub: 'auditor-a' };

function seed(store: MemoryAuditStore): { a1: AuditStoredRow; a2: AuditStoredRow; a3: AuditStoredRow; b1: AuditStoredRow } {
  const a1 = store.add(A, revoked(randomUUID()), T2);
  const a2 = store.add(A, registered(randomUUID()), T1);
  const a3 = store.add(A, failed(randomUUID()), T0);
  const b1 = store.add(B, revoked(randomUUID()), T2);
  return { a1, a2, a3, b1 };
}

function problem(body: unknown): { type: string; title: string; status: number; code: string; request_id: string } {
  assert.ok(body && typeof body === 'object');
  return body as { type: string; title: string; status: number; code: string; request_id: string };
}

describe('audit read API: list filters', () => {
  test('unfiltered list returns the tenant rows newest first with catalog fields', async () => {
    const store = new MemoryAuditStore();
    const { a1, a2, a3 } = seed(store);
    const t = await harness({}, store);
    try {
      const res = await t.get('/events', ADMIN);
      assert.equal(res.status, 200);
      const body = await res.json() as { events: AuditEventV1[]; next_cursor: null; catalog_version: number };
      assert.deepEqual(body.events.map(e => e.id), [a1.id, a2.id, a3.id]);
      assert.equal(body.next_cursor, null);
      assert.equal(body.catalog_version, AUDIT_CATALOG_VERSION);
      assert.equal(body.events[0].severity, 'high');
      assert.equal(body.events[1].severity, 'notice');
      assert.equal(body.events[2].severity, 'info');
      assert.ok(body.events.every(e => e.occurred_at.endsWith('Z') && e.catalog_version === 2));
    } finally { await t.close(); }
  });

  test('tenant isolation: Company A sees none of Company B rows', async () => {
    const store = new MemoryAuditStore();
    const { b1 } = seed(store);
    const t = await harness({}, store);
    try {
      const res = await t.get('/events', AUDITOR);
      const body = await res.json() as { events: AuditEventV1[] };
      assert.ok(body.events.every(e => e.id !== b1.id));
      assert.equal(body.events.length, 3);
    } finally { await t.close(); }
  });

  test('every filter selects, and every invalid filter is a 400', async () => {
    const store = new MemoryAuditStore();
    seed(store);
    const t = await harness({}, store);
    try {
      const ids = async (path: string): Promise<string[]> => {
        const res = await t.get(path, ADMIN);
        assert.equal(res.status, 200, path);
        return ((await res.json()) as { events: AuditEventV1[] }).events.map(e => e.id);
      };
      const { a1, a2, a3 } = { a1: store.rows[0].id, a2: store.rows[1].id, a3: store.rows[2].id };
      assert.deepEqual(await ids('/events?action=repository_grant.revoked'), [a1]);
      assert.deepEqual(await ids('/events?action=machine.registered&action=evidence_export.failed'), [a2, a3]);
      assert.deepEqual(await ids('/events?severity=high'), [a1]);
      assert.deepEqual(await ids('/events?severity=notice'), [a2]);
      assert.deepEqual(await ids('/events?severity=info'), [a3]);
      assert.deepEqual(await ids('/events?actor_type=tenant_admin'), [a1, a2, a3]);
      assert.deepEqual(await ids('/events?actor_id=admin-a'), [a1, a2, a3]);
      assert.deepEqual(await ids('/events?actor_id=nobody'), []);
      assert.deepEqual(await ids('/events?target_type=machine_repository_grant'), [a1]);
      assert.deepEqual(await ids(`/events?target_id=${store.rows[1].targetId}`), [a2]);
      assert.deepEqual(await ids(`/events?from=${T1}`), [a1, a2]);
      assert.deepEqual(await ids(`/events?to=${T1}`), [a3]);
      assert.deepEqual(await ids(`/events?from=${T0}&to=${T2}`), [a2, a3]);
      assert.deepEqual(await ids('/events?limit=2'), [a1, a2]);
      const bad = [
        '/events?action=no.such.action',
        `/events?${Array.from({ length: 21 }, () => 'action=machine.registered').join('&')}`,
        '/events?severity=critical',
        '/events?actor_type=robot',
        `/events?actor_id=${'x'.repeat(257)}`,
        '/events?target_type=Bad-Type',
        `/events?target_id=${'x'.repeat(257)}`,
        '/events?from=not-a-date',
        '/events?from=2026-10-14',
        `/events?from=${T2}&to=${T1}`,
        `/events?from=${T1}&to=${T1}`,
        '/events?limit=0',
        '/events?limit=201',
        '/events?limit=many',
        '/events?bogus=1',
      ];
      for (const path of bad) {
        const res = await t.get(path, ADMIN);
        assert.equal(res.status, 400, path);
        assert.equal(problem(await res.json()).code, 'AUDIT_FILTER_INVALID');
      }
    } finally { await t.close(); }
  });

  test('a reserved catalog action is a valid action filter', async () => {
    const t = await harness();
    try {
      const res = await t.get('/events?action=attesta.anchor.failed', ADMIN);
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as { events: AuditEventV1[] }).events, []);
    } finally { await t.close(); }
  });
});

describe('audit read API: keyset paging', () => {
  test('three pages over rows sharing an occurred_at return each row exactly once', async () => {
    const store = new MemoryAuditStore();
    const made = [
      store.add(A, revoked(randomUUID()), T1),
      store.add(A, registered(randomUUID()), T1),
      store.add(A, failed(randomUUID()), T1),
      store.add(A, revoked(randomUUID()), T1),
      store.add(A, registered(randomUUID()), T1),
    ];
    const t = await harness({}, store);
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page++) {
        const res = await t.get(cursor === null ? '/events?limit=2' : `/events?limit=2&cursor=${cursor}`, ADMIN);
        assert.equal(res.status, 200);
        const body = await res.json() as { events: AuditEventV1[]; next_cursor: string | null };
        seen.push(...body.events.map(e => e.id));
        cursor = body.next_cursor;
        if (page < 2) assert.ok(cursor, `page ${page} has a next cursor`);
      }
      assert.equal(cursor, null);
      assert.deepEqual([...seen].sort(), made.map(r => r.id).sort());
    } finally { await t.close(); }
  });

  test('a tampered cursor and a cursor reused with other filters are 400', async () => {
    const store = new MemoryAuditStore();
    seed(store);
    const t = await harness({}, store);
    try {
      const first = await t.get('/events?limit=1', ADMIN);
      const cursor = ((await first.json()) as { next_cursor: string }).next_cursor;
      assert.ok(cursor);
      const tampered = await t.get(`/events?limit=1&cursor=${cursor.slice(0, -2)}!!`, ADMIN);
      assert.equal(tampered.status, 400);
      assert.equal(problem(await tampered.json()).code, 'AUDIT_CURSOR_INVALID');
      const rebound = Buffer.from(JSON.stringify({ o: T2, i: store.rows[0].id, f: '0'.repeat(16) }), 'utf8').toString('base64url');
      const wrong = await t.get(`/events?limit=1&cursor=${rebound}`, ADMIN);
      assert.equal(wrong.status, 400);
      assert.equal(problem(await wrong.json()).code, 'AUDIT_CURSOR_INVALID');
      const other = await t.get(`/events?action=machine.registered&limit=1&cursor=${encodeURIComponent(cursor)}`, ADMIN);
      assert.equal(other.status, 400);
      assert.equal(problem(await other.json()).code, 'AUDIT_CURSOR_INVALID');
    } finally { await t.close(); }
  });
});

describe('audit read API: single read and catalog', () => {
  test('another tenant id and an unknown id share one 404 body; a bad id is 400', async () => {
    const store = new MemoryAuditStore();
    const { b1 } = seed(store);
    const t = await harness({}, store);
    try {
      const cross = await t.get(`/events/${b1.id}`, AUDITOR);
      assert.equal(cross.status, 404);
      const crossBody = problem(await cross.json());
      assert.equal(crossBody.code, 'AUDIT_EVENT_NOT_FOUND');
      const unknown = await t.get(`/events/${randomUUID()}`, AUDITOR);
      assert.equal(unknown.status, 404);
      const scrub = (p: { request_id: string }) => ({ ...p, request_id: null });
      assert.deepEqual(scrub(crossBody), scrub(problem(await unknown.json())));
      const bad = await t.get('/events/not-a-uuid', AUDITOR);
      assert.equal(bad.status, 400);
      assert.equal(problem(await bad.json()).code, 'AUDIT_FILTER_INVALID');
      const upper = store.rows.find(r => r.tenantId === A) as AuditStoredRow;
      const upperRes = await t.get(`/events/${upper.id.toUpperCase()}`, AUDITOR);
      assert.equal(upperRes.status, 200);
    } finally { await t.close(); }
  });

  test('the single read returns the event with its catalog fields', async () => {
    const store = new MemoryAuditStore();
    const { a2 } = seed(store);
    const t = await harness({}, store);
    try {
      const res = await t.get(`/events/${a2.id}`, AUDITOR);
      assert.equal(res.status, 200);
      const body = await res.json() as { event: AuditEventV1; catalog_version: number };
      assert.equal(body.event.id, a2.id);
      assert.equal(body.event.action, 'machine.registered');
      assert.equal(body.event.severity, AUDIT_CATALOG_BY_ACTION.get('machine.registered')?.severity);
      assert.equal(body.catalog_version, AUDIT_CATALOG_VERSION);
    } finally { await t.close(); }
  });

  test('a row whose action left the catalog is still returned with high severity', async () => {
    const store = new MemoryAuditStore();
    const gone: AuditStoredRow = {
      id: randomUUID(), tenantId: A, actorType: 'tenant_admin', actorId: 'admin-a', action: 'retired.action',
      targetType: 'tenant', targetId: A, details: {}, occurredAt: T0,
    };
    store.rows.push(gone);
    const t = await harness({}, store);
    try {
      const res = await t.get(`/events/${gone.id}`, ADMIN);
      assert.equal(res.status, 200);
      const body = await res.json() as { event: AuditEventV1 };
      assert.equal(body.event.action, 'retired.action');
      assert.equal(body.event.severity, 'high');
    } finally { await t.close(); }
  });

  test('the catalog lists actions for the console filters and writes no audit', async () => {
    const t = await harness();
    try {
      const res = await t.get('/catalog', AUDITOR);
      assert.equal(res.status, 200);
      const body = await res.json() as {
        catalog_version: number;
        actions: Array<{ action: string; owner: string; severity: string; status: string; actor_types: string[]; target_type: string }>;
      };
      assert.equal(body.catalog_version, AUDIT_CATALOG_VERSION);
      const read = body.actions.find(a => a.action === 'audit.events.read');
      assert.deepEqual(read, {
        action: 'audit.events.read', owner: 'Task16c', severity: 'info', status: 'emitted',
        actor_types: ['tenant_admin', 'tenant_auditor'], target_type: 'security_audit_events',
      });
      assert.equal(t.store.audits.length, 0);
    } finally { await t.close(); }
  });
});

describe('audit read API: problems, audit writes and roles', () => {
  test('401, 403 and 503 are problems with the request id echoed and no-store', async () => {
    const t = await harness();
    try {
      const anon = await t.get('/events', {}, { 'X-Request-ID': 'audit-401' });
      assert.equal(anon.status, 401);
      assert.equal(anon.headers.get('x-request-id'), 'audit-401');
      assert.equal(anon.headers.get('cache-control'), 'no-store');
      assert.ok(anon.headers.get('content-type')?.startsWith('application/problem+json'));
      const anonBody = problem(await anon.json());
      assert.deepEqual(anonBody, {
        type: `${PROBLEM_TYPE_BASE}AUDIT_API_UNAUTHENTICATED`, title: 'Authentication is required',
        status: 401, code: 'AUDIT_API_UNAUTHENTICATED', request_id: 'audit-401',
      });
      const denied = await t.get('/events', { tenant: A, sub: 'developer-a' }, { 'X-Request-ID': 'audit-403' });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('x-request-id'), 'audit-403');
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.equal(problem(await denied.json()).code, 'AUDIT_API_FORBIDDEN');
      t.store.fail = new Error('audit unavailable');
      const down = await t.get('/events', AUDITOR, { 'X-Request-ID': 'audit-503' });
      assert.equal(down.status, 503);
      assert.equal(down.headers.get('x-request-id'), 'audit-503');
      assert.equal(down.headers.get('cache-control'), 'no-store');
      const downBody = problem(await down.json());
      assert.equal(downBody.code, 'AUDIT_API_UNAVAILABLE');
      assert.equal(downBody.request_id, 'audit-503');
      assert.ok(t.logs.some(line => line.includes('AUDIT_API_UNAVAILABLE') && line.includes('audit-503')));
    } finally { await t.close(); }
  });

  test('a minted request id is echoed when the caller sends none or a bad one', async () => {
    const t = await harness();
    try {
      const minted = await t.get('/events', AUDITOR);
      const id = minted.headers.get('x-request-id');
      assert.ok(id && REQUEST_ID_RE.test(id));
      const reminted = await t.get('/events', AUDITOR, { 'X-Request-ID': 'has spaces!' });
      const id2 = reminted.headers.get('x-request-id');
      assert.ok(id2 && REQUEST_ID_RE.test(id2) && id2 !== 'has spaces!');
    } finally { await t.close(); }
  });

  test('one audit.events.read per read carries filter names only', async () => {
    const store = new MemoryAuditStore();
    seed(store);
    const t = await harness({}, store);
    try {
      await t.get('/events?action=machine.registered&from=' + encodeURIComponent(T0), AUDITOR, { 'X-Request-ID': 'r-1' });
      const single = store.rows.find(r => r.tenantId === A) as AuditStoredRow;
      await t.get(`/events/${single.id}`, ADMIN, { 'X-Request-ID': 'r-2' });
      assert.equal(store.audits.length, 2);
      const [list, get] = store.audits;
      assert.equal(list.action, 'audit.events.read');
      assert.equal(list.actorType, 'tenant_auditor');
      assert.equal(list.actorId, 'auditor-a');
      assert.equal(list.targetType, 'security_audit_events');
      assert.equal(list.targetId, A);
      assert.deepEqual(list.details, { limit: 50, returned: 1, filters: ['action', 'from'], request_id: 'r-1' });
      assert.deepEqual(get.details, { limit: 1, returned: 1, filters: ['id'], request_id: 'r-2' });
      assert.equal(get.actorType, 'tenant_admin');
    } finally { await t.close(); }
  });

  test('a failing audit answers 503 with no rows', async () => {
    const store = new MemoryAuditStore();
    seed(store);
    const t = await harness({}, store);
    try {
      t.store.fail = new Error('audit unavailable');
      const res = await t.get('/events', ADMIN);
      assert.equal(res.status, 503);
      assert.equal(problem(await res.json()).code, 'AUDIT_API_UNAVAILABLE');
      assert.equal(store.audits.length, 0);
    } finally { await t.close(); }
  });

  test('the auditor reads and a developer is refused, decided by adminMembershipAllows', async () => {
    const store = new MemoryAuditStore();
    seed(store);
    const t = await harness({}, store);
    try {
      for (const path of ['/events', `/events/${store.rows[0].id}`, '/catalog']) {
        const ok = await t.get(path, AUDITOR);
        assert.equal(ok.status, 200, `auditor reads ${path}`);
        const refused = await t.get(path, { tenant: A, sub: 'developer-a' });
        assert.equal(refused.status, 403, `developer refused on ${path}`);
        assert.equal(problem(await refused.json()).code, 'AUDIT_API_FORBIDDEN');
        const revoked = await t.get(path, { tenant: A, sub: 'revoked-a' });
        assert.equal(revoked.status, 403, `revoked auditor refused on ${path}`);
      }
    } finally { await t.close(); }
  });
});
