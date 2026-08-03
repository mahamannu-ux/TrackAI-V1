import 'dotenv/config';

import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave5-schema-verify',
  });
  try {
    const result = await pool.query<{
      tables: string;
      rls_tables: string;
      immutable_triggers: string;
      hardening_constraints: string;
      plaintext_columns: string;
      invalid_lifecycle_rows: string;
      policies: string;
      export_jobs: string;
      archive_entries: string;
      retention_runs: string;
      health_reports: string;
      journal_rows: string;
    }>(`
      SELECT
        (SELECT count(*) FROM unnest(ARRAY[
          'public.tenant_retention_policies',
          'public.evidence_export_jobs',
          'public.evidence_archive_entries',
          'public.retention_runs',
          'public.machine_delivery_health_reports'
        ]) AS expected(name) WHERE to_regclass(expected.name) IS NOT NULL)::text AS tables,
        (SELECT count(*) FROM pg_class WHERE oid IN (
          'public.tenant_retention_policies'::regclass,
          'public.evidence_export_jobs'::regclass,
          'public.evidence_archive_entries'::regclass,
          'public.retention_runs'::regclass,
          'public.machine_delivery_health_reports'::regclass
        ) AND relrowsecurity)::text AS rls_tables,
        (SELECT count(*) FROM pg_trigger WHERE tgname IN (
          'tenant_retention_policies_evidence_immutable',
          'evidence_export_jobs_evidence_immutable',
          'evidence_archive_entries_append_only',
          'retention_runs_evidence_immutable'
        ) AND NOT tgisinternal)::text AS immutable_triggers,
        (SELECT count(*) FROM pg_constraint WHERE conname IN (
          'tenant_retention_policies_version_check',
          'tenant_retention_policies_actor_reason_check',
          'evidence_export_jobs_format_check',
          'evidence_export_jobs_actor_reason_check',
          'evidence_export_jobs_counts_check',
          'evidence_export_jobs_result_check',
          'retention_runs_actor_reason_check',
          'retention_runs_counts_check',
          'retention_runs_result_check',
          'machine_delivery_health_reports_schema_version_check',
          'machine_delivery_health_reports_count_check',
          'machine_delivery_health_reports_timestamp_check'
        ))::text AS hardening_constraints,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN (
             'tenant_retention_policies', 'evidence_export_jobs',
             'evidence_archive_entries', 'retention_runs',
             'machine_delivery_health_reports'
           )
           AND column_name ~ '(credential|private_key|token|secret|prompt|raw_event|raw_payload)')::text
          AS plaintext_columns,
        (
          (SELECT count(*) FROM tenant_retention_policies
           WHERE (status = 'active' AND superseded_at IS NOT NULL)
              OR (status = 'superseded' AND superseded_at IS NULL))
          + (SELECT count(*) FROM evidence_export_jobs
             WHERE (status = 'completed'
                    AND (content_sha256 IS NULL OR storage_reference IS NULL
                         OR completed_at IS NULL OR failure_code IS NOT NULL))
                OR (status = 'failed' AND (completed_at IS NULL OR failure_code IS NULL)))
          + (SELECT count(*) FROM evidence_archive_entries AS entry
             LEFT JOIN evidence_export_jobs AS job
               ON job.tenant_id = entry.tenant_id AND job.id = entry.export_job_id
             WHERE job.id IS NULL)
          + (SELECT count(*) FROM retention_runs
             WHERE (mode = 'apply' AND archive_export_job_id IS NULL)
                OR (status <> 'planned' AND completed_at IS NULL))
          + (SELECT count(*) FROM machine_delivery_health_reports AS report
             LEFT JOIN developer_machines AS machine
               ON machine.tenant_id = report.tenant_id AND machine.id = report.machine_id
             WHERE machine.id IS NULL)
        )::text AS invalid_lifecycle_rows,
        (SELECT count(*) FROM tenant_retention_policies)::text AS policies,
        (SELECT count(*) FROM evidence_export_jobs)::text AS export_jobs,
        (SELECT count(*) FROM evidence_archive_entries)::text AS archive_entries,
        (SELECT count(*) FROM retention_runs)::text AS retention_runs,
        (SELECT count(*) FROM machine_delivery_health_reports)::text AS health_reports,
        (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS journal_rows
    `);
    const row = result.rows[0];
    if (Number(row.tables) !== 5
      || Number(row.rls_tables) !== 5
      || Number(row.immutable_triggers) !== 4
      || Number(row.hardening_constraints) !== 12
      || Number(row.plaintext_columns) !== 0
      || Number(row.invalid_lifecycle_rows) !== 0
      || Number(row.journal_rows) < 9) {
      throw new Error('Wave 5 persistent schema verification failed');
    }
    console.log('task4_operations_tables=5');
    console.log('rls_enabled_tables=5');
    console.log('immutable_triggers=4');
    console.log('hardening_constraints=12');
    console.log('unexpected_plaintext_columns=0');
    console.log('invalid_lifecycle_rows=0');
    console.log(`retention_policies=${row.policies}`);
    console.log(`evidence_export_jobs=${row.export_jobs}`);
    console.log(`evidence_archive_entries=${row.archive_entries}`);
    console.log(`retention_runs=${row.retention_runs}`);
    console.log(`machine_delivery_health_reports=${row.health_reports}`);
    console.log(`journal_rows=${row.journal_rows}`);
    console.log('schema_verification=passed');
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 schema verification failed');
  process.exitCode = 1;
});
