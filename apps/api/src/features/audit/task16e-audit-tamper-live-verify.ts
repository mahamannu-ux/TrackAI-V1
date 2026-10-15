/**
 * IT-T16e-01…02: audit seals and the signed audit export (Task16e, A16.4 + A16.7) against
 * real PostgreSQL (migration 0023), through the real routes behind the real JWT and tenant
 * middleware, with the trust inventory set up by the attesta:keys CLI and seals signed through
 * inventorySignerResolver (as IT-T15i4). Anchoring is not configured here (the anchor path is
 * Attesta's own, proven by IT-T15f2/T15i2): reports say anchors were not checked.
 *
 *   scripts/it-db.sh npm run verify:task16e-audit-tamper-live -w apps/api
 *
 * 01 seal and verify: a first seal over all history, then an empty contiguous seal; the verify
 *    report is ok and /api/attesta/verify is ok over the chain with the seal records; then, as
 *    the database owner with the guard trigger off, one row deleted, one row's details changed
 *    and one row inserted back-dated into the sealed window: the report lists exactly those
 *    three breaks. TRUNCATE of the trail and an UPDATE of a seal are refused; a seal that does
 *    not follow the latest is refused by the 0023 insert guard.
 * 02 export: request (202), replay (202, replayed), another scope with the key (409), ready,
 *    download; the signature verifies with the trust layer (verifyTrusted, the root pinned by
 *    the caller); every section digest matches; every sealed window's events match its seal;
 *    Company B gets the same 404 for A's export as for an unknown id; the audits are written.
 *
 * Prints only safe summary lines.
 */
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { db, pool } from '../../core/db';
import { recordAuditEvent } from '../../core/audit/record';
import { ATTESTA_PLATFORM_TENANT_ID } from '../attesta/anchor-contract';
import { main as keysMain } from '../attesta/attesta-keys-cli';
import { main as rootMain } from '../attesta/attesta-trust-root-cli';
import { createAttestaRouter } from '../attesta/attesta.routes';
import {
  auditRowDigest, pgSealStore, runAuditSealPass, type SealDatabase, type SealDocument, type StoredAuditRow,
} from '../attesta/audit-seal-service';
import { canonicalize, sha256Prefixed } from '../attesta/canonical';
import type { DsseEnvelope } from '../attesta/dsse';
import { keyidOf } from '../attesta/trust-documents';
import { verifyTrusted } from '../attesta/trust-contract';
import { pgTrustStore, type TrustDb } from '../attesta/trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from '../attesta/trust-resolver';
import { createAuditRouter } from './audit.routes';
import { AUDIT_EXPORT_PAYLOAD_TYPE } from './export-service';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T16e failed: ${message}`);
}

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; domain: string }
async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t16e-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, `${slug}.example`, slug]);
  return { label, tenantId, domain: `${slug}.example` };
}

const JWT_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'it-t16e';
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
    values ($1, $2, $3, $4, 'active', 'it-t16e')`, [t.tenantId, subject, `${subject}@${t.domain}`, role]);
}

interface Res { status: number; headers: Headers; body: any; text: string }
function client(base: string) {
  const call = async (method: string, path: string, bearer: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    check(res.headers.get('cache-control') === 'no-store', `${method} ${path}: no-store (${res.status})`);
    return { status: res.status, headers: res.headers, body: parsed, text };
  };
  return {
    get: (path: string, bearer: string) => call('GET', path, bearer),
    post: (path: string, bearer: string, body: unknown, headers?: Record<string, string>) => call('POST', path, bearer, body, headers),
  };
}
type Api = ReturnType<typeof client>;

// ---------------------------------------------------------------------------
// The world: trust inventory by CLI (IT-T15i4's setup without anchoring)

async function makeWorld(dir: string) {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const creds = [['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:b1', b.tenantId, k.b1]] as const;
  const exportDir = join(dir, 'exports');
  mkdirSync(exportDir, { mode: 0o700 });
  Object.assign(process.env, {
    ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid,
    ATTESTA_DEV_CREDENTIALS_FILE: file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
      ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) })))),
    TASK4_EXPORT_DIR: exportDir,
    TRACKAI_GIT_COMMIT: '0123456789abcdef',
  });
  const env = process.env;
  const out: string[] = [];
  const err: string[] = [];
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
  return { a, b, k, resolver };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

/** Writes `n` audit rows through the one emitter, then back-dates them as the database owner. */
async function backdatedRows(t: Tenant, n: number, startMin: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    await recordAuditEvent(db, t.tenantId, {
      action: 'audit.events.read', actorType: 'tenant_auditor', actorId: `auditor-${t.label}`,
      targetType: 'security_audit_events', targetId: t.tenantId,
      details: { limit: 50, returned: i, filters: ['from'], request_id: `it-t16e-${i}` },
    });
    const r = await pool.query(`select id::text as id from security_audit_events where tenant_id = $1 order by occurred_at desc, id desc limit 1`, [t.tenantId]);
    ids.push(r.rows[0].id);
  }
  await asOwner(async () => {
    for (const [i, rowId] of ids.entries()) {
      await pool.query(`update security_audit_events set occurred_at = now() - make_interval(mins => $2) + make_interval(secs => $3::double precision / 1000000)
        where id = $1`, [rowId, startMin, i * 1000 + 7]);
    }
  });
  return ids;
}

/** Runs `fn` with the audit trail's guard trigger off (only the throwaway database's owner can). */
async function asOwner(fn: () => Promise<void>): Promise<void> {
  await pool.query(`alter table security_audit_events disable trigger security_audit_events_immutable`);
  try {
    await fn();
  } finally {
    await pool.query(`alter table security_audit_events enable trigger security_audit_events_immutable`);
  }
}

async function sealNow(w: World, t: Tenant): Promise<string> {
  const r = await runAuditSealPass({ store: pgSealStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: '0.1.0+0123456789abcdef', actor: { type: 'service', id: 'it-t16e-worker' }, log: () => undefined }, { tenantIds: [t.tenantId] });
  return r[0].outcome + (r[0].code ? `:${r[0].code}` : '');
}

/** Ages the tenant's seals as the database owner, so the next pass is due (the cadence is unit-tested). */
async function ageSeals(t: Tenant, hours: number): Promise<void> {
  await pool.query(`alter table attesta_audit_seals disable trigger attesta_audit_seals_append_only`);
  try {
    await pool.query(`update attesta_audit_seals set created_at = created_at - make_interval(hours => $2) where tenant_id = $1`, [t.tenantId, hours]);
  } finally {
    await pool.query(`alter table attesta_audit_seals enable trigger attesta_audit_seals_append_only`);
  }
}

async function refused(sqlText: string, params: unknown[], label: string): Promise<void> {
  try {
    await pool.query(sqlText, params);
  } catch {
    return;
  }
  throw new Error(`IT-T16e failed: ${label} was not refused`);
}

// ---------------------------------------------------------------------------

async function it01(api: Api, w: World): Promise<void> {
  const t = w.a;
  const ids = await backdatedRows(t, 4, 180);
  check(await sealNow(w, t) === 'sealed', 'the first seal covers all history');
  check(await sealNow(w, t) === 'not_due', 'a second pass right away is not due');
  await ageSeals(t, 25);
  check(await sealNow(w, t) === 'sealed', 'a day later an empty window is sealed');
  const seals = (await pool.query(`select window_from, window_to, row_count, previous_digest, seal_digest from attesta_audit_seals
    where tenant_id = $1 order by window_from`, [t.tenantId])).rows;
  check(seals.length === 2 && seals[0].row_count === 4 && seals[0].previous_digest === null, 'first seal: four rows, no previous');
  check(seals[1].row_count === 0 && seals[1].previous_digest === seals[0].seal_digest && seals[1].window_from === seals[0].window_to,
    'the empty seal is contiguous and linked');
  const sealedAudits = (await pool.query(`select count(*)::int as n from security_audit_events where tenant_id = $1 and action = 'audit.trail.sealed'`,
    [t.tenantId])).rows[0].n;
  check(sealedAudits === 2, 'each seal writes audit.trail.sealed');

  const auditor = token(t, `auditor-${t.label}`);
  const q = `/api/audit/verify?from=${encodeURIComponent(iso(Date.now() - 4 * 60 * MIN))}&to=${encodeURIComponent(iso(Date.now()))}`;
  const clean = await api.get(q, auditor);
  check(clean.status === 200 && clean.body.ok === true && clean.body.seals_checked === 2 && clean.body.breaks.length === 0,
    `a clean trail verifies: ${clean.text.slice(0, 300)}`);
  check(clean.body.chain.checked === 2 && clean.body.unsealed_tail.count >= 2, 'both seal records checked; the seal events are the unsealed tail');
  const chain = await api.get('/api/attesta/verify', auditor);
  check(chain.status === 200 && chain.body.ok === true && chain.body.signatures === 'checked', `/api/attesta/verify over the seal records: ${chain.text.slice(0, 300)}`);

  // Tamper as the owner: delete one row, change another, insert one back-dated into the sealed window.
  await asOwner(async () => {
    await pool.query(`delete from security_audit_events where id = $1`, [ids[0]]);
    await pool.query(`update security_audit_events set details = details || '{"returned": 99}'::jsonb where id = $1`, [ids[1]]);
  });
  const [late] = await backdatedRows(t, 1, 170);
  const tampered = await api.get(q, auditor);
  const kinds = (tampered.body.breaks as Array<{ kind: string; row_id?: string }>).map((b) => `${b.kind}:${b.row_id}`).sort();
  check(tampered.status === 200 && tampered.body.ok === false, 'a tampered trail does not verify');
  check(JSON.stringify(kinds) === JSON.stringify([`changed_row:${ids[1]}`, `missing_row:${ids[0]}`, `unsealed_row_in_sealed_window:${late}`].sort()),
    `exactly the three breaks: ${JSON.stringify(kinds)}`);
  const verified = (await pool.query(`select details from security_audit_events where tenant_id = $1 and action = 'audit.trail.verified'
    order by occurred_at`, [t.tenantId])).rows;
  check(verified.length === 2 && verified[1].details.ok === false && verified[1].details.break_count === 3, 'each report writes audit.trail.verified');

  await refused(`truncate security_audit_events`, [], 'TRUNCATE of the audit trail');
  await refused(`truncate attesta_audit_seals cascade`, [], 'TRUNCATE of the seals');
  await refused(`update attesta_audit_seals set row_count = row_count where tenant_id = $1`, [t.tenantId], 'UPDATE of a seal');
  await refused(`delete from attesta_audit_seals where tenant_id = $1`, [t.tenantId], 'DELETE of a seal');
  // A seal row that does not follow the latest (here: no record, wrong previous) is refused by the insert guard.
  const doc = canonicalize({ format: 'https://trackai.dev/attesta/audit-seal-document/v1', tenant_id: t.tenantId,
    window: { from: seals[0].window_from, to: seals[0].window_to }, previous: null, catalog_version: 2, count: 0, rows: [],
    rows_root: sha256Prefixed(Buffer.alloc(0)) });
  await refused(`insert into attesta_audit_seals (tenant_id, window_from, window_to, row_count, previous_digest, seal_document, seal_digest,
    record_id, statement_digest) select $1, $2, $3, 0, null, $4, $5, r.id, r.statement_digest from attesta_records r where r.tenant_id = $1 limit 1`,
  [t.tenantId, seals[0].window_from, seals[0].window_to, doc, sha256Prefixed(doc)], 'a second first seal');
  console.log('seals=2 clean_report=ok tampered_breaks=3 truncate=refused seal_update_delete=refused');
  console.log('IT-T16e-01=passed');
}

async function waitReady(api: Api, bearer: string, id: string): Promise<any> {
  for (let i = 0; i < 150; i++) {
    const r = await api.get(`/api/audit/exports/${id}`, bearer);
    check(r.status === 200, `status ${r.status}`);
    if (r.body.status === 'ready' || r.body.status === 'failed') return r.body;
    await sleep(100);
  }
  throw new Error('IT-T16e failed: the export job did not finish in 15 s');
}

async function it02(api: Api, w: World): Promise<void> {
  const t = w.b;
  await backdatedRows(t, 3, 120);
  check(await sealNow(w, t) === 'sealed', 'B: the first seal');
  await backdatedRows(t, 2, 1); // newer than the seal: unsealed
  const auditor = token(t, `auditor-${t.label}`);
  const scope = { from: iso(Date.now() - 6 * 60 * MIN), to: iso(Date.now()) };
  const first = await api.post('/api/audit/exports', auditor, scope, { 'Idempotency-Key': 'it-t16e-export-1' });
  check(first.status === 202 && first.body.replayed === false, `POST 202: ${first.text.slice(0, 200)}`);
  const replay = await api.post('/api/audit/exports', auditor, scope, { 'Idempotency-Key': 'it-t16e-export-1' });
  check(replay.status === 202 && replay.body.replayed === true && replay.body.id === first.body.id, 'replay returns the same job');
  const conflict = await api.post('/api/audit/exports', auditor, { ...scope, from: iso(Date.now() - 7 * 60 * MIN) }, { 'Idempotency-Key': 'it-t16e-export-1' });
  check(conflict.status === 409 && conflict.body.code === 'AUDIT_EXPORT_CONFLICT', 'another scope with the key is 409');
  const tooLong = await api.post('/api/audit/exports', auditor, { from: iso(Date.now() - 400 * 86_400_000), to: iso(Date.now()) }, { 'Idempotency-Key': 'it-t16e-export-2' });
  check(tooLong.status === 400 && tooLong.body.code === 'AUDIT_FILTER_INVALID', 'more than a year is 400');
  const status = await waitReady(api, auditor, first.body.id);
  check(status.status === 'ready', `export ready: ${status.error_code}`);

  const content = await api.get(`/api/audit/exports/${first.body.id}/content`, auditor);
  check(content.status === 200 && content.headers.get('content-disposition')?.includes('attachment'), 'content is an attachment');
  const { export: ex, signature } = content.body as { export: any; signature: DsseEnvelope };
  const exportDigest = sha256Prefixed(canonicalize(ex));
  check(exportDigest === status.export_digest, 'the export digest matches the job');
  for (const name of ['events', 'seals', 'seal_evidence']) {
    check(ex.manifest.sections[name] === sha256Prefixed(canonicalize(ex[name])), `${name} section digest`);
  }
  const payload = Buffer.from(signature.payload, 'base64');
  check(signature.payloadType === AUDIT_EXPORT_PAYLOAD_TYPE
    && payload.toString('utf8') === canonicalize({ manifest: ex.manifest, export_digest: exportDigest }), 'the signed payload names the export');
  const verdict = verifyTrusted({
    payloadType: AUDIT_EXPORT_PAYLOAD_TYPE, payload, envelope: signature, purpose: 'statement', audience: t.tenantId,
    signedAt: ex.manifest.generated_at,
    state: { pinnedRootKeyids: [w.k.root.keyid], rootDocuments: ex.seal_evidence.trust.root_documents,
      keysetDocuments: { [t.tenantId]: ex.seal_evidence.trust.keyset_documents }, lastTrusted: {}, now: new Date().toISOString(), production: true },
  });
  check(verdict.status === 'verified', `the signature verifies with the trust layer: ${JSON.stringify(verdict).slice(0, 200)}`);
  check(ex.seals.length === 1 && ex.manifest.counts.sealed_events === 3 && ex.manifest.counts.unsealed_events >= 2, 'counts');
  for (const s of ex.seals as Array<{ seal_digest: string; document: string }>) {
    check(sha256Prefixed(s.document) === s.seal_digest, 'seal document digest');
    const d = JSON.parse(s.document) as SealDocument;
    const inWindow = (ex.events as StoredAuditRow[]).filter((e) => e.occurred_at >= d.window.from && e.occurred_at < d.window.to);
    check(JSON.stringify(inWindow.map((e) => [e.id, auditRowDigest(e)])) === JSON.stringify(d.rows.map((r) => [r.id, r.digest])),
      'the window\'s events are exactly the sealed rows');
  }
  check(ex.seal_evidence.statements.length === 1 && ex.seal_evidence.records.length === 1, 'seal evidence for the seal record only');

  // Company A cannot see B's export: the same 404 as an unknown id.
  const aAuditor = token(w.a, `auditor-${w.a.label}`);
  const theirs = await api.get(`/api/audit/exports/${first.body.id}`, aAuditor);
  const none = await api.get(`/api/audit/exports/${randomUUID()}`, aAuditor);
  const theirsContent = await api.get(`/api/audit/exports/${first.body.id}/content`, aAuditor);
  check(theirs.status === 404 && none.status === 404 && theirsContent.status === 404 && theirs.body.code === 'AUDIT_EXPORT_NOT_FOUND'
    && theirs.body.title === none.body.title, 'another tenant\'s export is the same 404');
  const audits = (await pool.query(`select action, details from security_audit_events where tenant_id = $1 and action like 'audit.export.%'
    order by occurred_at`, [t.tenantId])).rows;
  check(audits.filter((r) => r.action === 'audit.export.requested').length === 2
    && audits.filter((r) => r.action === 'audit.export.downloaded').length === 1, 'requested ×2 (created, replay) and downloaded ×1 audited');
  console.log(`export_events=${ex.events.length} seals=${ex.seals.length} signature=verified sections=match company_b=404`);
  console.log('IT-T16e-02=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const dir = mkdtempSync(join(tmpdir(), 'it-t16e-'));
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
    app.use('/api/audit', createAuditRouter());
    const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const api = client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await it01(api, w);
    await it02(api, w);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T16e failed');
  process.exitCode = 1;
});
