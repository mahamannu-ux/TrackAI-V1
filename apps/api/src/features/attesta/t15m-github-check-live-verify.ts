/**
 * IT-T15m-01…02: the GitHub check pass against real PostgreSQL, through the
 * real Task2 ingestion, builder and anchoring passes, with a fake GitHub (an
 * in-process stand-in passed through `deps`; no real GitHub):
 *
 *   scripts/it-db.sh npm run verify:task15m-github-check-live -w apps/api
 *
 * 01 an open PR with three member commits of which two are built → the pass
 *    posts one check titled "2 of 3 commits attested · …"; a second pass is
 *    `unchanged`; after the anchoring pass it is `updated`.
 * 02 Company A/B: tenant B's pass posts nothing about A's PRs, and A's check
 *    counts only A's records.
 * Prints only safe summary lines (counts and titles, never shas).
 */
import { createPublicKey, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, pool } from '../../core/db';
import type { GitHubCommit } from '../scm/github-app';
import { recordPullRequestSnapshot } from '../scm/lifecycle-service';
import { upsertPullRequestObservation } from '../scm/scm.routes';
import { ingestMetricsBatch } from '../telemetry/service';
import type { GitAiMetricEvent } from '../telemetry/types';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { anchorFromEnv } from './anchor-env';
import { runAnchorPass } from './anchor-worker';
import {
  runGithubCheckPass,
  type CheckDeps,
  type CheckRunPayload,
} from './github-check';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver } from './signer-resolver';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { runBuilderPass, type BuilderPassOptions } from './worker';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T15m failed: ${message}`);
}

const RESOLVER = devSignerResolver({ sharedKeyPem: generateDevCredential('dev:it', 'it').privateKeyPem });
const OPTIONS: BuilderPassOptions = { limit: 50, maxAttempts: 5, builderVersion: '0.1.0+0123456789abcdef' };
const sha = () => randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);

interface Tenant {
  label: string; tenantId: string; repoUrl: string; repositoryId: string;
}

function note(label: string): string {
  return [`src/${label}/alpha.ts`, '  s_it::t_1 1-6', '  h_dev 7-8', '---',
    JSON.stringify({ sessions: { s_it: { agent_id: { tool: 'opencode', id: `it-session-${label}`, model: 'model-x' } } } })].join('\n');
}

function commitEvent(t: Tenant, commitSha: string): GitAiMetricEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    t: now, e: 1,
    v: { '0': 2, '1': 0, '2': 8, '3': ['opencode:model-x'], '5': [6], '11': 'IT synthetic commit', '13': note(t.label), '15': now - 60, '16': now - 30 },
    a: { '1': t.repoUrl, '2': `IT Dev ${t.label} <it-dev-${t.label}@example.invalid>`, '3': commitSha, '5': 'main', '20': 'opencode', '21': 'model-x', '23': `it-session-${t.label}` },
  };
}

async function seedTenant(label: string): Promise<Tenant> {
  const tenantId = randomUUID();
  const slug = `it-t15m-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(`insert into sso_tenants (id, company_name, domain, supabase_provider_id) values ($1, $2, $3, $4)`,
    [tenantId, `IT ${label}`, `${slug}.example`, slug]);
  return { label, tenantId, repoUrl: `https://github.com/${slug}/service`, repositoryId: '' };
}

async function ingestCommit(t: Tenant, commitSha: string): Promise<void> {
  const errors = await ingestMetricsBatch(t.tenantId, { v: 1, events: [commitEvent(t, commitSha)] });
  check(errors.length === 0, `${t.label}: commit ingestion failed`);
  if (!t.repositoryId) {
    const r = await pool.query(`select id::text as id from scm_repositories where tenant_id = $1`, [t.tenantId]);
    t.repositoryId = r.rows[0].id;
  }
}

function githubCommit(label: string, commitSha: string): GitHubCommit {
  return {
    sha: commitSha,
    commit: { message: 'IT synthetic', author: { name: `IT Dev ${label}`, email: `it-dev-${label}@example.invalid`, date: new Date().toISOString() }, committer: { date: new Date().toISOString() } },
    parents: [{ sha: sha() }],
  };
}

async function openPrWithCommits(t: Tenant, shas: string[]): Promise<void> {
  const headSha = shas[shas.length - 1];
  const pullRequestId = await db.transaction((tx) => upsertPullRequestObservation(tx, {
    eventType: 'pr_opened', tenantId: t.tenantId, repositoryId: t.repositoryId, provider: 'github',
    providerDeliveryId: randomUUID(),
    pullRequest: {
      externalId: String(300_000 + Math.floor(Math.random() * 1e9)), number: 8, title: 'IT open PR', state: 'open',
      authorEmail: null, authorProviderId: '4242', authorLogin: 'it-dev',
      headRef: 'feature', baseRef: 'main', headSha, mergedAt: null, mergeCommitSha: null,
    },
  }));
  await recordPullRequestSnapshot({
    tenantId: t.tenantId, repositoryId: t.repositoryId, pullRequestId, headSha,
    commits: shas.map((s) => githubCommit(t.label, s)),
  });
}

async function build(): Promise<void> {
  const pass = await runBuilderPass(db, RESOLVER, OPTIONS);
  check(pass.failed === 0 && pass.retried === 0, `builder pass: ${JSON.stringify(pass.codes)}`);
}

async function anchoringEnv() {
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000);
  const tsa = await FakeTsa.create();
  const dir = mkdtempSync(join(tmpdir(), 'it-t15m-anchor-'));
  const cred = generateDevCredential('dev:it-anchor', ATTESTA_PLATFORM_TENANT_ID);
  const file = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body, { mode: 0o600 });
    return p;
  };
  const env = await anchorFromEnv({
    ...process.env,
    ATTESTA_ANCHOR_CREDENTIAL_ID: cred.credentialId,
    ATTESTA_DEV_ANCHOR_KEY_FILE: file('anchor.pem', cred.privateKeyPem),
    ATTESTA_REKOR_URL: 'http://rekor.test',
    ATTESTA_REKOR_LOG_KEY_FILE: file('rekor.pem', createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString()),
    ATTESTA_TSA_URL: TSA_URL,
    ATTESTA_TSA_ANCHORS_FILE: file('tsa.pem', tsa.anchorsPem),
  }, { rekorFetch: rekor.fetch, tsaFetch: tsa.fetch });
  return {
    dir,
    pass: async (tenantId: string) => {
      const r = await runAnchorPass(db, { anchor: env.anchor, now: () => new Date() }, { tenantId, partialAfterMs: 0, maxBatchesPerTenant: 100 });
      check(r.tenantErrors === 0, 'anchoring pass');
      return r;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake GitHub: an in-process check-runs store behind the deps seam.

interface FakeRun { id: number; external_id: string; output: { title: string; summary: string } }

class FakeGitHub {
  writes: Array<{ method: string; path: string; body: CheckRunPayload }> = [];
  runs = new Map<string, FakeRun[]>();
  nextId = 1;

  get deps(): CheckDeps {
    return {
      env: {},
      getStatus: (async (path: string) => {
        const sha = decodeURIComponent(path.split('/commits/')[1].split('/')[0]);
        return { status: 200, data: { check_runs: this.runs.get(sha) ?? [] } };
      }) as CheckDeps['getStatus'],
      write: (async (method: 'POST' | 'PATCH', path: string, body: unknown) => {
        const payload = body as CheckRunPayload;
        this.writes.push({ method, path, body: payload });
        if (method === 'POST') {
          const run = {
            id: this.nextId++, external_id: payload.external_id,
            output: { title: payload.output.title, summary: payload.output.summary },
          };
          const list = this.runs.get(payload.head_sha) ?? [];
          list.push(run);
          this.runs.set(payload.head_sha, list);
          return { status: 201, data: { id: run.id } };
        }
        const id = Number(path.split('/').pop());
        for (const list of this.runs.values()) {
          const run = list.find((r) => r.id === id);
          if (run) {
            run.output.title = payload.output.title;
            run.output.summary = payload.output.summary;
            return { status: 200, data: { id } };
          }
        }
        return { status: 404, data: null };
      }) as CheckDeps['write'],
    };
  }

  bodies(): string[] {
    return this.writes.map((w) => JSON.stringify(w.body));
  }
}

// ---------------------------------------------------------------------------

async function it01(anchors: { pass(t: string): Promise<unknown> }, a: Tenant): Promise<void> {
  const c1 = sha();
  const c2 = sha();
  const c3 = sha();
  await ingestCommit(a, c1);
  await ingestCommit(a, c2);
  await build();
  await openPrWithCommits(a, [c1, c2, c3]);
  const fake = new FakeGitHub();

  const first = await runGithubCheckPass(pool, fake.deps, { tenantId: a.tenantId, now: new Date() });
  check(first.prs === 1 && first.created === 1, `first pass posts one check: ${JSON.stringify(first)}`);
  const title1 = (fake.writes[0].body as CheckRunPayload).output.title;
  check(title1 === '2 of 3 commits attested · 0 anchored', `open title before anchoring: ${title1}`);

  const second = await runGithubCheckPass(pool, fake.deps, { tenantId: a.tenantId, now: new Date() });
  check(second.unchanged === 1 && second.created === 0 && second.updated === 0, 'second pass is unchanged');

  await anchors.pass(a.tenantId);
  const third = await runGithubCheckPass(pool, fake.deps, { tenantId: a.tenantId, now: new Date() });
  check(third.updated === 1, `after anchoring the check is updated: ${JSON.stringify(third)}`);
  const title3 = (fake.writes[fake.writes.length - 1].body as CheckRunPayload).output.title;
  check(title3 === '2 of 3 commits attested · 2 anchored', `open title after anchoring: ${title3}`);
  console.log('IT-T15m-01=passed');
}

async function it02(anchors: { pass(t: string): Promise<unknown> }, a: Tenant, b: Tenant): Promise<void> {
  const cb = sha();
  await ingestCommit(b, cb);
  await build();
  await openPrWithCommits(b, [cb]);
  await anchors.pass(b.tenantId);

  const fakeB = new FakeGitHub();
  const passB = await runGithubCheckPass(pool, fakeB.deps, { tenantId: b.tenantId, now: new Date() });
  check(passB.prs === 1 && passB.created === 1, `B posts one check: ${JSON.stringify(passB)}`);
  const bTitle = (fakeB.writes[0].body as CheckRunPayload).output.title;
  check(bTitle === '1 of 1 commits attested · 1 anchored', `B title: ${bTitle}`);

  const aShas = (await pool.query(
    `select sha from scm_commits where tenant_id = $1`, [a.tenantId])).rows.map((r) => r.sha as string);
  for (const body of fakeB.bodies()) {
    for (const s of aShas) check(!body.includes((s as string).slice(0, 7)), "nothing of A in B's check");
  }
  const fakeA = new FakeGitHub();
  const passA = await runGithubCheckPass(pool, fakeA.deps, { tenantId: a.tenantId, now: new Date() });
  check(passA.prs === 1, "A's pass sees only A's PR");
  const aTitle = (fakeA.writes[0].body as CheckRunPayload).output.title;
  check(aTitle === '2 of 3 commits attested · 2 anchored', `A counts only A: ${aTitle}`);
  check(!fakeA.bodies().some((body) => body.includes(cb.slice(0, 7))), "nothing of B in A's check");
  console.log('IT-T15m-02=passed');
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  check(['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname), 'a local disposable database is required');
  const anchors = await anchoringEnv();
  try {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await it01(anchors, a);
    await it02(anchors, a, b);
    const counts = await pool.query(
      `select (select count(*)::int from attesta_records where tenant_id = $1) as a,
              (select count(*)::int from attesta_records where tenant_id = $2) as b`,
      [a.tenantId, b.tenantId]);
    console.log(`statements_company_a=${counts.rows[0].a} statements_company_b=${counts.rows[0].b}`);
  } finally {
    rmSync(anchors.dir, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'IT-T15m failed');
  process.exitCode = 1;
});
