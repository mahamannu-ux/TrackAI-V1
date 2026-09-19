import 'dotenv/config';

import { Pool } from 'pg';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task5-schema-verify',
  });
  try {
    const result = await pool.query<{
      vector_extension: string;
      semantic_tables: string;
      vector_dimensions: string;
      lexical_indexes: string;
      versioning_constraints: string;
      rls_tables: string;
      browser_policies: string;
      plaintext_columns: string;
      invalid_rows: string;
      journal_rows: string;
    }>(`
      SELECT
        (SELECT count(*) FROM pg_extension WHERE extname = 'vector')::text AS vector_extension,
        (SELECT count(*) FROM unnest(ARRAY[
          'public.evidence_intention_embeddings',
          'public.evidence_semantic_jobs'
        ]) AS expected(name) WHERE to_regclass(expected.name) IS NOT NULL)::text AS semantic_tables,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'evidence_intention_embeddings'
           AND column_name = 'embedding'
           AND udt_name = 'vector')::text AS vector_dimensions,
        (SELECT count(*) FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'evidence_intention_embeddings_lexical_idx'
           AND indexdef ILIKE '%USING gin%')::text AS lexical_indexes,
        (SELECT count(*) FROM pg_constraint WHERE conname IN (
          'evidence_intentions_tenant_series_version_key',
          'evidence_intentions_supersedes_tenant_fk',
          'evidence_intentions_version_check',
          'evidence_intentions_lifecycle_check',
          'evidence_intentions_semantic_availability_check',
          'evidence_intention_embeddings_dimensions_check',
          'evidence_semantic_jobs_state_check',
          'evidence_semantic_jobs_attempt_check'
        ))::text AS versioning_constraints,
        (SELECT count(*) FROM pg_class WHERE oid IN (
          'public.tenant_evidence_settings'::regclass,
          'public.evidence_events'::regclass,
          'public.evidence_event_contents'::regclass,
          'public.evidence_intentions'::regclass,
          'public.evidence_links'::regclass,
          'public.evidence_summaries'::regclass,
          'public.evidence_semantic_documents'::regclass,
          'public.evidence_intention_embeddings'::regclass,
          'public.evidence_semantic_jobs'::regclass
        ) AND relrowsecurity)::text AS rls_tables,
        (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
          AND tablename IN (
            'tenant_evidence_settings', 'evidence_events', 'evidence_event_contents',
            'evidence_intentions', 'evidence_links', 'evidence_summaries',
            'evidence_semantic_documents', 'evidence_intention_embeddings',
            'evidence_semantic_jobs'
          ))::text AS browser_policies,
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('evidence_intention_embeddings', 'evidence_semantic_jobs')
           AND column_name ~ '(prompt|response|reasoning|tool_payload|raw_content|plaintext)')::text
          AS plaintext_columns,
        ((SELECT count(*) FROM evidence_intentions
          WHERE version < 1 OR content_fingerprint = '' OR series_id IS NULL)
         + (SELECT count(*) FROM evidence_intention_embeddings
          WHERE dimensions <> 384 OR expires_at <= created_at)
         + (SELECT count(*) FROM evidence_semantic_jobs
          WHERE attempt_count < 0 OR attempt_count > 5 OR expires_at <= created_at))::text AS invalid_rows,
        (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS journal_rows
    `);
    const row = result.rows[0];
    const checks = {
      vector: Number(row.vector_extension) === 1,
      tables: Number(row.semantic_tables) === 2,
      dimensions: Number(row.vector_dimensions) === 1,
      lexical: Number(row.lexical_indexes) === 1,
      constraints: Number(row.versioning_constraints) === 8,
      rls: Number(row.rls_tables) === 9,
      policies: Number(row.browser_policies) === 0,
      plaintext: Number(row.plaintext_columns) === 0,
      rows: Number(row.invalid_rows) === 0,
      journal: Number(row.journal_rows) >= 12,
    };
    if (Object.values(checks).some(value => !value)) {
      throw new Error('Task5 persistent schema verification failed');
    }
    console.log('pgvector_extension=enabled');
    console.log('semantic_tables=2');
    console.log('embedding_dimensions=384');
    console.log('lexical_gin_index=present');
    console.log('versioning_constraints=8');
    console.log('rls_enabled_tables=9');
    console.log('direct_browser_policies=0');
    console.log('unexpected_plaintext_columns=0');
    console.log('invalid_semantic_rows=0');
    console.log(`journal_rows=${row.journal_rows}`);
    console.log('schema_verification=passed');
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task5 schema verification failed');
  process.exitCode = 1;
});
