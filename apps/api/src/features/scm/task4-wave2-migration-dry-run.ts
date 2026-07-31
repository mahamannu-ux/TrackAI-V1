import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };

const migrationPath = resolve(__dirname, '../../../drizzle/0004_majestic_lucky_pierre.sql');

async function mutationIsBlocked(
  client: PoolClient,
  savepoint: string,
  sql: string,
  deliveryId: string,
): Promise<boolean> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, [deliveryId]);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return false;
  } catch (error) {
    const failure = error as PgFailure;
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return failure.code === 'P0001';
  }
}

async function tableCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM (VALUES
      (to_regclass('public.provider_event_deliveries')),
      (to_regclass('public.provider_projection_cursors'))
    ) AS task4_tables(table_name)
    WHERE table_name IS NOT NULL
  `);
  return Number(result.rows[0].count);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave2-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    const before = await tableCount(client);
    if (before !== 0) {
      throw new Error('Wave 2 provider tables already exist; dry-run expects an unapplied migration');
    }

    const migrationSql = await readFile(migrationPath, 'utf8');
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(migrationSql);

    const insideTables = await tableCount(client);
    const rls = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_class
      WHERE oid IN (
        'public.provider_event_deliveries'::regclass,
        'public.provider_projection_cursors'::regclass
      ) AND relrowsecurity
    `);
    const leaseColumn = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'provider_event_deliveries'
        AND column_name = 'processing_started_at'
    `);
    const indexes = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'provider_event_deliveries_tenant_received_at_idx',
          'provider_event_deliveries_tenant_provider_fingerprint_idx'
        )
    `);
    const trigger = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_trigger
      WHERE tgrelid = 'public.provider_event_deliveries'::regclass
        AND tgname = 'provider_event_deliveries_evidence_immutable'
        AND NOT tgisinternal
    `);
    const [tenant] = (await client.query<{ id: string }>(`
      SELECT id FROM sso_tenants ORDER BY created_at, id LIMIT 1
    `)).rows;
    if (!tenant) throw new Error('At least one tenant is required for rollback-only verification');

    const deliveryId = `task4-wave2-dry-run-${randomUUID()}`;
    await client.query(`
      INSERT INTO provider_event_deliveries (
        tenant_id, provider, delivery_id, event_type, event_fingerprint,
        provider_occurred_at, raw_event, processing_started_at
      ) VALUES ($1, 'github', $2, 'push', $3, now(), $4::jsonb, now())
    `, [tenant.id, deliveryId, 'a'.repeat(64), JSON.stringify({ dryRun: true })]);
    await client.query(`
      UPDATE provider_event_deliveries
      SET processing_status = 'projected', error_code = NULL
      WHERE delivery_id = $1
    `, [deliveryId]);

    const rawUpdateBlocked = await mutationIsBlocked(
      client,
      'raw_update_blocked',
      `UPDATE provider_event_deliveries
       SET raw_event = '{"changed":true}'::jsonb WHERE delivery_id = $1`,
      deliveryId,
    );
    const deleteBlocked = await mutationIsBlocked(
      client,
      'delete_blocked',
      'DELETE FROM provider_event_deliveries WHERE delivery_id = $1',
      deliveryId,
    );

    const checks = {
      insideTables: insideTables === 2,
      rls: Number(rls.rows[0].count) === 2,
      leaseColumn: Number(leaseColumn.rows[0].count) === 1,
      indexes: Number(indexes.rows[0].count) === 2,
      trigger: Number(trigger.rows[0].count) === 1,
      rawUpdateBlocked,
      deleteBlocked,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('One or more Wave 2 migration dry-run checks failed');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await tableCount(client);
    if (after !== 0) throw new Error('Wave 2 migration dry-run did not roll back cleanly');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log(`inside_transaction_tables=${insideTables}`);
    console.log('rls_enabled_tables=2');
    console.log('processing_lease_column=present');
    console.log('delivery_indexes=2');
    console.log('immutable_raw_update=blocked');
    console.log('immutable_delete=blocked');
    console.log('operational_status_update=accepted');
    console.log('migration_dry_run=rolled-back');
    console.log(`after_rollback_tables=${after}`);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 migration dry-run failed');
  process.exitCode = 1;
});
