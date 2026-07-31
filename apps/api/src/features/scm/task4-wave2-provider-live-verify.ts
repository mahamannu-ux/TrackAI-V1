import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  providerEventDeliveries,
  providerProjectionCursors,
  ssoTenants,
} from '../../core/db/schema';
import {
  claimProviderDeliveryInTransaction,
  completeProviderDeliveryInTransaction,
  projectProviderDeliveryInTransaction,
  releaseProviderDeliveryForRetryInTransaction,
  type ProviderTransaction,
} from './provider-delivery-store';

const COMPANY_A_DOMAIN = 'purpletealabs.net';
const COMPANY_B_DOMAIN = 'customer-b-oidc.com';

const lifecycleCountsSql = `
  SELECT
    (SELECT count(*)::text FROM telemetry_metric_events) AS telemetry_metric_events,
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM scm_pull_requests) AS scm_pull_requests,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_session_usage) AS ai_session_usage,
    (SELECT count(*)::text FROM ai_commit_sessions) AS ai_commit_sessions,
    (SELECT count(*)::text FROM ai_commit_model_attributions) AS ai_commit_model_attributions,
    (SELECT count(*)::text FROM scm_commit_lineage) AS scm_commit_lineage,
    (SELECT count(*)::text FROM scm_pull_request_snapshots) AS scm_pull_request_snapshots,
    (SELECT count(*)::text FROM scm_pull_request_commit_memberships) AS scm_pull_request_commit_memberships,
    (SELECT count(*)::text FROM scm_merge_lineage) AS scm_merge_lineage,
    (SELECT count(*)::text FROM scm_deployments) AS scm_deployments,
    (SELECT count(*)::text FROM ai_generation_observations) AS ai_generation_observations,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events,
    (SELECT count(*)::text FROM telemetry_corrections) AS telemetry_corrections
`;

class VerificationRollback extends Error {}

function deliveryInput(
  tenantId: string,
  deliveryId: string,
  fingerprint: string,
  occurredAt: Date | null,
  now: Date,
) {
  return {
    tenantId,
    provider: 'github' as const,
    deliveryId,
    eventType: 'push' as const,
    fingerprint,
    providerOccurredAt: occurredAt,
    rawEvent: { task4Probe: true, deliveryId },
    now,
  };
}

async function project(
  transaction: ProviderTransaction,
  tenantId: string,
  deliveryId: string,
  fingerprint: string,
  occurredAt: Date | null,
  projectionKey: string,
  now: Date,
  onProject: () => void,
) {
  const claim = await claimProviderDeliveryInTransaction(
    transaction,
    deliveryInput(tenantId, deliveryId, fingerprint, occurredAt, now),
  );
  if (claim.outcome !== 'claimed' || claim.action !== 'process') {
    throw new Error('Expected a newly claimed provider delivery');
  }
  const result = await projectProviderDeliveryInTransaction(transaction, {
    tenantId,
    provider: 'github',
    deliveryId,
    recordId: claim.recordId,
    leaseStartedAt: claim.leaseStartedAt,
    fingerprint,
    occurredAt,
    identity: { projectionType: 'branch', projectionKey },
    now,
  }, async () => {
    onProject();
    return true;
  });
  return { claim, result };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task4-wave2-${randomUUID()}`;
  const baseTime = new Date('2026-07-31T08:30:00.000Z');
  const newerTime = new Date('2026-07-31T08:31:00.000Z');
  const olderTime = new Date('2026-07-31T08:29:00.000Z');
  const expiredTime = new Date(baseTime.getTime() + 6 * 60 * 1000);
  const beforeLifecycle = (await pool.query(lifecycleCountsSql)).rows[0];
  let projectionCallbacks = 0;
  const checks: Record<string, boolean> = {};

  try {
    await db.transaction(async (transaction) => {
      const tenants = await transaction.select({ id: ssoTenants.id, domain: ssoTenants.domain })
        .from(ssoTenants)
        .where(inArray(ssoTenants.domain, [COMPANY_A_DOMAIN, COMPANY_B_DOMAIN]));
      const companyA = tenants.find(tenant => tenant.domain.toLowerCase() === COMPANY_A_DOMAIN);
      const companyB = tenants.find(tenant => tenant.domain.toLowerCase() === COMPANY_B_DOMAIN);
      if (!companyA || !companyB) throw new Error('Company A/B tenant fixtures are required');
      checks.companyATenant = true;
      checks.companyBTenant = true;

      const sharedDeliveryId = `${marker}-shared`;
      const sharedFingerprint = '1'.repeat(64);
      const sharedProjectionKey = `${marker}:refs/heads/main`;
      const firstA = await project(
        transaction, companyA.id, sharedDeliveryId, sharedFingerprint,
        baseTime, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      const firstB = await project(
        transaction, companyB.id, sharedDeliveryId, sharedFingerprint,
        baseTime, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      checks.sameDeliveryIdCrossTenant = firstA.result.outcome === 'projected'
        && firstB.result.outcome === 'projected';
      checks.completedA = await completeProviderDeliveryInTransaction(transaction, {
        tenantId: companyA.id,
        recordId: firstA.claim.recordId,
        leaseStartedAt: firstA.claim.leaseStartedAt,
        now: baseTime,
      });
      checks.completedB = await completeProviderDeliveryInTransaction(transaction, {
        tenantId: companyB.id,
        recordId: firstB.claim.recordId,
        leaseStartedAt: firstB.claim.leaseStartedAt,
        now: baseTime,
      });

      const terminalRetry = await claimProviderDeliveryInTransaction(
        transaction,
        deliveryInput(companyA.id, sharedDeliveryId, sharedFingerprint, baseTime, baseTime),
      );
      checks.terminalRetryAcknowledged = terminalRetry.outcome === 'acknowledge'
        && terminalRetry.reason === 'applied';
      const changedDelivery = await claimProviderDeliveryInTransaction(
        transaction,
        deliveryInput(companyA.id, sharedDeliveryId, '2'.repeat(64), baseTime, baseTime),
      );
      checks.reusedDeliveryConflict = changedDelivery.outcome === 'acknowledge'
        && changedDelivery.reason === 'conflict';

      const duplicate = await project(
        transaction, companyA.id, `${marker}-duplicate`, sharedFingerprint,
        baseTime, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      checks.duplicateAcknowledged = duplicate.result.outcome === 'acknowledge'
        && duplicate.result.reason === 'duplicate';
      const stale = await project(
        transaction, companyA.id, `${marker}-stale`, '3'.repeat(64),
        olderTime, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      checks.staleAcknowledged = stale.result.outcome === 'acknowledge'
        && stale.result.reason === 'stale';
      const conflict = await project(
        transaction, companyA.id, `${marker}-conflict`, '4'.repeat(64),
        baseTime, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      checks.equalTimeConflictAcknowledged = conflict.result.outcome === 'acknowledge'
        && conflict.result.reason === 'conflict';
      const unsequenced = await project(
        transaction, companyA.id, `${marker}-unsequenced`, '5'.repeat(64),
        null, sharedProjectionKey, baseTime, () => { projectionCallbacks += 1; },
      );
      checks.unsequencedAcknowledged = unsequenced.result.outcome === 'acknowledge'
        && unsequenced.result.reason === 'unsequenced';
      const newer = await project(
        transaction, companyA.id, `${marker}-newer`, '6'.repeat(64),
        newerTime, sharedProjectionKey, newerTime, () => { projectionCallbacks += 1; },
      );
      checks.newerProjected = newer.result.outcome === 'projected';
      checks.newerCompleted = await completeProviderDeliveryInTransaction(transaction, {
        tenantId: companyA.id,
        recordId: newer.claim.recordId,
        leaseStartedAt: newer.claim.leaseStartedAt,
        now: newerTime,
      });

      const activeId = `${marker}-active`;
      const activeInput = deliveryInput(
        companyA.id, activeId, '7'.repeat(64), baseTime, baseTime,
      );
      const activeClaim = await claimProviderDeliveryInTransaction(transaction, activeInput);
      const activeRetry = await claimProviderDeliveryInTransaction(transaction, activeInput);
      checks.activeLeaseRetries = activeClaim.outcome === 'claimed'
        && activeRetry.outcome === 'retry';
      if (activeClaim.outcome !== 'claimed') throw new Error('Active claim was not acquired');
      checks.failedReleased = await releaseProviderDeliveryForRetryInTransaction(transaction, {
        tenantId: companyA.id,
        recordId: activeClaim.recordId,
        leaseStartedAt: activeClaim.leaseStartedAt,
        stage: 'received',
        errorCode: 'projection_failed',
        now: baseTime,
      });
      const recovered = await claimProviderDeliveryInTransaction(transaction, {
        ...activeInput, now: newerTime,
      });
      checks.failedClaimRecovered = recovered.outcome === 'claimed'
        && recovered.action === 'process';

      const resume = await project(
        transaction, companyA.id, `${marker}-resume`, '8'.repeat(64),
        baseTime, `${marker}:refs/heads/resume`, baseTime,
        () => { projectionCallbacks += 1; },
      );
      if (resume.result.outcome !== 'projected') throw new Error('Resume probe was not projected');
      checks.projectedReleased = await releaseProviderDeliveryForRetryInTransaction(transaction, {
        tenantId: companyA.id,
        recordId: resume.claim.recordId,
        leaseStartedAt: resume.claim.leaseStartedAt,
        stage: 'projected',
        errorCode: 'enrichment_failed',
        now: baseTime,
      });
      const resumed = await claimProviderDeliveryInTransaction(transaction, {
        ...deliveryInput(
          companyA.id, `${marker}-resume`, '8'.repeat(64), baseTime, newerTime,
        ),
      });
      checks.projectedResumed = resumed.outcome === 'claimed' && resumed.action === 'resume';
      if (resumed.outcome !== 'claimed') throw new Error('Projected claim was not resumed');
      checks.resumedCompleted = await completeProviderDeliveryInTransaction(transaction, {
        tenantId: companyA.id,
        recordId: resumed.recordId,
        leaseStartedAt: resumed.leaseStartedAt,
        now: newerTime,
      });

      const fencedId = `${marker}-fenced`;
      const fencedFingerprint = '9'.repeat(64);
      const oldClaim = await claimProviderDeliveryInTransaction(transaction, deliveryInput(
        companyA.id, fencedId, fencedFingerprint, baseTime, baseTime,
      ));
      if (oldClaim.outcome !== 'claimed') throw new Error('Old fencing lease was not acquired');
      const newClaim = await claimProviderDeliveryInTransaction(transaction, deliveryInput(
        companyA.id, fencedId, fencedFingerprint, baseTime, expiredTime,
      ));
      if (newClaim.outcome !== 'claimed') throw new Error('Expired fencing lease was not reclaimed');
      let oldLeaseBlocked = false;
      try {
        await transaction.transaction(async (savepoint) => {
          await projectProviderDeliveryInTransaction(savepoint, {
            tenantId: companyA.id,
            provider: 'github',
            deliveryId: fencedId,
            recordId: oldClaim.recordId,
            leaseStartedAt: oldClaim.leaseStartedAt,
            fingerprint: fencedFingerprint,
            occurredAt: baseTime,
            identity: { projectionType: 'branch', projectionKey: `${marker}:refs/heads/fenced` },
            now: expiredTime,
          }, async () => true);
        });
      } catch (error) {
        oldLeaseBlocked = error instanceof Error && error.message.includes('lease was lost');
      }
      checks.expiredLeaseFenced = oldLeaseBlocked;
      const winningProjection = await projectProviderDeliveryInTransaction(transaction, {
        tenantId: companyA.id,
        provider: 'github',
        deliveryId: fencedId,
        recordId: newClaim.recordId,
        leaseStartedAt: newClaim.leaseStartedAt,
        fingerprint: fencedFingerprint,
        occurredAt: baseTime,
        identity: { projectionType: 'branch', projectionKey: `${marker}:refs/heads/fenced` },
        now: expiredTime,
      }, async () => true);
      checks.reclaimedLeaseProjects = winningProjection.outcome === 'projected';

      const cursorRows = await transaction.select({ tenantId: providerProjectionCursors.tenantId })
        .from(providerProjectionCursors).where(and(
          inArray(providerProjectionCursors.tenantId, [companyA.id, companyB.id]),
          like(providerProjectionCursors.projectionKey, `${marker}%`),
        ));
      checks.tenantCursorsIsolated = cursorRows.some(row => row.tenantId === companyA.id)
        && cursorRows.some(row => row.tenantId === companyB.id);

      if (Object.values(checks).some(value => !value)) {
        throw new Error('One or more Wave 2 live provider checks failed');
      }
      throw new VerificationRollback();
    });
  } catch (error) {
    if (!(error instanceof VerificationRollback)) throw error;
  }

  const residual = await db.select({ id: providerEventDeliveries.id })
    .from(providerEventDeliveries)
    .where(like(providerEventDeliveries.deliveryId, `${marker}%`));
  const residualCursors = await db.select({ id: providerProjectionCursors.id })
    .from(providerProjectionCursors)
    .where(like(providerProjectionCursors.projectionKey, `${marker}%`));
  const afterLifecycle = (await pool.query(lifecycleCountsSql)).rows[0];
  if (residual.length + residualCursors.length !== 0) {
    throw new Error('Wave 2 rollback left residual provider probe rows');
  }
  if (JSON.stringify(beforeLifecycle) !== JSON.stringify(afterLifecycle)) {
    throw new Error('Task2 lifecycle counts changed during Wave 2 verification');
  }

  console.log('company_a_tenant=present');
  console.log('company_b_tenant=present');
  console.log('same_delivery_id_cross_tenant=isolated');
  console.log('active_lease=retry-signalled');
  console.log('reused_delivery_changed_evidence=conflict-acknowledged');
  console.log('duplicate=acknowledged-without-projection');
  console.log('stale=acknowledged-without-projection');
  console.log('equal_time_conflict=acknowledged-without-projection');
  console.log('unsequenced=acknowledged-without-projection');
  console.log('newer=projected');
  console.log('failed_claim=recovered');
  console.log('projected_enrichment=resumed');
  console.log('expired_lease=fenced-and-reclaimed');
  console.log(`projection_callbacks=${projectionCallbacks}`);
  console.log('transaction=rolled-back');
  console.log('residual_probe_rows=0');
  console.log('task2_lifecycle_counts=unchanged');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 provider verification failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
