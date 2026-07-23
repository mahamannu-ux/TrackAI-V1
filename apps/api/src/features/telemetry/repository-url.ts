import { createHash } from 'crypto';

export function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  let host: string;
  let path: string;

  if (scpMatch && !trimmed.includes('://')) {
    host = scpMatch[1];
    path = scpMatch[2];
  } else {
    const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const normalizedPath = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!host || !normalizedPath || !normalizedPath.includes('/')) {
    throw new Error('Repository URL must include a host, owner and repository');
  }
  return `${host.toLowerCase()}/${normalizedPath}`;
}

export function repositoryIdentity(value: string) {
  const normalizedUrl = normalizeRepositoryUrl(value);
  const [host, ...pathParts] = normalizedUrl.split('/');
  const name = pathParts[pathParts.length - 1];
  const provider = host === 'github.com' ? 'github'
    : host === 'gitlab.com' ? 'gitlab'
      : host === 'bitbucket.org' ? 'bitbucket' : 'git';
  return {
    normalizedUrl,
    canonicalUrl: `https://${normalizedUrl}`,
    provider,
    name,
    externalId: `telemetry:${createHash('sha256').update(normalizedUrl).digest('hex')}`,
  };
}
