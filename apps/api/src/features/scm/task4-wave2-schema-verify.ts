import 'dotenv/config';

import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave2-schema-verify',
  });

  try {
    const result = await pool.query<{
      provider_tables: string;
      rls_tables: string;
      lease_columns: string;
      delivery_indexes: string;
      immutable_triggers: string;
      plaintext_columns: string;
      journal_rows: string;
    }>(`
      SELECT
        (
          SELECT count(*) FROM (VALUES
            (to_regclass('public.provider_event_deliveries')),
            (to_regclass('public.provider_projection_cursors'))
          ) AS expected(table_name)
          WHERE table_name IS NOT NULL
        )::text AS provider_tables,
        (
          SELECT count(*) FROM pg_class
          WHERE oid IN (
            'public.provider_event_deliveries'::regclass,
            'public.provider_projection_cursors'::regclass
          ) AND relrowsecurity
        )::text AS rls_tables,
        (
          SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'provider_event_deliveries'
            AND column_name = 'processing_started_at'
        )::text AS lease_columns,
        (
          SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'provider_event_deliveries_tenant_received_at_idx',
              'provider_event_deliveries_tenant_provider_fingerprint_idx'
            )
        )::text AS delivery_indexes,
        (
          SELECT count(*) FROM pg_trigger
          WHERE tgrelid = 'public.provider_event_deliveries'::regclass
            AND tgname = 'provider_event_deliveries_evidence_immutable'
            AND NOT tgisinternal
        )::text AS immutable_triggers,
        (
          SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('provider_event_deliveries', 'provider_projection_cursors')
            AND column_name ~ '(secret|token|api_key|private_key)'
        )::text AS plaintext_columns,
        (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS journal_rows
    `);

    const row = result.rows[0];
    const checks = {
      providerTables: Number(row.provider_tables) === 2,
      rlsTables: Number(row.rls_tables) === 2,
      leaseColumn: Number(row.lease_columns) === 1,
      deliveryIndexes: Number(row.delivery_indexes) === 2,
      immutableTrigger: Number(row.immutable_triggers) === 1,
      plaintextColumns: Number(row.plaintext_columns) === 0,
      journalRows: Number(row.journal_rows) >= 5,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('Wave 2 persistent schema verification failed');
    }

    console.log('task4_provider_tables=2');
    console.log('rls_enabled_tables=2');
    console.log('processing_lease_column=present');
    console.log('delivery_indexes=2');
    console.log('immutable_trigger=present');
    console.log('unexpected_plaintext_columns=0');
    console.log(`journal_rows=${row.journal_rows}`);
    console.log('schema_verification=passed');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 schema verification failed');
  process.exitCode = 1;
});
