/**
 * Attesta evidence API (Task15i, A15.9 part 1): the real Express router in-process
 * over a fake read store (the queries' tenant binding is checked on the rendered SQL).
 *
 * Ported from SushiCorp @ 0bd67a5 (catalog AP-1, AU-1): tests/unit/api/test_api_gaps.py
 * (paging, filters, bad cursor and filters refused, other tenant sees nothing),
 * tests/unit/api/test_api_auditor.py (the route-table test: walk every registered route,
 * compare with a hand-kept list, so a new route fails until it is classified; the
 * auditor writes nothing) and api_harness.py (an in-process app with role headers).
 * Deviations: 400 instead of 422; problems carry no `detail`; the sweep also checks that
 * a non-member and a revoked auditor get 403 on every route (TrackAI roles, not
 * SushiCorp's read-only principal); the OpenAPI half is not ported (Task11).
 */
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import express, { type RequestHandler, type Router } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { adminMembershipAllows, type AdminMembershipRecord } from '../../core/security/admin-authorization';
import { createAttestaRouter, type AttestaRouterDeps } from './attesta.routes';
import { PROBLEM_TYPE_BASE, REQUEST_ID_RE, problemizeAuth } from './http';
import {
  ANCHOR_WINDOW_MS, AttestaQueryError, MAX_VERIFY_RANGE, anchorStatusOf, decodeCursor, encodeCursor,
  parseListQuery, parseRfc3339, pgReadStore,
  type AnchorRowOut, type AttestaReadStore, type Cursor, type ListFilter, type StatementDetailRow,
  type StatementRow, type SubjectRow, type VerifyAuditInput,
} from './read-service';
import { sha256Prefixed } from './canonical';
import { assertTenantBound } from './testing/builder-world';
import { buildChain, makeStatement, shaOf } from './testing/ledger-fixtures';
import { DEFAULT_ANCHOR_WINDOW_MS, verifyChainRows, type ChainReport, type VerifyChainOptions } from './verify-chain';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const REPO_A = '00000000-0000-4000-8000-0000000000a1';
const REPO_B = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const PREDICATE = 'https://trackai.dev/attesta/ai-provenance/v1';

// ---------------------------------------------------------------------------
// Fake store: rows as the tables hold them

interface FakeRecord {
  tenantId: string;
  digest: string;
  seq: number;
  recordedAt: string;
  kind: string | null;
  repositoryId: string;
  subjectSha: string | null;
  statementCanonical: string;
  anchors: AnchorRowOut[];
}

class FakeStore implements AttestaReadStore {
  records: FakeRecord[] = [];
  audits: VerifyAuditInput[] = [];
  heads = new Map<string, number>();
  fail: Error | null = null;
  listCalls = 0;

  add(tenantId: string, o: { seq: number; ageMs: number; kind?: 'commit_observed' | 'pr_merged' | 'deployed'; repositoryId: string;
    subjectSha?: string; previous?: string[]; rekor?: boolean; tsa?: boolean; failedTsa?: boolean }): FakeRecord {
    const subjectSha = o.subjectSha ?? shaOf(`${tenantId}-${o.seq}`);
    const kind = o.kind ?? 'commit_observed';
    const statementCanonical = makeStatement({
      repositoryId: o.repositoryId, subjectSha, kind,
      previous: (o.previous ?? []).map((digest) => ({ digest, statement_kind: 'commit_observed' as const })),
      asOf: new Date(NOW.getTime() - o.ageMs).toISOString(),
    });
    const anchors: AnchorRowOut[] = [];
    const anchor = (type: 'rekor' | 'tsa', status: 'anchored' | 'failed'): AnchorRowOut => ({
      anchor_type: type, status, inclusion_proof: status === 'anchored' ? { version: 1 } : null,
      rekor_entry_uuid: type === 'rekor' && status === 'anchored' ? 'a'.repeat(64) : null,
      tsa_token_b64: type === 'tsa' && status === 'anchored' ? 'AAAA' : null,
      error_code: status === 'failed' ? 'ATTESTA_ANCHOR_TSA_UNAVAILABLE' : null, created_at: '2026-10-13T11:00:00.000000Z',
    });
    if (o.failedTsa) anchors.push(anchor('tsa', 'failed'));
    if (o.rekor) anchors.push(anchor('rekor', 'anchored'));
    if (o.tsa) anchors.push(anchor('tsa', 'anchored'));
    const rec: FakeRecord = {
      tenantId, digest: sha256Prefixed(statementCanonical), seq: o.seq,
      recordedAt: new Date(NOW.getTime() - o.ageMs).toISOString().replace('Z', '000Z'),
      kind, repositoryId: o.repositoryId, subjectSha, statementCanonical, anchors,
    };
    this.records.push(rec);
    this.heads.set(tenantId, Math.max(this.heads.get(tenantId) ?? -1, o.seq));
    return rec;
  }

  private row(r: FakeRecord): StatementRow {
    return {
      statementDigest: r.digest, seq: r.seq, recordedAt: r.recordedAt, statementKind: r.kind, predicateType: PREDICATE,
      repositoryId: r.repositoryId, subjectSha: r.subjectSha,
      rekorAnchored: r.anchors.some((a) => a.anchor_type === 'rekor' && a.status === 'anchored'),
      tsaAnchored: r.anchors.some((a) => a.anchor_type === 'tsa' && a.status === 'anchored'),
    };
  }

  private check(): void { if (this.fail) throw this.fail; }

  async listStatements(tenantId: string, filter: ListFilter, after: Cursor | null, limit: number): Promise<StatementRow[]> {
    this.check();
    this.listCalls++;
    return this.records
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => !filter.repositoryId || r.repositoryId === filter.repositoryId)
      .filter((r) => !filter.kind || (filter.kind === 'period_report' ? r.kind === null : r.kind === filter.kind))
      .filter((r) => !filter.subjectSha || r.subjectSha === filter.subjectSha)
      .filter((r) => !filter.from || Date.parse(r.recordedAt) >= Date.parse(filter.from))
      .filter((r) => !filter.to || Date.parse(r.recordedAt) <= Date.parse(filter.to))
      .filter((r) => !after || r.seq > after.s)
      .sort((x, y) => x.seq - y.seq)
      .slice(0, limit)
      .map((r) => this.row(r));
  }

  async getStatement(tenantId: string, digest: string): Promise<StatementDetailRow | null> {
    this.check();
    const r = this.records.find((x) => x.tenantId === tenantId && x.digest === digest);
    if (!r) return null;
    return {
      seq: r.seq, prevHash: 'sha256:' + '0'.repeat(64), recordedAt: r.recordedAt, recordHash: 'sha256:' + '1'.repeat(64),
      canonicalRecord: '{"seq":0}', statementCanonical: r.statementCanonical,
      envelope: { payload: Buffer.from(r.statementCanonical).toString('base64'), payloadType: 'application/vnd.in-toto+json',
        signatures: [{ keyid: 'sha256:' + '2'.repeat(64), sig: 'MEUC' }] },
      anchors: r.anchors,
    };
  }

  async subjectStatements(tenantId: string, repositoryId: string, sha: string, limit: number): Promise<SubjectRow[]> {
    this.check();
    return this.records
      .filter((r) => r.tenantId === tenantId && r.repositoryId === repositoryId && r.subjectSha === sha)
      .sort((x, y) => x.seq - y.seq).slice(0, limit)
      .map((r) => ({ ...this.row(r), statementCanonical: r.statementCanonical }));
  }

  async chainExtent(tenantId: string): Promise<number> {
    this.check();
    return this.heads.get(tenantId) ?? -1;
  }

  async recordVerifyAudit(input: VerifyAuditInput): Promise<void> {
    this.audits.push(input);
  }
}

// ---------------------------------------------------------------------------
// Authorization: the same answers as core/middleware/admin.ts requireAdminAction,
// over a fake membership table, deciding with the real adminMembershipAllows.

type Memberships = Map<string, AdminMembershipRecord | 'unavailable'>;

function fakeRequireAdmin(memberships: Memberships): RequestHandler {
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
    if (!adminMembershipAllows(m, { tenantId, subject, action: 'attesta.read' })) {
      res.status(403).json({ error: 'Forbidden: Tenant administrator permission is required' });
      return;
    }
    req.adminRole = m?.role;
    next();
  };
}

const member = (tenantId: string, subject: string, role: 'tenant_admin' | 'tenant_auditor', revoked = false): AdminMembershipRecord => ({
  tenantId, subject, role, status: revoked ? 'revoked' : 'active', revokedAt: revoked ? new Date() : null,
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
  store: FakeStore;
  router: Router;
  logs: string[];
  verifierCalls: Array<{ tenantId: string; options: VerifyChainOptions }>;
  close(): Promise<void>;
  get(path: string, who?: { tenant?: string; sub?: string }, headers?: Record<string, string>): Promise<Response>;
}

/** Real verifyChainRows over a built chain of the tenant's head length: report version 2, no keys. */
function chainVerifier(calls: Harness['verifierCalls'], store: FakeStore) {
  return async (tenantId: string, options: VerifyChainOptions): Promise<ChainReport> => {
    calls.push({ tenantId, options });
    const n = (store.heads.get(tenantId) ?? -1) + 1;
    const chain = buildChain(n, { tenantId, repositoryId: REPO_A });
    const fromSeq = options.fromSeq ?? 0;
    const toSeq = options.toSeq ?? Math.max(fromSeq, n - 1);
    return verifyChainRows(chain.rows, { tenantId, fromSeq, toSeq, head: chain.head, keys: options.keys });
  };
}

async function harness(over: Partial<AttestaRouterDeps> = {}, store = new FakeStore()): Promise<Harness> {
  const logs: string[] = [];
  const verifierCalls: Harness['verifierCalls'] = [];
  const router = createAttestaRouter({
    store, authorize: fakeRequireAdmin(memberships()), verifier: chainVerifier(verifierCalls, store),
    anchors: async () => null, now: () => NOW, log: (l) => logs.push(l), ...over,
  });
  const app = express();
  app.use((req, _res, next) => {
    // Stands in for /api's JWT + tenant middleware.
    const tenant = req.get('x-test-tenant');
    const sub = req.get('x-test-sub');
    if (tenant) req.tenantId = tenant;
    if (sub) req.user = { sub } as Express.AuthenticatedUser;
    next();
  });
  app.use('/api/attesta', router);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attesta`;
  return {
    url, store, router, logs, verifierCalls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get: (path, who = { tenant: A, sub: 'auditor-a' }, headers = {}) => fetch(url + path, {
      headers: { ...(who.tenant ? { 'x-test-tenant': who.tenant } : {}), ...(who.sub ? { 'x-test-sub': who.sub } : {}), ...headers },
    }),
  };
}

async function expectProblem(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('content-type')?.split(';')[0], 'application/problem+json');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'request_id', 'status', 'title', 'type']);
  assert.equal(body.code, code);
  assert.equal(body.status, status);
  assert.equal(body.type, PROBLEM_TYPE_BASE + code);
  assert.equal(body.request_id, res.headers.get('x-request-id'));
  return body;
}

const ITEM_KEYS = ['anchor_status', 'predicate_type', 'recorded_at', 'repository_id', 'seq', 'statement_digest', 'statement_kind', 'subject_sha'];

// ---------------------------------------------------------------------------

describe('attesta.read authorization', () => {
  test('tenant_admin and tenant_auditor are allowed attesta.read; revoked, other-tenant and absent are not', () => {
    const input = { tenantId: A, subject: 'auditor-a', action: 'attesta.read' as const };
    assert.equal(adminMembershipAllows(member(A, 'auditor-a', 'tenant_auditor'), input), true);
    assert.equal(adminMembershipAllows(member(A, 'auditor-a', 'tenant_admin'), input), true);
    assert.equal(adminMembershipAllows(member(A, 'auditor-a', 'tenant_auditor', true), input), false);
    assert.equal(adminMembershipAllows(member(B, 'auditor-a', 'tenant_auditor'), input), false);
    assert.equal(adminMembershipAllows(null, input), false);
  });
});

describe('query parsing', () => {
  test('cursor round-trips and refuses anything it did not print', () => {
    const c = { r: '2026-10-13T11:00:00.123456Z', s: 41 };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
    const bad = [
      'bogus!', '', Buffer.from('{"r":"x","s":1}').toString('base64url'),
      Buffer.from('{"r":"2026-10-13T11:00:00.123456Z","s":-1}').toString('base64url'),
      Buffer.from('{"r":"2026-10-13T11:00:00.123456Z","s":1.5}').toString('base64url'),
      Buffer.from('{"r":"2026-10-13T11:00:00.123456Z","s":1,"t":"x"}').toString('base64url'),
      Buffer.from('{"s":1,"r":"2026-10-13T11:00:00.123456Z"}').toString('base64url'),
      Buffer.from('[1]').toString('base64url'), Buffer.from('not json').toString('base64url'),
      encodeCursor(c) + 'A', 'A'.repeat(300),
    ];
    for (const raw of bad) assert.throws(() => decodeCursor(raw), AttestaQueryError, raw);
  });

  test('RFC 3339 needs a real calendar instant', () => {
    assert.equal(parseRfc3339('2026-10-13T11:00:00Z', 'from'), Date.parse('2026-10-13T11:00:00Z'));
    assert.equal(parseRfc3339('2026-10-13T16:30:00.5+05:30', 'from'), Date.parse('2026-10-13T11:00:00.5Z'));
    for (const v of ['2026-02-30T00:00:00Z', '2026-10-13', '2026-10-13T24:00:00Z', '2026-10-13T11:00:00', '2026-13-01T00:00:00Z',
      '2026-10-13T11:00:00+25:00', '2026-10-13 11:00:00Z', '2026-10-13T11:00:00.1234567Z']) {
      assert.throws(() => parseRfc3339(v, 'from'), AttestaQueryError, v);
    }
  });

  test('limit bounds and defaults', () => {
    assert.equal(parseListQuery({}).limit, 50);
    assert.equal(parseListQuery({ limit: '200' }).limit, 200);
    for (const limit of ['0', '201', '01', '-1', '1.5', 'x', ['1', '2'] as unknown as string]) {
      assert.throws(() => parseListQuery({ limit }), AttestaQueryError, String(limit));
    }
  });

  test('anchor_status: anchored needs both types; pending inside the window; missing beyond it or far in the future', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    assert.equal(ANCHOR_WINDOW_MS, DEFAULT_ANCHOR_WINDOW_MS);
    assert.equal(anchorStatusOf({ rekor: true, tsa: true }, at(10 * ANCHOR_WINDOW_MS), NOW), 'anchored');
    assert.equal(anchorStatusOf({ rekor: true, tsa: false }, at(1000), NOW), 'pending');
    assert.equal(anchorStatusOf({ rekor: false, tsa: false }, at(ANCHOR_WINDOW_MS), NOW), 'pending');
    assert.equal(anchorStatusOf({ rekor: false, tsa: true }, at(ANCHOR_WINDOW_MS + 1), NOW), 'missing');
    assert.equal(anchorStatusOf({ rekor: false, tsa: false }, at(-10 * 60_000), NOW), 'missing');
    assert.equal(anchorStatusOf({ rekor: false, tsa: false }, 'not a time', NOW), 'missing');
  });
});

describe('pgReadStore', () => {
  test('every query is bound to the tenant and never selects credential_id', async () => {
    const dialect = new PgDialect();
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const executor = {
      async execute(q: SQL) {
        const r = dialect.sqlToQuery(q);
        seen.push(r);
        if (/from attesta_records r\s+left join attesta_envelopes/.test(r.sql)) {
          return { rows: [{ id: '00000000-0000-4000-8000-0000000000ff', seq: '3', prev_hash: 'p', recorded_at: 't',
            record_hash: 'h', canonical_record: '{}', statement_canonical: '{}', envelope: {} }] };
        }
        return { rows: [] };
      },
    };
    const store = pgReadStore(executor);
    await store.listStatements(A, { repositoryId: REPO_A, kind: 'pr_merged', subjectSha: shaOf(1), from: '2026-10-01T00:00:00Z', to: '2026-10-14T00:00:00Z' },
      { r: '2026-10-13T11:00:00.000000Z', s: 3 }, 51);
    await store.listStatements(A, { kind: 'period_report' }, null, 51);
    await store.getStatement(A, 'sha256:' + 'a'.repeat(64));
    await store.subjectStatements(A, REPO_A, shaOf(1), 200);
    await store.chainExtent(A);
    assert.equal(seen.length, 6);
    for (const q of seen) {
      assertTenantBound(q.sql, q.params, A, 'read-service');
      assert.doesNotMatch(q.sql, /credential_id/);
      assert.ok(!q.params.includes(B));
    }
    assert.match(seen[1].sql, /statement_kind is null/);
    assert.match(seen[0].sql, /order by r\.seq/);
  });
});

describe('GET /statements', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    h.store.add(A, { seq: 0, ageMs: 3 * ANCHOR_WINDOW_MS, repositoryId: REPO_A, rekor: true, tsa: true });
    h.store.add(A, { seq: 1, ageMs: 2 * ANCHOR_WINDOW_MS, repositoryId: REPO_A, rekor: true, failedTsa: true });
    h.store.add(A, { seq: 2, ageMs: 60_000, repositoryId: REPO_A, kind: 'pr_merged' });
    h.store.add(A, { seq: 3, ageMs: 30_000, repositoryId: REPO_B, kind: 'deployed' });
    h.store.add(A, { seq: 4, ageMs: 10_000, repositoryId: REPO_A });
    h.store.add(B, { seq: 0, ageMs: 10_000, repositoryId: REPO_B });
  });
  after(() => h.close());

  test('a page of typed columns with anchor_status, seq ascending', async () => {
    const res = await h.get('/statements');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json() as { statements: Array<Record<string, unknown>>; next_cursor: string | null };
    assert.deepEqual(Object.keys(body).sort(), ['next_cursor', 'statements']);
    assert.equal(body.next_cursor, null);
    assert.deepEqual(body.statements.map((s) => s.seq), [0, 1, 2, 3, 4]);
    for (const s of body.statements) assert.deepEqual(Object.keys(s).sort(), ITEM_KEYS);
    assert.deepEqual(body.statements.map((s) => s.anchor_status), ['anchored', 'missing', 'pending', 'pending', 'pending']);
    assert.equal(typeof body.statements[0].seq, 'number');
    assert.match(String(body.statements[0].recorded_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  test('pages across a stable cursor until next_cursor is null', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path = `/statements?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const body = await (await h.get(path)).json() as { statements: Array<{ seq: number }>; next_cursor: string | null };
      const again = await (await h.get(path)).json() as { next_cursor: string | null };
      assert.equal(again.next_cursor, body.next_cursor, 'the same page gives the same cursor');
      seen.push(...body.statements.map((s) => s.seq));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
    assert.equal(pages, 3);
  });

  test('filters: repository, kind, subject, time range', async () => {
    const seqs = async (q: string) => ((await (await h.get(`/statements?${q}`)).json()) as { statements: Array<{ seq: number }> })
      .statements.map((s) => s.seq);
    assert.deepEqual(await seqs(`repository_id=${REPO_B}`), [3]);
    assert.deepEqual(await seqs('kind=pr_merged'), [2]);
    assert.deepEqual(await seqs('kind=period_report'), []);
    const sha = h.store.records[4].subjectSha;
    assert.deepEqual(await seqs(`subject_sha=${sha}`), [4]);
    const from = new Date(NOW.getTime() - 45_000).toISOString();
    assert.deepEqual(await seqs(`from=${from}`), [3, 4]);
    assert.deepEqual(await seqs(`to=${from}`), [0, 1, 2]);
  });

  test('another tenant sees only its own statements', async () => {
    const body = await (await h.get('/statements', { tenant: B, sub: 'auditor-b' })).json() as { statements: Array<{ repository_id: string }> };
    assert.equal(body.statements.length, 1);
    assert.equal(body.statements[0].repository_id, REPO_B);
  });

  test('every invalid parameter and a tampered cursor is a 400 problem', async () => {
    const good = encodeCursor({ r: '2026-10-13T11:00:00.000000Z', s: 1 });
    const tampered = good.slice(0, -2) + (good.endsWith('A') ? 'B' : 'A') + good.slice(-1);
    const cases = [
      'unknown=1', 'repository_id=not-a-uuid', `repository_id=${REPO_A.toUpperCase()}`, 'kind=commit', 'kind=',
      `subject_sha=${'A'.repeat(40)}`, `subject_sha=${'a'.repeat(39)}`, 'from=yesterday', 'from=2026-02-30T00:00:00Z',
      'to=2026-10-13', 'from=2026-10-13T12:00:00Z&to=2026-10-13T11:00:00Z', 'limit=0', 'limit=201', 'limit=x',
      'limit=1&limit=2', 'kind[]=deployed', 'cursor=bogus', `cursor=${tampered}`, `cursor=${good}x`,
      `cursor=${Buffer.from('{"r":"2026-10-13T11:00:00.000000Z","s":"1"}').toString('base64url')}`,
    ];
    const before = h.store.listCalls;
    for (const q of cases) await expectProblem(await h.get(`/statements?${q}`), 400, 'ATTESTA_API_INVALID_QUERY');
    assert.equal(h.store.listCalls, before, 'nothing reaches the store');
  });
});

describe('GET /statements/{digest} and /subjects', () => {
  let h: Harness;
  let first: FakeRecord;
  let second: FakeRecord;
  let theirs: FakeRecord;
  before(async () => {
    h = await harness();
    const sha = shaOf('subject');
    first = h.store.add(A, { seq: 0, ageMs: 10_000, repositoryId: REPO_A, subjectSha: sha, rekor: true, tsa: true });
    second = h.store.add(A, { seq: 1, ageMs: 5_000, repositoryId: REPO_A, subjectSha: sha, kind: 'pr_merged', previous: [first.digest] });
    theirs = h.store.add(B, { seq: 0, ageMs: 5_000, repositoryId: REPO_B, subjectSha: shaOf('theirs') });
  });
  after(() => h.close());

  test('detail returns record, parsed statement, stored envelope and anchors; never credential_id', async () => {
    const res = await h.get(`/statements/${first.digest}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    assert.doesNotMatch(text, /credential/);
    const body = JSON.parse(text) as Record<string, any>;
    assert.deepEqual(Object.keys(body).sort(), ['anchors', 'envelope', 'record', 'statement']);
    assert.deepEqual(Object.keys(body.record).sort(), ['canonical_record', 'prev_hash', 'record_hash', 'recorded_at', 'seq']);
    assert.equal(body.statement.predicateType, PREDICATE);
    assert.equal(body.envelope.payloadType, 'application/vnd.in-toto+json');
    assert.equal(body.anchors.length, 2);
    assert.deepEqual(Object.keys(body.anchors[0]).sort(),
      ['anchor_type', 'created_at', 'error_code', 'inclusion_proof', 'rekor_entry_uuid', 'status', 'tsa_token_b64']);
  });

  test("another tenant's digest is the same 404 as a digest that does not exist", async () => {
    const strip = async (res: Response) => {
      const body = await expectProblem(res, 404, 'ATTESTA_API_NOT_FOUND');
      delete body.request_id;
      return { body, type: res.headers.get('content-type'), length: res.headers.get('content-length') };
    };
    const cross = await strip(await h.get(`/statements/${theirs.digest}`));
    const unknown = await strip(await h.get(`/statements/sha256:${'e'.repeat(64)}`));
    assert.deepEqual(cross, unknown);
    assert.equal((await h.get(`/statements/${theirs.digest}`, { tenant: B, sub: 'auditor-b' })).status, 200);
  });

  test('a malformed digest or any query parameter is a 400', async () => {
    for (const path of [`/statements/${first.digest.toUpperCase()}`, '/statements/sha256:abc', `/statements/${first.digest.slice(7)}`,
      `/statements/${first.digest}?x=1`]) {
      await expectProblem(await h.get(path), 400, 'ATTESTA_API_INVALID_QUERY');
    }
  });

  test('subject: every statement about the commit, oldest first, with previous', async () => {
    const res = await h.get(`/subjects/${REPO_A}/${first.subjectSha}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { statements: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(body), ['statements']);
    assert.deepEqual(body.statements.map((s) => s.statement_digest), [first.digest, second.digest]);
    assert.deepEqual(body.statements.map((s) => s.previous), [[], [first.digest]]);
    assert.deepEqual(Object.keys(body.statements[0]).sort(), [...ITEM_KEYS, 'previous'].sort());
    assert.deepEqual(body.statements.map((s) => s.anchor_status), ['anchored', 'pending']);
  });

  test("subject: none, another tenant's, or malformed", async () => {
    await expectProblem(await h.get(`/subjects/${REPO_A}/${shaOf('none')}`), 404, 'ATTESTA_API_NOT_FOUND');
    await expectProblem(await h.get(`/subjects/${REPO_B}/${theirs.subjectSha}`), 404, 'ATTESTA_API_NOT_FOUND');
    await expectProblem(await h.get(`/subjects/not-a-uuid/${first.subjectSha}`), 400, 'ATTESTA_API_INVALID_QUERY');
    await expectProblem(await h.get(`/subjects/${REPO_A}/${'G'.repeat(40)}`), 400, 'ATTESTA_API_INVALID_QUERY');
    await expectProblem(await h.get(`/subjects/${REPO_A}/${first.subjectSha}?limit=1`), 400, 'ATTESTA_API_INVALID_QUERY');
  });

  test('reads are not audited', () => {
    assert.equal(h.store.audits.length, 0);
  });
});

describe('conventions', () => {
  let h: Harness;
  before(async () => { h = await harness(); });
  after(() => h.close());

  test('a bounded X-Request-ID is echoed; anything else is replaced by a UUID; errors too', async () => {
    const ok = await h.get('/statements', undefined, { 'X-Request-ID': 'req-42.a_b' });
    assert.equal(ok.headers.get('x-request-id'), 'req-42.a_b');
    const err = await h.get('/statements?bad=1', undefined, { 'X-Request-ID': 'req-43' });
    assert.equal((await expectProblem(err, 400, 'ATTESTA_API_INVALID_QUERY')).request_id, 'req-43');
    for (const bad of ['x'.repeat(65), 'has space', 'semi;colon', 'a/b', '<script>']) {
      const res = await h.get('/statements', undefined, { 'X-Request-ID': bad });
      const id = res.headers.get('x-request-id') ?? '';
      assert.notEqual(id, bad);
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const generated = await h.get('/statements');
    assert.match(generated.headers.get('x-request-id') ?? '', REQUEST_ID_RE);
  });

  test('a malformed percent-encoded path parameter is a 400, not a 500', async () => {
    await expectProblem(await h.get('/statements/%E0%A4%A'), 400, 'ATTESTA_API_INVALID_QUERY');
    await expectProblem(await h.get('/subjects/%zz/abc'), 400, 'ATTESTA_API_INVALID_QUERY');
    assert.equal(h.logs.length, 0);
  });

  test('the default router is guarded by the real requireAdminAction', async () => {
    // No identity: the real middleware refuses before any database lookup; the refusal is a problem.
    const app = express();
    app.use('/api/attesta', createAttestaRouter({ store: new FakeStore() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attesta/statements`);
      await expectProblem(res, 401, 'ATTESTA_API_UNAUTHENTICATED');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('an unknown path or method is a 404 problem; nothing falls through', async () => {
    await expectProblem(await h.get('/nope'), 404, 'ATTESTA_API_NOT_FOUND');
    const post = await fetch(`${h.url}/statements`, { method: 'POST', headers: { 'x-test-tenant': A, 'x-test-sub': 'admin-a' } });
    await expectProblem(post, 404, 'ATTESTA_API_NOT_FOUND');
  });

  test('a store failure is a generic 500; the log has the code and request id, never the message', async () => {
    h.store.fail = new Error('connection to db://user:secret@host failed');
    try {
      const res = await h.get('/statements', undefined, { 'X-Request-ID': 'req-500' });
      const body = await expectProblem(res, 500, 'ATTESTA_API_INTERNAL');
      assert.equal(body.title, 'The service could not complete the request');
      assert.equal(h.logs.length, 1);
      assert.match(h.logs[0], /ATTESTA_API_INTERNAL request_id=req-500/);
      assert.doesNotMatch(h.logs[0], /secret/);
    } finally {
      h.store.fail = null;
    }
  });

  test('problemizeAuth maps 401, 403 and 503 and passes success through', async () => {
    for (const [status, expected, code] of [[401, 401, 'ATTESTA_API_UNAUTHENTICATED'], [403, 403, 'ATTESTA_API_FORBIDDEN'],
      [503, 503, 'ATTESTA_API_UNAVAILABLE'], [500, 503, 'ATTESTA_API_UNAVAILABLE']] as const) {
      const app = express();
      app.use((_req, res, next) => { res.locals.attestaRequestId = 'rid'; next(); });
      app.use(problemizeAuth((_req, res) => { res.status(status).json({ error: 'internal words' }); }));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      assert.equal(res.status, expected);
      const text = await res.text();
      assert.doesNotMatch(text, /internal words/);
      assert.equal(JSON.parse(text).code, code);
      await new Promise((r) => server.close(r));
    }
  });
});

describe('GET /verify', () => {
  test("verifyChain's report (version 2): signatures not checked, never ok; one audit row", async () => {
    const h = await harness();
    try {
      for (let seq = 0; seq < 3; seq++) h.store.add(A, { seq, ageMs: 1000, repositoryId: REPO_A });
      await h.get('/statements');
      assert.equal(h.store.audits.length, 0);
      const res = await h.get('/verify', { tenant: A, sub: 'auditor-a' }, { 'X-Request-ID': 'req-v1' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const report = await res.json() as ChainReport;
      assert.equal(report.report_version, 2);
      assert.equal(report.ok, false);
      assert.equal(report.chain_intact, true);
      assert.equal(report.signatures, 'not_checked');
      assert.deepEqual(report.breaks.map((b) => b.detail_code), ['ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED']);
      assert.deepEqual(report.anchors, { status: 'not_checked' });
      assert.deepEqual(report.range, { from_seq: 0, to_seq: 2 });
      assert.deepEqual(h.verifierCalls.map((c) => c.options), [{ fromSeq: 0, toSeq: 2 }], 'no keys, no anchors, the extent as to_seq');
      assert.deepEqual(h.store.audits, [{
        tenantId: A, actorId: 'auditor-a', actorRole: 'tenant_auditor', requestId: 'req-v1', fromSeq: 0, toSeq: 2,
        ok: false, checked: 3, breakCount: 1,
      }]);
    } finally {
      await h.close();
    }
  });

  test('ranges: explicit, open, empty chain, bounds', async () => {
    const h = await harness();
    try {
      for (let seq = 0; seq < 5; seq++) h.store.add(A, { seq, ageMs: 1000, repositoryId: REPO_A });
      assert.equal((await h.get('/verify?from_seq=1&to_seq=3')).status, 200);
      assert.equal((await h.get('/verify?from_seq=2')).status, 200);
      assert.equal((await h.get('/verify?to_seq=1')).status, 200);
      const empty = await (await h.get('/verify', { tenant: B, sub: 'auditor-b' })).json() as ChainReport;
      assert.equal(empty.checked, 0);
      assert.deepEqual(h.verifierCalls.map((c) => c.options),
        [{ fromSeq: 1, toSeq: 3 }, { fromSeq: 2, toSeq: 4 }, { fromSeq: 0, toSeq: 1 }, { fromSeq: 0 }]);
      for (const q of ['from_seq=-1', 'from_seq=x', 'to_seq=1.5', 'from_seq=3&to_seq=2', `from_seq=0&to_seq=${MAX_VERIFY_RANGE}`,
        'from_seq=1&from_seq=2', 'seq=1', 'from_seq=9999999999999999']) {
        await expectProblem(await h.get(`/verify?${q}`), 400, 'ATTESTA_API_INVALID_QUERY');
      }
      assert.equal((await h.get(`/verify?from_seq=0&to_seq=${MAX_VERIFY_RANGE - 1}`)).status, 200);
      // An open range over a chain longer than the bound is refused (no silent truncation).
      h.store.heads.set(A, MAX_VERIFY_RANGE + 5);
      await expectProblem(await h.get('/verify'), 400, 'ATTESTA_API_INVALID_QUERY');
      assert.equal(h.store.audits.length, 5);
    } finally {
      await h.close();
    }
  });

  test('published keys and anchor material reach verifyChain when supplied', async () => {
    const key = createPublicKey({ key: (await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }) });
    const material = { rekorLogKey: key, anchorKeysSpkiDer: [], tsaAnchors: [] };
    const h = await harness({ keys: async () => [{ keyid: 'sha256:' + 'f'.repeat(64), publicKey: key }], anchors: async () => material });
    try {
      h.store.add(A, { seq: 0, ageMs: 1000, repositoryId: REPO_A });
      assert.equal((await h.get('/verify')).status, 200);
      const options = h.verifierCalls[0].options;
      assert.deepEqual(Object.keys(options.keys ?? {}), ['sha256:' + 'f'.repeat(64)]);
      assert.equal(options.anchors?.windowMs, ANCHOR_WINDOW_MS);
      assert.equal(options.anchors?.now.getTime(), NOW.getTime());
      assert.equal(options.anchors?.rekorLogKey, key);
    } finally {
      await h.close();
    }
  });

  test('broken anchor configuration is a 500 (never a silent skip), still audited as a failed verify', async () => {
    const h = await harness({ anchors: async () => { throw new Error('ATTESTA_TSA_ANCHORS_FILE /secret/path'); } });
    try {
      h.store.add(A, { seq: 0, ageMs: 1000, repositoryId: REPO_A });
      await expectProblem(await h.get('/verify', undefined, { 'X-Request-ID': 'req-fail' }), 500, 'ATTESTA_API_INTERNAL');
      assert.deepEqual(h.store.audits, [{
        tenantId: A, actorId: 'auditor-a', actorRole: 'tenant_auditor', requestId: 'req-fail', fromSeq: 0, toSeq: 0,
        ok: false, checked: 0, breakCount: 0, failed: true,
      }]);
      assert.equal(h.verifierCalls.length, 0);
      assert.doesNotMatch(h.logs.join('\n'), /secret/);
    } finally {
      await h.close();
    }
  });

  test('one verify per tenant at a time: the second is 429 with Retry-After: 5; other tenants are not blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = new FakeStore();
    store.add(A, { seq: 0, ageMs: 1000, repositoryId: REPO_A });
    store.add(B, { seq: 0, ageMs: 1000, repositoryId: REPO_B });
    const calls: Harness['verifierCalls'] = [];
    const inner = chainVerifier(calls, store);
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const h = await harness({
      verifier: async (tenantId, options) => {
        if (tenantId === A) { entered(); await gate; }
        return inner(tenantId, options);
      },
    }, store);
    try {
      const first = h.get('/verify');
      await inside;
      const second = await h.get('/verify', { tenant: A, sub: 'admin-a' });
      const body = await expectProblem(second, 429, 'ATTESTA_API_RATE_LIMITED');
      assert.equal(second.headers.get('retry-after'), '5');
      assert.equal(body.status, 429);
      assert.equal((await h.get('/verify', { tenant: B, sub: 'auditor-b' })).status, 200);
      release();
      assert.equal((await first).status, 200);
      assert.equal((await h.get('/verify')).status, 200, 'the guard is released');
      assert.equal(store.audits.length, 3);
    } finally {
      release();
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AU-1: the route table, swept

/** Every route the Attesta router serves, classified. A new route fails here until it is listed. */
const EXPECTED_ROUTES = new Set([
  'GET /statements',
  'GET /statements/:digest',
  'GET /subjects/:repository_id/:sha',
  'GET /verify',
]);
/** Routes that change anything (Task15i2 adds the POSTs; the auditor must get 403 on them). */
const EXPECTED_MUTATING = new Set<string>();
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The router's non-route layers, in order: a nested router or new middleware fails the sweep. */
const EXPECTED_MIDDLEWARE = ['attestaHttp', 'attestaAuthorize', 'attestaNotFound', 'attestaError'];

function middlewareTable(router: Router): string[] {
  return (router.stack as Array<{ route?: unknown; name: string }>).filter((l) => !l.route).map((l) => l.name);
}

function routeTable(router: Router): string[] {
  const out: string[] = [];
  for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) if (on) out.push(`${method.toUpperCase()} ${layer.route.path}`);
  }
  return out;
}

function concrete(route: string): string {
  const path = route.split(' ')[1];
  return path
    .replace(':digest', `sha256:${'c'.repeat(64)}`)
    .replace(':repository_id', REPO_A)
    .replace(':sha', shaOf('sweep'));
}

describe('route sweep (AU-1)', () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    h.store.add(A, { seq: 0, ageMs: 1000, repositoryId: REPO_A, subjectSha: shaOf('sweep') });
  });
  after(() => h.close());

  test('the route table is what we expect, and nothing in it writes', () => {
    const table = routeTable(h.router);
    assert.deepEqual(new Set(table), EXPECTED_ROUTES, 'a route was added or removed: classify it here and in the handoff');
    assert.equal(table.length, EXPECTED_ROUTES.size);
    assert.deepEqual(new Set(table.filter((r) => MUTATING.has(r.split(' ')[0]))), EXPECTED_MUTATING);
    assert.deepEqual(middlewareTable(h.router), EXPECTED_MIDDLEWARE, 'no nested router or unclassified middleware');
  });

  test('every route: 403 problem for a non-member, a revoked auditor, another tenant\'s auditor; 503 when lookup fails', async () => {
    for (const route of EXPECTED_ROUTES) {
      const path = concrete(route);
      for (const sub of ['stranger', 'revoked-a', 'auditor-b']) {
        await expectProblem(await h.get(path, { tenant: A, sub }), 403, 'ATTESTA_API_FORBIDDEN');
      }
      await expectProblem(await h.get(path, { tenant: A }), 401, 'ATTESTA_API_UNAUTHENTICATED');
      await expectProblem(await h.get(path, { tenant: A, sub: 'flaky-a' }), 503, 'ATTESTA_API_UNAVAILABLE');
    }
    assert.equal(h.store.listCalls, 0);
    assert.equal(h.store.audits.length, 0, 'a refused request writes nothing');
  });

  test('every route answers the auditor and the admin (none is admin-only)', async () => {
    for (const route of EXPECTED_ROUTES) {
      for (const sub of ['auditor-a', 'admin-a']) {
        const res = await h.get(concrete(route), { tenant: A, sub });
        assert.ok(res.status === 200 || res.status === 404, `${route} as ${sub}: ${res.status}`);
        assert.notEqual(res.status, 403);
      }
    }
  });
});
