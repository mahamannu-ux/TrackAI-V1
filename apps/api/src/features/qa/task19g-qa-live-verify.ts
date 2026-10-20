/** IT-T19g-01 steps 1–3: real webhook, managed upload, QA routes, and tenant isolation. */
import 'dotenv/config';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseDotenv } from 'dotenv';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { pool } from '../../core/db';
import { createGitHubAppInstallation } from '../../core/security/github-app-security-service';
import { createMachineCredential } from '../../core/security/machine-credential';
import { runMergedByBackfill } from '../scm/task19g-merged-by-backfill';

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`IT-T19g-01 failed: ${label}`);
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function listen(server: Server): Promise<Server> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

/** Optional step 4: copy one lab commit's metadata into the throwaway DB, then use real App blame. */
async function verifyLiveQ2(
  tenantId: string,
  token: string,
  get: (path: string, token: string) => Promise<{ status: number; body: any }>,
): Promise<void> {
  const sourceEnvFile = process.env.TASK19G_Q2_SOURCE_ENV_FILE;
  const appKeyFile = process.env.TASK19G_Q2_APP_KEY_FILE;
  if (!sourceEnvFile && !appKeyFile) return;
  check(sourceEnvFile && appKeyFile, 'both Q2 source env and App key file required');
  const sourceUrl = parseDotenv(readFileSync(sourceEnvFile)).DATABASE_URL;
  check(sourceUrl && sourceUrl !== process.env.DATABASE_URL, 'separate source database URL required');
  const source = new Client({
    connectionString: sourceUrl,
    connectionTimeoutMillis: 7000,
    options: '-c default_transaction_read_only=on -c statement_timeout=7000',
  });
  type LabRow = {
    provider: string; external_id: string; name: string; url: string;
    sha: string; subject: string; author_email: string | null; commit_ai_lines: number;
    path: string; file_ai_lines: number; file_human_lines: number; attribution_ranges: unknown;
    app_id: string; installation_external_id: string; account_login: string;
  };
  let candidates: LabRow[];
  await source.connect();
  try {
    const result = await source.query<LabRow>(`select r.provider, r.external_id, r.name, r.url,
      c.sha, c.subject, c.author_email, c.observed_ai_lines as commit_ai_lines,
      f.path, f.observed_ai_lines as file_ai_lines,
      f.observed_human_lines as file_human_lines, f.attribution_ranges,
      i.app_id, i.installation_external_id, i.account_login
      from sso_tenants t
      join scm_repositories r on r.tenant_id = t.id
      join scm_commits c on c.tenant_id = t.id and c.repository_id = r.id
      join scm_commit_files f on f.tenant_id = t.id and f.commit_id = c.id
      join github_app_installations i on i.tenant_id = t.id and i.provider_host = 'github.com'
        and i.account_login = 'mahamannu-ai'
        and i.status = 'active'
      where t.domain = 'purpletealabs.net'
        and r.url = 'https://github.com/mahamannu-ai/git-ai-teamz-lab'
        and c.sha = '807419e8ceb1436ce34826d496e87a964888aa27'
        and f.observed_ai_lines > 0
      order by f.observed_ai_lines desc limit 3`);
    candidates = result.rows;
  } finally {
    await source.end();
  }
  const chosen = candidates.flatMap((row) => {
    if (!Array.isArray(row.attribution_ranges)) return [];
    const range = row.attribution_ranges.find((item) => item && typeof item === 'object'
      && item.kind === 'ai' && Number.isInteger(item.startLine)
      && item.startLine > 0 && item.startLine <= 1_000_000);
    return range ? [{ row, line: range.startLine as number }] : [];
  })[0];
  check(chosen, 'lab commit has an AI-attributed file line');
  const { row, line } = chosen;
  const repositoryId = randomUUID();
  const commitId = randomUUID();
  const fileId = randomUUID();
  await pool.query(`insert into scm_repositories
    (id, tenant_id, provider, external_id, name, url)
    values ($1, $2, $3, $4, $5, $6)`,
  [repositoryId, tenantId, row.provider, row.external_id, row.name, row.url]);
  await pool.query(`insert into scm_commits
    (id, tenant_id, repository_id, sha, subject, author_email, observed_ai_lines)
    values ($1, $2, $3, $4, $5, $6, $7)`,
  [commitId, tenantId, repositoryId, row.sha, row.subject, row.author_email, row.commit_ai_lines]);
  await pool.query(`insert into scm_commit_files
    (id, tenant_id, commit_id, path, observed_ai_lines, observed_human_lines, attribution_ranges)
    values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
  [fileId, tenantId, commitId, row.path, row.file_ai_lines, row.file_human_lines,
    JSON.stringify(row.attribution_ranges)]);
  await createGitHubAppInstallation({
    tenantId, appId: row.app_id, installationExternalId: row.installation_external_id,
    accountLogin: row.account_login, permissions: { contents: 'read', pull_requests: 'read' },
    privateKey: readFileSync(appKeyFile, 'utf8'), actorId: 'it-t19g-live',
  });
  const scope = `kind=live&repository_id=${repositoryId}&commit_sha=${row.sha}`;
  const drilldown = await get(`/api/qa/questions/Q2/drilldown?${scope}`, token);
  check(drilldown.status === 200 && drilldown.body.items?.some((item: { id: string }) => item.id === fileId),
    'Q2 file drill-down');
  const answer = await get(`/api/qa/questions/Q2/answer?${scope}&file_id=${fileId}&line=${line}`, token);
  const figure = (key: string) => answer.body.figures?.find((item: { key: string }) => item.key === key);
  check(answer.status === 200 && figure('line_written_by_ai')?.value?.count === 1
    && figure('originating_commit_known')?.value?.count === 1, 'Q2 live exact AI line');
  check(!JSON.stringify(answer.body).includes(row.path), 'Q2 response has no file path');
  process.stdout.write(`IT-T19g-01 step 4 passed: real App blame, exact AI line ${line}, no path in answer\n`);
}

async function main(): Promise<void> {
  check(process.env.TASK6_EPHEMERAL_DATABASE === '1', 'disposable database flag');
  check(process.env.DATABASE_URL && ['127.0.0.1', 'localhost']
    .includes(new URL(process.env.DATABASE_URL).hostname), 'local disposable database');
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'it-t19g', alg: 'RS256', use: 'sig' };
  const auth = await listen(createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    } else res.writeHead(404).end();
  }));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`;
  process.env.GITHUB_WEBHOOK_SECRET = `it-t19g-${randomUUID()}`;
  let api: Server | undefined;
  try {
    const { createApp } = await import('../../app');
    api = await new Promise<Server>((done) => {
      const server = createApp().listen(0, '127.0.0.1', () => done(server));
    });
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const org = `it-t19g-${randomUUID().slice(0, 8)}`;
    const domainA = `${org}-a.example`;
    const domainB = `${org}-b.example`;
    await pool.query(`insert into sso_tenants
      (id, company_name, domain, supabase_provider_id, scm_org_identifier)
      values ($1, 'IT T19g A', $2, $2, $3), ($4, 'IT T19g B', $5, $5, $6)`,
    [tenantA, domainA, org, tenantB, domainB, `${org}-b`]);
    for (const [tenant, subject, domain] of [
      [tenantA, 'admin-a', domainA], [tenantB, 'admin-b', domainB],
    ]) await pool.query(`insert into tenant_admin_memberships
      (tenant_id, subject, email, role, status, granted_by)
      values ($1, $2, $3, 'tenant_admin', 'active', 'it-t19g')`,
    [tenant, subject, `${subject}@${domain}`]);
    const bearer = (subject: string, domain: string) => jwt.sign({ subject, sub: subject,
      email: `${subject}@${domain}` }, keys.privateKey,
    { algorithm: 'RS256', keyid: 'it-t19g', expiresIn: 600 });
    const get = async (path: string, token: string) => {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as any };
    };
    const sha = 'a'.repeat(40);
    const body = JSON.stringify({ action: 'closed', repository: {
      id: 1901, name: 'it-repo', html_url: `https://github.com/${org}/it-repo`,
      owner: { login: org },
    }, pull_request: { id: 1902, number: 1, title: 'IT merge', state: 'closed',
      merged_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      merge_commit_sha: sha, user: { id: 10, login: 'author' },
      merged_by: { id: 11, login: 'merger' } } });
    const signature = `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!)
      .update(body).digest('hex')}`;
    const webhook = await fetch(`${base}/api/v1/webhooks/github`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature,
        'x-github-event': 'pull_request', 'x-github-delivery': randomUUID() } });
    check(webhook.status === 200, `webhook ${webhook.status}`);
    const pr = await pool.query<{ id: string; repository_id: string; merged_by_provider_id: string }>(
      `select id, repository_id, merged_by_provider_id from scm_pull_requests
       where tenant_id = $1 and external_id = '1902'`, [tenantA]);
    check(pr.rows.length === 1 && pr.rows[0].merged_by_provider_id === '11', 'merger stored');
    await pool.query(`update scm_pull_requests set merged_by_provider_id = null,
      merged_by_login = null where id = $1`, [pr.rows[0].id]);
    await runMergedByBackfill(false);
    const beforeBackfill = await pool.query<{ merged_by_provider_id: string | null }>(
      `select merged_by_provider_id from scm_pull_requests where id = $1`, [pr.rows[0].id]);
    check(beforeBackfill.rows[0].merged_by_provider_id === null, 'dry-run changes nothing');
    await runMergedByBackfill(true);
    const afterBackfill = await pool.query<{ merged_by_provider_id: string | null }>(
      `select merged_by_provider_id from scm_pull_requests where id = $1`, [pr.rows[0].id]);
    check(afterBackfill.rows[0].merged_by_provider_id === '11', 'confirm fills merger');
    const markers = await pool.query<{ tenant_id: string; details: { updated: number } }>(
      `select tenant_id, details from security_audit_events
       where action = 'scm.merged_by.backfilled' order by tenant_id`);
    check(markers.rows.length === 2 && markers.rows.some((row) =>
      row.tenant_id === tenantB && row.details.updated === 0), 'one backfill marker per tenant');
    const commitId = randomUUID();
    await pool.query(`insert into scm_commits
      (id, tenant_id, repository_id, sha, subject, author_email, observed_ai_lines)
      values ($1, $2, $3, $4, 'IT AI commit', 'author@example.test', 5)`,
    [commitId, tenantA, pr.rows[0].repository_id, sha]);
    await pool.query(`insert into scm_pull_request_commits
      (tenant_id, pull_request_id, commit_id, match_method, confidence)
      values ($1, $2, $3, 'it_fixture', 100)`, [tenantA, pr.rows[0].id, commitId]);
    const period = `from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`
      + `&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;
    const q6 = await get(`/api/qa/questions/Q6/answer?kind=live&repository_id=${pr.rows[0].repository_id}&${period}`,
      bearer('admin-a', domainA));
    check(q6.status === 200 && q6.body.figures.find((f: any) =>
      f.key === 'merged_by_someone_else')?.value?.count === 1, 'Q6 merger count');
    check(!JSON.stringify(q6.body).includes('"merger"'), 'Q6 no login');
    const machine = randomUUID();
    const credential = createMachineCredential();
    await pool.query(`insert into developer_machines (id, tenant_id, installation_id, display_name)
      values ($1, $2, $3, 'IT T19g machine')`, [machine, tenantA, randomUUID()]);
    await pool.query(`insert into machine_credentials
      (tenant_id, machine_id, key_id, secret_hash, status)
      values ($1, $2, $3, $4, 'active')`,
    [tenantA, machine, credential.keyId, credential.secretHash]);
    const upload = await fetch(`${base}/worker/metrics/upload`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': credential.plaintext },
      body: JSON.stringify({ v: 1, events: [{ t: 1, e: 1, v: {},
        a: { '1': `https://github.com/${org}/ungranted`, '5': 'main' } }] }),
    });
    check(upload.status === 200, `managed upload ${upload.status}`);
    const audit = await pool.query<{ details: { event_count: number } }>(
      `select details from security_audit_events where tenant_id = $1
       and action = 'telemetry.upload.rejected'`, [tenantA]);
    check(audit.rows.length === 1 && audit.rows[0].details.event_count === 1, 'one rejection audit');
    const q15 = await get(`/api/qa/questions/Q15/answer?kind=live&${period}`, bearer('admin-a', domainA));
    check(q15.status === 200 && q15.body.figures.find((f: any) =>
      f.key === 'rejected_uploads')?.value?.count === 1, 'Q15 rejection count');
    const isolated = await get(`/api/qa/questions/Q15/answer?kind=live&${period}`,
      bearer('admin-b', domainB));
    check(isolated.status === 200 && isolated.body.availability === 'partial', 'Company B Q15 isolation');
    const foreign = await get(`/api/qa/questions/Q6/answer?kind=live&repository_id=${pr.rows[0].repository_id}&${period}`,
      bearer('admin-b', domainB));
    check(foreign.status === 404, 'Company B Q6 scope isolation');
    const beforeIngest = await pool.query<{ count: string }>(
      `select count(*)::text as count from telemetry_ingest_batches where tenant_id = $1`, [tenantA]);
    await pool.query(`alter table security_audit_events add constraint it_t19g_refuse_audit
      check (action <> 'telemetry.upload.rejected') not valid`);
    try {
      const failedAudit = await fetch(`${base}/worker/metrics/upload`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': credential.plaintext },
        body: JSON.stringify({ v: 1, events: [{ t: 2, e: 1, v: {},
          a: { '1': `https://github.com/${org}/ungranted`, '5': 'main' } }] }),
      });
      check(failedAudit.status === 503, 'audit failure fails closed');
      const afterIngest = await pool.query<{ count: string }>(
        `select count(*)::text as count from telemetry_ingest_batches where tenant_id = $1`, [tenantA]);
      check(afterIngest.rows[0].count === beforeIngest.rows[0].count, 'audit failure ingests nothing');
    } finally {
      await pool.query(`alter table security_audit_events drop constraint it_t19g_refuse_audit`);
    }
    process.stdout.write('IT-T19g-01 steps 1–3 passed: merger, managed rejection, tenant isolation\n');
    try {
      await verifyLiveQ2(tenantA, bearer('admin-a', domainA), get);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('IT-T19g-01 failed:')) throw error;
      throw new Error('IT-T19g-01 failed: Q2 live provider or setup error');
    }
  } finally {
    await new Promise<void>((done) => api?.close(() => done()) ?? done());
    await new Promise<void>((done) => auth.close(() => done()));
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'IT-T19g-01 failed'}\n`);
  process.exitCode = 1;
});
