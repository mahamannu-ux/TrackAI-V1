/**
 * Security live answerers (Task19c, T19.4): synthetic contexts, no database.
 *
 * Two generations of `security_findings` (Task6.a and v2) are exercised, plus
 * the `not_enrolled` bucket, an unknown platform and an unknown model, the
 * metadata-only read (no preview column), the full envelope sweep through the
 * real service (every answer validates), and a Company A / Company B route
 * check through the in-process router (as qa-api.test.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { adminMembershipAllows, type AdminMembershipRecord } from '../../core/security/admin-authorization';
import { createAnswererRegistry } from './answerers';
import { checkEnvelope } from './envelope';
import { createQaRouter } from './qa.routes';
import { answerQuestion, type QaScopeStore } from './service';
import {
  SECURITY_FINDING_METADATA_COLUMNS,
  toFindingRow,
  type SecurityContext,
  type SecurityFindingRow,
} from './security-read';
import {
  comparisonAnswer, linkedAnswer, securityAnswer,
  computeS5, computeS6, computeS7, computeS8, computeS9, computeS10, computeS11,
  computeS12, computeS15, computeS17, computeS18, computeQ11,
} from './security-answerers';
import type { QaContext } from './answers/common';
import type { QaAnswerContext, QaEnvelope, QaFigure } from './types';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const REPO_A = '00000000-0000-4000-8000-0000000000a1';
const REPO_B = '00000000-0000-4000-8000-0000000000b1';
const MACHINE_A = '00000000-0000-4000-8000-0000000000c1';
const MACHINE_B = '00000000-0000-4000-8000-0000000000c2';
const PR_A = '00000000-0000-4000-8000-0000000000d1';
const SESSION_ID = '00000000-0000-4000-8000-0000000000e1';
const EXT_SESSION = 'ext-session-1';
const FROM = '2026-09-15T09:30:00.000Z';
const TO = '2026-10-15T09:30:00.000Z';
const NOW = '2026-10-15T09:30:00.000Z';

function finding(over: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    generation: 'task6a', ruleId: 'trackai.exec.reverse_shell', ruleCategory: 'execution',
    ruleSeverity: 'high', repositoryId: REPO_A, repositoryKind: 'enrolled', machineId: MACHINE_A,
    sessionId: EXT_SESSION, occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    rulePackVersion: 'rules-2026.10', agent: 'opencode', model: null, phase: 'requested',
    resultCategory: null, ...over,
  };
}

/** A Task6.a row, a Task6.a row with no session, and a v2 not_enrolled row. */
function securityContext(over: Partial<SecurityContext> = {}): SecurityContext {
  return {
    findings: [
      finding(),
      finding({ id: '00000000-0000-4000-8000-0000000000f2', ruleId: 'trackai.exec.download_pipe_shell',
        ruleSeverity: 'critical', sessionId: null, phase: 'observed_result' }),
      finding({ id: '00000000-0000-4000-8000-0000000000f3', generation: 'v2', ruleId: 'secret.read.aws_key',
        ruleCategory: 'secret', ruleSeverity: 'high', repositoryId: null, repositoryKind: 'not_enrolled',
        machineId: MACHINE_B, agent: 'claude', model: 'claude-3', phase: null,
        rulePackVersion: 'bundle:0123456789abcdef' }),
    ],
    enforcement: [
      { id: '00000000-0000-4000-8000-0000000000g1', decision: 'deny', machineId: MACHINE_B, occurredAt: new Date('2026-10-02T00:00:00.000Z') },
      { id: '00000000-0000-4000-8000-0000000000g2', decision: 'no_override', machineId: MACHINE_A, occurredAt: new Date('2026-10-02T00:00:00.000Z') },
    ],
    statusSnapshots: [{ id: '00000000-0000-4000-8000-0000000000h1', machineId: MACHINE_A, observedAt: new Date('2026-10-03T00:00:00.000Z') }],
    machinePlatforms: new Map([[MACHINE_A, 'macos'], [MACHINE_B, 'windows']]),
    sessions: [{ id: SESSION_ID, externalSessionId: EXT_SESSION, tool: 'opencode' }],
    ...over,
  };
}

/** A minimal Task2 context with one merged PR whose session is the finding's session. */
function codeContext(): QaContext {
  return {
    repositories: [{ id: REPO_A, name: 'repo-a' }],
    pullRequests: [{ id: PR_A, repositoryId: REPO_A, title: 'PR', state: 'merged', mergeCommitSha: null, mergedAt: new Date('2026-10-04T00:00:00.000Z') }],
    contributors: [],
    sessions: [{ id: SESSION_ID, externalSessionId: EXT_SESSION, tool: 'opencode', observedModels: [] }],
    sessionRepositories: [],
    usage: [],
    commits: [{ id: 'c1', repositoryId: REPO_A, sha: 'a'.repeat(40), subject: 'x', reachability: 'current',
      committedAt: new Date('2026-10-01T00:00:00.000Z'), observedAiLines: 0, observedHumanLines: 0 }],
    files: [],
    commitSessions: [{ commitId: 'c1', sessionId: SESSION_ID }],
    pullRequestCommits: [],
    generationObservations: [],
    lifecycleEvents: [],
    memberships: [{ pullRequestId: PR_A, commitId: 'c1', active: true }],
    commitLineage: [],
    mergeLineage: [],
    deployments: [],
    commitModelAttributions: [],
    modelLifecycleEvents: [],
    corrections: new Map(),
  } as unknown as QaContext;
}

function ctxFor(questionId: string, scopeLevel: QaAnswerContext['scopeLevel'], breakdown: QaAnswerContext['breakdown'] = null,
  scope: QaAnswerContext['scope'] = { from: FROM, to: TO }): QaAnswerContext {
  return { tenantId: A, questionId: questionId as QaAnswerContext['questionId'], kind: 'live', role: 'tenant_admin',
    scopeLevel, scope, breakdown, now: NOW };
}

const figureOf = (e: QaEnvelope, key: string): QaFigure => {
  const f = e.figures.find((x) => x.key === key);
  assert.ok(f, `figure ${key}`);
  return f;
};

describe('Task19c: no preview column is read', () => {
  test('the read module never names the preview table', () => {
    const source = readFileSync(`${__dirname}/security-read.ts`, 'utf8');
    assert.ok(!/securityFindingPreviews|security_finding_previews/.test(source.replace(/^\s*\*.*$/gm, '')), 'preview table not referenced in code');
  });

  test('the metadata allowlist excludes title, tags and every preview', () => {
    assert.deepEqual([...SECURITY_FINDING_METADATA_COLUMNS].sort(), [
      'agent', 'generation', 'id', 'machineId', 'model', 'occurredAt', 'phase', 'repositoryId',
      'repositoryKind', 'resultCategory', 'ruleCategory', 'ruleId', 'rulePackVersion', 'ruleSeverity', 'sessionId',
    ]);
    const row = toFindingRow({
      id: 'x', recordGeneration: 'v2', ruleId: 'r', ruleCategory: 'c', ruleSeverity: 'high',
      repositoryId: null, repositoryKind: 'not_enrolled', machineId: MACHINE_B, sessionId: null,
      occurredAt: new Date(NOW), rulePackVersion: 'bundle:0'.padEnd(23, '0'), sourceAgent: 'claude', model: 'm',
      agentFamily: null, phase: null, resultCategory: null,
      title: 'a command preview', tags: ['secret'], // must be dropped
    } as never);
    assert.deepEqual(Object.keys(row).sort(), [...SECURITY_FINDING_METADATA_COLUMNS].sort());
    assert.ok(!JSON.stringify(row).includes('a command preview'));
  });
});

describe('Task19c: S7 findings and previous', () => {
  test('tenant count, previous period, breakdowns, not_enrolled buckets as unknown', () => {
    const e = computeS7({ ctx: ctxFor('S7', 'tenant', 'repository'), security: securityContext(), previous: { ...securityContext(), findings: [] } });
    assert.equal(figureOf(e, 'findings').value && (figureOf(e, 'findings').value as { count: number }).count, 3);
    assert.deepEqual(figureOf(e, 'findings').breakdown, [
      { dimension: 'repository', key: REPO_A, value: { type: 'count', count: 2 } },
      { dimension: 'repository', key: 'unknown', value: { type: 'count', count: 1 } },
    ]);
    assert.equal(e.previous?.figures[0] && (e.previous.figures[0].value as { count: number }).count, 0);
    assert.equal(checkEnvelope(e, { questionId: 'S7', kind: 'live', scope: ctxFor('S7', 'tenant').scope, breakdown: 'repository' }).ok, true);
    const sev = computeS7({ ctx: ctxFor('S7', 'tenant', 'severity'), security: securityContext(), previous: { ...securityContext(), findings: [] } });
    assert.deepEqual(figureOf(sev, 'findings').breakdown, [
      { dimension: 'severity', key: 'critical', value: { type: 'count', count: 1 } },
      { dimension: 'severity', key: 'high', value: { type: 'count', count: 2 } },
    ]);
  });
});

describe('Task19c: S8/S9/S10/S11/S12/S17/S18', () => {
  const ctx = (id: string, breakdown: QaAnswerContext['breakdown']) => ctxFor(id, breakdown ? 'repository' : 'tenant', breakdown);

  test('S8 agent and unknown model buckets', () => {
    const agent = computeS8({ ctx: ctx('S8', 'agent_family'), security: securityContext() });
    assert.deepEqual(figureOf(agent, 'findings').breakdown, [
      { dimension: 'agent_family', key: 'claude', value: { type: 'count', count: 1 } },
      { dimension: 'agent_family', key: 'opencode', value: { type: 'count', count: 2 } },
    ]);
    const model = computeS8({ ctx: ctx('S8', 'model'), security: securityContext() });
    assert.deepEqual(figureOf(model, 'findings').breakdown, [
      { dimension: 'model', key: 'claude-3', value: { type: 'count', count: 1 } },
      { dimension: 'model', key: 'unknown', value: { type: 'count', count: 2 } },
    ]);
  });

  test('S9 platform: windows partial (not_monitored), missing platform unavailable, real value', () => {
    const e = computeS9({ ctx: ctx('S9', 'operating_system'), security: securityContext() });
    const f = figureOf(e, 'findings');
    assert.equal(f.availability, 'partial');
    assert.deepEqual(f.reasons, [{ code: 'not_monitored' }]);
    assert.deepEqual(f.value, { type: 'count', count: 3 });
    assert.deepEqual(f.breakdown, [
      { dimension: 'operating_system', key: 'macos', value: { type: 'count', count: 2 } },
      { dimension: 'operating_system', key: 'windows', value: { type: 'count', count: 1 } },
    ]);
    const none = computeS9({ ctx: ctx('S9', 'operating_system'), security: securityContext({ machinePlatforms: new Map() }) });
    assert.deepEqual(figureOf(none, 'findings').breakdown, [
      { dimension: 'operating_system', key: 'unavailable', value: { type: 'count', count: 3 } },
    ]);
  });

  test('S10 versions, reporting machines, up-to-date unavailable G7', () => {
    const e = computeS10({ ctx: ctx('S10', 'machine'), security: securityContext() });
    assert.deepEqual(figureOf(e, 'rule_pack_versions_in_force').value, { type: 'count', count: 2 });
    assert.deepEqual(figureOf(e, 'machines_reporting_status').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'machines_up_to_date').reasons, [{ code: 'not_captured_yet', gap: 'G7' }]);
    assert.equal(figureOf(e, 'rule_pack_versions_in_force').breakdown?.length, 2);
  });

  test('S11 requested, observed_result, v2_unclassified', () => {
    const e = computeS11({ ctx: ctx('S11', 'rule'), security: securityContext() });
    assert.deepEqual(figureOf(e, 'requested').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'observed_result').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'v2_unclassified').value, { type: 'count', count: 1 });
  });

  test('S12 denied_by_request real 0 or count, blocked unavailable, policy versions', () => {
    const e = computeS12({ ctx: ctx('S12', 'repository'), security: securityContext() });
    assert.deepEqual(figureOf(e, 'denied_by_request').value, { type: 'count', count: 1 });
    assert.equal(figureOf(e, 'blocked').availability, 'unavailable');
    assert.deepEqual(figureOf(e, 'blocked').reasons, [{ code: 'answer_not_built' }]);
    assert.deepEqual(figureOf(e, 'policy_versions').value, { type: 'count', count: 2 });
    const none = computeS12({ ctx: ctx('S12', null), security: securityContext({ enforcement: [] }) });
    assert.deepEqual(figureOf(none, 'denied_by_request').value, { type: 'count', count: 0 });
  });

  test('S17 machine buckets; team is honestly unavailable', () => {
    const e = computeS17({ ctx: ctx('S17', 'machine'), security: securityContext() });
    assert.equal(figureOf(e, 'findings').breakdown?.length, 2);
    assert.equal(e.availability, 'recorded');
    const team = computeS17({ ctx: ctx('S17', 'team'), security: securityContext() });
    assert.equal(team.availability, 'unavailable');
    assert.deepEqual(figureOf(team, 'findings').reasons, [{ code: 'answer_not_built' }]);
  });

  test('S18 rule buckets and noisy rules G13', () => {
    const e = computeS18({ ctx: ctxFor('S18', 'tenant', 'rule'), security: securityContext() });
    assert.equal(figureOf(e, 'findings').breakdown?.length, 3);
    assert.deepEqual(figureOf(e, 'noisy_rules').reasons, [{ code: 'not_captured_yet', gap: 'G13' }]);
  });

  test('repository scope cuts findings to that repository and its machines', () => {
    const scope = { from: FROM, to: TO, repository_id: REPO_A };
    const s8 = computeS8({ ctx: ctxFor('S8', 'repository', null, scope), security: securityContext() });
    assert.deepEqual(figureOf(s8, 'findings').value, { type: 'count', count: 2 });
    const s12 = computeS12({ ctx: ctxFor('S12', 'repository', null, scope), security: securityContext() });
    assert.deepEqual(figureOf(s12, 'denied_by_request').value, { type: 'count', count: 0 });
    assert.deepEqual(figureOf(s12, 'policy_versions').value, { type: 'count', count: 1 });
    const s5 = computeS5({ ctx: ctxFor('S5', 'repository', null, scope), security: securityContext() });
    assert.deepEqual(figureOf(s5, 'findings_with_session').value, { type: 'count', count: 1 });
  });
});

describe('Task19c: S5/S6/Q11 session link', () => {
  test('S5 counts sessions on findings, chain unavailable G10', () => {
    const e = computeS5({ ctx: ctxFor('S5', 'tenant'), security: securityContext() });
    assert.deepEqual(figureOf(e, 'findings_with_session').value, { type: 'count', count: 2 });
    assert.deepEqual(figureOf(e, 'linked_sessions').value, { type: 'count', count: 1 });
    assert.deepEqual(figureOf(e, 'commits_and_pull_requests').reasons, [{ code: 'not_captured_yet', gap: 'G10' }]);
    assert.equal(e.wording.includes('session_link_partial'), true);
  });

  test('S6 high/critical findings whose session reached a merged PR', () => {
    const e = computeS6({ ctx: ctxFor('S6', 'tenant', 'severity'), security: securityContext(), context: codeContext() });
    assert.deepEqual(figureOf(e, 'high_or_critical_sessions_merged').value, { type: 'count', count: 2 });
    assert.deepEqual(figureOf(e, 'high_or_critical_sessions_merged').breakdown, [
      { dimension: 'severity', key: 'high', value: { type: 'count', count: 2 } },
    ]);
  });

  test('Q11 findings in linked sessions, by repository', () => {
    const e = computeQ11({ ctx: ctxFor('Q11', 'tenant', 'repository'), security: securityContext(), context: codeContext() });
    assert.deepEqual(figureOf(e, 'findings_in_linked_sessions').value, { type: 'count', count: 2 });
    assert.equal(e.wording.includes('monitor_only_observed'), true);
    assert.equal(e.wording.includes('session_link_partial'), true);
  });

  test('S15 audit reads is link-only', () => {
    const e = computeS15({ ctx: ctxFor('S15', 'tenant'), security: securityContext() });
    assert.equal(e.availability, 'unavailable');
    assert.deepEqual(figureOf(e, 'audit_reads').reasons, [{ code: 'answer_not_built' }]);
    assert.deepEqual(e.drilldown, []);
    assert.equal(e.signed_evidence, undefined);
  });
});

// --- The full service sweep and Company A/B through the router ---

const scopes: QaScopeStore = {
  async repositoryExists(_t, id) { return id === REPO_A; },
  async pullRequestRepository(_t, id) { return id === PR_A ? REPO_A : null; },
  async commitExists() { return true; },
};

function registrations(load: (tenantId: string) => Promise<SecurityContext>, code: () => Promise<QaContext>) {
  const answerers = createAnswererRegistry();
  answerers.register('S5', 'live', linkedAnswer(computeS5, async (t) => load(t), code));
  answerers.register('S6', 'live', linkedAnswer(computeS6, async (t) => load(t), code));
  answerers.register('S7', 'live', comparisonAnswer(computeS7, async (t) => load(t)));
  answerers.register('S8', 'live', securityAnswer(computeS8, async (t) => load(t)));
  answerers.register('S9', 'live', securityAnswer(computeS9, async (t) => load(t)));
  answerers.register('S10', 'live', securityAnswer(computeS10, async (t) => load(t)));
  answerers.register('S11', 'live', securityAnswer(computeS11, async (t) => load(t)));
  answerers.register('S12', 'live', securityAnswer(computeS12, async (t) => load(t)));
  answerers.register('S15', 'live', securityAnswer(computeS15, async (t) => load(t)));
  answerers.register('S17', 'live', securityAnswer(computeS17, async (t) => load(t)));
  answerers.register('S18', 'live', securityAnswer(computeS18, async (t) => load(t)));
  answerers.register('Q11', 'live', linkedAnswer(computeQ11, async (t) => load(t), code));
  return answerers;
}

describe('Task19c: every registered answer validates through the service', () => {
  test('all twelve answerers answer for each offered scope and breakdown', async () => {
    const answerers = registrations(async () => securityContext(), async () => codeContext());
    const base = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const cases: Array<[string, string]> = [
      ['S5', 'kind=live'], ['S6', 'kind=live'], ['S7', 'kind=live'],
      ['S8', 'kind=live'], ['S8', 'kind=live&breakdown=agent_family'], ['S8', 'kind=live&breakdown=model'],
      ['S9', 'kind=live'], ['S9', 'kind=live&breakdown=operating_system'], ['S9', 'kind=live&breakdown=rule_category'],
      ['S10', `kind=live&repository_id=${REPO_A}`], ['S10', `kind=live&repository_id=${REPO_A}&breakdown=machine`],
      ['S11', `kind=live&repository_id=${REPO_A}&breakdown=rule`], ['S12', `kind=live&breakdown=repository`],
      ['S15', 'kind=live'], ['S17', 'kind=live&breakdown=machine'], ['S17', 'kind=live&breakdown=team'],
      ['S18', 'kind=live&breakdown=rule'],
      ['Q11', 'kind=live'], ['Q11', 'kind=live&breakdown=rule_category'],
      ['Q11', `kind=live&repository_id=${REPO_A}&breakdown=repository`],
    ];
    for (const [id, params] of cases) {
      const query = Object.fromEntries(new URLSearchParams(`${params}&${base}`).entries());
      const envelope = await answerQuestion({ answerers, scopes }, { tenantId: A, role: 'tenant_admin', questionId: id, query, now: new Date(NOW) });
      assert.equal(envelope.question_id, id, `${id} ${params}`);
      assert.equal(checkEnvelope(envelope).ok, true, `${id} ${params} valid`);
    }
  });
});

describe('Task19c: Company A and Company B see only their own findings', () => {
  const member = (tenantId: string, subject: string): AdminMembershipRecord =>
    ({ tenantId, subject, role: 'tenant_admin', status: 'active', revokedAt: null });
  const authorize: RequestHandler = async (req, res, next) => {
    const tenantId = req.get('x-test-tenant');
    const subject = req.get('x-test-sub');
    if (!tenantId || !subject || !adminMembershipAllows(member(tenantId, subject), { tenantId, subject, action: 'qa.read' })) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    req.tenantId = tenantId;
    req.user = { sub: subject } as Express.AuthenticatedUser;
    req.adminRole = 'tenant_admin';
    next();
  };

  test('each tenant gets its own count through the real router', async () => {
    const load = async (tenantId: string) => tenantId === A
      ? securityContext()
      : securityContext({ findings: [finding({ id: 'b1', repositoryId: REPO_B, sessionId: null, ruleSeverity: 'high' })] });
    const router = createQaRouter({
      authorize, scopes, answerers: registrations(load, async () => codeContext()),
      log: () => undefined, now: () => new Date(NOW),
    });
    const app = express();
    app.use('/api/qa', router);
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/qa`;
    const get = async (tenant: string, sub: string) => {
      const res = await fetch(`${url}/questions/S7/answer?kind=live&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
        { headers: { 'x-test-tenant': tenant, 'x-test-sub': sub } });
      return { status: res.status, body: await res.json() as QaEnvelope };
    };
    try {
      const a = await get(A, 'admin-a');
      const b = await get(B, 'admin-b');
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200);
      assert.equal((a.body.figures[0].value as { count: number }).count, 3);
      assert.equal((b.body.figures[0].value as { count: number }).count, 1);
      assert.equal(checkEnvelope(a.body).ok, true);
      assert.equal(checkEnvelope(b.body).ok, true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
