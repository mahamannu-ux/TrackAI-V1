/**
 * Production signer resolution from the trust inventory (Task15l2, A15.12 part 2).
 *
 *   inventorySignerResolver  the builder's SignerResolver (A15.8): a tenant's one
 *                            active statement key, valid now; none → null
 *                            (ATTESTA_SIGNER_NO_CREDENTIAL, the builder's existing path)
 *   platformSigner           the platform key of a purpose, only if the latest
 *                            imported root lists it active (fail closed otherwise)
 *   publishedKeysFor         every key a tenant ever had plus the stored documents:
 *                            what verify-chain (A15.9 / 15i2) checks signatures with
 *   adaptersFromEnv          KMS adapters from ATTESTA_KMS_CREDENTIALS_FILE (references
 *                            only, no secrets); the dev signer outside production
 *   trustConfigFromEnv       ATTESTA_TRUST_ROOT_KEYIDS (comma-separated; required in production)
 *
 * Every returned adapter is pinned to the public key registered for the credential
 * (trust-inventory.ts `pinnedAdapter`): a credentials file or KMS key swapped after
 * registration cannot sign. Errors name variables and keyids, never credential
 * references or file contents.
 *
 * Port from: SushiCorp A1b adapters/signing/registry.py @ 0bd67a5 (catalog SG-1):
 * adapters selected by name from configuration, tenant-bound credentials (IT-A1b-03).
 * New: resolution from the signed inventory instead of per-deployment settings.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isProduction } from './anchor-contract';
import type { DsseEnvelope } from './dsse';
import { SigningRejected, SigningUnavailable } from './signer-contract';
import { KmsSigner, kmsCredentialsFromJson, AWS_CREDENTIAL_PREFIX, GCP_CREDENTIAL_PREFIX, type KmsProvider } from './signer-kms';
import { LocalDevSigner, LOCAL_DEV_ADAPTER_NAME, type DevCredentialInput } from './signer-local-dev';
import type { ResolvedSigner, SignerResolver } from './signer-resolver';
import { PLATFORM_SCOPE } from './trust-contract';
import { DIGEST_RE, UUID_RE } from './trust-documents';
import {
  pinnedAdapter,
  resolvePlatformSigner,
  type PlatformPurpose,
  type PlatformSigner,
  type TrustAdapters,
  type TrustConfig,
  type TrustStore,
} from './trust-inventory';

/** A configuration problem: the caller must not start. The message names variables only. */
export class TrustConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustConfigError';
  }
}

export interface ResolverOptions {
  now?: () => Date;
}

/**
 * The builder's resolver: the tenant's one `active` statement key whose validity
 * covers now, through its adapter, pinned to the registered key. No such key → null.
 * An adapter that is not configured is a deployment fault → SigningUnavailable
 * (retryable; nothing signs meanwhile).
 */
export function inventorySignerResolver(store: TrustStore, adapters: TrustAdapters, options: ResolverOptions = {}): SignerResolver {
  const now = options.now ?? (() => new Date());
  return {
    async resolve(tenantId: string): Promise<ResolvedSigner | null> {
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) return null;
      const t = now().getTime();
      const active = (await store.tenantKeys(tenantId)).filter((k) =>
        k.tenantId === tenantId && k.purpose === 'statement' && k.status === 'active' &&
        Date.parse(k.notBefore) <= t && t < Date.parse(k.notAfter));
      if (active.length !== 1) return null; // none, or (impossible under the 0019 index) ambiguous: never guess
      const key = active[0];
      if (!Object.prototype.hasOwnProperty.call(adapters, key.adapterName)) {
        throw new SigningUnavailable(`signing adapter ${JSON.stringify(key.adapterName)} for key ${key.keyid} is not configured`);
      }
      return { adapter: pinnedAdapter(adapters[key.adapterName], key.credentialRef, key.spkiDer), credentialId: key.credentialRef };
    },
  };
}

/**
 * `{ adapter, credentialId }` for the active platform key of `purpose`, only when
 * the stored root chain verifies from the pin and the latest root lists that key
 * active and valid now. Throws PlatformSignerError otherwise (fail closed).
 */
export async function platformSigner(store: TrustStore, adapters: TrustAdapters, purpose: PlatformPurpose,
  config: TrustConfig, options: ResolverOptions = {}): Promise<PlatformSigner> {
  return resolvePlatformSigner(store, adapters, purpose, config, (options.now ?? (() => new Date()))());
}

export interface PublishedKeys {
  /** Every statement key the tenant ever had (retired and revoked included), by keyid. */
  keys: Record<string, KeyObject>;
  /** Every stored root document, version 1 first. */
  rootDocuments: DsseEnvelope[];
  /** The tenant's key sets from version 1. */
  keysetDocuments: DsseEnvelope[];
}

/**
 * What verify-chain and evidence packs need for one tenant: its keys by keyid (only
 * this tenant's, only keys that were ever active: a registered-only key never
 * signed) and the stored documents from version 1. 15i2 passes `keys` to
 * verifyChain and the documents into packs (trust.md "Consumers").
 */
export async function publishedKeysFor(store: TrustStore, tenantId: string): Promise<PublishedKeys> {
  if (!UUID_RE.test(tenantId)) throw new RangeError('tenantId is not a lowercase UUID');
  const keys: Record<string, KeyObject> = {};
  for (const k of await store.tenantKeys(tenantId)) {
    if (k.tenantId !== tenantId || !k.everActive || k.status === 'registered') continue;
    keys[k.keyid] = createPublicKey({ key: k.spkiDer, format: 'der', type: 'spki' });
  }
  return {
    keys,
    rootDocuments: (await store.documents(PLATFORM_SCOPE)).map((d) => d.envelope),
    keysetDocuments: (await store.documents(tenantId)).map((d) => d.envelope),
  };
}

type ReadFile = (path: string) => string;
const defaultRead: ReadFile = (path) => readFileSync(path, 'utf8');

/** ATTESTA_TRUST_ROOT_KEYIDS and the production flag (NODE_ENV=production always counts). */
export function trustConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TrustConfig {
  const raw = env.ATTESTA_TRUST_ROOT_KEYIDS?.trim() ?? '';
  const pinnedRootKeyids = raw === '' ? [] : raw.split(',').map((s) => s.trim());
  if (pinnedRootKeyids.some((k) => !DIGEST_RE.test(k)) || new Set(pinnedRootKeyids).size !== pinnedRootKeyids.length || pinnedRootKeyids.length > 16) {
    throw new TrustConfigError('ATTESTA_TRUST_ROOT_KEYIDS must be 1..16 distinct comma-separated sha256:<hex> keyids');
  }
  return { pinnedRootKeyids, production: isProduction(env) };
}

export interface AdapterDeps {
  read?: ReadFile;
  /** Test seam: KMS providers by name (production builds the AWS and Google clients). */
  kmsProviders?: { aws?: KmsProvider; gcp?: KmsProvider };
}

async function defaultProvider(name: 'aws' | 'gcp'): Promise<KmsProvider> {
  if (name === 'aws') {
    const [{ KMSClient }, { AwsKmsProvider }] = await Promise.all([import('@aws-sdk/client-kms'), import('./signer-kms-aws')]);
    return new AwsKmsProvider(new KMSClient({}));
  }
  const [{ KeyManagementServiceClient }, { GcpKmsProvider }] = await Promise.all([import('@google-cloud/kms'), import('./signer-kms-google')]);
  return new GcpKmsProvider(new KeyManagementServiceClient());
}

function readNamed(read: ReadFile, env: NodeJS.ProcessEnv, name: string): string {
  try {
    return read(env[name] as string);
  } catch {
    throw new TrustConfigError(`${name} names a file that cannot be read`);
  }
}

/**
 * Signing adapters by name:
 * - `kms-aws` / `kms-gcp` from ATTESTA_KMS_CREDENTIALS_FILE, a kmsCredentialsFromJson
 *   list (credentialId `aws-kms:…` / `gcp-kms:…`, tenantId, displayName, keyReference,
 *   publicKeySha256: references and public pins only, no secrets; platform keys use
 *   the reserved platform tenant ID);
 * - `local-dev` from ATTESTA_DEV_CREDENTIALS_FILE (`[{credentialId, tenantId, keyFile}]`),
 *   refused in production together with everything that uses it.
 */
export async function adaptersFromEnv(env: NodeJS.ProcessEnv = process.env, deps: AdapterDeps = {}): Promise<TrustAdapters> {
  const read = deps.read ?? defaultRead;
  const adapters: Record<string, KmsSigner | LocalDevSigner> = {};
  if (env.ATTESTA_KMS_CREDENTIALS_FILE?.trim()) {
    let creds;
    try {
      creds = kmsCredentialsFromJson(readNamed(read, env, 'ATTESTA_KMS_CREDENTIALS_FILE'));
    } catch (err) {
      if (err instanceof TrustConfigError) throw err;
      throw new TrustConfigError('ATTESTA_KMS_CREDENTIALS_FILE is not a valid KMS credentials list');
    }
    for (const [name, prefix] of [['aws', AWS_CREDENTIAL_PREFIX], ['gcp', GCP_CREDENTIAL_PREFIX]] as const) {
      const mine = creds.filter((c) => c.credentialId.startsWith(prefix));
      if (mine.length === 0) continue;
      const provider = deps.kmsProviders?.[name] ?? await defaultProvider(name);
      const signer = new KmsSigner({ provider, credentials: mine });
      adapters[signer.capabilities().adapterName] = signer;
    }
    if (creds.some((c) => !c.credentialId.startsWith(AWS_CREDENTIAL_PREFIX) && !c.credentialId.startsWith(GCP_CREDENTIAL_PREFIX))) {
      throw new TrustConfigError('ATTESTA_KMS_CREDENTIALS_FILE: every credentialId starts with aws-kms: or gcp-kms:');
    }
  }
  if (env.ATTESTA_DEV_CREDENTIALS_FILE?.trim()) {
    if (isProduction(env)) throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE is set in production: refusing to run with a development signer');
    let list: unknown;
    try {
      list = JSON.parse(readNamed(read, env, 'ATTESTA_DEV_CREDENTIALS_FILE'));
    } catch (err) {
      if (err instanceof TrustConfigError) throw err;
      throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE is not JSON');
    }
    if (!Array.isArray(list)) throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE must be a list');
    const credentials: DevCredentialInput[] = list.map((item) => {
      const c = item as Record<string, unknown>;
      if (typeof c?.credentialId !== 'string' || typeof c.tenantId !== 'string' || typeof c.keyFile !== 'string') {
        throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE entries are {credentialId, tenantId, keyFile}');
      }
      let privateKeyPem: string;
      try {
        privateKeyPem = read(c.keyFile);
      } catch {
        throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE names a key file that cannot be read');
      }
      return { credentialId: c.credentialId, tenantId: c.tenantId, privateKeyPem };
    });
    try {
      adapters[LOCAL_DEV_ADAPTER_NAME] = new LocalDevSigner({ credentials, env });
    } catch (err) {
      if (err instanceof SigningRejected) throw new TrustConfigError('ATTESTA_DEV_CREDENTIALS_FILE: not usable dev P-256 credentials (ids start with "dev:")');
      throw err;
    }
  }
  return adapters;
}
