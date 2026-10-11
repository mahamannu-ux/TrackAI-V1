import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  IN_TOTO_PAYLOAD_TYPE,
  pae,
  signEnvelope,
  verifyEnvelope,
  type DsseEnvelope,
} from './dsse';

test('PAE matches the DSSE known answer', () => {
  assert.equal(
    pae('http://example.com/HelloWorld', Buffer.from('hello world')).toString('utf8'),
    'DSSEv1 29 http://example.com/HelloWorld 11 hello world',
  );
});

test('PAE lengths count bytes, not characters', () => {
  const payload = Buffer.from('€', 'utf8');
  assert.equal(payload.length, 3);
  const out = pae('t', payload);
  assert.deepEqual(out, Buffer.concat([Buffer.from('DSSEv1 1 t 3 ', 'utf8'), payload]));
});

test('in-toto payload type constant', () => {
  assert.equal(IN_TOTO_PAYLOAD_TYPE, 'application/vnd.in-toto+json');
});

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEYS = { 'test-key-1': publicKey };

async function signed(payloadType: string, payload: Buffer): Promise<DsseEnvelope> {
  return signEnvelope(payloadType, payload, async (paeBytes) => ({
    keyid: 'test-key-1',
    sig: sign('sha256', paeBytes, privateKey),
  }));
}

test('sign/verify round-trips with a P-256 key', async () => {
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('{"_type":"x"}'));
  assert.equal(env.payloadType, IN_TOTO_PAYLOAD_TYPE);
  assert.equal(env.payload, Buffer.from('{"_type":"x"}').toString('base64'));
  assert.equal(env.signatures.length, 1);
  const result = verifyEnvelope(env, KEYS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.verifiedKeyids, ['test-key-1']);
  assert.deepEqual(result.errors, []);
});

test('a tampered payload does not verify', async () => {
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('hello'));
  const tampered: DsseEnvelope = {
    ...env,
    payload: Buffer.from('hellx').toString('base64'),
  };
  const result = verifyEnvelope(tampered, KEYS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.verifiedKeyids, []);
  assert.ok(result.errors.length > 0);
});

test('a tampered payloadType does not verify', async () => {
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('hello'));
  const result = verifyEnvelope({ ...env, payloadType: 'application/json' }, KEYS);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('an unknown keyid fails closed without throwing', async () => {
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('hello'));
  const result = verifyEnvelope(env, { 'other-key': publicKey });
  assert.equal(result.ok, false);
  assert.deepEqual(result.verifiedKeyids, []);
  assert.ok(result.errors.some((e) => e.includes('unknown keyid')));
});

test('empty signatures fail without throwing', () => {
  const result = verifyEnvelope(
    { payload: Buffer.from('hello').toString('base64'), payloadType: 't', signatures: [] },
    KEYS,
  );
  assert.equal(result.ok, false);
});

test('malformed base64 fails without throwing', async () => {
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('hello'));
  for (const broken of [
    { ...env, payload: '!!!not-base64!!!' },
    { ...env, signatures: [{ keyid: 'test-key-1', sig: '!!!not-base64!!!' }] },
    { ...env, signatures: [{ keyid: 'test-key-1', sig: '' }] },
  ]) {
    const result = verifyEnvelope(broken, KEYS);
    assert.equal(result.ok, false, JSON.stringify(broken.signatures));
    assert.ok(result.errors.length > 0);
  }
});

test('a signature from another key does not verify', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = await signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from('hello'), async (paeBytes) => ({
    keyid: 'test-key-1',
    sig: sign('sha256', paeBytes, other.privateKey),
  }));
  const result = verifyEnvelope(env, KEYS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.verifiedKeyids, []);
});

test('malformed envelopes fail without throwing', () => {
  const bad: unknown[] = [null, [], 'x', {}, { payload: 'eA==', payloadType: 't' }];
  for (const b of bad) {
    const result = verifyEnvelope(b as DsseEnvelope, KEYS);
    assert.equal(result.ok, false, JSON.stringify(b));
  }
});

test('verification works from exported public keys', async () => {
  const jwk = publicKey.export({ format: 'jwk' });
  const reimported = createPublicKey({ key: jwk, format: 'jwk' });
  void createPrivateKey(privateKey.export({ format: 'pem', type: 'sec1' }));
  const env = await signed(IN_TOTO_PAYLOAD_TYPE, Buffer.from('interop'));
  const result = verifyEnvelope(env, { 'test-key-1': reimported });
  assert.equal(result.ok, true);
});
