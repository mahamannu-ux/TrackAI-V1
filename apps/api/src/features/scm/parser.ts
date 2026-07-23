export type SCMPayload = {
  provider: 'github' | 'gitlab' | 'bitbucket';
  eventType: 'pr_opened' | 'pr_updated' | 'pr_closed' | 'push' | 'deployment_status';
  organization: string;
  repository: {
    externalId: string;
    name: string;
    url: string;
  };
  pullRequest: {
    externalId: string;
    number: number;
    title: string;
    state: string;
    authorEmail: string | null;
    authorProviderId: string;
    authorLogin: string;
    headRef: string | null;
    baseRef: string | null;
    headSha: string | null;
    mergeCommitSha: string | null;
    mergedAt: string | null;
  } | null;
  push: {
    ref: string;
    beforeSha: string | null;
    afterSha: string | null;
    forced: boolean;
    deleted: boolean;
    commitShas: string[];
  } | null;
  deployment: {
    externalId: string;
    environment: string;
    ref: string | null;
    sha: string;
    status: string;
    production: boolean;
    deployedAt: string;
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

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
    const commits = Array.isArray(bodyRecord.commits) ? bodyRecord.commits : [];
    return {
      provider: 'github',
      eventType: 'push',
      organization,
      repository,
      pullRequest: null,
      push: {
        ref: asString(bodyRecord.ref) ?? 'unknown',
        beforeSha: asString(bodyRecord.before),
        afterSha: asString(bodyRecord.after),
        forced: bodyRecord.forced === true,
        deleted: bodyRecord.deleted === true,
        commitShas: commits.map(asRecord).filter(Boolean)
          .map((commit) => asString(commit!.id)).filter((sha): sha is string => Boolean(sha)),
      },
      deployment: null,
    };
  }

  if (event === 'deployment_status') {
    const deployment = asRecord(bodyRecord.deployment);
    const deploymentStatus = asRecord(bodyRecord.deployment_status);
    const externalId = asString(deployment?.id);
    const sha = asString(deployment?.sha);
    const status = asString(deploymentStatus?.state);
    if (!deployment || !deploymentStatus || !externalId || !sha || !status) return null;
    const environment = asString(deployment.environment)
      ?? asString(deploymentStatus.environment)
      ?? 'unknown';
    return {
      provider: 'github', eventType: 'deployment_status', organization, repository,
      pullRequest: null, push: null,
      deployment: {
        externalId,
        environment,
        ref: asString(deployment.ref),
        sha,
        status,
        production: environment.toLowerCase() === 'production',
        deployedAt: asString(deploymentStatus.created_at) ?? new Date().toISOString(),
      },
    };
  }

  if (event !== 'pull_request') return null;

  const action = asString(bodyRecord.action);
  const eventType = action === 'opened'
    ? 'pr_opened'
    : action === 'reopened' || action === 'synchronize'
      ? 'pr_updated'
    : action === 'closed'
      ? 'pr_closed'
      : null;

  // Ignore minor noisy PR actions like 'edited', 'labeled', or 'assigned'
  if (!eventType) return null;

  const pullRequest = asRecord(bodyRecord.pull_request);
  const author = pullRequest ? asRecord(pullRequest.user) : null;
  if (!pullRequest) return null;

  const externalId = asString(pullRequest.id);
  const number = asNumber(pullRequest.number) ?? asNumber(bodyRecord.number);
  const title = asString(pullRequest.title);
  const state = asString(pullRequest.state);
  const head = asRecord(pullRequest.head);
  const base = asRecord(pullRequest.base);
  const authorProviderId = asString(author?.id);
  const authorLogin = asString(author?.login);
  if (!externalId || number === null || !title || !state || !authorProviderId || !authorLogin) return null;

  return {
    provider: 'github',
    eventType,
    organization,
    repository,
    pullRequest: {
      externalId,
      number,
      title,
      state,
      authorEmail: asString(pullRequest.author_email)
        ?? asString(author?.email),
      authorProviderId,
      authorLogin,
      headRef: asString(head?.ref),
      baseRef: asString(base?.ref),
      headSha: asString(head?.sha),
      mergeCommitSha: asString(pullRequest.merge_commit_sha),
      mergedAt: asString(pullRequest.merged_at),
    },
    push: null,
    deployment: null,
  };
}
