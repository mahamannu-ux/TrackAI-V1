/**
 * Drill-down (Task19b, T19.3): paging over synthetic contexts, no database.
 * The service takes an injected context loader; the scope store is fake.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { QaContext } from './answers/common';
import { computeQ13 } from './answers/q13';
import { createAnswererRegistry } from './answerers';
import {
  decodeCursor,
  encodeCursor,
  listDrilldownItems,
  pageDrilldownItems,
} from './drilldown';
import { QaProblem, answerDrilldown, type QaServiceDeps } from './service';
import type { QaAnswerContext, QaQuestionId, QaScopeLevel } from './types';

const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P2 = '00000000-0000-4000-8000-0000000000c2';
const C1 = '00000000-0000-4000-8000-0000000000d1';
const C2 = '00000000-0000-4000-8000-0000000000d2';
const C3 = '00000000-0000-4000-8000-0000000000d3';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';
const NOW = new Date('2026-10-01T00:00:00.000Z');

const row = <T>(over: Record<string, unknown>): T => over as unknown as T;
type Ctx = QaContext;

function context(): Ctx {
  const inPeriod = new Date('2026-09-10T00:00:00.000Z');
  return {
    repositories: [
      row({ id: R1, name: 'repo-a' }),
      row({ id: R2, name: 'repo-b' }),
    ],
    pullRequests: [
      row({ id: P1, repositoryId: R1, number: 3, state: 'merged', mergedAt: inPeriod, updatedAt: inPeriod }),
      row({ id: P2, repositoryId: R1, number: null, state: 'open', mergedAt: null, updatedAt: inPeriod }),
    ],
    contributors: [],
    sessions: [],
    sessionRepositories: [],
    usage: [],
    commits: [
      row({ id: C1, repositoryId: R1, sha: SHA_A, reachability: 'reachable', committedAt: inPeriod, observedAiLines: 10, observedHumanLines: 5, observedUnknownLines: 0, authorshipNote: 'note' }),
      row({ id: C2, repositoryId: R1, sha: SHA_B, reachability: 'reachable', committedAt: inPeriod, observedAiLines: 20, observedHumanLines: 5, observedUnknownLines: 0, authorshipNote: null }),
      row({ id: C3, repositoryId: R2, sha: 'c'.repeat(40), reachability: 'reachable', committedAt: inPeriod, observedAiLines: 1, observedHumanLines: 1, observedUnknownLines: 0, authorshipNote: 'note' }),
      row({ id: '00000000-0000-4000-8000-0000000000d4', repositoryId: R1, sha: 'd'.repeat(40), reachability: 'reachable', committedAt: new Date('2026-01-01T00:00:00.000Z'), observedAiLines: 99, observedHumanLines: 0, observedUnknownLines: 0, authorshipNote: 'old' }),
    ],
    files: [],
    commitSessions: [],
    pullRequestCommits: [
      row({ pullRequestId: P1, commitId: C1 }),
      row({ pullRequestId: P1, commitId: C2 }),
    ],
    generationObservations: [],
    lifecycleEvents: [],
    memberships: [],
    commitLineage: [],
    mergeLineage: [],
    deployments: [],
    commitModelAttributions: [],
    modelLifecycleEvents: [],
    corrections: new Map(),
  } as unknown as Ctx;
}

function ctxFor(
  questionId: QaQuestionId,
  scopeLevel: QaScopeLevel,
  scope: QaAnswerContext['scope'],
  role: QaAnswerContext['role'] = 'tenant_admin',
): QaAnswerContext {
  return {
    tenantId: 'tenant-a', questionId, kind: 'live', role, scopeLevel, scope, breakdown: null, now: NOW.toISOString(),
  };
}

const scopes = {
  repositoryExists: async () => true,
  pullRequestRepository: async () => R1,
  commitExists: async () => true,
};

function deps(): QaServiceDeps {
  return { answerers: createAnswererRegistry(), scopes, contextLoader: async () => context() };
}

const req = (questionId: string, query: Record<string, unknown>, role: 'tenant_admin' | 'tenant_auditor' = 'tenant_admin') => ({
  tenantId: 'tenant-a', role, questionId, query, now: NOW,
});

describe('drilldown cursors', () => {
  test('base64url round trip; garbage decodes to null', () => {
    assert.equal(decodeCursor(encodeCursor(R1)), R1);
    assert.equal(decodeCursor('!!!'), null);
    assert.equal(decodeCursor(encodeCursor('not-a-uuid')), null);
  });

  test('paging is exact: pages, cursor round trip, then null', () => {
    const items = [
      { scope: 'repository' as const, id: R1, label: 'repo-a' },
      { scope: 'repository' as const, id: R2, label: 'repo-b' },
    ];
    const first = pageDrilldownItems(items, 1, null);
    assert.deepEqual(first.items, [items[0]]);
    assert.equal(first.nextCursor !== null, true);
    const second = pageDrilldownItems(items, 1, decodeCursor(first.nextCursor ?? ''));
    assert.deepEqual(second.items, [items[1]]);
    assert.equal(second.nextCursor, null);
  });
});

describe('drilldown listing', () => {
  test('tenant scope lists repositories with a commit in the period, by id', () => {
    const items = listDrilldownItems(context(), ctxFor('Q3', 'tenant', { from: FROM, to: TO }));
    assert.deepEqual(items.map((i) => i.id), [R1, R2].sort());
    assert.deepEqual(items.map((i) => i.scope), ['repository', 'repository']);
    assert.deepEqual(items.map((i) => i.label), ['repo-a', 'repo-b']);
  });

  test('repository scope lists PRs merged or updated in the period, metadata labels', () => {
    const items = listDrilldownItems(context(), ctxFor('Q3', 'repository', { repository_id: R1, from: FROM, to: TO }));
    assert.deepEqual(items.map((i) => i.label), ['#3', 'PR']);
    assert.deepEqual(items.map((i) => i.scope), ['pull_request', 'pull_request']);
  });

  test('pull_request scope lists the PR commits as commit ids with short SHAs', () => {
    const items = listDrilldownItems(
      context(), ctxFor('Q14', 'pull_request', { pull_request_id: P1, from: FROM, to: TO }));
    assert.deepEqual(items.map((i) => i.id).sort(), [C1, C2].sort());
    assert.deepEqual(items.map((i) => i.label).sort(), [SHA_A.slice(0, 12), SHA_B.slice(0, 12)].sort());
  });

  test('commit scope lists none', () => {
    const items = listDrilldownItems(
      context(), ctxFor('Q4', 'commit', { repository_id: R1, commit_sha: SHA_A, from: FROM, to: TO }));
    assert.deepEqual(items, []);
  });
});

describe('drilldown route', () => {
  test('tenant to repository to PR to commit pages correctly', async () => {
    const d = deps();
    const tenant = await answerDrilldown(d, req('Q3', { kind: 'live', limit: '1' }));
    assert.equal(tenant.items.length, 1);
    assert.equal(tenant.next_cursor !== null, true);
    const tenant2 = await answerDrilldown(d, req('Q3', { kind: 'live', limit: '1', cursor: tenant.next_cursor ?? '' }));
    assert.equal(tenant2.items.length, 1);
    assert.notEqual(tenant2.items[0].id, tenant.items[0].id);
    assert.equal(tenant2.next_cursor, null);

    const repos = await answerDrilldown(d, req('Q9', { kind: 'live', repository_id: R1, limit: '1' }));
    assert.equal(repos.items.length, 1);
    const prs = await answerDrilldown(d, req('Q9', { kind: 'live', repository_id: R1 }));
    assert.equal(prs.items.length, 2);

    const commits = await answerDrilldown(d, req('Q14', { kind: 'live', pull_request_id: P1, limit: '1' }));
    assert.equal(commits.items.length, 1);
    assert.equal(commits.next_cursor !== null, true);
    const commits2 = await answerDrilldown(
      d, req('Q14', { kind: 'live', pull_request_id: P1, limit: '1', cursor: commits.next_cursor ?? '' }));
    assert.equal(commits2.items.length, 1);
    assert.equal(commits2.next_cursor, null);
  });

  test('an invalid cursor is 400 QA_SCOPE_INVALID; other questions keep 501', async () => {
    const d = deps();
    await assert.rejects(answerDrilldown(d, req('Q3', { kind: 'live', cursor: '!!!' })), (e: unknown) =>
      e instanceof QaProblem && e.code === 'QA_SCOPE_INVALID');
    await assert.rejects(
      answerDrilldown(d, req('Q3', { kind: 'live', cursor: encodeCursor('00000000-0000-4000-8000-0000000000ff') })),
      (e: unknown) => e instanceof QaProblem && e.code === 'QA_SCOPE_INVALID');
    await assert.rejects(answerDrilldown(d, req('Q3', { kind: 'live', limit: '0' })), (e: unknown) =>
      e instanceof QaProblem && e.code === 'QA_SCOPE_INVALID');
    await assert.rejects(answerDrilldown(d, req('Q5', { kind: 'live' })), (e: unknown) =>
      e instanceof QaProblem && e.code === 'QA_DRILLDOWN_NOT_BUILT');
  });

  test('an auditor gets 403 on the drill-down', async () => {
    const d = deps();
    await assert.rejects(answerDrilldown(d, req('Q3', { kind: 'live' }, 'tenant_auditor')), (e: unknown) =>
      e instanceof QaProblem && e.code === 'QA_KIND_NOT_ALLOWED');
  });

  test('envelope drilldown is the first 20 of the route first page, same items', async () => {
    const c = context();
    const envelope = computeQ13({
      context: c,
      ctx: ctxFor('Q13', 'tenant', { from: FROM, to: TO }),
    });
    const page = await answerDrilldown(deps(), req('Q13', { kind: 'live', limit: '20' }));
    assert.deepEqual(envelope.drilldown, page.items.slice(0, 20));
  });
});
