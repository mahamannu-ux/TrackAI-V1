/**
 * `npm run audit:export -w apps/api -- --run-queued [--limit 20]`
 *
 * Recovery for signed audit export jobs (Task16e, A16.7; docs/contracts/audit/export.md), as
 * `attesta:pack` is for evidence packs: runs every job that is queued, or running past its
 * 10-minute lease (a restarted API process), once each, with the production wiring. The API
 * starts each job itself after its 202. Prints job IDs, outcomes and codes only.
 */
import 'dotenv/config';
import { pool } from '../../core/db';
import { parseArgs } from '../attesta/attesta-build-cli';
import { defaultExportJobDeps, runAuditExport, type ExportJobDeps, type ExportRunResult } from './export-service';

/** Run up to `limit` recoverable jobs in order; returns each outcome. */
export async function runQueuedExports(deps: ExportJobDeps, limit = 20): Promise<Array<{ id: string; result: ExportRunResult }>> {
  const out: Array<{ id: string; result: ExportRunResult }> = [];
  for (const job of await deps.store.runnable(limit)) out.push({ id: job.id, result: await runAuditExport(deps, job.tenantId, job.id) });
  return out;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) if (name !== 'run-queued' && name !== 'limit') throw new Error(`unknown option --${name}`);
  if (args.get('run-queued') !== 'true') throw new Error('pass --run-queued to run the queued and stranded audit export jobs');
  const rawLimit = args.get('limit') ?? '20';
  if (!/^[1-9]\d{0,3}$/.test(rawLimit)) throw new Error('--limit must be 1..9999');
  const results = await runQueuedExports({ ...defaultExportJobDeps(process.env), log: (line) => console.log(line) }, Number(rawLimit));
  for (const r of results) console.log(`audit_export id=${r.id} result=${r.result}`);
  console.log(`audit_export_pass jobs=${results.length}`);
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'audit:export failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
