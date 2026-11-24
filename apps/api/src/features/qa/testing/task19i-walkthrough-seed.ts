/**
 * IT-T19i-01 seed: one throwaway database holding everything the T19.9 walkthrough
 * (docs/plan/TASK19_WALKTHROUGH.md, 15 steps) asks about, built through the real
 * pipelines wherever one exists:
 *
 * Company A
 *  - code: two Git AI commit notes ingested through `ingestMetricsBatch` (one AI-assisted
 *    commit with a known model, one human commit), a signed GitHub `pull_request` closed
 *    and merged webhook and a signed production `deployment_status` webhook through the
 *    real `/api/v1/webhooks/github` route;
 *  - Attesta: the trust inventory set up by the `attesta:keys` CLI with the development
 *    signer, the builder pass over every pointer, an anchor pass (Rekor and TSA fakes),
 *    one period report covering the seeded period, security seals and one security
 *    period report;
 *  - security (Endpoint data in the stored shape, as IT-T19f/19h insert it): v2 findings
 *    across four severities and three categories (some in the previous period), one
 *    inventory snapshot, day-one scan summaries (complete and no-session-files), one
 *    at-rest finding, permission requests with one approved and one denied decision.
 * Company B: its own repository and commit, its own small inventory and one finding.
 *
 * Ported from (helpers copied, never imported, because those files are runnable scripts
 * with a `main`): IT-T16h-01 `task16h-auditor-qa-live-verify.ts` (trust inventory,
 * statements, period and security reports), IT-T15i4 `t15i4-period-report-live-verify.ts`
 * (anchoring through the environment with the fakes), IT-T19g-01 (signed webhook),
 * IT-T19f-01 and IT-T19h-01 (security rows), all at TrackAI `main` 0d4099c.
 *
 *   scripts/it-db.sh npx tsx src/features/qa/testing/task19i-walkthrough-seed.ts <manifest.json> <work dir>
 *
 * Writes the manifest (ids, periods, the API's Attesta environment) for the spec. Times are
 * relative to the seed's start, so the default "Last 30 days" window always covers them.
 * Synthetic only; refuses a non-ephemeral database. Prints safe summary lines only.
 */
import { createHmac, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { db, pool } from '../../../core/db';
import { ingestMetricsBatch } from '../../telemetry/service';
import type { GitAiMetricEvent } from '../../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from '../../attesta/anchor-contract';
import { anchorFromEnv } from '../../attesta/anchor-env';
import { runAnchorPass } from '../../attesta/anchor-worker';
import { main as keysMain } from '../../attesta/attesta-keys-cli';
import { main as rootMain } from '../../attesta/attesta-trust-root-cli';
import { chainStatement } from '../../attesta/ledger';
import { pgReportStore, runPeriodReport, type ReportDatabase } from '../../attesta/period-report-service';
import { pgSecuritySealStore, runSecuritySealPass } from '../../attesta/security-seal-service';
import type { SealDatabase } from '../../attesta/audit-seal-service';
import { buildSecurityReport, pgSecurityReportStore } from '../../attesta/security-report-service';
import { FakeRekor } from '../../attesta/testing/fake-rekor';
import { FakeTsa, TSA_URL } from '../../attesta/testing/fake-tsa';
import { keyidOf } from '../../attesta/trust-documents';
import { pgTrustStore, type TrustDb } from '../../attesta/trust-inventory';
import { adaptersFromEnv, inventorySignerResolver, trustConfigFromEnv } from '../../attesta/trust-resolver';
import { runBuilderPass, type BuilderPassOptions } from '../../attesta/worker';
import {
  WALKTHROUGH_COMPANIES, WALKTHROUGH_USERS, assertEphemeralDatabase, type WalkthroughCompany,
} from './task19i-walkthrough-users';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BUILDER_VERSION = '0.1.0+0123456789abcdef';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T19i-01 seed failed: ${message}`);
}

/** What the spec needs to know about the seeded world. */
export interface WalkthroughManifest {
  seededAt: string;
  companyA: { tenantId: string; repositoryId: string; repositoryName: string; pullRequestId: string; model: string; tool: string };
  companyB: { tenantId: string; repositoryId: string };
  /** The exact scope the code and security period reports were built over (Signed answers). */
  codeReport: { from: string; to: string; statementDigest: string };
  securityReport: { from: string; to: string; statementDigest: string };
  /** What the founder's steps expect, as seeded. */
  expected: {
    permissionApproved: number; permissionDenied: number; permissionRequested: number;
    machinesReporting: number; agentsDetected: number; agentsWired: number;
    findingsInPeriod: number; findingsPreviousPeriod: number; highOrCriticalInReport: number;
  };
  /** The four synthetic users (task19i-walkthrough-users.ts), for the browser sign-in. */
  users: typeof WALKTHROUGH_USERS;
  /** Environment the API process needs to verify signatures and anchors (file paths only). */
  apiEnv: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tenants, users, keys

interface Tenant { company: WalkthroughCompany; tenantId: string; repoUrl: string; repoName: string; repoExternalId: number; repositoryId: string; machineId: string }

async function seedTenant(company: WalkthroughCompany, repoName: string, repoExternalId: number): Promise<Tenant> {
  const tenantId = randomUUID();
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id, scm_org_identifier)
    values ($1, $2, $3, $4, $5)`, [tenantId, company.name, company.domain, `task19i-${company.label}`, company.githubOrg]);
  for (const user of Object.values(WALKTHROUGH_USERS).filter((u) => u.company === company.label)) {
    await pool.query(`insert into tenant_admin_memberships (tenant_id, subject, email, role, status, granted_by)
      values ($1, $2, $3, $4, 'active', 'task19i-seed')`, [tenantId, user.subject, user.email, user.role]);
  }
  const machine = await pool.query(`insert into developer_machines (tenant_id, installation_id, display_name)
    values ($1, $2, $3) returning id::text as id`, [tenantId, randomUUID(), `Walkthrough machine ${company.label.toUpperCase()}`]);
  return { company, tenantId, repoUrl: `https://github.com/${company.githubOrg}/${repoName}`, repoName, repoExternalId,
    repositoryId: '', machineId: machine.rows[0].id };
}

interface Key { pem: string; pubPem: string; keyid: string }
function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = createPublicKey(privateKey);
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pubPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyidOf(pub.export({ type: 'spki', format: 'der' }) as Buffer) };
}

/** The trust inventory by CLI, exactly as IT-T16h-01 and IT-T15i4 set it up; anchoring with the fakes. */
async function trust(dir: string, a: Tenant, b: Tenant, t0: number) {
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const creds = [['dev:anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor], ['dev:keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset],
    ['dev:a1', a.tenantId, k.a1], ['dev:b1', b.tenantId, k.b1]] as const;
  const rekor = new FakeRekor();
  const tsa = await FakeTsa.create();
  const apiEnv: Record<string, string> = {
    ATTESTA_TRUST_ROOT_KEYIDS: k.root.keyid,
    ATTESTA_DEV_CREDENTIALS_FILE: file('dev-credentials.json', JSON.stringify(creds.map(([credentialId, tenantId, key]) =>
      ({ credentialId, tenantId, keyFile: file(`${credentialId.replace(':', '_')}.pem`, key.pem) })))),
    ATTESTA_ANCHOR_CREDENTIAL_ID: 'dev:anchor',
    ATTESTA_DEV_ANCHOR_KEY_FILE: file('dev_anchor.pem', k.anchor.pem),
    // Verification only reads the pinned log key and TSA anchors; nothing is fetched.
    ATTESTA_REKOR_URL: 'http://rekor.test',
    ATTESTA_REKOR_LOG_KEY_FILE: file('rekor.pem', createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString()),
    ATTESTA_TSA_URL: TSA_URL,
    ATTESTA_TSA_ANCHORS_FILE: file('tsa.pem', tsa.anchorsPem),
    TRACKAI_GIT_COMMIT: '0123456789abcdef',
  };
  Object.assign(process.env, apiEnv);
  const env = process.env;
  const out: string[] = [];
  const err: string[] = [];
  // Keys set up three hours back: every statement below is stamped after that.
  const io = { readFile: (p: string) => readFileSync(p, 'utf8'), writeFile: (p: string, t: string) => writeFileSync(p, t, { flag: 'wx' }),
    out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, now: () => new Date(t0 - 3 * 60 * MIN) };
  const cli = async (...argv: string[]) => { out.length = 0; err.length = 0; const code = await keysMain(argv, io); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const apply = async (...argv: string[]) => {
    const dry = await cli(...argv);
    check(dry.code === 0, `dry run ${argv[0]}: ${dry.err}`);
    const m = /--confirm=(\S+) --expect=(\d+)/.exec(dry.out);
    check(m, `dry run ${argv[0]} prints the apply flags`);
    const done = await cli(...argv, `--confirm=${m[1]}`, `--expect=${m[2]}`, '--actor', 'task19i-operator');
    check(done.code === 0, `apply ${argv[0]}: ${done.err}`);
  };
  await apply('register', '--adapter', 'local-dev', '--credential', 'dev:anchor', '--purpose', 'anchor');
  await apply('register', '--adapter', 'local-dev', '--credential', 'dev:keyset', '--purpose', 'tenant_keyset');
  const draft = join(dir, 'draft.json');
  const signed = join(dir, 'root.json');
  check((await cli('export-root-draft', '--out', draft, '--root-pub', file('root.pub', k.root.pubPem), '--add', k.anchor.keyid, '--add', k.keyset.keyid)).code === 0, 'export-root-draft');
  const offline = { ...io, out: () => undefined, err: () => undefined, env: {} };
  check(await rootMain(['sign', '--draft', draft, '--key', file('root.pem', k.root.pem), '--out', signed], offline) === 0, 'offline root signature');
  await apply('import-root', '--file', signed);
  for (const [t, cred, key] of [[a, 'dev:a1', k.a1], [b, 'dev:b1', k.b1]] as const) {
    await apply('register', '--adapter', 'local-dev', '--credential', cred, '--tenant', t.tenantId);
    await apply('activate', '--tenant', t.tenantId, '--keyid', key.keyid);
    await apply('publish', '--tenant', t.tenantId);
  }
  const resolver = inventorySignerResolver(pgTrustStore(db as unknown as TrustDb), await adaptersFromEnv(env), trustConfigFromEnv(env));
  const anchoring = await anchorFromEnv(env, { rekorFetch: rekor.fetch, tsaFetch: tsa.fetch });
  return { resolver, anchoring, rekor, apiEnv };
}
type Trust = Awaited<ReturnType<typeof trust>>;

// ---------------------------------------------------------------------------
// Code: Git AI notes, then GitHub webhooks through the real route

const MODEL = 'claude-sonnet-4-5';
const TOOL = 'claude';

/** A Git AI commit note event (IT-T16h-01's commitEvent shape). `aiLines` 0 is a human-only commit. */
function commitEvent(t: Tenant, sha: string, aiLines: number, humanLines: number, session: string, atSec: number): GitAiMetricEvent {
  const total = aiLines + humanLines;
  const note = aiLines > 0
    ? [`src/${t.company.label}/feature.ts`, `  s_wt::t_1 1-${aiLines}`, '---',
      JSON.stringify({ sessions: { s_wt: { agent_id: { tool: TOOL, id: session, model: MODEL } } } })].join('\n')
    : '';
  return {
    t: atSec, e: 1,
    v: { '0': total, '1': 0, '2': aiLines, '3': aiLines > 0 ? [`${TOOL}:${MODEL}`] : [], '5': aiLines > 0 ? [aiLines] : [],
      '11': 'Synthetic walkthrough commit', ...(note ? { '13': note } : {}), '15': atSec - 60, '16': atSec - 30 },
    a: { '1': t.repoUrl, '2': `Walkthrough Dev ${t.company.label.toUpperCase()} <dev@${t.company.domain}>`, '3': sha, '5': 'main',
      ...(aiLines > 0 ? { '20': TOOL, '21': MODEL, '23': session } : {}) },
  };
}

/**
 * A fake GitHub REST API at the network boundary, for this seed process only: the webhook
 * handler asks the GitHub App for the PR's commits and the merge commit (scm.routes.ts),
 * which never answers locally. Only `https://api.github.com/repos/<org>/<repo>/…` GETs are
 * answered, with synthetic commits; every other request goes to the real fetch.
 * Nothing else is mocked.
 */
function fakeGitHub(t: Tenant, commits: Array<{ sha: string; parent: string | null; at: string }>, prNumber: number): () => void {
  const real = globalThis.fetch;
  const prefix = `https://api.github.com/repos/${t.company.githubOrg}/${t.repoName}`;
  const asGitHub = (c: { sha: string; parent: string | null; at: string }) => ({
    sha: c.sha,
    commit: { message: 'Synthetic walkthrough commit', author: { name: 'Walkthrough Dev', email: `dev@${t.company.domain}`, date: c.at }, committer: { date: c.at } },
    author: { id: 9101, login: 'walkthrough-author' },
    parents: c.parent ? [{ sha: c.parent }] : [],
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith('https://api.github.com/')) return real(input, init);
    const u = new URL(url);
    const path = `https://api.github.com${u.pathname}`;
    if (path === `${prefix}/pulls/${prNumber}/commits`) return json(u.searchParams.get('page') === '1' || !u.searchParams.get('page') ? commits.map(asGitHub) : []);
    if (path.startsWith(`${prefix}/commits/`)) {
      const c = commits.find((x) => x.sha === decodeURIComponent(path.slice(`${prefix}/commits/`.length)));
      return c ? json(asGitHub(c)) : json({ message: 'Not Found' }, 404);
    }
    if (path === `${prefix}/pulls`) return json([]);
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function webhook(base: string, secret: string, event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(`${base}/api/v1/webhooks/github`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': event, 'x-github-delivery': randomUUID() } });
  check(res.status === 200, `${event} webhook: HTTP ${res.status}`);
}

const hex40 = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);

async function builderPass(w: Trust, stampAgeMin: number, t0: number): Promise<void> {
  const stamp = new Date(t0 - stampAgeMin * MIN);
  const options: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: BUILDER_VERSION,
    deps: { chain: (tx, input) => chainStatement(tx, input, () => stamp) } };
  const pass = await runBuilderPass(db, w.resolver, options);
  check(pass.failed === 0 && pass.retried === 0, `builder pass: ${JSON.stringify(pass.codes)}`);
}

// ---------------------------------------------------------------------------
// Security rows in the stored shape (IT-T19f-01 / IT-T19h-01)

const digest = () => `sha256:${randomUUID().replace(/-/g, '')}${'a'.repeat(32)}`;
const BUNDLE = 'e'.repeat(64);

async function v2Finding(t: Tenant, f: { rule: string; severity: string; at: Date; receivedAt?: Date; repository: boolean; session: string | null; atRest?: boolean }): Promise<void> {
  await pool.query(`insert into security_findings
    (tenant_id, machine_id, record_generation, rule_id, rule_version, rule_category,
     rule_severity, effect, occurred_at, rule_pack_version, repository_id, session_id,
     record_id, source_agent, source_type, model, confidence, title, detected_at,
     numbat_schema_version, bundle_digest, lease_id, found_at_rest, repository_kind, received_at)
    values ($1, $2, 'v2', $3, '2.0', split_part($3, '.', 1), $4, 'monitor', $5,
      $6, $7, $8, $9, 'claude-code', $10, $11, 'high', 'Synthetic walkthrough finding', $5,
      '0.5.0', $12, 'task19i-lease', $13, $14, $15)`,
  [t.tenantId, t.machineId, f.rule, f.severity, f.at, `bundle:${BUNDLE.slice(0, 16)}`,
    f.repository ? t.repositoryId : null, f.session, digest(), f.atRest ? 'artifact' : 'hook', f.atRest ? null : MODEL,
    BUNDLE, Boolean(f.atRest), f.repository ? 'enrolled' : 'not_enrolled', f.receivedAt ?? f.at]);
}

async function inventory(t: Tenant, at: Date, agents: Array<{ agent: string; wired: 'yes' | 'no' }>): Promise<void> {
  await pool.query(`insert into security_agent_inventory_snapshots (tenant_id, machine_id, record_id, observed_at, agents)
    values ($1, $2, $3, $4, $5::jsonb)`, [t.tenantId, t.machineId, digest(), at,
    JSON.stringify(agents.map((x) => ({ agent: x.agent, version: null, config: 'present', artifacts: x.wired === 'yes' ? 'present' : 'absent', wired: x.wired })))]);
}

async function scan(t: Tenant, status: 'complete' | 'error', artifacts: number, findings: number): Promise<void> {
  await pool.query(`insert into security_scan_summaries (tenant_id, machine_id, record_id, status, artifacts_scanned,
    events_emitted, findings_emitted, indicators_emitted, diagnostics) values ($1, $2, $3, $4, $5, 0, $6, 0, 0)`,
  [t.tenantId, t.machineId, digest(), status, artifacts, findings]);
}

async function permission(t: Tenant, outcome: 'requested' | 'approved' | 'denied', session: string, at: Date): Promise<void> {
  await pool.query(`insert into security_permission_events
    (tenant_id, machine_id, record_id, outcome, session_id, source_agent, occurred_at, "join")
    values ($1, $2, $3, $4, $5, 'claude-code', $6, 'same_session_window')`,
  [t.tenantId, t.machineId, digest(), outcome, session, at]);
}

async function dataSettings(t: Tenant, at: Date): Promise<void> {
  await pool.query(`insert into security_data_settings_versions
    (tenant_id, version, command_previews, file_paths, urls, host_identity, user_identity,
     agents, day_one_scan, monitor_mode, created_by, reason, created_at)
    values ($1, 1, false, false, false, false, false, array['claude-code'], true, 'monitor',
      'task19i-seed', 'walkthrough', $2)`, [t.tenantId, at]);
}

// ---------------------------------------------------------------------------

export async function seedWalkthrough(workDir: string): Promise<WalkthroughManifest> {
  assertEphemeralDatabase('The Task19i walkthrough seed');
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  const ago = (ms: number) => new Date(t0 - ms);
  const a = await seedTenant(WALKTHROUGH_COMPANIES.a, 'walkthrough-app', 91901);
  const b = await seedTenant(WALKTHROUGH_COMPANIES.b, 'company-b-service', 92901);
  const w = await trust(workDir, a, b, t0);

  // Code, Company A: an AI-assisted commit and a human commit, as Git AI notes.
  const aiSha = hex40();
  const humanSha = hex40();
  const session = `task19i-session-${randomUUID().slice(0, 8)}`;
  const nowSec = Math.floor(t0 / 1000);
  for (const [sha, ai, human, age] of [[aiSha, 40, 10, 70], [humanSha, 0, 25, 65]] as const) {
    const errors = await ingestMetricsBatch(a.tenantId, { v: 1, events: [commitEvent(a, sha, ai, human, session, nowSec - age * 60)] });
    check(errors.length === 0, `Company A ingestion: ${JSON.stringify(errors)}`);
  }
  const bErrors = await ingestMetricsBatch(b.tenantId, { v: 1, events: [commitEvent(b, hex40(), 5, 5, `task19i-b-${randomUUID().slice(0, 8)}`, nowSec - 60 * 60)] });
  check(bErrors.length === 0, 'Company B ingestion');
  for (const t of [a, b]) {
    const r = await pool.query(`select id::text as id from scm_repositories where tenant_id = $1 and url = $2`, [t.tenantId, t.repoUrl]);
    check(r.rows.length === 1, `${t.company.label}: one repository row`);
    t.repositoryId = r.rows[0].id;
  }
  await builderPass(w, 60, t0);

  // GitHub: the merged PR and the production deployment through the real webhook route.
  process.env.GITHUB_WEBHOOK_SECRET = `task19i-${randomUUID()}`;
  const { createApp } = await import('../../../app');
  const server = await new Promise<Server>((done) => { const s = createApp().listen(0, '127.0.0.1', () => done(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const repository = { id: a.repoExternalId, name: a.repoName, full_name: `${a.company.githubOrg}/${a.repoName}`,
    html_url: a.repoUrl, owner: { login: a.company.githubOrg } };
  const mergedAt = ago(55 * MIN).toISOString();
  process.env.GITHUB_ALLOW_PUBLIC_READ = 'true';
  const restore = fakeGitHub(a, [{ sha: aiSha, parent: humanSha, at: ago(70 * MIN).toISOString() },
    { sha: humanSha, parent: null, at: ago(65 * MIN).toISOString() }].slice(0, 1), 7);
  try {
    await webhook(base, process.env.GITHUB_WEBHOOK_SECRET, 'pull_request', { action: 'closed', repository,
      pull_request: { id: 91902, number: 7, title: 'Add walkthrough feature', state: 'closed', merged: true,
        merged_at: mergedAt, updated_at: mergedAt, merge_commit_sha: aiSha,
        head: { ref: 'feature/walkthrough', sha: aiSha }, base: { ref: 'main' },
        user: { id: 9101, login: 'walkthrough-author' }, merged_by: { id: 9102, login: 'walkthrough-merger' } } });
    await webhook(base, process.env.GITHUB_WEBHOOK_SECRET, 'deployment_status', { action: 'created', repository,
      deployment: { id: 91903, sha: aiSha, environment: 'production', created_at: ago(50 * MIN).toISOString() },
      deployment_status: { id: 91904, state: 'success', environment: 'production', created_at: ago(50 * MIN).toISOString(),
        updated_at: ago(50 * MIN).toISOString() } });
  } finally {
    restore();
    delete process.env.GITHUB_ALLOW_PUBLIC_READ;
    await new Promise<void>((done) => server.close(() => done()));
  }
  const pr = await pool.query(`select id::text as id from scm_pull_requests where tenant_id = $1 and external_id = '91902'`, [a.tenantId]);
  check(pr.rows.length === 1, 'the merged PR is stored');
  // The merged-PR pointer waits five minutes for late commits (scm.routes.ts); bring it forward.
  await pool.query(`update attesta_subjects set not_before = now() where tenant_id = $1 and status = 'pending'`, [a.tenantId]);
  await builderPass(w, 45, t0);

  const summary = await pool.query(`select kind, status, count(*)::int as n from attesta_subjects group by 1, 2 order by 1, 2`);
  console.log(`subjects ${JSON.stringify(summary.rows)}`);
  const life = await pool.query(`select stage, sum(line_count)::int as lines from ai_code_lifecycle_events where tenant_id = $1 group by 1 order by 1`, [a.tenantId]);
  console.log(`lifecycle ${JSON.stringify(life.rows)}`);
  const models = await pool.query(`select stage, model_key, sum(line_count)::int as lines from ai_model_lifecycle_events where tenant_id = $1 group by 1, 2 order by 1`, [a.tenantId]);
  console.log(`models ${JSON.stringify(models.rows)}`);

  // Security, Company A (dataSettings first: the day-one scan is opt-in).
  await dataSettings(a, ago(40 * DAY));
  for (const [rule, severity, ageMin] of [
    ['secrets.read_private_key', 'critical', 40], ['secrets.read_env_file', 'high', 38], ['exec.download_pipe_shell', 'high', 36],
    ['exec.destructive_recursive_delete', 'medium', 34], ['network.unexpected_egress', 'low', 32],
  ] as const) {
    await v2Finding(a, { rule, severity, at: ago(ageMin * MIN), repository: true, session });
  }
  await v2Finding(a, { rule: 'secrets.read_env_file', severity: 'high', at: ago(42 * DAY), repository: true, session: null });
  await inventory(a, ago(30 * MIN), [{ agent: 'claude-code', wired: 'yes' }, { agent: 'codex', wired: 'yes' }, { agent: 'cursor', wired: 'no' }]);
  await scan(a, 'complete', 12, 1);
  await scan(a, 'error', 0, 0);
  // At rest: the old session's time is far outside the period; received now-ish places it inside.
  await v2Finding(a, { rule: 'secrets.read_private_key', severity: 'high', at: ago(200 * DAY), receivedAt: ago(31 * MIN),
    repository: false, session: 'old-session', atRest: true });
  for (const outcome of ['requested', 'requested', 'requested', 'approved', 'denied'] as const) {
    await permission(a, outcome, session, ago(35 * MIN));
  }
  // Company B: its own small, distinct data.
  await inventory(b, ago(30 * MIN), [{ agent: 'gemini-cli', wired: 'yes' }]);
  await v2Finding(b, { rule: 'exec.download_pipe_shell', severity: 'high', at: ago(33 * MIN), repository: true, session: null });

  // Attesta: anchor, then the code period report, security seals and the security report.
  w.rekor.clock = Math.floor(Date.now() / 1000);
  for (const t of [a, b]) {
    const r = await runAnchorPass(db, { anchor: w.anchoring.anchor, now: () => new Date() }, { tenantId: t.tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
    check(r.tenantErrors === 0, `anchoring ${t.company.label}: ${JSON.stringify(r)}`);
  }
  const codeScope = { repository_id: a.repositoryId, from: ago(2 * 60 * MIN).toISOString(), to: ago(20 * MIN).toISOString() };
  const store = pgReportStore(db as unknown as ReportDatabase, { clock: () => new Date(t0 - 15 * MIN) });
  const { job } = await store.createOrGet({ tenantId: a.tenantId, idempotencyKey: `task19i-${randomUUID().slice(0, 8)}`,
    request: { scope: { ...codeScope, basis: 'recorded_at' } }, requestedBy: 'task19i-operator', requestId: `task19i-${randomUUID()}` });
  const reportResult = await runPeriodReport({ store, resolver: async () => w.resolver, builderVersion: () => BUILDER_VERSION, log: () => undefined },
    a.tenantId, job.id);
  check(reportResult === 'ready', `period report: ${reportResult}`);
  const codeDigest = (await pool.query(`select statement_digest from attesta_period_reports where tenant_id = $1 and id = $2`, [a.tenantId, job.id])).rows[0].statement_digest as string;
  for (const t of [a, b]) {
    const r = await runSecuritySealPass({ store: pgSecuritySealStore(db as unknown as SealDatabase), resolver: w.resolver,
      builderVersion: BUILDER_VERSION, actor: { type: 'system_operator', id: 'task19i-operator' }, log: () => undefined },
    { tenantIds: [t.tenantId], now: true });
    check(r.length >= 1 && r.every((x) => x.outcome === 'sealed'), `security seal ${t.company.label}: ${JSON.stringify(r.map((x) => x.outcome + (x.code ? `:${x.code}` : '')))}`);
  }
  const secScope = { from: ago(2 * 60 * MIN).toISOString(), to: ago(10 * MIN).toISOString() };
  const sec = await buildSecurityReport({ store: pgSecurityReportStore(db as unknown as SealDatabase), resolver: w.resolver,
    builderVersion: BUILDER_VERSION, actor: { type: 'system_operator', id: 'attesta:security-report:task19i-operator' }, log: () => undefined },
  { tenant_id: a.tenantId, repository_id: null, ...secScope, basis: 'received_at' });
  check(sec.outcome === 'built', `security report: ${sec.outcome} ${sec.code ?? ''}`);
  // Anchor the report records too, so the chain verify (Q7) checks every anchor.
  w.rekor.clock = Math.floor(Date.now() / 1000);
  const r2 = await runAnchorPass(db, { anchor: w.anchoring.anchor, now: () => new Date() }, { tenantId: a.tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
  check(r2.tenantErrors === 0, `anchoring reports: ${JSON.stringify(r2)}`);

  return {
    seededAt: new Date(t0).toISOString(),
    companyA: { tenantId: a.tenantId, repositoryId: a.repositoryId, repositoryName: a.repoName, pullRequestId: pr.rows[0].id, model: MODEL, tool: TOOL },
    companyB: { tenantId: b.tenantId, repositoryId: b.repositoryId },
    codeReport: { ...codeScope, statementDigest: codeDigest },
    securityReport: { ...secScope, statementDigest: sec.statementDigest ?? '' },
    expected: {
      permissionApproved: 1, permissionDenied: 1, permissionRequested: 3,
      machinesReporting: 1, agentsDetected: 3, agentsWired: 2,
      findingsInPeriod: 5, findingsPreviousPeriod: 1, highOrCriticalInReport: 4,
    },
    users: WALKTHROUGH_USERS,
    apiEnv: w.apiEnv,
  };
}

async function main(): Promise<void> {
  const [manifestPath, workDir] = process.argv.slice(2);
  check(manifestPath && workDir, 'usage: task19i-walkthrough-seed.ts <manifest.json> <work dir>');
  try {
    const manifest = await seedWalkthrough(resolve(workDir));
    writeFileSync(resolve(manifestPath), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log('IT-T19i-01 seed ok: Company A (merged AI PR, production deployment, Attesta statements, reports, Endpoint security) and Company B');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'IT-T19i-01 seed failed');
    process.exitCode = 1;
  });
}
