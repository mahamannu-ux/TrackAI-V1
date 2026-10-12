/**
 * Attesta signer resolution (Task15h, A15.8): which signing adapter and credential
 * sign a tenant's statements.
 *
 * Interface first (AGENTS.md §5): the KMS adapters (A15.6) and the trust layer
 * (A15.12) supply production resolvers later; the worker depends only on
 * `SignerResolver`. `null` means the tenant has no active signing credential: the
 * worker fails the row with ATTESTA_SIGNER_NO_CREDENTIAL (terminal until a
 * credential is configured, then re-queued by the audited action).
 *
 * Port from: none (SushiCorp resolves one signer per deployment; TrackAI signs per
 * tenant). Built from signer-contract.ts (Task15b).
 */
import {
  LocalDevSigner,
  type DevCredentialInput,
} from './signer-local-dev';
import { SigningRejected, type SigningAdapter } from './signer-contract';

export interface ResolvedSigner {
  adapter: SigningAdapter;
  /** The credential to sign with; never published (envelope.md: keyid only). */
  credentialId: string;
}

export interface SignerResolver {
  resolve(tenantId: string): Promise<ResolvedSigner | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DevSignerResolverOptions {
  /** Explicit tenant-bound dev credentials (`dev:` prefix, as LocalDevSigner requires). */
  credentials?: DevCredentialInput[];
  /**
   * One throwaway P-256 key (PEM) used for every tenant that has no explicit
   * credential, as credential `dev:shared:<tenantId>`. Local use only.
   */
  sharedKeyPem?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Development resolver backed by LocalDevSigner. Refuses production exactly as the
 * dev signer does (NODE_ENV=production throws SigningRejected), at construction and
 * again on every resolve, so a dev resolver kept alive across a config change
 * cannot sign in production.
 */
export function devSignerResolver(options: DevSignerResolverOptions): SignerResolver {
  const env = options.env ?? process.env;
  const refuseProduction = () => {
    if (env.NODE_ENV === 'production') {
      throw new SigningRejected('devSignerResolver refuses to run in production');
    }
  };
  refuseProduction();
  const explicit = new LocalDevSigner({ credentials: options.credentials ?? [], env });
  const shared = new Map<string, LocalDevSigner>();
  const sharedKeyPem = options.sharedKeyPem;
  if (sharedKeyPem !== undefined) {
    // Fail at construction, not at the first tenant, if the key is unusable.
    new LocalDevSigner({
      credentials: [{ credentialId: 'dev:shared:probe', tenantId: 'probe', privateKeyPem: sharedKeyPem }],
      env,
    });
  }

  return {
    async resolve(tenantId: string): Promise<ResolvedSigner | null> {
      refuseProduction();
      if (!UUID_RE.test(tenantId)) return null;
      const own = (await explicit.listCredentials(tenantId))
        .map((c) => c.credentialId)
        .sort();
      if (own.length > 0) return { adapter: explicit, credentialId: own[0] };
      if (sharedKeyPem === undefined) return null;
      const credentialId = `dev:shared:${tenantId}`;
      let signer = shared.get(tenantId);
      if (signer === undefined) {
        signer = new LocalDevSigner({
          credentials: [{ credentialId, tenantId, privateKeyPem: sharedKeyPem }],
          env,
        });
        shared.set(tenantId, signer);
      }
      return { adapter: signer, credentialId };
    },
  };
}
