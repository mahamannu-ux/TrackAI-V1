// Ported from SushiCorp tests/unit/anchor/test_anchor_rekor.py @ 0bd67a5
// (catalog EV-2), against TrackAI's FakeRekor and the real sigstage vector.
// Added: errors.md codes on every failure, the production pin rule, the
// bounded cache, the tree-ID/origin binding, signer-contract wiring, and
// "an unreachable log is never a pass" for every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { leafHash } from './merkle';
import { FakeRekor, REKOR_TREE_ID_HEX } from './testing/fake-rekor';
import {
  AnchorError,
  AnchorInputError,
  ATTESTA_PLATFORM_TENANT_ID,
  BoundedCache,
  anchorSignerFromAdapter,
  type AnchorSigner,
} from './anchor-contract';
import {
  RekorAnchor,
  RekorVerificationError,
  loadLogPublicKey,
  logIdOf,
  proposedEntry,
  verifyCheckpoint,
  verifyRekorEntry,
} from './anchor-rekor';
import { LocalDevSigner, generateDevCredential } from './signer-local-dev';

const URL_ = 'http://rekor.test';
const VECTOR = JSON.parse(readFileSync(join(__dirname, 'vectors', 'rekor', 'sigstage_hashedrekord.json'), 'utf8')) as {
  entry_id: string;
  entry: Record<string, unknown>;
  log_public_key_pem: string;
};
const ROOT_A = createHash('sha256').update('batch a').digest();
const ROOT_B = createHash('sha256').update('batch b').digest();

/** Deterministic (RFC 6979) P-256 signer, like SushiCorp's anchoring key: lets Rekor's 409 dedup show. */
function deterministicSigner(): AnchorSigner & { calls: number } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const spki = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  const s = {
    calls: 0,
    publicKeySpkiDer: async () => Buffer.from(spki),
    sign: async (artifact: Buffer) => {
      s.calls++;
      const digest = createHash('sha256').update(artifact).digest();
      return Buffer.from(p256.sign(new Uint8Array(digest), new Uint8Array(priv), { prehash: false, format: 'der' }));
    },
  };
  return s;
}

/** The platform credential through the frozen signer contract (random nonces, like KMS). */
function devSigner(): AnchorSigner {
  const cred = generateDevCredential('dev:anchor', ATTESTA_PLATFORM_TENANT_ID);
  return anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
}

function pem(key: KeyObject): string {
  return (key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'pem' }).toString();
}

function adapter(rekor: FakeRekor, signer: AnchorSigner, opts: { pinned?: boolean; production?: boolean } = {}): RekorAnchor {
  return new RekorAnchor({
    url: URL_,
    signer,
    fetch: rekor.fetch,
    logPublicKeyPem: opts.pinned === false ? undefined : pem(rekor.logKey),
    production: opts.production ?? false,
  });
}

async function rejectsCode(p: Promise<unknown>, code: string, retryable?: boolean): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof AnchorError, `expected AnchorError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (retryable !== undefined) assert.equal(err.retryable, retryable);
    return true;
  });
}

const otherKey = (): KeyObject => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
const clone = <T>(v: T): T => structuredClone(v);
type Entry = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Real Rekor data (formats are not just self-consistent with our fake)
// ---------------------------------------------------------------------------

test('real sigstage entry verifies under the staging log key', () => {
  const logKey = loadLogPublicKey(VECTOR.log_public_key_pem);
  const v = verifyRekorEntry(VECTOR.entry_id, VECTOR.entry, { logKey });
  assert.equal(v.treeSize, 7376159);
  assert.equal(v.logIndex, 7390977);
  assert.ok(VECTOR.entry_id.startsWith(8050909264565447525n.toString(16).padStart(16, '0')));
  assert.equal(logIdOf(logKey), VECTOR.entry.logID);
});

const realTampers: Array<[string, (e: Entry) => void]> = [
  ['proof hash', (e) => { e.verification.inclusionProof.hashes[0] = '00'.repeat(32); }],
  ['root hash', (e) => { e.verification.inclusionProof.rootHash = '00'.repeat(32); }],
  ['proof index', (e) => { e.verification.inclusionProof.logIndex = 7376157; }],
  ['integratedTime (SET covers it)', (e) => { e.integratedTime += 1; }],
  ['logIndex (SET covers it)', (e) => { e.logIndex += 1; }],
  ['logID', (e) => { e.logID = '00'.repeat(32); }],
  ['SET', (e) => { e.verification.signedEntryTimestamp = Buffer.alloc(70, 0x78).toString('base64'); }],
  ['checkpoint size', (e) => {
    e.verification.inclusionProof.checkpoint = (e.verification.inclusionProof.checkpoint as string).replace('7376159', '7376160');
  }],
  ['body', (e) => { e.body = Buffer.from('{}').toString('base64'); }],
  ['proof hashes uppercase', (e) => {
    e.verification.inclusionProof.hashes = (e.verification.inclusionProof.hashes as string[]).map((h) => h.toUpperCase());
  }],
  ['unsafe integratedTime', (e) => { e.integratedTime = 2 ** 60; }],
  ['checkpoint origin tree id', (e) => {
    e.verification.inclusionProof.checkpoint = (e.verification.inclusionProof.checkpoint as string)
      .replace('8050909264565447525', '8050909264565447526');
  }],
];

for (const [name, mutate] of realTampers) {
  test(`real entry tampering detected: ${name}`, () => {
    const entry = clone(VECTOR.entry) as Entry;
    mutate(entry);
    const logKey = loadLogPublicKey(VECTOR.log_public_key_pem);
    assert.throws(() => verifyRekorEntry(VECTOR.entry_id, entry, { logKey }), RekorVerificationError);
  });
}

test('real entry rejected under a wrong log key', () => {
  const other = createPublicKey(otherKey());
  assert.throws(() => verifyRekorEntry(VECTOR.entry_id, VECTOR.entry, { logKey: other }), /checkpoint/);
});

test('real entry ID must match the body; bare UUID accepted', () => {
  const logKey = loadLogPublicKey(VECTOR.log_public_key_pem);
  const last = VECTOR.entry_id.at(-1) === '0' ? '1' : '0';
  assert.throws(() => verifyRekorEntry(VECTOR.entry_id.slice(0, -1) + last, VECTOR.entry, { logKey }), /UUID/);
  assert.throws(() => verifyRekorEntry('zz' + VECTOR.entry_id.slice(2), VECTOR.entry, { logKey }), /UUID/);
  assert.ok(verifyRekorEntry(VECTOR.entry_id.slice(16), VECTOR.entry, { logKey }));
  const otherPrefix = '0'.repeat(16) + VECTOR.entry_id.slice(16);
  assert.throws(() => verifyRekorEntry(otherPrefix, VECTOR.entry, { logKey }), /tree ID/);
});

test("real entry is not our anchor (someone else's artifact or key)", () => {
  const logKey = loadLogPublicKey(VECTOR.log_public_key_pem);
  assert.throws(() => verifyRekorEntry(VECTOR.entry_id, VECTOR.entry, { logKey, artifact: ROOT_A }), /commit/);
  const ours = Buffer.from(createPublicKey(otherKey()).export({ type: 'spki', format: 'der' }));
  assert.throws(() => verifyRekorEntry(VECTOR.entry_id, VECTOR.entry, { logKey, anchorKeySpkiDer: ours }), /anchoring key|unreadable/);
});

test('malformed entries fail as verification errors, never crash or pass', () => {
  const logKey = loadLogPublicKey(VECTOR.log_public_key_pem);
  for (const bad of [null, [], 'x', {}, { body: 'x' }, { ...clone(VECTOR.entry), verification: null }]) {
    assert.throws(() => verifyRekorEntry(VECTOR.entry_id, bad, { logKey }), RekorVerificationError);
  }
  assert.throws(() => loadLogPublicKey('nope'), RekorVerificationError);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
  assert.throws(() => loadLogPublicKey(pem(rsa)), /unsupported/);
});

// ---------------------------------------------------------------------------
// anchor()
// ---------------------------------------------------------------------------

test('anchor logs the root and returns a verified entry; nothing tenant-identifying is public', async () => {
  const rekor = new FakeRekor();
  const result = await adapter(rekor, devSigner()).anchor(ROOT_A, 't:0-9');
  assert.equal(result.type, 'rekor');
  assert.equal(result.entryId.length, 80);
  assert.ok(result.entryId.startsWith(REKOR_TREE_ID_HEX));
  assert.equal(result.entryId.slice(16), result.uuid);
  assert.equal(result.logIndex, 0);
  assert.match(result.anchoredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  assert.equal((result.entry.verification as Entry).inclusionProof.treeSize, 1);
  const body = JSON.parse(rekor.bodies[0].toString('utf8'));
  assert.equal(body.spec.data.hash.value, createHash('sha256').update(ROOT_A).digest('hex'));
  assert.ok(!rekor.bodies[0].includes('t:0-9'));
  assert.ok(!rekor.bodies[0].includes(ATTESTA_PLATFORM_TENANT_ID));
});

test('resubmission after a restart resolves through 409 to the same entry (deterministic signer)', async () => {
  const rekor = new FakeRekor();
  const signer = deterministicSigner();
  const first = await adapter(rekor, signer).anchor(ROOT_A, 't:0-9');
  const second = await adapter(rekor, signer).anchor(ROOT_A, 't:0-9');
  assert.equal(second.entryId, first.entryId);
  assert.equal(second.logIndex, first.logIndex);
  assert.equal(rekor.bodies.length, 1);
  assert.equal(rekor.posts, 2);
});

test('409 without a Location header resolves from the message', async () => {
  const rekor = new FakeRekor();
  rekor.omitLocation = true;
  const signer = deterministicSigner();
  const first = await adapter(rekor, signer).anchor(ROOT_A, 'b');
  assert.equal((await adapter(rekor, signer).anchor(ROOT_A, 'b')).entryId, first.entryId);
});

test('random-nonce signer after a restart logs a second, still verified entry (documented)', async () => {
  const rekor = new FakeRekor();
  const signer = devSigner();
  const first = await adapter(rekor, signer).anchor(ROOT_A, 'b');
  const second = await adapter(rekor, signer).anchor(ROOT_A, 'b');
  assert.notEqual(second.entryId, first.entryId);
  assert.equal(rekor.bodies.length, 2);
});

test('same adapter returns the cached result; a reused batch_id with another root is refused', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, deterministicSigner());
  const r = await a.anchor(ROOT_A, 'b');
  assert.deepEqual(await a.anchor(ROOT_A, 'b'), r);
  assert.equal(rekor.posts, 1);
  await assert.rejects(a.anchor(ROOT_B, 'b'), AnchorInputError);
});

test('malformed root or batch_id is an input error', async () => {
  const a = adapter(new FakeRekor(), devSigner());
  for (const root of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33)]) {
    await assert.rejects(a.anchor(root, 'b'), AnchorInputError);
  }
  await assert.rejects(a.anchor(ROOT_A, ''), AnchorInputError);
});

test('log errors map to errors.md codes; unreachable is never a pass', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner());
  rekor.down = true;
  await rejectsCode(a.anchor(ROOT_A, 'b1'), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', true);
  rekor.down = false;
  rekor.failStatus = 503;
  await rejectsCode(a.anchor(ROOT_A, 'b1'), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', true);
  rekor.failStatus = 500;
  await rejectsCode(a.anchor(ROOT_A, 'b1'), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', true);
  rekor.failStatus = 400;
  await rejectsCode(a.anchor(ROOT_A, 'b1'), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE', false);
});

test('the request is a hashedrekord the log accepts, and the log checks our signature', async () => {
  const rekor = new FakeRekor();
  const signer = devSigner();
  const sig = await signer.sign(ROOT_A);
  const spki = await signer.publicKeySpkiDer();
  const good = proposedEntry(ROOT_A, sig, spki);
  const bad = structuredClone(good) as Entry;
  bad.spec.data.hash.value = createHash('sha256').update('other').digest('hex');
  const post = (b: unknown) => rekor.fetch(`${URL_}/api/v1/log/entries`, { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await post(bad)).status, 400);
  assert.equal((await post(good)).status, 201);
});

const lyingAtAnchor: Array<[string, (r: FakeRekor) => void]> = [
  ['foreign checkpoint key', (r) => { r.checkpointKey = otherKey(); }],
  ['forged SET', (r) => { r.setKey = otherKey(); }],
  ['tampered proof', (r) => { r.tamper = (_id, e) => { (e as Entry).verification.inclusionProof.rootHash = '00'.repeat(32); }; }],
  ['tampered body', (r) => { r.tamper = (_id, e) => { e.body = Buffer.from('{"kind":"hashedrekord"}').toString('base64'); }; }],
  ['tampered logID', (r) => { r.tamper = (_id, e) => { e.logID = '11'.repeat(32); }; }],
  ['tampered integratedTime', (r) => { r.tamper = (_id, e) => { e.integratedTime = 1; }; }],
  ['missing verification', (r) => { r.tamper = (_id, e) => { delete e.verification; }; }],
];

for (const [name, lie] of lyingAtAnchor) {
  test(`anchor refuses a lying log: ${name}`, async () => {
    const rekor = new FakeRekor();
    lie(rekor);
    await rejectsCode(adapter(rekor, devSigner()).anchor(ROOT_A, 'b'), 'ATTESTA_ANCHOR_LOG_PROOF_INVALID', true);
  });
}

test('a 201 payload that is not one entry is a proof failure', async () => {
  for (const payload of ['not json', '{}', '[]', '{"a":{},"b":{}}', '{"zz":{}}']) {
    const fetchImpl = async () => new Response(payload, { status: 201 });
    const a = new RekorAnchor({ url: URL_, signer: devSigner(), fetch: fetchImpl, logPublicKeyPem: pem(otherKey()), production: false });
    await rejectsCode(a.anchor(ROOT_A, 'b'), 'ATTESTA_ANCHOR_LOG_PROOF_INVALID');
  }
});

test('production refuses to run without a pinned log key; trust on first use only outside it', async () => {
  const rekor = new FakeRekor();
  assert.throws(() => adapter(rekor, devSigner(), { pinned: false, production: true }), (err: unknown) =>
    err instanceof AnchorError && err.code === 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED' && !err.retryable);
  assert.throws(() => new RekorAnchor({ url: URL_, signer: devSigner(), logPublicKeyPem: 'garbage', production: false }),
    (err: unknown) => err instanceof AnchorError && err.code === 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED');
  assert.ok(adapter(rekor, devSigner(), { production: true }));
});

test('trust on first use fetches the key once and keeps it', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner(), { pinned: false });
  assert.equal(a.logKeySource, null);
  await a.anchor(ROOT_A, 'a');
  assert.equal(a.logKeySource, 'first_use');
  rekor.logKey = otherKey();
  rekor.checkpointKey = rekor.logKey;
  rekor.setKey = rekor.logKey;
  await rejectsCode(a.anchor(ROOT_B, 'b'), 'ATTESTA_ANCHOR_LOG_PROOF_INVALID');
});

test('first-use key fetch failures are unavailable, never a pass', async () => {
  const rekor = new FakeRekor();
  rekor.failStatus = 503;
  await rejectsCode(adapter(rekor, devSigner(), { pinned: false }).logKey(), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
  const garbage = async () => new Response('not a key', { status: 200 });
  const a = new RekorAnchor({ url: URL_, signer: devSigner(), fetch: garbage, production: false });
  await rejectsCode(a.logKey(), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
});

test('signer failures keep the signer codes', async () => {
  const unavailable: AnchorSigner = {
    publicKeySpkiDer: async () => Buffer.alloc(0),
    sign: async () => { throw new AnchorError('ATTESTA_SIGNER_UNAVAILABLE', 'down'); },
  };
  await rejectsCode(adapter(new FakeRekor(), unavailable).anchor(ROOT_A, 'b'), 'ATTESTA_SIGNER_UNAVAILABLE', true);
  // A credential for a real tenant cannot sign as the platform.
  const cred = generateDevCredential('dev:anchor', '11111111-1111-4111-8111-111111111111');
  const wrongTenant = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
  await rejectsCode(adapter(new FakeRekor(), wrongTenant).anchor(ROOT_A, 'b'), 'ATTESTA_SIGNER_REJECTED', false);
});

// ---------------------------------------------------------------------------
// verifyInclusion()
// ---------------------------------------------------------------------------

test('verifyInclusion holds as the log grows; bare UUID works; wrong root fails', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner());
  const roots = Array.from({ length: 7 }, (_, i) => createHash('sha256').update(Buffer.from([i])).digest());
  const refs: string[] = [];
  for (let i = 0; i < roots.length; i++) refs.push((await a.anchor(roots[i], `b${i}`)).entryId);
  for (let i = 0; i < refs.length; i++) assert.ok(await a.verifyInclusion(refs[i], roots[i]));
  assert.ok(await a.verifyInclusion(refs[0].slice(16), roots[0]));
  assert.equal(await a.verifyInclusion(refs[0], roots[1]), false);
});

test('verifyInclusion: unknown or malformed refs are false', async () => {
  const a = adapter(new FakeRekor(), devSigner());
  assert.equal(await a.verifyInclusion('ab'.repeat(40), ROOT_A), false);
  assert.equal(await a.verifyInclusion('not-hex/../x', ROOT_A), false);
  assert.equal(await a.verifyInclusion('', ROOT_A), false);
});

test('verifyInclusion: unreachable or 5xx raises, never false and never true', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner());
  const ref = (await a.anchor(ROOT_A, 'b')).entryId;
  rekor.down = true;
  await rejectsCode(a.verifyInclusion(ref, ROOT_A), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
  rekor.down = false;
  rekor.failStatus = 502;
  await rejectsCode(a.verifyInclusion(ref, ROOT_A), 'ATTESTA_ANCHOR_LOG_UNAVAILABLE');
});

for (const attack of ['proof', 'checkpoint_key', 'set_key', 'foreign_anchor_key', 'body_swap'] as const) {
  test(`verifyInclusion catches a lying log: ${attack}`, async () => {
    const rekor = new FakeRekor();
    const a = adapter(rekor, devSigner());
    const ref = await a.anchor(ROOT_A, 'a');
    await a.anchor(ROOT_B, 'b');
    if (attack === 'proof') {
      rekor.tamper = (_id, e) => {
        const p = (e as Entry).verification.inclusionProof;
        if (p.hashes.length > 0) p.hashes[0] = '00'.repeat(32);
        else p.rootHash = '00'.repeat(32);
      };
    } else if (attack === 'checkpoint_key') {
      rekor.checkpointKey = otherKey();
    } else if (attack === 'set_key') {
      rekor.setKey = otherKey();
    } else if (attack === 'foreign_anchor_key') {
      // Someone else logged our root under their own key: not our anchor.
      const other = await adapter(rekor, devSigner()).anchor(ROOT_A, 'x');
      assert.equal(await a.verifyInclusion(other.entryId, ROOT_A), false);
      return;
    } else {
      const otherBody = rekor.bodies[1].toString('base64');
      rekor.tamper = (_id, e) => { e.body = otherBody; };
    }
    assert.equal(await a.verifyInclusion(ref.entryId, ROOT_A), false);
  });
}

test('a log answering GET with a different entry is a proof failure', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner());
  const ref = (await a.anchor(ROOT_A, 'a')).entryId;
  const other = (await a.anchor(ROOT_B, 'b')).entryId;
  const swapped = async (input: string | URL | Request, init?: RequestInit) =>
    rekor.fetch(String(input).replace(ref, other), init);
  const b = new RekorAnchor({ url: URL_, signer: devSigner(), fetch: swapped, logPublicKeyPem: pem(rekor.logKey), production: false });
  await rejectsCode(b.verifyInclusion(ref, ROOT_A), 'ATTESTA_ANCHOR_LOG_PROOF_INVALID');
});

test('health', async () => {
  const rekor = new FakeRekor();
  const a = adapter(rekor, devSigner());
  assert.equal(await a.health(), true);
  rekor.down = true;
  assert.equal(await a.health(), false);
});

// ---------------------------------------------------------------------------
// Checkpoint parsing edge cases, cache bound
// ---------------------------------------------------------------------------

test('checkpoint malformations', async () => {
  const rekor = new FakeRekor();
  const signer = devSigner();
  const r = await adapter(rekor, signer).anchor(ROOT_A, 'b');
  const good = (r.entry.verification as Entry).inclusionProof.checkpoint as string;
  const k = createPublicKey(rekor.logKey);
  assert.equal(verifyCheckpoint(good, k).size, 1);
  const head = good.split('\n\n')[0];
  for (const bad of [
    good.replace('\n\n', '\n'),
    good.replace(/\n$/, ''),
    good.replace('\u2014 ', '- '),
    `${head}\n\n\u2014 host !!!notbase64\n`,
    `${head}\n\n\u2014 host AAAA\n`,
    `${head}\n\n`,
    good.replace('\n1\n', '\nx\n'),
    good.replace('\n1\n', '\n99999999999999999\n'),
  ]) {
    assert.throws(() => verifyCheckpoint(bad, k), RekorVerificationError, JSON.stringify(bad.slice(-40)));
  }
});

test('the adapter batch cache is bounded', async () => {
  const cache = new BoundedCache<string, number>(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.throws(() => new BoundedCache(0), RangeError);
  const rekor = new FakeRekor();
  const a = new RekorAnchor({ url: URL_, signer: devSigner(), fetch: rekor.fetch, logPublicKeyPem: pem(rekor.logKey), production: false, cacheSize: 1 });
  await a.anchor(ROOT_A, 'a');
  await a.anchor(ROOT_B, 'b');
  await a.anchor(ROOT_A, 'a'); // evicted: resubmitted (random nonce → a new entry), still verified
  assert.equal(rekor.posts, 3);
  assert.equal(leafHash(rekor.bodies[2]).length, 32);
});
