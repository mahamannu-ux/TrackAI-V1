import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  EKU_TIME_STAMPING,
  FakeTsa,
  TSA_POLICY,
  TSA_SERIAL_START,
  TSA_URL,
  generateTsaKeyPair,
  makeCa,
  makeTsaCert,
} from './testing/fake-tsa';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4';
const DATA_OID = '1.2.840.113549.1.7.1';
const ESS_V1_OID = '1.2.840.113549.1.9.16.2.12';
const ESS_V2_OID = '1.2.840.113549.1.9.16.2.47';
const CONTENT_TYPE_ATTR_OID = '1.2.840.113549.1.9.3';
const MESSAGE_DIGEST_ATTR_OID = '1.2.840.113549.1.9.4';
const ECDSA_SHA256_OID = '1.2.840.10045.4.3.2';
const RSA_SHA256_OID = '1.2.840.113549.1.1.11';
const RSA_KEY_OID = '1.2.840.113549.1.1.1';

function bytesOf(ab: ArrayBuffer): Buffer {
  return Buffer.from(new Uint8Array(ab));
}

/** Copy of a view's bytes as a fresh ArrayBuffer (for asn1js/pkijs parsers). */
function ab(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as unknown as ArrayBuffer;
}

/** Raw content bytes of an OCTET STRING / INTEGER element. */
function viewOf(block: unknown): Uint8Array {
  return new Uint8Array((block as { valueHexView: ArrayBuffer }).valueHexView);
}

function oidString(el: asn1js.AsnType): string {
  return (el as asn1js.ObjectIdentifier).valueBlock.toString();
}

function intNumber(el: asn1js.AsnType): number {
  const n = (el as asn1js.Integer).valueBlock.valueDec;
  if (typeof n !== 'number') throw new Error('expected small INTEGER');
  return n;
}

function intBigint(el: asn1js.AsnType): bigint {
  const raw = Buffer.from(new Uint8Array((el.valueBlock as unknown as { valueHexView: ArrayBuffer }).valueHexView));
  let value = BigInt(`0x${raw.toString('hex')}`);
  if ((raw[0] & 0x80) !== 0) value -= 1n << BigInt(raw.length * 8);
  return value;
}

function seqChildren(el: asn1js.AsnType): asn1js.AsnType[] {
  return (el as asn1js.Sequence).valueBlock.value;
}

/** DER TimeStampReq for `digest` (SHA-256), with a nonce unless told otherwise. */
function buildReq(digest: Buffer, nonce?: bigint): Buffer {
  const parts: asn1js.AsnType[] = [
    new asn1js.Integer({ value: 1 }),
    new asn1js.Sequence({
      value: [
        new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: SHA256_OID }), new asn1js.Null()] }),
        new asn1js.OctetString({ valueHex: ab(digest) }),
      ],
    }),
  ];
  if (nonce !== undefined) {
    let hex = nonce.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    let raw = Buffer.from(hex, 'hex');
    if ((raw[0] & 0x80) !== 0) raw = Buffer.concat([Buffer.from([0x00]), raw]);
    parts.push(new asn1js.Integer({ valueHex: ab(raw) }));
  }
  const ber = new asn1js.Sequence({ value: parts }).toBER(false);
  return Buffer.from(new Uint8Array(ber));
}

interface ParsedAttr {
  oid: string;
  values: asn1js.AsnType[];
}

interface ParsedToken {
  tstDer: Buffer;
  tst: {
    version: number;
    policy: string;
    imprintAlgo: string;
    imprint: Buffer;
    serial: number;
    genTime: Date;
    nonce: bigint | null;
    hasTsa: boolean;
  };
  signer: {
    digestAlgo: string;
    attrs: ParsedAttr[];
    sigAlgo: string;
    signature: Buffer;
  };
  certDers: Buffer[];
  signedData: pkijs.SignedData;
}

/** Parse a token the way a verifier would: structure by hand, crypto by pkijs. */
function parseToken(tokenDer: Buffer): ParsedToken {
  const asn1 = asn1js.fromBER(ab(tokenDer));
  if (asn1.offset === -1) throw new Error('malformed token');
  const ci = pkijs.ContentInfo.fromBER(ab(tokenDer));
  assert.equal(ci.contentType, '1.2.840.113549.1.7.2');
  const signedData = new pkijs.SignedData({ schema: ci.content });
  const sdTop = seqChildren(seqChildren(seqChildren(asn1.result)[1])[0]);
  // SignedData ::= SEQ { version, digestAlgorithms, encapContentInfo, [0] certs?, signerInfos }.
  const encap = seqChildren(sdTop[2]);
  const eContent = encap[1] as asn1js.Constructed;
  const tstOctets = seqChildren(eContent)[0] as asn1js.OctetString;
  const tstDer = Buffer.from(viewOf(tstOctets.valueBlock));
  const tst = seqChildren(parseSeq(tstDer));
  const imprint = seqChildren(tst[2]);
  const tstNonce = tst.find((el) => el instanceof asn1js.Integer && el !== tst[0] && el !== tst[3]);
  const parsed = {
    version: intNumber(tst[0]),
    policy: oidString(tst[1]),
    imprintAlgo: oidString(seqChildren(imprint[0])[0]),
    imprint: Buffer.from(viewOf((imprint[1] as asn1js.OctetString).valueBlock)),
    serial: intNumber(tst[3]),
    genTime: (tst[4] as asn1js.GeneralizedTime).toDate(),
    nonce: tstNonce ? intBigint(tstNonce) : null,
    hasTsa: tst.some((el) => el instanceof asn1js.Constructed && el.idBlock.tagClass === 3 && el.idBlock.tagNumber === 0),
  };
  const signerInfos = seqChildren(sdTop[sdTop.length - 1]);
  const si = seqChildren(signerInfos[0]);
  const sid = seqChildren(si[1]);
  assert.ok(sid.length === 2, 'signer identified by issuer and serial');
  const attrsEl = si[3] as asn1js.Constructed;
  assert.equal(attrsEl.idBlock.tagClass, 3);
  const attrs: ParsedAttr[] = seqChildren(attrsEl).map((attr) => {
    const parts = seqChildren(attr);
    return { oid: oidString(parts[0]), values: seqChildren(parts[1]) };
  });
  const sigAlgParts = seqChildren(si[4]);
  const certsEl = sdTop.find(
    (el, i) => i > 2 && i < sdTop.length - 1 && el instanceof asn1js.Constructed && el.idBlock.tagClass === 3,
  ) as asn1js.Constructed | undefined;
  const certDers = certsEl
    ? seqChildren(certsEl).map((c) => Buffer.from(new Uint8Array(c.toBER(false))))
    : [];
  return {
    tstDer,
    tst: parsed,
    signer: {
      digestAlgo: oidString(seqChildren(si[2])[0]),
      attrs,
      sigAlgo: oidString(sigAlgParts[0]),
      signature: Buffer.from(viewOf((si[5] as asn1js.OctetString).valueBlock)),
    },
    certDers,
    signedData,
  };
}

function parseSeq(der: Buffer): asn1js.Sequence {
  const asn1 = asn1js.fromBER(ab(der));
  if (asn1.offset === -1 || !(asn1.result instanceof asn1js.Sequence)) throw new Error('malformed TSTInfo');
  return asn1.result;
}

interface ParsedResp {
  status: number;
  token: ParsedToken | null;
}

async function postTsr(tsa: FakeTsa, reqDer: Buffer, method = 'POST'): Promise<{ status: number; contentType: string | null; resp: ParsedResp }> {
  const res = await tsa.fetch(TSA_URL, {
    method,
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: reqDer,
  });
  const der = Buffer.from(await res.arrayBuffer());
  const top = seqChildren(parseSeq(der));
  const statusInfo = seqChildren(top[0]);
  const status = intNumber(statusInfo[0]);
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    resp: { status, token: top.length > 1 ? parseToken(Buffer.from(new Uint8Array(top[1].toBER(false)))) : null },
  };
}

function attr(parsed: ParsedToken, oid: string): ParsedAttr | undefined {
  return parsed.signer.attrs.find((a) => a.oid === oid);
}

async function verifies(tsa: FakeTsa, parsed: ParsedToken, message: Buffer): Promise<boolean> {
  try {
    return await parsed.signedData.verify({
      signer: 0,
      data: ab(message),
      checkChain: true,
      trustedCerts: [tsa.root],
    });
  } catch {
    return false;
  }
}

function certFromDer(der: Buffer): pkijs.Certificate {
  const asn1 = asn1js.fromBER(ab(der));
  if (asn1.offset === -1) throw new Error('malformed certificate');
  return new pkijs.Certificate({ schema: asn1.result });
}

function certDer(cert: pkijs.Certificate): Buffer {
  return Buffer.from(new Uint8Array(cert.toSchema(true).toBER(false)));
}

test('granted flow verifies end to end with pkijs', async () => {
  const tsa = await FakeTsa.create();
  assert.equal(tsa.serial, TSA_SERIAL_START);
  const message = Buffer.from('batch root');
  const digest = createHash('sha256').update(message).digest();
  const nonce = 123456789n;
  const { status, contentType, resp } = await postTsr(tsa, buildReq(digest, nonce));
  assert.equal(status, 200);
  assert.equal(contentType, 'application/timestamp-reply');
  assert.equal(resp.status, 0);
  assert.ok(resp.token);
  const parsed = resp.token;
  assert.equal(tsa.posts, 1);

  // TSTInfo carries the requested imprint and nonce.
  assert.equal(parsed.tst.version, 1);
  assert.equal(parsed.tst.policy, TSA_POLICY);
  assert.equal(parsed.tst.imprintAlgo, SHA256_OID);
  assert.deepEqual(parsed.tst.imprint, digest);
  assert.equal(parsed.tst.nonce, nonce);
  assert.equal(parsed.tst.serial, TSA_SERIAL_START + 1);
  assert.ok(parsed.tst.hasTsa);

  // The signer certificate chains to the root and is a timestamping cert.
  assert.equal(parsed.certDers.length, 1);
  const signerCert = certFromDer(parsed.certDers[0]);
  const ekuExt = signerCert.extensions?.find((e) => e.extnID === '2.5.29.37');
  assert.ok(ekuExt, 'EKU extension present');
  assert.equal(ekuExt.critical, true);
  const eku = new pkijs.ExtKeyUsage({ schema: (ekuExt.extnValue.valueBlock.value as asn1js.AsnType[])[0] });
  assert.deepEqual(eku.keyPurposes, [EKU_TIME_STAMPING]);
  const bcExt = signerCert.extensions?.find((e) => e.extnID === '2.5.29.19');
  assert.equal(bcExt?.critical, true);

  // ESS names this signer with SHA-256, content-type and message-digest agree.
  const ess = attr(parsed, ESS_V2_OID);
  assert.ok(ess, 'ESS signing-certificate-v2 present');
  const essHash = Buffer.from(
    viewOf(seqChildren(seqChildren(seqChildren(ess.values[0])[0])[0])[0].valueBlock),
  );
  assert.deepEqual(essHash, createHash('sha256').update(parsed.certDers[0]).digest());
  assert.equal(oidString(attr(parsed, CONTENT_TYPE_ATTR_OID)?.values[0] as asn1js.AsnType), TST_INFO_OID);
  assert.deepEqual(
    Buffer.from(viewOf((attr(parsed, MESSAGE_DIGEST_ATTR_OID)?.values[0] as asn1js.OctetString).valueBlock)),
    createHash('sha256').update(parsed.tstDer).digest(),
  );

  // pkijs checks imprint, digest, signature and chain: the whole token.
  assert.equal(await verifies(tsa, parsed, message), true);
});

test('token without a nonce carries no nonce', async () => {
  const tsa = await FakeTsa.create();
  const digest = createHash('sha256').update(Buffer.from('no-nonce')).digest();
  const { resp } = await postTsr(tsa, buildReq(digest));
  assert.ok(resp.token);
  assert.equal(resp.token.tst.nonce, null);
});

test('GET is rejected with 405', async () => {
  const tsa = await FakeTsa.create();
  const res = await tsa.fetch(TSA_URL, { method: 'GET' });
  assert.equal(res.status, 405);
});

test('imprintOverride timestamps a different digest', async () => {
  const tsa = await FakeTsa.create();
  const other = createHash('sha256').update(Buffer.from('other')).digest();
  tsa.imprintOverride = other;
  const message = Buffer.from('requested');
  const digest = createHash('sha256').update(message).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 7n))).resp.token;
  assert.ok(parsed);
  assert.deepEqual(parsed.tst.imprint, other);
  // A verifier checking the requested message notices.
  assert.equal(await verifies(tsa, parsed, message), false);
});

test('nonceOffset shifts the echoed nonce', async () => {
  const tsa = await FakeTsa.create();
  tsa.nonceOffset = 5;
  const digest = createHash('sha256').update(Buffer.from('n')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 100n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.tst.nonce, 105n);
});

test('corruptSignature breaks CMS verification but nothing else', async () => {
  const tsa = await FakeTsa.create();
  tsa.corruptSignature = true;
  const message = Buffer.from('corrupt me');
  const digest = createHash('sha256').update(message).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 9n))).resp.token;
  assert.ok(parsed);
  assert.deepEqual(parsed.tst.imprint, digest);
  assert.equal(await verifies(tsa, parsed, message), false);
});

test('contentTypeAttr replaces the content-type attribute', async () => {
  const tsa = await FakeTsa.create();
  tsa.contentTypeAttr = 'data';
  const digest = createHash('sha256').update(Buffer.from('ct')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 3n))).resp.token;
  assert.ok(parsed);
  assert.equal(oidString(attr(parsed, CONTENT_TYPE_ATTR_OID)?.values[0] as asn1js.AsnType), DATA_OID);
});

test('digestOverride breaks the message-digest attribute', async () => {
  const tsa = await FakeTsa.create();
  tsa.digestOverride = Buffer.alloc(32, 0xab);
  const message = Buffer.from('digested');
  const digest = createHash('sha256').update(message).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 11n))).resp.token;
  assert.ok(parsed);
  assert.deepEqual(
    Buffer.from(viewOf((attr(parsed, MESSAGE_DIGEST_ATTR_OID)?.values[0] as asn1js.OctetString).valueBlock)),
    Buffer.alloc(32, 0xab),
  );
  assert.equal(await verifies(tsa, parsed, message), false);
});

test('omitEss drops the ESS attribute', async () => {
  const tsa = await FakeTsa.create();
  tsa.omitEss = true;
  const digest = createHash('sha256').update(Buffer.from('no-ess')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 13n))).resp.token;
  assert.ok(parsed);
  assert.equal(attr(parsed, ESS_V2_OID), undefined);
  assert.equal(attr(parsed, ESS_V1_OID), undefined);
});

test('essV1 names the signer with SHA-1', async () => {
  const tsa = await FakeTsa.create();
  tsa.essV1 = true;
  const digest = createHash('sha256').update(Buffer.from('v1')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 17n))).resp.token;
  assert.ok(parsed);
  const ess = attr(parsed, ESS_V1_OID);
  assert.ok(ess, 'ESS signing-certificate (v1) present');
  assert.equal(attr(parsed, ESS_V2_OID), undefined);
  const essHash = Buffer.from(
    viewOf(seqChildren(seqChildren(seqChildren(ess.values[0])[0])[0])[0].valueBlock),
  );
  assert.deepEqual(essHash, createHash('sha1').update(parsed.certDers[0]).digest());
});

test('essCert names another certificate', async () => {
  const tsa = await FakeTsa.create();
  const { cert: other } = await makeTsaCert(tsa.rootKey.privateKey, tsa.root, { cn: 'Other Unit' });
  tsa.essCert = other;
  const otherDer = Buffer.from(other.toSchema(true).toBER(false) as ArrayBuffer);
  const digest = createHash('sha256').update(Buffer.from('ess-cert')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 19n))).resp.token;
  assert.ok(parsed);
  const essHash = Buffer.from(
    viewOf(seqChildren(seqChildren(seqChildren(attr(parsed, ESS_V2_OID)?.values[0] as asn1js.AsnType)[0])[0])[0].valueBlock),
  );
  assert.deepEqual(essHash, createHash('sha256').update(otherDer).digest());
  assert.ok(!essHash.equals(createHash('sha256').update(parsed.certDers[0]).digest()));
});

test('includeCerts false ships no certificates', async () => {
  const tsa = await FakeTsa.create();
  tsa.includeCerts = false;
  const digest = createHash('sha256').update(Buffer.from('bare')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 23n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.certDers.length, 0);
  assert.equal(await verifies(tsa, parsed, Buffer.from('bare')), false);
});

test('non-granted status replies without a token', async () => {
  const tsa = await FakeTsa.create();
  tsa.status = 'rejection';
  const digest = createHash('sha256').update(Buffer.from('rejected')).digest();
  const { resp } = await postTsr(tsa, buildReq(digest, 29n));
  assert.equal(resp.status, 2);
  assert.equal(resp.token, null);
});

test('httpStatus answers every POST; contentType sets the header', async () => {
  const tsa = await FakeTsa.create();
  tsa.httpStatus = 500;
  const digest = createHash('sha256').update(Buffer.from('x')).digest();
  const failed = await tsa.fetch(TSA_URL, { method: 'POST', body: buildReq(digest, 1n) });
  assert.equal(failed.status, 500);
  assert.equal(tsa.posts, 1);

  tsa.httpStatus = 200;
  tsa.contentType = 'application/x-timestamp';
  const { contentType } = await postTsr(tsa, buildReq(digest, 1n));
  assert.equal(contentType, 'application/x-timestamp');
});

test('down rejects with TypeError', async () => {
  const tsa = await FakeTsa.create();
  tsa.down = true;
  const digest = createHash('sha256').update(Buffer.from('x')).digest();
  await assert.rejects(tsa.fetch(TSA_URL, { method: 'POST', body: buildReq(digest, 1n) }), TypeError);
});

test('genTime pins the token time', async () => {
  const tsa = await FakeTsa.create();
  const pinned = new Date(Math.floor((Date.now() - 3600_000) / 1000) * 1000);
  tsa.genTime = pinned;
  const digest = createHash('sha256').update(Buffer.from('timed')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 31n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.tst.genTime.getTime(), pinned.getTime());
});

test('tamper mutates the TSTInfo fields before signing', async () => {
  const tsa = await FakeTsa.create();
  tsa.tamper = (fields) => {
    fields.policy = '1.2.3.4.5';
  };
  const digest = createHash('sha256').update(Buffer.from('t')).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 37n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.tst.policy, '1.2.3.4.5');
});

test('an RSA TSA key verifies under sha256WithRSAEncryption', async () => {
  const tsa = await FakeTsa.create();
  const rsaPair = await generateTsaKeyPair('RSA');
  const { cert } = await makeTsaCert(tsa.rootKey.privateKey, tsa.root, { key: rsaPair });
  tsa.key = rsaPair;
  tsa.cert = cert;
  const message = Buffer.from('rsa timestamped');
  const digest = createHash('sha256').update(message).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 41n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.signer.sigAlgo, RSA_SHA256_OID);
  const signerCert = certFromDer(parsed.certDers[0]);
  assert.equal(signerCert.subjectPublicKeyInfo.algorithm.algorithmId, RSA_KEY_OID);
  assert.equal(await verifies(tsa, parsed, message), true);
});

test('an intermediate chains through to the root', async () => {
  const tsa = await FakeTsa.create();
  const inter = await makeTsaCert(tsa.rootKey.privateKey, tsa.root, { cn: 'Fake Intermediate', ca: true });
  const leaf = await makeTsaCert(inter.key.privateKey, inter.cert, { cn: 'Fake TSA Unit 1' });
  tsa.key = leaf.key;
  tsa.cert = leaf.cert;
  tsa.chain = [inter.cert];
  const message = Buffer.from('chained');
  const digest = createHash('sha256').update(message).digest();
  const parsed = (await postTsr(tsa, buildReq(digest, 43n))).resp.token;
  assert.ok(parsed);
  assert.equal(parsed.certDers.length, 2);
  assert.equal(await verifies(tsa, parsed, message), true);
});

test('anchorsPem is the root certificate', async () => {
  const tsa = await FakeTsa.create();
  assert.match(tsa.anchorsPem, /^-----BEGIN CERTIFICATE-----/);
  const b64 = tsa.anchorsPem.split('\n').filter((line) => !line.startsWith('-----')).join('');
  const root = certFromDer(Buffer.from(b64, 'base64'));
  assert.deepEqual(Buffer.from(root.toSchema(true).toBER(false) as ArrayBuffer), Buffer.from(tsa.root.toSchema(true).toBER(false) as ArrayBuffer));
});

test('makeCa and makeTsaCert carry the source defaults', async () => {  const { cert: root } = await makeCa();
  const parsedRoot = certFromDer(certDer(root));
  const rootBc = parsedRoot.extensions?.find((e) => e.extnID === '2.5.29.19');
  assert.equal(rootBc?.critical, true);
  assert.deepEqual(new pkijs.BasicConstraints({ schema: (rootBc?.extnValue.valueBlock.value as asn1js.AsnType[])[0] }).cA, true);

  const { cert: incomplete } = await makeTsaCert(
    (await makeCa()).key.privateKey,
    root,
    { eku: [], ekuCritical: false, ca: true, cn: 'Custom', notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 1000) },
  );
  const parsedLeaf = certFromDer(certDer(incomplete));
  assert.equal(parsedLeaf.extensions?.some((e) => e.extnID === '2.5.29.37'), false);
  assert.deepEqual(new pkijs.BasicConstraints({ schema: (parsedLeaf.extensions?.find((e) => e.extnID === '2.5.29.19')?.extnValue.valueBlock.value as asn1js.AsnType[])[0] }).cA, true);
});

/** Independent check: real OpenSSL verifies our tokens (skips without `openssl ts`). */
function opensslTsAvailable(): boolean {
  try {
    execFileSync('openssl', ['ts', '-help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('openssl verifies granted tokens with ESS v1 and v2', { skip: !opensslTsAvailable() }, async () => {
  for (const essV1 of [false, true]) {
    const tsa = await FakeTsa.create();
    tsa.essV1 = essV1;
    const message = Buffer.from(`openssl interop ess-${essV1 ? 'v1' : 'v2'}`);
    const digest = createHash('sha256').update(message).digest();
    const res = await tsa.fetch(TSA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: buildReq(digest, 77n),
    });
    assert.equal(res.status, 200);
    const dir = mkdtempSync(join(tmpdir(), 'attesta-tsa-'));
    try {
      writeFileSync(join(dir, 'msg.bin'), message);
      writeFileSync(join(dir, 'resp.tsr'), Buffer.from(await res.arrayBuffer()));
      writeFileSync(join(dir, 'root.pem'), tsa.anchorsPem);
      const out = execFileSync(
        'openssl',
        ['ts', '-verify', '-data', join(dir, 'msg.bin'), '-in', join(dir, 'resp.tsr'), '-CAfile', join(dir, 'root.pem')],
        { encoding: 'utf8' },
      );
      assert.match(out, /Verification: OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
