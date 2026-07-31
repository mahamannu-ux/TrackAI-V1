import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const COMPANY_A_DOMAIN = 'purpletealabs.net';
const COMPANY_B_DOMAIN = 'customer-b-oidc.com';

type PgFailure = Error & { code?: string; constraint?: string };

const lifecycleCountsSql = `
  SELECT
    (SELECT count(*)::text FROM telemetry_metric_events) AS telemetry_metric_events,
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM scm_pull_requests) AS scm_pull_requests,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_session_usage) AS ai_session_usage,
    (SELECT count(*)::text FROM ai_commit_sessions) AS ai_commit_sessions,
    (SELECT count(*)::text FROM ai_commit_model_attributions) AS ai_commit_model_attributions,
    (SELECT count(*)::text FROM scm_commit_lineage) AS scm_commit_lineage,
    (SELECT count(*)::text FROM scm_pull_request_snapshots) AS scm_pull_request_snapshots,
    (SELECT count(*)::text FROM scm_pull_request_commit_memberships) AS scm_pull_request_commit_memberships,
    (SELECT count(*)::text FROM scm_merge_lineage) AS scm_merge_lineage,
    (SELECT count(*)::text FROM scm_deployments) AS scm_deployments,
    (SELECT count(*)::text FROM ai_generation_observations) AS ai_generation_observations,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events,
    (SELECT count(*)::text FROM telemetry_corrections) AS telemetry_corrections
`;

async function expectForeignKeyRejection(
  client: PoolClient,
  savepoint: string,
  constraint: string,
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
    const failure = error as PgFailure;
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return failure.code === '23503' && failure.constraint === constraint;
  }
}

async function expectAuditMutationRejection(
  client: PoolClient,
  savepoint: string,
  sql: string,
  auditId: string,
): Promise<boolean> {
  await client.query(`SAVEPOINT ${savepoint}`);

  try {
    await client.query(sql, [auditId]);
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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const marker = `task4-wave1-${randomUUID()}`;
  const installationA = `${marker}-machine-a`;
  const installationB = `${marker}-machine-b`;
  const keyA = `${marker}-key-a`;
  const keyB = `${marker}-key-b`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave1-live-verify',
  });
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    const beforeLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const fixtures = await client.query<{
      domain: string;
      tenant_id: string;
      repository_id: string | null;
    }>(`
      SELECT
        lower(t.domain) AS domain,
        t.id AS tenant_id,
        (
          SELECT r.id
          FROM scm_repositories r
          WHERE r.tenant_id = t.id
          ORDER BY r.created_at, r.id
          LIMIT 1
        ) AS repository_id
      FROM sso_tenants t
      WHERE lower(t.domain) = ANY($1::text[])
    `, [[COMPANY_A_DOMAIN, COMPANY_B_DOMAIN]]);

    const companyA = fixtures.rows.find(row => row.domain === COMPANY_A_DOMAIN);
    const companyB = fixtures.rows.find(row => row.domain === COMPANY_B_DOMAIN);
    if (!companyA?.repository_id || !companyB?.repository_id) {
      throw new Error('Canonical Company A/B tenant and repository fixtures are required');
    }

    const machineA = await client.query<{ id: string }>(`
      INSERT INTO developer_machines
        (tenant_id, installation_id, display_name, platform)
      VALUES ($1, $2, 'Task4 logical machine A', 'single-mac-test')
      RETURNING id
    `, [companyA.tenant_id, installationA]);
    const machineB = await client.query<{ id: string }>(`
      INSERT INTO developer_machines
        (tenant_id, installation_id, display_name, platform)
      VALUES ($1, $2, 'Task4 logical machine B', 'single-mac-test')
      RETURNING id
    `, [companyB.tenant_id, installationB]);

    const machineAId = machineA.rows[0].id;
    const machineBId = machineB.rows[0].id;
    await client.query(`
      INSERT INTO machine_credentials
        (tenant_id, machine_id, key_id, secret_hash)
      VALUES
        ($1, $2, $3, $4),
        ($5, $6, $7, $8)
    `, [
      companyA.tenant_id, machineAId, keyA, 'a'.repeat(64),
      companyB.tenant_id, machineBId, keyB, 'b'.repeat(64),
    ]);

    const enrollmentA = await client.query<{ id: string }>(`
      INSERT INTO repository_enrollments
        (tenant_id, repository_id, enrolled_by, reason)
      VALUES ($1, $2, $3, 'rollback-only Wave 1 verification')
      RETURNING id
    `, [companyA.tenant_id, companyA.repository_id, marker]);
    const enrollmentB = await client.query<{ id: string }>(`
      INSERT INTO repository_enrollments
        (tenant_id, repository_id, enrolled_by, reason)
      VALUES ($1, $2, $3, 'rollback-only Wave 1 verification')
      RETURNING id
    `, [companyB.tenant_id, companyB.repository_id, marker]);
    const enrollmentAId = enrollmentA.rows[0].id;
    const enrollmentBId = enrollmentB.rows[0].id;

    await client.query(`
      INSERT INTO machine_repository_grants
        (tenant_id, machine_id, enrollment_id, branch_patterns, granted_by, reason)
      VALUES
        ($1, $2, $3, $4::jsonb, $5, 'rollback-only Wave 1 verification'),
        ($6, $7, $8, $9::jsonb, $10, 'rollback-only Wave 1 verification')
    `, [
      companyA.tenant_id, machineAId, enrollmentAId,
      JSON.stringify(['main', 'feature/*']), marker,
      companyB.tenant_id, machineBId, enrollmentBId,
      JSON.stringify([]), marker,
    ]);

    const crossCredentialBlocked = await expectForeignKeyRejection(
      client,
      'cross_credential',
      'machine_credentials_tenant_machine_fk',
      `INSERT INTO machine_credentials
        (tenant_id, machine_id, key_id, secret_hash)
       VALUES ($1, $2, $3, $4)`,
      [companyA.tenant_id, machineBId, `${marker}-cross-key`, 'c'.repeat(64)],
    );
    const crossEnrollmentBlocked = await expectForeignKeyRejection(
      client,
      'cross_enrollment',
      'repository_enrollments_tenant_repository_fk',
      `INSERT INTO repository_enrollments
        (tenant_id, repository_id, enrolled_by)
       VALUES ($1, $2, $3)`,
      [companyA.tenant_id, companyB.repository_id, marker],
    );
    const crossMachineGrantBlocked = await expectForeignKeyRejection(
      client,
      'cross_machine_grant',
      'machine_repository_grants_tenant_machine_fk',
      `INSERT INTO machine_repository_grants
        (tenant_id, machine_id, enrollment_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [companyA.tenant_id, machineBId, enrollmentAId, marker],
    );
    const crossEnrollmentGrantBlocked = await expectForeignKeyRejection(
      client,
      'cross_enrollment_grant',
      'machine_repository_grants_tenant_enrollment_fk',
      `INSERT INTO machine_repository_grants
        (tenant_id, machine_id, enrollment_id, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [companyA.tenant_id, machineAId, enrollmentBId, marker],
    );

    const audit = await client.query<{ id: string }>(`
      INSERT INTO security_audit_events
        (tenant_id, actor_type, actor_id, action, target_type, target_id, details)
      VALUES
        ($1, 'verification', $2, 'created', 'wave1_probe', $2, $3::jsonb)
      RETURNING id
    `, [companyA.tenant_id, marker, JSON.stringify({ rollbackOnly: true })]);
    const auditId = audit.rows[0].id;
    const auditUpdateBlocked = await expectAuditMutationRejection(
      client,
      'audit_update',
      `UPDATE security_audit_events SET action = 'modified' WHERE id = $1`,
      auditId,
    );
    const auditDeleteBlocked = await expectAuditMutationRejection(
      client,
      'audit_delete',
      `DELETE FROM security_audit_events WHERE id = $1`,
      auditId,
    );

    const checks = {
      crossCredentialBlocked,
      crossEnrollmentBlocked,
      crossMachineGrantBlocked,
      crossEnrollmentGrantBlocked,
      auditUpdateBlocked,
      auditDeleteBlocked,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('One or more Wave 1 isolation checks unexpectedly succeeded');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;

    const residual = await client.query<{ count: string }>(`
      SELECT
        (SELECT count(*) FROM developer_machines WHERE installation_id = ANY($1::text[])) +
        (SELECT count(*) FROM machine_credentials WHERE key_id = ANY($2::text[])) +
        (SELECT count(*) FROM repository_enrollments WHERE enrolled_by = $3) +
        (SELECT count(*) FROM machine_repository_grants WHERE granted_by = $3) +
        (SELECT count(*) FROM security_audit_events WHERE target_id = $3) AS count
    `, [[installationA, installationB], [keyA, keyB], marker]);
    const afterLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    const lifecycleUnchanged = JSON.stringify(beforeLifecycle) === JSON.stringify(afterLifecycle);

    console.log('logical_machines=2');
    console.log('same_tenant_credentials_and_grants=accepted');
    console.log('cross_tenant_machine_credential=blocked');
    console.log('cross_tenant_repository_enrollment=blocked');
    console.log('cross_tenant_machine_grant=blocked');
    console.log('cross_tenant_enrollment_grant=blocked');
    console.log('audit_update=blocked');
    console.log('audit_delete=blocked');
    console.log('transaction=rolled-back');
    console.log(`residual_probe_rows=${residual.rows[0].count}`);
    console.log(`task2_lifecycle_counts=${lifecycleUnchanged ? 'unchanged' : 'changed'}`);

    if (residual.rows[0].count !== '0' || !lifecycleUnchanged) {
      process.exitCode = 1;
    }
  } finally {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  const failure = error as PgFailure;
  console.log('wave1_live_verification=failed');
  console.log(`error_code=${failure.code ?? 'unknown'}`);
  process.exitCode = 1;
});
