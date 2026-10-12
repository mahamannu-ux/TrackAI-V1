// Ported from SushiCorp tests/unit/anchor/test_anchor_tsa.py @ 0bd67a5
// (catalog EV-2), against TrackAI's FakeTsa. Every way a reply can be wrong
// is its own case and must fail with an errors.md code, never become an
// anchor. Added: the genTime window, three-state revocation, bounded cache,
// and OpenSSL (`openssl ts -verify`) as an independent oracle on good and
// corrupted tokens (Task15e lesson; skipped when OpenSSL is absent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { FakeTsa, TSA_POLICY, TSA_URL, generateTsaKeyPair, makeCa, makeTsaCert } from './testing/fake-tsa';
import { AnchorError, AnchorInputError } from './anchor-contract';
import {
  MAX_TOKEN_CERTS,
  TimestampRejectedError,
  TimestampVerificationError,
  TsaAnchor,
  buildTimeStampReq,
  checkTsaRevocation,
  loadTrustAnchors,
  newNonce,
  tokenFromResponse,
  tsaTokenRef,
  verifyTimestampToken,
  type TsaRevocationChecker,
} from './anchor-tsa';

const ROOT = randomBytes(32);
const CODE_SIGNING = '1.3.6.1.5.5.7.3.3';
const TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

function pem(cert: pkijs.Certificate): string {
  const b64 = Buffer.from(cert.toSchema(true).toBER(false)).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
}

function adapter(fake: FakeTsa, opts: { anchors?: string; revocation?: TsaRevocationChecker; cacheSize?: number } = {}): TsaAnchor {
  return new TsaAnchor({
    url: TSA_URL,
    trustAnchorsPem: opts.anchors ?? fake.anchorsPem,
    fetch: fake.fetch,
    revocation: opts.revocation,
    cacheSize: opts.cacheSize,
  });
}

async function bad(fake: FakeTsa, code: string, match: RegExp, opts: { anchors?: string } = {}): Promise<void> {
  await assert.rejects(adapter(fake, opts).anchor(ROOT, 'b'), (err: unknown) => {
    assert.ok(err instanceof AnchorError, String(err));
    assert.equal(err.code, code);
    assert.equal(err.retryable, true);
    assert.match(err.message, match);
    return true;
  });
}

const sha256 = (d: Buffer): Buffer => createHash('sha256').update(d).digest();

// -- the happy path ----------------------------------------------------------

test('anchor returns a verified token; unknown revocation is stated, never clean', async () => {
  const tsa = await FakeTsa.create();
  const a = adapter(tsa);
  const result = await a.anchor(ROOT, 'b1');
  assert.equal(result.type, 'tsa');
  assert.equal(result.ref, tsaTokenRef(result.tokenDer));
  assert.match(result.anchoredAt, /Z$/);
  assert.equal(result.policy, TSA_POLICY);
  assert.deepEqual(result.revocation, { status: 'unknown', reason: 'no_source_configured' });
  const info = verifyTimestampToken(result.tokenDer, ROOT, loadTrustAnchors(tsa.anchorsPem));
  assert.equal(info.hashAlgorithm, 'sha256');
  assert.equal(info.signerSubject, 'Fake TSA Unit 1');
  assert.ok(info.nonce !== null && info.nonce > 0n);
  assert.equal(info.serialNumber, '1001');
  assert.ok(a.verifyToken(result.tokenDer, ROOT));
  assert.equal(a.verifyToken(result.tokenDer, randomBytes(32)), null);
});

test('idempotent on batch_id; a reused batch_id with another root is refused; cache is bounded', async () => {
  const tsa = await FakeTsa.create();
  const a = adapter(tsa, { cacheSize: 1 });
  const first = await a.anchor(ROOT, 'b1');
  assert.deepEqual(await a.anchor(ROOT, 'b1'), first);
  assert.equal(tsa.posts, 1);
  await assert.rejects(a.anchor(randomBytes(32), 'b1'), AnchorInputError);
  await a.anchor(randomBytes(32), 'b2');
  await a.anchor(ROOT, 'b1'); // evicted: a new token
  assert.equal(tsa.posts, 3);
});

test('contract input checks', async () => {
  const tsa = await FakeTsa.create();
  const a = adapter(tsa);
  await assert.rejects(a.anchor(Buffer.from('short'), 'b'), AnchorInputError);
  await assert.rejects(a.anchor(ROOT, ''), AnchorInputError);
  assert.throws(() => new TsaAnchor({ url: '', trustAnchorsPem: tsa.anchorsPem }), RangeError);
  assert.throws(() => new TsaAnchor({ url: TSA_URL, trustAnchorsPem: '' }), TimestampVerificationError);
  assert.throws(() => verifyTimestampToken(Buffer.alloc(1), ROOT, []), /no TSA trust anchors/);
});

test('ESS v1 + RSA signer + intermediate chain verifies', async () => {
  const fake = await FakeTsa.create({ essV1: true });
  const inter = await makeTsaCert(fake.rootKey.privateKey, fake.root, { ca: true, eku: [], cn: 'Fake TSA Intermediate' });
  const leaf = await makeTsaCert(inter.key.privateKey, inter.cert, { key: await generateTsaKeyPair('RSA') });
  fake.key = leaf.key;
  fake.cert = leaf.cert;
  fake.chain = [inter.cert];
  assert.ok((await adapter(fake).anchor(ROOT, 'b')).tokenDer.length > 0);
});

test('a pinned TSA certificate is its own anchor', async () => {
  const tsa = await FakeTsa.create();
  assert.ok(await adapter(tsa, { anchors: pem(tsa.cert) }).anchor(ROOT, 'b'));
});

test('health', async () => {
  const tsa = await FakeTsa.create();
  const a = adapter(tsa);
  assert.equal(await a.health(), true);
  tsa.down = true;
  assert.equal(await a.health(), false);
});

// -- failures: TSA_UNAVAILABLE (could not get a token) ------------------------

test('transport failures, HTTP status, content type and refusal are TSA_UNAVAILABLE', async () => {
  const tsa = await FakeTsa.create({ down: true });
  await bad(tsa, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', /unreachable/);
  tsa.down = false;
  tsa.httpStatus = 503;
  await bad(tsa, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', /HTTP 503/);
  tsa.httpStatus = 200;
  tsa.contentType = 'text/html';
  await bad(tsa, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', /text\/html/);
  tsa.contentType = 'application/timestamp-reply';
  tsa.status = 'rejection';
  await bad(tsa, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', /refused/);
  tsa.status = 'waiting';
  await bad(tsa, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', /refused/);
});

test('garbage replies and tokens fail as verification errors', async () => {
  const tsa = await FakeTsa.create();
  assert.throws(() => tokenFromResponse(Buffer.from('not der')), TimestampVerificationError);
  assert.throws(() => verifyTimestampToken(Buffer.from('not der'), ROOT, loadTrustAnchors(tsa.anchorsPem)), TimestampVerificationError);
  const token = await tsa.token(sha256(ROOT), 'sha256', 5n);
  assert.throws(() => verifyTimestampToken(Buffer.concat([token, Buffer.from([0])]), ROOT, loadTrustAnchors(tsa.anchorsPem)), /malformed/);
  for (let i = 0; i < 40; i++) {
    const cut = token.subarray(0, Math.floor((token.length * i) / 40));
    assert.throws(() => verifyTimestampToken(cut, ROOT, loadTrustAnchors(tsa.anchorsPem)), TimestampVerificationError);
  }
  // A granted status with no token.
  const grantedEmpty = Buffer.from(new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Integer({ value: 0 })] })] }).toBER(false));
  assert.throws(() => tokenFromResponse(grantedEmpty), /no token/);
  assert.throws(() => tokenFromResponse(Buffer.from(new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Integer({ value: 2 })] })] }).toBER(false))), TimestampRejectedError);
});

// -- failures: TSA_TOKEN_INVALID (a token that does not verify) ----------------

const I = 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID';

test('wrong imprint', async () => {
  await bad(await FakeTsa.create({ imprintOverride: Buffer.alloc(32, 1) }), I, /imprint/);
});

test('wrong nonce', async () => {
  await bad(await FakeTsa.create({ nonceOffset: 1 }), I, /nonce/);
});

test('missing nonce when one was sent', async () => {
  await bad(await FakeTsa.create({ tamper: (f) => { delete f.nonce; } }), I, /nonce/);
});

test('corrupt signature', async () => {
  await bad(await FakeTsa.create({ corruptSignature: true }), I, /signature does not verify/);
});

test('untrusted chain', async () => {
  const tsa = await FakeTsa.create();
  const other = await makeCa("Someone Else's Root");
  await bad(tsa, I, /does not chain/, { anchors: pem(other.cert) });
});

test('signed attribute failures', async () => {
  const cases: Array<[Parameters<typeof FakeTsa.create>[0], RegExp]> = [
    [{ digestOverride: Buffer.alloc(32, 2) }, /message digest/],
    [{ contentTypeAttr: 'data' }, /content-type/],
    [{ omitEss: true }, /ESS/],
    [{ includeCerts: false }, /not in the token/],
  ];
  for (const [init, match] of cases) await bad(await FakeTsa.create(init), I, match);
});

test('ESS naming another certificate', async () => {
  const fake = await FakeTsa.create();
  fake.essCert = (await makeTsaCert(fake.rootKey.privateKey, fake.root, { key: fake.key })).cert;
  await bad(fake, I, /does not name the signer/);
});

test('certificate policy failures: EKU and validity at genTime', async () => {
  const now = Date.now();
  const cases: Array<[Parameters<typeof makeTsaCert>[2], RegExp]> = [
    [{ eku: [CODE_SIGNING] }, /time-stamping certificate/],
    [{ ekuCritical: false }, /time-stamping certificate/],
    [{ eku: [] }, /no extended key usage/],
    [{ eku: [TIME_STAMPING, CODE_SIGNING] }, /time-stamping certificate/],
    [{ notBefore: new Date(now - 10 * 86400_000), notAfter: new Date(now - 86400_000) }, /not valid at genTime/],
    [{ notBefore: new Date(now + 86400_000), notAfter: new Date(now + 10 * 86400_000) }, /not valid at genTime/],
  ];
  for (const [opts, match] of cases) {
    const fake = await FakeTsa.create();
    const leaf = await makeTsaCert(fake.rootKey.privateKey, fake.root, opts);
    fake.key = leaf.key;
    fake.cert = leaf.cert;
    await bad(fake, I, match);
  }
});

test('an intermediate must be a CA', async () => {
  const fake = await FakeTsa.create();
  const inter = await makeTsaCert(fake.rootKey.privateKey, fake.root, { ca: false, eku: [], cn: 'Not a CA' });
  const leaf = await makeTsaCert(inter.key.privateKey, inter.cert);
  fake.key = leaf.key;
  fake.cert = leaf.cert;
  fake.chain = [inter.cert];
  await bad(fake, I, /through CA certificates/);
});

test('TSTInfo version 2 is refused', async () => {
  await bad(await FakeTsa.create({ tamper: (f) => { f.version = 2; } }), I, /version/);
});

test('imprint over a weak hash is refused', async () => {
  const tsa = await FakeTsa.create();
  const token = await tsa.token(createHash('sha1').update(ROOT).digest(), 'sha1', 9n);
  assert.throws(() => verifyTimestampToken(token, ROOT, loadTrustAnchors(tsa.anchorsPem)), /imprint hash/);
});

// -- genTime bound (closes SushiCorp A2b limitation #8) -------------------------

test('genTime outside the request window (backdated or future) is refused', async () => {
  await bad(await FakeTsa.create({ genTime: new Date(Date.now() - 3600_000) }), I, /genTime is outside/);
  await bad(await FakeTsa.create({ genTime: new Date(Date.now() + 3600_000) }), I, /genTime is outside/);
  // Within the skew is accepted.
  assert.ok(await adapter(await FakeTsa.create({ genTime: new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000) })).anchor(ROOT, 'b'));
});

test('offline verify applies a caller window too', async () => {
  const tsa = await FakeTsa.create();
  const token = await tsa.token(sha256(ROOT), 'sha256', 3n);
  const anchors = loadTrustAnchors(tsa.anchorsPem);
  assert.ok(verifyTimestampToken(token, ROOT, anchors, { genTimeNotBefore: new Date(Date.now() - 60_000) }));
  assert.throws(() => verifyTimestampToken(token, ROOT, anchors, { genTimeNotAfter: new Date(Date.now() - 60_000) }), /outside/);
});

// -- revocation: three states, UNKNOWN never CLEAN ------------------------------

test('revocation: revoked fails, clean passes, errors and junk are unknown', async () => {
  const tsa = await FakeTsa.create();
  const revoked: TsaRevocationChecker = { check: async () => ({ status: 'revoked', reason: 'ocsp_revoked' }) };
  await assert.rejects(adapter(tsa, { revocation: revoked }).anchor(ROOT, 'r'), (e: unknown) =>
    e instanceof AnchorError && e.code === I && /revoked/.test(e.message));
  const clean: TsaRevocationChecker = { check: async () => ({ status: 'clean', reason: 'ocsp_good' }) };
  assert.deepEqual((await adapter(tsa, { revocation: clean }).anchor(ROOT, 'c')).revocation, { status: 'clean', reason: 'ocsp_good' });
  const throws: TsaRevocationChecker = { check: async () => { throw new Error('timeout'); } };
  assert.deepEqual((await adapter(tsa, { revocation: throws }).anchor(ROOT, 't')).revocation, { status: 'unknown', reason: 'source_error' });
  const junk = { check: async () => ({ status: 'CLEAN', reason: 1 }) } as unknown as TsaRevocationChecker;
  assert.deepEqual((await adapter(tsa, { revocation: junk }).anchor(ROOT, 'j')).revocation, { status: 'unknown', reason: 'malformed_answer' });
  const info = verifyTimestampToken(await tsa.token(sha256(ROOT), 'sha256', 1n), ROOT, loadTrustAnchors(tsa.anchorsPem));
  let seen: [Buffer, Buffer | null] | null = null;
  await checkTsaRevocation(info, { check: async (c, i) => { seen = [c, i]; return { status: 'unknown', reason: 'x' }; } });
  assert.ok(seen && (seen as [Buffer, Buffer | null])[0].equals(info.signerCertDer));
  assert.ok((seen as unknown as [Buffer, Buffer])[1].equals(Buffer.from(tsa.root.toSchema(true).toBER(false))));
});

// -- request, chains, bounds ----------------------------------------------------

test('the request is well formed: v1, sha256 imprint of the root, nonce, certReq', () => {
  const req = buildTimeStampReq(ROOT, 7n);
  const seq = asn1js.fromBER(new Uint8Array(req).buffer).result as asn1js.Sequence;
  const parts = seq.valueBlock.value;
  assert.equal((parts[0] as asn1js.Integer).valueBlock.valueDec, 1);
  const imprint = (parts[1] as asn1js.Sequence).valueBlock.value;
  assert.deepEqual(Buffer.from((imprint[1] as asn1js.OctetString).valueBlock.valueHexView), sha256(ROOT));
  assert.equal((parts[2] as asn1js.Integer).valueBlock.valueDec, 7);
  assert.equal((parts[3] as asn1js.Boolean).valueBlock.value, true);
  assert.throws(() => buildTimeStampReq(ROOT, 1n, 'md5'), TimestampVerificationError);
  assert.throws(() => buildTimeStampReq(ROOT, 0n), RangeError);
  for (let i = 0; i < 50; i++) {
    const n = newNonce();
    assert.ok(n > 0n && n < 1n << 63n);
  }
});

test('a cross-signed chain is found whatever the issuer order; untrusted-only is refused', async () => {
  const fake = await FakeTsa.create();
  const untrusted = await makeCa("Someone Else's Root");
  const interKey = await generateTsaKeyPair('EC');
  const viaUntrusted = await makeTsaCert(untrusted.key.privateKey, untrusted.cert, { key: interKey, ca: true, eku: [], cn: 'Fake TSA Intermediate' });
  const viaTrusted = await makeTsaCert(fake.rootKey.privateKey, fake.root, { key: interKey, ca: true, eku: [], cn: 'Fake TSA Intermediate' });
  const leaf = await makeTsaCert(interKey.privateKey, viaTrusted.cert);
  fake.key = leaf.key;
  fake.cert = leaf.cert;
  const root = Buffer.alloc(32, 5);
  for (const chain of [[viaUntrusted.cert, untrusted.cert, viaTrusted.cert], [viaTrusted.cert, viaUntrusted.cert]]) {
    fake.chain = chain;
    const token = await fake.token(sha256(root));
    assert.ok(verifyTimestampToken(token, root, [fake.root]).serialNumber);
  }
  fake.chain = [viaUntrusted.cert, untrusted.cert];
  const token = await fake.token(sha256(root));
  assert.throws(() => verifyTimestampToken(token, root, [fake.root]), /does not chain/);
});

test(`a token with more than ${MAX_TOKEN_CERTS} certificates is refused`, async () => {
  const fake = await FakeTsa.create();
  fake.chain = await Promise.all(Array.from({ length: 40 }, (_, i) => makeCa(`Filler ${i}`).then((c) => c.cert)));
  const root = Buffer.alloc(32, 6);
  const token = await fake.token(sha256(root));
  assert.throws(() => verifyTimestampToken(token, root, [fake.root]), /more than/);
});

// -- independent oracle: OpenSSL agrees on good and corrupted tokens -------------

function opensslTs(): boolean {
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
}

function opensslVerifies(token: Buffer, data: Buffer, anchorsPem: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'attesta-t15f-'));
  try {
    writeFileSync(join(dir, 'data.bin'), data);
    writeFileSync(join(dir, 'token.der'), token);
    writeFileSync(join(dir, 'ca.pem'), anchorsPem);
    const r = spawnSync('openssl', ['ts', '-verify', '-data', join(dir, 'data.bin'), '-in', join(dir, 'token.der'), '-token_in',
      '-CAfile', join(dir, 'ca.pem')], { encoding: 'utf8' });
    return r.status === 0 && /Verification: OK/.test(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function oursVerifies(token: Buffer, data: Buffer, anchorsPem: string): boolean {
  try {
    verifyTimestampToken(token, data, loadTrustAnchors(anchorsPem));
    return true;
  } catch (err) {
    assert.ok(err instanceof TimestampVerificationError, String(err));
    return false;
  }
}

test('OpenSSL and the adapter agree on good and corrupted tokens', { skip: !opensslTs() }, async () => {
  execFileSync('openssl', ['version']);
  const data = Buffer.alloc(32, 7);
  const cases: Array<[string, (f: FakeTsa) => Promise<void> | void, boolean]> = [
    ['good (ESS v2)', () => {}, true],
    ['good (ESS v1)', (f) => { f.essV1 = true; }, true],
    ['corrupt signature', (f) => { f.corruptSignature = true; }, false],
    ['wrong imprint', (f) => { f.imprintOverride = Buffer.alloc(32, 1); }, false],
    ['wrong message digest', (f) => { f.digestOverride = Buffer.alloc(32, 2); }, false],
    ['ESS names another cert', async (f) => { f.essCert = (await makeTsaCert(f.rootKey.privateKey, f.root, { key: f.key })).cert; }, false],
    ['EKU not critical', async (f) => {
      const leaf = await makeTsaCert(f.rootKey.privateKey, f.root, { ekuCritical: false });
      f.key = leaf.key;
      f.cert = leaf.cert;
    }, false],
    ['code-signing EKU', async (f) => {
      const leaf = await makeTsaCert(f.rootKey.privateKey, f.root, { eku: [CODE_SIGNING] });
      f.key = leaf.key;
      f.cert = leaf.cert;
    }, false],
  ];
  for (const [name, setup, expected] of cases) {
    const fake = await FakeTsa.create();
    await setup(fake);
    const token = await fake.token(sha256(data), 'sha256', 11n);
    assert.equal(oursVerifies(token, data, fake.anchorsPem), expected, `adapter: ${name}`);
    assert.equal(opensslVerifies(token, data, fake.anchorsPem), expected, `openssl: ${name}`);
  }
  // Untrusted root: both refuse.
  const fake = await FakeTsa.create();
  const other = await makeCa('Other Root');
  const token = await fake.token(sha256(data), 'sha256', 12n);
  assert.equal(oursVerifies(token, data, pem(other.cert)), false);
  assert.equal(opensslVerifies(token, data, pem(other.cert)), false);
});

test('an intermediate CA whose key usage omits keyCertSign cannot issue', async () => {
  // makeTsaCert has no key-usage knob, so build this one CA by hand with pkijs.
  const pk = pkijs;
  const fake = await FakeTsa.create();
  const interKey = await generateTsaKeyPair('EC');
  const mk = async (keyCertSign: boolean): Promise<pkijs.Certificate> => {
    const ku = new asn1js.BitString({ valueHex: new Uint8Array([keyCertSign ? 0x86 : 0x80]).buffer, unusedBits: 1 });
    const cert = new pk.Certificate({
      version: 2,
      serialNumber: new asn1js.Integer({ value: keyCertSign ? 77 : 78 }),
      issuer: fake.root.subject,
      subject: new pk.RelativeDistinguishedNames({
        typesAndValues: [new pk.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'KU Intermediate' }) })],
      }),
      notBefore: new pk.Time({ type: 0, value: new Date(Date.now() - 86400_000) }),
      notAfter: new pk.Time({ type: 0, value: new Date(Date.now() + 86400_000) }),
      extensions: [
        new pk.Extension({ extnID: '2.5.29.19', critical: true, extnValue: new pk.BasicConstraints({ cA: true }).toSchema().toBER(false) }),
        new pk.Extension({ extnID: '2.5.29.15', critical: true, extnValue: ku.toBER(false) }),
      ],
    });
    await cert.subjectPublicKeyInfo.importKey(interKey.publicKey);
    await cert.sign(fake.rootKey.privateKey, 'SHA-256');
    return cert;
  };
  for (const keyCertSign of [true, false]) {
    const inter = await mk(keyCertSign);
    const leaf = await makeTsaCert(interKey.privateKey, inter);
    fake.key = leaf.key;
    fake.cert = leaf.cert;
    fake.chain = [inter];
    const root = Buffer.alloc(32, 8);
    const token = await fake.token(sha256(root), 'sha256', 4n);
    if (keyCertSign) assert.ok(verifyTimestampToken(token, root, [fake.root]));
    else assert.throws(() => verifyTimestampToken(token, root, [fake.root]), /does not chain/);
  }
});
