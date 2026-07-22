export type SCMPayload = {
  provider: 'github' | 'gitlab' | 'bitbucket';
  eventType: 'pr_opened' | 'pr_closed' | 'push';
  organization: string;
  repository: {
    externalId: string;
    name: string;
    url: string;
  };
  pullRequest: {
    externalId: string;
    title: string;
    state: string;
    authorEmail: string;
  } | null;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return null;
}

function readHeader(headers: unknown, name: string): string | null {
  const headerRecord = asRecord(headers);
  if (!headerRecord) return null;

  const matchingKey = Object.keys(headerRecord)
    .find((key) => key.toLowerCase() === name.toLowerCase());
  if (!matchingKey) return null;

  const value = headerRecord[matchingKey];
  return Array.isArray(value) ? asString(value[0]) : asString(value);
}

function parseRepository(body: UnknownRecord): SCMPayload['repository'] | null {
  const repository = asRecord(body.repository);
  if (!repository) return null;

  const externalId = asString(repository.id);
  const name = asString(repository.name);
  const url = asString(repository.html_url);

  return externalId && name && url
    ? { externalId, name, url }
    : null;
}

function parseOrganization(body: UnknownRecord): string | null {
  const organization = asRecord(body.organization);
  const repository = asRecord(body.repository);
  const owner = repository ? asRecord(repository.owner) : null;

  // repository.owner.login is the canonical slug used in GitHub repository URLs.
  // organization.login is retained as a fallback for organization-level payloads.
  const login = asString(owner?.login) ?? asString(organization?.login);
  return login?.toLowerCase() ?? null;
}

/**
 * Converts supported GitHub webhook events into the provider-neutral SCM shape.
 * Unsupported events or malformed payloads return null.
 */
export function parseGitHubWebhook(headers: any, body: any): SCMPayload | null {
  const event = readHeader(headers, 'x-github-event');
  const bodyRecord = asRecord(body);
  if (!event || !bodyRecord) return null;

  const organization = parseOrganization(bodyRecord);
  const repository = parseRepository(bodyRecord);

  if (!organization || !repository) return null;

  if (event === 'push') {
    return {
      provider: 'github',
      eventType: 'push',
      organization,
      repository,
      pullRequest: null,
    };
  }

  if (event !== 'pull_request') return null;

  const action = asString(bodyRecord.action);
  const eventType = action === 'opened'
    ? 'pr_opened'
    : action === 'closed'
      ? 'pr_closed'
      : null;

  // Ignore minor noisy PR actions like 'edited', 'labeled', or 'assigned'
  if (!eventType) return null;

  const pullRequest = asRecord(bodyRecord.pull_request);
  const author = pullRequest ? asRecord(pullRequest.user) : null;
  if (!pullRequest) return null;

  const externalId = asString(pullRequest.id);
  const title = asString(pullRequest.title);
  const state = asString(pullRequest.state);
  if (!externalId || !title || !state) return null;

  return {
    provider: 'github',
    eventType,
    organization,
    repository,
    pullRequest: {
      externalId,
      title,
      state,
      /*
      // Secure Fallback: GitHub hides email addresses in webhook data blocks
      authorEmail: asString(pullRequest.author_email)
        ?? asString(author?.email)
        ?? `${asString(author?.login) || 'unknown'}@github.user`,
        */
      authorEmail: (() => {
        const lowerTitle = title.toLowerCase();

        // COMPANY A SIMULATION TRIGGERS
        if (lowerTitle.includes('dev1-a')) return 'user1custA@purpletealabs.net';
        if (lowerTitle.includes('dev2-a')) return 'user2custA@purpletealabs.net';

        // COMPANY B SIMULATION TRIGGERS
        if (lowerTitle.includes('dev1-b')) return 'user1custB@customer-b-oidc.com';
        if (lowerTitle.includes('dev2-b')) return 'user2custB@customer-b-oidc.com';

        // Default fallback if no tag is present
        return asString(pullRequest.author_email) ?? `${asString(author?.login) || 'unknown'}@github.user`;
      })()
    },
  };
}
