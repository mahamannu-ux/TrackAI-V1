/**
 * Drill-down listing (Task19b, T19.3; docs/contracts/qa/api.md).
 *
 * Pure functions over a loaded Task2 context: the item listing every live
 * answerer's envelope previews (the first 20 of the first page, the same
 * items) and the route pages. Cursor = the last id, base64url. An invalid
 * cursor decodes to null and the route answers 400 QA_SCOPE_INVALID.
 */
import type { QaContext } from './answers/common';
import type { QaAnswerContext, QaDrilldown } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** The decoded id, or null when the cursor is invalid. */
export function decodeCursor(cursor: string): string | null {
  let id: string;
  try {
    id = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  return UUID_RE.test(id) ? id : null;
}

/** Metadata-only label: a repository name, never a path, prompt or command. */
export function safeLabel(value: string): string {
  const cleaned = value.replace(/[/\\@\n\r\t]/g, '-').trim();
  return cleaned.slice(0, 120) || 'repository';
}

/**
 * The PR's commit ids, selected exactly as pullRequestIntelligence selects
 * them (active memberships when any exist, otherwise the legacy PR links).
 */
export function pullRequestCommitIds(context: QaContext, pullRequestId: string): Set<string> {
  const memberships = context.memberships.filter((row) => row.pullRequestId === pullRequestId);
  const active = memberships.filter((row) => row.active);
  const links = (memberships.length > 0 ? active : context.pullRequestCommits
    .filter((row) => row.pullRequestId === pullRequestId)).map((row) => row.commitId);
  return new Set(links);
}

/** Repositories in the request's scope, by id ascending. */
export function repositoryIdsInScope(context: QaContext, ctx: QaAnswerContext): string[] {
  if (ctx.scope.repository_id) return [ctx.scope.repository_id];
  if (ctx.scope.pull_request_id) {
    const pr = context.pullRequests.find((row) => row.id === ctx.scope.pull_request_id);
    return pr ? [pr.repositoryId] : [];
  }
  if (ctx.scope.commit_sha && ctx.scope.repository_id) return [ctx.scope.repository_id];
  return context.repositories.map((row) => row.id).sort();
}

/**
 * Retained commits in the request's scope and period (§2.1 rule 4: always
 * through contributesToCurrentCommittedState). Period by committedAt; rows
 * without a committedAt never fall inside a period.
 */
export function commitsInScope(context: QaContext, ctx: QaAnswerContext): QaContext['commits'] {
  const fromMs = Date.parse(ctx.scope.from);
  const toMs = Date.parse(ctx.scope.to);
  const prCommitIds = ctx.scope.pull_request_id
    ? pullRequestCommitIds(context, ctx.scope.pull_request_id)
    : null;
  let commitId: string | null = null;
  if (ctx.scope.commit_sha && ctx.scope.repository_id) {
    commitId = context.commits.find((row) =>
      row.repositoryId === ctx.scope.repository_id && row.sha === ctx.scope.commit_sha)?.id ?? null;
  }
  return context.commits.filter((row) => {
    if (row.reachability === 'superseded' || row.reachability === 'unreachable') return false;
    if (ctx.scope.repository_id && row.repositoryId !== ctx.scope.repository_id) return false;
    if (prCommitIds && !prCommitIds.has(row.id)) return false;
    if (commitId && row.id !== commitId) return false;
    if (!row.committedAt) return false;
    const ms = row.committedAt.getTime();
    return ms >= fromMs && ms <= toMs;
  });
}

/** The commit the request names at commit scope, or null. */
export function commitInScope(context: QaContext, ctx: QaAnswerContext): QaContext['commits'][number] | null {
  if (!ctx.scope.commit_sha || !ctx.scope.repository_id) return null;
  return context.commits.find((row) =>
    row.repositoryId === ctx.scope.repository_id && row.sha === ctx.scope.commit_sha) ?? null;
}

/**
 * Every drill-down item for the request's scope (§2.3), by id ascending:
 * tenant → repositories with a commit in the period; repository → pull
 * requests merged or updated in the period; pull_request → the PR's commits;
 * commit → none. Labels are metadata only: repository names, `#<number>` or
 * `PR`, the first 12 hex characters of a SHA.
 */
export function listDrilldownItems(context: QaContext, ctx: QaAnswerContext): QaDrilldown[] {
  const fromMs = Date.parse(ctx.scope.from);
  const toMs = Date.parse(ctx.scope.to);
  const inPeriod = (value: Date | null) => {
    if (!value) return false;
    const ms = value.getTime();
    return ms >= fromMs && ms <= toMs;
  };
  if (ctx.scopeLevel === 'commit') return [];
  if (ctx.scopeLevel === 'pull_request' && ctx.scope.pull_request_id) {
    const ids = pullRequestCommitIds(context, ctx.scope.pull_request_id);
    return context.commits
      .filter((row) => ids.has(row.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row) => ({ scope: 'commit' as const, id: row.id, label: row.sha.slice(0, 12) }));
  }
  if (ctx.scopeLevel === 'repository' || ctx.scope.pull_request_id) {
    const repositoryId = ctx.scope.repository_id
      ?? context.pullRequests.find((row) => row.id === ctx.scope.pull_request_id)?.repositoryId;
    return context.pullRequests
      .filter((row) => row.repositoryId === repositoryId
        && (inPeriod(row.mergedAt) || inPeriod(row.updatedAt)))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row) => ({
        scope: 'pull_request' as const,
        id: row.id,
        label: row.number === null || row.number === undefined ? 'PR' : `#${row.number}`,
      }));
  }
  const withCommit = new Set(context.commits
    .filter((row) => inPeriod(row.committedAt))
    .map((row) => row.repositoryId));
  return context.repositories
    .filter((row) => withCommit.has(row.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((row) => ({ scope: 'repository' as const, id: row.id, label: safeLabel(row.name) }));
}

/** One page of the listing after an optional cursor, with the next cursor. */
export function pageDrilldownItems(
  items: QaDrilldown[],
  limit: number,
  cursor: string | null,
): { items: QaDrilldown[]; nextCursor: string | null } {
  const start = cursor === null ? 0 : items.findIndex((item) => item.id === cursor) + 1;
  const page = items.slice(start, start + limit);
  const rest = items.length - start - page.length;
  return {
    items: page,
    nextCursor: rest > 0 && page.length > 0 ? encodeCursor(page[page.length - 1].id) : null,
  };
}
