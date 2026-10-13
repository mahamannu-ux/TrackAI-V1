/**
 * Evidence packs (Task15i2): buildPack, the pack signature, the job and the request
 * parsing, checked with the independent oracle (testing/evidence-pack-oracle.ts).
 * Real signers and trust documents (an in-process KMS behind the real KmsSigner, the
 * real trust inventory on its memory store); the chain is built exactly as the ledger
 * builds it. The memory PackStore stands in for PostgreSQL (live: t15i2-evidence-packs-live-verify.ts).
 *
 * Ported first from SushiCorp @ 0bd67a5 tests/unit/reporting/test_reporting_integrity.py
 * (regeneration is byte-identical; generation time never enters the body; a tampered
 * record, report and signature are each detected) and the export checks of
 * services/anchoring/offline_verify.py (hash chain, Merkle path to the batch root).
 */
import assert from 'node:assert/strict';
import { createPublicKey, sign as cryptoSign, verify } from 'node:crypto';
import { describe, test } from 'node:test';
import type { EvidenceExportSink } from '../../core/operations/evidence-export-sink';
import { GENESIS_PREV_HASH, canonicalize, sha256Prefixed } from './canonical';
import { pae, verifyEnvelope, type DsseEnvelope } from './dsse';
import {
  EVIDENCE_PACK_PAYLOAD_TYPE, MAX_PACK_RECORDS, PackJobError, buildPack, downloadBody, packStatusBody,
  packTrustFrom, parseIdempotencyKey, parsePackRequest, parseStoredScope, runEvidencePack, sameRequest, signPack,
  type PackCounts, type PackRequest, type PackScope, type Segment,
} from './evidence-pack-service';
import { AttestaQueryError } from './read-service';
import { KmsSigner } from './signer-kms';
import type { SignerResolver } from './signer-resolver';
import {
  A, B, MIN, MemoryPackStore, MemorySink, PACK_1, PACK_2, R1, R2, T0, at, buildFixtureChain, newKey, segmentOf, trustWorld,
  type World,
} from './testing/evidence-pack-fixtures';
import { oracleVerifyPack } from './testing/evidence-pack-oracle';
import {
  applyTenantKeyCommand, planTenantKeyCommand, publishKeyset, registerKey, type InventoryContext, type TrustAdapters,
} from './trust-inventory';
import { inventorySignerResolver, publishedKeysFor } from './trust-resolver';

const SCOPE_ALL: PackScope = { repository_id: null, from: at(T0 - 3 * 60 * MIN + 2 * MIN), to: at(T0 - 3 * 60 * MIN + 8 * MIN) };
const SCOPE_R1: PackScope = { ...SCOPE_ALL, repository_id: R1 };
const GEN = at(T0);

async function packFor(w: World, scope: PackScope, mode: 'full' | 'repository_only' = 'full', packId = PACK_1, generatedAt = GEN,
  chain = buildFixtureChain(A, w.k.a1)) {
  const built = buildPack({ packId, tenantId: A, scope, mode, segment: segmentOf(chain, scope, generatedAt), trust: await w.material(A) });
  const signature = await signPack(built, w.resolver, A, 'req-1');
  const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as { pack: Record<string, any>; signature: DsseEnvelope };
  return { chain, built, signature, download };
}

// ---------------------------------------------------------------------------

describe('buildPack (ported: SushiCorp reporting integrity)', () => {
  test('regeneration is byte-identical apart from pack_id and generated_at; generation time enters nowhere else', async () => {
    const w = await trustWorld();
    // One stored chain (ECDSA signatures are randomized: a new chain would differ in its envelopes).
    const chain = buildFixtureChain(A, w.k.a1);
    const one = await packFor(w, SCOPE_ALL, 'full', PACK_1, at(T0), chain);
    const two = await packFor(w, SCOPE_ALL, 'full', PACK_2, at(T0 + 7 * MIN), chain);
    const strip = (p: Record<string, any>) => {
      const c = structuredClone(p);
      delete c.manifest.pack_id;
      delete c.manifest.generated_at;
      return canonicalize(c);
    };
    assert.equal(strip(one.download.pack), strip(two.download.pack));
    assert.notEqual(one.built.digest, two.built.digest);
    assert.ok(!one.built.text.includes(at(T0 + 7 * MIN)));
    const again = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full',
      segment: segmentOf(one.chain, SCOPE_ALL, at(T0)), trust: await w.material(A) });
    assert.equal(again.text, one.built.text, 'same inputs, same bytes');
  });

  test('the segment is the window plus one boundary record each side; manifest and section digests are right', async () => {
    const w = await trustWorld();
    const { download, built } = await packFor(w, SCOPE_ALL);
    const p = download.pack;
    assert.deepEqual(p.records.map((r: { seq: number }) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(p.statements.map((s: { seq: number }) => s.seq), [2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(p.manifest.chain_range, { from_seq: 1, to_seq: 9, prev_hash: download.pack.records[0].prev_hash, head: null });
    for (const name of Object.keys(p.manifest.sections)) assert.equal(p.manifest.sections[name], sha256Prefixed(canonicalize(p[name])), name);
    assert.equal(built.digest, sha256Prefixed(canonicalize(p)));
    assert.equal(built.text, canonicalize(p), 'the stored bytes are their own JCS form');
    assert.deepEqual(p.reports, []);
    assert.equal(p.verifier, null);
    assert.equal(p.manifest.completeness, 'provable');
  });

  test('pending records are counted and never shown as anchored', async () => {
    const w = await trustWorld();
    const { download } = await packFor(w, SCOPE_ALL);
    const counts = download.pack.manifest.counts as PackCounts;
    assert.deepEqual(counts, { records: 9, statements: 7, redacted_records: 0, anchored: 2, pending: 5, anchor_rows: 4, anchor_batches: 1 });
    const status = Object.fromEntries(download.pack.statements.map((s: { seq: number; anchor_status: string }) => [s.seq, s.anchor_status]));
    assert.equal(status[2], 'anchored');
    assert.equal(status[3], 'anchored');
    assert.equal(status[4], 'pending');
    // One anchor type only is still pending.
    const chain = buildFixtureChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    seg.anchors = seg.anchors.filter((a) => !(a.seq === 2 && a.anchorType === 'tsa'));
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: seg, trust: await w.material(A) });
    assert.equal(built.counts.anchored, 1);
  });

  test('full vs repository_only: no out-of-scope statement or canonical record in the latter', async () => {
    const w = await trustWorld();
    const full = await packFor(w, SCOPE_R1, 'full');
    const only = await packFor(w, SCOPE_R1, 'repository_only');
    assert.deepEqual(full.download.pack.statements.map((s: { seq: number }) => s.seq), [2, 4, 6, 8]);
    assert.ok(full.built.text.includes(R2), 'full shows other repositories\' record metadata (the documented trade-off)');
    assert.ok(!only.built.text.includes(R2), 'repository_only never names another repository');
    for (const r of only.download.pack.records) {
      if (r.seq % 2 === 1) assert.deepEqual(Object.keys(r).sort(), ['prev_hash', 'record_hash', 'seq']);
      else assert.ok(typeof r.canonical_record === 'string');
    }
    assert.equal(only.download.pack.manifest.counts.redacted_records, 5);
    assert.equal(only.download.pack.manifest.completeness, 'not_provable');
    for (const s of full.download.pack.statements) assert.ok(JSON.parse(s.statement_canonical).subject[0].name.includes(R1));
    assert.equal(full.download.pack.anchors.length, 2, 'anchors of in-scope records only (seq 2)');
  });

  test('refuses an inconsistent segment instead of building over it', async () => {
    const w = await trustWorld();
    const trust = await w.material(A);
    const chain = buildFixtureChain(A, w.k.a1);
    const base = () => segmentOf(chain, SCOPE_ALL, GEN);
    const cases: Array<[string, (s: Segment) => void, string]> = [
      ['gap', (s) => { s.records.splice(3, 1); }, 'ATTESTA_API_INTERNAL'],
      ['link', (s) => { s.records[2] = { ...s.records[2], prevHash: GENESIS_PREV_HASH }; }, 'ATTESTA_API_INTERNAL'],
      ['record bytes', (s) => { s.records[2] = { ...s.records[2], canonicalRecord: s.records[2].canonicalRecord.replace('"seq":3', '"seq":4') }; }, 'ATTESTA_API_INTERNAL'],
      ['statement', (s) => { s.records[2] = { ...s.records[2], statementCanonical: s.records[2].statementCanonical + ' ' }; }, 'ATTESTA_API_INTERNAL'],
      ['missing envelope', (s) => { s.records[2] = { ...s.records[2], envelope: null }; }, 'ATTESTA_API_INTERNAL'],
      ['head', (s) => { s.head = { next_seq: 99, head_hash: GENESIS_PREV_HASH }; }, 'ATTESTA_API_INTERNAL'],
      ['unsettled', (s) => { s.generatedAt = at(Date.parse(SCOPE_ALL.to) + MIN); }, 'ATTESTA_API_INVALID_QUERY'],
      ['too large', (s) => { s.toSeq = s.fromSeq + MAX_PACK_RECORDS; }, 'ATTESTA_API_INVALID_QUERY'],
    ];
    for (const [name, mutate, code] of cases) {
      const seg = base();
      mutate(seg);
      assert.throws(() => buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: seg, trust }),
        (e: unknown) => e instanceof PackJobError && e.code === code, name);
    }
  });

  test('an empty chain gives a valid empty pack; a window past the head ends at the head', async () => {
    const w = await trustWorld();
    const trust = await w.material(A);
    const empty = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', trust,
      segment: { generatedAt: GEN, fromSeq: 0, toSeq: -1, prevHash: GENESIS_PREV_HASH, head: null, records: [], anchors: [], batches: [] } });
    assert.equal(empty.counts.records, 0);
    const chain = buildFixtureChain(A, w.k.a1);
    const late: PackScope = { repository_id: null, from: at(T0 - 3 * 60 * MIN + 10 * MIN), to: at(T0 - 30 * MIN) };
    const seg = segmentOf(chain, late, GEN);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: late, mode: 'full', segment: seg, trust });
    assert.deepEqual(built.manifest.chain_range.head, { next_seq: 12, head_hash: chain.records[11].recordHash });
    const sig = await signPack(built, w.resolver, A, 'r');
    const res = oracleVerifyPack(JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(sig)}}`), [w.k.root.keyid]);
    assert.deepEqual(res.breaks, []);
    assert.equal(res.completeness, 'checked');
  });

  test('no raw content: no emails, paths, credential references or foreign URLs in a pack', async () => {
    const w = await trustWorld();
    const { built, signature } = await packFor(w, SCOPE_ALL);
    const text = built.text + JSON.stringify(signature);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text), 'email');
    assert.ok(!/aws-kms:|gcp-kms:|credential|ref-a1|dev:/.test(text), 'credential reference');
    assert.ok(!/(^|["\s])(\/Users|\/home|src\/|[A-Za-z]:\\)/.test(text), 'path');
    for (const url of text.match(/https?:\/\/[^"\s]+/g) ?? []) {
      assert.match(url, /^https:\/\/(trackai\.dev|in-toto\.io)\//, url);
    }
  });
});

/** Re-sign an altered pack as a dishonest exporter holding A's real key would: digests and signature redone. */
function resign(d: { pack: Record<string, any>; signature: DsseEnvelope }, w: World) {
  const p = d.pack;
  for (const name of Object.keys(p.manifest.sections)) p.manifest.sections[name] = sha256Prefixed(canonicalize(p[name]));
  const payload = Buffer.from(canonicalize({ manifest: p.manifest, pack_digest: sha256Prefixed(canonicalize(p)) }), 'utf8');
  const sig = cryptoSign('sha256', pae(EVIDENCE_PACK_PAYLOAD_TYPE, payload), { key: w.k.a1.priv, dsaEncoding: 'der' });
  d.signature = { payload: payload.toString('base64'), payloadType: EVIDENCE_PACK_PAYLOAD_TYPE, signatures: [{ keyid: w.k.a1.keyid, sig: sig.toString('base64') }] };
  return d;
}

describe('oracle: claims a dishonest exporter re-signs are still checked against the pack', () => {
  test('anchor_status, counts, completeness, duplicates, a left-out statement, a missing canonical_record', async () => {
    const w = await trustWorld();
    const { download } = await packFor(w, SCOPE_ALL);
    assert.deepEqual(oracleVerifyPack(resign(structuredClone(download), w), [w.k.root.keyid]).breaks, [], 're-signing alone changes nothing');
    const cases: Array<[string, (p: Record<string, any>) => void, RegExp]> = [
      ['pending shown as anchored', (p) => { p.statements[2].anchor_status = 'anchored'; p.manifest.counts.anchored += 1; p.manifest.counts.pending -= 1; }, /anchor_status at 4/],
      ['counts', (p) => { p.manifest.counts.records += 1; }, /counts/],
      ['completeness vs mode', (p) => { p.manifest.scope.mode = 'repository_only'; }, /completeness/],
      ['statement twice', (p) => { p.statements.push(structuredClone(p.statements[0])); p.manifest.counts.statements += 1; }, /listed twice/],
      ['statement left out', (p) => { p.statements.splice(3, 1); p.manifest.counts.statements -= 1; p.manifest.counts.pending -= 1; }, /left out/],
      ['canonical_record withheld in full', (p) => { delete p.records[4].canonical_record; p.manifest.counts.redacted_records += 1; }, /every canonical_record/],
      ['record not JSON', (p) => { p.records[4].canonical_record = '{'; }, /record/],
    ];
    for (const [name, mutate, expected] of cases) {
      const d = structuredClone(download);
      mutate(d.pack);
      const res = oracleVerifyPack(resign(d, w), [w.k.root.keyid]);
      assert.equal(res.ok, false, name);
      assert.ok(res.breaks.some((b) => expected.test(b)), `${name}: ${res.breaks.join('; ')}`);
    }
  });

  test('trust documents reordered, truncated or rolled back fail (key sets and roots run 1, 2, 3 …)', async () => {
    const w = await trustWorld();
    await publishKeyset(w.ctx, A); // key set version 2
    const { download } = await packFor(w, SCOPE_ALL);
    const bTrust = (await w.material(B)).trust;
    assert.equal(download.pack.trust.keyset_documents.length, 2);
    assert.deepEqual(oracleVerifyPack(download, [w.k.root.keyid]).breaks, []);
    const cases: Array<[string, (t: Record<string, any>) => void]> = [
      ['key sets reordered', (t) => { t.keyset_documents.reverse(); }],
      ['key set history truncated', (t) => { t.keyset_documents.shift(); }],
      ['root duplicated', (t) => { t.root_documents.push(t.root_documents[0]); }],
      ['no root', (t) => { t.root_documents = []; }],
      ['another tenant\'s key sets', (t) => { t.keyset_documents = bTrust.keyset_documents; }],
    ];
    for (const [name, mutate] of cases) {
      const d = structuredClone(download);
      mutate(d.pack.trust);
      assert.equal(oracleVerifyPack(resign(d, w), [w.k.root.keyid]).ok, false, name);
    }
    // Documented limit (trust.md "First-use limit"): withholding the newest key set is not
    // detectable offline without a persisted lastTrusted; a key set that still lists the
    // signer active and has not expired at generated_at is accepted. A15.10 persists lastTrusted.
    const withheld = structuredClone(download);
    withheld.pack.trust.keyset_documents.pop();
    assert.equal(oracleVerifyPack(resign(withheld, w), [w.k.root.keyid]).ok, true);
  });
});

describe('pack signature (RP-1) and the oracle', () => {
  test('the signature verifies with publishedKeysFor keys and covers {manifest, pack_digest}', async () => {
    const w = await trustWorld();
    const { built, signature } = await packFor(w, SCOPE_ALL);
    assert.equal(signature.payloadType, EVIDENCE_PACK_PAYLOAD_TYPE);
    const keys = (await publishedKeysFor(w.store, A)).keys;
    assert.ok(verifyEnvelope(signature, keys).ok);
    assert.equal(signature.signatures[0].keyid, w.k.a1.keyid);
    assert.deepEqual(JSON.parse(Buffer.from(signature.payload, 'base64').toString('utf8')), { manifest: built.manifest, pack_digest: built.digest });
    // B's keys never verify A's pack.
    assert.equal(verifyEnvelope(signature, (await publishedKeysFor(w.store, B)).keys).ok, false);
  });

  test('the oracle passes a good pack in both modes (repository_only: completeness not checkable)', async () => {
    const w = await trustWorld();
    const full = oracleVerifyPack((await packFor(w, SCOPE_R1, 'full')).download, [w.k.root.keyid]);
    assert.deepEqual(full.breaks, []);
    assert.equal(full.completeness, 'checked');
    assert.equal(full.counts.anchorPaths, 2);
    const only = oracleVerifyPack((await packFor(w, SCOPE_R1, 'repository_only')).download, [w.k.root.keyid]);
    assert.deepEqual(only.breaks, []);
    assert.equal(only.completeness, 'not_checkable');
  });

  test('every byte change is detected: record, statement, Merkle path, manifest, signature, a dropped statement', async () => {
    const w = await trustWorld();
    const { download } = await packFor(w, SCOPE_ALL);
    const cases: Array<[string, (d: typeof download) => void]> = [
      ['record bytes (resigned nothing)', (d) => { d.pack.records[3].canonical_record = d.pack.records[3].canonical_record.replace('"seq":4', '"seq":5'); }],
      ['statement swapped', (d) => { d.pack.statements[1].statement_canonical += ' '; }],
      ['dropped statement', (d) => { d.pack.statements.splice(2, 1); }],
      ['merkle path', (d) => { d.pack.anchors[0].inclusion_proof.merkle.path[0] = 'f'.repeat(64); }],
      ['manifest scope', (d) => { d.pack.manifest.scope.to = SCOPE_ALL.from; }],
      ['hint swapped (unsigned claim)', (d) => { d.pack.verification_hint.pinned_root_keyids = ['sha256:' + 'e'.repeat(64)]; }],
      ['signature bytes', (d) => { d.signature.signatures[0].sig = Buffer.from(Buffer.from(d.signature.signatures[0].sig, 'base64').map((b, i) => (i === 10 ? b ^ 1 : b))).toString('base64'); }],
      ['signature payload', (d) => {
        const body = JSON.parse(Buffer.from(d.signature.payload, 'base64').toString('utf8'));
        body.pack_digest = 'sha256:' + '0'.repeat(64);
        d.signature.payload = Buffer.from(canonicalize(body)).toString('base64');
      }],
    ];
    for (const [name, mutate] of cases) {
      const copy = structuredClone(download);
      mutate(copy);
      const res = oracleVerifyPack(copy, [w.k.root.keyid]);
      assert.equal(res.ok, false, name);
    }
  });

  test('a forged pack with its own root and a matching hint fails against the user\'s pin', async () => {
    const w = await trustWorld();
    const forger = await trustWorld();
    // The forger builds a pack over A's chain shape with its own root, keyset key and statement key.
    const chain = buildFixtureChain(A, forger.k.a1);
    const trust = await forger.material(A);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: segmentOf(chain, SCOPE_ALL, GEN), trust });
    const sig = await signPack(built, forger.resolver, A, 'r');
    const forged = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(sig)}}`);
    assert.deepEqual(oracleVerifyPack(forged, [forger.k.root.keyid]).breaks, [], 'self-consistent under the forger\'s own pin');
    const res = oracleVerifyPack(forged, [w.k.root.keyid]);
    assert.equal(res.ok, false, 'the user\'s pin rejects it, whatever the hint says');
    assert.ok(res.breaks.some((b) => /root document 1/.test(b)));
  });

  test('signPack: no key → NO_CREDENTIAL; activate before publish → SIGNER_UNAVAILABLE (retryable); KMS down → UNAVAILABLE', async () => {
    const w = await trustWorld();
    const { built } = await packFor(w, SCOPE_ALL);
    const none: SignerResolver = { resolve: async () => null };
    await assert.rejects(signPack(built, none, A, 'r'), (e: unknown) => e instanceof PackJobError && e.code === 'ATTESTA_SIGNER_NO_CREDENTIAL');
    // Rotate A to a new key without publishing: the resolver throws SigningUnavailable.
    const a2 = newKey();
    w.kms.keys.set('ref-a2', a2);
    const adapters: TrustAdapters = { 'kms-aws': new KmsSigner({ provider: w.kms, credentials: [
      { credentialId: 'aws-kms:a2', tenantId: A, displayName: 'a2', keyReference: 'ref-a2', publicKeySha256: a2.keyid }] }) };
    const ctx: InventoryContext = { ...w.ctx, adapters };
    await registerKey(ctx, { tenantId: A, purpose: 'statement', adapterName: 'kms-aws', credentialRef: 'aws-kms:a2' });
    const plan = await planTenantKeyCommand(ctx, 'activate', { tenantId: A, keyid: a2.keyid, replace: true });
    await applyTenantKeyCommand(ctx, 'activate', { tenantId: A, keyid: a2.keyid, replace: true }, plan.expect);
    const rotated = inventorySignerResolver(w.store, adapters, w.config, { now: () => new Date(T0) });
    await assert.rejects(signPack(built, rotated, A, 'r'), (e: unknown) => e instanceof PackJobError && e.code === 'ATTESTA_SIGNER_UNAVAILABLE');
    w.kms.down = true;
    await assert.rejects(signPack(built, w.resolver, A, 'r'), (e: unknown) => e instanceof PackJobError && e.code === 'ATTESTA_SIGNER_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// The job, over a memory store

async function jobWorld() {
  const w = await trustWorld();
  const store = new MemoryPackStore(new Map([[A, buildFixtureChain(A, w.k.a1)], [B, buildFixtureChain(B, w.k.b1)]]));
  const sink = new MemorySink();
  const logs: string[] = [];
  const deps = { store, sink: () => sink as EvidenceExportSink | null, resolver: async () => w.resolver, trust: w.material, log: (l: string) => logs.push(l) };
  return { w, store, sink, deps, logs };
}

describe('runEvidencePack', () => {
  const request: PackRequest = { scope: SCOPE_ALL, mode: 'full' };

  test('queued → running → ready; the stored bytes are the pack; the download verifies with the oracle', async () => {
    const j = await jobWorld();
    const { job } = await j.store.createOrGet({ tenantId: A, idempotencyKey: 'key-00001', request, requestedBy: 'auditor-a', requestId: 'r1' });
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'ready');
    const done = (await j.store.get(A, job.id))!;
    assert.equal(done.status, 'ready');
    const stored = await j.sink.read(done.storageReference!);
    assert.equal(sha256Prefixed(stored), done.packDigest);
    assert.equal(done.bytes, Buffer.byteLength(stored));
    const res = oracleVerifyPack(JSON.parse(downloadBody(done, stored)), [j.w.k.root.keyid]);
    assert.deepEqual(res.breaks, []);
    assert.equal(packStatusBody(done).content_path, `/api/attesta/evidence-packs/${job.id}/content`);
    assert.equal(packStatusBody(done).retryable, null);
    // Never twice: a second run does not claim a finished job.
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'not_claimed');
    assert.equal(j.store.readCount, 1);
    assert.throws(() => downloadBody(done, stored + ' '), /does not match its digest/);
  });

  test('a live lease is not taken; an expired one is retaken (one more attempt), and the old attempt cannot finish', async () => {
    const j = await jobWorld();
    const { job } = await j.store.createOrGet({ tenantId: A, idempotencyKey: 'key-00002', request, requestedBy: 'a', requestId: 'r' });
    assert.equal(await j.store.claim(A, job.id, 600_000), 1);
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'not_claimed', 'live lease');
    j.store.clock += 600_001;
    assert.deepEqual(await j.store.runnable(10), [{ tenantId: A, id: job.id }]);
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'ready');
    assert.equal((await j.store.get(A, job.id))!.attempts, 2);
    assert.equal(await j.store.finishReady(A, job.id, 1, { packDigest: 'x', storageReference: 'y', bytes: 1, counts: {} as PackCounts, signatureEnvelope: {} as DsseEnvelope }), false);
  });

  test('a lease lost while finishing leaves no file behind', async () => {
    const j = await jobWorld();
    const { job } = await j.store.createOrGet({ tenantId: A, idempotencyKey: 'key-00003', request, requestedBy: 'a', requestId: 'r' });
    const finish = j.store.finishReady.bind(j.store);
    j.store.finishReady = async (...args) => { j.store.jobs[0].attempts += 1; return finish(...args); };
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'lease_lost');
    assert.equal(j.sink.files.size, 0);
  });

  test('failures end failed with one code; never a partial pack', async () => {
    const cases: Array<[string, (j: Awaited<ReturnType<typeof jobWorld>>) => void, string, boolean]> = [
      ['no sink', (j) => { j.deps.sink = () => null; }, 'ATTESTA_API_UNAVAILABLE', true],
      ['sink refuses', (j) => { j.sink.failWrite = true; }, 'ATTESTA_API_UNAVAILABLE', true],
      ['trust unreadable', (j) => { j.deps.trust = async () => { throw new Error('db'); }; }, 'ATTESTA_API_UNAVAILABLE', true],
      ['signer config', (j) => { j.deps.resolver = async () => { throw new Error('env'); }; }, 'ATTESTA_SIGNER_UNAVAILABLE', true],
      ['no credential', (j) => { j.deps.resolver = async () => ({ resolve: async () => null }); }, 'ATTESTA_SIGNER_NO_CREDENTIAL', false],
      ['kms down', (j) => { j.w.kms.down = true; }, 'ATTESTA_SIGNER_UNAVAILABLE', true],
      ['chain inconsistent', (j) => { j.store.chains.get(A)!.records[4].prevHash = GENESIS_PREV_HASH; }, 'ATTESTA_API_INTERNAL', true],
      ['signer not in the pack\'s key set', (j) => { j.deps.trust = async () => j.w.material(B); }, 'ATTESTA_SIGNER_UNAVAILABLE', true],
    ];
    for (const [name, arrange, code, retryable] of cases) {
      const j = await jobWorld();
      arrange(j);
      const { job } = await j.store.createOrGet({ tenantId: A, idempotencyKey: 'key-00004', request, requestedBy: 'a', requestId: 'r' });
      assert.equal(await runEvidencePack(j.deps, A, job.id), 'failed', name);
      const failed = (await j.store.get(A, job.id))!;
      assert.equal(failed.errorCode, code, name);
      assert.equal(packStatusBody(failed).retryable, retryable, name);
      assert.equal(j.sink.files.size, 0, `${name}: no file`);
      assert.ok(j.logs.every((l) => /^attesta-pack ATTESTA_[A-Z_]+ pack_id=[0-9a-f-]+ cause=\w+$/.test(l)), `${name}: log carries codes only`);
    }
  });

  test('Company A/B: a job runs on its own tenant\'s chain only', async () => {
    const j = await jobWorld();
    const { job } = await j.store.createOrGet({ tenantId: B, idempotencyKey: 'key-00005', request, requestedBy: 'b', requestId: 'r' });
    assert.equal(await runEvidencePack(j.deps, A, job.id), 'not_claimed', 'A cannot run B\'s job');
    assert.equal(await runEvidencePack(j.deps, B, job.id), 'ready');
    const done = (await j.store.get(B, job.id))!;
    const pack = JSON.parse(await j.sink.read(done.storageReference!));
    assert.equal(pack.manifest.tenant_id, B);
    assert.ok(!JSON.stringify(pack).includes(A));
    assert.equal(JSON.parse(Buffer.from(done.signatureEnvelope!.payload, 'base64').toString()).manifest.tenant_id, B);
    assert.equal(done.signatureEnvelope!.signatures[0].keyid, j.w.k.b1.keyid);
  });
});

describe('request parsing', () => {
  const now = new Date(T0);
  test('accepts the documented body and normalizes instants', () => {
    const r = parsePackRequest({ from: '2026-10-13T10:00:00+05:30', to: '2026-10-13T11:00:00.000500Z', repository_id: R1, mode: 'repository_only' }, now);
    assert.deepEqual(r, { scope: { repository_id: R1, from: '2026-10-13T04:30:00.000Z', to: '2026-10-13T11:00:00.000Z' }, mode: 'repository_only' });
    assert.equal(parsePackRequest({ from: '2026-10-13T10:00:00.000500Z', to: '2026-10-13T11:00:00Z' }, now).scope.from, '2026-10-13T10:00:00.001Z', 'from rounds inward');
    assert.equal(parsePackRequest({ from: '2026-10-13T10:00:00Z', to: '2026-10-13T11:00:00Z' }, now).mode, 'full');
    assert.ok(sameRequest(r, { scope: { ...r.scope }, mode: 'repository_only' }));
    assert.ok(!sameRequest(r, { scope: { ...r.scope }, mode: 'full' }));
    assert.ok(!sameRequest(r, { scope: { ...r.scope, to: '2026-10-13T11:00:00.001Z' }, mode: 'repository_only' }));
  });

  test('refuses everything else', () => {
    const bad: unknown[] = [
      null, [], 'x', {}, { from: '2026-10-13T10:00:00Z' },
      { from: '2026-10-13T10:00:00Z', to: '2026-10-13T09:00:00Z' },
      { from: '2026-10-13T10:00:00Z', to: '2026-10-13T11:56:00Z' },
      { from: '2026-10-13T10:00:00Z', to: '2026-10-13T11:00:00Z', mode: 'everything' },
      { from: '2026-10-13T10:00:00Z', to: '2026-10-13T11:00:00Z', repository_id: 'R1' },
      { from: '2026-10-13T10:00:00Z', to: '2026-10-13T11:00:00Z', extra: 1 },
      { from: '2026-02-30T10:00:00Z', to: '2026-10-13T11:00:00Z' },
      { from: 1, to: 2 },
    ];
    for (const b of bad) assert.throws(() => parsePackRequest(b, now), AttestaQueryError, JSON.stringify(b));
    for (const k of [undefined, '', 'short', 'x'.repeat(65), 'has space1', 'naïve-key1']) assert.throws(() => parseIdempotencyKey(k), AttestaQueryError);
    assert.equal(parseIdempotencyKey('Order-2026.10_13'), 'Order-2026.10_13');
    assert.throws(() => parseStoredScope({ from: 'x', to: 'y', repository_id: null }), PackJobError);
    assert.throws(() => parseStoredScope({ ...SCOPE_ALL, extra: 1 }), PackJobError);
    assert.deepEqual(parseStoredScope(SCOPE_ALL), SCOPE_ALL);
  });
});

describe('packTrustFrom', () => {
  test('root and key-set documents from version 1, the anchoring key with its root entry, offsets as decimal tree IDs', async () => {
    const w = await trustWorld();
    const t = (await w.material(A)).trust;
    assert.equal(t.root_documents.length, 1);
    assert.equal(t.keyset_documents.length, 1);
    assert.equal(t.anchoring_keys.length, 1);
    assert.equal(t.anchoring_keys[0].keyid, w.k.anchor.keyid);
    assert.equal((t.anchoring_keys[0].root_entry as { purpose: string }).purpose, 'anchor');
    assert.deepEqual(t.rekor_log_index_offsets, { [BigInt('0x1122334455667788').toString(10)]: 7 });
    assert.ok(verify('sha256', Buffer.from('x'), createPublicKey({ key: Buffer.from(t.rekor_log_key_spki_b64!, 'base64'), format: 'der', type: 'spki' }),
      cryptoSign('sha256', Buffer.from('x'), w.k.anchor.priv)));
    const dev = packTrustFrom({ published: { rootDocuments: [], keysetDocuments: [] }, anchors: null, pinnedRootKeyids: [] });
    assert.deepEqual(dev.trust, { root_documents: [], keyset_documents: [], anchoring_keys: [], rekor_log_key_spki_b64: null,
      rekor_log_index_offsets: null, tsa_anchors_der_b64: [] });
  });
});
