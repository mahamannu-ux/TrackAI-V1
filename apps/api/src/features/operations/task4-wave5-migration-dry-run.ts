import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0007_friendly_chronomancer.sql');

async function operationIsBlocked(
  client: PoolClient,
  savepoint: string,
  sql: string,
  values: unknown[],
  codes: string[],
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
    return codes.includes((error as PgFailure).code ?? '');
  }
}

async function wave5TableCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM unnest(ARRAY[
      'public.tenant_retention_policies',
      'public.evidence_export_jobs',
      'public.evidence_archive_entries',
      'public.retention_runs'
    ]) AS expected(name)
    WHERE to_regclass(expected.name) IS NOT NULL
  `);
  return Number(result.rows[0].count);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave5-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    if (await wave5TableCount(client) !== 0) {
      throw new Error('Wave 5 operations tables already exist; dry-run expects an unapplied migration');
    }
    const tenants = (await client.query<{ id: string }>(`
      SELECT id FROM sso_tenants ORDER BY id LIMIT 2
    `)).rows;
    if (tenants.length !== 2) throw new Error('Two existing tenants are required');

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(await readFile(migrationPath, 'utf8'));

    const rls = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_class
      WHERE oid IN (
        'public.tenant_retention_policies'::regclass,
        'public.evidence_export_jobs'::regclass,
        'public.evidence_archive_entries'::regclass,
        'public.retention_runs'::regclass
      ) AND relrowsecurity
    `);
    const triggers = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_trigger
      WHERE tgname IN (
        'tenant_retention_policies_evidence_immutable',
        'evidence_export_jobs_evidence_immutable',
        'evidence_archive_entries_append_only',
        'retention_runs_evidence_immutable'
      ) AND NOT tgisinternal
    `);
    const hardeningConstraints = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_constraint WHERE conname IN (
        'tenant_retention_policies_version_check',
        'tenant_retention_policies_actor_reason_check',
        'evidence_export_jobs_format_check',
        'evidence_export_jobs_actor_reason_check',
        'evidence_export_jobs_counts_check',
        'evidence_export_jobs_result_check',
        'retention_runs_actor_reason_check',
        'retention_runs_counts_check',
        'retention_runs_result_check'
      )
    `);
    const plaintextColumns = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'tenant_retention_policies', 'evidence_export_jobs',
          'evidence_archive_entries', 'retention_runs'
        )
        AND column_name ~ '(credential|private_key|token|secret|prompt|raw_event|raw_payload)'
    `);

    const policyOneId = randomUUID();
    const policyTwoId = randomUUID();
    const exportId = randomUUID();
    const archiveEntryId = randomUUID();
    const retentionRunId = randomUUID();
    await client.query(`
      INSERT INTO tenant_retention_policies (
        id, tenant_id, version, mode, retention_days, created_by, reason
      ) VALUES ($1, $2, 1, 'archive_then_purge', 30, 'task4-wave5-dry-run', 'dry run')
    `, [policyOneId, tenants[0].id]);

    const duplicateActivePolicyBlocked = await operationIsBlocked(
      client,
      'duplicate_active_policy',
      `INSERT INTO tenant_retention_policies (
        tenant_id, version, mode, created_by, reason
      ) VALUES ($1, 2, 'retain', 'task4-wave5-dry-run', 'duplicate')`,
      [tenants[0].id],
      ['23505'],
    );
    const policyScopeUpdateBlocked = await operationIsBlocked(
      client,
      'policy_scope_update',
      `UPDATE tenant_retention_policies SET retention_days = 31 WHERE id = $1`,
      [policyOneId],
      ['P0001'],
    );
    await client.query(`
      UPDATE tenant_retention_policies
      SET status = 'superseded', superseded_at = now() WHERE id = $1
    `, [policyOneId]);
    await client.query(`
      INSERT INTO tenant_retention_policies (
        id, tenant_id, version, mode, created_by, reason
      ) VALUES ($1, $2, 2, 'retain', 'task4-wave5-dry-run', 'replacement')
    `, [policyTwoId, tenants[0].id]);
    const policyReactivationBlocked = await operationIsBlocked(
      client,
      'policy_reactivation',
      `UPDATE tenant_retention_policies
       SET status = 'active', superseded_at = null WHERE id = $1`,
      [policyOneId],
      ['P0001'],
    );

    await client.query(`
      INSERT INTO evidence_export_jobs (
        id, tenant_id, format, archive_purpose, scope_from, scope_until,
        requested_by, reason
      ) VALUES ($1, $2, 'trackai-evidence-export/v1', true,
        now() - interval '60 days', now() - interval '30 days',
        'task4-wave5-dry-run', 'dry run archive')
    `, [exportId, tenants[0].id]);
    const exportScopeUpdateBlocked = await operationIsBlocked(
      client,
      'export_scope_update',
      `UPDATE evidence_export_jobs SET reason = 'changed' WHERE id = $1`,
      [exportId],
      ['P0001'],
    );
    await client.query(`
      UPDATE evidence_export_jobs SET status = 'running', started_at = now() WHERE id = $1
    `, [exportId]);
    await client.query(`
      INSERT INTO evidence_archive_entries (
        id, tenant_id, export_job_id, evidence_family, evidence_id,
        occurred_at, content_sha256
      ) VALUES ($1, $2, $3, 'telemetry_metric_evidence', $4,
        now() - interval '45 days', $5)
    `, [archiveEntryId, tenants[0].id, exportId, randomUUID(), 'a'.repeat(64)]);
    const crossTenantArchiveBlocked = await operationIsBlocked(
      client,
      'cross_tenant_archive',
      `INSERT INTO evidence_archive_entries (
        tenant_id, export_job_id, evidence_family, evidence_id,
        occurred_at, content_sha256
      ) VALUES ($1, $2, 'telemetry_metric_evidence', $3, now(), $4)`,
      [tenants[1].id, exportId, randomUUID(), 'b'.repeat(64)],
      ['23503'],
    );
    const archiveMutationBlocked = await operationIsBlocked(
      client,
      'archive_mutation',
      `UPDATE evidence_archive_entries SET occurred_at = now() WHERE id = $1`,
      [archiveEntryId],
      ['P0001'],
    );
    await client.query(`
      UPDATE evidence_export_jobs
      SET status = 'completed', record_counts = '{"telemetry_metric_evidence":1}'::jsonb,
        content_sha256 = $2, storage_reference = 'task4://dry-run/archive', completed_at = now()
      WHERE id = $1
    `, [exportId, 'c'.repeat(64)]);
    const terminalExportMutationBlocked = await operationIsBlocked(
      client,
      'terminal_export_mutation',
      `UPDATE evidence_export_jobs SET record_counts = '{}'::jsonb WHERE id = $1`,
      [exportId],
      ['P0001'],
    );

    const applyWithoutArchiveBlocked = await operationIsBlocked(
      client,
      'apply_without_archive',
      `INSERT INTO retention_runs (
        tenant_id, policy_id, mode, cutoff_at, requested_by, reason
      ) VALUES ($1, $2, 'apply', now() - interval '30 days',
        'task4-wave5-dry-run', 'missing archive')`,
      [tenants[0].id, policyOneId],
      ['23514'],
    );
    const crossTenantRunBlocked = await operationIsBlocked(
      client,
      'cross_tenant_run',
      `INSERT INTO retention_runs (
        tenant_id, policy_id, archive_export_job_id, mode, cutoff_at,
        requested_by, reason
      ) VALUES ($1, $2, $3, 'apply', now() - interval '30 days',
        'task4-wave5-dry-run', 'cross tenant')`,
      [tenants[1].id, policyOneId, exportId],
      ['23503'],
    );
    await client.query(`
      INSERT INTO retention_runs (
        id, tenant_id, policy_id, archive_export_job_id, mode, cutoff_at,
        requested_by, reason
      ) VALUES ($1, $2, $3, $4, 'apply', now() - interval '30 days',
        'task4-wave5-dry-run', 'dry run lifecycle')
    `, [retentionRunId, tenants[0].id, policyOneId, exportId]);
    await client.query(`
      UPDATE retention_runs
      SET status = 'completed', candidate_counts = '{"telemetry_metric_evidence":1}'::jsonb,
        purged_counts = '{"telemetry_metric_evidence":1}'::jsonb, completed_at = now()
      WHERE id = $1
    `, [retentionRunId]);
    const terminalRunMutationBlocked = await operationIsBlocked(
      client,
      'terminal_run_mutation',
      `UPDATE retention_runs SET purged_counts = '{}'::jsonb WHERE id = $1`,
      [retentionRunId],
      ['P0001'],
    );

    if (await wave5TableCount(client) !== 4
      || Number(rls.rows[0].count) !== 4
      || Number(triggers.rows[0].count) !== 4
      || Number(hardeningConstraints.rows[0].count) !== 9
      || Number(plaintextColumns.rows[0].count) !== 0
      || !duplicateActivePolicyBlocked
      || !policyScopeUpdateBlocked
      || !policyReactivationBlocked
      || !exportScopeUpdateBlocked
      || !crossTenantArchiveBlocked
      || !archiveMutationBlocked
      || !terminalExportMutationBlocked
      || !applyWithoutArchiveBlocked
      || !crossTenantRunBlocked
      || !terminalRunMutationBlocked) {
      throw new Error('One or more Wave 5 migration dry-run checks failed');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await wave5TableCount(client);
    if (after !== 0) throw new Error('Wave 5 migration dry-run did not roll back cleanly');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log('inside_transaction_tables=4');
    console.log('rls_enabled_tables=4');
    console.log('immutable_triggers=4');
    console.log('hardening_constraints=9');
    console.log('unexpected_plaintext_columns=0');
    console.log('duplicate_active_policy=blocked');
    console.log('policy_scope_update=blocked');
    console.log('policy_reactivation=blocked');
    console.log('export_scope_update=blocked');
    console.log('cross_tenant_archive=blocked');
    console.log('archive_mutation=blocked');
    console.log('terminal_export_mutation=blocked');
    console.log('apply_without_archive=blocked');
    console.log('cross_tenant_retention_run=blocked');
    console.log('terminal_retention_run_mutation=blocked');
    console.log('migration_dry_run=rolled-back');
    console.log(`after_rollback_tables=${after}`);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 migration dry-run failed');
  process.exitCode = 1;
});
