// Ported from SushiCorp tests/unit/anchor/test_anchor_tsa.py (dual cases) and
// tests/unit/evidence/test_evidence_anchoring.py (stored proof round trip)
// @ 0bd67a5 (catalog EV-2), adapted to one row per record and anchor type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL, makeCa } from './testing/fake-tsa';
import { inclusionPath, merkleRoot, proofToJson } from './merkle';
import { ATTESTA_PLATFORM_TENANT_ID, AnchorInputError, anchorSignerFromAdapter } from './anchor-contract';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors, type TsaRevocationChecker } from './anchor-tsa';
import { DualAnchor, anchorProofJson, verifyStoredAnchor, type AnchorProofJson, type StoredAnchorKeys } from './anchor-dual';
import { LocalDevSigner, generateDevCredential } from './signer-local-dev';

const ROOT = randomBytes(32);

function signer() {
  const cred = generateDevCredential('dev:anchor', ATTESTA_PLATFORM_TENANT_ID);
  return anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
}

const pem = (k: KeyObject): string => (k.type === 'public' ? k : createPublicKey(k)).export({ type: 'spki', format: 'pem' }).toString();

async function setup(revocation?: TsaRevocationChecker) {
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000); // the fake's clock starts in the past; integratedTime is bounded
  const tsa = await FakeTsa.create();
  const s = signer();
  const dual = new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer: s, fetch: rekor.fetch, logPublicKeyPem: pem(rekor.logKey), production: false }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch, revocation }),
  );
  const keys: StoredAnchorKeys = {
    rekorLogKey: createPublicKey(rekor.logKey),
    anchorKeysSpkiDer: [await s.publicKeySpkiDer()],
    tsaAnchors: loadTrustAnchors(tsa.anchorsPem),
  };
  return { rekor, tsa, dual, keys };
}

test('dual carries both verified results', async () => {
  const { dual } = await setup();
  const out = await dual.anchor(ROOT, 'b');
  assert.equal(out.complete, true);
  assert.equal(out.rekor.status, 'anchored');
  assert.equal(out.tsa.status, 'anchored');
  assert.equal(await dual.health(), true);
});

test('dual is all or nothing; Rekor first, no token spent while the log is down; retry reuses the entry', async () => {
  const { rekor, tsa, dual } = await setup();
  tsa.down = true;
  let out = await dual.anchor(ROOT, 'b');
  assert.equal(out.complete, false);
  assert.equal(out.rekor.status, 'anchored');
  assert.deepEqual(out.tsa, { status: 'failed', code: 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', retryable: true });
  assert.equal(await dual.health(), false);

  tsa.down = false;
  rekor.down = true;
  out = await dual.anchor(randomBytes(32), 'c');
  assert.equal(out.complete, false);
  assert.deepEqual(out.rekor, { status: 'failed', code: 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', retryable: true });
  assert.deepEqual(out.tsa, { status: 'skipped' });
  assert.equal(tsa.posts, 0);

  rekor.down = false;
  out = await dual.anchor(ROOT, 'b'); // the retry after the TSA outage
  assert.equal(out.complete, true);
  assert.equal(rekor.bodies.length, 1);
});

test('a lying side fails only its own type, with its code', async () => {
  const { rekor, tsa, dual } = await setup();
  tsa.nonceOffset = 1;
  let out = await dual.anchor(ROOT, 'b');
  assert.equal(out.complete, false);
  assert.deepEqual(out.tsa, { status: 'failed', code: 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID', retryable: true });
  tsa.nonceOffset = 0;
  rekor.setKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  out = await dual.anchor(randomBytes(32), 'c');
  assert.deepEqual(out.rekor, { status: 'failed', code: 'ATTESTA_ANCHOR_LOG_PROOF_INVALID', retryable: true });
});

test('caller bugs are thrown, never recorded as anchor failures', async () => {
  const { dual } = await setup();
  await assert.rejects(dual.anchor(Buffer.alloc(3), 'b'), AnchorInputError);
});

// ---------------------------------------------------------------------------
// Stored proofs: anchor a batch, store per-record proofs, verify offline
// ---------------------------------------------------------------------------

async function anchoredBatch(n: number, revocation?: TsaRevocationChecker) {
  const ctx = await setup(revocation);
  const recordHashes = Array.from({ length: n }, (_, i) => 'sha256:' + createHash('sha256').update(`record ${i}`).digest('hex'));
  const leaves = recordHashes.map((h) => Buffer.from(h.slice(7), 'hex'));
  const root = merkleRoot(leaves);
  const out = await ctx.dual.anchor(root, `t:0-${n - 1}`);
  assert.ok(out.complete && out.rekor.status === 'anchored' && out.tsa.status === 'anchored');
  const rows = recordHashes.flatMap((recordHash, i) => {
    const merkle = proofToJson(i, n, inclusionPath(leaves, i));
    const results = [out.rekor, out.tsa].map((a) => (a as { result: Parameters<typeof anchorProofJson>[1] }).result);
    return results.map((result) => ({
      anchorType: result.type,
      // stored as JSONB and read back
      proof: JSON.parse(JSON.stringify(anchorProofJson(merkle, result))) as AnchorProofJson,
      recordHash,
      merkleRoot: 'sha256:' + root.toString('hex'),
      rekorEntryUuid: result.type === 'rekor' ? result.entryId : null,
      tsaTokenB64: result.type === 'tsa' ? result.tokenDer.toString('base64') : null,
    }));
  });
  return { ...ctx, rows, root };
}

test('every record of a batch verifies offline for both anchor types; unknown revocation is stated', async () => {
  const { rows, keys } = await anchoredBatch(5);
  assert.equal(rows.length, 10);
  for (const row of rows) {
    const check = verifyStoredAnchor(row, keys);
    assert.equal(check.status, 'valid', `${row.anchorType} ${row.recordHash}`);
    if (row.anchorType === 'tsa') {
      assert.deepEqual((check as { revocation: unknown }).revocation, { status: 'unknown', reason: 'not_rechecked_offline' });
      assert.deepEqual((check as { recordedRevocation: unknown }).recordedRevocation, { status: 'unknown', reason: 'no_source_configured' });
      assert.equal((row.proof.anchor as { rekor_entry: unknown }).rekor_entry, null);
    }
    assert.equal(row.proof.version, 1);
    assert.deepEqual(Object.keys(row.proof.anchor).slice(0, 5), ['type', 'ref', 'log_index', 'proof_b64', 'rekor_entry']);
  }
  const rekorRow = rows.find((r) => r.anchorType === 'rekor')!;
  assert.ok('rekor_entry' in rekorRow.proof.anchor);
});

type Row = Awaited<ReturnType<typeof anchoredBatch>>['rows'][number];
const mutateProof = (row: Row, f: (p: Record<string, any>) => void): Row => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = structuredClone(row.proof) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  f(p);
  return { ...row, proof: p as AnchorProofJson };
};

test('tampering with a stored row is caught offline with the right code', async () => {
  const { rows, keys } = await anchoredBatch(4);
  const rekorRow = rows.find((r) => r.anchorType === 'rekor')!;
  const tsaRow = rows.find((r) => r.anchorType === 'tsa')!;
  const other = 'sha256:' + 'ab'.repeat(32);
  const M = 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID';
  const A = 'ATTESTA_VERIFY_ANCHOR_INVALID';
  const cases: Array<[string, Row, string]> = [
    ['record hash', { ...rekorRow, recordHash: other }, M],
    ['batch root', { ...tsaRow, merkleRoot: other }, M],
    ['merkle path', mutateProof(rekorRow, (p) => { p.merkle.path[0] = '00'.repeat(32); }), M],
    ['merkle index', mutateProof(rekorRow, (p) => { p.merkle.leaf_index = (p.merkle.leaf_index + 1) % 4; }), M],
    ['merkle size', mutateProof(rekorRow, (p) => { p.merkle.tree_size = 5; }), M],
    ['rekor entry time', mutateProof(rekorRow, (p) => { p.anchor.rekor_entry.integratedTime += 1; }), A],
    ['rekor log_index', mutateProof(rekorRow, (p) => { p.anchor.log_index += 1; }), A],
    ['rekor proof_b64', mutateProof(rekorRow, (p) => { p.anchor.proof_b64 = Buffer.from('{}').toString('base64'); }), A],
    ['rekor uuid column', { ...rekorRow, rekorEntryUuid: '00'.repeat(40) }, A],
    ['type swap', { ...rekorRow, anchorType: 'tsa' }, A],
    ['version 2', mutateProof(rekorRow, (p) => { p.version = 2; }), A],
    ['tsa token swapped', { ...tsaRow, tsaTokenB64: Buffer.from('x').toString('base64') }, A],
    ['tsa token not base64', { ...tsaRow, tsaTokenB64: '!!' }, A],
    ['tsa gen_time', mutateProof(tsaRow, (p) => { p.anchor.gen_time = '2020-01-01T00:00:00.000Z'; }), A],
    ['tsa revoked recorded', mutateProof(tsaRow, (p) => { p.anchor.revocation = { status: 'revoked', reason: 'x' }; }), A],
    ['tsa policy', mutateProof(tsaRow, (p) => { p.anchor.policy = '1.2.3'; }), A],
    ['tsa log_index set', mutateProof(tsaRow, (p) => { p.anchor.log_index = 0; }), A],
    ['tsa proof_b64 set', mutateProof(tsaRow, (p) => { p.anchor.proof_b64 = 'AA=='; }), A],
    ['tsa token with whitespace', { ...tsaRow, tsaTokenB64: ` ${tsaRow.tsaTokenB64}` }, A],
    ['unknown type', mutateProof({ ...rekorRow, anchorType: 'other' as 'rekor' }, (p) => { p.anchor.type = 'other'; }), A],
  ];
  for (const [name, row, code] of cases) {
    assert.deepEqual(verifyStoredAnchor(row, keys), { status: 'invalid', code }, name);
  }
  // The token of another batch, with its matching ref: the imprint does not match this root.
  const second = await anchoredBatch(2);
  const foreignTsa = second.rows.find((r) => r.anchorType === 'tsa')!;
  assert.deepEqual(verifyStoredAnchor({ ...tsaRow, tsaTokenB64: foreignTsa.tsaTokenB64, proof: mutateProof(tsaRow, (p) => { p.anchor.ref = foreignTsa.proof.anchor.ref; }).proof }, keys),
    { status: 'invalid', code: A });
  // A stored "clean" (or junk) is never re-asserted as clean offline: it is unsigned.
  const forgedClean = mutateProof(tsaRow, (p) => { p.anchor.revocation = { status: 'clean', reason: 'ocsp_good' }; });
  assert.deepEqual(verifyStoredAnchor(forgedClean, keys), {
    status: 'valid',
    revocation: { status: 'unknown', reason: 'not_rechecked_offline' },
    recordedRevocation: { status: 'clean', reason: 'ocsp_good' },
  });
  const junk = mutateProof(tsaRow, (p) => { p.anchor.revocation = { status: 'CLEAN' }; });
  assert.deepEqual(verifyStoredAnchor(junk, keys), { status: 'invalid', code: A });
});

test('Codex review #3: each kind has a fixed row and proof shape; incomplete or cross-kind rows are invalid', async () => {
  const { rows, keys } = await anchoredBatch(3);
  const rekorRow = rows.find((r) => r.anchorType === 'rekor')!;
  const tsaRow = rows.find((r) => r.anchorType === 'tsa')!;
  const A = { status: 'invalid', code: 'ATTESTA_VERIFY_ANCHOR_INVALID' };
  const M = { status: 'invalid', code: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID' };
  const cases: Array<[string, Row, object]> = [
    ['rekor row without entry uuid (null)', { ...rekorRow, rekorEntryUuid: null }, A],
    ['rekor row without entry uuid (absent)', { ...rekorRow, rekorEntryUuid: undefined as unknown as null }, A],
    ['rekor row carrying a token', { ...rekorRow, tsaTokenB64: tsaRow.tsaTokenB64 }, A],
    ['rekor proof without rekor_entry', mutateProof(rekorRow, (p) => { delete p.anchor.rekor_entry; }), A],
    ['rekor proof with tsa fields', mutateProof(rekorRow, (p) => { p.anchor.gen_time = '2026-01-01T00:00:00.000Z'; }), A],
    ['rekor proof without proof_b64', mutateProof(rekorRow, (p) => { delete p.anchor.proof_b64; }), A],
    ['tsa row without token', { ...tsaRow, tsaTokenB64: null }, A],
    ['tsa row with an entry uuid', { ...tsaRow, rekorEntryUuid: rekorRow.rekorEntryUuid }, A],
    ['tsa proof with a rekor_entry', mutateProof(tsaRow, (p) => { p.anchor.rekor_entry = rekorRow.proof.anchor.rekor_entry; }), A],
    ['tsa proof without rekor_entry key', mutateProof(tsaRow, (p) => { delete p.anchor.rekor_entry; }), A],
    ['tsa proof without revocation', mutateProof(tsaRow, (p) => { delete p.anchor.revocation; }), A],
    ['tsa revocation with an extra key', mutateProof(tsaRow, (p) => { p.anchor.revocation.signed = true; }), A],
    ['extra top-level key', mutateProof(rekorRow, (p) => { p.note = 'x'; }), A],
    ['extra anchor key', mutateProof(tsaRow, (p) => { p.anchor.extra = 1; }), A],
    ['extra merkle key', mutateProof(rekorRow, (p) => { p.merkle.root = 'x'; }), M],
  ];
  for (const [name, row, expected] of cases) assert.deepEqual(verifyStoredAnchor(row, keys), expected, name);
  // Verifier-side material missing stays not_checkable, for a well-formed row.
  assert.equal(verifyStoredAnchor(tsaRow, {}).status, 'not_checkable');
  assert.equal(verifyStoredAnchor(rekorRow, {}).status, 'not_checkable');
});

test('wrong keys are invalid; missing keys or material are not checkable, never valid', async () => {
  const { rows, keys } = await anchoredBatch(3);
  const rekorRow = rows.find((r) => r.anchorType === 'rekor')!;
  const tsaRow = rows.find((r) => r.anchorType === 'tsa')!;
  const otherKey = createPublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey);
  const NC = { status: 'not_checkable', code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };
  const A = { status: 'invalid', code: 'ATTESTA_VERIFY_ANCHOR_INVALID' };
  assert.deepEqual(verifyStoredAnchor(rekorRow, { ...keys, rekorLogKey: otherKey }), A);
  const retired = Buffer.from(otherKey.export({ type: 'spki', format: 'der' }));
  assert.deepEqual(verifyStoredAnchor(rekorRow, { ...keys, anchorKeysSpkiDer: [retired] }), A);
  // Rotation: old anchors stay checkable while the retired key is published alongside the new one.
  assert.equal(verifyStoredAnchor(rekorRow, { ...keys, anchorKeysSpkiDer: [retired, ...keys.anchorKeysSpkiDer!] }).status, 'valid');
  assert.deepEqual(verifyStoredAnchor(rekorRow, { ...keys, anchorKeysSpkiDer: [] }), NC);
  assert.deepEqual(verifyStoredAnchor(tsaRow, { ...keys, tsaAnchors: [(await makeCa('Other')).cert] }), A);
  assert.deepEqual(verifyStoredAnchor(rekorRow, {}), NC);
  assert.deepEqual(verifyStoredAnchor(tsaRow, {}), NC);
  assert.deepEqual(verifyStoredAnchor({ ...tsaRow, tsaTokenB64: null }, keys), A);
  assert.deepEqual(verifyStoredAnchor(mutateProof(rekorRow, (p) => { delete p.anchor.rekor_entry; }), keys), A);
});

test('a clean revocation answer is carried into the proof', async () => {
  const { rows, keys } = await anchoredBatch(1, { check: async () => ({ status: 'clean', reason: 'ocsp_good' }) });
  const tsaRow = rows.find((r) => r.anchorType === 'tsa')!;
  assert.deepEqual(verifyStoredAnchor(tsaRow, keys), {
    status: 'valid',
    revocation: { status: 'unknown', reason: 'not_rechecked_offline' },
    recordedRevocation: { status: 'clean', reason: 'ocsp_good' },
  });
});
