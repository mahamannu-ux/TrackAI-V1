// RFC 3161 timestamp-authority anchoring adapter, and a token verifier that
// trusts nothing the TSA says without proof.
//
// `anchor(root, batchId)` asks the TSA to time-stamp sha256(root) with a fresh
// 63-bit nonce and `certReq`, then verifies the reply before accepting it.
// `verifyTimestampToken(token, root, anchors, opts)` accepts a token only if:
//  1. it is CMS SignedData encapsulating a TSTInfo v1, with no trailing bytes,
//     no indefinite lengths and no long-form short lengths (BER leniency that
//     would let one token take many byte forms is refused; the token ref is
//     the SHA-256 of the exact stored bytes);
//  2. the message imprint is the hash of `root` (sha256/384/512);
//  3. the nonce, when one was sent, is echoed back;
//  4. genTime lies in the caller's window (at anchor time: the request window
//     widened by the allowed clock skew) — closes SushiCorp A2b limitation #8;
//  5. there is exactly one signer, found among the token's certificates (issuer
//     and serial, or subject key ID); its signed attributes carry content-type
//     id-ct-TSTInfo, a message digest of the TSTInfo bytes, and an ESS
//     signing-certificate (v1 or v2) whose hash names that certificate;
//  6. the signature over the signed attributes verifies with the signer's key,
//     with a signature algorithm consistent with the digest algorithm;
//  7. the signer certificate carries a critical extended key usage of exactly
//     id-kp-timeStamping, is not a CA, allows digitalSignature or
//     nonRepudiation when it states a key usage, and is valid at genTime;
//  8. it chains, certificate by certificate (issuer name, signature with an
//     outer algorithm equal to the signed one, CA flag, keyCertSign when key
//     usage is stated, pathLenConstraint, validity at genTime), to a pinned
//     trust anchor; the search is bounded (32 certificates, 8 links, 256 checks);
//  9. no certificate on the path carries a critical extension we do not
//     process (RFC 5280 §4.2), and RSA keys are at least 2048 bits.
// Revocation of the TSA certificate has three states (TR-1): REVOKED fails the
// token, CLEAN and UNKNOWN pass, and UNKNOWN is never reported as CLEAN. With
// no revocation source configured every token records `unknown`
// (`no_source_configured`), which the proof states honestly (AGENTS.md §9 #19).
//
// Ported from SushiCorp A2b adapters/anchor/rfc3161.py and tsa.py @ 0bd67a5
// (catalog EV-2; revocation states from TR-1 core/trust/revocation.py).
// Deviations: (1) asn1js walks the CMS structure directly (raw bytes for the
// signed attributes and certificates, so nothing is re-encoded before it is
// hashed or verified); pkijs parses certificates and TSTInfo; Node's crypto
// verifies signatures; (2) errors.md codes: transport, HTTP status, content
// type and a non-granted status → TSA_UNAVAILABLE, any verification failure →
// TSA_TOKEN_INVALID; (3) genTime bound and three-state revocation added;
// (4) the batch cache is bounded (A2b limitation #11) and token and response
// sizes are bounded; (5) results carry the DER token and its facts as data
// rather than a bytes blob; (6) Ed448 dropped (no public TSA uses it);
// (7) added checks 7–9 beyond the source (signer not a CA, signer key usage,
// pathLen, outer/inner algorithm, unknown critical extensions, RSA size).
// Not covered: revocation of intermediate CA certificates (only the TSA
// certificate goes to the revocation source).

import { createHash, createPublicKey, constants, randomBytes, verify, type KeyObject } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  AnchorError,
  AnchorInputError,
  BoundedCache,
  assertAnchorInput,
  fetchWithTimeout,
  readCapped,
  type FetchLike,
} from './anchor-contract';

export const TIMESTAMP_QUERY = 'application/timestamp-query';
export const TIMESTAMP_REPLY = 'application/timestamp-reply';
export const TSA_REF_PREFIX = 'tsa:sha256:';
export const MAX_CHAIN_DEPTH = 8;
export const MAX_TOKEN_CERTS = 32;
export const MAX_CHAIN_CHECKS = 256;
export const MAX_TSA_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_TSA_TIMEOUT_MS = 10_000;
export const DEFAULT_TSA_CLOCK_SKEW_MS = 5 * 60_000;

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  essV1: '1.2.840.113549.1.9.16.2.12',
  essV2: '1.2.840.113549.1.9.16.2.47',
  eku: '2.5.29.37',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  ski: '2.5.29.14',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  ed25519: '1.3.101.112',
} as const;

const HASH_BY_OID: Record<string, 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
const OID_BY_HASH: Record<string, string> = Object.fromEntries(Object.entries(HASH_BY_OID).map(([o, h]) => [h, o]));
/** Signature algorithm OID → (kind, hash it names, or null when the digest algorithm decides). */
const SIG_ALGS: Record<string, { kind: 'ecdsa' | 'rsa' | 'rsa-pss' | 'ed25519'; hash: string | null }> = {
  '1.2.840.10045.4.3.2': { kind: 'ecdsa', hash: 'sha256' },
  '1.2.840.10045.4.3.3': { kind: 'ecdsa', hash: 'sha384' },
  '1.2.840.10045.4.3.4': { kind: 'ecdsa', hash: 'sha512' },
  '1.2.840.113549.1.1.11': { kind: 'rsa', hash: 'sha256' },
  '1.2.840.113549.1.1.12': { kind: 'rsa', hash: 'sha384' },
  '1.2.840.113549.1.1.13': { kind: 'rsa', hash: 'sha512' },
  [OID.rsaEncryption]: { kind: 'rsa', hash: null },
  [OID.rsaPss]: { kind: 'rsa-pss', hash: null },
  [OID.ed25519]: { kind: 'ed25519', hash: null },
};
const STRONG_HASHES = new Set(['sha256', 'sha384', 'sha512']);
const MIN_RSA_BITS = 2048;
/** Extensions this verifier processes or may safely ignore; any other critical extension fails the path. */
const KNOWN_EXTENSIONS = new Set([
  '2.5.29.14', // subject key identifier
  '2.5.29.15', // key usage
  '2.5.29.17', // subject alternative name
  '2.5.29.19', // basic constraints
  '2.5.29.31', // CRL distribution points
  '2.5.29.32', // certificate policies (no policy processing; informational for a TSA)
  '2.5.29.35', // authority key identifier
  '2.5.29.37', // extended key usage
  '1.3.6.1.5.5.7.1.1', // authority information access
]);

/** A token (or response) failed verification. The message is a reason, never a raw value. */
export class TimestampVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampVerificationError';
  }
}

/** The TSA answered with a status other than granted / grantedWithMods. */
export class TimestampRejectedError extends TimestampVerificationError {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampRejectedError';
  }
}

export type RevocationStatus = 'revoked' | 'clean' | 'unknown';

export interface RevocationResult {
  status: RevocationStatus;
  /** Machine-readable reason, e.g. `no_source_configured`, `ocsp_good`, `timeout`. */
  reason: string;
}

/**
 * A revocation source for the TSA certificate (OCSP, CRL). Implementations
 * return `unknown` for timeouts, errors, stale or unverifiable answers; a
 * thrown error is treated as `unknown` too, never `clean`.
 */
export interface TsaRevocationChecker {
  check(signerCertDer: Buffer, issuerCertDer: Buffer | null, at: Date): Promise<RevocationResult>;
}

export interface TimestampInfo {
  genTime: Date;
  /** Decimal string: TSA serials can exceed 2^53. */
  serialNumber: string;
  policy: string;
  hashAlgorithm: string;
  /** CN of the signer certificate, when it has one. */
  signerSubject: string | null;
  nonce: bigint | null;
  /** DER of the signer certificate and of the certificate it chained through first (null when pinned). */
  signerCertDer: Buffer;
  issuerCertDer: Buffer | null;
}

export interface VerifyTokenOptions {
  /** The nonce sent in the request; the token must echo it. */
  nonce?: bigint;
  /** genTime must not be earlier than this. */
  genTimeNotBefore?: Date;
  /** genTime must not be later than this. */
  genTimeNotAfter?: Date;
}

// ---------------------------------------------------------------------------
// ASN.1 helpers
// ---------------------------------------------------------------------------

function ab(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Reject the BER freedoms a DER token never uses: indefinite lengths, long-form short lengths. */
function assertDerLengths(el: asn1js.AsnType, what: string, depth = 0): void {
  if (depth > 64) throw new TimestampVerificationError(`malformed ${what}`);
  const len = el.lenBlock as unknown as { isIndefiniteForm: boolean; longFormUsed: boolean; length: number; blockLength: number };
  if (len.isIndefiniteForm) throw new TimestampVerificationError(`${what} is not DER (indefinite length)`);
  // Long form: one count byte plus the fewest bytes that hold the length, and only for lengths >= 128.
  const minimal = len.length < 128 ? 0 : Math.ceil(len.length.toString(16).length / 2);
  if (len.longFormUsed && (len.length < 128 || len.blockLength !== 1 + minimal)) {
    throw new TimestampVerificationError(`${what} is not DER (non-minimal length)`);
  }
  const inner = (el as { valueBlock?: { value?: unknown } }).valueBlock?.value;
  if (el.idBlock.isConstructed && Array.isArray(inner)) {
    for (const child of inner as asn1js.AsnType[]) assertDerLengths(child, what, depth + 1);
  }
}

/** Strict parse: one element, no trailing bytes, DER lengths. */
function parseDer(bytes: Uint8Array, what: string): asn1js.AsnType {
  const parsed = asn1js.fromBER(ab(bytes));
  if (parsed.offset === -1 || parsed.offset !== bytes.byteLength) {
    throw new TimestampVerificationError(`malformed ${what}`);
  }
  assertDerLengths(parsed.result, what);
  return parsed.result;
}

function raw(el: asn1js.AsnType): Buffer {
  return Buffer.from((el as unknown as { valueBeforeDecodeView: Uint8Array }).valueBeforeDecodeView);
}

function children(el: asn1js.AsnType | undefined, what: string): asn1js.AsnType[] {
  const value = (el as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock?.value;
  if (!Array.isArray(value)) throw new TimestampVerificationError(`malformed ${what}`);
  return value as asn1js.AsnType[];
}

function isTagged(el: asn1js.AsnType | undefined, n: number): boolean {
  return !!el && el.idBlock.tagClass === 3 && el.idBlock.tagNumber === n;
}

function oidOf(el: asn1js.AsnType | undefined, what: string): string {
  if (!(el instanceof asn1js.ObjectIdentifier)) throw new TimestampVerificationError(`malformed ${what}`);
  return el.valueBlock.toString();
}

function octets(el: asn1js.AsnType | undefined, what: string): Buffer {
  if (!(el instanceof asn1js.OctetString)) throw new TimestampVerificationError(`malformed ${what}`);
  if (el.idBlock.isConstructed) {
    return Buffer.concat(children(el, what).map((c) => octets(c, what)));
  }
  return Buffer.from(el.valueBlock.valueHexView);
}

function bigintOf(el: asn1js.AsnType | undefined, what: string): bigint {
  if (!(el instanceof asn1js.Integer)) throw new TimestampVerificationError(`malformed ${what}`);
  const bytes = Buffer.from(el.valueBlock.valueHexView);
  if (bytes.length === 0) throw new TimestampVerificationError(`malformed ${what}`);
  let v = BigInt(`0x${bytes.toString('hex')}`);
  if ((bytes[0] & 0x80) !== 0) v -= 1n << BigInt(bytes.length * 8);
  return v;
}

function derInteger(value: bigint): asn1js.Integer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return new asn1js.Integer({ valueHex: ab(bytes) });
}

function hashOf(name: string, data: Uint8Array): Buffer {
  return createHash(name).update(data).digest();
}

function certDer(cert: pkijs.Certificate): Buffer {
  return Buffer.from(cert.toSchema(true).toBER(false));
}

function loadCert(der: Buffer): pkijs.Certificate {
  try {
    return new pkijs.Certificate({ schema: parseDer(der, 'certificate') });
  } catch {
    throw new TimestampVerificationError('unreadable certificate in token');
  }
}

function extension(cert: pkijs.Certificate, oid: string): pkijs.Extension | undefined {
  const found = (cert.extensions ?? []).filter((e) => e.extnID === oid);
  if (found.length > 1) throw new TimestampVerificationError('certificate repeats an extension');
  return found[0];
}

function extValue(ext: pkijs.Extension): asn1js.AsnType {
  return parseDer(Buffer.from(ext.extnValue.valueBlock.valueHexView), 'certificate extension');
}

function validAt(cert: pkijs.Certificate, when: Date): boolean {
  return cert.notBefore.value.getTime() <= when.getTime() && when.getTime() <= cert.notAfter.value.getTime();
}

function cnOf(cert: pkijs.Certificate): string | null {
  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === '2.5.4.3') {
      const v = tv.value as unknown as { valueBlock?: { value?: unknown } };
      return typeof v.valueBlock?.value === 'string' ? v.valueBlock.value : null;
    }
  }
  return null;
}

function spkiKey(cert: pkijs.Certificate): KeyObject {
  try {
    return createPublicKey({ key: Buffer.from(cert.subjectPublicKeyInfo.toSchema().toBER(false)), format: 'der', type: 'spki' });
  } catch {
    throw new TimestampVerificationError('certificate public key is unusable');
  }
}

/** Verify `signature` over `message` with `key` under a signature algorithm (and, for rsaEncryption, a digest). */
function verifyWith(
  key: KeyObject,
  alg: { oid: string; params?: asn1js.AsnType },
  digest: string | null,
  message: Buffer,
  signature: Buffer,
): boolean {
  const spec = SIG_ALGS[alg.oid];
  if (!spec) throw new TimestampVerificationError('unsupported signature algorithm');
  if (spec.hash && digest && spec.hash !== digest) {
    throw new TimestampVerificationError('signature algorithm and digest algorithm disagree');
  }
  try {
    switch (spec.kind) {
      case 'ecdsa': {
        const hash = spec.hash ?? digest;
        if (key.asymmetricKeyType !== 'ec' || !hash) throw new TimestampVerificationError('key does not match the signature algorithm');
        return verify(hash, message, { key, dsaEncoding: 'der' }, signature);
      }
      case 'rsa': {
        const hash = spec.hash ?? digest;
        if (key.asymmetricKeyType !== 'rsa' || !hash || !STRONG_HASHES.has(hash)) {
          throw new TimestampVerificationError('key does not match the signature algorithm');
        }
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) throw new TimestampVerificationError('RSA key too small');
        return verify(hash, message, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
      }
      case 'rsa-pss': {
        if (key.asymmetricKeyType !== 'rsa' || !alg.params) throw new TimestampVerificationError('key does not match the signature algorithm');
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) throw new TimestampVerificationError('RSA key too small');
        const params = new pkijs.RSASSAPSSParams({ schema: alg.params });
        const hash = HASH_BY_OID[params.hashAlgorithm.algorithmId];
        const mgfHash = params.maskGenAlgorithm.algorithmId === OID.mgf1 && params.maskGenAlgorithm.algorithmParams
          ? HASH_BY_OID[new pkijs.AlgorithmIdentifier({ schema: params.maskGenAlgorithm.algorithmParams }).algorithmId]
          : undefined;
        if (!hash || !STRONG_HASHES.has(hash) || mgfHash !== hash || (digest && digest !== hash)) {
          throw new TimestampVerificationError('unsupported RSASSA-PSS parameters');
        }
        return verify(hash, message, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: params.saltLength }, signature);
      }
      case 'ed25519':
        if (key.asymmetricKeyType !== 'ed25519') throw new TimestampVerificationError('key does not match the signature algorithm');
        return verify(null, message, key, signature);
    }
  } catch (err) {
    if (err instanceof TimestampVerificationError) throw err;
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/** 63 random bits, never zero. */
export function newNonce(): bigint {
  const b = randomBytes(8);
  b[0] &= 0x7f;
  return BigInt(`0x${b.toString('hex')}`) | 1n;
}

/** DER TimeStampReq over hash(data), with `nonce` and `certReq`. */
export function buildTimeStampReq(data: Buffer, nonce: bigint, hashAlgorithm = 'sha256'): Buffer {
  const oid = OID_BY_HASH[hashAlgorithm];
  if (!oid || !STRONG_HASHES.has(hashAlgorithm)) throw new TimestampVerificationError('unsupported hash algorithm');
  if (nonce <= 0n) throw new RangeError('nonce must be positive');
  const req = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 1 }),
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: oid }), new asn1js.Null()] }),
          new asn1js.OctetString({ valueHex: ab(hashOf(hashAlgorithm, data)) }),
        ],
      }),
      derInteger(nonce),
      new asn1js.Boolean({ value: true }),
    ],
  });
  return Buffer.from(req.toBER(false));
}

/** The DER TimeStampToken from a TimeStampResp; throws unless the status is granted (0) or grantedWithMods (1). */
export function tokenFromResponse(response: Buffer): Buffer {
  const resp = parseDer(response, 'time-stamp response');
  const parts = children(resp, 'time-stamp response');
  const statusInfo = children(parts[0], 'PKIStatusInfo');
  const status = bigintOf(statusInfo[0], 'PKIStatus');
  if (status !== 0n && status !== 1n) throw new TimestampRejectedError(`TSA refused the request (status ${status})`);
  if (parts.length !== 2) throw new TimestampVerificationError('granted response carries no token');
  return raw(parts[1]);
}

/** Parse every certificate in a PEM bundle. */
export function loadTrustAnchors(pem: string): pkijs.Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const anchors = blocks.map((b) => loadCert(Buffer.from(b.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''), 'base64')));
  if (anchors.length === 0) throw new TimestampVerificationError('no TSA trust anchors configured');
  return anchors;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface ParsedToken {
  tstBytes: Buffer;
  tst: pkijs.TSTInfo;
  certs: Buffer[];
  signerInfo: asn1js.AsnType[];
}

function parseToken(token: Buffer): ParsedToken {
  const ci = children(parseDer(token, 'time-stamp token'), 'ContentInfo');
  if (ci.length !== 2 || oidOf(ci[0], 'content type') !== OID.signedData || !isTagged(ci[1], 0)) {
    throw new TimestampVerificationError('token is not CMS SignedData');
  }
  const sd = children(children(ci[1], 'SignedData wrapper')[0], 'SignedData');
  const encap = children(sd[2], 'encapsulated content');
  if (oidOf(encap[0], 'encapsulated content type') !== OID.tstInfo || !isTagged(encap[1], 0)) {
    throw new TimestampVerificationError('token does not encapsulate a TSTInfo');
  }
  const tstBytes = octets(children(encap[1], 'TSTInfo wrapper')[0], 'TSTInfo');
  let tst: pkijs.TSTInfo;
  try {
    tst = new pkijs.TSTInfo({ schema: parseDer(tstBytes, 'TSTInfo') });
  } catch (err) {
    if (err instanceof TimestampVerificationError) throw err;
    throw new TimestampVerificationError('unreadable TSTInfo');
  }
  if (tst.version !== 1) throw new TimestampVerificationError('TSTInfo version is not 1');
  let certs: Buffer[] = [];
  let i = 3;
  if (isTagged(sd[i], 0)) {
    certs = children(sd[i], 'certificates').map(raw);
    i++;
  }
  if (isTagged(sd[i], 1)) i++;
  const signerInfos = children(sd[i], 'signer infos');
  if (i !== sd.length - 1) throw new TimestampVerificationError('malformed SignedData');
  if (signerInfos.length !== 1) throw new TimestampVerificationError(`expected one signer, found ${signerInfos.length}`);
  if (certs.length > MAX_TOKEN_CERTS) throw new TimestampVerificationError(`token carries more than ${MAX_TOKEN_CERTS} certificates`);
  return { tstBytes, tst, certs, signerInfo: children(signerInfos[0], 'signer info') };
}

function skiOf(cert: pkijs.Certificate): Buffer | null {
  const ext = extension(cert, OID.ski);
  return ext ? octets(extValue(ext), 'subject key identifier') : null;
}

function findSigner(sid: asn1js.AsnType, certs: Buffer[]): { der: Buffer; cert: pkijs.Certificate } {
  for (const der of certs) {
    const cert = loadCert(der);
    if (isTagged(sid, 0)) {
      const ski = skiOf(cert);
      if (ski && ski.equals(Buffer.from((sid as asn1js.Primitive).valueBlock.valueHexView))) return { der, cert };
    } else {
      const ias = children(sid, 'signer identifier');
      if (ias.length !== 2) throw new TimestampVerificationError('malformed signer identifier');
      const issuer = new pkijs.RelativeDistinguishedNames({ schema: ias[0] });
      if (cert.issuer.isEqual(issuer) && bigintOf(cert.serialNumber, 'serial') === bigintOf(ias[1], 'serial')) {
        return { der, cert };
      }
    }
  }
  throw new TimestampVerificationError('the signer certificate is not in the token');
}

function signedAttribute(attrs: asn1js.AsnType[], oid: string): asn1js.AsnType | null {
  const found = attrs.filter((a) => oidOf(children(a, 'attribute')[0], 'attribute type') === oid);
  if (found.length === 0) return null;
  const values = children(children(found[0], 'attribute')[1], 'attribute values');
  if (found.length !== 1 || values.length !== 1) throw new TimestampVerificationError('signed attribute repeated');
  return values[0];
}

function checkSignedAttributes(attrs: asn1js.AsnType[], digest: string, tstBytes: Buffer, signerDer: Buffer): void {
  const ct = signedAttribute(attrs, OID.contentType);
  if (!ct || oidOf(ct, 'content-type attribute') !== OID.tstInfo) {
    throw new TimestampVerificationError('signed content-type is not id-ct-TSTInfo');
  }
  const md = signedAttribute(attrs, OID.messageDigest);
  if (!md || !octets(md, 'message-digest attribute').equals(hashOf(digest, tstBytes))) {
    throw new TimestampVerificationError('signed message digest does not match the TSTInfo');
  }
  const v2 = signedAttribute(attrs, OID.essV2);
  let alg: string;
  let expected: Buffer;
  if (v2) {
    const first = children(children(v2, 'ESS v2')[0], 'ESS v2 certs')[0];
    const parts = children(first, 'ESSCertIDv2');
    if (parts[0] instanceof asn1js.Sequence) {
      alg = HASH_BY_OID[oidOf(children(parts[0], 'ESS hash algorithm')[0], 'ESS hash algorithm')] ?? '';
      expected = octets(parts[1], 'ESS cert hash');
    } else {
      alg = 'sha256';
      expected = octets(parts[0], 'ESS cert hash');
    }
  } else {
    const v1 = signedAttribute(attrs, OID.essV1);
    if (!v1) throw new TimestampVerificationError('token lacks an ESS signing-certificate attribute');
    const first = children(children(v1, 'ESS v1')[0], 'ESS v1 certs')[0];
    alg = 'sha1';
    expected = octets(children(first, 'ESSCertID')[0], 'ESS cert hash');
  }
  if (!alg) throw new TimestampVerificationError('unsupported ESS hash');
  if (!hashOf(alg, signerDer).equals(expected)) throw new TimestampVerificationError('ESS signing-certificate does not name the signer');
}

function checkCriticalExtensions(cert: pkijs.Certificate): void {
  for (const e of cert.extensions ?? []) {
    if (e.critical && !KNOWN_EXTENSIONS.has(e.extnID)) {
      throw new TimestampVerificationError('certificate carries an unsupported critical extension');
    }
  }
}

function keyUsageBits(cert: pkijs.Certificate): Buffer | null {
  const ku = extension(cert, OID.keyUsage);
  if (!ku) return null;
  const bits = extValue(ku);
  if (!(bits instanceof asn1js.BitString)) throw new TimestampVerificationError('malformed key usage');
  return Buffer.from(bits.valueBlock.valueHexView);
}

function checkTsaCertificate(cert: pkijs.Certificate, genTime: Date): void {
  checkCriticalExtensions(cert);
  if (isCa(cert)) throw new TimestampVerificationError('signer certificate is a CA, not a time-stamping certificate');
  const ku = keyUsageBits(cert);
  if (ku && (ku.length === 0 || (ku[0] & 0xc0) === 0)) {
    throw new TimestampVerificationError('signer certificate key usage does not allow signing');
  }
  const eku = extension(cert, OID.eku);
  if (!eku) throw new TimestampVerificationError('signer certificate has no extended key usage');
  const purposes = new pkijs.ExtKeyUsage({ schema: extValue(eku) }).keyPurposes;
  if (!eku.critical || purposes.length !== 1 || purposes[0] !== OID.timeStamping) {
    throw new TimestampVerificationError('signer certificate is not a time-stamping certificate (critical EKU id-kp-timeStamping only)');
  }
  if (!validAt(cert, genTime)) throw new TimestampVerificationError('signer certificate was not valid at genTime');
}

function isCa(cert: pkijs.Certificate): boolean {
  const bc = extension(cert, OID.basicConstraints);
  return !!bc && new pkijs.BasicConstraints({ schema: extValue(bc) }).cA === true;
}

/** `below` = CA certificates between this issuer and the leaf (for pathLenConstraint). */
function canIssue(cert: pkijs.Certificate, when: Date, below: number): boolean {
  if (!isCa(cert) || !validAt(cert, when)) return false;
  try {
    checkCriticalExtensions(cert);
  } catch {
    return false;
  }
  const bc = new pkijs.BasicConstraints({ schema: extValue(extension(cert, OID.basicConstraints)!) });
  const pathLen = bc.pathLenConstraint;
  if (pathLen !== undefined) {
    const n = typeof pathLen === 'number' ? pathLen : Number((pathLen as asn1js.Integer).valueBlock.valueDec);
    if (!Number.isSafeInteger(n) || below > n) return false;
  }
  const bytes = keyUsageBits(cert);
  if (bytes === null) return true;
  return bytes.length > 0 && (bytes[0] & 0x04) !== 0; // keyCertSign is bit 5
}

function issuedBy(child: pkijs.Certificate, issuer: pkijs.Certificate): boolean {
  if (!child.issuer.isEqual(issuer.subject)) return false;
  if (!child.signatureAlgorithm.isEqual(child.signature)) return false; // outer algorithm must equal the signed one
  const alg = { oid: child.signatureAlgorithm.algorithmId, params: child.signatureAlgorithm.algorithmParams as asn1js.AsnType | undefined };
  if (SIG_ALGS[alg.oid]?.hash === null && alg.oid !== OID.rsaPss && alg.oid !== OID.ed25519) return false;
  try {
    return verifyWith(spkiKey(issuer), alg, null, Buffer.from(child.tbsView), Buffer.from(child.signatureValue.valueBlock.valueHexView));
  } catch {
    return false;
  }
}

/** Some issuer path from `leaf` to a pinned anchor, every hop checked at `when`. Returns the first issuer used (null when pinned). */
function checkChain(leafDer: Buffer, leaf: pkijs.Certificate, poolDers: Buffer[], anchorDers: Buffer[], when: Date): Buffer | null {
  if (anchorDers.some((a) => a.equals(leafDer))) return null; // a pinned TSA certificate is its own anchor
  const candidates = new Map<string, { der: Buffer; cert: pkijs.Certificate }>();
  for (const der of [...anchorDers, ...poolDers]) {
    const k = der.toString('hex');
    if (!candidates.has(k)) candidates.set(k, { der, cert: loadCert(der) });
  }
  const anchorSet = new Set(anchorDers.map((d) => d.toString('hex')));
  let budget = MAX_CHAIN_CHECKS;
  // `below`: CA certificates already on the path under the issuer being tried.
  const reaches = (cert: pkijs.Certificate, path: Set<string>, below: number): boolean => {
    if (path.size > MAX_CHAIN_DEPTH) return false;
    for (const [k, issuer] of candidates) {
      if (path.has(k) || !cert.issuer.isEqual(issuer.cert.subject)) continue;
      if (--budget < 0) throw new TimestampVerificationError('TSA certificate chain search exceeded its budget');
      if (!issuedBy(cert, issuer.cert) || !canIssue(issuer.cert, when, below)) continue;
      if (anchorSet.has(k) || reaches(issuer.cert, new Set([...path, k]), below + 1)) return true;
    }
    return false;
  };
  for (const [k, issuer] of candidates) {
    if (!leaf.issuer.isEqual(issuer.cert.subject)) continue;
    if (--budget < 0) throw new TimestampVerificationError('TSA certificate chain search exceeded its budget');
    if (!issuedBy(leaf, issuer.cert) || !canIssue(issuer.cert, when, 0)) continue;
    if (anchorSet.has(k) || reaches(issuer.cert, new Set([leafDer.toString('hex'), k]), 1)) return issuer.der;
  }
  throw new TimestampVerificationError('TSA certificate does not chain to a configured trust anchor through CA certificates valid at genTime');
}

/**
 * Verify `token` (DER TimeStampToken) over `data` (the batch root). See the
 * top of this file. Every failure is a TimestampVerificationError.
 */
export function verifyTimestampToken(
  token: Buffer,
  data: Buffer,
  anchors: pkijs.Certificate[],
  opts: VerifyTokenOptions = {},
): TimestampInfo {
  if (anchors.length === 0) throw new TimestampVerificationError('no TSA trust anchors configured');
  try {
    return verifyToken(token, data, anchors, opts);
  } catch (err) {
    if (err instanceof TimestampVerificationError) throw err;
    throw new TimestampVerificationError('malformed time-stamp token');
  }
}

function verifyToken(token: Buffer, data: Buffer, anchors: pkijs.Certificate[], opts: VerifyTokenOptions): TimestampInfo {
  if (!Buffer.isBuffer(token) || token.length > MAX_TSA_RESPONSE_BYTES) throw new TimestampVerificationError('token too large');
  const { tstBytes, tst, certs, signerInfo } = parseToken(token);

  const imprintAlg = HASH_BY_OID[tst.messageImprint.hashAlgorithm.algorithmId];
  if (!imprintAlg || !STRONG_HASHES.has(imprintAlg)) throw new TimestampVerificationError('unsupported imprint hash algorithm');
  if (!Buffer.from(tst.messageImprint.hashedMessage.valueBlock.valueHexView).equals(hashOf(imprintAlg, data))) {
    throw new TimestampVerificationError('message imprint does not match the timestamped data');
  }
  const echoed = tst.nonce ? bigintOf(tst.nonce, 'nonce') : null;
  if (opts.nonce !== undefined && echoed !== opts.nonce) {
    throw new TimestampVerificationError('nonce in the token does not match the request');
  }
  const genTime = tst.genTime;
  if (!(genTime instanceof Date) || Number.isNaN(genTime.getTime())) throw new TimestampVerificationError('token has no genTime');
  if ((opts.genTimeNotBefore && genTime < opts.genTimeNotBefore) || (opts.genTimeNotAfter && genTime > opts.genTimeNotAfter)) {
    throw new TimestampVerificationError('genTime is outside the allowed window');
  }

  // SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1]? }
  if (signerInfo.length < 6 || !isTagged(signerInfo[3], 0)) throw new TimestampVerificationError('token has no signed attributes');
  const digest = HASH_BY_OID[oidOf(children(signerInfo[2], 'digest algorithm')[0], 'digest algorithm')];
  if (!digest || !STRONG_HASHES.has(digest)) throw new TimestampVerificationError('unsupported digest algorithm');
  const signer = findSigner(signerInfo[1], certs);
  checkSignedAttributes(children(signerInfo[3], 'signed attributes'), digest, tstBytes, signer.der);

  const sigAlgParts = children(signerInfo[4], 'signature algorithm');
  const signedAttrsSet = Buffer.from(raw(signerInfo[3]));
  signedAttrsSet[0] = 0x31; // the signature covers the SET OF form (RFC 5652 §5.4)
  const ok = verifyWith(spkiKey(signer.cert), { oid: oidOf(sigAlgParts[0], 'signature algorithm'), params: sigAlgParts[1] },
    digest, signedAttrsSet, octets(signerInfo[5], 'signature'));
  if (!ok) throw new TimestampVerificationError('token signature does not verify');

  checkTsaCertificate(signer.cert, genTime);
  const issuerDer = checkChain(signer.der, signer.cert, certs, anchors.map(certDer), genTime);

  return {
    genTime,
    serialNumber: bigintOf(tst.serialNumber, 'serial').toString(10),
    policy: tst.policy,
    hashAlgorithm: imprintAlg,
    signerSubject: cnOf(signer.cert),
    nonce: echoed,
    signerCertDer: signer.der,
    issuerCertDer: issuerDer,
  };
}

/** Run a revocation source; anything but a well-formed answer is `unknown`, never `clean`. */
export async function checkTsaRevocation(info: TimestampInfo, checker: TsaRevocationChecker | undefined): Promise<RevocationResult> {
  if (!checker) return { status: 'unknown', reason: 'no_source_configured' };
  try {
    const r = await checker.check(info.signerCertDer, info.issuerCertDer, info.genTime);
    if (r && (r.status === 'revoked' || r.status === 'clean' || r.status === 'unknown') && typeof r.reason === 'string') return r;
    return { status: 'unknown', reason: 'malformed_answer' };
  } catch {
    return { status: 'unknown', reason: 'source_error' };
  }
}

export function tsaTokenRef(token: Buffer): string {
  return TSA_REF_PREFIX + createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface TsaAnchorResult {
  type: 'tsa';
  /** `tsa:sha256:<hex of the DER token>`. */
  ref: string;
  tokenDer: Buffer;
  /** RFC 3339 genTime. */
  anchoredAt: string;
  serialNumber: string;
  policy: string;
  revocation: RevocationResult;
}

export interface TsaAnchorOptions {
  url: string;
  /** PEM of the certificates a TSA certificate must chain to (or the TSA certificate itself, pinned). */
  trustAnchorsPem: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  hashAlgorithm?: 'sha256' | 'sha384' | 'sha512';
  /** Allowed difference between the TSA's clock and ours around the request window. */
  maxClockSkewMs?: number;
  revocation?: TsaRevocationChecker;
  cacheSize?: number;
  now?: () => Date;
}

export class TsaAnchor {
  private readonly url: string;
  private readonly anchors: pkijs.Certificate[];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly hashAlgorithm: string;
  private readonly skewMs: number;
  private readonly revocation?: TsaRevocationChecker;
  private readonly batches: BoundedCache<string, { root: Buffer; result: TsaAnchorResult }>;
  private readonly now: () => Date;

  constructor(opts: TsaAnchorOptions) {
    if (!opts.url) throw new RangeError('a TSA anchor needs a URL');
    this.url = opts.url;
    this.anchors = loadTrustAnchors(opts.trustAnchorsPem);
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TSA_TIMEOUT_MS;
    this.hashAlgorithm = opts.hashAlgorithm ?? 'sha256';
    this.skewMs = opts.maxClockSkewMs ?? DEFAULT_TSA_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.skewMs) || this.skewMs < 0) throw new RangeError('maxClockSkewMs must be a non-negative integer');
    this.revocation = opts.revocation;
    this.batches = new BoundedCache(opts.cacheSize ?? 1024);
    this.now = opts.now ?? (() => new Date());
  }

  get trustAnchors(): pkijs.Certificate[] {
    return [...this.anchors];
  }

  /** Time-stamp `root` for `batchId`; the token is verified before it is returned. */
  async anchor(root: Buffer, batchId: string): Promise<TsaAnchorResult> {
    assertAnchorInput(root, batchId);
    const seen = this.batches.get(batchId);
    if (seen) {
      if (!seen.root.equals(root)) throw new AnchorInputError('batch_id was already anchored with a different root');
      return seen.result;
    }
    const nonce = newNonce();
    const started = this.now();
    const reply = await this.post(buildTimeStampReq(root, nonce, this.hashAlgorithm));
    const ended = this.now();
    let token: Buffer;
    let info: TimestampInfo;
    try {
      token = tokenFromResponse(reply);
      info = verifyTimestampToken(token, root, this.anchors, {
        nonce,
        genTimeNotBefore: new Date(started.getTime() - this.skewMs),
        genTimeNotAfter: new Date(ended.getTime() + this.skewMs),
      });
    } catch (err) {
      if (err instanceof TimestampRejectedError) {
        throw new AnchorError('ATTESTA_ANCHOR_TSA_UNAVAILABLE', err.message);
      }
      if (err instanceof TimestampVerificationError) {
        throw new AnchorError('ATTESTA_ANCHOR_TSA_TOKEN_INVALID', `TSA returned a token that does not verify: ${err.message}`);
      }
      throw err;
    }
    const revocation = await checkTsaRevocation(info, this.revocation);
    if (revocation.status === 'revoked') {
      throw new AnchorError('ATTESTA_ANCHOR_TSA_TOKEN_INVALID', 'TSA certificate is revoked');
    }
    const result: TsaAnchorResult = {
      type: 'tsa',
      ref: tsaTokenRef(token),
      tokenDer: token,
      anchoredAt: info.genTime.toISOString(),
      serialNumber: info.serialNumber,
      policy: info.policy,
      revocation,
    };
    this.batches.set(batchId, { root: Buffer.from(root), result });
    return result;
  }

  /** Check a stored token against the pinned anchors; null when it fails. */
  verifyToken(token: Buffer, root: Buffer, opts: Omit<VerifyTokenOptions, 'nonce'> = {}): TimestampInfo | null {
    try {
      return verifyTimestampToken(token, root, this.anchors, opts);
    } catch (err) {
      if (err instanceof TimestampVerificationError) return null;
      throw err;
    }
  }

  /** The TSA answers HTTP at all (a TSA has no status endpoint). */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  private async post(request: Buffer): Promise<Buffer> {
    const res = await fetchWithTimeout(this.fetchImpl, this.url, {
      method: 'POST',
      headers: { 'Content-Type': TIMESTAMP_QUERY, Accept: TIMESTAMP_REPLY },
      body: request,
    }, this.timeoutMs, 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', 'TSA');
    if (res.status !== 200) throw new AnchorError('ATTESTA_ANCHOR_TSA_UNAVAILABLE', `TSA returned HTTP ${res.status}`);
    const kind = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (kind && kind !== TIMESTAMP_REPLY) {
      throw new AnchorError('ATTESTA_ANCHOR_TSA_UNAVAILABLE', `TSA returned ${kind}, not ${TIMESTAMP_REPLY}`);
    }
    return readCapped(res, MAX_TSA_RESPONSE_BYTES,
      { unavailable: 'ATTESTA_ANCHOR_TSA_UNAVAILABLE', tooLarge: 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID' }, 'TSA');
  }
}
