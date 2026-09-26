import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { db, pool } from '../../core/db';
import {
  aiCodeLifecycleEvents,
  aiCommitSessions,
  scmCommits,
  scmRepositories,
  ssoTenants,
} from '../../core/db/schema';
import { validateOpenCodeEvidenceBatch } from './contract';
import { frictionAnalytics, ingestOpenCodeEvidence, setEvidenceConsent } from './service';
import { evidenceWorkspace, evidenceWorkStory } from './workspace';

let activeStage = 'startup';

async function main() {
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('This verification may run only against an explicitly ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task5-analytics-${randomUUID()}`;
  const actorId = `${marker}-admin`;
  const startedAt = new Date();

  activeStage = 'fixture_setup';
  const [tenant] = await db.insert(ssoTenants).values({
    companyName: 'Task5 analytics verification',
    domain: `${marker}.example.invalid`,
    supabaseProviderId: `${marker}-provider`,
    scmOrgIdentifier: `${marker}-org`,
  }).returning();
  const [repository] = await db.insert(scmRepositories).values({
    tenantId: tenant.id,
    provider: 'github',
    externalId: `${marker}-repository`,
    name: 'task5-analytics-verification',
    url: `https://example.invalid/${marker}.git`,
    normalizedUrl: `https://example.invalid/${marker}.git`,
  }).returning();
  await setEvidenceConsent({ tenantId: tenant.id, actorId, enabled: true });

  activeStage = 'friction_evidence';
  const event = (
    suffix: string,
    type: 'prompt' | 'response' | 'tool_call' | 'tool_result',
    offsetMs: number,
    content: unknown,
    metadata: Record<string, unknown> = {},
    toolName: string | null = null,
  ) => ({
    providerEventId: `${marker}-${suffix}`,
    type,
    occurredAt: new Date(startedAt.getTime() + offsetMs).toISOString(),
    traceId: `${marker}-trace`,
    model: 'task5-local-model',
    toolName,
    content,
    metadata,
  });
  const productive = await ingestOpenCodeEvidence({
    tenantId: tenant.id,
    now: startedAt,
    batch: validateOpenCodeEvidenceBatch({
      provider: 'opencode',
      batchId: `${marker}-productive-batch`,
      sourceVersion: 'git-ai/opencode-evidence/1',
      repositoryId: repository.id,
      externalSessionId: `${marker}-productive-session`,
      gitAiSessionId: `${marker}-productive-git-ai-session`,
      intention: 'Prevent concurrent password recovery tokens from colliding',
      events: [
        event('prompt-1', 'prompt', 0, 'Investigate recovery concurrency'),
        event('prompt-2', 'prompt', 1_000, 'Try a transaction-based approach'),
        event('tests:call', 'tool_call', 2_000, 'npm test', { attempt: 1 }, 'shell'),
        event('tests:result', 'tool_result', 37_000, 'Synthetic failure', {
          status: 'failed', durationMs: 35_000, errorCode: 'SYNTHETIC_TEST_FAILURE',
        }, 'shell'),
        event('retry:call', 'tool_call', 38_000, 'npm test', { attempt: 2 }, 'shell'),
        event('response', 'response', 39_000, 'Synthetic response'),
      ],
    }),
  });
  const abandoned = await ingestOpenCodeEvidence({
    tenantId: tenant.id,
    now: startedAt,
    batch: validateOpenCodeEvidenceBatch({
      provider: 'opencode',
      batchId: `${marker}-abandoned-batch`,
      sourceVersion: 'git-ai/opencode-evidence/1',
      repositoryId: repository.id,
      externalSessionId: `${marker}-abandoned-session`,
      gitAiSessionId: `${marker}-abandoned-git-ai-session`,
      intention: 'Explore an alternative recovery-token cache',
      events: [event('abandoned', 'prompt', 40_000, 'Synthetic abandoned exploration', { abandoned: true })],
    }),
  });
  if (!productive.intentionId || !abandoned.intentionId) throw new Error('intentions_were_not_created');

  activeStage = 'commit_and_rework';
  const [commit] = await db.insert(scmCommits).values({
    tenantId: tenant.id,
    repositoryId: repository.id,
    sha: 'b'.repeat(40),
    branch: 'feature/task5-analytics',
    subject: 'Prevent recovery token collisions',
    committedAt: startedAt,
    diffAddedLines: 24,
    observedAiLines: 20,
  }).returning();
  await db.insert(aiCommitSessions).values({
    tenantId: tenant.id,
    commitId: commit.id,
    sessionId: productive.sessionId,
    observedAiLines: 20,
  });
  await db.insert(aiCodeLifecycleEvents).values({
    tenantId: tenant.id,
    repositoryId: repository.id,
    sessionId: productive.sessionId,
    commitId: commit.id,
    stage: 'reworked',
    lineCount: 14,
    actorKind: 'ai',
    evidenceType: 'task5_synthetic_verification',
    evidenceRef: `${marker}-rework`,
    confidence: 100,
    occurredAt: new Date(startedAt.getTime() + 45_000),
  });

  activeStage = 'analytics_assertions';
  const rows = await frictionAnalytics(tenant.id);
  const productiveRow = rows.find(row => row.sessionId === productive.sessionId);
  const abandonedRow = rows.find(row => row.sessionId === abandoned.sessionId);
  if (!productiveRow
    || productiveRow.failedToolCalls !== 1
    || productiveRow.retries !== 1
    || productiveRow.slowToolCalls !== 1
    || productiveRow.promptLoops !== 1
    || productiveRow.unmatchedToolCalls !== 1
    || productiveRow.reworkedLines !== 14
    || productiveRow.weakOutcome) {
    throw new Error('productive_session_friction_was_incorrect');
  }
  if (!abandonedRow || !abandonedRow.abandoned || !abandonedRow.weakOutcome) {
    throw new Error('abandoned_weak_outcome_was_not_detected');
  }

  activeStage = 'customer_story';
  const story = await evidenceWorkStory({ tenantId: tenant.id, rootType: 'commit', rootId: commit.id });
  if (!story
    || story.insights.failedTools !== 1
    || story.insights.retries !== 1
    || story.insights.slowTools !== 1
    || story.insights.promptLoops !== 1
    || story.insights.reworkedLines !== 14
    || story.summary.keyInsight !== '1 failed tool operation needs review.'
    || !story.insights.tests.some(test => test.status === 'failed')
    || !story.insights.tests.some(test => test.status === 'unknown')
    || !story.insights.unresolved.includes('1 failed tool operation')
    || !story.insights.unresolved.includes('A captured test command failed')) {
    throw new Error('customer_story_insights_were_incorrect');
  }
  const workspace = await evidenceWorkspace(tenant.id, { limit: 20 });
  if (!workspace.unfinishedWork.items.some(item => item.id === abandoned.intentionId
    && item.outcome === 'unfinished')) {
    throw new Error('abandoned_intention_was_not_presented_as_unfinished');
  }

  console.log('failed_retried_slow_tools=verified');
  console.log('prompt_loop_and_unmatched_tool=verified');
  console.log('task2_rework_projection=verified');
  console.log('abandoned_weak_outcome=verified');
  console.log('test_failure_and_unknown_status=verified');
  console.log('customer_story_insight_priority=verified');
  console.log('task5_analytics_live_verification=passed');
}

void main().catch(error => {
  console.log('task5_analytics_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`safe_error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
