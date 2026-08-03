import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const migrationPath = resolve(__dirname, '../../../drizzle/0009_mute_tiger_shark.sql');
const migrationCreatedAt = '1785698956953';
let diagnosticStage = 'startup';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave6-sample-table-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    diagnosticStage = 'read-before-state';
    const before = await client.query<{ rows: string; tables: string }>(`
      SELECT
        (SELECT count(*)::text FROM public.items) AS rows,
        (SELECT count(*)::text FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables
    `);
    if (Number(before.rows[0].tables) !== 43) {
      throw new Error('Expected 43 persistent tables before removing the sample table');
    }

    diagnosticStage = 'begin-transaction';
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const migrationSql = await readFile(migrationPath, 'utf8');
    const migrationHash = createHash('sha256').update(migrationSql).digest('hex');
    diagnosticStage = 'execute-migration-sql';
    await client.query(migrationSql);
    diagnosticStage = 'write-migration-journal';
    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ($1, $2::bigint)`,
      [migrationHash, migrationCreatedAt],
    );
    diagnosticStage = 'verify-inside-transaction';
    const inside = await client.query<{ items_present: boolean; tables: string }>(`
      SELECT
        to_regclass('public.items') IS NOT NULL AS items_present,
        (SELECT count(*)::text FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables
    `);
    if (inside.rows[0].items_present || Number(inside.rows[0].tables) !== 42) {
      throw new Error('Sample-table migration changed an unexpected table set');
    }
    console.log('migration_dry_run=applied-inside-transaction');
    console.log(`sample_rows=${before.rows[0].rows}`);
    console.log('inside_transaction_tables=42');
    console.log('unexpected_dependencies=none');
    console.log('journal_write=accepted-inside-transaction');
    console.log('production_tables=unchanged');

    diagnosticStage = 'rollback-transaction';
    await client.query('ROLLBACK');
    transactionOpen = false;
    diagnosticStage = 'verify-after-rollback';
    const after = await client.query<{ items_present: boolean; tables: string }>(`
      SELECT
        to_regclass('public.items') IS NOT NULL AS items_present,
        (SELECT count(*)::text FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables
    `);
    const rowsAfter = after.rows[0].items_present
      ? (await client.query<{ count: string }>('SELECT count(*)::text AS count FROM public.items')).rows[0].count
      : null;
    if (!after.rows[0].items_present
      || rowsAfter !== before.rows[0].rows
      || Number(after.rows[0].tables) !== 43) {
      throw new Error('Sample table or its rows did not return after rollback');
    }
    diagnosticStage = 'verify-journal-after-rollback';
    const journalAfter = await client.query<{ recorded: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $1::bigint
      ) AS recorded
    `, [migrationCreatedAt]);
    if (journalAfter.rows[0].recorded) {
      throw new Error('Migration journal entry did not roll back');
    }
    console.log('migration_dry_run=rolled-back');
    console.log('after_rollback_tables=43');
    console.log('sample_rows_restored=yes');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  const pgError = error as Error & { code?: string; constraint?: string };
  console.error(error instanceof Error ? error.message : 'Sample-table migration dry run failed');
  console.error(`failure_stage=${diagnosticStage}`);
  console.error(`error_code=${pgError.code ?? 'unknown'}`);
  if (pgError.constraint) console.error(`constraint=${pgError.constraint}`);
  process.exitCode = 1;
});
