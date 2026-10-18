/**
 * IT-T15op-02: the security period report (Task15op-b, A15.16) against real PostgreSQL (migration
 * 0027), signed through the trust inventory (IT-T15op-01's world, set up by the attesta:keys CLI)
 * and read through the real routes behind the real JWT and tenant middleware.
 *
 *   scripts/it-db.sh npm run verify:t15op-b-security-report-live -w apps/api
 *
 * Company A: Task6.a and v2 rows (enrolled and not_enrolled), a deny and a no_override enforcement
 * decision and a fleet state. A report before sealing is refused (NOT_SEALED); after a `--now`
 * seal, the CLI's dry run, then a tenant report and a repository report are built and chained
 * (/api/attesta/verify ok over every record); both routes serve them and B's auditor gets the same
 * 404; a re-run is `existing`; a fleet platform change gives a new report naming the first in
 * `previous`; a sealed row changed as the table owner makes the report ATTESTA_SECURITY_SEAL_BROKEN.
 * Company B builds its own report, which never names A's rows or seals. The audit events are checked.
 *
 * Prints only safe summary lines.
 */
import { execFileSync } from 'node:child_process';
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
import { sha256Prefixed } from './canonical';
import { pgSecuritySealStore, runSecuritySealPass } from './security-seal-service';
import { buildSecurityReport, parseSecurityReportScope, pgSecurityReportStore, type SecurityReportResult } from './security-report-service';
import { checkSecurityReport } from './security-report-rules';
import type { SecurityReportScope } from './security-report-rules';
import { keyidOf } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';

// --- IT-T15op-01's world (t15op-security-live-verify.ts), reused as is ---

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15op-b failed: ${message}`);
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
  const slug = `it-t15opb-${label}-${randomUUID().slice(0, 8)}`;
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
const KID = 'it-t15op-b';
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
async function v2Rows(t: Tenant, n: number, minsAgo: number, enrolled = false, oneInstant = false): Promise<string[]> {
  const digest = 'b'.repeat(64);
  const r = await pool.query(`insert into security_findings (tenant_id, machine_id, record_generation, record_id, rule_id, rule_version,
       rule_category, rule_severity, title, source_agent, source_type, confidence, detected_at, occurred_at, numbat_schema_version,
       bundle_digest, lease_id, found_at_rest, repository_kind, repository_id, rule_pack_version, effect, model, session_id, received_at)
     select $1, $2, 'v2', 'sha256:' || encode(sha256(convert_to($3 || ':' || g::text, 'UTF8')), 'hex'), 'secrets.aws_key', '1.0.0',
       'secrets', 'critical', 'synthetic title', 'claude-code', 'hook', 'high', now() - make_interval(mins => $4 + 1),
       now() - make_interval(mins => $4 + 1), '0.5.0', $5, 'lease-it', false, $6, $7::uuid, 'bundle:' || substr($5, 1, 16), 'monitor',
       'model-it', 'session-it', date_trunc('milliseconds', now() - make_interval(mins => $4))
         + make_interval(secs => case when $9::boolean then 0 else g end::double precision / 1000000)
     from generate_series(1, $8::int) as g
     returning id::text as id`,
  [t.tenantId, t.machineId, randomUUID(), minsAgo, digest, enrolled ? 'enrolled' : 'not_enrolled', enrolled ? t.repositoryId : null, n, oneInstant]);
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


// --- IT-T15op-02 ---

async function report(w: World, scope: SecurityReportScope): Promise<SecurityReportResult> {
  return buildSecurityReport({ store: pgSecurityReportStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'system_operator', id: 'attesta:security-report:it-operator' }, log: () => undefined }, scope);
}

async function decisions(t: Tenant, minsAgo: number): Promise<void> {
  for (const [decision, mode, deny] of [['deny', 'enforce', true], ['no_override', 'monitor', false]] as const) {
    await pool.query(`insert into security_enforcement_decisions (tenant_id, machine_id, record_id, decision, mode, rule_ids, deny_rule_id,
        deny_rule_version, finding_record_ids, tool_name, session_id, source_agent, occurred_at, received_at)
      values ($1, $2, 'sha256:' || encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4, $5, array['secrets.aws_key'], $6, $7, array[]::text[],
        'Bash', 'session-it', 'claude-code', now() - make_interval(mins => $8 + 1), now() - make_interval(mins => $8))`,
    [t.tenantId, t.machineId, randomUUID(), decision, mode, deny ? 'secrets.aws_key' : null, deny ? '1.0.0' : null, minsAgo]);
  }
}

async function platform(t: Tenant, value: 'macos' | 'windows'): Promise<void> {
  await pool.query(`insert into fleet_machine_states (tenant_id, machine_id, platform) values ($1, $2, $3)
    on conflict (tenant_id, machine_id) do update set platform = excluded.platform, updated_at = now()`, [t.tenantId, t.machineId, value]);
}

async function storedDocument(t: Tenant, reportId: string): Promise<{ document: string; statement: unknown }> {
  const r = (await pool.query(`select p.report_document, r.statement_canonical from attesta_security_period_reports p
    join attesta_records r on r.tenant_id = p.tenant_id and r.id = p.record_id where p.tenant_id = $1 and p.id = $2`, [t.tenantId, reportId])).rows[0];
  return { document: r.report_document as string, statement: JSON.parse(r.statement_canonical as string) };
}

function cliDryRun(t: Tenant, scope: SecurityReportScope): string {
  return execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, 'attesta-security-report-cli.ts'),
    '--tenant', t.tenantId, '--from', scope.from, '--to', scope.to], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function companyA(api: Api, w: World, scope: SecurityReportScope): Promise<{ reportIds: string[]; rowIds: string[] }> {
  const t = w.a;
  const rowIds = [await task6aRow(t, 180, 1), await task6aRow(t, 175, 2), ...await v2Rows(t, 2, 170), ...await v2Rows(t, 1, 165, true)];
  await decisions(t, 160);
  await platform(t, 'macos');
  const before = await report(w, scope);
  check(before.outcome === 'refused' && before.code === 'ATTESTA_SECURITY_PERIOD_NOT_SEALED', `A: a report before sealing is NOT_SEALED: ${before.code}`);
  check(JSON.stringify(await seal(w, t, true)) === '["sealed"]', 'A: --now seals the rows');
  const dry = cliDryRun(t, scope);
  check(/outcome=would_build seals=1 rows=5 decisions=1/.test(dry) && !/report_digest/.test(dry), `A: the CLI dry run: ${dry.trim().split('\n').at(-2)}`);

  const tenant = await report(w, scope);
  check(tenant.outcome === 'built' && tenant.rowCount === 5 && tenant.sealCount === 1 && tenant.decisionCount === 1, `A: the tenant report: ${JSON.stringify(tenant)}`);
  const repoScope = { ...scope, repository_id: t.repositoryId };
  const repo = await report(w, repoScope);
  check(repo.outcome === 'built' && repo.rowCount === 3 && repo.decisionCount === 0, `A: the repository report: ${JSON.stringify(repo)}`);
  const doc = await storedDocument(t, tenant.reportId as string);
  const d = JSON.parse(doc.document);
  check(d.figures.findings.value === 5 && JSON.stringify(d.figures.by_generation.value) === '[{"count":2,"key":"task6a"},{"count":3,"key":"v2"}]',
    'A: findings and generations');
  check(d.figures.denied_by_request.availability === 'partial' && d.figures.denied_by_request.value === 1, 'A: one deny request, not sealed');
  check(d.figures.by_platform.partial_reason === 'current_machine_state' && d.machine_platforms[0].platform === 'macos', 'A: the platform is the current state');
  check(d.blocked.reason === 'monitor_only_observed', 'A: blocked is never claimed');
  check(!/synthetic title|session-it|it-session|Bash/.test(doc.document), 'A: the document carries no title, session or tool (a model token is a by_model key by design)');
  check(checkSecurityReport({ statement: doc.statement, documentText: doc.document, tenantId: t.tenantId }).length === 0, 'A: SR1-SR8 hold on the stored report');
  const rd = JSON.parse((await storedDocument(t, repo.reportId as string)).document);
  check(rd.figures.denied_by_request.reason === 'not_applicable' && rd.figures.findings.value === 3, 'A: the repository report counts its rows only');

  const auditor = token(t, `auditor-${t.label}`);
  const chain = await api('/api/attesta/verify', auditor);
  check(chain.status === 200 && chain.body.ok === true && chain.body.signatures === 'checked', `A: /api/attesta/verify over seals and reports: ${chain.text.slice(0, 300)}`);
  const status = await api(`/api/attesta/security-period-reports/${tenant.reportId}`, auditor);
  check(status.status === 200 && status.body.report_digest === tenant.reportDigest && status.body.statement_digest === tenant.statementDigest
    && status.body.scope.repository_id === null, `A: the status route: ${status.text.slice(0, 200)}`);
  const dl = await api(`/api/attesta/security-period-reports/${tenant.reportId}/document`, token(t, `admin-${t.label}`));
  check(dl.status === 200 && sha256Prefixed(dl.text) === tenant.reportDigest, 'A: the document route serves the signed bytes');
  const other = token(w.b, `auditor-${w.b.label}`);
  for (const path of [`/api/attesta/security-period-reports/${tenant.reportId}`, `/api/attesta/security-period-reports/${tenant.reportId}/document`,
    `/api/attesta/security-period-reports/${randomUUID()}`]) {
    const res = await api(path, other);
    check(res.status === 404 && res.body.code === 'ATTESTA_API_NOT_FOUND', `B: ${path.includes('document') ? 'the document' : 'the status'} of A's report is the same 404`);
  }

  const again = await report(w, scope);
  check(again.outcome === 'existing' && again.reportId === tenant.reportId, 'A: a re-run returns the existing report');
  await platform(t, 'windows');
  const changed = await report(w, scope);
  check(changed.outcome === 'built' && changed.reportDigest !== tenant.reportDigest, 'A: a fleet platform change gives a new report');
  const next = await storedDocument(t, changed.reportId as string);
  const prev = (next.statement as { predicate: { previous: Array<{ digest: string }> } }).predicate.previous;
  check(prev.length === 1 && prev[0].digest === tenant.statementDigest, 'A: the new report names the first in previous');
  check(JSON.parse(next.document).machine_platforms[0].platform === 'windows', 'A: the new report holds the new platform');

  await asOwner(async () => {
    await pool.query(`update security_findings set rule_severity = 'low' where id = $1`, [rowIds[2]]);
  });
  const tampered = await report(w, scope);
  check(tampered.outcome === 'refused' && tampered.code === 'ATTESTA_SECURITY_SEAL_BROKEN', `A: a changed sealed row refuses the report: ${tampered.code}`);
  const tamperedRepo = await report(w, repoScope);
  check(tamperedRepo.code === 'ATTESTA_SECURITY_SEAL_BROKEN', 'A: and the repository report too');

  const built = (await pool.query(`select details from security_audit_events where tenant_id = $1 and action = 'attesta.security_report.built'
    order by occurred_at`, [t.tenantId])).rows;
  check(built.length === 3 && built[0].details.row_count === 5 && built[0].details.seal_count === 1 && built[0].details.repository_id === null
    && built[1].details.repository_id === t.repositoryId && built[0].details.report_digest === tenant.reportDigest, 'A: attesta.security_report.built per built report');
  const downloaded = (await pool.query(`select actor_type, details from security_audit_events where tenant_id = $1
    and action = 'attesta.security_report.downloaded'`, [t.tenantId])).rows;
  check(downloaded.length === 1 && downloaded[0].actor_type === 'tenant_admin' && downloaded[0].details.report_digest === tenant.reportDigest,
    'A: one attesta.security_report.downloaded');
  console.log('a_not_sealed=refused a_tenant_report=built a_repository_report=built verify=ok routes=ok b_404=same rerun=existing'
    + ' platform_change=new_with_previous tampered=ATTESTA_SECURITY_SEAL_BROKEN audit=built:3,downloaded:1');
  return { reportIds: [tenant.reportId as string, repo.reportId as string, changed.reportId as string], rowIds };
}

async function companyB(api: Api, w: World, scope: SecurityReportScope, a: { reportIds: string[]; rowIds: string[] }): Promise<void> {
  const t = w.b;
  await task6aRow(t, 150, 3);
  await v2Rows(t, 2, 140);
  await decisions(t, 130);
  check(JSON.stringify(await seal(w, t, true)) === '["sealed"]', 'B: --now seals its rows');
  const r = await report(w, scope);
  check(r.outcome === 'built' && r.rowCount === 3 && r.decisionCount === 1, `B: its own report: ${JSON.stringify(r)}`);
  const doc = (await storedDocument(t, r.reportId as string)).document;
  check(!a.rowIds.some((id) => doc.includes(id)) && !doc.includes(w.a.machineId) && !doc.includes(w.a.repositoryId), 'B: the report never names A\'s rows, machine or repository');
  check(JSON.parse(doc).figures.by_platform.value.some((b: { key: string }) => b.key === 'unavailable'), 'B: a v2 machine with no state is unavailable');
  const mine = await api(`/api/attesta/security-period-reports/${r.reportId}`, token(t, `auditor-${t.label}`));
  check(mine.status === 200, 'B: its auditor reads its report');
  const foreign = await api(`/api/attesta/security-period-reports/${r.reportId}`, token(w.a, `auditor-${w.a.label}`));
  check(foreign.status === 404, 'A: B\'s report is a 404 for A');
  const stranger = await report(w, { ...scope, tenant_id: t.tenantId, repository_id: w.a.repositoryId });
  check(stranger.outcome === 'refused' && stranger.code === 'ATTESTA_API_INVALID_QUERY', 'B: a report over A\'s repository is refused like an unknown one');
  console.log('b_report=built b_isolation=ok cross_repository=refused');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15op-b-'));
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
    const now = Date.now();
    const period = (tenantId: string) => parseSecurityReportScope({ tenantId, repositoryId: null, from: iso(now - 5 * 60 * MIN), to: iso(now - 30 * MIN) });
    const a = await companyA(api, w, period(w.a.tenantId));
    await companyB(api, w, period(w.b.tenantId), a);
    console.log('IT-T15op-02=passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15op-b failed');
  process.exitCode = 1;
});
