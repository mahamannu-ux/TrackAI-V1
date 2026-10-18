// Local development signer: real P-256 keys, real DER signatures, no trust.
//
// Development only: it holds its own throwaway keys in memory and refuses to
// run when NODE_ENV is `production` (production signers delegate to the
// tenant's KMS and implement `signer-contract.ts` instead). Signing is
// tenant-bound: `sign` refuses a credential from another tenant. Results
// contain public material only; payloads and keys are never logged.
//
// Ported from SushiCorp A1 adapters/signing/local_dev.py @ 0bd67a5 (catalog
// SG-1). Deviations: (1) no X.509 chain or CRL - Attesta verifies against
// the raw SPKI key, so there is no CA to run; (2) credentials are passed in
// at construction instead of generated into a key directory, so nothing is
// written to disk; (3) ES256 only; (4) signatures are DER (Attesta/DSSE
// form), not COSE raw r||s; (5) production guard reads NODE_ENV.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  SigningRejected,
  type SigningAdapter,
  type SigningCapabilities,
  type SigningCredential,
  type SigningResult,
} from './signer-contract';

export const LOCAL_DEV_ADAPTER_NAME = 'local-dev';
/** 4 MiB + 1 KiB, matching KMS_MAX_PAYLOAD_BYTES (Task20f rule bundles; Attesta statements stay at 1 MiB, ledger.ts). */
export const LOCAL_DEV_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024 + 1024;
const DEV_CREDENTIAL_PREFIX = 'dev:';

export interface DevCredentialInput {
  credentialId: string;
  tenantId: string;
  displayName?: string;
  /** PEM-encoded PKCS#8 or SEC1 EC private key on the P-256 curve. */
  privateKeyPem: string;
}

interface LoadedCredential {
  credentialId: string;
  tenantId: string;
  displayName: string;
  privateKey: KeyObject;
  publicKeySpkiDer: Buffer;
}

function loadCredential(input: DevCredentialInput): LoadedCredential {
  if (!input.credentialId.startsWith(DEV_CREDENTIAL_PREFIX)) {
    throw new SigningRejected(
      `credential id ${JSON.stringify(input.credentialId)} is not a dev credential (must start with ${JSON.stringify(DEV_CREDENTIAL_PREFIX)})`,
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new SigningRejected(
      `credential ${JSON.stringify(input.credentialId)} has an unreadable private key`,
    );
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ec') {
    throw new SigningRejected(
      `credential ${JSON.stringify(input.credentialId)} is not a P-256 EC key`,
    );
  }
  if (privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new SigningRejected(
      `credential ${JSON.stringify(input.credentialId)} is not on the P-256 curve`,
    );
  }
  const publicKeySpkiDer = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  return {
    credentialId: input.credentialId,
    tenantId: input.tenantId,
    displayName: input.displayName ?? input.credentialId,
    privateKey,
    publicKeySpkiDer: Buffer.from(publicKeySpkiDer),
  };
}

export class LocalDevSigner implements SigningAdapter {
  private readonly credentials = new Map<string, LoadedCredential>();

  constructor(options: { credentials: DevCredentialInput[]; env?: NodeJS.ProcessEnv }) {
    const env = options.env ?? process.env;
    if (env.NODE_ENV === 'production') {
      throw new SigningRejected('LocalDevSigner refuses to run in production');
    }
    for (const input of options.credentials) {
      const loaded = loadCredential(input);
      if (this.credentials.has(loaded.credentialId)) {
        throw new SigningRejected(
          `duplicate credential ${JSON.stringify(loaded.credentialId)}`,
        );
      }
      this.credentials.set(loaded.credentialId, loaded);
    }
  }

  capabilities(): SigningCapabilities {
    return {
      adapterName: LOCAL_DEV_ADAPTER_NAME,
      algorithms: ['ES256'],
      maxPayloadBytes: LOCAL_DEV_MAX_PAYLOAD_BYTES,
      supportsCredentialListing: true,
    };
  }

  async sign(
    payload: Buffer,
    credentialId: string,
    opts: { requestId: string; tenantId: string },
  ): Promise<SigningResult> {
    const credential = this.credentials.get(credentialId);
    if (credential === undefined) {
      throw new SigningRejected(
        `unknown credential ${JSON.stringify(credentialId)} (request ${opts.requestId})`,
      );
    }
    if (credential.tenantId !== opts.tenantId) {
      throw new SigningRejected(
        `credential ${JSON.stringify(credentialId)} does not belong to tenant ${JSON.stringify(opts.tenantId)} (request ${opts.requestId})`,
      );
    }
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
      throw new SigningRejected(
        `payload must be a non-empty Buffer (request ${opts.requestId})`,
      );
    }
    if (payload.length > LOCAL_DEV_MAX_PAYLOAD_BYTES) {
      throw new SigningRejected(
        `payload of ${payload.length} bytes exceeds ${LOCAL_DEV_MAX_PAYLOAD_BYTES} (request ${opts.requestId})`,
      );
    }
    const signature = sign('sha256', payload, {
      key: credential.privateKey,
      dsaEncoding: 'der',
    });
    return {
      signature,
      algorithm: 'ES256',
      credentialId: credential.credentialId,
      publicKeySpkiDer: Buffer.from(credential.publicKeySpkiDer),
    };
  }

  async listCredentials(tenantId: string): Promise<SigningCredential[]> {
    const out: SigningCredential[] = [];
    for (const credential of this.credentials.values()) {
      if (credential.tenantId !== tenantId) continue;
      out.push({
        credentialId: credential.credentialId,
        tenantId: credential.tenantId,
        displayName: credential.displayName,
        algorithm: 'ES256',
        publicKeySpkiDer: Buffer.from(credential.publicKeySpkiDer),
      });
    }
    return out;
  }

  async publicKey(credentialId: string): Promise<Buffer> {
    const credential = this.credentials.get(credentialId);
    if (credential === undefined) {
      throw new SigningRejected(`unknown credential ${JSON.stringify(credentialId)}`);
    }
    return Buffer.from(credential.publicKeySpkiDer);
  }

  async health(): Promise<boolean> {
    return this.credentials.size > 0;
  }
}

/**
 * Mint a throwaway P-256 credential for tests and local setup. The private
 * key never leaves the caller's memory; nothing is written to disk.
 */
export function generateDevCredential(
  credentialId: string,
  tenantId: string,
): { credentialId: string; tenantId: string; privateKeyPem: string } {
  if (!credentialId.startsWith(DEV_CREDENTIAL_PREFIX)) {
    throw new SigningRejected(
      `credential id ${JSON.stringify(credentialId)} is not a dev credential (must start with ${JSON.stringify(DEV_CREDENTIAL_PREFIX)})`,
    );
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { credentialId, tenantId, privateKeyPem };
}
