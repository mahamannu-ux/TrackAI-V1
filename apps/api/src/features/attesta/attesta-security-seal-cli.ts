/**
 * `npm run attesta:security-seal -w apps/api [-- --tenant <uuid>] [--now] [--confirm]`
 *
 * One security-finding sealing pass (Task15op-a, A15.15; docs/contracts/attesta/security-findings-seal.md).
 * Dry run by default (AGENTS.md §9 item 10): reads and plans each due seal and prints its window
 * and row counts; `--confirm` signs and chains them. Without `--tenant` it covers every tenant
 * with findings. `--now` seals up to the cutoff (database clock − 10 min) whatever the last
 * seal's age, before a report. The founder schedules it (hourly); it is not in the worker loop.
 * Prints tenant IDs, windows, counts and codes only.
 */
import 'dotenv/config';
import { userInfo } from 'node:os';
import { db, pool } from '../../core/db';
import { builderResolverFromEnv, parseArgs, resolveBuilderVersion } from './attesta-build-cli';
import type { SealDatabase } from './audit-seal-service';
import { pgSecuritySealStore, runSecuritySealPass } from './security-seal-service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The operator actor written into `audit.trail.security_findings_sealed` (the OS account, bounded). */
export function operatorActorId(): string {
  let name = 'unknown';
  try {
    name = userInfo().username || 'unknown';
  } catch {
    name = 'unknown';
  }
  return `attesta:security-seal:${name}`.slice(0, 256);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) {
    if (!['tenant', 'confirm', 'now', 'ephemeral-dev-key'].includes(name)) throw new Error(`unknown option --${name}`);
  }
  const tenant = args.get('tenant');
  if (tenant !== undefined && !UUID_RE.test(tenant)) throw new Error('--tenant must be a lowercase UUID');
  const dryRun = args.get('confirm') !== 'true';
  const now = args.get('now') === 'true';
  const store = pgSecuritySealStore(db as unknown as SealDatabase);
  const { resolver, label } = dryRun
    ? { resolver: { resolve: async () => null }, label: 'signer=none' }
    : await builderResolverFromEnv(process.env, args);
  const results = await runSecuritySealPass({
    store, resolver, builderVersion: dryRun ? '0.0.0+0000000' : resolveBuilderVersion(),
    actor: { type: 'system_operator', id: operatorActorId() }, log: (line) => console.log(line),
  }, { dryRun, now, ...(tenant ? { tenantIds: [tenant] } : {}) });
  console.log(`attesta_security_seal mode=${dryRun ? 'dry-run' : 'confirm'}${now ? ' now' : ''} ${label}`);
  for (const r of results) {
    const window = r.window ? ` from=${r.window.from} to=${r.window.to}` : '';
    const counts = r.count !== undefined ? ` count=${r.count} task6a=${r.generations?.task6a ?? 0} v2=${r.generations?.v2 ?? 0}` : '';
    console.log(`attesta_security_seal tenant=${r.tenantId} outcome=${r.outcome}${window}${counts}${r.code ? ` code=${r.code}` : ''}`);
  }
  if (dryRun) console.log('dry run: nothing was signed or written; rerun with --confirm to seal');
  if (results.some((r) => r.outcome === 'failed')) process.exitCode = 1;
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:security-seal failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
