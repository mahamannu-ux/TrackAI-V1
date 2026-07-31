import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { validateMetricsBatch } from './decoder';
import { evaluateManagedMachineIngestionPolicy } from './repository-enforcement';

const COMPANY_A_DOMAIN = 'purpletealabs.net';
const COMPANY_B_DOMAIN = 'customer-b-oidc.com';

type PgFailure = Error & { code?: string; constraint?: string };

const lifecycleCountsSql = `
  SELECT
    (SELECT count(*)::text FROM telemetry_metric_events) AS telemetry_metric_events,
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_session_usage) AS ai_session_usage,
    (SELECT count(*)::text FROM ai_generation_observations) AS ai_generation_observations,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events
`;

async function crossTenantAuthorizationIsBlocked(
  client: PoolClient,
  tenantId: string,
  enrollmentId: string,
  marker: string,
): Promise<boolean> {
  await client.query('SAVEPOINT cross_tenant_backfill');
  try {
    await client.query(`
      INSERT INTO repository_backfill_authorizations (
        tenant_id, enrollment_id, evidence_family, occurred_from, occurred_until,
        expires_at, authorized_by, reason
      ) VALUES ($1, $2, 'generation_session', now() - interval '2 days',
        now() - interval '1 day', now() + interval '1 hour', $3, 'cross tenant probe')
    `, [tenantId, enrollmentId, marker]);
    await client.query('ROLLBACK TO SAVEPOINT cross_tenant_backfill');
    await client.query('RELEASE SAVEPOINT cross_tenant_backfill');
    return false;
  } catch (error) {
    const failure = error as PgFailure;
    await client.query('ROLLBACK TO SAVEPOINT cross_tenant_backfill');
    await client.query('RELEASE SAVEPOINT cross_tenant_backfill');
    return failure.code === '23503'
      && failure.constraint === 'repository_backfill_authorizations_tenant_enrollment_fk';
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const marker = `task4-wave3-${randomUUID()}`;
  const base = new Date('2026-07-31T11:00:00.000Z');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave3-watermark-live-verify',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    const beforeLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const fixtures = await client.query<{
      domain: string;
      tenant_id: string;
      enrollment_id: string;
      normalized_url: string;
    }>(`
      SELECT lower(t.domain) AS domain, t.id AS tenant_id, e.id AS enrollment_id,
             r.normalized_url
      FROM sso_tenants t
      JOIN repository_enrollments e ON e.tenant_id = t.id
      JOIN scm_repositories r ON r.tenant_id = e.tenant_id AND r.id = e.repository_id
      WHERE lower(t.domain) = ANY($1::text[])
      ORDER BY e.created_at, e.id
    `, [[COMPANY_A_DOMAIN, COMPANY_B_DOMAIN]]);
    const companyA = fixtures.rows.find(row => row.domain === COMPANY_A_DOMAIN);
    const companyB = fixtures.rows.find(row => row.domain === COMPANY_B_DOMAIN);
    if (!companyA || !companyB) throw new Error('Company A/B enrollment fixtures are required');

    await client.query(`
      UPDATE repository_enrollments SET status = 'active', effective_from = $1,
        effective_until = NULL, generation_session_evidence_from = $1,
        commit_note_evidence_from = $1, updated_at = now()
      WHERE id = ANY($2::uuid[])
    `, [base, [companyA.enrollment_id, companyB.enrollment_id]]);
    const authorization = await client.query<{ id: string }>(`
      INSERT INTO repository_backfill_authorizations (
        tenant_id, enrollment_id, evidence_family, occurred_from, occurred_until,
        expires_at, authorized_by, reason
      ) VALUES ($1, $2, 'generation_session', $3, $4,
        now() + interval '1 hour', $5, 'rollback-only Company A verification')
      RETURNING id
    `, [
      companyA.tenant_id,
      companyA.enrollment_id,
      new Date(base.getTime() - 2 * 24 * 60 * 60 * 1000),
      new Date(base.getTime() - 1),
      marker,
    ]);
    const authorizationId = authorization.rows[0].id;
    const crossTenantBlocked = await crossTenantAuthorizationIsBlocked(
      client, companyB.tenant_id, companyA.enrollment_id, marker,
    );

    const event = (secondsFromBase: number, kind: number, repository: string) => ({
      t: Math.floor(base.getTime() / 1000) + secondsFromBase,
      e: kind,
      v: {},
      a: { '1': repository, '5': 'task4-wave3/main' },
    });
    const companyABatch = validateMetricsBatch({
      v: 1,
      events: [
        event(9 * 60, 5, companyA.normalized_url),
        event(60, 5, companyA.normalized_url),
        event(-24 * 60 * 60, 5, companyA.normalized_url),
        event(-24 * 60 * 60, 1, companyA.normalized_url),
      ],
    });
    const companyAPolicy = {
      enrollmentId: companyA.enrollment_id,
      generationSessionEvidenceFrom: base,
      commitNoteEvidenceFrom: base,
      backfillAuthorizations: [{
        id: authorizationId,
        evidenceFamily: 'generation_session' as const,
        occurredFrom: new Date(base.getTime() - 2 * 24 * 60 * 60 * 1000),
        occurredUntil: new Date(base.getTime() - 1),
        expiresAt: new Date(base.getTime() + 2 * 60 * 60 * 1000),
      }],
    };
    const companyADecision = await evaluateManagedMachineIngestionPolicy(
      companyABatch,
      async repository => repository === companyA.normalized_url ? companyAPolicy : null,
      new Date(base.getTime() + 10 * 60 * 1000),
    );
    const companyBDecision = await evaluateManagedMachineIngestionPolicy(
      validateMetricsBatch({
        v: 1,
        events: [event(-24 * 60 * 60, 5, companyB.normalized_url)],
      }),
      async repository => repository === companyB.normalized_url ? {
        enrollmentId: companyB.enrollment_id,
        generationSessionEvidenceFrom: base,
        commitNoteEvidenceFrom: base,
        backfillAuthorizations: [],
      } : null,
      new Date(base.getTime() + 10 * 60 * 1000),
    );

    const classes = companyADecision.labels.map(label => label.arrivalClass);
    const checks = {
      current: classes[0] === 'current',
      delayed: classes[1] === 'delayed',
      backfill: classes[2] === 'backfill'
        && companyADecision.labels[2].backfillAuthorizationId === authorizationId,
      familyMismatch: companyADecision.errors.some(error => error.index === 3),
      companyBFromNow: companyBDecision.errors.length === 1
        && companyBDecision.labels.length === 0,
      crossTenantBlocked,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('One or more Wave 3 Company A/B watermark checks failed');
    }
    await client.query('ROLLBACK');
    transactionOpen = false;

    const residual = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM repository_backfill_authorizations
      WHERE authorized_by = $1
    `, [marker]);
    const afterLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    if (Number(residual.rows[0].count) !== 0) {
      throw new Error('Wave 3 rollback left backfill authorization rows');
    }
    if (JSON.stringify(beforeLifecycle) !== JSON.stringify(afterLifecycle)) {
      throw new Error('Task2 lifecycle counts changed during Wave 3 verification');
    }

    console.log('company_a_tenant_and_enrollment=present');
    console.log('company_b_tenant_and_enrollment=present');
    console.log('current_evidence=accepted-and-labelled');
    console.log('delayed_evidence=accepted-and-labelled');
    console.log('company_a_generation_backfill=authorized-and-labelled');
    console.log('family_mismatch=blocked');
    console.log('company_b_without_authorization=from-now-blocked');
    console.log('cross_tenant_authorization=blocked');
    console.log('transaction=rolled-back');
    console.log('residual_probe_rows=0');
    console.log('task2_lifecycle_counts=unchanged');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 3 watermark verification failed');
  process.exitCode = 1;
});
