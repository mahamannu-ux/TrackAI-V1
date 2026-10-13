/**
 * IT-T15i-01…03: the Attesta evidence API against real PostgreSQL, through the real
 * JWT and tenant middleware (a local JWKS stands in for Supabase), the real
 * requireAdminAction, the real builder and the real anchoring worker (dev signers, the
 * in-process Rekor and TSA fakes), with anchoring configured through the environment
 * exactly as production reads it (anchor-env.ts).
 *
 *   scripts/it-db.sh npm run verify:task15i-evidence-api-live -w apps/api
 *
 * 01 list, detail, subject chain and verify return what the tables hold; anchor_status
 *    moves pending → anchored, and a record left unanchored reads missing once the
 *    clock passes the window; verify is report version 2 with SIGNATURES_NOT_CHECKED,
 *    anchors checked; the createApp() mount answers.
 * 02 Company A/B: B's tokens see none of A's statements, digests, subjects or verify
 *    ranges (404 or empty, never a 403 that leaks existence).
 * 03 the auditor reads everything; a revoked membership and a non-member get 403
 *    problems; verify writes one audit row carrying the request ID; reads write none.
 * Prints only safe summary lines (counts and codes).
 */
import { createPublicKey, generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, pool } from '../../core/db';
import { recordDeployment, recordMergeLineage, recordPullRequestSnapshot } from '../scm/lifecycle-service';
import { upsertPullRequestObservation } from '../scm/scm.routes';
import type { GitHubCommit } from '../scm/github-app';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { anchorFromEnv } from './anchor-env';
import { runAnchorPass } from './anchor-worker';
import { createAttestaRouter } from './attesta.routes';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver } from './signer-resolver';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import type { ChainReport } from './verify-chain';
import { runBuilderPass, type BuilderPassOptions } from './worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15i failed: ${message}`);
}

const HOUR = 3_600_000;
const RESOLVER = devSignerResolver({ sharedKeyPem: generateDevCredential('dev:it', 'it').privateKeyPem });
const OPTIONS: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef' };
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Task2's own writers (as in t15h-builder-live-verify.ts): a commit, a merged PR, a deployment

interface Tenant {
  label: string; tenantId: string; domain: string; repoUrl: string; repositoryId: string; repositoryExternalId: string;
  commitSha: string; mergeSha: string;
}

function note(label: string): string {
  return [`src/${label}/alpha.ts`, '  s_it::t_1 1-6', '  h_dev 7-8', '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${label}`, model: 'model-x' } } } })].join('\n');
}

function commitEvent(t: Tenant, commitSha: string): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 8, '3': ['opencode:model-x'], '5': [6], '11': 'IT synthetic commit', '13': note(t.label), '15': now - 60, '16': now - 30 },
    a: { '1': t.repoUrl, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${t.label}` },
  };
}

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15i-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  return { label, tenantId, domain, repoUrl: `https://github.com/${slug}/service`, repositoryId: '', repositoryExternalId: '', commitSha: sha(), mergeSha: sha() };
}

async function ingestCommit(t: Tenant, commitSha: string): Promise<void> {
  const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, commitSha)] });
  check(errors.length === 0, `${t.label}: commit ingestion failed`);
  if (!t.repositoryId) {
    const r = await pool.query(`select id::text as id, external_id from scm_repositories where tenant_id = $1`, [t.tenantId]);
    t.repositoryId = r.rows[0].id;
    t.repositoryExternalId = r.rows[0].external_id;
  }
}

function githubCommit(label: string, commitSha: string, parents: string[]): GitHubCommit {
  return {
    sha: commitSha,
    commit: { message: 'IT synthetic', author: { name: `IT Dev ${label}`, email: `it-dev-${label}@example.invalid`, date: new Date().toISOString() }, committer: { date: new Date().toISOString() } },
    parents: parents.map((p) => ({ sha: p })),
  };
}

async function insertDelivery(t: Tenant, deliveryId: string, eventType: string, rawEvent: Record<string, unknown>) {
  await pool.query(
    `insert into provider_event_deliveries (tenant_id, repository_id, provider, delivery_id, event_type, event_fingerprint, raw_event)
     values ($1, $2, 'github', $3, $4, $5, $6::jsonb)`,
    [t.tenantId, t.repositoryId, deliveryId, eventType, sha256Hex(deliveryId), JSON.stringify(rawEvent)]);
}

async function observeAll(t: Tenant): Promise<void> {
  await ingestCommit(t, t.commitSha);
  const deliveryId = randomUUID();
  const externalId = String(100_000 + Math.floor(Math.random() * 1e9));
  const mergedAt = new Date().toISOString();
  await insertDelivery(t, deliveryId, 'pr_closed', {
    action: 'closed', repository: { id: t.repositoryExternalId }, pull_request: { id: externalId, merged_at: mergedAt, merge_commit_sha: t.mergeSha },
  });
  const pullRequestId = await db.transaction((tx) => upsertPullRequestObservation(tx, {
    eventType: 'pr_closed', tenantId: t.tenantId, repositoryId: t.repositoryId, provider: 'github', providerDeliveryId: deliveryId,
    pullRequest: {
      externalId, number: 7, title: 'IT synthetic PR', state: 'merged', authorEmail: null, authorProviderId: '4242',
      authorLogin: 'it-dev', headRef: 'feature', baseRef: 'main', headSha: t.commitSha, mergedAt, mergeCommitSha: t.mergeSha,
    },
  }));
  await recordPullRequestSnapshot({ tenantId: t.tenantId, repositoryId: t.repositoryId, pullRequestId, headSha: t.commitSha, commits: [githubCommit(t.label, t.commitSha, [sha()])] });
  await recordMergeLineage({ tenantId: t.tenantId, repositoryId: t.repositoryId, pullRequestId, resultSha: t.mergeSha, resultCommit: githubCommit(t.label, t.mergeSha, [sha()]), mergedAt: new Date(mergedAt) });
  await pool.query(`update attesta_subjects set not_before = now() where tenant_id = $1 and kind = 'pr_merged'`, [t.tenantId]);
  const deployDelivery = randomUUID();
  const deploymentExternalId = String(200_000 + Math.floor(Math.random() * 1e9));
  await insertDelivery(t, deployDelivery, 'deployment_status', {
    repository: { id: t.repositoryExternalId }, deployment: { id: deploymentExternalId, sha: t.mergeSha }, deployment_status: { state: 'success' },
  });
  await recordDeployment({
    tenantId: t.tenantId, repositoryId: t.repositoryId, provider: 'github', providerDeliveryId: deployDelivery,
    externalId: deploymentExternalId, environment: 'production', ref: 'main', sha: t.mergeSha, status: 'success', production: true, deployedAt: new Date(),
  });
}

async function build(): Promise<void> {
  const pass = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(pass.failed === 0 && pass.retried === 0, `builder pass: ${JSON.stringify(pass.codes)}`);
}

async function grant(t: Tenant, subject: string, role: 'tenant_admin' | 'tenant_auditor', revoked = false): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, $5, 'it-t15i', $6)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role, revoked ? 'revoked' : 'active', revoked ? new Date() : null]);
}

// ---------------------------------------------------------------------------
// A local JWKS (Supabase's /auth/v1/.well-known/jwks.json) and RS256 tokens

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t15i';

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

// ---------------------------------------------------------------------------
// The anchoring environment, written as production reads it

async function anchoringEnv(dir: string) {
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000);
  const tsa = await FakeTsa.create();
  const cred = generateDevCredential('dev:it-anchor', ATTESTA_PLATFORM_TENANT_ID);
  const file = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body, { mode: 0o600 }); return p; };
  Object.assign(process.env, {
    ATTESTA_ANCHOR_CREDENTIAL_ID: cred.credentialId,
    ATTESTA_DEV_ANCHOR_KEY_FILE: file('anchor.pem', cred.privateKeyPem),
    ATTESTA_REKOR_URL: 'http://rekor.test',
    ATTESTA_REKOR_LOG_KEY_FILE: file('rekor.pem', createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString()),
    ATTESTA_TSA_URL: TSA_URL,
    ATTESTA_TSA_ANCHORS_FILE: file('tsa.pem', tsa.anchorsPem),
  });
  const env = await anchorFromEnv(process.env, { rekorFetch: rekor.fetch, tsaFetch: tsa.fetch });
  return {
    pass: async (tenantId: string) => {
      const r = await runAnchorPass(db, { anchor: env.anchor, now: () => new Date() }, { tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
      check(r.tenantErrors === 0, 'anchoring pass');
      return r;
    },
  };
}

// ---------------------------------------------------------------------------

interface Api {
  get(path: string, bearer?: string, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any; text: string }>;
}

function client(base: string): Api {
  return {
    async get(path, bearer, headers = {}) {
      const res = await fetch(base + path, { headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers } });
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      // Without a token the shared JWT middleware answers before the Attesta router (its 401 is not ours).
      check(!bearer || res.headers.get('cache-control') === 'no-store', `${path}: no-store (status ${res.status})`);
      return { status: res.status, headers: res.headers, body, text };
    },
  };
}

async function listAll(api: Api, bearer: string, query = ''): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const r = await api.get(`/api/attesta/statements?limit=1${query}${cursor ? `&cursor=${cursor}` : ''}`, bearer);
    check(r.status === 200, `list page: ${r.status}`);
    out.push(...r.body.statements);
    cursor = r.body.next_cursor;
  } while (cursor);
  return out;
}

async function tableRecords(tenantId: string) {
  return (await pool.query(
    `select r.seq::int as seq, r.statement_digest, r.prev_hash, r.record_hash, r.canonical_record, r.statement_canonical,
            r.statement_kind, r.subject_sha, r.repository_id::text as repository_id,
            to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at, e.envelope
     from attesta_records r join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
     where r.tenant_id = $1 order by r.seq`, [tenantId])).rows;
}

const auditRows = async (tenantId: string) => (await pool.query(
  `select actor_id, actor_type, target_type, target_id, details from security_audit_events where tenant_id = $1 and action = 'attesta.verify' order by occurred_at`,
  [tenantId])).rows;

const isProblem = (r: { status: number; headers: Headers; body: any }, status: number, code: string) =>
  r.status === status && r.headers.get('content-type')?.startsWith('application/problem+json') && r.body?.code === code
  && r.body?.request_id === r.headers.get('x-request-id');

async function it01(api: Api, appApi: Api, setClock: (ms: number) => void, anchors: { pass(t: string): Promise<unknown> }, a: Tenant): Promise<void> {
  const admin = token(a, 'admin-a');
  setClock(Date.now());
  let list = await listAll(api, admin);
  const rows = await tableRecords(a.tenantId);
  check(rows.length === 3 && list.length === 3, `three statements: ${list.length}`);
  check(list.every((s) => s.anchor_status === 'pending'), 'before anchoring: pending');
  for (const [i, s] of list.entries()) {
    const t = rows[i];
    check(s.seq === t.seq && s.statement_digest === t.statement_digest && s.recorded_at === t.recorded_at
      && s.statement_kind === t.statement_kind && s.subject_sha === t.subject_sha && s.repository_id === t.repository_id,
    'list item = table row');
  }

  await anchors.pass(a.tenantId);
  setClock(Date.now());
  list = await listAll(api, admin);
  check(list.every((s) => s.anchor_status === 'anchored'), 'after anchoring: anchored');

  // A fourth statement, not anchored: pending now, missing once the clock passes the window.
  await ingestCommit(a, sha());
  await build();
  setClock(Date.now());
  list = await listAll(api, admin);
  check(list.length === 4 && list[3].anchor_status === 'pending', 'new statement pending');
  setClock(Date.now() + 2 * HOUR);
  list = await listAll(api, admin);
  check(list[3].anchor_status === 'missing' && list.slice(0, 3).every((s) => s.anchor_status === 'anchored'), 'past the window: missing');
  const filtered = await listAll(api, admin, `&kind=deployed&repository_id=${a.repositoryId}`);
  check(filtered.length === 1 && filtered[0].statement_kind === 'deployed', 'kind and repository filters');

  // Detail = the stored bytes.
  const all = await tableRecords(a.tenantId);
  const dep = all.find((r) => r.statement_kind === 'deployed')!;
  const detail = await api.get(`/api/attesta/statements/${dep.statement_digest}`, admin);
  check(detail.status === 200, 'detail 200');
  check(!/credential/.test(detail.text), 'no credential in detail');
  const d = detail.body;
  check(d.record.seq === dep.seq && d.record.prev_hash === dep.prev_hash && d.record.record_hash === dep.record_hash
    && d.record.canonical_record === dep.canonical_record && d.record.recorded_at === dep.recorded_at, 'record = table');
  check(JSON.stringify(d.statement) === JSON.stringify(JSON.parse(dep.statement_canonical)), 'statement = stored statement');
  check(JSON.stringify(d.envelope) === JSON.stringify(dep.envelope), 'envelope = stored envelope');
  check(d.anchors.length === 2 && new Set(d.anchors.map((x: any) => x.anchor_type)).size === 2
    && d.anchors.every((x: any) => x.status === 'anchored' && x.inclusion_proof?.version === 1), 'two anchored rows with proofs');

  // Subject chain behind the merge sha: PR then deployment, linked by previous.
  const subject = await api.get(`/api/attesta/subjects/${a.repositoryId}/${a.mergeSha}`, admin);
  check(subject.status === 200 && subject.body.statements.length === 2, 'subject has two statements');
  const [pr, deployed] = subject.body.statements;
  check(pr.statement_kind === 'pr_merged' && deployed.statement_kind === 'deployed' && pr.seq < deployed.seq, 'oldest first');
  check(pr.previous.length === 0 && deployed.previous.length === 1 && deployed.previous[0] === pr.statement_digest, 'previous links');

  // Verify: report version 2, signatures not checked (no published keys yet), anchors checked.
  setClock(Date.now());
  const v = await api.get('/api/attesta/verify', admin, { 'X-Request-ID': 'it-t15i-01-verify' });
  const report = v.body as ChainReport;
  check(v.status === 200 && report.report_version === 2 && report.checked === 4, `verify: ${v.status}`);
  check(!report.ok && report.chain_intact && report.signatures === 'not_checked', 'never ok without published keys');
  check(report.breaks.length === 1 && report.breaks[0].detail_code === 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED', 'one SIGNATURES_NOT_CHECKED');
  check(report.anchors.status === 'checked' && report.anchors.anchored === 3 && report.anchors.pending === 1
    && report.anchors.invalid === 0 && report.anchors.not_checkable === 0, `anchors checked: ${JSON.stringify(report.anchors)}`);

  // The mount in createApp(): the same routes behind the real /api middleware.
  const mounted = await appApi.get('/api/attesta/statements', admin);
  check(mounted.status === 200 && mounted.body.statements.length === 4, 'createApp mount answers');
  const anonymous = await appApi.get('/api/attesta/statements');
  check(anonymous.status === 401, 'no token: 401 from the JWT middleware');
  console.log('IT-T15i-01=passed');
}

async function it02(api: Api, a: Tenant, b: Tenant): Promise<void> {
  const bTok = token(b, 'auditor-b');
  const aRecs = await tableRecords(a.tenantId);
  const bRecs = await tableRecords(b.tenantId);
  const bList = await listAll(api, bTok);
  check(bList.length === bRecs.length && bList.every((s) => s.repository_id === b.repositoryId), "B lists only B's");
  const aFilter = await api.get(`/api/attesta/statements?repository_id=${a.repositoryId}`, bTok);
  check(aFilter.status === 200 && aFilter.body.statements.length === 0, "filtering on A's repository is empty");
  const unknown = await api.get(`/api/attesta/statements/sha256:${'e'.repeat(64)}`, bTok);
  for (const r of aRecs) {
    const cross = await api.get(`/api/attesta/statements/${r.statement_digest}`, bTok);
    check(isProblem(cross, 404, 'ATTESTA_API_NOT_FOUND'), "A's digest is 404 for B");
    check(JSON.stringify({ ...cross.body, request_id: null }) === JSON.stringify({ ...unknown.body, request_id: null }), 'same body as an unknown digest');
  }
  const subj = await api.get(`/api/attesta/subjects/${a.repositoryId}/${a.mergeSha}`, bTok);
  check(isProblem(subj, 404, 'ATTESTA_API_NOT_FOUND'), "A's subject is 404 for B");
  const v = await api.get(`/api/attesta/verify?from_seq=0&to_seq=${aRecs.length - 1}`, bTok);
  const report = v.body as ChainReport;
  check(v.status === 200 && report.tenant_id === b.tenantId && report.checked === bRecs.length, "B's verify covers only B's chain");
  check(!aRecs.some((r) => v.text.includes(r.statement_digest) || v.text.includes(r.record_hash)), 'nothing of A in B\'s report');
  console.log('IT-T15i-02=passed');
}

async function it03(api: Api, a: Tenant): Promise<void> {
  const auditor = token(a, 'auditor-a');
  const recs = await tableRecords(a.tenantId);
  const before = (await auditRows(a.tenantId)).length;
  const paths = ['/api/attesta/statements', `/api/attesta/statements/${recs[0].statement_digest}`,
    `/api/attesta/subjects/${a.repositoryId}/${recs[0].subject_sha}`];
  for (const p of paths) check((await api.get(p, auditor)).status === 200, `auditor reads ${p}`);
  check((await auditRows(a.tenantId)).length === before, 'reads write no audit row');
  for (const sub of ['revoked-a', 'stranger-a']) {
    for (const p of [...paths, '/api/attesta/verify']) {
      check(isProblem(await api.get(p, token(a, sub)), 403, 'ATTESTA_API_FORBIDDEN'), `${sub} gets 403 on ${p}`);
    }
  }
  const v = await api.get('/api/attesta/verify', auditor, { 'X-Request-ID': 'it-t15i-03-verify' });
  check(v.status === 200 && v.headers.get('x-request-id') === 'it-t15i-03-verify', 'auditor verifies');
  const rows = await auditRows(a.tenantId);
  check(rows.length === before + 1, 'verify writes one audit row');
  const row = rows[rows.length - 1];
  check(row.actor_id === 'auditor-a' && row.actor_type === 'tenant_auditor' && row.target_type === 'attesta_chain'
    && row.target_id === `0-${recs.length - 1}` && row.details.request_id === 'it-t15i-03-verify' && row.details.ok === false
    && row.details.break_count === 1, 'audit row: actor, range, request id, ok, break count');
  check(Object.keys(row.details).sort().join(',') === 'break_count,checked,ok,request_id', 'audit details are counts only');
  console.log('IT-T15i-03=passed');
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15i-'));
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    // The JWT middleware reads SUPABASE_URL when it is first imported.
    const { authenticateJWT } = await import('../../core/middleware/auth');
    const { tenantMiddleware } = await import('../../core/middleware/tenant');
    const anchors = await anchoringEnv(dir);
    let clock = Date.now();
    const app = express();
    app.use('/api', authenticateJWT, tenantMiddleware);
    app.use('/api/attesta', createAttestaRouter({ now: () => new Date(clock) }));
    const own = await listen(app);
    const { createApp } = await import('../../app');
    const mounted = await listen(createApp());
    servers.push(own.server, mounted.server);

    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await observeAll(a);
    await observeAll(b);
    await build();
    await anchors.pass(b.tenantId);
    for (const [t, l] of [[a, 'a'], [b, 'b']] as const) {
      await grant(t, `admin-${l}`, 'tenant_admin');
      await grant(t, `auditor-${l}`, 'tenant_auditor');
      await grant(t, `revoked-${l}`, 'tenant_auditor', true);
    }
    await it01(client(own.base), client(mounted.base), (ms) => { clock = ms; }, anchors, a);
    await it02(client(own.base), a, b);
    await it03(client(own.base), a);
    console.log(`statements_company_a=${(await tableRecords(a.tenantId)).length}`);
    console.log(`statements_company_b=${(await tableRecords(b.tenantId)).length}`);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15i failed');
  process.exitCode = 1;
});
