/**
 * IT-T15op-01: security-finding seals (Task15op-a, A15.15, gap G6) against real PostgreSQL
 * (migration 0027), through the real route behind the real JWT and tenant middleware, with the
 * trust inventory set up by the attesta:keys CLI and seals signed through inventorySignerResolver
 * (IT-T16e's setup). Anchoring is not configured here (Attesta's own path, IT-T15f2/T15i2).
 *
 *   scripts/it-db.sh npm run verify:t15op-security-live -w apps/api
 *
 * Company A: Task6.a and v2 rows (enrolled and not_enrolled) are sealed in a first seal, a
 * second pass is not due, a day later an empty contiguous seal; the verify report is ok and
 * /api/attesta/verify is ok over the seal records. Then, as the table owner with the guard
 * trigger off, one row deleted and one changed, and one row inserted late into the sealed
 * window: the report lists exactly those three breaks. TRUNCATE of the findings and of the
 * seals, UPDATE and DELETE of a seal, and a second first seal are refused.
 * Company B: 8 003 rows are sealed in two back-to-back chunks (8 000 + 3); B's report is ok and
 * never names A's seals or rows; a B seal row pointing at A's record is refused; A's report
 * never names B's.
 *
 * Prints only safe summary lines.
 */
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, pool } from '../../core/db';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { main as keysMain } from './attesta-keys-cli';
import { main as rootMain } from './attesta-trust-root-cli';
import { createAttestaRouter } from './attesta.routes';
import type { SealDatabase } from './audit-seal-service';
import { canonicalize, sha256Prefixed } from './canonical';
import { MAX_SECURITY_SEAL_ROWS, pgSecuritySealStore, runSecuritySealPass } from './security-seal-service';
import { keyidOf } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15op failed: ${message}`);
}

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; domain: string; repositoryId: string; machineId: string }
async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15op-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, `${slug}.example`, slug]);
  const repositoryId = randomUUID();
  await pool.query(`insert into scm_repositories (id, tenant_id, provider, external_id, name, url) values ($1, $2, 'github', $3, $4, $5)`,
    [repositoryId, tenantId, `${slug}-repo`, `repo-${label}`, `https://github.com/example/${slug}`]);
  const machine = await pool.query(`insert into developer_machines (tenant_id, installation_id, display_name) values ($1, $2, 'it machine') returning id::text as id`,
    [tenantId, randomUUID()]);
  return { label, tenantId, domain: `${slug}.example`, repositoryId, machineId: machine.rows[0].id };
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t15op';
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
    values ($1, $2, $3, $4, 'active', 'it-t15op')`, [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

interface Res { status: number; body: any; text: string } // eslint-disable-line @typescript-eslint/no-explicit-any
function client(base: string) {
  return async (path: string, bearer: string): Promise<Res> => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${bearer}` } });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    check(res.headers.get('cache-control') === 'no-store', `GET ${path}: no-store (${res.status})`);
    return { status: res.status, body: parsed, text };
  };
}
type Api = ReturnType<typeof client>;

/** IT-T16e's trust inventory by CLI, without anchoring. */
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
  const io = { readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, now: () => new Date(Date.now() - 2 * 24 * 60 * MIN) };
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

/** One Task6.a row received `minsAgo` minutes ago (+ `us` microseconds); returns its id. */
async function task6aRow(t: Tenant, minsAgo: number, us: number): Promise<string> {
  const r = await pool.query(`insert into security_findings (tenant_id, machine_id, repository_id, finding_id, delivery_id, session_id,
       source_event_id, rule_id, rule_version, rule_category, rule_severity, route_id, agent_family, host_surface, host_mode,
       capture_channel, operating_system, timing, native_effect, activation, effect, phase, availability, completeness,
       result_category, occurred_at, client_version, rule_pack_version, received_at)
     values ($1, $2, $3, $4, $5, 'it-session', 'event-001', 'trackai.exec.download_pipe_shell', '1.4', 'execution', 'high',
       'AC-CLI-03', 'opencode', 'terminal', 'cli', 'provider-plugin', 'macos', 'pre_action', 'observe_only', 'observed',
       'monitor', 'requested', 'available', 'complete', 'not_observed', now() - make_interval(mins => $6 + 1), '0.1.0-test',
       '0.1.0-test', now() - make_interval(mins => $6) + make_interval(secs => $7::double precision / 1000000))
     returning id::text as id`, [t.tenantId, t.machineId, t.repositoryId, randomUUID(), randomUUID(), minsAgo, us]);
  return r.rows[0].id;
}

/** `n` v2 rows from `minsAgo` minutes ago, one microsecond apart; `enrolled` names the tenant's repository. */
async function v2Rows(t: Tenant, n: number, minsAgo: number, enrolled = false): Promise<string[]> {
  const digest = 'b'.repeat(64);
  const r = await pool.query(`insert into security_findings (tenant_id, machine_id, record_generation, record_id, rule_id, rule_version,
       rule_category, rule_severity, title, source_agent, source_type, confidence, detected_at, occurred_at, numbat_schema_version,
       bundle_digest, lease_id, found_at_rest, repository_kind, repository_id, rule_pack_version, effect, model, session_id, received_at)
     select $1, $2, 'v2', 'sha256:' || encode(sha256(convert_to($3 || ':' || g::text, 'UTF8')), 'hex'), 'secrets.aws_key', '1.0.0',
       'secrets', 'critical', 'synthetic title', 'claude-code', 'hook', 'high', now() - make_interval(mins => $4 + 1),
       now() - make_interval(mins => $4 + 1), '0.5.0', $5, 'lease-it', false, $6, $7::uuid, 'bundle:' || substr($5, 1, 16), 'monitor',
       'model-it', 'session-it', now() - make_interval(mins => $4) + make_interval(secs => g::double precision / 1000000)
     from generate_series(1, $8::int) as g
     returning id::text as id`,
  [t.tenantId, t.machineId, randomUUID(), minsAgo, digest, enrolled ? 'enrolled' : 'not_enrolled', enrolled ? t.repositoryId : null, n]);
  return r.rows.map((x: { id: string }) => x.id);
}

/** Runs `fn` with the findings' guard trigger off (only the throwaway database's owner can). */
async function asOwner(fn: () => Promise<void>): Promise<void> {
  await pool.query(`alter table security_findings disable trigger security_findings_immutable`);
  try {
    await fn();
  } finally {
    await pool.query(`alter table security_findings enable trigger security_findings_immutable`);
  }
}

async function ageSeals(t: Tenant, hours: number): Promise<void> {
  await pool.query(`alter table attesta_security_finding_seals disable trigger attesta_security_finding_seals_append_only`);
  try {
    await pool.query(`update attesta_security_finding_seals set created_at = created_at - make_interval(hours => $2) where tenant_id = $1`, [t.tenantId, hours]);
  } finally {
    await pool.query(`alter table attesta_security_finding_seals enable trigger attesta_security_finding_seals_append_only`);
  }
}

async function seal(w: World, t: Tenant, now = false): Promise<string[]> {
  const r = await runSecuritySealPass({ store: pgSecuritySealStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'system_operator', id: 'it-t15op-operator' }, log: () => undefined },
  { tenantIds: [t.tenantId], now });
  return r.map((x) => x.outcome + (x.code ? `:${x.code}` : ''));
}

async function refused(sqlText: string, params: unknown[], label: string): Promise<void> {
  try {
    await pool.query(sqlText, params);
  } catch {
    return;
  }
  throw new Error(`IT-T15op failed: ${label} was not refused`);
}

const verifyPath = () => `/api/attesta/security-seals/verify?from=${encodeURIComponent(iso(Date.now() - 6 * 60 * MIN))}&to=${encodeURIComponent(iso(Date.now()))}`;

async function companyA(api: Api, w: World): Promise<{ sealDigests: string[]; rowIds: string[] }> {
  const t = w.a;
  const ids = [await task6aRow(t, 180, 1), await task6aRow(t, 175, 2), ...await v2Rows(t, 2, 170), ...await v2Rows(t, 1, 165, true)];
  check(JSON.stringify(await seal(w, t)) === '["sealed"]', 'A: the first seal covers both generations');
  check(JSON.stringify(await seal(w, t)) === '["not_due"]', 'A: a second pass right away is not due');
  await ageSeals(t, 25);
  check(JSON.stringify(await seal(w, t)) === '["sealed"]', 'A: a day later an empty window is sealed');
  const seals = (await pool.query(`select window_from, window_to, row_count, task6a_count, v2_count, previous_digest, seal_digest
    from attesta_security_finding_seals where tenant_id = $1 order by window_from`, [t.tenantId])).rows;
  check(seals.length === 2 && seals[0].row_count === 5 && seals[0].task6a_count === 2 && seals[0].v2_count === 3
    && seals[0].previous_digest === null, 'A: first seal holds 2 Task6.a + 3 v2 rows, no previous');
  check(seals[1].row_count === 0 && seals[1].previous_digest === seals[0].seal_digest && seals[1].window_from === seals[0].window_to,
    'A: the empty seal is contiguous and linked');
  const doc = (await pool.query(`select seal_document from attesta_security_finding_seals where tenant_id = $1 order by window_from limit 1`, [t.tenantId])).rows[0].seal_document as string;
  check(!/synthetic title|session-it|model-it|it-session/.test(doc), 'A: the seal document carries no title, session or model');
  const sealedAudits = (await pool.query(`select count(*)::int as n from security_audit_events where tenant_id = $1
    and action = 'audit.trail.security_findings_sealed'`, [t.tenantId])).rows[0].n;
  check(sealedAudits === 2, 'A: each seal writes audit.trail.security_findings_sealed');

  const auditor = token(t, `auditor-${t.label}`);
  const clean = await api(verifyPath(), auditor);
  check(clean.status === 200 && clean.body.ok === true && clean.body.seals_checked === 2 && clean.body.breaks.length === 0,
    `A: a clean register verifies: ${clean.text.slice(0, 300)}`);
  check(clean.body.chain.checked === 2, 'A: both seal records checked');
  const chain = await api('/api/attesta/verify', auditor);
  check(chain.status === 200 && chain.body.ok === true && chain.body.signatures === 'checked', `A: /api/attesta/verify over the seal records: ${chain.text.slice(0, 300)}`);

  // Tamper as the owner: delete one row, change another; then insert one late into the sealed window.
  await asOwner(async () => {
    await pool.query(`delete from security_findings where id = $1`, [ids[0]]);
    await pool.query(`update security_findings set rule_severity = 'low' where id = $1`, [ids[2]]);
  });
  const [late] = await v2Rows(t, 1, 172);
  const tampered = await api(verifyPath(), auditor);
  const kinds = (tampered.body.breaks as Array<{ kind: string; row_id?: string }>).map((b) => `${b.kind}:${b.row_id}`).sort();
  check(tampered.status === 200 && tampered.body.ok === false, 'A: a tampered register does not verify');
  check(JSON.stringify(kinds) === JSON.stringify([`changed_row:${ids[2]}`, `missing_row:${ids[0]}`, `unsealed_row_in_sealed_window:${late}`].sort()),
    `A: exactly the three breaks: ${JSON.stringify(kinds)}`);
  const verified = (await pool.query(`select details from security_audit_events where tenant_id = $1
    and action = 'audit.trail.security_findings_verified' order by occurred_at`, [t.tenantId])).rows;
  check(verified.length === 2 && verified[1].details.ok === false && verified[1].details.break_count === 3,
    'A: each report writes audit.trail.security_findings_verified');

  await refused(`truncate security_findings cascade`, [], 'TRUNCATE of the findings');
  await refused(`truncate attesta_security_finding_seals cascade`, [], 'TRUNCATE of the seals');
  await refused(`update attesta_security_finding_seals set row_count = row_count where tenant_id = $1`, [t.tenantId], 'UPDATE of a seal');
  await refused(`delete from attesta_security_finding_seals where tenant_id = $1`, [t.tenantId], 'DELETE of a seal');
  await refused(`truncate attesta_security_period_reports cascade`, [], 'TRUNCATE of the security reports');
  const empty = sha256Prefixed(Buffer.alloc(0));
  const second = canonicalize({ format: 'https://trackai.dev/attesta/security-findings-seal-document/v1', tenant_id: t.tenantId,
    window: { from: seals[0].window_from, to: seals[0].window_to }, previous: null, count: 0, generations: { task6a: 0, v2: 0 },
    rows: [], rows_root: empty });
  await refused(`insert into attesta_security_finding_seals (tenant_id, window_from, window_to, row_count, task6a_count, v2_count,
    previous_digest, seal_document, seal_digest, record_id, statement_digest)
    select $1, $2, $3, 0, 0, 0, null, $4, $5, r.id, r.statement_digest from attesta_records r where r.tenant_id = $1 limit 1`,
  [t.tenantId, seals[0].window_from, seals[0].window_to, second, sha256Prefixed(second)], 'a second first seal');
  console.log('a_seals=2 a_generations=task6a:2,v2:3 clean_report=ok tampered_breaks=3 truncate=refused seal_update_delete=refused');
  return { sealDigests: seals.map((s) => s.seal_digest as string), rowIds: [...ids, late] };
}

async function companyB(api: Api, w: World, a: { sealDigests: string[]; rowIds: string[] }): Promise<void> {
  const t = w.b;
  await v2Rows(t, MAX_SECURITY_SEAL_ROWS + 3, 120);
  const outcomes = await seal(w, t);
  check(JSON.stringify(outcomes) === '["sealed","sealed"]', `B: a backlog over one seal is sealed in two chunks: ${JSON.stringify(outcomes)}`);
  const seals = (await pool.query(`select row_count, previous_digest, seal_digest, window_from, window_to, length(seal_document) as bytes
    from attesta_security_finding_seals where tenant_id = $1 order by window_from`, [t.tenantId])).rows;
  check(seals.length === 2 && seals[0].row_count === MAX_SECURITY_SEAL_ROWS && seals[1].row_count === 3
    && seals[1].previous_digest === seals[0].seal_digest && seals[1].window_from === seals[0].window_to, 'B: 8 000 + 3, contiguous and linked');
  check(seals[0].bytes <= 1_048_576 + 1024, `B: a full seal document stays near 1 MiB (${seals[0].bytes})`);
  check(JSON.stringify(await seal(w, t, true)) === '["not_due"]', 'B: --now right after a seal is not due');

  const auditor = token(t, `auditor-${t.label}`);
  const report = await api(verifyPath(), auditor);
  check(report.status === 200 && report.body.ok === true && report.body.seals_checked === 2, `B: the chunked register verifies: ${report.text.slice(0, 300)}`);
  check(!a.sealDigests.some((d) => report.text.includes(d)) && !a.rowIds.some((id) => report.text.includes(id)), 'B: the report never names A\'s seals or rows');
  const aReport = await api(verifyPath(), token(w.a, `auditor-${w.a.label}`));
  check(!seals.some((s) => aReport.text.includes(s.seal_digest)), 'A: the report never names B\'s seals');
  // A B seal row pointing at A's seal record is refused (composite tenant key and guard).
  await refused(`insert into attesta_security_finding_seals (tenant_id, window_from, window_to, row_count, task6a_count, v2_count,
    previous_digest, seal_document, seal_digest, record_id, statement_digest)
    select $1, s.window_to, '2099-01-01T00:00:00.000000Z', 0, 0, 0, $2, s.seal_document, s.seal_digest, s.record_id, s.statement_digest
    from attesta_security_finding_seals s where s.tenant_id = $3 limit 1`, [t.tenantId, seals[1].seal_digest, w.a.tenantId], 'a B seal on A\'s record');
  console.log(`b_seals=2 b_rows=${MAX_SECURITY_SEAL_ROWS + 3} b_report=ok company_isolation=ok`);
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15op-'));
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    const { authenticateJWT } = await import('../../core/middleware/auth');
    const { tenantMiddleware } = await import('../../core/middleware/tenant');
    const w = await makeWorld(dir);
    for (const t of [w.a, w.b]) {
      await grant(t, `admin-${t.label}`, 'tenant_admin');
      await grant(t, `auditor-${t.label}`, 'tenant_auditor');
    }
    const app = express();
    app.use(express.json());
    app.use('/api', authenticateJWT, tenantMiddleware);
    app.use('/api/attesta', createAttestaRouter());
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const api = client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const a = await companyA(api, w);
    await companyB(api, w, a);
    console.log('IT-T15op-01=passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15op failed');
  process.exitCode = 1;
});
