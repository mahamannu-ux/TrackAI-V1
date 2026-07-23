import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAttributes, decodeCheckpointValues, decodeRewriteValues, decodeSessionUsage, validateMetricEvent, validateMetricsBatch } from './decoder';
import { normalizeRepositoryUrl } from './repository-url';
import { parseAuthorshipNote } from './authorship-note';
import { parseIngestTokenMap, resolveTenantForToken } from '../../core/middleware/machine-auth';
import { parseGitHubWebhook } from '../scm/parser';
import { selectPullRequestMatch } from './pr-matching';
import { applyAuditedValue } from './audit';
import { calculateLifecycleSummary, diffCommitMembership, fallbackSessionName } from './lifecycle';

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
    cacheReadTokens: 7, cacheWriteTokens: null, costAmount: 0.5, externalEventId: null });
});

test('normalizes HTTPS, SSH and SCP repository URLs identically', () => {
  const expected = 'github.com/mahamannu-ai/git-ai-teamz-lab';
  assert.equal(normalizeRepositoryUrl('https://github.com/Mahamannu-AI/git-ai-teamz-lab.git'), expected);
  assert.equal(normalizeRepositoryUrl('git@github.com:mahamannu-ai/git-ai-teamz-lab.git'), expected);
  assert.equal(normalizeRepositoryUrl('ssh://git@github.com/mahamannu-ai/git-ai-teamz-lab'), expected);
});

test('parses Git Notes ranges and customer-visible external session identity', () => {
  const note = `src/a.ts\n  h_1 1\n  s_one::t_one 2-4\n---\n{"sessions":{"s_one":{"agent_id":{"tool":"opencode","id":"external-one","model":"m1"}}}}`;
  const parsed = parseAuthorshipNote(note);
  assert.equal(parsed.files[0].aiLines, 3);
  assert.equal(parsed.files[0].humanLines, 1);
  assert.equal(parsed.sessions[0].externalId, 'external-one');
  assert.equal(parsed.aiLinesBySession.get('s_one'), 3);
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

test('rewrite events preserve operation and predecessor SHAs without Untitled labels', () => {
  const rewrite = decodeRewriteValues({ '2': 4, '5': [3], '15': 'cherry_pick', '16': ['old-a'] });
  assert.equal(rewrite.operationKind, 'cherry_pick');
  assert.deepEqual(rewrite.originalCommitShas, ['old-a']);
  assert.equal(rewrite.subject, 'Rewrite: cherry pick');
});

test('checkpoint decoding uses SLOC for gross generation evidence', () => {
  const checkpoint = decodeCheckpointValues({ '1': 'ai_agent', '2': 'src/a.ts', '3': 8, '5': 5 });
  assert.equal(checkpoint.kind, 'ai_agent');
  assert.equal(checkpoint.linesAdded, 8);
  assert.equal(checkpoint.linesAddedSloc, 5);
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
