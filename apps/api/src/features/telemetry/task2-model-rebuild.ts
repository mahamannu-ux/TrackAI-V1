import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCodeLifecycleEvents, aiCommitModelAttributions, aiGenerationObservations,
  aiModelLifecycleEvents, aiSessions, scmCommitLineage, scmCommits,
  scmDeployments, scmMergeLineage, scmPullRequestCommitMemberships,
  scmPullRequests, scmRepositories, ssoTenants,
} from '../../core/db/schema';
import { parseAuthorshipNote } from './authorship-note';
import { committedLinesForOperation } from './lifecycle';
import {
  allocateReworkByOriginModel, modelAttributionsFromNote, modelKey, splitModelKey,
} from './model-lifecycle';
import { normalizeRepositoryUrl } from './repository-url';

type Projection = {
  modelKey: string; tool: string; model: string | null; sessionId: string | null; lines: number;
};
type ModelEventInput = Omit<typeof aiModelLifecycleEvents.$inferInsert, 'tenantId'>;

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split('='); return [key, rest.join('=')];
  }));
  const domain = args.get('--tenant-domain')?.trim().toLowerCase();
  const repositoryUrl = args.get('--repository-url')?.trim();
  const apply = args.get('--confirm') === 'REBUILD_MODEL_LIFECYCLE';
  if (!domain || !repositoryUrl) {
    throw new Error('--tenant-domain=<domain> and --repository-url=<url> are required');
  }

  const [tenant] = await db.select({ id: ssoTenants.id }).from(ssoTenants)
    .where(eq(ssoTenants.domain, domain)).limit(1);
  if (!tenant) throw new Error(`No tenant found for ${domain}`);
  const tenantDb = withTenant(db, tenant.id);
  const normalizedUrl = normalizeRepositoryUrl(repositoryUrl);
  if (!normalizedUrl) throw new Error(`Invalid repository URL: ${repositoryUrl}`);
  const [repository] = await tenantDb.select(
    scmRepositories, eq(scmRepositories.normalizedUrl, normalizedUrl),
  );
  if (!repository) throw new Error(`Repository is not enrolled: ${normalizedUrl}`);

  const [commits, sessions, lineage, lifecycleRows, observations, memberships,
    pullRequests, mergeRows, deployments] = await Promise.all([
    tenantDb.select(scmCommits, eq(scmCommits.repositoryId, repository.id)),
    tenantDb.select(aiSessions),
    tenantDb.select(scmCommitLineage, eq(scmCommitLineage.repositoryId, repository.id)),
    tenantDb.select(aiCodeLifecycleEvents, eq(aiCodeLifecycleEvents.repositoryId, repository.id)),
    tenantDb.select(aiGenerationObservations, eq(aiGenerationObservations.repositoryId, repository.id)),
    tenantDb.select(scmPullRequestCommitMemberships),
    tenantDb.select(scmPullRequests, eq(scmPullRequests.repositoryId, repository.id)),
    tenantDb.select(scmMergeLineage),
    tenantDb.select(scmDeployments, eq(scmDeployments.repositoryId, repository.id)),
  ]);

  const projections = new Map<string, Projection[]>();
  const modelRework = new Map<string, Map<string, number>>();
  const stageRows = new Map<string, { rows: number; lines: number }>();
  let attributionRows = 0;
  let unknownReworkLines = 0;

  const count = (stage: string, lines: number) => {
    const current = stageRows.get(stage) ?? { rows: 0, lines: 0 };
    stageRows.set(stage, { rows: current.rows + 1, lines: current.lines + lines });
  };
  const writeEvent = async (row: ModelEventInput) => {
    count(row.stage, row.lineCount);
    if (!apply) return;
    await tenantDb.upsert(aiModelLifecycleEvents, row, [
      aiModelLifecycleEvents.tenantId,
      aiModelLifecycleEvents.stage,
      aiModelLifecycleEvents.evidenceRef,
    ], {
      sessionId: row.sessionId ?? null, commitId: row.commitId ?? null,
      pullRequestId: row.pullRequestId ?? null, lineCount: row.lineCount,
      actorKind: row.actorKind ?? null, actorModelKey: row.actorModelKey ?? null,
      confidence: row.confidence ?? 100, occurredAt: row.occurredAt,
    });
  };

  for (const commit of commits.sort((left, right) =>
    (left.committedAt?.getTime() ?? 0) - (right.committedAt?.getTime() ?? 0))) {
    const parsed = parseAuthorshipNote(commit.authorshipNote);
    const rows = modelAttributionsFromNote(parsed).map((row) => {
      const session = sessions.find((candidate) => candidate.tool === row.tool
        && candidate.externalSessionId === row.externalSessionId);
      return { ...row, sessionId: session?.id ?? null,
        lines: committedLinesForOperation(commit.operationKind, row.lines) };
    }).filter((row) => row.lines > 0);
    projections.set(commit.id, rows);
    attributionRows += rows.length;
    for (const row of rows) {
      if (apply) {
        await tenantDb.upsert(aiCommitModelAttributions, {
          commitId: commit.id, sessionId: row.sessionId,
          internalSessionId: row.internalSessionId, tool: row.tool, model: row.model,
          modelKey: row.modelKey, observedAiLines: row.lines,
          evidenceType: 'git_ai_authorship_note_model_range',
          evidenceRef: `commit:${commit.id}:model:${row.modelKey}`,
        }, [aiCommitModelAttributions.tenantId, aiCommitModelAttributions.commitId,
          aiCommitModelAttributions.modelKey], {
          sessionId: row.sessionId, internalSessionId: row.internalSessionId,
          observedAiLines: row.lines, updatedAt: new Date(),
        });
      }
      await writeEvent({ repositoryId: repository.id, sessionId: row.sessionId,
        commitId: commit.id, tool: row.tool, model: row.model, modelKey: row.modelKey,
        stage: 'committed', lineCount: row.lines, actorKind: 'ai',
        actorModelKey: row.modelKey, evidenceType: 'git_ai_authorship_note_model_range',
        evidenceRef: `commit:${commit.id}:model:${row.modelKey}`,
        occurredAt: commit.committedAt ?? commit.createdAt });
    }
  }

  // Allocate each commit's rework once. Processing individual evidence rows
  // independently would repeatedly consume the same predecessor reduction.
  for (const commit of commits) {
    const commitRework = lifecycleRows.filter((row) => row.commitId === commit.id
      && row.stage === 'reworked');
    const total = commitRework.reduce((sum, row) => sum + row.lineCount, 0);
    if (total <= 0) continue;
    const parent = lineage.find((row) => row.successorCommitId === commit.id
      && row.predecessorCommitId !== null);
    const allocations = allocateReworkByOriginModel({
      predecessor: parent?.predecessorCommitId
        ? projections.get(parent.predecessorCommitId) ?? [] : [],
      successor: projections.get(commit.id) ?? [], reworkedLines: total,
    });
    const perModel = new Map<string, number>();
    modelRework.set(commit.id, perModel);
    for (const allocation of allocations) {
      perModel.set(allocation.modelKey, allocation.lines);
      if (allocation.modelKey === 'unknown::unknown') unknownReworkLines += allocation.lines;
      const identity = splitModelKey(allocation.modelKey);
      await writeEvent({ repositoryId: repository.id, commitId: commit.id,
        tool: identity.tool, model: identity.model === 'unknown' ? null : identity.model,
        modelKey: allocation.modelKey, stage: 'reworked', lineCount: allocation.lines,
        actorKind: commitRework.length === 1 ? commitRework[0].actorKind : 'mixed',
        evidenceType: 'model_origin_rebuild_from_commit_lineage',
        evidenceRef: `commit-model-rework:${commit.id}:${allocation.modelKey}`,
        confidence: allocation.confidence,
        occurredAt: commitRework.at(-1)?.occurredAt ?? commit.committedAt ?? commit.createdAt });
    }
  }
  for (const row of lifecycleRows.filter((candidate) => candidate.stage === 'reworked'
    && candidate.commitId === null)) {
    unknownReworkLines += row.lineCount;
    await writeEvent({ repositoryId: repository.id, sessionId: row.sessionId,
      tool: 'unknown', model: null, modelKey: 'unknown::unknown', stage: 'reworked',
      lineCount: row.lineCount, actorKind: row.actorKind,
      evidenceType: 'unresolved_model_origin', evidenceRef: `unresolved-model:${row.id}`,
      confidence: 0, occurredAt: row.occurredAt });
  }

  const aggregateBySource = new Map(lifecycleRows
    .filter((row) => row.stage === 'generated' && row.evidenceRef.startsWith('checkpoint:'))
    .map((row) => [row.evidenceRef.slice('checkpoint:'.length), row]));
  for (const observation of observations) {
    const session = sessions.find((row) => row.id === observation.sessionId);
    const key = modelKey(session?.tool, observation.model);
    const identity = splitModelKey(key);
    const aggregate = aggregateBySource.get(observation.sourceEventId);
    await writeEvent({ repositoryId: repository.id, sessionId: observation.sessionId,
      commitId: aggregate?.commitId ?? null, pullRequestId: aggregate?.pullRequestId ?? null,
      tool: identity.tool, model: identity.model === 'unknown' ? null : identity.model,
      modelKey: key, stage: 'generated', lineCount: observation.generatedLines,
      actorKind: 'ai', actorModelKey: key, evidenceType: observation.evidenceSource,
      evidenceRef: `checkpoint:${observation.sourceEventId}:model:${key}`,
      occurredAt: observation.generatedAt });
  }

  const retained = (commitId: string, row: Projection) => Math.max(0,
    row.lines - (modelRework.get(commitId)?.get(row.modelKey) ?? 0));
  let unresolvedDownstreamLines = 0;
  const projectStage = async (input: {
    stage: string; commitId: string; pullRequestId: string | null;
    lineCount: number; evidenceRef: string; occurredAt: Date;
  }) => {
    const rows = (projections.get(input.commitId) ?? []).map((row) => ({
      ...row, retainedLines: retained(input.commitId, row),
    })).filter((row) => row.retainedLines > 0);
    const knownTotal = rows.reduce((sum, row) => sum + row.retainedLines, 0);
    if (knownTotal !== input.lineCount) {
      unresolvedDownstreamLines += input.lineCount;
      await writeEvent({ repositoryId: repository.id, commitId: input.commitId,
        pullRequestId: input.pullRequestId, tool: 'unknown', model: null,
        modelKey: 'unknown::unknown', stage: input.stage, lineCount: input.lineCount,
        actorKind: 'ai', evidenceType: 'unresolved_legacy_model_projection',
        evidenceRef: `${input.evidenceRef}:model:unknown::unknown`, confidence: 0,
        occurredAt: input.occurredAt });
      return;
    }
    for (const row of rows) {
      await writeEvent({ repositoryId: repository.id, sessionId: row.sessionId,
        commitId: input.commitId, pullRequestId: input.pullRequestId,
        tool: row.tool, model: row.model, modelKey: row.modelKey, stage: input.stage,
        lineCount: row.retainedLines, actorKind: 'ai', actorModelKey: row.modelKey,
        evidenceType: `${input.stage}_model_projection`,
        evidenceRef: `${input.evidenceRef}:model:${row.modelKey}`,
        occurredAt: input.occurredAt });
    }
  };

  const openPullRequestIds = new Set(pullRequests.filter((row) => row.state === 'open')
    .map((row) => row.id));
  for (const membership of memberships.filter((row) => row.active
    && openPullRequestIds.has(row.pullRequestId))) {
    const commit = commits.find((row) => row.id === membership.commitId);
    if (!commit) continue;
    const committedRework = lifecycleRows.filter((row) => row.commitId === commit.id
      && row.stage === 'reworked').reduce((sum, row) => sum + row.lineCount, 0);
    await projectStage({ stage: 'in_pr', commitId: commit.id,
      pullRequestId: membership.pullRequestId,
      lineCount: Math.max(0, commit.observedAiLines - committedRework),
      evidenceRef: `model-pr:${membership.id}`, occurredAt: membership.lastSeenAt });
  }

  for (const aggregate of lifecycleRows.filter((row) =>
    row.commitId !== null && ['merged', 'merged_proxy', 'production'].includes(row.stage))) {
    await projectStage({ stage: aggregate.stage, commitId: aggregate.commitId!,
      pullRequestId: aggregate.pullRequestId, lineCount: aggregate.lineCount,
      evidenceRef: aggregate.evidenceRef, occurredAt: aggregate.occurredAt });
  }

  console.log(JSON.stringify({ dryRun: !apply, tenant: domain, repository: normalizedUrl,
    commits: commits.length, attributionRows,
    lifecycle: Object.fromEntries([...stageRows.entries()].sort()),
    unknownReworkLines, unresolvedDownstreamLines,
    next: apply ? null : 'rerun with --confirm=REBUILD_MODEL_LIFECYCLE after reviewing totals',
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
