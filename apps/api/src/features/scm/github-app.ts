import { createSign } from 'crypto';
import { loadGitHubAppRuntimeCredentials } from '../../core/security/github-app-security-service';

export type GitHubCommit = {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { id?: number; login?: string } | null;
  parents?: Array<{ sha: string }>;
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    patch?: string;
  }>;
};

type CachedToken = { value: string; expiresAt: number };
const cachedTokens = new Map<string, CachedToken>();

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

function installationIdFor(owner: string): string | null {
  const raw = process.env.GITHUB_APP_INSTALLATIONS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed[owner.toLowerCase()];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    } catch {
      throw new Error('GITHUB_APP_INSTALLATIONS_JSON must be an owner-to-installation-id object');
    }
  }
  return process.env.GITHUB_APP_INSTALLATION_ID ?? null;
}

async function installationToken(tenantId: string, owner: string): Promise<string | null> {
  const managed = await loadGitHubAppRuntimeCredentials(tenantId, owner);
  for (const credential of managed) {
    const cacheKey = `${tenantId}:${credential.installationId}`;
    const cachedToken = cachedTokens.get(cacheKey);
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const response = await fetch(
      `https://api.github.com/app/installations/${credential.installationExternalId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${appJwt(credential.appId, credential.privateKey)}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TrackAI',
        },
      },
    );
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && credential.status === 'active') {
        continue;
      }
      throw new Error(`GitHub installation token failed (${response.status})`);
    }
    const data = await response.json() as { token: string; expires_at: string };
    cachedTokens.set(cacheKey, {
      value: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    });
    return data.token;
  }

  // Transitional Task2 environment adapter. It is used only when the owner is
  // explicitly bound to an installation; Wave 4 managed records take priority.
  const installationId = installationIdFor(owner);
  if (!installationId) return null;
  const explicit = process.env.GITHUB_APP_INSTALLATION_TOKEN;
  if (explicit) return explicit;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !privateKey) return null;
  const cacheKey = `legacy:${owner.toLowerCase()}:${installationId}`;
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt(appId, privateKey)}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TrackAI',
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status})`);
  const data = await response.json() as { token: string; expires_at: string };
  cachedTokens.set(cacheKey, { value: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return data.token;
}

async function githubGet<T>(path: string, tenantId: string, owner: string): Promise<T | null> {
  const token = await installationToken(tenantId, owner);
  if (!token && process.env.GITHUB_ALLOW_PUBLIC_READ !== 'true') return null;
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TrackAI',
    },
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function listPullRequestCommits(
  tenantId: string,
  owner: string,
  repository: string,
  number: number,
) {
  const commits: GitHubCommit[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = await githubGet<GitHubCommit[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/commits?per_page=100&page=${page}`,
      tenantId,
      owner,
    );
    if (batch === null) return null;
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return commits;
}

export async function getRepositoryCommit(
  tenantId: string,
  owner: string,
  repository: string,
  sha: string,
) {
  return githubGet<GitHubCommit>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}`,
    tenantId,
    owner,
  );
}

export async function getRepositoryCommitFirstParentChain(
  tenantId: string,
  owner: string,
  repository: string,
  sha: string,
  limit: number,
) {
  const commits: GitHubCommit[] = [];
  let currentSha: string | null = sha;
  while (currentSha && commits.length < limit) {
    const commit = await getRepositoryCommit(tenantId, owner, repository, currentSha);
    if (!commit) break;
    commits.push(commit);
    currentSha = commit.parents?.[0]?.sha ?? null;
  }
  return commits;
}
