/**
 * IT-T15i3-01…04: key validity windows in /verify and the audited anchor resume,
 * against real PostgreSQL (migration 0021), through the real environment path: the
 * default router (createAttestaRouter with no seams) behind the real JWT and tenant
 * middleware (a local JWKS stands in for Supabase), the trust inventory driven by the
 * attesta:keys CLI (ATTESTA_DEV_CREDENTIALS_FILE, ATTESTA_TRUST_ROOT_KEYIDS), the
 * builder signing through inventorySignerResolver, anchoring configured from the
 * environment (the Rekor and TSA fakes in process), and attesta:anchor-resume run as
 * a real child process.
 *
 *   scripts/it-db.sh npm run verify:task15i3-verify-keys-resume-live -w apps/api
 *
 * 01 rotation (activate --replace, publish): statements signed by the old key and
 *    anchored before its retirement → /verify ok; a statement the retired key signs
 *    afterwards (a rogue signer holding it) → KEY_NOT_VALID_AT, before and after it is
 *    anchored; the new key's statements pass.
 * 02 revoke compromised --compromised-since: statements anchored before that instant
 *    pass, the one anchored after it breaks.
 * 03 a batch stopped by LOG_REJECTED (the fake log answers 400) is resumed by the CLI
 *    (dry run, then --confirm=RESUME), audited, and anchors on the next pass; a second
 *    resume without a new stop is refused by the guard (CLI, API role, RLS-bound role);
 *    a new stop needs a new resume; the guard stamps created_at; no UPDATE, DELETE or
 *    TRUNCATE.
 * 04 Company A/B: B cannot resume A's batch (CLI scope, store, API role, RLS role);
 *    A's windows never come from B's key set.
 *
 * One clock: the real one (the inventory, the log and the TSA stamp with it); waits of
 * 1.1 s separate instants the whole-second anchor times must order. Prints only safe
 * summary lines.
 */
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { PoolClient } from 'pg';
import { db, pool } from '../../core/db';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { anchorFromEnv } from './anchor-env';
import { runAnchorPass } from './anchor-worker';
import { pgResumeStore } from './attesta-anchor-resume-cli';
import { main as keysMain } from './attesta-keys-cli';
import { main as rootMain } from './attesta-trust-root-cli';
import { createAttestaRouter } from './attesta.routes';
import { chainStatement } from './ledger';
import { publishedKeyWindowsFor } from './read-service';
import { devSignerResolver, type SignerResolver } from './signer-resolver';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { keyidOf } from './trust-documents';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';
import type { ChainReport } from './verify-chain';
import { runBuilderPass, type BuilderPassOptions, type WorkerDatabase } from './worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15i3 failed: ${message}`);
}

const MIN = 60_000;
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP_ROLE = 'it_t15i3_app';

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; domain: string; slug: string; repos: Record<'r1' | 'r2', string> }

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15i3-${label}-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, domain, slug]);
  return { label, tenantId, domain, slug, repos: { r1: `https://github.com/${slug}/one`, r2: `https://github.com/${slug}/two` } };
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
// JWKS and tokens (as IT-T15i2)

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t15i3';
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
  await pool.query(
    `insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by) values ($1, $2, $3, $4, 'active', 'it-t15i3')`,
    [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

// ---------------------------------------------------------------------------
// The world: the trust inventory by CLI, the environment as production reads it

async function makeWorld(dir: string) {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  const c = await seedTenant('c');
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), a2: newKey(), b1: newKey(), c1: newKey() };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const creds = [['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:a2', a.tenantId, k.a2], ['dev:b1', b.tenantId, k.b1], ['dev:c1', c.tenantId, k.c1]] as const;
  const rekor = new FakeRekor();
  const tsa = await FakeTsa.create();
  Object.assign(process.env, {
    ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid,
    ATTESTA_DEV_CREDENTIALS_FILE: file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
      ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) })))),
    ATTESTA_ANCHOR_CREDENTIAL_ID: 'dev:anchor',
    ATTESTA_DEV_ANCHOR_KEY_FILE: file('dev_anchor.pem', k.anchor.pem),
    ATTESTA_REKOR_URL: 'http://rekor.test',
    ATTESTA_REKOR_LOG_KEY_FILE: file('rekor.pem', createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString()),
    ATTESTA_TSA_URL: TSA_URL,
    ATTESTA_TSA_ANCHORS_FILE: file('tsa.pem', tsa.anchorsPem),
  });
  const env = process.env;
  const out: string[] = [];
  const err: string[] = [];
  // The initial inventory is set up two hours back, so the keys' validity starts before the
  // statements the builder stamps up to 50 minutes in the past (recorded_at before a key's
  // not_before is KEY_NOT_VALID_AT). Rotation and revocation then run on the real clock.
  const clock = { offsetMs: -2 * 60 * MIN };
  const io = { readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, now: () => new Date(Date.now() + clock.offsetMs) };
  const cli = async (...argv: string[]) => { out.length = 0; err.length = 0; const code = await keysMain(argv, io); return { code, out: out.join('\n'), err: err.join('\n') }; };
  /** attesta:keys dry run, then apply with the flags it printed. */
  const keys = async (...argv: string[]) => {
    const dry = await cli(...argv);
    check(dry.code === 0, `dry run ${argv[0]}: ${dry.err}`);
    const m = /--confirm=(\S+) --expect=(\d+)/.exec(dry.out);
    check(m, `dry run ${argv[0]} prints the apply flags`);
    const done = await cli(...argv, `--confirm=${m[1]}`, `--expect=${m[2]}`, '--actor', 'it-operator');
    check(done.code === 0, `apply ${argv[0]}: ${done.err}`);
  };
  await keys('register', '--adapter', 'local-dev', '--credential', 'dev:anchor', '--purpose', 'anchor');
  await keys('register', '--adapter', 'local-dev', '--credential', 'dev:keyset', '--purpose', 'tenant_keyset');
  const draft = join(dir, 'draft.json');
  const signed = join(dir, 'root.json');
  check((await cli('export-root-draft', '--out', draft, '--root-pub', file('root.pub', k.root.pubPem), '--add', k.anchor.keyid, '--add', k.keyset.keyid)).code === 0, 'export-root-draft');
  const offline = { ...io, out: () => undefined, err: () => undefined, env: {} };
  check(await rootMain(['sign', '--draft', draft, '--key', file('root.pem', k.root.pem), '--out', signed], offline) === 0, 'offline root signature');
  await keys('import-root', '--file', signed);
  for (const [t, cred, key] of [[a, 'dev:a1', k.a1], [b, 'dev:b1', k.b1], [c, 'dev:c1', k.c1]] as const) {
    await keys('register', '--adapter', 'local-dev', '--credential', cred, '--tenant', t.tenantId);
    await keys('activate', '--tenant', t.tenantId, '--keyid', key.keyid);
    await keys('publish', '--tenant', t.tenantId);
  }

  clock.offsetMs = 0;
  const resolver = inventorySignerResolver(pgTrustStore(db as unknown as TrustDb), await adaptersFromEnv(env), trustConfigFromEnv(env));
  const anchoring = await anchorFromEnv(env, { rekorFetch: rekor.fetch, tsaFetch: tsa.fetch });
  /** One statement for the tenant, stamped `ageMin` minutes ago, signed through `signer` (default: the inventory). */
  const statement = async (t: Tenant, repo: 'r1' | 'r2', ageMin: number, signer: SignerResolver = resolver) => {
    const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, t.repos[repo], sha())] });
    check(errors.length === 0, `${t.label}: ingestion`);
    const stamp = new Date(Date.now() - ageMin * MIN);
    const options: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef',
      deps: { chain: (tx, input) => chainStatement(tx, input, () => stamp) } };
    const pass = await runBuilderPass(db, signer, options);
    check(pass.failed === 0 && pass.retried === 0 && pass.done === 1, `builder pass: ${JSON.stringify(pass.codes)}`);
    const r = await pool.query(`select max(seq)::int as seq from attesta_records where tenant_id = $1`, [t.tenantId]);
    return Number(r.rows[0].seq);
  };
  const anchorPass = async (t: Tenant, nowMs = Date.now()) => {
    rekor.clock = Math.floor(Date.now() / 1000);
    return runAnchorPass(db, { anchor: anchoring.anchor, now: () => new Date(nowMs) }, { tenantId: t.tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
  };
  const anchorAll = async (t: Tenant) => {
    const r = await anchorPass(t);
    check(r.tenantErrors === 0 && r.batchesAnchored >= 1, `anchoring pass: ${JSON.stringify(r)}`);
  };
  return { a, b, c, k, rekor, keys, statement, anchorPass, anchorAll };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

async function verify(base: string, t: Tenant): Promise<ChainReport> {
  const res = await fetch(`${base}/api/attesta/verify`, { headers: { authorization: `Bearer ${token(t, `admin-${t.label}`)}` } });
  check(res.status === 200 && res.headers.get('cache-control') === 'no-store', `verify ${t.label}: ${res.status}`);
  return await res.json() as ChainReport;
}
const keyBreaks = (r: ChainReport) => r.breaks.filter((b) => b.detail_code === 'ATTESTA_VERIFY_KEY_NOT_VALID_AT').map((b) => b.seq);
const summary = (r: ChainReport) => JSON.stringify({ ok: r.ok, signatures: r.signatures, breaks: r.breaks.slice(0, 5), warnings: r.warnings, anchors: r.anchors });

async function it01(base: string, w: World): Promise<void> {
  const s0 = await w.statement(w.a, 'r1', 50);
  const s1 = await w.statement(w.a, 'r2', 40);
  await w.anchorAll(w.a);
  let r = await verify(base, w.a);
  check(r.ok && r.signatures === 'checked' && r.anchors.status === 'checked', `before rotation: ${summary(r)}`);
  await sleep(1100);
  // Rotate with the CLI: a2 replaces a1 (a1 retired now), then publish the key set.
  await w.keys('register', '--adapter', 'local-dev', '--credential', 'dev:a2', '--tenant', w.a.tenantId);
  await w.keys('activate', '--tenant', w.a.tenantId, '--keyid', w.k.a2.keyid, '--replace');
  await w.keys('publish', '--tenant', w.a.tenantId);
  r = await verify(base, w.a);
  check(r.ok, `old key's statements anchored before its retirement verify: ${summary(r)}`);
  const s2 = await w.statement(w.a, 'r1', 0); // signed by a2 through the inventory
  await sleep(1100);
  // A rogue signer still holding the retired key signs after revoked_at.
  const rogue = devSignerResolver({ credentials: [{ credentialId: 'dev:rogue-a1', tenantId: w.a.tenantId, privateKeyPem: w.k.a1.pem }] });
  const s3 = await w.statement(w.a, 'r2', 0, rogue);
  const signedBy = await pool.query(`select keyid from attesta_envelopes e join attesta_records r on r.tenant_id = e.tenant_id and r.id = e.record_id
    where r.tenant_id = $1 and r.seq = $2`, [w.a.tenantId, s3]);
  check(signedBy.rows[0]?.keyid === w.k.a1.keyid, 'the rogue statement carries the retired keyid');
  r = await verify(base, w.a);
  check(!r.ok && JSON.stringify(keyBreaks(r)) === JSON.stringify([s3]), `recorded after revoked_at, not anchored: KEY_NOT_VALID_AT on ${s3} only: ${summary(r)}`);
  await sleep(1100);
  await w.anchorAll(w.a);
  r = await verify(base, w.a);
  check(!r.ok && JSON.stringify(keyBreaks(r)) === JSON.stringify([s3]) && r.anchors.status === 'checked' && r.anchors.anchored === 4,
    `anchored after revoked_at: still KEY_NOT_VALID_AT on ${s3} only: ${summary(r)}`);
  console.log(`it01_old_key_seqs=${s0},${s1} new_key_seq=${s2} rogue_seq=${s3} key_not_valid_at=${keyBreaks(r).length}`);
  console.log('IT-T15i3-01=passed');
}

async function it02(base: string, w: World): Promise<void> {
  const s0 = await w.statement(w.c, 'r1', 30);
  const s1 = await w.statement(w.c, 'r2', 20);
  await w.anchorAll(w.c);
  await sleep(1100);
  const compromisedSince = new Date();
  await sleep(1100);
  const s2 = await w.statement(w.c, 'r1', 0);
  await w.anchorAll(w.c);
  let r = await verify(base, w.c);
  check(r.ok, `before the revocation: ${summary(r)}`);
  await sleep(1100);
  await w.keys('revoke', '--tenant', w.c.tenantId, '--keyid', w.k.c1.keyid, '--reason', 'compromised', '--compromised-since', compromisedSince.toISOString());
  await w.keys('publish', '--tenant', w.c.tenantId);
  r = await verify(base, w.c);
  check(!r.ok && JSON.stringify(keyBreaks(r)) === JSON.stringify([s2]) && r.breaks.length === 1,
    `anchored before compromised_since pass (${s0}, ${s1}); after it breaks (${s2}): ${summary(r)}`);
  console.log(`it02_before=${s0},${s1} after=${s2} key_not_valid_at=1`);
  console.log('IT-T15i3-02=passed');
}

/** attesta:anchor-resume as the operator runs it (a child process, DATABASE_URL from the environment). */
function resumeCli(...argv: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(__dirname, 'attesta-anchor-resume-cli.ts'), ...argv],
    { env: process.env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function refused(client: PoolClient, label: string, code: string, statement: string, params: unknown[]): Promise<void> {
  await client.query('savepoint attack');
  let error: { code?: string } | null = null;
  try {
    await client.query(statement, params);
  } catch (e) {
    error = e as { code?: string };
  }
  await client.query('rollback to savepoint attack');
  check(error !== null, `${label}: the database accepted it`);
  check(error.code === code, `${label}: expected ${code}, got ${String(error.code)}`);
}

/** Runs `fn` on one connection as an RLS-bound role that sees only `bound`'s rows; rolled back. */
async function asRlsRole(bound: Tenant, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`create role ${APP_ROLE} nologin nosuperuser nobypassrls`);
    await client.query(`grant usage on schema public to ${APP_ROLE}`);
    await client.query(`grant select, insert, update, delete, truncate on attesta_anchor_resumes, attesta_anchor_batches, attesta_anchors to ${APP_ROLE}`);
    for (const table of ['attesta_anchor_resumes', 'attesta_anchor_batches', 'attesta_anchors']) {
      await client.query(`create policy it_t15i3_tenant on ${table} for all to ${APP_ROLE}
        using (tenant_id = current_setting('it_t15i3.tenant')::uuid) with check (tenant_id = current_setting('it_t15i3.tenant')::uuid)`);
    }
    await client.query(`select set_config('it_t15i3.tenant', $1, true)`, [bound.tenantId]);
    await client.query(`set local role ${APP_ROLE}`);
    await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const resumeInsert = `insert into attesta_anchor_resumes (tenant_id, batch_id, actor, reason, request_id) values ($1, $2, 'it-attacker', 'again', 'it-req')`;

async function it03and04(base: string, w: World): Promise<void> {
  const { a, b } = w;
  await w.statement(b, 'r1', 10);
  await w.statement(b, 'r2', 5);
  // Stop: the log refuses the entry (HTTP 400 → LOG_REJECTED, terminal).
  w.rekor.failStatus = 400;
  let p = await w.anchorPass(b);
  check(p.codes.ATTESTA_ANCHOR_LOG_REJECTED === 1, `stopped by LOG_REJECTED: ${JSON.stringify(p.codes)}`);
  const batch = `${b.tenantId}:0-1`;
  p = await w.anchorPass(b, Date.now() + 2 * 3_600_000);
  check(p.tenants === 0, 'a stopped batch makes no work, however late');

  // --- IT-T15i3-04 (A/B) while B's batch is stopped: A cannot resume it.
  let c = resumeCli('--tenant', a.tenantId, '--batch', batch, '--actor', 'it-a', '--reason', 'not mine', '--confirm=RESUME');
  check(c.code === 1 && /another tenant/.test(c.err), `CLI scope: ${c.err}`);
  check(await pgResumeStore(db as unknown as WorkerDatabase).batchState(a.tenantId, batch) === null, "A's store view has no B batch");
  const api = await pool.connect();
  try {
    await api.query('begin');
    await refused(api, 'api-role A resumes B\'s batch', 'ATG01', resumeInsert, [a.tenantId, batch]);
    await api.query('rollback');
  } finally {
    api.release();
  }
  await asRlsRole(a, async (client) => {
    await refused(client, 'rls-role A resumes B\'s batch under A', 'ATG01', resumeInsert, [a.tenantId, batch]);
    await refused(client, 'rls-role A writes a resume row for B', '42501', resumeInsert, [b.tenantId, batch]);
  });
  const aWindows = await publishedKeyWindowsFor(pgTrustStore(db as unknown as TrustDb), a.tenantId, trustConfigFromEnv(process.env));
  const bWindows = await publishedKeyWindowsFor(pgTrustStore(db as unknown as TrustDb), b.tenantId, trustConfigFromEnv(process.env));
  check(aWindows !== null && aWindows.every((x) => x.keyid === w.k.a1.keyid || x.keyid === w.k.a2.keyid), "A's windows are A's keys only");
  check(bWindows !== null && bWindows.length === 1 && bWindows[0].keyid === w.k.b1.keyid, "B's windows are B's key only");
  const rr = await verify(base, b);
  // B's records are inside the anchoring window (pending), so the report is ok with B's own key set.
  check(rr.ok && rr.signatures === 'checked' && rr.anchors.status === 'checked' && rr.anchors.pending === 2, `B verifies with its own key set: ${summary(rr)}`);
  console.log('IT-T15i3-04=passed');

  // --- IT-T15i3-03: dry run, apply, audit, one resume per stop, anchoring resumes.
  c = resumeCli('--tenant', b.tenantId, '--batch', batch, '--actor', 'it-operator', '--reason', 'log fixed upstream');
  check(c.code === 0 && /mode=dry-run/.test(c.out) && /records=2/.test(c.out) && /terminal_code=ATTESTA_ANCHOR_LOG_REJECTED/.test(c.out), `dry run: ${c.out} ${c.err}`);
  check((await pool.query(`select count(*)::int as n from attesta_anchor_resumes where tenant_id = $1`, [b.tenantId])).rows[0].n === 0, 'a dry run writes nothing');
  c = resumeCli('--tenant', b.tenantId, '--batch', batch, '--actor', 'it-operator', '--reason', 'log fixed upstream', '--confirm=RESUME');
  check(c.code === 0 && /mode=apply/.test(c.out), `apply: ${c.out} ${c.err}`);
  const audit = await pool.query(`select actor_type, actor_id, target_type, target_id, details from security_audit_events
    where tenant_id = $1 and action = 'attesta.anchor.resume'`, [b.tenantId]);
  const reqId = /request_id=(\S+)/.exec(c.out)?.[1];
  check(audit.rows.length === 1 && audit.rows[0].actor_type === 'system_operator' && audit.rows[0].actor_id === 'it-operator'
    && audit.rows[0].target_id === batch && audit.rows[0].details.request_id === reqId
    && audit.rows[0].details.terminal_code === 'ATTESTA_ANCHOR_LOG_REJECTED' && audit.rows[0].details.records === 2, 'one audit row');
  const row = await pool.query(`select request_id from attesta_anchor_resumes where tenant_id = $1 and batch_id = $2`, [b.tenantId, batch]);
  check(row.rows.length === 1 && row.rows[0].request_id === reqId, 'one resume row with the request id');
  // A second resume for the same stop: the CLI, the API role and an RLS-bound role are refused.
  c = resumeCli('--tenant', b.tenantId, '--batch', batch, '--actor', 'it-operator', '--reason', 'again', '--confirm=RESUME');
  check(c.code === 1 && /already resumed/.test(c.err), `second CLI resume: ${c.err}`);
  const api2 = await pool.connect();
  try {
    await api2.query('begin');
    await refused(api2, 'api-role second resume', 'ATG01', resumeInsert, [b.tenantId, batch]);
    await refused(api2, 'api-role update', 'ATG01', `update attesta_anchor_resumes set reason = 'x' where tenant_id = $1`, [b.tenantId]);
    await refused(api2, 'api-role delete', 'ATG01', `delete from attesta_anchor_resumes where tenant_id = $1`, [b.tenantId]);
    await refused(api2, 'api-role truncate', 'ATG01', `truncate attesta_anchor_resumes`, []);
    await api2.query('rollback');
  } finally {
    api2.release();
  }
  await asRlsRole(b, async (client) => {
    await refused(client, 'rls-role second resume', 'ATG01', resumeInsert, [b.tenantId, batch]);
    await refused(client, 'rls-role delete', 'ATG01', `delete from attesta_anchor_resumes where tenant_id = $1`, [b.tenantId]);
  });
  // Resumed but the log still refuses: retried once (after the normal backoff), then stopped again.
  p = await w.anchorPass(b, Date.now() + 2 * MIN);
  check(p.codes.ATTESTA_ANCHOR_LOG_REJECTED === 1 && p.batchesAnchored === 0, `retried once after the resume: ${JSON.stringify(p)}`);
  p = await w.anchorPass(b, Date.now() + 2 * 3_600_000);
  check(p.tenants === 0, 'a new terminal failure stops it again');
  // The new stop is resumable once more; the guard stamps created_at itself (a future date is ignored).
  const ins = await pool.query(`insert into attesta_anchor_resumes (tenant_id, batch_id, actor, reason, request_id, created_at)
    values ($1, $2, 'it-operator', 'second stop', 'it-req-2', '2099-01-01T00:00:00Z') returning created_at`, [b.tenantId, batch]);
  check(new Date(ins.rows[0].created_at).getTime() < Date.now() + MIN, 'created_at is the database clock, not the caller\'s');
  w.rekor.failStatus = null;
  p = await w.anchorPass(b, Date.now() + 10 * MIN);
  check(p.batchesAnchored === 1 && p.tenantErrors === 0, `anchors on the next pass: ${JSON.stringify(p)}`);
  const v = await verify(base, b);
  check(v.ok && v.anchors.status === 'checked' && v.anchors.anchored === 2, `B verifies ok after the resume: ${summary(v)}`);
  c = resumeCli('--tenant', b.tenantId, '--batch', batch, '--actor', 'it-operator', '--reason', 'anchored now');
  check(c.code === 1 && /anchored/.test(c.err), `an anchored batch is not resumable: ${c.err}`);
  const rls = await pool.query(`select relrowsecurity, (select count(*)::int from pg_policies where tablename = 'attesta_anchor_resumes') as policies
    from pg_class where relname = 'attesta_anchor_resumes'`);
  check(rls.rows[0].relrowsecurity === true && rls.rows[0].policies === 0, 'RLS on, no policies');
  console.log('it03_resumes=2 audits=1 stops=2 anchored=2');
  console.log('IT-T15i3-03=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t15i3-'));
  const jwks = await startJwks();
  process.env.SUPABASE_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const servers: Server[] = [jwks];
  try {
    const { authenticateJWT } = await import('../../core/middleware/auth');
    const { tenantMiddleware } = await import('../../core/middleware/tenant');
    const w = await makeWorld(dir);
    for (const t of [w.a, w.b, w.c]) await grant(t, `admin-${t.label}`, 'tenant_admin');
    const app = express();
    app.use(express.json());
    app.use('/api', authenticateJWT, tenantMiddleware);
    app.use('/api/attesta', createAttestaRouter());
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await it01(base, w);
    await it02(base, w);
    await it03and04(base, w);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15i3 failed');
  process.exitCode = 1;
});
