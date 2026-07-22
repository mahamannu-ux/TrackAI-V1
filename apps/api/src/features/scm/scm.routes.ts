import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  scmContributors,
  scmPullRequests,
  scmRepositories,
  ssoTenants,
} from '../../core/db/schema';
import { verifyGitHubSignature } from './crypto';
import { parseGitHubWebhook, type SCMPayload } from './parser';

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
            title: payload.pullRequest.title,
            state: payload.pullRequest.state,
            authorEmail: payload.pullRequest.authorEmail,
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
              updatedAt: new Date(),
            },
          })
          .returning({ id: scmPullRequests.id });

        pullRequestId = pullRequest?.id ?? null;
      }

      if (payload.eventType === 'pr_opened' && payload.pullRequest) {
        const authorEmail = payload.pullRequest.authorEmail.trim().toLowerCase();
        const contributorName = authorEmail.split('@')[0] || authorEmail;

        const [contributor] = await transaction
          .insert(scmContributors)
          .values({
            tenantId: tenant.id,
            repositoryId: repository.id,
            name: contributorName,
            email: authorEmail,
          })
          .onConflictDoUpdate({
            target: [
              scmContributors.tenantId,
              scmContributors.repositoryId,
              scmContributors.email,
            ],
            set: {
              name: contributorName,
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

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Failed to process SCM webhook:', error);
    res.status(500).json({ error: 'Failed to process SCM webhook' });
  }
});

export default router;
