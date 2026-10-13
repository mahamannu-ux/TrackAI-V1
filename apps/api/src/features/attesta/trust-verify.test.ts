/**
 * Trust verifier tests (Task15l, A15.12).
 *
 * Part 1 is ported first, from SushiCorp B4 tests/unit/trust/test_trust_revocation.py
 * @ 0bd67a5 (catalog TR-1): every way the revocation source can be missing, stale,
 * future-dated, garbled, forged or signed by the wrong issuer never yields CLEAN
 * (here: never `verified`); precedence REVOKED > CLEAN > UNKNOWN; no source
 * configured is UNKNOWN. Deviation, as in trust-documents.ts: a present-but-forged or
 * garbled document is `rejected` (SushiCorp: UNKNOWN); neither ever verifies.
 * Part 2 runs the contract vectors through `verifyTrusted`. Part 3 covers each rule
 * and bound in trust.md with fresh random keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { canonicalize, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  KEYSET_TYPE,
  TRUST_MAX_DOCUMENT_BYTES,
  TRUST_ROOT_TYPE,
  verifyTrusted,
  type ArtifactPurpose,
  type CustomerPinnedKey,
  type KeyPurpose,
  type TimeEvidence,
  type TrustCode,
  type TrustDocumentBody,
  type TrustKeyEntry,
  type TrustState,
  type TrustVerdict,
  type VerifyTrustedInput,
} from './trust-contract';
import {
  forwardOnlyViolation,
  parseTrustDocument,
  signTrustDocument,
  trustDocumentPayload,
  TrustDocumentError,
  type DocumentSigner,
} from './trust-documents';

// ---------------------------------------------------------------------------
// Helpers: a world of random keys and signed documents
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
const NOW = '2026-10-20T12:00:00.000Z';
const TENANT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const TENANT_B = '0b0b0b0b-0000-4000-8000-00000000000b';

function entry(k: Key, purpose: KeyPurpose, extra: Partial<TrustKeyEntry> = {}): TrustKeyEntry {
  return { keyid: k.keyid, purpose, spki_der_b64: k.b64, not_before: NB, not_after: NA, status: 'active', ...extra };
}

const W = {
  root1: newKey(), root2: newKey(), root3: newKey(),
  anchor: newKey(), lease: newKey(), fleet: newKey(), policy: newKey(), release: newKey(), keyset: newKey(), keyset2: newKey(),
  a1: newKey(), a2: newKey(), b1: newKey(), stranger: newKey(),
};
const online = (over: Partial<Record<string, Partial<TrustKeyEntry>>> = {}): TrustKeyEntry[] => [
  entry(W.anchor, 'anchor', over.anchor), entry(W.lease, 'activation_lease', over.lease), entry(W.fleet, 'fleet_config', over.fleet),
  entry(W.policy, 'policy_bundle', over.policy), entry(W.release, 'release', over.release), entry(W.keyset, 'tenant_keyset', over.keyset),
];

function rootBody(o: { version?: number; issued?: string; expires?: string; previous?: string | null; roots?: TrustKeyEntry[]; threshold?: number; keys?: TrustKeyEntry[] } = {}): TrustDocumentBody {
  return {
    _type: TRUST_ROOT_TYPE, scope: 'platform', version: o.version ?? 1, issued_at: o.issued ?? NB, expires: o.expires ?? NA,
    previous: o.previous ?? null, threshold: o.threshold ?? 1, keys: [...(o.roots ?? [entry(W.root1, 'root')]), ...(o.keys ?? online())],
  };
}
function keysetBody(o: { tenant?: string; version?: number; issued?: string; expires?: string; previous?: string | null; keys?: TrustKeyEntry[] } = {}): TrustDocumentBody {
  return {
    _type: KEYSET_TYPE, scope: o.tenant ?? TENANT_A, version: o.version ?? 1, issued_at: o.issued ?? '2026-10-10T00:00:00.000Z',
    expires: o.expires ?? '2026-11-09T00:00:00.000Z', previous: o.previous ?? null, keys: o.keys ?? [entry(W.a1, 'statement')],
  };
}
async function doc(body: TrustDocumentBody, signers: Key[]): Promise<DsseEnvelope> {
  return signTrustDocument(body, signers.map(signer));
}
const digestOf = (env: DsseEnvelope) => sha256Prefixed(Buffer.from(env.payload, 'base64'));

const STATEMENT = Buffer.from(canonicalize({ _type: 'https://in-toto.io/Statement/v1', n: 1 }), 'utf8');
const ARTIFACT = Buffer.from(canonicalize({ artifact: 'x' }), 'utf8');
function envelopeFor(payloadType: string, payload: Buffer, k: Key): DsseEnvelope {
  const sig = cryptoSign('sha256', pae(payloadType, payload), { key: k.privateKey, dsaEncoding: 'der' });
  return { payload: payload.toString('base64'), payloadType, signatures: [{ keyid: k.keyid, sig: sig.toString('base64') }] };
}

let R1: DsseEnvelope;
let KSA: DsseEnvelope;
let KSB: DsseEnvelope;
const ready = (async () => {
  R1 = await doc(rootBody(), [W.root1]);
  KSA = await doc(keysetBody(), [W.keyset]);
  KSB = await doc(keysetBody({ tenant: TENANT_B, keys: [entry(W.b1, 'statement')] }), [W.keyset]);
})();

function state(over: Partial<TrustState> = {}): TrustState {
  return {
    pinnedRootKeyids: [W.root1.keyid], rootDocuments: [R1], keysetDocuments: { [TENANT_A]: [KSA], [TENANT_B]: [KSB] },
    lastTrusted: {}, now: NOW, production: true, ...over,
  };
}
function stmt(k: Key, over: Partial<VerifyTrustedInput> = {}, st: Partial<TrustState> = {}): VerifyTrustedInput {
  return { payloadType: IN_TOTO_PAYLOAD_TYPE, payload: STATEMENT, envelope: envelopeFor(IN_TOTO_PAYLOAD_TYPE, STATEMENT, k),
    purpose: 'statement', audience: TENANT_A, signedAt: '2026-10-16T00:00:00.000Z', state: state(st), ...over };
}
function art(k: Key, purpose: ArtifactPurpose, over: Partial<VerifyTrustedInput> = {}, st: Partial<TrustState> = {}): VerifyTrustedInput {
  const pt = 'application/vnd.trackai.test+json';
  return { payloadType: pt, payload: ARTIFACT, envelope: envelopeFor(pt, ARTIFACT, k), purpose, audience: 'platform',
    signedAt: '2026-10-16T00:00:00.000Z', state: state(st), ...over };
}
function expect(v: TrustVerdict, code: TrustCode): void {
  assert.equal(v.code, code, JSON.stringify(v));
  if (code === 'ATTESTA_TRUST_VERIFIED') assert.equal(v.status, 'verified');
  else assert.notEqual(v.status, 'verified');
}

// ---------------------------------------------------------------------------
// Part 1: ported TR-1 cases (three states; UNKNOWN is never CLEAN)
// ---------------------------------------------------------------------------

test('TR-1 port: every key-set (revocation source) problem is never verified', async () => {
  await ready;
  const stale = await doc(keysetBody({ issued: '2026-10-02T00:00:00.000Z', expires: '2026-10-10T00:00:00.000Z' }), [W.keyset]);
  const future = await doc(keysetBody({ issued: '2026-10-21T00:00:00.000Z', expires: '2026-11-21T00:00:00.000Z' }), [W.keyset]);
  const forged = await doc(keysetBody(), [W.stranger]);
  const wrongIssuer = await doc(keysetBody(), [W.release]);
  const goodSigBadBytes = { ...KSA, signatures: [{ ...KSA.signatures[0], sig: forged.signatures[0].sig }] };
  const cases: Array<[string, DsseEnvelope[] | undefined, TrustCode, 'unavailable' | 'rejected']> = [
    ['missing', undefined, 'ATTESTA_TRUST_REVOCATION_UNKNOWN', 'unavailable'],
    ['empty', [], 'ATTESTA_TRUST_REVOCATION_UNKNOWN', 'unavailable'],
    ['garbage', [{ payload: 'bm90IGEga2V5c2V0', payloadType: 'application/vnd.trackai.keyset+json', signatures: KSA.signatures }], 'ATTESTA_TRUST_DOCUMENT_MALFORMED', 'rejected'],
    ['forged_signature', [goodSigBadBytes], 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID', 'rejected'],
    ['wrong_issuer', [wrongIssuer], 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID', 'rejected'],
    ['unknown_signer', [forged], 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID', 'rejected'],
    ['stale', [stale], 'ATTESTA_TRUST_DOCUMENT_EXPIRED', 'unavailable'],
    ['future', [future], 'ATTESTA_TRUST_DOCUMENT_FROM_FUTURE', 'unavailable'],
  ];
  for (const [name, docs, code, status] of cases) {
    const keysets: Record<string, DsseEnvelope[]> = { [TENANT_B]: [KSB] };
    if (docs) keysets[TENANT_A] = docs;
    const v = verifyTrusted(stmt(W.a1, {}, { keysetDocuments: keysets }));
    assert.equal(v.code, code, name);
    assert.equal(v.status, status, name);
  }
});

test('TR-1 port: every root (trust source) problem is never verified', async () => {
  await ready;
  const expired = await doc(rootBody({ expires: '2026-10-19T00:00:00.000Z' }), [W.root1]);
  const forged = await doc(rootBody(), [W.stranger]);
  const cases: Array<[string, Partial<TrustState>, TrustCode]> = [
    ['no_root', { rootDocuments: [] }, 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE'],
    ['not_pinned', { pinnedRootKeyids: [] }, 'ATTESTA_TRUST_ROOT_NOT_PINNED'],
    ['expired', { rootDocuments: [expired] }, 'ATTESTA_TRUST_DOCUMENT_EXPIRED'],
    ['forged', { rootDocuments: [forged] }, 'ATTESTA_TRUST_THRESHOLD_NOT_MET'],
    ['garbage', { rootDocuments: [{ payload: '', payloadType: 'x', signatures: [] }] }, 'ATTESTA_TRUST_DOCUMENT_MALFORMED'],
  ];
  for (const [name, st, code] of cases) expect(verifyTrusted(art(W.release, 'release', {}, st)), code);
});

test('TR-1 port: precedence REVOKED > CLEAN > UNKNOWN', async () => {
  await ready;
  // CLEAN: an authenticated, current key set affirmatively lists the key active.
  expect(verifyTrusted(stmt(W.a1)), 'ATTESTA_TRUST_VERIFIED');
  // REVOKED beats a valid chain and a valid signature.
  const revoked = await doc(keysetBody({ version: 2, previous: digestOf(KSA), issued: '2026-10-18T00:00:00.000Z',
    keys: [entry(W.a1, 'statement', { status: 'revoked', revoked_at: '2026-10-18T00:00:00.000Z', revocation_reason: 'compromised', compromised_since: '2026-10-01T00:00:00.000Z' })] }), [W.keyset]);
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [KSA, revoked] } })), 'ATTESTA_TRUST_KEY_REVOKED');
  // UNKNOWN (no source) is never CLEAN, even with a perfect signature.
  const v = verifyTrusted(stmt(W.a1, {}, { keysetDocuments: {} }));
  assert.equal(v.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// Part 2: contract vectors through verifyTrusted
// ---------------------------------------------------------------------------

test('T15l: every contract vector gives its expected status and code through verifyTrusted', () => {
  const dir = join(__dirname, 'vectors', 'trust');
  const files = readdirSync(dir).filter((f) => /^\d{2}-.*\.json$/.test(f)).sort();
  assert.ok(files.length >= 57);
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const s = v.input.state;
    const te = v.input.time_evidence;
    const r = verifyTrusted({
      payloadType: v.input.payload_type, payload: Buffer.from(v.input.payload_b64, 'base64'), envelope: v.input.envelope,
      purpose: v.input.purpose, audience: v.input.audience, signedAt: v.input.signed_at,
      timeEvidence: te && { kind: te.kind, time: te.time, binds: te.binds, digest: te.digest },
      state: { pinnedRootKeyids: s.pinned_root_keyids, pinnedRootThreshold: s.pinned_root_threshold, rootDocuments: s.root_documents,
        keysetDocuments: s.keyset_documents, customerPins: s.customer_pins, lastTrusted: s.last_trusted, now: s.now, trustedTimeFloor: s.trusted_time_floor,
        clockSkewMs: s.clock_skew_ms, production: s.production, allowUnpinnedRoot: s.allow_unpinned_root },
    });
    assert.equal(r.status, v.expected.status, f);
    assert.equal(r.code, v.expected.code, f);
    if (v.expected.keyid !== undefined) assert.equal(r.keyid, v.expected.keyid, f);
    if (v.expected.trusted !== undefined) assert.deepEqual(r.trusted, v.expected.trusted, f);
    if (v.expected.trusted_time !== undefined) assert.equal(r.trustedTime, v.expected.trusted_time, f);
    if (r.status !== 'verified') assert.equal(r.keyid, undefined, f);
  }
});

// ---------------------------------------------------------------------------
// Part 3: rules, boundaries and bounds
// ---------------------------------------------------------------------------

test('T15l validity: not_before, not_after and revoked_at boundaries', async () => {
  await ready;
  const at = (signedAt: string, st: Partial<TrustState> = {}) => verifyTrusted(stmt(W.a1, { signedAt }, st));
  expect(at(NB), 'ATTESTA_TRUST_VERIFIED');
  expect(at('2026-09-30T23:59:59.999Z'), 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  const late = { now: '2027-10-01T00:00:00.000Z', keysetDocuments: { [TENANT_A]: [await doc(keysetBody({ issued: '2027-09-20T00:00:00.000Z', expires: '2027-10-20T00:00:00.000Z' }), [W.keyset])] },
    rootDocuments: [await doc(rootBody({ issued: '2027-09-01T00:00:00.000Z', expires: '2027-12-01T00:00:00.000Z', keys: online({ keyset: { not_after: '2027-12-01T00:00:00.000Z' } }) }), [W.root1])] };
  expect(at(NA, late), 'ATTESTA_TRUST_VERIFIED');
  expect(at('2027-10-01T00:00:00.001Z', late), 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  const RA = '2026-10-15T00:00:00.000Z';
  const retired = await doc(keysetBody({ issued: RA, keys: [entry(W.a1, 'statement', { status: 'retired', revoked_at: RA })] }), [W.keyset]);
  const superseded = await doc(keysetBody({ issued: RA, keys: [entry(W.a1, 'statement', { status: 'revoked', revoked_at: RA, revocation_reason: 'superseded' })] }), [W.keyset]);
  const ledger = (time: string): TimeEvidence => ({ kind: 'rekor_integrated_time', time, binds: 'ledger_statement', digest: sha256Prefixed(STATEMENT) });
  for (const [ks, code] of [[retired, 'ATTESTA_TRUST_KEY_NOT_VALID_AT'], [superseded, 'ATTESTA_TRUST_KEY_REVOKED']] as const) {
    const st = { keysetDocuments: { [TENANT_A]: [ks] } };
    const withEv = (signedAt: string, time: string) => verifyTrusted(stmt(W.a1, { signedAt, timeEvidence: ledger(time) }, st));
    // The claim alone never grandfathers a non-active key (Codex review): only evidence before revoked_at.
    expect(at('2026-10-14T23:59:59.999Z', st), code);
    expect(withEv('2026-10-14T23:59:59.999Z', '2026-10-14T23:59:59.999Z'), 'ATTESTA_TRUST_VERIFIED');
    expect(withEv('2026-10-14T00:00:00.000Z', RA), code);
    expect(withEv(RA, '2026-10-14T00:00:00.000Z'), 'ATTESTA_TRUST_VERIFIED'); // the bound evidence decides, not the claim
  }
  // An active key past not_after at now: the claim alone is not enough either.
  const expiredNow = { now: '2027-10-01T00:05:00.001Z', keysetDocuments: { [TENANT_A]: [await doc(keysetBody({ issued: '2027-09-20T00:00:00.000Z', expires: '2027-10-20T00:00:00.000Z' }), [W.keyset])] },
    rootDocuments: late.rootDocuments };
  expect(at('2027-09-30T00:00:00.000Z', expiredNow), 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  expect(verifyTrusted(stmt(W.a1, { signedAt: '2027-09-30T00:00:00.000Z', timeEvidence: ledger('2027-09-30T00:00:00.000Z') }, expiredNow)), 'ATTESTA_TRUST_VERIFIED');
});

test('T15l clock floor: a rolled-back clock is refused; trustedTime only moves forward', async () => {
  await ready;
  expect(verifyTrusted(stmt(W.a1, {}, { trustedTimeFloor: '2026-10-20T12:05:00.001Z' })), 'ATTESTA_TRUST_CLOCK_BEHIND');
  const ok = verifyTrusted(stmt(W.a1, {}, { trustedTimeFloor: '2026-10-20T12:05:00.000Z' }));
  expect(ok, 'ATTESTA_TRUST_VERIFIED');
  assert.equal(ok.trustedTime, '2026-10-20T12:05:00.000Z');
  assert.equal(verifyTrusted(stmt(W.a1, {}, { trustedTimeFloor: '2026-10-01T00:00:00.000Z' })).trustedTime, NOW);
  assert.equal(verifyTrusted(stmt(W.a1)).trustedTime, NOW);
  assert.equal(verifyTrusted(stmt(W.a1, {}, { trustedTimeFloor: 'yesterday' })).code, 'ATTESTA_TRUST_INPUT_INVALID');
});

test('T15l compromise: only bound, independent, earlier time evidence saves a signature', async () => {
  await ready;
  const CS = '2026-10-17T00:00:00.000Z';
  const ks = await doc(keysetBody({ issued: '2026-10-18T00:00:00.000Z', keys: [entry(W.a1, 'statement', { status: 'revoked', revoked_at: '2026-10-18T00:00:00.000Z', revocation_reason: 'compromised', compromised_since: CS })] }), [W.keyset]);
  const st = { keysetDocuments: { [TENANT_A]: [ks] } };
  const ev = (o: Partial<TimeEvidence>): TimeEvidence => ({ kind: 'tsa_gen_time', time: '2026-10-16T00:00:00.000Z', binds: 'ledger_statement', digest: sha256Prefixed(STATEMENT), ...o });
  const run = (timeEvidence?: TimeEvidence, signedAt = '2026-10-10T00:00:00.000Z') => verifyTrusted(stmt(W.a1, { timeEvidence, signedAt }, st));
  expect(run(), 'ATTESTA_TRUST_KEY_REVOKED');
  expect(run(ev({})), 'ATTESTA_TRUST_VERIFIED');
  expect(run(ev({ kind: 'rekor_integrated_time' })), 'ATTESTA_TRUST_VERIFIED');
  expect(run(ev({ time: '2026-10-16T23:59:59.999Z' })), 'ATTESTA_TRUST_VERIFIED');
  expect(run(ev({ time: CS })), 'ATTESTA_TRUST_KEY_REVOKED');
  expect(run(ev({ kind: 'self_claimed' as TimeEvidence['kind'] })), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(run(ev({ digest: sha256Prefixed(ARTIFACT) })), 'ATTESTA_TRUST_KEY_REVOKED');
  expect(run(ev({ binds: 'signature' })), 'ATTESTA_TRUST_KEY_REVOKED'); // a payload digest is not the signature's
  expect(run(ev({ binds: 'other' as TimeEvidence['binds'] })), 'ATTESTA_TRUST_INPUT_INVALID');
  // Bound to the signature itself.
  const input = stmt(W.a1, { signedAt: '2026-10-10T00:00:00.000Z' }, st);
  const sigDigest = sha256Prefixed(Buffer.from(input.envelope.signatures[0].sig, 'base64'));
  expect(verifyTrusted({ ...input, timeEvidence: ev({ binds: 'signature', digest: sigDigest }) }), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted({ ...input, timeEvidence: ev({ binds: 'signature', digest: sigDigest, time: CS }) }), 'ATTESTA_TRUST_KEY_REVOKED');
  // A fresh signature over the same payload is not covered by the old signature's evidence.
  const resigned = stmt(W.a1, { signedAt: '2026-10-10T00:00:00.000Z' }, st);
  expect(verifyTrusted({ ...resigned, timeEvidence: ev({ binds: 'signature', digest: sigDigest }) }), 'ATTESTA_TRUST_KEY_REVOKED');
  expect(run(ev({ time: 'yesterday' })), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(run(ev({ digest: 'junk' })), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(run({ ...ev({}), extra: 1 } as TimeEvidence), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(run(ev({ time: '2026-09-01T00:00:00.000Z' })), 'ATTESTA_TRUST_KEY_REVOKED'); // before the key existed
  // A back-dated signedAt never helps without evidence.
  expect(run(undefined, '2026-10-02T00:00:00.000Z'), 'ATTESTA_TRUST_KEY_REVOKED');
});

test('T15l root rotation: k-of-n thresholds, old documents keep their era, retired roots refused', async () => {
  await ready;
  // Root v1: 2-of-3; v2 rotates to root3 alone (1-of-1), signed by two v1 keys and root3.
  const roots3 = [entry(W.root1, 'root'), entry(W.root2, 'root'), entry(W.stranger, 'root')];
  const v1 = await doc(rootBody({ roots: roots3, threshold: 2 }), [W.root1, W.root2]);
  const v1one = await doc(rootBody({ roots: roots3, threshold: 2 }), [W.root1]);
  const pins = { pinnedRootKeyids: [W.root1.keyid, W.root2.keyid, W.stranger.keyid] };
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1] })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1one] })), 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
  const v2body = rootBody({ version: 2, issued: '2026-10-12T00:00:00.000Z', previous: digestOf(v1), roots: [entry(W.root3, 'root')] });
  const v2 = await doc(v2body, [W.root1, W.root2, W.root3]);
  const v2weak = await doc(v2body, [W.root1, W.root3]);
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1, v2] })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1, v2weak] })), 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
  // Statements signed under v1's key set era still verify after rotation.
  expect(verifyTrusted(stmt(W.a1, {}, { ...pins, rootDocuments: [v1, v2] })), 'ATTESTA_TRUST_VERIFIED');
  // A v3 signed by v1's (now retired) root keys only.
  const v3 = await doc(rootBody({ version: 3, issued: '2026-10-13T00:00:00.000Z', previous: digestOf(v2), roots: [entry(W.root1, 'root')] }), [W.root1, W.root2]);
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1, v2, v3] })), 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
  // previous must name the exact predecessor; byte-identical duplicates are fine.
  const v2fork = await doc({ ...v2body, previous: 'sha256:' + '1'.repeat(64) }, [W.root1, W.root2, W.root3]);
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1, v2fork] })), 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
  expect(verifyTrusted(art(W.release, 'release', {}, { ...pins, rootDocuments: [v1, v2, v1, v2] })), 'ATTESTA_TRUST_VERIFIED');
  // The development TOFU flag is ignored in production.
  expect(verifyTrusted(art(W.release, 'release', {}, { pinnedRootKeyids: [], allowUnpinnedRoot: true })), 'ATTESTA_TRUST_ROOT_NOT_PINNED');
});

test('T15l root: dropping or weakening a platform online key across versions is a regression', async () => {
  await ready;
  const next = (keys: TrustKeyEntry[]) => doc(rootBody({ version: 2, issued: '2026-10-12T00:00:00.000Z', previous: digestOf(R1), keys }), [W.root1]);
  const dropped = await next(online().filter((k) => k.purpose !== 'release'));
  expect(verifyTrusted(art(W.anchor, 'anchor', {}, { rootDocuments: [R1, dropped] })), 'ATTESTA_TRUST_KEYSET_REGRESSION');
  const added = await next([...online(), entry(W.keyset2, 'tenant_keyset')]);
  expect(verifyTrusted(art(W.anchor, 'anchor', {}, { rootDocuments: [R1, added] })), 'ATTESTA_TRUST_VERIFIED');
});

test('T15l forward-only rule: each field may only move forward', async () => {
  await ready;
  const RA = '2026-10-15T00:00:00.000Z';
  const base = (keys: TrustKeyEntry[], version = 1, previous: string | null = null, issued = RA) =>
    parseTrustDocument(trustDocumentPayloadEnv(keysetBody({ version, previous, issued, keys })));
  const p = base([entry(W.a1, 'statement', { status: 'revoked', revoked_at: RA, revocation_reason: 'superseded' }), entry(W.a2, 'statement', { status: 'retired', revoked_at: RA })]);
  const n = (keys: TrustKeyEntry[], issued = RA) => base(keys, 2, p.digest, issued);
  const a1 = (x: Partial<TrustKeyEntry> = {}) => entry(W.a1, 'statement', { status: 'revoked', revoked_at: RA, revocation_reason: 'superseded', ...x });
  const a2 = (x: Partial<TrustKeyEntry> = {}) => entry(W.a2, 'statement', { status: 'retired', revoked_at: RA, ...x });
  const EARLIER = '2026-10-14T00:00:00.000Z';
  assert.equal(forwardOnlyViolation(p, n([a1(), a2()])), null);
  assert.equal(forwardOnlyViolation(p, n([a1({ revocation_reason: 'compromised', compromised_since: EARLIER }), a2()])), null);
  assert.equal(forwardOnlyViolation(p, n([a1({ revoked_at: EARLIER }), a2({ status: 'revoked', revocation_reason: 'superseded' })])), null);
  assert.equal(forwardOnlyViolation(p, n([a1(), a2({ not_after: '2027-01-01T00:00:00.000Z' })])), null);
  const bad: Array<[string, TrustKeyEntry[], string?]> = [
    ['dropped', [a1()]],
    ['status back', [a1(), entry(W.a2, 'statement')]],
    ['revoked to retired', [entry(W.a1, 'statement', { status: 'retired', revoked_at: RA }), a2()]],
    ['revoked_at later', [a1({ revoked_at: '2026-10-15T00:00:00.001Z' }), a2()], '2026-10-16T00:00:00.000Z'],
    ['not_after wider', [a1({ not_after: '2027-10-01T00:00:00.001Z' }), a2()]],
    ['not_before moved', [a1({ not_before: '2026-10-01T00:00:00.001Z' }), a2()]],
    ['issued_at back', [a1({ revoked_at: '2026-10-14T00:00:00.000Z' }), a2({ revoked_at: '2026-10-14T00:00:00.000Z' })], '2026-10-14T23:59:59.999Z'],
  ];
  for (const [name, keys, issued] of bad) assert.equal(forwardOnlyViolation(p, n(keys, issued ?? RA)), 'ATTESTA_TRUST_KEYSET_REGRESSION', name);
  const pc = base([a1({ revocation_reason: 'compromised', compromised_since: EARLIER }), a2()]);
  const nc = (x: Partial<TrustKeyEntry>) => base([a1(x), a2()], 2, pc.digest);
  assert.equal(forwardOnlyViolation(pc, nc({ revocation_reason: 'superseded' })), 'ATTESTA_TRUST_KEYSET_REGRESSION');
  assert.equal(forwardOnlyViolation(pc, nc({ revocation_reason: 'compromised', compromised_since: '2026-10-14T00:00:00.001Z' })), 'ATTESTA_TRUST_KEYSET_REGRESSION');
  assert.equal(forwardOnlyViolation(pc, nc({ revocation_reason: 'compromised', compromised_since: '2026-10-13T00:00:00.000Z' })), null);
});

function trustDocumentPayloadEnv(body: TrustDocumentBody): DsseEnvelope {
  const { payloadType, payload } = trustDocumentPayload(body);
  return { payload: payload.toString('base64'), payloadType, signatures: [{ keyid: W.keyset.keyid, sig: 'AA==' }] };
}

test('T15l purpose and tenant confusion', async () => {
  await ready;
  expect(verifyTrusted(art(W.release, 'activation_lease')), 'ATTESTA_TRUST_PURPOSE_MISMATCH');
  expect(verifyTrusted(art(W.lease, 'release')), 'ATTESTA_TRUST_PURPOSE_MISMATCH');
  expect(verifyTrusted(art(W.root1, 'anchor')), 'ATTESTA_TRUST_PURPOSE_MISMATCH');
  expect(verifyTrusted(art(W.a1, 'policy_bundle')), 'ATTESTA_TRUST_PURPOSE_MISMATCH');
  expect(verifyTrusted(stmt(W.keyset)), 'ATTESTA_TRUST_PURPOSE_MISMATCH');
  expect(verifyTrusted(stmt(W.a1, { audience: TENANT_B })), 'ATTESTA_TRUST_AUDIENCE_MISMATCH');
  expect(verifyTrusted(stmt(W.b1)), 'ATTESTA_TRUST_AUDIENCE_MISMATCH');
  expect(verifyTrusted(stmt(W.b1, { audience: TENANT_B })), 'ATTESTA_TRUST_VERIFIED');
  // A key set of tenant B filed under tenant A is refused, not used.
  expect(verifyTrusted(stmt(W.b1, {}, { keysetDocuments: { [TENANT_A]: [KSB] } })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  // A root document filed as a key set, and the reverse.
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [R1] } })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  expect(verifyTrusted(stmt(W.a1, {}, { rootDocuments: [KSA] })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
});

test('T15l key sets: a retired or compromised tenant_keyset key, rollback and expiry skew', async () => {
  await ready;
  const RA = '2026-10-12T00:00:00.000Z';
  const rootWith = (x: Partial<TrustKeyEntry>) => doc(rootBody({ version: 2, issued: '2026-10-12T00:00:00.000Z', previous: digestOf(R1), keys: online({ keyset: x }) }), [W.root1]);
  const retiredRoot = await rootWith({ status: 'retired', revoked_at: RA });
  const compromisedRoot = await rootWith({ status: 'revoked', revoked_at: RA, revocation_reason: 'compromised', compromised_since: '2026-10-01T00:00:00.000Z' });
  // KSA was issued 2026-10-10, before the keyset key retired: still vouches.
  expect(verifyTrusted(stmt(W.a1, {}, { rootDocuments: [R1, retiredRoot] })), 'ATTESTA_TRUST_VERIFIED');
  const after = await doc(keysetBody({ issued: '2026-10-13T00:00:00.000Z' }), [W.keyset]);
  expect(verifyTrusted(stmt(W.a1, {}, { rootDocuments: [R1, retiredRoot], keysetDocuments: { [TENANT_A]: [after] } })), 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  // A compromised keyset key never vouches (documents carry no time evidence).
  expect(verifyTrusted(stmt(W.a1, {}, { rootDocuments: [R1, compromisedRoot] })), 'ATTESTA_TRUST_KEY_REVOKED');
  expect(verifyTrusted(stmt(W.a1, {}, { lastTrusted: { [TENANT_A]: { version: 2, digest: 'sha256:' + '2'.repeat(64) } } })), 'ATTESTA_TRUST_ROLLBACK');
  expect(verifyTrusted(stmt(W.a1, {}, { lastTrusted: { [TENANT_A]: { version: 1, digest: 'sha256:' + '2'.repeat(64) } } })), 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
  const ok = verifyTrusted(stmt(W.a1, {}, { lastTrusted: { [TENANT_A]: { version: 1, digest: digestOf(KSA) }, platform: { version: 1, digest: digestOf(R1) } } }));
  expect(ok, 'ATTESTA_TRUST_VERIFIED');
  assert.deepEqual(ok.trusted, { platform: { version: 1, digest: digestOf(R1) }, [TENANT_A]: { version: 1, digest: digestOf(KSA) } });
  // Skew: a key set issued 4:59 in the future is fine, 5:00.001 is not.
  const ahead = (issued: string) => doc(keysetBody({ issued, expires: '2026-11-20T00:00:00.000Z' }), [W.keyset]);
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [await ahead('2026-10-20T12:05:00.000Z')] } })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [await ahead('2026-10-20T12:05:00.001Z')] } })), 'ATTESTA_TRUST_DOCUMENT_FROM_FUTURE');
  // A custom skew of zero.
  expect(verifyTrusted(stmt(W.a1, {}, { clockSkewMs: 0, keysetDocuments: { [TENANT_A]: [await ahead('2026-10-20T12:00:00.001Z')] } })), 'ATTESTA_TRUST_DOCUMENT_FROM_FUTURE');
  // Key-set version gap.
  const v3 = await doc(keysetBody({ version: 3, previous: digestOf(KSA), issued: '2026-10-12T00:00:00.000Z' }), [W.keyset]);
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [KSA, v3] } })), 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
});

test('T15l customer pins override the platform key set and still apply validity', async () => {
  await ready;
  const pin = (x: Partial<TrustKeyEntry> = {}) => entry(W.a2, 'statement', x) as CustomerPinnedKey;
  const noTrackai = { rootDocuments: [], keysetDocuments: {}, pinnedRootKeyids: [] };
  expect(verifyTrusted(stmt(W.a2, {}, { ...noTrackai, customerPins: { [TENANT_A]: [pin()] } })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(stmt(W.a1, {}, { customerPins: { [TENANT_A]: [pin()] } })), 'ATTESTA_TRUST_KEY_UNKNOWN');
  expect(verifyTrusted(stmt(W.a2, {}, { customerPins: { [TENANT_A]: [] } })), 'ATTESTA_TRUST_KEY_UNKNOWN');
  expect(verifyTrusted(stmt(W.a2, { signedAt: '2026-09-01T00:00:00.000Z' }, { customerPins: { [TENANT_A]: [pin()] } })), 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
  // Pins for tenant A do not leak into tenant B or into platform purposes.
  expect(verifyTrusted(stmt(W.b1, { audience: TENANT_B }, { customerPins: { [TENANT_A]: [pin()] } })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(art(W.release, 'release', {}, { customerPins: { [TENANT_A]: [pin()] } })), 'ATTESTA_TRUST_VERIFIED');
  // A malformed pin (keyid not the SPKI digest, purpose other than statement, duplicates) is a caller error.
  expect(verifyTrusted(stmt(W.a2, {}, { customerPins: { [TENANT_A]: [pin({ keyid: W.a1.keyid })] } })), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(verifyTrusted(stmt(W.a2, {}, { customerPins: { [TENANT_A]: [{ ...pin(), purpose: 'release' } as unknown as CustomerPinnedKey] } })), 'ATTESTA_TRUST_INPUT_INVALID');
  expect(verifyTrusted(stmt(W.a2, {}, { customerPins: { [TENANT_A]: [pin(), pin()] } })), 'ATTESTA_TRUST_INPUT_INVALID');
});

test('T15l bounds: oversized and malformed documents are refused before signature work', async () => {
  await ready;
  const bigKeys = Array.from({ length: 1001 }, () => entry(newKey(), 'statement'));
  assert.throws(() => trustDocumentPayload(keysetBody({ keys: bigKeys })), (e: unknown) => e instanceof TrustDocumentError && e.code === 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  // 1000 keys already exceed the 256 KiB payload bound; about 700 fit.
  assert.throws(() => trustDocumentPayload(keysetBody({ keys: bigKeys.slice(0, 1000) })), TrustDocumentError);
  const t0 = Date.now();
  parseTrustDocument(trustDocumentPayloadEnv(keysetBody({ keys: bigKeys.slice(0, 600) })));
  assert.ok(Date.now() - t0 < 2000, '600 keys parse quickly');
  const huge = Buffer.alloc(TRUST_MAX_DOCUMENT_BYTES + 1, 0x20).toString('base64');
  const cases: unknown[] = [
    { ...KSA, payload: huge },
    { ...KSA, signatures: Array.from({ length: 17 }, () => KSA.signatures[0]) },
    { ...KSA, signatures: [KSA.signatures[0], KSA.signatures[0]] },
    { ...KSA, signatures: [] },
    { ...KSA, extra: true },
    { ...KSA, payload: KSA.payload + '=' },
    { ...KSA, payloadType: 'application/json' },
    { ...KSA, signatures: [{ keyid: 'sha256:xyz', sig: 'AA==' }] },
    { ...KSA, signatures: [{ ...KSA.signatures[0], extra: 1 }] },
    null, 'x', 7, [],
  ];
  for (const c of cases) {
    expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [c as DsseEnvelope] } })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  }
  // Payload rules: canonical, closed, keyid digest, P-256, time order, revocation not after issued_at, threshold.
  const raw = (body: unknown) => ({ payload: Buffer.from(canonicalize(body), 'utf8').toString('base64'), payloadType: 'application/vnd.trackai.keyset+json', signatures: KSA.signatures });
  const kb = keysetBody();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const k1 = await import('node:crypto').then((c) => c.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
  const bodies: unknown[] = [
    { ...kb, extra: 1 },
    { ...kb, keys: [{ ...kb.keys[0], extra: 1 }] },
    { ...kb, keys: [{ ...kb.keys[0], spki_der_b64: rsa.toString('base64'), keyid: sha256Prefixed(rsa) }] },
    { ...kb, keys: [{ ...kb.keys[0], spki_der_b64: k1.toString('base64'), keyid: sha256Prefixed(k1) }] },
    { ...kb, expires: kb.issued_at },
    { ...kb, keys: [{ ...kb.keys[0], not_after: kb.keys[0].not_before }] },
    { ...kb, keys: [{ ...kb.keys[0], status: 'retired', revoked_at: '2026-10-11T00:00:00.000Z' }] },
    { ...kb, issued_at: '2026-02-30T00:00:00.000Z' },
    { ...kb, version: 0 },
    { ...kb, version: 2 },
    { ...kb, scope: 'A' },
    { ...kb, _type: TRUST_ROOT_TYPE },
    { ...kb, threshold: 1 },
    { ...kb, keys: [] },
    { ...kb, keys: [{ ...kb.keys[0], status: 'revoked', revoked_at: kb.issued_at, revocation_reason: 'compromised', compromised_since: '2026-10-10T00:00:00.001Z' }] },
    [kb],
  ];
  for (const [i, b] of bodies.entries()) {
    expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [raw(b) as DsseEnvelope] } })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
    assert.ok(i >= 0);
  }
  const proto = { payload: Buffer.from(canonicalize(kb).replace('{"_type"', '{"__proto__":{},"_type"'), 'utf8').toString('base64'), payloadType: KSA.payloadType, signatures: KSA.signatures };
  expect(verifyTrusted(stmt(W.a1, {}, { keysetDocuments: { [TENANT_A]: [proto as DsseEnvelope] } })), 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  // Root threshold above the active root keys.
  assert.throws(() => trustDocumentPayload(rootBody({ threshold: 2 })), TrustDocumentError);
  // A retired root key does not count as an active root key.
  assert.throws(() => trustDocumentPayload(rootBody({ roots: [entry(W.root1, 'root', { status: 'retired', revoked_at: NB })] })), TrustDocumentError);
});

test('T15l input: malformed calls are rejected, never thrown', async () => {
  await ready;
  const good = stmt(W.a1);
  const cases: Array<Partial<VerifyTrustedInput> | Record<string, unknown>> = [
    { payload: ARTIFACT },
    { payload: 'x' as unknown as Buffer },
    { payloadType: '' },
    { envelope: { ...good.envelope, signatures: [] } },
    { envelope: { ...good.envelope, payload: '%%%' } },
    { envelope: { ...good.envelope, signatures: [{ keyid: 'nope', sig: good.envelope.signatures[0].sig }] } },
    { envelope: null as unknown as DsseEnvelope },
    { purpose: 'tenant_keyset' as ArtifactPurpose },
    { audience: TENANT_A.toUpperCase() },
    { signedAt: '2026-10-16' },
    { timeEvidence: 'soon' as unknown as TimeEvidence },
    { state: { ...good.state, now: 'now' } },
    { state: { ...good.state, clockSkewMs: -1 } },
    { state: { ...good.state, clockSkewMs: 3_600_001 } },
    { state: { ...good.state, production: 'yes' as unknown as boolean } },
    { state: { ...good.state, pinnedRootKeyids: ['root'] } },
    { state: { ...good.state, pinnedRootThreshold: 0 } },
    { state: { ...good.state, rootDocuments: Array.from({ length: 1025 }, () => R1) } },
    { state: { ...good.state, keysetDocuments: { [TENANT_A]: Array.from({ length: 1025 }, () => KSA) } } },
    { state: { ...good.state, lastTrusted: { platform: { version: 0, digest: digestOf(R1) } } } },
    { state: { ...good.state, lastTrusted: { platform: { version: 1, digest: 'x' } } } },
    { state: { ...good.state, keysetDocuments: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`t${i}`, []])) } },
    { state: { ...good.state, keysetDocuments: { [TENANT_A]: Array.from({ length: 70 }, () => ({ ...KSA, payload: 'A'.repeat(250_000) })) } } },
    { state: null as unknown as TrustState },
  ];
  for (const [i, c] of cases.entries()) {
    const v = verifyTrusted({ ...good, ...c } as VerifyTrustedInput);
    assert.equal(v.code, 'ATTESTA_TRUST_INPUT_INVALID', `case ${i}: ${JSON.stringify(v)}`);
  }
  for (const junk of [null, undefined, 0, 'x', [], {}]) {
    assert.equal(verifyTrusted(junk as unknown as VerifyTrustedInput).code, 'ATTESTA_TRUST_INPUT_INVALID');
  }
  // Oversized artifact.
  const big = Buffer.alloc(16 * 1024 * 1024 + 1);
  assert.equal(verifyTrusted({ ...good, payload: big, envelope: { ...good.envelope, payload: big.toString('base64') } }).code, 'ATTESTA_TRUST_INPUT_INVALID');
});

test('T15l signature: a listed key over other bytes, or a tampered payload, is rejected', async () => {
  await ready;
  const v = stmt(W.a1);
  const other = envelopeFor(IN_TOTO_PAYLOAD_TYPE, ARTIFACT, W.a1);
  expect(verifyTrusted({ ...v, envelope: { ...v.envelope, signatures: other.signatures } }), 'ATTESTA_TRUST_SIGNATURE_INVALID');
  // Same signature, payloadType swapped consistently (PAE binds the type).
  const pt = 'application/vnd.other+json';
  expect(verifyTrusted({ ...v, payloadType: pt, envelope: { ...v.envelope, payloadType: pt } }), 'ATTESTA_TRUST_SIGNATURE_INVALID');
  expect(verifyTrusted({ ...v, envelope: { ...v.envelope, signatures: [{ ...v.envelope.signatures[0], sig: 'AAAA' }] } }), 'ATTESTA_TRUST_SIGNATURE_INVALID');
});

test('T15l documents: the hand-written validator agrees with the JSON schema', async () => {
  await ready;
  const schema = JSON.parse(readFileSync(join(__dirname, '../../../../../docs/contracts/attesta/trust-document-v1.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false }).compile(schema);
  const kb = keysetBody({ keys: [entry(W.a1, 'statement', { status: 'revoked', revoked_at: '2026-10-10T00:00:00.000Z', revocation_reason: 'superseded' })] });
  const rb = rootBody();
  const variants: unknown[] = [kb, rb,
    { ...kb, threshold: 1 }, { ...rb, threshold: undefined }, { ...kb, scope: 'platform' }, { ...kb, version: 2 },
    { ...kb, keys: [{ ...kb.keys[0], revocation_reason: undefined }] },
    { ...kb, keys: [{ ...kb.keys[0], revocation_reason: 'compromised' }] },
    { ...kb, keys: [{ ...kb.keys[0], status: 'active' }] },
    { ...rb, keys: rb.keys.map((k) => ({ ...k, purpose: k.purpose === 'root' ? 'anchor' : k.purpose })) },
    { ...rb, keys: [...rb.keys, entry(W.a1, 'statement')] },
    { ...kb, issued_at: '2026-10-10T00:00:00Z' }, { ...kb, previous: 'sha256:00' },
  ].map((o) => JSON.parse(JSON.stringify(o)));
  for (const [i, body] of variants.entries()) {
    const schemaOk = validate(body) as boolean;
    let mineOk = true;
    try {
      parseTrustDocument({ payload: Buffer.from(canonicalize(body), 'utf8').toString('base64'),
        payloadType: (body as { _type: string })._type === TRUST_ROOT_TYPE ? 'application/vnd.trackai.trust-root+json' : 'application/vnd.trackai.keyset+json',
        signatures: [{ keyid: W.keyset.keyid, sig: 'AA==' }] });
    } catch {
      mineOk = false;
    }
    assert.equal(mineOk, schemaOk, `variant ${i}`);
  }
});

test('T15l signTrustDocument: refuses what the verifier would refuse; signatures verify', async () => {
  await ready;
  await assert.rejects(signTrustDocument(keysetBody(), []), TrustDocumentError);
  await assert.rejects(signTrustDocument({ ...keysetBody(), scope: 'platform' }, [signer(W.keyset)]), TrustDocumentError);
  await assert.rejects(signTrustDocument(keysetBody(), [{ keyid: W.keyset.keyid, sign: () => 'nope' as unknown as Buffer }]), TrustDocumentError);
  const env = await signTrustDocument(keysetBody(), [signer(W.keyset)]);
  assert.equal(parseTrustDocument(env).signatures.length, 1);
});

test('T15l lifetimes and root-key validity (review findings 4 and 6)', async () => {
  await ready;
  // Key sets live at most 31 days, roots at most 366 days.
  assert.doesNotThrow(() => trustDocumentPayload(keysetBody({ expires: '2026-11-10T00:00:00.000Z' })));
  assert.throws(() => trustDocumentPayload(keysetBody({ expires: '2026-11-10T00:00:00.001Z' })), TrustDocumentError);
  assert.doesNotThrow(() => trustDocumentPayload(rootBody({ expires: '2027-10-02T00:00:00.000Z' })));
  assert.throws(() => trustDocumentPayload(rootBody({ expires: '2027-10-02T00:00:00.001Z' })), TrustDocumentError);
  // A retired tenant_keyset key back-dating a key set: its output dies within 31 days of revoked_at.
  const RA = '2026-10-12T00:00:00.000Z';
  const retiredRoot = await doc(rootBody({ version: 2, issued: RA, previous: digestOf(R1), keys: online({ keyset: { status: 'retired', revoked_at: RA } }) }), [W.root1]);
  const backdated = await doc(keysetBody({ issued: '2026-10-11T00:00:00.000Z', expires: '2026-11-11T00:00:00.000Z' }), [W.keyset]);
  const st = { rootDocuments: [R1, retiredRoot], keysetDocuments: { [TENANT_A]: [backdated] } };
  expect(verifyTrusted(stmt(W.a1, {}, st)), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(stmt(W.a1, {}, { ...st, now: '2026-11-11T00:05:00.001Z' })), 'ATTESTA_TRUST_DOCUMENT_EXPIRED');
  // A root key outside its validity at the document's issued_at does not count.
  const shortRoot = await doc(rootBody({ roots: [entry(W.root1, 'root', { not_after: '2026-10-05T00:00:00.000Z' })] }), [W.root1]);
  const next = await doc(rootBody({ version: 2, issued: '2026-10-06T00:00:00.000Z', previous: digestOf(shortRoot), roots: [entry(W.root2, 'root')] }), [W.root1, W.root2]);
  expect(verifyTrusted(art(W.release, 'release', {}, { rootDocuments: [shortRoot] })), 'ATTESTA_TRUST_VERIFIED');
  expect(verifyTrusted(art(W.release, 'release', {}, { rootDocuments: [shortRoot, next] })), 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
});
