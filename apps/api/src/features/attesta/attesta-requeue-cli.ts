/**
 * `npm run attesta:requeue -w apps/api -- --tenant <uuid> --code <ATTESTA_…> --actor <name> [--confirm=REQUEUE --expect=<n>]`
 *
 * Puts a tenant's `failed` outbox rows with one error code back in the queue
 * (outbox.md: pending, processed_at and claimed_at cleared, attempts kept).
 * Dry-run by default: prints the count and changes nothing (AGENTS.md §9 item 10).
 * With --confirm=REQUEUE --expect=<dry-run count> it moves exactly those rows (or
 * nothing, if the count changed) and writes one security_audit_events row (actor,
 * tenant, code, count). Prints counts only, never row or content IDs.
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
  const expectArg = args.get('expect');
  if (confirmArg === 'REQUEUE' && (expectArg === undefined || !/^\d+$/.test(expectArg))) {
    throw new Error('--confirm=REQUEUE needs --expect=<the dry-run count>');
  }
  const result = await requeueFailedSubjects(db, {
    tenantId, code, actorId, confirm: confirmArg === 'REQUEUE',
    expect: expectArg === undefined ? undefined : Number(expectArg),
  });
  console.log(`mode=${result.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`code=${code}`);
  console.log(`matched_failed_rows=${result.matched}`);
  console.log(`requeued_rows=${result.requeued}`);
  console.log(result.dryRun
    ? `next=rerun with --confirm=REQUEUE --expect=${result.matched} after review`
    : 'audit=security_audit_events row written');
  // Attempts are kept (outbox.md): a row that failed at the attempt limit gets one more try.
  console.log('attempts=kept');
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'attesta:requeue failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
