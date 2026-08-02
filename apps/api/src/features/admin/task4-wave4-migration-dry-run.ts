import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type PgFailure = Error & { code?: string };
const migrationPath = resolve(__dirname, '../../../drizzle/0006_fat_krista_starr.sql');

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

async function wave4TableCount(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM unnest(ARRAY[
      'public.tenant_admin_memberships',
      'public.github_app_installations',
      'public.github_app_credential_versions'
    ]) AS expected(name)
    WHERE to_regclass(expected.name) IS NOT NULL
  `);
  return Number(result.rows[0].count);
}

function syntheticEnvelope(masterKeyVersion: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    algorithm: 'aes-256-gcm',
    masterKeyVersion,
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'synthetic-ciphertext',
    authTag: 'AAAAAAAAAAAAAAAAAAAAAA==',
    wrappedDataKey: {
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'synthetic-wrapped-key',
      authTag: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave4-migration-dry-run',
  });
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    if (await wave4TableCount(client) !== 0) {
      throw new Error('Wave 4 administration tables already exist; dry-run expects an unapplied migration');
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
        'public.tenant_admin_memberships'::regclass,
        'public.github_app_installations'::regclass,
        'public.github_app_credential_versions'::regclass
      ) AND relrowsecurity
    `);
    const triggers = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_trigger
      WHERE tgname IN (
        'tenant_admin_memberships_scope_immutable',
        'github_app_installations_identity_immutable',
        'github_app_credential_versions_evidence_immutable'
      ) AND NOT tgisinternal
    `);
    const hardeningConstraints = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_constraint WHERE conname IN (
        'github_app_installations_app_id_check',
        'github_app_installations_external_id_check',
        'github_app_installations_provider_host_check',
        'github_app_installations_account_login_check',
        'github_app_installations_permissions_check',
        'github_app_installations_events_check',
        'github_app_credential_versions_envelope_check'
      )
    `);
    const plaintextColumns = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('github_app_installations', 'github_app_credential_versions')
        AND column_name ~ '(plaintext|access_token|private_key|webhook_secret)'
    `);

    const membershipId = randomUUID();
    const installationId = randomUUID();
    const credentialId = randomUUID();
    await client.query(`
      INSERT INTO tenant_admin_memberships (
        id, tenant_id, subject, email, role, granted_by
      ) VALUES ($1, $2, 'task4-wave4-admin-a', 'admin-a@example.invalid',
        'tenant_admin', 'task4-wave4-dry-run')
    `, [membershipId, tenants[0].id]);
    await client.query(`
      INSERT INTO github_app_installations (
        id, tenant_id, app_id, installation_external_id, account_login,
        permissions, subscribed_events, created_by
      ) VALUES ($1, $2, '10001', '20001', 'task4-wave4-a',
        '{"contents":"read","pull_requests":"read","metadata":"read"}'::jsonb,
        '["pull_request","push"]'::jsonb, 'task4-wave4-dry-run')
    `, [installationId, tenants[0].id]);
    await client.query(`
      INSERT INTO github_app_credential_versions (
        id, tenant_id, installation_id, encrypted_credential,
        master_key_version, credential_fingerprint, created_by
      ) VALUES ($1, $2, $3, $4::jsonb, 'dry-run-v1', $5, 'task4-wave4-dry-run')
    `, [
      credentialId,
      tenants[0].id,
      installationId,
      JSON.stringify(syntheticEnvelope('dry-run-v1')),
      'a'.repeat(64),
    ]);

    const crossTenantCredentialBlocked = await operationIsBlocked(
      client,
      'cross_tenant_credential',
      `INSERT INTO github_app_credential_versions (
        tenant_id, installation_id, encrypted_credential, master_key_version,
        credential_fingerprint, created_by
      ) VALUES ($1, $2, $3::jsonb, 'dry-run-v1', $4, 'task4-wave4-dry-run')`,
      [
        tenants[1].id,
        installationId,
        JSON.stringify(syntheticEnvelope('dry-run-v1')),
        'b'.repeat(64),
      ],
      ['23503'],
    );
    const crossTenantInstallationClaimBlocked = await operationIsBlocked(
      client,
      'cross_tenant_installation',
      `INSERT INTO github_app_installations (
        tenant_id, app_id, installation_external_id, account_login,
        permissions, created_by
      ) VALUES ($1, '10001', '20001', 'task4-wave4-b',
        '{"contents":"read","pull_requests":"read"}'::jsonb,
        'task4-wave4-dry-run')`,
      [tenants[1].id],
      ['23505'],
    );
    const plaintextEnvelopeBlocked = await operationIsBlocked(
      client,
      'plaintext_envelope',
      `UPDATE github_app_credential_versions
       SET encrypted_credential = '{"privateKey":"not-allowed"}'::jsonb WHERE id = $1`,
      [credentialId],
      ['P0001', '23514'],
    );
    const membershipScopeBlocked = await operationIsBlocked(
      client,
      'membership_scope',
      `UPDATE tenant_admin_memberships SET tenant_id = $1 WHERE id = $2`,
      [tenants[1].id, membershipId],
      ['P0001'],
    );
    const installationIdentityBlocked = await operationIsBlocked(
      client,
      'installation_identity',
      `UPDATE github_app_installations SET account_login = 'changed' WHERE id = $1`,
      [installationId],
      ['P0001'],
    );

    await client.query(`
      UPDATE github_app_credential_versions
      SET status = 'retiring', effective_until = now() + interval '1 day'
      WHERE id = $1
    `, [credentialId]);
    const credentialReactivationBlocked = await operationIsBlocked(
      client,
      'credential_reactivation',
      `UPDATE github_app_credential_versions SET status = 'active' WHERE id = $1`,
      [credentialId],
      ['P0001'],
    );
    await client.query(`
      UPDATE github_app_credential_versions
      SET status = 'revoked', revoked_at = now()
      WHERE id = $1
    `, [credentialId]);
    await client.query(`
      UPDATE tenant_admin_memberships SET status = 'revoked', revoked_at = now()
      WHERE id = $1
    `, [membershipId]);
    await client.query(`
      UPDATE github_app_installations SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = $1
    `, [installationId]);

    if (await wave4TableCount(client) !== 3
      || Number(rls.rows[0].count) !== 3
      || Number(triggers.rows[0].count) !== 3
      || Number(hardeningConstraints.rows[0].count) !== 7
      || Number(plaintextColumns.rows[0].count) !== 0
      || !crossTenantCredentialBlocked
      || !crossTenantInstallationClaimBlocked
      || !plaintextEnvelopeBlocked
      || !membershipScopeBlocked
      || !installationIdentityBlocked
      || !credentialReactivationBlocked) {
      throw new Error('One or more Wave 4 migration dry-run checks failed');
    }

    await client.query('ROLLBACK');
    transactionOpen = false;
    const after = await wave4TableCount(client);
    if (after !== 0) throw new Error('Wave 4 migration dry-run did not roll back cleanly');

    console.log('migration_dry_run=applied-inside-transaction');
    console.log('inside_transaction_tables=3');
    console.log('rls_enabled_tables=3');
    console.log('immutable_triggers=3');
    console.log('hardening_constraints=7');
    console.log('unexpected_plaintext_columns=0');
    console.log('cross_tenant_credential=blocked');
    console.log('cross_tenant_installation_claim=blocked');
    console.log('plaintext_envelope=blocked');
    console.log('membership_scope_update=blocked');
    console.log('installation_identity_update=blocked');
    console.log('credential_reactivation=blocked');
    console.log('lifecycle_revocations=accepted');
    console.log('migration_dry_run=rolled-back');
    console.log(`after_rollback_tables=${after}`);
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 4 migration dry-run failed');
  process.exitCode = 1;
});
