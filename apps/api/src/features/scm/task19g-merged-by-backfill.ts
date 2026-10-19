import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import { providerEventDeliveries, scmProviderIdentities, scmPullRequests, scmRepositories, ssoTenants } from '../../core/db/schema';
import { recordAuditEvent } from '../../core/audit/record';
import { parseGitHubWebhook } from './parser';

export interface BackfillCandidate {
  tenantId: string;
  repositoryId: string;
  externalId: string;
  mergerId: string;
  mergerLogin: string;
}

/** Pure planning: latest retained merged delivery wins; only null fields are candidates. */
export function planMergedByBackfill(
  tenantId: string,
  deliveries: Array<typeof providerEventDeliveries.$inferSelect>,
  repositories: Array<typeof scmRepositories.$inferSelect>,
  pullRequests: Array<typeof scmPullRequests.$inferSelect>,
): { candidates: BackfillCandidate[]; skipped: number } {
  const planned = new Map<string, BackfillCandidate>();
  let skipped = 0;
  for (const delivery of [...deliveries].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
    if (delivery.provider !== 'github' || delivery.eventType !== 'pr_closed') continue;
    const payload = parseGitHubWebhook({ 'x-github-event': 'pull_request' }, delivery.rawEvent);
    const pr = payload?.pullRequest;
    if (!pr?.mergedAt || !pr.mergedByProviderId || !pr.mergedByLogin) { skipped++; continue; }
    const repository = repositories.find((row) => row.id === delivery.repositoryId
      || row.externalId === payload?.repository.externalId);
    const stored = pullRequests.find((row) => row.repositoryId === repository?.id && row.externalId === pr.externalId);
    if (!repository || !stored || (stored.mergedByProviderId && stored.mergedByLogin)) { skipped++; continue; }
    planned.set(stored.id, {
      tenantId, repositoryId: repository.id, externalId: pr.externalId,
      mergerId: pr.mergedByProviderId, mergerLogin: pr.mergedByLogin,
    });
  }
  return { candidates: [...planned.values()], skipped };
}

export async function runMergedByBackfill(confirm: boolean): Promise<void> {
  const tenants = await db.select({ id: ssoTenants.id }).from(ssoTenants);
  for (const tenant of tenants) {
    const tenantDb = withTenant(db, tenant.id);
    const [deliveries, repositories, pullRequests] = await Promise.all([
      tenantDb.select(providerEventDeliveries), tenantDb.select(scmRepositories), tenantDb.select(scmPullRequests),
    ]);
    const plan = planMergedByBackfill(tenant.id, deliveries, repositories, pullRequests);
    console.log(JSON.stringify({ tenant_id: tenant.id, would_update: plan.candidates.length, skipped: plan.skipped, dry_run: !confirm }));
    if (!confirm || plan.candidates.length === 0) continue;
    await db.transaction(async (tx) => {
      let updated = 0;
      for (const candidate of plan.candidates) {
        const rows = await tx.update(scmPullRequests).set({
          mergedByProviderId: sql`coalesce(${scmPullRequests.mergedByProviderId}, ${candidate.mergerId})`,
          mergedByLogin: sql`coalesce(${scmPullRequests.mergedByLogin}, ${candidate.mergerLogin})`,
          updatedAt: new Date(),
        }).where(and(
          eq(scmPullRequests.tenantId, tenant.id),
          eq(scmPullRequests.repositoryId, candidate.repositoryId),
          eq(scmPullRequests.externalId, candidate.externalId),
          or(isNull(scmPullRequests.mergedByProviderId), isNull(scmPullRequests.mergedByLogin)),
        )).returning({ id: scmPullRequests.id });
        if (!rows.length) continue;
        updated++;
        await tx.insert(scmProviderIdentities).values({
          tenantId: tenant.id, provider: 'github', providerUserId: candidate.mergerId,
          login: candidate.mergerLogin, displayName: candidate.mergerLogin,
        }).onConflictDoUpdate({
          target: [scmProviderIdentities.tenantId, scmProviderIdentities.provider, scmProviderIdentities.providerUserId],
          set: { login: candidate.mergerLogin, updatedAt: new Date() },
        });
      }
      await recordAuditEvent(tx, tenant.id, {
        action: 'scm.merged_by.backfilled', actorType: 'system_operator', actorId: 'task19g-backfill',
        targetType: 'tenant', targetId: tenant.id,
        details: { updated, skipped: plan.skipped + plan.candidates.length - updated },
      });
    });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--confirm')) {
    console.error('Usage: backfill:task19g-merged-by [--confirm]');
    process.exitCode = 2;
  } else {
    runMergedByBackfill(args[0] === '--confirm').catch(() => {
      console.error('Merged-by backfill failed');
      process.exitCode = 1;
    }).finally(() => pool.end());
  }
}
