/**
 * `npm run attesta:report -w apps/api -- --run-queued [--limit 20]`
 *
 * Recovery for period-report jobs (Task15i4; period-report.md), as `attesta:pack` is for
 * evidence packs: runs every job that is queued, or running past its 10-minute lease (a
 * crashed API process), once each, with the production wiring (defaultReportJobDeps). The
 * API starts each job itself after its 202; this command only picks up what a restart left
 * behind. Production scheduling is Task14's. Prints job IDs, outcomes and codes only.
 */
import 'dotenv/config';
import { pool } from '../../core/db';
import { parseArgs } from './attesta-build-cli';
import { defaultReportJobDeps, runQueuedReports } from './period-report-service';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) {
    if (name !== 'run-queued' && name !== 'limit') throw new Error(`unknown option --${name}`);
  }
  if (args.get('run-queued') !== 'true') throw new Error('pass --run-queued to run the queued and stranded period-report jobs');
  const rawLimit = args.get('limit') ?? '20';
  if (!/^[1-9]\d{0,3}$/.test(rawLimit)) throw new Error('--limit must be 1..9999');
  const deps = defaultReportJobDeps(process.env);
  const results = await runQueuedReports({ ...deps, log: (line) => console.log(line) }, Number(rawLimit));
  for (const r of results) console.log(`attesta_report id=${r.id} result=${r.result}`);
  console.log(`attesta_report_pass jobs=${results.length}`);
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:report failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
