import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AttestaOutboxError,
  enqueueAttestaSubject,
  normalizeAttestaSubjectInput,
  type AttestaOutboxExecutor,
  type EnqueueAttestaSubjectInput,
} from './outbox';

const T = '00000000-0000-4000-8000-0000000000a1';
const R = '00000000-0000-4000-8000-0000000000b1';
const SHA = '3f2a9c4e1b7d6a5f8e0c2b4d6f8a1c3e5b7d9f0a';
const EVENT_AT = new Date('2026-10-12T09:14:55.000Z'); // reference time for notBefore cases

const commitObserved = (): EnqueueAttestaSubjectInput => ({
  kind: 'commit_observed', tenantId: T, repositoryId: R, commitSha: SHA,
  metricEventId: '00000000-0000-4000-8000-0000000000c1', commitId: '00000000-0000-4000-8000-0000000000d1',
});
const prMerged = (): EnqueueAttestaSubjectInput => ({
  kind: 'pr_merged', tenantId: T, repositoryId: R, commitSha: SHA,
  provider: 'github', providerDeliveryId: '5f1c0a2e-8b4d-11f0-9a1b-0242ac120002',
  pullRequestId: '00000000-0000-4000-8000-0000000000e1',
});
const deployed = (): EnqueueAttestaSubjectInput => ({
  kind: 'deployed', tenantId: T, repositoryId: R, commitSha: SHA,
  provider: 'github', deploymentId: '00000000-0000-4000-8000-0000000000f1',
  deploymentExternalId: '1846203377', deploymentStatus: 'success',
});

const rejects = (input: unknown, pattern: RegExp) => {
  assert.throws(() => normalizeAttestaSubjectInput(input), (error: unknown) =>
    error instanceof AttestaOutboxError && error.code === 'ATTESTA_OUTBOX_INVALID_INPUT' && pattern.test(error.message));
};

test('T15c outbox: accepts each kind and snapshots plain values', () => {
  for (const input of [commitObserved(), prMerged(), deployed()]) {
    const normalized = normalizeAttestaSubjectInput(input);
    assert.equal(normalized.kind, input.kind);
    assert.equal(normalized.notBefore, null);
  }
  const later = new Date(EVENT_AT.getTime() + 300_000);
  const withDelay = normalizeAttestaSubjectInput({ ...prMerged(), notBefore: later });
  assert.notEqual(withDelay.notBefore, later, 'notBefore is copied, not shared');
  assert.equal(withDelay.notBefore?.getTime(), later.getTime());
  assert.equal(normalizeAttestaSubjectInput(deployed()).providerDeliveryId, null);
});

test('T15c outbox: refuses malformed input', () => {
  rejects(null, /object/);
  rejects([], /object/);
  rejects({ ...commitObserved(), kind: 'commit_discovered' }, /kind/);
  rejects({ ...commitObserved(), tenantId: 'acme' }, /tenantId/);
  rejects({ ...commitObserved(), tenantId: T.toUpperCase() }, /tenantId/);
  rejects({ ...commitObserved(), commitSha: SHA.slice(0, 39) }, /commitSha/);
  rejects({ ...commitObserved(), commitSha: SHA.toUpperCase() }, /commitSha/);
  rejects({ ...commitObserved(), eventAt: EVENT_AT }, /unexpected field/);
  rejects({ ...commitObserved(), notBefore: 5 }, /notBefore/);
  rejects({ ...commitObserved(), notBefore: new Date('nope') }, /notBefore/);
  rejects({ ...commitObserved(), notBefore: new Date(Date.UTC(10000, 0, 1)) }, /notBefore/);
  rejects({ ...prMerged(), provider: 'GitHub' }, /provider/);
  rejects({ ...prMerged(), providerDeliveryId: '' }, /providerDeliveryId/);
  rejects({ ...prMerged(), providerDeliveryId: 'a\nb' }, /providerDeliveryId/);
  rejects({ ...prMerged(), providerDeliveryId: 'x'.repeat(129) }, /providerDeliveryId/);
  rejects({ ...deployed(), deploymentStatus: 'failure' }, /success/);
  rejects({ ...deployed(), deploymentExternalId: undefined }, /deploymentExternalId/);
});

test('T15c outbox: refuses fields that belong to another kind', () => {
  rejects({ ...commitObserved(), pullRequestId: '00000000-0000-4000-8000-0000000000e1' }, /unexpected field/);
  rejects({ ...prMerged(), metricEventId: '00000000-0000-4000-8000-0000000000c1' }, /unexpected field/);
  rejects({ ...deployed(), commitId: '00000000-0000-4000-8000-0000000000d1' }, /unexpected field/);
  rejects({ ...commitObserved(), title: 'raw PR title' }, /unexpected field/);
});

test('T15c outbox: reads each getter once (validate and use one snapshot)', () => {
  let reads = 0;
  const input = { ...commitObserved() } as Record<string, unknown>;
  Object.defineProperty(input, 'commitSha', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? SHA : 'not-a-sha'; },
  });
  const normalized = normalizeAttestaSubjectInput(input);
  assert.equal(normalized.commitSha, SHA);
  assert.equal(reads, 1);
});

// A fake executor: renders each statement and answers from a script.
function fakeExecutor(answers: Array<Array<Record<string, unknown>>>) {
  const dialect = new PgDialect();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const executor: AttestaOutboxExecutor = {
    async execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      statements.push({ sql: rendered.sql, params: rendered.params });
      return { rows: answers.shift() ?? [] };
    },
  };
  return { executor, statements };
}

const NEW_ID = '00000000-0000-4000-8000-000000000101';

test('T15c outbox: inserts with ON CONFLICT DO NOTHING on the kind key, bound to the tenant', async () => {
  for (const [input, target, source] of [
    [commitObserved(), "(tenant_id, kind, metric_event_id) where kind = 'commit_observed'", 'telemetry_metric_events'],
    [prMerged(), "(tenant_id, kind, provider, provider_delivery_id) where kind = 'pr_merged'", 'provider_event_deliveries'],
    [deployed(), "(tenant_id, kind, provider, deployment_external_id, deployment_status) where kind = 'deployed'", 'scm_deployments'],
  ] as const) {
    const { executor, statements } = fakeExecutor([[{ id: NEW_ID }]]);
    assert.deepEqual(await enqueueAttestaSubject(executor, input), { id: NEW_ID, inserted: true });
    assert.equal(statements.length, 1);
    const flat = statements[0].sql.replace(/\s+/g, ' ');
    assert.ok(flat.includes(`on conflict ${target} do nothing`), flat);
    assert.ok(flat.includes(source));
    assert.ok(statements[0].params.includes(T));
  }
});

test('T15c outbox: a replay returns the existing row', async () => {
  const input = commitObserved() as Extract<EnqueueAttestaSubjectInput, { kind: 'commit_observed' }>;
  const stored = {
    id: NEW_ID, repository_id: R, commit_sha: SHA, metric_event_id: input.metricEventId,
    commit_id: input.commitId, provider: null, provider_delivery_id: null, pull_request_id: null,
    deployment_id: null, deployment_external_id: null, deployment_status: null,
  };
  const { executor } = fakeExecutor([[], [stored]]);
  assert.deepEqual(await enqueueAttestaSubject(executor, input), { id: NEW_ID, inserted: false });

  const conflicting = fakeExecutor([[], [{ ...stored, commit_sha: 'b'.repeat(40) }]]);
  await assert.rejects(enqueueAttestaSubject(conflicting.executor, input), (error: unknown) =>
    error instanceof AttestaOutboxError && error.code === 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT'
      && /commit_sha/.test(error.message));

});

test('T15c outbox: a second success delivery for the same deployment is the same observation', async () => {
  const input = deployed() as Extract<EnqueueAttestaSubjectInput, { kind: 'deployed' }>;
  const stored = {
    id: NEW_ID, repository_id: R, commit_sha: SHA, metric_event_id: null, commit_id: null,
    provider: 'github', provider_delivery_id: 'first-delivery', pull_request_id: null,
    deployment_id: input.deploymentId, deployment_external_id: input.deploymentExternalId,
    deployment_status: 'success',
  };
  const { executor } = fakeExecutor([[], [stored]]);
  const result = await enqueueAttestaSubject(executor, { ...input, providerDeliveryId: 'second-delivery' });
  assert.deepEqual(result, { id: NEW_ID, inserted: false });
});

test('T15c outbox: a missing or foreign source row is refused', async () => {
  const { executor } = fakeExecutor([[], []]);
  await assert.rejects(enqueueAttestaSubject(executor, prMerged()), (error: unknown) =>
    error instanceof AttestaOutboxError && error.code === 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND');
});
