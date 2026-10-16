/**
 * IT-T19b-01: Task19b's ten live code answers against real PostgreSQL, through
 * the real JWT and tenant middleware (a local JWKS stands in for Supabase),
 * the real requireAdminAction('qa.read') guard and the real createApp() mount.
 *
 *   scripts/it-db.sh npm run verify:task19b-qa-live -w apps/api
 *
 * Seed (Company A): one repository with three retained commits (one without a
 * Git AI note), lifecycle evidence for merged/production/proxy/rework/generation,
 * two models, one merged PR with two commits, one production deployment, two
 * sessions with usage; plus one repository with one commit for Company B. Then:
 * - (a) Q3, Q9, Q13 and Q19 as Company A admin are 200, schema-valid, and
 *   their figure values equal the seeded constants below;
 * - (b) Q13 commits_without_git_ai_note = 1;
 * - (c) Q20 has previous with the same figure keys;
 * - (d) the drill-down pages tenant to repository to PR to commit;
 * - (e) Company A sees none of Company B's repositories in any answer or drill-down;
 * - (f) an auditor asking for kind=live gets 403.
 *
 * As IT-T19a-01 (task19a-qa-live-verify.ts). Throwaway database only
 * (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh). Safe summary lines only.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import type express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../../core/db';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T19b-01 failed: ${message}`);
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

interface Seed {
  tenantId: string;
  domain: string;
  repositoryId: string;
  commitIds: string[];
  pullRequestId: string | null;
}

async function seedTenant(label: string): Promise<Seed> {
  const tenantId = randomUUID();
  const slug = `it-t19b-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  const repositoryId = randomUUID();
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url) values ($1, $2, 'github', $3, $4, $5)`,
    [repositoryId, tenantId, `${slug}-repo`, `repo-${label}`, `https://github.com/example/${slug}`]);
  return { tenantId, domain, repositoryId, commitIds: [], pullRequestId: null };
}

async function grant(t: Seed, subject: string, role: 'tenant_admin' | 'tenant_auditor'): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, 'active', 'it-t19b', null)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

async function seedCompanyA(t: Seed): Promise<void> {
  const sha = (c: string) => c.repeat(40);
  const commits = [
    { sha: sha('a'), ai: 100, human: 50, unknown: 0, note: 'git-ai: session s-1', at: daysAgo(10) },
    { sha: sha('b'), ai: 200, human: 100, unknown: 5, note: null, at: daysAgo(9) },
    { sha: sha('c'), ai: 50, human: 150, unknown: 0, note: 'git-ai: session s-2', at: daysAgo(8) },
  ];
  for (const c of commits) {
    const id = randomUUID();
    t.commitIds.push(id);
    await pool.query(
      `insert into scm_commits (id, tenant_id, repository_id, sha, subject, reachability, committed_at,
        observed_ai_lines, observed_human_lines, observed_unknown_lines, authorship_note)
       values ($1, $2, $3, $4, $5, 'reachable', $6, $7, $8, $9, $10)`,
      [id, t.tenantId, t.repositoryId, c.sha, `commit ${c.sha.slice(0, 6)}`, c.at, c.ai, c.human, c.unknown, c.note]);
  }
  const [c1, c2, c3] = t.commitIds;
  const occurred = daysAgo(7);
  const event = (stage: string, lineCount: number, commitId: string | null, ref: string, actor: string | null = null) =>
    pool.query(
      `insert into ai_code_lifecycle_events (id, tenant_id, repository_id, commit_id, stage, line_count,
        actor_kind, evidence_type, evidence_ref, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, 't19b-it', $8, $9)`,
      [randomUUID(), t.tenantId, t.repositoryId, commitId, stage, lineCount, actor, ref, occurred]);
  await event('committed', 100, c1, 't19b-committed-c1');
  await event('committed', 200, c2, 't19b-committed-c2');
  await event('committed', 50, c3, 't19b-committed-c3');
  await event('generated', 100, c1, 't19b-generated-c1');
  await event('generated', 200, c2, 't19b-generated-c2');
  await event('generated', 50, c3, 't19b-generated-c3');
  await event('merged', 300, null, 't19b-merged-1');
  await event('production', 250, null, 't19b-production-1');
  await event('merged_proxy', 60, null, 't19b-proxy-1');
  await event('reworked', 40, c1, 't19b-rework-ai', 'ai');
  await event('reworked', 10, c2, 't19b-rework-human', 'human');
  // Generation observations ride on minimal metric-event scaffolding.
  await pool.query(
    `insert into telemetry_ingest_batches (id, tenant_id, api_version, event_count, payload_hash, payload)
     values ($1, $2, 1, 2, $3, '{}')`,
    [randomUUID(), t.tenantId, `t19b-${t.tenantId}`]);
  const observation = async (lines: number, ref: string) => {
    const eventId = randomUUID();
    const batch = await pool.query(`select id from telemetry_ingest_batches where tenant_id = $1 limit 1`, [t.tenantId]);
    await pool.query(
      `insert into telemetry_metric_events (id, tenant_id, batch_id, event_index, event_fingerprint, event_kind, event_timestamp, raw_event)
       values ($1, $2, $3, 0, $4, 1, $5, '{}')`,
      [eventId, t.tenantId, batch.rows[0].id, ref, occurred]);
    await pool.query(
      `insert into ai_generation_observations (id, tenant_id, repository_id, source_event_id, generated_lines, generated_at, evidence_source)
       values ($1, $2, $3, $4, $5, $6, 't19b-it')`,
      [randomUUID(), t.tenantId, t.repositoryId, eventId, lines, occurred]);
  };
  await observation(400, 't19b-obs-1');
  await observation(100, 't19b-obs-2');
  const modelEvent = (key: string, tool: string, stage: string, lineCount: number, commitId: string | null, ref: string) =>
    pool.query(
      `insert into ai_model_lifecycle_events (id, tenant_id, repository_id, commit_id, tool, model, model_key,
        stage, line_count, evidence_type, evidence_ref, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 't19b-it', $10, $11)`,
      [randomUUID(), t.tenantId, t.repositoryId, commitId, tool, key, key, stage, lineCount, ref, occurred]);
  await modelEvent('model-a', 'tool-a', 'committed', 100, c1, 't19b-m-a-committed');
  await modelEvent('model-a', 'tool-a', 'generated', 100, c1, 't19b-m-a-generated');
  await modelEvent('model-a', 'tool-a', 'merged', 300, null, 't19b-m-a-merged');
  await modelEvent('model-a', 'tool-a', 'production', 250, null, 't19b-m-a-production');
  await modelEvent('model-b', 'tool-b', 'committed', 200, c2, 't19b-m-b-committed');
  await modelEvent('model-b', 'tool-b', 'generated', 200, c2, 't19b-m-b-generated');
  await modelEvent('model-b', 'tool-b', 'production', 100, null, 't19b-m-b-production');
  const attribution = (commitId: string, key: string, tool: string, lines: number, ref: string) =>
    pool.query(
      `insert into ai_commit_model_attributions (id, tenant_id, commit_id, tool, model, model_key,
        observed_ai_lines, evidence_type, evidence_ref)
       values ($1, $2, $3, $4, $5, $6, $7, 't19b-it', $8)`,
      [randomUUID(), t.tenantId, commitId, tool, key, key, lines, ref]);
  await attribution(c1, 'model-a', 'tool-a', 100, 't19b-attr-c1');
  await attribution(c2, 'model-b', 'tool-b', 200, 't19b-attr-c2');
  await attribution(c3, 'model-a', 'tool-a', 50, 't19b-attr-c3');
  // One merged PR with two commits, one production deployment, two sessions with usage.
  const prId = randomUUID();
  t.pullRequestId = prId;
  await pool.query(
    `insert into scm_pull_requests (id, tenant_id, repository_id, external_id, title, state, number, merge_commit_sha, merged_at)
     values ($1, $2, $3, 'pr-7', 'Add feature', 'merged', 7, $4, $5)`,
    [prId, t.tenantId, t.repositoryId, sha('a'), daysAgo(6)]);
  for (const commitId of [c1, c2]) {
    await pool.query(
      `insert into scm_pull_request_commits (id, tenant_id, pull_request_id, commit_id, match_method, confidence)
       values ($1, $2, $3, $4, 'sha', 100)`,
      [randomUUID(), t.tenantId, prId, commitId]);
  }
  await pool.query(
    `insert into scm_deployments (id, tenant_id, repository_id, provider, external_id, environment, sha, status, production, deployed_at)
     values ($1, $2, $3, 'github', 'deploy-1', 'production', $4, 'success', true, $5)`,
    [randomUUID(), t.tenantId, t.repositoryId, sha('a'), daysAgo(5)]);
  const sessions = [
    { tool: 'opencode', ext: 's-1' },
    { tool: 'claude', ext: 's-2' },
  ];
  const sessionIds: string[] = [];
  for (const s of sessions) {
    const id = randomUUID();
    sessionIds.push(id);
    await pool.query(
      `insert into ai_sessions (id, tenant_id, external_session_id, tool) values ($1, $2, $3, $4)`,
      [id, t.tenantId, s.ext, s.tool]);
  }
  const link = (commitId: string, sessionId: string) =>
    pool.query(
      `insert into ai_commit_sessions (id, tenant_id, commit_id, session_id) values ($1, $2, $3, $4)`,
      [randomUUID(), t.tenantId, commitId, sessionId]);
  await link(c1, sessionIds[0]);
  await link(c2, sessionIds[1]);
  const usage = (
    sessionId: string, model: string, tokens: number[], cost: string, key: string,
  ) => pool.query(
    `insert into ai_session_usage (id, tenant_id, session_id, model, input_tokens, output_tokens,
      reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_amount, cost_unit,
      availability, evidence_source, evidence_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USD', 'recorded', 't19b-it', $11)`,
    [randomUUID(), t.tenantId, sessionId, model, ...tokens, cost, key]);
  await usage(sessionIds[0], 'model-a', [1000, 500, 100, 200, 50], '2.500000', 't19b-use-1');
  await usage(sessionIds[1], 'model-b', [2000, 800, 200, 0, 0], '1.250000', 't19b-use-2');
}

async function seedCompanyB(t: Seed): Promise<void> {
  const id = randomUUID();
  await pool.query(
    `insert into scm_commits (id, tenant_id, repository_id, sha, subject, reachability, committed_at,
      observed_ai_lines, observed_human_lines, observed_unknown_lines, authorship_note)
     values ($1, $2, $3, $4, 'b commit', 'reachable', $5, 10, 90, 0, 'note')`,
    [id, t.tenantId, t.repositoryId, 'e'.repeat(40), daysAgo(4)]);
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t19b';
async function startJwks(): Promise<Server> {
  const jwk = { ...JWT_KEY.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return server;
}
const token = (t: Seed, subject: string) =>
  jwt.sign({ sub: subject, email: `${subject}@${t.domain}` }, JWT_KEY.privateKey, { algorithm: 'RS256', keyid: KID, expiresIn: 600 });

interface Res { status: number; headers: Headers; body: any }
async function get(base: string, path: string, bearer: string): Promise<Res> {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  check(res.headers.get('cache-control') === 'no-store', `GET ${path}: no-store (${res.status})`);
  return { status: res.status, headers: res.headers, body };
}

const isProblem = (r: Res, status: number, code: string) =>
  r.status === status && r.headers.get('content-type')?.startsWith('application/problem+json') && r.body?.code === code;

function fig(body: any, key: string): any {
  const figure = body?.figures?.find((f: any) => f?.key === key);
  check(figure, `figure ${key} is present`);
  return figure;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    // The JWT middleware reads SUPABASE_URL when it is first imported.
    const { createApp } = await import('../../app');
    const app = await listen(createApp());
    servers.push(app.server);

    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await grant(a, 'admin-a', 'tenant_admin');
    await grant(a, 'auditor-a', 'tenant_auditor');
    await grant(b, 'admin-b', 'tenant_admin');
    await seedCompanyA(a);
    await seedCompanyB(b);
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/contracts/qa/answer-v1.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false }).compile(schema);

    const from = daysAgo(30).toISOString();
    const to = new Date().toISOString();
    const period = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const admin = token(a, 'admin-a');
    const answer = (id: string, params: string) => `/api/qa/questions/${id}/answer?${params}`;
    const valid = (r: Res, what: string) => {
      check(r.status === 200, `${what}: 200 (got ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)})`);
      check(validate(r.body) as boolean, `${what}: schema-valid`);
    };

    // (a) Q3, Q9, Q13 and Q19 equal the seeded constants.
    const q3 = await get(app.base, answer('Q3', `kind=live&repository_id=${a.repositoryId}&${period}`), admin);
    valid(q3, '(a) Q3');
    check(fig(q3.body, 'merged_ai_lines')?.value?.count === 300, '(a) Q3 merged_ai_lines = 300');
    check(JSON.stringify(fig(q3.body, 'ai_share_of_retained_lines')?.value) === JSON.stringify({ type: 'ratio', numerator: 350, denominator: 650 }),
      '(a) Q3 share = 350/650');
    const q9 = await get(app.base, answer('Q9', `kind=live&repository_id=${a.repositoryId}&${period}`), admin);
    valid(q9, '(a) Q9');
    check(fig(q9.body, 'production_ai_lines')?.value?.count === 250, '(a) Q9 production = 250');
    check(fig(q9.body, 'merged_not_deployed_proxy_lines')?.value?.count === 60, '(a) Q9 proxy = 60');
    check(fig(q9.body, 'production_deployments')?.value?.count === 1, '(a) Q9 deployments = 1');
    const q13 = await get(app.base, answer('Q13', `kind=live&repository_id=${a.repositoryId}&${period}`), admin);
    valid(q13, '(a) Q13');
    check(fig(q13.body, 'commits')?.value?.count === 3, '(a) Q13 commits = 3');
    check(fig(q13.body, 'unknown_lines')?.value?.count === 5, '(a) Q13 unknown = 5');
    const q19 = await get(app.base, answer('Q19', `kind=live&repository_id=${a.repositoryId}&${period}`), admin);
    valid(q19, '(a) Q19');
    check(fig(q19.body, 'generated_lines')?.value?.count === 500, '(a) Q19 generated = 500');
    check(fig(q19.body, 'committed_ai_lines')?.value?.count === 350, '(a) Q19 committed = 350');
    check(JSON.stringify(fig(q19.body, 'acceptance')?.value) === JSON.stringify({ type: 'ratio', numerator: 350, denominator: 500 }),
      '(a) Q19 acceptance = 350/500');
    console.log('IT-T19b-01a ok: Q3, Q9, Q13 and Q19 equal the seeded constants');

    // (b) One commit has no Git AI note.
    check(fig(q13.body, 'commits_without_git_ai_note')?.value?.count === 1, '(b) Q13 without note = 1');
    console.log('IT-T19b-01b ok: Q13 commits_without_git_ai_note = 1');

    // (c) Q20 carries previous with the same keys.
    const q20 = await get(app.base, answer('Q20', `kind=live&${period}`), admin);
    valid(q20, '(c) Q20');
    check(fig(q20.body, 'ai_committed_lines')?.value?.count === 350, '(c) Q20 committed = 350');
    check(Array.isArray(q20.body?.previous?.figures), '(c) Q20 previous is present');
    check(JSON.stringify(q20.body.previous.figures.map((f: any) => f.key)) === JSON.stringify(q20.body.figures.map((f: any) => f.key)),
      '(c) Q20 previous has the same keys');
    console.log('IT-T19b-01c ok: Q20 has previous with the same keys');

    // (d) Drill-down from tenant to repository to PR to commit.
    const drill = (params: string) => `/api/qa/questions/Q3/drilldown?${params}`;
    const tenant = await get(app.base, drill(`kind=live&${period}`), admin);
    check(tenant.status === 200, `(d) tenant drill-down: 200 (got ${tenant.status})`);
    check(tenant.body?.items?.some((i: any) => i.id === a.repositoryId), '(d) tenant lists Company A repository');
    const prs = await get(app.base, `/api/qa/questions/Q9/drilldown?kind=live&repository_id=${a.repositoryId}&${period}`, admin);
    check(prs.status === 200 && prs.body?.items?.some((i: any) => i.id === a.pullRequestId), '(d) repository lists the PR');
    const first = await get(
      app.base, `/api/qa/questions/Q14/drilldown?kind=live&pull_request_id=${a.pullRequestId}&${period}&limit=1`, admin);
    check(first.status === 200 && first.body?.items?.length === 1 && typeof first.body?.next_cursor === 'string',
      '(d) PR commits page with a cursor');
    const second = await get(
      app.base,
      `/api/qa/questions/Q14/drilldown?kind=live&pull_request_id=${a.pullRequestId}&${period}&limit=1&cursor=${first.body.next_cursor}`,
      admin);
    check(second.status === 200 && second.body?.items?.length === 1 && second.body?.next_cursor === null
      && second.body.items[0].id !== first.body.items[0].id, '(d) the cursor walks to the second commit');
    console.log('IT-T19b-01d ok: drill-down pages tenant to repository to PR to commit');

    // (e) Company A sees none of Company B's repositories.
    for (const r of [q3, q9, q13, q19, q20]) {
      check(!JSON.stringify(r.body).includes(b.repositoryId), '(e) no answer names Company B repository');
    }
    check(!JSON.stringify(tenant.body).includes(b.repositoryId), '(e) no drill-down names Company B repository');
    console.log('IT-T19b-01e ok: Company A sees none of Company B');

    // (f) An auditor asking for kind=live gets 403.
    const auditor = await get(app.base, answer('Q3', `kind=live&repository_id=${a.repositoryId}&${period}`), token(a, 'auditor-a'));
    check(isProblem(auditor, 403, 'QA_KIND_NOT_ALLOWED'), `(f) auditor live: 403 QA_KIND_NOT_ALLOWED (got ${auditor.status})`);
    console.log('IT-T19b-01f ok: auditor refused live (403 QA_KIND_NOT_ALLOWED)');
    console.log('IT-T19b-01 passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T19b-01 failed');
  process.exitCode = 1;
});
