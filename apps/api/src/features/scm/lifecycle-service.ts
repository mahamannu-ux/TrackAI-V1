import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitModelAttributions,
  aiCodeLifecycleEvents,
  aiModelLifecycleEvents,
  scmCommits,
  scmDeployments,
  scmMergeLineage,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequestSnapshots,
} from '../../core/db/schema';
import { currentRetainedAiLinesForCommit } from '../telemetry/lifecycle';
import type { GitHubCommit } from './github-app';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function githubCommitMetadata(item: GitHubCommit, observedAt = new Date()) {
  const [subject, ...bodyLines] = item.commit.message.split('\n');
  const authoredAt = item.commit.author?.date ? new Date(item.commit.author.date) : observedAt;
  const committedAt = item.commit.committer?.date ? new Date(item.commit.committer.date) : authoredAt;
  return {
    authorName: item.commit.author?.name ?? item.author?.login ?? null,
    authorEmail: item.commit.author?.email ?? null,
    subject: subject || `Commit ${item.sha.slice(0, 12)}`,
    body: bodyLines.join('\n').trim() || null,
    authoredAt,
    committedAt,
  };
}

/**
 * Materialize or enrich a commit observed by a GitHub push. This intentionally
 * updates only SCM metadata and reachability: Git AI remains authoritative for
 * attribution, sessions, operation kind and rewrite lineage.
 */
export async function recordPushedCommit(input: {
  tenantId: string;
  repositoryId: string;
  branch: string | null;
  commit: GitHubCommit;
  observedAt?: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const observedAt = input.observedAt ?? new Date();
  const metadata = githubCommitMetadata(input.commit, observedAt);
  const [commit] = await tenantDb.upsert(
    scmCommits,
    {
      repositoryId: input.repositoryId,
      sha: input.commit.sha,
      branch: input.branch,
      ...metadata,
      reachability: 'reachable',
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    },
    [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha],
    {
      branch: input.branch,
      ...metadata,
      reachability: 'reachable',
      lastSeenAt: observedAt,
      updatedAt: observedAt,
    },
  );
  return commit ?? null;
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
  const [insertedSnapshot] = await tenantDb.insertDoNothing(
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
  const [snapshot] = insertedSnapshot
    ? [insertedSnapshot]
    : await tenantDb.select(
      scmPullRequestSnapshots,
      and(
        eq(scmPullRequestSnapshots.pullRequestId, input.pullRequestId),
        eq(scmPullRequestSnapshots.snapshotKey, snapshotKey),
      ),
    );
  if (!snapshot) throw new Error('PR snapshot upsert did not return a record');

  const normalized = [];
  for (const item of input.commits) {
    const metadata = githubCommitMetadata(item, capturedAt);
    const [commit] = await tenantDb.upsert(
      scmCommits,
      {
        repositoryId: input.repositoryId,
        sha: item.sha,
        ...metadata,
        reachability: 'pull_request',
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
      },
      [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha],
      {
        ...metadata,
        reachability: 'pull_request',
        lastSeenAt: capturedAt,
        updatedAt: capturedAt,
      },
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
  return { created: Boolean(insertedSnapshot), commitCount: normalized.length };
}

export async function recordMergeLineage(input: {
  tenantId: string;
  repositoryId: string;
  pullRequestId: string;
  resultSha: string;
  resultCommit?: GitHubCommit | null;
  sourceCommitEvidence?: GitHubCommit[];
  resultFirstParentChain?: GitHubCommit[];
  mergedAt: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const memberships = await tenantDb.select(
    scmPullRequestCommitMemberships,
    eq(scmPullRequestCommitMemberships.pullRequestId, input.pullRequestId),
  );
  const activeMemberships = memberships.filter((row) => row.active);
  const sources = [];
  for (const membership of activeMemberships) {
    const [source] = await tenantDb.select(scmCommits, eq(scmCommits.id, membership.commitId));
    if (source) sources.push(source);
  }
  const mergeMethod = inferMergeMethod(
    sources.map((source) => source.sha),
    input.resultSha,
    input.resultCommit?.parents?.map((parent) => parent.sha) ?? [],
    input.sourceCommitEvidence,
    input.resultFirstParentChain,
  );
  const mergeConfidence = mergeMethod === 'rewritten_merge' ? 60 : 95;
  const rebasedResultsBySource = mergeMethod === 'rebase_merge'
    ? mapRebasedResultCommits(input.sourceCommitEvidence, input.resultFirstParentChain)
    : new Map<string, GitHubCommit>();
  const ensureResultCommit = async (commit: GitHubCommit | null | undefined) => {
    if (!commit) return null;
    const metadata = githubCommitMetadata(commit, input.mergedAt);
    const [stored] = await tenantDb.upsert(
      scmCommits,
      {
        repositoryId: input.repositoryId,
        sha: commit.sha,
        ...metadata,
        operationKind: mergeMethod,
        reachability: 'reachable',
        firstSeenAt: input.mergedAt,
        lastSeenAt: input.mergedAt,
      },
      [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha],
      {
        ...metadata,
        operationKind: mergeMethod,
        reachability: 'reachable',
        lastSeenAt: input.mergedAt,
        updatedAt: new Date(),
      },
    );
    return stored ?? null;
  };
  let resultCommit: typeof scmCommits.$inferSelect | null = (await tenantDb.select(
    scmCommits,
    and(eq(scmCommits.repositoryId, input.repositoryId), eq(scmCommits.sha, input.resultSha)),
  ))[0] ?? null;
  if (input.resultCommit) {
    resultCommit = await ensureResultCommit(input.resultCommit);
  }
  const reworkRows = await tenantDb.select(
    aiCodeLifecycleEvents,
    and(
      eq(aiCodeLifecycleEvents.repositoryId, input.repositoryId),
      eq(aiCodeLifecycleEvents.stage, 'reworked'),
    ),
  );
  const modelAttributions = await tenantDb.select(aiCommitModelAttributions);
  const modelReworkRows = await tenantDb.select(
    aiModelLifecycleEvents,
    and(
      eq(aiModelLifecycleEvents.repositoryId, input.repositoryId),
      eq(aiModelLifecycleEvents.stage, 'reworked'),
    ),
  );
  for (const source of sources) {
    const mappedResult = rebasedResultsBySource.get(source.sha);
    const sourceResultSha = mappedResult?.sha ?? input.resultSha;
    const sourceResultCommit = mappedResult
      ? await ensureResultCommit(mappedResult)
      : resultCommit;
    const [existingLineage] = await tenantDb.select(
      scmMergeLineage,
      and(
        eq(scmMergeLineage.pullRequestId, input.pullRequestId),
        eq(scmMergeLineage.sourceCommitId, source.id),
      ),
    );
    if (existingLineage) {
      await tenantDb.update(
        scmMergeLineage,
        {
          resultCommitId: sourceResultCommit?.id ?? null,
          resultSha: sourceResultSha,
          mergeMethod,
          confidence: mergeConfidence,
        },
        eq(scmMergeLineage.id, existingLineage.id),
      );
    } else {
      await tenantDb.insertDoNothing(
        scmMergeLineage,
        {
          pullRequestId: input.pullRequestId,
          sourceCommitId: source.id,
          resultCommitId: sourceResultCommit?.id ?? null,
          resultSha: sourceResultSha,
          mergeMethod,
          confidence: mergeConfidence,
        },
        [scmMergeLineage.tenantId, scmMergeLineage.pullRequestId,
          scmMergeLineage.sourceCommitId, scmMergeLineage.resultSha],
      );
    }
    const retainedAiLines = currentRetainedAiLinesForCommit(
      source.id,
      source.observedAiLines,
      reworkRows,
    );
    if (retainedAiLines > 0) {
      for (const stage of ['merged', 'merged_proxy'] as const) {
        await tenantDb.insertDoNothing(
          aiCodeLifecycleEvents,
          {
            repositoryId: input.repositoryId,
            commitId: source.id,
            pullRequestId: input.pullRequestId,
            stage,
            lineCount: retainedAiLines,
            evidenceType: stage === 'merged'
              ? 'github_pr_merge_current_head'
              : 'default_branch_proxy_current_head',
            evidenceRef: `${stage}:${input.pullRequestId}:${source.id}:${input.resultSha}:current-head`,
            occurredAt: input.mergedAt,
          },
          [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
        );
      }
    }
    for (const attribution of modelAttributions.filter((row) => row.commitId === source.id)) {
      const modelReworked = modelReworkRows
        .filter((row) => row.commitId === source.id && row.modelKey === attribution.modelKey)
        .reduce((sum, row) => sum + row.lineCount, 0);
      const retainedModelLines = Math.max(0, attribution.observedAiLines - modelReworked);
      if (retainedModelLines <= 0) continue;
      for (const stage of ['merged', 'merged_proxy'] as const) {
        await tenantDb.insertDoNothing(
          aiModelLifecycleEvents,
          {
            repositoryId: input.repositoryId,
            sessionId: attribution.sessionId,
            commitId: source.id,
            pullRequestId: input.pullRequestId,
            tool: attribution.tool,
            model: attribution.model,
            modelKey: attribution.modelKey,
            stage,
            lineCount: retainedModelLines,
            actorKind: 'ai',
            actorModelKey: attribution.modelKey,
            evidenceType: stage === 'merged'
              ? 'github_pr_merge_current_head_model_projection'
              : 'default_branch_proxy_current_head_model_projection',
            evidenceRef: `${stage}:${input.pullRequestId}:${source.id}:${input.resultSha}:model:${attribution.modelKey}`,
            occurredAt: input.mergedAt,
          },
          [
            aiModelLifecycleEvents.tenantId,
            aiModelLifecycleEvents.stage,
            aiModelLifecycleEvents.evidenceRef,
          ],
        );
      }
    }
  }
}

function patchIdentity(commit: GitHubCommit): string | null {
  if (!commit.files?.length || commit.files.some((file) => typeof file.patch !== 'string')) return null;
  return JSON.stringify(commit.files
    .map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      status: file.status,
      patch: file.patch?.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, '@@ @@'),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename)));
}

/** Pair each source commit with its patch-equivalent rewritten rebase result. */
export function mapRebasedResultCommits(
  sourceCommits?: GitHubCommit[],
  resultFirstParentChain?: GitHubCommit[],
): Map<string, GitHubCommit> {
  if (!sourceCommits?.length || !resultFirstParentChain
    || resultFirstParentChain.length < sourceCommits.length) return new Map();
  const rewritten = resultFirstParentChain.slice(0, sourceCommits.length).reverse();
  if (!sourceCommits.every((source, index) => {
    const sourceIdentity = patchIdentity(source);
    return sourceIdentity !== null && sourceIdentity === patchIdentity(rewritten[index]);
  })) return new Map();
  return new Map(sourceCommits.map((source, index) => [source.sha, rewritten[index]]));
}

export function inferMergeMethod(
  sourceShas: string[],
  resultSha: string,
  parentShas: string[],
  sourceCommits?: GitHubCommit[],
  resultFirstParentChain?: GitHubCommit[],
) {
  if (sourceShas.includes(resultSha)) return 'fast_forward';
  if (parentShas.length > 1) return 'merge_commit';
  if (sourceShas.length > 1 && parentShas.length === 1) {
    const sourceIdentities = sourceCommits?.map(patchIdentity) ?? [];
    const rebasedIdentities = resultFirstParentChain
      ?.slice(0, sourceShas.length)
      .reverse()
      .map(patchIdentity) ?? [];
    const exactRebase = sourceIdentities.length === sourceShas.length
      && rebasedIdentities.length === sourceShas.length
      && sourceIdentities.every((identity, index) => identity !== null
        && identity === rebasedIdentities[index]);
    return exactRebase ? 'rebase_merge' : 'squash_merge';
  }
  // A one-commit PR rewritten onto a diverged base is topologically
  // indistinguishable from GitHub squash/rebase. Preserve the fact without
  // inventing a more specific operation.
  return 'rewritten_merge';
}

export function uniquePullRequestForDeploymentSource(
  sourceCommitId: string,
  lineage: Array<{ sourceCommitId: string; pullRequestId: string }>,
) {
  const pullRequestIds = lineage
    .filter((row) => row.sourceCommitId === sourceCommitId)
    .map((row) => row.pullRequestId)
    .filter((id, index, all) => all.indexOf(id) === index);
  return pullRequestIds.length === 1 ? pullRequestIds[0] : null;
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
  const lineage = await tenantDb.select(scmMergeLineage, eq(scmMergeLineage.resultSha, input.sha));
  let sourceCommits = commit?.observedAiLines ? [commit] : [];
  if (sourceCommits.length === 0) {
    const sourceIds = lineage.map((row) => row.sourceCommitId)
      .filter((id, index, all) => all.indexOf(id) === index);
    sourceCommits = (await Promise.all(sourceIds.map(async (id) =>
      (await tenantDb.select(scmCommits, eq(scmCommits.id, id)))[0])))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }
  const reworkRows = await tenantDb.select(
    aiCodeLifecycleEvents,
    and(
      eq(aiCodeLifecycleEvents.repositoryId, input.repositoryId),
      eq(aiCodeLifecycleEvents.stage, 'reworked'),
    ),
  );
  const modelAttributions = await tenantDb.select(aiCommitModelAttributions);
  const modelReworkRows = await tenantDb.select(
    aiModelLifecycleEvents,
    and(
      eq(aiModelLifecycleEvents.repositoryId, input.repositoryId),
      eq(aiModelLifecycleEvents.stage, 'reworked'),
    ),
  );
  for (const source of sourceCommits.filter(Boolean)) {
    const retainedAiLines = currentRetainedAiLinesForCommit(
      source.id,
      source.observedAiLines,
      reworkRows,
    );
    if (retainedAiLines <= 0) continue;
    const pullRequestId = uniquePullRequestForDeploymentSource(source.id, lineage);
    await tenantDb.upsert(
      aiCodeLifecycleEvents,
      {
        repositoryId: input.repositoryId,
        commitId: source.id,
        pullRequestId,
        stage: 'production',
        lineCount: retainedAiLines,
        evidenceType: 'github_deployment_status_current_head',
        evidenceRef: `deployment:${input.externalId}:${input.status}:${source.id}:current-head`,
        occurredAt: input.deployedAt,
      },
      [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
      { pullRequestId },
    );
    for (const attribution of modelAttributions.filter((row) => row.commitId === source.id)) {
      const modelReworked = modelReworkRows
        .filter((row) => row.commitId === source.id && row.modelKey === attribution.modelKey)
        .reduce((sum, row) => sum + row.lineCount, 0);
      const retainedModelLines = Math.max(0, attribution.observedAiLines - modelReworked);
      if (retainedModelLines <= 0) continue;
      await tenantDb.upsert(
        aiModelLifecycleEvents,
        {
          repositoryId: input.repositoryId,
          sessionId: attribution.sessionId,
          commitId: source.id,
          pullRequestId,
          tool: attribution.tool,
          model: attribution.model,
          modelKey: attribution.modelKey,
          stage: 'production',
          lineCount: retainedModelLines,
          actorKind: 'ai',
          actorModelKey: attribution.modelKey,
          evidenceType: 'github_deployment_status_current_head_model_projection',
          evidenceRef: `deployment:${input.externalId}:${input.status}:${source.id}:model:${attribution.modelKey}`,
          occurredAt: input.deployedAt,
        },
        [
          aiModelLifecycleEvents.tenantId,
          aiModelLifecycleEvents.stage,
          aiModelLifecycleEvents.evidenceRef,
        ],
        { pullRequestId },
      );
    }
  }
}
