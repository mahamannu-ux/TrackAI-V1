/**
 * IT-T15l-01…04: the Attesta trust inventory against real PostgreSQL (migration 0019
 * guards), through the real environment path: the attesta:keys CLI with
 * DATABASE_URL, ATTESTA_TRUST_ROOT_KEYIDS and ATTESTA_DEV_CREDENTIALS_FILE (dev
 * signers; the KMS run is A15.13), the builder worker, and anchoring with the
 * in-process Rekor and TSA fakes.
 *
 *   scripts/it-db.sh npm run verify:task15l2-trust-live -w apps/api
 *
 * 01 root (dev keys) exported, signed offline, imported → tenant key registered with
 *    proof of possession → activated → published → the builder signs with
 *    inventorySignerResolver, anchoring signs with platformSigner('anchor') →
 *    verifyChain with publishedKeysFor keys is ok with signatures checked; each stored
 *    key set passes the verifier's document checks and the statement verifies.
 * 02 rotation with overlap: statements signed before and after verify (the old key's
 *    through the record's anchor time as timeEvidence); the retired key is never
 *    resolved for new signing.
 * 03 revoke compromised: anchored before compromised_since → verified, later →
 *    rejected; dry run changes nothing, confirm writes events and one audit row; the
 *    guards refuse status going back, a mutated spki_der, a document whose version or
 *    previous does not follow, a keyid reused by another tenant, a key inserted
 *    active, deletes and truncates, and every UPDATE without its event row (checked at
 *    commit), as the API role and an RLS-bound role; definer settings; RLS on.
 * 04 Company A/B: B cannot register, see, resolve, activate or publish A's keys; A's
 *    key set never lists B's keys; A's statement does not verify for B.
 * Prints only safe summary lines (counts, codes, versions).
 */
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { db, pool } from '../../core/db';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { DualAnchor } from './anchor-dual';
import { platformAnchorKeysFromEnv, platformAnchorSignerFromEnv } from './anchor-env';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { runAnchorPass } from './anchor-worker';
import { main as keysMain } from './attesta-keys-cli';
import { main as rootMain } from './attesta-trust-root-cli';
import { sha256Prefixed } from './canonical';
import type { DsseEnvelope } from './dsse';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { KEYSET_PAYLOAD_TYPE, KEYSET_TYPE, verifyTrusted, type TimeEvidence, type TrustCode } from './trust-contract';
import { keyidOf, parseTrustDocument } from './trust-documents';
import { checkDocumentChain, pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, publishedKeysFor, trustConfigFromEnv } from './trust-resolver';
import { verifyChain, type AnchorCheckOptions } from './verify-chain';
import { runBuilderPass, type BuilderPassOptions } from './worker';

const APP_ROLE = 'it_t15l2_app';
const OPTIONS: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef' };
const store = pgTrustStore(db as unknown as TrustDb);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15l2 failed: ${message}`);
}

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

interface Tenant { label: string; tenantId: string; repoUrl: string }

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15l2-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, `${slug}.example`, slug]);
  return { label, tenantId, repoUrl: `https://github.com/${slug}/service` };
}

/** A Git AI commit note through Task2's own ingestion (as IT-T15h-01): one pending outbox row. */
function commitEvent(t: Tenant, commitSha: string): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  const note = [`src/${t.label}/alpha.ts`, '  s_it::t_1 1-6', '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${t.label}`, model: 'model-x' } } } })].join('\n');
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 6, '3': ['opencode:model-x'], '5': [6], '11': 'IT synthetic commit', '13': note, '15': now - 60, '16': now - 30 },
    a: { '1': t.repoUrl, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${t.label}` },
  };
}

interface Rec { seq: number; recordId: string; recordedAt: string; payload: Buffer; envelope: DsseEnvelope; keyid: string }

async function records(tenantId: string): Promise<Rec[]> {
  const r = await pool.query(
    `select r.seq::int as seq, r.id::text as id, to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at,
       r.statement_canonical, e.envelope from attesta_records r join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
     where r.tenant_id = $1 order by r.seq`, [tenantId]);
  return r.rows.map((row) => ({ seq: row.seq, recordId: row.id, recordedAt: row.recorded_at, payload: Buffer.from(row.statement_canonical, 'utf8'),
    envelope: row.envelope, keyid: row.envelope.signatures[0].keyid }));
}

/** The record's Rekor anchor time (verified by verifyChain with anchors). */
async function anchorTime(t: Tenant, recordId: string): Promise<string> {
  const r = await pool.query(`select inclusion_proof from attesta_anchors where tenant_id = $1 and record_id = $2 and anchor_type = 'rekor'
    and status = 'anchored'`, [t.tenantId, recordId]);
  check(r.rows.length === 1, 'the record is anchored');
  return new Date(r.rows[0].inclusion_proof.anchor.rekor_entry.integratedTime * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// The world: tenants, keys, dev credentials file, CLI through the real environment
// ---------------------------------------------------------------------------

async function makeWorld() {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), a2: newKey(), b1: newKey() };
  const dir = mkdtempSync(join(tmpdir(), 'it-t15l2-'));
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text, { mode: 0o600 });
    return p;
  };
  const creds = [
    ['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:a2', a.tenantId, k.a2], ['dev:b1', b.tenantId, k.b1], ['dev:a1-for-b', b.tenantId, k.a1],
  ] as const;
  const devFile = file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
    ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) }))));
  const rootPem = file('root.pem', k.root.pem);
  const rootPub = file('root.pub', k.root.pubPem);
  const env: NodeJS.ProcessEnv = { ...process.env, ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid, ATTESTA_DEV_CREDENTIALS_FILE: devFile };
  const adapters = await adaptersFromEnv(env);
  const config = trustConfigFromEnv(env);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    readFile: (p: string) => readFileSync(p, 'utf8'),
    writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, now: () => new Date(),
  };
  const cli = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await keysMain(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const apply = async (...argv: string[]) => {
    const dry = await cli(...argv);
    check(dry.code === 0, `dry run ${argv[0]}: ${dry.err}`);
    const m = /--confirm=(\S+) --expect=(\d+)/.exec(dry.out);
    check(m, `dry run ${argv[0]} prints the apply flags`);
    const done = await cli(...argv, `--confirm=${m[1]}`, `--expect=${m[2]}`, '--actor', 'it-operator');
    check(done.code === 0, `apply ${argv[0]}: ${done.err}`);
    return done;
  };
  let draftN = 0;
  /** export-root-draft → offline sign (no DATABASE_URL) → import-root. */
  const rotateRoot = async (...flags: string[]) => {
    const n = ++draftN;
    const draft = join(dir, `draft${n}.json`);
    const prev = join(dir, `prev${n}.json`);
    const signed = join(dir, `root${n}.json`);
    const exp = await cli('export-root-draft', '--out', draft, ...(n === 1 ? ['--root-pub', rootPub] : ['--previous-out', prev]), ...flags);
    check(exp.code === 0, `export-root-draft: ${exp.err}`);
    const offlineErr: string[] = [];
    const offline = { readFile: io.readFile, writeFile: io.writeFile, out: () => undefined, err: (l: string) => offlineErr.push(l), env: {}, now: () => new Date() };
    const code = await rootMain(['sign', '--draft', draft, '--key', rootPem, ...(n === 1 ? [] : ['--previous', prev]), '--out', signed], offline);
    check(code === 0, `offline sign: ${offlineErr.join(' ')}`);
    return apply('import-root', '--file', signed);
  };
  // Anchoring through the production code path: platformAnchorSignerFromEnv with the real store.
  const rekor = new FakeRekor();
  const tsa = await FakeTsa.create();
  const rekorLog = createPublicKey(rekor.logKey);
  const dual = async () => {
    const signer = await platformAnchorSignerFromEnv(env);
    return new DualAnchor(
      new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: rekorLog.export({ type: 'spki', format: 'pem' }).toString(), production: false }),
      new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch }));
  };
  // Verification material through the production path: every anchor key the latest verified root lists.
  const material = async (): Promise<AnchorCheckOptions> => ({
    rekorLogKey: rekorLog, anchorKeysSpkiDer: await platformAnchorKeysFromEnv(env),
    tsaAnchors: loadTrustAnchors(tsa.anchorsPem), now: new Date(),
  });
  const resolver = inventorySignerResolver(store, adapters, config);
  /** One new statement for `t`: Task2 ingestion → builder pass (inventory resolver) → anchor pass (inventory anchor key). */
  const anchorNow = async (t: Tenant) => {
    rekor.clock = Math.floor(Date.now() / 1000);
    const anchored = await runAnchorPass(db, { anchor: await dual() }, { tenantId: t.tenantId, partialAfterMs: 0 });
    check(anchored.batchesAnchored >= 1 && anchored.tenantErrors === 0, `anchor pass: ${JSON.stringify(anchored)}`);
  };
  const statement = async (t: Tenant, opts: { anchor?: boolean } = {}): Promise<Rec> => {
    const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, sha())] });
    check(errors.length === 0, `${t.label}: ingestion`);
    const pass = await runBuilderPass(db, resolver, OPTIONS);
    check(pass.failed === 0 && pass.retried === 0 && pass.done >= 1, `builder pass: ${JSON.stringify(pass.codes)}`);
    if (opts.anchor !== false) await anchorNow(t);
    const recs = await records(t.tenantId);
    return recs[recs.length - 1];
  };
  const docs = async (scope: string) => (await store.documents(scope)).map((d) => d.envelope);
  /** verifyTrusted for a stored statement, exactly as a consumer calls it (production, pinned root). */
  const verifyStatement = async (t: Tenant, rec: Rec, opts: { audience?: string; evidence?: string } = {}) => {
    const audience = opts.audience ?? t.tenantId;
    const timeEvidence: TimeEvidence | undefined = opts.evidence
      ? { kind: 'rekor_integrated_time', time: opts.evidence, binds: 'ledger_statement', digest: sha256Prefixed(rec.payload) } : undefined;
    return verifyTrusted({
      payloadType: rec.envelope.payloadType, payload: rec.payload, envelope: rec.envelope, purpose: 'statement', audience,
      signedAt: rec.recordedAt, timeEvidence,
      state: { pinnedRootKeyids: [k.root.keyid], rootDocuments: await docs('platform'),
        keysetDocuments: { [audience]: await docs(audience) }, lastTrusted: {}, now: new Date().toISOString(), production: true },
    });
  };
  return { a, b, k, dir, env, adapters, config, cli, apply, rotateRoot, statement, anchorNow, material, resolver, verifyStatement, docs };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

// ---------------------------------------------------------------------------

async function it01(w: World): Promise<Rec> {
  await w.apply('register', '--adapter', 'local-dev', '--credential', 'dev:anchor', '--purpose', 'anchor');
  await w.apply('register', '--adapter', 'local-dev', '--credential', 'dev:keyset', '--purpose', 'tenant_keyset');
  const imp = await w.rotateRoot('--add', w.k.anchor.keyid, '--add', w.k.keyset.keyid);
  check(/registered -> active/.test(imp.out), 'root import activates the platform keys');
  const reg = await w.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a1', '--tenant', w.a.tenantId);
  check(/proof of possession verified/.test(reg.out), 'registration proved possession');
  const pop = await pool.query(`select pop_digest, status from attesta_tenant_keys where keyid = $1`, [w.k.a1.keyid]);
  check(pop.rows[0].status === 'registered' && /^sha256:[0-9a-f]{64}$/.test(pop.rows[0].pop_digest), 'stored as registered with its proof digest');
  check(await w.resolver.resolve(w.a.tenantId) === null, 'a registered key is not resolved');
  await w.apply('activate', '--tenant', w.a.tenantId, '--keyid', w.k.a1.keyid);
  const window = await w.resolver.resolve(w.a.tenantId).then(() => 'resolved', (e: Error) => e.name);
  check(window === 'SigningUnavailable', `an activated key signs nothing until it is published: ${window}`);
  await w.apply('publish', '--tenant', w.a.tenantId);
  const s1 = await w.statement(w.a);
  check(s1.keyid === w.k.a1.keyid, 'the builder signed with the inventory key');
  const published = await publishedKeysFor(store, w.a.tenantId);
  const report = await verifyChain(db, w.a.tenantId, { keys: published.keys, anchors: await w.material() });
  check(report.ok && report.signatures === 'checked' && report.anchors.status === 'checked' && report.anchors.anchored === 1,
    `verifyChain: ${JSON.stringify({ breaks: report.breaks.slice(0, 3), anchors: report.anchors, signatures: report.signatures })}`);
  const v = await w.verifyStatement(w.a, s1);
  check(v.status === 'verified', `statement verifies with the stored documents: ${v.code}`);
  const ksets = await w.docs(w.a.tenantId);
  for (let n = 1; n <= ksets.length; n++) {
    check(checkDocumentChain(w.config, new Date(), await w.docs('platform'), { tenantId: w.a.tenantId, documents: ksets.slice(0, n) }) === null,
      `key set version ${n} passes the verifier's document checks`);
  }
  console.log(`it01_root_versions=${(await w.docs('platform')).length} keyset_versions=${ksets.length} verify_chain=ok signatures=checked anchored=1 statement=${v.code}`);
  console.log('IT-T15l-01=passed');
  return s1;
}

async function it02(w: World, s1: Rec): Promise<{ s2: Rec }> {
  await w.apply('register', '--adapter', 'local-dev', '--credential', 'dev:a2', '--tenant', w.a.tenantId);
  // A signed record that is not anchored yet blocks the rotation (it would never verify afterwards).
  await w.statement(w.a, { anchor: false });
  const blocked = await w.cli('activate', '--tenant', w.a.tenantId, '--keyid', w.k.a2.keyid, '--replace');
  check(blocked.code === 1 && /1 ledger records signed by key .* are not anchored yet/.test(blocked.err), `rotation waits for anchoring: ${blocked.err}`);
  await w.anchorNow(w.a);
  await sleep(2500); // the anchor times lie before the rotation instant
  const rot = await w.apply('activate', '--tenant', w.a.tenantId, '--keyid', w.k.a2.keyid, '--replace');
  check(/active -> retired/.test(rot.out) && /registered -> active/.test(rot.out), 'activate --replace retires the old key in the same transaction');
  const crashWindow = await w.resolver.resolve(w.a.tenantId).then(() => 'resolved', (e: Error) => e.name);
  check(crashWindow === 'SigningUnavailable', `between --replace and publish nothing signs: ${crashWindow}`);
  await w.apply('publish', '--tenant', w.a.tenantId);
  const resolved = await w.resolver.resolve(w.a.tenantId);
  check(resolved?.credentialId === 'dev:a2', 'the retired key is never resolved for new signing');
  const s2 = await w.statement(w.a);
  check(s2.keyid === w.k.a2.keyid, 'the new statement is signed by the new key');
  const t1 = await anchorTime(w.a, s1.recordId);
  const old = await w.verifyStatement(w.a, s1, { evidence: t1 });
  const oldNoEvidence = await w.verifyStatement(w.a, s1);
  const fresh = await w.verifyStatement(w.a, s2);
  check(old.status === 'verified', `old statement with its anchor time: ${old.code}`);
  check(oldNoEvidence.code === 'ATTESTA_TRUST_KEY_NOT_VALID_AT', `old statement without evidence: ${oldNoEvidence.code}`);
  check(fresh.status === 'verified', `new statement: ${fresh.code}`);
  const report = await verifyChain(db, w.a.tenantId, { keys: (await publishedKeysFor(store, w.a.tenantId)).keys, anchors: await w.material() });
  check(report.ok && report.signatures === 'checked', 'verifyChain checks both keys');
  console.log(`it02_old_with_anchor_time=${old.code} old_without=${oldNoEvidence.code} new=${fresh.code}`);
  console.log('IT-T15l-02=passed');
  return { s2 };
}

async function refused(client: PoolClient, label: string, code: string | RegExp, fn: () => Promise<unknown>): Promise<void> {
  await client.query('savepoint attack');
  let error: { code?: string } | null = null;
  try {
    await fn();
  } catch (e) {
    error = e as { code?: string };
  }
  await client.query('rollback to savepoint attack');
  check(error !== null, `${label}: the database accepted it`);
  check(typeof code === 'string' ? error.code === code : code.test(String(error.code)), `${label}: expected ${String(code)}, got ${String(error.code)}`);
}

/** An UPDATE whose guard runs at COMMIT (deferred): its own transaction must fail to commit. */
async function refusedAtCommit(label: string, role: { name: string; tenantId: string } | null, sqlText: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  let error: { code?: string } | null = null;
  try {
    await client.query('begin');
    if (role) {
      await client.query(`select set_config('it_t15l2.tenant', $1, true)`, [role.tenantId]);
      await client.query(`set local role ${role.name}`);
    }
    const r = await client.query(sqlText, params);
    check(r.rowCount === 1, `${label}: the update reached its row`);
    await client.query('commit');
  } catch (e) {
    error = e as { code?: string };
    await client.query('rollback').catch(() => undefined);
  } finally {
    client.release();
  }
  check(error?.code === 'ATG01', `${label}: expected ATG01 at commit, got ${String(error?.code ?? 'committed')}`);
}

function fakeDocument(scope: string, version: number, previous: string | null) {
  const payload = Buffer.from(JSON.stringify({ _type: KEYSET_TYPE, scope, version, previous, keys: [] }), 'utf8');
  const envelope = { payload: payload.toString('base64'), payloadType: KEYSET_PAYLOAD_TYPE, signatures: [{ keyid: 'sha256:' + '0'.repeat(64), sig: 'AA==' }] };
  return [scope, version, sha256Prefixed(payload), KEYSET_PAYLOAD_TYPE, JSON.stringify(envelope)];
}

async function it03(w: World, s2: Rec): Promise<void> {
  // A later statement signed by the same key, anchored a few seconds after s2.
  await sleep(3000);
  const s3 = await w.statement(w.a);
  check(s3.keyid === w.k.a2.keyid, 's3 signed by the key about to be compromised');
  const x = await anchorTime(w.a, s2.recordId);
  const y = await anchorTime(w.a, s3.recordId);
  check(Date.parse(y) - Date.parse(x) >= 2000, 'the two anchors are apart');
  const since = new Date(Date.parse(x) + 1000).toISOString();
  const auditsBefore = Number((await pool.query(`select count(*)::int as n from security_audit_events where tenant_id = $1 and action = 'attesta.keys.revoke'`, [w.a.tenantId])).rows[0].n);
  const dry = await w.cli('revoke', '--tenant', w.a.tenantId, '--keyid', w.k.a2.keyid, '--reason', 'compromised', '--compromised-since', since);
  check(dry.code === 0 && /DRY RUN revoke/.test(dry.out) && dry.out.includes(w.k.a2.keyid) && dry.out.includes(`compromised_since ${since}`), 'the dry run prints the exact scope');
  check((await pool.query(`select status from attesta_tenant_keys where keyid = $1`, [w.k.a2.keyid])).rows[0].status === 'active', 'the dry run changed nothing');
  await w.apply('revoke', '--tenant', w.a.tenantId, '--keyid', w.k.a2.keyid, '--reason', 'compromised', '--compromised-since', since);
  const audits = (await pool.query(`select actor_id, details from security_audit_events where tenant_id = $1 and action = 'attesta.keys.revoke'`, [w.a.tenantId])).rows;
  check(audits.length === auditsBefore + 1 && audits[audits.length - 1].actor_id === 'it-operator', 'one audit row for the applied revoke');
  check((await pool.query(`select count(*)::int as n from attesta_key_events e join attesta_tenant_keys t on t.id = e.key_id
    where t.keyid = $1 and e.action = 'revoke'`, [w.k.a2.keyid])).rows[0].n === 1, 'one revoke event');
  check(await w.resolver.resolve(w.a.tenantId) === null, 'no key resolves after the compromise');
  await w.apply('publish', '--tenant', w.a.tenantId);
  const before = await w.verifyStatement(w.a, s2, { evidence: x });
  const after = await w.verifyStatement(w.a, s3, { evidence: y });
  check(before.status === 'verified', `anchored before compromised_since: ${before.code}`);
  check(after.code === 'ATTESTA_TRUST_KEY_REVOKED', `anchored after compromised_since: ${after.code}`);
  console.log(`it03_before_compromise=${before.code} after_compromise=${after.code}`);

  // Guards: definer settings and RLS.
  const fns = await pool.query(`select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config from pg_proc p
    where p.proname in ('attesta_trust_keys_insert_guard', 'attesta_trust_keys_update_guard', 'attesta_trust_keys_event_check',
      'attesta_key_events_guard', 'attesta_trust_documents_guard')`);
  check(fns.rows.length === 5 && fns.rows.every((f) => f.prosecdef === true && f.config === 'search_path=pg_catalog, pg_temp'),
    'guard functions are SECURITY DEFINER with a fixed search_path');
  const rls = await pool.query(`select c.relname, c.relrowsecurity as on, (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
    from pg_class c where c.relname in ('attesta_platform_keys', 'attesta_tenant_keys', 'attesta_key_events', 'attesta_trust_documents')`);
  check(rls.rows.length === 4 && rls.rows.every((r) => r.on === true && r.policies === 0), 'RLS enabled without policies');

  const A = w.a.tenantId;
  const B = w.b.tenantId;
  const a1 = w.k.a1.keyid;
  const keysetVersions = (await w.docs(A)).length;
  const lastDigest = (await store.documents(A))[keysetVersions - 1].digest;
  const a1Spki = (await pool.query(`select spki_der from attesta_tenant_keys where keyid = $1`, [a1])).rows[0].spki_der as Buffer;
  const attacks = async (client: PoolClient, who: string, tenantForInsert: string): Promise<number> => {
    const q = (text: string, params: unknown[] = []) => client.query(text, params);
    let n = 0;
    const list: Array<[string, string | RegExp, () => Promise<unknown>]> = [
      ['status back to active', 'ATG01', () => q(`update attesta_tenant_keys set status = 'active', revoked_at = null where keyid = $1`, [a1])],
      ['spki_der mutated', /^(ATG01|23514)$/, () => q(`update attesta_tenant_keys set spki_der = $2 where keyid = $1`, [w.k.a2.keyid, a1Spki])],
      ['not_after grows', 'ATG01', () => q(`update attesta_tenant_keys set not_after = not_after + interval '1 day' where keyid = $1`, [a1])],
      ['compromised_since later', 'ATG01', () => q(`update attesta_tenant_keys set compromised_since = compromised_since + interval '1 second' where keyid = $1`, [w.k.a2.keyid])],
      ['key deleted', 'ATG01', () => q(`delete from attesta_tenant_keys where keyid = $1`, [a1])],
      ['tenant keys truncated', 'ATG01', () => q(`truncate attesta_tenant_keys cascade`)],
      ['platform keys truncated', 'ATG01', () => q(`truncate attesta_platform_keys`)],
      ['event updated', 'ATG01', () => q(`update attesta_key_events set actor = 'x' where tenant_id = $1`, [A])],
      ['event deleted', 'ATG01', () => q(`delete from attesta_key_events where tenant_id = $1`, [A])],
      ['document deleted', 'ATG01', () => q(`delete from attesta_trust_documents where scope = $1`, [A])],
      ['document updated', 'ATG01', () => q(`update attesta_trust_documents set digest = digest where scope = $1`, [A])],
      ['document version skips', 'ATG01', () => q(`insert into attesta_trust_documents (scope, kind, version, digest, payload_type, envelope)
        values ($1, 'keyset', $2, $3, $4, $5::jsonb)`, fakeDocument(A, keysetVersions + 2, lastDigest))],
      ['document previous wrong', 'ATG01', () => q(`insert into attesta_trust_documents (scope, kind, version, digest, payload_type, envelope)
        values ($1, 'keyset', $2, $3, $4, $5::jsonb)`, fakeDocument(A, keysetVersions + 1, 'sha256:' + '1'.repeat(64)))],
      ['document columns not the payload', 'ATG01', () => q(`insert into attesta_trust_documents (scope, kind, version, digest, payload_type, envelope)
        values ($1, 'keyset', $2, $3, $4, $5::jsonb)`, [A, keysetVersions + 1, 'sha256:' + '2'.repeat(64), KEYSET_PAYLOAD_TYPE, fakeDocument(A, keysetVersions + 1, lastDigest)[4]])],
      ['keyid reused by another tenant', 'ATK01', () => q(`insert into attesta_tenant_keys (tenant_id, keyid, purpose, adapter_name, credential_ref, spki_der,
        not_before, not_after, status, pop_digest) values ($1, $2, 'statement', 'local-dev', 'dev:x', $3, now(), now() + interval '1 day', 'registered', $4)`,
        [tenantForInsert, a1, a1Spki, 'sha256:' + '3'.repeat(64)])],
      ['keyid reused for the platform', 'ATK01', () => q(`insert into attesta_platform_keys (keyid, purpose, adapter_name, credential_ref, spki_der,
        not_before, not_after, status, pop_digest) values ($1, 'release', 'local-dev', 'dev:x', $2, now(), now() + interval '1 day', 'registered', $3)`,
        [a1, a1Spki, 'sha256:' + '3'.repeat(64)])],
      ['platform key not as the latest root lists', 'ATG01', () => q(`update attesta_platform_keys set status = 'retired', revoked_at = now() where keyid = $1`, [w.k.keyset.keyid])],
      ['event naming a key of another scope', 'ATG01', () => q(`insert into attesta_key_events (tenant_id, key_id, action, actor, request_id)
        select $1, id, 'activate', 'x', 'r' from attesta_platform_keys limit 1`, [tenantForInsert])],
    ];
    for (const [label, code, fn] of list) {
      await refused(client, `${who} ${label}`, code, fn);
      n++;
    }
    const fresh = newKey();
    const spki = createPublicKey(fresh.pubPem).export({ type: 'spki', format: 'der' }) as Buffer;
    await refused(client, `${who} key inserted active`, 'ATG01', () => q(`insert into attesta_tenant_keys (tenant_id, keyid, purpose, adapter_name, credential_ref,
      spki_der, not_before, not_after, status, pop_digest) values ($1, $2, 'statement', 'local-dev', 'dev:x', $3, now(), now() + interval '1 day', 'active', $4)`,
      [tenantForInsert, fresh.keyid, spki, 'sha256:' + '4'.repeat(64)]));
    return n + 1;
  };
  // A registered key with no event: the UPDATE alone fails at commit (deferred check).
  const spare = newKey();
  const spareSpki = createPublicKey(spare.pubPem).export({ type: 'spki', format: 'der' }) as Buffer;
  await pool.query(`insert into attesta_tenant_keys (tenant_id, keyid, purpose, adapter_name, credential_ref, spki_der, not_before, not_after, status, pop_digest)
    values ($1, $2, 'statement', 'local-dev', 'dev:spare', $3, now(), now() + interval '30 days', 'registered', $4)`,
    [B, spare.keyid, spareSpki, 'sha256:' + '5'.repeat(64)]);

  const client = await pool.connect();
  let asApi = 0;
  let asRls = 0;
  try {
    await client.query('begin');
    asApi = await attacks(client, 'api-role', B);
    await client.query('rollback');
    await refusedAtCommit('api-role activate without an event', null, `update attesta_tenant_keys set status = 'active' where keyid = $1`, [spare.keyid]);
    await refusedAtCommit('api-role revoke without an event', null,
      `update attesta_tenant_keys set status = 'revoked', revoked_at = now(), revocation_reason = 'superseded' where keyid = $1`, [spare.keyid]);
    asApi += 2;

    await client.query('begin');
    await client.query(`create role ${APP_ROLE} nologin nosuperuser nobypassrls`);
    await client.query(`grant usage on schema public to ${APP_ROLE}`);
    await client.query(`grant select, insert, update, delete, truncate on attesta_platform_keys, attesta_tenant_keys, attesta_key_events,
      attesta_trust_documents to ${APP_ROLE}`);
    await client.query(`create policy it_t15l2_tenant on attesta_tenant_keys for all to ${APP_ROLE}
      using (tenant_id = current_setting('it_t15l2.tenant')::uuid) with check (tenant_id = current_setting('it_t15l2.tenant')::uuid)`);
    await client.query(`create policy it_t15l2_events on attesta_key_events for all to ${APP_ROLE}
      using (tenant_id is null or tenant_id = current_setting('it_t15l2.tenant')::uuid) with check (true)`);
    for (const table of ['attesta_platform_keys', 'attesta_trust_documents']) {
      await client.query(`create policy it_t15l2_all on ${table} for all to ${APP_ROLE} using (true) with check (true)`);
    }
    await client.query('commit');
    // As tenant A's RLS-bound role: every attack still refused (the guards are SECURITY DEFINER and see every tenant).
    await client.query('begin');
    await client.query(`select set_config('it_t15l2.tenant', $1, true)`, [A]);
    await client.query(`set local role ${APP_ROLE}`);
    const visibleB = Number((await client.query(`select count(*)::int as n from attesta_tenant_keys where tenant_id = $1`, [B])).rows[0].n);
    check(visibleB === 0, 'the RLS role of A sees none of B\'s keys');
    asRls = await attacks(client, 'rls-role', A);
    await client.query('rollback');
    // As B's RLS role: re-registering A's keyid (invisible to B) is still refused by the definer guard.
    await client.query('begin');
    await client.query(`select set_config('it_t15l2.tenant', $1, true)`, [B]);
    await client.query(`set local role ${APP_ROLE}`);
    await refused(client, 'rls-role B reuses A\'s keyid it cannot see', 'ATK01', () => client.query(`insert into attesta_tenant_keys (tenant_id, keyid, purpose,
      adapter_name, credential_ref, spki_der, not_before, not_after, status, pop_digest) values ($1, $2, 'statement', 'local-dev', 'dev:x', $3, now(),
      now() + interval '1 day', 'registered', $4)`, [B, a1, a1Spki, 'sha256:' + '6'.repeat(64)]));
    await client.query('rollback');
    await refusedAtCommit('rls-role activate without an event', { name: APP_ROLE, tenantId: B },
      `update attesta_tenant_keys set status = 'active' where keyid = $1`, [spare.keyid]);
    asRls += 2;
  } finally {
    client.release();
  }
  console.log(`it03_guards_api_role=${asApi}_refused guards_rls_role=${asRls}_refused`);
  console.log('IT-T15l-03=passed');
}

async function it04(w: World, s1: Rec): Promise<void> {
  const A = w.a.tenantId;
  const B = w.b.tenantId;
  const reuse = await w.cli('register', '--adapter', 'local-dev', '--credential', 'dev:a1-for-b', '--tenant', B, '--confirm=REGISTER', '--expect=1', '--actor', 'it');
  check(reuse.code === 1 && /already registered/.test(reuse.err) && !reuse.err.includes(A), 'B cannot register A\'s key; the refusal names no tenant');
  const steal = await w.cli('register', '--adapter', 'local-dev', '--credential', 'dev:a1', '--tenant', B, '--confirm=REGISTER', '--expect=1', '--actor', 'it');
  check(steal.code === 1, 'B cannot register with A\'s credential');
  await w.apply('register', '--adapter', 'local-dev', '--credential', 'dev:b1', '--tenant', B);
  const act = await w.cli('activate', '--tenant', B, '--keyid', w.k.a1.keyid);
  check(act.code === 1 && /no key .* is registered for tenant/.test(act.err), 'B cannot activate A\'s key');
  for (const cmd of ['retire', 'revoke']) {
    const r = await w.cli(cmd, '--tenant', B, '--keyid', w.k.a2.keyid, ...(cmd === 'revoke' ? ['--reason', 'superseded'] : []));
    check(r.code === 1, `B cannot ${cmd} A's key`);
  }
  await w.apply('activate', '--tenant', B, '--keyid', w.k.b1.keyid);
  const listB = await w.cli('list', '--tenant', B);
  check(listB.out.includes(w.k.b1.keyid) && !listB.out.includes(w.k.a1.keyid) && !listB.out.includes(w.k.a2.keyid), 'B lists only its own keys');
  await w.apply('publish', '--all-tenants');
  const rb = await w.resolver.resolve(B);
  check(rb?.credentialId === 'dev:b1', 'B resolves only its own key');
  const setsA = (await w.docs(A)).map(parseTrustDocument);
  const setsB = (await w.docs(B)).map(parseTrustDocument);
  check(setsA.every((d) => !d.keys.has(w.k.b1.keyid)) && setsB.every((d) => !d.keys.has(w.k.a1.keyid) && !d.keys.has(w.k.a2.keyid)),
    'key sets never list the other tenant\'s keys');
  check(Object.keys((await publishedKeysFor(store, B)).keys).join() === w.k.b1.keyid, 'B\'s published keys are its own');
  const cross = await w.verifyStatement(w.a, s1, { audience: B });
  check(cross.status === 'rejected' && (['ATTESTA_TRUST_KEY_UNKNOWN', 'ATTESTA_TRUST_AUDIENCE_MISMATCH'] as TrustCode[]).includes(cross.code),
    `A's statement under B's audience: ${cross.code}`);
  const auditsB = (await pool.query(`select details::text as d from security_audit_events where tenant_id = $1 and action like 'attesta.keys.%'`, [B])).rows;
  check(auditsB.length >= 3 && auditsB.every((r) => !r.d.includes(w.k.a1.keyid)), 'B\'s audit rows never name A\'s keys');
  console.log(`it04_cross_tenant_verify=${cross.code} keysets_a=${setsA.length} keysets_b=${setsB.length}`);
  console.log('IT-T15l-04=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  check(process.env.NODE_ENV !== 'production', 'the live test uses development signers');
  let dir: string | null = null;
  try {
    const w = await makeWorld();
    dir = w.dir;
    const s1 = await it01(w);
    const { s2 } = await it02(w, s1);
    await it03(w, s2);
    await it04(w, s1);
    console.log(`statements_company_a=${(await records(w.a.tenantId)).length}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15l2 failed');
  process.exitCode = 1;
});
