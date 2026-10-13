/**
 * attesta-build-cli (Task15i2 item 8) and attesta-pack-cli: production builds sign
 * through the trust inventory and never reach the development resolver; development
 * keeps the dev signer; the pack recovery pass runs each stranded job once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderResolverFromEnv } from './attesta-build-cli';
import { runQueuedPacks } from './attesta-pack-cli';
import { generateDevCredential } from './signer-local-dev';
import type { SignerResolver } from './signer-resolver';
import { A, MemoryPackStore, MemorySink, T0, buildFixtureChain, trustWorld } from './testing/evidence-pack-fixtures';

const inventoryResolver: SignerResolver = { resolve: async () => null };

test('production: the inventory resolver, never the dev resolver (even with a dev key file or flag)', async () => {
  let devCalls = 0;
  let inventoryEnv: NodeJS.ProcessEnv | null = null;
  const env = { NODE_ENV: 'production', ATTESTA_DEV_SIGNER_KEY_FILE: '/tmp/dev.pem' } as NodeJS.ProcessEnv;
  const r = await builderResolverFromEnv(env, new Map([['ephemeral-dev-key', 'true']]), {
    inventory: async (e) => { inventoryEnv = e; return inventoryResolver; },
    dev: () => { devCalls += 1; return inventoryResolver; },
    read: () => { throw new Error('production must not read a dev key'); },
  });
  assert.equal(r.resolver, inventoryResolver);
  assert.equal(r.label, 'signer=trust-inventory');
  assert.equal(inventoryEnv, env);
  assert.equal(devCalls, 0);
});

test('production with a broken trust configuration fails to start (no fallback to the dev signer)', async () => {
  let devCalls = 0;
  await assert.rejects(builderResolverFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, new Map(), {
    inventory: async () => { throw new Error('ATTESTA_TRUST_ROOT_KEYIDS must be …'); },
    dev: () => { devCalls += 1; return inventoryResolver; },
  }), /ATTESTA_TRUST_ROOT_KEYIDS/);
  assert.equal(devCalls, 0);
});

test('development: the dev signer from the key file or --ephemeral-dev-key; neither → refused', async () => {
  const pem = generateDevCredential('dev:t', 'local').privateKeyPem;
  let inventoryCalls = 0;
  const deps = { inventory: async () => { inventoryCalls += 1; return inventoryResolver; }, read: () => pem };
  const fromFile = await builderResolverFromEnv({ ATTESTA_DEV_SIGNER_KEY_FILE: '/k.pem' } as NodeJS.ProcessEnv, new Map(), deps);
  assert.match(fromFile.label, /^signer=dev dev_keyid=sha256:[0-9a-f]{64}$/);
  assert.ok(await fromFile.resolver.resolve('00000000-0000-4000-8000-00000000000a'));
  const eph = await builderResolverFromEnv({} as NodeJS.ProcessEnv, new Map([['ephemeral-dev-key', 'true']]), deps);
  assert.match(eph.label, /^signer=dev /);
  await assert.rejects(builderResolverFromEnv({} as NodeJS.ProcessEnv, new Map(), deps), /ATTESTA_DEV_SIGNER_KEY_FILE/);
  assert.equal(inventoryCalls, 0);
});

test('attesta:pack --run-queued runs queued and lease-expired jobs once each, and nothing live', async () => {
  const w = await trustWorld();
  const store = new MemoryPackStore(new Map([[A, buildFixtureChain(A, w.k.a1)]]));
  store.clock = T0;
  const sink = new MemorySink();
  const deps = { store, sink: () => sink, resolver: async () => w.resolver, trust: w.material, log: () => undefined };
  const request = { scope: { repository_id: null, from: '2026-10-13T09:02:00.000Z', to: '2026-10-13T09:08:00.000Z' }, mode: 'full' as const };
  const queued = (await store.createOrGet({ tenantId: A, idempotencyKey: 'cli-queued-1', request, requestedBy: 'a', requestId: 'r' })).job;
  const live = (await store.createOrGet({ tenantId: A, idempotencyKey: 'cli-live-001', request, requestedBy: 'a', requestId: 'r' })).job;
  await store.claim(A, live.id, 600_000);
  assert.deepEqual(await runQueuedPacks(deps), [{ id: queued.id, result: 'ready' }]);
  assert.deepEqual(await runQueuedPacks(deps), [], 'nothing left; the live lease is not taken');
  store.clock += 600_001;
  assert.deepEqual(await runQueuedPacks(deps), [{ id: live.id, result: 'ready' }]);
});
