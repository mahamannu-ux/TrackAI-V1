import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseGitHubWebhook } from '../scm/parser';
import { planMergedByBackfill } from '../scm/task19g-merged-by-backfill';
import { rejectionAuditDetails } from '../telemetry/ingest.routes';
import type { GitAiMetricsBatch } from '../telemetry/types';
import { createAnswererRegistry } from './answerers';
import { answerQuestion } from './service';
import { computeQ6 } from './answers/q06';
import { computeQ15 } from './answers/q15';
import { createQ2Answerer, resolveOriginCommit } from './answers/q02';
import type { QaContext } from './answers/common';

const tenantA = randomUUID();
const tenantB = randomUUID();
const repoA = randomUUID();
const prId = randomUUID();
const commitId = randomUUID();
const fileId = randomUUID();
const now = new Date('2026-10-19T12:00:00.000Z');
const row = <T>(value: Record<string, unknown>) => value as unknown as T;

function webhook(mergedBy: unknown, mergedAt: string | null = now.toISOString()) {
  return {
    action: 'closed', repository: {
      id: 1, name: 'repo', html_url: 'https://github.com/example/repo', owner: { login: 'example' },
    },
    pull_request: {
      id: 7, number: 5, title: 'PR', state: 'closed', merged_at: mergedAt,
      updated_at: now.toISOString(), user: { id: 21, login: 'author' }, merged_by: mergedBy,
    },
  };
}

test('merged-by parser captures only merged closed PRs and backfill plans only nulls', () => {
  const parsed = parseGitHubWebhook({ 'x-github-event': 'pull_request' }, webhook({ id: 42, login: 'merger' }));
  assert.equal(parsed?.pullRequest?.mergedByProviderId, '42');
  assert.equal(parsed?.pullRequest?.mergedByLogin, 'merger');
  assert.equal(parseGitHubWebhook({ 'x-github-event': 'pull_request' }, webhook({ id: 42, login: 'merger' }, null))
    ?.pullRequest?.mergedByProviderId, null);
  assert.equal(parseGitHubWebhook({ 'x-github-event': 'pull_request' }, webhook(null))
    ?.pullRequest?.mergedByProviderId, null);
  const delivery = row<Parameters<typeof planMergedByBackfill>[1][number]>({
    tenantId: tenantA, provider: 'github', eventType: 'pr_closed', repositoryId: repoA,
    rawEvent: webhook({ id: 42, login: 'merger' }), receivedAt: now,
  });
  const repository = row<Parameters<typeof planMergedByBackfill>[2][number]>({ id: repoA, externalId: '1' });
  const missing = row<Parameters<typeof planMergedByBackfill>[3][number]>({
    id: prId, repositoryId: repoA, externalId: '7', mergedByProviderId: null, mergedByLogin: null,
  });
  assert.equal(planMergedByBackfill(tenantA, [delivery], [repository], [missing]).candidates.length, 1);
  assert.equal(planMergedByBackfill(tenantA, [delivery], [repository],
    [{ ...missing, mergedByProviderId: '42', mergedByLogin: 'merger' }]).candidates.length, 0);
});

test('rejection details map all four reasons and contain digests only', () => {
  const batch: GitAiMetricsBatch = { v: 1, events: Array.from({ length: 4 }, () => ({
    t: 1, e: 1, v: {}, a: { '1': 'https://github.com/Example/Repo' },
  })) };
  const messages = [
    'Repository is required for managed machine telemetry', 'Repository URL is invalid',
    'Machine repository or branch grant is not active',
    'Evidence predates the repository enrollment watermark',
  ];
  const details = rejectionAuditDetails(batch, messages.map((error, index) => ({ index, error })));
  assert.deepEqual(details.reason_counts, {
    repository_missing: 1, repository_url_invalid: 1, grant_inactive: 1, before_watermark: 1,
  });
  assert.equal(details.event_count, 4);
  assert.equal(details.repository_digests.length, 1);
  assert.match(details.repository_digests[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(details), /github|Example|Repo|https|\/|\\/);
  const many: GitAiMetricsBatch = { v: 1, events: Array.from({ length: 21 }, (_, index) => ({
    t: index + 1, e: 1, v: {}, a: { '1': `https://github.com/example/repo-${index}` },
  })) };
  const capped = rejectionAuditDetails(many, many.events.map((_, index) => ({
    index, error: messages[2],
  })));
  assert.equal(capped.repository_digests.length, 20);
});

const context = row<QaContext>({
  repositories: [{ id: repoA, name: 'repo' }],
  pullRequests: [{ id: prId, repositoryId: repoA, state: 'merged', mergedAt: now,
    mergedByProviderId: '42', authorProviderId: '21', mergeCommitSha: 'a'.repeat(40), number: 5 }],
  commits: [{ id: commitId, repositoryId: repoA, sha: 'a'.repeat(40), observedAiLines: 5,
    observedHumanLines: 2, authorEmail: 'hidden@example.com', reachability: 'reachable' }],
  pullRequestCommits: [{ pullRequestId: prId, commitId }],
  memberships: [], commitSessions: [], sessions: [], usage: [], lifecycleEvents: [],
  contributors: [], sessionRepositories: [], files: [], generationObservations: [],
  commitLineage: [], mergeLineage: [], deployments: [], commitModelAttributions: [],
  modelLifecycleEvents: [], corrections: new Map(),
});

const scopes = {
  repositoryExists: async (tenantId: string, id: string) => tenantId === tenantA && id === repoA,
  pullRequestRepository: async (tenantId: string, id: string) => tenantId === tenantA && id === prId ? repoA : null,
  commitExists: async () => false,
};

test('Q6 validates through answerQuestion, counts the merger without naming people, isolates tenant', async () => {
  const answerers = createAnswererRegistry();
  answerers.register('Q6', 'live', async (ctx) => computeQ6({ context, ctx }));
  const request = { tenantId: tenantA, role: 'tenant_admin' as const, questionId: 'Q6',
    query: { kind: 'live', repository_id: repoA, from: '2026-10-18T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z' }, now };
  const answer = await answerQuestion({ answerers, scopes }, request);
  assert.equal(answer.figures.find((figure) => figure.key === 'merged_by_someone_else')?.value?.type, 'count');
  assert.equal(answer.figures.find((figure) => figure.key === 'ai_assisted_merged_prs')?.value?.type, 'count');
  assert.doesNotMatch(JSON.stringify(answer), /hidden@example|"authorLogin"|"mergedByLogin"|\/repo/);
  await assert.rejects(answerQuestion({ answerers, scopes }, { ...request, tenantId: tenantB }),
    (error: Error & { code?: string }) => error.code === 'QA_SCOPE_NOT_FOUND');
  const unknownContext = row<QaContext>({ ...context,
    pullRequests: [{ ...context.pullRequests[0], mergedByProviderId: null, mergedByLogin: null }] });
  const beforeAnswerers = createAnswererRegistry();
  beforeAnswerers.register('Q6', 'live', async (ctx) => computeQ6({ context: unknownContext, ctx }));
  const before = await answerQuestion({ answerers: beforeAnswerers, scopes }, request);
  assert.equal(before.figures.find((figure) => figure.key === 'merged_by_author')?.availability, 'partial');
  const afterAnswerers = createAnswererRegistry();
  afterAnswerers.register('Q6', 'live', async (ctx) => computeQ6({ context: unknownContext, ctx }, true));
  const after = await answerQuestion({ answerers: afterAnswerers, scopes }, request);
  assert.equal(after.figures.find((figure) => figure.key === 'merged_by_author')?.availability, 'recorded');
  assert.deepEqual(after.figures.find((figure) => figure.key === 'merger_unknown')?.value,
    { type: 'count', count: 1 });
});

test('Q15 is unavailable before capture, then recorded; Company B has no A rows', async () => {
  const answerers = createAnswererRegistry();
  let rows: Parameters<typeof computeQ15>[1] = [];
  answerers.register('Q15', 'live', async (ctx) => computeQ15(ctx, rows.filter((row) => row.tenantId === ctx.tenantId)));
  const request = { tenantId: tenantA, role: 'tenant_admin' as const, questionId: 'Q15',
    query: { kind: 'live', from: '2026-10-18T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' }, now };
  const before = await answerQuestion({ answerers, scopes }, request);
  assert.equal(before.availability, 'unavailable');
  assert.deepEqual(before.reasons, [{ code: 'not_captured_yet', gap: 'G5' }]);
  assert.ok(before.figures.every((figure) => figure.availability === 'unavailable' && figure.value === null));
  rows = [row({ tenantId: tenantA, action: 'telemetry.upload.rejected', actorId: randomUUID(),
    occurredAt: now, details: { event_count: 2, reason_counts: { grant_inactive: 2 },
      repository_digests: ['a'.repeat(64)] } })];
  const after = await answerQuestion({ answerers, scopes }, request);
  assert.equal(after.availability, 'partial');
  assert.equal(after.figures.find((figure) => figure.key === 'rejected_events')?.availability, 'partial');
  assert.deepEqual(after.figures.find((figure) => figure.key === 'rejected_events')?.value,
    { type: 'count', count: 2 });
  const other = await answerQuestion({ answerers, scopes }, { ...request, tenantId: tenantB });
  assert.equal(other.availability, 'unavailable');
  const historical = await answerQuestion({ answerers, scopes }, { ...request,
    query: { ...request.query, from: '2026-10-17T00:00:00.000Z',
      to: '2026-10-18T00:00:00.000Z' } });
  assert.equal(historical.availability, 'unavailable');
  assert.deepEqual(historical.reasons, [{ code: 'not_captured_yet', gap: 'G5' }]);
  assert.ok(historical.figures.every((figure) => figure.availability === 'unavailable' && figure.value === null));
  rows = [row({ ...rows[0], details: { event_count: 2, reason_counts: { grant_inactive: 2 },
    repository_digests: Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, '0')) } })];
  const truncated = await answerQuestion({ answerers, scopes }, { ...request,
    query: { ...request.query, from: now.toISOString() } });
  assert.equal(truncated.figures.find((figure) => figure.key === 'rejected_repositories')?.availability, 'partial');
  assert.equal(truncated.reasons[0]?.code, 'evidence_truncated');
});

test('Q2 exact, rewritten, unknown, and non-GitHub answers validate without exposing path', async () => {
  const sha = 'a'.repeat(40);
  const previousSha = 'b'.repeat(40);
  const missingSha = 'c'.repeat(40);
  const path = 'src/private/customer-file.ts';
  const priorCommitId = randomUUID();
  const source = row<QaContext>({ ...context,
    repositories: [{ id: repoA, provider: 'github', url: 'https://github.com/example/repo' }],
    commits: [...context.commits, { ...context.commits[0], id: priorCommitId, sha: previousSha }],
    files: [{ id: fileId, commitId, path, attributionRanges: [
      { kind: 'ai', startLine: 1, endLine: 5, sessionId: 'git-ai-session' },
    ], observedAiLines: 5, observedHumanLines: 2 },
    { id: randomUUID(), commitId: priorCommitId, path, attributionRanges: [],
      observedAiLines: 3, observedHumanLines: 1 }],
    sessions: [{ id: randomUUID(), gitAiSessionId: 'git-ai-session' }],
    commitLineage: [{ repositoryId: repoA, predecessorSha: previousSha, successorSha: sha }],
  });
  assert.equal(resolveOriginCommit(source, repoA, previousSha)?.id, priorCommitId);
  let originSha: string | null = sha;
  const answerers = createAnswererRegistry();
  answerers.register('Q2', 'live', createQ2Answerer(async () => source,
    async () => ({ status: 'ok', originSha })));
  const q2Scopes = { ...scopes, commitExists: async (tenant: string) => tenant === tenantA,
    fileInCommit: async (tenant: string, _repo: string, _sha: string, id: string) =>
      tenant === tenantA && id === fileId };
  const request = { tenantId: tenantA, role: 'tenant_admin' as const, questionId: 'Q2',
    query: { kind: 'live', repository_id: repoA, commit_sha: sha, file_id: fileId, line: '3' }, now };
  const exact = await answerQuestion({ answerers, scopes: q2Scopes }, request);
  assert.deepEqual(exact.figures.find((figure) => figure.key === 'line_written_by_ai')?.value,
    { type: 'count', count: 1 });
  assert.equal(exact.availability, 'recorded');
  assert.equal(exact.drilldown.filter((item) => item.scope === 'session').length, 1);
  assert.doesNotMatch(JSON.stringify(exact), /customer-file|src\/private|example\/repo/);
  originSha = previousSha;
  const partial = await answerQuestion({ answerers, scopes: q2Scopes }, request);
  assert.equal(partial.availability, 'partial');
  assert.equal(partial.figures.find((figure) => figure.key === 'line_written_by_ai')?.value, null);
  originSha = missingSha;
  const unknown = await answerQuestion({ answerers, scopes: q2Scopes }, request);
  assert.equal(unknown.availability, 'unavailable');
  const nonGitHub = row<QaContext>({ ...source,
    repositories: [{ id: repoA, provider: 'gitlab', url: 'https://gitlab.com/example/repo' }] });
  const unsupportedAnswerers = createAnswererRegistry();
  unsupportedAnswerers.register('Q2', 'live', createQ2Answerer(async () => nonGitHub,
    async () => { throw new Error('should not call GitHub'); }));
  const unsupported = await answerQuestion({ answerers: unsupportedAnswerers, scopes: q2Scopes }, request);
  assert.equal(unsupported.availability, 'unavailable');
  assert.equal(unsupported.reasons[0]?.code, 'answer_not_built');
  await assert.rejects(answerQuestion({ answerers, scopes: q2Scopes },
    { ...request, tenantId: tenantB }),
  (error: Error & { code?: string }) => error.code === 'QA_SCOPE_NOT_FOUND');
  await assert.rejects(answerQuestion({ answerers, scopes: q2Scopes },
    { ...request, questionId: 'Q6' }),
  (error: Error & { code?: string }) => error.code === 'QA_SCOPE_INVALID');
});

test('Q2 provider timeout becomes QA_UNAVAILABLE', async () => {
  const source = row<QaContext>({ ...context,
    repositories: [{ id: repoA, provider: 'github', url: 'https://github.com/example/repo' }],
    files: [{ id: fileId, commitId, path: 'private/path.ts', attributionRanges: [] }],
  });
  const answerers = createAnswererRegistry();
  answerers.register('Q2', 'live', createQ2Answerer(async () => source,
    async () => { throw new Error('timeout'); }));
  await assert.rejects(answerQuestion({ answerers,
    scopes: { ...scopes, commitExists: async () => true, fileInCommit: async () => true },
  }, { tenantId: tenantA, role: 'tenant_admin', questionId: 'Q2',
    query: { kind: 'live', repository_id: repoA, commit_sha: 'a'.repeat(40),
      file_id: fileId, line: '3' }, now }),
  (error: Error & { code?: string }) => error.code === 'QA_UNAVAILABLE'
    && !error.message.includes('private/path.ts'));
});
