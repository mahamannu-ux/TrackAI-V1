/**
 * Generator for the trust-layer test vectors (Task15l, A15.12; docs/contracts/attesta/trust.md "Vectors").
 *
 *   npx tsx src/features/attesta/vectors/trust/generate.ts          # (re)write the files
 *   npx tsx src/features/attesta/vectors/trust/generate.ts --check  # exit 1 if a file differs
 *
 * Every byte is deterministic: test keys are derived from public seed strings
 * (they protect nothing), signatures are RFC 6979 (@noble/curves), payloads are
 * RFC 8785. The `expected` block of each vector is the contract: GitAI's Rust
 * verifier and trust-verify.ts must both return that status and code.
 *
 * Built only on merged primitives (canonical.ts, dsse.ts), not on the verifier
 * under test, so the vectors stay an independent specification.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import { canonicalize, sha256Prefixed } from '../../canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from '../../dsse';

export const VECTOR_VERSION = 1;
const OUT_DIR = __dirname;
const ROOT_PT = 'application/vnd.trackai.trust-root+json';
const KEYSET_PT = 'application/vnd.trackai.keyset+json';
const ROOT_TYPE = 'https://trackai.dev/attesta/trust-root/v1';
const KEYSET_TYPE = 'https://trackai.dev/attesta/keyset/v1';
const ARTIFACT_PT = 'application/vnd.trackai.test-artifact+json';

/** Fixed SPKI header of an uncompressed P-256 public key (RFC 5480). */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

export const TENANT_A = '0a0a0a0a-0000-4000-8000-00000000000a';
export const TENANT_B = '0b0b0b0b-0000-4000-8000-00000000000b';

interface TestKey { name: string; sk: Uint8Array; spki: Buffer; keyid: string; b64: string }

function testKey(name: string): TestKey {
  const sk = new Uint8Array(createHash('sha256').update(`trackai-trust-vector-key:${name}`).digest());
  if (!p256.utils.isValidSecretKey(sk)) throw new Error(`seed for ${name} is not a valid scalar`);
  const spki = Buffer.concat([P256_SPKI_PREFIX, Buffer.from(p256.getPublicKey(sk, false))]);
  return { name, sk, spki, keyid: sha256Prefixed(spki), b64: spki.toString('base64') };
}

const K = Object.fromEntries(
  ['root1', 'root2', 'anchor1', 'lease1', 'fleet1', 'policy1', 'release1', 'keyset1',
    'stmtA1', 'stmtA2', 'stmtB1', 'attacker', 'attacker2', 'keyset2'].map((n) => [n, testKey(n)]),
) as Record<string, TestKey>;

function signBytes(key: TestKey, bytes: Buffer): Buffer {
  const digest = createHash('sha256').update(bytes).digest();
  return Buffer.from(p256.sign(new Uint8Array(digest), key.sk, { prehash: false, format: 'der' }));
}

interface Signed { env: DsseEnvelope; payload: Buffer; digest: string }

function envelopeOf(payloadType: string, payload: Buffer, signers: TestKey[]): Signed {
  const bytes = pae(payloadType, payload);
  return {
    env: {
      payload: payload.toString('base64'),
      payloadType,
      signatures: signers.map((k) => ({ keyid: k.keyid, sig: signBytes(k, bytes).toString('base64') })),
    },
    payload,
    digest: sha256Prefixed(payload),
  };
}

function signDoc(payloadType: string, body: unknown, signers: TestKey[]): Signed {
  return envelopeOf(payloadType, Buffer.from(canonicalize(body), 'utf8'), signers);
}

const NB = '2026-10-01T00:00:00.000Z';
const NA = '2027-10-01T00:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';

type Entry = Record<string, string>;
function entry(key: TestKey, purpose: string, extra: Entry = {}): Entry {
  return { keyid: key.keyid, purpose, spki_der_b64: key.b64, not_before: NB, not_after: NA, status: 'active', ...extra };
}

const ONLINE = (): Entry[] => [
  entry(K.anchor1, 'anchor'), entry(K.lease1, 'activation_lease'), entry(K.fleet1, 'fleet_config'),
  entry(K.policy1, 'policy_bundle'), entry(K.release1, 'release'), entry(K.keyset1, 'tenant_keyset'),
];

function rootBody(version: number, issued: string, expires: string, previous: string | null, rootKeys: Entry[], threshold = 1, online = ONLINE()) {
  return { _type: ROOT_TYPE, scope: 'platform', version, issued_at: issued, expires, previous, threshold, keys: [...rootKeys, ...online] };
}
function keysetBody(tenant: string, version: number, issued: string, expires: string, previous: string | null, keys: Entry[]) {
  return { _type: KEYSET_TYPE, scope: tenant, version, issued_at: issued, expires, previous, keys };
}

// ----- Documents ------------------------------------------------------------
const R1 = signDoc(ROOT_PT, rootBody(1, NB, NA, null, [entry(K.root1, 'root')]), [K.root1]);
const R2_BODY = rootBody(2, '2026-10-12T00:00:00.000Z', '2027-10-12T00:00:00.000Z', R1.digest, [entry(K.root2, 'root')]);
const R2 = signDoc(ROOT_PT, R2_BODY, [K.root1, K.root2]);
const R2_ONLY_NEW = signDoc(ROOT_PT, R2_BODY, [K.root2]);
const R2_ONLY_OLD = signDoc(ROOT_PT, R2_BODY, [K.root1]);
const R3_BODY = (rootKey: TestKey) => rootBody(3, '2026-10-14T00:00:00.000Z', '2027-10-14T00:00:00.000Z', R2.digest, [entry(rootKey, 'root')]);
const R3_RETIRED_ROOT = signDoc(ROOT_PT, R3_BODY(K.attacker), [K.root1, K.attacker]);
const R3_GOOD = signDoc(ROOT_PT, R3_BODY(K.root2), [K.root2]);

const A1 = (extra: Entry = {}) => entry(K.stmtA1, 'statement', extra);
const A2 = (extra: Entry = {}) => entry(K.stmtA2, 'statement', { not_before: '2026-10-15T00:00:00.000Z', ...extra });
const A1_RETIRED = { status: 'retired', revoked_at: '2026-10-15T00:00:00.000Z' };

const KSA1 = signDoc(KEYSET_PT, keysetBody(TENANT_A, 1, '2026-10-10T00:00:00.000Z', '2026-11-09T00:00:00.000Z', null, [A1()]), [K.keyset1]);
const KSA2_BODY = keysetBody(TENANT_A, 2, '2026-10-15T00:00:00.000Z', '2026-11-14T00:00:00.000Z', KSA1.digest, [A1(A1_RETIRED), A2()]);
const KSA2 = signDoc(KEYSET_PT, KSA2_BODY, [K.keyset1]);
const KSA2_CONFLICT = signDoc(KEYSET_PT, { ...KSA2_BODY, expires: '2026-11-13T00:00:00.000Z' }, [K.keyset1]);
const KSA2_BY_ATTACKER = signDoc(KEYSET_PT, KSA2_BODY, [K.attacker]);
const KSA2_BY_RELEASE = signDoc(KEYSET_PT, KSA2_BODY, [K.release1]);
const KSA2_NOT_CANONICAL = envelopeOf(KEYSET_PT, Buffer.from(JSON.stringify(KSA2_BODY, null, 1), 'utf8'), [K.keyset1]);
const KSA2_BAD_KEYID = signDoc(KEYSET_PT, keysetBody(TENANT_A, 2, '2026-10-15T00:00:00.000Z', '2026-11-14T00:00:00.000Z', KSA1.digest,
  [A1(A1_RETIRED), A2({ keyid: K.stmtA1.keyid })]), [K.keyset1]);
const KSA3_ISSUED = '2026-10-18T00:00:00.000Z';
const KSA3_COMPROMISED = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, KSA3_ISSUED, '2026-11-17T00:00:00.000Z', KSA2.digest,
  [A1(A1_RETIRED), A2({ status: 'revoked', revoked_at: KSA3_ISSUED, revocation_reason: 'compromised', compromised_since: '2026-10-17T00:00:00.000Z' })]), [K.keyset1]);
const KSA3_SUPERSEDED = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, KSA3_ISSUED, '2026-11-17T00:00:00.000Z', KSA2.digest,
  [A1(A1_RETIRED), A2({ status: 'revoked', revoked_at: KSA3_ISSUED, revocation_reason: 'superseded' })]), [K.keyset1]);
const KSA3_REGRESSION = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, KSA3_ISSUED, '2026-11-17T00:00:00.000Z', KSA2.digest,
  [A1(), A2()]), [K.keyset1]);
const KSA3_FUTURE = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, '2026-10-20T12:10:00.000Z', '2026-11-19T00:00:00.000Z', KSA2.digest,
  [A1(A1_RETIRED), A2()]), [K.keyset1]);
const KSA3_FORGED_NO_LINK = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, KSA3_ISSUED, '2026-11-17T00:00:00.000Z', 'sha256:' + '1'.repeat(64),
  [A1(A1_RETIRED), A2()]), [K.keyset1]);
const KSA1_TOO_LONG = signDoc(KEYSET_PT, keysetBody(TENANT_A, 1, '2026-10-10T00:00:00.000Z', '2026-11-11T00:00:00.001Z', null, [A1()]), [K.keyset1]);
const R2_FAKE = signDoc(ROOT_PT, rootBody(2, '2026-10-13T00:00:00.000Z', '2027-10-13T00:00:00.000Z', R1.digest, [entry(K.attacker, 'root')],
  1, [...ONLINE(), entry(K.attacker2, 'release')]), [K.root1, K.attacker]);
const R3_FAKE = signDoc(ROOT_PT, rootBody(3, '2026-10-14T00:00:00.000Z', '2027-10-14T00:00:00.000Z', R2_FAKE.digest, [entry(K.attacker, 'root')],
  1, [...ONLINE(), entry(K.attacker2, 'release')]), [K.attacker]);
const R2_RELEASE_COMPROMISED = signDoc(ROOT_PT, rootBody(2, KSA3_ISSUED, '2027-10-18T00:00:00.000Z', R1.digest, [entry(K.root1, 'root')], 1,
  ONLINE().map((e) => (e.purpose === 'release' ? { ...e, status: 'revoked', revoked_at: KSA3_ISSUED, revocation_reason: 'compromised', compromised_since: '2026-10-17T00:00:00.000Z' } : e))), [K.root1]);
const R2_KEYSET_COMPROMISED = signDoc(ROOT_PT, rootBody(2, KSA3_ISSUED, '2027-10-18T00:00:00.000Z', R1.digest, [entry(K.root1, 'root')], 1,
  [...ONLINE().map((e) => (e.purpose === 'tenant_keyset' ? { ...e, status: 'revoked', revoked_at: KSA3_ISSUED, revocation_reason: 'compromised', compromised_since: '2026-10-17T00:00:00.000Z' } : e)),
    entry(K.keyset2, 'tenant_keyset')]), [K.root1]);
const KSA3_BY_KEYSET2 = signDoc(KEYSET_PT, keysetBody(TENANT_A, 3, '2026-10-19T00:00:00.000Z', '2026-11-18T00:00:00.000Z', KSA2.digest,
  [A1(A1_RETIRED), A2()]), [K.keyset2]);
const R1_TOO_LONG = signDoc(ROOT_PT, rootBody(1, NB, '2027-10-02T00:00:00.001Z', null, [entry(K.root1, 'root')]), [K.root1]);
const R1_SHORT_ROOT_KEY = signDoc(ROOT_PT, rootBody(1, NB, NA, null, [entry(K.root1, 'root', { not_after: '2026-10-05T00:00:00.000Z' })]), [K.root1]);
const R2_AFTER_SHORT = signDoc(ROOT_PT, rootBody(2, '2026-10-06T00:00:00.000Z', '2027-10-06T00:00:00.000Z', R1_SHORT_ROOT_KEY.digest, [entry(K.root2, 'root')]), [K.root1, K.root2]);
const KSB1 = signDoc(KEYSET_PT, keysetBody(TENANT_B, 1, '2026-10-10T00:00:00.000Z', '2026-11-09T00:00:00.000Z', null,
  [entry(K.stmtB1, 'statement')]), [K.keyset1]);

// ----- Artifacts ------------------------------------------------------------
const STATEMENT = Buffer.from(canonicalize({ _type: 'https://in-toto.io/Statement/v1', note: 'synthetic trust vector statement' }), 'utf8');
const ARTIFACT = Buffer.from(canonicalize({ artifact: 'synthetic trust vector artifact', version: '1.2.3' }), 'utf8');
const stmtBy = (k: TestKey) => envelopeOf(IN_TOTO_PAYLOAD_TYPE, STATEMENT, [k]);
const artBy = (k: TestKey) => envelopeOf(ARTIFACT_PT, ARTIFACT, [k]);

// ----- Vectors --------------------------------------------------------------
interface State {
  pinned_root_keyids: string[]; pinned_root_threshold: number; root_documents: DsseEnvelope[];
  keyset_documents: Record<string, DsseEnvelope[]>; customer_pins?: Record<string, Entry[]>;
  last_trusted: Record<string, { version: number; digest: string }>; now: string; clock_skew_ms: number; production: boolean; allow_unpinned_root: boolean;
}
interface Vector {
  vector_version: number; name: string; description: string;
  input: { payload_type: string; payload_b64: string; envelope: DsseEnvelope; purpose: string; audience: string; signed_at: string;
    time_evidence?: { kind: string; time: string; binds: string; digest: string }; state: State };
  expected: { status: string; code: string; keyid?: string; trusted?: Record<string, { version: number; digest: string }> };
}

const baseState = (): State => ({
  pinned_root_keyids: [K.root1.keyid], pinned_root_threshold: 1, root_documents: [R1.env],
  keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env], [TENANT_B]: [KSB1.env] },
  last_trusted: {}, now: NOW, clock_skew_ms: 300_000, production: true, allow_unpinned_root: false,
});

const vectors: Vector[] = [];
function add(name: string, description: string, art: Signed, o: {
  purpose?: string; audience?: string; signedAt?: string; state?: Partial<State>; payload?: Buffer; payloadType?: string;
  timeEvidence?: Vector['input']['time_evidence'];
}, status: string, code: string, verifiedExtras?: { trusted?: Record<string, { version: number; digest: string }> }) {
  const purpose = o.purpose ?? 'statement';
  const v: Vector = {
    vector_version: VECTOR_VERSION, name, description,
    input: {
      payload_type: o.payloadType ?? art.env.payloadType,
      payload_b64: (o.payload ?? art.payload).toString('base64'),
      envelope: art.env, purpose,
      audience: o.audience ?? (purpose === 'statement' ? TENANT_A : 'platform'),
      signed_at: o.signedAt ?? '2026-10-16T00:00:00.000Z',
      ...(o.timeEvidence ? { time_evidence: o.timeEvidence } : {}),
      state: { ...baseState(), ...o.state },
    },
    expected: { status, code },
  };
  if (status === 'verified') {
    v.expected.keyid = art.env.signatures[0]?.keyid;
    if (verifiedExtras?.trusted) v.expected.trusted = verifiedExtras.trusted;
  }
  vectors.push(v);
}
const OK = 'ATTESTA_TRUST_VERIFIED';
const ev = (time: string, payload = STATEMENT) => ({ kind: 'rekor_integrated_time', time, binds: 'ledger_statement', digest: sha256Prefixed(payload) });
const evSig = (time: string, art: Signed) => ({ kind: 'tsa_gen_time', time, binds: 'signature', digest: sha256Prefixed(Buffer.from(art.env.signatures[0].sig, 'base64')) });
const ref = (d: Signed, version: number) => ({ version, digest: d.digest });
const T = (o: Record<string, [Signed, number]>) => Object.fromEntries(Object.entries(o).map(([k, [d, v]]) => [k, ref(d, v)]));

// Good paths
add('good-statement', 'Tenant A statement signed by its active key, key set v2 under root v1.', stmtBy(K.stmtA2), {}, 'verified', OK, { trusted: T({ platform: [R1, 1], [TENANT_A]: [KSA2, 2] }) });
add('good-release', 'Platform release artifact signed by the release key listed in the root.', artBy(K.release1), { purpose: 'release' }, 'verified', OK, { trusted: T({ platform: [R1, 1] }) });
add('good-activation-lease', 'Activation lease signed by the activation_lease key.', artBy(K.lease1), { purpose: 'activation_lease' }, 'verified', OK, { trusted: T({ platform: [R1, 1] }) });
add('good-fleet-config', 'Fleet configuration signed by the fleet_config key.', artBy(K.fleet1), { purpose: 'fleet_config' }, 'verified', OK, { trusted: T({ platform: [R1, 1] }) });
add('good-tenant-b', 'Tenant B statement signed by its own key.', stmtBy(K.stmtB1), { audience: TENANT_B }, 'verified', OK, { trusted: T({ platform: [R1, 1], [TENANT_B]: [KSB1, 1] }) });
// Rotation with overlap
add('rotation-old-key-before-retirement', 'Retired key A1, signature before its revoked_at: still verifies (rotation overlap).', stmtBy(K.stmtA1), { signedAt: '2026-10-12T00:00:00.000Z' }, 'verified', OK);
add('rotation-old-key-after-retirement', 'Retired key A1 used after its revoked_at.', stmtBy(K.stmtA1), {}, 'rejected', 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
add('key-before-not-before', 'Key A2 used before its not_before.', stmtBy(K.stmtA2), { signedAt: '2026-10-14T00:00:00.000Z' }, 'rejected', 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
add('signed-at-in-future', 'signedAt after now plus skew.', stmtBy(K.stmtA2), { signedAt: '2026-10-20T12:05:00.001Z' }, 'rejected', 'ATTESTA_TRUST_KEY_NOT_VALID_AT');
// Root rotation
add('root-rotation-chain', 'Pinned root1, holds root v1 and v2 (signed by root1 and root2): accepted.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R2.env, R1.env] } }, 'verified', OK, { trusted: T({ platform: [R2, 2] }) });
add('root-rotation-statement', 'Statement after root rotation: key set signed by the tenant_keyset key, still listed in root v2.', stmtBy(K.stmtA2), { state: { root_documents: [R1.env, R2.env] } }, 'verified', OK, { trusted: T({ platform: [R2, 2], [TENANT_A]: [KSA2, 2] }) });
add('root-new-pin-only', 'Fresh install pinned to root2, holds only root v2: accepted.', artBy(K.release1), { purpose: 'release', state: { pinned_root_keyids: [K.root2.keyid], root_documents: [R2.env] } }, 'verified', OK, { trusted: T({ platform: [R2, 2] }) });
add('root-old-pin-missing-link', 'Pinned root1 but only root v2 held: nothing chains from the pin.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R2.env] } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
add('root-retired-root-signs', 'Root v3 signed by the retired root1 and an unknown key, not by root v2\'s root2.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1.env, R2.env, R3_RETIRED_ROOT.env] } }, 'rejected', 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
add('root-rotation-missing-old-signature', 'Root v2 signed only by its own new key.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1.env, R2_ONLY_NEW.env] } }, 'rejected', 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
add('root-rotation-missing-new-signature', 'Root v2 signed only by the previous root key.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1.env, R2_ONLY_OLD.env] } }, 'rejected', 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
add('root-pinned-threshold-not-met', 'Pin threshold 2, start document signed by one pinned key.', artBy(K.release1), { purpose: 'release', state: { pinned_root_threshold: 2 } }, 'rejected', 'ATTESTA_TRUST_THRESHOLD_NOT_MET');
add('root-version-gap', 'Holds root v1 and v3 but not v2.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1.env, R3_GOOD.env] } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
add('root-none-held', 'No root document held.', artBy(K.release1), { purpose: 'release', state: { root_documents: [] } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
add('root-not-pinned-production', 'Production with no pinned root, even with allow_unpinned_root.', artBy(K.release1), { purpose: 'release', state: { pinned_root_keyids: [], allow_unpinned_root: true } }, 'unavailable', 'ATTESTA_TRUST_ROOT_NOT_PINNED');
add('root-unpinned-development', 'Outside production, allow_unpinned_root trusts the lowest held root.', artBy(K.release1), { purpose: 'release', state: { pinned_root_keyids: [], production: false, allow_unpinned_root: true } }, 'verified', OK, { trusted: T({ platform: [R1, 1] }) });
add('root-unpinned-development-not-allowed', 'Outside production without allow_unpinned_root.', artBy(K.release1), { purpose: 'release', state: { pinned_root_keyids: [], production: false } }, 'unavailable', 'ATTESTA_TRUST_ROOT_NOT_PINNED');
add('root-rollback', 'A root v2 was seen before; only v1 held now.', artBy(K.release1), { purpose: 'release', state: { last_trusted: { platform: ref(R2, 2) } } }, 'rejected', 'ATTESTA_TRUST_ROLLBACK');
add('root-expired', 'Root v1 past expires plus skew (release key still in its validity).', artBy(K.release1), { purpose: 'release', signedAt: '2027-09-30T00:00:00.000Z', state: { now: '2027-10-01T00:05:00.001Z' } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_EXPIRED');
// Key sets
add('keyset-missing', 'No key set held for the tenant: revocation status unknown.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_B]: [KSB1.env] } } }, 'unavailable', 'ATTESTA_TRUST_REVOCATION_UNKNOWN');
add('keyset-expiry-boundary-inside', 'Now exactly at key set expires plus skew: still valid.', stmtBy(K.stmtA2), { state: { now: '2026-11-14T00:05:00.000Z' } }, 'verified', OK);
add('keyset-expiry-boundary-outside', 'Now one millisecond past key set expires plus skew.', stmtBy(K.stmtA2), { state: { now: '2026-11-14T00:05:00.001Z' } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_EXPIRED');
add('keyset-rollback', 'Key set v3 was seen before; only v1 and v2 held now.', stmtBy(K.stmtA2), { state: { last_trusted: { [TENANT_A]: ref(KSA3_SUPERSEDED, 3) } } }, 'rejected', 'ATTESTA_TRUST_ROLLBACK');
add('keyset-from-future', 'Newest key set issued after now plus skew.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_FUTURE.env] } } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_FROM_FUTURE');
add('keyset-conflict', 'Two different key sets claim version 2.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA2_CONFLICT.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
add('keyset-regression', 'Key set v3 un-retires A1.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_REGRESSION.env] } } }, 'rejected', 'ATTESTA_TRUST_KEYSET_REGRESSION');
add('keyset-signed-by-unknown-key', 'Key set signed by a key the root does not list.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2_BY_ATTACKER.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID');
add('keyset-signed-by-wrong-purpose', 'Key set signed by the release key.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2_BY_RELEASE.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID');
add('keyset-not-canonical', 'Key set payload is not its RFC 8785 form.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2_NOT_CANONICAL.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
add('keyset-keyid-not-spki-digest', 'A key entry names a keyid that is not the SHA-256 of its SPKI.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2_BAD_KEYID.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
// Revocation
add('revoked-superseded-before', 'A2 revoked superseded; signature before revoked_at.', stmtBy(K.stmtA2), { signedAt: '2026-10-17T00:00:00.000Z', state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_SUPERSEDED.env] } } }, 'verified', OK);
add('revoked-superseded-after', 'A2 revoked superseded; signature after revoked_at.', stmtBy(K.stmtA2), { signedAt: '2026-10-19T00:00:00.000Z', state: { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_SUPERSEDED.env] } } }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
const COMPROMISED = { keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_COMPROMISED.env] } };
add('compromised-no-time-evidence', 'A2 compromised; self-claimed signedAt before compromised_since is not enough.', stmtBy(K.stmtA2), { state: COMPROMISED }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
add('compromised-time-evidence-before', 'A2 compromised; anchored time evidence for this payload before compromised_since.', stmtBy(K.stmtA2), { state: COMPROMISED, timeEvidence: ev('2026-10-16T12:00:00.000Z') }, 'verified', OK, { trusted: T({ platform: [R1, 1], [TENANT_A]: [KSA3_COMPROMISED, 3] }) });
add('compromised-time-evidence-after', 'A2 compromised; time evidence after compromised_since.', stmtBy(K.stmtA2), { state: COMPROMISED, timeEvidence: ev('2026-10-17T06:00:00.000Z') }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
add('compromised-time-evidence-other-payload', 'A2 compromised; time evidence names another payload.', stmtBy(K.stmtA2), { state: COMPROMISED, timeEvidence: ev('2026-10-16T12:00:00.000Z', ARTIFACT) }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
// Key, purpose, audience
add('key-unknown-statement', 'Statement signed by a key no key set lists.', stmtBy(K.attacker), {}, 'rejected', 'ATTESTA_TRUST_KEY_UNKNOWN');
add('key-unknown-release', 'Release signed by a key the root does not list.', artBy(K.attacker), { purpose: 'release' }, 'rejected', 'ATTESTA_TRUST_KEY_UNKNOWN');
add('purpose-release-as-lease', 'Release key signature presented as an activation lease.', artBy(K.release1), { purpose: 'activation_lease' }, 'rejected', 'ATTESTA_TRUST_PURPOSE_MISMATCH');
add('purpose-keyset-key-as-statement', 'The tenant_keyset key signs a statement.', stmtBy(K.keyset1), {}, 'rejected', 'ATTESTA_TRUST_PURPOSE_MISMATCH');
add('purpose-statement-key-as-release', 'Tenant A statement key signs a release.', artBy(K.stmtA2), { purpose: 'release' }, 'rejected', 'ATTESTA_TRUST_PURPOSE_MISMATCH');
add('audience-tenant-a-key-for-b', 'Tenant A key signs a statement presented for tenant B.', stmtBy(K.stmtA2), { audience: TENANT_B }, 'rejected', 'ATTESTA_TRUST_AUDIENCE_MISMATCH');
add('signature-invalid', 'Listed key, but the signature is over other bytes.', { ...stmtBy(K.stmtA2), env: { ...stmtBy(K.stmtA2).env, signatures: [{ keyid: K.stmtA2.keyid, sig: signBytes(K.stmtA2, pae(IN_TOTO_PAYLOAD_TYPE, ARTIFACT)).toString('base64') }] } }, {}, 'rejected', 'ATTESTA_TRUST_SIGNATURE_INVALID');
// Rollback and fork protection anchored at the last trusted document (review finding, A1/A2/A5)
add('keyset-first-use-needs-history', 'No last trusted key set: a lone v3 (hiding A2\'s history) is not enough; the chain must start at v1.', stmtBy(K.stmtA2), { state: { keyset_documents: { [TENANT_A]: [KSA3_REGRESSION.env] } } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
add('keyset-forged-after-last-trusted', 'Last trusted A v2; a v3 that does not link to it (stolen tenant_keyset key).', stmtBy(K.stmtA2), { state: { last_trusted: { [TENANT_A]: ref(KSA2, 2) }, keyset_documents: { [TENANT_A]: [KSA2.env, KSA3_FORGED_NO_LINK.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
add('keyset-forged-without-last-trusted-doc', 'Last trusted A v2 not held; only a v3 is offered.', stmtBy(K.stmtA2), { state: { last_trusted: { [TENANT_A]: ref(KSA2, 2) }, keyset_documents: { [TENANT_A]: [KSA3_FORGED_NO_LINK.env] } } }, 'unavailable', 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE');
add('keyset-same-version-fork', 'Last trusted A v2; a different v2 is offered.', stmtBy(K.stmtA2), { state: { last_trusted: { [TENANT_A]: ref(KSA2, 2) }, keyset_documents: { [TENANT_A]: [KSA2_CONFLICT.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
add('keyset-anchored-at-last-trusted', 'Last trusted A v2 held with a linked v3: verified without v1.', stmtBy(K.stmtA2), { signedAt: '2026-10-17T00:00:00.000Z', state: { last_trusted: { [TENANT_A]: ref(KSA2, 2) }, keyset_documents: { [TENANT_A]: [KSA2.env, KSA3_SUPERSEDED.env] } } }, 'verified', OK, { trusted: T({ platform: [R1, 1], [TENANT_A]: [KSA3_SUPERSEDED, 3] }) });
add('keyset-lifetime-too-long', 'Key set expires more than 31 days after issued_at.', stmtBy(K.stmtA1), { signedAt: '2026-10-12T00:00:00.000Z', state: { keyset_documents: { [TENANT_A]: [KSA1_TOO_LONG.env] } } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
add('root-fork-by-rotated-out-key', 'Last trusted root v2; the retired root1 key forges a v2\' and v3\' with an attacker release key.', artBy(K.attacker2), { purpose: 'release', state: { last_trusted: { platform: ref(R2, 2) }, root_documents: [R1.env, R2_FAKE.env, R3_FAKE.env] } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_CONFLICT');
add('root-fork-first-use', 'Without a last trusted root the same fork chains from the pin (documented first-use limit; evidence packs and enrollment pin the current root).', artBy(K.attacker2), { purpose: 'release', state: { root_documents: [R1.env, R2_FAKE.env, R3_FAKE.env] } }, 'verified', OK, { trusted: T({ platform: [R3_FAKE, 3] }) });
add('root-anchored-at-last-trusted', 'Last trusted root v2 held alone, pinned root1: the chain starts at v2.', artBy(K.release1), { purpose: 'release', state: { last_trusted: { platform: ref(R2, 2) }, root_documents: [R2.env] } }, 'verified', OK, { trusted: T({ platform: [R2, 2] }) });
const RC = { purpose: 'release', state: { root_documents: [R1.env, R2_RELEASE_COMPROMISED.env] } };
add('compromised-release-signature-evidence', 'Release key compromised; time evidence over this very signature before compromised_since.', artBy(K.release1), { ...RC, timeEvidence: evSig('2026-10-16T12:00:00.000Z', artBy(K.release1)) }, 'verified', OK, { trusted: T({ platform: [R2_RELEASE_COMPROMISED, 2] }) });
add('compromised-release-payload-timestamped', 'Release key compromised; a timestamp over the payload alone (anyone can get one) is not evidence for a release.', artBy(K.release1), { ...RC, timeEvidence: ev('2026-10-16T12:00:00.000Z', ARTIFACT) }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
add('compromised-release-other-signature-evidence', 'Release key compromised; evidence names a different signature.', artBy(K.release1), { ...RC, timeEvidence: evSig('2026-10-16T12:00:00.000Z', artBy(K.lease1)) }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
// Customer pins
add('pin-overrides-without-trackai', 'Customer pins A2: no root, no key set needed.', stmtBy(K.stmtA2), { state: { root_documents: [], keyset_documents: {}, pinned_root_keyids: [], customer_pins: { [TENANT_A]: [A2()] } } }, 'verified', OK, { trusted: {} });
add('pin-excludes-listed-key', 'Customer pins only A1; A2 is in TrackAI\'s key set but the pin overrides it.', stmtBy(K.stmtA2), { state: { customer_pins: { [TENANT_A]: [A1()] } } }, 'rejected', 'ATTESTA_TRUST_KEY_UNKNOWN');
add('pin-revoked-compromised', 'Customer pin marks A2 compromised; no time evidence.', stmtBy(K.stmtA2), { state: { customer_pins: { [TENANT_A]: [A2({ status: 'revoked', revoked_at: KSA3_ISSUED, revocation_reason: 'compromised', compromised_since: '2026-10-15T12:00:00.000Z' })] } } }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
// Input
add('input-payload-not-envelope', 'Payload differs from the envelope payload.', stmtBy(K.stmtA2), { payload: ARTIFACT }, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');
add('input-payload-type-mismatch', 'payloadType differs from the envelope.', stmtBy(K.stmtA2), { payloadType: ARTIFACT_PT }, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');
add('input-two-signatures', 'Two signatures on the artifact.', envelopeOf(IN_TOTO_PAYLOAD_TYPE, STATEMENT, [K.stmtA2, K.stmtA1]), {}, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');
add('input-statement-audience-platform', 'Purpose statement with audience platform.', stmtBy(K.stmtA2), { audience: 'platform' }, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');
add('input-release-audience-tenant', 'Purpose release with a tenant audience.', artBy(K.release1), { purpose: 'release', audience: TENANT_A }, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');
add('input-purpose-root', 'Purpose root is for documents only.', artBy(K.root1), { purpose: 'root' }, 'rejected', 'ATTESTA_TRUST_INPUT_INVALID');

// Review round 2: recovery after a tenant_keyset compromise, and coverage
const KC = { root_documents: [R1.env, R2_KEYSET_COMPROMISED.env] };
add('keyset-recovery-fresh', 'tenant_keyset key compromised; v3 signed by the new keyset key: history stays valid through previous links.', stmtBy(K.stmtA2), { state: { ...KC, keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env, KSA3_BY_KEYSET2.env] } } }, 'verified', OK, { trusted: T({ platform: [R2_KEYSET_COMPROMISED, 2], [TENANT_A]: [KSA3_BY_KEYSET2, 3] }) });
add('keyset-recovery-anchored', 'Same, for a verifier anchored at key set v2.', stmtBy(K.stmtA2), { state: { ...KC, last_trusted: { [TENANT_A]: ref(KSA2, 2) }, keyset_documents: { [TENANT_A]: [KSA2.env, KSA3_BY_KEYSET2.env] } } }, 'verified', OK);
add('keyset-newest-by-compromised-keyset-key', 'tenant_keyset key compromised and no newer key set yet: the newest is not vouched for.', stmtBy(K.stmtA2), { state: { ...KC, keyset_documents: { [TENANT_A]: [KSA1.env, KSA2.env] } } }, 'rejected', 'ATTESTA_TRUST_KEY_REVOKED');
add('compromised-statement-signature-evidence', 'Statement key compromised; time evidence over this very signature before compromised_since.', stmtBy(K.stmtA2), { state: COMPROMISED, timeEvidence: evSig('2026-10-16T12:00:00.000Z', stmtBy(K.stmtA2)) }, 'verified', OK);
add('root-lifetime-too-long', 'Root document expires more than 366 days after issued_at.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1_TOO_LONG.env] } }, 'rejected', 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
add('root-signer-outside-validity', 'Root v2 signed by root1 after root1\'s not_after.', artBy(K.release1), { purpose: 'release', state: { root_documents: [R1_SHORT_ROOT_KEY.env, R2_AFTER_SHORT.env] } }, 'rejected', 'ATTESTA_TRUST_THRESHOLD_NOT_MET');

export function buildVectorFiles(): Map<string, string> {
  const files = new Map<string, string>();
  vectors.forEach((v, i) => {
    files.set(`${String(i + 1).padStart(2, '0')}-${v.name}.json`, JSON.stringify(v, null, 2) + '\n');
  });
  const keys = Object.values(K).map((k) => ({ name: k.name, keyid: k.keyid, spki_der_b64: k.b64 }));
  files.set('keys.json', JSON.stringify({ vector_version: VECTOR_VERSION, note: 'Synthetic test keys derived from public seeds; they protect nothing.', keys }, null, 2) + '\n');
  return files;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const files = buildVectorFiles();
  mkdirSync(OUT_DIR, { recursive: true });
  const existing = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
  let differs = existing.some((f) => !files.has(f));
  for (const [name, text] of files) {
    const path = join(OUT_DIR, name);
    let current: string | null = null;
    try { current = readFileSync(path, 'utf8'); } catch { current = null; }
    if (current !== text) {
      differs = true;
      if (!check) writeFileSync(path, text);
    }
  }
  if (check && differs) {
    console.error('trust vectors differ from the generator output');
    process.exit(1);
  }
  console.log(`${files.size} trust vector files ${check ? 'checked' : 'written'}`);
}
