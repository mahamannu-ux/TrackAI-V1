import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCodeLifecycleEvents,
  scmCommits,
  scmDeployments,
  scmMergeLineage,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequestSnapshots,
} from '../../core/db/schema';
import type { GitHubCommit } from './github-app';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function recordPullRequestSnapshot(input: {
  tenantId: string;
  repositoryId: string;
  pullRequestId: string;
  headSha: string | null;
  commits: GitHubCommit[];
  capturedAt?: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const capturedAt = input.capturedAt ?? new Date();
  const commitShas = input.commits.map((commit) => commit.sha);
  const snapshotKey = hash({ headSha: input.headSha, commitShas });
  const [snapshot] = await tenantDb.insertDoNothing(
    scmPullRequestSnapshots,
    {
      pullRequestId: input.pullRequestId,
      headSha: input.headSha,
      snapshotKey,
      commitShas,
      source: 'github_pr_commits_api',
      capturedAt,
    },
    [
      scmPullRequestSnapshots.tenantId,
      scmPullRequestSnapshots.pullRequestId,
      scmPullRequestSnapshots.snapshotKey,
    ],
  );
  if (!snapshot) return { created: false, commitCount: commitShas.length };

  const normalized = [];
  for (const item of input.commits) {
    const [subject, ...bodyLines] = item.commit.message.split('\n');
    const authoredAt = item.commit.author?.date ? new Date(item.commit.author.date) : capturedAt;
    const committedAt = item.commit.committer?.date ? new Date(item.commit.committer.date) : authoredAt;
    const [commit] = await tenantDb.upsert(
      scmCommits,
      {
        repositoryId: input.repositoryId,
        sha: item.sha,
        authorName: item.commit.author?.name ?? item.author?.login ?? null,
        authorEmail: item.commit.author?.email ?? null,
        subject: subject || `Commit ${item.sha.slice(0, 12)}`,
        body: bodyLines.join('\n').trim() || null,
        authoredAt,
        committedAt,
        reachability: 'pull_request',
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
      },
      [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha],
      { reachability: 'pull_request', lastSeenAt: capturedAt, updatedAt: capturedAt },
    );
    if (commit) normalized.push(commit);
  }

  const existing = await tenantDb.select(
    scmPullRequestCommitMemberships,
    eq(scmPullRequestCommitMemberships.pullRequestId, input.pullRequestId),
  );
  const currentIds = new Set(normalized.map((commit) => commit.id));
  for (const membership of existing) {
    if (membership.active && !currentIds.has(membership.commitId)) {
      await tenantDb.update(
        scmPullRequestCommitMemberships,
        { active: false, removedAt: capturedAt, lastSeenSnapshotId: snapshot.id, lastSeenAt: capturedAt },
        eq(scmPullRequestCommitMemberships.id, membership.id),
      );
    }
  }
  for (const commit of normalized) {
    await tenantDb.upsert(
      scmPullRequestCommitMemberships,
      {
        pullRequestId: input.pullRequestId,
        commitId: commit.id,
        firstSeenSnapshotId: snapshot.id,
        lastSeenSnapshotId: snapshot.id,
        active: true,
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
        removedAt: null,
      },
      [
        scmPullRequestCommitMemberships.tenantId,
        scmPullRequestCommitMemberships.pullRequestId,
        scmPullRequestCommitMemberships.commitId,
      ],
      { lastSeenSnapshotId: snapshot.id, active: true, lastSeenAt: capturedAt, removedAt: null },
    );
    await tenantDb.upsert(
      scmPullRequestCommits,
      {
        pullRequestId: input.pullRequestId,
        commitId: commit.id,
        matchMethod: 'github_pr_commits_api',
        confidence: 100,
      },
      [scmPullRequestCommits.tenantId, scmPullRequestCommits.pullRequestId, scmPullRequestCommits.commitId],
      { matchMethod: 'github_pr_commits_api', confidence: 100 },
    );
  }
  return { created: true, commitCount: normalized.length };
}

export async function recordMergeLineage(input: {
  tenantId: string;
  repositoryId: string;
  pullRequestId: string;
  resultSha: string;
  mergedAt: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const memberships = await tenantDb.select(
    scmPullRequestCommitMemberships,
    eq(scmPullRequestCommitMemberships.pullRequestId, input.pullRequestId),
  );
  const [resultCommit] = await tenantDb.select(
    scmCommits,
    and(eq(scmCommits.repositoryId, input.repositoryId), eq(scmCommits.sha, input.resultSha)),
  );
  for (const membership of memberships.filter((row) => row.active)) {
    const [source] = await tenantDb.select(scmCommits, eq(scmCommits.id, membership.commitId));
    if (!source) continue;
    const mergeMethod = memberships.filter((row) => row.active).length > 1
      && input.resultSha !== source.sha ? 'squash_or_merge' : 'fast_forward_or_rebase';
    await tenantDb.insertDoNothing(
      scmMergeLineage,
      {
        pullRequestId: input.pullRequestId,
        sourceCommitId: source.id,
        resultCommitId: resultCommit?.id ?? null,
        resultSha: input.resultSha,
        mergeMethod,
        confidence: 70,
      },
      [scmMergeLineage.tenantId, scmMergeLineage.pullRequestId, scmMergeLineage.sourceCommitId, scmMergeLineage.resultSha],
    );
    if (source.observedAiLines > 0) {
      for (const stage of ['merged', 'merged_proxy'] as const) {
        await tenantDb.insertDoNothing(
          aiCodeLifecycleEvents,
          {
            repositoryId: input.repositoryId,
            commitId: source.id,
            pullRequestId: input.pullRequestId,
            stage,
            lineCount: source.observedAiLines,
            evidenceType: stage === 'merged' ? 'github_pr_merge' : 'default_branch_proxy',
            evidenceRef: `${stage}:${input.pullRequestId}:${source.id}:${input.resultSha}`,
            occurredAt: input.mergedAt,
          },
          [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
        );
      }
    }
  }
}

export async function recordDeployment(input: {
  tenantId: string;
  repositoryId: string;
  provider: string;
  externalId: string;
  environment: string;
  ref: string | null;
  sha: string;
  status: string;
  production: boolean;
  deployedAt: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  await tenantDb.insertDoNothing(
    scmDeployments,
    input,
    [scmDeployments.tenantId, scmDeployments.provider, scmDeployments.externalId, scmDeployments.status],
  );
  if (!input.production || input.status !== 'success') return;
  const [commit] = await tenantDb.select(
    scmCommits,
    and(eq(scmCommits.repositoryId, input.repositoryId), eq(scmCommits.sha, input.sha)),
  );
  let sourceCommits = commit?.observedAiLines ? [commit] : [];
  if (sourceCommits.length === 0) {
    const lineage = await tenantDb.select(scmMergeLineage, eq(scmMergeLineage.resultSha, input.sha));
    const sourceIds = lineage.map((row) => row.sourceCommitId)
      .filter((id, index, all) => all.indexOf(id) === index);
    sourceCommits = (await Promise.all(sourceIds.map(async (id) =>
      (await tenantDb.select(scmCommits, eq(scmCommits.id, id)))[0])))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }
  for (const source of sourceCommits.filter(Boolean)) {
    if (source.observedAiLines <= 0) continue;
    await tenantDb.insertDoNothing(
      aiCodeLifecycleEvents,
      {
        repositoryId: input.repositoryId,
        commitId: source.id,
        stage: 'production',
        lineCount: source.observedAiLines,
        evidenceType: 'github_deployment_status',
        evidenceRef: `deployment:${input.externalId}:${input.status}:${source.id}`,
        occurredAt: input.deployedAt,
      },
      [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
    );
  }
}
