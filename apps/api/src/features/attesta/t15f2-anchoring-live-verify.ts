/**
 * IT-T15f-01…04: Attesta anchoring against real PostgreSQL, with the in-process
 * Rekor and TSA fakes (real rekor.sigstage.dev and FreeTSA runs stay at A15.13).
 *
 *   scripts/it-db.sh npm run verify:task15f2-anchoring-live -w apps/api
 *   IT_T15F2_RECORDS=2000 scripts/it-db.sh npm run verify:task15f2-anchoring-live -w apps/api
 *
 * 01 a chain of N records anchors in one pass (batches of 8 plus a partial batch,
 *    roots rebuilt by the 0018 guard); proofs stored; verifyChain with anchor material
 *    is ok and every record anchored; a second pass adds nothing.
 * 02 one lying-log knob per case → failed rows with the right code, attesta_records
 *    byte-identical before and after; the next honest pass anchors the same batch_id
 *    and root. LOG_REJECTED stops its batch for good (ANCHOR_MISSING once past the window).
 * 03 guards on both tables as the API role and an RLS-bound role (UPDATE / DELETE /
 *    TRUNCATE, wrong batch_id, gap or overlap, foreign seqs, wrong root, anchor outside
 *    its batch, a second anchored row, anchored without proof, proof bound elsewhere);
 *    definer settings; a crash between submit and record re-plans the same root and
 *    records once.
 * 04 Company A/B: a batch never mixes tenants; B cannot insert an anchor naming A's
 *    record or a batch over A's seqs; each tenant's verify is clean.
 * Prints only safe summary lines (counts and codes).
 */
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db, pool } from '../../core/db';
import { ATTESTA_PLATFORM_TENANT_ID, anchorSignerFromAdapter } from './anchor-contract';
import { DualAnchor } from './anchor-dual';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { anchorBatchId, pgAnchorStore, planTenant, rowsForOutcome, runAnchorPass, type AnchorPassOptions } from './anchor-worker';
import { chainStatement } from './ledger';
import { inclusionPath, merkleRoot } from './merkle';
import { LocalDevSigner, generateDevCredential } from './signer-local-dev';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { chainInput, makeStatement, makeTestKey, shaOf, type TestKey } from './testing/ledger-fixtures';
import { verifyChain, type AnchorCheckOptions } from './verify-chain';

const RECORDS = Number(process.env.IT_T15F2_RECORDS ?? 20);
const KEY: TestKey = makeTestKey();
const KEYS = { [KEY.keyid]: KEY.publicKey };
const APP_ROLE = 'it_t15f2_app';
const HOUR = 3_600_000;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15f2 failed: ${message}`);
}

interface Tenant { tenantId: string; repositoryId: string }

async function seedTenant(label: string): Promise<Tenant> {
  const slug = `it-t15f2-${label}-${randomUUID().slice(0, 8)}`;
  const t = { tenantId: randomUUID(), repositoryId: randomUUID() };
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [t.tenantId, `IT ${label}`, `${slug}.example`, `it-${label}`]);
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url, normalized_url)
     values ($1, $2, 'github', $3, 'payments-service', $4, $5)`,
    [t.repositoryId, t.tenantId, String(100_000 + Math.floor(Math.random() * 1e6)),
      `https://github.com/${slug}/payments-service`, `github.com/${slug}/payments-service`]);
  return t;
}

let asOfCounter = 0;
async function chainRecords(t: Tenant, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const subjectSha = shaOf(`${t.tenantId}-${asOfCounter}`);
    const claim = (await pool.query(
      `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at,
         status, claimed_at, attempts)
       values ($1, $2, 'commit_observed', $3, $4, $5, now(), 'claimed', now(), 1)
       returning id::text as id, to_char(claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at`,
      [t.tenantId, t.repositoryId, randomUUID(), randomUUID(), subjectSha])).rows[0];
    const statement = makeStatement({ repositoryId: t.repositoryId, subjectSha,
      asOf: new Date(Date.parse('2026-10-12T10:00:00.000Z') + asOfCounter++).toISOString(), previous: [] });
    await db.transaction((tx) => chainStatement(tx, chainInput(t.tenantId, statement, KEY,
      { outboxClaim: { subjectId: claim.id, claimedAt: claim.claimed_at, attempts: 1 } })));
  }
}

/** The anchoring world: fakes, a platform dev signer, the verify material. */
async function anchoringWorld() {
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000); // a new entry's integratedTime must fall in the request window
  const tsa = await FakeTsa.create();
  const cred = generateDevCredential('dev:it-anchor', ATTESTA_PLATFORM_TENANT_ID);
  const signer = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:it-anchor');
  const logPem = createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString();
  const dual = () => new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: logPem, production: false }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch }),
  );
  const material = async (nowMs = Date.now()): Promise<AnchorCheckOptions> => ({
    rekorLogKey: createPublicKey(rekor.logKey), anchorKeysSpkiDer: [await signer.publicKeySpkiDer()],
    tsaAnchors: loadTrustAnchors(tsa.anchorsPem), now: new Date(nowMs),
  });
  return { rekor, tsa, dual, material };
}

type World = Awaited<ReturnType<typeof anchoringWorld>>;

const pass = (w: World, opts: AnchorPassOptions, nowMs = Date.now(), anchor = w.dual()) =>
  runAnchorPass(db, { anchor, now: () => new Date(nowMs) }, { partialAfterMs: 0, ...opts });

async function recordsDigest(tenantId?: string): Promise<string> {
  const r = await pool.query(
    `select coalesce(md5(string_agg(id::text || seq::text || record_hash || canonical_record || statement_canonical
       || recorded_at::text, '|' order by tenant_id, seq)), 'empty') as d, count(*)::int as n
     from attesta_records ${tenantId ? 'where tenant_id = $1' : ''}`, tenantId ? [tenantId] : []);
  return `${r.rows[0].n}:${r.rows[0].d}`;
}

async function anchorCounts(tenantId: string) {
  const r = await pool.query(
    `select count(*) filter (where status = 'anchored')::int as anchored, count(*) filter (where status = 'failed')::int as failed,
       (select count(*)::int from attesta_anchor_batches where tenant_id = $1) as batches
     from attesta_anchors where tenant_id = $1`, [tenantId]);
  return r.rows[0] as { anchored: number; failed: number; batches: number };
}

// ---------------------------------------------------------------------------

async function it01(w: World, t: Tenant): Promise<void> {
  await chainRecords(t, RECORDS);
  const before = await recordsDigest(t.tenantId);
  const started = performance.now();
  const r = await pass(w, { tenantId: t.tenantId, maxBatch: 8, maxBatchesPerTenant: 1000 });
  const ms = performance.now() - started;
  const batches = Math.ceil(RECORDS / 8);
  check(r.batchesAnchored === batches && r.recordsAnchored === RECORDS && r.tenantErrors === 0, `one pass anchors all: ${JSON.stringify(r)}`);
  const c = await anchorCounts(t.tenantId);
  check(c.anchored === 2 * RECORDS && c.failed === 0 && c.batches === batches, `rows: ${JSON.stringify(c)}`);
  // The guard rebuilt every root in SQL; check them against merkle.ts once more from the stored rows.
  const stored = await pool.query(
    `select b.merkle_root, array_agg(r.record_hash order by r.seq) as hashes from attesta_anchor_batches b
     join attesta_records r on r.tenant_id = b.tenant_id and r.seq between b.seq_from and b.seq_to
     where b.tenant_id = $1 group by b.id, b.merkle_root`, [t.tenantId]);
  for (const b of stored.rows) {
    const root = merkleRoot((b.hashes as string[]).map((h) => Buffer.from(h.slice(7), 'hex')));
    check(b.merkle_root === `sha256:${root.toString('hex')}`, 'SQL and TypeScript roots agree');
  }
  const report = await verifyChain(db, t.tenantId, { keys: KEYS, anchors: await w.material() });
  check(report.ok && report.anchors.status === 'checked' && report.anchors.anchored === RECORDS,
    `verify with anchors: ${JSON.stringify({ breaks: report.breaks.slice(0, 3), anchors: report.anchors })}`);
  const again = await pass(w, { tenantId: t.tenantId, maxBatch: 8 });
  check(again.tenants === 0 && again.batchesAnchored === 0, 'a second pass finds nothing to do');
  check(JSON.stringify(await anchorCounts(t.tenantId)) === JSON.stringify(c), 'a second pass adds nothing');
  check(await recordsDigest(t.tenantId) === before, 'attesta_records unchanged by anchoring');
  console.log(`it01_records=${RECORDS} batches=${batches} pass_ms=${ms.toFixed(0)} verify=ok anchored=${report.anchors.anchored}`);
  console.log('IT-T15f-01=passed');
}

async function it02(w: World, t: Tenant, d: Tenant): Promise<void> {
  await chainRecords(t, 6);
  const cases: Array<[string, () => void, string]> = [
    ['log_down', () => { w.rekor.down = true; }, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'],
    ['log_503', () => { w.rekor.failStatus = 503; }, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'],
    ['log_lies_about_time', () => { w.rekor.tamper = (_id, e) => { e.integratedTime = 1; }; }, 'ATTESTA_ANCHOR_LOG_PROOF_INVALID'],
    ['tsa_down', () => { w.tsa.down = true; }, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE'],
    ['tsa_wrong_nonce', () => { w.tsa.nonceOffset = 1; }, 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID'],
    ['tsa_corrupt_signature', () => { w.tsa.corruptSignature = true; }, 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID'],
  ];
  const honest = () => {
    w.rekor.down = false; w.rekor.failStatus = null; w.rekor.tamper = null;
    w.tsa.down = false; w.tsa.nonceOffset = 0; w.tsa.corruptSignature = false;
  };
  const before = await recordsDigest();
  const batchId = anchorBatchId(t.tenantId, 0, 5);
  let root: string | null = null;
  let k = 0;
  for (const [name, lie, code] of cases) {
    lie();
    const r = await pass(w, { tenantId: t.tenantId }, Date.now() + (++k) * 2 * HOUR);
    honest();
    check(r.batchesFailed === 1 && r.codes[code] === 1, `${name}: ${JSON.stringify(r.codes)}`);
    const rows = await pool.query(
      `select count(*)::int as n from attesta_anchors where tenant_id = $1 and batch_id = $2 and status = 'failed' and error_code = $3`,
      [t.tenantId, batchId, code]);
    check(rows.rows[0].n >= 6, `${name}: one failed row per record`);
    const b = (await pool.query(`select merkle_root from attesta_anchor_batches where batch_id = $1`, [batchId])).rows[0];
    root ??= b.merkle_root;
    check(b.merkle_root === root, `${name}: the batch keeps its root`);
    check(await recordsDigest() === before, `${name}: attesta_records byte-identical`);
    console.log(`it02_${name}=${code}`);
  }
  const ok = await pass(w, { tenantId: t.tenantId }, Date.now() + (++k) * 2 * HOUR);
  check(ok.batchesAnchored === 1 && (await anchorCounts(t.tenantId)).anchored === 12, 'the honest pass anchors the same batch');
  check((await pool.query(`select count(*)::int as n from attesta_anchor_batches where tenant_id = $1`, [t.tenantId])).rows[0].n === 1,
    'no second batch for the same records');
  check(await recordsDigest() === before, 'attesta_records byte-identical after anchoring');
  check((await verifyChain(db, t.tenantId, { keys: KEYS, anchors: await w.material() })).ok, 'verify clean after recovery');
  console.log('it02_recovery=same_batch_id_same_root');

  // LOG_REJECTED is terminal: the batch stops, later batches anchor, the report shows the gap.
  await chainRecords(d, 3);
  w.rekor.failStatus = 400;
  let r = await pass(w, { tenantId: d.tenantId });
  honest();
  check(r.codes.ATTESTA_ANCHOR_LOG_REJECTED === 1 && !r.stoppedOnOutage, 'rejected recorded');
  await chainRecords(d, 2);
  r = await pass(w, { tenantId: d.tenantId }, Date.now() + 10 * HOUR);
  check(r.batchesStopped === 1 && r.batchesAnchored === 1, `stopped batch not retried: ${JSON.stringify(r)}`);
  const report = await verifyChain(db, d.tenantId, { keys: KEYS, anchors: await w.material(Date.now() + 2 * HOUR) });
  check(!report.ok && report.breaks.filter((b) => b.detail_code === 'ATTESTA_VERIFY_ANCHOR_MISSING').length === 3,
    `stopped records are ANCHOR_MISSING past the window: ${JSON.stringify(report.breaks)}`);
  console.log('it02_log_rejected=terminal_then_anchor_missing');
  console.log('IT-T15f-02=passed');
}

/** Run `fn` in a savepoint; it must be refused with `code`. */
async function refused(client: PoolClient, label: string, code: string | RegExp, fn: () => Promise<unknown>): Promise<void> {
  await client.query('savepoint attack');
  let error: { code?: string } | null = null;
  try {
    await fn();
  } catch (err) {
    error = err as { code?: string };
  }
  await client.query('rollback to savepoint attack');
  check(error !== null, `${label}: the database accepted it`);
  const ok = typeof code === 'string' ? error.code === code : code.test(String(error.code));
  check(ok, `${label}: expected ${String(code)}, got ${String(error.code)}`);
}

async function guardAttacks(client: PoolClient, t: Tenant, other: Tenant, roleLabel: string): Promise<number> {
  let n = 0;
  const attack = async (label: string, code: string | RegExp, fn: () => Promise<unknown>) => {
    await refused(client, `${roleLabel} ${label}`, code, fn);
    n++;
  };
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  const T = t.tenantId;
  const anchored = (await q(`select a.*, a.inclusion_proof::text as proof_text from attesta_anchors a
    where a.tenant_id = $1 and a.status = 'anchored' and a.anchor_type = 'rekor' order by a.created_at limit 1`, [T])).rows[0];
  const lastTo = Number((await q(`select max(seq_to)::text as s from attesta_anchor_batches where tenant_id = $1`, [T])).rows[0].s);
  const recordAt = async (seq: number) => (await q(`select id::text as id from attesta_records where tenant_id = $1 and seq = $2`, [T, seq])).rows[0].id as string;
  const rootOf = async (tenantId: string, from: number, to: number) => {
    const hashes = (await q(`select record_hash from attesta_records where tenant_id = $1 and seq between $2 and $3 order by seq`,
      [tenantId, from, to])).rows.map((r) => Buffer.from(String(r.record_hash).slice(7), 'hex'));
    return `sha256:${merkleRoot(hashes).toString('hex')}`;
  };
  const insertBatch = (tenantId: string, from: number, to: number, root: string, batchId = anchorBatchId(tenantId, from, to)) =>
    q(`insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, batchId, from, to, root, to - from + 1]);
  const insertAnchor = (tenantId: string, batchId: string, recordId: string, type: string, status: string, proof: string | null,
    uuid: string | null, token: string | null, code: string | null) =>
    q(`insert into attesta_anchors (tenant_id, batch_id, record_id, anchor_type, status, inclusion_proof, rekor_entry_uuid, tsa_token_b64, error_code)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`, [tenantId, batchId, recordId, type, status, proof, uuid, token, code]);

  // Append-only.
  await attack('update batch', 'ATG01', () => q(`update attesta_anchor_batches set merkle_root = merkle_root where tenant_id = $1`, [T]));
  await attack('delete batch', /^(ATG01|23503)$/, () => q(`delete from attesta_anchor_batches where tenant_id = $1`, [T]));
  await attack('truncate batches', /^(ATG01|0A000)$/, () => q(`truncate attesta_anchor_batches`));
  await attack('truncate batches cascade', 'ATG01', () => q(`truncate attesta_anchor_batches cascade`));
  await attack('update anchor', 'ATG01', () => q(`update attesta_anchors set error_code = null where tenant_id = $1`, [T]));
  await attack('update anchor to failed', 'ATG01', () => q(`update attesta_anchors set status = 'failed' where tenant_id = $1`, [T]));
  await attack('delete anchor', 'ATG01', () => q(`delete from attesta_anchors where tenant_id = $1`, [T]));
  await attack('truncate anchors', 'ATG01', () => q(`truncate attesta_anchors`));
  // Batch shape and range. A BEFORE INSERT guard runs before CHECK constraints, so a
  // shape fault may be refused by either (both are refusals; neither writes).
  const SHAPE = /^(23514|ATG01)$/;
  const next = lastTo + 1;
  await attack('wrong batch_id', SHAPE, async () => insertBatch(T, next, next, await rootOf(T, next, next), `${T}:${next}-${next + 1}`));
  await attack('batch_id of another tenant', SHAPE, async () => insertBatch(T, next, next, await rootOf(T, next, next), anchorBatchId(other.tenantId, next, next)));
  await attack('leaf_count not the range', SHAPE, () => q(
    `insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, $3, $3, $4, 2)`,
    [T, anchorBatchId(T, next, next), next, `sha256:${'0'.repeat(64)}`]));
  await attack('batch leaves a gap', 'ATA01', async () => insertBatch(T, next + 1, next + 1, await rootOf(T, next + 1, next + 1)));
  await attack('batch overlaps an earlier one', 'ATA01', async () => insertBatch(T, lastTo, next, await rootOf(T, lastTo, next)));
  await attack('batch over seqs not in the ledger', 'ATG01', () => insertBatch(T, next, next + 100_000, `sha256:${'0'.repeat(64)}`));
  await attack('batch with a wrong root', 'ATG01', () => insertBatch(T, next, next, `sha256:${'0'.repeat(64)}`));
  // Anchor rows.
  const proofText = anchored.proof_text as string;
  const proof = JSON.parse(proofText);
  await attack('a second anchored row', '23505', () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'rekor', 'anchored',
    proofText, anchored.rekor_entry_uuid, null, null));
  await attack('anchored without proof', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'rekor', 'anchored',
    null, anchored.rekor_entry_uuid, null, null));
  await attack('anchored with an error code', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'rekor', 'anchored',
    proofText, anchored.rekor_entry_uuid, null, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'));
  await attack('failed without a code', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'rekor', 'failed',
    null, null, null, null));
  await attack('failed with a proof', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'rekor', 'failed',
    proofText, null, null, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'));
  await attack('tsa row with a rekor entry uuid', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'tsa', 'failed',
    null, anchored.rekor_entry_uuid, null, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE'));
  await attack('unknown anchor type', SHAPE, () => insertAnchor(T, anchored.batch_id, anchored.record_id, 'ots', 'failed',
    null, null, null, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE'));
  // Re-anchoring a record whose rows already exist: build a fresh anchored row for
  // another record of the same batch at the wrong position, in a batch that has none yet.
  const outside = await recordAt(next); // not in any batch
  await attack('anchor outside its batch', 'ATG01', () => insertAnchor(T, anchored.batch_id, outside, 'rekor', 'failed',
    null, null, null, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'));
  await attack('anchor naming a batch of another tenant', /^(ATG01|23503)$/, async () => {
    const otherBatch = (await q(`select batch_id from attesta_anchor_batches where tenant_id = $1 limit 1`, [other.tenantId])).rows[0].batch_id;
    await insertAnchor(T, otherBatch, anchored.record_id, 'rekor', 'failed', null, null, null, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
  });
  await attack('anchor naming a record of another tenant', /^(ATG01|23503)$/, async () => {
    const otherRecord = (await q(`select id::text as id from attesta_records where tenant_id = $1 limit 1`, [other.tenantId])).rows[0].id;
    await insertAnchor(T, anchored.batch_id, otherRecord, 'rekor', 'failed', null, null, null, 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
  });
  // A fresh batch with no anchors yet, so the partial unique index does not answer first.
  await insertBatch(T, next, next + 1, await rootOf(T, next, next + 1));
  const fresh = anchorBatchId(T, next, next + 1);
  const second = await recordAt(next + 1);
  const rebound = (f: (p: any) => void) => { const p = structuredClone(proof); f(p); return JSON.stringify(p); };
  await attack('proof bound to another position', 'ATG01', () => insertAnchor(T, fresh, second, 'rekor', 'anchored',
    rebound((p) => { p.merkle.leaf_index = 0; p.merkle.tree_size = 2; }), proof.anchor.ref, null, null));
  await attack('proof of another tree size', 'ATG01', () => insertAnchor(T, fresh, second, 'rekor', 'anchored',
    rebound((p) => { p.merkle.leaf_index = 1; p.merkle.tree_size = 3; }), proof.anchor.ref, null, null));
  await attack('proof of the other anchor type', 'ATG01', () => insertAnchor(T, fresh, second, 'tsa', 'anchored',
    rebound((p) => { p.merkle.leaf_index = 1; p.merkle.tree_size = 2; }), null, Buffer.from('token').toString('base64'), null));
  await attack('rekor uuid column not the proof ref', 'ATG01', () => insertAnchor(T, fresh, second, 'rekor', 'anchored',
    rebound((p) => { p.merkle.leaf_index = 1; p.merkle.tree_size = 2; }), 'ab'.repeat(40), null, null));
  await attack('tsa token not the proof ref', 'ATG01', () => insertAnchor(T, fresh, second, 'tsa', 'anchored',
    rebound((p) => { p.merkle.leaf_index = 1; p.merkle.tree_size = 2; p.anchor.type = 'tsa'; p.anchor.ref = 'tsa:sha256:' + '0'.repeat(64); }),
    null, Buffer.from('token').toString('base64'), null));
  // Position, size, type and ref right, but a path that does not lead to the batch root.
  const freshLeaves = (await q(`select record_hash from attesta_records where tenant_id = $1 and seq between $2 and $3 order by seq`,
    [T, next, next + 1])).rows.map((r) => Buffer.from(String(r.record_hash).slice(7), 'hex'));
  const goodPath = inclusionPath(freshLeaves, 1).map((x) => x.toString('hex'));
  const tokenB64 = Buffer.from('token').toString('base64');
  const tsaRef = `tsa:sha256:${createHash('sha256').update(Buffer.from(tokenB64, 'base64')).digest('hex')}`;
  const tsaProof = (path: string[]) => rebound((p) => { p.merkle = { leaf_index: 1, tree_size: 2, path }; p.anchor.type = 'tsa'; p.anchor.ref = tsaRef; });
  await attack('path not to the batch root', 'ATG01', () => insertAnchor(T, fresh, second, 'tsa', 'anchored',
    tsaProof(['0'.repeat(64)]), null, tokenB64, null));
  await attack('path too long', 'ATG01', () => insertAnchor(T, fresh, second, 'tsa', 'anchored',
    tsaProof([...goodPath, '0'.repeat(64)]), null, tokenB64, null));
  await attack('path missing', 'ATG01', () => insertAnchor(T, fresh, second, 'tsa', 'anchored', tsaProof([]), null, tokenB64, null));
  // The same row, bound correctly, is accepted (the guard is not refusing everything).
  await insertAnchor(T, fresh, second, 'tsa', 'anchored', tsaProof(goodPath), null, tokenB64, null);
  return n;
}

async function it03(w: World, t: Tenant, other: Tenant): Promise<void> {
  await chainRecords(t, 6);
  await pass(w, { tenantId: t.tenantId, maxBatch: 2, maxBatchesPerTenant: 1 }); // batch 0-1 only
  await chainRecords(other, 1);
  await pass(w, { tenantId: other.tenantId });

  const fns = await pool.query(
    `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config
     from pg_proc p where p.proname in ('attesta_anchor_batches_guard', 'attesta_anchors_guard', 'attesta_ledger_reject_mutation')`);
  check(fns.rows.length === 3 && fns.rows.every((f) => f.prosecdef === true && f.config === 'search_path=pg_catalog, pg_temp'),
    'anchor guard functions are SECURITY DEFINER with a fixed search_path');
  const rls = await pool.query(
    `select c.relname, c.relrowsecurity as on, (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
     from pg_class c where c.relname in ('attesta_anchor_batches', 'attesta_anchors')`);
  check(rls.rows.length === 2 && rls.rows.every((r) => r.on === true && r.policies === 0), 'RLS enabled without policies');
  console.log('anchor_guard_functions=security_definer_fixed_search_path');
  console.log('anchor_rls=enabled_no_policies');

  const client = await pool.connect();
  try {
    await client.query('begin');
    const asApi = await guardAttacks(client, t, other, 'api-role');
    await client.query('rollback');
    console.log(`anchor_guards_api_role=${asApi}_refused`);

    await client.query('begin');
    await client.query(`create role ${APP_ROLE} nologin nosuperuser nobypassrls`);
    await client.query(`grant usage on schema public to ${APP_ROLE}`);
    await client.query(`grant select, insert, update, delete, truncate on attesta_anchor_batches, attesta_anchors, attesta_records, chain_head to ${APP_ROLE}`);
    for (const table of ['attesta_anchor_batches', 'attesta_anchors', 'attesta_records', 'chain_head']) {
      await client.query(`create policy it_t15f2_tenant on ${table} for all to ${APP_ROLE}
        using (tenant_id = current_setting('it_t15f2.tenant')::uuid) with check (tenant_id = current_setting('it_t15f2.tenant')::uuid)`);
    }
    await client.query(`select set_config('it_t15f2.tenant', $1, true)`, [t.tenantId]);
    await client.query(`set local role ${APP_ROLE}`);
    const visible = Number((await client.query(`select count(*)::int as n from attesta_anchor_batches where tenant_id = $1`, [other.tenantId])).rows[0].n);
    check(visible === 0, 'the RLS role sees no tenant B batch');
    // Run the attacks as the RLS role, except the ones that need to read the other tenant (invisible here):
    // those are covered as the API role above and in IT-T15f-04.
    let asRls = 0;
    const q = (text: string, params: unknown[] = []) => client.query(text, params);
    for (const [label, code, sqlText] of [
      ['update batch', 'ATG01', `update attesta_anchor_batches set merkle_root = merkle_root where tenant_id = $1`],
      ['delete anchor', 'ATG01', `delete from attesta_anchors where tenant_id = $1`],
      ['update anchor', 'ATG01', `update attesta_anchors set error_code = null where tenant_id = $1`],
    ] as const) {
      await refused(client, `rls-role ${label}`, code, () => q(sqlText, [t.tenantId]));
      asRls++;
    }
    await refused(client, 'rls-role truncate anchors', 'ATG01', () => q(`truncate attesta_anchors`));
    asRls++;
    await refused(client, 'rls-role batch with a wrong root', 'ATG01', () => q(
      `insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, 2, 2, $3, 1)`,
      [t.tenantId, anchorBatchId(t.tenantId, 2, 2), `sha256:${'0'.repeat(64)}`]));
    asRls++;
    await refused(client, 'rls-role batch leaves a gap', 'ATA01', () => q(
      `insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, 3, 3, $3, 1)`,
      [t.tenantId, anchorBatchId(t.tenantId, 3, 3), `sha256:${'0'.repeat(64)}`]));
    asRls++;
    // A legitimate batch still inserts: the definer guard reads the ledger under RLS.
    const hash = (await q(`select record_hash from attesta_records where tenant_id = $1 and seq = 2`, [t.tenantId])).rows[0].record_hash as string;
    await q(`insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, 2, 2, $3, 1)`,
      [t.tenantId, anchorBatchId(t.tenantId, 2, 2), `sha256:${merkleRoot([Buffer.from(hash.slice(7), 'hex')]).toString('hex')}`]);
    await client.query('rollback');
    console.log(`anchor_guards_rls_role=${asRls}_refused`);
    console.log('rls_role_batch_insert=passed');
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }

  // Crash between submit and record: the root went to the log, nothing was stored.
  const store = pgAnchorStore(db);
  const input = await store.loadPlan(t.tenantId, { unbatched: 100, incomplete: 10 });
  check(input !== null, 'plan lock available');
  const plan = planTenant(t.tenantId, input, new Date(), { maxBatch: 2, partialAfterMs: 0, maxBatchesPerTenant: 1 });
  const planned = plan.work[0];
  const submitted = merkleRoot(planned.leaves);
  const crashed = await w.dual().anchor(submitted, planned.batch.batchId);
  check(crashed.complete, 'the crashed worker had anchored');
  check((await pool.query(`select count(*)::int as n from attesta_anchor_batches where batch_id = $1`, [planned.batch.batchId])).rows[0].n === 0,
    'nothing recorded before the crash');
  const r = await pass(w, { tenantId: t.tenantId, maxBatch: 2, maxBatchesPerTenant: 1 });
  const b = (await pool.query(`select merkle_root from attesta_anchor_batches where batch_id = $1`, [planned.batch.batchId])).rows[0];
  check(r.batchesAnchored === 1 && b?.merkle_root === `sha256:${submitted.toString('hex')}`, 're-planned with the same root');
  const n = (await pool.query(`select count(*)::int as n from attesta_anchors where tenant_id = $1 and batch_id = $2 and status = 'anchored'`,
    [t.tenantId, planned.batch.batchId])).rows[0].n;
  check(n === 4, 'recorded once');
  console.log('crash_between_submit_and_record=same_root_recorded_once');

  // Two workers at once on one tenant, with work for both: one anchored row per record and type.
  await chainRecords(t, 12);
  const results = await Promise.all([1, 2].map(() => pass(w, { tenantId: t.tenantId, maxBatch: 2, maxBatchesPerTenant: 100 })));
  const dup = (await pool.query(`select count(*)::int as n from (select record_id, anchor_type from attesta_anchors
    where tenant_id = $1 and status = 'anchored' group by 1, 2 having count(*) > 1) d`, [t.tenantId])).rows[0].n;
  check(dup === 0 && results.every((x) => x.tenantErrors === 0), `concurrent passes: ${JSON.stringify(results)}`);
  check(results.reduce((sum, x) => sum + x.recordsAnchored, 0) >= 14, 'the concurrent passes did the work');
  check((await verifyChain(db, t.tenantId, { keys: KEYS, anchors: await w.material() })).ok, 'verify clean after concurrent passes');
  console.log(`concurrent_passes=one_row_per_record_and_type busy=${results.map((x) => x.busy).join('+')} already=${results.map((x) => x.alreadyAnchored).join('+')}`);

  // Overlapping ranges: worker 1 plans 2 records, worker 2 plans 4; both submit; worker 2
  // records first, so worker 1's batch is no longer the next range (ATA01: superseded).
  await chainRecords(t, 4);
  const plan1 = planTenant(t.tenantId, (await store.loadPlan(t.tenantId, { unbatched: 10, incomplete: 10 }))!, new Date(),
    { maxBatch: 2, partialAfterMs: 0, maxBatchesPerTenant: 1 }).work[0];
  const plan2 = planTenant(t.tenantId, (await store.loadPlan(t.tenantId, { unbatched: 10, incomplete: 10 }))!, new Date(),
    { maxBatch: 4, partialAfterMs: 0, maxBatchesPerTenant: 1 }).work[0];
  check(plan1.batch.seqFrom === plan2.batch.seqFrom && plan1.batch.seqTo < plan2.batch.seqTo, 'overlapping plans');
  const [out1, out2] = await Promise.all([w.dual().anchor(merkleRoot(plan1.leaves), plan1.batch.batchId),
    w.dual().anchor(merkleRoot(plan2.leaves), plan2.batch.batchId)]);
  const rec2 = await store.record(t.tenantId, plan2.batch, rowsForOutcome(plan2, out2));
  const rec1 = await store.record(t.tenantId, plan1.batch, rowsForOutcome(plan1, out1));
  check(rec2.status === 'recorded' && rec1.status === 'superseded', `overlap: ${rec2.status}/${rec1.status}`);
  check((await pool.query(`select count(*)::int as n from attesta_anchor_batches where batch_id = $1`, [plan1.batch.batchId])).rows[0].n === 0,
    'the superseded batch left nothing');
  check((await verifyChain(db, t.tenantId, { keys: KEYS, anchors: await w.material() })).ok, 'verify clean after the overlap');
  console.log('overlapping_ranges=second_superseded_nothing_written');
  console.log('IT-T15f-03=passed');
}

async function it04(w: World, a: Tenant, b: Tenant): Promise<void> {
  await chainRecords(a, 5);
  await chainRecords(b, 4);
  const r = await pass(w, {});
  check(r.tenantErrors === 0 && r.batchesAnchored >= 2, `all tenants: ${JSON.stringify(r)}`);
  const mixed = await pool.query(
    `select count(*)::int as n from attesta_anchors x
     join attesta_records rec on rec.id = x.record_id
     join attesta_anchor_batches bt on bt.batch_id = x.batch_id
     where rec.tenant_id <> x.tenant_id or bt.tenant_id <> x.tenant_id or split_part(bt.batch_id, ':', 1) <> bt.tenant_id::text`);
  check(mixed.rows[0].n === 0, 'no batch or anchor mixes tenants');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const aRecord = (await client.query(`select id::text as id from attesta_records where tenant_id = $1 limit 1`, [a.tenantId])).rows[0].id;
    const bBatch = (await client.query(`select batch_id from attesta_anchor_batches where tenant_id = $1 limit 1`, [b.tenantId])).rows[0].batch_id;
    await refused(client, 'B anchors A\'s record', /^(ATG01|23503)$/, () => client.query(
      `insert into attesta_anchors (tenant_id, batch_id, record_id, anchor_type, status, error_code)
       values ($1, $2, $3, 'rekor', 'failed', 'ATTESTA_ANCHOR_LOG_UNAVAILABLE')`, [b.tenantId, bBatch, aRecord]));
    const aMax = Number((await client.query(`select max(seq)::text as s from attesta_records where tenant_id = $1`, [a.tenantId])).rows[0].s);
    const bNext = Number((await client.query(`select coalesce(max(seq_to) + 1, 0)::text as s from attesta_anchor_batches where tenant_id = $1`, [b.tenantId])).rows[0].s);
    await refused(client, 'B batches seqs only A has', 'ATG01', () => client.query(
      `insert into attesta_anchor_batches (tenant_id, batch_id, seq_from, seq_to, merkle_root, leaf_count) values ($1, $2, $3, $4, $5, $6)`,
      [b.tenantId, anchorBatchId(b.tenantId, bNext, aMax), bNext, aMax, `sha256:${'0'.repeat(64)}`, aMax - bNext + 1]));
    await client.query('rollback');
  } finally {
    client.release();
  }
  for (const t of [a, b]) {
    const report = await verifyChain(db, t.tenantId, { keys: KEYS, anchors: await w.material() });
    check(report.ok && report.anchors.status === 'checked' && report.anchors.pending === 0, `tenant verify clean: ${JSON.stringify(report.breaks.slice(0, 3))}`);
  }
  console.log('company_a_b=isolated_both_clean');
  console.log('IT-T15f-04=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('IT-T15f2 requires a local disposable database');
  if (!Number.isSafeInteger(RECORDS) || RECORDS < 1) throw new Error('IT_T15F2_RECORDS must be a positive integer');
  try {
    const w = await anchoringWorld();
    await it01(w, await seedTenant('one'));
    await it02(w, await seedTenant('two'), await seedTenant('rejected'));
    await it03(w, await seedTenant('guards'), await seedTenant('guards-other'));
    await it04(w, await seedTenant('company-a'), await seedTenant('company-b'));
    console.log('IT-T15f2=passed');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15f2 failed');
  process.exitCode = 1;
});
