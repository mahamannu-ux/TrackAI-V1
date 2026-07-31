import 'dotenv/config';

import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave3-schema-verify',
  });
  try {
    const result = await pool.query<{
      watermark_objects: string;
      rls_tables: string;
      immutable_triggers: string;
      bounded_constraints: string;
      plaintext_columns: string;
      missing_watermarks: string;
      unexpected_existing_labels: string;
      active_authorization_rows: string;
      revoked_authorization_rows: string;
      journal_rows: string;
    }>(`
      SELECT
        (
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
        )::text AS watermark_objects,
        (SELECT count(*) FROM pg_class
         WHERE oid = 'public.repository_backfill_authorizations'::regclass
           AND relrowsecurity)::text AS rls_tables,
        (SELECT count(*) FROM pg_trigger
         WHERE tgname IN (
           'repository_backfill_authorizations_evidence_immutable',
           'telemetry_metric_events_evidence_immutable'
         ) AND NOT tgisinternal)::text AS immutable_triggers,
        (SELECT count(*) FROM pg_constraint
         WHERE conname IN (
           'repository_backfill_authorizations_bounded_window_check',
           'repository_backfill_authorizations_expiry_check',
           'repository_backfill_authorizations_reason_check'
         ))::text AS bounded_constraints,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'repository_backfill_authorizations'
           AND column_name ~ '(secret|token|api_key|private_key)')::text AS plaintext_columns,
        (SELECT count(*) FROM repository_enrollments
         WHERE generation_session_evidence_from IS NULL
            OR commit_note_evidence_from IS NULL)::text AS missing_watermarks,
        (SELECT count(*) FROM telemetry_metric_events
         WHERE evidence_family <> 'legacy_unclassified'
            OR arrival_class <> 'legacy_unclassified'
            OR enrollment_id IS NOT NULL
            OR backfill_authorization_id IS NOT NULL)::text AS unexpected_existing_labels,
        (SELECT count(*) FROM repository_backfill_authorizations
         WHERE status = 'active')::text AS active_authorization_rows,
        (SELECT count(*) FROM repository_backfill_authorizations
         WHERE status = 'revoked')::text AS revoked_authorization_rows,
        (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS journal_rows
    `);
    const row = result.rows[0];
    const checks = {
      objects: Number(row.watermark_objects) === 7,
      rls: Number(row.rls_tables) === 1,
      triggers: Number(row.immutable_triggers) === 2,
      constraints: Number(row.bounded_constraints) === 3,
      plaintext: Number(row.plaintext_columns) === 0,
      watermarks: Number(row.missing_watermarks) === 0,
      labels: Number(row.unexpected_existing_labels) === 0,
      authorizations: Number(row.active_authorization_rows) === 0,
      journal: Number(row.journal_rows) === 6,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('Wave 3 persistent schema verification failed');
    }
    console.log('watermark_objects=7');
    console.log('backfill_authorization_rls=enabled');
    console.log('immutable_triggers=2');
    console.log('bounded_constraints=3');
    console.log('unexpected_plaintext_columns=0');
    console.log('missing_enrollment_watermarks=0');
    console.log('existing_evidence_labels=legacy-unclassified');
    console.log('active_backfill_authorizations=0');
    console.log(`retained_revoked_backfill_authorizations=${row.revoked_authorization_rows}`);
    console.log(`journal_rows=${row.journal_rows}`);
    console.log('schema_verification=passed');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 3 schema verification failed');
  process.exitCode = 1;
});
