/**
 * `npm run attesta:pack -w apps/api -- --run-queued [--limit 20]`
 *
 * Recovery for evidence-pack jobs (Task15i2; evidence-pack.md): runs every job that is
 * queued, or running past its 10-minute lease (a crashed API process), once each, with
 * the production wiring (defaultPackJobDeps: the pg store, TASK4_EXPORT_DIR, the
 * tenant's statement key through the trust inventory). The API starts each job itself
 * after its 202; this command only picks up what a restart left behind. Production
 * scheduling is Task14's. Prints job IDs, outcomes and codes only.
 */
import 'dotenv/config';
import { pool } from '../../core/db';
import { parseArgs } from './attesta-build-cli';
import { defaultPackJobDeps, runEvidencePack, type PackJobDeps, type PackRunResult } from './evidence-pack-service';

export const DEFAULT_RECOVERY_LIMIT = 20;

/** Run up to `limit` recoverable jobs in order; returns each outcome. */
export async function runQueuedPacks(deps: PackJobDeps, limit = DEFAULT_RECOVERY_LIMIT): Promise<Array<{ id: string; result: PackRunResult }>> {
  const out: Array<{ id: string; result: PackRunResult }> = [];
  for (const job of await deps.store.runnable(limit)) {
    out.push({ id: job.id, result: await runEvidencePack(deps, job.tenantId, job.id) });
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) {
    if (name !== 'run-queued' && name !== 'limit') throw new Error(`unknown option --${name}`);
  }
  if (args.get('run-queued') !== 'true') throw new Error('pass --run-queued to run the queued and stranded evidence-pack jobs');
  const rawLimit = args.get('limit') ?? String(DEFAULT_RECOVERY_LIMIT);
  if (!/^[1-9]\d{0,3}$/.test(rawLimit)) throw new Error('--limit must be 1..9999');
  const deps = defaultPackJobDeps(process.env);
  const results = await runQueuedPacks({ ...deps, log: (line) => console.log(line) }, Number(rawLimit));
  for (const r of results) console.log(`attesta_pack id=${r.id} result=${r.result}`);
  console.log(`attesta_pack_pass jobs=${results.length}`);
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:pack failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
