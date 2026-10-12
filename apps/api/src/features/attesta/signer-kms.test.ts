// KMS signer tests: in-process, no network. Fake AWS/GCP clients implement
// just the SDK calls used, backed by real P-256 keys from `node:crypto`, so
// every signature is really verified. No key material in fixtures: all keys
// are generated at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from '@aws-sdk/client-kms';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { p256 } from '@noble/curves/nist.js';
import {
  signVerified,
  SigningRejected,
  SigningUnavailable,
} from './signer-contract';
import {
  KMS_PUBLIC_KEY_CACHE_MS,
  KmsSigner,
  kmsCredentialsFromJson,
  type KmsCredentialInput,
} from './signer-kms';
import { AwsKmsProvider } from './signer-kms-aws';
import { crc32c, GcpKmsProvider } from './signer-kms-google';

const PAYLOAD = Buffer.from('attesta kms test payload');
// Realistic references: full ARN / resource name, which must never leak.
const AWS_REF = 'arn:aws:kms:us-east-1:123456789012:key/abcd1234-ef56-7890-abcd-ef1234567890';
const GCP_REF =
  'projects/test-proj/locations/global/keyRings/test-ring/cryptoKeys/test-key/cryptoKeyVersions/1';

interface TestKey {
  privateKey: KeyObject;
  spkiDer: Buffer;
  pin: string;
}

function makeKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const pin = `sha256:${createHash('sha256').update(spkiDer).digest('hex')}`;
  return { privateKey, spkiDer, pin };
}

function verifyDer(publicKeySpkiDer: Buffer, payload: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: publicKeySpkiDer, format: 'der', type: 'spki' });
  return verify('sha256', payload, { key, dsaEncoding: 'der' }, signature);
}

// --- Raw P-256 ECDSA (test fakes only) ------------------------------------------
//
// Node's `crypto.sign` always hashes; a real KMS signs the SHA-256 digest
// directly, so the fakes sign raw with @noble/curves (the same call Task15e
// uses). Every signature they produce is checked by Node's OpenSSL-backed
// `verify` in the tests below, and the static OpenSSL vector after this
// helper anchors the expected shape independently of this code.

/** Raw ECDSA P-256 over a 32-byte digest, DER-encoded. Test fakes only. */
function rawEcdsaSignP256(privateKey: KeyObject, digest: Buffer): Buffer {
  assert.equal(digest.length, 32);
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  assert.ok(typeof jwk.d === 'string');
  const privBytes = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  return Buffer.from(
    p256.sign(new Uint8Array(digest), privBytes, { prehash: false, format: 'der' }),
  );
}

// Static OpenSSL vector (generated with `openssl dgst -sha256 -sign` on a
// fresh P-256 key): anchors the exact shape a real KMS returns, independent
// of the fake signing helper above.
const KNOWN_PUB_SPKI_HEX =
  '3059301306072a8648ce3d020106082a8648ce3d03010703420004576eccd89a68bd3bcf85fd902c40f5ddde1531ffdc1f2983b676fea18d82189235124f53888f3291126b0f9524dde8bda193e928485506a5488cd77be1415391';
const KNOWN_SIG_DER_HEX =
  '304502204fa7efd751587637e63a93d2d6bb79383bc43dab3aa7b544998c87f0c6b6b258022100d97a7b3e68ac683ee15d55744de65dbc255b29bde7a7e63f0cddfc0b9dceaec1';
const KNOWN_PAYLOAD = Buffer.from('attesta kms known-answer payload', 'utf8');

test('static OpenSSL vector: DER ECDSA over sha256(payload) verifies', () => {
  const pub = Buffer.from(KNOWN_PUB_SPKI_HEX, 'hex');
  const sig = Buffer.from(KNOWN_SIG_DER_HEX, 'hex');
  assert.ok(verifyDer(pub, KNOWN_PAYLOAD, sig));
  assert.equal(verifyDer(pub, Buffer.concat([KNOWN_PAYLOAD, Buffer.from('x')]), sig), false);
});


function awsCredential(key: TestKey, overrides?: Partial<KmsCredentialInput>): KmsCredentialInput {
  return {
    credentialId: 'aws-kms:test-key',
    tenantId: 'tenant-a',
    displayName: 'Test AWS key',
    keyReference: AWS_REF,
    publicKeySha256: key.pin,
    ...overrides,
  };
}

function gcpCredential(key: TestKey, overrides?: Partial<KmsCredentialInput>): KmsCredentialInput {
  return {
    credentialId: 'gcp-kms:test-key',
    tenantId: 'tenant-a',
    displayName: 'Test GCP key',
    keyReference: GCP_REF,
    publicKeySha256: key.pin,
    ...overrides,
  };
}

// --- Fake AWS KMS client -------------------------------------------------

interface FakeAwsOptions {
  publicKeyDer?: Buffer;
  keySpec?: string;
  keyUsage?: string;
  signWith?: KeyObject;
  garbageSignature?: boolean;
  /** Thrown by every SDK call when set. */
  error?: unknown;
}

class FakeAwsKms {
  getPublicKeyCalls = 0;
  signCalls = 0;
  lastSignInput?: { Message?: unknown; MessageType?: unknown; SigningAlgorithm?: unknown };

  constructor(
    private readonly key: TestKey,
    private readonly opts: FakeAwsOptions = {},
  ) {}

  async send(command: unknown): Promise<unknown> {
    if (this.opts.error !== undefined) throw this.opts.error;
    if (command instanceof GetPublicKeyCommand) {
      this.getPublicKeyCalls++;
      return {
        PublicKey: this.opts.publicKeyDer ?? Buffer.from(this.key.spkiDer),
        KeySpec: this.opts.keySpec ?? 'ECC_NIST_P256',
        KeyUsage: this.opts.keyUsage ?? 'SIGN_VERIFY',
      };
    }
    if (command instanceof SignCommand) {
      this.signCalls++;
      const input = command.input;
      this.lastSignInput = {
        Message: input.Message,
        MessageType: input.MessageType,
        SigningAlgorithm: input.SigningAlgorithm,
      };
      const digest = Buffer.from(input.Message as Uint8Array);
      if (this.opts.garbageSignature) return { Signature: Buffer.from('not a signature') };
      const signer = this.opts.signWith ?? this.key.privateKey;
      return { Signature: rawEcdsaSignP256(signer, digest) };
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  }

  asClient(): KMSClient {
    return this as unknown as KMSClient;
  }
}

function awsSigner(key: TestKey, opts: FakeAwsOptions = {}, cred?: KmsCredentialInput) {
  const fake = new FakeAwsKms(key, opts);
  const signer = new KmsSigner({
    provider: new AwsKmsProvider(fake.asClient()),
    credentials: [cred ?? awsCredential(key)],
  });
  return { fake, signer };
}

// --- Fake Google Cloud KMS client -----------------------------------------

interface FakeGcpOptions {
  publicKeyDer?: Buffer;
  algorithm?: string | number;
  corruptPemCrc?: boolean;
  omitPemCrc?: boolean;
  signWith?: KeyObject;
  garbageSignature?: boolean;
  verifiedDigestCrc32c?: boolean;
  responseName?: string;
  corruptSignatureCrc?: boolean;
  omitSignatureCrc?: boolean;
  error?: unknown;
}

class FakeGcpKms {
  getPublicKeyCalls = 0;
  signCalls = 0;
  lastSignRequest?: { name?: string | null; digest?: { sha256?: unknown }; digestCrc32c?: { value?: unknown } };

  constructor(
    private readonly key: TestKey,
    private readonly opts: FakeGcpOptions = {},
  ) {}

  async getPublicKey(request: { name?: string }) {
    if (this.opts.error !== undefined) throw this.opts.error;
    this.getPublicKeyCalls++;
    const der = this.opts.publicKeyDer ?? Buffer.from(this.key.spkiDer);
    const pem = createPublicKey({ key: der, format: 'der', type: 'spki' }).export({
      format: 'pem',
      type: 'spki',
    }) as string;
    const pemBytes = Buffer.from(pem, 'utf8');
    const goodCrc = crc32c(pemBytes);
    return [
      {
        pem,
        algorithm: this.opts.algorithm ?? 'EC_SIGN_P256_SHA256',
        pemCrc32c: this.opts.omitPemCrc
          ? undefined
          : { value: this.opts.corruptPemCrc ? goodCrc ^ 1 : goodCrc },
        name: request.name,
      },
    ];
  }

  async asymmetricSign(request: {
    name?: string;
    digest?: { sha256?: Uint8Array };
    digestCrc32c?: { value?: number };
  }) {
    if (this.opts.error !== undefined) throw this.opts.error;
    this.signCalls++;
    this.lastSignRequest = request;
    const digest = Buffer.from(request.digest?.sha256 ?? Buffer.alloc(0));
    const sig = this.opts.garbageSignature
      ? Buffer.from('garbage')
      : rawEcdsaSignP256(this.opts.signWith ?? this.key.privateKey, digest);
    const goodCrc = crc32c(sig);
    return [
      {
        signature: sig,
        name: this.opts.responseName ?? request.name,
        verifiedDigestCrc32c: this.opts.verifiedDigestCrc32c ?? true,
        signatureCrc32c: this.opts.omitSignatureCrc
          ? undefined
          : { value: this.opts.corruptSignatureCrc ? goodCrc ^ 1 : goodCrc },
      },
    ];
  }

  asClient(): KeyManagementServiceClient {
    return this as unknown as KeyManagementServiceClient;
  }
}

function gcpSigner(key: TestKey, opts: FakeGcpOptions = {}, cred?: KmsCredentialInput) {
  const fake = new FakeGcpKms(key, opts);
  const signer = new KmsSigner({
    provider: new GcpKmsProvider(fake.asClient()),
    credentials: [cred ?? gcpCredential(key)],
  });
  return { fake, signer };
}

// --- CRC32C -----------------------------------------------------------------

test('crc32c matches the known answer', () => {
  assert.equal(crc32c(Buffer.from('123456789', 'utf8')), 0xe3069283);
});

// --- Happy paths --------------------------------------------------------------

test('AWS happy path: signVerified succeeds and the signature verifies', async () => {
  const key = makeKey();
  const { fake, signer } = awsSigner(key);
  const result = await signVerified(signer, PAYLOAD, {
    credentialId: 'aws-kms:test-key',
    tenantId: 'tenant-a',
    requestId: 'r1',
  });
  assert.equal(result.algorithm, 'ES256');
  assert.equal(result.credentialId, 'aws-kms:test-key');
  assert.ok(result.publicKeySpkiDer.equals(key.spkiDer));
  assert.ok(verifyDer(key.spkiDer, PAYLOAD, result.signature));
  // The KMS signed exactly sha256(payload) with DIGEST/ECDSA_SHA_256.
  const expectedDigest = createHash('sha256').update(PAYLOAD).digest();
  assert.ok(Buffer.from(fake.lastSignInput?.Message as Uint8Array).equals(expectedDigest));
  assert.equal(fake.lastSignInput?.MessageType, 'DIGEST');
  assert.equal(fake.lastSignInput?.SigningAlgorithm, 'ECDSA_SHA_256');
});

test('GCP happy path: signVerified succeeds and the signature verifies', async () => {
  const key = makeKey();
  const { fake, signer } = gcpSigner(key);
  const result = await signVerified(signer, PAYLOAD, {
    credentialId: 'gcp-kms:test-key',
    tenantId: 'tenant-a',
    requestId: 'r1',
  });
  assert.equal(result.algorithm, 'ES256');
  assert.ok(result.publicKeySpkiDer.equals(key.spkiDer));
  assert.ok(verifyDer(key.spkiDer, PAYLOAD, result.signature));
  // The KMS signed exactly sha256(payload) with a matching digest CRC.
  const expectedDigest = createHash('sha256').update(PAYLOAD).digest();
  assert.ok(
    Buffer.from(fake.lastSignRequest?.digest?.sha256 as Uint8Array).equals(expectedDigest),
  );
  assert.equal(fake.lastSignRequest?.digestCrc32c?.value, crc32c(expectedDigest));
});

test('GCP accepts the numeric P-256 algorithm enum real servers return', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { algorithm: 12 });
  const result = await signVerified(signer, PAYLOAD, {
    credentialId: 'gcp-kms:test-key',
    tenantId: 'tenant-a',
    requestId: 'r1',
  });
  assert.ok(verifyDer(key.spkiDer, PAYLOAD, result.signature));
});

// --- Hostile or misconfigured KMS answers are refused --------------------------

test('pin mismatch (KMS returns another key) is SigningRejected', async () => {
  const pinned = makeKey();
  const other = makeKey();
  const aws = awsSigner(pinned, { publicKeyDer: other.spkiDer });
  await assert.rejects(
    aws.signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  const gcp = gcpSigner(pinned, { publicKeyDer: other.spkiDer });
  await assert.rejects(
    gcp.signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('wrong AWS key spec or usage is SigningRejected', async () => {
  const key = makeKey();
  for (const opts of [{ keySpec: 'RSA_2048' }, { keyUsage: 'ENCRYPT_DECRYPT' }]) {
    const { signer } = awsSigner(key, opts);
    await assert.rejects(
      signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
      SigningRejected,
    );
  }
});

test('wrong GCP algorithm is SigningRejected', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { algorithm: 'EC_SIGN_P384_SHA384' });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('a pinned non-P-256 key is refused at sign time', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaSpki = Buffer.from(rsa.publicKey.export({ format: 'der', type: 'spki' }));
  const rsaPin = `sha256:${createHash('sha256').update(rsaSpki).digest('hex')}`;
  const { signer } = awsSigner(makeKey(), { publicKeyDer: rsaSpki }, awsCredential(makeKey(), { publicKeySha256: rsaPin }));
  await assert.rejects(
    signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('unparseable key bytes from the KMS are refused before any use', async () => {
  const garbage = Buffer.from('not a key at all');
  const pin = `sha256:${createHash('sha256').update(garbage).digest('hex')}`;
  const { signer } = awsSigner(
    makeKey(),
    { publicKeyDer: garbage },
    awsCredential(makeKey(), { publicKeySha256: pin }),
  );
  // The provider cannot parse the bytes, so it fails retryable: the pin and
  // curve checks in the signer are never reached with garbage.
  await assert.rejects(
    signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningUnavailable,
  );
});

test('a signature made by another key does not verify and is SigningRejected', async () => {
  const key = makeKey();
  const other = makeKey();
  const aws = awsSigner(key, { signWith: other.privateKey });
  await assert.rejects(
    aws.signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  const gcp = gcpSigner(key, { signWith: other.privateKey });
  await assert.rejects(
    gcp.signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('non-DER garbage signatures are SigningRejected', async () => {
  const key = makeKey();
  const aws = awsSigner(key, { garbageSignature: true });
  await assert.rejects(
    aws.signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  const gcp = gcpSigner(key, { garbageSignature: true });
  await assert.rejects(
    gcp.signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

// --- GCP integrity checks --------------------------------------------------------

test('GCP refuses an unverified digest CRC', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { verifiedDigestCrc32c: false });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('GCP refuses a wrong signature CRC', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { corruptSignatureCrc: true });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('GCP refuses a response naming another key', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { responseName: `${GCP_REF}-other` });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('GCP refuses a wrong public key CRC', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { corruptPemCrc: true });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('GCP refuses a missing public key CRC', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { omitPemCrc: true });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

test('GCP refuses a missing signature CRC', async () => {
  const key = makeKey();
  const { signer } = gcpSigner(key, { omitSignatureCrc: true });
  await assert.rejects(
    signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
});

// --- Error mapping -----------------------------------------------------------------

test('AWS error mapping: retryable faults are SigningUnavailable', async () => {
  const key = makeKey();
  for (const name of [
    'ThrottlingException',
    'RequestLimitExceeded',
    'TimeoutError',
    'NetworkingError',
    'InternalFailure',
    'KMSInternalException',
    'DependencyTimeoutException',
  ]) {
    const { signer } = awsSigner(key, { error: Object.assign(new Error(name), { name }) });
    await assert.rejects(
      signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
      (err: unknown) => err instanceof SigningUnavailable && (err as Error).message.includes(name),
      `expected SigningUnavailable for ${name}`,
    );
  }
});

test('AWS error mapping: terminal faults are SigningRejected', async () => {
  const key = makeKey();
  for (const name of [
    'AccessDeniedException',
    'NotFoundException',
    'DisabledException',
    'KMSInvalidStateException',
    'InvalidKeyUsageException',
    'ValidationException',
  ]) {
    const { signer } = awsSigner(key, { error: Object.assign(new Error(name), { name }) });
    await assert.rejects(
      signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
      (err: unknown) => err instanceof SigningRejected && (err as Error).message.includes(name),
      `expected SigningRejected for ${name}`,
    );
  }
});

test('AWS error mapping: unrecognised failures are SigningUnavailable', async () => {
  const key = makeKey();
  const { signer } = awsSigner(key, { error: Object.assign(new Error('x'), { name: 'SomethingWeirdException' }) });
  await assert.rejects(
    signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningUnavailable,
  );
  const plain = awsSigner(key, { error: new Error('plain, no AWS shape') });
  await assert.rejects(
    plain.signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningUnavailable,
  );
});

test('GCP error mapping: retryable codes are SigningUnavailable', async () => {
  const key = makeKey();
  for (const code of [8, 4, 14]) {
    const { signer } = gcpSigner(key, { error: Object.assign(new Error(`code ${code}`), { code }) });
    await assert.rejects(
      signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
      SigningUnavailable,
      `expected SigningUnavailable for gRPC code ${code}`,
    );
  }
});

test('GCP error mapping: terminal codes are SigningRejected', async () => {
  const key = makeKey();
  for (const code of [7, 5, 9, 3]) {
    const { signer } = gcpSigner(key, { error: Object.assign(new Error(`code ${code}`), { code }) });
    await assert.rejects(
      signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
      SigningRejected,
      `expected SigningRejected for gRPC code ${code}`,
    );
  }
});

test('GCP error mapping: unknown codes and codeless errors are SigningUnavailable', async () => {
  const key = makeKey();
  const unknown = gcpSigner(key, { error: Object.assign(new Error('code 99'), { code: 99 }) });
  await assert.rejects(
    unknown.signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningUnavailable,
  );
  const codeless = gcpSigner(key, { error: new Error('transport blew up') });
  await assert.rejects(
    codeless.signer.sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningUnavailable,
  );
});

test('error messages carry the error name or code only, never key material', async () => {
  const key = makeKey();
  // Even when the SDK error text quotes the full ARN, the mapped message must not.
  const awsDenied = awsSigner(key, {
    error: Object.assign(new Error(`User is not authorized for ${AWS_REF}`), {
      name: 'AccessDeniedException',
    }),
  });
  const awsErr = await awsDenied.signer
    .sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' })
    .then(
      () => assert.fail('expected rejection'),
      (err: unknown) => err as Error,
    );
  assert.ok(awsErr.message.includes('AccessDeniedException'));
  assert.ok(!awsErr.message.includes(AWS_REF));
  const gcpDenied = gcpSigner(key, {
    error: Object.assign(new Error(`permission denied on ${GCP_REF}`), { code: 7 }),
  });
  const gcpErr = await gcpDenied.signer
    .sign(PAYLOAD, 'gcp-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' })
    .then(
      () => assert.fail('expected rejection'),
      (err: unknown) => err as Error,
    );
  assert.ok(gcpErr.message.includes('PERMISSION_DENIED'));
  assert.ok(!gcpErr.message.includes(GCP_REF));
});

// --- Payload, tenant and credential plumbing --------------------------------------------

test('unknown credential, non-Buffer, empty and oversize payloads are SigningRejected', async () => {
  const key = makeKey();
  const { signer } = awsSigner(key);
  await assert.rejects(
    signer.sign(PAYLOAD, 'aws-kms:unknown', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign(Buffer.alloc(0), 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign(Buffer.alloc(1_048_576 + 1), 'aws-kms:test-key', {
      requestId: 'r',
      tenantId: 'tenant-a',
    }),
    SigningRejected,
  );
  await assert.rejects(
    signer.sign('text' as unknown as Buffer, 'aws-kms:test-key', {
      requestId: 'r',
      tenantId: 'tenant-a',
    }),
    SigningRejected,
  );
});

test("sign refuses a credential from another tenant; listing is scoped", async () => {
  const keyA = makeKey();
  const fake = new FakeAwsKms(keyA);
  const signer = new KmsSigner({
    provider: new AwsKmsProvider(fake.asClient()),
    credentials: [
      awsCredential(keyA, { credentialId: 'aws-kms:a-key', tenantId: 'tenant-a' }),
      // Second credential shares the fake: pin it to the same key the fake serves.
      {
        credentialId: 'aws-kms:b-key',
        tenantId: 'tenant-b',
        displayName: 'B key',
        keyReference: AWS_REF,
        publicKeySha256: keyA.pin,
      },
    ],
  });
  await assert.rejects(
    signer.sign(PAYLOAD, 'aws-kms:b-key', { requestId: 'r', tenantId: 'tenant-a' }),
    SigningRejected,
  );
  assert.deepEqual(
    (await signer.listCredentials('tenant-a')).map((c) => c.credentialId),
    ['aws-kms:a-key'],
  );
  assert.deepEqual(
    (await signer.listCredentials('tenant-b')).map((c) => c.credentialId),
    ['aws-kms:b-key'],
  );
});

test('publicKey returns the pinned key and rejects unknown credentials', async () => {
  const key = makeKey();
  const { signer } = awsSigner(key);
  assert.ok((await signer.publicKey('aws-kms:test-key')).equals(key.spkiDer));
  await assert.rejects(signer.publicKey('aws-kms:unknown'), SigningRejected);
});

test('capabilities name the provider', () => {
  const key = makeKey();
  assert.equal(awsSigner(key).signer.capabilities().adapterName, 'kms-aws');
  assert.equal(gcpSigner(key).signer.capabilities().adapterName, 'kms-gcp');
  assert.deepEqual(awsSigner(key).signer.capabilities().algorithms, ['ES256']);
  assert.equal(awsSigner(key).signer.capabilities().maxPayloadBytes, 1_048_576);
  assert.equal(awsSigner(key).signer.capabilities().supportsCredentialListing, true);
});

test('health is true when the provider answers and every pin matches', async () => {
  const key = makeKey();
  assert.equal(await awsSigner(key).signer.health(), true);
  assert.equal(await gcpSigner(key).signer.health(), true);
});

test('health is false on pin mismatch or provider failure', async () => {
  const key = makeKey();
  const mismatch = awsSigner(key, { publicKeyDer: makeKey().spkiDer });
  assert.equal(await mismatch.signer.health(), false);
  // The KMS is unreachable: the per-credential key fetch fails.
  const down = awsSigner(key, { error: new Error('down') });
  assert.equal(await down.signer.health(), false);
  const gcpMismatch = gcpSigner(key, { publicKeyDer: makeKey().spkiDer });
  assert.equal(await gcpMismatch.signer.health(), false);
});

test('provider health performs no remote call', async () => {
  const key = makeKey();
  const awsFake = new FakeAwsKms(key);
  assert.equal(await new AwsKmsProvider(awsFake.asClient()).health(), true);
  assert.equal(awsFake.getPublicKeyCalls, 0);
  assert.equal(awsFake.signCalls, 0);
});

// --- Credential configuration ---------------------------------------------------------------

test('kmsCredentialsFromJson parses a valid list', () => {
  const key = makeKey();
  const parsed = kmsCredentialsFromJson(
    JSON.stringify([awsCredential(key), gcpCredential(key)]),
  );
  assert.equal(parsed.length, 2);
  const signer = new KmsSigner({
    provider: new AwsKmsProvider(new FakeAwsKms(key).asClient()),
    credentials: [parsed[0] as KmsCredentialInput],
  });
  assert.equal(signer.capabilities().adapterName, 'kms-aws');
});

test('kmsCredentialsFromJson refuses malformed input', () => {
  const key = makeKey();
  const good = awsCredential(key);
  assert.throws(() => kmsCredentialsFromJson('not json'), SigningRejected);
  assert.throws(() => kmsCredentialsFromJson(JSON.stringify({ a: 1 })), SigningRejected);
  assert.throws(() => kmsCredentialsFromJson(JSON.stringify([42])), SigningRejected);
  assert.throws(
    () => kmsCredentialsFromJson(JSON.stringify([{ ...good, extra: 'x' }])),
    SigningRejected,
  );
  const { displayName: _dropped, ...missing } = good;
  assert.throws(() => kmsCredentialsFromJson(JSON.stringify([missing])), SigningRejected);
  assert.throws(
    () => kmsCredentialsFromJson(JSON.stringify([{ ...good, keyReference: '' }])),
    SigningRejected,
  );
});

test('constructor refuses duplicates, prefix mismatches and bad pins', () => {
  const key = makeKey();
  const cred = awsCredential(key);
  const provider = new AwsKmsProvider(new FakeAwsKms(key).asClient());
  assert.throws(
    () => new KmsSigner({ provider, credentials: [cred, { ...cred }] }),
    SigningRejected,
  );
  const gcpProvider = new GcpKmsProvider(new FakeGcpKms(key).asClient());
  assert.throws(
    () => new KmsSigner({ provider: gcpProvider, credentials: [cred] }),
    SigningRejected,
  );
  assert.throws(
    () => new KmsSigner({ provider, credentials: [{ ...cred, publicKeySha256: 'xyz' }] }),
    SigningRejected,
  );
  assert.throws(() => new KmsSigner({ provider, credentials: [] }), SigningRejected);
});

// --- No secrets in results, listings or errors --------------------------------------------------

test('results, listings and errors contain no private material or key references', async () => {
  const key = makeKey();
  const { signer } = awsSigner(key);
  const result = await signer.sign(PAYLOAD, 'aws-kms:test-key', {
    requestId: 'r1',
    tenantId: 'tenant-a',
  });
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(result).includes(AWS_REF));
  const listed = await signer.listCredentials('tenant-a');
  assert.ok(!JSON.stringify(listed).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(listed).includes(AWS_REF));
  const messages: string[] = [];
  for (const attempt of [
    signer.sign(PAYLOAD, 'aws-kms:unknown', { requestId: 'r', tenantId: 'tenant-a' }),
    signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-b' }),
  ]) {
    await attempt.then(
      () => assert.fail('expected rejection'),
      (err: unknown) => messages.push((err as Error).message),
    );
  }
  const mismatch = awsSigner(key, { publicKeyDer: makeKey().spkiDer });
  await mismatch.signer
    .sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r', tenantId: 'tenant-a' })
    .then(
      () => assert.fail('expected rejection'),
      (err: unknown) => messages.push((err as Error).message),
    );
  for (const message of messages) {
    assert.ok(!message.includes('PRIVATE KEY'));
    assert.ok(!message.includes(AWS_REF));
  }
});

// --- Public key cache ------------------------------------------------------------------------------

test('a second sign within 5 minutes reuses the cached public key', async () => {
  const key = makeKey();
  let now = 1_000_000;
  const fake = new FakeAwsKms(key);
  const signer = new KmsSigner({
    provider: new AwsKmsProvider(fake.asClient()),
    credentials: [awsCredential(key)],
    clock: () => now,
  });
  await signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r1', tenantId: 'tenant-a' });
  await signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r2', tenantId: 'tenant-a' });
  assert.equal(fake.getPublicKeyCalls, 1);
  now += KMS_PUBLIC_KEY_CACHE_MS + 1;
  await signer.sign(PAYLOAD, 'aws-kms:test-key', { requestId: 'r3', tenantId: 'tenant-a' });
  assert.equal(fake.getPublicKeyCalls, 2);
});
