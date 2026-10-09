import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  developerMachines,
  fleetConfigurations,
  fleetMachineStates,
  machineCredentials,
  machineRepositoryGrants,
  securityAuditEvents,
} from '../../core/db/schema';
import {
  applyFleetOffboard,
  assignFleetConfiguration,
  createFleetConfiguration,
  FleetServiceError,
  getFleetConfiguration,
  recordFleetReport,
} from './service';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0014_spotty_serpent_society.sql');

async function expectDatabaseError(run: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return (error as PgFailure).code === code;
  }
}

async function proveMigrationRoundTrip(): Promise<void> {
  const migration = await readFile(migrationPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP TABLE fleet_machine_states');
    await client.query('DROP TABLE fleet_configurations');
    await client.query(migration);
    const applied = await client.query<{ tables: string }>(`
      SELECT count(*)::text AS tables FROM pg_class
      WHERE oid IN ('fleet_configurations'::regclass, 'fleet_machine_states'::regclass)
    `);
    if (Number(applied.rows[0].tables) !== 2) throw new Error('Fleet migration did not apply');
    await client.query('ROLLBACK');

    const afterRollback = await client.query<{ tables: string }>(`
      SELECT count(*)::text AS tables FROM pg_class
      WHERE oid IN ('fleet_configurations'::regclass, 'fleet_machine_states'::regclass)
    `);
    if (Number(afterRollback.rows[0].tables) !== 2) {
      throw new Error('Fleet migration rollback did not restore the prior schema');
    }

    await client.query('BEGIN');
    await client.query('DROP TABLE fleet_machine_states');
    await client.query('DROP TABLE fleet_configurations');
    await client.query(migration);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL
    || process.env.TASK5_EPHEMERAL_DATABASE !== '1'
    || process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('IT-T9-01 requires scripts/it-db.sh and its disposable database flags');
  }
  await proveMigrationRoundTrip();

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const machineA = randomUUID();
  const machineB = randomUUID();
  const repositoryA = randomUUID();
  const repositoryB = randomUUID();
  const enrollmentA = randomUUID();
  const enrollmentB = randomUUID();
  const grantA = randomUUID();
  const grantB = randomUUID();
  const credentialA = randomUUID();
  const marker = `it-t9-01-${randomUUID()}`;

  await pool.query(`
    INSERT INTO sso_tenants (id, company_name, domain, supabase_provider_id)
    VALUES ($1, 'IT T9 Company A', $2, $3), ($4, 'IT T9 Company B', $5, $6)
  `, [tenantA, `${marker}-a.example`, `${marker}-provider-a`, tenantB,
    `${marker}-b.example`, `${marker}-provider-b`]);
  await pool.query(`
    INSERT INTO developer_machines (id, tenant_id, installation_id, display_name, status)
    VALUES ($1, $2, $3, 'IT T9 machine A', 'active'),
           ($4, $5, $6, 'IT T9 machine B', 'active')
  `, [machineA, tenantA, `${marker}-machine-a`, machineB, tenantB, `${marker}-machine-b`]);
  await pool.query(`
    INSERT INTO scm_repositories (id, tenant_id, provider, external_id, name, url)
    VALUES ($1, $2, 'github', $3, 'IT T9 A', 'https://example.invalid/a'),
           ($4, $5, 'github', $6, 'IT T9 B', 'https://example.invalid/b')
  `, [repositoryA, tenantA, `${marker}-repo-a`, repositoryB, tenantB, `${marker}-repo-b`]);
  await pool.query(`
    INSERT INTO repository_enrollments
      (id, tenant_id, repository_id, status, enrolled_by, reason)
    VALUES ($1, $2, $3, 'active', $4, 'IT T9 fixture'),
           ($5, $6, $7, 'active', $4, 'IT T9 fixture')
  `, [enrollmentA, tenantA, repositoryA, marker, enrollmentB, tenantB, repositoryB]);
  await pool.query(`
    INSERT INTO machine_repository_grants
      (id, tenant_id, machine_id, enrollment_id, branch_patterns, status, granted_by, reason)
    VALUES ($1, $2, $3, $4, '["main"]'::jsonb, 'active', $5, 'IT T9 fixture'),
           ($6, $7, $8, $9, '["main"]'::jsonb, 'active', $5, 'IT T9 fixture')
  `, [grantA, tenantA, machineA, enrollmentA, marker, grantB, tenantB, machineB, enrollmentB]);
  await pool.query(`
    INSERT INTO machine_credentials
      (id, tenant_id, machine_id, key_id, secret_hash, status)
    VALUES ($1, $2, $3, $4, $5, 'active')
  `, [credentialA, tenantA, machineA, `${marker}-key`, 'a'.repeat(64)]);
  await pool.query(`
    INSERT INTO tenant_security_monitor_settings
      (tenant_id, mode, version, updated_by)
    VALUES ($1, 'monitor', 3, $2)
  `, [tenantA, marker]);

  const first = await createFleetConfiguration({
    tenantId: tenantA,
    actorId: marker,
    configuration: {
      targetClientVersion: '1.2.3',
      channel: 'enterprise-latest',
      ring: 'early',
      validUntil: null,
      reason: 'IT T9 first configuration',
    },
  });
  const second = await createFleetConfiguration({
    tenantId: tenantA,
    actorId: marker,
    configuration: {
      targetClientVersion: '1.2.4',
      channel: 'enterprise-next',
      ring: 'early',
      validUntil: null,
      reason: 'IT T9 next configuration',
    },
  });
  const companyBConfiguration = await createFleetConfiguration({
    tenantId: tenantB,
    actorId: marker,
    configuration: {
      targetClientVersion: '1.2.3', channel: 'latest', ring: null,
      validUntil: null, reason: 'IT T9 company B configuration',
    },
  });
  if (first.epoch !== 1 || second.epoch !== 2 || companyBConfiguration.epoch !== 1) {
    throw new Error('Tenant-local fleet epochs are not monotonic');
  }

  await assignFleetConfiguration({
    tenantId: tenantA,
    actorId: marker,
    assignment: { configurationId: first.id, machineIds: [machineA], reason: 'IT T9 rollout' },
  });
  await assignFleetConfiguration({
    tenantId: tenantB,
    actorId: marker,
    assignment: {
      configurationId: companyBConfiguration.id,
      machineIds: [machineB],
      reason: 'IT T9 rollout B',
    },
  });
  const envelope = await getFleetConfiguration(tenantA, machineA);
  if (!envelope
    || envelope.configurationId !== first.id
    || envelope.securityActivation.mode !== 'monitor'
    || envelope.repositoryPolicies.length !== 1
    || envelope.verification.state !== 'unavailable') {
    throw new Error('Fleet configuration fetch did not preserve the frozen contract');
  }

  const reportTime = new Date();
  await recordFleetReport({
    tenantId: tenantA,
    machineId: machineA,
    report: {
      schemaVersion: 1,
      reportedAt: reportTime,
      acknowledgement: { configurationId: first.id, epoch: first.epoch, resultCode: 'applied' },
      platform: 'macos',
      osVersion: '15.7',
      architecture: 'x86_64',
      gitaiVersion: '1.2.3',
      serviceState: 'running',
      queue: {
        pendingRetryable: 1, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0,
      },
      mdmDeviceReference: `${marker}-opaque-device`,
      mdmUserReference: null,
      assignmentEvidence: { source: 'jamf', observedAt: reportTime },
    },
  });
  const [reported] = await db.select().from(fleetMachineStates).where(eq(
    fleetMachineStates.machineId,
    machineA,
  ));
  if (reported.acknowledgedConfigurationId !== first.id || reported.pendingRetryable !== 1) {
    throw new Error('Fleet report did not update observed state');
  }

  let companyACannotReadB = false;
  try {
    await getFleetConfiguration(tenantA, machineB);
  } catch (error) {
    companyACannotReadB = error instanceof FleetServiceError && error.status === 404;
  }
  let companyBCannotAcknowledgeA = false;
  try {
    await recordFleetReport({
      tenantId: tenantB,
      machineId: machineB,
      report: {
        schemaVersion: 1,
        reportedAt: new Date(),
        acknowledgement: { configurationId: first.id, epoch: first.epoch, resultCode: 'applied' },
        platform: 'windows', osVersion: '11', architecture: 'x86_64', gitaiVersion: '1.2.3',
        serviceState: 'running',
        queue: { pendingRetryable: 0, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0 },
        mdmDeviceReference: null, mdmUserReference: null,
        assignmentEvidence: { source: 'intune', observedAt: new Date() },
      },
    });
  } catch (error) {
    companyBCannotAcknowledgeA = error instanceof FleetServiceError && error.status === 404;
  }
  const crossTenantDesiredBlocked = await expectDatabaseError(
    () => pool.query(
      'UPDATE fleet_machine_states SET desired_configuration_id = $1 WHERE tenant_id = $2 AND machine_id = $3',
      [first.id, tenantB, machineB],
    ),
    '23503',
  );
  const duplicateEpochBlocked = await expectDatabaseError(
    () => pool.query(`
      INSERT INTO fleet_configurations
        (tenant_id, epoch, schema_version, generated_by, target_client_version, channel, snapshot)
      SELECT tenant_id, epoch, schema_version, generated_by, target_client_version, channel, snapshot
      FROM fleet_configurations WHERE tenant_id = $1 AND id = $2
    `, [tenantA, first.id]),
    '23505',
  );
  const immutableConfiguration = await expectDatabaseError(
    () => pool.query('UPDATE fleet_configurations SET ring = $1 WHERE id = $2', ['changed', first.id]),
    'P0001',
  );
  const [fleetAudit] = await db.select().from(securityAuditEvents).where(eq(
    securityAuditEvents.targetId,
    first.id,
  )).limit(1);
  const immutableAudit = fleetAudit ? await expectDatabaseError(
    () => pool.query('DELETE FROM security_audit_events WHERE id = $1', [fleetAudit.id]),
    'P0001',
  ) : false;

  await assignFleetConfiguration({
    tenantId: tenantA,
    actorId: marker,
    assignment: { configurationId: second.id, machineIds: [machineA], reason: 'IT T9 advance' },
  });
  await recordFleetReport({
    tenantId: tenantA,
    machineId: machineA,
    report: {
      schemaVersion: 1,
      reportedAt: new Date(),
      acknowledgement: { configurationId: second.id, epoch: second.epoch, resultCode: 'applied' },
      platform: 'macos', osVersion: '15.7', architecture: 'x86_64', gitaiVersion: '1.2.4',
      serviceState: 'running',
      queue: { pendingRetryable: 0, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0 },
      mdmDeviceReference: `${marker}-opaque-device`, mdmUserReference: null,
      assignmentEvidence: { source: 'jamf', observedAt: new Date() },
    },
  });
  await assignFleetConfiguration({
    tenantId: tenantA,
    actorId: marker,
    assignment: { configurationId: first.id, machineIds: [machineA], reason: 'IT T9 rollback' },
  });
  await recordFleetReport({
    tenantId: tenantA,
    machineId: machineA,
    report: {
      schemaVersion: 1,
      reportedAt: new Date(),
      acknowledgement: { configurationId: first.id, epoch: first.epoch, resultCode: 'applied' },
      platform: 'macos', osVersion: '15.7', architecture: 'x86_64', gitaiVersion: '1.2.3',
      serviceState: 'running',
      queue: { pendingRetryable: 0, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0 },
      mdmDeviceReference: `${marker}-opaque-device`, mdmUserReference: null,
      assignmentEvidence: { source: 'jamf', observedAt: new Date() },
    },
  });
  const offboard = await applyFleetOffboard({
    tenantId: tenantA, machineId: machineA, actorId: marker, reason: 'IT T9 offboard',
  });
  const [revokedMachine] = await db.select().from(developerMachines).where(eq(
    developerMachines.id,
    machineA,
  ));
  const [revokedCredential] = await db.select().from(machineCredentials).where(eq(
    machineCredentials.id,
    credentialA,
  ));
  const [revokedGrant] = await db.select().from(machineRepositoryGrants).where(eq(
    machineRepositoryGrants.id,
    grantA,
  ));
  const [clearedState] = await db.select().from(fleetMachineStates).where(eq(
    fleetMachineStates.machineId,
    machineA,
  ));

  const shape = await pool.query<{
    rls: string;
    policies: string;
    foreign_keys: string;
    sensitive_columns: string;
    sensitive_values: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM pg_class WHERE oid IN (
        'fleet_configurations'::regclass, 'fleet_machine_states'::regclass
      ) AND relrowsecurity) AS rls,
      (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public'
        AND tablename IN ('fleet_configurations', 'fleet_machine_states')) AS policies,
      (SELECT count(*)::text FROM pg_constraint WHERE conname IN (
        'fleet_machine_states_tenant_machine_fk',
        'fleet_machine_states_tenant_desired_configuration_fk',
        'fleet_machine_states_tenant_acknowledged_configuration_fk'
      )) AS foreign_keys,
      (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('fleet_configurations', 'fleet_machine_states')
          AND column_name ~ '(credential|secret|token|prompt|response|command|file_content|raw_payload)')
        AS sensitive_columns,
      ((SELECT count(*) FROM fleet_configurations
        WHERE snapshot::text ~* '(trk_v1|private key|raw[_ ]?payload|prompt|response|command|file content)')
       + (SELECT count(*) FROM fleet_machine_states
        WHERE coalesce(mdm_device_reference, '') ~* '(trk_v1|private key)'
           OR coalesce(mdm_user_reference, '') ~* '(trk_v1|private key)'))::text AS sensitive_values
  `);
  const proof = shape.rows[0];
  if (!companyACannotReadB
    || !companyBCannotAcknowledgeA
    || !crossTenantDesiredBlocked
    || !duplicateEpochBlocked
    || !immutableConfiguration
    || !immutableAudit
    || Number(proof.rls) !== 2
    || Number(proof.policies) !== 0
    || Number(proof.foreign_keys) !== 3
    || Number(proof.sensitive_columns) !== 0
    || Number(proof.sensitive_values) !== 0
    || offboard.serverRevocation !== 'applied'
    || revokedMachine.status !== 'revoked'
    || revokedCredential.status !== 'revoked'
    || revokedGrant.status !== 'revoked'
    || clearedState.desiredConfigurationId !== null) {
    throw new Error('IT-T9-01 fleet verification failed');
  }

  console.log('it_t9_01=passed');
  console.log('migration=apply-rollback-fresh-reapply');
  console.log('fleet_tables=2');
  console.log('rls_enabled_tables=2');
  console.log('browser_policies=0');
  console.log('tenant_epochs=monotonic-and-isolated');
  console.log('tenant_foreign_keys=cross-tenant-blocked');
  console.log('configuration_fetch_and_report=passed');
  console.log('assignment_rollback=passed');
  console.log('offboard_revocation=passed');
  console.log('immutable_configuration_and_audit=passed');
  console.log('unexpected_sensitive_columns_or_values=0');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'IT-T9-01 failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
