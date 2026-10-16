/**
 * Q&A API (Task19a, T19.2): the real Express router in-process, with a fake
 * membership table decided by the real adminMembershipAllows and a fake scope store
 * (as features/audit/audit-api.test.ts). Mocked: the membership lookup and the
 * scope store (both database reads). No database.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { adminMembershipAllows, type AdminMembershipRecord } from '../../core/security/admin-authorization';
import { AnswererRegistrationError, createAnswererRegistry, type AnswererRegistry } from './answerers';
import type { QaContext } from './answers/common';
import { checkEnvelope } from './envelope';
import { PROBLEM_TYPE_BASE, QA_API_STATUSES, REQUEST_ID_RE, type QaApiCode } from './http';
import { createQaRouter, type QaRouterDeps } from './qa.routes';
import { QA_QUESTIONS, QA_REGISTRY_VERSION } from './registry';
import type { QaScopeStore } from './service';
import type { QaAnswerContext, QaEnvelope } from './types';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const REPO_A = '00000000-0000-4000-8000-0000000000a1';
const REPO_A2 = '00000000-0000-4000-8000-0000000000a2';
const REPO_B = '00000000-0000-4000-8000-0000000000b1';
const PR_A = '00000000-0000-4000-8000-0000000000c1';
const SHA_A = 'a'.repeat(40);
const NOW = new Date('2026-10-15T09:30:00.000Z');

type Memberships = Map<string, AdminMembershipRecord | 'unavailable'>;

/** The same answers as core/middleware/admin.ts requireAdminAction('qa.read'). */
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
    if (!adminMembershipAllows(m, { tenantId, subject, action: 'qa.read' })) {
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
    [`${B}/admin-b`, member(B, 'admin-b', 'tenant_admin')],
  ]);
}

class FakeScopes implements QaScopeStore {
  fail = false;
  repos = new Map([[REPO_A, A], [REPO_A2, A], [REPO_B, B]]);
  async repositoryExists(tenantId: string, id: string) { this.check(); return this.repos.get(id) === tenantId; }
  async pullRequestRepository(tenantId: string, id: string) { this.check(); return tenantId === A && id === PR_A ? REPO_A : null; }
  async commitExists(tenantId: string, repositoryId: string, sha: string) {
    this.check(); return tenantId === A && repositoryId === REPO_A && sha === SHA_A;
  }
  private check() { if (this.fail) throw new Error('database down'); }
}

interface Harness {
  get(path: string, who?: Who, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }>;
  logs: string[];
  scopes: FakeScopes;
  close(): Promise<void>;
}
type Who = { tenant?: string; sub?: string };
const ADMIN: Who = { tenant: A, sub: 'admin-a' };
const AUDITOR: Who = { tenant: A, sub: 'auditor-a' };
const DEVELOPER: Who = { tenant: A, sub: 'developer-a' };

async function harness(over: Partial<QaRouterDeps> = {}): Promise<Harness> {
  const logs: string[] = [];
  const scopes = new FakeScopes();
  const router = createQaRouter({
    authorize: fakeRequireAdmin(memberships()), answerers: createAnswererRegistry(), scopes,
    log: (l) => logs.push(l), now: () => NOW, ...over,
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
  app.use('/api/qa', router);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/qa`;
  return {
    logs, scopes,
    get: async (path, who = ADMIN, headers = {}) => {
      const res = await fetch(url + path, { headers: {
        ...(who.tenant ? { 'x-test-tenant': who.tenant } : {}), ...(who.sub ? { 'x-test-sub': who.sub } : {}), ...headers,
      } });
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, headers: res.headers, body };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function assertProblem(r: { status: number; headers: Headers; body: any }, code: QaApiCode): void {
  assert.equal(r.status, QA_API_STATUSES[code], `${code}: status`);
  assert.match(r.headers.get('content-type') ?? '', /^application\/problem\+json/);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'request_id', 'status', 'title', 'type']);
  assert.equal(r.body.code, code);
  assert.equal(r.body.type, PROBLEM_TYPE_BASE + code);
  assert.equal(r.body.request_id, r.headers.get('x-request-id'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
}

const answer = (id: string, params: string) => `/questions/${id}/answer?${params}`;

describe('qa api: registry routes', () => {
  test('GET /questions lists every entry, unpaged, no-store, request id echoed', async () => {
    const h = await harness();
    try {
      const r = await h.get('/questions', AUDITOR, { 'X-Request-ID': 'req-qa-1' });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-request-id'), 'req-qa-1');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.body.registry_version, QA_REGISTRY_VERSION);
      assert.equal(r.body.items.length, QA_QUESTIONS.length);
      assert.deepEqual(r.body.items.map((q: { id: string }) => q.id), QA_QUESTIONS.map((q) => q.id));
      // A bad request id is replaced, never rejected.
      const bad = await h.get('/questions', ADMIN, { 'X-Request-ID': 'has spaces!' });
      assert.equal(bad.status, 200);
      assert.match(bad.headers.get('x-request-id') ?? '', REQUEST_ID_RE);
      assert.notEqual(bad.headers.get('x-request-id'), 'has spaces!');
    } finally { await h.close(); }
  });

  test('GET /questions/:id: the entry, per kind built or not, open gaps; unknown id 404', async () => {
    const answerers = createAnswererRegistry();
    answerers.register('Q1', 'live', async (ctx) => notBuiltLike(ctx));
    const h = await harness({ answerers });
    try {
      const r = await h.get('/questions/Q1');
      assert.equal(r.status, 200);
      assert.equal(r.body.question.id, 'Q1');
      assert.deepEqual(r.body.answers.map((x: any) => [x.kind, x.builder, x.built, x.open_gaps]), [
        ['live', 'T19.3', true, ['G1']], ['verifiable', 'A16.13a', false, ['G1']], ['signed', 'Task15i4', false, ['G1']],
      ]);
      assertProblem(await h.get('/questions/Q99'), 'QA_QUESTION_NOT_FOUND');
      assertProblem(await h.get('/questions/q1'), 'QA_QUESTION_NOT_FOUND');
    } finally { await h.close(); }
  });
});

describe('qa api: authorization', () => {
  test('no identity 401; developer and revoked member 403; store down 503; other tenant\'s admin sees its own', async () => {
    const h = await harness();
    try {
      assertProblem(await h.get('/questions', {}), 'QA_UNAUTHENTICATED');
      assertProblem(await h.get('/questions', DEVELOPER), 'QA_FORBIDDEN');
      assertProblem(await h.get(answer('Q3', 'kind=live'), DEVELOPER), 'QA_FORBIDDEN');
      assertProblem(await h.get('/questions', { tenant: A, sub: 'revoked-a' }), 'QA_FORBIDDEN');
      assertProblem(await h.get('/questions', { tenant: A, sub: 'flaky-a' }), 'QA_UNAVAILABLE');
      // An admin of B is not an admin of A.
      assertProblem(await h.get('/questions', { tenant: A, sub: 'admin-b' }), 'QA_FORBIDDEN');
    } finally { await h.close(); }
  });

  test('an auditor is refused live (D2) and allowed verifiable and signed', async () => {
    const h = await harness();
    try {
      assertProblem(await h.get(answer('Q3', `kind=live&repository_id=${REPO_A}`), AUDITOR), 'QA_KIND_NOT_ALLOWED');
      // Even on a live-only question, the role check applies (never a quiet fallback).
      assertProblem(await h.get(answer('Q10', 'kind=live'), AUDITOR), 'QA_KIND_NOT_ALLOWED');
      const v = await h.get(answer('Q3', `kind=verifiable&repository_id=${REPO_A}`), AUDITOR);
      assert.equal(v.status, 200);
      assert.equal(v.body.kind, 'verifiable');
      const s = await h.get(answer('Q3', `kind=signed&repository_id=${REPO_A}`), AUDITOR);
      assert.equal(s.status, 200);
      assert.equal(s.body.kind, 'signed');
      // The admin gets live.
      assert.equal((await h.get(answer('Q3', `kind=live&repository_id=${REPO_A}`), ADMIN)).status, 200);
    } finally { await h.close(); }
  });
});

describe('qa api: answers', () => {
  test('no answerer: 200, unavailable, answer_not_built plus the open gaps, required wording, valid', async () => {
    const h = await harness();
    try {
      const r = await h.get(answer('Q1', `kind=live&repository_id=${REPO_A}&from=2026-07-01T00:00:00Z&to=2026-09-30T23:59:59.999Z`));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const e = r.body as QaEnvelope;
      assert.equal(e.availability, 'unavailable');
      assert.deepEqual(e.reasons, [{ code: 'answer_not_built' }, { code: 'not_captured_yet', gap: 'G1' }]);
      assert.deepEqual(e.figures, []);
      assert.deepEqual(e.scope, { repository_id: REPO_A, from: '2026-07-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' });
      assert.equal(e.as_of, NOW.toISOString());
      assert.equal(checkEnvelope(e).ok, true);
      // Security answers carry monitor_only_observed; compare_previous answers carry previous.
      const s7 = (await h.get(answer('S7', 'kind=live'))).body as QaEnvelope;
      assert.ok(s7.wording.includes('monitor_only_observed'));
      assert.deepEqual(s7.previous, { from: '2026-08-16T09:29:59.999Z', to: '2026-09-15T09:29:59.999Z', figures: [] });
      assert.equal(checkEnvelope(s7).ok, true);
      // Phase 2.
      const q17 = (await h.get(answer('Q17', 'kind=live'))).body as QaEnvelope;
      assert.deepEqual(q17.reasons, [{ code: 'phase_2' }]);
      // Every question and kind gives a valid not-built envelope.
      for (const q of QA_QUESTIONS) {
        const scope = q.scopes.includes('tenant') ? '' : q.scopes.includes('repository') ? `&repository_id=${REPO_A}`
          : q.scopes.includes('pull_request') ? `&pull_request_id=${PR_A}` : `&repository_id=${REPO_A}&commit_sha=${SHA_A}`;
        for (const { kind } of q.kinds) {
          const res = await h.get(answer(q.id, `kind=${kind}${scope}`));
          assert.equal(res.status, 200, `${q.id}/${kind}`);
          assert.equal(checkEnvelope(res.body).ok, true, `${q.id}/${kind}`);
        }
      }
    } finally { await h.close(); }
  });

  test('a registered answerer\'s valid envelope is returned as is', async () => {
    const answerers = createAnswererRegistry();
    const seen: QaAnswerContext[] = [];
    answerers.register('Q3', 'live', async (ctx) => {
      seen.push(ctx);
      return {
        ...notBuiltLike(ctx), availability: 'recorded', reasons: [],
        figures: [{ key: 'merged_ai_share', availability: 'recorded', reasons: [], value: { type: 'ratio', numerator: 3, denominator: 4 },
          breakdown: [{ dimension: 'model', key: 'unknown', value: { type: 'count', count: 1 } }] }],
      };
    });
    const h = await harness({ answerers });
    try {
      const r = await h.get(answer('Q3', `kind=live&repository_id=${REPO_A}&breakdown=model`));
      assert.equal(r.status, 200);
      assert.equal(r.body.figures[0].value.numerator, 3);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].tenantId, A);
      assert.equal(seen[0].role, 'tenant_admin');
      assert.equal(seen[0].scopeLevel, 'repository');
      assert.equal(seen[0].breakdown, 'model');
    } finally { await h.close(); }
  });

  test('an invalid envelope never reaches the client: 503 QA_ANSWER_INVALID, logged with the path only', async () => {
    const answerers = createAnswererRegistry();
    // An unavailable figure written as 0: the classic dishonest answer.
    answerers.register('Q5', 'live', async (ctx) => ({
      ...notBuiltLike(ctx),
      figures: [{ key: 'reviewed', availability: 'unavailable', reasons: [{ code: 'not_captured_yet', gap: 'G3' }], value: { type: 'count', count: 0 } }],
    }));
    // Missing required wording.
    answerers.register('S12', 'live', async (ctx) => ({ ...notBuiltLike(ctx), wording: [] }));
    // Another scope than the one asked.
    answerers.register('Q9', 'live', async (ctx) => ({ ...notBuiltLike(ctx), scope: { ...ctx.scope, repository_id: REPO_B } }));
    answerers.register('Q13', 'live', async () => { throw new Error('secret detail SELECT * FROM x'); });
    const h = await harness({ answerers });
    try {
      for (const [id, params] of [['Q5', ''], ['S12', ''], ['Q9', `&repository_id=${REPO_A}`]]) {
        const r = await h.get(answer(id, `kind=live${params}`));
        assertProblem(r, 'QA_ANSWER_INVALID');
        assert.ok(!JSON.stringify(r.body).includes('count'), 'no envelope content leaks');
      }
      assert.equal(h.logs.length, 3);
      for (const line of h.logs) assert.match(line, /^qa-api QA_ANSWER_INVALID request_id=\S+ cause=/);
      const thrown = await h.get(answer('Q13', 'kind=live'));
      assertProblem(thrown, 'QA_UNAVAILABLE');
      assert.ok(!h.logs.some((l) => l.includes('secret') || l.includes('SELECT')), 'the cause text is never logged');
    } finally { await h.close(); }
  });

  test('registerAnswerer refuses an unknown question, a kind not offered, and a duplicate', () => {
    const answerers = createAnswererRegistry();
    const fn = async (ctx: QaAnswerContext) => notBuiltLike(ctx);
    assert.throws(() => answerers.register('Q99', 'live', fn), AnswererRegistrationError);
    assert.throws(() => answerers.register('Q7', 'live', fn), AnswererRegistrationError);
    answerers.register('Q3', 'live', fn);
    assert.throws(() => answerers.register('Q3', 'live', fn), AnswererRegistrationError);
  });
});

describe('qa api: parameters and scope', () => {
  test('each bad parameter is QA_SCOPE_INVALID; a kind not offered is QA_KIND_NOT_OFFERED', async () => {
    const h = await harness();
    try {
      assertProblem(await h.get(answer('Q7', 'kind=live')), 'QA_KIND_NOT_OFFERED');
      assertProblem(await h.get(answer('Q10', 'kind=signed')), 'QA_KIND_NOT_OFFERED');
      const invalid = [
        '', 'kind=', 'kind=LIVE', 'kind=live&kind=live',
        'kind=live&repository_id=not-a-uuid', `kind=live&repository_id=${REPO_A.toUpperCase()}`,
        'kind=live&from=2026-10-01', 'kind=live&from=yesterday',
        'kind=live&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        'kind=live&from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z',
        'kind=live&breakdown=developer', 'kind=live&breakdown=machine',
        'kind=live&contributor_id=x', 'kind=live&page=2',
        `kind=live&commit_sha=${SHA_A}`, `kind=live&repository_id=${REPO_A}&commit_sha=XYZ`,
      ];
      for (const params of invalid) assertProblem(await h.get(answer('Q3', params)), 'QA_SCOPE_INVALID');
      // A scope level the question does not accept (Q14 is per pull request; Q20 tenant only).
      assertProblem(await h.get(answer('Q14', 'kind=live')), 'QA_SCOPE_INVALID');
      assertProblem(await h.get(answer('Q20', `kind=live&repository_id=${REPO_A}`)), 'QA_SCOPE_INVALID');
      // Exactly 366 days is allowed; offsets are normalized to UTC.
      const ok = await h.get(answer('Q3', 'kind=live&from=2025-10-01T00:00:00Z&to=2026-10-02T00:00:00Z'));
      assert.equal(ok.status, 200);
      const off = await h.get(answer('Q3', `kind=live&from=${encodeURIComponent('2026-10-01T05:30:00+05:30')}&to=2026-10-02T00:00:00Z`));
      assert.equal(off.body.scope.from, '2026-10-01T00:00:00.000Z');
    } finally { await h.close(); }
  });

  test('another tenant\'s repository, a pull request elsewhere, an unseen commit: the same 404', async () => {
    const h = await harness();
    try {
      assertProblem(await h.get(answer('Q3', `kind=live&repository_id=${REPO_B}`)), 'QA_SCOPE_NOT_FOUND');
      assertProblem(await h.get(answer('Q3', 'kind=live&repository_id=00000000-0000-4000-8000-0000000000ff')), 'QA_SCOPE_NOT_FOUND');
      assertProblem(await h.get(answer('Q9', `kind=live&repository_id=${REPO_A2}&pull_request_id=${PR_A}`)), 'QA_SCOPE_NOT_FOUND');
      assertProblem(await h.get(answer('Q9', `kind=live&pull_request_id=${PR_A}`, ), { tenant: B, sub: 'admin-b' }), 'QA_SCOPE_NOT_FOUND');
      assertProblem(await h.get(answer('Q8', `kind=verifiable&repository_id=${REPO_A}&commit_sha=${'b'.repeat(40)}`)), 'QA_SCOPE_NOT_FOUND');
      assert.equal((await h.get(answer('Q8', `kind=verifiable&repository_id=${REPO_A}&commit_sha=${SHA_A}`))).status, 200);
      assert.equal((await h.get(answer('Q9', `kind=live&repository_id=${REPO_A}&pull_request_id=${PR_A}`))).status, 200);
      h.scopes.fail = true;
      assertProblem(await h.get(answer('Q3', `kind=live&repository_id=${REPO_A}`)), 'QA_UNAVAILABLE');
    } finally { await h.close(); }
  });

  test('drill-down: parameters checked, built questions page, others keep 501', async () => {
    const contextLoader = async (): Promise<QaContext> => ({
      repositories: [{ id: REPO_A, name: 'repo-a' }],
      pullRequests: [],
      contributors: [],
      sessions: [],
      sessionRepositories: [],
      usage: [],
      commits: [],
      files: [],
      commitSessions: [],
      pullRequestCommits: [],
      generationObservations: [],
      lifecycleEvents: [],
      memberships: [],
      commitLineage: [],
      mergeLineage: [],
      deployments: [],
      commitModelAttributions: [],
      modelLifecycleEvents: [],
      corrections: new Map(),
    }) as unknown as QaContext;
    const h = await harness({ contextLoader });
    try {
      const page = await h.get('/questions/Q3/drilldown?kind=live&limit=20');
      assert.equal(page.status, 200);
      assert.deepEqual(Object.keys(page.body).sort(), ['items', 'next_cursor']);
      assertProblem(await h.get('/questions/Q3/drilldown?kind=live&limit=0'), 'QA_SCOPE_INVALID');
      assertProblem(await h.get('/questions/Q3/drilldown?kind=live&limit=101'), 'QA_SCOPE_INVALID');
      assertProblem(await h.get('/questions/Q3/drilldown?kind=live&cursor=a%2Fb'), 'QA_SCOPE_INVALID');
      assertProblem(await h.get('/questions/Q3/drilldown?kind=live', AUDITOR), 'QA_KIND_NOT_ALLOWED');
      assertProblem(await h.get('/questions/Q99/drilldown?kind=live'), 'QA_QUESTION_NOT_FOUND');
      // A question Task19b does not build keeps answering 501.
      assertProblem(await h.get('/questions/Q5/drilldown?kind=live'), 'QA_DRILLDOWN_NOT_BUILT');
    } finally { await h.close(); }
  });
});

/** A minimal valid envelope for the context (as the service's not-built answer). */
function notBuiltLike(ctx: QaAnswerContext): QaEnvelope {
  const question = QA_QUESTIONS.find((q) => q.id === ctx.questionId)!;
  return {
    question_id: ctx.questionId, registry_version: QA_REGISTRY_VERSION, kind: ctx.kind, as_of: ctx.now,
    scope: ctx.scope, availability: 'unavailable', reasons: [{ code: 'answer_not_built' }], figures: [],
    wording: [...question.wording], drilldown: [],
  };
}
