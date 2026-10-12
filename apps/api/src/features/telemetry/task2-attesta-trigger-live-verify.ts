/**
 * IT-T2AT-01..04: Task2 observation transactions write Attesta outbox rows.
 *
 *   scripts/it-db.sh npm run -s verify:task2-attesta-trigger-live -w apps/api
 */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { db, pool } from '../../core/db';
import { AttestaOutboxError } from '../attesta/outbox';
import { recordDeployment } from '../scm/lifecycle-service';
import { enqueuePrMergedSubject, upsertPullRequestObservation } from '../scm/scm.routes';
import { decodeAttributes } from './decoder';
import {
  ingestMetricsBatch,
  normalizeCommit,
  reconcilePendingMetricEvents,
  rebuildCommitLifecycle,
} from './service';
import type { GitAiMetricEvent, GitAiMetricsBatch } from './types';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Task2 Attesta live verify failed: ${message}`);
}

const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);

interface TenantFixture {
  tenantId: string;
  repositoryUrl: string;
  commitSha: string;
  mergeSha: string;
  deploymentExternalId: string;
}

async function seedTenant(label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const slug = `task2-attesta-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id)
     values ($1, $2, $3, $4)`,
    [tenantId, `Task2 Attesta ${label}`, `${slug}.example`, slug],
  );
  return {
    tenantId,
    repositoryUrl: `https://github.com/${slug}/service`,
    commitSha: sha(),
    mergeSha: sha(),
    deploymentExternalId: `deployment-${randomUUID()}`,
  };
}

function commitEvent(fixture: TenantFixture, commitSha = fixture.commitSha): GitAiMetricEvent {
  return {
    t: Math.floor(Date.now() / 1000),
    e: 1,
    v: {
      '0': 0,
      '1': 0,
      '2': 4,
      '3': ['opencode:model-x'],
      '5': [4],
      '11': 'Synthetic Task2 Attesta commit',
    },
    a: {
      '1': fixture.repositoryUrl,
      '3': commitSha,
      '5': 'main',
      '20': 'opencode',
      '21': 'model-x',
      '23': `session-${randomUUID()}`,
    },
  };
}

async function repository(fixture: TenantFixture) {
  const result = await pool.query<{ id: string; external_id: string }>(
    `select id, external_id from scm_repositories where tenant_id = $1`,
    [fixture.tenantId],
  );
  check(result.rows.length === 1, 'tenant repository was not created exactly once');
  return result.rows[0];
}

async function outboxCount(tenantId: string, kind?: string): Promise<number> {
  const result = kind
    ? await pool.query<{ count: number }>(
      `select count(*)::int as count from attesta_subjects where tenant_id = $1 and kind = $2`,
      [tenantId, kind],
    )
    : await pool.query<{ count: number }>(
      `select count(*)::int as count from attesta_subjects where tenant_id = $1`,
      [tenantId],
    );
  return result.rows[0].count;
}

async function lifecycleSnapshot(tenantId: string): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(
    `select
      (select count(*)::text from ai_code_lifecycle_events where tenant_id = $1) as code_rows,
      (select coalesce(sum(line_count), 0)::text from ai_code_lifecycle_events where tenant_id = $1) as code_lines,
      (select count(*)::text from ai_model_lifecycle_events where tenant_id = $1) as model_rows,
      (select coalesce(sum(line_count), 0)::text from ai_model_lifecycle_events where tenant_id = $1) as model_lines`,
    [tenantId],
  );
  return result.rows[0];
}

async function verifyCommitObservation(fixture: TenantFixture): Promise<void> {
  const event = commitEvent(fixture);
  const batch: GitAiMetricsBatch = { v: 1, events: [event] };
  const rejectAttesta = async () => {
    throw new AttestaOutboxError(
      'ATTESTA_OUTBOX_SOURCE_NOT_FOUND',
      'synthetic writer failure',
    );
  };
  const errors = await ingestMetricsBatch(fixture.tenantId, batch, [], rejectAttesta);
  check(
    errors.length === 1 && errors[0].error === 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND',
    'commit-note ingestion did not surface the safe writer code',
  );
  const failedAttempt = await pool.query<{
    id: string;
    normalization_status: string;
    normalization_error: string | null;
    commits: number;
    subjects: number;
  }>(
    `select e.id, e.normalization_status, e.normalization_error,
       (select count(*)::int from scm_commits c where c.tenant_id = e.tenant_id and c.sha = $2) as commits,
       (select count(*)::int from attesta_subjects s where s.tenant_id = e.tenant_id and s.metric_event_id = e.id) as subjects
     from telemetry_metric_events e
     where e.tenant_id = $1 and e.raw_event -> 'a' ->> '3' = $2`,
    [fixture.tenantId, fixture.commitSha],
  );
  check(
    failedAttempt.rows.length === 1
      && failedAttempt.rows[0].normalization_status === 'pending'
      && failedAttempt.rows[0].normalization_error === 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND'
      && failedAttempt.rows[0].commits === 0
      && failedAttempt.rows[0].subjects === 0,
    'writer failure did not roll back the projection while retaining a retryable event',
  );
  const retry = await reconcilePendingMetricEvents({
    tenantId: fixture.tenantId,
    apply: true,
    delayMs: 0,
  });
  check(retry.normalized === 1, 'pending commit event was not normalized by reconciliation');
  check(await outboxCount(fixture.tenantId, 'commit_observed') === 1, 'commit note produced one outbox row');

  const beforeReplay = await lifecycleSnapshot(fixture.tenantId);
  await ingestMetricsBatch(fixture.tenantId, batch);
  await rebuildCommitLifecycle(fixture.tenantId, fixture.repositoryUrl, true);
  check(await outboxCount(fixture.tenantId, 'commit_observed') === 1, 'replay and rebuild added no outbox row');
  check(
    JSON.stringify(await lifecycleSnapshot(fixture.tenantId)) === JSON.stringify(beforeReplay),
    'replay or rebuild changed lifecycle totals',
  );

  const rollbackSha = sha();
  const rollbackEvent = commitEvent(fixture, rollbackSha);
  const batchId = randomUUID();
  const eventId = randomUUID();
  await pool.query(
    `insert into telemetry_ingest_batches
       (id, tenant_id, api_version, payload_hash, event_count, payload)
     values ($1, $2, 1, $3, 1, $4::jsonb)`,
    [batchId, fixture.tenantId, randomUUID(), JSON.stringify({ v: 1, events: [rollbackEvent] })],
  );
  await pool.query(
    `insert into telemetry_metric_events
       (id, tenant_id, batch_id, event_index, event_fingerprint, event_kind,
        event_timestamp, raw_event, normalization_status)
     values ($1, $2, $3, 0, $4, 1, now(), $5::jsonb, 'pending')`,
    [eventId, fixture.tenantId, batchId, randomUUID(), JSON.stringify(rollbackEvent)],
  );
  await db.transaction(async transaction => {
    await normalizeCommit(
      fixture.tenantId,
      rollbackEvent,
      decodeAttributes(rollbackEvent.a),
      eventId,
      transaction as unknown as typeof db,
    );
    transaction.rollback();
  }).catch(() => undefined);
  const rolledBack = await pool.query<{ commits: number; subjects: number }>(
    `select
      (select count(*)::int from scm_commits where tenant_id = $1 and sha = $2) as commits,
      (select count(*)::int from attesta_subjects where tenant_id = $1 and metric_event_id = $3) as subjects`,
    [fixture.tenantId, rollbackSha, eventId],
  );
  check(rolledBack.rows[0].commits === 0 && rolledBack.rows[0].subjects === 0,
    'rolled-back commit projection or outbox row survived');
}

async function seedMetricSource(
  fixture: TenantFixture,
  event: GitAiMetricEvent,
): Promise<string> {
  const batchId = randomUUID();
  const eventId = randomUUID();
  await pool.query(
    `insert into telemetry_ingest_batches
       (id, tenant_id, api_version, payload_hash, event_count, payload)
     values ($1, $2, 1, $3, 1, $4::jsonb)`,
    [batchId, fixture.tenantId, randomUUID(), JSON.stringify({ v: 1, events: [event] })],
  );
  await pool.query(
    `insert into telemetry_metric_events
       (id, tenant_id, batch_id, event_index, event_fingerprint, event_kind,
        event_timestamp, raw_event, normalization_status)
     values ($1, $2, $3, 0, $4, 1, to_timestamp($5), $6::jsonb, 'pending')`,
    [eventId, fixture.tenantId, batchId, randomUUID(), event.t, JSON.stringify(event)],
  );
  return eventId;
}

function median(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function benchmarkCommitNormalization(): Promise<{ beforeMs: number; afterMs: number }> {
  const beforeFixture = await seedTenant('latency-before');
  const afterFixture = await seedTenant('latency-after');
  const beforeSamples: number[] = [];
  const afterSamples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const beforeEvent = commitEvent(beforeFixture, sha());
    const beforeEventId = await seedMetricSource(beforeFixture, beforeEvent);
    const beforeStarted = performance.now();
    await normalizeCommit(
      beforeFixture.tenantId,
      beforeEvent,
      decodeAttributes(beforeEvent.a),
      beforeEventId,
      db,
      async () => ({ id: randomUUID(), inserted: true }),
    );
    beforeSamples.push(performance.now() - beforeStarted);

    const afterEvent = commitEvent(afterFixture, sha());
    const afterEventId = await seedMetricSource(afterFixture, afterEvent);
    const afterStarted = performance.now();
    await normalizeCommit(
      afterFixture.tenantId,
      afterEvent,
      decodeAttributes(afterEvent.a),
      afterEventId,
    );
    afterSamples.push(performance.now() - afterStarted);
  }
  return { beforeMs: median(beforeSamples), afterMs: median(afterSamples) };
}

async function insertDelivery(input: {
  fixture: TenantFixture;
  repositoryId: string;
  deliveryId: string;
  eventType: string;
  rawEvent: Record<string, unknown>;
}) {
  await pool.query(
    `insert into provider_event_deliveries
       (tenant_id, repository_id, provider, delivery_id, event_type, event_fingerprint, raw_event)
     values ($1, $2, 'github', $3, $4, $5, $6::jsonb)`,
    [input.fixture.tenantId, input.repositoryId, input.deliveryId,
      input.eventType, randomUUID(), JSON.stringify(input.rawEvent)],
  );
}

async function verifyPullRequestObservation(fixture: TenantFixture): Promise<void> {
  const repo = await repository(fixture);
  const rollbackDeliveryId = randomUUID();
  const rollbackExternalId = String(Math.floor(Math.random() * 1_000_000_000));
  const rollbackMergedAt = new Date().toISOString();
  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId: rollbackDeliveryId, eventType: 'pr_closed',
    rawEvent: {
      action: 'closed', repository: { id: repo.external_id },
      pull_request: {
        id: rollbackExternalId,
        merged_at: rollbackMergedAt,
        merge_commit_sha: fixture.mergeSha,
      },
    },
  });
  await db.transaction(transaction => upsertPullRequestObservation(transaction, {
    eventType: 'pr_closed', tenantId: fixture.tenantId, repositoryId: repo.id,
    provider: 'github', providerDeliveryId: rollbackDeliveryId,
    pullRequest: {
      externalId: rollbackExternalId, number: 1, title: 'Synthetic rolled-back PR',
      state: 'merged', authorEmail: null, authorProviderId: 'task2-reviewer',
      authorLogin: 'task2-reviewer', headRef: 'task2', baseRef: 'main',
      headSha: fixture.mergeSha, mergedAt: rollbackMergedAt,
      mergeCommitSha: fixture.mergeSha,
    },
  }, async () => {
    throw new AttestaOutboxError('ATTESTA_OUTBOX_SOURCE_NOT_FOUND', 'synthetic writer failure');
  })).catch(() => undefined);
  const rolledBack = await pool.query<{ pull_requests: number; subjects: number }>(
    `select
       (select count(*)::int from scm_pull_requests where tenant_id = $1 and external_id = $2) as pull_requests,
       (select count(*)::int from attesta_subjects where tenant_id = $1 and provider_delivery_id = $3) as subjects`,
    [fixture.tenantId, rollbackExternalId, rollbackDeliveryId],
  );
  check(
    rolledBack.rows[0].pull_requests === 0 && rolledBack.rows[0].subjects === 0,
    'PR writer failure did not roll back the PR projection and outbox row',
  );

  const deliveryId = randomUUID();
  const externalId = String(Math.floor(Math.random() * 1_000_000_000));
  const mergedAt = new Date().toISOString();
  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId, eventType: 'pr_closed',
    rawEvent: {
      action: 'closed', repository: { id: repo.external_id },
      pull_request: { id: externalId, merged_at: mergedAt, merge_commit_sha: fixture.mergeSha },
    },
  });
  const pullRequestId = await db.transaction(transaction => upsertPullRequestObservation(transaction, {
    eventType: 'pr_closed', tenantId: fixture.tenantId, repositoryId: repo.id,
    provider: 'github', providerDeliveryId: deliveryId,
    pullRequest: {
      externalId, number: 2, title: 'Synthetic merged PR', state: 'merged',
      authorEmail: null, authorProviderId: 'task2-reviewer',
      authorLogin: 'task2-reviewer', headRef: 'task2', baseRef: 'main',
      headSha: fixture.mergeSha, mergedAt, mergeCommitSha: fixture.mergeSha,
    },
  }));
  const row = await pool.query<{ seconds_ahead: number }>(
    `select extract(epoch from (not_before - created_at))::float8 as seconds_ahead
     from attesta_subjects where tenant_id = $1 and kind = 'pr_merged'`,
    [fixture.tenantId],
  );
  check(row.rows.length === 1 && row.rows[0].seconds_ahead >= 299 && row.rows[0].seconds_ahead <= 301,
    'merged PR did not produce one row about five minutes ahead');
  await db.transaction(transaction => enqueuePrMergedSubject(transaction, {
    eventType: 'pr_closed', tenantId: fixture.tenantId, repositoryId: repo.id,
    provider: 'github', providerDeliveryId: deliveryId,
    pullRequestId, mergedAt, mergeCommitSha: fixture.mergeSha,
  }));
  check(await outboxCount(fixture.tenantId, 'pr_merged') === 1, 'merge redelivery added an outbox row');
  await db.transaction(transaction => enqueuePrMergedSubject(transaction, {
    eventType: 'pr_closed', tenantId: fixture.tenantId, repositoryId: repo.id,
    provider: 'github', providerDeliveryId: deliveryId,
    pullRequestId: null, mergedAt: null, mergeCommitSha: null,
  }));
  check(await outboxCount(fixture.tenantId, 'pr_merged') === 1, 'closed-unmerged PR added an outbox row');
}

async function verifyDeploymentObservation(fixture: TenantFixture): Promise<void> {
  const repo = await repository(fixture);
  const rollbackDelivery = randomUUID();
  const rollbackExternalId = `deployment-rollback-${randomUUID()}`;
  const successDelivery = randomUUID();
  const deliveryRaw = (state: string) => ({
    repository: { id: repo.external_id },
    deployment: { id: fixture.deploymentExternalId, sha: fixture.commitSha },
    deployment_status: { state },
  });
  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId: rollbackDelivery, eventType: 'deployment_status', rawEvent: deliveryRaw('success'),
  });
  await recordDeployment({
    tenantId: fixture.tenantId, repositoryId: repo.id, provider: 'github',
    providerDeliveryId: rollbackDelivery, externalId: rollbackExternalId,
    environment: 'production', ref: 'main', sha: fixture.commitSha,
    status: 'success', production: true, deployedAt: new Date(),
  }, undefined, async () => {
    throw new AttestaOutboxError('ATTESTA_OUTBOX_SOURCE_NOT_FOUND', 'synthetic writer failure');
  }).catch(() => undefined);
  const rolledBack = await pool.query<{
    deployments: number;
    lifecycle_rows: number;
    subjects: number;
  }>(
    `select
       (select count(*)::int from scm_deployments where tenant_id = $1 and external_id = $2) as deployments,
       (select count(*)::int from ai_code_lifecycle_events where tenant_id = $1 and evidence_ref like $3) as lifecycle_rows,
       (select count(*)::int from attesta_subjects where tenant_id = $1 and provider_delivery_id = $4) as subjects`,
    [fixture.tenantId, rollbackExternalId, `deployment:${rollbackExternalId}:%`, rollbackDelivery],
  );
  check(
    rolledBack.rows[0].deployments === 0
      && rolledBack.rows[0].lifecycle_rows === 0
      && rolledBack.rows[0].subjects === 0,
    'deployment writer failure did not roll back deployment, lifecycle, and outbox rows',
  );

  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId: successDelivery, eventType: 'deployment_status', rawEvent: deliveryRaw('success'),
  });
  await recordDeployment({
    tenantId: fixture.tenantId, repositoryId: repo.id, provider: 'github',
    providerDeliveryId: successDelivery, externalId: fixture.deploymentExternalId,
    environment: 'production', ref: 'main', sha: fixture.commitSha,
    status: 'success', production: true, deployedAt: new Date(),
  });
  check(await outboxCount(fixture.tenantId, 'deployed') === 1, 'production success produced one deployed row');

  const failedDelivery = randomUUID();
  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId: failedDelivery, eventType: 'deployment_status', rawEvent: deliveryRaw('failure'),
  });
  await recordDeployment({
    tenantId: fixture.tenantId, repositoryId: repo.id, provider: 'github',
    providerDeliveryId: failedDelivery, externalId: `${fixture.deploymentExternalId}-failed`,
    environment: 'production', ref: 'main', sha: fixture.commitSha,
    status: 'failure', production: true, deployedAt: new Date(),
  });
  check(await outboxCount(fixture.tenantId, 'deployed') === 1, 'failed deployment added an outbox row');

  const secondSuccessDelivery = randomUUID();
  await insertDelivery({
    fixture, repositoryId: repo.id,
    deliveryId: secondSuccessDelivery, eventType: 'deployment_status', rawEvent: deliveryRaw('success'),
  });
  await recordDeployment({
    tenantId: fixture.tenantId, repositoryId: repo.id, provider: 'github',
    providerDeliveryId: secondSuccessDelivery, externalId: fixture.deploymentExternalId,
    environment: 'production', ref: 'main', sha: fixture.commitSha,
    status: 'success', production: true, deployedAt: new Date(),
  });
  check(await outboxCount(fixture.tenantId, 'deployed') === 1, 'second success delivery added another row');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const host = new URL(process.env.DATABASE_URL).hostname;
  check(['127.0.0.1', 'localhost'].includes(host), 'a local disposable database is required');

  try {
    const latency = await benchmarkCommitNormalization();
    const companyA = await seedTenant('a');
    const companyB = await seedTenant('b');
    await verifyCommitObservation(companyA);
    await verifyPullRequestObservation(companyA);
    await verifyDeploymentObservation(companyA);
    await verifyCommitObservation(companyB);
    await verifyPullRequestObservation(companyB);
    await verifyDeploymentObservation(companyB);

    check(await outboxCount(companyA.tenantId) === 3, 'Company A does not own exactly three rows');
    check(await outboxCount(companyB.tenantId) === 3, 'Company B does not own exactly three rows');
    const crossed = await pool.query<{ count: number }>(
      `select count(*)::int as count from attesta_subjects s
       left join scm_repositories r on r.id = s.repository_id and r.tenant_id = s.tenant_id
       where s.tenant_id = any($1::uuid[]) and r.id is null`,
      [[companyA.tenantId, companyB.tenantId]],
    );
    check(crossed.rows[0].count === 0, 'an outbox row crossed tenant ownership');

    console.log('IT-T2AT-01=passed');
    console.log('IT-T2AT-02=passed');
    console.log('IT-T2AT-03=passed');
    console.log('IT-T2AT-04=passed');
    console.log(`commit_normalization_latency_before_ms=${latency.beforeMs.toFixed(2)}`);
    console.log(`commit_normalization_latency_after_ms=${latency.afterMs.toFixed(2)}`);
    console.log('lifecycle_totals_after_replay_and_rebuild=unchanged');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Task2 Attesta live verify failed');
  process.exitCode = 1;
});
