import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  signVerified,
  SigningRejected,
  SigningUnavailable,
  type SigningAdapter,
  type SigningResult,
} from './signer-contract';
import {
  generateDevCredential,
  LOCAL_DEV_ADAPTER_NAME,
  LOCAL_DEV_MAX_PAYLOAD_BYTES,
  LocalDevSigner,
} from './signer-local-dev';

const PAYLOAD = Buffer.from('attesta test payload');

function makeSigner(tenantId = 'tenant-a'): { signer: LocalDevSigner; credentialId: string } {
  const credentialId = `dev:${tenantId}-key-1`;
  const signer = new LocalDevSigner({
    credentials: [generateDevCredential(credentialId, tenantId)],
    env: { NODE_ENV: 'test' },
  });
  return { signer, credentialId };
}

function verifyDer(publicKeySpkiDer: Buffer, payload: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: publicKeySpkiDer, format: 'der', type: 'spki' });
  return verify('sha256', payload, { key, dsaEncoding: 'der' }, signature);
}

test('signature verifies with the published public key', async () => {
  const { signer, credentialId } = makeSigner();
  const result = await signer.sign(PAYLOAD, credentialId, { requestId: 'r1' });
  assert.equal(result.algorithm, 'ES256');
  assert.equal(result.credentialId, credentialId);
  const published = await signer.publicKey(credentialId);
  assert.ok(result.publicKeySpkiDer.equals(published));
  assert.ok(verifyDer(published, PAYLOAD, result.signature));
});

test('tampered payload fails verification', async () => {
  const { signer, credentialId } = makeSigner();
  const result = await signer.sign(PAYLOAD, credentialId, { requestId: 'r1' });
  const published = await signer.publicKey(credentialId);
  assert.equal(
    verifyDer(published, Buffer.concat([PAYLOAD, Buffer.from('x')]), result.signature),
    false,
  );
});

test('signVerified passes for a good signature', async () => {
  const { signer, credentialId } = makeSigner();
  const result = await signVerified(signer, PAYLOAD, credentialId, 'r1');
  assert.equal(result.credentialId, credentialId);
});

test('signVerified rejects a signature made by a different key', async () => {
  const { signer, credentialId } = makeSigner();
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otherSpki = other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const fake: SigningAdapter = {
    capabilities: () => signer.capabilities(),
    sign: async () => ({
      signature: (await signer.sign(PAYLOAD, credentialId, { requestId: 'r' })).signature,
      algorithm: 'ES256',
      credentialId,
      publicKeySpkiDer: Buffer.from(otherSpki),
    }),
    listCredentials: () => signer.listCredentials('tenant-a'),
    publicKey: () => signer.publicKey(credentialId),
    health: () => signer.health(),
  };
  await assert.rejects(signVerified(fake, PAYLOAD, credentialId, 'r'), SigningRejected);
});

test('signVerified rejects a mismatched published public key', async () => {
  const { signer, credentialId } = makeSigner();
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otherSpki = Buffer.from(other.publicKey.export({ format: 'der', type: 'spki' }));
  const real = await signer.sign(PAYLOAD, credentialId, { requestId: 'r' });
  const fake: SigningAdapter = {
    capabilities: () => signer.capabilities(),
    sign: async () => real,
    listCredentials: () => signer.listCredentials('tenant-a'),
    publicKey: async () => otherSpki,
    health: () => signer.health(),
  };
  await assert.rejects(signVerified(fake, PAYLOAD, credentialId, 'r'), SigningRejected);
});

test('signVerified wraps a plain Error as SigningUnavailable', async () => {
  const { signer, credentialId } = makeSigner();
  const fake: SigningAdapter = {
    capabilities: () => signer.capabilities(),
    sign: async () => {
      throw new Error('boom');
    },
    listCredentials: (tenantId) => signer.listCredentials(tenantId),
    publicKey: (id) => signer.publicKey(id),
    health: () => signer.health(),
  };
  await assert.rejects(signVerified(fake, PAYLOAD, credentialId, 'r'), SigningUnavailable);
});

test('signVerified passes SigningRejected through unchanged', async () => {
  const { signer } = makeSigner();
  await assert.rejects(
    signVerified(signer, PAYLOAD, 'dev:unknown', 'r'),
    (err: unknown) => err instanceof SigningRejected,
  );
});

test('unknown credential, empty and oversize payloads are SigningRejected', async () => {
  const { signer, credentialId } = makeSigner();
  await assert.rejects(
    signer.sign(PAYLOAD, 'dev:unknown', { requestId: 'r' }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign(Buffer.alloc(0), credentialId, { requestId: 'r' }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign(Buffer.alloc(LOCAL_DEV_MAX_PAYLOAD_BYTES + 1), credentialId, {
      requestId: 'r',
    }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign('text' as unknown as Buffer, credentialId, { requestId: 'r' }),
    SigningRejected,
  );
});

test('non-dev credential ids are refused at construction', () => {
  const { privateKeyPem } = generateDevCredential('dev:ok', 'tenant-a');
  assert.throws(
    () =>
      new LocalDevSigner({
        credentials: [{ credentialId: 'prod-key-1', tenantId: 'tenant-a', privateKeyPem }],
        env: { NODE_ENV: 'test' },
      }),
    SigningRejected,
  );
});

test('non-P-256 keys are refused at construction', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(
    () =>
      new LocalDevSigner({
        credentials: [{ credentialId: 'dev:p384', tenantId: 'tenant-a', privateKeyPem }],
        env: { NODE_ENV: 'test' },
      }),
    SigningRejected,
  );
  assert.throws(
    () =>
      new LocalDevSigner({
        credentials: [
          { credentialId: 'dev:garbage', tenantId: 'tenant-a', privateKeyPem: 'not a key' },
        ],
        env: { NODE_ENV: 'test' },
      }),
    SigningRejected,
  );
});

test('local dev signer refuses to run in production', () => {
  const input = generateDevCredential('dev:key-1', 'tenant-a');
  assert.throws(
    () => new LocalDevSigner({ credentials: [input], env: { NODE_ENV: 'production' } }),
    (err: unknown) =>
      err instanceof SigningRejected &&
      (err as Error).message === 'LocalDevSigner refuses to run in production',
  );
});

test('listCredentials is scoped to one tenant', async () => {
  const signer = new LocalDevSigner({
    credentials: [
      generateDevCredential('dev:a-key', 'tenant-a'),
      generateDevCredential('dev:b-key', 'tenant-b'),
    ],
    env: { NODE_ENV: 'test' },
  });
  const a = await signer.listCredentials('tenant-a');
  assert.deepEqual(
    a.map((c) => c.credentialId),
    ['dev:a-key'],
  );
  assert.equal(a[0]?.tenantId, 'tenant-a');
  const b = await signer.listCredentials('tenant-b');
  assert.deepEqual(
    b.map((c) => c.credentialId),
    ['dev:b-key'],
  );
});

test('publicKey rejects unknown credentials; health reflects loaded keys', async () => {
  const { signer, credentialId } = makeSigner();
  await assert.rejects(signer.publicKey('dev:unknown'), SigningRejected);
  assert.ok(Buffer.isBuffer(await signer.publicKey(credentialId)));
  assert.equal(await signer.health(), true);
  const empty = new LocalDevSigner({ credentials: [], env: { NODE_ENV: 'test' } });
  assert.equal(await empty.health(), false);
  assert.deepEqual(await empty.listCredentials('tenant-a'), []);
});

test('signing results contain no private material', async () => {
  const { signer, credentialId } = makeSigner();
  const result: SigningResult = await signer.sign(PAYLOAD, credentialId, { requestId: 'r1' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
  const listed = await signer.listCredentials('tenant-a');
  assert.ok(!JSON.stringify(listed).includes('PRIVATE KEY'));
});

test('capabilities are as specified', () => {
  const { signer } = makeSigner();
  assert.deepEqual(signer.capabilities(), {
    adapterName: LOCAL_DEV_ADAPTER_NAME,
    algorithms: ['ES256'],
    maxPayloadBytes: LOCAL_DEV_MAX_PAYLOAD_BYTES,
    supportsCredentialListing: true,
  });
  assert.equal(LOCAL_DEV_ADAPTER_NAME, 'local-dev');
  assert.equal(LOCAL_DEV_MAX_PAYLOAD_BYTES, 1_048_576);
});
