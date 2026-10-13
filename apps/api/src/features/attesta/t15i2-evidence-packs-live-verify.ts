/**
 * IT-T15i2-01…03: Attesta evidence packs against real PostgreSQL (migration 0020),
 * through the real environment path: the default router (createAttestaRouter with no
 * seams except the clock) behind the real JWT and tenant middleware (a local JWKS
 * stands in for Supabase) and the real requireAdminAction; the trust inventory set up
 * with the attesta:keys CLI (dev credentials, ATTESTA_DEV_CREDENTIALS_FILE,
 * ATTESTA_TRUST_ROOT_KEYIDS); the builder signing through inventorySignerResolver;
 * anchoring configured through the environment as production reads it (the Rekor and
 * TSA fakes in process); the Task4 sink in TASK4_EXPORT_DIR.
 *
 *   scripts/it-db.sh npm run verify:task15i2-evidence-packs-live -w apps/api
 *
 * 01 builder + anchoring + keys → POST a pack → ready → download → the independent
 *    oracle verifies every hash, Merkle path and signature from the user's pin; pending
 *    is zero after anchoring; /verify is ok with signatures and anchors checked (real
 *    published keys); the stored file is the pack the signature names.
 * 02 Company A/B: B cannot read or download A's pack (the same 404 as an unknown id);
 *    a full pack of A never contains B's records, and B's pack none of A's.
 * 03 the auditor exports and downloads (both audited with the request ID); a
 *    non-member and a revoked auditor get 403; an idempotent repeat returns the same
 *    job, another scope 409; repository_only hides the other repository; the 0020
 *    guards refuse status going back, identity changes, deletes and truncates.
 *
 * recorded_at is stamped through the ledger's clock seam (chainStatement's clock), set
 * 50…10 minutes in the past, so the window settles (evidence-pack.md: `to` at least
 * 5 minutes before generated_at) without waiting. Prints only safe summary lines.
 */
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, pool } from '../../core/db';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { anchorFromEnv } from './anchor-env';
import { runAnchorPass } from './anchor-worker';
import { main as keysMain } from './attesta-keys-cli';
import { main as rootMain } from './attesta-trust-root-cli';
import { createAttestaRouter } from './attesta.routes';
import { chainStatement } from './ledger';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { oracleVerifyPack } from './testing/evidence-pack-oracle';
import { keyidOf } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';
import type { ChainReport } from './verify-chain';
import { runBuilderPass, type BuilderPassOptions } from './worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15i2 failed: ${message}`);
}

const MIN = 60_000;
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; domain: string; slug: string; repos: Record<'r1' | 'r2', { url: string; id: string }> }

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15i2-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  return { label, tenantId, domain, slug, repos: { r1: { url: `https://github.com/${slug}/one`, id: '' }, r2: { url: `https://github.com/${slug}/two`, id: '' } } };
}

function commitEvent(t: Tenant, url: string, commitSha: string): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  const note = [`src/${t.label}/alpha.ts`, '  s_it::t_1 1-6', '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${t.label}`, model: 'model-x' } } } })].join('\n');
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 6, '3': ['opencode:model-x'], '5': [6], '11': 'IT synthetic commit', '13': note, '15': now - 60, '16': now - 30 },
    a: { '1': url, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${t.label}` },
  };
}

// ---------------------------------------------------------------------------
// JWKS and tokens (as IT-T15i)

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t15i2';
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

async function grant(t: Tenant, subject: string, role: 'tenant_admin' | 'tenant_auditor', revoked = false): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, $5, 'it-t15i2', $6)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role, revoked ? 'revoked' : 'active', revoked ? new Date() : null]);
}

interface Res { status: number; headers: Headers; body: any; text: string }
function client(base: string) {
  const call = async (method: string, path: string, bearer?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    check(!bearer || res.headers.get('cache-control') === 'no-store', `${method} ${path}: no-store (${res.status})`);
    return { status: res.status, headers: res.headers, body: parsed, text };
  };
  return {
    get: (path: string, bearer?: string, headers?: Record<string, string>) => call('GET', path, bearer, undefined, headers),
    post: (path: string, bearer: string, body: unknown, headers?: Record<string, string>) => call('POST', path, bearer, body, headers),
  };
}
type Api = ReturnType<typeof client>;

const isProblem = (r: Res, status: number, code: string) =>
  r.status === status && r.headers.get('content-type')?.startsWith('application/problem+json') && r.body?.code === code;

// ---------------------------------------------------------------------------
// The world: trust inventory by CLI, environment as production reads it, statements

async function makeWorld(dir: string) {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const creds = [['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:b1', b.tenantId, k.b1]] as const;
  const exportDir = join(dir, 'exports');
  mkdirSync(exportDir, { mode: 0o700 });
  const rekor = new FakeRekor();
  const tsa = await FakeTsa.create();
  Object.assign(process.env, {
    ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid,
    ATTESTA_DEV_CREDENTIALS_FILE: file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
      ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) })))),
    // Anchoring signs with the same dev key the root lists as the platform anchor key.
    ATTESTA_ANCHOR_CREDENTIAL_ID: 'dev:anchor',
    ATTESTA_DEV_ANCHOR_KEY_FILE: file('dev_anchor.pem', k.anchor.pem),
    ATTESTA_REKOR_URL: 'http://rekor.test',
    ATTESTA_REKOR_LOG_KEY_FILE: file('rekor.pem', createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString()),
    ATTESTA_TSA_URL: TSA_URL,
    ATTESTA_TSA_ANCHORS_FILE: file('tsa.pem', tsa.anchorsPem),
    TASK4_EXPORT_DIR: exportDir,
  });
  const env = process.env;
  const out: string[] = [];
  const err: string[] = [];
  const io = { readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
    // Set up two hours back (Task15i3): /verify applies key windows, and the statements below are
    // stamped up to 50 minutes in the past; recorded_at before a key's not_before is KEY_NOT_VALID_AT.
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, now: () => new Date(Date.now() - 2 * 60 * MIN) };
  const cli = async (...argv: string[]) => { out.length = 0; err.length = 0; const code = await keysMain(argv, io); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const apply = async (...argv: string[]) => {
    const dry = await cli(...argv);
    check(dry.code === 0, `dry run ${argv[0]}: ${dry.err}`);
    const m = /--confirm=(\S+) --expect=(\d+)/.exec(dry.out);
    check(m, `dry run ${argv[0]} prints the apply flags`);
    const done = await cli(...argv, `--confirm=${m[1]}`, `--expect=${m[2]}`, '--actor', 'it-operator');
    check(done.code === 0, `apply ${argv[0]}: ${done.err}`);
  };
  await apply('register', '--adapter', 'local-dev', '--credential', 'dev:anchor', '--purpose', 'anchor');
  await apply('register', '--adapter', 'local-dev', '--credential', 'dev:keyset', '--purpose', 'tenant_keyset');
  const draft = join(dir, 'draft.json');
  const signed = join(dir, 'root.json');
  check((await cli('export-root-draft', '--out', draft, '--root-pub', file('root.pub', k.root.pubPem), '--add', k.anchor.keyid, '--add', k.keyset.keyid)).code === 0, 'export-root-draft');
  const offline = { ...io, out: () => undefined, err: () => undefined, env: {} };
  check(await rootMain(['sign', '--draft', draft, '--key', file('root.pem', k.root.pem), '--out', signed], offline) === 0, 'offline root signature');
  await apply('import-root', '--file', signed);
  for (const [t, cred] of [[a, 'dev:a1'], [b, 'dev:b1']] as const) {
    await apply('register', '--adapter', 'local-dev', '--credential', cred, '--tenant', t.tenantId);
    await apply('activate', '--tenant', t.tenantId, '--keyid', (cred === 'dev:a1' ? k.a1 : k.b1).keyid);
    await apply('publish', '--tenant', t.tenantId);
  }

  const resolver = inventorySignerResolver(pgTrustStore(db as unknown as TrustDb), await adaptersFromEnv(env), trustConfigFromEnv(env));
  const anchoring = await anchorFromEnv(env, { rekorFetch: rekor.fetch, tsaFetch: tsa.fetch });
  /** One statement per (tenant, repo), stamped `ageMin` minutes ago through the ledger's clock seam. */
  const statement = async (t: Tenant, repo: 'r1' | 'r2', ageMin: number) => {
    const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, t.repos[repo].url, sha())] });
    check(errors.length === 0, `${t.label}: ingestion`);
    const stamp = new Date(Date.now() - ageMin * MIN);
    const options: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef',
      deps: { chain: (tx, input) => chainStatement(tx, input, () => stamp) } };
    const pass = await runBuilderPass(db, resolver, options);
    check(pass.failed === 0 && pass.retried === 0 && pass.done === 1, `builder pass: ${JSON.stringify(pass.codes)}`);
    if (!t.repos[repo].id) {
      const r = await pool.query(`select id::text as id from scm_repositories where tenant_id = $1 and url = $2`, [t.tenantId, t.repos[repo].url]);
      check(r.rows.length === 1, `${t.label}/${repo}: one repository row`);
      t.repos[repo].id = r.rows[0].id;
    }
  };
  const anchorAll = async (t: Tenant) => {
    rekor.clock = Math.floor(Date.now() / 1000);
    const r = await runAnchorPass(db, { anchor: anchoring.anchor, now: () => new Date() }, { tenantId: t.tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
    check(r.tenantErrors === 0 && r.batchesAnchored >= 1, `anchoring pass: ${JSON.stringify(r)}`);
  };
  return { a, b, k, exportDir, statement, anchorAll };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

/** Waits for the in-process job the POST started (the API runs it after the 202). */
async function waitReady(api: Api, bearer: string, id: string): Promise<any> {
  for (let i = 0; i < 150; i++) {
    const r = await api.get(`/api/attesta/evidence-packs/${id}`, bearer);
    check(r.status === 200, `status ${r.status}`);
    if (r.body.status === 'ready' || r.body.status === 'failed') return r.body;
    await sleep(100);
  }
  throw new Error('IT-T15i2 failed: the pack did not finish in 15 s');
}

const recordsOf = async (tenantId: string) => (await pool.query(
  `select statement_digest, record_hash, repository_id::text as repository_id from attesta_records where tenant_id = $1 order by seq`, [tenantId])).rows;
const audits = async (tenantId: string, action: string) => (await pool.query(
  `select actor_id, actor_type, target_type, target_id, details from security_audit_events where tenant_id = $1 and action = $2 order by occurred_at`,
  [tenantId, action])).rows;

// The window: statements at −50 (r1, boundary), −40 (r2), −30 (r1), −20 (r2) and −10 (r1, boundary) minutes.
const windowBody = () => ({ from: iso(Date.now() - 45 * MIN), to: iso(Date.now() - 15 * MIN) });

async function it01(api: Api, w: World): Promise<string> {
  const admin = token(w.a, 'admin-a');
  const post = await api.post('/api/attesta/evidence-packs', admin, windowBody(), { 'Idempotency-Key': 'it-01-full-pack', 'X-Request-ID': 'it-t15i2-01' });
  check(post.status === 202 && post.body.status === 'queued', `POST: ${post.status} ${post.text.slice(0, 200)}`);
  const status = await waitReady(api, admin, post.body.id);
  check(status.status === 'ready', `job ready: ${status.status} ${status.error_code}`);
  check(status.counts.statements === 3 && status.counts.pending === 0 && status.counts.anchored === 3 && status.counts.records === 5,
    `counts: ${JSON.stringify(status.counts)}`);
  const content = await api.get(status.content_path, admin);
  check(content.status === 200 && /attachment; filename="trackai-evidence-pack-/.test(content.headers.get('content-disposition') ?? ''), 'download');
  check(!/credential|dev:a1|dev:anchor|example\.invalid|github\.com/.test(content.text), 'no credential reference, email or repository URL in the pack');
  const verdict = oracleVerifyPack(content.body, [w.k.root.keyid]);
  check(verdict.ok && verdict.completeness === 'checked', `oracle: ${verdict.breaks.slice(0, 5).join('; ')}`);
  check(verdict.counts.statements === 3 && verdict.counts.anchorPaths === 6, `oracle counts: ${JSON.stringify(verdict.counts)}`);
  check(content.body.pack.trust.anchoring_keys.length === 1 && content.body.pack.trust.anchoring_keys[0].root_entry?.purpose === 'anchor',
    'the anchoring key ships with its root entry');
  // The stored file is exactly the pack the digest names.
  const files = readdirSync(w.exportDir);
  check(files.length === 1, `one file in the sink: ${files.length}`);
  const stored = readFileSync(join(w.exportDir, files[0]), 'utf8');
  check(stored === JSON.stringify(content.body.pack) && `sha256:${(await import('node:crypto')).createHash('sha256').update(stored).digest('hex')}` === status.pack_digest,
    'the stored bytes are the signed pack');
  // /verify with the real published keys: ok, signatures and anchors checked.
  const v = await api.get('/api/attesta/verify', admin);
  const report = v.body as ChainReport;
  check(v.status === 200 && report.ok && report.signatures === 'checked' && report.anchors.status === 'checked'
    && report.anchors.anchored === 5, `verify: ${JSON.stringify({ ok: report.ok, breaks: report.breaks?.slice(0, 3), anchors: report.anchors })}`);
  console.log(`it01_records=${status.counts.records} statements=${status.counts.statements} pending=${status.counts.pending} oracle=ok verify=ok`);
  console.log('IT-T15i2-01=passed');
  return post.body.id as string;
}

async function it02(api: Api, w: World, aPackId: string): Promise<void> {
  const bTok = token(w.b, 'auditor-b');
  for (const path of [`/api/attesta/evidence-packs/${aPackId}`, `/api/attesta/evidence-packs/${aPackId}/content`]) {
    const theirs = await api.get(path, bTok);
    const none = await api.get(path.replace(aPackId, randomUUID()), bTok);
    check(isProblem(theirs, 404, 'ATTESTA_API_NOT_FOUND') && isProblem(none, 404, 'ATTESTA_API_NOT_FOUND') && theirs.body.title === none.body.title,
      `B gets the same 404 for A's pack: ${path}`);
  }
  // B's key with A's idempotency key makes B's own job, never A's.
  const bPost = await api.post('/api/attesta/evidence-packs', bTok, windowBody(), { 'Idempotency-Key': 'it-01-full-pack' });
  check(bPost.status === 202 && bPost.body.id !== aPackId, 'B with the same key gets its own job');
  const bStatus = await waitReady(api, bTok, bPost.body.id);
  check(bStatus.status === 'ready', `B's pack: ${bStatus.error_code}`);
  const bPack = (await api.get(bStatus.content_path, bTok)).body;
  const aPack = (await api.get(`/api/attesta/evidence-packs/${aPackId}/content`, token(w.a, 'admin-a'))).body;
  const aText = JSON.stringify(aPack);
  const bText = JSON.stringify(bPack);
  for (const r of await recordsOf(w.b.tenantId)) check(!aText.includes(r.statement_digest) && !aText.includes(r.record_hash), "A's pack holds none of B's records");
  for (const r of await recordsOf(w.a.tenantId)) check(!bText.includes(r.statement_digest) && !bText.includes(r.record_hash), "B's pack holds none of A's records");
  check(!aText.includes(w.b.tenantId) && !bText.includes(w.a.tenantId), 'no tenant ID crosses');
  check(oracleVerifyPack(bPack, [w.k.root.keyid]).ok, "B's pack verifies for B");
  // A's pack relabelled as B's fails (the signature and B's key sets do not cover it).
  const relabelled = structuredClone(aPack);
  relabelled.pack.manifest.tenant_id = w.b.tenantId;
  relabelled.pack.trust.keyset_documents = bPack.pack.trust.keyset_documents;
  check(!oracleVerifyPack(relabelled, [w.k.root.keyid]).ok, 'a relabelled pack fails');
  console.log('IT-T15i2-02=passed');
}

async function it03(api: Api, w: World): Promise<void> {
  const auditor = token(w.a, 'auditor-a');
  const body = { ...windowBody(), repository_id: w.a.repos.r1.id, mode: 'repository_only' };
  for (const sub of ['stranger-a', 'revoked-a']) {
    check(isProblem(await api.post('/api/attesta/evidence-packs', token(w.a, sub), body, { 'Idempotency-Key': 'it-03-refused' }), 403, 'ATTESTA_API_FORBIDDEN'),
      `${sub}: 403 on POST`);
  }
  const before = (await audits(w.a.tenantId, 'attesta.export.request')).length;
  const post = await api.post('/api/attesta/evidence-packs', auditor, body, { 'Idempotency-Key': 'it-03-auditor', 'X-Request-ID': 'it-t15i2-03-req' });
  check(post.status === 202, `auditor POST: ${post.status} ${post.text.slice(0, 200)}`);
  const again = await api.post('/api/attesta/evidence-packs', auditor, body, { 'Idempotency-Key': 'it-03-auditor' });
  check(again.status === 202 && again.body.id === post.body.id && again.body.replayed === true, 'idempotent repeat: the same job');
  check(isProblem(await api.post('/api/attesta/evidence-packs', auditor, { ...body, mode: 'full' }, { 'Idempotency-Key': 'it-03-auditor' }), 409, 'ATTESTA_API_CONFLICT'),
    'another scope: 409');
  const jobs = await pool.query(`select count(*)::int as n from attesta_evidence_packs where tenant_id = $1 and idempotency_key = 'it-03-auditor'`, [w.a.tenantId]);
  check(jobs.rows[0].n === 1, 'one job row');
  const status = await waitReady(api, auditor, post.body.id);
  check(status.status === 'ready' && status.counts.statements === 1 && status.counts.redacted_records === 4, `repository_only counts: ${JSON.stringify(status.counts)}`);
  for (const sub of ['stranger-a', 'revoked-a']) {
    check(isProblem(await api.get(status.content_path, token(w.a, sub)), 403, 'ATTESTA_API_FORBIDDEN'), `${sub}: 403 on download`);
  }
  const dl = await api.get(status.content_path, auditor, { 'X-Request-ID': 'it-t15i2-03-dl' });
  check(dl.status === 200 && !dl.text.includes(w.a.repos.r2.id), 'repository_only never names the other repository');
  const verdict = oracleVerifyPack(dl.body, [w.k.root.keyid]);
  check(verdict.ok && verdict.completeness === 'not_checkable', `repository_only verifies, completeness not checkable: ${verdict.breaks.join('; ')}`);
  const req = await audits(w.a.tenantId, 'attesta.export.request');
  check(req.length === before + 2, `request audits: ${req.length - before}`);
  const first = req[before];
  check(first.actor_id === 'auditor-a' && first.actor_type === 'tenant_auditor' && first.target_type === 'attesta_evidence_pack'
    && first.target_id === post.body.id && first.details.request_id === 'it-t15i2-03-req' && first.details.replayed === false
    && first.details.mode === 'repository_only', 'request audit row');
  const downloads = await audits(w.a.tenantId, 'attesta.export.download');
  const last = downloads[downloads.length - 1];
  check(last.actor_id === 'auditor-a' && last.details.request_id === 'it-t15i2-03-dl' && last.details.pack_digest === status.pack_digest, 'download audit row');
  check(!JSON.stringify([...req, ...downloads]).includes('statement_canonical'), 'audits carry no content');

  // 0020 guards, as the API role.
  const id = post.body.id as string;
  const refused = async (label: string, statement: string) => {
    const r = await pool.query(statement, [w.a.tenantId, id]).then(() => 'accepted', (e: { code?: string }) => e.code ?? 'error');
    check(r !== 'accepted', `guard: ${label}`);
  };
  await refused('ready back to queued', `update attesta_evidence_packs set status = 'queued', lease_until = null, pack_digest = null, storage_reference = null, bytes = null, counts = null, signature_envelope = null, finished_at = null where tenant_id = $1 and id = $2`);
  await refused('scope changed', `update attesta_evidence_packs set scope = '{}'::jsonb where tenant_id = $1 and id = $2`);
  await refused('ready → failed', `update attesta_evidence_packs set status = 'failed', error_code = 'ATTESTA_API_INTERNAL' where tenant_id = $1 and id = $2`);
  await refused('delete', `delete from attesta_evidence_packs where tenant_id = $1 and id = $2`);
  await refused('truncate', `truncate attesta_evidence_packs`);
  await refused('insert running', `insert into attesta_evidence_packs (tenant_id, idempotency_key, scope, mode, requested_by, request_id, status, lease_until, attempts) values ($1, 'guard-key-1' || $2::text, '{}'::jsonb, 'full', 'x', 'y', 'running', now(), 1)`);
  const rls = await pool.query(`select relrowsecurity from pg_class where relname = 'attesta_evidence_packs'`);
  check(rls.rows[0].relrowsecurity === true, 'RLS enabled');
  console.log('IT-T15i2-03=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15i2-'));
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    const { authenticateJWT } = await import('../../core/middleware/auth');
    const { tenantMiddleware } = await import('../../core/middleware/tenant');
    const w = await makeWorld(dir);
    for (const t of [w.a, w.b]) {
      for (const [repo, age] of [['r1', 50], ['r2', 40], ['r1', 30], ['r2', 20], ['r1', 10]] as const) await w.statement(t, repo, age);
      await w.anchorAll(t);
      for (const l of ['admin', 'auditor']) await grant(t, `${l}-${t.label}`, l === 'admin' ? 'tenant_admin' : 'tenant_auditor');
      await grant(t, `revoked-${t.label}`, 'tenant_auditor', true);
    }
    // The default router: production wiring from the environment (only the 202's job start and the clock are real too).
    const app = express();
    app.use(express.json());
    app.use('/api', authenticateJWT, tenantMiddleware);
    app.use('/api/attesta', createAttestaRouter());
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const api = client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const aPack = await it01(api, w);
    await it02(api, w, aPack);
    await it03(api, w);
    const n = await pool.query(`select status, count(*)::int as n from attesta_evidence_packs group by status order by status`);
    console.log(`packs=${n.rows.map((r: { status: string; n: number }) => `${r.status}:${r.n}`).join(',')}`);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15i2 failed');
  process.exitCode = 1;
});
