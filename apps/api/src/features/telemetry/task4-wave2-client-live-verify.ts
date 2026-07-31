import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

type ManifestEntry = {
  label: string;
  tenantId: string;
  repositoryId: string;
  repositoryUrl: string;
};

type Manifest = {
  version: number;
  createdAt: string;
  entries: ManifestEntry[];
};

type CountRow = { count: string };
type EvidenceRow = {
  event_count: string;
  normalized_count: string;
  failed_count: string;
  generation_count: string;
  generated_lines: string;
  unavailable_accepted_lines: string;
  lifecycle_count: string;
  lifecycle_lines: string;
  model_lifecycle_count: string;
  model_lifecycle_lines: string;
};

function requireCount(value: string, expected: number, message: string): void {
  if (Number(value) !== expected) throw new Error(message);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const runtimeDirValue = process.env.TASK4_WAVE2_RUNTIME_DIR?.trim();
  if (!runtimeDirValue) throw new Error('TASK4_WAVE2_RUNTIME_DIR is required');

  const manifestPath = join(resolve(runtimeDirValue), 'task4-wave2-client-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (manifest.version !== 1 || !manifest.createdAt || manifest.entries.length !== 2) {
    throw new Error('Wave 2 client manifest is invalid');
  }

  const createdAt = new Date(manifest.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Wave 2 manifest timestamp is invalid');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave2-client-live-verify',
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");

    for (const entry of manifest.entries) {
      const evidence = await client.query<EvidenceRow>(`
        WITH target_events AS (
          SELECT e.*
          FROM telemetry_metric_events e
          WHERE e.tenant_id = $1
            AND e.event_kind = 4
            AND e.created_at >= $3
            AND e.raw_event #>> '{a,1}' = $4
            AND e.raw_event #>> '{a,20}' = 'task4-live-ai'
        )
        SELECT
          (SELECT count(*) FROM target_events)::text AS event_count,
          (SELECT count(*) FROM target_events
            WHERE normalization_status = 'normalized')::text AS normalized_count,
          (SELECT count(*) FROM target_events
            WHERE normalization_status = 'failed')::text AS failed_count,
          (SELECT count(*)
             FROM ai_generation_observations g
             JOIN target_events e ON e.id = g.source_event_id
            WHERE g.tenant_id = $1 AND g.repository_id = $2)::text AS generation_count,
          COALESCE((SELECT sum(g.generated_lines)
             FROM ai_generation_observations g
             JOIN target_events e ON e.id = g.source_event_id
            WHERE g.tenant_id = $1 AND g.repository_id = $2), 0)::text AS generated_lines,
          (SELECT count(*)
             FROM ai_generation_observations g
             JOIN target_events e ON e.id = g.source_event_id
            WHERE g.tenant_id = $1 AND g.repository_id = $2
              AND g.accepted_lines IS NULL)::text AS unavailable_accepted_lines,
          (SELECT count(*)
             FROM ai_code_lifecycle_events l
             JOIN target_events e ON l.evidence_ref = 'checkpoint:' || e.id::text
            WHERE l.tenant_id = $1 AND l.repository_id = $2
              AND l.stage = 'generated')::text AS lifecycle_count,
          COALESCE((SELECT sum(l.line_count)
             FROM ai_code_lifecycle_events l
             JOIN target_events e ON l.evidence_ref = 'checkpoint:' || e.id::text
            WHERE l.tenant_id = $1 AND l.repository_id = $2
              AND l.stage = 'generated'), 0)::text AS lifecycle_lines,
          (SELECT count(*)
             FROM ai_model_lifecycle_events m
             JOIN target_events e
               ON m.evidence_ref LIKE 'checkpoint:' || e.id::text || ':model:%'
            WHERE m.tenant_id = $1 AND m.repository_id = $2
              AND m.stage = 'generated' AND m.tool = 'task4-live-ai')::text
            AS model_lifecycle_count,
          COALESCE((SELECT sum(m.line_count)
             FROM ai_model_lifecycle_events m
             JOIN target_events e
               ON m.evidence_ref LIKE 'checkpoint:' || e.id::text || ':model:%'
            WHERE m.tenant_id = $1 AND m.repository_id = $2
              AND m.stage = 'generated' AND m.tool = 'task4-live-ai'), 0)::text
            AS model_lifecycle_lines
      `, [entry.tenantId, entry.repositoryId, createdAt, entry.repositoryUrl]);

      const row = evidence.rows[0];
      requireCount(row.event_count, 1, `${entry.label} checkpoint event count is invalid`);
      requireCount(row.normalized_count, 1, `${entry.label} checkpoint was not normalized`);
      requireCount(row.failed_count, 0, `${entry.label} checkpoint normalization failed`);
      requireCount(row.generation_count, 1, `${entry.label} generation evidence is missing`);
      requireCount(row.generated_lines, 1, `${entry.label} generated lines changed`);
      requireCount(
        row.unavailable_accepted_lines,
        1,
        `${entry.label} missing accepted-line evidence was not retained as unavailable`,
      );
      requireCount(row.lifecycle_count, 1, `${entry.label} generated lifecycle evidence is missing`);
      requireCount(row.lifecycle_lines, 1, `${entry.label} generated lifecycle lines changed`);
      requireCount(
        row.model_lifecycle_count,
        1,
        `${entry.label} model lifecycle evidence is missing`,
      );
      requireCount(
        row.model_lifecycle_lines,
        1,
        `${entry.label} model lifecycle lines changed`,
      );

      const crossing = await client.query<CountRow>(`
        SELECT count(*)::text AS count
        FROM telemetry_metric_events e
        WHERE e.tenant_id <> $1
          AND e.created_at >= $2
          AND e.raw_event #>> '{a,1}' = $3
      `, [entry.tenantId, createdAt, entry.repositoryUrl]);
      requireCount(crossing.rows[0].count, 0, `${entry.label} repository crossed tenant context`);

      console.log(`${entry.label}.checkpoint_events=1`);
      console.log(`${entry.label}.repository_scope=matched`);
      console.log(`${entry.label}.normalization=normalized`);
      console.log(`${entry.label}.generated_lines=1`);
      console.log(`${entry.label}.accepted_lines=unavailable`);
      console.log(`${entry.label}.model_attribution=task4-live-ai`);
      console.log(`${entry.label}.cross_tenant_rows=0`);
    }

    await client.query('COMMIT');
    console.log('task2_generated_semantics=preserved');
    console.log('production_proxy=not_exercised');
    console.log('verification=read-only-complete');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 2 client verification failed');
  process.exitCode = 1;
});
