// Task15m (A15.14): the informational GitHub check — payload wording, idempotent
// post, result codes, privacy and tenant binding. No network, no database: a
// memory executor answers the module's SQL shapes and a fake GitHub records
// the check-run calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attestationFacts,
  checkRunPayload,
  postCheck,
  runGithubCheckPass,
  selectPullRequests,
  type AttestationFacts,
  type CheckDb,
  type CheckDeps,
  type CheckRunPayload,
  type PullRequestRow,
} from './github-check';
import { githubWrite } from '../scm/github-app';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const RECENT = '2026-10-14T11:59:00.000000Z';
const OLD = '2020-01-01T00:00:00.000000Z';
const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const REPO = '11111111-1111-4111-8111-111111111111';
const sha = (c: string) => c.repeat(40);

// ---------------------------------------------------------------------------
// Memory executor: answers the module's four query shapes from plain arrays.

interface MemPr {
  id: string; tenantId: string; repositoryId: string;
  headSha: string | null; mergeCommitSha: string | null; state: string;
  mergedAt: string | null; updatedAt: string;
}

class FakeDb implements CheckDb {
  calls: Array<{ text: string; params: unknown[] }> = [];
  repos: Array<{ id: string; tenantId: string; provider: string; url: string }> = [];
  prs: MemPr[] = [];
  commits: Array<{ id: string; tenantId: string; sha: string }> = [];
  memberships: Array<{ prId: string; tenantId: string; commitId: string; active: boolean }> = [];
  records: Array<{
    tenantId: string; repositoryId: string; subjectSha: string; kind: string;
    recordedAt: string; rekor: boolean; tsa: boolean;
  }> = [];
  // Columns the module must never select (Task15h lesson).
  titles = new Map<string, string>();
  authors = new Map<string, string>();
  subjects = new Map<string, string>();

  async query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ text, params });
    if (text.includes('github-check prs')) {
      const [tenantId, weekAgo, limit] = params as [string, string, number];
      const rows = this.prs
        .filter((p) => p.tenantId === tenantId
          && this.repos.some((r) => r.id === p.repositoryId && r.tenantId === tenantId && r.provider === 'github')
          && ((p.state === 'open' && p.headSha !== null)
            || (p.mergedAt !== null && p.mergedAt >= weekAgo && p.mergeCommitSha !== null)))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, limit)
        .map((p) => {
          const repo = this.repos.find((r) => r.id === p.repositoryId)!;
          return {
            id: p.id, repository_id: p.repositoryId, head_sha: p.headSha,
            merge_commit_sha: p.mergeCommitSha, state: p.state, merged_at: p.mergedAt,
            updated_at: p.updatedAt, repo_url: repo.url, repo_provider: repo.provider,
          } as Record<string, unknown>;
        });
      return { rows };
    }
    if (text.includes('github-check members')) {
      const [tenantId, prId] = params as [string, string];
      const rows = this.memberships
        .filter((m) => m.tenantId === tenantId && m.prId === prId && m.active)
        .map((m) => ({ sha: this.commits.find((c) => c.id === m.commitId)!.sha }));
      return { rows };
    }
    if (text.includes('github-check records')) {
      const [tenantId, repositoryId, kind, shas] = params as [string, string, string, string[]];
      const rows = this.records
        .filter((r) => r.tenantId === tenantId && r.repositoryId === repositoryId
          && r.kind === kind && shas.includes(r.subjectSha))
        .map((r) => ({
          subject_sha: r.subjectSha, recorded_at: r.recordedAt,
          rekor_anchored: r.rekor, tsa_anchored: r.tsa,
        }));
      return { rows };
    }
    if (text.includes('github-check tenants')) {
      return { rows: [...new Set(this.repos.map((r) => r.tenantId))].map((t) => ({ tenant_id: t })) };
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  }
}

function openPr(over: Partial<MemPr> = {}): MemPr {
  return {
    id: 'pr-1', tenantId: A, repositoryId: REPO, headSha: sha('d'), mergeCommitSha: null,
    state: 'open', mergedAt: null, updatedAt: '2026-10-14T11:00:00.000Z', ...over,
  };
}

function seedOpen(db: FakeDb, pr: MemPr, shas: string[]): PullRequestRow {
  db.repos.push({ id: pr.repositoryId, tenantId: pr.tenantId, provider: 'github', url: 'https://github.com/acme/service' });
  db.prs.push(pr);
  shas.forEach((s, i) => {
    const id = `commit-${i}`;
    db.commits.push({ id, tenantId: pr.tenantId, sha: s });
    db.memberships.push({ prId: pr.id, tenantId: pr.tenantId, commitId: id, active: true });
  });
  return {
    id: pr.id, repositoryId: pr.repositoryId, headSha: pr.headSha, mergeCommitSha: pr.mergeCommitSha,
    state: pr.state, mergedAt: pr.mergedAt, updatedAt: pr.updatedAt,
    repoUrl: 'https://github.com/acme/service', repoProvider: 'github',
  };
}

// ---------------------------------------------------------------------------
// Fake GitHub: an in-memory check-runs store behind the deps seam.

interface FakeRun { id: number; external_id: string; output: { title: string; summary: string } }

class FakeGitHub {
  requests: Array<{ method: string; path: string; body: unknown }> = [];
  runs = new Map<string, FakeRun[]>();
  nextId = 101;
  writeImpl: CheckDeps['write'] | null = null;
  getStatusImpl: CheckDeps['getStatus'] | null = null;

  get deps(): CheckDeps {
    return {
      env: {},
      getStatus: (async (path: string, tenantId: string, owner: string) => {
        if (this.getStatusImpl) return this.getStatusImpl(path, tenantId, owner);
        const sha = decodeURIComponent(path.split('/commits/')[1].split('/')[0]);
        return { status: 200, data: { check_runs: this.runs.get(sha) ?? [] } };
      }) as CheckDeps['getStatus'],
      write: (async (method: 'POST' | 'PATCH', path: string, body: unknown, tenantId: string, owner: string) => {
        if (this.writeImpl) return this.writeImpl(method, path, body, tenantId, owner);
        this.requests.push({ method, path, body });
        const payload = body as CheckRunPayload;
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
}

function factsFor(f: Partial<AttestationFacts>): AttestationFacts {
  return {
    kind: 'open', prId: 'pr-1', repositoryId: REPO, sha: sha('d'), commits: [], merge: null,
    attested: 0, anchored: 0, pending: 0, overdue: 0, unattested: 0, ...f,
  };
}

// ---------------------------------------------------------------------------
// 1. Payload: an open PR with anchored, pending and unattested commits.

test('payload: open PR counts, neutral conclusion and ordered table', async () => {
  const db = new FakeDb();
  const [aSha, bSha, cSha] = [sha('a'), sha('b'), sha('c')];
  const row = seedOpen(db, openPr(), [aSha, bSha, cSha]);
  db.records.push(
    { tenantId: A, repositoryId: REPO, subjectSha: aSha, kind: 'commit_observed', recordedAt: RECENT, rekor: true, tsa: true },
    { tenantId: A, repositoryId: REPO, subjectSha: bSha, kind: 'commit_observed', recordedAt: RECENT, rekor: true, tsa: false },
  );
  const facts = await attestationFacts(db, A, row, sha('d'), NOW);
  assert.deepEqual(
    [facts.attested, facts.anchored, facts.pending, facts.overdue, facts.unattested],
    [2, 1, 1, 0, 1],
  );
  const payload = checkRunPayload(facts, {}, NOW);
  assert.equal(payload.name, 'TrackAI Attesta');
  assert.equal(payload.conclusion, 'neutral');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output.title, '2 of 3 commits attested · 1 anchored');
  const [head, blank, counts] = payload.output.summary.split('\n');
  assert.equal(head, 'Informational: TrackAI records which commits it has signed and anchored. This check never blocks a merge.');
  assert.equal(blank, '');
  assert.equal(counts, 'Attested: 2 · Anchored: 1 · Anchoring pending: 1 · Anchor overdue: 0 · Not attested yet: 1');
  assert.deepEqual(payload.output.text.split('\n'), [
    '| Commit | State |',
    '| --- | --- |',
    '| aaaaaaa | Signed · anchored |',
    '| bbbbbbb | Signed · anchoring pending |',
    '| ccccccc | Not attested yet |',
  ]);
  assert.ok(!('details_url' in payload));
  const withConsole = checkRunPayload(facts, { TRACKAI_CONSOLE_URL: 'https://console.example/' }, NOW);
  assert.equal(withConsole.details_url, 'https://console.example/dashboard');
});

// ---------------------------------------------------------------------------
// 2. Payload: merged states and the empty open PR.

test('payload: merged titles and the empty open PR', () => {
  const merge = (merge: AttestationFacts['merge']) =>
    checkRunPayload(factsFor({ kind: 'merged', merge }), {}, NOW).output.title;
  assert.equal(merge({ hasRecord: true, status: 'anchored' }), 'Merge attested · anchored');
  assert.equal(merge({ hasRecord: true, status: 'pending' }), 'Merge attested · anchoring pending');
  assert.equal(merge({ hasRecord: true, status: 'missing' }), 'Merge attested · anchor overdue');
  assert.equal(merge({ hasRecord: false, status: 'missing' }), 'Merge not attested yet');
  assert.equal(
    checkRunPayload(factsFor({ commits: [] }), {}, NOW).output.title,
    'No commits observed yet',
  );
  const overdue = checkRunPayload(
    factsFor({
      commits: [{ sha: sha('e'), hasRecord: true, status: 'missing' }],
      attested: 1, overdue: 1,
    }),
    {},
    NOW,
  );
  assert.ok(overdue.output.text.includes('| eeeeeee | Signed · anchor overdue |'));
});

// ---------------------------------------------------------------------------
// 3. Payload: the table holds 50 rows, then the overflow line; limits hold.

test('payload: 120 commits give 50 rows then the overflow line', async () => {
  const db = new FakeDb();
  const shas = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(40, '0'));
  const row = seedOpen(db, openPr(), shas);
  for (const s of shas) {
    db.records.push({
      tenantId: A, repositoryId: REPO, subjectSha: s, kind: 'commit_observed',
      recordedAt: RECENT, rekor: true, tsa: true,
    });
  }
  const facts = await attestationFacts(db, A, row, sha('d'), NOW);
  const payload = checkRunPayload(facts, {}, NOW);
  const lines = payload.output.text.split('\n');
  assert.equal(lines.length, 2 + 50 + 1);
  assert.equal(lines[lines.length - 1], '… and 70 more');
  assert.ok(payload.output.title.length <= 255);
  assert.ok(payload.output.summary.length <= 60_000);
  assert.ok(payload.output.text.length <= 60_000);
});

// ---------------------------------------------------------------------------
// 4. Post: create, unchanged, update; another app's run is ignored.

test('post: create, unchanged, update and foreign runs', async () => {
  const fake = new FakeGitHub();
  const base = factsFor({
    commits: [{ sha: sha('a'), hasRecord: true, status: 'anchored' }],
    attested: 1, anchored: 1,
  });
  const first = checkRunPayload(base, {}, NOW);
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', first), 'created');
  assert.equal(fake.requests.length, 1);
  assert.deepEqual(fake.requests[0], {
    method: 'POST', path: '/repos/acme/service/check-runs', body: first,
  });
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', first), 'unchanged');
  assert.equal(fake.requests.length, 1);

  const changed = checkRunPayload(
    factsFor({
      commits: [
        { sha: sha('a'), hasRecord: true, status: 'anchored' },
        { sha: sha('b'), hasRecord: false, status: 'missing' },
      ],
      attested: 1, anchored: 1, unattested: 1,
    }),
    {},
    NOW,
  );
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', changed), 'updated');
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].method, 'PATCH');
  assert.match(fake.requests[1].path, /\/repos\/acme\/service\/check-runs\/\d+$/);

  // A run from another app (another external_id) does not satisfy the check.
  const other: FakeRun = {
    id: 999, external_id: 'other-app:1',
    output: { title: changed.output.title, summary: changed.output.summary },
  };
  fake.runs.set(sha('e'), [other]);
  const foreign = checkRunPayload(factsFor({ sha: sha('e') }), {}, NOW);
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', foreign), 'created');
  assert.equal(fake.runs.get(sha('e'))!.length, 2);
});

// ---------------------------------------------------------------------------
// 5. Results: the status codes; the pass continues past failures; the real
// helper makes no request without a token.

test('post: status codes and the pass continues past failures', async () => {
  const fake = new FakeGitHub();
  const payload = checkRunPayload(factsFor({}), {}, NOW);
  for (const [status, expected] of [
    [0, 'skipped_no_installation'], [403, 'permission_missing'], [404, 'not_found'],
    [500, 'failed'], [-1, 'failed'],
  ] as const) {
    fake.writeImpl = (async () => ({ status, data: null })) as CheckDeps['write'];
    assert.equal(await postCheck(fake.deps, A, 'acme', 'service', payload), expected, String(status));
  }
  fake.writeImpl = (async () => { throw new Error('boom'); }) as CheckDeps['write'];
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', payload), 'failed');
  fake.getStatusImpl = (async () => { throw new Error('boom'); }) as CheckDeps['getStatus'];
  assert.equal(await postCheck(fake.deps, A, 'acme', 'service', payload), 'failed');

  // The pass continues: one PR's thrown write does not stop the next PR.
  const db = new FakeDb();
  const first = openPr({ id: 'pr-1', headSha: sha('d'), updatedAt: '2026-10-14T11:00:00.000Z' });
  const second = openPr({ id: 'pr-2', headSha: sha('e'), updatedAt: '2026-10-14T10:00:00.000Z' });
  db.repos.push({ id: REPO, tenantId: A, provider: 'github', url: 'https://github.com/acme/service' });
  db.prs.push(first, second);
  const throwing = new FakeGitHub();
  let calls = 0;
  throwing.writeImpl = (async (method: string, path: string, body: unknown) => {
    calls += 1;
    if ((body as CheckRunPayload).head_sha === sha('d')) throw new Error('boom');
    return { status: 201, data: { id: calls } };
  }) as unknown as CheckDeps['write'];
  const counts = await runGithubCheckPass(db, throwing.deps, { tenantId: A, now: NOW });
  assert.deepEqual([counts.prs, counts.failed, counts.created], [2, 1, 1]);
});

test('githubWrite: no installation token means status 0 with no request', async () => {
  const saved = new Map<string, string | undefined>();
  for (const name of ['GITHUB_APP_INSTALLATIONS_JSON', 'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_APP_INSTALLATION_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY']) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  const realFetch = globalThis.fetch;
  let requested = 0;
  globalThis.fetch = (async () => {
    requested += 1;
    throw new Error('must not be called');
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(
      await githubWrite('POST', '/repos/acme/service/check-runs', { name: 'x' }, A, 'acme'),
      { status: 0, data: null },
    );
    assert.equal(requested, 0);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. Privacy: secrets in the database never reach a request body.

test('privacy: titles, emails and subjects never reach GitHub', async () => {
  const db = new FakeDb();
  const pr = openPr();
  const row = seedOpen(db, pr, [sha('a')]);
  db.titles.set(pr.id, 'SECRET-TITLE');
  db.authors.set(pr.id, 'dev@example.com');
  db.subjects.set(sha('a'), 'SECRET-SUBJECT');
  const fake = new FakeGitHub();
  const counts = await runGithubCheckPass(db, fake.deps, { tenantId: A, now: NOW });
  assert.equal(counts.created, 1);
  const bodies = fake.requests.map((r) => JSON.stringify(r.body));
  assert.ok(bodies.length > 0);
  for (const secret of ['SECRET-TITLE', 'dev@example.com', 'SECRET-SUBJECT']) {
    assert.ok(bodies.every((b) => !b.includes(secret)), secret);
  }
  // The only long identifiers in a body are the check's own head sha; Task2
  // column names (titles, authors, subjects, notes, statements) never appear.
  for (const name of ['author_email', 'author_login', 'author_name', 'authorship_note', 'credential_id', 'statement_canonical']) {
    assert.ok(bodies.every((b) => !b.includes(name)), name);
  }
  const hex40 = bodies.flatMap((b) => b.match(/[0-9a-f]{40}/g) ?? []);
  assert.ok(hex40.length > 0);
  assert.ok(hex40.every((h) => h === row.headSha), hex40.join(','));
});

// ---------------------------------------------------------------------------
// 7. Tenant binding: every statement names the tenant; B is invisible to A.

test('tenant binding: A never selects B', async () => {
  const db = new FakeDb();
  db.repos.push(
    { id: REPO, tenantId: A, provider: 'github', url: 'https://github.com/acme/service' },
    { id: 'repo-b', tenantId: B, provider: 'github', url: 'https://github.com/other/service' },
  );
  db.prs.push(openPr({ id: 'pr-a', tenantId: A, repositoryId: REPO }));
  db.prs.push(openPr({ id: 'pr-b', tenantId: B, repositoryId: 'repo-b' }));
  const fake = new FakeGitHub();
  const counts = await runGithubCheckPass(db, fake.deps, { tenantId: A, now: NOW });
  assert.equal(counts.prs, 1);
  assert.equal(counts.created, 1);
  assert.ok(db.calls.length > 0);
  assert.ok(db.calls.every((c) => c.params.includes(A)), 'every statement binds the tenant');
  assert.ok(db.calls.every((c) => !c.params.includes(B)), 'B is never bound');
  for (const c of db.calls) {
    assert.ok(!/title|author_email|subject|body/.test(c.text), c.text.slice(0, 60));
  }
  const selected = await selectPullRequests(db, B, NOW);
  assert.deepEqual(selected.map((p) => p.id), ['pr-b']);
});

// ---------------------------------------------------------------------------
// 8. URLs: a non-github host and an unparsable URL skip without a request.

test('urls: non-github hosts and bad urls are skipped_url', async () => {
  const db = new FakeDb();
  db.repos.push(
    { id: 'repo-gitlab', tenantId: A, provider: 'github', url: 'https://gitlab.com/acme/service' },
    { id: 'repo-bad', tenantId: A, provider: 'github', url: 'not a url at all' },
    { id: REPO, tenantId: A, provider: 'github', url: 'https://github.com/acme/service' },
  );
  db.prs.push(
    openPr({ id: 'pr-gitlab', repositoryId: 'repo-gitlab' }),
    openPr({ id: 'pr-bad', repositoryId: 'repo-bad' }),
    openPr({ id: 'pr-good', repositoryId: REPO }),
  );
  const fake = new FakeGitHub();
  const counts = await runGithubCheckPass(db, fake.deps, { tenantId: A, now: NOW });
  assert.deepEqual([counts.prs, counts.skipped_url, counts.created], [3, 2, 1]);
  assert.equal(fake.requests.length, 1);
});

// A throwing query fails one PR, not the pass.

test('pass: a throwing membership query fails one PR and posts the next', async () => {
  const db = new FakeDb();
  db.repos.push({ id: REPO, tenantId: A, provider: 'github', url: 'https://github.com/acme/service' });
  db.prs.push(
    openPr({ id: 'pr-1', headSha: sha('d'), updatedAt: '2026-10-14T11:00:00.000Z' }),
    openPr({ id: 'pr-2', headSha: sha('e'), updatedAt: '2026-10-14T10:00:00.000Z' }),
    openPr({ id: 'pr-3', headSha: sha('f'), updatedAt: '2026-10-14T09:00:00.000Z' }),
  );
  const realQuery = db.query.bind(db);
  db.query = async (text: string, params: unknown[]) => {
    if (text.includes('github-check members') && (params as string[])[1] === 'pr-2') {
      throw new Error('boom');
    }
    return realQuery(text, params);
  };
  const fake = new FakeGitHub();
  const counts = await runGithubCheckPass(db, fake.deps, { tenantId: A, now: NOW });
  assert.deepEqual([counts.prs, counts.failed, counts.created], [3, 1, 2]);
  assert.deepEqual(
    fake.requests.map((r) => (r.body as CheckRunPayload).head_sha).sort(),
    [sha('d'), sha('f')],
  );
});

// A merged PR posts on its merge sha and reads the pr_merged record.

test('merged PR: the check goes on the merge sha with the merge title', async () => {
  const db = new FakeDb();
  const mergeSha = sha('f');
  db.repos.push({ id: REPO, tenantId: A, provider: 'github', url: 'https://github.com/Acme/Service' });
  db.prs.push({
    id: 'pr-m', tenantId: A, repositoryId: REPO, headSha: sha('d'), mergeCommitSha: mergeSha,
    state: 'merged', mergedAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T11:00:00.000Z',
  });
  db.records.push({
    tenantId: A, repositoryId: REPO, subjectSha: mergeSha, kind: 'pr_merged',
    recordedAt: RECENT, rekor: true, tsa: true,
  });
  const fake = new FakeGitHub();
  const counts = await runGithubCheckPass(db, fake.deps, { tenantId: A, now: NOW });
  assert.equal(counts.created, 1);
  const body = fake.requests[0].body as CheckRunPayload;
  assert.equal(body.head_sha, mergeSha);
  assert.equal(body.external_id, 'trackai-attesta:pr-m');
  assert.equal(body.output.title, 'Merge attested · anchored');
});
