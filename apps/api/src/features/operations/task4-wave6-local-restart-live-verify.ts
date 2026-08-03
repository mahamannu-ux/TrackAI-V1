import 'dotenv/config';

import { Pool } from 'pg';

const companyADomain = 'purpletealabs.net';
const companyBDomain = 'customer-b-oidc.com';
const externalSessionId = 'ai_tab-task4-wave6-offline-restart';
const tool = 'task4-wave6-release';
const repositoryIdentity = 'github.com/mahamannu-ai/git-ai-teamz-lab';
const expectedEventTimestamp = 1785703102;
const expectedBranch = 'feature/task4-wave6-release';
const expectedCommitSubject = 'test: add Wave 6 delayed delivery evidence';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task4-wave6-local-restart-live-verify',
  });
  try {
    const result = await pool.query<{
      domain: string;
      session_id: string;
      generated_lines: number;
      normalization_status: string;
      arrival_class: string;
      event_timestamp: Date;
      normalized_url: string | null;
      repository_url: string;
    }>(`
      SELECT
        tenant.domain,
        session.id::text AS session_id,
        observation.generated_lines,
        event.normalization_status,
        event.arrival_class,
        event.event_timestamp,
        repository.normalized_url,
        repository.url AS repository_url
      FROM ai_sessions AS session
      JOIN sso_tenants AS tenant ON tenant.id = session.tenant_id
      JOIN ai_generation_observations AS observation
        ON observation.tenant_id = session.tenant_id
       AND observation.session_id = session.id
      JOIN telemetry_metric_events AS event
        ON event.tenant_id = observation.tenant_id
       AND event.id = observation.source_event_id
      JOIN scm_repositories AS repository
        ON repository.tenant_id = observation.tenant_id
       AND repository.id = observation.repository_id
      WHERE session.external_session_id = $1
        AND session.tool = $2
      ORDER BY event.created_at, event.id
    `, [externalSessionId, tool]);

    const companyARows = result.rows.filter(row => row.domain === companyADomain);
    const companyBRows = result.rows.filter(row => row.domain === companyBDomain);
    const sessionIds = new Set(companyARows.map(row => row.session_id));
    const generatedLines = companyARows.reduce((sum, row) => sum + row.generated_lines, 0);
    const timestamps = new Set(companyARows.map(row => Math.floor(row.event_timestamp.getTime() / 1000)));
    const normalizationStatuses = [...new Set(companyARows.map(row => row.normalization_status))];
    const arrivalClasses = [...new Set(companyARows.map(row => row.arrival_class))];
    const repositoryMatched = companyARows.every(row => (
      (row.normalized_url ?? row.repository_url)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^git@github\.com:/, 'github.com/')
        .replace(/\.git$/, '') === repositoryIdentity
    ));

    const matches = companyARows.length === 1
      && companyBRows.length === 0
      && sessionIds.size === 1
      && generatedLines === 2
      && companyARows.every(row => row.normalization_status === 'normalized')
      && companyARows.every(row => row.arrival_class === 'delayed')
      && timestamps.size === 1
      && timestamps.has(expectedEventTimestamp)
      && repositoryMatched;
    if (!matches) {
      console.error(`diagnostic.company_a_rows=${companyARows.length}`);
      console.error(`diagnostic.company_b_rows=${companyBRows.length}`);
      console.error(`diagnostic.company_a_sessions=${sessionIds.size}`);
      console.error(`diagnostic.generated_lines=${generatedLines}`);
      console.error(`diagnostic.normalization=${normalizationStatuses.join(',') || 'none'}`);
      console.error(`diagnostic.arrival=${arrivalClasses.join(',') || 'none'}`);
      console.error(`diagnostic.event_timestamps=${[...timestamps].join(',') || 'none'}`);
      console.error(`diagnostic.repository_scope=${repositoryMatched ? 'matched' : 'mismatched'}`);
      throw new Error('Wave 6 local restart server evidence did not match the expected contract');
    }

    const commitResult = await pool.query<{
      domain: string;
      sha: string;
      branch: string | null;
      observed_ai_lines: number;
      observed_human_lines: number;
      observed_unknown_lines: number;
      normalization_status: string;
      normalized_url: string | null;
      repository_url: string;
      model_rows: number;
      model_ai_lines: number;
    }>(`
      SELECT
        tenant.domain,
        commit.sha,
        commit.branch,
        commit.observed_ai_lines,
        commit.observed_human_lines,
        commit.observed_unknown_lines,
        event.normalization_status,
        repository.normalized_url,
        repository.url AS repository_url,
        count(attribution.id)::int AS model_rows,
        coalesce(sum(attribution.observed_ai_lines), 0)::int AS model_ai_lines
      FROM scm_commits AS commit
      JOIN sso_tenants AS tenant ON tenant.id = commit.tenant_id
      JOIN scm_repositories AS repository
        ON repository.tenant_id = commit.tenant_id
       AND repository.id = commit.repository_id
      JOIN telemetry_metric_events AS event
        ON event.tenant_id = commit.tenant_id
       AND event.id = commit.source_event_id
      LEFT JOIN ai_commit_model_attributions AS attribution
        ON attribution.tenant_id = commit.tenant_id
       AND attribution.commit_id = commit.id
       AND attribution.tool = $1
       AND attribution.model = 'verification-model'
      WHERE commit.subject = $2
        AND commit.branch = $3
      GROUP BY tenant.domain, commit.id, event.normalization_status, repository.id
      ORDER BY commit.created_at, commit.id
    `, [tool, expectedCommitSubject, expectedBranch]);
    const companyACommits = commitResult.rows.filter(row => row.domain === companyADomain);
    const companyBCommits = commitResult.rows.filter(row => row.domain === companyBDomain);
    const commitRepositoryMatched = companyACommits.every(row => (
      (row.normalized_url ?? row.repository_url)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^git@github\.com:/, 'github.com/')
        .replace(/\.git$/, '') === repositoryIdentity
    ));
    if (companyACommits.length !== 1
      || companyBCommits.length !== 0
      || companyACommits[0].sha.length !== 40
      || companyACommits[0].branch !== expectedBranch
      || companyACommits[0].observed_ai_lines !== 2
      || companyACommits[0].observed_human_lines !== 0
      || companyACommits[0].observed_unknown_lines !== 0
      || companyACommits[0].normalization_status !== 'normalized'
      || companyACommits[0].model_rows !== 1
      || companyACommits[0].model_ai_lines !== 2
      || !commitRepositoryMatched) {
      throw new Error('Wave 6 commit server evidence did not match the expected contract');
    }

    console.log('company_a.session=matched-once');
    console.log('company_a.generation_observations=1');
    console.log('company_a.generated_lines=2');
    console.log('company_a.normalization=normalized');
    console.log('company_a.arrival=delayed');
    console.log(`company_a.original_event_ts=${expectedEventTimestamp}`);
    console.log('company_a.repository_scope=matched');
    console.log('company_b.cross_tenant_rows=0');
    console.log(`company_a.commit_sha=${companyACommits[0].sha}`);
    console.log('company_a.commit_branch=matched');
    console.log('company_a.commit_ai_lines=2');
    console.log('company_a.commit_model_attribution=matched');
    console.log('company_b.cross_tenant_commits=0');
    console.log('raw_events=not-selected-or-printed');
    console.log('database_changes=none');
    console.log('verification=passed');
  } finally {
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error
    ? error.message
    : 'Wave 6 local restart server verification failed');
  process.exitCode = 1;
});
