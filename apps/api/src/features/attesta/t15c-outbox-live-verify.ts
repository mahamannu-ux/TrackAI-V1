/**
 * IT-T15c-01: the attesta_subjects outbox against real PostgreSQL.
 *
 *   scripts/it-db.sh npm run verify:task15c-outbox-live -w apps/api
 *
 * Proves: idempotency on replay (same row back), same-tenant rows that do not
 * belong together refused (event/commit, delivery/PR, delivery/deployment),
 * a disagreeing stored pointer refused,
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
  repositoryUrl: string;
  repositoryExternalId: string;
  otherRepositoryUrl: string;
  metricEventId: string;
  sessionEventId: string;
  otherRepoEventId: string;
  staleEventId: string;
  commitId: string;
  commitSha: string;
  commitId2: string;
  commitSha2: string;
  pullRequestId: string;
  pullRequestId2: string;
  mergeSha: string;
  deliveryId: string;
  unrelatedDeliveryId: string;
  deploymentId: string;
  deploymentExternalId: string;
  deploymentId2: string;
  deployDeliveryId: string;
  deployDeliveryId2: string;
  failedDeliveryId: string;
}

let counter = 100_000;
const numericId = () => String(counter++);

async function seedTenant(label: string): Promise<Seeded> {
  const slug = `it-${label}-${randomUUID().slice(0, 8)}`;
  const s: Seeded = {
    tenantId: randomUUID(), repositoryId: randomUUID(),
    repositoryUrl: `https://github.com/${slug}/payments-service`, repositoryExternalId: numericId(),
    otherRepositoryUrl: `https://github.com/${slug}/other-service`,
    metricEventId: randomUUID(), sessionEventId: randomUUID(), otherRepoEventId: randomUUID(), staleEventId: randomUUID(),
    commitId: randomUUID(), commitSha: hexSha(), commitId2: randomUUID(), commitSha2: hexSha(),
    pullRequestId: randomUUID(), pullRequestId2: randomUUID(), mergeSha: hexSha(),
    deliveryId: randomUUID(), unrelatedDeliveryId: randomUUID(),
    deploymentId: randomUUID(), deploymentExternalId: numericId(), deploymentId2: randomUUID(),
    deployDeliveryId: randomUUID(), deployDeliveryId2: randomUUID(), failedDeliveryId: randomUUID(),
  };
  const prExternal = numericId();
  const prExternal2 = numericId();
  const deploymentExternal2 = numericId();
  const batchId = randomUUID();
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [s.tenantId, `IT ${label}`, `${slug}.example`, `it-${label}`],
  );
  await pool.query(
    `insert into scm_repositories (id, tenant_id, provider, external_id, name, url, normalized_url)
     values ($1, $2, 'github', $3, 'payments-service', $4, $5)`,
    [s.repositoryId, s.tenantId, s.repositoryExternalId, s.repositoryUrl, `github.com/${slug}/payments-service`],
  );
  await pool.query(
    `insert into telemetry_ingest_batches (id, tenant_id, api_version, payload_hash, event_count, payload)
     values ($1, $2, 1, $3, 4, '{}'::jsonb)`,
    [batchId, s.tenantId, randomUUID()],
  );
  // Synthetic Git AI events: only the attributes the binding reads (a.1 repo URL, a.3 sha).
  const event = (kind: number, url: string, sha: string) => JSON.stringify({ e: kind, t: 1791790000, v: {}, a: { 1: url, 3: sha } });
  await pool.query(
    `insert into telemetry_metric_events (id, tenant_id, batch_id, event_index, event_fingerprint, event_kind, event_timestamp, raw_event)
     values ($1, $2, $3, 0, $4, 1, now() - interval '1 minute', $5::jsonb),
            ($6, $2, $3, 1, $7, 2, now(), $8::jsonb),
            ($9, $2, $3, 2, $10, 1, now(), $11::jsonb),
            ($12, $2, $3, 3, $13, 7, now(), $14::jsonb)`,
    [s.metricEventId, s.tenantId, batchId, randomUUID(), event(1, s.repositoryUrl, s.commitSha),
      s.sessionEventId, randomUUID(), event(2, s.repositoryUrl, s.commitSha),
      s.otherRepoEventId, randomUUID(), event(1, s.otherRepositoryUrl, s.commitSha),
      s.staleEventId, randomUUID(), event(7, `git@github.com:${slug}/payments-service.git`, s.commitSha)],
  );
  await pool.query(
    `insert into scm_commits (id, tenant_id, repository_id, sha, subject) values ($1, $2, $3, $4, 'synthetic'), ($5, $2, $3, $6, 'synthetic')`,
    [s.commitId, s.tenantId, s.repositoryId, s.commitSha, s.commitId2, s.commitSha2],
  );
  await pool.query(
    `insert into scm_pull_requests (id, tenant_id, repository_id, external_id, title, state, merge_commit_sha, merged_at)
     values ($1, $2, $3, $4, 'synthetic', 'merged', $5, now() - interval '2 minutes'),
            ($6, $2, $3, $7, 'synthetic', 'merged', $5, now())`,
    [s.pullRequestId, s.tenantId, s.repositoryId, prExternal, s.mergeSha, s.pullRequestId2, prExternal2],
  );
  const repo = { id: Number(s.repositoryExternalId) };
  const merged = JSON.stringify({ action: 'closed', repository: repo,
    pull_request: { id: Number(prExternal), merge_commit_sha: s.mergeSha, merged_at: '2026-10-12T11:02:30Z' } });
  const opened = JSON.stringify({ action: 'opened', repository: repo,
    pull_request: { id: Number(prExternal), merge_commit_sha: s.mergeSha, merged_at: null } });
  const status = (state: string) => JSON.stringify({ repository: repo,
    deployment: { id: Number(s.deploymentExternalId), sha: s.mergeSha }, deployment_status: { state } });
  await pool.query(
    `insert into provider_event_deliveries (tenant_id, repository_id, provider, delivery_id, event_type, event_fingerprint, raw_event)
     values ($1, $2, 'github', $3, 'pr_closed', $4, $5::jsonb),
            ($1, $2, 'github', $6, 'pr_opened', $7, $8::jsonb),
            ($1, $2, 'github', $9, 'deployment_status', $10, $11::jsonb),
            ($1, null, 'github', $12, 'deployment_status', $13, $11::jsonb),
            ($1, $2, 'github', $14, 'deployment_status', $15, $16::jsonb)`,
    [s.tenantId, s.repositoryId, s.deliveryId, randomUUID(), merged,
      s.unrelatedDeliveryId, randomUUID(), opened,
      s.deployDeliveryId, randomUUID(), status('success'),
      s.deployDeliveryId2, randomUUID(),
      s.failedDeliveryId, randomUUID(), status('failure')],
  );
  await pool.query(
    `insert into scm_deployments (id, tenant_id, repository_id, provider, external_id, environment, sha, status, production, deployed_at)
     values ($1, $2, $3, 'github', $4, 'production', $5, 'success', true, now() - interval '3 minutes'),
            ($6, $2, $3, 'github', $7, 'production', $5, 'success', true, now())`,
    [s.deploymentId, s.tenantId, s.repositoryId, s.deploymentExternalId, s.mergeSha, s.deploymentId2, deploymentExternal2],
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

const enqueue = (input: EnqueueAttestaSubjectInput) => db.transaction((tx) => enqueueAttestaSubject(tx, input));

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

    // 2. Same-tenant rows that do not belong together are refused.
    const [aCommit, aMerge, aDeploy] = inputs(a);
    const mismatches: Array<[EnqueueAttestaSubjectInput, string]> = [
      [{ ...aCommit, metricEventId: a.metricEventId, commitId: a.commitId2, commitSha: a.commitSha2 } as EnqueueAttestaSubjectInput, 'event for commit X paired with commit Y'],
      [{ ...aCommit, metricEventId: a.sessionEventId } as EnqueueAttestaSubjectInput, 'session event paired with a commit'],
      [{ ...aCommit, metricEventId: a.otherRepoEventId } as EnqueueAttestaSubjectInput, 'event from another repository'],
      [{ ...aMerge, pullRequestId: a.pullRequestId2 } as EnqueueAttestaSubjectInput, 'merge delivery paired with another PR'],
      [{ ...aMerge, providerDeliveryId: a.unrelatedDeliveryId } as EnqueueAttestaSubjectInput, 'opened delivery keyed as a merge'],
      [{ ...aDeploy, deploymentId: a.deploymentId2 } as EnqueueAttestaSubjectInput, 'status delivery paired with another deployment'],
      [{ ...aDeploy, providerDeliveryId: a.failedDeliveryId } as EnqueueAttestaSubjectInput, 'failure status keyed as a success'],
    ];
    for (const [input, label] of mismatches) {
      await expectCode(enqueue(input), 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND', label);
    }
    check(await countRows(a.tenantId) === 3, 'mismatches added no row');
    // A rewrite-commit event from the scp-style URL binds.
    const rewrite = await enqueue({ ...aCommit, metricEventId: a.staleEventId } as EnqueueAttestaSubjectInput);
    check(rewrite.inserted, 'rewrite-commit event binds');
    console.log('same_tenant_mismatch=blocked');

    // A stored pointer that disagrees with a bound replay is refused, never merged.
    await pool.query(`delete from attesta_subjects where id = $1`, [rewrite.id]);
    await pool.query(
      `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at)
       values ($1, $2, 'commit_observed', $3, $4, $5, now())`,
      [a.tenantId, a.repositoryId, a.staleEventId, a.commitId2, a.commitSha2],
    );
    await expectCode(enqueue({ ...aCommit, metricEventId: a.staleEventId } as EnqueueAttestaSubjectInput), 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT', 'stale stored pointer');
    console.log('changed_replay=blocked');

    // 3. Company B cannot use A's sources, nor reach A's rows by replaying A's key.
    for (const input of inputs(a)) {
      const crossed = { ...input, tenantId: b.tenantId, repositoryId: b.repositoryId } as EnqueueAttestaSubjectInput;
      await expectCode(enqueue(crossed), 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND', `cross-tenant ${input.kind}`);
      const repositoryOnly = { ...input, repositoryId: b.repositoryId } as EnqueueAttestaSubjectInput;
      await expectCode(enqueue(repositoryOnly), 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND', `foreign repository ${input.kind}`);
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
      `insert into attesta_subjects (tenant_id, repository_id, kind, commit_sha, provider, provider_delivery_id, deployment_id, deployment_external_id, deployment_status, event_at)
       values ($1, $2, 'deployed', $3, 'github', 'd', $4, 'x', 'failure', now())`,
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
