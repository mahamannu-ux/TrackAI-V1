import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  inferredIntentionFromPrompt,
  redactSecrets,
  shouldCreateIntentionVersion,
  validateOpenCodeEvidenceBatch,
} from './contract';
import { openCodeRowsToEvidenceEvents } from './opencode-collector';
import {
  SEMANTIC_DIMENSIONS,
  normalizeEmbedding,
  reciprocalRankFusion,
  semanticCandidateIsRelevant,
  semanticQueryForEmbedding,
  semanticSafeError,
} from './semantic';
import { compareIntentionSearchResults, edgesForNodePage, uniqueGraphEdges } from './service';
import {
  currentPullRequestCommitIds,
  distinctRelatedWork,
  exactRangeTraceIds,
  isTestCommand,
  keyInsight,
} from './workspace';
import {
  task5VerificationCorpus,
  validateTask5VerificationCorpus,
} from './task5-verification-corpus';

function batch(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'opencode',
    batchId: 'batch-1',
    sourceVersion: 'opencode/1',
    repositoryId: '00000000-0000-4000-8000-000000000001',
    externalSessionId: 'session-1',
    gitAiSessionId: 's_1234567890abcd',
    events: [{
      providerEventId: 'part-1',
      type: 'prompt',
      occurredAt: '2026-09-19T10:00:00.000Z',
      traceId: 't_1234567890abcd',
      content: 'Reduce login failures.',
    }],
    ...overrides,
  };
}

test('OpenCode evidence contract keeps prompt and intention separate', () => {
  const parsed = validateOpenCodeEvidenceBatch(batch({ intention: 'Improve login reliability' }));
  assert.equal(parsed.intention, 'Improve login reliability');
  assert.equal(parsed.events[0].content, 'Reduce login failures.');
  assert.equal(parsed.events[0].type, 'prompt');
});

test('Task5 verification corpus covers every evidence gate with one bounded product story', () => {
  assert.deepEqual(validateTask5VerificationCorpus(), {
    corpusId: 'task5-password-recovery-v1',
    pullRequests: 3,
    commits: 7,
    sessions: 6,
    intentions: 6,
    evidenceScenarios: 8,
    gates: 12,
  });
});

test('Task5 verification corpus proves GitAI many-to-many identity without redefining sessions', () => {
  const sessions = task5VerificationCorpus.sessions;
  assert.ok(sessions.some(row => row.commits.length === 0));
  assert.ok(sessions.some(row => row.commits.length === 1));
  assert.ok(sessions.some(row => row.commits.length > 1));
  const recoveryTestSessions = sessions.filter(row => row.commits.some(commit => commit === 'recovery-test'));
  assert.equal(recoveryTestSessions.length, 2);
});

test('Task5 verification corpus separates semantic positives from token-word hard negatives', () => {
  const cases = task5VerificationCorpus.searchCases;
  assert.ok(cases.relevantIntentions.includes('recovery-v2'));
  assert.ok(cases.relevantIntentions.includes('refresh-race'));
  assert.deepEqual(cases.hardNegatives, ['design-token']);
  const negative = task5VerificationCorpus.intentions.find(row => row.key === 'design-token');
  assert.match(negative?.text ?? '', /tokens/);
  assert.match(negative?.text ?? '', /without changing authentication/);
});

test('OpenCode evidence contract rejects providers outside Task5 scope', () => {
  assert.throws(() => validateOpenCodeEvidenceBatch(batch({ provider: 'cursor' })), /opencode/);
});

test('OpenCode evidence contract rejects duplicate provider event identities', () => {
  const event = (batch().events as Array<Record<string, unknown>>)[0];
  assert.throws(() => validateOpenCodeEvidenceBatch(batch({ events: [event, event] })), /unique/);
});

test('TrackAI accepts GitAI replay-stable tool and unavailable-reasoning evidence', () => {
  const gitAiBatch = {
    provider: 'opencode',
    batchId: 'opencode-contract-replay-id',
    sourceVersion: 'git-ai/opencode-evidence/1',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    externalSessionId: 'session-contract',
    gitAiSessionId: 's_1234567890abcd',
    events: [
      {
        providerEventId: 'part-contract:call', type: 'tool_call',
        occurredAt: '2025-06-15T15:06:40.000Z', traceId: null,
        model: 'model-contract', toolName: 'shell',
        content: { command: 'task test' }, metadata: { status: 'completed', durationMs: 42 },
      },
      {
        providerEventId: 'part-contract:result', type: 'tool_result',
        occurredAt: '2025-06-15T15:06:40.000Z', traceId: null,
        model: 'model-contract', toolName: 'shell', content: 'passed',
        metadata: { status: 'completed', durationMs: 42 },
      },
      {
        providerEventId: 'message-contract:reasoning-unavailable', type: 'reasoning',
        occurredAt: '2025-06-15T15:06:40.000Z', traceId: null,
        model: 'model-contract', toolName: null, content: null, metadata: {},
      },
    ],
  };
  const parsed = validateOpenCodeEvidenceBatch(gitAiBatch);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[2].type, 'reasoning');
  assert.equal(parsed.events[2].content, null);
  assert.equal(parsed.events[2].traceId, null);
  assert.equal(parsed.intention, null);
  assert.deepEqual(validateOpenCodeEvidenceBatch(structuredClone(gitAiBatch)), parsed);
});

test('raw prompt and tool payload fields cannot be smuggled into metadata', () => {
  const event = { ...(batch().events as Array<Record<string, unknown>>)[0], metadata: {
    status: 'failed', arguments: { password: 'must-not-live-in-metadata' },
  } };
  assert.throws(() => validateOpenCodeEvidenceBatch(batch({ events: [event] })), /raw payloads/);
});

test('secret scanning redacts nested content before storage', () => {
  const result = redactSecrets({
    command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
    nested: ['api_key=super-secret-value'],
  });
  assert.equal(result.changed, true);
  assert.doesNotMatch(JSON.stringify(result.value), /abcdefghijklmnopqrstuvwxyz|super-secret-value/);
  assert.equal(result.counts.bearer_token, 1);
  assert.equal(result.counts.assigned_secret, 1);
});

test('semantic vectors are normalized and dimension checked', () => {
  const normalized = normalizeEmbedding(Array.from({ length: SEMANTIC_DIMENSIONS }, (_, index) => index === 0 ? 3 : index === 1 ? 4 : 0));
  assert.equal(normalized[0], 0.6);
  assert.equal(normalized[1], 0.8);
  assert.throws(() => normalizeEmbedding([1, 2]), /semantic_invalid_dimensions/);
});

test('semantic keyword queries expand concurrency concepts and reject weak vector-only matches', () => {
  assert.equal(
    semanticQueryForEmbedding('authentication credential race condition'),
    'Find work about concurrent requests involving authentication credential.',
  );
  assert.equal(semanticCandidateIsRelevant({ exact: false, vectorScore: 0.5999 }), false);
  assert.equal(semanticCandidateIsRelevant({ exact: false, vectorScore: 0.6 }), true);
  assert.equal(semanticCandidateIsRelevant({ exact: false, lexicalRank: 1, vectorScore: 0.2 }), true);
  assert.equal(semanticCandidateIsRelevant({ exact: true }), true);
});

test('hybrid search uses stable reciprocal rank fusion', () => {
  const ranked = reciprocalRankFusion(
    [{ id: 'lexical-only', score: 0.9 }, { id: 'both', score: 0.8 }],
    [{ id: 'both', score: 0.95 }, { id: 'vector-only', score: 0.85 }],
  );
  assert.equal(ranked[0].id, 'both');
  assert.equal(ranked[0].lexicalRank, 2);
  assert.equal(ranked[0].vectorRank, 1);
  assert.deepEqual(new Set(ranked.map(row => row.id)), new Set(['both', 'lexical-only', 'vector-only']));
});

test('deterministic semantic reranking breaks RRF ties before database identity', () => {
  const base = {
    match: 'hybrid' as const, score: 0.032, lexicalScore: 0.9,
    evidenceState: 'observed' as const, confidence: 100,
  };
  const hardNegative = { ...base, id: 'a-randomly-first-id', vectorScore: 0.71 };
  const semanticMatch = { ...base, id: 'z-randomly-last-id', vectorScore: 0.83, lexicalScore: 0.5 };
  assert.deepEqual(
    [hardNegative, semanticMatch].sort(compareIntentionSearchResults).map(row => row.id),
    ['z-randomly-last-id', 'a-randomly-first-id'],
  );
});

test('graph pagination emits cross-page edges once with their source page', () => {
  const edges = [{
    fromType: 'commit', fromId: 'commit-1', toType: 'session', toId: 'session-1',
    relationship: 'contains_attribution_from', evidenceState: 'observed' as const,
    confidence: 100, basis: 'git_ai_authorship_note',
  }];
  assert.equal(edgesForNodePage(edges, new Set(['commit:commit-1'])).length, 1);
  assert.equal(edgesForNodePage(edges, new Set(['session:session-1'])).length, 0);
});

test('graph removes duplicate normalized and stored relationships before pagination', () => {
  const edge = {
    fromType: 'event', fromId: 'event-1', toType: 'session', toId: 'session-1',
    relationship: 'occurred_in', evidenceState: 'observed' as const,
    confidence: 100, basis: 'provider_session_id',
  };
  assert.equal(uniqueGraphEdges([edge, { ...edge }]).length, 1);
  assert.equal(uniqueGraphEdges([edge, { ...edge, basis: 'independent_attestation' }]).length, 2);
});

test('semantic worker errors expose safe codes rather than source content', () => {
  assert.equal(semanticSafeError(new Error('customer prompt should never be returned')), 'semantic_unknown_failure');
  assert.equal(semanticSafeError(new Error('semantic_timeout')), 'semantic_timeout');
});

test('inferred intention is a bounded summary, not the stored prompt identity', () => {
  assert.equal(
    inferredIntentionFromPrompt('Reduce login failures. Then add monitoring and update the runbook.'),
    'Reduce login failures.',
  );
  assert.equal(inferredIntentionFromPrompt(null), null);
});

test('inferred intention is created at a session milestone, not for every later prompt', () => {
  assert.equal(shouldCreateIntentionVersion({
    nextFingerprint: 'first', nextState: 'inferred',
  }), true);
  assert.equal(shouldCreateIntentionVersion({
    existingFingerprint: 'first', existingState: 'inferred',
    nextFingerprint: 'later-prompt', nextState: 'inferred',
  }), false);
  assert.equal(shouldCreateIntentionVersion({
    existingFingerprint: 'first', existingState: 'inferred',
    nextFingerprint: 'first', nextState: 'observed',
  }), true);
});

test('OpenCode collector preserves provider event identity and explicit trace mapping', () => {
  const events = openCodeRowsToEvidenceEvents([{
    messageId: 'message-1', messageTime: 1_750_000_000_000,
    messageData: JSON.stringify({ role: 'user', modelID: 'model-a' }),
    partId: 'part-1', partTime: 1_750_000_000_000,
    partData: JSON.stringify({ type: 'text', text: 'Add retry handling.' }),
  }], { 'part-1': 't_1234567890abcd' });
  assert.deepEqual(events, [{
    providerEventId: 'part-1', type: 'prompt', toolName: null,
    content: 'Add retry handling.',
    occurredAt: new Date(1_750_000_000_000).toISOString(),
    traceId: 't_1234567890abcd', model: 'model-a', metadata: {},
  }]);
});

test('Task5 migration stores sensitive evidence only in encrypted JSON envelopes', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0010_cooing_darkhawk.sql'),
    'utf8',
  );
  for (const table of [
    'tenant_evidence_settings', 'evidence_events', 'evidence_event_contents',
    'evidence_intentions', 'evidence_links', 'evidence_summaries',
    'evidence_semantic_documents',
  ]) assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  assert.match(migration, /"encrypted_value" jsonb NOT NULL/);
  assert.doesNotMatch(migration, /"(?:prompt|response|reasoning|tool_arguments|tool_result)_text"/);
  assert.match(migration, /"retention_days" = 30/);
});

test('Task5 semantic migration enables pgvector, exact hybrid indexes, versioning, and RLS', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0011_plain_xavin.sql'),
    'utf8',
  );
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(migration, /"embedding" vector\(384\) NOT NULL/);
  assert.match(migration, /"lexical_document" tsvector NOT NULL/);
  assert.match(migration, /evidence_intentions_tenant_one_current_series_key/);
  assert.match(migration, /evidence_intentions_supersedes_tenant_fk/);
  for (const table of [
    'tenant_evidence_settings', 'evidence_events', 'evidence_event_contents',
    'evidence_intentions', 'evidence_links', 'evidence_summaries',
    'evidence_semantic_documents', 'evidence_intention_embeddings', 'evidence_semantic_jobs',
  ]) assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  assert.doesNotMatch(migration, /CREATE POLICY/);
  const hardeningMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0012_gray_warbird.sql'),
    'utf8',
  );
  assert.match(hardeningMigration, /evidence_intention_embeddings_tenant_intention_fk/);
  assert.match(hardeningMigration, /evidence_semantic_jobs_tenant_intention_fk/);
  assert.match(hardeningMigration, /DROP CONSTRAINT "evidence_intention_embeddings_intention_id/);
});

test('Task5 CI uses the Task4 runtime master-key contract', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '../../.github/workflows/task5-verification.yml'),
    'utf8',
  );
  assert.match(workflow, /MASTER_ENCRYPTION_KEY_ACTIVE_VERSION: ci-v1/);
  assert.match(workflow, /MASTER_ENCRYPTION_KEYS_JSON:/);
  assert.doesNotMatch(workflow, /TRACKAI_MASTER_KEYRING/);
});

test('local BGE adapter is pinned to local-only normalized 384-dimensional inference', () => {
  const adapter = readFileSync(resolve(process.cwd(), 'scripts/trackai-bge-embed.py'), 'utf8');
  assert.match(adapter, /BAAI\/bge-small-en-v1\.5/);
  assert.match(adapter, /DIMENSIONS = 384/);
  assert.match(adapter, /local_files_only=True/);
  assert.match(adapter, /trust_remote_code=False/);
  assert.match(adapter, /normalize_embeddings=True/);
  assert.match(adapter, /hashlib\.sha256/);
  assert.match(adapter, /local semantic checksum does not match configuration/);
  assert.match(adapter, /local semantic revision does not match configuration/);
  assert.doesNotMatch(adapter, /print\(customer_text/);
});

test('customer workspace identifies tests without treating ordinary shell work as a test', () => {
  assert.equal(isTestCommand({ command: 'npm run test --workspace=apps/api' }), true);
  assert.equal(isTestCommand({ command: 'cargo test evidence_binding --lib' }), true);
  assert.equal(isTestCommand({ command: 'task test' }), true);
  assert.equal(isTestCommand({ command: 'git status --short' }), false);
  assert.equal(isTestCommand({ path: 'src/testimonials.ts' }), false);
});

test('customer quality insight uses readable singular and plural wording', () => {
  const values = {
    failedTools: 1, retries: 0, slowTools: 0, promptLoops: 0,
    reworkedLines: 0, abandoned: false, evidenceGaps: 0,
  };
  assert.equal(keyInsight(values), '1 failed tool operation needs review.');
  assert.equal(keyInsight({ ...values, failedTools: 2 }), '2 failed tool operations need review.');
});

test('customer workspace uses active PR membership and retains legacy fallback only when needed', () => {
  const memberships = [
    { pullRequestId: 'pr-1', commitId: 'current', active: true },
    { pullRequestId: 'pr-1', commitId: 'removed', active: false },
  ];
  const legacy = [
    { pullRequestId: 'pr-1', commitId: 'legacy-stale' },
    { pullRequestId: 'pr-2', commitId: 'legacy-current' },
  ];
  assert.deepEqual(currentPullRequestCommitIds(memberships, legacy, 'pr-1'), ['current']);
  assert.deepEqual(currentPullRequestCommitIds(memberships, legacy, 'pr-2'), ['legacy-current']);
});

test('file-line exactness requires an explicit GitAI range attribution edge', () => {
  assert.deepEqual(exactRangeTraceIds([
    { fromType: 'event', relationship: 'reported_trace', toType: 'trace', toId: 'provider-trace' },
    { fromType: 'checkpoint', relationship: 'identified_by', toType: 'trace', toId: 'checkpoint-trace' },
  ]), []);
  assert.deepEqual(exactRangeTraceIds([
    { fromType: 'code_range', relationship: 'attributed_to', toType: 'trace', toId: 'exact-trace' },
  ]), ['exact-trace']);
});

test('Task5 browser acceptance helpers fail closed and do not log credentials', () => {
  const corpusRunner = readFileSync(
    resolve(process.cwd(), 'src/features/evidence/task5-corpus-live-verify.ts'),
    'utf8',
  );
  const authServer = readFileSync(
    resolve(process.cwd(), 'src/features/evidence/task5-acceptance-auth.ts'),
    'utf8',
  );
  assert.match(corpusRunner, /TASK5_ACCEPTANCE_PERSIST === '1'/);
  assert.match(corpusRunner, /TASK5_EPHEMERAL_DATABASE !== '1'/);
  assert.match(authServer, /NODE_ENV === 'production'/);
  assert.match(authServer, /TASK5_EPHEMERAL_DATABASE !== '1'/);
  assert.doesNotMatch(authServer, /console\.log\([^\n]*password/);
  assert.doesNotMatch(authServer, /console\.log\([^\n]*(accessToken|refreshToken)/);
});

test('Task5 semantic runtime stays compatible with Intel macOS and reindex retries existing jobs', () => {
  const requirements = readFileSync(
    resolve(process.cwd(), 'scripts/requirements-semantic.txt'),
    'utf8',
  );
  const service = readFileSync(
    resolve(process.cwd(), 'src/features/evidence/service.ts'),
    'utf8',
  );
  assert.match(requirements, /^numpy<2$/m);
  assert.match(requirements, /^scipy<1\.15$/m);
  assert.match(service, /inArray\(evidenceSemanticJobs\.state, \['completed', 'failed', 'skipped'\]\)/);
  assert.match(service, /attemptCount: 0/);
  assert.match(service, /safeErrorCode: null/);
});

test('similar work excludes the current story before deduplication and limiting', () => {
  const related = distinctRelatedWork([
    { kind: 'pull_request', id: 'current', title: 'Current via another intention' },
    { kind: 'pull_request', id: 'related', title: 'Related first match' },
    { kind: 'pull_request', id: 'related', title: 'Related duplicate' },
    { kind: 'unfinished_intention', id: 'open', title: 'Open investigation' },
  ], ['pull_request:current']);
  assert.deepEqual(related.map(item => `${item.kind}:${item.id}`), [
    'pull_request:related',
    'unfinished_intention:open',
  ]);
});
