/**
 * IT-T19c-01: Task19c's live security answers against real PostgreSQL, through
 * the real JWT and tenant middleware (a local JWKS stands in for Supabase), the
 * real requireAdminAction('qa.read') guard and the real createApp() mount.
 *
 *   scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api
 *
 * Both generations of `security_findings` are seeded by direct SQL (v2 rows
 * need a signed activation lease, which is Task20f's): Company A gets three
 * Task6.a rows (macOS) and one v2 `not_enrolled` row (Windows), plus a merged
 * PR, a commit, a session, a status snapshot and two enforcement decisions.
 * Company B gets one Task6.a row. Then:
 * - (a) S7 is 200, schema-valid, counts four findings, carries `previous`;
 * - (b) S7's repository breakdown puts the v2 `not_enrolled` row under `unknown`;
 * - (c) S8's model breakdown names the v2 model and `unknown` for Task6.a;
 * - (d) S9 is partial with `not_monitored` for the Windows machine;
 * - (e) S12 reports the one `deny` and two policy versions, `blocked` unavailable;
 * - (f) S5, S6 and Q11 count the linked session's findings;
 * - (g) Company A never sees Company B's row, and Company B counts its own one;
 * - (h) an auditor asking for kind=live gets 403.
 *
 * Throwaway database only (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh).
 * Safe summary lines only.
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
  if (!condition) throw new Error(`IT-T19c-01 failed: ${message}`);
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const hex = (n: number, c = 'a') => c.repeat(n);

interface Seed {
  tenantId: string;
  domain: string;
  repositoryId: string;
  machineId: string;
  machineId2: string | null;
}

async function seedTenant(label: string): Promise<Seed> {
  const tenantId = randomUUID();
  const slug = `it-t19c-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  const repositoryId = randomUUID();
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url) values ($1, $2, 'github', $3, $4, $5)`,
    [repositoryId, tenantId, `${slug}-repo`, `repo-${label}`, `https://github.com/example/${slug}`]);
  const machine = async (platform: 'macos' | 'windows') => {
    const id = (await pool.query(
      `insert into developer_machines (tenant_id, installation_id, display_name) values ($1, $2, 'it machine') returning id`,
      [tenantId, randomUUID()])).rows[0].id as string;
    await pool.query(
      `insert into fleet_machine_states (tenant_id, machine_id, platform, updated_at) values ($1, $2, $3, now())`,
      [tenantId, id, platform]);
    return id;
  };
  return { tenantId, domain, repositoryId, machineId: await machine('macos'), machineId2: null };
}

async function grant(t: Seed, subject: string, role: 'tenant_admin' | 'tenant_auditor'): Promise<void> {
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by, revoked_at)
     values ($1, $2, $3, $4, 'active', 'it-t19c', null)`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

/** One Task6.a row (monitor-only, macOS, session string), as t15h seeds one. */
async function insertTask6a(t: Seed, opts: { machineId: string; session: string; rule: string; severity: string; at: Date }): Promise<void> {
  await pool.query(
    `insert into security_findings (tenant_id, machine_id, repository_id, finding_id, delivery_id, session_id, source_event_id,
       rule_id, rule_version, rule_category, rule_severity, route_id, agent_family, host_surface, host_mode, capture_channel,
       operating_system, timing, native_effect, activation, effect, phase, availability, completeness, result_category,
       occurred_at, client_version, rule_pack_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, '1.4', 'execution', $9, 'AC-CLI-03',
       'opencode', 'terminal', 'cli', 'provider-plugin', 'macos', 'pre_action', 'observe_only', 'observed', 'monitor',
       'requested', 'available', 'complete', 'not_observed', $10, '0.1.0-test', '0.1.0-test')`,
    [t.tenantId, opts.machineId, t.repositoryId, randomUUID(), randomUUID(), opts.session, `event-${randomUUID()}`,
      opts.rule, opts.severity, opts.at]);
}

/** One v2 row, inserted directly (no lease). */
async function insertV2(t: Seed, opts: {
  machineId: string; session: string | null; rule: string; severity: string; model: string | null;
  sourceAgent: string; repositoryKind: 'enrolled' | 'not_enrolled'; bundle: string; at: Date;
}): Promise<void> {
  const recordId = `sha256:${hex(64, 'b')}`;
  await pool.query(
    `insert into security_findings (tenant_id, machine_id, record_generation, rule_id, rule_version, rule_category,
       rule_severity, effect, occurred_at, rule_pack_version, repository_id, session_id, record_id, source_agent, source_type,
       model, confidence, title, detected_at, numbat_schema_version, bundle_digest, lease_id, found_at_rest, repository_kind)
     values ($1, $2, 'v2', $3, '2.0', split_part($3, '.', 1), $4, 'monitor', $5, $6,
       $7, $8, $9, $10, 'artifact', $11, 'high', 'IT finding', $5, '0.5.0', $12, 'it-lease', false, $13)`,
    [t.tenantId, opts.machineId, opts.rule, opts.severity, opts.at, `bundle:${opts.bundle.slice(0, 16)}`,
      opts.repositoryKind === 'enrolled' ? t.repositoryId : null, opts.session, recordId, opts.sourceAgent, opts.model,
      opts.bundle, opts.repositoryKind]);
}

async function seedSnapshot(t: Seed, machineId: string, at: Date): Promise<void> {
  await pool.query(
    `insert into security_status_snapshots (tenant_id, machine_id, record_id, observed_at, numbat_version, wired_agents,
       hook_status, agent_effective_view, local_record, forwarder_ack)
     values ($1, $2, $3, $4, '0.5.0', array['opencode'], 'ok', 'ok', 'ok', 'ok')`,
    [t.tenantId, machineId, `sha256:${hex(64, 'c')}`, at]);
}

async function seedDecision(t: Seed, machineId: string, decision: 'deny' | 'no_override', at: Date): Promise<void> {
  await pool.query(
    `insert into security_enforcement_decisions (tenant_id, machine_id, record_id, decision, mode, rule_ids,
       deny_rule_id, deny_rule_version, finding_record_ids, source_agent, occurred_at)
     values ($1, $2, $3, $4, $5, array['trackai.exec.reverse_shell'], $6, $7, array[]::text[], 'opencode', $8)`,
    [t.tenantId, machineId, `sha256:${randomUUID().replace(/-/g, '')}${hex(32, 'd')}`, decision,
      decision === 'deny' ? 'enforce' : 'monitor',
      decision === 'deny' ? 'trackai.exec.reverse_shell' : null, decision === 'deny' ? '1.4' : null, at]);
}

async function seedCompanyA(t: Seed): Promise<void> {
  const bundle = hex(64, 'e');
  t.machineId2 = (await pool.query(
    `insert into developer_machines (tenant_id, installation_id, display_name) values ($1, $2, 'it machine win') returning id`,
    [t.tenantId, randomUUID()])).rows[0].id as string;
  await pool.query(
    `insert into fleet_machine_states (tenant_id, machine_id, platform, updated_at) values ($1, $2, 'windows', now())`,
    [t.tenantId, t.machineId2]);

  await insertTask6a(t, { machineId: t.machineId, session: 'it-session-1', rule: 'trackai.exec.download_pipe_shell', severity: 'high', at: daysAgo(10) });
  await insertTask6a(t, { machineId: t.machineId, session: 'it-session-1', rule: 'trackai.exec.reverse_shell', severity: 'critical', at: daysAgo(9) });
  await insertV2(t, { machineId: t.machineId, session: null, rule: 'secret.read.aws_key', severity: 'high',
    model: 'claude-3', sourceAgent: 'claude-code', repositoryKind: 'enrolled', bundle, at: daysAgo(8) });
  await insertV2(t, { machineId: t.machineId2, session: null, rule: 'network.outbound_scan', severity: 'medium',
    model: null, sourceAgent: 'codex', repositoryKind: 'not_enrolled', bundle, at: daysAgo(7) });

  await seedSnapshot(t, t.machineId, daysAgo(6));
  await seedDecision(t, t.machineId, 'deny', daysAgo(6));
  await seedDecision(t, t.machineId, 'no_override', daysAgo(6));

  // A session, one retained commit linked to it, and a merged PR over that commit.
  const sessionId = randomUUID();
  await pool.query(
    `insert into ai_sessions (id, tenant_id, external_session_id, tool) values ($1, $2, 'it-session-1', 'opencode')`,
    [sessionId, t.tenantId]);
  const commitId = randomUUID();
  const sha = hex(40, 'f');
  await pool.query(
    `insert into scm_commits (id, tenant_id, repository_id, sha, subject, reachability, committed_at,
       observed_ai_lines, observed_human_lines, observed_unknown_lines, authorship_note)
     values ($1, $2, $3, $4, 'commit', 'reachable', $5, 10, 5, 0, 'git-ai: it-session-1')`,
    [commitId, t.tenantId, t.repositoryId, sha, daysAgo(10)]);
  await pool.query(
    `insert into ai_commit_sessions (id, tenant_id, commit_id, session_id) values ($1, $2, $3, $4)`,
    [randomUUID(), t.tenantId, commitId, sessionId]);
  const prId = randomUUID();
  await pool.query(
    `insert into scm_pull_requests (id, tenant_id, repository_id, external_id, title, state, number, merged_at)
     values ($1, $2, $3, 'pr-1', 'IT PR', 'merged', 1, $4)`,
    [prId, t.tenantId, t.repositoryId, daysAgo(9)]);
  await pool.query(
    `insert into scm_pull_request_commits (id, tenant_id, pull_request_id, commit_id, match_method, confidence)
     values ($1, $2, $3, $4, 'sha', 100)`,
    [randomUUID(), t.tenantId, prId, commitId]);
}

async function seedCompanyB(t: Seed): Promise<void> {
  await insertTask6a(t, { machineId: t.machineId, session: 'it-session-b', rule: 'trackai.exec.reverse_shell', severity: 'high', at: daysAgo(8) });
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t19c';
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

function fig(body: any, key: string): any {
  const figure = body?.figures?.find((f: any) => f?.key === key);
  check(figure, `figure ${key} is present`);
  return figure;
}

function bucket(figure: any, key: string): any {
  const item = figure?.breakdown?.find((b: any) => b?.key === key);
  check(item, `bucket ${key} is present`);
  return item;
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

    // (a) S7 counts four findings and carries previous.
    const s7 = await get(app.base, answer('S7', `kind=live&breakdown=repository&${period}`), admin);
    valid(s7, '(a) S7');
    check(fig(s7.body, 'findings')?.value?.count === 4, '(a) S7 findings = 4');
    check(Array.isArray(s7.body?.previous?.figures), '(a) S7 previous is present');
    check(JSON.stringify(s7.body.previous.figures.map((f: any) => f.key)) === JSON.stringify(s7.body.figures.map((f: any) => f.key)),
      '(a) S7 previous has the same keys');
    console.log('IT-T19c-01a ok: S7 counts four findings with previous');

    // (b) A v2 not_enrolled row buckets as unknown, never a repository.
    check(bucket(fig(s7.body, 'findings'), a.repositoryId)?.value?.count === 3, '(b) S7 repository A = 3');
    check(bucket(fig(s7.body, 'findings'), 'unknown')?.value?.count === 1, '(b) S7 unknown = 1 (not_enrolled)');
    console.log('IT-T19c-01b ok: S7 puts the v2 not_enrolled row under unknown');

    // (c) S8 model breakdown.
    const s8 = await get(app.base, answer('S8', `kind=live&breakdown=model&repository_id=${a.repositoryId}&${period}`), admin);
    valid(s8, '(c) S8');
    check(bucket(fig(s8.body, 'findings'), 'claude-3')?.value?.count === 1, '(c) S8 claude-3 = 1');
    check(bucket(fig(s8.body, 'findings'), 'unknown')?.value?.count === 2, '(c) S8 unknown = 2 (Task6.a)');
    console.log('IT-T19c-01c ok: S8 model breakdown names claude-3 and unknown');

    // (d) S9 partial for the Windows machine.
    const s9 = await get(app.base, answer('S9', `kind=live&breakdown=operating_system&${period}`), admin);
    valid(s9, '(d) S9');
    check(fig(s9.body, 'findings')?.availability === 'partial', '(d) S9 partial');
    check(fig(s9.body, 'findings')?.reasons?.some((r: any) => r.code === 'not_monitored'), '(d) S9 not_monitored');
    check(bucket(fig(s9.body, 'findings'), 'macos')?.value?.count === 3, '(d) S9 macos = 3');
    check(bucket(fig(s9.body, 'findings'), 'windows')?.value?.count === 1, '(d) S9 windows = 1');
    console.log('IT-T19c-01d ok: S9 is partial with not_monitored for Windows');

    // (e) S12 one deny, two policy versions, blocked unavailable.
    const s12 = await get(app.base, answer('S12', `kind=live&breakdown=repository&${period}`), admin);
    valid(s12, '(e) S12');
    check(fig(s12.body, 'denied_by_request')?.value?.count === 1, '(e) S12 denied = 1');
    check(fig(s12.body, 'policy_versions')?.value?.count === 2, '(e) S12 policy versions = 2');
    check(fig(s12.body, 'blocked')?.availability === 'unavailable', '(e) S12 blocked unavailable');
    console.log('IT-T19c-01e ok: S12 denied = 1, policy versions = 2, blocked unavailable');

    // (f) The linked session's findings.
    const s5 = await get(app.base, answer('S5', `kind=live&${period}`), admin);
    valid(s5, '(f) S5');
    check(fig(s5.body, 'findings_with_session')?.value?.count === 2, '(f) S5 with session = 2');
    check(fig(s5.body, 'linked_sessions')?.value?.count === 1, '(f) S5 linked sessions = 1');
    const s6 = await get(app.base, answer('S6', `kind=live&repository_id=${a.repositoryId}&${period}`), admin);
    valid(s6, '(f) S6');
    check(fig(s6.body, 'high_or_critical_sessions_merged')?.value?.count === 2, '(f) S6 merged = 2');
    const q11 = await get(app.base, answer('Q11', `kind=live&${period}`), admin);
    valid(q11, '(f) Q11');
    check(fig(q11.body, 'findings_in_linked_sessions')?.value?.count === 2, '(f) Q11 = 2');
    console.log('IT-T19c-01f ok: S5, S6 and Q11 count the linked session');

    // (g) Company A never sees Company B; Company B counts its own one.
    for (const r of [s7, s8, s9, s12, s5, s6, q11]) {
      check(!JSON.stringify(r.body).includes(b.repositoryId), '(g) no Company B repository in Company A answers');
      check(!JSON.stringify(r.body).includes(b.machineId), '(g) no Company B machine in Company A answers');
    }
    const bs7 = await get(app.base, answer('S7', `kind=live&${period}`), token(b, 'admin-b'));
    valid(bs7, '(g) Company B S7');
    check(fig(bs7.body, 'findings')?.value?.count === 1, '(g) Company B S7 = 1');
    console.log('IT-T19c-01g ok: Company A sees none of Company B; Company B counts its own');

    // (h) An auditor asking for kind=live gets 403.
    const auditor = await get(app.base, answer('S7', `kind=live&${period}`), token(a, 'auditor-a'));
    check(auditor.status === 403, `(h) auditor live: 403 (got ${auditor.status})`);
    console.log('IT-T19c-01h ok: auditor refused live (403)');
    console.log('IT-T19c-01 passed');
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T19c-01 failed');
  process.exitCode = 1;
});
