/**
 * IT-T19a-01: the Q&A API against real PostgreSQL, through the real JWT and tenant
 * middleware (a local JWKS stands in for Supabase), the real requireAdminAction('qa.read')
 * guard and the real createApp() mount.
 *
 *   scripts/it-db.sh npm run verify:task19a-qa-live -w apps/api
 *
 * (a) An admin of Company A gets the Q3 live envelope (answer_not_built), valid
 *     against docs/contracts/qa/answer-v1.schema.json.
 * (b) An auditor gets 403 QA_KIND_NOT_ALLOWED for live, and 200 for verifiable.
 * (c) A developer (a valid user of the tenant, no admin membership) gets 403 QA_FORBIDDEN.
 * (d) Company A asking with Company B's repository id gets 404 QA_SCOPE_NOT_FOUND.
 * (e) The X-Request-ID is echoed, and every response is no-store.
 *
 * As IT-T16c-01 (features/audit/task16c-audit-api-live-verify.ts). Throwaway database
 * only (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh). Prints safe summary lines only.
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
  if (!condition) throw new Error(`IT-T19a-01 failed: ${message}`);
}

interface Tenant { label: string; tenantId: string; domain: string; repositoryId: string }

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t19a-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  const repositoryId = randomUUID();
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url) values ($1, $2, 'github', $3, $4, $5)`,
    [repositoryId, tenantId, `${slug}-repo`, `repo-${label}`, `https://github.com/example/${slug}`]);
  return { label, tenantId, domain, repositoryId };
}

async function grant(t: Tenant, subject: string, role: 'tenant_admin' | 'tenant_auditor'): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, 'active', 'it-t19a', null)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t19a';
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
const token = (t: Tenant, subject: string) =>
  jwt.sign({ sub: subject, email: `${subject}@${t.domain}` }, JWT_KEY.privateKey, { algorithm: 'RS256', keyid: KID, expiresIn: 600 });

interface Res { status: number; headers: Headers; body: any }
async function get(base: string, path: string, bearer: string, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${bearer}`, ...headers } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  check(res.headers.get('cache-control') === 'no-store', `GET ${path}: no-store (${res.status})`);
  return { status: res.status, headers: res.headers, body };
}

const isProblem = (r: Res, status: number, code: string) =>
  r.status === status && r.headers.get('content-type')?.startsWith('application/problem+json') && r.body?.code === code;

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
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/contracts/qa/answer-v1.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false }).compile(schema);

    // (a) admin, Q3 live, answer_not_built, valid against the schema.
    const q3 = await get(app.base, `/api/qa/questions/Q3/answer?kind=live&repository_id=${a.repositoryId}`, token(a, 'admin-a'));
    check(q3.status === 200, `(a) admin Q3 live: 200 (got ${q3.status})`);
    check(validate(q3.body) as boolean, '(a) the envelope is valid against answer-v1.schema.json');
    check(q3.body.availability === 'unavailable' && q3.body.reasons?.[0]?.code === 'answer_not_built', '(a) answer_not_built');
    check(q3.body.scope?.repository_id === a.repositoryId, '(a) the scope is the request\'s');
    console.log('IT-T19a-01a ok: admin gets the Q3 live envelope (answer_not_built), schema-valid');

    // (b) auditor: live refused, verifiable allowed.
    const auditor = token(a, 'auditor-a');
    const live = await get(app.base, `/api/qa/questions/Q3/answer?kind=live&repository_id=${a.repositoryId}`, auditor);
    check(isProblem(live, 403, 'QA_KIND_NOT_ALLOWED'), `(b) auditor live: 403 QA_KIND_NOT_ALLOWED (got ${live.status} ${live.body?.code})`);
    const verifiable = await get(app.base, `/api/qa/questions/Q3/answer?kind=verifiable&repository_id=${a.repositoryId}`, auditor);
    check(verifiable.status === 200 && (validate(verifiable.body) as boolean), `(b) auditor verifiable: 200, valid (got ${verifiable.status})`);
    console.log('IT-T19a-01b ok: auditor refused live (403 QA_KIND_NOT_ALLOWED), allowed verifiable (200)');

    // (c) developer: a valid tenant user without an admin membership.
    const developer = await get(app.base, '/api/qa/questions', token(a, 'developer-a'));
    check(isProblem(developer, 403, 'QA_FORBIDDEN'), `(c) developer: 403 QA_FORBIDDEN (got ${developer.status} ${developer.body?.code})`);
    console.log('IT-T19a-01c ok: developer gets 403 QA_FORBIDDEN');

    // (d) Company A with Company B's repository id: the same 404 as an unknown id.
    const cross = await get(app.base, `/api/qa/questions/Q3/answer?kind=live&repository_id=${b.repositoryId}`, token(a, 'admin-a'));
    check(isProblem(cross, 404, 'QA_SCOPE_NOT_FOUND'), `(d) cross-tenant repository: 404 QA_SCOPE_NOT_FOUND (got ${cross.status} ${cross.body?.code})`);
    const unknown = await get(app.base, `/api/qa/questions/Q3/answer?kind=live&repository_id=${randomUUID()}`, token(a, 'admin-a'));
    check(isProblem(unknown, 404, 'QA_SCOPE_NOT_FOUND'), '(d) unknown repository: the same 404');
    const own = await get(app.base, `/api/qa/questions/Q3/answer?kind=live&repository_id=${b.repositoryId}`, token(b, 'admin-b'));
    check(own.status === 200, '(d) Company B reads its own repository');
    console.log('IT-T19a-01d ok: Company B\'s repository id is 404 QA_SCOPE_NOT_FOUND for Company A');

    // (e) request id echoed, on success and on a problem.
    const echoed = await get(app.base, '/api/qa/questions', token(a, 'admin-a'), { 'X-Request-ID': 'it-t19a-req-1' });
    check(echoed.status === 200 && echoed.headers.get('x-request-id') === 'it-t19a-req-1', '(e) X-Request-ID echoed on 200');
    const echoedProblem = await get(app.base, '/api/qa/questions/Q99', token(a, 'admin-a'), { 'X-Request-ID': 'it-t19a-req-2' });
    check(isProblem(echoedProblem, 404, 'QA_QUESTION_NOT_FOUND') && echoedProblem.body.request_id === 'it-t19a-req-2'
      && echoedProblem.headers.get('x-request-id') === 'it-t19a-req-2', '(e) X-Request-ID echoed on a problem');
    console.log('IT-T19a-01e ok: X-Request-ID echoed; every response no-store');
    console.log('IT-T19a-01 passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T19a-01 failed');
  process.exitCode = 1;
});
