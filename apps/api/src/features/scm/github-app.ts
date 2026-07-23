import { createSign } from 'crypto';

export type GitHubCommit = {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { id?: number; login?: string } | null;
};

type CachedToken = { value: string; expiresAt: number };
const cachedTokens = new Map<string, CachedToken>();

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(): string | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !privateKey) return null;
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

async function installationToken(owner: string): Promise<string | null> {
  const explicit = process.env.GITHUB_APP_INSTALLATION_TOKEN;
  if (explicit) return explicit;
  const installationId = installationIdFor(owner);
  const cachedToken = installationId ? cachedTokens.get(installationId) : null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const jwt = appJwt();
  if (!installationId || !jwt) return null;
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TrackAI',
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status})`);
  const data = await response.json() as { token: string; expires_at: string };
  cachedTokens.set(installationId, { value: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return data.token;
}

async function githubGet<T>(path: string, owner: string): Promise<T | null> {
  const token = await installationToken(owner);
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

export function githubReadConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_INSTALLATION_TOKEN
    || (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
      && (process.env.GITHUB_APP_INSTALLATION_ID || process.env.GITHUB_APP_INSTALLATIONS_JSON))
    || process.env.GITHUB_ALLOW_PUBLIC_READ === 'true',
  );
}

export async function listPullRequestCommits(owner: string, repository: string, number: number) {
  const commits: GitHubCommit[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = await githubGet<GitHubCommit[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${number}/commits?per_page=100&page=${page}`,
      owner,
    );
    if (batch === null) return null;
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return commits;
}
