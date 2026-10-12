// AWS KMS provider for `KmsSigner`: GetPublicKey + Sign over an injected
// `KMSClient`, so tests inject a fake that implements just the SDK calls
// used. Errors map by AWS error name: authorization, addressing and key-state
// failures are terminal (`SigningRejected`); throttling, timeouts, network
// faults, 5xx and anything unrecognised are retryable
// (`SigningUnavailable`). Messages carry the AWS error name only, never key
// material, ARNs or SDK detail text.
//
// Ported from SushiCorp A1b adapters/signing/kms_aws.py @ 0bd67a5 (catalog
// SG-1). Deviations: TypeScript AWS SDK v3 commands; the key must be
// `ECC_NIST_P256` with `SIGN_VERIFY` usage (SushiCorp trusted the configured
// chain instead); DER SPKI is returned directly (no PEM round-trip;
// parseability is still checked); health lists one key.

import { createPublicKey } from 'node:crypto';
import {
  GetPublicKeyCommand,
  KMSClient,
  ListKeysCommand,
  SignCommand,
} from '@aws-sdk/client-kms';
import { SigningRejected, SigningUnavailable } from './signer-contract';
import type { KmsProvider } from './signer-kms';

/**
 * Terminal AWS failures: access denied, unknown/disabled keys, keys that
 * cannot sign (wrong usage, pending deletion or otherwise unusable state)
 * and invalid requests. Retrying cannot help.
 */
const REJECTED_NAMES = new Set([
  'AccessDeniedException',
  'DisabledException',
  'InvalidKeyUsageException',
  'KMSInvalidStateException',
  'NotFoundException',
  'ValidationException',
]);

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return 'UnknownError';
}

function mapAwsError(err: unknown, requestId: string): SigningRejected | SigningUnavailable {
  const name = errorName(err);
  const message = `AWS KMS ${name} (request ${requestId})`;
  if (REJECTED_NAMES.has(name)) return new SigningRejected(message);
  return new SigningUnavailable(message);
}

export class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws' as const;

  constructor(private readonly client: KMSClient) {}

  async publicKeySpkiDer(keyReference: string): Promise<Buffer> {
    let out;
    try {
      out = await this.client.send(new GetPublicKeyCommand({ KeyId: keyReference }));
    } catch (err) {
      throw mapAwsError(err, 'public-key');
    }
    if (out.KeySpec !== 'ECC_NIST_P256') {
      throw new SigningRejected(
        `AWS KMS key is not ECC_NIST_P256 (request public-key)`,
      );
    }
    if (out.KeyUsage !== 'SIGN_VERIFY') {
      throw new SigningRejected(
        `AWS KMS key is not for SIGN_VERIFY (request public-key)`,
      );
    }
    if (!(out.PublicKey instanceof Uint8Array)) {
      throw new SigningUnavailable('AWS KMS returned a malformed public key');
    }
    const spkiDer = Buffer.from(out.PublicKey);
    try {
      createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    } catch {
      throw new SigningUnavailable('AWS KMS returned an invalid public key');
    }
    return spkiDer;
  }

  async signDigest(keyReference: string, digest: Buffer, requestId: string): Promise<Buffer> {
    let out;
    try {
      out = await this.client.send(
        new SignCommand({
          KeyId: keyReference,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );
    } catch (err) {
      throw mapAwsError(err, requestId);
    }
    if (!(out.Signature instanceof Uint8Array)) {
      throw new SigningUnavailable('AWS KMS returned a malformed signature');
    }
    return Buffer.from(out.Signature);
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(new ListKeysCommand({ Limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}
