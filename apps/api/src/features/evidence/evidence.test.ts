import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  inferredIntentionFromPrompt,
  redactSecrets,
  semanticSimilarity,
  semanticTokens,
  validateOpenCodeEvidenceBatch,
} from './contract';
import { openCodeRowsToEvidenceEvents } from './opencode-collector';

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

test('semantic search ranks related intentions without calling them identical', () => {
  const query = semanticTokens('reduce login failures');
  const related = semanticSimilarity(query, semanticTokens('reduce repeated login failure errors'));
  const unrelated = semanticSimilarity(query, semanticTokens('update billing invoice colors'));
  assert.ok(related > unrelated);
  assert.ok(related < 1);
});

test('inferred intention is a bounded summary, not the stored prompt identity', () => {
  assert.equal(
    inferredIntentionFromPrompt('Reduce login failures. Then add monitoring and update the runbook.'),
    'Reduce login failures.',
  );
  assert.equal(inferredIntentionFromPrompt(null), null);
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
