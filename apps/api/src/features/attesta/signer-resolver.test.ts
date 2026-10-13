import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver } from './signer-resolver';
import { SigningRejected, signVerified } from './signer-contract';

const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const DEV_ENV = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

test('T15h resolver: explicit credential resolves only for its own tenant', async () => {
  const cred = generateDevCredential('dev:a', TENANT_A);
  const resolver = devSignerResolver({ credentials: [cred], env: DEV_ENV });
  const a = await resolver.resolve(TENANT_A);
  assert.ok(a);
  assert.equal(a.credentialId, 'dev:a');
  const signed = await signVerified(a.adapter, Buffer.from('x'), {
    credentialId: a.credentialId, tenantId: TENANT_A, requestId: 'r1',
  });
  assert.equal(signed.credentialId, 'dev:a');
  assert.equal(await resolver.resolve(TENANT_B), null);
});

test('T15h resolver: no credential and no shared key gives null (ATTESTA_SIGNER_NO_CREDENTIAL upstream)', async () => {
  const resolver = devSignerResolver({ env: DEV_ENV });
  assert.equal(await resolver.resolve(TENANT_A), null);
  assert.equal(await resolver.resolve('not-a-uuid'), null);
});

test('T15h resolver: shared dev key gives each tenant its own tenant-bound credential', async () => {
  const { privateKeyPem } = generateDevCredential('dev:x', TENANT_A);
  const resolver = devSignerResolver({ sharedKeyPem: privateKeyPem, env: DEV_ENV });
  const a = await resolver.resolve(TENANT_A);
  const b = await resolver.resolve(TENANT_B);
  assert.ok(a && b);
  assert.equal(a.credentialId, `dev:shared:${TENANT_A}`);
  assert.equal(b.credentialId, `dev:shared:${TENANT_B}`);
  // A's adapter refuses B's tenant: credentials stay tenant-bound.
  await assert.rejects(
    a.adapter.sign(Buffer.from('x'), a.credentialId, { requestId: 'r', tenantId: TENANT_B }),
    SigningRejected,
  );
  assert.equal(await resolver.resolve(TENANT_A).then((r) => r?.adapter), a.adapter);
});

test('T15h resolver: explicit credential wins over the shared key; lowest id first', async () => {
  const { privateKeyPem } = generateDevCredential('dev:x', TENANT_A);
  const resolver = devSignerResolver({
    credentials: [generateDevCredential('dev:z', TENANT_A), generateDevCredential('dev:m', TENANT_A)],
    sharedKeyPem: privateKeyPem,
    env: DEV_ENV,
  });
  assert.equal((await resolver.resolve(TENANT_A))?.credentialId, 'dev:m');
});

test('T15h resolver: refuses production at construction and on resolve', async () => {
  assert.throws(() => devSignerResolver({ env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv }), SigningRejected);
  const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
  const resolver = devSignerResolver({ credentials: [generateDevCredential('dev:a', TENANT_A)], env });
  env.NODE_ENV = 'production';
  await assert.rejects(resolver.resolve(TENANT_A), SigningRejected);
});

test('T15h resolver: an unusable shared key fails at construction', () => {
  assert.throws(() => devSignerResolver({ sharedKeyPem: 'not a key', env: DEV_ENV }), SigningRejected);
});
