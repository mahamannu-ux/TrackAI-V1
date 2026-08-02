export interface RepositoryGrantState {
  tenantId: string;
  machineId: string;
  repositoryId: string;
  status: string;
  branchPatterns: readonly string[];
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

export interface RepositoryGrantRequest {
  tenantId: string;
  machineId: string;
  repositoryId: string;
  branch: string | null;
  now?: Date;
}

function normalizedBranch(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

export function branchPatternIsValid(pattern: string): boolean {
  if (!pattern || pattern.startsWith('/') || pattern.includes('..') || pattern.includes('refs/heads/')) {
    return false;
  }
  const firstWildcard = pattern.indexOf('*');
  return firstWildcard === -1 || (pattern.endsWith('/*') && firstWildcard === pattern.length - 1);
}

export function normalizeRepositoryBranchPatterns(patterns: readonly string[]): string[] {
  const normalized = [...new Set(patterns.map(pattern => pattern.trim()))];
  if (normalized.some(pattern => !branchPatternIsValid(pattern))) {
    throw new Error('Branch patterns must be exact names or a prefix ending in /*');
  }
  return normalized;
}

function branchMatches(patterns: readonly string[], branch: string | null): boolean {
  if (patterns.length === 0) return true;
  if (!branch || patterns.some((pattern) => !branchPatternIsValid(pattern))) return false;
  const normalized = normalizedBranch(branch);
  return patterns.some((pattern) => pattern.endsWith('/*')
    ? normalized.startsWith(pattern.slice(0, -1))
    : normalized === pattern);
}

export function repositoryGrantAllows(
  grant: RepositoryGrantState,
  request: RepositoryGrantRequest,
): boolean {
  const now = request.now ?? new Date();
  return grant.status === 'active'
    && grant.tenantId === request.tenantId
    && grant.machineId === request.machineId
    && grant.repositoryId === request.repositoryId
    && grant.effectiveFrom.getTime() <= now.getTime()
    && (grant.effectiveUntil === null || grant.effectiveUntil.getTime() > now.getTime())
    && branchMatches(grant.branchPatterns, request.branch);
}
