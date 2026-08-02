import { Router, Request, Response } from 'express';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  scmContributors,
  scmCommits,
  scmPullRequests,
  scmProviderIdentities,
  scmRepositories,
  ssoTenants,
} from '../../core/db/schema';
import { verifyGitHubSignature } from './crypto';
import { parseGitHubWebhook, type SCMPayload } from './parser';
import { normalizeRepositoryUrl } from '../telemetry/repository-url';
import { reconcileRepositoryPullRequests } from '../telemetry/service';
import {
  getRepositoryCommit,
  getRepositoryCommitFirstParentChain,
  listPullRequestCommits,
} from './github-app';
import {
  recordDeployment,
  recordMergeLineage,
  recordPullRequestSnapshot,
  recordPushedCommit,
} from './lifecycle-service';
import {
  claimProviderDelivery,
  completeProviderDelivery,
  projectProviderDelivery,
  releaseProviderDeliveryForRetry,
} from './provider-delivery-store';
import {
  normalizeProviderDeliveryId,
  providerEventFingerprint,
  providerProjectionIdentity,
} from './provider-event';

const router = Router();

type WebhookParser = (headers: unknown, body: unknown) => SCMPayload | null;

const providerParsers: Partial<Record<SCMPayload['provider'], WebhookParser>> = {
  github: parseGitHubWebhook,
};

function decodeWebhookBody(rawBody: string, contentType: string): unknown | null {
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const encodedPayload = new URLSearchParams(rawBody).get('payload');
      return encodedPayload ? JSON.parse(encodedPayload) : null;
    }

    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function parseProviderOccurredAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const occurredAt = new Date(value);
  return Number.isFinite(occurredAt.getTime()) ? occurredAt : null;
}

interface StoredWebhookRecords {
  repositoryId: string;
  pullRequestId: string | null;
  contributorId: string | null;
}

async function loadProjectedWebhookRecords(
  tenantId: string,
  payload: SCMPayload,
): Promise<StoredWebhookRecords> {
  const [repository] = await db.select({ id: scmRepositories.id })
    .from(scmRepositories).where(and(
      eq(scmRepositories.tenantId, tenantId),
      eq(scmRepositories.provider, payload.provider),
      eq(scmRepositories.externalId, payload.repository.externalId),
    )).limit(1);
  if (!repository) throw new Error('Projected repository was not found');

  let pullRequestId: string | null = null;
  if (payload.pullRequest) {
    const [pullRequest] = await db.select({ id: scmPullRequests.id })
      .from(scmPullRequests).where(and(
        eq(scmPullRequests.tenantId, tenantId),
        eq(scmPullRequests.repositoryId, repository.id),
        eq(scmPullRequests.externalId, payload.pullRequest.externalId),
      )).limit(1);
    if (!pullRequest) throw new Error('Projected pull request was not found');
    pullRequestId = pullRequest.id;
  }

  return { repositoryId: repository.id, pullRequestId, contributorId: null };
}

/**
 * POST /api/v1/webhooks/:provider
 * Public SCM webhook receiver secured with provider signature verification;
 * this route intentionally does not use interactive-user JWT auth.
 */
router.post('/:provider', async (req: Request, res: Response) => {
  const providerParam = Array.isArray(req.params.provider)
    ? req.params.provider[0]
    : req.params.provider;

  const provider = providerParam?.toLowerCase() as SCMPayload['provider'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;

  if (provider === 'github') {
    const signature = req.get('x-hub-signature-256');
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (
      !signature
      || !secret
      || rawBody === null
      || !verifyGitHubSignature(signature, rawBody, secret)
    ) {
      res.status(401).json({ error: 'Unauthorized: Invalid webhook signature' });
      return;
    }
  }

  const parser = providerParsers[provider];

  if (!parser) {
    console.log('Unsupported SCM provider');
    res.status(400).json({ error: `Unsupported SCM provider: ${providerParam ?? ''}` });
    return;
  }

  if (rawBody === null) {
    res.status(400).json({ error: 'Malformed webhook body' });
    return;
  }

  // GitHub sends a ping containing a random `zen` phrase when a webhook is
  // configured. It verifies delivery only and is not a business SCM event.

  if (provider === 'github' && req.get('x-github-event') === 'ping') {
    res.status(200).json({ ok: true });
    return;
  }

  const webhookBody = decodeWebhookBody(rawBody, req.get('content-type') ?? '');
  const payload = webhookBody ? parser(req.headers, webhookBody) : null;
  if (!payload) {
    console.log('Unsupported or malformed SCM webhook payload');
    res.status(400).json({ error: 'Unsupported or malformed SCM webhook payload' });
    return;
  }

  const deliveryId = normalizeProviderDeliveryId(req.get('x-github-delivery'));
  if (!deliveryId) {
    res.status(400).json({ error: 'Missing or invalid provider delivery ID' });
    return;
  }
  if (typeof webhookBody !== 'object' || webhookBody === null || Array.isArray(webhookBody)) {
    res.status(400).json({ error: 'Malformed webhook body' });
    return;
  }
  const rawEvent = webhookBody as Record<string, unknown>;
  const fingerprint = providerEventFingerprint(provider, payload.eventType, rawEvent);
  const occurredAt = parseProviderOccurredAt(payload.providerOccurredAt);
  const projectionIdentity = providerProjectionIdentity(payload);
  let retryRelease: {
    tenantId: string;
    recordId: string;
    leaseStartedAt: Date;
    stage: 'received' | 'projected';
  } | null = null;

  try {
    const [tenant] = await db
      .select({ id: ssoTenants.id })
      .from(ssoTenants)
      .where(sql`lower(${ssoTenants.scmOrgIdentifier}) = ${payload.organization}`)
      .limit(1);

    if (!tenant) {
      console.log('No tenant registered for this SCM organization');
      res.status(404).json({ error: 'No tenant registered for this SCM organization' });
      return;
    }

    const claim = await claimProviderDelivery({
      tenantId: tenant.id,
      provider,
      deliveryId,
      eventType: payload.eventType,
      fingerprint,
      providerOccurredAt: occurredAt,
      rawEvent,
    });
    if (claim.outcome === 'retry') {
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'SCM webhook processing is in progress' });
      return;
    }
    if (claim.outcome === 'acknowledge') {
      console.log('Acknowledged SCM webhook', {
        tenantId: tenant.id, provider, deliveryId, outcome: claim.reason,
      });
      res.status(200).json({ ok: true, outcome: claim.reason });
      return;
    }

    retryRelease = {
      tenantId: tenant.id,
      recordId: claim.recordId,
      leaseStartedAt: claim.leaseStartedAt,
      stage: claim.action === 'resume' ? 'projected' : 'received',
    };

    let storedRecords: StoredWebhookRecords;
    if (claim.action === 'resume') {
      storedRecords = await loadProjectedWebhookRecords(tenant.id, payload);
    } else {
      const projection = await projectProviderDelivery({
        tenantId: tenant.id,
        provider,
        deliveryId,
        recordId: claim.recordId,
        leaseStartedAt: claim.leaseStartedAt,
        fingerprint,
        occurredAt,
        identity: projectionIdentity,
      }, async (transaction) => {
      const normalizedUrl = normalizeRepositoryUrl(payload.repository.url);
      const [existingRepository] = await transaction
        .select({ id: scmRepositories.id })
        .from(scmRepositories)
        .where(and(
          eq(scmRepositories.tenantId, tenant.id),
          or(
            normalizedUrl
              ? eq(scmRepositories.normalizedUrl, normalizedUrl)
              : undefined,
            and(
              eq(scmRepositories.provider, payload.provider),
              eq(scmRepositories.externalId, payload.repository.externalId),
            ),
          ),
        ))
        .limit(1);

      const repositoryValues = {
        tenantId: tenant.id,
        provider: payload.provider,
        externalId: payload.repository.externalId,
        name: payload.repository.name,
        url: payload.repository.url,
        normalizedUrl,
      };

      const [repository] = existingRepository
        ? await transaction
          .update(scmRepositories)
          .set({
            provider: payload.provider,
            externalId: payload.repository.externalId,
            name: payload.repository.name,
            url: payload.repository.url,
            normalizedUrl,
          })
          .where(eq(scmRepositories.id, existingRepository.id))
          .returning({ id: scmRepositories.id })
        : await transaction
          .insert(scmRepositories)
          .values(repositoryValues)
          .onConflictDoUpdate({
            target: [
              scmRepositories.tenantId,
              scmRepositories.provider,
              scmRepositories.externalId,
            ],
            set: {
              name: payload.repository.name,
              url: payload.repository.url,
              normalizedUrl,
            },
          })
          .returning({ id: scmRepositories.id });

      if (!repository) {
        throw new Error('Repository upsert did not return a record');
      }

      let pullRequestId: string | null = null;
      let contributorId: string | null = null;

      if (payload.pullRequest) {
        const [pullRequest] = await transaction
          .insert(scmPullRequests)
          .values({
            tenantId: tenant.id,
            repositoryId: repository.id,
            externalId: payload.pullRequest.externalId,
            number: payload.pullRequest.number,
            title: payload.pullRequest.title,
            state: payload.pullRequest.state,
            authorEmail: payload.pullRequest.authorEmail,
            authorProviderId: payload.pullRequest.authorProviderId,
            authorLogin: payload.pullRequest.authorLogin,
            headRef: payload.pullRequest.headRef,
            baseRef: payload.pullRequest.baseRef,
            headSha: payload.pullRequest.headSha,
            mergeCommitSha: payload.pullRequest.mergeCommitSha,
            mergedAt: payload.pullRequest.mergedAt ? new Date(payload.pullRequest.mergedAt) : null,
          })
          .onConflictDoUpdate({
            target: [
              scmPullRequests.tenantId,
              scmPullRequests.repositoryId,
              scmPullRequests.externalId,
            ],
            set: {
              title: payload.pullRequest.title,
              state: payload.pullRequest.state,
              authorEmail: payload.pullRequest.authorEmail,
              authorProviderId: payload.pullRequest.authorProviderId,
              authorLogin: payload.pullRequest.authorLogin,
              number: payload.pullRequest.number,
              headRef: payload.pullRequest.headRef,
              baseRef: payload.pullRequest.baseRef,
              headSha: payload.pullRequest.headSha,
              mergeCommitSha: payload.pullRequest.mergeCommitSha,
              mergedAt: payload.pullRequest.mergedAt ? new Date(payload.pullRequest.mergedAt) : null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: scmPullRequests.id });

        pullRequestId = pullRequest?.id ?? null;
      }

      if (payload.pullRequest) {
        const [identity] = await transaction
          .insert(scmProviderIdentities)
          .values({
            tenantId: tenant.id,
            provider: payload.provider,
            providerUserId: payload.pullRequest.authorProviderId,
            login: payload.pullRequest.authorLogin,
            displayName: payload.pullRequest.authorLogin,
            email: payload.pullRequest.authorEmail?.trim().toLowerCase() ?? null,
          })
          .onConflictDoUpdate({
            target: [
              scmProviderIdentities.tenantId,
              scmProviderIdentities.provider,
              scmProviderIdentities.providerUserId,
            ],
            set: {
              login: payload.pullRequest.authorLogin,
              email: payload.pullRequest.authorEmail?.trim().toLowerCase() ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: scmProviderIdentities.id });

        const [contributor] = await transaction
          .insert(scmContributors)
          .values({
            tenantId: tenant.id,
            repositoryId: repository.id,
            name: payload.pullRequest.authorLogin,
            email: payload.pullRequest.authorEmail?.trim().toLowerCase() ?? null,
            providerIdentityId: identity?.id ?? null,
          })
          .onConflictDoUpdate({
            target: [
              scmContributors.tenantId,
              scmContributors.repositoryId,
              scmContributors.providerIdentityId,
            ],
            set: {
              name: payload.pullRequest.authorLogin,
              email: payload.pullRequest.authorEmail?.trim().toLowerCase() ?? null,
            },
          })
          .returning({ id: scmContributors.id });

        contributorId = contributor?.id ?? null;
      }

        return {
        repositoryId: repository.id,
        pullRequestId,
        contributorId,
        };
      });

      if (projection.outcome === 'acknowledge') {
        retryRelease = null;
        console.log('Acknowledged SCM webhook', {
          tenantId: tenant.id, provider, deliveryId, outcome: projection.reason,
        });
        res.status(200).json({ ok: true, outcome: projection.reason });
        return;
      }
      storedRecords = projection.value;
      retryRelease.stage = 'projected';
    }

    console.log('Stored SCM webhook', {
      tenantId: tenant.id,
      ...storedRecords,
      provider,
      deliveryId,
    });

    if (storedRecords.pullRequestId) {
      await reconcileRepositoryPullRequests(tenant.id, storedRecords.repositoryId);
      let pullRequestCommits = null;
      if (payload.pullRequest) {
        pullRequestCommits = await listPullRequestCommits(
          tenant.id,
          payload.organization,
          payload.repository.name,
          payload.pullRequest.number,
        );
        if (pullRequestCommits) {
          await recordPullRequestSnapshot({
            tenantId: tenant.id,
            repositoryId: storedRecords.repositoryId,
            pullRequestId: storedRecords.pullRequestId,
            headSha: payload.pullRequest.headSha,
            commits: pullRequestCommits,
          });
        }
      }
      if (payload.eventType === 'pr_closed' && payload.pullRequest?.mergeCommitSha && payload.pullRequest.mergedAt) {
        const resultCommit = await getRepositoryCommit(
          tenant.id,
          payload.organization,
          payload.repository.name,
          payload.pullRequest.mergeCommitSha,
        );
        const sourceCommitEvidence = pullRequestCommits
          ? (await Promise.all(pullRequestCommits.map((commit) => getRepositoryCommit(
            tenant.id,
            payload.organization,
            payload.repository.name,
            commit.sha,
          )))).filter((commit) => commit !== null)
          : undefined;
        const resultFirstParentChain = pullRequestCommits
          ? await getRepositoryCommitFirstParentChain(
            tenant.id,
            payload.organization,
            payload.repository.name,
            payload.pullRequest.mergeCommitSha,
            pullRequestCommits.length,
          )
          : undefined;
        await recordMergeLineage({
          tenantId: tenant.id,
          repositoryId: storedRecords.repositoryId,
          pullRequestId: storedRecords.pullRequestId,
          resultSha: payload.pullRequest.mergeCommitSha,
          resultCommit,
          sourceCommitEvidence,
          resultFirstParentChain,
          mergedAt: new Date(payload.pullRequest.mergedAt),
        });
      }
    }

    if (payload.deployment) {
      await recordDeployment({
        tenantId: tenant.id,
        repositoryId: storedRecords.repositoryId,
        provider: payload.provider,
        ...payload.deployment,
        deployedAt: new Date(payload.deployment.deployedAt),
      });
    }

    if (payload.push) {
      const observedAt = new Date();
      const branch = payload.push.ref.startsWith('refs/heads/')
        ? payload.push.ref.slice('refs/heads/'.length)
        : payload.push.ref;
      const pushedShas = [...new Set([
        ...payload.push.commitShas,
        payload.push.afterSha,
      ])].filter((sha): sha is string => Boolean(sha) && !/^0+$/.test(sha as string));

      if (!payload.push.deleted) {
        for (const sha of pushedShas) {
          const commit = await getRepositoryCommit(
            tenant.id,
            payload.organization,
            payload.repository.name,
            sha,
          );
          if (commit) {
            await recordPushedCommit({
              tenantId: tenant.id,
              repositoryId: storedRecords.repositoryId,
              branch,
              commit,
              observedAt,
            });
          } else {
            await db.update(scmCommits).set({
              reachability: 'reachable',
              lastSeenAt: observedAt,
              updatedAt: observedAt,
            }).where(and(
              eq(scmCommits.tenantId, tenant.id),
              eq(scmCommits.repositoryId, storedRecords.repositoryId),
              eq(scmCommits.sha, sha),
            ));
          }
        }
      } else {
        for (const sha of pushedShas) {
          await db.update(scmCommits).set({
            reachability: payload.push.deleted ? 'unreachable' : 'reachable',
            lastSeenAt: observedAt,
            updatedAt: observedAt,
          }).where(and(
            eq(scmCommits.tenantId, tenant.id),
            eq(scmCommits.repositoryId, storedRecords.repositoryId),
            eq(scmCommits.sha, sha),
          ));
        }
      }
    }

    const completed = await completeProviderDelivery({
      tenantId: tenant.id,
      recordId: retryRelease.recordId,
      leaseStartedAt: retryRelease.leaseStartedAt,
    });
    if (!completed) throw new Error('Provider delivery completion lease was lost');
    retryRelease = null;
    res.status(200).json({ ok: true, outcome: 'applied' });
  } catch (error) {
    const release = retryRelease;
    if (release) {
      try {
        await releaseProviderDeliveryForRetry({
          ...release,
          errorCode: release.stage === 'received'
            ? 'projection_failed'
            : 'enrichment_failed',
        });
      } catch {
        console.error('Failed to release SCM webhook processing lease', {
          provider, deliveryId, stage: release.stage,
        });
      }
    }
    console.error('Failed to process SCM webhook', {
      provider,
      deliveryId,
      stage: release?.stage ?? 'unclaimed',
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    res.set('Retry-After', '5');
    res.status(503).json({ error: 'Temporary failure processing SCM webhook' });
  }
});

export default router;
