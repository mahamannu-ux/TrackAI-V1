/**
 * Trust inventory (Task15l2): registration with proof of possession, tenant key
 * status, root import, key-set publishing. The memory store stands in for
 * PostgreSQL (the 0019 guards are proven live in t15l2-trust-live-verify.ts); the
 * signers, documents and verifier are the real ones.
 *
 * Ported first from SushiCorp A1b @ 0bd67a5 (catalog SG-1):
 * tests/integration/signing/test_it_a1b.py IT-A1b-03 (two tenants, no cross-use) and
 * the MODULE_A1b_HANDOFF.md "Rotation" procedure (keep old public material forever).
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { canonicalize } from './canonical';
import type { DsseEnvelope } from './dsse';
import { SigningRejected, type SigningAdapter } from './signer-contract';
import { LocalDevSigner } from './signer-local-dev';
import { verifyTrusted, type TrustDocumentBody } from './trust-contract';
import { keyidOf, parseTrustDocument, signTrustDocument } from './trust-documents';
import {
  KEYSET_LIFETIME_MS,
  TrustInventoryError,
  applyTenantKeyCommand,
  exportRootDraft,
  importRoot,
  memoryTrustStore,
  planPublish,
  planRegistration,
  planRootImport,
  planTenantKeyCommand,
  proveRegistration,
  publishKeyset,
  registerKey,
  registrationChallenge,
  resolvePlatformSigner,
  verifyRegistrationProof,
  type InventoryContext,
  type TrustAdapters,
} from './trust-inventory';
import { inventorySignerResolver, publishedKeysFor } from './trust-resolver';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Key { pem: string; priv: KeyObject; spki: Buffer; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), priv: privateKey, spki, keyid: keyidOf(spki) };
}

/** Counts signatures per credential (to prove "refused before signing"). */
function counting(adapter: SigningAdapter): SigningAdapter & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    calls,
    capabilities: () => adapter.capabilities(),
    publicKey: (c) => adapter.publicKey(c),
    listCredentials: (t) => adapter.listCredentials(t),
    health: () => adapter.health(),
    async sign(p, c, o) {
      calls.set(c, (calls.get(c) ?? 0) + 1);
      return adapter.sign(p, c, o);
    },
  };
}

function world() {
  const k = { root: newKey(), root2: newKey(), anchor: newKey(), keyset: newKey(), keyset2: newKey(), a1: newKey(), a2: newKey(), b1: newKey() };
  const dev = new LocalDevSigner({ env: {}, credentials: [
    { credentialId: 'dev:anchor', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.anchor.pem },
    { credentialId: 'dev:keyset', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.keyset.pem },
    { credentialId: 'dev:keyset2', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.keyset2.pem },
    { credentialId: 'dev:a1', tenantId: A, privateKeyPem: k.a1.pem },
    { credentialId: 'dev:a2', tenantId: A, privateKeyPem: k.a2.pem },
    { credentialId: 'dev:b1', tenantId: B, privateKeyPem: k.b1.pem },
    // Tenant B configured with tenant A's key (a copied public key or shared KMS key).
    { credentialId: 'dev:a1-for-b', tenantId: B, privateKeyPem: k.a1.pem },
    // Tenant A's credential name used under the platform tenant.
    { credentialId: 'dev:a1-for-platform', tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: k.a1.pem },
  ] });
  const adapter = counting(dev);
  const adapters: TrustAdapters = { 'local-dev': adapter };
  const store = memoryTrustStore();
  let now = T0;
  const ctx: InventoryContext = {
    store, adapters, config: { pinnedRootKeyids: [k.root.keyid], production: false },
    actor: 'it-operator', requestId: 'req-1', now: () => new Date(now),
  };
  const advance = (msDelta: number) => { now += msDelta; };
  const offlineSign = (body: TrustDocumentBody, keys: Key[] = [k.root]) =>
    signTrustDocument(body, keys.map((key) => ({ keyid: key.keyid, sign: (b: Buffer) => cryptoSign('sha256', b, { key: key.priv, dsaEncoding: 'der' }) })));
  const reg = (tenantId: string | null, credentialRef: string, purpose: 'statement' | 'anchor' | 'tenant_keyset' = 'statement') =>
    registerKey(ctx, { tenantId, purpose, adapterName: 'local-dev', credentialRef });
  /** Root v1 with the anchor and keyset keys, imported. */
  async function bootstrap(): Promise<DsseEnvelope> {
    await reg(null, 'dev:anchor', 'anchor');
    await reg(null, 'dev:keyset', 'tenant_keyset');
    const draft = await exportRootDraft(ctx, { rootSpkis: [k.root.spki], add: [k.anchor.keyid, k.keyset.keyid] });
    const env = await offlineSign(draft.body);
    await importRoot(ctx, env, 1);
    return env;
  }
  async function activate(tenantId: string, keyid: string, replace = false) {
    const plan = await planTenantKeyCommand(ctx, 'activate', { tenantId, keyid, replace });
    return applyTenantKeyCommand(ctx, 'activate', { tenantId, keyid, replace }, plan.expect);
  }
  return { k, ctx, store, adapter, adapters, advance, offlineSign, reg, bootstrap, activate, now: () => new Date(now) };
}

const refusedWith = (code?: string, re?: RegExp) => (err: unknown) =>
  err instanceof TrustInventoryError && (code === undefined || err.code === code) && (re === undefined || re.test(err.message));

// ---------------------------------------------------------------------------
// Ported from SushiCorp IT-A1b-03 and the A1b rotation procedure
// ---------------------------------------------------------------------------

test('ported IT-A1b-03: two tenants keep their signers apart (no cross-use)', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  await w.reg(B, 'dev:b1');
  await w.activate(A, w.k.a1.keyid);
  await w.activate(B, w.k.b1.keyid);
  // B cannot touch A's key: it is simply not found in B's inventory.
  for (const command of ['activate', 'retire', 'revoke'] as const) {
    await assert.rejects(planTenantKeyCommand(w.ctx, command, { tenantId: B, keyid: w.k.a1.keyid, reason: 'superseded' }),
      refusedWith('ATTESTA_TRUST_INPUT_INVALID', /no key .* is registered for tenant bbbbbbbb/));
  }
  // B cannot register A's public key (same keyid), nor a credential bound to A.
  await assert.rejects(w.reg(B, 'dev:a1-for-b'), refusedWith('ATTESTA_TRUST_INPUT_INVALID', /already registered/));
  const fresh = world();
  await assert.rejects(fresh.reg(B, 'dev:a1'), SigningRejected); // proof of possession signs as B: the credential is A's
  // Each tenant resolves only its own key.
  const resolver = inventorySignerResolver(w.store, w.adapters, { now: w.now });
  const ra = await resolver.resolve(A);
  const rb = await resolver.resolve(B);
  assert.equal(ra?.credentialId, 'dev:a1');
  assert.equal(rb?.credentialId, 'dev:b1');
  assert.equal(keyidOf(await ra!.adapter.publicKey('dev:a1')), w.k.a1.keyid);
  // A's resolved adapter refuses B's credential name.
  await assert.rejects(ra!.adapter.sign(Buffer.from('x'), 'dev:b1', { requestId: 'r', tenantId: B }), SigningRejected);
  // A's key set never lists B's keys, and the reverse.
  await publishKeyset(w.ctx, A);
  await publishKeyset(w.ctx, B);
  const setA = parseTrustDocument((await w.store.documents(A))[0].envelope);
  const setB = parseTrustDocument((await w.store.documents(B))[0].envelope);
  assert.deepEqual([...setA.keys.keys()], [w.k.a1.keyid]);
  assert.deepEqual([...setB.keys.keys()], [w.k.b1.keyid]);
  assert.deepEqual(Object.keys((await publishedKeysFor(w.store, B)).keys), [w.k.b1.keyid]);
  // Audit rows stay in their tenant.
  assert.ok(w.store.state.audits.every((a) => a.tenantId === A || a.tenantId === B));
  assert.ok(w.store.state.audits.filter((a) => a.tenantId === B).every((a) => !JSON.stringify(a).includes(w.k.a1.keyid)));
});

test('ported A1b rotation: register, activate with --replace, publish; the old public key is kept forever', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  await w.activate(A, w.k.a1.keyid);
  await publishKeyset(w.ctx, A);
  w.advance(HOUR);
  await w.reg(A, 'dev:a2');
  const plan = await planTenantKeyCommand(w.ctx, 'activate', { tenantId: A, keyid: w.k.a2.keyid, replace: true });
  assert.equal(plan.expect, 2);
  assert.match(plan.lines.join('\n'), /retire statement key .* active -> retired/);
  await applyTenantKeyCommand(w.ctx, 'activate', { tenantId: A, keyid: w.k.a2.keyid, replace: true }, 2);
  await publishKeyset(w.ctx, A);
  const v2 = parseTrustDocument((await w.store.documents(A))[1].envelope);
  assert.equal(v2.keys.get(w.k.a1.keyid)?.entry.status, 'retired');
  assert.equal(v2.keys.get(w.k.a1.keyid)?.entry.revoked_at, new Date(T0 + HOUR).toISOString());
  assert.equal(v2.keys.get(w.k.a2.keyid)?.entry.status, 'active');
  const resolved = await inventorySignerResolver(w.store, w.adapters, { now: w.now }).resolve(A);
  assert.equal(resolved?.credentialId, 'dev:a2'); // the retired key is never resolved again
  const published = await publishedKeysFor(w.store, A);
  assert.deepEqual(Object.keys(published.keys).sort(), [w.k.a1.keyid, w.k.a2.keyid].sort());
  assert.equal(published.keysetDocuments.length, 2);
  // Events: register ×2, activate ×2, retire ×1, publish ×2.
  const actions = w.store.state.events.filter((e) => e.tenantId === A).map((e) => e.action).sort();
  assert.deepEqual(actions, ['activate', 'activate', 'publish', 'publish', 'register', 'register', 'retire']);
});

// ---------------------------------------------------------------------------
// Proof of possession
// ---------------------------------------------------------------------------

test('proof of possession: wrong key, replayed challenge, other scope or purpose are refused', async () => {
  const w = world();
  const dev = w.adapters['local-dev'];
  const challenge = registrationChallenge(A, 'statement', w.k.a1.keyid, w.now());
  const proof = await proveRegistration(dev, 'dev:a1', A, challenge, 'r1');
  verifyRegistrationProof(proof, challenge, w.k.a1.spki); // the honest proof passes
  // Wrong key: another key signed the same challenge.
  const other = await proveRegistration(dev, 'dev:a2', A, challenge, 'r2');
  assert.throws(() => verifyRegistrationProof(other, challenge, w.k.a1.spki), refusedWith(undefined, /signature keyid|does not verify/));
  const forged = { ...proof, signatures: [{ keyid: w.k.a1.keyid, sig: other.signatures[0].sig }] };
  assert.throws(() => verifyRegistrationProof(forged, challenge, w.k.a1.spki), refusedWith(undefined, /does not verify/));
  // Replay: an old proof against a new challenge (fresh nonce).
  const next = registrationChallenge(A, 'statement', w.k.a1.keyid, w.now());
  assert.notEqual(next.nonce, challenge.nonce);
  assert.throws(() => verifyRegistrationProof(proof, next, w.k.a1.spki), refusedWith(undefined, /not the one issued/));
  // Another scope or purpose: the bytes differ.
  for (const c of [{ ...challenge, scope: B }, { ...challenge, scope: 'platform' }, { ...challenge, purpose: 'anchor' as const }]) {
    assert.throws(() => verifyRegistrationProof(proof, c, w.k.a1.spki), refusedWith(undefined, /not the one issued/));
  }
  // Another key's SPKI with this proof.
  assert.throws(() => verifyRegistrationProof(proof, challenge, w.k.a2.spki), refusedWith(undefined, /names another key/));
  assert.throws(() => verifyRegistrationProof({ ...proof, payloadType: 'x' }, challenge, w.k.a1.spki), refusedWith(undefined, /payload type/));
  assert.equal(JSON.parse(Buffer.from(proof.payload, 'base64').toString()).nonce.length, 44);
  assert.equal(canonicalize(challenge), Buffer.from(proof.payload, 'base64').toString());
});

test('registration: an adapter that signs with another key than it publishes is refused; nothing stored', async () => {
  const w = world();
  const dev = w.adapters['local-dev'];
  const lying: SigningAdapter = {
    ...dev,
    capabilities: () => dev.capabilities(),
    publicKey: () => dev.publicKey('dev:a1'),
    sign: (p, _c, o) => dev.sign(p, 'dev:a2', o),
    listCredentials: (t) => dev.listCredentials(t),
    health: () => dev.health(),
  };
  w.ctx.adapters = { 'local-dev': lying };
  await assert.rejects(w.reg(A, 'dev:a1'), SigningRejected);
  assert.equal(w.store.state.keys.length, 0);
  assert.equal(w.store.state.events.length, 0);
});

test('registration: keyid reuse across tenants and purposes is refused without naming the owner', async () => {
  const w = world();
  const key = await w.reg(A, 'dev:a1');
  assert.equal(key.status, 'registered');
  assert.match(key.popDigest, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(w.reg(B, 'dev:a1-for-b'), (e: unknown) => refusedWith('ATTESTA_TRUST_INPUT_INVALID', /already registered/)(e) &&
    !(e as Error).message.includes(A));
  await assert.rejects(w.reg(null, 'dev:a1-for-platform', 'anchor'), refusedWith('ATTESTA_TRUST_INPUT_INVALID', /already registered/));
  await assert.rejects(w.reg(A, 'dev:a1'), refusedWith(undefined, /already registered/));
  // Input checks.
  await assert.rejects(registerKey(w.ctx, { tenantId: A, purpose: 'anchor', adapterName: 'local-dev', credentialRef: 'dev:a2' }), refusedWith(undefined, /purpose statement only/));
  await assert.rejects(registerKey(w.ctx, { tenantId: null, purpose: 'root', adapterName: 'local-dev', credentialRef: 'dev:anchor' }), refusedWith(undefined, /root keys live only/));
  await assert.rejects(registerKey(w.ctx, { tenantId: 'A', purpose: 'statement', adapterName: 'local-dev', credentialRef: 'dev:a2' }), refusedWith(undefined, /UUID/));
  await assert.rejects(registerKey(w.ctx, { tenantId: A, purpose: 'statement', adapterName: 'kms-aws', credentialRef: 'dev:a2' }), /not configured/);
  await assert.rejects(registerKey(w.ctx, { tenantId: A, purpose: 'statement', adapterName: 'local-dev', credentialRef: 'dev:a2', validDays: 0 }), refusedWith(undefined, /valid-days/));
  // The dry run reads the public key only (no signature).
  const plan = await planRegistration(w.ctx, { tenantId: A, purpose: 'statement', adapterName: 'local-dev', credentialRef: 'dev:a2' });
  assert.equal(plan.expect, 1);
  assert.equal(w.adapter.calls.get('dev:a2') ?? 0, 0);
  assert.ok(!plan.lines.join('\n').includes('dev:a2'), 'the credential reference is never printed');
  assert.equal(w.store.state.audits.filter((a) => a.action === 'attesta.keys.register').length, 1);
});

// ---------------------------------------------------------------------------
// Tenant key status
// ---------------------------------------------------------------------------

test('activation with and without --replace; expired, unknown and non-registered keys are refused', async () => {
  const w = world();
  await w.reg(A, 'dev:a1');
  await w.reg(A, 'dev:a2');
  const first = await planTenantKeyCommand(w.ctx, 'activate', { tenantId: A, keyid: w.k.a1.keyid });
  assert.equal(first.expect, 1);
  await assert.rejects(applyTenantKeyCommand(w.ctx, 'activate', { tenantId: A, keyid: w.k.a1.keyid }, 2), refusedWith(undefined, /--expect=2/));
  assert.equal(w.store.state.keys.find((k) => k.keyid === w.k.a1.keyid)?.status, 'registered', 'an --expect mismatch changes nothing');
  await w.activate(A, w.k.a1.keyid);
  await assert.rejects(w.activate(A, w.k.a2.keyid), refusedWith(undefined, /already has active key .* --replace/));
  await assert.rejects(w.activate(A, w.k.a1.keyid), refusedWith(undefined, /is active; only a registered key/));
  await assert.rejects(w.activate(A, w.k.b1.keyid), refusedWith(undefined, /no key/));
  w.advance(400 * DAY);
  await assert.rejects(w.activate(A, w.k.a2.keyid, true), refusedWith(undefined, /expired/));
  // The resolver ignores the expired active key.
  assert.equal(await inventorySignerResolver(w.store, w.adapters, { now: w.now }).resolve(A), null);
});

test('retire and revoke: forward only, compromised_since bounded, superseded may become compromised', async () => {
  const w = world();
  await w.reg(A, 'dev:a1');
  await w.activate(A, w.k.a1.keyid);
  w.advance(HOUR);
  const retire = await planTenantKeyCommand(w.ctx, 'retire', { tenantId: A, keyid: w.k.a1.keyid });
  assert.match(retire.lines.join('\n'), /no active statement key afterwards/);
  await applyTenantKeyCommand(w.ctx, 'retire', { tenantId: A, keyid: w.k.a1.keyid }, 1);
  const retiredAt = new Date(T0 + HOUR).toISOString();
  await assert.rejects(applyTenantKeyCommand(w.ctx, 'retire', { tenantId: A, keyid: w.k.a1.keyid }, 1), refusedWith(undefined, /only the active key/));
  w.advance(HOUR);
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised' }), refusedWith(undefined, /compromised-since/));
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised',
    compromisedSince: new Date(T0 + 2 * HOUR).toISOString() }), refusedWith(undefined, /must not be after the key stopped signing/));
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'superseded',
    compromisedSince: retiredAt }), refusedWith(undefined, /compromised only/));
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'expired' as never }), refusedWith(undefined, /--reason/));
  await applyTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'superseded' }, 1);
  let row = w.store.state.keys.find((k) => k.keyid === w.k.a1.keyid)!;
  assert.equal(row.revokedAt, retiredAt, 'a retired key keeps the instant it stopped signing');
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'superseded' }), refusedWith(undefined, /already revoked/));
  const since = new Date(T0 + 30 * 60_000).toISOString();
  await applyTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised', compromisedSince: since }, 1);
  row = w.store.state.keys.find((k) => k.keyid === w.k.a1.keyid)!;
  assert.deepEqual([row.status, row.revocationReason, row.compromisedSince], ['revoked', 'compromised', since]);
  // compromised_since only moves earlier.
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised', compromisedSince: retiredAt }),
    refusedWith(undefined, /already revoked/));
  const earlier = new Date(T0 + 10 * 60_000).toISOString();
  await applyTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised', compromisedSince: earlier }, 1);
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'superseded' }), refusedWith(undefined, /already revoked/));
  await assert.rejects(planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised',
    compromisedSince: new Date(T0 + 400 * DAY).toISOString() }), refusedWith(undefined, /future/));
  // Every applied change wrote its event and one audit row.
  assert.deepEqual(w.store.state.events.filter((e) => e.keyId === row.id).map((e) => e.action),
    ['register', 'activate', 'retire', 'revoke', 'revoke', 'revoke']);
  assert.equal(w.store.state.audits.filter((a) => a.action === 'attesta.keys.revoke').length, 3);
});

// ---------------------------------------------------------------------------
// Platform keys and root documents
// ---------------------------------------------------------------------------

test('platform keys become active only by importing a signed root that lists them', async () => {
  const w = world();
  await w.reg(null, 'dev:anchor', 'anchor');
  await w.reg(null, 'dev:keyset', 'tenant_keyset');
  // No CLI path: tenant commands never see platform keys, and nothing resolves before a root.
  await assert.rejects(w.activate(A, w.k.anchor.keyid), refusedWith(undefined, /no key/));
  await assert.rejects(resolvePlatformSigner(w.store, w.adapters, 'anchor', w.ctx.config, w.now()), /no root document/);
  const bare = await exportRootDraft(w.ctx, { rootSpkis: [w.k.root.spki] });
  assert.equal(bare.body.keys.length, 1, 'nothing is added unless named');
  assert.match(bare.lines.join('\n'), /2 registered platform key\(s\) not added/);
  await assert.rejects(exportRootDraft(w.ctx, { rootSpkis: [w.k.root.spki], add: [w.k.a1.keyid] }), refusedWith(undefined, /--add .*not a registered platform key/));
  const draft = await exportRootDraft(w.ctx, { rootSpkis: [w.k.root.spki], add: [w.k.anchor.keyid, w.k.keyset.keyid] });
  assert.equal(draft.previous, null);
  assert.match(draft.lines.join('\n'), /anchor .* active \(new\)/);
  // A draft signed by an online key (stolen credential) is not a root.
  const byOnline = await w.offlineSign(draft.body, [w.k.anchor]);
  await assert.rejects(importRoot(w.ctx, byOnline, 1), refusedWith('ATTESTA_TRUST_THRESHOLD_NOT_MET'));
  assert.equal(w.store.state.keys.filter((k) => k.status === 'active').length, 0);
  const env = await w.offlineSign(draft.body);
  const plan = await planRootImport(w.ctx, env);
  assert.equal(plan.expect, 1);
  await assert.rejects(importRoot(w.ctx, env, 2), refusedWith(undefined, /--expect=2/));
  await importRoot(w.ctx, env, 1);
  assert.deepEqual(w.store.state.keys.map((k) => k.status), ['active', 'active']);
  const signer = await resolvePlatformSigner(w.store, w.adapters, 'anchor', w.ctx.config, w.now());
  assert.equal(signer.keyid, w.k.anchor.keyid);
  assert.deepEqual(w.store.state.events.filter((e) => e.tenantId === null).map((e) => e.action).sort(),
    ['activate', 'activate', 'import_root', 'register', 'register']);
});

test('import-root: threshold, fork, rollback, gap and regression are refused with the right code', async () => {
  const w = world();
  const v1 = await w.bootstrap();
  // Rollback: the stored version again.
  await assert.rejects(importRoot(w.ctx, v1, 1), refusedWith('ATTESTA_TRUST_ROLLBACK'));
  // Version 2 that retires the anchor key.
  w.advance(DAY);
  const draft = await exportRootDraft(w.ctx, { retire: [w.k.anchor.keyid] });
  assert.ok(draft.previous);
  // Threshold: signed by a key that is not a root key of v1.
  const unsigned = await w.offlineSign(draft.body, [w.k.root2]);
  await assert.rejects(importRoot(w.ctx, unsigned, 2), refusedWith('ATTESTA_TRUST_THRESHOLD_NOT_MET'));
  // Fork: a version 2 whose previous is not v1.
  const forkBody = { ...draft.body, previous: 'sha256:' + '1'.repeat(64) };
  await assert.rejects(importRoot(w.ctx, await w.offlineSign(forkBody), 2), refusedWith('ATTESTA_TRUST_DOCUMENT_CONFLICT'));
  // A different version 1 (conflict with the stored one).
  const otherV1 = await w.offlineSign({ ...parseTrustDocument(v1).body, issued_at: new Date(T0 + 1).toISOString() });
  await assert.rejects(importRoot(w.ctx, otherV1, 1), refusedWith('ATTESTA_TRUST_DOCUMENT_CONFLICT'));
  // Gap: version 3 with nothing at 2.
  await assert.rejects(importRoot(w.ctx, await w.offlineSign({ ...draft.body, version: 3 }), 3), refusedWith('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE'));
  // Regression: version 2 that drops the keyset key.
  const dropped = { ...draft.body, keys: draft.body.keys.filter((k) => k.keyid !== w.k.keyset.keyid) };
  await assert.rejects(importRoot(w.ctx, await w.offlineSign(dropped), 2), refusedWith('ATTESTA_TRUST_KEYSET_REGRESSION'));
  // A root listing a key that was never registered here.
  const stranger = newKey();
  const extra = { ...draft.body, keys: [...draft.body.keys, { keyid: stranger.keyid, purpose: 'release' as const,
    spki_der_b64: stranger.spki.toString('base64'), not_before: draft.body.issued_at, not_after: draft.body.expires, status: 'active' as const }] };
  await assert.rejects(importRoot(w.ctx, await w.offlineSign(extra), 2), refusedWith(undefined, /not registered here: register it first/));
  // Malformed file.
  await assert.rejects(importRoot(w.ctx, { nope: true }, 2), refusedWith('ATTESTA_TRUST_DOCUMENT_MALFORMED'));
  // The honest version 2 imports and retires the anchor key; nothing resolves for anchor afterwards.
  await importRoot(w.ctx, await w.offlineSign(draft.body), 2);
  assert.equal(w.store.state.keys.find((k) => k.keyid === w.k.anchor.keyid)?.status, 'retired');
  await assert.rejects(resolvePlatformSigner(w.store, w.adapters, 'anchor', w.ctx.config, w.now()), /lists no active anchor key/);
  // Pin required in production; a pin to another key fails closed.
  await assert.rejects(planRootImport({ ...w.ctx, config: { pinnedRootKeyids: [], production: true } }, v1), refusedWith('ATTESTA_TRUST_ROOT_NOT_PINNED'));
  await assert.rejects(resolvePlatformSigner(w.store, w.adapters, 'tenant_keyset', { pinnedRootKeyids: [w.k.root2.keyid], production: true }, w.now()),
    /do not verify from the pin/);
});

test('export-root-draft: refuses unknown or root keyids, root keys after version 1, and a revocation without reason', async () => {
  const w = world();
  await assert.rejects(exportRootDraft(w.ctx, {}), refusedWith(undefined, /version 1 needs --root-pub/));
  await w.bootstrap();
  await assert.rejects(exportRootDraft(w.ctx, { rootSpkis: [w.k.root2.spki] }), refusedWith(undefined, /version 1 only/));
  await assert.rejects(exportRootDraft(w.ctx, { retire: [w.k.root.keyid] }), refusedWith(undefined, /not a platform online key/));
  await assert.rejects(exportRootDraft(w.ctx, { revoke: [w.k.anchor.keyid] }), refusedWith(undefined, /--reason/));
  await assert.rejects(exportRootDraft(w.ctx, { revoke: [w.k.anchor.keyid], reason: 'compromised' }), refusedWith(undefined, /compromised-since/));
  w.advance(HOUR);
  // Rotating the tenant_keyset key: new key registered, old revoked compromised.
  await w.reg(null, 'dev:keyset2', 'tenant_keyset');
  const since = new Date(T0 + 30 * 60_000).toISOString();
  const draft = await exportRootDraft(w.ctx, { add: [w.k.keyset2.keyid], revoke: [w.k.keyset.keyid], reason: 'compromised', compromisedSince: since });
  assert.match(draft.lines.join('\n'), /revoked \(was active\)/);
  const byId = new Map(draft.body.keys.map((k) => [k.keyid, k]));
  assert.equal(byId.get(w.k.keyset2.keyid)?.status, 'active');
  assert.deepEqual([byId.get(w.k.keyset.keyid)?.status, byId.get(w.k.keyset.keyid)?.compromised_since], ['revoked', since]);
  assert.equal(byId.get(w.k.root.keyid)?.not_after, draft.body.expires, 'root keys are renewed to the new expiry');
  assert.ok(!JSON.stringify(draft).includes('dev:'), 'no credential reference in a draft');
});

// ---------------------------------------------------------------------------
// Key-set publishing
// ---------------------------------------------------------------------------

test('publish: version chain, 30-day lifetime, registered keys excluded, signed by the root-listed tenant_keyset key', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  await assert.rejects(planPublish(w.ctx, A), refusedWith(undefined, /no key that was ever active/));
  await w.activate(A, w.k.a1.keyid);
  await w.reg(A, 'dev:a2'); // registered only: never listed
  const popOnly = w.adapter.calls.get('dev:keyset');
  const plan = await planPublish(w.ctx, A);
  assert.equal(w.adapter.calls.get('dev:keyset'), popOnly, 'the dry run signs nothing');
  assert.match(plan.lines[0], new RegExp(`version 1 for tenant ${A}, signed by tenant_keyset key ${w.k.keyset.keyid}`));
  await publishKeyset(w.ctx, A);
  w.advance(7 * DAY);
  await publishKeyset(w.ctx, A);
  const [d1, d2] = (await w.store.documents(A)).map((d) => parseTrustDocument(d.envelope));
  assert.deepEqual([d1.body.version, d1.body.previous, d2.body.version, d2.body.previous], [1, null, 2, d1.digest]);
  assert.equal(d2.expires - d2.issuedAt, KEYSET_LIFETIME_MS);
  assert.deepEqual([...d2.keys.keys()], [w.k.a1.keyid]);
  assert.deepEqual(d2.signatures.map((s) => s.keyid), [w.k.keyset.keyid]);
  // The stored chain verifies as GitAI and auditors will verify it (key unknown = every document check passed).
  const verdict = verifyTrusted({
    payloadType: 'x', payload: Buffer.from('p'), envelope: { payload: Buffer.from('p').toString('base64'), payloadType: 'x', signatures: [{ keyid: 'sha256:' + 'f'.repeat(64), sig: 'AA==' }] },
    purpose: 'statement', audience: A, signedAt: w.now().toISOString(),
    state: { pinnedRootKeyids: [w.k.root.keyid], rootDocuments: (await w.store.documents('platform')).map((d) => d.envelope),
      keysetDocuments: { [A]: (await w.store.documents(A)).map((d) => d.envelope) }, lastTrusted: {}, now: w.now().toISOString(), production: true },
  });
  assert.equal(verdict.code, 'ATTESTA_TRUST_KEY_UNKNOWN');
  assert.equal(w.store.state.audits.filter((a) => a.action === 'attesta.keys.publish' && a.tenantId === A).length, 2);
});

test('publish: forward-only is checked before signing; a revoked tenant_keyset key stops publishing', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  await w.activate(A, w.k.a1.keyid);
  await publishKeyset(w.ctx, A);
  const signedBefore = w.adapter.calls.get('dev:keyset');
  // A row written around the service (the guards refuse this in PostgreSQL): the key goes back to registered.
  w.store.state.keys.find((k) => k.keyid === w.k.a1.keyid)!.status = 'registered';
  await w.reg(A, 'dev:a2');
  await w.activate(A, w.k.a2.keyid);
  await assert.rejects(publishKeyset(w.ctx, A), refusedWith('ATTESTA_TRUST_KEYSET_REGRESSION', /nothing signed/));
  assert.equal(w.adapter.calls.get('dev:keyset'), signedBefore, 'nothing was signed');
  assert.equal((await w.store.documents(A)).length, 1);
  // Root v2 revokes the keyset key: publish fails closed until a new keyset key is listed.
  w.store.state.keys.find((k) => k.keyid === w.k.a1.keyid)!.status = 'active';
  w.store.state.keys.find((k) => k.keyid === w.k.a2.keyid)!.status = 'registered';
  w.advance(HOUR);
  const draft = await exportRootDraft(w.ctx, { revoke: [w.k.keyset.keyid], reason: 'superseded' });
  await importRoot(w.ctx, await w.offlineSign(draft.body), 2);
  await assert.rejects(publishKeyset(w.ctx, A), /lists no active tenant_keyset key/);
  w.advance(HOUR);
  await w.reg(null, 'dev:keyset2', 'tenant_keyset');
  const draft3 = await exportRootDraft(w.ctx, { add: [w.k.keyset2.keyid] });
  await importRoot(w.ctx, await w.offlineSign(draft3.body), 3);
  await publishKeyset(w.ctx, A);
  const latest = parseTrustDocument((await w.store.documents(A))[1].envelope);
  assert.deepEqual(latest.signatures.map((s) => s.keyid), [w.k.keyset2.keyid]);
});

test('every refusal and plan names keyids and tenants only: no credential reference, no key material', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  const outputs: string[] = [];
  outputs.push(...(await planTenantKeyCommand(w.ctx, 'activate', { tenantId: A, keyid: w.k.a1.keyid })).lines);
  await w.activate(A, w.k.a1.keyid);
  outputs.push(...(await planPublish(w.ctx, A)).lines);
  outputs.push(...(await planRootImport(w.ctx, (await w.store.documents('platform'))[0].envelope).catch((e: Error) => ({ lines: [e.message] }))).lines);
  for (const fn of [() => w.reg(B, 'dev:a1-for-b'), () => w.activate(B, w.k.a1.keyid)]) {
    outputs.push(await fn().then(() => 'ok', (e: Error) => e.message));
  }
  const text = outputs.join('\n');
  assert.ok(!/dev:|PRIVATE|BEGIN/.test(text), text);
  assert.ok(!text.includes(w.k.a1.spki.toString('base64')));
});

test('memory store: a failed transaction rolls back every write', async () => {
  const w = world();
  await w.reg(A, 'dev:a1');
  const before = JSON.stringify(w.store.state.events);
  await assert.rejects(w.store.transaction(async (tx) => {
    await tx.insertEvent({ tenantId: A, keyId: null, action: 'publish', actor: 'x', reason: null, documentVersion: 1, requestId: 'r' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(JSON.stringify(w.store.state.events), before);
});

// ---------------------------------------------------------------------------
// Review round 1 fixes
// ---------------------------------------------------------------------------

test('a key stops signing only once every record it signed is anchored (compromise excepted)', async () => {
  const w = world();
  await w.reg(A, 'dev:a1');
  await w.activate(A, w.k.a1.keyid);
  await w.reg(A, 'dev:a2');
  w.store.state.unanchored = { [w.k.a1.keyid]: 3 };
  for (const [command, cmd] of [
    ['retire', { tenantId: A, keyid: w.k.a1.keyid }],
    ['activate', { tenantId: A, keyid: w.k.a2.keyid, replace: true }],
    ['revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'superseded' }],
  ] as const) {
    await assert.rejects(planTenantKeyCommand(w.ctx, command, cmd), refusedWith(undefined, /3 ledger records signed by key .* are not anchored yet/));
  }
  // A compromise is never delayed: those records must not verify anyway.
  const plan = await planTenantKeyCommand(w.ctx, 'revoke', { tenantId: A, keyid: w.k.a1.keyid, reason: 'compromised', compromisedSince: w.now().toISOString() });
  assert.equal(plan.expect, 1);
  w.store.state.unanchored = {};
  await w.activate(A, w.k.a2.keyid, true);
});

test('apply is compare-and-set: a key changed after it was read is refused, nothing written', async () => {
  const w = world();
  const key = await w.reg(A, 'dev:a1');
  const stale = { ...key };
  await w.activate(A, w.k.a1.keyid);
  await assert.rejects(w.store.transaction((tx) => tx.updateKey(stale, { status: 'revoked', revokedAt: w.now().toISOString(),
    revocationReason: 'superseded', compromisedSince: null, notAfter: stale.notAfter })), refusedWith(undefined, /changed while this command ran/));
  assert.equal(w.store.state.keys[0].status, 'active');
});

test('the reserved platform tenant is never a --tenant; root import needs a pin in development too', async () => {
  const w = world();
  await assert.rejects(registerKey(w.ctx, { tenantId: ATTESTA_PLATFORM_TENANT_ID, purpose: 'statement', adapterName: 'local-dev', credentialRef: 'dev:anchor' }),
    refusedWith(undefined, /reserved platform tenant/));
  await assert.rejects(planPublish(w.ctx, ATTESTA_PLATFORM_TENANT_ID), refusedWith(undefined, /reserved platform tenant/));
  await w.reg(null, 'dev:anchor', 'anchor');
  const draft = await exportRootDraft(w.ctx, { rootSpkis: [w.k.root.spki], add: [w.k.anchor.keyid] });
  const env = await w.offlineSign(draft.body);
  await assert.rejects(planRootImport({ ...w.ctx, config: { pinnedRootKeyids: [], production: false } }, env), refusedWith('ATTESTA_TRUST_ROOT_NOT_PINNED'));
  // A self-signed root under another key is refused against the pin.
  const rogue = await w.offlineSign({ ...draft.body, keys: [...draft.body.keys.filter((k) => k.purpose !== 'root'),
    { keyid: w.k.root2.keyid, purpose: 'root', spki_der_b64: w.k.root2.spki.toString('base64'), not_before: draft.body.issued_at, not_after: draft.body.expires, status: 'active' }] },
  [w.k.root2]);
  await assert.rejects(importRoot(w.ctx, rogue, 1), refusedWith('ATTESTA_TRUST_DOCUMENT_UNAVAILABLE'));
});

test('publish never extends a stored key set that no tenant_keyset key signed', async () => {
  const w = world();
  await w.bootstrap();
  await w.reg(A, 'dev:a1');
  await w.activate(A, w.k.a1.keyid);
  await publishKeyset(w.ctx, A);
  // A database writer appends a version 2 signed by a statement key (shape-valid, chained).
  const v1 = parseTrustDocument((await w.store.documents(A))[0].envelope);
  const forged = await signTrustDocument({ ...v1.body, version: 2, previous: v1.digest, issued_at: new Date(T0 + 1000).toISOString() },
    [{ keyid: w.k.a1.keyid, sign: (b: Buffer) => cryptoSign('sha256', b, { key: w.k.a1.priv, dsaEncoding: 'der' }) }]);
  w.store.state.documents.push({ scope: A, kind: 'keyset', version: 2, digest: parseTrustDocument(forged).digest, envelope: forged });
  const signedBefore = w.adapter.calls.get('dev:keyset');
  await assert.rejects(publishKeyset(w.ctx, A), refusedWith('ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID', /not signed by any tenant_keyset key/));
  assert.equal(w.adapter.calls.get('dev:keyset'), signedBefore);
});
