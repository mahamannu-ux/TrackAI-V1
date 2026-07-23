import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions, aiSessionRepositories, aiSessions, aiSessionUsage,
  scmCommitFiles, scmCommits, scmRepositories, ssoTenants, telemetryCorrections,
} from '../../core/db/schema';
import { task1Commits, task1Sessions } from './task1-seed-data';
import { normalizeRepositoryUrl, repositoryIdentity } from './repository-url';

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const domain = (argument('tenant-domain') ?? '').toLowerCase();
  const dryRun = process.argv.includes('--dry-run');
  if (!domain) throw new Error('--tenant-domain is required');
  const plan = {
    tenantDomain: domain, repositories: 1, commits: task1Commits.length,
    sessions: task1Sessions.length, shippedSessions: task1Sessions.filter((row) => row.status === 'shipped').length,
    usageRows: task1Sessions.length + task1Sessions.filter((row) => row.usage).length,
    corrections: 4, excludes: ['all disposable B4 branches', 'raw prompt text'],
  };
  if (dryRun) { console.log(JSON.stringify({ dryRun: true, plan }, null, 2)); return; }

  const [tenant] = await db.select({ id: ssoTenants.id }).from(ssoTenants)
    .where(eq(ssoTenants.domain, domain)).limit(1);
  if (!tenant) throw new Error(`No tenant registered for ${domain}`);
  const tenantDb = withTenant(db, tenant.id);
  const repoIdentity = repositoryIdentity('https://github.com/mahamannu-ai/git-ai-teamz-lab');
  const existingRepositories = await tenantDb.select(scmRepositories);
  const matchingRepository = existingRepositories.find((row) => {
    if (row.normalizedUrl === repoIdentity.normalizedUrl) return true;
    try { return normalizeRepositoryUrl(row.url) === repoIdentity.normalizedUrl; }
    catch { return false; }
  });
  const [repository] = matchingRepository
    ? await tenantDb.update(scmRepositories, {
      normalizedUrl: repoIdentity.normalizedUrl,
      name: repoIdentity.name,
      url: repoIdentity.canonicalUrl,
    }, eq(scmRepositories.id, matchingRepository.id))
    : await tenantDb.upsert(scmRepositories, {
      provider: repoIdentity.provider, externalId: repoIdentity.externalId,
      name: repoIdentity.name, url: repoIdentity.canonicalUrl, normalizedUrl: repoIdentity.normalizedUrl,
    }, [scmRepositories.tenantId, scmRepositories.normalizedUrl], {
      name: repoIdentity.name, url: repoIdentity.canonicalUrl,
    });
  if (!repository) throw new Error('Repository seed failed');

  const seededSessions = new Map<string, typeof aiSessions.$inferSelect>();
  for (const row of task1Sessions) {
    const [session] = await tenantDb.upsert(aiSessions, {
      externalSessionId: row.externalId, gitAiSessionId: row.gitAiId,
      tool: row.tool, displayName: row.name, observedModels: row.observedModels,
      status: row.status,
    }, [aiSessions.tenantId, aiSessions.tool, aiSessions.externalSessionId], {
      gitAiSessionId: row.gitAiId, displayName: row.name,
      observedModels: row.observedModels, status: row.status,
    });
    if (!session) throw new Error(`Session seed failed: ${row.externalId}`);
    seededSessions.set(row.externalId, session);
    await tenantDb.insertDoNothing(aiSessionRepositories,
      { sessionId: session.id, repositoryId: repository.id },
      [aiSessionRepositories.tenantId, aiSessionRepositories.sessionId, aiSessionRepositories.repositoryId]);
    await tenantDb.upsert(aiSessionUsage, {
      sessionId: session.id, model: row.observedModels[0] ?? null,
      availability: 'unavailable', evidenceSource: 'git_ai_observed',
      evidenceKey: `seed:git-ai-unavailable:${row.externalId}`,
    }, [aiSessionUsage.tenantId, aiSessionUsage.evidenceKey], { availability: 'unavailable' });
    if (row.usage) {
      await tenantDb.upsert(aiSessionUsage, {
        sessionId: session.id, model: row.usage.model,
        inputTokens: row.usage.input, outputTokens: row.usage.output,
        reasoningTokens: row.usage.reasoning, cacheReadTokens: row.usage.cacheRead,
        cacheWriteTokens: row.usage.cacheWrite, costAmount: String(row.usage.cost),
        costUnit: row.usage.unit, availability: 'recorded',
        evidenceSource: 'provider_audited', evidenceKey: `seed:provider:${row.externalId}`,
      }, [aiSessionUsage.tenantId, aiSessionUsage.evidenceKey], {
        inputTokens: row.usage.input, outputTokens: row.usage.output,
        reasoningTokens: row.usage.reasoning, cacheReadTokens: row.usage.cacheRead,
        cacheWriteTokens: row.usage.cacheWrite, costAmount: String(row.usage.cost),
        costUnit: row.usage.unit, availability: 'recorded',
      });
    }
  }

  const seededCommits = new Map<string, typeof scmCommits.$inferSelect>();
  for (const row of task1Commits) {
    const [commit] = await tenantDb.upsert(scmCommits, {
      repositoryId: repository.id, sha: row.sha, branch: 'main',
      authorName: 'Teamz Lab', authorEmail: 'teamz-lab@example.invalid',
      subject: row.subject, diffAddedLines: row.added, diffDeletedLines: row.deleted,
      observedAiLines: row.ai, observedHumanLines: row.human,
      observedUnknownLines: row.unknown,
    }, [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha], {
      subject: row.subject, diffAddedLines: row.added, diffDeletedLines: row.deleted,
      observedAiLines: row.ai, observedHumanLines: row.human, observedUnknownLines: row.unknown,
    });
    if (!commit) throw new Error(`Commit seed failed: ${row.sha}`);
    seededCommits.set(row.sha, commit);
    for (const file of row.files) {
      await tenantDb.upsert(scmCommitFiles, {
        commitId: commit.id, path: file.path, observedAiLines: file.ai,
        observedHumanLines: file.human, attributionRanges: file.ranges,
      }, [scmCommitFiles.tenantId, scmCommitFiles.commitId, scmCommitFiles.path], {
        observedAiLines: file.ai, observedHumanLines: file.human, attributionRanges: file.ranges,
      });
    }
    for (const link of row.sessions) {
      const session = seededSessions.get(link.externalId);
      if (!session) throw new Error(`Missing session for commit: ${link.externalId}`);
      await tenantDb.upsert(aiCommitSessions, {
        commitId: commit.id, sessionId: session.id, observedAiLines: link.ai,
      }, [aiCommitSessions.tenantId, aiCommitSessions.commitId, aiCommitSessions.sessionId], {
        observedAiLines: link.ai,
      });
    }
  }

  const modelSession = seededSessions.get('ses_07aa4025cffeURaVSPGxAfguCM')!;
  const copilotCommit = seededCommits.get('babc2ea33e4a85b0c982cfab57faa40434b9c687')!;
  const corrections = [
    { targetType: 'session', targetKey: modelSession.id, fieldName: 'observedModels',
      correctedValue: ['nemotron-3-ultra-free', 'deepseek-v4-flash-free'],
      reason: 'Provider evidence shows an in-session model switch that Git AI attributed to the stale model.', evidenceRef: 'Task1:OpenCode-model-switch' },
    { targetType: 'commit', targetKey: copilotCommit.id, fieldName: 'observedAiLines', correctedValue: 1,
      reason: 'Copilot multi-file operation recorded one AI line as human.', evidenceRef: 'Task1:Copilot-multifile' },
    { targetType: 'commit', targetKey: copilotCommit.id, fieldName: 'observedHumanLines', correctedValue: 0,
      reason: 'Copilot multi-file operation recorded one AI line as human.', evidenceRef: 'Task1:Copilot-multifile' },
    { targetType: 'commit', targetKey: copilotCommit.id, fieldName: 'auditedSessionExternalId',
      correctedValue: '5c23eb69-1244-4861-9791-1fe81b4d3c44',
      reason: 'Provider operation and checkpoint timing associate the edit with Copilot.', evidenceRef: 'Task1:Copilot-multifile' },
  ];
  for (const row of corrections) {
    await tenantDb.upsert(telemetryCorrections, row,
      [telemetryCorrections.tenantId, telemetryCorrections.targetType,
        telemetryCorrections.targetKey, telemetryCorrections.fieldName],
      { correctedValue: row.correctedValue, reason: row.reason, evidenceRef: row.evidenceRef });
  }
  console.log(JSON.stringify({ dryRun: false, applied: plan }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
