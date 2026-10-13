/**
 * Trust resolvers (Task15l2): the builder's inventorySignerResolver, platformSigner,
 * publishedKeysFor against verify-chain, and the adapters / pin from the environment.
 * Real signers (LocalDevSigner; KmsSigner over an in-process provider for the
 * production paths), real documents and the real verifier; the memory store stands
 * in for PostgreSQL (live: t15l2-trust-live-verify.ts).
 */
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { p256 } from '@noble/curves/nist.js';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { AnchorConfigError, anchorFromEnv, anchorSignerFromEnv, platformAnchorSignerFromEnv } from './anchor-env';
import { SigningRejected, SigningUnavailable, signVerified, type SigningAdapter } from './signer-contract';
import { KmsSigner, type KmsProvider } from './signer-kms';
import { LocalDevSigner } from './signer-local-dev';
import { buildChain, type TestKey } from './testing/ledger-fixtures';
import type { TrustDocumentBody } from './trust-contract';
import { keyidOf, signTrustDocument } from './trust-documents';
import {
  applyTenantKeyCommand,
  exportRootDraft,
  importRoot,
  memoryTrustStore,
  pinnedAdapter,
  planTenantKeyCommand,
  registerKey,
  type InventoryContext,
  type TrustAdapters,
  type TrustConfig,
} from './trust-inventory';
import { TrustConfigError, adaptersFromEnv, inventorySignerResolver, platformSigner, publishedKeysFor, trustConfigFromEnv } from './trust-resolver';
import { verifyChainRows } from './verify-chain';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const REPO = 'cccccccc-0000-4000-8000-00000000000c';
const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const DAY = 86_400_000;

interface Key { pem: string; priv: KeyObject; spki: Buffer; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), priv: privateKey, spki, keyid: keyidOf(spki) };
}

/** An in-process KMS: signs SHA-256 digests with keys held here (production paths need a non-dev adapter). */
class FakeKms implements KmsProvider {
  readonly name = 'aws' as const;
  constructor(readonly keys: Map<string, Key>) {}
  async publicKeySpkiDer(ref: string): Promise<Buffer> {
    const k = this.keys.get(ref);
    if (!k) throw new SigningRejected('unknown key');
    return Buffer.from(k.spki);
  }
  async signDigest(ref: string, digest: Buffer): Promise<Buffer> {
    const k = this.keys.get(ref) as Key;
    const d = Buffer.from((k.priv.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
    return Buffer.from(p256.sign(new Uint8Array(digest), new Uint8Array(d), { prehash: false, format: 'der' }));
  }
  async health(): Promise<boolean> {
    return true;
  }
}

function kmsCredential(id: string, tenantId: string, key: Key) {
  return { credentialId: `aws-kms:${id}`, tenantId, displayName: id, keyReference: `ref-${id}`, publicKeySha256: key.keyid };
}

/** A bootstrapped inventory (root v1 with anchor and keyset keys) on KMS adapters, production or not. */
async function kmsWorld(production: boolean) {
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const kms = new FakeKms(new Map([['ref-anchor', k.anchor], ['ref-keyset', k.keyset], ['ref-a1', k.a1], ['ref-b1', k.b1]]));
  const creds = [kmsCredential('anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor), kmsCredential('keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset),
    kmsCredential('a1', A, k.a1), kmsCredential('b1', B, k.b1)];
  const adapters: TrustAdapters = { 'kms-aws': new KmsSigner({ provider: kms, credentials: creds }) };
  const store = memoryTrustStore();
  let now = T0;
  const config: TrustConfig = { pinnedRootKeyids: [k.root.keyid], production };
  const ctx: InventoryContext = { store, adapters, config, actor: 'op', requestId: 'r', now: () => new Date(now) };
  const reg = (tenantId: string | null, id: string, purpose: 'statement' | 'anchor' | 'tenant_keyset' = 'statement') =>
    registerKey(ctx, { tenantId, purpose, adapterName: 'kms-aws', credentialRef: `aws-kms:${id}` });
  await reg(null, 'anchor', 'anchor');
  await reg(null, 'keyset', 'tenant_keyset');
  const sign = (body: TrustDocumentBody) => signTrustDocument(body, [{ keyid: k.root.keyid,
    sign: (b: Buffer) => cryptoSign('sha256', b, { key: k.root.priv, dsaEncoding: 'der' }) }]);
  await importRoot(ctx, await sign((await exportRootDraft(ctx, { rootSpkis: [k.root.spki], add: [k.anchor.keyid, k.keyset.keyid] })).body), 1);
  const activate = async (tenantId: string, keyid: string) => {
    const plan = await planTenantKeyCommand(ctx, 'activate', { tenantId, keyid });
    await applyTenantKeyCommand(ctx, 'activate', { tenantId, keyid }, plan.expect);
  };
  return { k, kms, creds, adapters, store, config, ctx, reg, sign, activate, advance: (d: number) => { now += d; }, now: () => new Date(now) };
}

test('inventorySignerResolver: null when there is no usable key; fail closed on a missing adapter', async () => {
  const w = await kmsWorld(true);
  const resolver = inventorySignerResolver(w.store, w.adapters, { now: w.now });
  assert.equal(await resolver.resolve(A), null, 'no key at all');
  await w.reg(A, 'a1');
  assert.equal(await resolver.resolve(A), null, 'registered only');
  await w.activate(A, w.k.a1.keyid);
  const r = await resolver.resolve(A);
  assert.equal(r?.credentialId, 'aws-kms:a1');
  // It signs (production KMS adapter, pinned to the registered key) and signVerified accepts.
  const signed = await signVerified(r!.adapter, Buffer.from('statement'), { credentialId: r!.credentialId, tenantId: A, requestId: 'x' });
  assert.equal(keyidOf(signed.publicKeySpkiDer), w.k.a1.keyid);
  assert.equal(await resolver.resolve('not-a-uuid'), null);
  assert.equal(await resolver.resolve(B), null, 'another tenant never gets A\'s key');
  assert.equal(await inventorySignerResolver(w.store, w.adapters, { now: () => new Date(T0 - DAY) }).resolve(A), null, 'not yet valid');
  assert.equal(await inventorySignerResolver(w.store, w.adapters, { now: () => new Date(T0 + 400 * DAY) }).resolve(A), null, 'expired');
  await assert.rejects(inventorySignerResolver(w.store, {}, { now: w.now }).resolve(A), SigningUnavailable);
  // Retired: never resolved again.
  w.advance(1000);
  await applyTenantKeyCommand(w.ctx, 'retire', { tenantId: A, keyid: w.k.a1.keyid }, 1);
  assert.equal(await resolver.resolve(A), null);
});

test('pinned adapter: a KMS key swapped after registration cannot sign', async () => {
  const w = await kmsWorld(true);
  await w.reg(A, 'a1');
  await w.activate(A, w.k.a1.keyid);
  // The credentials file now points the same credential at another key (with a matching pin).
  const swapped = new KmsSigner({ provider: w.kms, credentials: [{ ...kmsCredential('a1', A, w.k.b1), keyReference: 'ref-b1' }] });
  const r = await inventorySignerResolver(w.store, { 'kms-aws': swapped }, { now: w.now }).resolve(A);
  await assert.rejects(r!.adapter.publicKey('aws-kms:a1'), /differs from the key registered/);
  await assert.rejects(signVerified(r!.adapter, Buffer.from('s'), { credentialId: 'aws-kms:a1', tenantId: A, requestId: 'x' }), SigningRejected);
  const pinned = pinnedAdapter(w.adapters['kms-aws'], 'aws-kms:a1', w.k.a1.spki);
  await assert.rejects(pinned.sign(Buffer.from('s'), 'aws-kms:b1', { requestId: 'x', tenantId: B }), /not the registered one/);
  await assert.rejects(pinned.publicKey('aws-kms:b1'), /not the registered one/);
});

test('platformSigner: the latest root decides; every missing piece fails closed', async () => {
  const w = await kmsWorld(true);
  const s = await platformSigner(w.store, w.adapters, 'anchor', w.config, { now: w.now });
  assert.deepEqual([s.credentialId, s.keyid], ['aws-kms:anchor', w.k.anchor.keyid]);
  await assert.rejects(platformSigner(w.store, w.adapters, 'release', w.config, { now: w.now }), /lists no active release key/);
  await assert.rejects(platformSigner(w.store, {}, 'anchor', w.config, { now: w.now }), /not configured/);
  await assert.rejects(platformSigner(w.store, w.adapters, 'anchor', { ...w.config, pinnedRootKeyids: [] }, { now: w.now }), /ATTESTA_TRUST_ROOT_KEYIDS is required/);
  await assert.rejects(platformSigner(w.store, w.adapters, 'anchor', { pinnedRootKeyids: [], production: false }, { now: w.now }), /ATTESTA_TRUST_ROOT_KEYIDS is required/);
  await assert.rejects(platformSigner(w.store, w.adapters, 'anchor', w.config, { now: () => new Date(T0 + 400 * DAY) }), /DOCUMENT_EXPIRED/);
  await assert.rejects(platformSigner(memoryTrustStore(), w.adapters, 'anchor', w.config, { now: w.now }), /no root document/);
  await assert.rejects(platformSigner(w.store, w.adapters, 'statement' as never, w.config, { now: w.now }), /not a platform purpose/);
  // A row changed around the service (status) no longer matches the root: fail closed.
  w.store.state.keys.find((k) => k.keyid === w.k.anchor.keyid)!.status = 'registered';
  await assert.rejects(platformSigner(w.store, w.adapters, 'anchor', w.config, { now: w.now }), /not active in the inventory/);
});

test('publishedKeysFor: its keys make verify-chain check every signature', async () => {
  const w = await kmsWorld(false);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const tk: TestKey = { privateKey, publicKey, spki, keyid: keyidOf(spki) };
  const dev = new LocalDevSigner({ env: {}, credentials: [{ credentialId: 'dev:ledger', tenantId: A, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] });
  w.ctx.adapters = { ...w.adapters, 'local-dev': dev };
  await registerKey(w.ctx, { tenantId: A, purpose: 'statement', adapterName: 'local-dev', credentialRef: 'dev:ledger' });
  await w.activate(A, tk.keyid);
  const chain = buildChain(5, { tenantId: A, repositoryId: REPO, key: tk });
  const blind = await verifyChainRows(chain.rows, { tenantId: A, fromSeq: 0, toSeq: 4, head: chain.head });
  assert.equal(blind.signatures, 'not_checked');
  const published = await publishedKeysFor(w.store, A);
  const report = await verifyChainRows(chain.rows, { tenantId: A, fromSeq: 0, toSeq: 4, head: chain.head, keys: published.keys });
  assert.equal(report.signatures, 'checked');
  assert.equal(report.ok, true);
  assert.deepEqual(report.breaks, []);
  assert.equal(published.rootDocuments.length, 1);
  // Another tenant's published keys do not verify A's chain.
  const other = await publishedKeysFor(w.store, B);
  const cross = await verifyChainRows(chain.rows, { tenantId: A, fromSeq: 0, toSeq: 4, head: chain.head, keys: other.keys });
  assert.equal(cross.ok, false);
  await assert.rejects(publishedKeysFor(w.store, 'A'), RangeError);
});

test('trustConfigFromEnv and adaptersFromEnv: pin format, KMS references, the dev signer refused in production', async () => {
  const k = newKey();
  assert.deepEqual(trustConfigFromEnv({ ATTESTA_TRUST_ROOT_KEYIDS: ` ${k.keyid} `, NODE_ENV: 'production' }),
    { pinnedRootKeyids: [k.keyid], production: true });
  assert.deepEqual(trustConfigFromEnv({}), { pinnedRootKeyids: [], production: false });
  for (const bad of ['sha256:12', `${k.keyid},${k.keyid}`, 'x']) {
    assert.throws(() => trustConfigFromEnv({ ATTESTA_TRUST_ROOT_KEYIDS: bad }), TrustConfigError);
  }
  const files: Record<string, string> = {
    '/c/kms.json': JSON.stringify([kmsCredential('one', A, k)]),
    '/c/dev.json': JSON.stringify([{ credentialId: 'dev:one', tenantId: A, keyFile: '/c/one.pem' }]),
    '/c/one.pem': k.pem,
    '/c/bad.json': '{',
    '/c/odd.json': JSON.stringify([{ ...kmsCredential('one', A, k), credentialId: 'vault:one' }]),
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };
  const fake = new FakeKms(new Map([['ref-one', k]]));
  const both = await adaptersFromEnv({ ATTESTA_KMS_CREDENTIALS_FILE: '/c/kms.json', ATTESTA_DEV_CREDENTIALS_FILE: '/c/dev.json' },
    { read, kmsProviders: { aws: fake } });
  assert.deepEqual(Object.keys(both).sort(), ['kms-aws', 'local-dev']);
  assert.equal(keyidOf(await both['kms-aws'].publicKey('aws-kms:one')), k.keyid);
  await assert.rejects(adaptersFromEnv({ NODE_ENV: 'production', ATTESTA_DEV_CREDENTIALS_FILE: '/c/dev.json' }, { read }),
    (e: unknown) => e instanceof TrustConfigError && /production/.test((e as Error).message));
  await assert.rejects(adaptersFromEnv({ ATTESTA_KMS_CREDENTIALS_FILE: '/c/missing.json' }, { read }),
    (e: unknown) => e instanceof TrustConfigError && !(e as Error).message.includes('/c/'));
  await assert.rejects(adaptersFromEnv({ ATTESTA_KMS_CREDENTIALS_FILE: '/c/bad.json' }, { read }), TrustConfigError);
  await assert.rejects(adaptersFromEnv({ ATTESTA_KMS_CREDENTIALS_FILE: '/c/odd.json' }, { read, kmsProviders: { aws: fake } }), TrustConfigError);
  assert.deepEqual(await adaptersFromEnv({}, { read }), {});
});

test('anchor-env production branch: platformSigner(anchor) from the inventory, fail closed without it', async () => {
  const w = await kmsWorld(true);
  const env = { NODE_ENV: 'production', ATTESTA_TRUST_ROOT_KEYIDS: w.k.root.keyid };
  assert.throws(() => anchorSignerFromEnv(env), (e: unknown) => e instanceof AnchorConfigError && /trust inventory/.test((e as Error).message));
  const signer = await platformAnchorSignerFromEnv(env, { store: w.store, adapters: w.adapters, now: w.now });
  assert.equal(keyidOf(await signer.publicKeySpkiDer()), w.k.anchor.keyid);
  assert.ok((await signer.sign(Buffer.from('root'))).length > 0);
  await assert.rejects(platformAnchorSignerFromEnv({ NODE_ENV: 'production' }, { store: w.store, adapters: w.adapters, now: w.now }),
    (e: unknown) => e instanceof AnchorConfigError && /ATTESTA_TRUST_ROOT_KEYIDS/.test((e as Error).message));
  await assert.rejects(platformAnchorSignerFromEnv(env, { store: memoryTrustStore(), adapters: w.adapters, now: w.now }),
    (e: unknown) => e instanceof AnchorConfigError && /no root document/.test((e as Error).message));
  await assert.rejects(platformAnchorSignerFromEnv(env, { store: w.store, adapters: {}, now: w.now }), AnchorConfigError);
  // anchorFromEnv takes the production branch (fails here at the Rekor URL, after the signer resolved).
  await assert.rejects(anchorFromEnv(env, { platform: { store: w.store, adapters: w.adapters, now: w.now } }),
    (e: unknown) => e instanceof AnchorConfigError && /ATTESTA_REKOR_URL/.test((e as Error).message));
  await assert.rejects(anchorFromEnv(env, { platform: { store: memoryTrustStore(), adapters: w.adapters, now: w.now } }),
    (e: unknown) => e instanceof AnchorConfigError && /no root document/.test((e as Error).message));
  // The adapter used is the pinned one: a swapped anchor key is refused at sign time.
  const swapped: SigningAdapter = new KmsSigner({ provider: w.kms, credentials: [{ ...kmsCredential('anchor', ATTESTA_PLATFORM_TENANT_ID, w.k.b1), keyReference: 'ref-b1' }] });
  const bad = await platformAnchorSignerFromEnv(env, { store: w.store, adapters: { 'kms-aws': swapped }, now: w.now });
  await assert.rejects(bad.sign(Buffer.from('root')), /refused to sign|signer/);
});

test('a running anchor signer follows the latest root: a revoked anchor key stops signing at once', async () => {
  const w = await kmsWorld(true);
  const env = { NODE_ENV: 'production', ATTESTA_TRUST_ROOT_KEYIDS: w.k.root.keyid };
  const signer = await platformAnchorSignerFromEnv(env, { store: w.store, adapters: w.adapters, now: w.now });
  assert.ok((await signer.sign(Buffer.from('root-1'))).length > 0);
  w.advance(60_000);
  const draft = await exportRootDraft(w.ctx, { revoke: [w.k.anchor.keyid], reason: 'compromised', compromisedSince: w.now().toISOString() });
  await importRoot(w.ctx, await w.sign(draft.body), 2);
  await assert.rejects(signer.sign(Buffer.from('root-2')), (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'ATTESTA_SIGNER_REJECTED');
  await assert.rejects(signer.publicKeySpkiDer(), (e: unknown) => (e as { code?: string }).code === 'ATTESTA_SIGNER_REJECTED');
});
