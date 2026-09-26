import 'dotenv/config';

import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { encryptEnvelope } from '../../core/security/envelope-encryption';
import { task5VerificationCorpus, validateTask5VerificationCorpus } from './task5-verification-corpus';

type PgFailure = Error & { code?: string; constraint?: string };
type Scenario = Record<string, unknown>;
let activeStage = 'startup';

const lifecycleCountsSql = `
  SELECT
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM scm_pull_requests) AS scm_pull_requests,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_commit_sessions) AS ai_commit_sessions,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events
`;

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function expectForeignKeyRejection(
  client: PoolClient,
  tenantId: string,
  intentionId: string,
  marker: string,
) {
  await client.query('SAVEPOINT cross_tenant_semantic');
  try {
    await client.query(`
      INSERT INTO evidence_semantic_jobs
        (tenant_id, intention_id, content_fingerprint, model_revision, expires_at)
      VALUES ($1, $2, $3, 'task5-verification-model', now() + interval '30 days')
    `, [tenantId, intentionId, fingerprint(marker)]);
    await client.query('ROLLBACK TO SAVEPOINT cross_tenant_semantic');
    await client.query('RELEASE SAVEPOINT cross_tenant_semantic');
    return false;
  } catch (error) {
    const failure = error as PgFailure;
    await client.query('ROLLBACK TO SAVEPOINT cross_tenant_semantic');
    await client.query('RELEASE SAVEPOINT cross_tenant_semantic');
    return failure.code === '23503'
      && failure.constraint === 'evidence_semantic_jobs_tenant_intention_fk';
  }
}

async function main() {
  activeStage = 'configuration';
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const persistAcceptance = process.env.TASK5_ACCEPTANCE_PERSIST === '1';
  if (persistAcceptance && process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('Persistent acceptance fixtures require an explicitly ephemeral database');
  }
  const acceptanceDomain = 'task5.acceptance.invalid';
  const acceptanceSubject = 'task5-acceptance-admin';
  const acceptanceEmail = `admin@${acceptanceDomain}`;
  validateTask5VerificationCorpus();

  const corpus = task5VerificationCorpus;
  const marker = `task5-corpus-${randomUUID()}`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: 'trackai-task5-corpus-live-verify',
  });
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    activeStage = 'baseline';
    const beforeLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    activeStage = 'tenants';
    const tenantIds = new Map<string, string>();
    for (const [key, domain] of Object.entries(corpus.tenants)) {
      const tenantDomain = persistAcceptance && key === 'primary'
        ? acceptanceDomain
        : `${marker}.${domain}`;
      const result = await client.query<{ id: string }>(`
        INSERT INTO sso_tenants
          (company_name, domain, supabase_provider_id, scm_org_identifier)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [
        `Task5 verification ${key}`,
        tenantDomain,
        `${marker}-${key}-provider`,
        `${marker}-${key}-org`,
      ]);
      tenantIds.set(key, result.rows[0].id);
    }
    const primaryTenantId = tenantIds.get('primary')!;
    const isolatedTenantId = tenantIds.get('isolated')!;

    activeStage = 'repositories_and_consent';
    const repositories = new Map<string, string>();
    for (const [key, tenantId] of tenantIds) {
      const result = await client.query<{ id: string }>(`
        INSERT INTO scm_repositories
          (tenant_id, provider, external_id, name, url, normalized_url)
        VALUES ($1, 'github', $2, $3, $4, $4)
        RETURNING id
      `, [
        tenantId,
        `${corpus.repository.externalId}-${marker}-${key}`,
        corpus.repository.name,
        `${corpus.repository.url}?run=${marker}-${key}`,
      ]);
      repositories.set(key, result.rows[0].id);
    }
    const primaryRepositoryId = repositories.get('primary')!;

    for (const tenantId of tenantIds.values()) {
      await client.query(`
        INSERT INTO tenant_evidence_settings
          (tenant_id, raw_collection_enabled, provider, retention_days, consented_by, consented_at)
        VALUES ($1, true, 'opencode', 30, $2, now())
      `, [tenantId, `${marker}-admin`]);
    }
    if (persistAcceptance) {
      await client.query(`
        INSERT INTO tenant_admin_memberships
          (tenant_id, subject, email, role, status, granted_by)
        VALUES ($1, $2, $3, 'tenant_admin', 'active', 'task5-acceptance-seed')
      `, [primaryTenantId, acceptanceSubject, acceptanceEmail]);
    }

    activeStage = 'commits_and_sessions';
    const commitIds = new Map<string, string>();
    for (const commit of corpus.commits) {
      const result = await client.query<{ id: string }>(`
        INSERT INTO scm_commits
          (tenant_id, repository_id, sha, branch, subject, committed_at,
           diff_added_lines, observed_ai_lines)
        VALUES ($1, $2, $3, 'feature/task5-verification', $4, now(), 10, 8)
        RETURNING id
      `, [primaryTenantId, primaryRepositoryId, commit.sha, commit.subject]);
      commitIds.set(commit.key, result.rows[0].id);
    }

    const sessionIds = new Map<string, string>();
    for (const session of corpus.sessions) {
      const result = await client.query<{ id: string }>(`
        INSERT INTO ai_sessions
          (tenant_id, external_session_id, git_ai_session_id, tool, display_name,
           observed_models, status, started_at, ended_at)
        VALUES ($1, $2, $3, 'opencode', $4, $5::jsonb, $6, now() - interval '1 hour', now())
        RETURNING id
      `, [
        primaryTenantId, `${marker}-${session.externalId}`, session.gitAiSessionId,
        `Synthetic ${session.key}`, JSON.stringify(['task5-local-model']), session.status,
      ]);
      const sessionId = result.rows[0].id;
      sessionIds.set(session.key, sessionId);
      await client.query(`
        INSERT INTO ai_session_repositories (tenant_id, session_id, repository_id)
        VALUES ($1, $2, $3)
      `, [primaryTenantId, sessionId, primaryRepositoryId]);
      for (const commitKey of session.commits) {
        await client.query(`
          INSERT INTO ai_commit_sessions
            (tenant_id, commit_id, session_id, observed_ai_lines)
          VALUES ($1, $2, $3, 4)
        `, [primaryTenantId, commitIds.get(commitKey), sessionId]);
      }
    }

    activeStage = 'pull_requests';
    const pullRequestIds = new Map<string, string>();
    for (const pr of corpus.pullRequests) {
      const headCommit = corpus.commits.find(row => row.key === pr.activeCommits.at(-1));
      const result = await client.query<{ id: string }>(`
        INSERT INTO scm_pull_requests
          (tenant_id, repository_id, external_id, title, state, number, head_ref,
           base_ref, head_sha, merge_commit_sha, merged_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'main', $8, $9, $10)
        RETURNING id
      `, [
        primaryTenantId, primaryRepositoryId, `${marker}-pr-${pr.number}`,
        pr.title, pr.outcome === 'merged' || pr.outcome === 'deployed' ? 'merged' : 'open',
        pr.number, pr.branch, headCommit?.sha ?? null,
        pr.outcome === 'merged' || pr.outcome === 'deployed' ? headCommit?.sha ?? null : null,
        pr.outcome === 'merged' || pr.outcome === 'deployed' ? new Date() : null,
      ]);
      const pullRequestId = result.rows[0].id;
      pullRequestIds.set(pr.key, pullRequestId);
      const snapshot = await client.query<{ id: string }>(`
        INSERT INTO scm_pull_request_snapshots
          (tenant_id, pull_request_id, head_sha, snapshot_key, commit_shas, source, captured_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, 'task5_verification', now())
        RETURNING id
      `, [
        primaryTenantId, pullRequestId, headCommit?.sha ?? null, `${marker}-${pr.key}-snapshot`,
        JSON.stringify(pr.activeCommits.map(key => corpus.commits.find(row => row.key === key)?.sha)),
      ]);
      for (const [active, keys] of [[true, pr.activeCommits], [false, pr.historicalCommits]] as const) {
        for (const commitKey of keys) {
          await client.query(`
            INSERT INTO scm_pull_request_commit_memberships
              (tenant_id, pull_request_id, commit_id, first_seen_snapshot_id, last_seen_snapshot_id,
               active, first_seen_at, last_seen_at, removed_at)
            VALUES ($1, $2, $3, $4, $4, $5, now(), now(), $6)
          `, [
            primaryTenantId, pullRequestId, commitIds.get(commitKey), snapshot.rows[0].id,
            active, active ? null : new Date(),
          ]);
        }
      }
    }

    activeStage = 'file_attribution';
    const fileKeys = new Set<string>();
    for (const file of corpus.fileEvidence) {
      const key = `${file.commit}:${file.path}`;
      if (fileKeys.has(key)) throw new Error(`Duplicate file fixture: ${key}`);
      fileKeys.add(key);
      await client.query(`
        INSERT INTO scm_commit_files
          (tenant_id, commit_id, path, observed_ai_lines, attribution_ranges)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [
        primaryTenantId, commitIds.get(file.commit), file.path,
        file.range.endLine - file.range.startLine + 1,
        JSON.stringify([{ ...file.range, authorType: 'ai' }]),
      ]);
    }
    await client.query(`
      INSERT INTO scm_commit_files
        (tenant_id, commit_id, path, observed_ai_lines, observed_unknown_lines, attribution_ranges)
      VALUES ($1, $2, $3, 0, 3, '[]'::jsonb)
    `, [
      primaryTenantId, commitIds.get(corpus.missingAttribution.commit),
      corpus.missingAttribution.path,
    ]);

    activeStage = 'evidence_events';
    const eventIds = new Map<string, string>();
    for (const rawScenario of corpus.evidenceScenarios) {
      const scenario = rawScenario as Scenario;
      const eventId = randomUUID();
      const availability = String(scenario.availability ?? 'available');
      const content = `Synthetic Task5 ${String(scenario.key)} evidence for ${marker}`;
      const metadata = Object.fromEntries(
        ['status', 'attempt', 'durationMs'].flatMap(key => scenario[key] === undefined ? [] : [[key, scenario[key]]]),
      );
      await client.query(`
        INSERT INTO evidence_events
          (id, tenant_id, session_id, repository_id, provider, provider_event_id,
           event_type, trace_id, model, tool_name, evidence_state, availability,
           source_version, metadata, content_sha256, occurred_at, expires_at)
        VALUES ($1, $2, $3, $4, 'opencode', $5, $6, $7, 'task5-local-model', $8,
                'observed', $9, 'task5-verification/1', $10::jsonb, $11, now(),
                now() + interval '30 days')
      `, [
        eventId, primaryTenantId, sessionIds.get(String(scenario.session)), primaryRepositoryId,
        `${marker}-${String(scenario.key)}`, scenario.type, scenario.trace,
        scenario.tool ?? null, availability, JSON.stringify(metadata),
        availability === 'unavailable' ? null : fingerprint(content),
      ]);
      eventIds.set(String(scenario.key), eventId);
      if (availability !== 'unavailable') {
        const encrypted = encryptEnvelope(JSON.stringify({ message: content }), {
          tenantId: primaryTenantId, purpose: 'evidence-event', resourceId: eventId,
        });
        await client.query(`
          INSERT INTO evidence_event_contents
            (tenant_id, event_id, encrypted_value, redaction_summary, expires_at)
          VALUES ($1, $2, $3::jsonb, $4::jsonb, now() + interval '30 days')
        `, [
          primaryTenantId, eventId, JSON.stringify(encrypted),
          JSON.stringify(availability === 'redacted' ? { synthetic_sentinel: 1 } : {}),
        ]);
      }
    }

    activeStage = 'intentions';
    const intentionIds = new Map<string, string>();
    const seriesIds = new Map<string, string>();
    for (const intention of corpus.intentions) {
      const id = randomUUID();
      const seriesId = seriesIds.get(intention.series) ?? randomUUID();
      seriesIds.set(intention.series, seriesId);
      const encrypted = encryptEnvelope(JSON.stringify(intention.text), {
        tenantId: primaryTenantId, purpose: 'evidence-intention', resourceId: id,
      });
      const supersedesId = intention.version > 1
        ? intentionIds.get(corpus.intentions.find(row => row.series === intention.series
          && row.version === intention.version - 1)?.key ?? '') ?? null
        : null;
      await client.query(`
        INSERT INTO evidence_intentions
          (id, tenant_id, series_id, version, lifecycle, supersedes_intention_id,
           is_current, session_id, encrypted_value, content_fingerprint,
           evidence_state, confidence, semantic_availability, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
                'pending', now() + interval '30 days')
      `, [
        id, primaryTenantId, seriesId, intention.version, intention.lifecycle,
        supersedesId, intention.current,
        intention.session ? sessionIds.get(intention.session) : null,
        JSON.stringify(encrypted), fingerprint(intention.text), intention.state,
        intention.state === 'inferred' ? 70 : 100,
      ]);
      intentionIds.set(intention.key, id);
    }

    activeStage = 'isolated_tenant';
    const isolatedSession = await client.query<{ id: string }>(`
      INSERT INTO ai_sessions
        (tenant_id, external_session_id, tool, display_name, observed_models, status)
      VALUES ($1, $2, 'opencode', 'Tenant-isolation probe', '[]'::jsonb, 'shipped')
      RETURNING id
    `, [isolatedTenantId, `${marker}-isolated-session`]);
    const isolatedIntentionId = randomUUID();
    const isolatedEncrypted = encryptEnvelope(JSON.stringify(corpus.isolatedTenantIntention), {
      tenantId: isolatedTenantId, purpose: 'evidence-intention', resourceId: isolatedIntentionId,
    });
    await client.query(`
      INSERT INTO evidence_intentions
        (id, tenant_id, series_id, version, lifecycle, is_current, session_id,
         encrypted_value, content_fingerprint, evidence_state, confidence,
         semantic_availability, expires_at)
      VALUES ($1, $2, $3, 1, 'finalized', true, $4, $5::jsonb, $6,
              'observed', 100, 'pending', now() + interval '30 days')
    `, [
      isolatedIntentionId, isolatedTenantId, randomUUID(), isolatedSession.rows[0].id,
      JSON.stringify(isolatedEncrypted), fingerprint(corpus.isolatedTenantIntention),
    ]);

    activeStage = 'verification_queries';
    const identity = (await client.query<{
      zero_sessions: string; one_sessions: string; multi_sessions: string;
      max_sessions_per_commit: string; trace_count: string; checkpoint_count: string;
    }>(`
      SELECT
        count(*) FILTER (WHERE commit_count = 0)::text AS zero_sessions,
        count(*) FILTER (WHERE commit_count = 1)::text AS one_sessions,
        count(*) FILTER (WHERE commit_count > 1)::text AS multi_sessions,
        (SELECT max(session_count)::text FROM (
          SELECT count(*) AS session_count FROM ai_commit_sessions
          WHERE tenant_id = $1 GROUP BY commit_id
        ) grouped_commits) AS max_sessions_per_commit,
        (SELECT count(DISTINCT trace_id)::text FROM evidence_events WHERE tenant_id = $1) AS trace_count,
        (SELECT count(DISTINCT range->>'checkpointId')::text
          FROM scm_commit_files, jsonb_array_elements(attribution_ranges) range
          WHERE tenant_id = $1 AND range ? 'checkpointId') AS checkpoint_count
      FROM (
        SELECT sessions.id, count(links.id) AS commit_count
        FROM ai_sessions sessions
        LEFT JOIN ai_commit_sessions links
          ON links.tenant_id = sessions.tenant_id AND links.session_id = sessions.id
        WHERE sessions.tenant_id = $1
        GROUP BY sessions.id
      ) grouped_sessions
    `, [primaryTenantId])).rows[0];
    const primaryIntentions = (await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM evidence_intentions WHERE tenant_id = $1',
      [primaryTenantId],
    )).rows[0].count;
    const encryptedPlaintextMatches = (await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM evidence_intentions
      WHERE tenant_id = $1 AND encrypted_value::text ILIKE '%password recovery%'
    `, [primaryTenantId])).rows[0].count;
    const persistedShape = (await client.query<{
      exact_files: string; missing_files: string; active_memberships: string;
      historical_memberships: string; consented_tenants: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM scm_commit_files
          WHERE tenant_id = $1 AND jsonb_array_length(attribution_ranges) > 0) AS exact_files,
        (SELECT count(*)::text FROM scm_commit_files
          WHERE tenant_id = $1 AND jsonb_array_length(attribution_ranges) = 0) AS missing_files,
        (SELECT count(*)::text FROM scm_pull_request_commit_memberships
          WHERE tenant_id = $1 AND active) AS active_memberships,
        (SELECT count(*)::text FROM scm_pull_request_commit_memberships
          WHERE tenant_id = $1 AND NOT active) AS historical_memberships,
        (SELECT count(*)::text FROM tenant_evidence_settings
          WHERE tenant_id = ANY($2::uuid[]) AND raw_collection_enabled) AS consented_tenants
    `, [primaryTenantId, [...tenantIds.values()]])).rows[0];
    activeStage = 'cross_tenant_rejection';
    const crossTenantSemanticBlocked = await expectForeignKeyRejection(
      client, primaryTenantId, isolatedIntentionId, marker,
    );

    activeStage = 'acceptance_checks';
    const checks = {
      zeroCommitSession: Number(identity.zero_sessions) >= 1,
      oneCommitSession: Number(identity.one_sessions) >= 1,
      multiCommitSession: Number(identity.multi_sessions) >= 1,
      multiSessionCommit: Number(identity.max_sessions_per_commit) >= 2,
      multipleTraces: Number(identity.trace_count) >= 3,
      multipleCheckpoints: Number(identity.checkpoint_count) >= 3,
      primaryTenantIntentions: Number(primaryIntentions) === corpus.intentions.length,
      encryptedAtRest: encryptedPlaintextMatches === '0',
      crossTenantSemanticBlocked,
      exactAndMissingAttribution: Number(persistedShape.exact_files) >= 1
        && Number(persistedShape.missing_files) >= 1,
      activeAndHistoricalMembership: Number(persistedShape.active_memberships) >= 1
        && Number(persistedShape.historical_memberships) >= 1,
      explicitConsent: Number(persistedShape.consented_tenants) === tenantIds.size,
    };
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) {
      console.log(`failed_checks=${failedChecks.join(',')}`);
      throw new Error('task5_acceptance_check_failed');
    }

    if (persistAcceptance) {
      activeStage = 'commit_acceptance_fixture';
      await client.query('COMMIT');
      transactionOpen = false;
      console.log('corpus=task5-password-recovery-v1');
      console.log('acceptance_fixture=persisted');
      console.log(`acceptance_email=${acceptanceEmail}`);
      console.log('acceptance_role=tenant_admin');
      console.log('task5_corpus_live_verification=passed');
      return;
    }

    activeStage = 'rollback_and_residuals';
    await client.query('ROLLBACK');
    transactionOpen = false;
    const afterLifecycle = (await client.query(lifecycleCountsSql)).rows[0];
    const residual = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM sso_tenants WHERE domain LIKE $1
    `, [`${marker}.%`]);
    const lifecycleUnchanged = JSON.stringify(beforeLifecycle) === JSON.stringify(afterLifecycle);

    console.log('corpus=task5-password-recovery-v1');
    console.log('identity_many_to_many=passed');
    console.log('traces_and_checkpoints=passed');
    console.log('active_and_historical_pr_membership=passed');
    console.log('exact_and_missing_attribution=passed');
    console.log('encrypted_content_plaintext_probe=passed');
    console.log('cross_tenant_semantic_reference=blocked');
    console.log('transaction=rolled-back');
    console.log(`residual_probe_rows=${residual.rows[0].count}`);
    console.log(`task2_lifecycle_counts=${lifecycleUnchanged ? 'unchanged' : 'changed'}`);
    console.log('task5_corpus_live_verification=passed');
    if (residual.rows[0].count !== '0' || !lifecycleUnchanged) process.exitCode = 1;
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

void main().catch(error => {
  const failure = error as PgFailure;
  console.log('task5_corpus_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`error_code=${failure.code ?? 'unknown'}`);
  if (failure.constraint) console.log(`error_constraint=${failure.constraint}`);
  process.exitCode = 1;
});
