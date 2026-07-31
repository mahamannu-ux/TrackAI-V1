import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointDeletionMatchesCommitFiles, decodeAiAuthoredDeletionLines, decodeAttributes, decodeCheckpointValues, decodeDeletionFilePaths, decodeOtelUsage, decodeRewriteValues, decodeSessionUsage, validateMetricEvent, validateMetricsBatch } from './decoder';
import { normalizeRepositoryUrl } from './repository-url';
import { parseAuthorshipNote } from './authorship-note';
import { parseIngestTokenMap, resolveTenantForToken } from '../../core/middleware/machine-auth';
import { parseGitHubWebhook } from '../scm/parser';
import { selectPullRequestMatch } from './pr-matching';
import { applyAuditedValue } from './audit';
import {
  aggregateExternalSessionLines,
  calculateLifecycleScopeTotals,
  calculateLifecycleSummary,
  checkpointDeletionBuckets,
  checkpointLifecycleLines,
  committedLinesForOperation,
  contributorMatchesCommit,
  currentRetainedAiLines,
  rewriteRetainsGenerationEvidence,
  currentRetainedAiLinesForCommit,
  diffCommitMembership,
  fallbackSessionName,
  generationEvidenceMetric,
  generationEvidenceForScope,
  generationCoverageForScope,
  lifecycleEvidenceForPullRequest,
  lifecycleEvidenceMatchesPullRequestScope,
  NORMALIZED_COMMIT_REACHABILITY,
  operationSupersedesPredecessor,
  shouldAbandonSiblingTip,
} from './lifecycle';
import { githubCommitMetadata, inferMergeMethod, mapRebasedResultCommits, uniquePullRequestForDeploymentSource } from '../scm/lifecycle-service';
import { repositoryIsInTenantScope } from './repository-scope';
import { allocateReworkByOriginModel, modelAttributionsFromNote, modelKey } from './model-lifecycle';
import { evidenceFlowEnabled, normalizeOpenCodeEvidence } from './opencode-evidence';
import {
  evaluateManagedMachineIngestionPolicy,
  partitionAuthorizedMetricsBatch,
  remapAuthorizedUploadErrors,
  validateManagedMachineRepositoryScope,
} from './repository-enforcement';
import {
  classifyProviderProjectionEvent,
  classifyProviderDeliveryState,
  classifyProviderDeliveryCollision,
  normalizeProviderDeliveryId,
  planProviderDeliveryClaim,
  providerDeliveryCanBeClaimed,
  providerEventFingerprint,
  providerProjectionIdentity,
} from '../scm/provider-event';
import { evaluateEvidenceWatermark } from './watermark-policy';

test('enrollment watermarks separate current delayed backfill and rejected evidence', () => {
  const watermarks = {
    generationSessionFrom: new Date('2026-07-31T10:00:00Z'),
    commitNoteFrom: new Date('2026-07-01T00:00:00Z'),
  };
  const receivedAt = new Date('2026-07-31T10:10:00Z');
  const event = (time: string, kind: number) => ({
    t: Math.floor(new Date(time).getTime() / 1000), e: kind, v: {}, a: {},
  });

  assert.equal(evaluateEvidenceWatermark({
    event: event('2026-07-31T10:09:00Z', 5), watermarks, receivedAt,
  }).arrivalClass, 'current');
  assert.equal(evaluateEvidenceWatermark({
    event: event('2026-07-31T10:01:00Z', 5), watermarks, receivedAt,
  }).arrivalClass, 'delayed');
  assert.equal(evaluateEvidenceWatermark({
    event: event('2026-07-30T12:00:00Z', 5), watermarks, receivedAt,
  }).arrivalClass, 'rejected');
  assert.equal(evaluateEvidenceWatermark({
    event: event('2026-07-30T12:00:00Z', 5), watermarks, receivedAt,
    authorization: {
      evidenceFamily: 'generation_session',
      occurredFrom: new Date('2026-07-30T00:00:00Z'),
      occurredUntil: new Date('2026-07-30T23:59:59Z'),
      expiresAt: new Date('2026-07-31T11:00:00Z'),
    },
  }).arrivalClass, 'backfill');
  assert.equal(evaluateEvidenceWatermark({
    event: event('2026-06-30T23:59:59Z', 1), watermarks, receivedAt,
    authorization: {
      evidenceFamily: 'generation_session',
      occurredFrom: new Date('2026-06-01T00:00:00Z'),
      occurredUntil: new Date('2026-06-30T23:59:59Z'),
      expiresAt: new Date('2026-07-31T11:00:00Z'),
    },
  }).arrivalClass, 'rejected');
});

test('decodes sparse Git AI positions without shifting missing values', () => {
  const attrs = decodeAttributes({ '1': 'git@github.com:Acme/Repo.git', '20': 'opencode', '21': 'model-x', '23': 'external-1', '24': 's_internal' });
  assert.equal(attrs.repoUrl, 'git@github.com:Acme/Repo.git');
  assert.equal(attrs.externalSessionId, 'external-1');
  assert.equal(attrs.sessionId, 's_internal');
  assert.equal(attrs.author, null);
});

test('accepts future event kinds for immutable raw preservation', () => {
  assert.equal(validateMetricEvent({ t: 1, e: 99, v: {}, a: {} }).e, 99);
  assert.throws(() => validateMetricEvent({ t: -1, e: 1, v: {}, a: {} }));
  assert.throws(() => validateMetricsBatch({ v: 1, events: Array(1001).fill({}) }), /1000/);
});

test('decodes provider usage while preserving unavailable categories as null', () => {
  const usage = decodeSessionUsage({ t: 1, e: 5, a: {}, v: { '0': { role: 'assistant', modelID: 'deepseek-v4', tokens: { input: 10, output: 4, cache: { read: 7 } }, cost: 0.5 } } });
  assert.deepEqual(usage, { model: 'deepseek-v4', inputTokens: 10, outputTokens: 4, reasoningTokens: null,
    cacheReadTokens: 7, cacheWriteTokens: null, costAmount: 0.5, costUnit: 'USD', externalEventId: null });
});

test('decodes Copilot OTEL usage and preserves its native nano-AIU cost unit', () => {
  const usage = decodeOtelUsage({
    t: 1,
    e: 6,
    a: { '20': 'github-copilot', '23': 'copilot-session' },
    v: {
      '0': {
        span: {
          operation_name: 'chat', response_model: 'gpt-5.6-luna-free-auto',
          input_tokens: 17361, output_tokens: 195, reasoning_tokens: 23, cached_tokens: 0,
        },
        attributes: { 'copilot_chat.copilot_usage_nano_aiu': '2287050000' },
      },
      '1': 'span-id',
    },
  });
  assert.deepEqual(usage, {
    model: 'gpt-5.6-luna-free-auto', inputTokens: 17361, outputTokens: 195,
    reasoningTokens: 23, cacheReadTokens: 0, cacheWriteTokens: null,
    costAmount: 2287050000, costUnit: 'copilot_nano_aiu', externalEventId: 'span-id',
  });
});

test('normalizes HTTPS, SSH and SCP repository URLs identically', () => {
  const expected = 'github.com/mahamannu-ai/git-ai-teamz-lab';
  assert.equal(normalizeRepositoryUrl('https://github.com/Mahamannu-AI/git-ai-teamz-lab.git'), expected);
  assert.equal(normalizeRepositoryUrl('git@github.com:mahamannu-ai/git-ai-teamz-lab.git'), expected);
  assert.equal(normalizeRepositoryUrl('ssh://git@github.com/mahamannu-ai/git-ai-teamz-lab'), expected);
});

test('repository scope blocks cross-tenant native telemetry after a key switch', () => {
  const enrolled = new Set(['github.com/mahamannu-ux/trackai-v1']);
  assert.equal(repositoryIsInTenantScope(
    'github.com/mahamannu-ux/trackai-v1', enrolled, 'mahamannu-ai',
  ), true);
  assert.equal(repositoryIsInTenantScope(
    'github.com/mahamannu-ai/new-repo', enrolled, 'mahamannu-ai',
  ), true);
  assert.equal(repositoryIsInTenantScope(
    'github.com/customer-b-corp-ai/concurrency_engine_for_webhook_tests',
    enrolled,
    'mahamannu-ai',
  ), false);
});

test('managed machine scope enforces repository and branch for every metric event', async () => {
  const checked: Array<[string, string | null]> = [];
  const batch = validateMetricsBatch({
    v: 1,
    events: [
      { t: 1, e: 1, v: {}, a: { '1': 'git@github.com:Company-A/repo.git', '5': 'main' } },
      { t: 2, e: 1, v: {}, a: { '1': 'https://github.com/company-a/repo', '5': 'secret' } },
      { t: 3, e: 1, v: {}, a: { '1': 'https://github.com/company-b/repo', '5': 'main' } },
      { t: 4, e: 1, v: {}, a: { '5': 'main' } },
      { t: 5, e: 1, v: {}, a: { '1': 'not-a-repository', '5': 'main' } },
    ],
  });

  const errors = await validateManagedMachineRepositoryScope(batch, async (repository, branch) => {
    checked.push([repository, branch]);
    return repository === 'github.com/company-a/repo' && branch === 'main';
  });

  assert.deepEqual(checked, [
    ['github.com/company-a/repo', 'main'],
    ['github.com/company-a/repo', 'secret'],
    ['github.com/company-b/repo', 'main'],
  ]);
  assert.deepEqual(errors, [
    { index: 1, error: 'Machine repository or branch grant is not active' },
    { index: 2, error: 'Machine repository or branch grant is not active' },
    { index: 3, error: 'Repository is required for managed machine telemetry' },
    { index: 4, error: 'Repository URL is invalid' },
  ]);
});

test('managed ingestion policy applies family watermarks and exact backfill authorization', async () => {
  const batch = validateMetricsBatch({
    v: 1,
    events: [
      { t: 110, e: 5, v: {}, a: { '1': 'https://github.com/company-a/repo', '5': 'main' } },
      { t: 90, e: 5, v: {}, a: { '1': 'https://github.com/company-a/repo', '5': 'main' } },
      { t: 190, e: 1, v: {}, a: { '1': 'https://github.com/company-a/repo', '5': 'main' } },
      { t: 210, e: 1, v: {}, a: { '1': 'https://github.com/company-a/repo', '5': 'main' } },
    ],
  });
  const decision = await evaluateManagedMachineIngestionPolicy(batch, async () => ({
    enrollmentId: 'enrollment-a',
    generationSessionEvidenceFrom: new Date(100_000),
    commitNoteEvidenceFrom: new Date(200_000),
    backfillAuthorizations: [{
      id: 'generation-backfill-a',
      evidenceFamily: 'generation_session',
      occurredFrom: new Date(80_000),
      occurredUntil: new Date(99_000),
      expiresAt: new Date(300_000),
    }],
  }), new Date(250_000));

  assert.deepEqual(decision.errors, [
    { index: 2, error: 'Evidence predates the repository enrollment watermark' },
  ]);
  assert.deepEqual(decision.labels, [
    {
      index: 0, enrollmentId: 'enrollment-a', evidenceFamily: 'generation_session',
      arrivalClass: 'current', backfillAuthorizationId: null,
    },
    {
      index: 1, enrollmentId: 'enrollment-a', evidenceFamily: 'generation_session',
      arrivalClass: 'backfill', backfillAuthorizationId: 'generation-backfill-a',
    },
    {
      index: 3, enrollmentId: 'enrollment-a', evidenceFamily: 'commit_note',
      arrivalClass: 'current', backfillAuthorizationId: null,
    },
  ]);
});

test('scope partition preserves original indexes for partial ingestion results', () => {
  const batch = validateMetricsBatch({
    v: 1,
    events: [
      { t: 1, e: 1, v: {}, a: { '1': 'https://github.com/company-a/repo' } },
      { t: 2, e: 1, v: {}, a: { '1': 'https://github.com/company-b/repo' } },
      { t: 3, e: 1, v: {}, a: { '1': 'https://github.com/company-a/repo' } },
      { t: 4, e: 1, v: {}, a: {} },
    ],
  });
  const scopeErrors = [
    { index: 1, error: 'repository denied' },
    { index: 3, error: 'repository required' },
  ];

  const partition = partitionAuthorizedMetricsBatch(batch, scopeErrors);
  assert.deepEqual(partition.originalIndexes, [0, 2]);
  assert.deepEqual(partition.batch.events.map((event) => event.t), [1, 3]);
  assert.deepEqual(
    remapAuthorizedUploadErrors(scopeErrors, [{ index: 1, error: 'event invalid' }], partition),
    [
      { index: 1, error: 'repository denied' },
      { index: 2, error: 'event invalid' },
      { index: 3, error: 'repository required' },
    ],
  );
});

test('provider event fingerprint is stable across object key order and changes with evidence', () => {
  const left = providerEventFingerprint('github', 'pr_updated', {
    repository: { id: 10, name: 'repo' }, action: 'synchronize', number: 7,
  });
  const reordered = providerEventFingerprint('github', 'pr_updated', {
    number: 7, action: 'synchronize', repository: { name: 'repo', id: 10 },
  });
  const changed = providerEventFingerprint('github', 'pr_updated', {
    number: 8, action: 'synchronize', repository: { name: 'repo', id: 10 },
  });

  assert.match(left, /^[a-f0-9]{64}$/);
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
});

test('provider projection ordering retains stale and conflicting evidence without regressing state', () => {
  const current = {
    occurredAt: new Date('2026-07-31T10:00:00Z'),
    fingerprint: 'b'.repeat(64),
  };
  assert.equal(classifyProviderProjectionEvent(current, {
    occurredAt: new Date('2026-07-31T10:00:01Z'), fingerprint: 'c'.repeat(64),
  }), 'apply');
  assert.equal(classifyProviderProjectionEvent(current, {
    occurredAt: new Date('2026-07-31T09:59:59Z'), fingerprint: 'a'.repeat(64),
  }), 'stale');
  assert.equal(classifyProviderProjectionEvent(current, {
    occurredAt: new Date('2026-07-31T10:00:00Z'), fingerprint: 'b'.repeat(64),
  }), 'duplicate');
  assert.equal(classifyProviderProjectionEvent(current, {
    occurredAt: new Date('2026-07-31T10:00:00Z'), fingerprint: 'd'.repeat(64),
  }), 'conflict');
  assert.equal(classifyProviderProjectionEvent(current, {
    occurredAt: null, fingerprint: 'e'.repeat(64),
  }), 'unsequenced');
  assert.equal(classifyProviderProjectionEvent(null, {
    occurredAt: null, fingerprint: 'f'.repeat(64),
  }), 'unsequenced');
});

test('provider delivery state distinguishes retry, resume, and terminal acknowledgement', () => {
  assert.equal(classifyProviderDeliveryState(null), 'process');
  assert.equal(classifyProviderDeliveryState('received'), 'retry');
  assert.equal(classifyProviderDeliveryState('failed'), 'retry');
  assert.equal(classifyProviderDeliveryState('projected'), 'resume');
  for (const status of ['applied', 'duplicate', 'stale', 'conflict', 'unsequenced'] as const) {
    assert.equal(classifyProviderDeliveryState(status), 'acknowledge');
  }
});

test('provider delivery claim permits new, failed, and expired work without racing active work', () => {
  const now = new Date('2026-07-31T10:00:00Z');
  const active = new Date('2026-07-31T09:59:30Z');
  const expired = new Date('2026-07-31T09:54:59Z');

  assert.equal(providerDeliveryCanBeClaimed(null, null, now), true);
  assert.equal(providerDeliveryCanBeClaimed('failed', active, now), true);
  assert.equal(providerDeliveryCanBeClaimed('received', active, now), false);
  assert.equal(providerDeliveryCanBeClaimed('received', expired, now), true);
  assert.equal(providerDeliveryCanBeClaimed('projected', active, now), false);
  assert.equal(providerDeliveryCanBeClaimed('projected', expired, now), true);
  assert.equal(providerDeliveryCanBeClaimed('applied', expired, now), false);
});

test('provider delivery IDs accept canonical opaque IDs and reject unsafe input', () => {
  assert.equal(normalizeProviderDeliveryId(' 01234567-89ab-cdef-0123-456789abcdef '),
    '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(normalizeProviderDeliveryId('delivery_17.example:retry'),
    'delivery_17.example:retry');
  assert.equal(normalizeProviderDeliveryId(undefined), null);
  assert.equal(normalizeProviderDeliveryId('contains whitespace'), null);
  assert.equal(normalizeProviderDeliveryId('a'.repeat(256)), null);
});

test('provider delivery claim plan distinguishes ownership, retry, resume, and terminal states', () => {
  const now = new Date('2026-07-31T10:00:00Z');
  const active = new Date('2026-07-31T09:59:30Z');
  const expired = new Date('2026-07-31T09:54:59Z');

  assert.deepEqual(planProviderDeliveryClaim(null, null, now),
    { action: 'process', claim: true });
  assert.deepEqual(planProviderDeliveryClaim('received', active, now),
    { action: 'retry', claim: false });
  assert.deepEqual(planProviderDeliveryClaim('received', expired, now),
    { action: 'process', claim: true });
  assert.deepEqual(planProviderDeliveryClaim('failed', active, now),
    { action: 'process', claim: true });
  assert.deepEqual(planProviderDeliveryClaim('projected', active, now),
    { action: 'retry', claim: false });
  assert.deepEqual(planProviderDeliveryClaim('projected', expired, now),
    { action: 'resume', claim: true });
  assert.deepEqual(planProviderDeliveryClaim('stale', expired, now),
    { action: 'acknowledge', claim: false });
});

test('provider delivery collision distinguishes retry, deduplication, and conflicting evidence', () => {
  const existing = { deliveryId: 'delivery-1', fingerprint: 'a'.repeat(64) };
  assert.equal(classifyProviderDeliveryCollision(existing, existing), 'same');
  assert.equal(classifyProviderDeliveryCollision(existing, {
    deliveryId: 'delivery-2', fingerprint: existing.fingerprint,
  }), 'duplicate');
  assert.equal(classifyProviderDeliveryCollision(existing, {
    deliveryId: existing.deliveryId, fingerprint: 'b'.repeat(64),
  }), 'conflict');
  assert.equal(classifyProviderDeliveryCollision(existing, {
    deliveryId: 'delivery-2', fingerprint: 'b'.repeat(64),
  }), 'unrelated');
});

test('provider projection identity separates PRs, branches, and deployments', () => {
  const repository = {
    id: 1, name: 'repo', html_url: 'https://github.com/acme/repo', owner: { login: 'acme' },
  };
  const pullRequest = parseGitHubWebhook({ 'x-github-event': 'pull_request' }, {
    action: 'synchronize', repository,
    pull_request: {
      id: 2, number: 17, title: 'Change', state: 'open', updated_at: '2026-07-31T10:00:00Z',
      user: { id: 99, login: 'dev' }, head: { ref: 'feature', sha: 'abc' },
      base: { ref: 'main', sha: 'def' },
    },
  });
  const mainPush = parseGitHubWebhook({ 'x-github-event': 'push' }, {
    repository, ref: 'refs/heads/main', before: 'a', after: 'b', commits: [],
    head_commit: { timestamp: '2026-07-31T10:00:00Z' },
  });
  const featurePush = parseGitHubWebhook({ 'x-github-event': 'push' }, {
    repository, ref: 'refs/heads/feature', before: 'a', after: 'c', commits: [],
    head_commit: { timestamp: '2026-07-31T10:00:01Z' },
  });
  const deployment = parseGitHubWebhook({ 'x-github-event': 'deployment_status' }, {
    repository,
    deployment: { id: 7, environment: 'production', ref: 'main', sha: 'b' },
    deployment_status: { state: 'success', created_at: '2026-07-31T10:00:02Z' },
  });

  assert.ok(pullRequest && mainPush && featurePush && deployment);
  assert.deepEqual(providerProjectionIdentity(pullRequest), {
    projectionType: 'pull_request', projectionKey: '1:2',
  });
  assert.deepEqual(providerProjectionIdentity(mainPush), {
    projectionType: 'branch', projectionKey: '1:refs/heads/main',
  });
  assert.deepEqual(providerProjectionIdentity(featurePush), {
    projectionType: 'branch', projectionKey: '1:refs/heads/feature',
  });
  assert.deepEqual(providerProjectionIdentity(deployment), {
    projectionType: 'deployment', projectionKey: '1:7',
  });
});

test('parses Git Notes ranges and customer-visible external session identity', () => {
  const note = `src/a.ts\n  h_1 1\n  s_one::t_one 2-4\n---\n{"sessions":{"s_one":{"agent_id":{"tool":"opencode","id":"external-one","model":"m1"}}}}`;
  const parsed = parseAuthorshipNote(note);
  assert.equal(parsed.files[0].aiLines, 3);
  assert.equal(parsed.files[0].humanLines, 1);
  assert.equal(parsed.sessions[0].externalId, 'external-one');
  assert.equal(parsed.aiLinesBySession.get('s_one'), 3);
});

test('aggregates model-specific Git AI sessions into one external conversation', () => {
  const totals = aggregateExternalSessionLines([
    { sessionId: 'external-session-a', lines: 268 },
    { sessionId: 'external-session-a', lines: 140 },
    { sessionId: 'external-session-b', lines: 9 },
  ]);
  assert.equal(totals.get('external-session-a'), 408);
  assert.equal(totals.get('external-session-b'), 9);
});

test('machine token map resolves a tenant and rejects unknown keys', () => {
  const map = parseIngestTokenMap('{"opaque-a":"tenant-a"}');
  assert.equal(resolveTenantForToken('opaque-a', map), 'tenant-a');
  assert.equal(resolveTenantForToken('opaque-b', map), null);
  assert.throws(() => parseIngestTokenMap('[]'));
});

test('GitHub PR parser captures refs and SHAs for synchronize events', () => {
  const parsed = parseGitHubWebhook({ 'x-github-event': 'pull_request' }, {
    action: 'synchronize', repository: { id: 1, name: 'repo', html_url: 'https://github.com/acme/repo', owner: { login: 'acme' } },
    number: 17,
    pull_request: { id: 2, number: 17, title: 'Update dev1-a', state: 'open', user: { id: 99, login: 'dev' },
      head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main', sha: 'def' }, merge_commit_sha: 'merge' },
  });
  assert.equal(parsed?.eventType, 'pr_updated');
  assert.equal(parsed?.pullRequest?.headRef, 'feature');
  assert.equal(parsed?.pullRequest?.headSha, 'abc');
  assert.equal(parsed?.pullRequest?.mergeCommitSha, 'merge');
  assert.equal(parsed?.pullRequest?.authorProviderId, '99');
  assert.equal(parsed?.pullRequest?.authorLogin, 'dev');
  assert.equal(parsed?.pullRequest?.authorEmail, null);
});

test('GitHub PR parser presents a successfully merged PR as merged', () => {
  const parsed = parseGitHubWebhook({ 'x-github-event': 'pull_request' }, {
    action: 'closed', repository: { id: 1, name: 'repo', html_url: 'https://github.com/acme/repo', owner: { login: 'acme' } },
    pull_request: { id: 2, number: 17, title: 'Merged change', state: 'closed', merged_at: '2026-07-24T17:28:27Z',
      user: { id: 99, login: 'dev' }, head: { ref: 'feature', sha: 'abc' }, base: { ref: 'main', sha: 'def' },
      merge_commit_sha: 'result' },
  });
  assert.equal(parsed?.pullRequest?.state, 'merged');
  assert.equal(parsed?.pullRequest?.mergedAt, '2026-07-24T17:28:27Z');
});

test('merge topology distinguishes merge, squash, and patch-equivalent rebase histories', () => {
  assert.equal(inferMergeMethod(['a', 'b'], 'result', ['base', 'head']), 'merge_commit');
  assert.equal(inferMergeMethod(['a', 'b'], 'result', ['base']), 'squash_merge');
  assert.equal(inferMergeMethod(['a'], 'a', ['base']), 'fast_forward');
  assert.equal(inferMergeMethod(['a'], 'replacement', ['diverged-base']), 'rewritten_merge');
  const commit = (sha: string, patch: string) => ({
    sha,
    commit: { message: sha },
    parents: [{ sha: 'parent' }],
    files: [{ filename: 'file.ts', status: 'modified', patch }],
  });
  assert.equal(inferMergeMethod(
    ['a', 'b'],
    'rebased-b',
    ['rebased-a'],
    [commit('a', '@@ a'), commit('b', '@@ b')],
    [commit('rebased-b', '@@ b'), commit('rebased-a', '@@ a')],
  ), 'rebase_merge');
  const mapping = mapRebasedResultCommits(
    [commit('a', '@@ a'), commit('b', '@@ b')],
    [commit('rebased-b', '@@ b'), commit('rebased-a', '@@ a')],
  );
  assert.equal(mapping.get('a')?.sha, 'rebased-a');
  assert.equal(mapping.get('b')?.sha, 'rebased-b');
  assert.equal(mapRebasedResultCommits(
    [commit('a', '@@ a'), commit('b', '@@ b')],
    [commit('rebased-b', '@@ different'), commit('rebased-a', '@@ a')],
  ).size, 0);
});

test('GitHub push metadata enriches a rewrite commit without changing lifecycle semantics', () => {
  const observedAt = new Date('2026-07-25T00:00:00Z');
  const metadata = githubCommitMetadata({
    sha: 'af888ab2bb3e',
    commit: {
      message: 'Revert "Test AI and human deletion attribution"\n\nRestore deleted code.',
      author: { name: 'Teamz Lab', email: 'teamz-lab@example.invalid', date: '2026-07-24T23:37:36Z' },
      committer: { date: '2026-07-24T23:38:00Z' },
    },
    author: null,
  }, observedAt);
  assert.equal(metadata.authorName, 'Teamz Lab');
  assert.equal(metadata.authorEmail, 'teamz-lab@example.invalid');
  assert.equal(metadata.subject, 'Revert "Test AI and human deletion attribution"');
  assert.equal(metadata.body, 'Restore deleted code.');
  assert.equal(metadata.authoredAt.toISOString(), '2026-07-24T23:37:36.000Z');
});

test('rewrite events preserve operation and predecessor SHAs without Untitled labels', () => {
  const rewrite = decodeRewriteValues({ '2': 4, '5': [3], '15': 'cherry_pick', '16': ['old-a'] });
  assert.equal(rewrite.operationKind, 'cherry_pick');
  assert.deepEqual(rewrite.originalCommitShas, ['old-a']);
  assert.equal(rewrite.subject, 'Rewrite: cherry pick');
});

test('checkpoint decoding preserves physical LoC, SLOC and deleted-line provenance', () => {
  const checkpoint = decodeCheckpointValues({
    '1': 'ai_agent', '2': 'src/a.ts', '3': 8, '4': 3, '5': 5,
    '11': 2, '12': 1, '13': 0,
  });
  assert.equal(checkpoint.kind, 'ai_agent');
  assert.equal(checkpoint.linesAdded, 8);
  assert.equal(checkpoint.linesAddedSloc, 5);
  assert.equal(checkpoint.aiAuthoredLinesDeleted, 2);
  assert.equal(checkpoint.humanAuthoredLinesDeleted, 1);
  assert.deepEqual(checkpointLifecycleLines(checkpoint), {
    generatedPhysicalLoc: 8,
    deletedPhysicalLoc: 3,
  });
});

test('commit hunks retain AI rework evidence when a whole file disappears', () => {
  assert.equal(decodeAiAuthoredDeletionLines(JSON.stringify([
    { hunk_kind: 'deletion', start_line: 1, end_line: 7, file_path: 'deleted.md',
      session_id: 's_agent', prompt_id: 's_agent::t_trace' },
    { hunk_kind: 'deletion', start_line: 8, end_line: 10, file_path: 'deleted.md',
      human_id: 'h_human' },
    { hunk_kind: 'addition', start_line: 1, end_line: 100, session_id: 's_agent' },
  ])), 7);
  assert.equal(decodeAiAuthoredDeletionLines(null), null);
});

test('deletion hunks inherit AI provenance from predecessor attribution ranges', () => {
  const hunks = JSON.stringify([
    { hunk_kind: 'deletion', start_line: 6, end_line: 6,
      file_path: 'docs/copilot-kept-create-regression.md' },
    { hunk_kind: 'deletion', start_line: 26, end_line: 27,
      file_path: 'src/distributions.py' },
    { hunk_kind: 'deletion', start_line: 30, end_line: 30,
      file_path: 'src/distributions.py' },
    { hunk_kind: 'deletion', start_line: 9, end_line: 9,
      file_path: 'human.md' },
  ]);
  const predecessorFiles = [
    { path: 'docs/copilot-kept-create-regression.md', attributionRanges: [
      { kind: 'ai', startLine: 1, endLine: 7 },
    ] },
    { path: 'src/distributions.py', attributionRanges: [
      { kind: 'ai', startLine: 1, endLine: 53 },
    ] },
    { path: 'human.md', attributionRanges: [
      { kind: 'human', startLine: 1, endLine: 20 },
    ] },
  ];
  assert.equal(decodeAiAuthoredDeletionLines(hunks, predecessorFiles), 4);
});

test('deletion provenance survives unrelated commits and uses the nearest line owner', () => {
  const hunks = JSON.stringify([
    { hunk_kind: 'deletion', start_line: 7, end_line: 9,
      file_path: 'src/retention_fixture.py' },
  ]);
  const newestToOldestHistory = [
    // The immediate parent changed another file, so it contributes no entry.
    { path: 'src/retention_fixture.py', attributionRanges: [
      { kind: 'human', startLine: 8, endLine: 8 },
    ] },
    { path: 'src/retention_fixture.py', attributionRanges: [
      { kind: 'ai', startLine: 1, endLine: 29 },
    ] },
  ];
  assert.equal(decodeAiAuthoredDeletionLines(hunks, newestToOldestHistory), 2);
  assert.equal(decodeAiAuthoredDeletionLines(hunks, [newestToOldestHistory[1]]), 3);
});

test('checkpoint deletion evidence is reconciled only to matching commit files', () => {
  const hunks = JSON.stringify([
    { hunk_kind: 'deletion', file_path: 'tests/deleted.py', start_line: 1, end_line: 85 },
    { hunk_kind: 'addition', file_path: 'src/other.py', start_line: 1, end_line: 1 },
  ]);
  const paths = decodeDeletionFilePaths(hunks);
  assert.deepEqual([...paths], ['tests/deleted.py']);
  assert.equal(checkpointDeletionMatchesCommitFiles('tests/deleted.py', paths), true);
  assert.equal(checkpointDeletionMatchesCommitFiles('./tests/deleted.py', paths), true);
  assert.equal(checkpointDeletionMatchesCommitFiles('src/unrelated.py', paths), false);
});

test('unknown-origin checkpoint deletions remain available for commit reconciliation', () => {
  assert.deepEqual(checkpointDeletionBuckets({
    linesDeleted: 3,
    aiAuthoredLinesDeleted: 0,
    humanAuthoredLinesDeleted: 0,
    unknownAuthoredLinesDeleted: 3,
  }), { aiReworkedLines: 0, unresolvedLines: 3 });
  assert.deepEqual(checkpointDeletionBuckets({
    linesDeleted: 2,
    aiAuthoredLinesDeleted: null,
    humanAuthoredLinesDeleted: null,
    unknownAuthoredLinesDeleted: null,
  }), { aiReworkedLines: 0, unresolvedLines: 2 });
});

test('current PR head subtracts committed-line rework but historical committed does not', () => {
  assert.equal(currentRetainedAiLines(576, [
    { lineCount: 41, evidenceType: 'git_ai_checkpoint_ai_authored_deletion' },
    { lineCount: 4, evidenceType: 'git_ai_checkpoint_deletion_with_commit_hunk_attribution' },
  ]), 572);
});

test('merge and deployment materialization retain source attribution without historical overcounting', () => {
  const reworkRows = [
    { commitId: 'first', lineCount: 41, evidenceType: 'git_ai_checkpoint_ai_authored_deletion' },
    { commitId: 'third', lineCount: 4, evidenceType: 'git_ai_checkpoint_deletion_with_commit_hunk_attribution' },
  ];
  const retained = [
    currentRetainedAiLinesForCommit('first', 408, reworkRows),
    currentRetainedAiLinesForCommit('second', 148, reworkRows),
    currentRetainedAiLinesForCommit('third', 20, reworkRows),
  ];
  assert.deepEqual(retained, [408, 148, 16]);
  assert.equal(retained.reduce((sum, lines) => sum + lines, 0), 572);
});

test('deployment evidence inherits a unique PR through merge lineage', () => {
  const lineage = [
    { sourceCommitId: 'first', pullRequestId: 'pr-3' },
    { sourceCommitId: 'second', pullRequestId: 'pr-3' },
  ];
  assert.equal(uniquePullRequestForDeploymentSource('first', lineage), 'pr-3');
  assert.equal(uniquePullRequestForDeploymentSource('missing', lineage), null);
  assert.equal(uniquePullRequestForDeploymentSource('first', [
    ...lineage,
    { sourceCommitId: 'first', pullRequestId: 'pr-4' },
  ]), null);
});

test('PR lifecycle includes commit-linked rework without duplicating direct PR evidence', () => {
  const rows = [
    { id: 'merged', pullRequestId: 'pr-3', commitId: 'first', stage: 'merged' },
    { id: 'rework', pullRequestId: null, commitId: 'third', stage: 'reworked' },
    { id: 'other', pullRequestId: null, commitId: 'outside', stage: 'reworked' },
    { id: 'direct-rework', pullRequestId: 'pr-3', commitId: 'third', stage: 'reworked' },
  ];
  assert.deepEqual(
    lifecycleEvidenceForPullRequest(rows, 'pr-3', new Set(['first', 'third'])).map((row) => row.id),
    ['merged', 'rework', 'direct-rework'],
  );
  assert.equal(lifecycleEvidenceMatchesPullRequestScope(
    rows[1]!,
    new Set(['pr-3']),
    new Set(['first', 'third']),
  ), true);
  assert.equal(lifecycleEvidenceMatchesPullRequestScope(
    rows[2]!,
    new Set(['pr-3']),
    new Set(['first', 'third']),
  ), false);
});

test('lifecycle metrics keep unavailable distinct from zero and production from proxy', () => {
  const summary = calculateLifecycleSummary([
    { stage: 'generated', lineCount: 90, evidenceType: 'checkpoint' },
    { stage: 'committed', lineCount: 10, evidenceType: 'note' },
    { stage: 'merged_proxy', lineCount: 8, evidenceType: 'default_branch_proxy' },
    { stage: 'reworked', lineCount: 2, actorKind: 'human', evidenceType: 'diff' },
  ]);
  assert.equal(summary.ratios.generatedToCommitted, 9);
  assert.equal(summary.production.value, null);
  assert.equal(summary.mergedProxy.value, 8);
  assert.equal(summary.reworkByActor.human, 2);
});

test('generation evidence is marked partial when it cannot cover final attribution', () => {
  assert.deepEqual(generationEvidenceMetric(3, 33), {
    value: null,
    observedValue: 3,
    status: 'partial',
    evidence: 'git_ai_checkpoint',
    reason: 'Partial checkpoint coverage: 3 observed generated physical LoC is below 33 final attributed AI lines.',
  });
});

test('session fallback names are deterministic and contain no prompt text', () => {
  assert.equal(
    fallbackSessionName('codex', new Date('2026-07-23T00:00:00Z'), 'external-session-id'),
    'codex session · 2026-07-23 · external',
  );
});

test('PR membership snapshots preserve removed commits instead of erasing history', () => {
  assert.deepEqual(diffCommitMembership(['a', 'b'], ['b', 'c']), {
    added: ['c'], retained: ['b'], removed: ['a'],
  });
});

test('contributor lifecycle scope follows commit authorship, not PR ownership', () => {
  const contributor = { name: 'Teamz Lab', email: 'teamz-lab@example.invalid' };
  assert.equal(contributorMatchesCommit(contributor, {
    authorName: 'Different display name', authorEmail: 'TEAMZ-LAB@example.invalid',
  }), true);
  assert.equal(contributorMatchesCommit(contributor, {
    authorName: 'PR Owner', authorEmail: 'owner@example.invalid',
  }), false);
});

test('revert preserves predecessor reachability while rewrite operations supersede it', () => {
  assert.equal(NORMALIZED_COMMIT_REACHABILITY, 'reachable');
  assert.equal(operationSupersedesPredecessor('revert'), false);
  assert.equal(committedLinesForOperation('revert', 25), 0);
  assert.equal(committedLinesForOperation('commit', 25), 25);
  assert.equal(operationSupersedesPredecessor('amend'), true);
  assert.equal(operationSupersedesPredecessor('rebase'), true);
  assert.equal(operationSupersedesPredecessor('recommit_after_reset'), true);
  assert.equal(rewriteRetainsGenerationEvidence('recommit_after_reset'), true);
  assert.equal(rewriteRetainsGenerationEvidence('revert'), false);
});

test('a later sibling commit on the same branch abandons the reset-away local tip', () => {
  assert.equal(shouldAbandonSiblingTip({
    sha: 'reset-away', branch: 'feature', committedAt: new Date('2026-07-25T01:00:00Z'),
    reachability: 'reachable',
  }, {
    sha: 'replacement', branch: 'feature', committedAt: new Date('2026-07-25T02:00:00Z'),
  }), true);
  assert.equal(shouldAbandonSiblingTip({
    sha: 'other-branch', branch: 'other', committedAt: new Date('2026-07-25T01:00:00Z'),
    reachability: 'reachable',
  }, {
    sha: 'replacement', branch: 'feature', committedAt: new Date('2026-07-25T02:00:00Z'),
  }), false);
});

test('repository, PR and contributor headline totals use only their selected entities', () => {
  const base = {
    commits: [
      { id: 'a', repositoryId: 'repo-a', reachability: 'reachable', finalAiLines: 10, finalHumanLines: 2 },
      { id: 'b', repositoryId: 'repo-a', reachability: 'superseded', finalAiLines: 7, finalHumanLines: 1 },
      { id: 'c', repositoryId: 'repo-b', reachability: 'reachable', finalAiLines: 5, finalHumanLines: 4 },
    ],
    commitSessions: [
      { commitId: 'a', sessionId: 'session-a' },
      { commitId: 'c', sessionId: 'session-b' },
    ],
    sessionRepositories: [
      { sessionId: 'session-a', repositoryId: 'repo-a' },
      { sessionId: 'uncommitted-a', repositoryId: 'repo-a' },
      { sessionId: 'session-b', repositoryId: 'repo-b' },
    ],
    allSessionIds: ['session-a', 'uncommitted-a', 'session-b'],
  };
  assert.deepEqual(calculateLifecycleScopeTotals({
    ...base, repositoryIds: new Set(['repo-a']), pullRequestCommitIds: null,
    contributorCommitIds: null,
  }), { sessions: 2, commits: 1, finalAiLines: 10, finalHumanLines: 2 });
  assert.deepEqual(calculateLifecycleScopeTotals({
    ...base, repositoryIds: null, pullRequestCommitIds: new Set(['c']),
    contributorCommitIds: null,
  }), { sessions: 1, commits: 1, finalAiLines: 5, finalHumanLines: 4 });
  assert.deepEqual(calculateLifecycleScopeTotals({
    ...base, repositoryIds: new Set(['repo-a']), pullRequestCommitIds: null,
    contributorCommitIds: new Set(['a']),
  }), { sessions: 1, commits: 1, finalAiLines: 10, finalHumanLines: 2 });
  assert.deepEqual(calculateLifecycleScopeTotals({
    ...base, repositoryIds: null, pullRequestCommitIds: null,
    contributorCommitIds: null,
    reworkRows: [
      { commitId: 'a', lineCount: 3, evidenceType: 'git_ai_checkpoint_deletion_with_commit_hunk_attribution' },
      { commitId: 'b', lineCount: 7, evidenceType: 'git_ai_checkpoint_deletion_with_commit_hunk_attribution' },
    ],
  }), { sessions: 3, commits: 2, finalAiLines: 12, finalHumanLines: 6 });
});

test('disjoint PR generation uses commit-linked evidence without duplicating shared sessions', () => {
  const observations = [{ lineCount: 46, evidenceType: 'tenant_checkpoint_total' }];
  const commitLinked = [
    { commitId: 'pr-one-a', lineCount: 36, evidenceType: 'checkpoint' },
    { commitId: 'pr-one-b', lineCount: 6, evidenceType: 'checkpoint' },
    { commitId: 'pr-two', lineCount: 3, evidenceType: 'checkpoint' },
    { commitId: null, lineCount: 1, evidenceType: 'checkpoint' },
  ];
  const tenant = generationEvidenceForScope({ observations, commitLinked, commitIds: null });
  const prOne = generationEvidenceForScope({
    observations, commitLinked, commitIds: new Set(['pr-one-a', 'pr-one-b']),
  });
  const prTwo = generationEvidenceForScope({
    observations, commitLinked, commitIds: new Set(['pr-two']),
  });
  const sum = (rows: Array<{ lineCount: number }>) => rows.reduce((total, row) => total + row.lineCount, 0);
  assert.equal(sum(tenant), 46);
  assert.equal(sum(prOne), 42);
  assert.equal(sum(prTwo), 3);
  assert.ok(sum(prOne) + sum(prTwo) <= sum(tenant));
});

test('generation completeness is checked per retained commit, not masked by aggregate totals', () => {
  const coverage = generationCoverageForScope({
    commits: [
      { id: 'covered', finalAiLines: 5, reachability: 'reachable' },
      { id: 'gap', finalAiLines: 3, reachability: 'reachable' },
      { id: 'old', finalAiLines: 99, reachability: 'superseded' },
    ],
    generatedRows: [
      { commitId: 'covered', lineCount: 6 },
      { commitId: 'gap', lineCount: 2 },
      { commitId: null, lineCount: 500 },
    ],
    commitIds: null,
  });
  assert.deepEqual(coverage, {
    complete: false,
    requiredCommitCount: 2,
    coveredCommitCount: 1,
    missingCommitIds: ['gap'],
  });
  const summary = calculateLifecycleSummary([
    { stage: 'generated', lineCount: 508, evidenceType: 'checkpoint' },
    { stage: 'committed', lineCount: 8, evidenceType: 'git_ai_authorship' },
  ], coverage);
  assert.equal(summary.generated.value, null);
  assert.equal(summary.generated.availability, 'partial');
  assert.equal(summary.ratios.generatedToCommitted, null);
});

test('deployment status parser distinguishes production evidence', () => {
  const parsed = parseGitHubWebhook({ 'x-github-event': 'deployment_status' }, {
    repository: { id: 1, name: 'repo', html_url: 'https://github.com/acme/repo', owner: { login: 'acme' } },
    deployment: { id: 7, environment: 'production', ref: 'main', sha: 'abc' },
    deployment_status: { state: 'success', created_at: '2026-07-23T01:00:00Z' },
  });
  assert.equal(parsed?.eventType, 'deployment_status');
  assert.equal(parsed?.deployment?.production, true);
  assert.equal(parsed?.deployment?.status, 'success');
});

test('deployment creation is retained without advancing production', () => {
  const parsed = parseGitHubWebhook({ 'x-github-event': 'deployment' }, {
    repository: { id: 1, name: 'repo', html_url: 'https://github.com/acme/repo', owner: { login: 'acme' } },
    deployment: { id: 7, ref: 'main', sha: 'abc', environment: 'production', created_at: '2026-07-25T00:00:00Z' },
  });
  assert.equal(parsed?.deployment?.status, 'created');
  assert.equal(parsed?.deployment?.production, true);
  assert.equal(parsed?.deployment?.deployedAt, '2026-07-25T00:00:00Z');
});

test('PR matching uses SHA, then branch, and rejects ambiguous author matches', () => {
  const rows = [
    { id: 'one', headSha: 'sha-one', mergeCommitSha: null, headRef: 'feature', authorEmail: 'dev@example.com', state: 'open' },
    { id: 'two', headSha: 'sha-two', mergeCommitSha: null, headRef: 'other', authorEmail: 'dev@example.com', state: 'open' },
  ];
  assert.equal(selectPullRequestMatch({ sha: 'sha-one', branch: 'other', authorEmail: 'dev@example.com' }, rows)?.pullRequest.id, 'one');
  assert.equal(selectPullRequestMatch({ sha: 'none', branch: 'feature', authorEmail: 'dev@example.com' }, rows)?.method, 'branch');
  assert.equal(selectPullRequestMatch({ sha: 'none', branch: null, authorEmail: 'dev@example.com' }, rows), null);
});

test('correction overlays retain observed evidence', () => {
  const result = applyAuditedValue({ targetType: 'commit', targetKey: 'c1',
    fieldName: 'observedAiLines', correctedValue: 8, reason: 'audited', evidenceRef: 'e1' }, 7);
  assert.equal(result.observedValue, 7);
  assert.equal(result.auditedValue, 8);
  assert.equal(result.corrected, true);
});

test('per-model commit attribution preserves exact Git Note ranges before session collapse', () => {
  const parsed = parseAuthorshipNote(`src/example.ts
  s_a::t_1 1-3
  s_b::t_2 4-5
---
{"sessions":{"s_a":{"agent_id":{"tool":"opencode","id":"conversation-1","model":"deepseek"}},"s_b":{"agent_id":{"tool":"opencode","id":"conversation-1","model":"nemotron"}}}}`);
  assert.deepEqual(modelAttributionsFromNote(parsed).map((row) => ({ key: row.modelKey, lines: row.lines })), [
    { key: 'opencode::deepseek', lines: 3 },
    { key: 'opencode::nemotron', lines: 2 },
  ]);
  assert.equal(modelKey('github-copilot', null), 'github-copilot::unknown');
});

test('model rework remains charged to the originating model and records unknown honestly', () => {
  const rows = allocateReworkByOriginModel({
    predecessor: [{ modelKey: 'opencode::deepseek', lines: 8 }, { modelKey: 'opencode::nemotron', lines: 4 }],
    successor: [{ modelKey: 'opencode::deepseek', lines: 5 }, { modelKey: 'opencode::nemotron', lines: 4 }],
    reworkedLines: 5,
  });
  assert.deepEqual(rows, [
    { modelKey: 'opencode::deepseek', lines: 3, confidence: 100 },
    { modelKey: 'unknown::unknown', lines: 2, confidence: 50 },
  ]);
});

test('development evidence endpoint gate is always off in production', () => {
  assert.equal(evidenceFlowEnabled({ NODE_ENV: 'development', TRACKAI_DEV_EVIDENCE_ENABLED: 'true' }), true);
  assert.equal(evidenceFlowEnabled({ NODE_ENV: 'production', TRACKAI_DEV_EVIDENCE_ENABLED: 'true' }), false);
  assert.equal(evidenceFlowEnabled({ NODE_ENV: 'development' }), false);
});

test('OpenCode evidence normalization orders turns, pairs tools, and excludes provider internals', () => {
  const rows = [
    { messageId: 'm1', messageTime: 1000, partId: 'p1', partTime: 1000,
      messageData: JSON.stringify({ role: 'user', model: { modelID: 'deepseek' } }),
      partData: JSON.stringify({ type: 'text', text: 'Add a median function', time: { start: 1000 } }) },
    { messageId: 'm2', messageTime: 2000, partId: 'p2', partTime: 2000,
      messageData: JSON.stringify({ role: 'assistant', modelID: 'deepseek' }),
      partData: JSON.stringify({ type: 'tool', tool: 'write', callID: 'private-provider-id', state: {
        input: { path: 'src/stats.py' }, output: 'Done', time: { start: 2000, end: 2100 },
      } }) },
    { messageId: 'm2', messageTime: 2200, partId: 'p3', partTime: 2200,
      messageData: JSON.stringify({ role: 'assistant', modelID: 'deepseek' }),
      partData: JSON.stringify({ type: 'text', text: 'Implemented and tested.', time: { start: 2200 } }) },
    { messageId: 'm3', messageTime: 4000, partId: 'p4', partTime: 4000,
      messageData: JSON.stringify({ role: 'user', model: { modelID: 'deepseek' } }),
      partData: JSON.stringify({ type: 'text', text: 'This happened after commit', time: { start: 4000 } }) },
  ];
  const nodes = normalizeOpenCodeEvidence(rows, {
    sha: 'abc', subject: 'Add median', committedAt: new Date(3000),
  });
  assert.deepEqual(nodes.map((node) => node.type), [
    'developer_prompt', 'tool_call', 'tool_result', 'agent_response', 'commit',
  ]);
  assert.equal(JSON.stringify(nodes).includes('private-provider-id'), false);
  assert.equal(JSON.stringify(nodes).includes('This happened after commit'), false);
  assert.equal(nodes.at(-1)?.linkageQuality, 'exact');
});
