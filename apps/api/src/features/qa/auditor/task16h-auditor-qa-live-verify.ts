/**
 * IT-T16h-01: the auditor's verifiable and signed answers (Task16h, A16.13a + A16.13b)
 * against real PostgreSQL, through the real JWT and tenant middleware (a local JWKS
 * stands in for Supabase), the real requireAdminAction('qa.read') guard and the real
 * createApp() mount. Every statement, seal and report is signed by Attesta's own
 * pipelines (the attesta:keys CLI's trust inventory, the builder pass, the security and
 * audit seal passes, the period and security report builders); nothing is hand-signed.
 * The world setup is IT-T15i4's, IT-T15op's and IT-T16e's, reused as is.
 *
 *   scripts/it-db.sh npm run verify:task16h-auditor-qa-live -w apps/api
 *
 * (a) Q1 and Q3 verifiable at repository scope equal the period report computation, with
 *     matching evidence roots;
 * (b) Q3 signed, after a period report for exactly that scope, names its statement digest
 *     and has the verifiable answer's figures; another scope gives report_not_built;
 * (c) S7 verifiable over a sealed period matches the signed security report's figures;
 *     a period crossing the unsealed tail is partial with not_sealed_yet;
 * (d) a finding row deleted as the database owner (guard trigger off) makes S1
 *     evidence_broken;
 * (e) S15 counts the sealed security_findings.read events;
 * (f) Company B gets 404 for A's repository and none of A's evidence;
 * (g) kind=live as an auditor is 403.
 *
 * Throwaway database only (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh).
 * Safe summary lines only.
 */
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import type express from 'express';
import jwt from 'jsonwebtoken';
import { recordAuditEvent } from '../../../core/audit/record';
import { db, pool } from '../../../core/db';
import { ingestMetricsBatch } from '../../telemetry/service';
import type { GitAiMetricEvent } from '../../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from '../../attesta/anchor-contract';
import { main as keysMain } from '../../attesta/attesta-keys-cli';
import { main as rootMain } from '../../attesta/attesta-trust-root-cli';
import { pgSealStore, runAuditSealPass, type SealDatabase } from '../../attesta/audit-seal-service';
import { chainStatement } from '../../attesta/ledger';
import { computeReportDocument, digestsRoot, type ReportInput } from '../../attesta/period-report-rules';
import { pgReportStore, runPeriodReport, type ReportDatabase } from '../../attesta/period-report-service';
import { pgSecuritySealStore, runSecuritySealPass } from '../../attesta/security-seal-service';
import { buildSecurityReport, pgSecurityReportStore, type SecurityReportResult } from '../../attesta/security-report-service';
import { keyidOf } from '../../attesta/trust-documents';
import { pgTrustStore, type TrustDb } from '../../attesta/trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from '../../attesta/trust-resolver';
import { runBuilderPass, type BuilderPassOptions } from '../../attesta/worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T16h-01 failed: ${message}`);
}

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);

// ---------------------------------------------------------------------------
// The world: two tenants, the trust inventory by CLI (IT-T15op / IT-T16e), JWKS

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; domain: string; codeRepoUrl: string; codeRepoId: string; machineId: string }

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t16h-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  const machine = await pool.query(`insert into developer_machines (tenant_id, installation_id, display_name) values ($1, $2, 'it machine') returning id::text as id`,
    [tenantId, randomUUID()]);
  return { label, tenantId, domain, codeRepoUrl: `https://github.com/${slug}/one`, codeRepoId: '', machineId: machine.rows[0].id };
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t16h';
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
async function grant(t: Tenant, subject: string, role: 'tenant_admin' | 'tenant_auditor'): Promise<void> {
  await pool.query(`insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by)
    values ($1, $2, $3, $4, 'active', 'it-t16h')`, [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

async function makeWorld(dir: string) {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const creds = [['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:b1', b.tenantId, k.b1]] as const;
  Object.assign(process.env, {
    ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid,
    ATTESTA_DEV_CREDENTIALS_FILE: file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
      ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) })))),
    TRACKAI_GIT_COMMIT: '0123456789abcdef',
  });
  const env = process.env;
  const out: string[] = [];
  const err: string[] = [];
  // Set up two hours back: the statements below are stamped up to an hour in the past.
  const io = { readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
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
  for (const [t, cred, key] of [[a, 'dev:a1', k.a1], [b, 'dev:b1', k.b1]] as const) {
    await apply('register', '--adapter', 'local-dev', '--credential', cred, '--tenant', t.tenantId);
    await apply('activate', '--tenant', t.tenantId, '--keyid', key.keyid);
    await apply('publish', '--tenant', t.tenantId);
  }
  const resolver = inventorySignerResolver(pgTrustStore(db as unknown as TrustDb), await adaptersFromEnv(env), trustConfigFromEnv(env));
  return { a, b, resolver };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

// ---------------------------------------------------------------------------
// Code statements and the period report (IT-T15i4)

function commitEvent(t: Tenant, commitSha: string): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  const note = [`src/${t.label}/alpha.ts`, '  s_it::t_1 1-6', '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${t.label}`, model: 'model-x' } } } })].join('\n');
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 6, '3': ['opencode:model-x'], '5': [6], '11': 'IT synthetic commit', '13': note, '15': now - 60, '16': now - 30 },
    a: { '1': t.codeRepoUrl, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${t.label}` },
  };
}

/** One commit statement, stamped `ageMin` minutes ago through the ledger's clock seam. */
async function statement(w: World, t: Tenant, ageMin: number): Promise<void> {
  const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, sha())] });
  check(errors.length === 0, `${t.label}: ingestion`);
  const stamp = new Date(Date.now() - ageMin * MIN);
  const options: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef',
    deps: { chain: (tx, input) => chainStatement(tx, input, () => stamp) } };
  const pass = await runBuilderPass(db, w.resolver, options);
  check(pass.failed === 0 && pass.retried === 0 && pass.done === 1, `builder pass: ${JSON.stringify(pass.codes)}`);
  if (!t.codeRepoId) {
    const r = await pool.query(`select id::text as id from scm_repositories where tenant_id = $1 and url = $2`, [t.tenantId, t.codeRepoUrl]);
    check(r.rows.length === 1, `${t.label}: one repository row`);
    t.codeRepoId = r.rows[0].id;
  }
}

async function inputsOf(t: Tenant, scope: { repository_id: string; from: string; to: string }): Promise<ReportInput[]> {
  const r = await pool.query(`select seq::text as seq, statement_digest, statement_canonical from attesta_records
    where tenant_id = $1 and repository_id = $2 and predicate_type = 'https://trackai.dev/attesta/ai-provenance/v1'
      and recorded_at >= $3 and recorded_at <= $4 order by seq`, [t.tenantId, scope.repository_id, scope.from, scope.to]);
  return r.rows.map((x: { seq: string; statement_digest: string; statement_canonical: string }) =>
    ({ seq: Number(x.seq), digest: x.statement_digest, canonical: x.statement_canonical }));
}

/** One period report job run directly, recorded `ageMin` minutes ago (IT-T15i4's directReport). */
async function periodReport(w: World, t: Tenant, scope: { repository_id: string; from: string; to: string }, ageMin: number): Promise<string> {
  const store = pgReportStore(db as unknown as ReportDatabase, { clock: () => new Date(Date.now() - ageMin * MIN) });
  const key = `it-t16h-${randomUUID().slice(0, 8)}`;
  const { job } = await store.createOrGet({ tenantId: t.tenantId, idempotencyKey: key, request: { scope: { ...scope, basis: 'recorded_at' } },
    requestedBy: 'it-operator', requestId: `req-${key}` });
  const result = await runPeriodReport({ store, resolver: async () => w.resolver, builderVersion: () => '0.1.0+0123456789abcdef', log: () => undefined },
    t.tenantId, job.id);
  check(result === 'ready', `period report: ${result}`);
  const row = await pool.query(`select statement_digest from attesta_period_reports where tenant_id = $1 and id = $2`, [t.tenantId, job.id]);
  return row.rows[0].statement_digest as string;
}

// ---------------------------------------------------------------------------
// Security rows, seals and the security report (IT-T15op / IT-T15op-b)

async function task6aRow(t: Tenant, minsAgo: number, us: number, severity: 'high' | 'critical'): Promise<string> {
  const r = await pool.query(`insert into security_findings (tenant_id, machine_id, repository_id, finding_id, delivery_id, session_id,
       source_event_id, rule_id, rule_version, rule_category, rule_severity, route_id, agent_family, host_surface, host_mode,
       capture_channel, operating_system, timing, native_effect, activation, effect, phase, availability, completeness,
       result_category, occurred_at, client_version, rule_pack_version, received_at)
     values ($1, $2, $8::uuid, $3, $4, 'it-session', 'event-001', 'trackai.exec.download_pipe_shell', '1.4', 'execution', $7,
       'AC-CLI-03', 'opencode', 'terminal', 'cli', 'provider-plugin', 'macos', 'pre_action', 'observe_only', 'observed',
       'monitor', 'requested', 'available', 'complete', 'not_observed', now() - make_interval(mins => $5 + 1), '0.1.0-test',
       '0.1.0-test', now() - make_interval(mins => $5) + make_interval(secs => $6::double precision / 1000000))
     returning id::text as id`, [t.tenantId, t.machineId, randomUUID(), randomUUID(), minsAgo, us, severity, t.codeRepoId]);
  return r.rows[0].id;
}

async function securitySeal(w: World, t: Tenant): Promise<void> {
  const r = await runSecuritySealPass({ store: pgSecuritySealStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'system_operator', id: 'it-t16h-operator' }, log: () => undefined },
  { tenantIds: [t.tenantId], now: true });
  check(r.length >= 1 && r[0].outcome === 'sealed', `security seal: ${JSON.stringify(r.map((x) => x.outcome + (x.code ? `:${x.code}` : '')))}`);
}

async function securityReport(w: World, t: Tenant, from: string, to: string): Promise<SecurityReportResult> {
  return buildSecurityReport({ store: pgSecurityReportStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'system_operator', id: 'attesta:security-report:it-operator' }, log: () => undefined },
  { tenant_id: t.tenantId, repository_id: null, from, to, basis: 'received_at' });
}

async function asOwner(table: string, trigger: string, fn: () => Promise<void>): Promise<void> {
  await pool.query(`alter table ${table} disable trigger ${trigger}`);
  try {
    await fn();
  } finally {
    await pool.query(`alter table ${table} enable trigger ${trigger}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP

interface Res { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function get(base: string, path: string, bearer: string): Promise<Res> {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  check(res.headers.get('cache-control') === 'no-store', `GET ${path}: no-store (${res.status})`);
  return { status: res.status, body };
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const fig = (body: any, key: string): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = body?.figures?.find((x: any) => x?.key === key); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(f, `figure ${key} is present`);
  return f;
};

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t16h-'));
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    const w = await makeWorld(dir);
    const { a, b } = w;
    const { createApp } = await import('../../../app');
    const app = await listen(createApp());
    servers.push(app.server);
    await grant(a, 'auditor-a', 'tenant_auditor');
    await grant(b, 'auditor-b', 'tenant_auditor');
    const auditorA = token(a, 'auditor-a');
    const auditorB = token(b, 'auditor-b');
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../docs/contracts/qa/answer-v1.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false }).compile(schema);
    const answer = (id: string, params: Record<string, string>) => `/api/qa/questions/${id}/answer?${new URLSearchParams(params).toString()}`;
    const ok = (r: Res, what: string) => {
      check(r.status === 200, `${what}: 200 (got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)})`);
      check(validate(r.body) as boolean, `${what}: schema-valid`);
      for (const f of r.body.figures) {
        if (f.availability === 'unavailable') check(f.value === null && f.evidence === undefined, `${what}/${f.key}: unavailable is null`);
        else check(f.evidence && f.evidence.statements_root === digestsRoot(f.evidence.records.map((x: { digest: string }) => x.digest)),
          `${what}/${f.key}: evidence recomputes`);
      }
      return r.body;
    };

    // (a) Code statements at −50, −30, −10 min; Q1 and Q3 verifiable equal the report computation.
    for (const age of [50, 30, 10]) await statement(w, a, age);
    await statement(w, b, 20);
    const scope = { repository_id: a.codeRepoId, from: iso(Date.now() - 55 * MIN), to: iso(Date.now() - 8 * MIN) };
    const doc = computeReportDocument({ tenantId: a.tenantId, scope: { ...scope, basis: 'recorded_at' }, inputs: await inputsOf(a, scope) });
    check(doc.statements.length === 3, `three statements in the window (${doc.statements.length})`);
    const q1 = ok(await get(app.base, answer('Q1', { kind: 'verifiable', ...scope }), auditorA), '(a) Q1 verifiable');
    check(fig(q1, 'ai_lines_changed').value?.count === (doc.figures.lines_changed.value as { ai: number }).ai, '(a) Q1 ai lines = the report computation');
    check(fig(q1, 'ai_lines_changed').evidence.statements_root === doc.figures.lines_changed.statements_root, '(a) Q1 evidence root = the report figure root');
    const q3v = ok(await get(app.base, answer('Q3', { kind: 'verifiable', ...scope }), auditorA), '(a) Q3 verifiable');
    for (const [key, name] of [['prs_merged', 'prs_merged'], ['merged_ai_lines', 'merged_ai_lines']] as const) {
      const f = fig(q3v, key);
      const expected = doc.figures[name].availability;
      check(f.availability === expected, `(a) Q3 ${key} availability ${f.availability} = ${expected}`);
      if (f.availability !== 'unavailable') check(f.evidence.statements_root === doc.figures[name].statements_root, `(a) Q3 ${key} root`);
      if (f.availability !== 'unavailable') check(f.value?.count === doc.figures[name].value, `(a) Q3 ${key} value`);
    }
    console.log(`IT-T16h-01a ok: Q1 ai_lines=${fig(q1, 'ai_lines_changed').value?.count} and Q3 equal the period report computation, evidence roots match`);

    // (b) Q3 signed after a report for exactly that scope; another scope is report_not_built.
    const notYet = ok(await get(app.base, answer('Q3', { kind: 'signed', ...scope }), auditorA), '(b) Q3 signed before the report');
    check(notYet.reasons.some((r: { code: string }) => r.code === 'report_not_built'), '(b) no report yet: report_not_built');
    const digest = await periodReport(w, a, scope, 7);
    const q3s = ok(await get(app.base, answer('Q3', { kind: 'signed', ...scope }), auditorA), '(b) Q3 signed');
    check(q3s.signed?.statement_digest === digest && q3s.signed?.predicate_type === 'https://trackai.dev/attesta/period-report/v1', '(b) names the report statement');
    check(JSON.stringify(q3s.figures) === JSON.stringify(q3v.figures), '(b) the signed figures are the verifiable figures');
    const other = ok(await get(app.base, answer('Q3', { kind: 'signed', ...scope, from: iso(Date.parse(scope.from) + 1) }), auditorA), '(b) another scope');
    check(other.availability === 'unavailable' && other.reasons.some((r: { code: string }) => r.code === 'report_not_built') && !other.signed,
      '(b) another scope: report_not_built');
    console.log('IT-T16h-01b ok: Q3 signed names the report statement; another scope is report_not_built');

    // (c) Security: three Task6.a rows, sealed now; S7 verifiable = the security report; the unsealed tail is partial.
    const rowIds = [await task6aRow(a, 40, 1, 'high'), await task6aRow(a, 35, 2, 'critical'), await task6aRow(a, 30, 3, 'high')];
    await task6aRow(b, 30, 4, 'high');
    await securitySeal(w, a);
    await securitySeal(w, b);
    const sFrom = iso(Date.now() - 60 * MIN);
    const sTo = iso(Date.now() - 15 * MIN);
    const report = await securityReport(w, a, sFrom, sTo);
    check(report.outcome === 'built', `(c) the security report: ${report.outcome} ${report.code ?? ''}`);
    const stored = (await pool.query(`select report_document from attesta_security_period_reports where tenant_id = $1 and statement_digest = $2`,
      [a.tenantId, report.statementDigest])).rows[0].report_document as string;
    const sdoc = JSON.parse(stored);
    const s7v = ok(await get(app.base, answer('S7', { kind: 'verifiable', from: sFrom, to: sTo }), auditorA), '(c) S7 verifiable');
    check(fig(s7v, 'findings').value?.count === sdoc.figures.findings.value && sdoc.figures.findings.value === 3, '(c) S7 findings = the report = 3');
    const sealSeqs = (sdoc.seals as Array<{ seq: number }>).map((s) => s.seq);
    check(JSON.stringify(fig(s7v, 'findings').evidence.records.map((r: { seq: number }) => r.seq)) === JSON.stringify(sealSeqs), '(c) evidence = the covering seals');
    const s7s = ok(await get(app.base, answer('S7', { kind: 'signed', from: sFrom, to: sTo }), auditorA), '(c) S7 signed');
    check(s7s.signed?.statement_digest === report.statementDigest && fig(s7s, 'findings').value?.count === 3, '(c) S7 signed names the security report');
    const tail = ok(await get(app.base, answer('S7', { kind: 'verifiable', from: sFrom, to: iso(Date.now() + 60 * MIN) }), auditorA), '(c) S7 over the unsealed tail');
    check(tail.availability === 'partial' && fig(tail, 'findings').reasons.some((r: { code: string }) => r.code === 'not_sealed_yet'), '(c) the tail: partial, not_sealed_yet');
    console.log('IT-T16h-01c ok: S7 verifiable = the security report (3), signed names it, the unsealed tail is partial');

    // (e) S15: two security_findings.read events, sealed; the answer counts them.
    // Written through the one emitter, then back-dated as the database owner so the
    // seal pass finds them settled (IT-T16e's backdatedRows).
    const reads: string[] = [];
    for (let i = 0; i < 2; i++) {
      await recordAuditEvent(db, a.tenantId, {
        action: 'security_findings.read', actorType: 'tenant_auditor', actorId: 'auditor-a',
        targetType: 'security_findings', targetId: a.tenantId, details: { limit: 50, returned: 3 },
      });
      reads.push((await pool.query(`select id::text as id from security_audit_events where tenant_id = $1 and action = 'security_findings.read'
        order by occurred_at desc, id desc limit 1`, [a.tenantId])).rows[0].id);
    }
    await asOwner('security_audit_events', 'security_audit_events_immutable', async () => {
      for (const [i, id] of reads.entries()) {
        await pool.query(`update security_audit_events set occurred_at = now() - make_interval(mins => 25) + make_interval(secs => $2::double precision / 1000000)
          where id = $1`, [id, i * 1000 + 7]);
      }
    });
    const audit = await runAuditSealPass({ store: pgSealStore(db as unknown as SealDatabase), resolver: w.resolver,
      builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'service', id: 'it-t16h-worker' }, log: () => undefined }, { tenantIds: [a.tenantId] });
    check(audit[0]?.outcome === 'sealed', `(e) audit seal: ${audit[0]?.outcome} ${audit[0]?.code ?? ''}`);
    const sealTo = (await pool.query(`select max(window_to)::text as t from attesta_audit_seals where tenant_id = $1`, [a.tenantId])).rows[0].t as string;
    const s15 = ok(await get(app.base, answer('S15', { kind: 'verifiable', from: sFrom, to: iso(Date.parse(sealTo) - 1) }), auditorA), '(e) S15 verifiable');
    check(fig(s15, 'security_findings_reads').value?.count === 2, `(e) S15 counts two sealed reads (${fig(s15, 'security_findings_reads').value?.count})`);
    console.log('IT-T16h-01e ok: S15 counts the two sealed security_findings.read events');

    // (d) A sealed finding row deleted by the database owner: S1 is evidence_broken.
    await asOwner('security_findings', 'security_findings_immutable', async () => {
      await pool.query(`delete from security_findings where tenant_id = $1 and id = $2`, [a.tenantId, rowIds[0]]);
    });
    const s1 = ok(await get(app.base, answer('S1', { kind: 'verifiable', from: sFrom, to: sTo }), auditorA), '(d) S1 after the delete');
    check(s1.availability === 'unavailable' && JSON.stringify(s1.reasons) === '[{"code":"evidence_broken"}]', `(d) S1 evidence_broken (${JSON.stringify(s1.reasons)})`);
    console.log('IT-T16h-01d ok: a deleted sealed row makes S1 evidence_broken');

    // (f) Company B: 404 for A's repository; its own answers carry none of A's evidence.
    const bRepo = await get(app.base, answer('Q3', { kind: 'verifiable', ...scope }), auditorB);
    check(bRepo.status === 404, `(f) B on A's repository: 404 (got ${bRepo.status})`);
    const bS7 = ok(await get(app.base, answer('S7', { kind: 'verifiable', from: sFrom, to: sTo }), auditorB), '(f) B S7');
    check(fig(bS7, 'findings').value?.count === 1, '(f) B counts its own one finding');
    const aDigests = [...sdoc.seals.map((s: { statement_digest: string }) => s.statement_digest), ...doc.statements.map((s) => s.digest)];
    for (const body of [bS7, ok(await get(app.base, answer('Q16', { kind: 'verifiable', from: scope.from, to: scope.to }), auditorB), '(f) B Q16')]) {
      check(!aDigests.some((d) => JSON.stringify(body).includes(d)), '(f) none of A\'s statement or seal digests');
    }
    console.log('IT-T16h-01f ok: Company B gets 404 for A\'s repository and none of A\'s evidence');

    // (g) kind=live as an auditor.
    const live = await get(app.base, answer('Q3', { kind: 'live', ...scope }), auditorA);
    check(live.status === 403, `(g) auditor live: 403 (got ${live.status})`);
    console.log('IT-T16h-01g ok: an auditor asking for kind=live gets 403');
    console.log('IT-T16h-01 passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T16h-01 failed');
  process.exitCode = 1;
});
