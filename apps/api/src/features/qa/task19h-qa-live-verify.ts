/** IT-T19h-01: real JWT/tenant/QA route against a disposable PostgreSQL database. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv from 'ajv';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../../core/db';

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`IT-T19h-01 failed: ${what}`);
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const digest = () => `sha256:${randomUUID().replace(/-/g, '')}${'a'.repeat(32)}`;
interface Tenant { id: string; domain: string; machine: string }
async function tenant(name: string): Promise<Tenant> {
  const id = randomUUID();
  const domain = `it-t19h-${name}-${randomUUID().slice(0, 8)}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id)
    values ($1, $2, $3, $4)`, [id, `IT ${name}`, domain, domain]);
  const machine = (await pool.query(`insert into developer_machines (tenant_id, installation_id, display_name)
    values ($1, $2, 'IT machine') returning id`, [id, randomUUID()])).rows[0].id as string;
  return { id, domain, machine };
}
async function membership(t: Tenant, sub: string, role: string): Promise<void> {
  await pool.query(`insert into tenant_admin_memberships
    (tenant_id, subject, email, role, status, granted_by, revoked_at)
    values ($1, $2, $3, $4, 'active', 'it-t19h', null)`, [t.id, sub, `${sub}@${t.domain}`, role]);
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'it-t19h';
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
async function inventory(t: Tenant, observedAt: Date, agents: unknown[]): Promise<void> {
  await pool.query(`insert into security_agent_inventory_snapshots (tenant_id, machine_id, record_id, observed_at, agents)
    values ($1, $2, $3, $4, $5::jsonb)`, [t.id, t.machine, digest(), observedAt, JSON.stringify(agents)]);
}
async function scan(t: Tenant, status: string, artifacts: number): Promise<void> {
  await pool.query(`insert into security_scan_summaries (tenant_id, machine_id, record_id, status, artifacts_scanned,
    events_emitted, findings_emitted, indicators_emitted, diagnostics) values ($1, $2, $3, $4, $5, 0, 0, 0, 0)`,
    [t.id, t.machine, digest(), status, artifacts]);
}
async function atRestFinding(t: Tenant): Promise<void> {
  const bundle = 'e'.repeat(64);
  // occurred_at is the old session's time, far outside the period; received_at (now) places it in the period.
  await pool.query(`insert into security_findings
    (tenant_id, machine_id, record_generation, rule_id, rule_version, rule_category,
     rule_severity, effect, occurred_at, rule_pack_version, repository_id, session_id,
     record_id, source_agent, source_type, model, confidence, title, detected_at,
     numbat_schema_version, bundle_digest, lease_id, found_at_rest, repository_kind)
    values ($1, $2, 'v2', 'secrets.read_private_key', '2.0', 'secrets', 'high', 'monitor', $3,
      $4, null, 'old-session', $5, 'claude-code', 'artifact', null, 'high', 'IT at-rest finding', $3,
      '0.5.0', $6, 'it-lease', true, 'not_enrolled')`,
    [t.id, t.machine, ago(200), `bundle:${bundle.slice(0, 16)}`, digest(), bundle]);
}
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
    const periodEnd = new Date(Date.now() + 60_000);
    await membership(a, 'admin-a', 'tenant_admin');
    await membership(a, 'auditor-a', 'tenant_auditor');
    await membership(b, 'admin-b', 'tenant_admin');
    const agent = (name: string, config: string, artifacts: string, wired: string) =>
      ({ agent: name, version: null, config, artifacts, wired });
    await inventory(a, ago(3), [agent('codex', 'present', 'absent', 'no')]);
    await inventory(a, ago(1), [agent('claude', 'present', 'present', 'yes'), agent('codex', 'present', 'absent', 'no'),
      agent('cursor', 'absent', 'absent', 'no')]);
    await scan(a, 'complete', 7);
    await scan(a, 'error', 0);
    await atRestFinding(a);
    await inventory(b, ago(1), [agent('gemini', 'present', 'present', 'yes')]);
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
    const s19 = await get(answer('S19'), adminA);
    check(s19.status === 200 && validate(s19.body), 'S19 schema-valid 200');
    for (const [key, count] of [['machines_reporting', 1], ['agents_detected', 2], ['agents_wired', 1],
      ['agents_detected_not_wired', 1]] as const) {
      check(figure(s19.body, key)?.value?.count === count, `S19 ${key} (latest snapshot only)`);
    }
    check(figure(s19.body, 'agent_versions')?.value === null, 'S19 no versions claimed');
    const s20 = await get(answer('S20'), adminA);
    check(s20.status === 200 && validate(s20.body), 'S20 schema-valid 200');
    for (const [key, count] of [['machines_scanned', 1], ['scans_complete', 1], ['scans_no_session_files', 1],
      ['scans_failed', 0], ['artifacts_scanned', 7], ['findings_at_rest', 1]] as const) {
      check(figure(s20.body, key)?.value?.count === count, `S20 ${key}`);
    }
    const s19b = await get(answer('S19'), token(b, 'admin-b'));
    check(figure(s19b.body, 'agents_detected')?.value?.count === 1, 'B sees only its own inventory');
    const s20b = await get(answer('S20'), token(b, 'admin-b'));
    check(s20b.status === 200 && s20b.body.availability === 'unavailable', 'B has no day-one scan: unavailable, not zero');
    const forbidden = await get(answer('S19'), token(a, 'auditor-a'));
    check(forbidden.status === 403, 'auditor live 403');
    process.stdout.write('IT-T19h-01 passed: S19 latest inventory, S20 scans and at-rest findings, tenant isolation, auditor guard\n');
  } finally {
    await new Promise<void>((done) => server?.close(() => done()) ?? done());
    await new Promise<void>((done) => auth.close(() => done()));
    await pool.end();
  }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
