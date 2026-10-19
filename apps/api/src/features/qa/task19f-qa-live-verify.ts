/** IT-T19f-01: real JWT/tenant/QA route against a disposable PostgreSQL database. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv from 'ajv';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../core/db';

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`IT-T19f-01 failed: ${what}`);
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const digest = () => `sha256:${randomUUID().replace(/-/g, '')}${'a'.repeat(32)}`;
interface Tenant { id: string; domain: string; machine: string }
async function tenant(name: string): Promise<Tenant> {
  const id = randomUUID();
  const domain = `it-t19f-${name}-${randomUUID().slice(0, 8)}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id)
    values ($1, $2, $3, $4)`, [id, `IT ${name}`, domain, domain]);
  const machine = (await pool.query(`insert into developer_machines (tenant_id, installation_id, display_name)
    values ($1, $2, 'IT machine') returning id`, [id, randomUUID()])).rows[0].id as string;
  return { id, domain, machine };
}
async function membership(t: Tenant, sub: string, role: string): Promise<void> {
  await pool.query(`insert into tenant_admin_memberships
    (tenant_id, subject, email, role, status, granted_by, revoked_at)
    values ($1, $2, $3, $4, 'active', 'it-t19f', null)`, [t.id, sub, `${sub}@${t.domain}`, role]);
}
async function setting(t: Tenant, urls: boolean): Promise<void> {
  await pool.query(`insert into security_data_settings_versions
    (tenant_id, version, command_previews, file_paths, urls, host_identity, user_identity,
     agents, day_one_scan, monitor_mode, created_by, reason, created_at)
    values ($1, 1, false, false, $2, false, false, array['claude-code'], false, 'monitor',
      'it-t19f', 'integration', $3)`, [t.id, urls, ago(40)]);
}
async function permission(t: Tenant, outcome: string, session: string): Promise<void> {
  await pool.query(`insert into security_permission_events
    (tenant_id, machine_id, record_id, outcome, session_id, source_agent, occurred_at, "join")
    values ($1, $2, $3, $4, $5, 'claude-code', $6, 'same_session_window')`,
    [t.id, t.machine, digest(), outcome, session, ago(5)]);
}
async function finding(t: Tenant, rule: string, session: string): Promise<void> {
  const bundle = 'e'.repeat(64);
  await pool.query(`insert into security_findings
    (tenant_id, machine_id, record_generation, rule_id, rule_version, rule_category,
     rule_severity, effect, occurred_at, rule_pack_version, repository_id, session_id,
     record_id, source_agent, source_type, model, confidence, title, detected_at,
     numbat_schema_version, bundle_digest, lease_id, found_at_rest, repository_kind)
    values ($1, $2, 'v2', $3, '2.0', split_part($3, '.', 1), 'high', 'monitor', $4,
      $5, null, $6, $7, 'claude-code', 'artifact', null, 'high', 'IT finding', $4,
      '0.5.0', $8, 'it-lease', false, 'not_enrolled')`,
    [t.id, t.machine, rule, ago(5), `bundle:${bundle.slice(0, 16)}`, session, digest(), bundle]);
}
async function indicator(t: Tenant, type: string, value: string, count: number,
  window: { firstSeen: Date; lastSeen: Date } = { firstSeen: ago(6), lastSeen: ago(5) }): Promise<void> {
  await pool.query(`insert into security_indicators
    (tenant_id, machine_id, record_id, type, value, count, first_seen, last_seen, source_agent)
    values ($1, $2, $3, $4, $5, $6, $7, $8, 'claude-code')`,
    [t.id, t.machine, digest(), type, value, count, window.firstSeen, window.lastSeen]);
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'it-t19f';
async function jwks(): Promise<Server> {
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}
const token = (t: Tenant, sub: string) => jwt.sign({ sub, email: `${sub}@${t.domain}` }, keys.privateKey,
  { algorithm: 'RS256', keyid: kid, expiresIn: 600 });
async function main(): Promise<void> {
  check(process.env.TASK6_EPHEMERAL_DATABASE === '1', 'disposable database required');
  check(process.env.DATABASE_URL && ['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname),
    'local disposable database required');
  const auth = await jwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`;
  let server: Server | undefined;
  try {
    const { createApp } = await import('../../app');
    server = await new Promise<Server>((done) => { const s = createApp().listen(0, '127.0.0.1', () => done(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const a = await tenant('a');
    const b = await tenant('b');
    const periodEnd = new Date();
    await membership(a, 'admin-a', 'tenant_admin');
    await membership(a, 'auditor-a', 'tenant_auditor');
    await membership(b, 'admin-b', 'tenant_admin');
    await setting(a, true);
    await setting(b, false);
    await permission(a, 'requested', 'session-a');
    await permission(a, 'requested', 'session-a');
    await permission(a, 'approved', 'session-a');
    await permission(a, 'denied', 'session-b');
    await finding(a, 'tamper.guardrails_off', 'session-a');
    await indicator(a, 'domain', 'a.example', 2);
    // This row overlaps the requested period even though last_seen is after it.
    await indicator(a, 'domain', 'ongoing.example', 5,
      { firstSeen: ago(4), lastSeen: new Date(periodEnd.getTime() + 86_400_000) });
    await indicator(a, 'url', 'https://a.example/path', 3);
    await indicator(a, 'ipv4', '203.0.113.1', 4);
    await permission(b, 'requested', 'session-b');
    await indicator(b, 'domain', 'b.example', 7);
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/contracts/qa/answer-v1.schema.json'), 'utf8'));
    const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false }).compile(schema);
    const period = `from=${encodeURIComponent(ago(30).toISOString())}&to=${encodeURIComponent(periodEnd.toISOString())}`;
    async function get(path: string, bearer: string): Promise<{ status: number; body: any }> {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
      check(res.headers.get('cache-control') === 'no-store', 'no-store');
      return { status: res.status, body: await res.json() as any };
    }
    const answer = (id: string) => `/api/qa/questions/${id}/answer?kind=live&${period}`;
    const figure = (body: any, key: string) => body.figures.find((f: any) => f.key === key);
    const adminA = token(a, 'admin-a');
    const s26 = await get(answer('S26'), adminA);
    check(s26.status === 200 && validate(s26.body), 'S26 schema-valid 200');
    for (const [key, count] of [['permission_requested', 2], ['permission_approved', 1],
      ['permission_denied', 1], ['sessions_with_finding_and_approval', 1]] as const) {
      check(figure(s26.body, key)?.value?.count === count, `S26 ${key}`);
    }
    check(figure(s26.body, 'approval_rate')?.value?.denominator === 2, 'S26 approval denominator');
    const s23 = await get(answer('S23'), adminA);
    check(s23.status === 200 && validate(s23.body), 'S23 schema-valid 200');
    check(figure(s23.body, 'distinct_domains')?.value?.count === 2, 'S23 overlapping domains');
    check(figure(s23.body, 'distinct_urls')?.value?.count === 1, 'S23 distinct URLs');
    check(figure(s23.body, 'distinct_ip_addresses')?.value?.count === 1, 'S23 distinct IPs');
    check(figure(s23.body, 'indicator_observations')?.value?.count === 14, 'S23 overlapping observations');
    check(!JSON.stringify(s23.body).includes('a.example') && !JSON.stringify(s23.body).includes('ongoing.example'),
      'S23 indicator values excluded');
    const s21 = await get(answer('S21'), adminA);
    check(s21.status === 200 && validate(s21.body), 'S21 schema-valid 200');
    check(figure(s21.body, 'guardrails_off_findings')?.value?.count === 1, 'S21 findings');
    check(figure(s21.body, 'guardrails_off_sessions')?.value?.count === 1, 'S21 sessions');
    check(figure(s21.body, 'bypass_flag_launches')?.availability === 'unavailable', 'S21 bypass unavailable');
    const off = await get(answer('S23'), token(b, 'admin-b'));
    const offBody: any = off.body;
    check(off.status === 200 && (validate(offBody) as boolean) && offBody.availability === 'unavailable', 'B S23 unavailable');
    check(offBody.figures.every((f: any) => f.value === null && f.reasons.some((r: any) => r.code === 'data_setting_off')),
      'B S23 null and data_setting_off');
    const isolated = await get(answer('S26'), token(b, 'admin-b'));
    check(figure(isolated.body, 'permission_requested')?.value?.count === 1, 'B sees only B permission events');
    check(figure(isolated.body, 'permission_approved')?.value?.count === 0, 'B sees no A approvals');
    const forbidden = await get(answer('S26'), token(a, 'auditor-a'));
    check(forbidden.status === 403, 'auditor live 403');
    const questions = await get('/api/qa/questions', adminA);
    check(questions.status === 200, 'question list 200');
    check(questions.body.items.length === 46, '46 questions');
    process.stdout.write('IT-T19f-01 passed: S26/S23/S21 seeded figures, privacy, tenant isolation, auditor guard, 46 questions\n');
  } finally {
    await new Promise<void>((done) => server?.close(() => done()) ?? done());
    await new Promise<void>((done) => auth.close(() => done()));
    await pool.end();
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
