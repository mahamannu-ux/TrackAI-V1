import { loadGitHubAppRuntimeCredentials } from '../../core/security/github-app-security-service';
import { appJwt } from './github-app';

export type BlameResult =
  | { status: 'ok'; originSha: string | null }
  | { status: 'missing_installation' | 'provider_unavailable' };

type BlameInput = {
  tenantId: string;
  repositoryId: string;
  repositoryUrl: string;
  commitSha: string;
  fileId: string;
  path: string;
  line: number;
};

const cache = new Map<string, { expiresAt: number; ranges: Array<{ start: number; end: number; sha: string }> }>();
const tokens = new Map<string, { expiresAt: number; value: string }>();
const TTL_MS = 10 * 60_000;

function githubRepository(url: string): { owner: string; name: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
    const segments = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    return segments.length === 2 ? { owner: segments[0], name: segments[1] } : null;
  } catch { return null; }
}

async function tokenFor(tenantId: string, owner: string, signal: AbortSignal): Promise<string | null> {
  const credentials = await loadGitHubAppRuntimeCredentials(tenantId, owner);
  const credential = credentials.find((item) => item.status === 'active');
  if (!credential) return null;
  const key = `${tenantId}:${credential.installationId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const response = await fetch(`https://api.github.com/app/installations/${credential.installationExternalId}/access_tokens`, {
    method: 'POST', signal,
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${appJwt(credential.appId, credential.privateKey)}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TrackAI',
    },
  });
  if (!response.ok) return null;
  const data = await response.json() as { token?: string; expires_at?: string };
  if (!data.token || !data.expires_at) return null;
  tokens.set(key, { value: data.token, expiresAt: Date.parse(data.expires_at) });
  return data.token;
}

/** One GraphQL blame call per uncached request. Path and response body are never logged. */
export async function githubBlame(input: BlameInput): Promise<BlameResult> {
  const repository = githubRepository(input.repositoryUrl);
  if (!repository) return { status: 'provider_unavailable' };
  const key = JSON.stringify([input.tenantId, input.repositoryId, input.commitSha, input.fileId]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: 'ok', originSha: cached.ranges.find((range) =>
      range.start <= input.line && range.end >= input.line)?.sha ?? null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const token = await tokenFor(input.tenantId, repository.owner, controller.signal);
    if (!token) return { status: 'missing_installation' };
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST', signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`, 'User-Agent': 'TrackAI',
      },
      body: JSON.stringify({
        query: 'query($owner:String!,$name:String!,$oid:GitObjectID!,$path:String!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{blame(path:$path){ranges{startingLine endingLine commit{oid}}}}}}}',
        variables: { owner: repository.owner, name: repository.name, oid: input.commitSha, path: input.path },
      }),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404)
      return { status: 'missing_installation' };
    if (!response.ok) throw new Error('GitHub blame request failed');
    const data = await response.json() as {
      errors?: unknown[];
      data?: { repository?: { object?: { blame?: { ranges?: Array<{
        startingLine?: number; endingLine?: number; commit?: { oid?: string };
      }> } } } };
    };
    if (data.errors?.length) return { status: 'provider_unavailable' };
    const raw = data.data?.repository?.object?.blame?.ranges;
    if (!Array.isArray(raw)) return { status: 'provider_unavailable' };
    const ranges = raw.flatMap((range) => Number.isInteger(range.startingLine)
      && Number.isInteger(range.endingLine)
      && range.startingLine! > 0 && range.endingLine! >= range.startingLine!
      && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(range.commit?.oid ?? '')
      ? [{ start: range.startingLine!, end: range.endingLine!, sha: range.commit!.oid! }] : []);
    cache.set(key, { expiresAt: Date.now() + TTL_MS, ranges });
    return { status: 'ok', originSha: ranges.find((range) =>
      range.start <= input.line && range.end >= input.line)?.sha ?? null };
  } finally {
    clearTimeout(timer);
  }
}
