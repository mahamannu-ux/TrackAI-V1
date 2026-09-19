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
  semanticSafeError,
} from './semantic';
import { isTestCommand } from './workspace';

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

test('OpenCode evidence contract rejects providers outside Task5 scope', () => {
  assert.throws(() => validateOpenCodeEvidenceBatch(batch({ provider: 'cursor' })), /opencode/);
});

test('OpenCode evidence contract rejects duplicate provider event identities', () => {
  const event = (batch().events as Array<Record<string, unknown>>)[0];
  assert.throws(() => validateOpenCodeEvidenceBatch(batch({ events: [event, event] })), /unique/);
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

test('local BGE adapter is pinned to local-only normalized 384-dimensional inference', () => {
  const adapter = readFileSync(resolve(process.cwd(), 'scripts/trackai-bge-embed.py'), 'utf8');
  assert.match(adapter, /BAAI\/bge-small-en-v1\.5/);
  assert.match(adapter, /DIMENSIONS = 384/);
  assert.match(adapter, /local_files_only=True/);
  assert.match(adapter, /trust_remote_code=False/);
  assert.match(adapter, /normalize_embeddings=True/);
  assert.doesNotMatch(adapter, /print\(customer_text/);
});

test('customer workspace identifies tests without treating ordinary shell work as a test', () => {
  assert.equal(isTestCommand({ command: 'npm run test --workspace=apps/api' }), true);
  assert.equal(isTestCommand({ command: 'cargo test evidence_binding --lib' }), true);
  assert.equal(isTestCommand({ command: 'task test' }), true);
  assert.equal(isTestCommand({ command: 'git status --short' }), false);
  assert.equal(isTestCommand({ path: 'src/testimonials.ts' }), false);
});
