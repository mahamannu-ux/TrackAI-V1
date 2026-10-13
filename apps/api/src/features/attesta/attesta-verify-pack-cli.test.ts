/**
 * `attesta:verify-pack` (Task15j, A15.10): argument handling, file handling, output
 * formats, the state file and exit-code equality with the pure report.
 *
 * Packs are small fixture builds with schema-valid statements (see
 * offline-verifier.test.ts for the real-anchor coverage); the CLI is a thin shell
 * around `verifyEvidencePack`, so these tests prove the shell: every exit code equals
 * the report's, files are read and written through the injected IO, and failures name
 * the file, never a stack trace or key material.
 *
 * Ported from SushiCorp services/anchoring/offline_verify.py @ 0bd67a5 (catalog EV-2)
 * - Node instead of Python;
 * - the trust documents travel in the pack, but the pin is the user's;
 * - DSSE and in-toto instead of JCS records;
 * - two pack modes.
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { GENESIS_PREV_HASH, canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import { AI_PROVENANCE_PREDICATE_TYPE, LEDGER_RECORD_KIND, buildCanonicalRecord } from './ledger';
import { buildPack, packTrustFrom, signPack, type PackScope } from './evidence-pack-service';
import { DualAnchor, anchorProofJson } from './anchor-dual';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { inclusionPath, merkleRoot, proofToJson } from './merkle';
import { publishedKeysFor } from './trust-resolver';
import { FakeRekor, REKOR_TREE_ID_DEC, REKOR_TREE_ID_HEX } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { __setSchemaDirForTests, verifyEvidencePack } from './offline-verifier';
import { main, type VerifyPackIo } from './attesta-verify-pack-cli';
import {
  A,
  MIN,
  PACK_1,
  R1,
  R2,
  T0,
  at,
  newKey,
  segmentOf,
  trustWorld,
  type ChainRecord,
  type World,
} from './testing/evidence-pack-fixtures';
import { shaOf } from './testing/ledger-fixtures';

type Key = ReturnType<typeof newKey>;
type Download = { pack: Record<string, any>; signature: DsseEnvelope }; // eslint-disable-line @typescript-eslint/no-explicit-any

const REC_BASE = T0;
const SCOPE_ALL: PackScope = { repository_id: null, from: at(T0 + 2 * MIN), to: at(T0 + 8 * MIN) };
const SCOPE_R1: PackScope = { ...SCOPE_ALL, repository_id: R1 };
const GEN = at(T0 + 20 * MIN);
const NOW_MS = Date.parse(at(T0 + 25 * MIN));

const FIXTURE_STATEMENTS = ['valid-commit-observed.json', 'valid-pr-merged.json', 'valid-deployed.json', 'valid-hashed-model.json'];
function buildValidChain(tenantId: string, key: Key, n = 12, base = REC_BASE): { records: ChainRecord[]; anchors: never[]; batches: never[] } {
  const records: ChainRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let seq = 0; seq < n; seq++) {
    const repositoryId = seq % 2 === 0 ? R1 : R2;
    const stmt = JSON.parse(readFileSync(join(__dirname, '../../../../../docs/contracts/attesta/fixtures', FIXTURE_STATEMENTS[seq % FIXTURE_STATEMENTS.length]), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    stmt.predicate.as_of = at(base + seq * MIN - 1000);
    // The record's typed copies must equal the signed statement (the verifier binds
    // them): point this copy at its own repository, keeping S1/S2 intact.
    stmt.predicate.repository.id = repositoryId;
    stmt.subject[0].name = `trackai:repository/${repositoryId}/commit/${stmt.subject[0].digest.gitCommit}`;
    const statementCanonical = canonicalize(stmt);
    const statementDigest = sha256Prefixed(statementCanonical);
    const recordedAt = at(base + seq * MIN);
    const subjectSha = typeof stmt.subject?.[0]?.digest?.gitCommit === 'string' ? stmt.subject[0].digest.gitCommit as string : shaOf(`${tenantId}-${seq}`);
    const canonicalRecord = buildCanonicalRecord({
      seq, prev_hash: prev, recorded_at: recordedAt, tenant_id: tenantId, record_kind: LEDGER_RECORD_KIND,
      statement_digest: statementDigest, predicate_type: AI_PROVENANCE_PREDICATE_TYPE, statement_kind: stmt.predicate?.statement_kind ?? 'commit_observed',
      repository_id: repositoryId, subject_sha: subjectSha, outbox_subject_id: null,
    });
    const recordHash = computeRecordHash(canonicalRecord, prev);
    const payload = Buffer.from(statementCanonical, 'utf8');
    const sig = cryptoSign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: key.priv, dsaEncoding: 'der' });
    const envelope: DsseEnvelope = { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }] };
    records.push({ seq, prevHash: prev, recordHash, canonicalRecord, recordedAt, repositoryId, statementDigest,
      statementCanonical, envelope, statementCanonicalAll: statementCanonical, envelopeAll: envelope });
    prev = recordHash;
  }
  return { records, anchors: [], batches: [] };
}

function memIo(files: Record<string, string>, nowMs: number = NOW_MS) {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: VerifyPackIo & { lines: string[]; errors: string[]; files: Record<string, string> } = {
    lines, errors, files,
    readFile: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    writeFile: (p, t) => {
      files[p] = t;
    },
    renameFile: (t, d) => {
      files[d] = files[t];
      delete files[t];
    },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    now: () => new Date(nowMs),
  };
  return io;
}

async function pendingDownload(w: World, scope: PackScope = SCOPE_ALL, mode: 'full' | 'repository_only' = 'full'): Promise<Download> {
  const chain = buildValidChain(A, w.k.a1);
  const seg = segmentOf(chain, scope, GEN);
  const trust = await w.material(A);
  const built = buildPack({ packId: PACK_1, tenantId: A, scope, mode, segment: { ...seg, anchors: [], batches: [] }, trust });
  const signature = await signPack(built, w.resolver, A, 'req-1');
  return JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
}

/** A small real-anchor pack (full scope, every in-scope record anchored through both fakes). */
async function realDownload(w: World): Promise<{ download: Download; rekor: FakeRekor; tsa: FakeTsa }> {
  const anchorAtMs = Date.parse(at(T0 + 15 * MIN));
  const chain = buildValidChain(A, w.k.a1);
  const seg = segmentOf(chain, SCOPE_ALL, GEN);
  const inScope = seg.records.filter((r) => r.statementCanonical !== null).map((r) => r.seq);
  const min = Math.min(...inScope);
  const max = Math.max(...inScope);
  const range = chain.records.filter((r) => r.seq >= min && r.seq <= max);
  const leaves = range.map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
  const root = merkleRoot(leaves);
  const batchId = `${A}:${min}-${max}`;
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(anchorAtMs / 1000) - 1;
  const realNow = Date.now;
  Date.now = () => anchorAtMs;
  let tsa: FakeTsa;
  try {
    tsa = await FakeTsa.create({ genTime: new Date(anchorAtMs) });
  } finally {
    Date.now = realNow;
  }
  const signer = {
    publicKeySpkiDer: async () => Buffer.from(w.k.anchor.spki),
    sign: async (b: Buffer) => cryptoSign('sha256', b, { key: w.k.anchor.priv, dsaEncoding: 'der' }),
  };
  const pemLog = (k: Parameters<typeof createPublicKey>[0]): string =>
    createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();
  const dual = new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: pemLog(rekor.logKey), production: false, now: () => new Date(anchorAtMs) }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch, now: () => new Date(anchorAtMs) }),
  );
  const outcome = await dual.anchor(root, batchId);
  assert.equal(outcome.complete, true);
  const rekorResult = (outcome.rekor as { result: Parameters<typeof anchorProofJson>[1] }).result;
  const tsaResult = (outcome.tsa as { result: Parameters<typeof anchorProofJson>[1] }).result;
  const anchors: unknown[] = [];
  for (const seq of inScope) {
    const i = seq - min;
    const merkle = proofToJson(i, range.length, inclusionPath(leaves, i));
    anchors.push({ seq, anchorType: 'rekor', batchId, inclusionProof: anchorProofJson(merkle, rekorResult), rekorEntryUuid: (rekorResult as { entryId: string }).entryId, tsaTokenB64: null });
    anchors.push({ seq, anchorType: 'tsa', batchId, inclusionProof: anchorProofJson(merkle, tsaResult), rekorEntryUuid: null, tsaTokenB64: ((tsaResult as { tokenDer: Buffer }).tokenDer).toString('base64') });
  }
  const batches = [{ batchId, seqFrom: min, seqTo: max, leafCount: range.length, merkleRoot: `sha256:${root.toString('hex')}` }];
  const trust = packTrustFrom({
    published: await publishedKeysFor(w.store, A),
    anchors: {
      rekorLogKey: createPublicKey(rekor.logKey),
      anchorKeysSpkiDer: [w.k.anchor.spki],
      tsaAnchors: loadTrustAnchors(tsa.anchorsPem),
      rekorLogIndexOffsets: { [REKOR_TREE_ID_HEX]: 0 },
    },
    pinnedRootKeyids: w.config.pinnedRootKeyids,
  });
  const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full',
    segment: { ...seg, anchors: anchors as never, batches: batches as never }, trust });
  const signature = await signPack(built, w.resolver, A, 'req-1');
  const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
  return { download, rekor, tsa };
}

describe('attesta:verify-pack CLI', () => {
  test('a pending pack inside the window exits 0 with a human summary', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid], io);
    assert.equal(code, 0);
    assert.ok(io.lines.some((l) => l.includes('trust_and_signature: passed')), io.lines.join('\n'));
    assert.ok(io.lines.some((l) => l.includes('anchors: warning')), io.lines.join('\n'));
    assert.ok(io.lines.some((l) => l.includes('result: passed (exit 0)')), io.lines.join('\n'));
    assert.ok(io.lines.some((l) => l.startsWith('counts: records=9 statements=7')), io.lines.join('\n'));
  });

  test('--json prints the report and the exit code equals the report', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--json'], io);
    const report = JSON.parse(io.lines.join('\n'));
    assert.equal(code, report.exit_code);
    assert.equal(code, 0);
    assert.equal(report.checks.length, 7);
    const expected = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: new Date(NOW_MS).toISOString() });
    assert.deepEqual(report.checks, expected.checks);
  });

  test('a tampered pack exits 1, matching the report', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    download.pack.statements[0].statement_canonical += ' ';
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid], io);
    const expected = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: new Date(NOW_MS).toISOString() });
    assert.equal(code, 1);
    assert.equal(code, expected.exit_code);
  });

  test('repository_only exits 2, matching the report', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w, SCOPE_R1, 'repository_only');
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid], io);
    const expected = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: new Date(NOW_MS).toISOString() });
    assert.equal(code, 2);
    assert.equal(code, expected.exit_code);
    assert.ok(io.lines.some((l) => l.includes('completeness: not_checkable')), io.lines.join('\n'));
  });

  test('a missing pack file exits 2 without a stack trace', async () => {
    const w = await trustWorld();
    const io = memIo({});
    const code = await main(['--pack', '/gone.json', '--root-keyid', w.k.root.keyid], io);
    assert.equal(code, 2);
    assert.ok(io.errors.join('\n').includes('/gone.json'));
    assert.doesNotMatch(io.errors.join('\n'), /\n\s+at\s/);
  });

  test('an invalid pack file exits 2', async () => {
    const w = await trustWorld();
    const io = memIo({ '/pack.json': '{not json' });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid], io);
    assert.equal(code, 2);
  });

  test('no pin exits 2; a bad keyid exits 2; unknown flags exit 2', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const files = { '/pack.json': JSON.stringify(download), '/pin.json': '[]' };
    assert.equal(await main(['--pack', '/pack.json'], memIo(files)), 2);
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', 'nope'], memIo(files)), 2);
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--bogus'], memIo(files)), 2);
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--json=yes'], memIo(files)), 2);
  });

  test('root-keyid plus customer-pin is allowed (pin decides, root feeds anchor windows)', async () => {
    const w = await trustWorld();
    const { download, rekor, tsa } = await realDownload(w);
    const keyset = JSON.parse(Buffer.from(download.pack.trust.keyset_documents[0].payload, 'base64').toString('utf8'));
    const pins = keyset.keys.filter((k: { purpose: string }) => k.purpose === 'statement');
    const io = memIo({
      '/pack.json': JSON.stringify(download),
      '/pin.json': JSON.stringify(pins),
      '/rekor.pem': createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
      '/tsa.pem': tsa.anchorsPem,
    });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--customer-pin', '/pin.json',
      '--rekor-log-key', '/rekor.pem', '--tsa-anchors', '/tsa.pem'], io);
    assert.equal(code, 0);
    assert.ok(io.lines.some((l) => l.includes('anchors: passed')), io.lines.join('\n'));
  });

  test('an unreadable Rekor key or TSA anchors file exits 2', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const files = { '/pack.json': JSON.stringify(download) };
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--rekor-log-key', '/gone.pem'], memIo(files)), 2);
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--tsa-anchors', '/gone.pem'], memIo(files)), 2);
    const bad = { ...files, '/rekor.pem': 'not a key', '/tsa.pem': 'not certs' };
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--rekor-log-key', '/rekor.pem'], memIo(bad)), 2);
    assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--tsa-anchors', '/tsa.pem'], memIo(bad)), 2);
  });

  test('the state file is written after a pass and read back', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const args = ['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--state', '/state.json'];
    assert.equal(await main(args, io), 0);
    assert.ok(io.errors.some((l) => l.includes('state file not found; starting fresh (first use)')), io.errors.join('\n'));
    const state = JSON.parse(io.files['/state.json']);
    assert.ok(typeof state.lastTrusted?.platform?.digest === 'string');
    assert.ok(typeof state.lastTrusted?.[A]?.digest === 'string');
    assert.equal(state.trustedTimeFloor, new Date(NOW_MS).toISOString());
    // Read back: still a pass, and the file is rewritten, not duplicated.
    const errorsBefore = io.errors.length;
    assert.equal(await main(args, io), 0);
    assert.equal(io.errors.length, errorsBefore, 'no fresh-start notice once the file exists');
    assert.deepEqual(JSON.parse(io.files['/state.json']), state);
  });

  test('a bad state file exits 2', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    for (const bad of ['{no', '{"lastTrusted":[]}', '{"lastTrusted":{"platform":{"version":"1","digest":"x"}}}']) {
      const io = memIo({ '/pack.json': JSON.stringify(download), '/state.json': bad });
      assert.equal(await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--state', '/state.json'], io), 2, bad);
    }
  });

  test('customer pins verify without a root pin', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const keyset = JSON.parse(Buffer.from(download.pack.trust.keyset_documents[0].payload, 'base64').toString('utf8'));
    const pins = keyset.keys.filter((k: { purpose: string }) => k.purpose === 'statement');
    assert.ok(pins.length > 0);
    const io = memIo({ '/pack.json': JSON.stringify(download), '/pin.json': JSON.stringify(pins) });
    const code = await main(['--pack', '/pack.json', '--customer-pin', '/pin.json'], io);
    const expected = verifyEvidencePack(download, {
      pinnedRootKeyids: [],
      customerPins: pins,
      now: new Date(NOW_MS).toISOString(),
    });
    assert.equal(code, expected.exit_code);
    assert.equal(code, 0);
  });

  test('nothing printed or written is key material', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--json', '--state', '/state.json'], io);
    const text = [...io.lines, ...io.errors, io.files['/state.json']].join('\n');
    assert.doesNotMatch(text, /BEGIN|PRIVATE/);
  });

  test('offsets file: missing or malformed exits 2', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const base = { '/pack.json': JSON.stringify(download) };
    const args = ['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--rekor-log-index-offsets', '/offsets.json'];
    assert.equal(await main(args, memIo(base)), 2);
    assert.equal(await main(args, memIo({ ...base, '/offsets.json': '{no' })), 2);
    assert.equal(await main(args, memIo({ ...base, '/offsets.json': '[]' })), 2);
    assert.equal(await main(args, memIo({ ...base, '/offsets.json': '{"abc": 0}' })), 2);
    assert.equal(await main(args, memIo({ ...base, '/offsets.json': '{"123": -1}' })), 2);
  });

  test('offsets flow through: correct passes, wrong fails with the sharding hint', async () => {
    const w = await trustWorld();
    const { download, rekor, tsa } = await realDownload(w);
    const keyPem = createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString();
    const files = {
      '/pack.json': JSON.stringify(download),
      '/rekor.pem': keyPem,
      '/tsa.pem': tsa.anchorsPem,
      '/offsets-ok.json': JSON.stringify({ [REKOR_TREE_ID_DEC]: 0 }),
      '/offsets-bad.json': JSON.stringify({ [REKOR_TREE_ID_DEC]: 5 }),
    };
    const base = ['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--rekor-log-key', '/rekor.pem', '--tsa-anchors', '/tsa.pem'];
    assert.equal(await main(base, memIo(files)), 0);
    const okIo = memIo(files);
    assert.equal(await main([...base, '--rekor-log-index-offsets', '/offsets-ok.json'], okIo), 0);
    assert.ok(!okIo.errors.join('\n').includes('--rekor-log-index-offsets'));
    const badIo = memIo(files);
    assert.equal(await main([...base, '--rekor-log-index-offsets', '/offsets-bad.json'], badIo), 1);
  });

  test('failed anchors with keys but no offsets file print the sharding hint', async () => {
    const w = await trustWorld();
    // Anchored claims with unusable proofs: the anchors check fails while keys are
    // supplied and no offsets file was given, which is exactly the sharded-log shape.
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const leaves = chain.records.slice(0, 4).map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
    const batchId = `${A}:0-3`;
    const batches = [{ batchId, seqFrom: 0, seqTo: 3, leafCount: 4, merkleRoot: `sha256:${merkleRoot(leaves).toString('hex')}` }];
    const anchors: unknown[] = [];
    for (const seq of [2, 3]) {
      const merkle = proofToJson(seq, 4, inclusionPath(leaves, seq));
      anchors.push({ seq, anchorType: 'rekor', batchId,
        inclusionProof: { version: 1, merkle, anchor: { type: 'rekor', ref: 'a'.repeat(64), log_index: 1, proof_b64: 'AA==', rekor_entry: { integratedTime: 1 } } },
        rekorEntryUuid: 'a'.repeat(64), tsaTokenB64: null });
      anchors.push({ seq, anchorType: 'tsa', batchId,
        inclusionProof: { version: 1, merkle, anchor: { type: 'tsa', ref: 'tsa:x', log_index: null, proof_b64: null, rekor_entry: null,
          gen_time: at(T0 + 15 * MIN), serial_number: '1', policy: '1.2.3', revocation: { status: 'clean', reason: 'ocsp_good' } } },
        rekorEntryUuid: null, tsaTokenB64: 'AAAA' });
    }
    const trust = await w.material(A);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full',
      segment: { ...seg, anchors: anchors as never, batches: batches as never }, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const tsa = await FakeTsa.create();
    const io = memIo({
      '/pack.json': JSON.stringify(download),
      '/rekor.pem': generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      '/tsa.pem': tsa.anchorsPem,
    });
    const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--rekor-log-key', '/rekor.pem', '--tsa-anchors', '/tsa.pem'], io);
    assert.equal(code, 1);
    assert.ok(io.errors.join('\n').includes('--rekor-log-index-offsets'), io.errors.join('\n'));
  });

  test('a broken verifier installation exits 2 with a verifier error', async () => {
    const w = await trustWorld();
    const download = await pendingDownload(w);
    const io = memIo({ '/pack.json': JSON.stringify(download) });
    const dir = mkdtempSync(join(tmpdir(), 'attesta-no-schemas-'));
    __setSchemaDirForTests(dir);
    try {
      const code = await main(['--pack', '/pack.json', '--root-keyid', w.k.root.keyid, '--json'], io);
      assert.equal(code, 2);
      assert.ok(io.errors.some((l) => l.includes('verifier error: contract schemas unavailable')), io.errors.join('\n'));
      assert.equal(JSON.parse(io.lines.join('\n')).verifier_error, 'contract schemas unavailable');
    } finally {
      __setSchemaDirForTests(undefined);
    }
  });
});
