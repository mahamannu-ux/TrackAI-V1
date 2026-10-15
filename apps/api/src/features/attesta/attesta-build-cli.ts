/**
 * `npm run attesta:build -w apps/api [-- --loop --sleep-ms=30000 --limit=50 --max-attempts=8 --lease-ms=600000]`
 *
 * Runs one builder pass (or passes in a loop, for local use). Production scheduling is
 * Task14's. Signers (`builderResolverFromEnv`):
 *   production (NODE_ENV=production): the trust inventory, `inventorySignerResolver(
 *     pgTrustStore(db), await adaptersFromEnv(), trustConfigFromEnv())` (Task15i2): the
 *     tenant's one active, published statement key; never the development signer;
 *   otherwise the development signer, which needs one of:
 *     ATTESTA_DEV_SIGNER_KEY_FILE=<path to a P-256 PEM private key>  (stable key)
 *     --ephemeral-dev-key                                             (new key each run)
 * Needs DATABASE_URL.
 * The builder version is `<apps/api version>+<git commit>`; the commit comes from
 * TRACKAI_GIT_COMMIT or `git rev-parse HEAD`. Prints codes and counts only.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, pool } from '../../core/db';
import { sha256Prefixed } from './canonical';
import { isProduction } from './anchor-contract';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver, type SignerResolver } from './signer-resolver';
import { pgTrustStore, type TrustDb } from './trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from './trust-resolver';
import { runBuilderPass } from './worker';
import { pgSealStore, runAuditSealPass, type SealDatabase } from './audit-seal-service';

export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    if (eq > 0) out.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { out.set(arg.slice(2), argv[i + 1]); i += 1; }
    else out.set(arg.slice(2), 'true');
  }
  return out;
}

function intArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  return Number(raw);
}

/** `<apps/api version>+<git commit>`, refused unless both are well formed. */
export function resolveBuilderVersion(env: NodeJS.ProcessEnv = process.env): string {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version?: string };
  let commit = env.TRACKAI_GIT_COMMIT?.trim();
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
    } catch {
      commit = '';
    }
  }
  const version = `${pkg.version ?? ''}+${commit.toLowerCase()}`;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{7,40}$/.test(version)) {
    throw new Error('builder version unavailable: set TRACKAI_GIT_COMMIT to the deployed commit');
  }
  return version;
}

export interface BuilderResolverDeps {
  inventory?: (env: NodeJS.ProcessEnv) => Promise<SignerResolver>;
  dev?: (pem: string, env: NodeJS.ProcessEnv) => SignerResolver;
  read?: (path: string) => string;
}

/**
 * The builder's signer resolver for this environment, and a label for the log line.
 * Production always takes the inventory branch (a dev key file or flag is ignored and
 * the dev resolver is never constructed); development keeps the dev signer.
 */
export async function builderResolverFromEnv(env: NodeJS.ProcessEnv, args: Map<string, string>, deps: BuilderResolverDeps = {}):
  Promise<{ resolver: SignerResolver; label: string }> {
  if (isProduction(env)) {
    const inventory = deps.inventory ?? (async (e: NodeJS.ProcessEnv) =>
      inventorySignerResolver(pgTrustStore(db as unknown as TrustDb), await adaptersFromEnv(e), trustConfigFromEnv(e)));
    return { resolver: await inventory(env), label: 'signer=trust-inventory' };
  }
  const keyFile = env.ATTESTA_DEV_SIGNER_KEY_FILE;
  let pem: string;
  if (keyFile) pem = (deps.read ?? ((path: string) => readFileSync(path, 'utf8')))(keyFile);
  else if (args.get('ephemeral-dev-key') === 'true') pem = generateDevCredential('dev:ephemeral', 'local').privateKeyPem;
  else throw new Error('set ATTESTA_DEV_SIGNER_KEY_FILE or pass --ephemeral-dev-key (development signer only)');
  const keyid = sha256Prefixed(createPublicKey(pem).export({ format: 'der', type: 'spki' }) as Buffer);
  const dev = deps.dev ?? ((p: string, e: NodeJS.ProcessEnv) => devSignerResolver({ sharedKeyPem: p, env: e }));
  return { resolver: dev(pem, env), label: `signer=dev dev_keyid=${keyid}` };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  const { resolver, label } = await builderResolverFromEnv(process.env, args);
  const options = {
    limit: intArg(args, 'limit', 50),
    maxAttempts: intArg(args, 'max-attempts', 8),
    leaseMs: intArg(args, 'lease-ms', 600_000),
    builderVersion: resolveBuilderVersion(),
  };
  // A short lease lets workers take live claims from each other and waste signatures.
  if (options.leaseMs < 60_000) throw new Error('--lease-ms must be at least 60000');
  const loop = args.get('loop') === 'true';
  const sleepMs = intArg(args, 'sleep-ms', 30_000);
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  console.log(`attesta_build builder_version=${options.builderVersion} ${label} mode=${loop ? 'loop' : 'once'}`);
  do {
    const r = await runBuilderPass(db, resolver, options);
    const codes = Object.entries(r.codes).sort().map(([code, n]) => `${code}:${n}`).join(',') || 'none';
    console.log(`attesta_build_pass recovered=${r.recovered} recovered_failed=${r.recoveredFailed} claimed=${r.claimed} done=${r.done} duplicates=${r.duplicates} retried=${r.retried} failed=${r.failed} claim_lost=${r.claimLost} left_claimed=${r.leftClaimed} codes=${codes}`);
    if (loop) {
      // Task16e (A16.4): the loop also seals each tenant's audit trail when a seal is due.
      const seals = await runAuditSealPass({ store: pgSealStore(db as unknown as SealDatabase), resolver,
        builderVersion: options.builderVersion, actor: { type: 'service', id: 'attesta-worker' } });
      const sealed = seals.filter((x) => x.outcome === 'sealed').length;
      const failed = seals.filter((x) => x.outcome === 'failed').length;
      console.log(`attesta_audit_seal_pass tenants=${seals.length} sealed=${sealed} failed=${failed}`);
    }
    if (loop && !stop) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  } while (loop && !stop);
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:build failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
