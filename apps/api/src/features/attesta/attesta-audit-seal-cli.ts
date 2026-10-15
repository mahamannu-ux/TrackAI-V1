/**
 * `npm run attesta:audit-seal -w apps/api [-- --tenant <uuid>] [--confirm]`
 *
 * One audit sealing pass (Task16e, A16.4; docs/contracts/attesta/audit-seal.md). Dry run by
 * default (AGENTS.md §9 item 10): reads and plans each due seal and prints its window and row
 * count; `--confirm` signs and chains them. Without `--tenant` it covers every tenant with audit
 * rows. The worker loop (`attesta:build -- --loop`) runs the same pass each iteration. Prints
 * tenant IDs, windows, counts and codes only.
 */
import 'dotenv/config';
import { userInfo } from 'node:os';
import { db, pool } from '../../core/db';
import { builderResolverFromEnv, parseArgs, resolveBuilderVersion } from './attesta-build-cli';
import { pgSealStore, runAuditSealPass, type SealDatabase } from './audit-seal-service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The operator actor written into `audit.trail.sealed` (the OS account, bounded). */
export function operatorActorId(): string {
  let name = 'unknown';
  try {
    name = userInfo().username || 'unknown';
  } catch {
    name = 'unknown';
  }
  return `attesta:audit-seal:${name}`.slice(0, 256);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) {
    if (!['tenant', 'confirm', 'ephemeral-dev-key'].includes(name)) throw new Error(`unknown option --${name}`);
  }
  const tenant = args.get('tenant');
  if (tenant !== undefined && !UUID_RE.test(tenant)) throw new Error('--tenant must be a lowercase UUID');
  const dryRun = args.get('confirm') !== 'true';
  const store = pgSealStore(db as unknown as SealDatabase);
  const { resolver, label } = dryRun
    ? { resolver: { resolve: async () => null }, label: 'signer=none' }
    : await builderResolverFromEnv(process.env, args);
  const results = await runAuditSealPass({
    store, resolver, builderVersion: dryRun ? '0.0.0+0000000' : resolveBuilderVersion(),
    actor: { type: 'system_operator', id: operatorActorId() }, log: (line) => console.log(line),
  }, { dryRun, ...(tenant ? { tenantIds: [tenant] } : {}) });
  console.log(`attesta_audit_seal mode=${dryRun ? 'dry-run' : 'confirm'} ${label}`);
  for (const r of results) {
    const window = r.window ? ` from=${r.window.from} to=${r.window.to}` : '';
    console.log(`attesta_audit_seal tenant=${r.tenantId} outcome=${r.outcome}${window}${r.count !== undefined ? ` count=${r.count}` : ''}${r.code ? ` code=${r.code}` : ''}`);
  }
  if (dryRun) console.log('dry run: nothing was signed or written; rerun with --confirm to seal');
  if (results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:audit-seal failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
