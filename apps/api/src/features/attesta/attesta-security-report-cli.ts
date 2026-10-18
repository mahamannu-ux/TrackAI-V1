/**
 * `npm run attesta:security-report -w apps/api -- --tenant <uuid> --from <ms> --to <ms> [--repository <uuid>] [--confirm]`
 *
 * One security period report (Task15op-b, A15.16; docs/contracts/attesta/security-period-report.md).
 * Dry run by default (AGENTS.md §9 item 10): reads the snapshot, re-checks the covering seals and
 * computes the document, then prints the scope, the counts and the outcome; `--confirm` signs and
 * chains it (or returns the stored report with the same digest). Seal first:
 * `npm run attesta:security-seal -w apps/api -- --tenant <uuid> --now --confirm`.
 * Prints ids, counts, digests (with --confirm) and codes only, never row content.
 */
import 'dotenv/config';
import { userInfo } from 'node:os';
import { db, pool } from '../../core/db';
import { builderResolverFromEnv, parseArgs, resolveBuilderVersion } from './attesta-build-cli';
import type { SealDatabase } from './audit-seal-service';
import { buildSecurityReport, parseSecurityReportScope, pgSecurityReportStore } from './security-report-service';
import { SecurityReportError } from './security-report-rules';

/** The operator actor written into `attesta.security_report.built` (the OS account, bounded). */
export function operatorActorId(): string {
  let name = 'unknown';
  try {
    name = userInfo().username || 'unknown';
  } catch {
    name = 'unknown';
  }
  return `attesta:security-report:${name}`.slice(0, 256);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = parseArgs(process.argv.slice(2));
  for (const name of args.keys()) {
    if (!['tenant', 'repository', 'from', 'to', 'confirm', 'ephemeral-dev-key'].includes(name)) throw new Error(`unknown option --${name}`);
  }
  let scope;
  try {
    scope = parseSecurityReportScope({
      tenantId: args.get('tenant') ?? '', repositoryId: args.get('repository') ?? null, from: args.get('from') ?? '', to: args.get('to') ?? '',
    });
  } catch (err) {
    throw new Error(err instanceof SecurityReportError ? `${err.code}: ${err.message}` : 'the scope is invalid');
  }
  const dryRun = args.get('confirm') !== 'true';
  const { resolver, label } = dryRun
    ? { resolver: { resolve: async () => null }, label: 'signer=none' }
    : await builderResolverFromEnv(process.env, args);
  const r = await buildSecurityReport({
    store: pgSecurityReportStore(db as unknown as SealDatabase), resolver,
    builderVersion: dryRun ? '0.0.0+0000000' : resolveBuilderVersion(),
    actor: { type: 'system_operator', id: operatorActorId() }, log: (line) => console.log(line),
  }, scope, { dryRun });
  console.log(`attesta_security_report mode=${dryRun ? 'dry-run' : 'confirm'} ${label}`);
  const counts = r.rowCount !== undefined ? ` seals=${r.sealCount} rows=${r.rowCount} decisions=${r.decisionCount}` : '';
  const digests = !dryRun && r.reportDigest ? ` report_id=${r.reportId} report_digest=${r.reportDigest} statement_digest=${r.statementDigest}` : '';
  console.log(`attesta_security_report tenant=${scope.tenant_id} repository=${scope.repository_id ?? 'none'} from=${scope.from} to=${scope.to}`
    + ` outcome=${r.outcome}${counts}${digests}${r.code ? ` code=${r.code}` : ''}`);
  if (dryRun) console.log('dry run: nothing was signed or written; rerun with --confirm to build');
  if (r.outcome === 'refused') process.exitCode = 1;
}

if (require.main === module) {
  void main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'attesta:security-report failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
