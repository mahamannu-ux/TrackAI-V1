import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AttestaOutboxError,
  enqueueAttestaSubject,
  normalizeAttestaSubjectInput,
  sourceBindsToPointer,
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
  provider: 'github', providerDeliveryId: '7a2d1b3c-8b5e-11f0-9a1b-0242ac120002',
  deploymentId: '00000000-0000-4000-8000-0000000000f1',
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
  rejects({ ...deployed(), providerDeliveryId: undefined }, /providerDeliveryId/);
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

// Facts a bound source returns, per kind (what bindingQuery selects).
const PR_EXTERNAL = '2873461190';
const REPO_EXTERNAL = '700100200';
const goodFacts = (kind: string): Record<string, unknown> => {
  if (kind === 'commit_observed') {
    return {
      event_kind: 1, event_at: EVENT_AT, event_at_text: '2026-10-12 09:14:55.123456+00', raw_repo_url: 'git@github.com:acme/payments-service.git',
      raw_sha: SHA, commit_repository_id: R, commit_sha: SHA,
      repository_normalized_url: 'github.com/acme/payments-service',
    };
  }
  if (kind === 'pr_merged') {
    return {
      event_type: 'pr_closed', delivery_repository_id: R, raw_action: 'closed', raw_pr_id: PR_EXTERNAL,
      raw_merge_sha: SHA, raw_merged_at: '2026-10-12T11:02:30Z', raw_repo_id: REPO_EXTERNAL,
      pr_external_id: PR_EXTERNAL, pr_repository_id: R, pr_merge_sha: SHA, event_at: EVENT_AT,
      event_at_text: '2026-10-12 09:14:55.123456+00',
      repository_external_id: REPO_EXTERNAL,
    };
  }
  return {
    event_type: 'deployment_status', delivery_repository_id: null, raw_deployment_id: '1846203377',
    raw_sha: SHA, raw_state: 'success', raw_repo_id: REPO_EXTERNAL, deployment_repository_id: R,
    deployment_provider: 'github', deployment_external_id: '1846203377', deployment_status: 'success',
    deployment_production: true, deployment_sha: SHA, event_at: EVENT_AT,
    event_at_text: '2026-10-12 09:14:55.123456+00', repository_external_id: REPO_EXTERNAL,
  };
};

test('T15c outbox: binding accepts facts that prove the event produced the projection', () => {
  for (const input of [commitObserved(), prMerged(), deployed()]) {
    assert.equal(sourceBindsToPointer(normalizeAttestaSubjectInput(input), goodFacts(input.kind)), true, input.kind);
  }
  // Rewrite-commit events bind too.
  assert.equal(sourceBindsToPointer(normalizeAttestaSubjectInput(commitObserved()),
    { ...goodFacts('commit_observed'), event_kind: 7 }), true);
});

test('T15c outbox: binding refuses same-tenant rows that do not belong together', () => {
  const OTHER = 'b'.repeat(40);
  const cases: Array<[EnqueueAttestaSubjectInput, Record<string, unknown>, string]> = [
    [commitObserved(), { event_kind: 2 }, 'session event, not a commit event'],
    [commitObserved(), { raw_sha: OTHER }, 'event names another commit'],
    [commitObserved(), { commit_sha: OTHER }, 'commit row is another commit'],
    [commitObserved(), { commit_repository_id: '00000000-0000-4000-8000-0000000000b2' }, 'commit in another repository'],
    [commitObserved(), { raw_repo_url: 'https://github.com/acme/other-service' }, 'event from another repository'],
    [commitObserved(), { raw_repo_url: 'not a url' }, 'unparseable repository URL'],
    [commitObserved(), { raw_sha: null }, 'event without a sha'],
    [prMerged(), { event_type: 'pr_opened' }, 'delivery is not a close'],
    [prMerged(), { raw_action: 'reopened' }, 'raw action is not closed'],
    [prMerged(), { raw_merged_at: null }, 'closed without merge'],
    [prMerged(), { raw_pr_id: '1' }, 'delivery is about another PR'],
    [prMerged(), { raw_merge_sha: OTHER }, 'delivery names another merge commit'],
    [prMerged(), { pr_merge_sha: OTHER }, 'PR row has another merge commit'],
    [prMerged(), { pr_repository_id: '00000000-0000-4000-8000-0000000000b2' }, 'PR in another repository'],
    [prMerged(), { delivery_repository_id: '00000000-0000-4000-8000-0000000000b2' }, 'delivery for another repository'],
    [prMerged(), { raw_repo_id: '999' }, 'raw repository is another repository'],
    [deployed(), { event_type: 'pr_closed' }, 'delivery is not a deployment status'],
    [deployed(), { raw_state: 'failure' }, 'delivery reports a failure'],
    [deployed(), { raw_deployment_id: '1' }, 'delivery is about another deployment'],
    [deployed(), { raw_sha: OTHER }, 'delivery names another sha'],
    [deployed(), { deployment_production: false }, 'not production'],
    [deployed(), { deployment_sha: OTHER }, 'deployment row is another sha'],
    [deployed(), { deployment_provider: 'gitlab' }, 'deployment from another provider'],
    [deployed(), { raw_repo_id: null }, 'delivery without a repository'],
  ];
  for (const [input, override, label] of cases) {
    const facts = { ...goodFacts(input.kind), ...override };
    assert.equal(sourceBindsToPointer(normalizeAttestaSubjectInput(input), facts), false, label);
  }
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

test('T15c outbox: proves the sources, then inserts with ON CONFLICT DO NOTHING on the kind key', async () => {
  for (const [input, target, source] of [
    [commitObserved(), "(tenant_id, kind, metric_event_id) where kind = 'commit_observed'", 'telemetry_metric_events'],
    [prMerged(), "(tenant_id, kind, provider, provider_delivery_id) where kind = 'pr_merged'", 'provider_event_deliveries'],
    [deployed(), "(tenant_id, kind, provider, deployment_external_id, deployment_status) where kind = 'deployed'", 'scm_deployments'],
  ] as const) {
    const { executor, statements } = fakeExecutor([[goodFacts(input.kind)], [{ id: NEW_ID }]]);
    assert.deepEqual(await enqueueAttestaSubject(executor, input), { id: NEW_ID, inserted: true });
    assert.equal(statements.length, 2);
    assert.ok(statements[0].sql.includes(source));
    assert.ok(statements[0].params.includes(T), 'source query is tenant-bound');
    const insert = statements[1].sql.replace(/\s+/g, ' ');
    assert.ok(insert.includes(`on conflict ${target} do nothing`), insert);
    assert.ok(statements[1].params.includes('2026-10-12 09:14:55.123456+00'), 'event_at comes from the source row, at full precision');
  }
});

const storedCommitRow = () => {
  const input = commitObserved() as Extract<EnqueueAttestaSubjectInput, { kind: 'commit_observed' }>;
  return {
    id: NEW_ID, repository_id: R, commit_sha: SHA, metric_event_id: input.metricEventId,
    commit_id: input.commitId, provider: null, provider_delivery_id: null, pull_request_id: null,
    deployment_id: null, deployment_external_id: null, deployment_status: null,
  };
};

test('T15c outbox: a replay returns the existing row; a changed stored pointer is refused', async () => {
  const { executor } = fakeExecutor([[goodFacts('commit_observed')], [], [storedCommitRow()]]);
  assert.deepEqual(await enqueueAttestaSubject(executor, commitObserved()), { id: NEW_ID, inserted: false });

  const conflicting = fakeExecutor([[goodFacts('commit_observed')], [], [{ ...storedCommitRow(), commit_sha: 'b'.repeat(40) }]]);
  await assert.rejects(enqueueAttestaSubject(conflicting.executor, commitObserved()), (error: unknown) =>
    error instanceof AttestaOutboxError && error.code === 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT'
      && /commit_sha/.test(error.message) && !error.message.includes('b'.repeat(40)));
});

test('T15c outbox: a second success delivery for the same deployment is the same observation', async () => {
  const input = deployed() as Extract<EnqueueAttestaSubjectInput, { kind: 'deployed' }>;
  const stored = {
    id: NEW_ID, repository_id: R, commit_sha: SHA, metric_event_id: null, commit_id: null,
    provider: 'github', provider_delivery_id: 'first-delivery', pull_request_id: null,
    deployment_id: input.deploymentId, deployment_external_id: input.deploymentExternalId,
    deployment_status: 'success',
  };
  const { executor } = fakeExecutor([[goodFacts('deployed')], [], [stored]]);
  const result = await enqueueAttestaSubject(executor, { ...input, providerDeliveryId: 'second-delivery' });
  assert.deepEqual(result, { id: NEW_ID, inserted: false });
});

test('T15c outbox: missing, foreign or mismatched sources are refused before any insert', async () => {
  for (const answer of [[], [{ ...goodFacts('pr_merged'), raw_pr_id: '1' }]]) {
    const { executor, statements } = fakeExecutor([answer]);
    await assert.rejects(enqueueAttestaSubject(executor, prMerged()), (error: unknown) =>
      error instanceof AttestaOutboxError && error.code === 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND');
    assert.equal(statements.length, 1, 'nothing is inserted');
  }
});
