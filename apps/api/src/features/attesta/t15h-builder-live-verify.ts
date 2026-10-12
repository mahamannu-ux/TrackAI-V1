/**
 * IT-T15h-01…04: the Attesta builder worker against real PostgreSQL, from real Task2
 * ingestion to verified chains.
 *
 *   scripts/it-db.sh npm run verify:task15h-builder-live -w apps/api
 *
 * 01 end to end: a Git AI commit note, a merged one-commit PR with lineage, and a
 *    production deployment, each written by Task2's own code → three outbox rows →
 *    one pass → three chained statements whose envelopes verify; verifyChain with the
 *    dev key is ok; the PR statement's lineage names the commit statement and the
 *    deployment statement's `previous` names the PR statement; note and file digests
 *    match what Task2 stored.
 * 02 replay and crash: a second pass adds nothing; a second note for one commit signs
 *    only what each note proves (B1/B2); a worker killed after signing and
 *    before chaining leaves the row claimed, lease recovery re-runs it, one statement;
 *    a worker whose lease is taken over mid-flight gets CLAIM_LOST and chains nothing;
 *    two workers in parallel chain every row exactly once.
 * 03 failures: no credential → failed / ATTESTA_SIGNER_NO_CREDENTIAL; re-queue dry-run
 *    (CLI, no change), confirm (audit row) → done; SigningUnavailable → pending with
 *    backoff; the attesta:build CLI runs one pass.
 * 04 Company A/B: each tenant's rows build only from its own sources and chain only
 *    into its own ledger; a forged row in B pointing at A's commit fails SOURCE_MISSING.
 * Prints only safe summary lines (codes and counts).
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, pool } from '../../core/db';
import { recordDeployment, recordMergeLineage, recordPullRequestSnapshot } from '../scm/lifecycle-service';
import { upsertPullRequestObservation } from '../scm/scm.routes';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import type { GitHubCommit } from '../scm/github-app';
import { canonicalize, sha256Prefixed } from './canonical';
import { verifyEnvelope, type DsseEnvelope } from './dsse';
import { SigningUnavailable, type SigningAdapter } from './signer-contract';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver, type SignerResolver } from './signer-resolver';
import { verifyChain } from './verify-chain';
import { requeueFailedSubjects, runBuilderPass, type BuilderPassOptions } from './worker';
import { createHash } from 'node:crypto';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15h failed: ${message}`);
}

const KEY_PEM = generateDevCredential('dev:it', 'it').privateKeyPem;
const PUBLIC_KEY = createPublicKey(KEY_PEM);
const KEYID = sha256Prefixed(PUBLIC_KEY.export({ format: 'der', type: 'spki' }) as Buffer);
const KEYS = { [KEYID]: PUBLIC_KEY };
const RESOLVER = devSignerResolver({ sharedKeyPem: KEY_PEM });
const OPTIONS: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef' };
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface Tenant {
  label: string;
  tenantId: string;
  repoUrl: string;
  repositoryId: string;
  repositoryExternalId: string;
  commitSha: string;
  mergeSha: string;
}

function note(label: string): string {
  return [
    `src/${label}/alpha.ts`, '  s_it::t_1 1-6', '  h_dev 7-8',
    `src/${label}/beta.ts`, '  s_it::t_1 1-3',
    '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${label}`, model: 'model-x' } } } }),
  ].join('\n');
}

function commitEvent(t: Pick<Tenant, 'repoUrl' | 'label'>, commitSha: string, noteLabel = t.label): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 11, '3': ['opencode:model-x'], '5': [9], '11': 'IT synthetic commit', '13': note(noteLabel), '15': now - 60, '16': now - 30 },
    a: { '1': t.repoUrl, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${noteLabel}` },
  };
}

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15h-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, `${slug}.example`, slug],
  );
  return { label, tenantId, repoUrl: `https://github.com/${slug}/service`, repositoryId: '', repositoryExternalId: '', commitSha: sha(), mergeSha: sha() };
}

async function ingestCommit(t: Tenant, commitSha: string, noteLabel = t.label): Promise<void> {
  const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, commitSha, noteLabel)] });
  check(errors.length === 0, `${t.label}: commit ingestion failed`);
  if (!t.repositoryId) {
    const r = await pool.query(`select id::text as id, external_id from scm_repositories where tenant_id = $1`, [t.tenantId]);
    check(r.rows.length === 1, `${t.label}: one repository`);
    t.repositoryId = r.rows[0].id;
    t.repositoryExternalId = r.rows[0].external_id;
  }
}

function githubCommit(label: string, commitSha: string, parents: string[]): GitHubCommit {
  // GitHub reports the same git author the Git AI note carried.
  return {
    sha: commitSha,
    commit: { message: 'IT synthetic', author: { name: `IT Dev ${label}`, email: `it-dev-${label}@example.invalid`, date: new Date().toISOString() }, committer: { date: new Date().toISOString() } },
    parents: parents.map((p) => ({ sha: p })),
  };
}

async function insertDelivery(t: Tenant, deliveryId: string, eventType: string, rawEvent: Record<string, unknown>) {
  await pool.query(
    `insert into provider_event_deliveries (tenant_id, repository_id, provider, delivery_id, event_type, event_fingerprint, raw_event)
     values ($1, $2, 'github', $3, $4, $5, $6::jsonb)`,
    [t.tenantId, t.repositoryId, deliveryId, eventType, sha256Hex(deliveryId), JSON.stringify(rawEvent)],
  );
}

/** Task2's own writers for a commit note, a merged PR with lineage, and a production deployment. */
async function observeAll(t: Tenant): Promise<void> {
  await ingestCommit(t, t.commitSha);
  const deliveryId = randomUUID();
  const externalId = String(100_000 + Math.floor(Math.random() * 1e9));
  const mergedAt = new Date().toISOString();
  await insertDelivery(t, deliveryId, 'pr_closed', {
    action: 'closed', repository: { id: t.repositoryExternalId },
    pull_request: { id: externalId, merged_at: mergedAt, merge_commit_sha: t.mergeSha },
  });
  const pullRequestId = await db.transaction((tx) => upsertPullRequestObservation(tx, {
    eventType: 'pr_closed', tenantId: t.tenantId, repositoryId: t.repositoryId, provider: 'github', providerDeliveryId: deliveryId,
    pullRequest: {
      externalId, number: 7, title: 'IT synthetic PR', state: 'merged', authorEmail: null, authorProviderId: '4242',
      authorLogin: 'it-dev', headRef: 'feature', baseRef: 'main', headSha: t.commitSha, mergedAt, mergeCommitSha: t.mergeSha,
    },
  }));
  // Lineage enrichment (scm.routes.ts:416–470 runs these after the projection).
  await recordPullRequestSnapshot({ tenantId: t.tenantId, repositoryId: t.repositoryId, pullRequestId, headSha: t.commitSha, commits: [githubCommit(t.label, t.commitSha, [sha()])] });
  await recordMergeLineage({ tenantId: t.tenantId, repositoryId: t.repositoryId, pullRequestId, resultSha: t.mergeSha, resultCommit: githubCommit(t.label, t.mergeSha, [sha()]), mergedAt: new Date(mergedAt) });
  // The PR row waits five minutes by design; the test does not.
  await pool.query(`update attesta_subjects set not_before = now() where tenant_id = $1 and kind = 'pr_merged'`, [t.tenantId]);
  const deployDelivery = randomUUID();
  const deploymentExternalId = String(200_000 + Math.floor(Math.random() * 1e9));
  await insertDelivery(t, deployDelivery, 'deployment_status', {
    repository: { id: t.repositoryExternalId }, deployment: { id: deploymentExternalId, sha: t.mergeSha }, deployment_status: { state: 'success' },
  });
  await recordDeployment({
    tenantId: t.tenantId, repositoryId: t.repositoryId, provider: 'github', providerDeliveryId: deployDelivery,
    externalId: deploymentExternalId, environment: 'production', ref: 'main', sha: t.mergeSha, status: 'success',
    production: true, deployedAt: new Date(),
  });
}

interface RecordRow { seq: number; statement_kind: string; statement_digest: string; subject_sha: string; repository_id: string; statement_canonical: string; envelope: DsseEnvelope; outbox_subject_id: string }

async function records(tenantId: string): Promise<RecordRow[]> {
  const r = await pool.query(
    `select r.seq::int as seq, r.statement_kind, r.statement_digest, r.subject_sha, r.repository_id::text as repository_id,
       r.statement_canonical, e.envelope, r.outbox_subject_id::text as outbox_subject_id
     from attesta_records r join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
     where r.tenant_id = $1 order by r.seq`, [tenantId]);
  return r.rows;
}

async function outbox(tenantId: string) {
  return (await pool.query(
    `select id::text as id, kind, status, attempts, last_error_code, claimed_at is not null as claimed,
       extract(epoch from (not_before - now()))::float8 as wait_s
     from attesta_subjects where tenant_id = $1 order by created_at`, [tenantId])).rows;
}

async function chainOk(tenantId: string): Promise<void> {
  const report = await verifyChain(db, tenantId, { keys: KEYS });
  check(report.ok && report.signatures === 'checked' && report.breaks.length === 0, `chain of a tenant does not verify: ${report.breaks.map((b) => b.kind).join(',')}`);
}

const predicate = (r: RecordRow) => (JSON.parse(r.statement_canonical) as { predicate: Record<string, any> }).predicate;

/** One Task6 finding (the values of Task6's own unit test) on the commit's session string. */
async function seedFinding(t: Tenant, sessionString: string): Promise<void> {
  const machine = await pool.query(
    `insert into developer_machines (tenant_id, installation_id, display_name) values ($1, $2, 'it machine') returning id`,
    [t.tenantId, randomUUID()]);
  await pool.query(
    `insert into security_findings (tenant_id, machine_id, repository_id, finding_id, delivery_id, session_id, source_event_id,
       rule_id, rule_version, rule_category, rule_severity, route_id, agent_family, host_surface, host_mode, capture_channel,
       operating_system, timing, native_effect, activation, effect, phase, availability, completeness, result_category,
       occurred_at, client_version, rule_pack_version)
     values ($1, $2, $3, $4, $5, $6, 'event-001', 'trackai.exec.download_pipe_shell', '1.4', 'execution', 'high', 'AC-CLI-03',
       'opencode', 'terminal', 'cli', 'provider-plugin', 'linux', 'pre_action', 'observe_only', 'observed', 'monitor',
       'requested', 'available', 'complete', 'not_observed', now(), '0.1.0-test', '0.1.0-test')`,
    [t.tenantId, machine.rows[0].id, t.repositoryId, randomUUID(), randomUUID(), sessionString]);
}

async function it01(a: Tenant): Promise<void> {
  await observeAll(a);
  await seedFinding(a, `it-session-${a.label}`);
  const rows = await outbox(a.tenantId);
  check(rows.length === 3 && rows.every((r) => r.status === 'pending'), 'Task2 wrote three pending outbox rows');
  const pass = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(pass.failed === 0 && pass.retried === 0, `first pass failed rows: ${JSON.stringify(pass.codes)}`);
  const recs = await records(a.tenantId);
  check(recs.length === 3, 'three chained statements');
  const [commitRec, prRec, deployRec] = recs;
  check(commitRec.statement_kind === 'commit_observed' && prRec.statement_kind === 'pr_merged' && deployRec.statement_kind === 'deployed', 'chain order commit, PR, deployment');
  for (const rec of recs) {
    const v = verifyEnvelope(rec.envelope, KEYS);
    check(v.ok, 'an envelope does not verify');
    check(Buffer.from(rec.envelope.payload, 'base64').toString('utf8') === rec.statement_canonical, 'envelope payload is the stored statement');
    check(canonicalize(JSON.parse(rec.statement_canonical)) === rec.statement_canonical, 'stored statement is canonical');
  }
  await chainOk(a.tenantId);
  check((await outbox(a.tenantId)).every((r) => r.status === 'done'), 'every outbox row done');

  // Linkage: PR → commit through merge_lineage; deployment → PR through previous.
  const pr = predicate(prRec);
  check(pr.merge_lineage.availability === 'recorded' && pr.merge_lineage.value[0].source_statement_digest === commitRec.statement_digest, 'PR lineage names the commit statement');
  // A one-commit PR on a diverged base is recorded as rewritten_merge (lc inferMergeMethod).
  check(pr.merge_lineage.value[0].merge_method === 'rewritten_merge' && pr.merge_lineage.value[0].confidence === 60, 'lineage method and confidence from Task2');
  check(pr.sessions.availability === 'recorded' && pr.sessions.value.length === 1, 'PR carries the source commit session');
  check(pr.lifecycle.value.stage === 'merged' && pr.lifecycle.value.ai_lines === 9, 'merged AI lines from Task2 lifecycle');
  const dep = predicate(deployRec);
  check(dep.previous.length === 1 && dep.previous[0].digest === prRec.statement_digest && dep.previous[0].statement_kind === 'pr_merged', 'deployment previous names the PR statement');
  check(dep.lifecycle.value.stage === 'production' && dep.lifecycle.value.ai_lines === 9, 'production AI lines from Task2 lifecycle');
  check(dep.pull_request.availability === 'recorded' && dep.pull_request.value.id === pr.pull_request.value.id, 'deployment names the PR');

  // Independent oracle: the digests Task2's stored rows give.
  const c = predicate(commitRec);
  const stored = await pool.query(
    `select c.authorship_note, f.path, f.attribution_ranges, f.observed_ai_lines, f.observed_human_lines
     from scm_commits c join scm_commit_files f on f.tenant_id = c.tenant_id and f.commit_id = c.id
     where c.tenant_id = $1 and c.sha = $2`, [a.tenantId, a.commitSha]);
  check(stored.rows.length === 2, 'Task2 stored two files');
  check(c.source_evidence.note_digest.value.value === sha256Hex(stored.rows[0].authorship_note), 'note digest = SHA-256 of the stored note');
  for (const f of stored.rows) {
    const entry = c.files.value.entries.find((e: any) => e.path_sha256 === sha256Hex(f.path));
    check(entry, 'every stored file is in the statement');
    check(entry.attribution_ranges_sha256 === sha256Hex(canonicalize(f.attribution_ranges)), 'ranges digest = canonical stored ranges');
    check(entry.ai_lines === f.observed_ai_lines && entry.human_lines === f.observed_human_lines, 'file line counts match');
  }
  check(c.lines.value.ai === 9 && c.lines.value.human === 2 && c.files.value.total === 2, 'commit line totals');
  check(c.committer.availability === 'partial', 'committer matched to the contributor Task2 created');
  check(c.security_findings_observed.availability === 'partial' && c.security_findings_observed.value.total === 1
    && c.security_findings_observed.value.by_category.execution === 1 && c.security_findings_observed.value.by_severity.high === 1,
  'the finding on the commit session is counted (observed, monitor-only)');
  check(JSON.stringify(c.policy.rule_pack_versions.value) === '["0.1.0-test"]', 'rule pack of the counted finding');
  const url = await pool.query(`select normalized_url from scm_repositories where tenant_id = $1`, [a.tenantId]);
  check(c.repository.url_sha256.value === sha256Hex(url.rows[0].normalized_url), 'url digest = SHA-256 of the normalized URL');
  console.log('IT-T15h-01=passed');
}

async function it02(a: Tenant): Promise<void> {
  const before = (await records(a.tenantId)).length;
  const replay = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(replay.claimed === 0 && (await records(a.tenantId)).length === before, 'a second pass adds nothing');

  // Killed after signing, before chaining.
  await ingestCommit(a, sha());
  const crash = await runBuilderPass(db, RESOLVER, { ...OPTIONS, hooks: { afterSign: async () => { throw new Error('killed'); } } });
  check(crash.leftClaimed === 1, 'the crashed row stays claimed');
  const crashed = (await outbox(a.tenantId)).find((r) => r.status === 'claimed');
  check(crashed && (await records(a.tenantId)).length === before, 'nothing chained by the crashed worker');
  const notYet = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(notYet.recovered === 0 && notYet.claimed === 0, 'an unexpired claim is not recovered');
  const recovered = await runBuilderPass(db, RESOLVER, { ...OPTIONS, leaseMs: 0 });
  check(recovered.recovered === 1 && recovered.done === 1, 'lease recovery re-ran the row');
  const once = await pool.query(`select count(*)::int as n from attesta_records where tenant_id = $1 and outbox_subject_id = $2`, [a.tenantId, crashed.id]);
  check(once.rows[0].n === 1, 'exactly one statement for the crashed row');

  // A worker whose lease is taken over mid-flight chains nothing.
  await ingestCommit(a, sha());
  let inner: Awaited<ReturnType<typeof runBuilderPass>> | null = null;
  const slow = await runBuilderPass(db, RESOLVER, {
    ...OPTIONS,
    hooks: { afterSign: async () => { if (!inner) inner = await runBuilderPass(db, RESOLVER, { ...OPTIONS, leaseMs: 0 }); } },
  });
  check(inner !== null && (inner as { done: number }).done === 1, 'the second worker took over and chained');
  check(slow.claimLost === 1 && slow.done === 0, `the first worker got CLAIM_LOST: ${JSON.stringify(slow.codes)}`);

  // A second note for the same commit (B1/B2): the first statement keeps only what its
  // own note proves; the second reports only the second note's session, although Task2
  // keeps both sessions' rows on the commit.
  const twice = sha();
  await ingestCommit(a, twice, 'note-one');
  await ingestCommit(a, twice, 'note-two');
  const both = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(both.done === 2, `two notes, two statements: ${JSON.stringify(both.codes)}`);
  const stmts = (await records(a.tenantId)).filter((r) => r.subject_sha === twice).map(predicate);
  check(stmts.length === 2 && stmts[1].previous.length === 1, 'the second statement links the first');
  check(stmts[0].sessions.availability === 'unavailable' && stmts[0].files.availability === 'recorded'
    && stmts[0].source_evidence.note_digest.value.value !== stmts[1].source_evidence.note_digest.value.value,
  'the overwritten observation keeps its own note and files, nothing else');
  const sessionTwo = await pool.query(`select id::text as id from ai_sessions where tenant_id = $1 and external_session_id = 'it-session-note-two'`, [a.tenantId]);
  const kept = await pool.query(
    `select count(*)::int as n from ai_commit_sessions cs join scm_commits c on c.id = cs.commit_id and c.tenant_id = cs.tenant_id
     where cs.tenant_id = $1 and c.sha = $2`, [a.tenantId, twice]);
  check(kept.rows[0].n === 2, 'Task2 kept both notes\' session rows on the commit');
  check(stmts[1].sessions.value.length === 1 && stmts[1].sessions.value[0].session_id === sessionTwo.rows[0].id
    && stmts[1].models.value.every((m: any) => m.session_id === sessionTwo.rows[0].id),
  'the second statement reports only its own note\'s session and models');

  // Two workers in parallel.
  for (let i = 0; i < 6; i += 1) await ingestCommit(a, sha());
  // Three rows each, so both workers hold claims and chain into one tenant at once.
  const [w1, w2] = await Promise.all([
    runBuilderPass(db, RESOLVER, { ...OPTIONS, limit: 3 }), runBuilderPass(db, RESOLVER, { ...OPTIONS, limit: 3 }),
  ]);
  check(w1.claimed === 3 && w2.claimed === 3, `SKIP LOCKED gave each worker its own rows: ${w1.claimed}/${w2.claimed} ${JSON.stringify([w1.codes, w2.codes])}`);
  check(w1.done + w2.done === 6 && w1.failed + w2.failed === 0, `parallel workers chained ${w1.done}+${w2.done}`);
  const dup = await pool.query(
    `select count(*)::int as n, count(distinct outbox_subject_id)::int as d from attesta_records where tenant_id = $1`, [a.tenantId]);
  check(dup.rows[0].n === dup.rows[0].d, 'no outbox row chained twice');
  check((await outbox(a.tenantId)).every((r) => r.status === 'done'), 'every row done');
  await chainOk(a.tenantId);
  console.log('IT-T15h-02=passed');
  console.log(`parallel_split=${Math.min(w1.done, w2.done)}/${Math.max(w1.done, w2.done)}`);
}

function runCli(script: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ['--import', 'tsx', join(__dirname, script), ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

async function it03(): Promise<void> {
  const t = await seedTenant('failures');
  await ingestCommit(t, t.commitSha);
  const none: SignerResolver = { resolve: async () => null };
  const failed = await runBuilderPass(db, none, OPTIONS);
  check(failed.failed === 1 && failed.codes.ATTESTA_SIGNER_NO_CREDENTIAL === 1, 'no credential fails the row');
  let rows = await outbox(t.tenantId);
  check(rows[0].status === 'failed' && rows[0].last_error_code === 'ATTESTA_SIGNER_NO_CREDENTIAL', 'row failed with the code');
  check((await runBuilderPass(db, RESOLVER, OPTIONS)).claimed === 0, 'a failed row is not retried by itself');

  // Re-queue: dry-run through the CLI changes nothing and audits nothing.
  const dry = runCli('attesta-requeue-cli.ts', ['--tenant', t.tenantId, '--code', 'ATTESTA_SIGNER_NO_CREDENTIAL', '--actor', 'it-t15h'], {});
  check(dry.includes('mode=dry-run') && dry.includes('matched_failed_rows=1') && dry.includes('requeued_rows=0'), 'CLI dry-run counted one row');
  const audits = async () => (await pool.query(
    `select actor_id, action, details from security_audit_events where tenant_id = $1 and action = 'attesta_subjects.requeued'`, [t.tenantId])).rows;
  check((await audits()).length === 0 && (await outbox(t.tenantId))[0].status === 'failed', 'dry-run changed nothing');
  check(dry.includes('next=rerun with --confirm=REQUEUE --expect=1'), 'dry-run names the count to confirm');
  // A confirm with a stale count changes nothing.
  const stale = await requeueFailedSubjects(db, { tenantId: t.tenantId, code: 'ATTESTA_SIGNER_NO_CREDENTIAL', actorId: 'it-t15h', confirm: true, expect: 2 })
    .then(() => 'applied', (err: Error) => err.name);
  check(stale === 'RequeueScopeChanged' && (await audits()).length === 0 && (await outbox(t.tenantId))[0].status === 'failed', 'a stale confirm changed nothing');
  const applied = runCli('attesta-requeue-cli.ts', ['--tenant', t.tenantId, '--code', 'ATTESTA_SIGNER_NO_CREDENTIAL', '--actor', 'it-t15h', '--confirm=REQUEUE', '--expect=1'], {});
  check(applied.includes('mode=apply') && applied.includes('requeued_rows=1'), 'CLI confirm re-queued the row');
  const audit = await audits();
  check(audit.length === 1 && audit[0].actor_id === 'it-t15h' && audit[0].details.code === 'ATTESTA_SIGNER_NO_CREDENTIAL' && audit[0].details.count === 1
    && Object.keys(audit[0].details).sort().join(',') === 'code,count', 'one audit row: actor, code, count only');
  rows = await outbox(t.tenantId);
  check(rows[0].status === 'pending' && rows[0].attempts === 1, 'pending again, attempts kept');
  const ok = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(ok.done === 1 && (await outbox(t.tenantId))[0].status === 'done', 'the re-queued row is chained');

  // SigningUnavailable → pending with backoff.
  await ingestCommit(t, sha());
  const adapter: SigningAdapter = {
    capabilities: () => ({ adapterName: 'it-down', algorithms: ['ES256'], maxPayloadBytes: 1_048_576, supportsCredentialListing: false }),
    sign: async () => { throw new SigningUnavailable('kms down'); },
    listCredentials: async () => [],
    publicKey: async () => { throw new SigningUnavailable('kms down'); },
    health: async () => false,
  };
  const down = await runBuilderPass(db, { resolve: async () => ({ adapter, credentialId: 'kms:it' }) }, OPTIONS);
  check(down.retried === 1, 'unavailable signer retried');
  const waiting = (await outbox(t.tenantId)).find((r) => r.status === 'pending');
  check(waiting && waiting.last_error_code === 'ATTESTA_SIGNER_UNAVAILABLE' && !waiting.claimed && waiting.wait_s > 25 && waiting.wait_s <= 30, 'pending with a 30 s backoff');

  // The build CLI runs one pass (the waiting row is not due yet, so it claims nothing).
  const dir = mkdtempSync(join(tmpdir(), 'it-t15h-'));
  try {
    const keyFile = join(dir, 'dev-key.pem');
    writeFileSync(keyFile, KEY_PEM, { mode: 0o600 });
    const out = runCli('attesta-build-cli.ts', [], { ATTESTA_DEV_SIGNER_KEY_FILE: keyFile, TRACKAI_GIT_COMMIT: '0123456789abcdef' });
    check(out.includes(`dev_keyid=${KEYID}`) && out.includes('attesta_build_pass') && out.includes('failed=0'), 'build CLI ran one pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await chainOk(t.tenantId);
  console.log('IT-T15h-03=passed');
}

async function it04(a: Tenant, b: Tenant): Promise<void> {
  await observeAll(b);
  // A forged pointer in B naming A's commit and event (the writer would refuse it).
  const aRow = (await pool.query(
    `select metric_event_id::text as m, commit_id::text as c from attesta_subjects where tenant_id = $1 and kind = 'commit_observed' order by created_at limit 1`,
    [a.tenantId])).rows[0];
  await pool.query(
    `insert into attesta_subjects (tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, event_at)
     values ($1, $2, 'commit_observed', $3, $4, $5, now())`,
    [b.tenantId, b.repositoryId, aRow.m, aRow.c, a.commitSha]);
  const pass = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(pass.done === 3 && pass.failed === 1 && pass.codes.ATTESTA_BUILDER_SOURCE_MISSING === 1, `B built its three rows and refused the forged one: ${JSON.stringify(pass.codes)}`);
  for (const [own, other] of [[a, b], [b, a]] as const) {
    const recs = await records(own.tenantId);
    check(recs.length > 0 && recs[0].seq === 0, `${own.label}: chain starts at 0`);
    check(recs.every((r) => r.repository_id === own.repositoryId), `${own.label}: every statement is about its own repository`);
    check(!recs.some((r) => r.statement_canonical.includes(other.repositoryId) || r.statement_canonical.includes(other.tenantId)), `${own.label}: no statement names the other tenant`);
    const foreign = await pool.query(
      `select count(*)::int as n from attesta_records r join attesta_subjects s on s.id = r.outbox_subject_id
       where r.tenant_id = $1 and s.tenant_id <> $1`, [own.tenantId]);
    check(foreign.rows[0].n === 0, `${own.label}: chained only its own outbox rows`);
    await chainOk(own.tenantId);
  }
  const bRecs = await records(b.tenantId);
  check(bRecs.length === 3, 'B has exactly its three statements');
  const bPr = predicate(bRecs[1]);
  check(bPr.merge_lineage.value[0].source_statement_digest === bRecs[0].statement_digest, 'B links to its own commit statement');
  console.log('IT-T15h-04=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  try {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await it01(a);
    await it02(a);
    await it03();
    await it04(a, b);
    console.log(`statements_company_a=${(await records(a.tenantId)).length}`);
    console.log(`statements_company_b=${(await records(b.tenantId)).length}`);
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15h failed');
  process.exitCode = 1;
});
