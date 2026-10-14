/**
 * Task15m (A15.14): the informational "TrackAI Attesta" GitHub check run.
 *
 * TrackAI's server posts one check run per pull request through the GitHub App
 * the customer already installed. Phase 1 is informational: the conclusion is
 * always `neutral` (no policy decides pass or fail yet; that is Task6.b), so a
 * check never blocks a merge, and its text says how many of the PR's commits
 * are attested and anchored.
 *
 * The GitHub calls follow `../scm/github-app.ts` conventions (`githubWrite`
 * and `githubGetStatus` there); the anchor states reuse `anchorStatusOf` from
 * the evidence API. Only shas, kinds, times and anchor rows are read — never
 * titles, bodies, author names, emails, file paths, notes or statement
 * contents — and only short shas and counts leave the tenant in a check body.
 * Production scheduling (every 5 minutes, after the build and anchor passes)
 * is Task14's.
 */
import { normalizeRepositoryUrl } from '../telemetry/repository-url';
import { githubGetStatus, githubWrite } from '../scm/github-app';
import { ANCHOR_WINDOW_MS, anchorStatusOf } from './read-service';

/** The database surface the pass needs (`pool` satisfies this). */
export interface CheckDb {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CheckDeps {
  write: typeof githubWrite;
  getStatus: typeof githubGetStatus;
  env: NodeJS.ProcessEnv;
}

export const CHECK_NAME = 'TrackAI Attesta';
const MERGED_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_TABLE_ROWS = 50;
const MAX_TITLE = 255;
const MAX_BODY = 60_000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const toIso = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return typeof v === 'string' && v.length > 0 ? v : null;
};

// ---------------------------------------------------------------------------
// Which PRs, per pass

export interface PullRequestRow {
  id: string;
  repositoryId: string;
  headSha: string | null;
  mergeCommitSha: string | null;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
  repoUrl: string;
  repoProvider: string;
}

/**
 * Open PRs with a `head_sha`, plus PRs merged within the last 7 days with a
 * `merge_commit_sha`, for repositories with `provider = 'github'`; newest
 * `updated_at` first, at most `limit` per tenant. The tenant is bound
 * explicitly in every query this module issues.
 */
export async function selectPullRequests(
  executor: CheckDb, tenantId: string, now: Date, limit = 200,
): Promise<PullRequestRow[]> {
  const weekAgo = new Date(now.getTime() - MERGED_WINDOW_MS).toISOString();
  const result = await executor.query(
    `/* github-check prs */
     select pr.id::text as id, pr.repository_id::text as repository_id,
            pr.head_sha as head_sha, pr.merge_commit_sha as merge_commit_sha,
            pr.state as state, pr.merged_at as merged_at, pr.updated_at as updated_at,
            r.url as repo_url, r.provider as repo_provider
     from scm_pull_requests pr
     join scm_repositories r on r.tenant_id = pr.tenant_id and r.id = pr.repository_id
     where pr.tenant_id = $1 and r.provider = 'github'
       and ((pr.state = 'open' and pr.head_sha is not null)
         or (pr.merged_at is not null and pr.merged_at >= $2::timestamptz
             and pr.merge_commit_sha is not null))
     order by pr.updated_at desc
     limit $3`,
    [tenantId, weekAgo, limit],
  );
  return result.rows.map((r) => ({
    id: str(r.id),
    repositoryId: str(r.repository_id),
    headSha: strOrNull(r.head_sha),
    mergeCommitSha: strOrNull(r.merge_commit_sha),
    state: str(r.state),
    mergedAt: toIso(r.merged_at),
    updatedAt: toIso(r.updated_at) ?? new Date(0).toISOString(),
    repoUrl: str(r.repo_url),
    repoProvider: str(r.repo_provider),
  }));
}

// ---------------------------------------------------------------------------
// What is counted

export type CommitState = 'anchored' | 'pending' | 'missing';

export interface CommitFact {
  sha: string;
  /** False when there is no `commit_observed` record for the sha. */
  hasRecord: boolean;
  status: CommitState;
}

export interface MergeFact {
  hasRecord: boolean;
  status: CommitState;
}

export interface AttestationFacts {
  kind: 'open' | 'merged';
  prId: string;
  repositoryId: string;
  /** The sha the check is posted on: `head_sha`, or `merge_commit_sha`. */
  sha: string;
  /** Member commits, sha ascending (stable). */
  commits: CommitFact[];
  /** The `pr_merged` record for a merged PR; null for an open PR. */
  merge: MergeFact | null;
  attested: number;
  anchored: number;
  pending: number;
  overdue: number;
  unattested: number;
}

interface RecordHit {
  recordedAt: string;
  rekor: boolean;
  tsa: boolean;
}

async function recordsBySha(
  executor: CheckDb, tenantId: string, repositoryId: string, kind: string, shas: string[],
): Promise<Map<string, RecordHit>> {
  const out = new Map<string, RecordHit>();
  if (shas.length === 0) return out;
  const result = await executor.query(
    `/* github-check records */
     select r.subject_sha as subject_sha,
            to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
            exists (select 1 from attesta_anchors a where a.tenant_id = r.tenant_id and a.record_id = r.id
                    and a.anchor_type = 'rekor' and a.status = 'anchored') as rekor_anchored,
            exists (select 1 from attesta_anchors t where t.tenant_id = r.tenant_id and t.record_id = r.id
                    and t.anchor_type = 'tsa' and t.status = 'anchored') as tsa_anchored
     from attesta_records r
     where r.tenant_id = $1 and r.repository_id = $2 and r.statement_kind = $3
       and r.subject_sha = any($4::text[])`,
    [tenantId, repositoryId, kind, shas],
  );
  for (const row of result.rows) {
    out.set(str(row.subject_sha), {
      recordedAt: str(row.recorded_at),
      rekor: row.rekor_anchored === true,
      tsa: row.tsa_anchored === true,
    });
  }
  return out;
}

function factFor(sha: string, hit: RecordHit | undefined, now: Date): CommitFact {
  if (!hit) return { sha, hasRecord: false, status: 'missing' };
  return {
    sha,
    hasRecord: true,
    status: anchorStatusOf({ rekor: hit.rekor, tsa: hit.tsa }, hit.recordedAt, now, ANCHOR_WINDOW_MS),
  };
}

export async function attestationFacts(
  executor: CheckDb, tenantId: string, pr: PullRequestRow, sha: string, now: Date,
): Promise<AttestationFacts> {
  const members = await executor.query(
    `/* github-check members */
     select c.sha as sha
     from scm_pull_request_commit_memberships m
     join scm_commits c on c.tenant_id = m.tenant_id and c.id = m.commit_id
     where m.tenant_id = $1 and m.pull_request_id = $2 and m.active = true`,
    [tenantId, pr.id],
  );
  const shas = members.rows.map((r) => str(r.sha)).filter((s) => s.length > 0);
  const hits = await recordsBySha(executor, tenantId, pr.repositoryId, 'commit_observed', shas);
  const commits = shas.map((s) => factFor(s, hits.get(s), now)).sort((a, b) => (a.sha < b.sha ? -1 : 1));
  const kind = pr.state === 'open' ? 'open' : 'merged';
  let merge: MergeFact | null = null;
  if (kind === 'merged') {
    const mergeHits = await recordsBySha(executor, tenantId, pr.repositoryId, 'pr_merged', [sha]);
    const hit = mergeHits.get(sha);
    merge = hit
      ? {
        hasRecord: true,
        status: anchorStatusOf({ rekor: hit.rekor, tsa: hit.tsa }, hit.recordedAt, now, ANCHOR_WINDOW_MS),
      }
      : { hasRecord: false, status: 'missing' };
  }
  let attested = 0;
  let anchored = 0;
  let pending = 0;
  let overdue = 0;
  let unattested = 0;
  for (const c of commits) {
    if (!c.hasRecord) {
      unattested += 1;
      continue;
    }
    attested += 1;
    if (c.status === 'anchored') anchored += 1;
    else if (c.status === 'pending') pending += 1;
    else overdue += 1;
  }
  return {
    kind, prId: pr.id, repositoryId: pr.repositoryId, sha, commits, merge,
    attested, anchored, pending, overdue, unattested,
  };
}

// ---------------------------------------------------------------------------
// The check run

export interface CheckRunPayload {
  name: typeof CHECK_NAME;
  head_sha: string;
  external_id: string;
  status: 'completed';
  conclusion: 'neutral';
  completed_at: string;
  details_url?: string;
  output: { title: string; summary: string; text: string };
}

const SUMMARY_HEAD =
  'Informational: TrackAI records which commits it has signed and anchored. This check never blocks a merge.';

function stateLabel(c: CommitFact): string {
  if (c.status === 'anchored') return 'Signed · anchored';
  if (c.status === 'pending') return 'Signed · anchoring pending';
  if (c.hasRecord) return 'Signed · anchor overdue';
  return 'Not attested yet';
}

/** Pure: facts in, the exact GitHub check-run body out. */
export function checkRunPayload(facts: AttestationFacts, env: NodeJS.ProcessEnv, now: Date): CheckRunPayload {
  const total = facts.commits.length;
  let title: string;
  if (facts.kind === 'merged') {
    if (!facts.merge?.hasRecord) title = 'Merge not attested yet';
    else if (facts.merge.status === 'anchored') title = 'Merge attested · anchored';
    else if (facts.merge.status === 'pending') title = 'Merge attested · anchoring pending';
    else title = 'Merge attested · anchor overdue';
  } else if (total === 0) {
    title = 'No commits observed yet';
  } else {
    title = `${facts.attested} of ${total} commits attested · ${facts.anchored} anchored`;
  }
  const summary = `${SUMMARY_HEAD}\n\nAttested: ${facts.attested} · Anchored: ${facts.anchored} · `
    + `Anchoring pending: ${facts.pending} · Anchor overdue: ${facts.overdue} · Not attested yet: ${facts.unattested}`;
  const lines = ['| Commit | State |', '| --- | --- |'];
  for (const c of facts.commits.slice(0, MAX_TABLE_ROWS)) {
    lines.push(`| ${c.sha.slice(0, 7)} | ${stateLabel(c)} |`);
  }
  if (total > MAX_TABLE_ROWS) lines.push(`… and ${total - MAX_TABLE_ROWS} more`);
  const payload: CheckRunPayload = {
    name: CHECK_NAME,
    head_sha: facts.sha,
    external_id: `trackai-attesta:${facts.prId}`,
    status: 'completed',
    conclusion: 'neutral',
    completed_at: now.toISOString(),
    output: {
      title: title.slice(0, MAX_TITLE),
      summary: summary.slice(0, MAX_BODY),
      text: lines.join('\n').slice(0, MAX_BODY),
    },
  };
  const consoleUrl = env.TRACKAI_CONSOLE_URL?.trim();
  if (consoleUrl) payload.details_url = `${consoleUrl.replace(/\/+$/, '')}/dashboard`;
  return payload;
}

// ---------------------------------------------------------------------------
// Idempotent post

export type PostResult =
  | 'created' | 'updated' | 'unchanged'
  | 'skipped_no_installation' | 'permission_missing' | 'not_found' | 'failed';

interface ListedRun {
  id: number;
  external_id?: string | null;
  output?: { title?: string; summary?: string } | null;
}

function mapWriteStatus(status: number, existed: boolean): PostResult {
  if (status === 0) return 'skipped_no_installation';
  if (status === 403) return 'permission_missing';
  if (status === 404) return 'not_found';
  if (status >= 200 && status < 300) return existed ? 'updated' : 'created';
  return 'failed';
}

/**
 * Creates the check run, patches it when the same `external_id` exists with
 * different wording, and does nothing when the wording matches. A 403 or 404
 * never throws and never retries in the same pass; a run from another app (a
 * different `external_id`) is ignored. Never throws: infrastructure failures
 * are `failed` so the pass continues to the next PR.
 */
export async function postCheck(
  deps: CheckDeps, tenantId: string, owner: string, repo: string, payload: CheckRunPayload,
): Promise<PostResult> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`;
  const listPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + `/commits/${encodeURIComponent(payload.head_sha)}/check-runs`
    + `?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`;
  let listed: { status: number; data: { check_runs: ListedRun[] } | null };
  try {
    listed = await deps.getStatus<{ check_runs: ListedRun[] }>(listPath, tenantId, owner);
  } catch {
    return 'failed';
  }
  if (listed.status === 0) return 'skipped_no_installation';
  if (listed.status === 403) return 'permission_missing';
  if (listed.status === 404) return 'not_found';
  if (listed.status !== 200 || !listed.data) return 'failed';
  const existing = (listed.data.check_runs ?? []).find((r) => r.external_id === payload.external_id);
  if (existing
    && existing.output?.title === payload.output.title
    && existing.output?.summary === payload.output.summary) {
    return 'unchanged';
  }
  try {
    if (existing) {
      const { head_sha: _head, ...update } = payload;
      const res = await deps.write('PATCH', `${base}/${existing.id}`, update, tenantId, owner);
      return mapWriteStatus(res.status, true);
    }
    const res = await deps.write('POST', base, payload, tenantId, owner);
    return mapWriteStatus(res.status, false);
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// The pass

export interface CheckPassOptions {
  tenantId?: string;
  now?: Date;
  limit?: number;
}

export interface CheckPassCounts {
  tenants: number;
  prs: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped_no_installation: number;
  permission_missing: number;
  not_found: number;
  failed: number;
  skipped_url: number;
}

const ZERO_COUNTS = {
  prs: 0, created: 0, updated: 0, unchanged: 0, skipped_no_installation: 0,
  permission_missing: 0, not_found: 0, failed: 0, skipped_url: 0,
};

function splitRepo(repoUrl: string): { owner: string; repo: string } | null {
  let normalized: string;
  try {
    normalized = normalizeRepositoryUrl(repoUrl);
  } catch {
    return null;
  }
  const parts = normalized.split('/');
  if (parts.length !== 3 || parts[0] !== 'github.com' || !parts[1] || !parts[2]) return null;
  return { owner: parts[1], repo: parts[2] };
}

export async function runGithubCheckPass(
  executor: CheckDb, deps: CheckDeps, options: CheckPassOptions = {},
): Promise<CheckPassCounts> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 200;
  const tenantIds = options.tenantId
    ? [options.tenantId]
    : (await executor.query(
      '/* github-check tenants */ select distinct tenant_id::text as tenant_id from scm_repositories',
      [],
    )).rows.map((r) => str(r.tenant_id)).filter((t) => t.length > 0);
  const counts: CheckPassCounts = { tenants: tenantIds.length, ...ZERO_COUNTS };
  for (const tenantId of tenantIds) {
    let prs: PullRequestRow[];
    try {
      prs = await selectPullRequests(executor, tenantId, now, limit);
    } catch {
      // This tenant's PRs are unknown; the next tenant still gets its pass.
      continue;
    }
    for (const pr of prs) {
      counts.prs += 1;
      try {
        const split = splitRepo(pr.repoUrl);
        const sha = pr.state === 'open' ? pr.headSha : pr.mergeCommitSha;
        if (!split || !sha) {
          counts.skipped_url += 1;
          continue;
        }
        const facts = await attestationFacts(executor, tenantId, pr, sha, now);
        const payload = checkRunPayload(facts, deps.env, now);
        counts[await postCheck(deps, tenantId, split.owner, split.repo, payload)] += 1;
      } catch {
        // One PR never stops the rest of the pass.
        counts.failed += 1;
      }
    }
  }
  console.log(`attesta_github_check tenants=${counts.tenants} prs=${counts.prs} created=${counts.created} `
    + `updated=${counts.updated} unchanged=${counts.unchanged} `
    + `skipped_no_installation=${counts.skipped_no_installation} permission_missing=${counts.permission_missing} `
    + `not_found=${counts.not_found} failed=${counts.failed} skipped_url=${counts.skipped_url}`);
  return counts;
}
