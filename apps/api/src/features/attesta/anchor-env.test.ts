// Anchoring configuration from the environment (Task15f2): fail closed in production,
// name variables (never values) in errors, and build a working dual anchor in dev.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes } from 'node:crypto';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa } from './testing/fake-tsa';
import { AnchorConfigError, anchorFromEnv, anchorSignerFromEnv, parseLogIndexOffsets } from './anchor-env';
import { generateDevCredential } from './signer-local-dev';

const KEY = generateDevCredential('dev:anchor', 'x').privateKeyPem;

async function fixture() {
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000);
  const tsa = await FakeTsa.create();
  const files: Record<string, string> = {
    '/k/anchor.pem': KEY,
    '/k/rekor.pem': createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(),
    '/k/tsa.pem': tsa.anchorsPem,
    '/k/junk': 'not a key',
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };
  const env: NodeJS.ProcessEnv = {
    ATTESTA_ANCHOR_CREDENTIAL_ID: 'dev:anchor', ATTESTA_DEV_ANCHOR_KEY_FILE: '/k/anchor.pem',
    ATTESTA_REKOR_URL: 'http://rekor.test/', ATTESTA_REKOR_LOG_KEY_FILE: '/k/rekor.pem',
    ATTESTA_TSA_URL: 'http://tsa.test/tsr', ATTESTA_TSA_ANCHORS_FILE: '/k/tsa.pem',
  };
  return { rekor, tsa, read, env };
}

test('dev: the env builds a dual anchor that anchors with the fakes, plus matching verify material', async () => {
  const f = await fixture();
  const built = await anchorFromEnv(f.env, { read: f.read, rekorFetch: f.rekor.fetch, tsaFetch: f.tsa.fetch });
  const out = await built.anchor.anchor(randomBytes(32), 'b');
  assert.equal(out.complete, true);
  assert.equal(built.verify.anchorKeysSpkiDer.length, 1);
  assert.equal(built.verify.tsaAnchors.length, 1);
  assert.equal(built.verify.rekorLogIndexOffsets, undefined);
});

test('production refuses to start until the Task15l platform resolver exists', async () => {
  const f = await fixture();
  assert.throws(() => anchorSignerFromEnv({ ...f.env, NODE_ENV: 'production' }, f.read),
    (e: unknown) => e instanceof AnchorConfigError && /Task15l/.test(e.message));
});

test('missing or unreadable configuration names the variable, never its value', async () => {
  const f = await fixture();
  for (const name of ['ATTESTA_ANCHOR_CREDENTIAL_ID', 'ATTESTA_DEV_ANCHOR_KEY_FILE', 'ATTESTA_REKOR_URL',
    'ATTESTA_REKOR_LOG_KEY_FILE', 'ATTESTA_TSA_URL', 'ATTESTA_TSA_ANCHORS_FILE']) {
    const env = { ...f.env };
    delete env[name];
    await assert.rejects(anchorFromEnv(env, { read: f.read }), (e: unknown) => e instanceof AnchorConfigError && e.message.includes(name));
  }
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_TSA_ANCHORS_FILE: '/secret/path.pem' }, { read: f.read }),
    (e: unknown) => e instanceof AnchorConfigError && !e.message.includes('/secret/path.pem'));
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_REKOR_LOG_KEY_FILE: '/k/junk' }, { read: f.read }), AnchorConfigError);
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_TSA_ANCHORS_FILE: '/k/junk' }, { read: f.read }), AnchorConfigError);
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_ANCHOR_CREDENTIAL_ID: 'kms:anchor' }, { read: f.read }), AnchorConfigError);
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_REKOR_URL: 'http://user:pw@rekor.test' }, { read: f.read }),
    (e: unknown) => e instanceof AnchorConfigError && !e.message.includes('pw'));
  await assert.rejects(anchorFromEnv({ ...f.env, ATTESTA_TSA_URL: 'ftp://tsa.test' }, { read: f.read }), AnchorConfigError);
});

test('log index offsets: decimal tree IDs to non-negative safe integers', () => {
  assert.equal(parseLogIndexOffsets(undefined), undefined);
  assert.equal(parseLogIndexOffsets(' '), undefined);
  assert.deepEqual(parseLogIndexOffsets('{"1193050959916656506": 7376158}'), { '1193050959916656506': 7376158 });
  for (const bad of ['[]', 'null', '{"x": 1}', '{"1": -1}', '{"1": 1.5}', '{"1": "2"}', '{', '{"1": 9007199254740992}']) {
    assert.throws(() => parseLogIndexOffsets(bad), AnchorConfigError, bad);
  }
});
