/**
 * Key resolution for the security documents (Task20f), the anchor-env.ts pattern:
 *
 *   Production   the platform `policy_bundle` / `activation_lease` key from the trust
 *                inventory: the key the latest chain-verified root lists active, through
 *                the KMS adapters of ATTESTA_KMS_CREDENTIALS_FILE, with the root chain
 *                checked from ATTESTA_TRUST_ROOT_KEYIDS (trust-resolver.ts platformSigner).
 *                Re-resolved for every signature. No key → SecuritySigningUnavailable:
 *                nothing is published and no lease is issued (fail closed).
 *   Development  SECURITY_POLICY_BUNDLE_CREDENTIAL_ID + SECURITY_DEV_POLICY_BUNDLE_KEY_FILE,
 *                SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID + SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE
 *                (LocalDevSigner, `dev:` ids; refused in production).
 *
 * Errors name variables, never values; nothing here logs.
 */
import { readFileSync } from 'node:fs';
import { ATTESTA_PLATFORM_TENANT_ID, isProduction } from '../attesta/anchor-contract';
import { LocalDevSigner } from '../attesta/signer-local-dev';
import { pgTrustStore, type TrustAdapters, type TrustDb, type TrustStore } from '../attesta/trust-inventory';
import { adaptersFromEnv, platformSigner, trustConfigFromEnv } from '../attesta/trust-resolver';
import { SecuritySigningUnavailable, type SecurityDocumentPurpose, type SecurityDocumentSigner } from './signing';

type ReadFile = (path: string) => string;
const defaultRead: ReadFile = (path) => readFileSync(path, 'utf8');

const DEV_VARIABLES: Readonly<Record<SecurityDocumentPurpose, { id: string; file: string }>> = {
  policy_bundle: { id: 'SECURITY_POLICY_BUNDLE_CREDENTIAL_ID', file: 'SECURITY_DEV_POLICY_BUNDLE_KEY_FILE' },
  activation_lease: { id: 'SECURITY_ACTIVATION_LEASE_CREDENTIAL_ID', file: 'SECURITY_DEV_ACTIVATION_LEASE_KEY_FILE' },
};

export interface SecuritySignerDeps {
  read?: ReadFile;
  /** Test seams; production reads the database of DATABASE_URL and builds adapters from the environment. */
  store?: TrustStore;
  adapters?: TrustAdapters;
  now?: () => Date;
}

function devSigner(purpose: SecurityDocumentPurpose, env: NodeJS.ProcessEnv, read: ReadFile): SecurityDocumentSigner {
  const names = DEV_VARIABLES[purpose];
  const credentialId = env[names.id]?.trim();
  const file = env[names.file]?.trim();
  const unavailable = (why: string) => ({
    purpose,
    resolve: async () => { throw new SecuritySigningUnavailable(why); },
  });
  if (!credentialId || !file) return unavailable(`${names.id} and ${names.file} are required outside production`);
  let adapter: LocalDevSigner;
  try {
    adapter = new LocalDevSigner({ credentials: [{ credentialId, tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: read(file) }], env });
  } catch {
    return unavailable(`${names.file} / ${names.id}: not a usable dev P-256 credential (id must start with "dev:")`);
  }
  return { purpose, resolve: async () => ({ adapter, credentialId }) };
}

/**
 * The signer for one purpose. Never throws at construction: a missing key surfaces as
 * SecuritySigningUnavailable on the first signature, so the API starts and simply
 * refuses to publish or issue (the fail-closed answer) until the key exists.
 */
export function securitySignerFromEnv(purpose: SecurityDocumentPurpose, env: NodeJS.ProcessEnv = process.env,
  deps: SecuritySignerDeps = {}): SecurityDocumentSigner {
  const read = deps.read ?? defaultRead;
  if (!isProduction(env)) return devSigner(purpose, env, read);
  let adapters: Promise<TrustAdapters> | undefined;
  return {
    purpose,
    resolve: async () => {
      try {
        const config = trustConfigFromEnv(env);
        const store = deps.store ?? pgTrustStore((await import('../../core/db')).db as unknown as TrustDb);
        adapters ??= deps.adapters ? Promise.resolve(deps.adapters) : adaptersFromEnv(env, { read });
        const signer = await platformSigner(store, await adapters, purpose, config, { now: deps.now });
        return { adapter: signer.adapter, credentialId: signer.credentialId };
      } catch (err) {
        adapters = deps.adapters ? adapters : undefined;
        throw new SecuritySigningUnavailable(`no ${purpose} key is authorized by the latest root document`, { cause: err });
      }
    },
  };
}
