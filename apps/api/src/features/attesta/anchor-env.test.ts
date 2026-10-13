// Anchoring configuration from the environment (Task15f2): fail closed in production,
// name variables (never values) in errors, and build a working dual anchor in dev.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes } from 'node:crypto';
import { FakeRekor, REKOR_TREE_ID_DEC } from './testing/fake-rekor';
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

test('a pinned shard offset reaches the verifier: the fake log\'s tree with offset 1 is refused, with 0 accepted', async () => {
  const f = await fixture();
  const opts = { read: f.read, rekorFetch: f.rekor.fetch, tsaFetch: f.tsa.fetch };
  const wrong = await anchorFromEnv({ ...f.env, ATTESTA_REKOR_LOG_INDEX_OFFSETS: `{"${REKOR_TREE_ID_DEC}": 1}` }, opts);
  const out = await wrong.anchor.anchor(randomBytes(32), 'b1');
  assert.deepEqual(out.rekor, { status: 'failed', code: 'ATTESTA_ANCHOR_LOG_PROOF_INVALID', retryable: true });
  const right = await anchorFromEnv({ ...f.env, ATTESTA_REKOR_LOG_INDEX_OFFSETS: `{"${REKOR_TREE_ID_DEC}": 0}` }, opts);
  assert.equal((await right.anchor.anchor(randomBytes(32), 'b2')).complete, true);
});

test('production never uses the development key: the anchor key comes from the trust inventory (Task15l2)', async () => {
  const f = await fixture();
  assert.throws(() => anchorSignerFromEnv({ ...f.env, NODE_ENV: 'production' }, f.read),
    (e: unknown) => e instanceof AnchorConfigError && /trust inventory/.test(e.message));
  // Without a pinned root the production branch does not start (more in trust-resolver.test.ts).
  await assert.rejects(anchorFromEnv({ ...f.env, NODE_ENV: 'production' }, { read: f.read }),
    (e: unknown) => e instanceof AnchorConfigError && /ATTESTA_TRUST_ROOT_KEYIDS/.test(e.message));
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
  // Keyed by the 16-hex tree ID, the form verifyRekorEntry derives from the checkpoint origin.
  assert.deepEqual(parseLogIndexOffsets('{"1193050959916656506": 7376158}'), { '108e9186e8c5677a': 7376158 });
  assert.deepEqual(parseLogIndexOffsets('{"1": 1}'), { '0000000000000001': 1 });
  for (const bad of ['[]', 'null', '{"x": 1}', '{"1": -1}', '{"1": 1.5}', '{"1": "2"}', '{', '{"1": 9007199254740992}',
    '{"18446744073709551616": 1}', '{"1": 1, "01": 2}', '{"ab": 1}']) {
    assert.throws(() => parseLogIndexOffsets(bad), AnchorConfigError, bad);
  }
});
