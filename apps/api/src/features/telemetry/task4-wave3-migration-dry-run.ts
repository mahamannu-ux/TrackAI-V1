import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0005_tearful_lake.sql');

async function mutationIsBlocked(
  client: PoolClient,
  savepoint: string,
  sql: string,
  values: unknown[],
): Promise<boolean> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, values);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return false;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return (error as PgFailure).code === 'P0001';
  }
}

async function wave3ObjectCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT (
      CASE WHEN to_regclass('public.repository_backfill_authorizations') IS NULL THEN 0 ELSE 1 END
      + (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND (
           (table_name = 'repository_enrollments' AND column_name IN (
             'generation_session_evidence_from', 'commit_note_evidence_from'
           )) OR
           (table_name = 'telemetry_metric_events' AND column_name IN (
             'enrollment_id', 'evidence_family', 'arrival_class', 'backfill_authorization_id'
           ))
         ))
    )::text AS count
  `);
  return Number(result.rows[0].count);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave3-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    if (await wave3ObjectCount(client) !== 0) {
      throw new Error('Wave 3 watermark objects already exist; dry-run expects an unapplied migration');
    }
    const migrationSql = await readFile(migrationPath, 'utf8');
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(migrationSql);

    const objects = await wave3ObjectCount(client);
    const rls = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_class
      WHERE oid = 'public.repository_backfill_authorizations'::regclass AND relrowsecurity
    `);
    const triggers = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_trigger
      WHERE tgname IN (
        'repository_backfill_authorizations_evidence_immutable',
        'telemetry_metric_events_evidence_immutable'
      ) AND NOT tgisinternal
    `);
    const [enrollment] = (await client.query<{ id: string; tenant_id: string }>(`
      SELECT id, tenant_id FROM repository_enrollments ORDER BY created_at, id LIMIT 1
    `)).rows;
    const [metric] = (await client.query<{ id: string }>(`
      SELECT id FROM telemetry_metric_events ORDER BY created_at, id LIMIT 1
    `)).rows;
    if (!enrollment || !metric) throw new Error('Existing enrollment and metric evidence are required');

    const authorizationId = randomUUID();
    await client.query(`
      INSERT INTO repository_backfill_authorizations (
        id, tenant_id, enrollment_id, evidence_family, occurred_from, occurred_until,
        expires_at, authorized_by, reason
      ) VALUES ($1, $2, $3, 'generation_session', now() - interval '2 days',
        now() - interval '1 day', now() + interval '1 hour', 'task4-dry-run', 'dry run')
    `, [authorizationId, enrollment.tenant_id, enrollment.id]);
    await client.query(`
      UPDATE repository_backfill_authorizations SET status = 'revoked', revoked_at = now()
      WHERE id = $1
    `, [authorizationId]);
    const authScopeUpdateBlocked = await mutationIsBlocked(
      client,
      'auth_scope_update',
      `UPDATE repository_backfill_authorizations SET reason = 'changed' WHERE id = $1`,
      [authorizationId],
    );
    const metricRawUpdateBlocked = await mutationIsBlocked(
      client,
      'metric_raw_update',
      `UPDATE telemetry_metric_events SET raw_event = '{"changed":true}'::jsonb WHERE id = $1`,
      [metric.id],
    );
    await client.query(`
      UPDATE telemetry_metric_events SET normalization_status = normalization_status WHERE id = $1
    `, [metric.id]);

    if (objects !== 7 || Number(rls.rows[0].count) !== 1
      || Number(triggers.rows[0].count) !== 2
      || !authScopeUpdateBlocked || !metricRawUpdateBlocked) {
      throw new Error('One or more Wave 3 migration dry-run checks failed');
    }
    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await wave3ObjectCount(client);
    if (after !== 0) throw new Error('Wave 3 migration dry-run did not roll back cleanly');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log('inside_transaction_objects=7');
    console.log('backfill_authorization_rls=enabled');
    console.log('immutable_triggers=2');
    console.log('authorization_scope_update=blocked');
    console.log('authorization_revocation=accepted');
    console.log('metric_raw_update=blocked');
    console.log('metric_normalization_update=accepted');
    console.log('migration_dry_run=rolled-back');
    console.log(`after_rollback_objects=${after}`);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 3 migration dry-run failed');
  process.exitCode = 1;
});
