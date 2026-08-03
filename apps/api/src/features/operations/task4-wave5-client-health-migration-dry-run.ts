import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0008_spicy_prodigy.sql');

async function operationIsBlocked(
  client: PoolClient,
  savepoint: string,
  statement: string,
  values: unknown[],
  expectedCode: string,
): Promise<boolean> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(statement, values);
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return false;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return (error as PgFailure).code === expectedCode;
  }
}

async function tableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(`
    SELECT to_regclass('public.machine_delivery_health_reports') IS NOT NULL AS present
  `);
  return result.rows[0].present;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave5-client-health-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    if (await tableExists(client)) throw new Error('Client health migration is already applied');
    const tenants = (await client.query<{ id: string }>(`
      SELECT id FROM sso_tenants ORDER BY id LIMIT 2
    `)).rows;
    if (tenants.length !== 2) throw new Error('Two existing tenants are required');

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(await readFile(migrationPath, 'utf8'));

    const machineA = randomUUID();
    const machineB = randomUUID();
    await client.query(`
      INSERT INTO developer_machines (
        id, tenant_id, installation_id, display_name, status
      ) VALUES
        ($1, $2, $3, 'Wave 5 health dry-run A', 'active'),
        ($4, $5, $6, 'Wave 5 health dry-run B', 'active')
    `, [machineA, tenants[0].id, `wave5-health-a-${machineA}`, machineB, tenants[1].id, `wave5-health-b-${machineB}`]);

    await client.query(`
      INSERT INTO machine_delivery_health_reports (
        tenant_id, machine_id, schema_version, observed_at,
        pending_retryable, waiting_retry, processing, quarantined,
        rows_with_errors, oldest_pending_at, last_delivered_at
      ) VALUES ($1, $2, 1, now(), 1, 2, 0, 3, 4,
        now() - interval '1 hour', now() - interval '1 minute')
    `, [tenants[0].id, machineA]);

    const crossTenantMachineBlocked = await operationIsBlocked(
      client,
      'cross_tenant_machine',
      `INSERT INTO machine_delivery_health_reports (
        tenant_id, machine_id, schema_version, observed_at,
        pending_retryable, waiting_retry, processing, quarantined, rows_with_errors
      ) VALUES ($1, $2, 1, now(), 0, 0, 0, 0, 0)`,
      [tenants[1].id, machineA],
      '23503',
    );
    const excessiveCountBlocked = await operationIsBlocked(
      client,
      'excessive_count',
      `UPDATE machine_delivery_health_reports
       SET pending_retryable = 1000001 WHERE tenant_id = $1 AND machine_id = $2`,
      [tenants[0].id, machineA],
      '23514',
    );
    const invalidTimestampBlocked = await operationIsBlocked(
      client,
      'invalid_timestamp',
      `UPDATE machine_delivery_health_reports
       SET oldest_pending_at = observed_at + interval '1 second'
       WHERE tenant_id = $1 AND machine_id = $2`,
      [tenants[0].id, machineA],
      '23514',
    );
    await client.query(`
      UPDATE machine_delivery_health_reports
      SET observed_at = now() + interval '1 second', pending_retryable = 2,
          received_at = now()
      WHERE tenant_id = $1 AND machine_id = $2
    `, [tenants[0].id, machineA]);

    const checks = await client.query<{
      rls: string;
      constraints: string;
      plaintext: string;
      rows: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pg_class
         WHERE oid = 'public.machine_delivery_health_reports'::regclass
           AND relrowsecurity) AS rls,
        (SELECT count(*)::text FROM pg_constraint WHERE conname IN (
          'machine_delivery_health_reports_schema_version_check',
          'machine_delivery_health_reports_count_check',
          'machine_delivery_health_reports_timestamp_check'
        )) AS constraints,
        (SELECT count(*)::text FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'machine_delivery_health_reports'
           AND column_name ~ '(credential|private_key|token|secret|prompt|raw_event|raw_payload|reason)') AS plaintext,
        (SELECT count(*)::text FROM machine_delivery_health_reports) AS rows
    `);
    const check = checks.rows[0];
    if (Number(check.rls) !== 1
      || Number(check.constraints) !== 3
      || Number(check.plaintext) !== 0
      || Number(check.rows) !== 1
      || !crossTenantMachineBlocked
      || !excessiveCountBlocked
      || !invalidTimestampBlocked) {
      throw new Error('Client health migration dry-run checks failed');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;
    if (await tableExists(client)) throw new Error('Client health migration did not roll back');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log('client_health_tables=1');
    console.log('rls_enabled_tables=1');
    console.log('hardening_constraints=3');
    console.log('unexpected_sensitive_columns=0');
    console.log('cross_tenant_machine_report=blocked');
    console.log('excessive_count=blocked');
    console.log('future_pending_timestamp=blocked');
    console.log('latest_snapshot_update=accepted');
    console.log('migration_dry_run=rolled-back');
    console.log('after_rollback_tables=0');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Client health migration dry-run failed');
  process.exitCode = 1;
});
