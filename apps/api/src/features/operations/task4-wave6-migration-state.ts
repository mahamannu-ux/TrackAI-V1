import 'dotenv/config';

import { Pool } from 'pg';

const expectedMigrationCreatedAt = '1785698956953';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave6-migration-state',
  });
  try {
    const result = await pool.query<{
      journal_rows: string;
      latest_created_at: string | null;
      expected_recorded: boolean;
      items_present: boolean | 't' | 'f';
      public_tables: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM drizzle.__drizzle_migrations) AS journal_rows,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations) AS latest_created_at,
        EXISTS (
          SELECT 1 FROM drizzle.__drizzle_migrations
          WHERE created_at = $1::bigint
        ) AS expected_recorded,
        to_regclass('public.items') IS NOT NULL AS items_present,
        (SELECT count(*)::text FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables
    `, [expectedMigrationCreatedAt]);
    const state = result.rows[0];
    const itemsPresent = state.items_present === true || state.items_present === 't';
    console.log(`journal_rows=${state.journal_rows}`);
    console.log(`latest_created_at=${state.latest_created_at ?? 'none'}`);
    console.log(`expected_0009_created_at=${expectedMigrationCreatedAt}`);
    console.log(`migration_0009_recorded=${state.expected_recorded ? 'yes' : 'no'}`);
    console.log(`items_table=${itemsPresent ? 'present' : 'absent'}`);
    console.log('items_rows=not-read');
    console.log(`public_tables=${state.public_tables}`);

    const consistentBefore = !state.expected_recorded && itemsPresent;
    const consistentAfter = state.expected_recorded && !itemsPresent;
    console.log(`migration_state=${consistentBefore ? 'not-applied' : consistentAfter ? 'applied' : 'inconsistent'}`);
    console.log('database_changes=none');
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  const pgError = error as Error & { code?: string; constraint?: string };
  console.error(`migration_state_diagnostic=failed`);
  console.error(`error_code=${pgError.code ?? 'unknown'}`);
  if (pgError.constraint) console.error(`constraint=${pgError.constraint}`);
  process.exitCode = 1;
});
