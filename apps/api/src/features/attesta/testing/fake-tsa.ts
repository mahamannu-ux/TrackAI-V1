// In-process RFC 3161 timestamp authority with real cryptography.
//
// Ported from SushiCorp tests/unit/anchor/fake_tsa.py @ 0bd67a5 (catalog EV-2).
// Deviations: (1) httpx `MockTransport` becomes a `FetchLike` (`fetch`
// property); `down` rejects with `TypeError('fetch failed')`, matching what
// Node's `fetch` throws on a refused connection; `GET` answers 405;
// (2) `asn1crypto`/`cryptography` become `asn1js` (protocol framing) plus
// `pkijs` (X.509 creation and parsing) over Node's WebCrypto; the pkijs
// engine is installed once from `node:crypto`'s `webcrypto`; (3) `token()`
// and `respond()` are async because WebCrypto signing is async;
// (4) keys are WebCrypto `CryptoKeyPair`s and certificates pkijs
// `Certificate`s (`makeCa`/`makeTsaCert` return `{ key, cert }`); nonces and
// serials cross the `number`/`bigint` boundary explicitly (ASN.1 INTEGERs
// are encoded from `bigint`); (5) `Error` instead of Python exceptions on
// malformed requests. Behaviour, constants, string formats and knob
// semantics stay the same.

import { createHash, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { FetchLike } from './fetch-like';

/** Default token endpoint URL, as in the source. */
export const TSA_URL = 'http://tsa.test/tsr';
/** Timestamp policy OID stamped into every token. */
export const TSA_POLICY = '1.3.6.1.4.1.99999.1';
/** Token serial before the first token; each token advances it by one. */
export const TSA_SERIAL_START = 1000;
/** Distinguished name of the fake TSA and of the root CA. */
export const TSA_UNIT_CN = 'Fake TSA Unit 1';
export const TSA_ROOT_CN = 'Fake TSA Root';
/** Critical extended key usage every TSA certificate carries by default. */
export const EKU_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

const SHA1_OID = '1.3.14.3.2.26';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const SHA384_OID = '2.16.840.1.101.3.4.2.2';
const SHA512_OID = '2.16.840.1.101.3.4.2.3';
const ECDSA_SHA256_OID = '1.2.840.10045.4.3.2';
const RSA_SHA256_OID = '1.2.840.113549.1.1.11';
const ATTR_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const ATTR_SIGNING_CERT = '1.2.840.113549.1.9.16.2.12';
const ATTR_SIGNING_CERT_V2 = '1.2.840.113549.1.9.16.2.47';
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2';
const TST_INFO_CONTENT_OID = '1.2.840.113549.1.9.16.1.4';
const EXT_BASIC_CONSTRAINTS = '2.5.29.19';
const EXT_KEY_USAGE = '2.5.29.37';
const CN_OID = '2.5.4.3';

const HASH_NAME_BY_OID: Record<string, string> = {
  [SHA1_OID]: 'sha1',
  [SHA256_OID]: 'sha256',
  [SHA384_OID]: 'sha384',
  [SHA512_OID]: 'sha512',
};
const HASH_OID_BY_NAME: Record<string, string> = {
  sha1: SHA1_OID,
  sha256: SHA256_OID,
  sha384: SHA384_OID,
  sha512: SHA512_OID,
};
const CONTENT_TYPE_OID_BY_NAME: Record<string, string> = {
  tst_info: TST_INFO_CONTENT_OID,
  data: '1.2.840.113549.1.7.1',
  signed_data: SIGNED_DATA_OID,
};
const STATUS_CODE_BY_NAME: Record<string, number> = {
  granted: 0,
  grantedWithMods: 1,
  rejection: 2,
  waiting: 3,
  revocationWarning: 4,
  revocationNotification: 5,
};

export interface TsaKeyPair {
  privateKey: webcrypto.CryptoKey;
  publicKey: webcrypto.CryptoKey;
}

export interface TsaCertBundle {
  key: TsaKeyPair;
  cert: pkijs.Certificate;
}

/** The TSTInfo fields `tamper` may mutate before the token is built. */
export interface TstFields {
  version: number;
  policy: string;
  messageImprint: { algorithm: string; digest: Uint8Array };
  serialNumber: number;
  genTime: Date;
  tsa: boolean;
  nonce?: bigint;
}

export interface ParsedTimeStampReq {
  version: number;
  algorithm: string;
  digest: Uint8Array;
  nonce: bigint | null;
}

export interface MakeTsaCertOptions {
  key?: TsaKeyPair;
  /** OIDs; an empty array omits the EKU extension. Defaults to timeStamping. */
  eku?: string[];
  ekuCritical?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  ca?: boolean;
  cn?: string;
}

let engineInstalled = false;

/** Install the pkijs engine once, from Node's WebCrypto. */
export function ensureTsaEngine(): void {
  if (!engineInstalled) {
    pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));
    engineInstalled = true;
  }
}

function bytesOf(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}

function sha256(data: Uint8Array): Uint8Array {
  return bytesOf(createHash('sha256').update(data).digest());
}

function hashByName(name: string, data: Uint8Array): Uint8Array {
  const oid = HASH_OID_BY_NAME[name];
  if (!oid) throw new Error(`unsupported hash algorithm ${JSON.stringify(name)}`);
  return bytesOf(createHash(name).update(data).digest());
}

function sliceCopy(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Minimal two's-complement DER INTEGER from a bigint. */
function derInteger(value: bigint): asn1js.Integer {
  let hex = (value < 0n ? -value : value).toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (value < 0n) {
    const n = BigInt(bytes.length * 8);
    bytes = Buffer.from(((1n << n) + value).toString(16).padStart(bytes.length * 2, '0'), 'hex');
  } else if (bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return new asn1js.Integer({ valueHex: sliceCopy(bytes) });
}

function blockView(block: unknown): Uint8Array {
  return bytesOf((block as { valueHexView: ArrayBuffer }).valueHexView);
}

function parseInteger(element: asn1js.AsnType): bigint {
  const raw = Buffer.from(blockView(element.valueBlock));
  if (raw.length === 0) throw new Error('empty INTEGER');
  let value = BigInt(`0x${raw.toString('hex')}`);
  if ((raw[0] & 0x80) !== 0) value -= 1n << BigInt(raw.length * 8);
  return value;
}

function oidElement(oid: string): asn1js.ObjectIdentifier {
  return new asn1js.ObjectIdentifier({ value: oid });
}

function octetElement(data: Uint8Array): asn1js.OctetString {
  const copy = Buffer.from(data);
  return new asn1js.OctetString({ valueHex: sliceCopy(copy) });
}

function seqElement(...children: asn1js.AsnType[]): asn1js.Sequence {
  return new asn1js.Sequence({ value: children });
}

function contextElement(tagNumber: number, ...children: asn1js.AsnType[]): asn1js.Constructed {
  return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: children });
}

function digestAlgorithmElement(name: string): asn1js.Sequence {
  const oid = HASH_OID_BY_NAME[name];
  if (!oid) throw new Error(`unsupported hash algorithm ${JSON.stringify(name)}`);
  return seqElement(oidElement(oid), new asn1js.Null());
}

function derOf(node: asn1js.AsnType): Buffer {
  return Buffer.from(bytesOf(node.toBER(false)));
}

function parseDer(bytes: Uint8Array, what: string): asn1js.Sequence {
  const asn1 = asn1js.fromBER(sliceCopy(Buffer.from(bytes)));
  if (asn1.offset === -1 || !(asn1.result instanceof asn1js.Sequence)) throw new Error(`malformed ${what}`);
  return asn1.result;
}

function rdn(cn: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [new pkijs.AttributeTypeAndValue({ type: CN_OID, value: new asn1js.Utf8String({ value: cn }) })],
  });
}

function randomSerial(): asn1js.Integer {
  const bytes = Buffer.alloc(8);
  bytes[0] = 0x01;
  for (let i = 1; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return new asn1js.Integer({ valueHex: sliceCopy(bytes) });
}

export async function generateTsaKeyPair(kind: 'EC' | 'RSA' = 'EC'): Promise<TsaKeyPair> {
  ensureTsaEngine();
  if (kind === 'RSA') {
    return (await webcrypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as TsaKeyPair;
  }
  return (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as TsaKeyPair;
}

/** A self-signed root CA (P-256, `BasicConstraints ca=true` critical). */
export async function makeCa(cn: string = TSA_ROOT_CN, key?: TsaKeyPair): Promise<TsaCertBundle> {
  ensureTsaEngine();
  const pair = key ?? (await generateTsaKeyPair('EC'));
  const now = Date.now();
  const cert = new pkijs.Certificate({
    version: 2,
    serialNumber: randomSerial(),
    issuer: rdn(cn),
    subject: rdn(cn),
    notBefore: new pkijs.Time({ type: 0, value: new Date(now - 30 * 86400_000) }),
    notAfter: new pkijs.Time({ type: 0, value: new Date(now + 3650 * 86400_000) }),
    extensions: [
      new pkijs.Extension({
        extnID: EXT_BASIC_CONSTRAINTS,
        critical: true,
        extnValue: new pkijs.BasicConstraints({ cA: true }).toSchema().toBER(false),
      }),
    ],
  });
  await cert.subjectPublicKeyInfo.importKey(pair.publicKey);
  await cert.sign(pair.privateKey, 'SHA-256');
  return { key: pair, cert };
}

/** A TSA certificate issued by `issuer`, with the source's exact defaults. */
export async function makeTsaCert(
  issuerKey: webcrypto.CryptoKey,
  issuerCert: pkijs.Certificate,
  opts: MakeTsaCertOptions = {},
): Promise<TsaCertBundle> {
  ensureTsaEngine();
  const pair = opts.key ?? (await generateTsaKeyPair('EC'));
  const now = Date.now();
  const extensions = [
    new pkijs.Extension({
      extnID: EXT_BASIC_CONSTRAINTS,
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: opts.ca ?? false }).toSchema().toBER(false),
    }),
  ];
  const eku = opts.eku === undefined ? [EKU_TIME_STAMPING] : opts.eku;
  if (eku.length > 0) {
    extensions.push(
      new pkijs.Extension({
        extnID: EXT_KEY_USAGE,
        critical: opts.ekuCritical ?? true,
        extnValue: new pkijs.ExtKeyUsage({ keyPurposes: eku }).toSchema().toBER(false),
      }),
    );
  }
  const cert = new pkijs.Certificate({
    version: 2,
    serialNumber: randomSerial(),
    issuer: issuerCert.subject,
    subject: rdn(opts.cn ?? TSA_UNIT_CN),
    notBefore: new pkijs.Time({ type: 0, value: opts.notBefore ?? new Date(now - 86400_000) }),
    notAfter: new pkijs.Time({ type: 0, value: opts.notAfter ?? new Date(now + 365 * 86400_000) }),
    extensions,
  });
  await cert.subjectPublicKeyInfo.importKey(pair.publicKey);
  await cert.sign(issuerKey, 'SHA-256');
  return { key: pair, cert };
}

function certDer(cert: pkijs.Certificate): Buffer {
  return Buffer.from(bytesOf(cert.toSchema(true).toBER(false)));
}

function derToPem(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Raw ECDSA R||S (WebCrypto form) to a DER signature. */
function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  if (raw.length % 2 !== 0) throw new Error('malformed ECDSA signature');
  const half = raw.length / 2;
  const part = (chunk: Uint8Array): asn1js.Integer => {
    let hex = Buffer.from(chunk).toString('hex').replace(/^0+/, '');
    if (hex.length === 0) hex = '00';
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    let bytes = Buffer.from(hex, 'hex');
    if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
    return new asn1js.Integer({ valueHex: sliceCopy(bytes) });
  };
  return bytesOf(seqElement(part(raw.subarray(0, half)), part(raw.subarray(half))).toBER(false));
}

function wholeSecondsNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function tsaDirectoryName(): asn1js.Constructed {
  // The PKIX module is DEFINITIONS EXPLICIT TAGS, so directoryName [4] wraps
  // the whole Name (RDNSequence), it does not replace its tag.
  const atv = seqElement(oidElement(CN_OID), new asn1js.Utf8String({ value: TSA_UNIT_CN }));
  const name = seqElement(new asn1js.Set({ value: [atv] }));
  return contextElement(0, contextElement(4, name));
}

function encodeTstInfo(fields: TstFields): Buffer {
  const imprintOid = HASH_OID_BY_NAME[fields.messageImprint.algorithm];
  if (!imprintOid) throw new Error(`unsupported hash algorithm ${JSON.stringify(fields.messageImprint.algorithm)}`);
  const parts: asn1js.AsnType[] = [
    new asn1js.Integer({ value: fields.version }),
    oidElement(fields.policy),
    seqElement(seqElement(oidElement(imprintOid), new asn1js.Null()), octetElement(fields.messageImprint.digest)),
    derInteger(BigInt(fields.serialNumber)),
    new asn1js.GeneralizedTime({ valueDate: fields.genTime }),
  ];
  if (fields.nonce !== undefined) parts.push(derInteger(fields.nonce));
  if (fields.tsa) parts.push(tsaDirectoryName());
  return derOf(seqElement(...parts));
}

export function parseTimeStampReq(bytes: Uint8Array): ParsedTimeStampReq {
  const req = parseDer(bytes, 'TimeStampReq');
  const parts = req.valueBlock.value;
  if (parts.length < 2) throw new Error('malformed TimeStampReq');
  const version = parts[0] as asn1js.Integer;
  const imprint = parts[1] as asn1js.Sequence;
  const imprintParts = imprint.valueBlock.value;
  const hashAlg = imprintParts[0] as asn1js.Sequence;
  const algoOid = (hashAlg.valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString();
  const algorithm = HASH_NAME_BY_OID[algoOid];
  if (!algorithm) throw new Error(`unsupported hash algorithm ${JSON.stringify(algoOid)}`);
  const digest = Buffer.from(blockView((imprintParts[1] as asn1js.OctetString).valueBlock));
  let nonce: bigint | null = null;
  for (const part of parts.slice(2)) {
    if (part instanceof asn1js.Integer) nonce = parseInteger(part);
  }
  return { version: Number((version.valueBlock.valueDec as number | undefined) ?? 1), algorithm, digest, nonce };
}

function contentTypeOid(name: string): string {
  if (/^[0-9]+(\.[0-9]+)+$/.test(name)) return name;
  const oid = CONTENT_TYPE_OID_BY_NAME[name];
  if (!oid) throw new Error(`unknown content type ${JSON.stringify(name)}`);
  return oid;
}

function statusCode(name: string): number {
  const code = STATUS_CODE_BY_NAME[name];
  if (code === undefined) throw new Error(`unknown TSA status ${JSON.stringify(name)}`);
  return code;
}

/** DER `TimeStampResp` carrying only a `PKIStatusInfo` (no token). */
function failureResponse(status: string): Buffer {
  const info = seqElement(
    new asn1js.Integer({ value: statusCode(status) }),
    seqElement(new asn1js.Utf8String({ value: 'no' })),
  );
  return derOf(seqElement(info));
}

async function readBody(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
  const body = init?.body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return bytesOf(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (input instanceof Request) return Buffer.from(await input.arrayBuffer());
  return Buffer.alloc(0);
}

export interface FakeTsaInit {
  chain?: pkijs.Certificate[];
  down?: boolean;
  httpStatus?: number;
  contentType?: string;
  status?: string;
  includeCerts?: boolean;
  essV1?: boolean;
  omitEss?: boolean;
  genTime?: Date | null;
  imprintOverride?: Uint8Array | null;
  nonceOffset?: number;
  corruptSignature?: boolean;
  contentTypeAttr?: string;
  digestOverride?: Uint8Array | null;
  essCert?: pkijs.Certificate | null;
  tamper?: ((fields: TstFields) => void) | null;
}

/**
 * An in-process RFC 3161 TSA: a self-signed root CA issues a time-stamping
 * certificate (critical EKU `id-kp-timeStamping`); replies are DER
 * `TimeStampResp` whose token is CMS `SignedData` over a `TSTInfo`, with
 * content-type, message-digest and ESS signed attributes. Knobs make it
 * misbehave in each way the A15.5 verifier must catch.
 */
export class FakeTsa {
  rootKey!: TsaKeyPair;
  root!: pkijs.Certificate;
  key!: TsaKeyPair;
  cert!: pkijs.Certificate;
  chain: pkijs.Certificate[] = [];
  serial = TSA_SERIAL_START;
  posts = 0;
  down = false;
  httpStatus = 200;
  contentType = 'application/timestamp-reply';
  status = 'granted';
  includeCerts = true;
  essV1 = false;
  omitEss = false;
  genTime: Date | null = null;
  imprintOverride: Uint8Array | null = null;
  nonceOffset = 0;
  corruptSignature = false;
  contentTypeAttr = 'tst_info';
  digestOverride: Uint8Array | null = null;
  essCert: pkijs.Certificate | null = null;
  tamper: ((fields: TstFields) => void) | null = null;

  private constructor() {}

  static async create(init: FakeTsaInit = {}): Promise<FakeTsa> {
    ensureTsaEngine();
    const tsa = new FakeTsa();
    const { key: rootKey, cert: root } = await makeCa();
    const { key, cert } = await makeTsaCert(rootKey.privateKey, root);
    tsa.rootKey = rootKey;
    tsa.root = root;
    tsa.key = key;
    tsa.cert = cert;
    Object.assign(tsa, init);
    return tsa;
  }

  /** PEM of the root CA: the trust anchor a verifier pins. */
  get anchorsPem(): string {
    return derToPem(certDer(this.root), 'CERTIFICATE');
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET') return new Response(null, { status: 405 });
    this.posts += 1;
    if (this.httpStatus !== 200) return new Response(null, { status: this.httpStatus });
    const bytes = await readBody(input, init);
    const response = await this.respond(parseTimeStampReq(bytes));
    return new Response(response, { status: 200, headers: { 'Content-Type': this.contentType } });
  };

  async respond(req: ParsedTimeStampReq): Promise<Buffer> {
    if (this.status !== 'granted') return failureResponse(this.status);
    const token = await this.token(req.digest, req.algorithm, req.nonce);
    return derOf(seqElement(seqElement(new asn1js.Integer({ value: 0 })), parseDer(token, 'token')));
  }

  /** DER CMS `ContentInfo` token timestamping `digest` (the message imprint). */
  async token(digest: Uint8Array, algorithm = 'sha256', nonce?: bigint | null): Promise<Buffer> {
    this.serial += 1;
    const fields: TstFields = {
      version: 1,
      policy: TSA_POLICY,
      messageImprint: { algorithm, digest: Buffer.from(digest) },
      serialNumber: this.serial,
      genTime: this.genTime ?? wholeSecondsNow(),
      tsa: true,
    };
    if (nonce !== undefined && nonce !== null) fields.nonce = nonce + BigInt(this.nonceOffset);
    this.tamper?.(fields);
    const imprint = this.imprintOverride ?? fields.messageImprint.digest;
    const tstDer = encodeTstInfo({ ...fields, messageImprint: { algorithm: fields.messageImprint.algorithm, digest: imprint } });

    const essDer = certDer(this.essCert ?? this.cert);
    const attrs: asn1js.Sequence[] = [
      seqElement(oidElement(ATTR_CONTENT_TYPE), new asn1js.Set({ value: [oidElement(contentTypeOid(this.contentTypeAttr))] })),
      seqElement(oidElement(ATTR_MESSAGE_DIGEST), new asn1js.Set({ value: [octetElement(this.digestOverride ?? sha256(tstDer))] })),
    ];
    if (!this.omitEss) {
      const essHash = this.essV1
        ? bytesOf(createHash('sha1').update(essDer).digest())
        : sha256(essDer);
      const essAttr = this.essV1 ? ATTR_SIGNING_CERT : ATTR_SIGNING_CERT_V2;
      // SigningCertificate(V2) ::= SEQUENCE { certs SEQUENCE OF
      // ESSCertID(v2) }; each ESSCertID(v2) is itself a SEQUENCE holding the
      // cert hash (the v2 hash algorithm stays absent: SHA-256 is the default).
      attrs.push(seqElement(oidElement(essAttr), new asn1js.Set({ value: [seqElement(seqElement(seqElement(octetElement(essHash))))] })));
    }
    // The signature covers the DER `SET OF` (tag 0x31), not the [0] form.
    const setDer = Buffer.from(bytesOf(seqElement(...attrs).toBER(false)));
    setDer[0] = 0x31;

    const isRsa = this.key.privateKey.algorithm.name === 'RSASSA-PKCS1-v1_5';
    const rawSig = Buffer.from(
      await webcrypto.subtle.sign(isRsa ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }, this.key.privateKey, setDer),
    );
    let signature = isRsa ? rawSig : Buffer.from(rawEcdsaToDer(rawSig));
    if (this.corruptSignature) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 1;
    }

    const issuerDer = Buffer.from(bytesOf(this.cert.issuer.toSchema().toBER(false)));
    const issuerEl = parseDer(issuerDer, 'issuer');
    const serialHex = Buffer.from(blockView(this.cert.serialNumber.valueBlock)).toString('hex');
    const signerInfo = seqElement(
      new asn1js.Integer({ value: 1 }),
      seqElement(issuerEl, derInteger(BigInt(`0x${serialHex}`))),
      digestAlgorithmElement('sha256'),
      contextElement(0, ...attrs),
      isRsa
        ? seqElement(oidElement(RSA_SHA256_OID), new asn1js.Null())
        : seqElement(oidElement(ECDSA_SHA256_OID)),
      octetElement(signature),
    );

    const signedDataParts: asn1js.AsnType[] = [
      new asn1js.Integer({ value: 3 }),
      new asn1js.Set({ value: [digestAlgorithmElement('sha256')] }),
      seqElement(oidElement(TST_INFO_CONTENT_OID), contextElement(0, octetElement(tstDer))),
    ];
    if (this.includeCerts) {
      const certs = [this.cert, ...this.chain].map((c) => parseDer(certDer(c), 'certificate'));
      signedDataParts.push(contextElement(0, ...certs));
    }
    signedDataParts.push(new asn1js.Set({ value: [signerInfo] }));
    const signedData = seqElement(...signedDataParts);
    return derOf(seqElement(oidElement(SIGNED_DATA_OID), contextElement(0, signedData)));
  }
}
