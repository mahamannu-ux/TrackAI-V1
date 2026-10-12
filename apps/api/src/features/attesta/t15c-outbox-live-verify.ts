/**
 * IT-T15c-01: the attesta_subjects outbox against real PostgreSQL.
 *
 *   scripts/it-db.sh npm run verify:task15c-outbox-live -w apps/api
 *
 * Proves: idempotency on replay (same row back), a changed replay refused,
 * rollback leaves no row, two concurrent writers produce one row, Company A/B
 * isolation (B cannot use or read A's sources or rows), identity columns are
 * immutable, the per-kind shape check holds, and RLS is enabled with no
 * policies. Prints only safe summary lines.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import { AttestaOutboxError, enqueueAttestaSubject, type EnqueueAttestaSubjectInput } from './outbox';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15c-01 failed: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, label: string) {
  try {
    await promise;
  } catch (error) {
    check(error instanceof AttestaOutboxError && error.code === code, `${label}: expected ${code}`);
    return;
  }
  throw new Error(`IT-T15c-01 failed: ${label}: expected ${code}, got success`);
}

async function expectDatabaseError(statement: string, params: unknown[], label: string) {
  try {
    await pool.query(statement, params);
  } catch {
    return;
  }
  throw new Error(`IT-T15c-01 failed: ${label}: the database accepted it`);
}

const hexSha = () => randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40);

interface Seeded {
  tenantId: string;
  repositoryId: string;
  metricEventId: string;
  commitId: string;
  commitSha: string;
  commitId2: string;
  commitSha2: string;
  pullRequestId: string;
  mergeSha: string;
  deliveryId: string;
  deploymentId: string;
  deploymentExternalId: string;
  deployDeliveryId: string;
  deployDeliveryId2: string;
  unrelatedDeliveryId: string;
}

async function seedTenant(label: string): Promise<Seeded> {
  const s: Seeded = {
    tenantId: randomUUID(), repositoryId: randomUUID(), metricEventId: randomUUID(),
    commitId: randomUUID(), commitSha: hexSha(), commitId2: randomUUID(), commitSha2: hexSha(), pullRequestId: randomUUID(), mergeSha: hexSha(),
    deliveryId: randomUUID(), deploymentId: randomUUID(), deploymentExternalId: String(Date.now()) + label,
    deployDeliveryId: randomUUID(), deployDeliveryId2: randomUUID(), unrelatedDeliveryId: randomUUID(),
  };
  const batchId = randomUUID();
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [s.tenantId, `IT ${label}`, `it-t15c-${label}-${s.tenantId}.example`, `it-${label}`],
  );
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url, normalized_url)
     values ($1, $2, 'github', $3, 'payments-service', $4, $4)`,
    [s.repositoryId, s.tenantId, `ext-${s.repositoryId}`, `https://github.com/it-${label}/payments-service`],
  );
  await pool.query(
    `insert into telemetry_ingest_batches (id, tenant_id, api_version, payload_hash, event_count, payload)
     values ($1, $2, 1, $3, 1, '{}'::jsonb)`,
    [batchId, s.tenantId, randomUUID()],
  );
  await pool.query(
    `insert into telemetry_metric_events (id, tenant_id, batch_id, event_index, event_fingerprint, event_kind, event_timestamp, raw_event)
     values ($1, $2, $3, 0, $4, 1, now(), '{}'::jsonb)`,
    [s.metricEventId, s.tenantId, batchId, randomUUID()],
  );
  await pool.query(
    `insert into scm_commits (id, tenant_id, repository_id, sha, subject) values ($1, $2, $3, $4, 'synthetic'), ($5, $2, $3, $6, 'synthetic')`,
    [s.commitId, s.tenantId, s.repositoryId, s.commitSha, s.commitId2, s.commitSha2],
  );
  await pool.query(
    `insert into scm_pull_requests (id, tenant_id, repository_id, external_id, title, state, merge_commit_sha, merged_at)
     values ($1, $2, $3, $4, 'synthetic', 'merged', $5, now())`,
    [s.pullRequestId, s.tenantId, s.repositoryId, `pr-${s.pullRequestId}`, s.mergeSha],
  );
  await pool.query(
    `insert into provider_event_deliveries (tenant_id, repository_id, provider, delivery_id, event_type, event_fingerprint, raw_event)
     values ($1, $2, 'github', $3, 'pr_closed', $4, '{}'::jsonb),
            ($1, $2, 'github', $5, 'deployment_status', $6, '{}'::jsonb),
            ($1, $2, 'github', $7, 'deployment_status', $8, '{}'::jsonb),
            ($1, $2, 'github', $9, 'pr_opened', $10, '{}'::jsonb)`,
    [s.tenantId, s.repositoryId, s.deliveryId, randomUUID(), s.deployDeliveryId, randomUUID(),
      s.deployDeliveryId2, randomUUID(), s.unrelatedDeliveryId, randomUUID()],
  );
  await pool.query(
    `insert into scm_deployments (id, tenant_id, repository_id, provider, external_id, environment, sha, status, production, deployed_at)
     values ($1, $2, $3, 'github', $4, 'production', $5, 'success', true, now())`,
    [s.deploymentId, s.tenantId, s.repositoryId, s.deploymentExternalId, s.mergeSha],
  );
  return s;
}

const inputs = (s: Seeded): EnqueueAttestaSubjectInput[] => [
  { kind: 'commit_observed', tenantId: s.tenantId, repositoryId: s.repositoryId, commitSha: s.commitSha,
    metricEventId: s.metricEventId, commitId: s.commitId },
  { kind: 'pr_merged', tenantId: s.tenantId, repositoryId: s.repositoryId, commitSha: s.mergeSha,
    provider: 'github', providerDeliveryId: s.deliveryId, pullRequestId: s.pullRequestId,
    notBefore: new Date(Date.now() + 300_000) },
  { kind: 'deployed', tenantId: s.tenantId, repositoryId: s.repositoryId, commitSha: s.mergeSha,
    provider: 'github', providerDeliveryId: s.deployDeliveryId, deploymentId: s.deploymentId,
    deploymentExternalId: s.deploymentExternalId, deploymentStatus: 'success' },
];

async function countRows(tenantId: string): Promise<number> {
  const result = await pool.query('select count(*)::int as n from attesta_subjects where tenant_id = $1', [tenantId]);
  return result.rows[0].n as number;
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('IT-T15c-01 requires a local disposable database');

  try {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    // 1. Insert each kind, then replay: same row back, nothing new.
    for (const input of inputs(a)) {
      const first = await db.transaction((tx) => enqueueAttestaSubject(tx, input));
      const replay = await db.transaction((tx) => enqueueAttestaSubject(tx, input));
      check(first.inserted && !replay.inserted && first.id === replay.id, `${input.kind} replay`);
    }
    check(await countRows(a.tenantId) === 3, 'tenant A has exactly three rows');
    const times = await pool.query(
      `select count(*)::int as n from attesta_subjects s
       left join telemetry_metric_events e on e.id = s.metric_event_id
       left join scm_pull_requests pr on pr.id = s.pull_request_id
       left join scm_deployments dep on dep.id = s.deployment_id
       where s.tenant_id = $1 and s.event_at = coalesce(e.event_timestamp, pr.merged_at, dep.deployed_at)`,
      [a.tenantId],
    );
    check(times.rows[0].n === 3, 'event_at comes from each source row');
    const secondDelivery = { ...inputs(a)[2], providerDeliveryId: a.deployDeliveryId2 } as EnqueueAttestaSubjectInput;
    const redelivered = await db.transaction((tx) => enqueueAttestaSubject(tx, secondDelivery));
    check(!redelivered.inserted && await countRows(a.tenantId) === 3, 'second success delivery is the same observation');
    console.log('replay_idempotent=passed');

    // 2. A replay that changes the pointer is refused.
    const changed = { ...inputs(a)[0], commitId: a.commitId2, commitSha: a.commitSha2 } as EnqueueAttestaSubjectInput;
    await expectCode(db.transaction((tx) => enqueueAttestaSubject(tx, changed)), 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT', 'changed replay');
    const unrelated = { ...inputs(a)[1], providerDeliveryId: a.unrelatedDeliveryId } as EnqueueAttestaSubjectInput;
    await expectCode(db.transaction((tx) => enqueueAttestaSubject(tx, unrelated)), 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND', 'merge keyed on an unrelated delivery');
    console.log('changed_replay=blocked');

    // 3. Company B cannot use A's sources, nor read A's rows by replaying A's key.
    for (const input of inputs(a)) {
      const crossed = { ...input, tenantId: b.tenantId, repositoryId: b.repositoryId } as EnqueueAttestaSubjectInput;
      await expectCode(db.transaction((tx) => enqueueAttestaSubject(tx, crossed)), 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND', `cross-tenant ${input.kind}`);
      const repositoryOnly = { ...input, repositoryId: b.repositoryId } as EnqueueAttestaSubjectInput;
      await expectCode(db.transaction((tx) => enqueueAttestaSubject(tx, repositoryOnly)), 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT', `foreign repository ${input.kind}`);
    }
    check(await countRows(b.tenantId) === 0, 'tenant B has no rows after cross-tenant attempts');
    await expectDatabaseError(
      `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at)
       values ($1, $2, 'commit_observed', $3, $4, $5, now())`,
      [b.tenantId, a.repositoryId, randomUUID(), randomUUID(), a.commitSha],
      'B row pointing at A repository',
    );
    console.log('cross_tenant=blocked');

    // 4. Rollback leaves no row; B's own sources work.
    const [bCommit] = inputs(b);
    await db.transaction(async (tx) => {
      await enqueueAttestaSubject(tx, bCommit);
      tx.rollback();
    }).catch(() => undefined);
    check(await countRows(b.tenantId) === 0, 'rolled-back enqueue left no row');
    console.log('rollback=no_row');

    // 5. Two concurrent writers of the same observation produce one row.
    const results = await Promise.all([1, 2].map(() => db.transaction(async (tx) => {
      const result = await enqueueAttestaSubject(tx, bCommit);
      await tx.execute(sql`select pg_sleep(0.2)`);
      return result;
    })));
    check(results.filter((r) => r.inserted).length === 1 && results[0].id === results[1].id, 'concurrent writers');
    check(await countRows(b.tenantId) === 1, 'tenant B has one row');
    console.log('concurrent_writers=one_row');

    // 6. Identity columns are immutable; worker fields are not.
    const rowId = results[0].id;
    await expectDatabaseError('update attesta_subjects set commit_sha = $2 where id = $1', [rowId, hexSha()], 'identity update');
    await expectDatabaseError('update attesta_subjects set tenant_id = $2 where id = $1', [rowId, a.tenantId], 'tenant move');
    await pool.query(`update attesta_subjects set status = 'claimed', claimed_at = now(), attempts = attempts + 1 where id = $1`, [rowId]);
    await expectDatabaseError(`update attesta_subjects set last_error_code = 'free text' where id = $1`, [rowId], 'free-text error code');
    console.log('identity_immutable=passed');

    // 7. Shape check: a failed deployment is never an outbox row.
    await expectDatabaseError(
      `insert into attesta_subjects (tenant_id, repository_id, kind, commit_sha, provider, deployment_id, deployment_external_id, deployment_status, event_at)
       values ($1, $2, 'deployed', $3, 'github', $4, 'x', 'failure', now())`,
      [b.tenantId, b.repositoryId, b.mergeSha, b.deploymentId],
      'failed deployment row',
    );
    console.log('kind_shape=enforced');

    // 8. RLS is enabled and no policy opens the table to browsers.
    const rls = await pool.query(
      `select c.relrowsecurity as on, (select count(*)::int from pg_policies p where p.tablename = 'attesta_subjects') as policies
       from pg_class c where c.relname = 'attesta_subjects'`,
    );
    check(rls.rows[0]?.on === true && rls.rows[0]?.policies === 0, 'RLS enabled without policies');
    console.log('rls=enabled_no_policies');

    console.log(`tenant_a_rows=${await countRows(a.tenantId)}`);
    console.log(`tenant_b_rows=${await countRows(b.tenantId)}`);
    console.log('IT-T15c-01=passed');
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15c-01 failed');
  process.exitCode = 1;
});
