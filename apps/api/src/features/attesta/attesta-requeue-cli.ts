/**
 * `npm run attesta:requeue -w apps/api -- --tenant <uuid> --code <ATTESTA_…> --actor <name> [--confirm=REQUEUE]`
 *
 * Puts a tenant's `failed` outbox rows with one error code back in the queue
 * (outbox.md: pending, processed_at and claimed_at cleared, attempts kept).
 * Dry-run by default: prints the count and changes nothing (AGENTS.md §9 item 10).
 * With --confirm=REQUEUE it moves the rows and writes one security_audit_events row
 * (actor, tenant, code, count). Prints counts only, never row or content IDs.
 */
import 'dotenv/config';
import { db, pool } from '../../core/db';
import { parseArgs } from './attesta-build-cli';
import { requeueFailedSubjects } from './worker';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.get('tenant');
  const code = args.get('code');
  const actorId = args.get('actor');
  if (!tenantId || !code || !actorId) throw new Error('--tenant, --code and --actor are required');
  const confirmArg = args.get('confirm');
  if (confirmArg !== undefined && confirmArg !== 'REQUEUE') throw new Error('--confirm must be exactly REQUEUE');
  const result = await requeueFailedSubjects(db, {
    tenantId, code, actorId, confirm: confirmArg === 'REQUEUE',
  });
  console.log(`mode=${result.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`code=${code}`);
  console.log(`matched_failed_rows=${result.matched}`);
  console.log(`requeued_rows=${result.requeued}`);
  console.log(result.dryRun ? 'next=rerun with --confirm=REQUEUE after review' : 'audit=security_audit_events row written');
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'attesta:requeue failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
