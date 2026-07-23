import { Router, Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  scmCommitFiles,
  scmCommits,
  scmContributors,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
  ssoTenants,
  telemetryCorrections,
} from '../../core/db/schema';
import { applyAuditedValue } from './audit';

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

async function loadContext(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits, corrections] = await Promise.all([
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
  ]);
  return {
    repositories, pullRequests, contributors, sessions, sessionRepositories,
    usage, commits, files, commitSessions, pullRequestCommits,
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
      headRef: row.headRef, baseRef: row.baseRef, headSha: row.headSha,
      mergeCommitSha: row.mergeCommitSha, createdAt: row.createdAt.toISOString(),
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
      const tokens = usage.reduce((sum, row) => sum
        + (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
        + (row.reasoningTokens ?? 0) + (row.cacheReadTokens ?? 0)
        + (row.cacheWriteTokens ?? 0), 0);
      return {
        id: session.id,
        externalSessionId: session.externalSessionId,
        gitAiSessionId: session.gitAiSessionId,
        displayName: session.displayName,
        agent: session.tool,
        models: audited(context.corrections, 'session', session.id, 'observedModels', session.observedModels),
        status: session.status,
        startedAt: date(session.startedAt), endedAt: date(session.endedAt), repositories,
        commitCount: commitLinks.length,
        finalAiLines: commitLinks.reduce((sum, row) => sum + row.observedAiLines, 0),
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
      gitAiSessionId: session.gitAiSessionId, displayName: session.displayName,
      agent: session.tool,
      models: audited(context.corrections, 'session', session.id, 'observedModels', session.observedModels),
      humanAuthor: session.humanAuthor, status: session.status,
      startedAt: date(session.startedAt), endedAt: date(session.endedAt),
      repositories: context.repositories.filter((row) => repositoryIds.has(row.id))
        .map((row) => ({ id: row.id, name: row.name, url: row.url })),
      finalAiLines: links.reduce((sum, row) => sum + row.observedAiLines, 0),
      totalAiGeneratedLoc: { value: null, status: 'unavailable', reason: 'Gross generation semantics are deferred to Task2.' },
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
      };
    }));
  } catch (error) { next(error); }
});

router.get('/telemetry/commits/:id', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const commit = context.commits.find((row) => row.id === req.params.id);
    if (!commit) { res.status(404).json({ error: 'Commit not found' }); return; }
    const links = context.commitSessions.filter((row) => row.commitId === commit.id);
    res.json({
      id: commit.id, sha: commit.sha, subject: commit.subject, body: commit.body,
      branch: commit.branch, authorName: commit.authorName, authorEmail: commit.authorEmail,
      authoredAt: date(commit.authoredAt), committedAt: date(commit.committedAt),
      diffAddedLines: commit.diffAddedLines, diffDeletedLines: commit.diffDeletedLines,
      finalAiLines: audited(context.corrections, 'commit', commit.id, 'observedAiLines', commit.observedAiLines),
      finalHumanLines: audited(context.corrections, 'commit', commit.id, 'observedHumanLines', commit.observedHumanLines),
      unknownLines: commit.observedUnknownLines,
      totalAiGeneratedLoc: { value: null, status: 'unavailable', reason: 'Gross generation semantics are deferred to Task2.' },
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
    const commitIds = new Set(prLinks.map((row) => row.commitId));
    const commits = context.commits.filter((row) => commitIds.has(row.id));
    const sessionIds = new Set(context.commitSessions
      .filter((row) => commitIds.has(row.commitId)).map((row) => row.sessionId));
    const usage = context.usage.filter((row) => sessionIds.has(row.sessionId));
    const costByUnit = Array.from(usage.reduce((map, row) => {
      if (!row.costUnit || row.costAmount === null) return map;
      map.set(row.costUnit, (map.get(row.costUnit) ?? 0) + Number(row.costAmount));
      return map;
    }, new Map<string, number>())).map(([unit, amount]) => ({ unit, amount }));
    res.json({
      pullRequest: { id: pullRequest.id, title: pullRequest.title, state: pullRequest.state },
      commits: commits.map((row) => ({ id: row.id, sha: row.sha, subject: row.subject,
        match: prLinks.find((link) => link.commitId === row.id) })),
      sessions: context.sessions.filter((row) => sessionIds.has(row.id)).map((row) => ({
        id: row.id, externalSessionId: row.externalSessionId, agent: row.tool, models: row.observedModels,
      })),
      finalAiLines: commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedAiLines', row.observedAiLines).auditedValue, 0),
      finalHumanLines: commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedHumanLines', row.observedHumanLines).auditedValue, 0),
      tokens: {
        input: usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
        output: usage.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
        reasoning: usage.reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0),
        cacheRead: usage.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0),
        cacheWrite: usage.reduce((sum, row) => sum + (row.cacheWriteTokens ?? 0), 0),
      },
      costByUnit,
    });
  } catch (error) { next(error); }
});

router.get('/dashboard/summary', async (req, res, next) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const context = await loadContext(tenantId);
    const [tenantRow] = await db.select({ companyName: ssoTenants.companyName })
      .from(ssoTenants).where(eq(ssoTenants.id, tenantId)).limit(1);
    res.json({
      organizationName: tenantRow?.companyName ?? 'Workspace',
      repositories: context.repositories.length, pullRequests: context.pullRequests.length,
      contributors: context.contributors.length, sessions: context.sessions.length,
      commits: context.commits.length,
      finalAiLines: context.commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedAiLines', row.observedAiLines).auditedValue, 0),
      finalHumanLines: context.commits.reduce((sum, row) => sum + audited(context.corrections, 'commit', row.id, 'observedHumanLines', row.observedHumanLines).auditedValue, 0),
    });
  } catch (error) { next(error); }
});

export default router;
