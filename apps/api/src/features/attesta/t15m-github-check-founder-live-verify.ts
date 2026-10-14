/**
 * IT-T15m-03: the check against the real GitHub App and the real test PR, on a
 * throwaway database (the persistent database is migrated in Task15n step 1).
 *
 * Seeds the throwaway with the founder's real test PR (open PR #3 in
 * customer-b-corp-ai/concurrency_engine_for_webhook_tests) and runs one pass
 * with the REAL GitHub helpers, minting the installation token through the
 * env-token adapter. Set privately (never paste these anywhere):
 *
 *   GITHUB_APP_INSTALLATIONS_JSON='{"customer-b-corp-ai":"<installation id>"}'
 *   GITHUB_APP_ID='<app id>'
 *   GITHUB_APP_PRIVATE_KEY='<private key, \n for newlines>'
 *
 * (or GITHUB_APP_INSTALLATION_TOKEN for a pre-minted token), then:
 *
 *   scripts/it-db.sh npm run verify:task15m-github-check-founder-live -w apps/api
 *
 * Expects one PR selected and one check created. Prints only safe summary
 * lines (counts and the title, never shas or tokens).
 */
import { randomUUID } from 'node:crypto';
import { db, pool } from '../../core/db';
import { githubGetStatus, githubWrite } from '../scm/github-app';
import type { GitHubCommit } from '../scm/github-app';
import { recordPullRequestSnapshot } from '../scm/lifecycle-service';
import { upsertPullRequestObservation } from '../scm/scm.routes';
import {
  runGithubCheckPass,
} from './github-check';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15m-03 failed: ${message}`);
}

const OWNER = 'customer-b-corp-ai';
const REPO_URL = `https://github.com/${OWNER}/concurrency_engine_for_webhook_tests`;
const HEAD_SHA = '000b7b3e403080cd7da1b6374685634d17b1b0e8';

function githubCommit(commitSha: string): GitHubCommit {
  return {
    sha: commitSha,
    commit: { message: 'IT-T15m-03 seed (mirrors the real open PR)', date: new Date().toISOString() } as GitHubCommit['commit'],
    parents: [],
  };
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  check(
    Boolean(process.env.GITHUB_APP_INSTALLATIONS_JSON ?? process.env.GITHUB_APP_INSTALLATION_ID),
    'set GITHUB_APP_INSTALLATIONS_JSON (or GITHUB_APP_INSTALLATION_ID) plus GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY or GITHUB_APP_INSTALLATION_TOKEN',
  );

  const tenantId = randomUUID();
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, 'IT T15m-03', `it-t15m-03-${randomUUID().slice(0, 8)}.example`, `it-t15m-03-${randomUUID().slice(0, 8)}`]);
  const repo = await pool.query(
    `insert into scm_repositories (tenant_id, provider, external_id, name, url) values ($1, 'github', $2, $3, $4) returning id::text as id`,
    [tenantId, `${OWNER}/concurrency_engine_for_webhook_tests`, 'concurrency_engine_for_webhook_tests', REPO_URL]);
  const repositoryId = repo.rows[0].id as string;
  const pullRequestId = await db.transaction((tx) => upsertPullRequestObservation(tx, {
    eventType: 'pr_opened', tenantId, repositoryId, provider: 'github',
    providerDeliveryId: randomUUID(),
    pullRequest: {
      externalId: `it-t15m-03-${randomUUID().slice(0, 8)}`, number: 3, title: 'IT-T15m-03 seed', state: 'open',
      authorEmail: null, authorProviderId: '4242', authorLogin: 'it-dev',
      headRef: 'it-t15m-03', baseRef: 'main', headSha: HEAD_SHA, mergedAt: null, mergeCommitSha: null,
    },
  }));
  await recordPullRequestSnapshot({
    tenantId, repositoryId, pullRequestId, headSha: HEAD_SHA, commits: [githubCommit(HEAD_SHA)],
  });

  const result = await runGithubCheckPass(
    pool,
    { write: githubWrite, getStatus: githubGetStatus, env: process.env },
    { tenantId, now: new Date() },
  );
  check(result.prs === 1 && result.created === 1, `one PR posted: ${JSON.stringify(result)}`);
  const listed = await githubGetStatus<{ check_runs: Array<{ id: number; name: string; conclusion: string; output: { title: string } }> }>(
    `/repos/${OWNER}/concurrency_engine_for_webhook_tests/commits/${HEAD_SHA}/check-runs?check_name=TrackAI%20Attesta&filter=latest`,
    tenantId, OWNER,
  );
  check(listed.status === 200 && listed.data, `check run is listed: status ${listed.status}`);
  const run = (listed.data?.check_runs ?? []).find((r) => r.name === 'TrackAI Attesta');
  check(run?.conclusion === 'neutral', 'the check is neutral');
  console.log(`check_title=${run?.output.title}`);
  console.log('IT-T15m-03=passed');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15m-03 failed');
  process.exitCode = 1;
}).finally(() => pool.end());
