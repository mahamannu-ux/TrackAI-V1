// Google Cloud KMS provider for `KmsSigner`: getPublicKey + asymmetricSign
// over an injected `KeyManagementServiceClient`, so tests inject a fake that
// implements just the SDK calls used. Every response is integrity-checked:
// the public key must use `EC_SIGN_P256_SHA256` and its `pemCrc32c` must
// match the PEM; a signature is accepted only when `verifiedDigestCrc32c`
// is true, the response `name` equals the request and `signatureCrc32c`
// matches the signature. Anything that fails these checks is refused
// (`SigningRejected`): the KMS answered with something unverifiable, so
// retrying cannot help. Transport failures map by gRPC code:
// PERMISSION_DENIED/NOT_FOUND/FAILED_PRECONDITION/INVALID_ARGUMENT are
// terminal; UNAVAILABLE/DEADLINE_EXCEEDED/RESOURCE_EXHAUSTED and anything
// unrecognised are retryable (`SigningUnavailable`). Messages carry the gRPC
// code name only, never key material, resource names or server detail text.
//
// Ported from SushiCorp A1b adapters/signing/kms_google.py @ 0bd67a5
// (catalog SG-1). Deviations: the CRC32C checks above (SushiCorp trusted the
// transport); the algorithm allow-list covers P-256 only and accepts the
// numeric enum form real servers return; DER SPKI is returned directly.

import { createPublicKey } from 'node:crypto';
import { KeyManagementServiceClient, protos } from '@google-cloud/kms';
import { SigningRejected, SigningUnavailable } from './signer-contract';
import type { KmsProvider } from './signer-kms';

/** Numeric value of CryptoKeyVersionAlgorithm.EC_SIGN_P256_SHA256. */
const EC_SIGN_P256_SHA256 = 12;

/** gRPC codes that are terminal: the request itself is bad. */
const REJECTED_GRPC_CODES = new Map<number, string>([
  [3, 'INVALID_ARGUMENT'],
  [5, 'NOT_FOUND'],
  [7, 'PERMISSION_DENIED'],
  [9, 'FAILED_PRECONDITION'],
]);

const GRPC_CODE_NAMES = new Map<number, string>([
  ...REJECTED_GRPC_CODES,
  [1, 'CANCELLED'],
  [4, 'DEADLINE_EXCEEDED'],
  [8, 'RESOURCE_EXHAUSTED'],
  [10, 'ABORTED'],
  [13, 'INTERNAL'],
  [14, 'UNAVAILABLE'],
  [15, 'DATA_LOSS'],
  [16, 'UNAUTHENTICATED'],
]);

function grpcCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number' && Number.isInteger(code)) return code;
  }
  return undefined;
}

function mapGcpError(err: unknown, requestId: string): SigningRejected | SigningUnavailable {
  const code = grpcCode(err);
  const name =
    code === undefined
      ? 'UnknownError'
      : (GRPC_CODE_NAMES.get(code) ?? `code ${code}`);
  const message = `Google Cloud KMS ${name} (request ${requestId})`;
  if (code !== undefined && REJECTED_GRPC_CODES.has(code)) return new SigningRejected(message);
  return new SigningUnavailable(message);
}

const CRC32C_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** CRC32C (Castagnoli) checksum, as an unsigned 32-bit integer. */
export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32C_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read an Int64Value checksum wrapper as a number, or undefined. */
function int64Value(value: unknown): number | undefined {
  if (typeof value === 'object' && value !== null) {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    // Long instances and numeric strings convert exactly for 32-bit values.
    if (typeof raw === 'string' && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { toNumber?: unknown }).toNumber === 'function'
    ) {
      const parsed = (raw as { toNumber: () => number }).toNumber();
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function toBufferBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value, 'base64');
  return undefined;
}

export class GcpKmsProvider implements KmsProvider {
  readonly name = 'gcp' as const;

  constructor(private readonly client: KeyManagementServiceClient) {}

  async publicKeySpkiDer(keyReference: string): Promise<Buffer> {
    let response: protos.google.cloud.kms.v1.IPublicKey;
    try {
      [response] = await this.client.getPublicKey({ name: keyReference });
    } catch (err) {
      throw mapGcpError(err, 'public-key');
    }
    if (
      response.algorithm !== 'EC_SIGN_P256_SHA256' &&
      response.algorithm !== EC_SIGN_P256_SHA256
    ) {
      throw new SigningRejected(
        'Google Cloud KMS key is not EC_SIGN_P256_SHA256 (request public-key)',
      );
    }
    if (typeof response.pem !== 'string' || !response.pem.includes('BEGIN PUBLIC KEY')) {
      throw new SigningUnavailable('Google Cloud KMS returned a malformed public key');
    }
    const pemBytes = Buffer.from(response.pem, 'utf8');
    const expected = int64Value(response.pemCrc32c);
    if (expected === undefined || crc32c(pemBytes) !== expected) {
      throw new SigningRejected(
        'Google Cloud KMS public key failed its CRC32C check (request public-key)',
      );
    }
    let spkiDer: Buffer;
    try {
      spkiDer = createPublicKey(response.pem).export({ format: 'der', type: 'spki' }) as Buffer;
    } catch {
      throw new SigningUnavailable('Google Cloud KMS returned an invalid public key');
    }
    return Buffer.from(spkiDer);
  }

  async signDigest(keyReference: string, digest: Buffer, requestId: string): Promise<Buffer> {
    let response: protos.google.cloud.kms.v1.IAsymmetricSignResponse;
    try {
      [response] = await this.client.asymmetricSign({
        name: keyReference,
        digest: { sha256: digest },
        digestCrc32c: { value: crc32c(digest) },
      });
    } catch (err) {
      throw mapGcpError(err, requestId);
    }
    if (response.verifiedDigestCrc32c !== true) {
      throw new SigningRejected(
        `Google Cloud KMS did not verify the digest CRC (request ${requestId})`,
      );
    }
    if (response.name !== keyReference) {
      throw new SigningRejected(
        `Google Cloud KMS response is for another key (request ${requestId})`,
      );
    }
    const signature = toBufferBytes(response.signature);
    if (signature === undefined) {
      throw new SigningUnavailable('Google Cloud KMS returned a malformed signature');
    }
    const expected = int64Value(response.signatureCrc32c);
    if (expected === undefined || crc32c(signature) !== expected) {
      throw new SigningRejected(
        `Google Cloud KMS signature failed its CRC32C check (request ${requestId})`,
      );
    }
    return signature;
  }

  async health(): Promise<boolean> {
    return true;
  }
}
