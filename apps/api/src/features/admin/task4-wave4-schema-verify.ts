import 'dotenv/config';

import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave4-schema-verify',
  });
  try {
    const result = await pool.query<{
      tables: string;
      rls_tables: string;
      immutable_triggers: string;
      hardening_constraints: string;
      plaintext_columns: string;
      invalid_lifecycle_rows: string;
      memberships: string;
      installations: string;
      credentials: string;
      journal_rows: string;
    }>(`
      SELECT
        (SELECT count(*) FROM unnest(ARRAY[
          'public.tenant_admin_memberships',
          'public.github_app_installations',
          'public.github_app_credential_versions'
        ]) AS expected(name) WHERE to_regclass(expected.name) IS NOT NULL)::text AS tables,
        (SELECT count(*) FROM pg_class WHERE oid IN (
          'public.tenant_admin_memberships'::regclass,
          'public.github_app_installations'::regclass,
          'public.github_app_credential_versions'::regclass
        ) AND relrowsecurity)::text AS rls_tables,
        (SELECT count(*) FROM pg_trigger WHERE tgname IN (
          'tenant_admin_memberships_scope_immutable',
          'github_app_installations_identity_immutable',
          'github_app_credential_versions_evidence_immutable'
        ) AND NOT tgisinternal)::text AS immutable_triggers,
        (SELECT count(*) FROM pg_constraint WHERE conname IN (
          'github_app_installations_app_id_check',
          'github_app_installations_external_id_check',
          'github_app_installations_provider_host_check',
          'github_app_installations_account_login_check',
          'github_app_installations_permissions_check',
          'github_app_installations_events_check',
          'github_app_credential_versions_envelope_check'
        ))::text AS hardening_constraints,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('github_app_installations', 'github_app_credential_versions')
           AND column_name ~ '(plaintext|access_token|private_key|webhook_secret)')::text
          AS plaintext_columns,
        (
          (SELECT count(*) FROM tenant_admin_memberships
           WHERE (status = 'active' AND revoked_at IS NOT NULL)
              OR (status = 'revoked' AND revoked_at IS NULL))
          + (SELECT count(*) FROM github_app_installations
             WHERE (status = 'active' AND revoked_at IS NOT NULL)
                OR (status = 'revoked' AND revoked_at IS NULL))
          + (SELECT count(*) FROM github_app_credential_versions
             WHERE (status IN ('active', 'retiring') AND revoked_at IS NOT NULL)
                OR (status = 'revoked' AND revoked_at IS NULL))
          + (SELECT count(*) FROM github_app_credential_versions AS credential
             INNER JOIN github_app_installations AS installation
               ON installation.tenant_id = credential.tenant_id
              AND installation.id = credential.installation_id
             WHERE credential.status IN ('active', 'retiring')
               AND installation.status <> 'active')
        )::text AS invalid_lifecycle_rows,
        (SELECT count(*) FROM tenant_admin_memberships)::text AS memberships,
        (SELECT count(*) FROM github_app_installations)::text AS installations,
        (SELECT count(*) FROM github_app_credential_versions)::text AS credentials,
        (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS journal_rows
    `);
    const row = result.rows[0];
    if (Number(row.tables) !== 3
      || Number(row.rls_tables) !== 3
      || Number(row.immutable_triggers) !== 3
      || Number(row.hardening_constraints) !== 7
      || Number(row.plaintext_columns) !== 0
      || Number(row.invalid_lifecycle_rows) !== 0
      || Number(row.journal_rows) < 7) {
      throw new Error('Wave 4 persistent schema verification failed');
    }
    console.log('task4_admin_tables=3');
    console.log('rls_enabled_tables=3');
    console.log('immutable_triggers=3');
    console.log('hardening_constraints=7');
    console.log('unexpected_plaintext_columns=0');
    console.log('invalid_lifecycle_rows=0');
    console.log(`admin_memberships=${row.memberships}`);
    console.log(`github_app_installations=${row.installations}`);
    console.log(`github_app_credential_versions=${row.credentials}`);
    console.log(`journal_rows=${row.journal_rows}`);
    console.log('schema_verification=passed');
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 4 schema verification failed');
  process.exitCode = 1;
});
