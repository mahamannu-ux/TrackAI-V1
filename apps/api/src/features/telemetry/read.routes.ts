import { Router, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiCommitModelAttributions,
  aiCodeLifecycleEvents,
  aiGenerationObservations,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  aiModelLifecycleEvents,
  scmCommitFiles,
  scmCommitLineage,
  scmCommits,
  scmContributors,
  scmDeployments,
  scmMergeLineage,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
  ssoTenants,
  telemetryCorrections,
} from '../../core/db/schema';
import { applyAuditedValue } from './audit';
import {
  calculateLifecycleScopeTotals,
  calculateLifecycleSummary,
  contributorMatchesCommit,
  fallbackSessionName,
  generationEvidenceMetric,
  generationEvidenceForScope,
  generationCoverageForScope,
  currentRetainedAiLines,
  isCommittedLineReworkEvidence,
  lifecycleEvidenceForPullRequest,
  lifecycleEvidenceMatchesPullRequestScope,
} from './lifecycle';
import { parseAuthorshipNote } from './authorship-note';
import { evidenceFlowEnabled, loadOpenCodeEvidence } from './opencode-evidence';

const router = Router();

function tenant(req: Request, res: Response): string | null {
  if (!req.tenantId) {
    res.status(500).json({ error: 'Tenant context was not initialized' });
    return null;
  }
  return req.tenantId;
}

type CorrectionRow = typeof telemetryCorrections.$inferSelect;

function correctionMap(rows: CorrectionRow[]) {
  return new Map(rows.map((row) => [
    `${row.targetType}:${row.targetKey}:${row.fieldName}`,
    row,
  ]));
}

function audited<T>(
  corrections: Map<string, CorrectionRow>,
  targetType: string,
  targetKey: string,
  fieldName: string,
  observedValue: T,
) {
  return applyAuditedValue(
    corrections.get(`${targetType}:${targetKey}:${fieldName}`),
    observedValue,
  );
}

function date(value: Date | null) {
  return value?.toISOString() ?? null;
}

function contributesToCurrentCommittedState(reachability: string) {
  return reachability !== 'superseded' && reachability !== 'unreachable';
}

async function loadContext(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits, corrections,
    generationObservations, lifecycleEvents, memberships, commitLineage,
    mergeLineage, deployments, commitModelAttributions, modelLifecycleEvents] = await Promise.all([
    tenantDb.select(scmRepositories),
    tenantDb.select(scmPullRequests),
    tenantDb.select(scmContributors),
    tenantDb.select(aiSessions),
    tenantDb.select(aiSessionRepositories),
    tenantDb.select(aiSessionUsage),
    tenantDb.select(scmCommits),
    tenantDb.select(scmCommitFiles),
    tenantDb.select(aiCommitSessions),
    tenantDb.select(scmPullRequestCommits),
    tenantDb.select(telemetryCorrections),
    tenantDb.select(aiGenerationObservations),
    tenantDb.select(aiCodeLifecycleEvents),
    tenantDb.select(scmPullRequestCommitMemberships),
    tenantDb.select(scmCommitLineage),
    tenantDb.select(scmMergeLineage),
    tenantDb.select(scmDeployments),
    tenantDb.select(aiCommitModelAttributions),
    tenantDb.select(aiModelLifecycleEvents),
  ]);
  return {
    repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits,
    generationObservations, lifecycleEvents, memberships, commitLineage,
    mergeLineage, deployments, commitModelAttributions, modelLifecycleEvents,
    corrections: correctionMap(corrections),
  };
}

router.get('/repositories', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const rows = await withTenant(db, tenantId).select(scmRepositories);
    res.json(rows.map((row) => ({
      id: row.id, provider: row.provider, externalId: row.externalId,
      name: row.name, url: row.url, normalizedUrl: row.normalizedUrl,
      createdAt: row.createdAt.toISOString(),
    })));
  } catch (error) { next(error); }
});

router.get('/pull-requests', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const rows = await withTenant(db, tenantId).select(scmPullRequests);
    res.json(rows.map((row) => ({
      id: row.id, repositoryId: row.repositoryId, externalId: row.externalId,
      title: row.title, state: row.state, authorEmail: row.authorEmail,
      authorLogin: row.authorLogin, authorProviderId: row.authorProviderId,
      headRef: row.headRef, baseRef: row.baseRef, headSha: row.headSha,
      mergeCommitSha: row.mergeCommitSha, mergedAt: date(row.mergedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })));
  } catch (error) { next(error); }
});

router.get('/contributors', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const rows = await withTenant(db, tenantId).select(scmContributors);
    res.json(rows.map((row) => ({
      id: row.id, repositoryId: row.repositoryId, name: row.name,
      email: row.email, machineId: row.machineId,
    })));
  } catch (error) { next(error); }
});

router.get('/telemetry/sessions', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    res.json(context.sessions.map((session) => {
      const repositories = context.sessionRepositories
        .filter((link) => link.sessionId === session.id)
        .map((link) => context.repositories.find((repo) => repo.id === link.repositoryId))
        .filter(Boolean)
        .map((repo) => ({ id: repo!.id, name: repo!.name, url: repo!.url }));
      const usage = context.usage.filter((row) => row.sessionId === session.id);
      const commitLinks = context.commitSessions.filter((link) => link.sessionId === session.id);
      const retainedCommitLinks = commitLinks.filter((link) => {
        const commit = context.commits.find((row) => row.id === link.commitId);
        return commit ? contributesToCurrentCommittedState(commit.reachability) : false;
      });
      const tokens = usage.reduce((sum, row) => sum
        + (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
        + (row.reasoningTokens ?? 0) + (row.cacheReadTokens ?? 0)
        + (row.cacheWriteTokens ?? 0), 0);
      return {
        id: session.id,
        externalSessionId: session.externalSessionId,
        gitAiSessionId: session.gitAiSessionId,
        displayName: session.displayName
          ?? fallbackSessionName(session.tool, session.startedAt, session.externalSessionId),
        agent: session.tool,
        models: audited(context.corrections, 'session', session.id, 'observedModels', session.observedModels),
        status: session.status,
        startedAt: date(session.startedAt), endedAt: date(session.endedAt), repositories,
        commitCount: retainedCommitLinks.length,
        retainedCommitCount: retainedCommitLinks.length,
        historicalCommitCount: commitLinks.length,
        finalAiLines: retainedCommitLinks.reduce((sum, row) => sum + row.observedAiLines, 0),
        totalTokens: usage.some((row) => row.availability === 'recorded') ? tokens : null,
        usageAvailability: usage.some((row) => row.availability === 'recorded') ? 'recorded' : 'unavailable',
      };
    }));
  } catch (error) { next(error); }
});

router.get('/telemetry/sessions/:id', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const session = context.sessions.find((row) => row.id === req.params.id);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    const links = context.commitSessions.filter((row) => row.sessionId === session.id);
    const commits = links.map((link) => context.commits.find((row) => row.id === link.commitId))
      .filter(Boolean).map((commit) => ({
        id: commit!.id, sha: commit!.sha, subject: commit!.subject,
        committedAt: date(commit!.committedAt),
      }));
    const repositoryIds = new Set(context.sessionRepositories
      .filter((row) => row.sessionId === session.id).map((row) => row.repositoryId));
    res.json({
      id: session.id, externalSessionId: session.externalSessionId,
      gitAiSessionId: session.gitAiSessionId,
      displayName: session.displayName
        ?? fallbackSessionName(session.tool, session.startedAt, session.externalSessionId),
      agent: session.tool,
      models: audited(context.corrections, 'session', session.id, 'observedModels', session.observedModels),
      humanAuthor: session.humanAuthor, status: session.status,
      startedAt: date(session.startedAt), endedAt: date(session.endedAt),
      repositories: context.repositories.filter((row) => repositoryIds.has(row.id))
        .map((row) => ({ id: row.id, name: row.name, url: row.url })),
      finalAiLines: links.reduce((sum, row) => sum + row.observedAiLines, 0),
      totalAiGeneratedLoc: (() => {
        const rows = context.generationObservations.filter((row) => row.sessionId === session.id);
        const finalAiLines = links.reduce((sum, row) => sum + row.observedAiLines, 0);
        const observedLines = rows.length
          ? rows.reduce((sum, row) => sum + row.generatedLines, 0)
          : null;
        return generationEvidenceMetric(observedLines, finalAiLines);
      })(),
      usage: context.usage.filter((row) => row.sessionId === session.id).map((row) => ({
        id: row.id, model: row.model, inputTokens: row.inputTokens,
        outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens,
        cacheReadTokens: row.cacheReadTokens, cacheWriteTokens: row.cacheWriteTokens,
        costAmount: row.costAmount, costUnit: row.costUnit,
        availability: row.availability, evidenceSource: row.evidenceSource,
      })),
      commits,
      deferred: { traces: [], checkpoints: [], toolCalls: [], prompts: [] },
    });
  } catch (error) { next(error); }
});

router.get('/telemetry/commits', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    res.json(context.commits.map((commit) => {
      const repository = context.repositories.find((row) => row.id === commit.repositoryId);
      const sessions = context.commitSessions.filter((row) => row.commitId === commit.id);
      return {
        id: commit.id, sha: commit.sha, subject: commit.subject, branch: commit.branch,
        repository: repository ? { id: repository.id, name: repository.name } : null,
        authorName: commit.authorName, authorEmail: commit.authorEmail,
        committedAt: date(commit.committedAt), diffAddedLines: commit.diffAddedLines,
        diffDeletedLines: commit.diffDeletedLines,
        finalAiLines: audited(context.corrections, 'commit', commit.id, 'observedAiLines', commit.observedAiLines),
        finalHumanLines: audited(context.corrections, 'commit', commit.id, 'observedHumanLines', commit.observedHumanLines),
        unknownLines: commit.observedUnknownLines, sessionCount: sessions.length,
        reachability: commit.reachability, operationKind: commit.operationKind,
      };
    }));
  } catch (error) { next(error); }
});

router.get('/telemetry/commits/:id/evidence-flow', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  if (!evidenceFlowEnabled()) {
    res.status(404).json({ error: 'Development evidence flow is disabled' });
    return;
  }
  try {
    const databasePath = process.env.TRACKAI_OPENCODE_DB_PATH;
    if (!databasePath) {
      res.status(503).json({ error: 'OpenCode evidence database is not configured' });
      return;
    }
    const context = await loadContext(tenantId);
    const commit = context.commits.find((row) => row.id === req.params.id);
    if (!commit) { res.status(404).json({ error: 'Commit not found' }); return; }
    const committedAt = commit.committedAt ?? commit.createdAt;
    const note = parseAuthorshipNote(commit.authorshipNote);
    const openCode = note.sessions.find((row) => row.tool === 'opencode');
    if (!openCode) {
      res.json({ provider: 'opencode', status: 'unavailable',
        reason: 'This commit has no OpenCode conversation evidence', nodes: [] });
      return;
    }
    const session = context.sessions.find((row) => row.tool === 'opencode'
      && row.externalSessionId === openCode.externalId);
    const previousCommit = session
      ? context.commitSessions
        .filter((link) => link.sessionId === session.id && link.commitId !== commit.id)
        .map((link) => context.commits.find((candidate) => candidate.id === link.commitId))
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
        .filter((candidate) => (candidate.committedAt ?? candidate.createdAt) < committedAt)
        .sort((left, right) => (right.committedAt ?? right.createdAt).getTime()
          - (left.committedAt ?? left.createdAt).getTime())[0]
      : undefined;
    const nodes = await loadOpenCodeEvidence({
      databasePath,
      externalSessionId: openCode.externalId,
      after: previousCommit ? previousCommit.committedAt ?? previousCommit.createdAt : undefined,
      through: committedAt,
      commit: { sha: commit.sha, subject: commit.subject, committedAt },
    });
    res.json({
      provider: 'opencode',
      status: nodes.length > 1 ? 'recorded' : 'unavailable',
      reason: nodes.length > 1 ? null : 'No provider turns were found in the commit time window',
      developmentOnly: true,
      correlation: nodes.length > 1 ? 'time-window' : 'unresolved',
      nodes,
    });
  } catch (error) { next(error); }
});

router.get('/telemetry/commits/:id', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const commit = context.commits.find((row) => row.id === req.params.id);
    if (!commit) { res.status(404).json({ error: 'Commit not found' }); return; }
    const links = context.commitSessions.filter((row) => row.commitId === commit.id);
    const reworkRows = context.lifecycleEvents.filter((row) =>
      row.commitId === commit.id && row.stage === 'reworked');
    const reworkByActor = reworkRows.reduce((result, row) => {
      const actor = row.actorKind ?? 'unknown';
      result[actor] = (result[actor] ?? 0) + row.lineCount;
      return result;
    }, {} as Record<string, number>);
    res.json({
      id: commit.id, sha: commit.sha, subject: commit.subject, body: commit.body,
      branch: commit.branch, authorName: commit.authorName, authorEmail: commit.authorEmail,
      authoredAt: date(commit.authoredAt), committedAt: date(commit.committedAt),
      diffAddedLines: commit.diffAddedLines, diffDeletedLines: commit.diffDeletedLines,
      finalAiLines: audited(context.corrections, 'commit', commit.id, 'observedAiLines', commit.observedAiLines),
      finalHumanLines: audited(context.corrections, 'commit', commit.id, 'observedHumanLines', commit.observedHumanLines),
      unknownLines: commit.observedUnknownLines,
      rework: {
        value: reworkRows.length
          ? reworkRows.reduce((sum, row) => sum + row.lineCount, 0)
          : null,
        availability: reworkRows.length ? 'recorded' : 'unavailable',
        byActor: reworkByActor,
        evidenceTypes: [...new Set(reworkRows.map((row) => row.evidenceType))].sort(),
      },
      totalAiGeneratedLoc: (() => {
        const sessionIds = new Set(links.map((row) => row.sessionId));
        const rows = context.generationObservations.filter((row) => sessionIds.has(row.sessionId ?? ''));
        const observedLines = rows.length
          ? rows.reduce((sum, row) => sum + row.generatedLines, 0)
          : null;
        const finalAiLines = audited(
          context.corrections,
          'commit',
          commit.id,
          'observedAiLines',
          commit.observedAiLines,
        ).auditedValue;
        return generationEvidenceMetric(observedLines, finalAiLines);
      })(),
      reachability: commit.reachability,
      operationKind: commit.operationKind,
      predecessors: context.commitLineage.filter((row) => row.successorCommitId === commit.id),
      successors: context.commitLineage.filter((row) => row.predecessorCommitId === commit.id),
      files: context.files.filter((row) => row.commitId === commit.id).map((row) => ({
        id: row.id, path: row.path, observedAiLines: row.observedAiLines,
        observedHumanLines: row.observedHumanLines, observedUnknownLines: row.observedUnknownLines,
        attributionRanges: row.attributionRanges,
      })),
      sessions: links.map((link) => {
        const session = context.sessions.find((row) => row.id === link.sessionId);
        return session ? { id: session.id, externalSessionId: session.externalSessionId,
          agent: session.tool, models: session.observedModels, finalAiLines: link.observedAiLines } : null;
      }).filter(Boolean),
    });
  } catch (error) { next(error); }
});

router.get('/pull-requests/:id/intelligence', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const pullRequest = context.pullRequests.find((row) => row.id === req.params.id);
    if (!pullRequest) { res.status(404).json({ error: 'Pull request not found' }); return; }
    const prLinks = context.pullRequestCommits.filter((row) => row.pullRequestId === pullRequest.id);
    const memberships = context.memberships.filter((row) => row.pullRequestId === pullRequest.id);
    const activeMemberships = memberships.filter((row) => row.active);
    const commitIds = new Set((memberships.length > 0 ? activeMemberships : prLinks)
      .map((row) => row.commitId));
    const commits = context.commits.filter((row) => commitIds.has(row.id));
    const mergeResult = pullRequest.mergeCommitSha
      ? context.commits.find((row) => row.repositoryId === pullRequest.repositoryId
        && row.sha === pullRequest.mergeCommitSha)
      : null;
    const sessionIds = new Set(context.commitSessions
      .filter((row) => commitIds.has(row.commitId)).map((row) => row.sessionId));
    const usage = context.usage.filter((row) => sessionIds.has(row.sessionId));
    const costByUnit = Array.from(usage.reduce((map, row) => {
      if (!row.costUnit || row.costAmount === null) return map;
      map.set(row.costUnit, (map.get(row.costUnit) ?? 0) + Number(row.costAmount));
      return map;
    }, new Map<string, number>())).map(([unit, amount]) => ({ unit, amount }));
    res.json({
      pullRequest: { id: pullRequest.id, title: pullRequest.title, state: pullRequest.state,
        mergeCommitSha: pullRequest.mergeCommitSha, mergedAt: date(pullRequest.mergedAt) },
      mergeResult: mergeResult ? { id: mergeResult.id, sha: mergeResult.sha,
        subject: mergeResult.subject, operationKind: mergeResult.operationKind } : null,
      commits: commits.map((row) => ({ id: row.id, sha: row.sha, subject: row.subject,
        match: prLinks.find((link) => link.commitId === row.id) })),
      sessions: context.sessions.filter((row) => sessionIds.has(row.id)).map((row) => ({
        id: row.id, externalSessionId: row.externalSessionId, agent: row.tool, models: row.observedModels,
      })),
      finalAiLines: currentRetainedAiLines(
        commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedAiLines', row.observedAiLines).auditedValue, 0),
        context.lifecycleEvents.filter((row) => row.commitId !== null && commitIds.has(row.commitId)
          && row.stage === 'reworked'),
      ),
      finalHumanLines: commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedHumanLines', row.observedHumanLines).auditedValue, 0),
      tokens: {
        input: usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
        output: usage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
        reasoning: usage.reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0),
        cacheRead: usage.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0),
        cacheWrite: usage.reduce((sum, row) => sum + (row.cacheWriteTokens ?? 0), 0),
      },
      costByUnit,
      membership: {
        source: memberships.length > 0 ? 'github_pr_commits_api' : 'legacy_inference',
        current: activeMemberships.length,
        removedHistorical: memberships.filter((row) => !row.active).length,
      },
      lifecycle: calculateLifecycleSummary([
        ...lifecycleEvidenceForPullRequest(
          context.lifecycleEvents,
          pullRequest.id,
          commitIds,
        ),
        ...(pullRequest.state === 'open' ? [{
          stage: 'in_pr',
          lineCount: currentRetainedAiLines(
            commits.reduce((sum, commit) => sum + commit.observedAiLines, 0),
            context.lifecycleEvents.filter((row) => row.commitId !== null && commitIds.has(row.commitId)
              && row.stage === 'reworked'),
          ),
          evidenceType: 'github_pr_commits_api_current_head',
        }] : []),
      ]),
    });
  } catch (error) { next(error); }
});

type LifecycleFilter = {
  repositoryId?: string;
  pullRequestId?: string;
  contributorId?: string;
  from?: Date;
  to?: Date;
};

async function lifecycleForTenant(tenantId: string, filter: LifecycleFilter) {
  const context = await loadContext(tenantId);
  let repositoryIds = filter.repositoryId ? new Set([filter.repositoryId]) : null;
  let pullRequestIds = filter.pullRequestId ? new Set([filter.pullRequestId]) : null;
  let contributorCommitIds: Set<string> | null = null;
  if (filter.contributorId) {
    const contributor = context.contributors.find((row) => row.id === filter.contributorId);
    if (!contributor) return null;
    repositoryIds = new Set([contributor.repositoryId]);
    contributorCommitIds = new Set(context.commits
      .filter((commit) => commit.repositoryId === contributor.repositoryId)
      .filter((commit) => contributorMatchesCommit(contributor, commit))
      .map((commit) => commit.id));
  }
  const inTime = (dateValue: Date) => (!filter.from || dateValue >= filter.from)
    && (!filter.to || dateValue <= filter.to);
  const scopedMemberships = context.memberships.filter((row) =>
    (!pullRequestIds || pullRequestIds.has(row.pullRequestId))
    && (!contributorCommitIds || contributorCommitIds.has(row.commitId)));
  const scopedMembershipCommitIds = new Set(scopedMemberships.map((row) => row.commitId));
  const retainedCommitIds = new Set(context.commits
    .filter((commit) => contributesToCurrentCommittedState(commit.reachability))
    .filter((commit) => !repositoryIds || repositoryIds.has(commit.repositoryId))
    .map((commit) => commit.id));
  const lifecycleRows = context.lifecycleEvents.filter((row) =>
    (!repositoryIds || repositoryIds.has(row.repositoryId))
    && (!pullRequestIds || lifecycleEvidenceMatchesPullRequestScope(
      row,
      pullRequestIds,
      scopedMembershipCommitIds,
    ))
    && (!contributorCommitIds
      || (row.commitId !== null && contributorCommitIds.has(row.commitId)))
    && inTime(row.occurredAt)
    && row.stage !== 'generated'
    && (row.stage !== 'committed'
      || row.commitId === null
      || retainedCommitIds.has(row.commitId)));
  const generationCommitIds = pullRequestIds
    ? new Set(scopedMemberships.map((row) => row.commitId))
    : contributorCommitIds;
  const generationRows = generationEvidenceForScope({
    observations: context.generationObservations
      .filter((row) => (!repositoryIds
        || (row.repositoryId !== null && repositoryIds.has(row.repositoryId)))
        && inTime(row.generatedAt))
      .map((row) => ({ lineCount: row.generatedLines, evidenceType: row.evidenceSource })),
    commitLinked: context.lifecycleEvents
      .filter((row) => row.stage === 'generated'
        && (!repositoryIds || repositoryIds.has(row.repositoryId))
        && inTime(row.occurredAt))
      .map((row) => ({
        commitId: row.commitId,
        lineCount: row.lineCount,
        evidenceType: row.evidenceType,
      })),
    commitIds: generationCommitIds,
  });
  const openPullRequestIds = new Set(context.pullRequests
    .filter((row) => row.state.toLowerCase() === 'open').map((row) => row.id));
  const activeMemberships = context.memberships.filter((row) => row.active
    && openPullRequestIds.has(row.pullRequestId)
    && (!pullRequestIds || pullRequestIds.has(row.pullRequestId))
    && (!contributorCommitIds || contributorCommitIds.has(row.commitId)));
  const activeMembershipCommitIds = new Set(activeMemberships.map((row) => row.commitId));
  const activeMembershipCommittedAi = context.commits
    .filter((commit) => activeMembershipCommitIds.has(commit.id))
    .reduce((sum, commit) => sum + commit.observedAiLines, 0);
  const inPrRows = activeMemberships.length > 0 ? [{
    stage: 'in_pr',
    lineCount: currentRetainedAiLines(
      activeMembershipCommittedAi,
      context.lifecycleEvents.filter((row) => row.commitId !== null
        && activeMembershipCommitIds.has(row.commitId) && row.stage === 'reworked'),
    ),
    actorKind: null,
    evidenceType: 'github_pr_commits_api_current_head',
  }] : [];
  const committedRows = pullRequestIds ? scopedMemberships
    .filter((membership) => membership.active && retainedCommitIds.has(membership.commitId))
    .map((membership) => ({
    stage: 'committed',
    lineCount: context.commits.find((commit) => commit.id === membership.commitId)?.observedAiLines ?? 0,
    actorKind: null,
    evidenceType: 'git_ai_authorship',
    })) : [];
  const pullRequestCommitIds = pullRequestIds
    ? new Set(scopedMemberships.filter((row) => row.active).map((row) => row.commitId))
    : null;
  const selectedCommitIds = pullRequestCommitIds ?? contributorCommitIds ?? (repositoryIds
    ? new Set(context.commits.filter((row) => repositoryIds!.has(row.repositoryId)).map((row) => row.id))
    : null);
  const committedByCommit = context.lifecycleEvents
    .filter((row) => row.stage === 'committed' && row.commitId !== null)
    .reduce((result, row) => {
      result.set(row.commitId!, (result.get(row.commitId!) ?? 0) + row.lineCount);
      return result;
    }, new Map<string, number>());
  const generationCoverage = generationCoverageForScope({
    commits: context.commits.map((commit) => ({
      id: commit.id,
      reachability: commit.reachability,
      finalAiLines: committedByCommit.get(commit.id) ?? 0,
    })),
    generatedRows: context.lifecycleEvents
      .filter((row) => row.stage === 'generated')
      .map((row) => ({ commitId: row.commitId, lineCount: row.lineCount })),
    commitIds: selectedCommitIds,
  });
  const summary = calculateLifecycleSummary([
    ...generationRows.map((row) => ({
      stage: 'generated', lineCount: row.lineCount,
      actorKind: 'ai', evidenceType: row.evidenceType,
    })),
    ...lifecycleRows,
    ...committedRows,
    ...inPrRows,
  ], generationCoverage);
  const totals = calculateLifecycleScopeTotals({
    commits: context.commits.map((commit) => ({
      id: commit.id,
      repositoryId: commit.repositoryId,
      reachability: commit.reachability,
      finalAiLines: audited(
        context.corrections,
        'commit',
        commit.id,
        'observedAiLines',
        commit.observedAiLines,
      ).auditedValue,
      finalHumanLines: audited(
        context.corrections,
        'commit',
        commit.id,
        'observedHumanLines',
        commit.observedHumanLines,
      ).auditedValue,
    })),
    commitSessions: context.commitSessions,
    sessionRepositories: context.sessionRepositories,
    allSessionIds: context.sessions.map((session) => session.id),
    repositoryIds,
    pullRequestCommitIds,
    contributorCommitIds,
    reworkRows: context.lifecycleEvents
      .filter((row) => row.stage === 'reworked' && isCommittedLineReworkEvidence(row.evidenceType))
      .map((row) => ({
        commitId: row.commitId,
        lineCount: row.lineCount,
        evidenceType: row.evidenceType,
      })),
  });
  return {
    summary,
    totals,
    generationCoverage,
    scope: {
      repositoryIds: repositoryIds ? [...repositoryIds] : [],
      pullRequestIds: pullRequestIds ? [...pullRequestIds] : [],
      contributorId: filter.contributorId ?? null,
      from: filter.from?.toISOString() ?? null,
      to: filter.to?.toISOString() ?? null,
    },
    evidence: {
      generationObservations: generationRows.length,
      lifecycleEvents: lifecycleRows.length,
      activePullRequestMemberships: activeMemberships.length,
      deployments: context.deployments.filter((row) => !repositoryIds || repositoryIds.has(row.repositoryId)).length,
    },
  };
}

function lifecycleForModel(context: Awaited<ReturnType<typeof loadContext>>, key: string) {
  const rows = context.modelLifecycleEvents.filter((row) => row.modelKey === key);
  const committedIds = new Set(rows
    .filter((row) => row.stage === 'committed' && row.commitId !== null)
    .map((row) => row.commitId!));
  const retainedCommitIds = new Set(context.commits
    .filter((commit) => contributesToCurrentCommittedState(commit.reachability))
    .filter((commit) => committedIds.has(commit.id))
    .map((commit) => commit.id));
  const lifecycleRows = rows.filter((row) => row.stage !== 'committed'
    || row.commitId === null || retainedCommitIds.has(row.commitId));
  const committedAttributions = context.commitModelAttributions
    .filter((row) => row.modelKey === key && retainedCommitIds.has(row.commitId));
  const reworked = rows.filter((row) => row.stage === 'reworked'
    && row.commitId !== null && retainedCommitIds.has(row.commitId))
    .reduce((sum, row) => sum + row.lineCount, 0);
  const sessions = new Set(rows.map((row) => row.sessionId).filter(Boolean));
  const generatedCommitIds = new Set(rows
    .filter((row) => row.stage === 'generated' && row.commitId !== null)
    .map((row) => row.commitId!));
  const missingCommitIds = [...retainedCommitIds].filter((id) => !generatedCommitIds.has(id));
  return {
    summary: calculateLifecycleSummary(lifecycleRows, {
      complete: missingCommitIds.length === 0,
      requiredCommitCount: retainedCommitIds.size,
      coveredCommitCount: retainedCommitIds.size - missingCommitIds.length,
      missingCommitIds,
    }),
    totals: {
      sessions: sessions.size,
      commits: retainedCommitIds.size,
      finalAiLines: Math.max(0,
        committedAttributions.reduce((sum, row) => sum + row.observedAiLines, 0) - reworked),
      finalHumanLines: 0,
    },
    generationCoverage: {
      complete: missingCommitIds.length === 0,
      requiredCommitCount: retainedCommitIds.size,
      coveredCommitCount: retainedCommitIds.size - missingCommitIds.length,
      missingCommitIds,
    },
    scope: { modelKey: key },
    evidence: { modelLifecycleEvents: rows.length, commitModelAttributions: committedAttributions.length },
  };
}

function optionalDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? undefined : result;
}

router.get('/metrics/lifecycle', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const modelKey = typeof req.query.modelKey === 'string' ? req.query.modelKey : undefined;
    const result = modelKey
      ? lifecycleForModel(await loadContext(tenantId), modelKey)
      : await lifecycleForTenant(tenantId, {
      repositoryId: typeof req.query.repositoryId === 'string' ? req.query.repositoryId : undefined,
      pullRequestId: typeof req.query.pullRequestId === 'string' ? req.query.pullRequestId : undefined,
      contributorId: typeof req.query.contributorId === 'string' ? req.query.contributorId : undefined,
      from: optionalDate(req.query.from), to: optionalDate(req.query.to),
      });
    if (!result) { res.status(404).json({ error: 'Lifecycle scope not found' }); return; }
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/telemetry/models', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const models = new Map<string, { key: string; tool: string; model: string | null }>();
    for (const row of context.modelLifecycleEvents) {
      models.set(row.modelKey, { key: row.modelKey, tool: row.tool, model: row.model });
    }
    res.json([...models.values()].sort((left, right) =>
      `${left.tool}:${left.model ?? ''}`.localeCompare(`${right.tool}:${right.model ?? ''}`)));
  } catch (error) { next(error); }
});

router.get('/repositories/:id/lifecycle', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try { res.json(await lifecycleForTenant(tenantId, { repositoryId: req.params.id })); }
  catch (error) { next(error); }
});

router.get('/pull-requests/:id/lifecycle', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try { res.json(await lifecycleForTenant(tenantId, { pullRequestId: req.params.id })); }
  catch (error) { next(error); }
});

router.get('/contributors/:id/lifecycle', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const result = await lifecycleForTenant(tenantId, { contributorId: req.params.id });
    if (!result) { res.status(404).json({ error: 'Contributor not found' }); return; }
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/dashboard/summary', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const [tenantRow] = await db.select({ companyName: ssoTenants.companyName })
      .from(ssoTenants).where(eq(ssoTenants.id, tenantId)).limit(1);
    const lifecycleTotals = calculateLifecycleScopeTotals({
      commits: context.commits.map((commit) => ({
        id: commit.id,
        repositoryId: commit.repositoryId,
        reachability: commit.reachability,
        finalAiLines: audited(
          context.corrections,
          'commit',
          commit.id,
          'observedAiLines',
          commit.observedAiLines,
        ).auditedValue,
        finalHumanLines: audited(
          context.corrections,
          'commit',
          commit.id,
          'observedHumanLines',
          commit.observedHumanLines,
        ).auditedValue,
      })),
      commitSessions: context.commitSessions,
      sessionRepositories: context.sessionRepositories,
      allSessionIds: context.sessions.map((session) => session.id),
      repositoryIds: null,
      pullRequestCommitIds: null,
      contributorCommitIds: null,
      reworkRows: context.lifecycleEvents
        .filter((row) => row.stage === 'reworked' && isCommittedLineReworkEvidence(row.evidenceType))
        .map((row) => ({
          commitId: row.commitId,
          lineCount: row.lineCount,
          evidenceType: row.evidenceType,
        })),
    });
    res.json({
      organizationName: tenantRow?.companyName ?? 'Workspace',
      repositories: context.repositories.length, pullRequests: context.pullRequests.length,
      contributors: context.contributors.length, sessions: context.sessions.length,
      commits: context.commits.length,
      retainedCommits: lifecycleTotals.commits,
      historicalCommits: context.commits.length,
      finalAiLines: lifecycleTotals.finalAiLines,
      finalHumanLines: lifecycleTotals.finalHumanLines,
    });
  } catch (error) { next(error); }
});

export default router;
