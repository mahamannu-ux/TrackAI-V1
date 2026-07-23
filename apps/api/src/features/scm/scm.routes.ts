import { Router, Request, Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
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
import { githubReadConfigured, listPullRequestCommits } from './github-app';
import { recordDeployment, recordMergeLineage, recordPullRequestSnapshot } from './lifecycle-service';

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

    const storedRecords = await db.transaction(async (transaction) => {
      const [repository] = await transaction
        .insert(scmRepositories)
        .values({
          tenantId: tenant.id,
          provider: payload.provider,
          externalId: payload.repository.externalId,
          name: payload.repository.name,
          url: payload.repository.url,
          normalizedUrl: normalizeRepositoryUrl(payload.repository.url),
        })
        .onConflictDoUpdate({
          target: [
            scmRepositories.tenantId,
            scmRepositories.provider,
            scmRepositories.externalId,
          ],
          set: {
            name: payload.repository.name,
            url: payload.repository.url,
            normalizedUrl: normalizeRepositoryUrl(payload.repository.url),
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

    console.log('Stored SCM webhook', {
      tenantId: tenant.id,
      ...storedRecords,
      payload,
    });

    if (storedRecords.pullRequestId) {
      await reconcileRepositoryPullRequests(tenant.id, storedRecords.repositoryId);
      if (payload.pullRequest && githubReadConfigured()) {
        const commits = await listPullRequestCommits(
          payload.organization,
          payload.repository.name,
          payload.pullRequest.number,
        );
        if (commits) {
          await recordPullRequestSnapshot({
            tenantId: tenant.id,
            repositoryId: storedRecords.repositoryId,
            pullRequestId: storedRecords.pullRequestId,
            headSha: payload.pullRequest.headSha,
            commits,
          });
        }
      }
      if (payload.eventType === 'pr_closed' && payload.pullRequest?.mergeCommitSha && payload.pullRequest.mergedAt) {
        await recordMergeLineage({
          tenantId: tenant.id,
          repositoryId: storedRecords.repositoryId,
          pullRequestId: storedRecords.pullRequestId,
          resultSha: payload.pullRequest.mergeCommitSha,
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

    if (payload.push?.afterSha) {
      await db.update(scmCommits).set({
        reachability: payload.push.deleted ? 'unreachable' : 'reachable',
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(scmCommits.tenantId, tenant.id),
        eq(scmCommits.repositoryId, storedRecords.repositoryId),
        eq(scmCommits.sha, payload.push.afterSha),
      ));
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Failed to process SCM webhook:', error);
    res.status(500).json({ error: 'Failed to process SCM webhook' });
  }
});

export default router;
