import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  aiCodeLifecycleEvents,
  aiCommitModelAttributions,
  aiCommitSessions,
  aiGenerationObservations,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  aiModelLifecycleEvents,
  scmCommitFiles,
  scmCommitLineage,
  scmCommits,
  scmBranches,
  scmContributors,
  scmDeployments,
  scmMergeLineage,
  scmProviderIdentities,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequestSnapshots,
  scmPullRequests,
  ssoTenants,
  telemetryCorrections,
  telemetryIngestBatches,
  telemetryMetricEvents,
  tenantIdentityLinks,
} from '../../core/db/schema';

async function main() {
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=') || 'true'];
}));
const domain = args.get('tenant-domain')?.trim().toLowerCase();
const confirmed = args.get('confirm') === 'RESET_TASK2';
const includeScmHistory = args.get('include-scm-history') === 'true';
if (!domain) throw new Error('--tenant-domain=<domain> is required');

const [tenant] = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
  .from(ssoTenants).where(eq(ssoTenants.domain, domain)).limit(1);
if (!tenant) throw new Error(`No tenant found for ${domain}`);

const tables = [
  aiModelLifecycleEvents,
  aiCodeLifecycleEvents,
  tenantIdentityLinks,
  scmContributors,
  scmMergeLineage,
  scmPullRequestCommitMemberships,
  scmPullRequestSnapshots,
  scmPullRequestCommits,
  scmCommitLineage,
  aiCommitModelAttributions,
  aiCommitSessions,
  aiSessionUsage,
  aiGenerationObservations,
  aiSessionRepositories,
  scmDeployments,
  scmCommitFiles,
  telemetryCorrections,
  scmCommits,
  aiSessions,
  telemetryMetricEvents,
  telemetryIngestBatches,
  scmProviderIdentities,
  ...(includeScmHistory ? [scmBranches, scmPullRequests] : []),
] as const;
const tableNames = [
  'ai_model_lifecycle_events', 'ai_code_lifecycle_events', 'tenant_identity_links', 'scm_contributors',
  'scm_merge_lineage', 'scm_pull_request_commit_memberships', 'scm_pull_request_snapshots',
  'scm_pull_request_commits', 'scm_commit_lineage', 'ai_commit_model_attributions', 'ai_commit_sessions',
  'ai_session_usage', 'ai_generation_observations', 'ai_session_repositories',
  'scm_deployments', 'scm_commit_files', 'telemetry_corrections',
  'scm_commits', 'ai_sessions', 'telemetry_metric_events',
  'telemetry_ingest_batches', 'scm_provider_identities',
  ...(includeScmHistory ? ['scm_branches', 'scm_pull_requests'] : []),
] as const;

const counts: Record<string, number> = {};
for (const [index, table] of tables.entries()) {
  const rows = await db.select({ id: table.id }).from(table).where(eq(table.tenantId, tenant.id));
  counts[tableNames[index]] = rows.length;
}

if (!confirmed) {
  console.log(JSON.stringify({ dryRun: true, tenant: tenant.domain, includeScmHistory, preserved: [
    'sso_tenants', 'authentication identities', 'scm_repositories',
    ...(includeScmHistory ? [] : ['scm_pull_requests', 'scm_branches']),
  ], wouldDelete: counts, next: `rerun with --confirm=RESET_TASK2${includeScmHistory ? ' --include-scm-history=true' : ''}` }, null, 2));
  return;
}

await db.transaction(async (transaction) => {
  for (const table of tables) {
    await transaction.delete(table).where(eq(table.tenantId, tenant.id));
  }
});
console.log(JSON.stringify({ dryRun: false, tenant: tenant.domain, deleted: counts }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
