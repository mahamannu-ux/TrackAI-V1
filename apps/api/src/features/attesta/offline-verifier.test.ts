/**
 * Offline evidence-pack verifier (Task15j, A15.10): the pure `verifyEvidencePack` over
 * good, tampered and not-checkable packs.
 *
 * Packs are built exactly as the exporter builds them (`buildPack` + `signPack` over a
 * `trustWorld` chain); real anchors come from the in-process fakes (`FakeRekor`,
 * `FakeTsa`) as `anchor-dual.test.ts` does. Every tamper below is the test that would
 * pass if its check were forgotten: the pack is assumed to be written by an attacker.
 *
 * Ported from SushiCorp services/anchoring/offline_verify.py @ 0bd67a5 (catalog EV-2)
 * - Node instead of Python;
 * - the trust documents travel in the pack, but the pin is the user's;
 * - DSSE and in-toto instead of JCS records;
 * - two pack modes.
 */
import assert from 'node:assert/strict';
import { createPublicKey, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalize, sha256Prefixed, GENESIS_PREV_HASH, computeRecordHash } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  EVIDENCE_PACK_PAYLOAD_TYPE,
  buildPack,
  packTrustFrom,
  signPack,
  type PackScope,
} from './evidence-pack-service';
import { FakeRekor, REKOR_TREE_ID_DEC, REKOR_TREE_ID_HEX } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { DualAnchor, anchorProofJson } from './anchor-dual';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { inclusionPath, merkleRoot, proofToJson } from './merkle';
import { __setSchemaDirForTests, verifyEvidencePack, type OfflineReport, type OfflineVerifyOptions } from './offline-verifier';
import {
  A,
  B,
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
import { AI_PROVENANCE_PREDICATE_TYPE, LEDGER_RECORD_KIND, buildCanonicalRecord } from './ledger';
import {
  applyTenantKeyCommand,
  exportRootDraft,
  importRoot,
  planTenantKeyCommand,
  publishKeyset,
  registerKey,
} from './trust-inventory';
import { publishedKeysFor } from './trust-resolver';
import { signTrustDocument } from './trust-documents';
import { KmsSigner } from './signer-kms';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { buildReportStatement, computeReportDocument } from './period-report-rules';

const SCOPE_ALL: PackScope = { repository_id: null, from: at(T0 + 2 * MIN), to: at(T0 + 8 * MIN) };
const SCOPE_R1: PackScope = { ...SCOPE_ALL, repository_id: R1 };
// Records run 12:00..12:11, after key registration (11:50): statement times fall inside
// key validity, so signatures verify without time evidence while keys stay active.
const REC_BASE = T0;
const GEN = at(T0 + 20 * MIN);
const NOW = at(T0 + 25 * MIN);
const ANCHOR_AT_MS = Date.parse(at(T0 + 15 * MIN));

type Download = { pack: Record<string, any>; signature: DsseEnvelope }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Key = ReturnType<typeof newKey>;

const checkOf = (report: OfflineReport, id: string) => report.checks.find((c) => c.id === id);
const pemOfKey = (key: Parameters<typeof createPublicKey>[0]): string =>
  createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
const pemOfSpki = (spki: Buffer): string =>
  createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();

/** A chain shaped exactly like buildFixtureChain, but every statement is a frozen
 * schema-valid contract fixture (tweaked only in `as_of`, moving it forward, which the
 * rules allow): an honest pack passes the verifier's schema and rule checks. Record
 * subjects stay synthetic: the frozen check list never compares them. */
const FIXTURE_STATEMENTS = ['valid-commit-observed.json', 'valid-pr-merged.json', 'valid-deployed.json', 'valid-hashed-model.json'];
function fixtureStatement(name: string): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return JSON.parse(readFileSync(join(__dirname, '../../../../../docs/contracts/attesta/fixtures', name), 'utf8'));
}
function buildValidChain(
  tenantId: string,
  key: Key,
  n = 12,
  base = REC_BASE,
  pick: (seq: number) => string = (seq) => FIXTURE_STATEMENTS[seq % FIXTURE_STATEMENTS.length],
  tweak: (stmt: Record<string, any>, seq: number) => void = (stmt, seq) => { stmt.predicate.as_of = at(base + seq * MIN - 1000); }, // eslint-disable-line @typescript-eslint/no-explicit-any
): { records: ChainRecord[]; anchors: never[]; batches: never[] } {
  const records: ChainRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let seq = 0; seq < n; seq++) {
    const repositoryId = seq % 2 === 0 ? R1 : R2;
    const stmt = fixtureStatement(pick(seq));
    tweak(stmt, seq);
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

/** Sign a built pack object with a raw key (post-rotation packs: the signer is not the stale resolver). */
function signPackWith(pack: Record<string, any>, key: Key): DsseEnvelope { // eslint-disable-line @typescript-eslint/no-explicit-any
  const payload = Buffer.from(canonicalize({ manifest: pack.manifest, pack_digest: sha256Prefixed(canonicalize(pack)) }), 'utf8');
  const sig = cryptoSign('sha256', pae(EVIDENCE_PACK_PAYLOAD_TYPE, payload), { key: key.priv, dsaEncoding: 'der' });
  return { payload: payload.toString('base64'), payloadType: EVIDENCE_PACK_PAYLOAD_TYPE, signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }] };
}

/** Rotate tenant A to a fresh key at `atMs` (retiring the old one): returns the new key. */
async function rotateWorldAt(w: World, atMs: number): Promise<Key> {
  const a2 = newKey();
  w.kms.keys.set('ref-a2', a2);
  const adapters = adaptersWith(w, 'a2', A, a2);
  const ctx2 = { ...w.ctx, adapters, now: () => new Date(atMs) };
  await registerKey(ctx2, { tenantId: A, purpose: 'statement', adapterName: 'kms-aws', credentialRef: 'aws-kms:a2' });
  const plan = await planTenantKeyCommand(ctx2, 'activate', { tenantId: A, keyid: a2.keyid, replace: true });
  await applyTenantKeyCommand(ctx2, 'activate', { tenantId: A, keyid: a2.keyid, replace: true }, plan.expect);
  await publishKeyset(ctx2, A);
  return a2;
}

/** A fixture pack with the oracle's placeholder anchors (nothing cryptographic in them). */
async function packFor(w: World, scope: PackScope = SCOPE_ALL, mode: 'full' | 'repository_only' = 'full') {
  const chain = buildValidChain(A, w.k.a1);
  const built = buildPack({ packId: PACK_1, tenantId: A, scope, mode, segment: segmentOf(chain, scope, GEN), trust: await w.material(A) });
  const signature = await signPack(built, w.resolver, A, 'req-1');
  const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
  return { chain, built, signature, download };
}

/** Re-sign an altered pack as a dishonest exporter holding the real key would. */
function resign(d: Download, key: Key): Download {
  const p = d.pack;
  for (const name of Object.keys(p.manifest.sections)) p.manifest.sections[name] = sha256Prefixed(canonicalize(p[name]));
  const payload = Buffer.from(canonicalize({ manifest: p.manifest, pack_digest: sha256Prefixed(canonicalize(p)) }), 'utf8');
  const sig = cryptoSign('sha256', pae(EVIDENCE_PACK_PAYLOAD_TYPE, payload), { key: key.priv, dsaEncoding: 'der' });
  d.signature = { payload: payload.toString('base64'), payloadType: EVIDENCE_PACK_PAYLOAD_TYPE, signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }] };
  return d;
}

interface RealAnchorWorld {
  download: Download;
  chain: ReturnType<typeof buildValidChain>;
  rekor: FakeRekor;
  tsa: FakeTsa;
}

/** Adapters with every trust-world credential plus one new key (publish needs the keyset signer too). */
function adaptersWith(w: World, id: string, tenantId: string, key: Key) {
  const cred = (cid: string, tid: string, k: Key) => ({
    credentialId: `aws-kms:${cid}`, tenantId: tid, displayName: cid, keyReference: `ref-${cid}`, publicKeySha256: k.keyid,
  });
  return {
    'kms-aws': new KmsSigner({ provider: w.kms, credentials: [
      cred('anchor', ATTESTA_PLATFORM_TENANT_ID, w.k.anchor),
      cred('keyset', ATTESTA_PLATFORM_TENANT_ID, w.k.keyset),
      cred('a1', A, w.k.a1),
      cred('b1', B, w.k.b1),
      cred(id, tenantId, key),
    ] }),
  };
}

/**
 * A pack whose anchors are real: one batch over the in-scope range, anchored through
 * both fakes with the trust world's anchor key (the key the verified root lists), and
 * trust material carrying the same log key, offsets and TSA anchors the auditor gets.
 */
async function realPack(w: World, opts: {
  scope?: PackScope;
  mode?: 'full' | 'repository_only';
  generatedAt?: string;
  anchorAtMs?: number;
  anchoredSeqs?: number[];
  /** Sign with this key instead of the resolver (post-rotation packs). */
  signerKey?: Key;
} = {}): Promise<RealAnchorWorld> {
  const scope = opts.scope ?? SCOPE_ALL;
  const generatedAt = opts.generatedAt ?? GEN;
  const anchorAtMs = opts.anchorAtMs ?? ANCHOR_AT_MS;
  const chain = buildValidChain(A, w.k.a1);
  const seg = segmentOf(chain, scope, generatedAt);
  const inScope = seg.records.filter((r) => r.statementCanonical !== null).map((r) => r.seq);
  const anchored = opts.anchoredSeqs ?? inScope;
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
    sign: async (artifact: Buffer) => cryptoSign('sha256', artifact, { key: w.k.anchor.priv, dsaEncoding: 'der' }),
  };
  const dual = new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: pemOfKey(rekor.logKey), production: false, now: () => new Date(anchorAtMs) }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch, now: () => new Date(anchorAtMs) }),
  );
  const outcome = await dual.anchor(root, batchId);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.rekor.status, 'anchored');
  assert.equal(outcome.tsa.status, 'anchored');
  const rekorResult = (outcome.rekor as { result: Parameters<typeof anchorProofJson>[1] }).result;
  const tsaResult = (outcome.tsa as { result: Parameters<typeof anchorProofJson>[1] }).result;
  const anchors: unknown[] = [];
  for (const seq of anchored) {
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
  const built = buildPack({ packId: PACK_1, tenantId: A, scope, mode: opts.mode ?? 'full', segment: { ...seg, anchors: anchors as never, batches: batches as never }, trust });
  let signature;
  if (opts.signerKey !== undefined) {
    const pack = JSON.parse(built.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    signature = signPackWith(pack, opts.signerKey);
  } else {
    signature = await signPack(built, w.resolver, A, 'req-1');
  }
  const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
  return { download, chain, rekor, tsa };
}

/** The auditor's options for a real pack: the pin plus the log key and TSA anchors. */
function userOpts(w: World, ctx: RealAnchorWorld, extra: Record<string, unknown> = {}) {
  return {
    pinnedRootKeyids: [w.k.root.keyid],
    now: NOW,
    rekorLogKeyPem: createPublicKey(ctx.rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
    tsaAnchorsPem: ctx.tsa.anchorsPem,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A good pack exits 0; repository_only exits 2 (completeness is not checkable)
// ---------------------------------------------------------------------------

describe('offline verifier: good packs', () => {
  test('a good full pack exits 0 with every check passed', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx));
    assert.equal(report.result, 'passed');
    assert.equal(report.exit_code, 0);
    assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [
      ['trust_and_signature', 'passed'],
      ['structure', 'passed'],
      ['chain', 'passed'],
      ['completeness', 'passed'],
      ['statements', 'passed'],
      ['anchors', 'passed'],
      ['reports', 'passed'],
    ]);
    assert.deepEqual(report.counts, { records: 9, statements: 7, anchors_verified: 14 });
    assert.equal(report.tenant_id, A);
    assert.equal(report.pack_id, PACK_1);
  });

  test('repository_only exits 2: completeness is not checkable, never passed', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w, { scope: SCOPE_R1, mode: 'repository_only' });
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx));
    assert.equal(report.result, 'not_checkable');
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'completeness')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'completeness')?.code, 'ATTESTA_VERIFY_NOT_CHECKABLE');
    for (const id of ['trust_and_signature', 'structure', 'chain', 'statements', 'anchors', 'reports']) {
      assert.equal(checkOf(report, id)?.status, 'passed', id);
    }
  });

  test('an all-pending pack inside the window warns but still exits 0', async () => {
    const w = await trustWorld();
    // Drop every anchor row and rebuild honestly: all statements pending, far younger
    // than the window when measured at generated_at with a generous window.
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const trust = await w.material(A);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const pending = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const report = verifyEvidencePack(pending, {
      pinnedRootKeyids: [w.k.root.keyid],
      now: NOW,
      anchorWindowMs: 24 * 3600_000,
    });
    assert.equal(checkOf(report, 'anchors')?.status, 'warning');
    assert.equal(report.result, 'passed');
    assert.equal(report.exit_code, 0);
  });

  test('the report carries codes, seqs and counts only: no contents, no key material', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx));
    const text = JSON.stringify(report);
    assert.doesNotMatch(text, /BEGIN|PRIVATE/);
    assert.doesNotMatch(text, /trackai:repository/);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  });
});

// ---------------------------------------------------------------------------
// Tampered packs exit 1, one test each (no re-signing: the signature already breaks)
// ---------------------------------------------------------------------------

describe('offline verifier: tampered packs exit 1', () => {
  test("a record's bytes", async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.records[3].canonical_record = d.pack.records[3].canonical_record.replace('"seq":4', '"seq":5');
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'failed');
  });

  test('a link', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.records[3].prev_hash = d.pack.records[2].prev_hash;
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'failed');
    assert.equal(checkOf(report, 'chain')?.code, 'ATTESTA_VERIFY_PREV_HASH_MISMATCH');
  });

  test('a dropped record', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.records.splice(3, 1);
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'failed');
  });

  test('a dropped statement', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.statements.splice(2, 1);
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
  });

  test("a statement's bytes", async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.statements[1].statement_canonical += ' ';
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'statements')?.status, 'failed');
  });

  test('a Merkle path', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.anchors[0].inclusion_proof.merkle.path[0] = 'f'.repeat(64);
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
  });

  test('a batch root', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.anchor_batches[0].merkle_root = `sha256:${'0'.repeat(64)}`;
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
  });

  test('counts', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.manifest.counts.records += 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
    assert.equal(checkOf(report, 'structure')?.status, 'failed');
  });

  test('completeness', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.manifest.completeness = 'not_provable';
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'structure')?.status, 'failed');
  });

  test('the scope', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.manifest.scope.to = SCOPE_ALL.from;
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'failed');
  });

  test('a section digest', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.manifest.sections.records = `sha256:${'0'.repeat(64)}`;
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'structure')?.status, 'failed');
  });

  test('the signature bytes', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    const raw = Buffer.from(d.signature.signatures[0].sig, 'base64').map((b, i) => (i === 10 ? b ^ 1 : b));
    d.signature.signatures[0].sig = Buffer.from(raw).toString('base64');
    const report = verifyEvidencePack(d, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'failed');
  });

  test('a schema-invalid statement', async () => {
    const w = await trustWorld();
    // One record carries a statement with a required field deleted: the chain is
    // consistent (hashes, links, signature), only the predicate schema rejects it.
    const chain = buildValidChain(A, w.k.a1, 12, REC_BASE, (seq) => FIXTURE_STATEMENTS[seq % FIXTURE_STATEMENTS.length],
      (stmt, seq) => {
        stmt.predicate.as_of = at(REC_BASE + seq * MIN - 1000);
        if (seq === 4) delete stmt.predicate.builder;
      });
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const trust = packTrustFrom({
      published: await publishedKeysFor(w.store, A),
      anchors: null,
      pinnedRootKeyids: w.config.pinnedRootKeyids,
    });
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const report = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: NOW, anchorWindowMs: 24 * 3600_000 });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'passed');
    assert.equal(checkOf(report, 'statements')?.status, 'failed');
    assert.equal(checkOf(report, 'statements')?.code, 'ATTESTA_VERIFY_SCHEMA_INVALID');
  });

  test('a rule-breaking statement', async () => {
    const w = await trustWorld();
    // A lying fixture is schema-valid but breaks S8: signed and chained honestly,
    // so only the cross-field rules can catch it.
    const chain = buildValidChain(A, w.k.a1, 12, REC_BASE,
      (seq) => (seq === 4 ? 'lying-duplicate-model.json' : FIXTURE_STATEMENTS[seq % FIXTURE_STATEMENTS.length]));
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const trust = packTrustFrom({
      published: await publishedKeysFor(w.store, A),
      anchors: null,
      pinnedRootKeyids: w.config.pinnedRootKeyids,
    });
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const report = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: NOW, anchorWindowMs: 24 * 3600_000 });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'passed');
    assert.equal(checkOf(report, 'statements')?.status, 'failed');
    assert.equal(checkOf(report, 'statements')?.code, 'ATTESTA_VERIFY_RULE_VIOLATION');
  });

  test('a record rewritten without re-signing its statement', async () => {
    const w = await trustWorld();
    // The exporter rewrites the newest pending record's repository_id, recomputes its
    // hash and its successor's link, and re-signs the pack: the chain links verify,
    // but the record no longer says what the signed statement says.
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const trust = await w.material(A);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust });
    const pack = JSON.parse(built.text) as Download['pack'];
    const recs = pack.records as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const target = recs.find((r) => r.seq === 8);
    assert.ok(target !== undefined && typeof target.canonical_record === 'string');
    const canon = JSON.parse(target.canonical_record) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    canon.repository_id = 'ffffffff-0000-4000-8000-00000000000f';
    target.canonical_record = canonicalize(canon);
    target.record_hash = computeRecordHash(target.canonical_record, target.prev_hash);
    const next = recs.find((r) => r.seq === 9);
    assert.ok(next !== undefined);
    next.prev_hash = target.record_hash;
    const nextCanon = JSON.parse(next.canonical_record) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    nextCanon.prev_hash = target.record_hash;
    next.canonical_record = canonicalize(nextCanon);
    next.record_hash = computeRecordHash(next.canonical_record, next.prev_hash);
    const download = { pack, signature: null as unknown as DsseEnvelope };
    resign(download, w.k.a1);
    const report = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: NOW, anchorWindowMs: 24 * 3600_000 });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'chain')?.status, 'passed');
    assert.equal(checkOf(report, 'statements')?.status, 'failed');
    assert.equal(checkOf(report, 'statements')?.code, 'ATTESTA_VERIFY_FIELD_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Re-signed lies: the signature is redone, so only the content checks can catch them
// ---------------------------------------------------------------------------

describe('offline verifier: re-signed lies exit 1', () => {
  /** Dual anchoring is all or nothing: dropping one type's rows for an anchored
   * statement is invalid, never merely not checkable. */
  async function withheldRowExit1(type: 'rekor' | 'tsa') {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.anchors = d.pack.anchors.filter((a: { seq: number; anchor_type: string }) => !(a.seq === 4 && a.anchor_type === type));
    d.pack.manifest.counts.anchor_rows -= 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
    assert.equal(checkOf(report, 'anchors')?.code, 'ATTESTA_VERIFY_ANCHOR_INVALID');
  }

  test('pending shown as anchored', async () => {
    const w = await trustWorld();
    // Anchor only some statements honestly, then lie about one more.
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const trust = await w.material(A);
    const partial = { ...seg, anchors: seg.anchors.filter((a) => a.seq !== 4), batches: seg.batches };
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: partial, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const statusOf = Object.fromEntries(download.pack.statements.map((s: { seq: number; anchor_status: string }) => [s.seq, s.anchor_status]));
    assert.equal(statusOf[4], 'pending');
    const d = structuredClone(download);
    const target = d.pack.statements.find((s: { seq: number }) => s.seq === 4);
    target.anchor_status = 'anchored';
    d.pack.manifest.counts.anchored += 1;
    d.pack.manifest.counts.pending -= 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), { pinnedRootKeyids: [w.k.root.keyid], now: NOW });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
  });

  test('an anchored claim with the TSA rows withheld exits 1', async () => {
    await withheldRowExit1('tsa');
  });

  test('an anchored claim with the Rekor rows withheld exits 1', async () => {
    await withheldRowExit1('rekor');
  });

  test('a statement left out', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.statements.splice(3, 1);
    d.pack.manifest.counts.statements -= 1;
    d.pack.manifest.counts.pending -= 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'completeness')?.status, 'failed');
  });

  test('a statement listed twice', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.statements.push(structuredClone(d.pack.statements[0]));
    d.pack.manifest.counts.statements += 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'structure')?.status, 'failed');
  });

  test('a canonical_record withheld in full', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    delete d.pack.records[4].canonical_record;
    d.pack.manifest.counts.redacted_records += 1;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
  });
});

// ---------------------------------------------------------------------------
// Forged trust: whatever the hint says, the user's pin decides
// ---------------------------------------------------------------------------

describe('offline verifier: forged trust exits 1', () => {
  test("a forger's root under the user's pin", async () => {
    const w = await trustWorld();
    const forger = await trustWorld();
    const chain = buildValidChain(A, forger.k.a1);
    const trust = await forger.material(A);
    const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: segmentOf(chain, SCOPE_ALL, GEN), trust });
    const sig = await signPack(built, forger.resolver, A, 'r');
    const forged = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(sig)}}`) as Download;
    // The forger smuggles its own version-1 root alongside the real one: two different
    // documents claim one version, which is tamper evidence (conflict), not absence.
    const realRoots = (await w.material(A)).trust.root_documents;
    forged.pack.trust.root_documents = [...realRoots, ...forged.pack.trust.root_documents];
    const report = verifyEvidencePack(resign(forged, forger.k.a1), { pinnedRootKeyids: [w.k.root.keyid], now: NOW });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'failed');
    assert.equal(checkOf(report, 'trust_and_signature')?.code, 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
  });

  test('reordered key sets still verify (versions, not positions, define the chain)', async () => {
    // The frozen trust layer indexes documents by version (trust-verify.ts sorts by
    // version; the array order carries no security meaning: versions and `previous`
    // digests define the chain). Reordering plus re-signing therefore still verifies.
    // This differs from the oracle, which walks array order; the frozen layer wins.
    const w = await trustWorld();
    await publishKeyset(w.ctx, A);
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.trust.keyset_documents.reverse();
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 0);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
  });

  test('truncated key sets', async () => {
    // Without a persisted lastTrusted the key-set history must start at version 1
    // (first-use full history): a withheld v1 is absent trust information (exit 2),
    // not tamper evidence. This differs from the prompt's exit-1 list; frozen wins.
    const w = await trustWorld();
    await publishKeyset(w.ctx, A);
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.trust.keyset_documents.shift();
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'trust_and_signature')?.code, 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
  });

  test("another tenant's key sets", async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const other = await w.material(B);
    const d = structuredClone(ctx.download);
    d.pack.trust.keyset_documents = other.trust.keyset_documents;
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// Not checkable: nothing missing is ever a pass
// ---------------------------------------------------------------------------

describe('offline verifier: not-checkable packs exit 2', () => {
  test('no Rekor key or TSA anchors given', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, { pinnedRootKeyids: [w.k.root.keyid], now: NOW });
    assert.equal(report.exit_code, 2);
    assert.equal(report.result, 'not_checkable');
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
    assert.equal(checkOf(report, 'anchors')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'anchors')?.code, 'ATTESTA_VERIFY_NOT_CHECKABLE');
  });

  test('a key set expired at now', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx, { now: at(T0 + 31 * 24 * 60 * MIN) }));
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'trust_and_signature')?.code, 'ATTESTA_TRUST_DOCUMENT_EXPIRED');
  });

  test('reports non-empty', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const d = structuredClone(ctx.download);
    d.pack.reports = [{ period: '2026-Q3' }];
    const report = verifyEvidencePack(resign(d, w.k.a1), userOpts(w, ctx));
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'reports')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'reports')?.code, 'ATTESTA_VERIFY_NOT_CHECKABLE');
  });

  test('a pin the pack roots do not list', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx, { pinnedRootKeyids: [`sha256:${'e'.repeat(64)}`] }));
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'not_checkable');
  });
});

// ---------------------------------------------------------------------------
// Real anchors: both types must verify; windows and roots bind them
// ---------------------------------------------------------------------------

describe('offline verifier: real anchors', () => {
  test('a Rekor entry outside its key window fails', async () => {
    const w = await trustWorld();
    // Retire the anchor key in a new root issued before the anchor time: the log time
    // falls past the key's window, so the entry is no anchor even though it verifies
    // cryptographically and the TSA token is genuine.
    const retireAt = Date.parse(at(T0 + 5 * MIN));
    const ctxR = { ...w.ctx, now: () => new Date(retireAt) };
    const draft = await exportRootDraft(ctxR, { retire: [w.k.anchor.keyid] });
    const signed = await signTrustDocument(draft.body, [{
      keyid: w.k.root.keyid,
      sign: (b: Buffer) => cryptoSign('sha256', b, { key: w.k.root.priv, dsaEncoding: 'der' }),
    }]);
    await importRoot(ctxR, signed, 2);
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
    assert.equal(checkOf(report, 'anchors')?.code, 'ATTESTA_VERIFY_ANCHOR_INVALID');
  });

  test('a TSA token from another root fails', async () => {    const w = await trustWorld();
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const inScope = seg.records.filter((r) => r.statementCanonical !== null).map((r) => r.seq);
    const min = Math.min(...inScope);
    const max = Math.max(...inScope);
    const range = chain.records.filter((r) => r.seq >= min && r.seq <= max);
    const leaves = range.map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
    const root = merkleRoot(leaves);
    const batchId = `${A}:${min}-${max}`;
    const anchorAtMs = Date.parse(at(T0 - 10 * MIN));

    const rekor = new FakeRekor();
    rekor.clock = Math.floor(anchorAtMs / 1000) - 1;
    const signer = {
      publicKeySpkiDer: async () => Buffer.from(w.k.anchor.spki),
      sign: async (artifact: Buffer) => cryptoSign('sha256', artifact, { key: w.k.anchor.priv, dsaEncoding: 'der' }),
    };
    const realNow = Date.now;
    Date.now = () => anchorAtMs;
    let tsaForeign: FakeTsa;
    try {
      tsaForeign = await FakeTsa.create({ genTime: new Date(anchorAtMs) });
    } finally {
      Date.now = realNow;
    }
    const dual = new DualAnchor(
      new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: pemOfKey(rekor.logKey), production: false, now: () => new Date(anchorAtMs) }),
      // Signed by a TSA the auditor does not trust: the anchor step trusts the
      // foreign TSA, the pack and the auditor trust the home one.
      new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsaForeign.anchorsPem, fetch: tsaForeign.fetch, now: () => new Date(anchorAtMs) }),
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
    // The auditor trusts the home TSA, not the foreign one that signed these tokens.
    const tsa = await FakeTsa.create();
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
      segment: { ...seg, anchors: anchors as never, batches: [{ batchId, seqFrom: min, seqTo: max, leafCount: range.length, merkleRoot: `sha256:${root.toString('hex')}` }] as never }, trust });
    const signature = await signPack(built, w.resolver, A, 'req-1');
    const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
    const report = verifyEvidencePack(download, {
      pinnedRootKeyids: [w.k.root.keyid],
      now: NOW,
      rekorLogKeyPem: createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
      tsaAnchorsPem: tsa.anchorsPem,
    });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
  });

  test('a wrong user offset fails the anchors', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, userOpts(w, ctx, { rekorLogIndexOffsets: { [REKOR_TREE_ID_DEC]: 5 } }));
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'anchors')?.status, 'failed');
  });

  test("the pack's offsets never feed verification but warn on mismatch", async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    // A mismatched pack value is ignored without user offsets: still a pass.
    const tampered = structuredClone(ctx.download);
    tampered.pack.trust.rekor_log_index_offsets = { '1193050959916656506': 0 };
    const ignored = verifyEvidencePack(resign(tampered, w.k.a1), userOpts(w, ctx));
    assert.equal(ignored.exit_code, 0);
    assert.equal(checkOf(ignored, 'anchors')?.status, 'passed');
    // Matching user offsets verify cleanly.
    const matched = verifyEvidencePack(ctx.download, userOpts(w, ctx, { rekorLogIndexOffsets: { [REKOR_TREE_ID_DEC]: 0 } }));
    assert.equal(matched.exit_code, 0);
    assert.equal(checkOf(matched, 'anchors')?.status, 'passed');
    // The same mismatch against user offsets warns without failing.
    const warned = verifyEvidencePack(resign(structuredClone(tampered), w.k.a1),
      userOpts(w, ctx, { rekorLogIndexOffsets: { [REKOR_TREE_ID_DEC]: 0 } }));
    assert.equal(warned.exit_code, 0);
    assert.equal(checkOf(warned, 'anchors')?.status, 'warning');
  });
});

// ---------------------------------------------------------------------------
// Key time evidence: retired keys verify only with a bound anchor time
// ---------------------------------------------------------------------------

describe('offline verifier: key time evidence', () => {
  const R = Date.parse(at(T0 + 40 * MIN));
  const GEN2 = at(T0 + 50 * MIN);
  const NOW2 = at(T0 + 60 * MIN);

  async function rotatedWorld() {
    const w = await trustWorld();
    const a2 = await rotateWorldAt(w, R);
    return { w, a2 };
  }

  async function rotatedPack(stripSeqs: number[] = []) {
    const { w, a2 } = await rotatedWorld();
    const anchorAtMs = ANCHOR_AT_MS;
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN2);
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
      sign: async (artifact: Buffer) => cryptoSign('sha256', artifact, { key: w.k.anchor.priv, dsaEncoding: 'der' }),
    };
    const dual = new DualAnchor(
      new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: pemOfKey(rekor.logKey), production: false, now: () => new Date(anchorAtMs) }),
      new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch, now: () => new Date(anchorAtMs) }),
    );
    const outcome = await dual.anchor(root, batchId);
    assert.equal(outcome.complete, true);
    const rekorResult = (outcome.rekor as { result: Parameters<typeof anchorProofJson>[1] }).result;
    const tsaResult = (outcome.tsa as { result: Parameters<typeof anchorProofJson>[1] }).result;
    const anchors: unknown[] = [];
    for (const seq of inScope) {
      if (stripSeqs.includes(seq)) continue;
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
    // Signed after the rotation with the active key.
    const pack = JSON.parse(built.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const download = { pack, signature: signPackWith(pack, a2) };
    const opts = {
      pinnedRootKeyids: [w.k.root.keyid],
      now: NOW2,
      rekorLogKeyPem: createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
      tsaAnchorsPem: tsa.anchorsPem,
    };
    return { w, a2, download, opts, rekor, tsa };
  }

  test('a retired key with an anchor before revoked_at passes', async () => {
    const { download, opts } = await rotatedPack();
    const report = verifyEvidencePack(download, opts);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
    assert.equal(checkOf(report, 'statements')?.status, 'passed');
    assert.equal(checkOf(report, 'anchors')?.status, 'passed');
    assert.equal(report.exit_code, 0);
  });

  test('without the anchor the retired key fails ATTESTA_TRUST_KEY_NOT_VALID_AT', async () => {
    const { download, opts } = await rotatedPack([4]);
    const report = verifyEvidencePack(download, opts);
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'statements')?.status, 'failed');
    assert.equal(checkOf(report, 'statements')?.code, 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  });
});

// ---------------------------------------------------------------------------
// State file: written after a pass, read back; rollbacks rejected
// ---------------------------------------------------------------------------

describe('offline verifier: persisted trust', () => {
  test('lastTrusted written after a pass verifies the same pack again', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const first = verifyEvidencePack(ctx.download, userOpts(w, ctx));
    assert.equal(first.exit_code, 0);
    assert.ok(first.trusted?.platform !== undefined);
    assert.ok(first.trusted?.[A] !== undefined);
    assert.ok(typeof first.trustedTime === 'string');
    const second = verifyEvidencePack(ctx.download, userOpts(w, ctx, {
      lastTrusted: first.trusted,
      trustedTimeFloor: first.trustedTime,
    }));
    assert.equal(second.exit_code, 0);
  });

  test('a rollback to an older key set after the state was written is rejected', async () => {
    const w = await trustWorld();
    // A pre-rotation pack (v1-only trust, signed by a1 while active): passes on first use.
    const chain = buildValidChain(A, w.k.a1);
    const seg = segmentOf(chain, SCOPE_ALL, GEN);
    const publishedV1 = await publishedKeysFor(w.store, A);
    assert.equal(publishedV1.keysetDocuments.length, 1);
    const trustV1 = packTrustFrom({ published: publishedV1, anchors: null, pinnedRootKeyids: w.config.pinnedRootKeyids });
    const builtV1 = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full',
      segment: { ...seg, anchors: [], batches: [] }, trust: trustV1 });
    const packV1 = JSON.parse(builtV1.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const downloadV1 = { pack: packV1, signature: signPackWith(packV1, w.k.a1) };
    const pins = { pinnedRootKeyids: [w.k.root.keyid], now: NOW };
    assert.equal(verifyEvidencePack(downloadV1, pins).exit_code, 0);
    // Rotate, then capture state from a fresh post-rotation pack (real anchors, a2 signature).
    const R2 = Date.parse(at(T0 + 40 * MIN));
    const GEN2B = at(T0 + 50 * MIN);
    const NOW2B = at(T0 + 60 * MIN);
    const a2 = await rotateWorldAt(w, R2);
    // Signed with the post-rotation active key.
    const full = await realPack(w, { generatedAt: GEN2B, signerKey: a2 });
    const stateOpts = userOpts(w, full, { now: NOW2B });
    const state = verifyEvidencePack(full.download, stateOpts);
    assert.equal(state.exit_code, 0);
    // Replaying the old pack against the persisted state is a rollback, not first use.
    const withoutState = verifyEvidencePack(downloadV1, pins);
    assert.equal(withoutState.exit_code, 0, 'first use cannot see the withholding (documented limit)');
    const withState = verifyEvidencePack(downloadV1, { ...pins, lastTrusted: state.trusted });
    assert.equal(withState.exit_code, 1);
    assert.equal(checkOf(withState, 'trust_and_signature')?.status, 'failed');
    assert.equal(checkOf(withState, 'trust_and_signature')?.code, 'ATTESTA_TRUST_ROLLBACK');
  });
});

// ---------------------------------------------------------------------------
// Customer pins: the pin decides trust; the root pin still feeds anchor windows
// ---------------------------------------------------------------------------

describe('offline verifier: customer pins', () => {
  function pinsOf(download: Download) {
    const keyset = JSON.parse(Buffer.from(download.pack.trust.keyset_documents[0].payload, 'base64').toString('utf8'));
    return keyset.keys.filter((k: { purpose: string }) => k.purpose === 'statement');
  }

  test('customer pin plus root pin checks Rekor anchors', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, { ...userOpts(w, ctx), customerPins: pinsOf(ctx.download) });
    assert.equal(report.exit_code, 0);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
    assert.equal(checkOf(report, 'anchors')?.status, 'passed');
  });

  test('customer pins alone leave Rekor anchors not checkable', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, { pinnedRootKeyids: [], customerPins: pinsOf(ctx.download), now: NOW,
      rekorLogKeyPem: createPublicKey(ctx.rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
      tsaAnchorsPem: ctx.tsa.anchorsPem });
    assert.equal(report.exit_code, 2);
    assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
    assert.equal(checkOf(report, 'anchors')?.status, 'not_checkable');
  });
});

// ---------------------------------------------------------------------------
// Environment failures: the verifier broken is never the pack broken
// ---------------------------------------------------------------------------

describe('offline verifier: environment failures', () => {
  test('an unexpected failure reads not_checkable, never failed', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const report = verifyEvidencePack(ctx.download, undefined as unknown as OfflineVerifyOptions);
    assert.equal(report.exit_code, 2);
    assert.equal(report.result, 'not_checkable');
    assert.equal(report.verifier_error, 'unexpected verifier failure');
    assert.ok(report.checks.every((c) => c.status === 'not_checkable' && c.code === 'ATTESTA_VERIFY_NOT_CHECKABLE'));
  });

  test('missing schema files read not_checkable with a verifier error', async () => {
    const w = await trustWorld();
    const ctx = await realPack(w);
    const dir = mkdtempSync(join(tmpdir(), 'attesta-no-schemas-'));
    __setSchemaDirForTests(dir);
    try {
      const report = verifyEvidencePack(ctx.download, userOpts(w, ctx));
      assert.equal(report.exit_code, 2);
      assert.equal(report.verifier_error, 'contract schemas unavailable');
      assert.equal(checkOf(report, 'structure')?.status, 'not_checkable');
      assert.equal(checkOf(report, 'statements')?.status, 'not_checkable');
      // The pack itself still verifies: trust, chain and completeness pass.
      assert.equal(checkOf(report, 'trust_and_signature')?.status, 'passed');
      assert.equal(checkOf(report, 'chain')?.status, 'passed');
      assert.equal(checkOf(report, 'completeness')?.status, 'passed');
    } finally {
      __setSchemaDirForTests(undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Garbage in, report out (never a throw)
// ---------------------------------------------------------------------------

describe('offline verifier: hostile input', () => {
  test('garbage downloads report failed or not_checkable, never throw', async () => {
    const w = await trustWorld();
    const pins = { pinnedRootKeyids: [w.k.root.keyid], now: NOW };
    for (const garbage of [null, undefined, 42, 'pack', [], {}, { pack: null }, { pack: {}, signature: {} }]) {
      const report = verifyEvidencePack(garbage, pins);
      assert.equal(report.checks.length, 7);
      assert.ok(report.exit_code === 1 || report.exit_code === 2);
      assert.ok(report.result === 'failed' || report.result === 'not_checkable');
    }
  });
});

// ---------------------------------------------------------------------------
// Standalone shippability: the verifier's import graph reaches no server code
// ---------------------------------------------------------------------------

describe('offline verifier: import-graph purity', () => {
  test('offline-verifier.ts imports only the allowed modules, transitively', async () => {
    const dir = __dirname;
    const direct = new Set(['node:crypto', 'node:fs', 'node:path', 'ajv', 'pkijs',
      './canonical', './merkle', './dsse', './trust-contract', './trust-documents',
      './anchor-dual', './anchor-rekor', './anchor-tsa', './contract-rules']);
    const readSource = (name: string): string => readFileSync(join(dir, `${name}.ts`), 'utf8');
    const specifiersOf = (source: string): string[] => [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    // Direct imports: exactly the allowed set (plus types, which share the same module).
    const own = specifiersOf(readSource('offline-verifier'));
    for (const spec of own) {
      assert.ok(direct.has(spec), `offline-verifier.ts imports a non-allowed module ${spec}`);
    }
    // Transitive walk over relative imports.
    const seen = new Set<string>(['offline-verifier']);
    const queue = ['offline-verifier'];
    // `./testing/fetch-like` is an in-process type with no network behind it.
    const bannedImport = (spec: string): boolean => spec !== './testing/fetch-like'
      && (spec.includes('core/') || spec === 'drizzle-orm' || spec === 'pg' || spec === 'express'
      || spec === 'dotenv' || spec.includes('fetch'));
    // The two adapter classes keep an injectable network fallback the verifier never
    // constructs (it only calls the pure proof checks); every other network call is banned.
    const fallback = '?? ((input, init) => fetch(input, init))';
    while (queue.length > 0) {
      const name = queue.pop() as string;
      const source = readSource(name);
      for (const spec of specifiersOf(source)) {
        assert.ok(!bannedImport(spec), `${name}.ts reaches a banned import ${spec}`);
        if (spec.startsWith('./') && !spec.includes('/testing/')) {
          const next = spec.slice(2);
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      for (const line of source.split('\n')) {
        if (line.includes('fetch(') && !line.includes(fallback)) {
          assert.fail(`${name}.ts reaches a network call: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    // The walk must have covered the whole pure core (a walk that visits nothing proves nothing).
    for (const name of ['canonical', 'trust-contract', 'trust-verify', 'trust-documents', 'anchor-dual', 'anchor-contract', 'anchor-rekor', 'anchor-tsa', 'contract-rules', 'dsse', 'merkle']) {
      assert.ok(seen.has(name), `purity walk never visited ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task15i4: a period_report statement in a pack (reports: [] until the follow-up)
// ---------------------------------------------------------------------------

/** Put an honest, signed period_report at `seq` (repository R1) and re-link the chain after it. */
function withReportAt(chain: ReturnType<typeof buildValidChain>, tenantId: string, key: Key, seq: number, recordPatch: Record<string, unknown> = {}) {
  const scope = { repository_id: R1, from: at(REC_BASE - 60 * MIN), to: at(REC_BASE - 10 * MIN), basis: 'recorded_at' as const };
  const document = computeReportDocument({ tenantId, scope, inputs: [] });
  const statementCanonical = buildReportStatement({ document, chainRange: { from_seq: 0, to_seq: 3, to_record_hash: chain.records[3].recordHash },
    asOf: at(REC_BASE + seq * MIN - 1000), builderVersion: '0.1.0+3c862ef', previous: [] }).statementCanonical;
  const payload = Buffer.from(statementCanonical, 'utf8');
  const sig = cryptoSign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: key.priv, dsaEncoding: 'der' });
  const envelope: DsseEnvelope = { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }] };
  const records = chain.records.map((r) => ({ ...r }));
  records[seq] = { ...records[seq], repositoryId: R1, statementDigest: sha256Prefixed(statementCanonical), statementCanonical, envelope,
    statementCanonicalAll: statementCanonical, envelopeAll: envelope };
  let prev = seq === 0 ? GENESIS_PREV_HASH : records[seq - 1].recordHash;
  for (let i = seq; i < records.length; i++) {
    const f = JSON.parse(records[i].canonicalRecord);
    const fields = i === seq
      ? { ...f, prev_hash: prev, statement_digest: records[i].statementDigest, predicate_type: 'https://trackai.dev/attesta/period-report/v1',
          statement_kind: null, subject_sha: null, repository_id: R1, ...recordPatch }
      : { ...f, prev_hash: prev };
    records[i].prevHash = prev;
    records[i].canonicalRecord = buildCanonicalRecord(fields);
    records[i].recordHash = computeRecordHash(records[i].canonicalRecord, prev);
    prev = records[i].recordHash;
  }
  return { ...chain, records };
}

async function reportPack(w: World, recordPatch: Record<string, unknown> = {}) {
  const chain = withReportAt(buildValidChain(A, w.k.a1), A, w.k.a1, 4, recordPatch);
  const seg = segmentOf(chain, SCOPE_ALL, GEN);
  const trust = packTrustFrom({ published: await publishedKeysFor(w.store, A), anchors: null, pinnedRootKeyids: w.config.pinnedRootKeyids });
  const built = buildPack({ packId: PACK_1, tenantId: A, scope: SCOPE_ALL, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust });
  const signature = await signPack(built, w.resolver, A, 'req-1');
  const download = JSON.parse(`{"pack":${built.text},"signature":${JSON.stringify(signature)}}`) as Download;
  return verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: NOW, anchorWindowMs: 24 * 3600_000 });
}

describe('offline verifier: period_report statements (Task15i4)', () => {
  test('an honest report statement passes the statements check; its figures are not checkable (exit 2)', async () => {
    const w = await trustWorld();
    const report = await reportPack(w);
    assert.equal(checkOf(report, 'statements')?.status, 'passed', JSON.stringify(checkOf(report, 'statements')));
    assert.equal(checkOf(report, 'chain')?.status, 'passed');
    assert.equal(checkOf(report, 'reports')?.status, 'not_checkable');
    assert.equal(checkOf(report, 'reports')?.code, 'ATTESTA_VERIFY_NOT_CHECKABLE');
    assert.equal(report.exit_code, 2);
  });

  test('a report record whose typed copies disagree with its statement is a break', async () => {
    const w = await trustWorld();
    const report = await reportPack(w, { statement_kind: 'commit_observed' });
    assert.equal(report.exit_code, 1);
    assert.equal(checkOf(report, 'statements')?.code, 'ATTESTA_VERIFY_FIELD_MISMATCH');
  });
});
