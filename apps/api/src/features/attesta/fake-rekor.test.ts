import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { canonicalize } from './canonical';
import { leafHash, merkleRoot, verifyInclusion } from './merkle';
import { FakeRekor, REKOR_TREE_ID_HEX } from './testing/fake-rekor';

const BASE = 'http://rekor.test';

function makeKey(): { privateKey: KeyObject; publicKey: KeyObject; privBytes: Uint8Array; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privBytes = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString('utf8');
  return { privateKey, publicKey, privBytes, pem };
}

function proposal(digest: Buffer, sigDer: Buffer, pem: string): Record<string, unknown> {  return {
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: { hash: { algorithm: 'sha256', value: digest.toString('hex') } },
      signature: {
        content: sigDer.toString('base64'),
        publicKey: { content: Buffer.from(pem, 'utf8').toString('base64') },
      },
    },
  };
}

/** Raw ECDSA over a precomputed digest (what Rekor's `hashedrekord` signs). */
function signDigest(digest: Buffer, privBytes: Uint8Array): Buffer {
  return Buffer.from(p256.sign(new Uint8Array(digest), privBytes, { prehash: false, format: 'der' }));
}

async function submitProposal(
  fake: FakeRekor,
  proposed: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fake.fetch(`${BASE}/api/v1/log/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proposed),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function postEntry(
  fake: FakeRekor,
  digest: Buffer,
  key: { privBytes: Uint8Array; pem: string },
  sigDer?: Buffer,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers; proposed: Record<string, unknown> }> {
  const sig = sigDer ?? signDigest(digest, key.privBytes);
  const proposed = proposal(digest, sig, key.pem);
  const out = await submitProposal(fake, proposed);
  return { ...out, proposed };
}

function logPublicKey(fake: FakeRekor): KeyObject {
  return createPublicKey(fake.logKey);
}

function spkiDer(key: KeyObject): Buffer {
  return Buffer.from(key.export({ type: 'spki', format: 'der' }));
}

test('valid hashedrekord submits and every proof verifies', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const digest = createHash('sha256').update('batch root').digest();
  const { status, body } = await postEntry(fake, digest, key);
  assert.equal(status, 201);
  const entryId = Object.keys(body)[0];
  const uuid = entryId.slice(16);
  assert.equal(entryId.slice(0, 16), REKOR_TREE_ID_HEX);
  const entry = body[entryId] as Record<string, unknown>;
  assert.equal(uuid, leafHash(Buffer.from(entry['body'] as string, 'base64')).toString('hex'));

  // Inclusion proof recomputes the stated root (RFC 9162 2.1.3.2).
  const proof = (entry['verification'] as Record<string, unknown>)['inclusionProof'] as Record<string, unknown>;
  const root = Buffer.from(proof['rootHash'] as string, 'hex');
  assert.ok(
    verifyInclusion(
      Buffer.from(entry['body'] as string, 'base64'),
      proof['logIndex'] as number,
      proof['treeSize'] as number,
      (proof['hashes'] as string[]).map((h) => Buffer.from(h, 'hex')),
      root,
    ),
  );

  // Checkpoint commits to the same root and is signed by the log key.
  const checkpoint = proof['checkpoint'] as string;
  const cpLines = checkpoint.split('\n');
  assert.equal(cpLines[0], `${'rekor.local'} - ${0x1122334455667788n.toString(10)}`);
  assert.equal(cpLines[1], '1');
  assert.equal(cpLines[2], root.toString('base64'));
  assert.equal(cpLines[3], 'Timestamp: 1');
  assert.equal(cpLines[4], '');
  const sigLine = cpLines[5];
  assert.equal(cpLines[6], '');
  assert.match(sigLine, /^— rekor\.local /);
  const sigAndHint = Buffer.from(sigLine.split(' ')[2], 'base64');
  const hint = sigAndHint.subarray(0, 4);
  const cpSig = sigAndHint.subarray(4);
  assert.deepEqual(hint, createHash('sha256').update(spkiDer(logPublicKey(fake))).digest().subarray(0, 4));
  const note = cpLines.slice(0, 4).join('\n') + '\n';
  assert.ok(verify('sha256', Buffer.from(note, 'utf8'), logPublicKey(fake), cpSig));

  // SET is signed by the log key over the canonical entry fields.
  const setB64 = (entry['verification'] as Record<string, unknown>)['signedEntryTimestamp'] as string;
  const setData = {
    body: entry['body'],
    integratedTime: entry['integratedTime'],
    logID: entry['logID'],
    logIndex: entry['logIndex'],
  };
  assert.ok(
    verify('sha256', Buffer.from(canonicalize(setData), 'utf8'), logPublicKey(fake), Buffer.from(setB64, 'base64')),
  );
  assert.equal(entry['logID'], createHash('sha256').update(spkiDer(logPublicKey(fake))).digest('hex'));
  assert.equal(entry['integratedTime'], 1_790_000_001);
});

test('resubmission is a 409 with Location, omitted under omitLocation', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const digest = createHash('sha256').update('same root').digest();
  const first = await postEntry(fake, digest, key);
  assert.equal(first.status, 201);
  const entryId = Object.keys(first.body)[0];
  const second = await postEntry(fake, digest, key);
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('Location'), `/api/v1/log/entries/${entryId}`);
  assert.match(second.body['message'] as string, /already exists/);

  fake.omitLocation = true;
  const third = await postEntry(fake, digest, key);
  assert.equal(third.status, 409);
  assert.equal(third.headers.get('Location'), null);
});

test('a POST body sent as bytes submits like a string', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const digest = createHash('sha256').update('bytes-body').digest();
  const proposed = proposal(digest, signDigest(digest, key.privBytes), key.pem);
  const res = await fake.fetch(`${BASE}/api/v1/log/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(proposed), 'utf8'),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  const entryId = Object.keys(body)[0];
  assert.equal(entryId.slice(16), leafHash(Buffer.from(canonicalize(proposed), 'utf8')).toString('hex'));
});

test('a well-signed but uncanonicalizable entry is a 400, not a throw', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const digest = createHash('sha256').update('uncanonical').digest();
  const proposed = { ...proposal(digest, signDigest(digest, key.privBytes), key.pem), extra: 2 ** 60 };
  const { status, body } = await submitProposal(fake, proposed);
  assert.equal(status, 400);
  assert.match((body['message'] as string) ?? '', /^validation: /);
  assert.equal(fake.bodies.length, 0);
});

test('a high-S signature is accepted', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const digest = createHash('sha256').update('high-s root').digest();
  const low = p256.Signature.fromBytes(p256.sign(new Uint8Array(digest), key.privBytes, { prehash: false }));
  // SEC2 P-256 group order (noble v2 does not expose the curve constants).
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const highS = (n - low.s) % n;
  assert.ok(highS > n / 2n, 'test setup: s must really be high');
  const highDer = Buffer.from(new p256.Signature(low.r, highS).toBytes('der'));
  const { status } = await postEntry(fake, digest, key, highDer);
  assert.equal(status, 201);
});

test('a wrong digest or a foreign key is a 400', async () => {
  const fake = new FakeRekor();
  const signer = makeKey();
  const other = makeKey();
  const digest = createHash('sha256').update('claimed').digest();
  const actual = createHash('sha256').update('actual').digest();

  // Signed `actual`, stated `claimed`.
  const badDigest = await postEntry(fake, digest, signer, signDigest(actual, signer.privBytes));
  assert.equal(badDigest.status, 400);
  assert.match((badDigest.body['message'] as string) ?? '', /^validation: /);

  // Signed by `signer`, attributed to `other`.
  const foreign = await postEntry(fake, digest, { privBytes: signer.privBytes, pem: other.pem });
  assert.equal(foreign.status, 400);

  // Garbage signature bytes.
  const garbage = await postEntry(fake, digest, signer, Buffer.from('not-a-signature'));
  assert.equal(garbage.status, 400);
  assert.equal(fake.bodies.length, 0);
});

test('GET by UUID and entry ID, treeSize growth, publicKey', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const d1 = createHash('sha256').update('one').digest();
  const d2 = createHash('sha256').update('two').digest();
  const r1 = await postEntry(fake, d1, key);
  const id1 = Object.keys(r1.body)[0];
  await postEntry(fake, d2, key);

  const byEntry = await (await fake.fetch(`${BASE}/api/v1/log/entries/${id1}`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(byEntry), [id1]);
  const byUuid = await (await fake.fetch(`${BASE}/api/v1/log/entries/${id1.slice(16).toUpperCase()}`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(byUuid), [id1]);
  const missing = await fake.fetch(`${BASE}/api/v1/log/entries/${'ab'.repeat(32)}`);
  assert.equal(missing.status, 404);

  const info = (await (await fake.fetch(`${BASE}/api/v1/log`)).json()) as { treeSize: number };
  assert.equal(info.treeSize, 2);

  const pemRes = await fake.fetch(`${BASE}/api/v1/log/publicKey`);
  assert.equal(pemRes.status, 200);
  const pemText = await pemRes.text();
  assert.ok(pemText.startsWith('-----BEGIN PUBLIC KEY-----'));
  assert.deepEqual(spkiDer(createPublicKey(pemText)), spkiDer(logPublicKey(fake)));

  const unknown = await fake.fetch(`${BASE}/api/v1/log/nope`);
  assert.equal(unknown.status, 404);
});

test('down rejects with TypeError; failStatus answers every route', async () => {
  const fake = new FakeRekor();
  fake.down = true;
  await assert.rejects(fake.fetch(`${BASE}/api/v1/log`), TypeError);
  fake.down = false;

  fake.failStatus = 503;
  const res = await fake.fetch(`${BASE}/api/v1/log`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { code: 503, message: 'boom' });
  fake.failStatus = null;
  assert.equal(((await (await fake.fetch(`${BASE}/api/v1/log`)).json()) as { treeSize: number }).treeSize, 0);
});

test('forged checkpoint and SET keys do not verify under the log key', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const forge = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  fake.checkpointKey = forge;
  fake.setKey = forge;
  const digest = createHash('sha256').update('forged').digest();
  const { status, body } = await postEntry(fake, digest, key);
  assert.equal(status, 201);
  const entryId = Object.keys(body)[0];
  const entry = body[entryId] as Record<string, unknown>;
  const proof = (entry['verification'] as Record<string, unknown>)['inclusionProof'] as Record<string, unknown>;

  const cpLines = (proof['checkpoint'] as string).split('\n');
  const note = cpLines.slice(0, 4).join('\n') + '\n';
  const forgedCpSig = Buffer.from(cpLines[5].split(' ')[2], 'base64').subarray(4);
  assert.equal(verify('sha256', Buffer.from(note, 'utf8'), logPublicKey(fake), forgedCpSig), false);

  const setData = {
    body: entry['body'],
    integratedTime: entry['integratedTime'],
    logID: entry['logID'],
    logIndex: entry['logIndex'],
  };
  const setB64 = (entry['verification'] as Record<string, unknown>)['signedEntryTimestamp'] as string;
  assert.equal(
    verify('sha256', Buffer.from(canonicalize(setData), 'utf8'), logPublicKey(fake), Buffer.from(setB64, 'base64')),
    false,
  );
});

test('tamper changes exactly what it mutates', async () => {
  const fake = new FakeRekor();
  const key = makeKey();
  const clean = await postEntry(fake, createHash('sha256').update('clean').digest(), key);
  const cleanEntry = clean.body[Object.keys(clean.body)[0]] as Record<string, unknown>;

  fake.tamper = (_id, entry) => {
    entry['integratedTime'] = 12345;
  };
  const dirty = createHash('sha256').update('dirty').digest();
  const { status, body, proposed } = await postEntry(fake, dirty, key);
  assert.equal(status, 201);
  const entry = body[Object.keys(body)[0]] as Record<string, unknown>;
  assert.equal(entry['integratedTime'], 12345);
  assert.equal(entry['body'], Buffer.from(canonicalize(proposed), 'utf8').toString('base64'));
  assert.equal(entry['logIndex'], 1);
  assert.equal(entry['logID'], cleanEntry['logID']);
});

test('root matches an independent RFC 6962 MTH over leaf hashes', async () => {
  function leaf(data: Buffer): Buffer {
    return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), data])).digest();
  }
  function node(a: Buffer, b: Buffer): Buffer {
    return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), a, b])).digest();
  }
  function split(n: number): number {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k;
  }
  function mth(hashes: Buffer[]): Buffer {
    if (hashes.length === 1) return hashes[0];
    const k = split(hashes.length);
    return node(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
  }

  const fake = new FakeRekor();
  const key = makeKey();
  for (const label of ['a', 'b', 'c']) {
    await postEntry(fake, createHash('sha256').update(label).digest(), key);
  }
  const expected = mth(fake.bodies.map((b) => leaf(b))).toString('hex');
  assert.equal(expected, merkleRoot(fake.bodies).toString('hex'));
  const lastId = `${REKOR_TREE_ID_HEX}${leafHash(fake.bodies[2]).toString('hex')}`;
  const entry = (await (await fake.fetch(`${BASE}/api/v1/log/entries/${lastId}`)).json()) as Record<string, unknown>;
  const proof = ((entry[lastId] as Record<string, unknown>)['verification'] as Record<string, unknown>)[
    'inclusionProof'
  ] as Record<string, unknown>;
  assert.equal(proof['rootHash'], expected);
});

test('sigstage vector loads and matches fake entry shape', async () => {
  const vector = JSON.parse(
    readFileSync(join(__dirname, 'vectors', 'rekor', 'sigstage_hashedrekord.json'), 'utf8'),
  ) as {
    entry_id: string;
    entry: Record<string, unknown>;
    log_public_key_pem: string;
  };
  const entry = vector.entry;
  const bodyBytes = Buffer.from(entry['body'] as string, 'base64');
  // The entry ID binds the tree prefix to the body: prefix + leaf hash.
  assert.match(vector.entry_id.slice(0, 16), /^[0-9a-f]{16}$/);
  assert.equal(vector.entry_id.slice(16), leafHash(bodyBytes).toString('hex'));

  const fake = new FakeRekor();
  const key = makeKey();
  const { body } = await postEntry(fake, createHash('sha256').update('shape').digest(), key);
  const fakeEntry = body[Object.keys(body)[0]] as Record<string, unknown>;
  const shapeOf = (v: unknown): unknown =>
    Array.isArray(v)
      ? 'array'
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, shapeOf(val)]))
        : typeof v;
  // Same field names and the same value types throughout the entry.
  assert.deepEqual(shapeOf(fakeEntry), shapeOf(entry));
  assert.ok((vector.log_public_key_pem as string).includes('BEGIN PUBLIC KEY'));
});
