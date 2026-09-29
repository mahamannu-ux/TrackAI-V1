import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0013_task6_security_storage.sql');

async function operationIsBlocked(
  client: PoolClient,
  savepoint: string,
  statement: string,
  values: unknown[],
  expectedCodes: string[],
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
    return expectedCodes.includes((error as PgFailure).code ?? '');
  }
}

async function task6TableCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM unnest(ARRAY[
      'public.tenant_security_monitor_settings',
      'public.security_findings'
    ]) AS expected(name)
    WHERE to_regclass(expected.name) IS NOT NULL
  `);
  return Number(result.rows[0].count);
}

function findingValues(input: {
  tenantId: string;
  machineId: string;
  repositoryId: string;
  findingId: string;
  deliveryId: string;
}): unknown[] {
  return [
    input.tenantId,
    input.machineId,
    input.repositoryId,
    input.findingId,
    input.deliveryId,
    `session-${input.findingId}`,
    `event-${input.findingId}`,
  ];
}

const insertFindingSql = `
  INSERT INTO security_findings (
    tenant_id, machine_id, repository_id, finding_id, delivery_id,
    session_id, source_event_id, rule_id, rule_version, rule_category,
    rule_severity, route_id, agent_family, host_surface, host_mode,
    capture_channel, operating_system, timing, native_effect, activation,
    effect, phase, availability, completeness, result_category,
    occurred_at, client_version, rule_pack_version
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    'trackai.exec.download_pipe_shell', '1.4', 'execution', 'high',
    'AC-CLI-03', 'opencode', 'terminal', 'cli', 'provider-plugin',
    'linux', 'pre_action', 'observe_only', 'observed', 'monitor',
    'requested', 'available', 'complete', 'not_observed',
    now(), 'task6-dry-run', 'task6-dry-run'
  )
`;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task6-storage-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    if (await task6TableCount(client) !== 0) {
      throw new Error('Task6 storage tables already exist; dry-run expects an unapplied migration');
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

    const tenantA = tenants[0].id;
    const tenantB = tenants[1].id;
    const machineA = randomUUID();
    const machineB = randomUUID();
    const repositoryA = randomUUID();
    const repositoryB = randomUUID();
    await client.query(`
      INSERT INTO developer_machines (
        id, tenant_id, installation_id, display_name, status
      ) VALUES
        ($1, $2, $3, 'Task6 dry-run A', 'active'),
        ($4, $5, $6, 'Task6 dry-run B', 'active')
    `, [
      machineA, tenantA, `task6-a-${machineA}`,
      machineB, tenantB, `task6-b-${machineB}`,
    ]);
    await client.query(`
      INSERT INTO scm_repositories (
        id, tenant_id, provider, external_id, name, url, normalized_url
      ) VALUES
        ($1, $2, 'github', $3, 'Task6 dry-run A', $4, $4),
        ($5, $6, 'github', $7, 'Task6 dry-run B', $8, $8)
    `, [
      repositoryA, tenantA, `task6-a-${repositoryA}`, `https://example.invalid/${repositoryA}`,
      repositoryB, tenantB, `task6-b-${repositoryB}`, `https://example.invalid/${repositoryB}`,
    ]);

    await client.query(`
      INSERT INTO tenant_security_monitor_settings (
        tenant_id, mode, version, updated_by
      ) VALUES ($1, 'monitor', 1, 'task6-storage-dry-run')
    `, [tenantA]);
    const invalidMonitorModeBlocked = await operationIsBlocked(
      client,
      'invalid_monitor_mode',
      `INSERT INTO tenant_security_monitor_settings (
        tenant_id, mode, version, updated_by
      ) VALUES ($1, 'block', 1, 'task6-storage-dry-run')`,
      [tenantB],
      ['23514'],
    );

    const baseFinding = {
      tenantId: tenantA,
      machineId: machineA,
      repositoryId: repositoryA,
      findingId: 'finding-base',
      deliveryId: 'delivery-base',
    };
    await client.query(insertFindingSql, findingValues(baseFinding));
    const duplicateDeliveryBlocked = await operationIsBlocked(
      client,
      'duplicate_delivery',
      insertFindingSql,
      findingValues(baseFinding),
      ['23505'],
    );
    const changedDuplicateDeliveryBlocked = await operationIsBlocked(
      client,
      'changed_duplicate_delivery',
      insertFindingSql,
      findingValues({ ...baseFinding, findingId: 'finding-changed' }),
      ['23505'],
    );
    const crossTenantMachineBlocked = await operationIsBlocked(
      client,
      'cross_tenant_machine',
      insertFindingSql,
      findingValues({
        tenantId: tenantB,
        machineId: machineA,
        repositoryId: repositoryB,
        findingId: 'finding-cross-machine',
        deliveryId: 'delivery-cross-machine',
      }),
      ['23503'],
    );
    const crossTenantRepositoryBlocked = await operationIsBlocked(
      client,
      'cross_tenant_repository',
      insertFindingSql,
      findingValues({
        tenantId: tenantB,
        machineId: machineB,
        repositoryId: repositoryA,
        findingId: 'finding-cross-repository',
        deliveryId: 'delivery-cross-repository',
      }),
      ['23503'],
    );
    const findingUpdateBlocked = await operationIsBlocked(
      client,
      'finding_update',
      `UPDATE security_findings SET result_category = 'success'
       WHERE tenant_id = $1 AND finding_id = $2`,
      [tenantA, baseFinding.findingId],
      ['P0001'],
    );
    const findingDeleteBlocked = await operationIsBlocked(
      client,
      'finding_delete',
      `DELETE FROM security_findings WHERE tenant_id = $1 AND finding_id = $2`,
      [tenantA, baseFinding.findingId],
      ['P0001'],
    );

    const checks = await client.query<{
      rls: string;
      policies: string;
      foreignKeys: string;
      hardeningChecks: string;
      immutableTriggers: string;
      forbiddenColumns: string;
      findingRows: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pg_class WHERE oid IN (
          'public.tenant_security_monitor_settings'::regclass,
          'public.security_findings'::regclass
        ) AND relrowsecurity) AS rls,
        (SELECT count(*)::text FROM pg_policy WHERE polrelid IN (
          'public.tenant_security_monitor_settings'::regclass,
          'public.security_findings'::regclass
        )) AS policies,
        (SELECT count(*)::text FROM pg_constraint WHERE conname IN (
          'tenant_security_monitor_settings_tenant_id_sso_tenants_id_fk',
          'security_findings_tenant_id_sso_tenants_id_fk',
          'security_findings_tenant_machine_fk',
          'security_findings_tenant_repository_fk'
        )) AS "foreignKeys",
        (SELECT count(*)::text FROM pg_constraint WHERE conname IN (
          'tenant_security_monitor_settings_mode_check',
          'tenant_security_monitor_settings_version_check',
          'tenant_security_monitor_settings_interval_check',
          'security_findings_rule_id_check',
          'security_findings_rule_category_check',
          'security_findings_rule_severity_check',
          'security_findings_route_check',
          'security_findings_operating_system_check',
          'security_findings_timing_check',
          'security_findings_activation_check',
          'security_findings_effect_check',
          'security_findings_phase_check',
          'security_findings_availability_check',
          'security_findings_completeness_check',
          'security_findings_result_category_check',
          'security_findings_bounded_metadata_check'
        )) AS "hardeningChecks",
        (SELECT count(*)::text FROM pg_trigger
         WHERE tgname = 'security_findings_immutable' AND NOT tgisinternal) AS "immutableTriggers",
        (SELECT count(*)::text FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('tenant_security_monitor_settings', 'security_findings')
           AND column_name ~ '(command|prompt|response|reasoning|path|url|argument|output|payload|content|secret|credential)') AS "forbiddenColumns",
        (SELECT count(*)::text FROM security_findings) AS "findingRows"
    `);
    const check = checks.rows[0];
    if (await task6TableCount(client) !== 2
      || Number(check.rls) !== 2
      || Number(check.policies) !== 0
      || Number(check.foreignKeys) !== 4
      || Number(check.hardeningChecks) !== 16
      || Number(check.immutableTriggers) !== 1
      || Number(check.forbiddenColumns) !== 0
      || Number(check.findingRows) !== 1
      || !invalidMonitorModeBlocked
      || !duplicateDeliveryBlocked
      || !changedDuplicateDeliveryBlocked
      || !crossTenantMachineBlocked
      || !crossTenantRepositoryBlocked
      || !findingUpdateBlocked
      || !findingDeleteBlocked) {
      throw new Error('One or more Task6 storage migration dry-run checks failed');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await task6TableCount(client);
    if (after !== 0) throw new Error('Task6 storage migration dry-run did not roll back cleanly');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log('inside_transaction_tables=2');
    console.log('rls_enabled_tables=2');
    console.log('direct_browser_policies=0');
    console.log('tenant_bound_foreign_keys=4');
    console.log('hardening_constraints=16');
    console.log('immutable_triggers=1');
    console.log('unexpected_sensitive_columns=0');
    console.log('invalid_monitor_mode=blocked');
    console.log('cross_tenant_machine=blocked');
    console.log('cross_tenant_repository=blocked');
    console.log('duplicate_delivery=blocked');
    console.log('changed_duplicate_delivery=blocked');
    console.log('finding_update=blocked');
    console.log('finding_delete=blocked');
    console.log('migration_dry_run=rolled-back');
    console.log(`after_rollback_tables=${after}`);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task6 storage migration dry-run failed');
  process.exitCode = 1;
});
