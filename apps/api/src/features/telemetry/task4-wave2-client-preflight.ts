import 'dotenv/config';

import { Pool } from 'pg';

const COMPANY_DOMAINS = ['purpletealabs.net', 'customer-b-oidc.com'] as const;

type PreflightRow = {
  domain: string;
  tenant_id: string;
  repository_id: string | null;
  normalized_url: string | null;
  active_credentials: string;
  active_enrollments: string;
  active_grants: string;
};

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave2-client-preflight',
  });

  try {
    const result = await pool.query<PreflightRow>(`
      SELECT
        lower(t.domain) AS domain,
        t.id AS tenant_id,
        r.id AS repository_id,
        r.normalized_url,
        (
          SELECT count(*) FROM machine_credentials c
          JOIN developer_machines m
            ON m.tenant_id = c.tenant_id AND m.id = c.machine_id
          WHERE c.tenant_id = t.id
            AND c.status = 'active' AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > now())
            AND m.status = 'active' AND m.revoked_at IS NULL
        )::text AS active_credentials,
        (
          SELECT count(*) FROM repository_enrollments e
          WHERE e.tenant_id = t.id AND e.status = 'active'
            AND e.effective_from <= now()
            AND (e.effective_until IS NULL OR e.effective_until > now())
        )::text AS active_enrollments,
        (
          SELECT count(*) FROM machine_repository_grants g
          WHERE g.tenant_id = t.id AND g.status = 'active'
            AND g.effective_from <= now()
            AND (g.effective_until IS NULL OR g.effective_until > now())
        )::text AS active_grants
      FROM sso_tenants t
      LEFT JOIN scm_repositories r ON r.tenant_id = t.id
      WHERE lower(t.domain) = ANY($1::text[])
      ORDER BY lower(t.domain), r.normalized_url, r.id
    `, [COMPANY_DOMAINS]);

    for (const domain of COMPANY_DOMAINS) {
      const rows = result.rows.filter(row => row.domain === domain);
      if (rows.length === 0) throw new Error(`Tenant fixture is missing for ${domain}`);
      const first = rows[0];
      const repositories = rows
        .filter(row => row.repository_id && row.normalized_url)
        .map(row => `${row.repository_id}:${row.normalized_url}`);
      console.log(`${domain}.tenant_id=${first.tenant_id}`);
      console.log(`${domain}.repositories=${repositories.join(',') || 'none'}`);
      console.log(`${domain}.active_credentials=${first.active_credentials}`);
      console.log(`${domain}.active_enrollments=${first.active_enrollments}`);
      console.log(`${domain}.active_grants=${first.active_grants}`);
    }
    console.log('preflight=read-only-complete');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 client preflight failed');
  process.exitCode = 1;
});
