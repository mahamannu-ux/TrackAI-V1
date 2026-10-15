/**
 * Offline audit-export verifier (Task16f2, A16.7 finishing work): the pure
 * `verifyAuditExport` against exports built in memory with test keys, no
 * database (docs/contracts/audit/export.md "What a verifier checks").
 *
 * Fixture pattern: Task16e's audit-seal.test.ts (seal documents, statements,
 * records, buildAuditExport, signExport with devSignerResolver) plus the trust
 * world's signed root/keyset documents from trust-verify.test.ts and the dual
 * anchor rows from anchor-dual.test.ts (FakeRekor + FakeTsa, so anchored seal
 * records verify offline with the user's files).
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import test from 'node:test';
import {
  AUDIT_EXPORT_PAYLOAD_TYPE,
  buildAuditExport,
  signExport,
  type ExportSnapshot,
} from './export-service';
import { main as verifyExportMain, type VerifyExportIo } from './audit-verify-export-cli';
import { verifyAuditExport } from './offline-export-verifier';
import {
  auditRowDigest,
  buildSealDocument,
  buildSealStatement,
  type StoredAuditRow,
} from '../attesta/audit-seal-service';
import { canonicalize, computeRecordHash, sha256Prefixed, GENESIS_PREV_HASH } from '../attesta/canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from '../attesta/dsse';
import { AUDIT_SEAL_PREDICATE_TYPE, buildCanonicalRecord } from '../attesta/ledger';
import { devSignerResolver } from '../attesta/signer-resolver';
import { KEYSET_TYPE, TRUST_ROOT_TYPE, type KeyPurpose, type TrustDocumentBody, type TrustKeyEntry } from '../attesta/trust-contract';
import { signTrustDocument, type DocumentSigner } from '../attesta/trust-documents';
import { packAnchorEntries, packBatchEntries } from '../attesta/evidence-pack-service';
import { FakeRekor, REKOR_TREE_ID_DEC } from '../attesta/testing/fake-rekor';
import { FakeTsa, TSA_URL } from '../attesta/testing/fake-tsa';
import { inclusionPath, merkleRoot, proofToJson } from '../attesta/merkle';
import { anchorSignerFromAdapter } from '../attesta/anchor-contract';
import { DualAnchor, anchorProofJson } from '../attesta/anchor-dual';
import { RekorAnchor } from '../attesta/anchor-rekor';
import { TsaAnchor } from '../attesta/anchor-tsa';
import { LocalDevSigner, generateDevCredential } from '../attesta/signer-local-dev';
import { ATTESTA_PLATFORM_TENANT_ID } from '../attesta/anchor-contract';

const TENANT = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `0b7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-10-15T12:00:00.000Z';
const GENERATED_AT = '2026-10-15T11:00:00.000Z';
const SCOPE = { from: '2026-10-15T06:15:00.000Z', to: '2026-10-15T10:00:00.000Z' };
const W1 = { from: '2026-10-15T06:00:00.000000Z', to: '2026-10-15T07:00:00.000000Z' };
const W2 = { from: '2026-10-15T07:00:00.000000Z', to: '2026-10-15T08:00:00.000000Z' };

const row = (n: number, at: string): StoredAuditRow => ({
  id: id(n), action: 'audit.events.read', actor_type: 'tenant_auditor', actor_id: 'sub-1',
  target_type: 'security_audit_events', target_id: TENANT, details: { request_id: `r${n}` }, occurred_at: at,
});

// ---------------------------------------------------------------------------
// Trust world (mirrors trust-verify.test.ts): root R, keyset signer K,
// statement key S, plus the online anchor/lease/fleet/policy/release keys.
// ---------------------------------------------------------------------------

interface Key { privateKey: KeyObject; spki: Buffer; keyid: string; b64: string }
function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { privateKey, spki, keyid: sha256Prefixed(spki), b64: spki.toString('base64') };
}
const signer = (k: Key): DocumentSigner => ({ keyid: k.keyid, sign: (b) => cryptoSign('sha256', b, { key: k.privateKey, dsaEncoding: 'der' }) });

const NB = '2026-10-01T00:00:00.000Z';
const NA = '2027-10-01T00:00:00.000Z';
function entry(k: Key, purpose: KeyPurpose): TrustKeyEntry {
  return { keyid: k.keyid, purpose, spki_der_b64: k.b64, not_before: NB, not_after: NA, status: 'active' };
}

const R = newKey();
const K = newKey();
const S = newKey();
const L = newKey();
const F = newKey();
const P = newKey();
const Rl = newKey();

const rootBodyFor = (signerSpki: Buffer): TrustDocumentBody => {
  const signerKeyid = sha256Prefixed(signerSpki);
  return {
    _type: TRUST_ROOT_TYPE, scope: 'platform', version: 1, issued_at: NB, expires: NA, previous: null, threshold: 1,
    keys: [entry(R, 'root'), entry(K, 'tenant_keyset'),
      { keyid: signerKeyid, purpose: 'anchor', spki_der_b64: signerSpki.toString('base64'), not_before: NB, not_after: NA, status: 'active' },
      entry(L, 'activation_lease'), entry(F, 'fleet_config'), entry(P, 'policy_bundle'), entry(Rl, 'release')],
  };
};
const keysetBody: TrustDocumentBody = {
  _type: KEYSET_TYPE, scope: TENANT, version: 1, issued_at: '2026-10-10T00:00:00.000Z',
  expires: '2026-11-09T00:00:00.000Z', previous: null, keys: [entry(S, 'statement')],
};

interface TrustDocs { R1: DsseEnvelope; KSA: DsseEnvelope }
async function trustDocs(signerSpki: Buffer): Promise<TrustDocs> {
  return {
    R1: await signTrustDocument(rootBodyFor(signerSpki), [signer(R)]),
    KSA: await signTrustDocument(keysetBody, [signer(K)]),
  };
}

function sealEnvelope(canonical: string): DsseEnvelope {
  const bytes = Buffer.from(canonical, 'utf8');
  const sig = cryptoSign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, bytes), { key: S.privateKey, dsaEncoding: 'der' });
  return { payload: bytes.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid: S.keyid, sig: sig.toString('base64') }] };
}

// ---------------------------------------------------------------------------
// Anchors (mirrors anchor-dual.test.ts): one batch over the seal records.
// ---------------------------------------------------------------------------

interface AnchorSetup {
  rekorLogKeyPem: string;
  rekorSpkiB64: string;
  tsaAnchorsPem: string;
  signerSpki: Buffer;
  mintBatch: (seqs: number[], recordHashes: string[]) => Promise<{ anchors: ExportSnapshot['anchors']; batches: ExportSnapshot['batches'] }>;
}

async function anchorSetup(): Promise<AnchorSetup> {
  const rekor = new FakeRekor();
  // The fake log stamps integratedTime from its clock and refuses entries outside
  // the request window, so minting uses the real clock; the seal records stay at
  // fixed earlier times (anchor time only needs to follow recorded_at).
  rekor.clock = Math.floor(Date.now() / 1000);
  const tsa = await FakeTsa.create();
  const pem = (k: KeyObject): string => (k.type === 'public' ? k : createPublicKey(k)).export({ type: 'spki', format: 'pem' }).toString();
  const cred = generateDevCredential('dev:anchor', ATTESTA_PLATFORM_TENANT_ID);
  const s = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
  const dual = new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer: s, fetch: rekor.fetch, logPublicKeyPem: pem(rekor.logKey), production: false }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch }),
  );
  return {
    rekorLogKeyPem: pem(rekor.logKey),
    rekorSpkiB64: createPublicKey(rekor.logKey).export({ type: 'spki', format: 'der' }).toString('base64'),
    tsaAnchorsPem: tsa.anchorsPem,
    signerSpki: await s.publicKeySpkiDer(),
    mintBatch: async (seqs, recordHashes) => {
      const leaves = recordHashes.map((h) => Buffer.from(h.slice('sha256:'.length), 'hex'));
      const root = merkleRoot(leaves);
      const label = `${TENANT}:${seqs[0]}-${seqs[seqs.length - 1]}`;
      const out = await dual.anchor(root, label);
      assert.ok(out.complete && out.rekor.status === 'anchored' && out.tsa.status === 'anchored');
      const segAnchors = recordHashes.flatMap((recordHash, i) => [out.rekor, out.tsa].map((a) => {
        const result = (a as { result: Parameters<typeof anchorProofJson>[1] }).result;
        return {
          seq: seqs[i],
          anchorType: result.type,
          batchId: label,
          inclusionProof: JSON.parse(JSON.stringify(anchorProofJson(proofToJson(i, seqs.length, inclusionPath(leaves, i)), result))),
          rekorEntryUuid: result.type === 'rekor' ? result.entryId : null,
          tsaTokenB64: result.type === 'tsa' ? result.tokenDer.toString('base64') : null,
        };
      }));
      const batches = [{
        batchId: label, seqFrom: seqs[0], seqTo: seqs[seqs.length - 1], leafCount: seqs.length,
        merkleRoot: `sha256:${root.toString('hex')}`,
      }];
      return { anchors: segAnchors, batches };
    },
  };
}

// ---------------------------------------------------------------------------
// Export builder: seals, records, statements, snapshot, signature.
// ---------------------------------------------------------------------------

interface BuiltSeal {
  window: { from: string; to: string };
  digest: string;
  text: string;
  seq: number;
  prevHash: string;
  recordHash: string;
  canonicalRecord: string;
  statementDigest: string;
  statementCanonical: string;
  envelope: DsseEnvelope;
}

function buildSeal(window: { from: string; to: string }, previous: string | null, rows: StoredAuditRow[], seq: number, recordedAt: string): BuiltSeal {
  const built = buildSealDocument({ tenantId: TENANT, window, previous, rows });
  const statementCanonical = buildSealStatement({ document: built.document, documentDigest: built.digest, asOf: recordedAt, builderVersion: '0.1.0+abcdef0' });
  const statementDigest = sha256Prefixed(statementCanonical);
  const canonicalRecord = buildCanonicalRecord({
    seq, prev_hash: GENESIS_PREV_HASH, recorded_at: recordedAt, tenant_id: TENANT,
    record_kind: 'statement', statement_digest: statementDigest, predicate_type: AUDIT_SEAL_PREDICATE_TYPE,
    statement_kind: null, repository_id: null, subject_sha: null, outbox_subject_id: null,
  });
  return {
    window, digest: built.digest, text: built.text, seq, prevHash: GENESIS_PREV_HASH,
    recordHash: computeRecordHash(canonicalRecord, GENESIS_PREV_HASH), canonicalRecord,
    statementDigest, statementCanonical, envelope: sealEnvelope(statementCanonical),
  };
}

interface Fixture {
  download: { export: unknown; signature: DsseEnvelope };
  exportObj: Record<string, unknown>;
}

async function buildFixture(ctx: AnchorSetup, opts: { twoSeals?: boolean; pending?: boolean; unsealed?: boolean; previousOverride?: string } = {}): Promise<Fixture> {
  const { R1, KSA } = await trustDocs(ctx.signerSpki);
  const e1 = row(1, '2026-10-15T06:00:00.000000Z');
  const e2 = row(2, '2026-10-15T06:30:00.000000Z');
  const seal1 = buildSeal(W1, null, [e1, e2], 41, '2026-10-15T07:10:00.000Z');
  const seals = [seal1];
  const events = [e1, e2];
  if (opts.twoSeals) {
    const e3 = row(3, '2026-10-15T07:30:00.000000Z');
    events.push(e3);
    seals.push(buildSeal(W2, opts.previousOverride ?? seal1.digest, [e3], 42, '2026-10-15T08:10:00.000Z'));
  }
  if (opts.unsealed) {
    events.push(row(9, '2026-10-15T09:30:00.000000Z'));
  }
  const seqs = seals.map((s) => s.seq);
  const minted = opts.pending ? { anchors: [], batches: [] } : await ctx.mintBatch(seqs, seals.map((s) => s.recordHash));
  const snapshot: ExportSnapshot = {
    generatedAt: GENERATED_AT,
    events,
    seals: seals.map((s) => ({
      seq: s.seq, windowFrom: s.window.from, windowTo: s.window.to, sealDigest: s.digest, sealDocument: s.text,
      prevHash: s.prevHash, recordHash: s.recordHash, canonicalRecord: s.canonicalRecord,
      statementDigest: s.statementDigest, statementCanonical: s.statementCanonical, envelope: s.envelope,
    })),
    anchors: minted.anchors,
    batches: minted.batches,
  };
  const trust = {
    trust: {
      root_documents: [R1], keyset_documents: [KSA],
      anchoring_keys: [{ keyid: sha256Prefixed(ctx.signerSpki), spki_der_b64: ctx.signerSpki.toString('base64'), root_entry: null }],
      rekor_log_key_spki_b64: ctx.rekorSpkiB64, rekor_log_index_offsets: null, tsa_anchors_der_b64: [],
    },
    pinnedRootKeyids: [] as string[],
  };
  const built = buildAuditExport({ exportId: id(500), tenantId: TENANT, scope: SCOPE, snapshot, trust });
  const pem = S.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const envelope = await signExport(built, devSignerResolver({ sharedKeyPem: pem, env: {} }), TENANT, 'req-test');
  const exportObj = JSON.parse(built.text) as Record<string, unknown>;
  return { download: { export: exportObj, signature: envelope }, exportObj };
}

/** Recompute section digests, counts and the signature after a tamper (isolates the tampered layer). */
function resign(exportObj: Record<string, unknown>): { export: unknown; signature: DsseEnvelope } {
  const obj = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  const events = obj.events as StoredAuditRow[];
  const seals = obj.seals as Array<{ document: string }>;
  const statements = (obj.seal_evidence as Record<string, unknown>).statements as Array<{ anchor_status: string }>;
  const windows = seals.map((s) => (JSON.parse(s.document) as { window: { from: string; to: string } }).window);
  const sealed = events.filter((e) => windows.some((w) => e.occurred_at >= w.from && e.occurred_at < w.to)).length;
  const anchored = statements.filter((s) => s.anchor_status === 'anchored').length;
  (obj.manifest as Record<string, unknown>).sections = {
    events: sha256Prefixed(canonicalize(obj.events)),
    seals: sha256Prefixed(canonicalize(obj.seals)),
    seal_evidence: sha256Prefixed(canonicalize(obj.seal_evidence)),
  };
  (obj.manifest as Record<string, unknown>).counts = {
    events: events.length, seals: seals.length, sealed_events: sealed, unsealed_events: events.length - sealed,
    anchored, pending: statements.length - anchored,
  };
  const digest = sha256Prefixed(canonicalize(obj));
  const payload = Buffer.from(canonicalize({ manifest: obj.manifest, export_digest: digest }), 'utf8');
  const sig = cryptoSign('sha256', pae(AUDIT_EXPORT_PAYLOAD_TYPE, payload), { key: S.privateKey, dsaEncoding: 'der' });
  return {
    export: obj,
    signature: {
      payload: payload.toString('base64'), payloadType: AUDIT_EXPORT_PAYLOAD_TYPE,
      signatures: [{ keyid: S.keyid, sig: sig.toString('base64') }],
    },
  };
}

function checkOptions(ctx: AnchorSetup) {
  return {
    pinnedRootKeyids: [R.keyid], rekorLogKeyPem: ctx.rekorLogKeyPem, tsaAnchorsPem: ctx.tsaAnchorsPem, now: NOW,
  };
}

test('T16f2 offline export: a signed, anchored export passes with nothing unsealed', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx);
  const report = verifyAuditExport(download, checkOptions(ctx));
  assert.equal(report.exit_code, 0);
  assert.ok(report.checks.every((c) => c.status === 'passed'), JSON.stringify(report.checks));
  assert.deepEqual(report.breaks, []);
  assert.deepEqual(report.unsealed, { count: 0 });
});

test('T16f2 offline export: events after the last seal are reported, never a pass and never a break', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx, { unsealed: true });
  const report = verifyAuditExport(download, checkOptions(ctx));
  assert.equal(report.exit_code, 0);
  assert.deepEqual(report.breaks, []);
  assert.deepEqual(report.unsealed, { count: 1 });
});

test('T16f2 offline export: a wrong payload type fails the signature', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx);
  const tampered = {
    export: download.export,
    signature: { ...download.signature, payloadType: 'application/vnd.trackai.evidence-pack+json' },
  };
  const report = verifyAuditExport(tampered, checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.equal(report.checks.find((c) => c.id === 'signature')?.status, 'failed');
  assert.equal(report.checks.find((c) => c.id === 'signature')?.detail_code, 'ATTESTA_VERIFY_SIGNATURE_INVALID');
});

test('T16f2 offline export: a changed manifest fails the signature', async () => {
  const ctx = await anchorSetup();
  const { exportObj, download } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  (tampered.manifest as Record<string, unknown>).counts = {
    ...((tampered.manifest as Record<string, unknown>).counts as Record<string, unknown>), events: 99,
  };
  const report = verifyAuditExport({ export: tampered, signature: download.signature }, checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.equal(report.checks.find((c) => c.id === 'signature')?.status, 'failed');
});

test('T16f2 offline export: a section digest mismatch fails the shape', async () => {
  const ctx = await anchorSetup();
  const { exportObj, download } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  ((tampered.manifest as Record<string, unknown>).sections as Record<string, unknown>).events = `sha256:${'0'.repeat(64)}`;
  const report = verifyAuditExport({ export: tampered, signature: download.signature }, checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.equal(report.checks.find((c) => c.id === 'shape')?.status, 'failed');
  assert.equal(report.checks.find((c) => c.id === 'shape')?.detail_code, 'AUDIT_EXPORT_SHAPE_INVALID');
});

test('T16f2 offline export: a rows_root mismatch fails the seals', async () => {
  const ctx = await anchorSetup();
  const { exportObj } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  const seal = (tampered.seals as Array<{ document: string }>)[0];
  const doc = JSON.parse(seal.document) as Record<string, unknown>;
  doc.rows_root = `sha256:${'0'.repeat(64)}`;
  seal.document = JSON.stringify(doc);
  const report = verifyAuditExport(resign(tampered), checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.equal(report.checks.find((c) => c.id === 'seals')?.status, 'failed');
  assert.deepEqual(report.breaks.map((b) => b.kind), ['statement_problem']);
});

test('T16f2 offline export: a broken previous link is reported', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx, { twoSeals: true, previousOverride: `sha256:${'d'.repeat(64)}` });
  const report = verifyAuditExport(download, checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.breaks.map((b) => b.kind), ['broken_previous']);
});

test('T16f2 offline export: a seal statement that does not match is reported', async () => {
  const ctx = await anchorSetup();
  const { exportObj } = await buildFixture(ctx, { twoSeals: true });
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  const statements = (tampered.seal_evidence as Record<string, unknown>).statements as Array<Record<string, unknown>>;
  const swap = statements[0].statement_canonical;
  statements[0].statement_canonical = statements[1].statement_canonical;
  statements[1].statement_canonical = swap;
  const report = verifyAuditExport(resign(tampered), checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.breaks.map((b) => b.kind), ['statement_problem', 'statement_problem']);
});

test('T16f2 offline export: a changed event is reported with its row', async () => {
  const ctx = await anchorSetup();
  const { exportObj } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  ((tampered.events as StoredAuditRow[])[1].details as Record<string, unknown>).request_id = 'changed';
  const report = verifyAuditExport(resign(tampered), checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.breaks, [{ kind: 'changed_row', seal_digest: report.breaks[0].seal_digest, row_id: id(2) }]);
});

test('T16f2 offline export: a missing event is reported with its row', async () => {
  const ctx = await anchorSetup();
  const { exportObj } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  tampered.events = (tampered.events as StoredAuditRow[]).filter((e) => e.id !== id(2));
  const report = verifyAuditExport(resign(tampered), checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.breaks, [{ kind: 'missing_row', seal_digest: report.breaks[0].seal_digest, row_id: id(2) }]);
});

test('T16f2 offline export: an event added inside a sealed window is reported', async () => {
  const ctx = await anchorSetup();
  const { exportObj } = await buildFixture(ctx);
  const tampered = JSON.parse(JSON.stringify(exportObj)) as Record<string, unknown>;
  (tampered.events as StoredAuditRow[]).push(row(7, '2026-10-15T06:45:00.000000Z'));
  const report = verifyAuditExport(resign(tampered), checkOptions(ctx));
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.breaks, [{ kind: 'unsealed_row_in_sealed_window', seal_digest: report.breaks[0].seal_digest, row_id: id(7) }]);
});

test('T16f2 offline export: pending anchors read not checkable, never a break', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx, { pending: true });
  const report = verifyAuditExport(download, {
    pinnedRootKeyids: [R.keyid], now: NOW,
  });
  assert.equal(report.exit_code, 2);
  assert.equal(report.checks.find((c) => c.id === 'seal_evidence')?.status, 'not_checkable');
  assert.deepEqual(report.breaks, []);
});

// The row digest ignores derived fields, so export events read back exactly.
test('T16f2 offline export: the row digest vector still holds for export events', () => {
  const r = row(1, '2026-10-15T06:00:00.000000Z');
  assert.equal(auditRowDigest(r), auditRowDigest({ ...r, details: { request_id: 'r1' } }));
});

test('T16f2 CLI: --rekor-log-index-offsets reaches the verifier', async () => {
  const ctx = await anchorSetup();
  const { download } = await buildFixture(ctx);
  const files: Record<string, string> = {
    'export.json': JSON.stringify(download),
    'rekor.pem': ctx.rekorLogKeyPem,
    'tsa.pem': ctx.tsaAnchorsPem,
    'offsets-wrong.json': JSON.stringify({ [REKOR_TREE_ID_DEC]: 5 }),
  };
  const run = async (argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await verifyExportMain(argv, {
      readFile: (p) => {
        const text = files[p];
        if (text === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return text;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => new Date(NOW),
    } satisfies VerifyExportIo);
    return { code, out, err };
  };
  const base = ['--export', 'export.json', '--root-keyid', R.keyid,
    '--rekor-log-key', 'rekor.pem', '--tsa-anchors', 'tsa.pem'];
  const clean = await run(base);
  assert.equal(clean.code, 0);
  assert.ok(clean.out.some((l) => l === 'result: exit 0'));
  // A wrong offset for the log's tree fails the anchors: the flag feeds verification.
  const wrong = await run([...base, '--rekor-log-index-offsets', 'offsets-wrong.json']);
  assert.equal(wrong.code, 1);
  // An unreadable offsets file is exit 2 with a clear message.
  const missing = await run([...base, '--rekor-log-index-offsets', 'no-such.json']);
  assert.equal(missing.code, 2);
  assert.ok(missing.err.join('\n').includes('rekor log index offsets file'));
});
