/**
 * Task19b live code answerers (T19.3): every compute function on synthetic
 * contexts, no database. Each question covers recorded, partial and
 * unavailable; null is never 0; breakdown keys carry no `/`, `\` or `@`;
 * Q20 carries previous with the same keys; Q18 covers rounding and partial
 * cases; every envelope also passes the contract validator through
 * answerQuestion with a fake scope store (as qa-api.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LifecycleSummary, LifecycleValue } from '../../telemetry/lifecycle';
import { createAnswererRegistry } from '../answerers';
import { answerQuestion } from '../service';
import type {
  QaAnswerContext,
  QaDimension,
  QaEnvelope,
  QaFigure,
  QaQuestionId,
  QaScope,
  QaScopeLevel,
} from '../types';
import {
  type BreakdownFacts,
  type ComputeInput,
  type QaContext,
  type ScopeFacts,
} from './common';
import { computeQ1 } from './q01';
import { computeQ3 } from './q03';
import { computeQ4 } from './q04';
import { computeQ9 } from './q09';
import { computeQ10 } from './q10';
import { computeQ13 } from './q13';
import { computeQ14 } from './q14';
import { computeQ18 } from './q18';
import { computeQ19 } from './q19';
import { computeQ20 } from './q20';

const REPO = '00000000-0000-4000-8000-0000000000a1';
const REPO2 = '00000000-0000-4000-8000-0000000000a2';
const PR = '00000000-0000-4000-8000-0000000000c1';
const SHA = 'a'.repeat(40);
const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';
const NOW = '2026-10-01T00:00:00.000Z';
const AT = new Date('2026-09-10T00:00:00.000Z');

const row = <T>(over: Record<string, unknown>): T => over as unknown as T;

type Avail = 'recorded' | 'partial' | 'unavailable';
const lv = (value: number | null, availability?: Avail): LifecycleValue => ({
  value,
  availability: availability ?? (value === null ? 'unavailable' : 'recorded'),
  evidenceTypes: [],
});

function summaryWith(over: Partial<LifecycleSummary>): LifecycleSummary {
  return {
    generated: lv(null), committed: lv(null), inPullRequests: lv(null), merged: lv(null),
    production: lv(null), mergedProxy: lv(null), reworked: lv(null), churned: lv(null),
    reworkByActor: {},
    ratios: { generatedToCommitted: null, generatedToPullRequest: null, generatedToMerged: null, generatedToProduction: null },
    ...over,
  };
}

function baseContext(): QaContext {
  return {
    repositories: [row({ id: REPO, name: 'repo-a' }), row({ id: REPO2, name: 'repo-b' })],
    pullRequests: [],
    contributors: [],
    sessions: [],
    sessionRepositories: [],
    usage: [],
    commits: [],
    files: [],
    commitSessions: [],
    pullRequestCommits: [],
    generationObservations: [],
    lifecycleEvents: [],
    memberships: [],
    commitLineage: [],
    mergeLineage: [],
    deployments: [],
    commitModelAttributions: [],
    modelLifecycleEvents: [],
    corrections: new Map(),
  } as unknown as QaContext;
}

function ctxFor(
  questionId: QaQuestionId,
  scopeLevel: QaScopeLevel,
  scope: QaScope,
  breakdown: QaDimension | null = null,
): QaAnswerContext {
  return {
    tenantId: 'tenant-a', questionId, kind: 'live', role: 'tenant_admin',
    scopeLevel, scope, breakdown, now: NOW,
  };
}

const facts = (
  summary: LifecycleSummary,
  totals: ScopeFacts['totals'] = { sessions: 0, commits: 0, finalAiLines: 0, finalHumanLines: 0 },
  deployments = 0,
): ScopeFacts => ({ summary, totals, deployments });
const noBreakdown: BreakdownFacts = { repositories: [], models: [] };

function figureOf(envelope: QaEnvelope, key: string): QaFigure {
  const figure = envelope.figures.find((f) => f.key === key);
  assert.ok(figure, `figure ${key}`);
  return figure as QaFigure;
}

function realtimeCommit(over: Record<string, unknown>) {
  return row<QaContext['commits'][number]>({
    reachability: 'reachable', committedAt: AT, observedAiLines: 0, observedHumanLines: 0,
    observedUnknownLines: 0, authorshipNote: 'note', repositoryId: REPO, sha: SHA, ...over,
  });
}

describe('Q3 merged share', () => {
  const scope = facts(summaryWith({ merged: lv(300) }), { sessions: 2, commits: 3, finalAiLines: 350, finalHumanLines: 300 });
  test('recorded figures and ratio share', () => {
    const e = computeQ3({ context: baseContext(), ctx: ctxFor('Q3', 'repository', { repository_id: REPO, from: FROM, to: TO }), scope, breakdownFacts: noBreakdown });
    assert.deepEqual(figureOf(e, 'merged_ai_lines').value, { type: 'count', count: 300 });
    assert.deepEqual(figureOf(e, 'ai_share_of_retained_lines').value, { type: 'ratio', numerator: 350, denominator: 650 });
    assert.equal(e.availability, 'recorded');
    assert.deepEqual(e.signed_evidence, { path: '/api/attesta/statements', query: { repository_id: REPO, from: FROM, to: TO } });
    assert.ok(e.wording.includes('unknown_model_explicit'));
  });

  test('unavailable merged stays null, never 0; breakdown buckets only when recorded', () => {
    const partial = computeQ3({
      context: baseContext(),
      ctx: ctxFor('Q3', 'tenant', { from: FROM, to: TO }, 'model'),
      scope: facts(summaryWith({ merged: lv(null, 'partial') }), { sessions: 0, commits: 0, finalAiLines: 0, finalHumanLines: 0 }),
      breakdownFacts: {
        repositories: [],
        models: [{ key: 'model-a', tool: 'tool-a', summary: summaryWith({ merged: lv(120) }) }],
      },
    });
    assert.equal(figureOf(partial, 'merged_ai_lines').availability, 'partial');
    assert.equal(figureOf(partial, 'merged_ai_lines').value, null);
    // Partial figures may carry breakdowns; unavailable ones never do.
    assert.deepEqual(figureOf(partial, 'merged_ai_lines').breakdown, [
      { dimension: 'model', key: 'model-a', value: { type: 'count', count: 120 } },
    ]);
    const unavailable = computeQ3({
      context: baseContext(),
      ctx: ctxFor('Q3', 'tenant', { from: FROM, to: TO }, 'model'),
      scope: facts(summaryWith({ merged: lv(null, 'unavailable') }), { sessions: 0, commits: 0, finalAiLines: 0, finalHumanLines: 0 }),
      breakdownFacts: {
        repositories: [],
        models: [{ key: 'model-a', tool: 'tool-a', summary: summaryWith({ merged: lv(120) }) }],
      },
    });
    assert.equal(figureOf(unavailable, 'merged_ai_lines').value, null);
    assert.equal(figureOf(unavailable, 'merged_ai_lines').breakdown, undefined);
    assert.equal(unavailable.availability, 'unavailable');
  });

  test('model, tool and repository breakdowns', () => {
    const models: BreakdownFacts['models'] = [
      { key: 'model-a', tool: 'tool-a', summary: summaryWith({ merged: lv(200) }) },
      { key: 'model-b', tool: 'tool-b', summary: summaryWith({ merged: lv(100) }) },
    ];
    for (const breakdown of ['model', 'tool', 'repository'] as const) {
      const e = computeQ3({
        context: baseContext(),
        ctx: ctxFor('Q3', 'tenant', { from: FROM, to: TO }, breakdown),
        scope,
        breakdownFacts: {
          repositories: [{ id: REPO, scope: facts(summaryWith({ merged: lv(300) })) }],
          models,
        },
      });
      const buckets = figureOf(e, 'merged_ai_lines').breakdown ?? [];
      assert.ok(buckets.length > 0, `${breakdown} has buckets`);
      assert.ok(buckets.every((b) => b.dimension === breakdown));
    }
  });
});

describe('Q1 changed-lines share', () => {
  test('share recorded, repository share unavailable with G1 on figure and top', () => {
    const e = computeQ1({
      context: baseContext(),
      ctx: ctxFor('Q1', 'tenant', { from: FROM, to: TO }, 'repository'),
      scope: facts(summaryWith({}), { sessions: 1, commits: 2, finalAiLines: 350, finalHumanLines: 300 }),
      breakdownFacts: { repositories: [{ id: REPO, scope: facts(summaryWith({}), { sessions: 1, commits: 2, finalAiLines: 350, finalHumanLines: 300 }) }], models: [] },
    });
    assert.deepEqual(figureOf(e, 'ai_share_of_changed_lines').value, { type: 'ratio', numerator: 350, denominator: 650 });
    assert.equal(figureOf(e, 'ai_share_of_repository').availability, 'unavailable');
    assert.deepEqual(figureOf(e, 'ai_share_of_repository').reasons, [{ code: 'not_captured_yet', gap: 'G1' }]);
    assert.ok(e.reasons.some((r) => r.code === 'not_captured_yet' && r.gap === 'G1'));
    assert.equal(e.availability, 'partial');
  });
});

describe('Q4 production models', () => {
  function q4Context(): QaContext {
    const c = baseContext();
    c.commits = [realtimeCommit({ id: 'c1', observedAiLines: 100 })];
    c.commitModelAttributions = [
      row({ commitId: 'c1', modelKey: 'model-a', tool: 'tool-a', observedAiLines: 100 }),
      row({ commitId: 'c1', modelKey: 'model-b', tool: 'tool-b', observedAiLines: 50 }),
    ];
    c.modelLifecycleEvents = [
      row({ modelKey: 'model-a', tool: 'tool-a', repositoryId: REPO, stage: 'production', lineCount: 250, commitId: null, occurredAt: AT }),
      row({ modelKey: 'model-b', tool: 'tool-b', repositoryId: REPO, stage: 'merged', lineCount: 50, commitId: null, occurredAt: AT }),
    ];
    return c;
  }
  test('models in production counted, approval G2, commit scope from attributions', () => {
    const input: ComputeInput = {
      context: q4Context(),
      ctx: ctxFor('Q4', 'repository', { repository_id: REPO, from: FROM, to: TO }),
      scope: facts(summaryWith({ production: lv(250) })),
      breakdownFacts: noBreakdown,
    };
    const e = computeQ4(input);
    assert.deepEqual(figureOf(e, 'models_in_production').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'production_ai_lines').value, { type: 'count', count: 250 });
    assert.deepEqual(figureOf(e, 'approved_at_the_time').reasons, [{ code: 'not_captured_yet', gap: 'G2' }]);
    const commit = computeQ4({
      ...input,
      ctx: ctxFor('Q4', 'commit', { repository_id: REPO, commit_sha: SHA, from: FROM, to: TO }),
      context: { ...q4Context(), commits: [realtimeCommit({ id: 'c1', sha: SHA })] },
    });
    assert.deepEqual(figureOf(commit, 'models_in_production').value, { type: 'count', count: 1 });
  });
});

describe('Q9 production', () => {
  test('production, proxy and deployment count; proxy never added', () => {
    const e = computeQ9({
      context: baseContext(),
      ctx: ctxFor('Q9', 'repository', { repository_id: REPO, from: FROM, to: TO }, 'repository'),
      scope: facts(summaryWith({ production: lv(250), mergedProxy: lv(60) }), { sessions: 0, commits: 0, finalAiLines: 0, finalHumanLines: 0 }, 1),
      breakdownFacts: {
        repositories: [{ id: REPO, scope: facts(summaryWith({ production: lv(250) })) }],
        models: [],
      },
    });
    assert.deepEqual(figureOf(e, 'production_ai_lines').value, { type: 'count', count: 250 });
    assert.deepEqual(figureOf(e, 'merged_not_deployed_proxy_lines').value, { type: 'count', count: 60 });
    assert.deepEqual(figureOf(e, 'production_deployments').value, { type: 'count', count: 1 });
    assert.ok(e.wording.includes('merged_not_deployed_proxy'));
  });
});

describe('Q10 rework', () => {
  test('reworked by actor; missing unknown key reads 0 when recorded', () => {
    const e = computeQ10({
      context: baseContext(),
      ctx: ctxFor('Q10', 'tenant', { from: FROM, to: TO }),
      scope: facts(summaryWith({ reworked: lv(50), reworkByActor: { ai: 40, human: 10 } })),
      breakdownFacts: noBreakdown,
    });
    assert.deepEqual(figureOf(e, 'reworked_ai_lines').value, { type: 'count', count: 50 });
    assert.deepEqual(figureOf(e, 'reworked_by_ai').value, { type: 'count', count: 40 });
    assert.deepEqual(figureOf(e, 'reworked_by_human').value, { type: 'count', count: 10 });
    assert.deepEqual(figureOf(e, 'reworked_by_unknown').value, { type: 'count', count: 0 });
    assert.deepEqual(figureOf(e, 'churned_ai_lines').reasons, [{ code: 'never_written' }]);
    assert.equal(figureOf(e, 'churned_ai_lines').value, null);
    assert.ok(e.wording.includes('churned_unavailable'));
  });

  test('unrecorded rework makes actor buckets unavailable, never 0', () => {
    const e = computeQ10({
      context: baseContext(),
      ctx: ctxFor('Q10', 'tenant', { from: FROM, to: TO }),
      scope: facts(summaryWith({ reworked: lv(null, 'partial') })),
      breakdownFacts: noBreakdown,
    });
    for (const key of ['reworked_ai_lines', 'reworked_by_ai', 'reworked_by_human', 'reworked_by_unknown']) {
      assert.equal(figureOf(e, key).value, null, `${key} is null`);
    }
  });
});

describe('Q13 evidence completeness', () => {
  function q13Context(): QaContext {
    const c = baseContext();
    c.commits = [
      realtimeCommit({ id: 'c1' }),
      realtimeCommit({ id: 'c2', authorshipNote: null, observedUnknownLines: 5 }),
      realtimeCommit({ id: 'c3', repositoryId: REPO2 }),
    ];
    return c;
  }
  test('commits, missing notes, unknown lines, coverage', () => {
    const e = computeQ13({
      context: q13Context(), ctx: ctxFor('Q13', 'tenant', { from: FROM, to: TO }, 'repository'),
    });
    assert.deepEqual(figureOf(e, 'commits').value, { type: 'count', count: 3 });
    assert.deepEqual(figureOf(e, 'commits_without_git_ai_note').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'unknown_lines').value, { type: 'count', count: 5 });
    assert.deepEqual(figureOf(e, 'note_coverage').value, { type: 'ratio', numerator: 2, denominator: 3 });
    assert.deepEqual(figureOf(e, 'commits').breakdown?.map((b) => b.key).sort(), [REPO, REPO2].sort());
  });

  test('commit scope narrows to the one commit', () => {
    const e = computeQ13({
      context: q13Context(),
      ctx: ctxFor('Q13', 'commit', { repository_id: REPO, commit_sha: SHA, from: FROM, to: TO }),
    });
    assert.deepEqual(figureOf(e, 'commits').value, { type: 'count', count: 1 });
  });
});

describe('Q14 pull-request chain', () => {
  function q14Context(): QaContext {
    const c = baseContext();
    c.pullRequests = [row({ id: PR, repositoryId: REPO, state: 'merged', mergeCommitSha: SHA, mergedAt: AT })];
    c.commits = [
      realtimeCommit({ id: 'c1', sha: SHA, observedAiLines: 100, observedHumanLines: 50 }),
      realtimeCommit({ id: 'c2', sha: 'b'.repeat(40), observedAiLines: 200, observedHumanLines: 100 }),
    ];
    c.pullRequestCommits = [row({ pullRequestId: PR, commitId: 'c1' }), row({ pullRequestId: PR, commitId: 'c2' })];
    c.sessions = [row({ id: 's1', tool: 'opencode', externalSessionId: 'ext-1', observedModels: [] })];
    c.commitSessions = [row({ commitId: 'c1', sessionId: 's1', observedAiLines: 100 })];
    c.lifecycleEvents = [row({ repositoryId: REPO, pullRequestId: PR, commitId: null, stage: 'production', lineCount: 250, actorKind: null, evidenceType: 'deployed', occurredAt: AT })];
    return c;
  }
  test('counts, lines, merged 1, production from Task2', () => {
    const e = computeQ14({
      context: q14Context(), ctx: ctxFor('Q14', 'pull_request', { pull_request_id: PR, from: FROM, to: TO }),
    });
    assert.deepEqual(figureOf(e, 'commits').value, { type: 'count', count: 2 });
    assert.deepEqual(figureOf(e, 'sessions').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'final_ai_lines').value, { type: 'count', count: 300 });
    assert.deepEqual(figureOf(e, 'final_human_lines').value, { type: 'count', count: 150 });
    assert.deepEqual(figureOf(e, 'merged').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'production_ai_lines').value, { type: 'count', count: 250 });
    assert.ok(e.wording.includes('metadata_only'));
  });

  test('unknown PR answers unavailable, never 0', () => {
    const e = computeQ14({
      context: q14Context(),
      ctx: ctxFor('Q14', 'pull_request', { pull_request_id: '00000000-0000-4000-8000-0000000000ff', from: FROM, to: TO }),
    });
    for (const f of e.figures) assert.equal(f.value, null);
  });
});

describe('Q18 tokens and cost', () => {
  function q18Context(): QaContext {
    const c = baseContext();
    c.commits = [realtimeCommit({ id: 'c1' }), realtimeCommit({ id: 'c2' })];
    c.sessions = [
      row({ id: 's1', tool: 'opencode', externalSessionId: 'ext-1' }),
      row({ id: 's2', tool: 'claude', externalSessionId: 'ext-2' }),
    ];
    c.sessionRepositories = [row({ sessionId: 's1', repositoryId: REPO }), row({ sessionId: 's2', repositoryId: REPO })];
    c.commitSessions = [row({ commitId: 'c1', sessionId: 's1' }), row({ commitId: 'c2', sessionId: 's2' })];
    c.usage = [
      row({ sessionId: 's1', model: 'model-a', inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, costAmount: '1.2345678', costUnit: 'USD', availability: 'recorded', evidenceSource: 't', evidenceKey: 'k1' }),
      row({ sessionId: 's2', model: 'model-b', inputTokens: 2000, outputTokens: 800, reasoningTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costAmount: '1.0000000', costUnit: 'usd', availability: 'recorded', evidenceSource: 't', evidenceKey: 'k2' }),
    ];
    return c;
  }
  test('recorded sums; cost rounded per row in integer millionths, units lowercase', () => {
    const e = computeQ18({ context: q18Context(), ctx: ctxFor('Q18', 'repository', { repository_id: REPO, from: FROM, to: TO }) });
    assert.deepEqual(figureOf(e, 'input_tokens').value, { type: 'count', count: 3000 });
    assert.deepEqual(figureOf(e, 'output_tokens').value, { type: 'count', count: 1300 });
    // 1.2345678M rounds per row: 1234568 + 1000000.
    assert.deepEqual(figureOf(e, 'cost_micro_usd').value, { type: 'count', count: 2234568 });
    assert.equal(e.availability, 'recorded');
  });

  test('a null token makes that figure partial with vendor_does_not_report', () => {
    const c = q18Context();
    (c.usage[0] as unknown as Record<string, unknown>).reasoningTokens = null;
    const e = computeQ18({ context: c, ctx: ctxFor('Q18', 'tenant', { from: FROM, to: TO }) });
    assert.equal(figureOf(e, 'reasoning_tokens').availability, 'partial');
    assert.deepEqual(figureOf(e, 'reasoning_tokens').reasons, [{ code: 'vendor_does_not_report' }]);
    assert.equal(figureOf(e, 'reasoning_tokens').value, null);
    assert.equal(figureOf(e, 'input_tokens').availability, 'recorded');
  });

  test('a session without usage makes figures partial; no usage at all is unavailable', () => {
    const c = q18Context();
    c.sessions.push(row({ id: 's3', tool: 'opencode', externalSessionId: 'ext-3' }));
    c.commitSessions.push(row({ commitId: 'c1', sessionId: 's3' }));
    const partial = computeQ18({ context: c, ctx: ctxFor('Q18', 'tenant', { from: FROM, to: TO }) });
    assert.equal(figureOf(partial, 'input_tokens').availability, 'partial');
    const empty = baseContext();
    const unavailable = computeQ18({ context: empty, ctx: ctxFor('Q18', 'tenant', { from: FROM, to: TO }) });
    assert.equal(figureOf(unavailable, 'input_tokens').availability, 'unavailable');
    assert.equal(figureOf(unavailable, 'input_tokens').value, null);
  });

  test('breakdowns on output_tokens only, unknown buckets stay', () => {
    for (const breakdown of ['model', 'tool', 'repository'] as const) {
      const e = computeQ18({ context: q18Context(), ctx: ctxFor('Q18', 'tenant', { from: FROM, to: TO }, breakdown) });
      const buckets = figureOf(e, 'output_tokens').breakdown ?? [];
      assert.ok(buckets.length > 0, `${breakdown} has buckets`);
      assert.ok(buckets.every((b) => b.dimension === breakdown));
    }
  });
});

describe('Q19 acceptance', () => {
  test('generated, committed and acceptance ratio', () => {
    const e = computeQ19({
      context: baseContext(),
      ctx: ctxFor('Q19', 'tenant', { from: FROM, to: TO }),
      scope: facts(summaryWith({ generated: lv(500), committed: lv(350) })),
      breakdownFacts: noBreakdown,
    });
    assert.deepEqual(figureOf(e, 'generated_lines').value, { type: 'count', count: 500 });
    assert.deepEqual(figureOf(e, 'committed_ai_lines').value, { type: 'count', count: 350 });
    assert.deepEqual(figureOf(e, 'acceptance').value, { type: 'ratio', numerator: 350, denominator: 500 });
  });

  test('partial generated keeps partial; acceptance needs both recorded', () => {
    const e = computeQ19({
      context: baseContext(),
      ctx: ctxFor('Q19', 'tenant', { from: FROM, to: TO }),
      scope: facts(summaryWith({ generated: lv(null, 'partial'), committed: lv(350) })),
      breakdownFacts: noBreakdown,
    });
    assert.equal(figureOf(e, 'generated_lines').availability, 'partial');
    assert.equal(figureOf(e, 'acceptance').availability, 'unavailable');
    assert.equal(figureOf(e, 'acceptance').value, null);
  });
});

describe('Q20 change over time', () => {
  test('previous carries the same keys; team stays unavailable', () => {
    const prevScope = facts(summaryWith({}), { sessions: 1, commits: 1, finalAiLines: 300, finalHumanLines: 200 });
    const e = computeQ20({
      context: baseContext(),
      ctx: ctxFor('Q20', 'tenant', { from: FROM, to: TO }, 'repository'),
      scope: facts(summaryWith({}), { sessions: 2, commits: 3, finalAiLines: 350, finalHumanLines: 300 }),
      breakdownFacts: {
        repositories: [{ id: REPO, scope: facts(summaryWith({}), { sessions: 2, commits: 3, finalAiLines: 350, finalHumanLines: 300 }) }],
        models: [],
      },
      previous: {
        from: '2026-08-02T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
        scope: prevScope,
        breakdownFacts: {
          repositories: [{ id: REPO, scope: prevScope }],
          models: [],
        },
      },
    });
    assert.deepEqual(figureOf(e, 'ai_committed_lines').value, { type: 'count', count: 350 });
    assert.equal(figureOf(e, 'team').availability, 'unavailable');
    assert.ok(e.previous, 'previous is present');
    assert.deepEqual(e.previous?.figures.map((f) => f.key), e.figures.map((f) => f.key));
    assert.deepEqual(figureOf({ figures: e.previous?.figures ?? [] } as QaEnvelope, 'ai_committed_lines').value, { type: 'count', count: 300 });
  });
});

describe('honest states everywhere', () => {
  test('null is never 0: every unavailable figure carries null', () => {
    const empty = baseContext();
    const tenant = ctxFor('Q3', 'tenant', { from: FROM, to: TO });
    const none = facts(summaryWith({}));
    const envelopes: QaEnvelope[] = [
      computeQ1({ context: empty, ctx: ctxFor('Q1', 'tenant', { from: FROM, to: TO }), scope: none, breakdownFacts: noBreakdown }),
      computeQ3({ context: empty, ctx: tenant, scope: none, breakdownFacts: noBreakdown }),
      computeQ4({ context: empty, ctx: ctxFor('Q4', 'tenant', { from: FROM, to: TO }), scope: none, breakdownFacts: noBreakdown }),
      computeQ9({ context: empty, ctx: ctxFor('Q9', 'tenant', { from: FROM, to: TO }), scope: none, breakdownFacts: noBreakdown }),
      computeQ10({ context: empty, ctx: ctxFor('Q10', 'tenant', { from: FROM, to: TO }), scope: none, breakdownFacts: noBreakdown }),
      computeQ13({ context: empty, ctx: ctxFor('Q13', 'tenant', { from: FROM, to: TO }) }),
      computeQ14({ context: empty, ctx: ctxFor('Q14', 'pull_request', { pull_request_id: PR, from: FROM, to: TO }) }),
      computeQ18({ context: empty, ctx: ctxFor('Q18', 'tenant', { from: FROM, to: TO }) }),
      computeQ19({ context: empty, ctx: ctxFor('Q19', 'tenant', { from: FROM, to: TO }), scope: none, breakdownFacts: noBreakdown }),
      computeQ20({ context: empty, ctx: ctxFor('Q20', 'tenant', { from: FROM, to: TO }), scope: facts(summaryWith({}), { sessions: 0, commits: 0, finalAiLines: 0, finalHumanLines: 0 }), breakdownFacts: noBreakdown }),
    ];
    for (const e of envelopes) {
      for (const f of [...e.figures, ...(e.previous?.figures ?? [])]) {
        if (f.availability === 'unavailable') assert.equal(f.value, null, `${e.question_id}/${f.key} is null`);
        if (f.availability !== 'unavailable') assert.notEqual(f.value, null, `${e.question_id}/${f.key} has a value`);
      }
    }
  });

  test('breakdown keys never carry a path or an email', () => {
    const keys: string[] = [];
    const e = computeQ3({
      context: baseContext(),
      ctx: ctxFor('Q3', 'tenant', { from: FROM, to: TO }, 'model'),
      scope: facts(summaryWith({ merged: lv(300) })),
      breakdownFacts: {
        repositories: [{ id: REPO, scope: facts(summaryWith({ merged: lv(300) })) }],
        models: [{ key: 'model-a', tool: 'tool-a', summary: summaryWith({ merged: lv(300) }) }],
      },
    });
    for (const f of e.figures) for (const b of f.breakdown ?? []) keys.push(b.key);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.match(key, /^[^/\\@]+$/);
  });
});

describe('validator sweep through answerQuestion', () => {
  const fakeScopes = {
    repositoryExists: async () => true,
    pullRequestRepository: async () => REPO,
    commitExists: async () => true,
  };
  const full = {
    context: (() => {
      const c = baseContext();
      c.commits = [realtimeCommit({ id: 'c1', observedAiLines: 100, observedHumanLines: 50 })];
      c.modelLifecycleEvents = [row({ modelKey: 'model-a', tool: 'tool-a', repositoryId: REPO, stage: 'production', lineCount: 100, commitId: 'c1', occurredAt: AT })];
      c.commitModelAttributions = [row({ commitId: 'c1', modelKey: 'model-a', tool: 'tool-a', observedAiLines: 100 })];
      return c;
    })(),
    rich: facts(
      summaryWith({ merged: lv(300), production: lv(250), mergedProxy: lv(60), committed: lv(350), generated: lv(500), reworked: lv(50), reworkByActor: { ai: 50 } }),
      { sessions: 2, commits: 3, finalAiLines: 350, finalHumanLines: 300 },
      1,
    ),
    breakdown: {
      repositories: [] as BreakdownFacts['repositories'],
      models: [{ key: 'model-a', tool: 'tool-a', summary: summaryWith({ merged: lv(300), production: lv(100), committed: lv(350) }) }],
    } as BreakdownFacts,
  };

  test('every live answer validates for its scopes', async () => {
    const answerers = createAnswererRegistry();
    const s = full;
    answerers.register('Q1', 'live', async (ctx) => computeQ1({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q3', 'live', async (ctx) => computeQ3({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q4', 'live', async (ctx) => computeQ4({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q9', 'live', async (ctx) => computeQ9({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q10', 'live', async (ctx) => computeQ10({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q13', 'live', async (ctx) => computeQ13({ context: s.context, ctx }));
    answerers.register('Q14', 'live', async (ctx) => computeQ14({ context: s.context, ctx }));
    answerers.register('Q18', 'live', async (ctx) => computeQ18({ context: s.context, ctx }));
    answerers.register('Q19', 'live', async (ctx) => computeQ19({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    answerers.register('Q20', 'live', async (ctx) => computeQ20({ context: s.context, ctx, scope: s.rich, breakdownFacts: s.breakdown }));
    const deps = { answerers, scopes: fakeScopes };
    const queries: Array<[QaQuestionId, string]> = [
      ['Q1', 'kind=live'],
      ['Q3', 'kind=live'],
      ['Q4', 'kind=live'],
      ['Q9', 'kind=live'],
      ['Q10', 'kind=live'],
      ['Q13', 'kind=live'],
      ['Q19', 'kind=live'],
      ['Q18', 'kind=live'],
      ['Q20', 'kind=live'],
      ['Q3', 'kind=live&breakdown=model'],
      ['Q9', `kind=live&repository_id=${REPO}`],
      ['Q13', `kind=live&repository_id=${REPO}`],
      ['Q4', `kind=live&repository_id=${REPO}&commit_sha=${SHA}`],
      ['Q14', `kind=live&pull_request_id=${PR}`],
      ['Q19', `kind=live&pull_request_id=${PR}`],
      ['Q18', `kind=live&pull_request_id=${PR}`],
      ['Q10', `kind=live&repository_id=${REPO}`],
    ];
    for (const [id, params] of queries) {
      const query = Object.fromEntries(new URLSearchParams(`${params}&from=${FROM}&to=${TO}`).entries());
      const envelope = await answerQuestion(deps, { tenantId: 't', role: 'tenant_admin', questionId: id, query, now: new Date(NOW) });
      assert.equal(envelope.question_id, id, `${id} ${params}`);
    }
  });
});
