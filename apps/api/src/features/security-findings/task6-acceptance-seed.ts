import 'dotenv/config';

import { Pool } from 'pg';

const acceptanceDomain = 'task5.acceptance.invalid';
const auditorSubject = 'task6-acceptance-auditor';
const auditorEmail = 'auditor@task5.acceptance.invalid';

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('Task6 acceptance seed may run only outside production with an ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task6-acceptance-seed',
  });
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const tenantResult = await client.query<{ id: string }>(`
      SELECT id FROM sso_tenants WHERE domain = $1
    `, [acceptanceDomain]);
    if (!tenantResult.rows[0]) {
      throw new Error('Task5 persistent acceptance tenant is missing; create it before Task6 seeding');
    }
    const tenantId = tenantResult.rows[0].id;

    const repositoryResult = await client.query<{ id: string }>(`
      SELECT id FROM scm_repositories
      WHERE tenant_id = $1
      ORDER BY created_at ASC
      LIMIT 1
    `, [tenantId]);
    if (!repositoryResult.rows[0]) {
      throw new Error('Task5 persistent acceptance repository is missing; create it before Task6 seeding');
    }
    const repositoryId = repositoryResult.rows[0].id;

    await client.query(`
      INSERT INTO tenant_admin_memberships
        (tenant_id, subject, email, role, status, granted_by)
      VALUES ($1, $2, $3, 'tenant_auditor', 'active', 'task6-acceptance-seed')
      ON CONFLICT (tenant_id, subject) DO UPDATE SET
        email = EXCLUDED.email,
        status = 'active',
        revoked_at = NULL
    `, [tenantId, auditorSubject, auditorEmail]);

    const machineResult = await client.query<{ id: string }>(`
      INSERT INTO developer_machines
        (tenant_id, installation_id, display_name, platform, status)
      VALUES ($1, 'task6-acceptance-machine', 'Task6 acceptance Mac', 'macos', 'active')
      ON CONFLICT (tenant_id, installation_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        platform = EXCLUDED.platform,
        status = 'active',
        revoked_at = NULL,
        updated_at = now()
      RETURNING id
    `, [tenantId]);
    const machineId = machineResult.rows[0].id;

    await client.query(`
      INSERT INTO tenant_security_monitor_settings
        (tenant_id, mode, version, valid_until, revoked_at, updated_by)
      VALUES ($1, 'monitor', 1, now() + interval '4 hours', NULL, 'task6-acceptance-seed')
      ON CONFLICT (tenant_id) DO UPDATE SET
        mode = 'monitor',
        version = tenant_security_monitor_settings.version + 1,
        valid_until = now() + interval '4 hours',
        revoked_at = NULL,
        updated_by = 'task6-acceptance-seed',
        updated_at = now()
    `, [tenantId]);

    await client.query(`
      INSERT INTO security_findings (
        tenant_id, machine_id, repository_id, finding_id, delivery_id,
        session_id, source_event_id, correlation_id, rule_id, rule_version,
        rule_category, rule_severity, route_id, agent_family, host_surface,
        host_mode, capture_channel, operating_system, timing, native_effect,
        activation, effect, phase, availability, completeness, result_category,
        occurred_at, client_version, rule_pack_version
      ) VALUES (
        $1, $2, $3, 'task6-acceptance-finding', 'task6-acceptance-delivery',
        'task6-acceptance-session', 'task6-acceptance-event', NULL,
        'trackai.exec.download_pipe_shell', '1.4', 'execution', 'high',
        'AC-CLI-03', 'opencode', 'terminal', 'cli', 'provider-plugin',
        'macos', 'pre_action', 'observe_only', 'observed', 'monitor',
        'requested', 'available', 'complete', 'not_observed', now(),
        'task6-acceptance', 'task6-acceptance'
      )
      ON CONFLICT (tenant_id, delivery_id) DO NOTHING
    `, [tenantId, machineId, repositoryId]);

    await client.query('COMMIT');
    transactionOpen = false;
    console.log('task6_acceptance_seed=ready');
    console.log(`acceptance_tenant_id=${tenantId}`);
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Task6 acceptance seed failed');
  process.exitCode = 1;
});
