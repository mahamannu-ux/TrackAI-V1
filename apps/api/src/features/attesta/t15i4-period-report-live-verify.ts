/**
 * IT-T15i4-01…03: the signed period report (Task15i4, A15.9 part 3) against real PostgreSQL
 * (migration 0022), through the real environment path as IT-T15i2: the default router behind
 * the real JWT and tenant middleware, the trust inventory set up by the attesta:keys CLI, the
 * builder and the report job signing through inventorySignerResolver, anchoring through the
 * environment (the Rekor and TSA fakes in process).
 *
 *   scripts/it-db.sh npm run verify:task15i4-period-report-live -w apps/api
 *
 * 01 builder statements → a report job (direct, with the ledger clock seam so the record
 *    settles) → chained, anchored → /verify ok with signatures and anchors → GET document →
 *    P1–P10 hold and every figure recomputes from the signed statements (P9); an evidence
 *    pack over the window lists the report statement, the offline verifier passes its
 *    statements check (reports: not checkable, exit 2) and the pack's own statements
 *    recompute the document; a report through POST (the real 202 path) is ready and its
 *    rerun lists the first in `previous`.
 * 02 Company A/B: B gets the same 404 for A's report and document as for an unknown id; B
 *    cannot report on A's repository; B's report sums none of A's statements.
 * 03 idempotency (replay, 409), audits, the 0022 guards on attesta_period_reports, and the
 *    replaced 0017 chain guard refusing malformed period_report records, as the API role and
 *    as an RLS-bound role.
 *
 * Prints only safe summary lines.
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
import { buildCanonicalRecord, chainStatement } from './ledger';
import { canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import { verifyEvidencePack } from './offline-verifier';
import { checkPeriodReport, type ReportInput } from './period-report-rules';
import { pgReportStore, runPeriodReport, type ReportDatabase } from './period-report-service';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { oracleVerifyPack } from './testing/evidence-pack-oracle';
import { keyidOf } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';
import type { ChainReport } from './verify-chain';
import { runBuilderPass, type BuilderPassOptions } from './worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15i4 failed: ${message}`);
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
  const slug = `it-t15i4-${label}-${randomUUID().slice(0, 8)}`;
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
const KID = 'it-t15i4';
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
     values ($1, $2, $3, $4, $5, 'it-t15i4', $6)`,
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
    // The report builder's version (period-report-service.ts defaultReportJobDeps).
    TRACKAI_GIT_COMMIT: '0123456789abcdef',
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
  return { a, b, k, exportDir, statement, anchorAll, rekor, tsa, resolver };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

/** Waits for the in-process job the POST started (the API runs it after the 202). */
async function waitReady(api: Api, bearer: string, id: string, kind: 'evidence-packs' | 'period-reports' = 'evidence-packs'): Promise<any> {
  for (let i = 0; i < 150; i++) {
    const r = await api.get(`/api/attesta/${kind}/${id}`, bearer);
    check(r.status === 200, `status ${r.status}`);
    if (r.body.status === 'ready' || r.body.status === 'failed') return r.body;
    await sleep(100);
  }
  throw new Error(`IT-T15i4 failed: the ${kind} job did not finish in 15 s`);
}

const recordsOf = async (tenantId: string) => (await pool.query(
  `select statement_digest, record_hash, repository_id::text as repository_id from attesta_records where tenant_id = $1 order by seq`, [tenantId])).rows;
const audits = async (tenantId: string, action: string) => (await pool.query(
  `select actor_id, actor_type, target_type, target_id, details from security_audit_events where tenant_id = $1 and action = $2 order by occurred_at`,
  [tenantId, action])).rows;


const PERIOD_REPORT = 'https://trackai.dev/attesta/period-report/v1';

/** One report job run directly (no route), recorded `ageMin` minutes ago through the ledger clock seam. */
async function directReport(w: World, t: Tenant, scope: { repository_id: string; from: string; to: string }, key: string, ageMin: number) {
  const store = pgReportStore(db as unknown as ReportDatabase, { clock: () => new Date(Date.now() - ageMin * MIN) });
  const { job } = await store.createOrGet({ tenantId: t.tenantId, idempotencyKey: key, request: { scope: { ...scope, basis: 'recorded_at' } },
    requestedBy: 'it-operator', requestId: `req-${key}` });
  const result = await runPeriodReport({ store, resolver: async () => w.resolver, builderVersion: () => '0.1.0+0123456789abcdef', log: () => undefined },
    t.tenantId, job.id);
  check(result === 'ready', `direct report: ${result} ${(await store.get(t.tenantId, job.id))?.errorCode}`);
  return job.id;
}

/** The ai-provenance statements of a repository in a window, from the ledger (stored bytes). */
async function inputsOf(t: Tenant, scope: { repository_id: string; from: string; to: string }): Promise<ReportInput[]> {
  const r = await pool.query(`select seq::text as seq, statement_digest, statement_canonical from attesta_records
    where tenant_id = $1 and repository_id = $2 and predicate_type = 'https://trackai.dev/attesta/ai-provenance/v1'
      and recorded_at >= $3 and recorded_at <= $4 order by seq`, [t.tenantId, scope.repository_id, scope.from, scope.to]);
  return r.rows.map((x: { seq: string; statement_digest: string; statement_canonical: string }) =>
    ({ seq: Number(x.seq), digest: x.statement_digest, canonical: x.statement_canonical }));
}

// Statements at −50, −30, −10 (r1) and −40, −20 (r2) minutes; the report window holds all of them.
const reportScope = (t: Tenant) => ({ repository_id: t.repos.r1.id, from: iso(Date.now() - 55 * MIN), to: iso(Date.now() - 8 * MIN) });

async function it01(api: Api, w: World): Promise<string> {
  const admin = token(w.a, 'admin-a');
  const scope = reportScope(w.a);
  const id = await directReport(w, w.a, scope, 'it-01-direct-rep', 7);
  await w.anchorAll(w.a);
  const status = (await api.get(`/api/attesta/period-reports/${id}`, admin)).body;
  check(status.status === 'ready' && /^sha256:/.test(status.statement_digest), `report status: ${JSON.stringify(status)}`);
  const rec = (await pool.query(`select seq::text as seq, statement_kind, subject_sha, outbox_subject_id, repository_id::text as repository_id, statement_canonical
    from attesta_records where tenant_id = $1 and statement_digest = $2`, [w.a.tenantId, status.statement_digest])).rows[0];
  check(rec && rec.statement_kind === null && rec.subject_sha === null && rec.outbox_subject_id === null && rec.repository_id === scope.repository_id,
    'the report record: kind, sha and outbox null, the repository from the scope');
  const anchored = await pool.query(`select count(*)::int as n from attesta_anchors a join attesta_records r on r.tenant_id = a.tenant_id and r.id = a.record_id
    where a.tenant_id = $1 and r.statement_digest = $2 and a.status = 'anchored'`, [w.a.tenantId, status.statement_digest]);
  check(anchored.rows[0].n === 2, 'the report record is anchored in Rekor and the TSA');
  const v = await api.get('/api/attesta/verify', admin);
  const report = v.body as ChainReport;
  check(v.status === 200 && report.ok && report.signatures === 'checked' && report.anchors.status === 'checked',
    `verify: ${JSON.stringify({ ok: report.ok, breaks: report.breaks?.slice(0, 3), anchors: report.anchors })}`);

  // The document: P1–P10, and every figure recomputed from the signed statements (P9).
  const doc = await api.get(status.document_path, admin);
  check(doc.status === 200 && /attachment; filename="trackai-period-report-/.test(doc.headers.get('content-disposition') ?? ''), 'document download');
  const statement = JSON.parse(rec.statement_canonical);
  const inputs = await inputsOf(w.a, scope);
  check(inputs.length === 3, `three r1 statements in the window: ${inputs.length}`);
  const broken = checkPeriodReport({ statement, documentText: doc.text, tenantId: w.a.tenantId, inputs });
  check(broken.length === 0, `P1–P10 against the database: ${broken.join(',')}`);
  const figures = statement.predicate.figures;
  check(figures.commits_observed.value === 3 && figures.lines_changed.availability === 'recorded'
    && figures.lines_changed.value.ai === 18, `figures: ${JSON.stringify({ c: figures.commits_observed, l: figures.lines_changed.value })}`);
  check(statement.predicate.ratios.ai_share_of_changed_lines_bp.value === 10000, 'AI share of changed lines in basis points');
  check(!/example\.invalid|github\.com|IT Dev|alpha\.ts/.test(doc.text + rec.statement_canonical), 'no email, URL, name or path in the report');

  // An evidence pack over the window lists the report statement; the pack's statements recompute it.
  const packWindow = { from: scope.from, to: iso(Date.now() - 6 * MIN), repository_id: scope.repository_id };
  const post = await api.post('/api/attesta/evidence-packs', admin, packWindow, { 'Idempotency-Key': 'it-01-report-pack' });
  check(post.status === 202, `pack POST: ${post.status} ${post.text.slice(0, 200)}`);
  const pack = await waitReady(api, admin, post.body.id);
  check(pack.status === 'ready' && pack.counts.statements === 4 && pack.counts.pending === 0, `pack counts: ${JSON.stringify(pack.counts)}`);
  const content = (await api.get(pack.content_path, admin)).body;
  const reportInPack = content.pack.statements.find((s: { statement_digest: string }) => s.statement_digest === status.statement_digest);
  check(reportInPack !== undefined, 'the pack lists the report statement');
  // The report's inputs chosen from the pack alone (review finding: never from the database
  // query the service shares): the hashed records of the repository's ai-provenance
  // statements with recorded_at in [from, to], then their statements by seq.
  const inWindow = content.pack.records
    .filter((r: { canonical_record?: string }) => typeof r.canonical_record === 'string')
    .map((r: { canonical_record: string }) => JSON.parse(r.canonical_record))
    .filter((f: any) => f.predicate_type === 'https://trackai.dev/attesta/ai-provenance/v1' && f.repository_id === scope.repository_id
      && f.recorded_at >= scope.from && f.recorded_at <= scope.to);
  const packInputs: ReportInput[] = inWindow.map((f: { seq: number }) => {
    const s = content.pack.statements.find((x: { seq: number }) => x.seq === f.seq);
    check(s !== undefined, `the pack carries the statement at seq ${f.seq}`);
    return { seq: s.seq, digest: s.statement_digest, canonical: s.statement_canonical };
  });
  check(packInputs.length === 3, `three inputs chosen from the pack: ${packInputs.length}`);
  check(checkPeriodReport({ statement: JSON.parse(reportInPack.statement_canonical), documentText: doc.text, tenantId: w.a.tenantId, inputs: packInputs }).length === 0,
    'the figures recompute from the pack\'s own statements');
  const oracle = oracleVerifyPack(content, [w.k.root.keyid]);
  check(oracle.ok, `pack oracle: ${oracle.breaks.slice(0, 3).join('; ')}`);
  const offline = verifyEvidencePack(content, { pinnedRootKeyids: [w.k.root.keyid], now: new Date().toISOString(),
    rekorLogKeyPem: createPublicKey(w.rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(), tsaAnchorsPem: w.tsa.anchorsPem });
  const by = Object.fromEntries(offline.checks.map((c) => [c.id, c.status]));
  check(by.statements === 'passed' && by.chain === 'passed' && by.completeness === 'passed' && by.anchors === 'passed'
    && by.reports === 'not_checkable' && offline.exit_code === 2, `offline verifier: ${JSON.stringify(by)} exit ${offline.exit_code}`);

  // Through the route (the real 202 path): ready, and the rerun of the same scope lists the first.
  const routed = await api.post('/api/attesta/period-reports', admin, scope, { 'Idempotency-Key': 'it-01-route-rep', 'X-Request-ID': 'it-t15i4-01' });
  check(routed.status === 202 && routed.body.status === 'queued', `POST report: ${routed.status} ${routed.text.slice(0, 200)}`);
  const done = await waitReady(api, admin, routed.body.id, 'period-reports');
  check(done.status === 'ready', `routed report: ${done.status} ${done.error_code}`);
  check(done.report_digest === status.report_digest, 'the same statements give the same document bytes (regeneration)');
  const second = JSON.parse((await pool.query(`select statement_canonical from attesta_records where tenant_id = $1 and statement_digest = $2`,
    [w.a.tenantId, done.statement_digest])).rows[0].statement_canonical);
  check(second.predicate.previous.length === 1 && second.predicate.previous[0].digest === status.statement_digest, 'the rerun lists the earlier report in previous');
  console.log(`it01_inputs=${inputs.length} commits=${figures.commits_observed.value} ai_bp=${statement.predicate.ratios.ai_share_of_changed_lines_bp.value} anchored=2 verify=ok pack_statements=${pack.counts.statements} offline_exit=${offline.exit_code} p9=ok regenerated=identical`);
  console.log('IT-T15i4-01=passed');
  return id;
}

async function it02(api: Api, w: World, aReportId: string): Promise<void> {
  const bTok = token(w.b, 'auditor-b');
  for (const path of [`/api/attesta/period-reports/${aReportId}`, `/api/attesta/period-reports/${aReportId}/document`]) {
    const theirs = await api.get(path, bTok);
    const none = await api.get(path.replace(aReportId, randomUUID()), bTok);
    check(isProblem(theirs, 404, 'ATTESTA_API_NOT_FOUND') && isProblem(none, 404, 'ATTESTA_API_NOT_FOUND') && theirs.body.title === none.body.title,
      `B gets the same 404 for A's report: ${path}`);
  }
  check(isProblem(await api.post('/api/attesta/period-reports', bTok, reportScope(w.a), { 'Idempotency-Key': 'it-02-b-on-a' }), 400, 'ATTESTA_API_INVALID_QUERY'),
    "B cannot report on A's repository");
  const bScope = reportScope(w.b);
  const post = await api.post('/api/attesta/period-reports', bTok, bScope, { 'Idempotency-Key': 'it-01-route-rep' });
  check(post.status === 202, 'B with A\'s idempotency key gets its own job');
  const done = await waitReady(api, bTok, post.body.id, 'period-reports');
  check(done.status === 'ready', `B's report: ${done.error_code}`);
  const doc = (await api.get(done.document_path, bTok)).text;
  for (const r of await recordsOf(w.a.tenantId)) check(!doc.includes(r.statement_digest), "B's report sums none of A's statements");
  check(!doc.includes(w.a.tenantId), 'no tenant ID crosses');
  console.log('IT-T15i4-02=passed');
}

/** A period_report record at the head of `t`'s chain with one defect; returns the error code or 'accepted'. */
async function recordAttack(q: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, t: Tenant, statementJson: any, typed: {
  predicate_type?: string; statement_kind?: string | null; subject_sha?: string | null; repository_id?: string; outbox_subject_id?: string | null;
}): Promise<string> {
  // On the attacking connection: its transaction holds the policies' table locks.
  const head = (await q(`select next_seq::text as next_seq, head_hash from chain_head where tenant_id = $1`, [t.tenantId])).rows[0];
  const last = (await q(`select to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from attesta_records where tenant_id = $1 and seq = $2`,
    [t.tenantId, Number(head.next_seq) - 1])).rows[0].at as string;
  const statementCanonical = canonicalize(statementJson);
  const digest = sha256Prefixed(statementCanonical);
  const fields = {
    seq: Number(head.next_seq), prev_hash: head.head_hash, recorded_at: last, tenant_id: t.tenantId, record_kind: 'statement' as const,
    statement_digest: digest, predicate_type: typed.predicate_type ?? PERIOD_REPORT, statement_kind: (typed.statement_kind ?? null) as any,
    repository_id: typed.repository_id ?? t.repos.r1.id, subject_sha: typed.subject_sha ?? null, outbox_subject_id: typed.outbox_subject_id ?? null,
  };
  const canonicalRecord = buildCanonicalRecord(fields);
  return q(`insert into attesta_records (tenant_id, seq, prev_hash, recorded_at, record_kind, statement_digest, predicate_type, statement_kind,
      repository_id, subject_sha, statement_canonical, canonical_record, record_hash, outbox_subject_id)
    values ($1, $2, $3, $4, 'statement', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
  [t.tenantId, fields.seq, fields.prev_hash, last, digest, fields.predicate_type, fields.statement_kind, fields.repository_id, fields.subject_sha,
    statementCanonical, canonicalRecord, computeRecordHash(canonicalRecord, fields.prev_hash), fields.outbox_subject_id])
    .then(() => 'accepted', (e: { code?: string }) => e.code ?? 'error');
}

async function it03(api: Api, w: World, aReportId: string): Promise<void> {
  const auditor = token(w.a, 'auditor-a');
  const scope = { ...reportScope(w.a), from: iso(Date.now() - 52 * MIN) };
  for (const sub of ['stranger-a', 'revoked-a']) {
    check(isProblem(await api.post('/api/attesta/period-reports', token(w.a, sub), scope, { 'Idempotency-Key': 'it-03-refused' }), 403, 'ATTESTA_API_FORBIDDEN'), `${sub}: 403`);
  }
  const post = await api.post('/api/attesta/period-reports', auditor, scope, { 'Idempotency-Key': 'it-03-auditor', 'X-Request-ID': 'it-t15i4-03-req' });
  check(post.status === 202, `auditor POST: ${post.status}`);
  const again = await api.post('/api/attesta/period-reports', auditor, scope, { 'Idempotency-Key': 'it-03-auditor' });
  check(again.status === 202 && again.body.id === post.body.id && again.body.replayed === true, 'idempotent repeat: the same job');
  check(isProblem(await api.post('/api/attesta/period-reports', auditor, { ...scope, to: iso(Date.now() - 9 * MIN) }, { 'Idempotency-Key': 'it-03-auditor' }), 409, 'ATTESTA_API_CONFLICT'),
    'another scope: 409');
  const done = await waitReady(api, auditor, post.body.id, 'period-reports');
  check(done.status === 'ready', `auditor report: ${done.error_code}`);
  await api.get(done.document_path, auditor, { 'X-Request-ID': 'it-t15i4-03-dl' });
  const req = await audits(w.a.tenantId, 'attesta.report.request');
  const mine = req.filter((r: any) => r.target_id === post.body.id);
  check(mine.length === 2 && mine[0].actor_type === 'tenant_auditor' && mine[0].target_type === 'attesta_period_report'
    && mine[0].details.request_id === 'it-t15i4-03-req' && mine[1].details.replayed === true, 'request audit rows');
  const dls = await audits(w.a.tenantId, 'attesta.report.download');
  check(dls.some((d: any) => d.details.request_id === 'it-t15i4-03-dl' && d.details.report_digest === done.report_digest), 'download audit row');
  check(!JSON.stringify([...req, ...dls]).includes('statement_canonical'), 'audits carry no content');

  // 0022 guards on attesta_period_reports, as the API role.
  const refused = async (label: string, statement: string, values: unknown[] = [w.a.tenantId, aReportId]) => {
    const r = await pool.query(statement, values).then(() => 'accepted', (e: { code?: string }) => e.code ?? 'error');
    check(r !== 'accepted', `guard: ${label}`);
  };
  await refused('ready back to queued', `update attesta_period_reports set status = 'queued', report_document = null, report_digest = null, record_id = null, statement_digest = null, finished_at = null where tenant_id = $1 and id = $2`);
  await refused('scope changed', `update attesta_period_reports set scope = jsonb_set(scope, '{to}', '"2020-01-01T00:00:00.000Z"') where tenant_id = $1 and id = $2`);
  await refused('ready → failed', `update attesta_period_reports set status = 'failed', error_code = 'ATTESTA_API_INTERNAL' where tenant_id = $1 and id = $2`);
  await refused('delete', `delete from attesta_period_reports where tenant_id = $1 and id = $2`);
  await refused('truncate', `truncate attesta_period_reports`, []);
  await refused('insert running', `insert into attesta_period_reports (tenant_id, idempotency_key, repository_id, scope, requested_by, request_id, status, lease_until, attempts) values ($1, 'guard-key-1', $2, jsonb_build_object('repository_id', $2::text, 'from', 'x', 'to', 'y'), 'x', 'y', 'running', now(), 1)`, [w.a.tenantId, w.a.repos.r1.id]);
  await refused('scope names another repository', `insert into attesta_period_reports (tenant_id, idempotency_key, repository_id, scope, requested_by, request_id) values ($1, 'guard-key-2', $2, jsonb_build_object('repository_id', $3::text, 'from', 'x', 'to', 'y'), 'x', 'y')`, [w.a.tenantId, w.a.repos.r1.id, w.a.repos.r2.id]);
  // A running job made ready with a document that is not the record's, or with an ai-provenance record.
  const queued = await pool.query(`insert into attesta_period_reports (tenant_id, idempotency_key, repository_id, scope, requested_by, request_id)
    values ($1, 'guard-key-3', $2, $3::jsonb, 'x', 'y') returning id::text as id`, [w.a.tenantId, w.a.repos.r1.id, JSON.stringify(reportScope(w.a))]);
  const qid = queued.rows[0].id;
  await pool.query(`update attesta_period_reports set status = 'running', attempts = 1, lease_until = now() + interval '1 minute' where tenant_id = $1 and id = $2`, [w.a.tenantId, qid]);
  const real = (await pool.query(`select record_id::text as record_id, statement_digest, report_document, report_digest from attesta_period_reports where tenant_id = $1 and id = $2`, [w.a.tenantId, aReportId])).rows[0];
  const ai = (await pool.query(`select id::text as id, statement_digest from attesta_records where tenant_id = $1 and statement_kind is not null limit 1`, [w.a.tenantId])).rows[0];
  const ready = `update attesta_period_reports set status = 'ready', lease_until = null, report_document = $3, report_digest = $4, record_id = $5::uuid, statement_digest = $6, finished_at = now() where tenant_id = $1 and id = $2`;
  await refused('ready with a digest that is not the document\'s', ready, [w.a.tenantId, qid, real.report_document + ' ', real.report_digest, real.record_id, real.statement_digest]);
  await refused('ready naming an ai-provenance record', ready, [w.a.tenantId, qid, real.report_document, real.report_digest, ai.id, ai.statement_digest]);
  await refused('ready naming another scope\'s report', ready, [w.a.tenantId, qid, '{"x":1}', sha256Prefixed('{"x":1}'), real.record_id, real.statement_digest]);
  const rls = await pool.query(`select relrowsecurity from pg_class where relname = 'attesta_period_reports'`);
  check(rls.rows[0].relrowsecurity === true, 'RLS enabled');

  // The replaced chain guard: malformed period_report records, as the API role and as an RLS-bound role.
  const base = JSON.parse((await pool.query(`select r.statement_canonical from attesta_records r where r.tenant_id = $1 and r.id = $2::uuid`, [w.a.tenantId, real.record_id])).rows[0].statement_canonical);
  const sub = base.subject[0];
  const attacks: Array<[string, any, Parameters<typeof recordAttack>[3]]> = [
    ['a kind on a report', base, { statement_kind: 'commit_observed' }],
    ['a sha on a report', base, { subject_sha: 'a'.repeat(40) }],
    ['another repository than the scope', base, { repository_id: w.a.repos.r2.id }],
    ['a subject period other than the scope', { ...base, subject: [{ ...sub, name: sub.name.replace(/\.\..*$/, '..2020-01-01T00:00:00.000Z') }] }, {}],
    ['a git commit digest', { ...base, subject: [{ ...sub, digest: { gitCommit: 'a'.repeat(40) } }] }, {}],
    ['two digests', { ...base, subject: [{ ...sub, digest: { ...sub.digest, sha512: 'ab' } }] }, {}],
    ['a report typed as ai-provenance', base, { predicate_type: 'https://trackai.dev/attesta/ai-provenance/v1', statement_kind: 'commit_observed', subject_sha: 'a'.repeat(40) }],
    ['an unknown predicate type', { ...base, predicateType: 'https://example.com/x' }, { predicate_type: 'https://example.com/x' }],
  ];
  const client = await pool.connect();
  let refusedCount = 0;
  try {
    for (const role of ['api', 'rls'] as const) {
      await client.query('begin');
      if (role === 'rls') {
        await client.query(`create role it_t15i4_app nologin nosuperuser nobypassrls`);
        await client.query(`grant usage on schema public to it_t15i4_app`);
        await client.query(`grant select, insert, update, delete, truncate on chain_head, attesta_records, attesta_envelopes, attesta_subjects, attesta_anchor_batches, attesta_anchors, attesta_period_reports to it_t15i4_app`);
        for (const table of ['chain_head', 'attesta_records', 'attesta_envelopes', 'attesta_period_reports']) {
          await client.query(`create policy it_t15i4_tenant on ${table} for all to it_t15i4_app
            using (tenant_id = current_setting('it_t15i4.tenant')::uuid) with check (tenant_id = current_setting('it_t15i4.tenant')::uuid)`);
        }
        await client.query(`select set_config('it_t15i4.tenant', $1, true)`, [w.a.tenantId]);
        await client.query(`set local role it_t15i4_app`);
      }
      let n = 0;
      const q = async (text: string, values: unknown[]) => {
        await client.query(`savepoint attack_${n}`);
        try {
          return await client.query(text, values);
        } finally {
          await client.query(`rollback to savepoint attack_${n++}`);
        }
      };
      for (const [label, stmt, typed] of attacks) {
        const code = await recordAttack(q, w.a, stmt, typed);
        check(code === 'ATG01' || code === '23514', `${role} role: ${label} refused (got ${code})`);
        refusedCount += 1;
      }
      // Job guards under RLS too: delete and truncate.
      for (const [label, text, values] of [['delete', `delete from attesta_period_reports where tenant_id = $1 and id = $2`, [w.a.tenantId, aReportId]],
        ['truncate', `truncate attesta_period_reports`, []]] as const) {
        const r = await q(text, [...values]).then(() => 'accepted', (e: { code?: string }) => e.code ?? 'error');
        check(r !== 'accepted', `${role} role: job ${label} refused`);
      }
      await client.query('rollback');
    }
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
  const v = await api.get('/api/attesta/verify', token(w.a, 'admin-a'));
  check(v.status === 200 && v.body.chain_intact, 'tenant A chain intact after the attacks');

  // The open-job cap counts aged queued jobs too (cross-review finding): fill it with jobs
  // queued 11 minutes ago, then a new key is 429 and creates nothing.
  const openNow = Number((await pool.query(`select count(*)::int as n from attesta_period_reports where tenant_id = $1
    and (status = 'queued' or (status = 'running' and lease_until > now()))`, [w.a.tenantId])).rows[0].n);
  for (let i = openNow; i < 4; i++) {
    await pool.query(`insert into attesta_period_reports (tenant_id, idempotency_key, repository_id, scope, requested_by, request_id, created_at)
      values ($1, $2, $3, $4::jsonb, 'it-operator', 'it-aged', now() - interval '11 minutes')`,
    [w.a.tenantId, `it-03-aged-${i}`, w.a.repos.r1.id, JSON.stringify(reportScope(w.a))]);
  }
  const before = Number((await pool.query(`select count(*)::int as n from attesta_period_reports where tenant_id = $1`, [w.a.tenantId])).rows[0].n);
  const capped = await api.post('/api/attesta/period-reports', token(w.a, 'admin-a'), reportScope(w.a), { 'Idempotency-Key': 'it-03-over-cap' });
  check(isProblem(capped, 429, 'ATTESTA_API_RATE_LIMITED'), `a fifth open job is 429 even when the others are aged: ${capped.status}`);
  const after = Number((await pool.query(`select count(*)::int as n from attesta_period_reports where tenant_id = $1`, [w.a.tenantId])).rows[0].n);
  check(after === before, 'the refused request created no job');
  console.log(`guards_period_reports=10_refused chain_guard_attacks=${refusedCount}_refused open_cap_aged=429`);
  console.log('IT-T15i4-03=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15i4-'));
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
    const app = express();
    app.use(express.json());
    app.use('/api', authenticateJWT, tenantMiddleware);
    app.use('/api/attesta', createAttestaRouter());
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const api = client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const aReport = await it01(api, w);
    await it02(api, w, aReport);
    await it03(api, w, aReport);
    const n = await pool.query(`select status, count(*)::int as n from attesta_period_reports group by status order by status`);
    console.log(`reports=${n.rows.map((r: { status: string; n: number }) => `${r.status}:${r.n}`).join(',')}`);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15i4 failed');
  process.exitCode = 1;
});
