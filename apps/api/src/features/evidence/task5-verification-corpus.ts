/**
 * Deterministic, synthetic Task5 acceptance corpus.
 *
 * This file contains identities and safe metadata only. Raw prompts, responses,
 * tool payloads and redaction sentinels are created at runtime by the live
 * verifier so no reusable secret-like value is committed to the repository.
 */

export const TASK5_CORPUS_ID = 'task5-password-recovery-v1';

export const task5VerificationCorpus = {
  tenants: {
    primary: 'task5-alpha.example.invalid',
    isolated: 'task5-beta.example.invalid',
  },
  repository: {
    externalId: 'trackai/task5-verification',
    name: 'task5-verification',
    url: 'https://example.invalid/trackai/task5-verification.git',
  },
  pullRequests: [
    {
      key: 'recovery', number: 104, title: 'Prevent duplicate password recovery token use',
      branch: 'feature/recovery-token-race', outcome: 'merged',
      activeCommits: ['recovery-guard', 'recovery-test', 'recovery-observe'],
      historicalCommits: ['recovery-first-draft'],
    },
    {
      key: 'refresh', number: 98, title: 'Serialize concurrent session refreshes',
      branch: 'fix/session-refresh-lock', outcome: 'deployed',
      activeCommits: ['refresh-lock'], historicalCommits: [],
    },
    {
      key: 'design-token', number: 87, title: 'Rename dashboard colour tokens',
      branch: 'chore/design-token-names', outcome: 'merged',
      activeCommits: ['design-token-rename'], historicalCommits: [],
    },
  ],
  commits: [
    { key: 'recovery-first-draft', sha: '5100000000000000000000000000000000000001', subject: 'Draft recovery token guard' },
    { key: 'recovery-guard', sha: '5100000000000000000000000000000000000002', subject: 'Guard one-time recovery tokens' },
    { key: 'recovery-test', sha: '5100000000000000000000000000000000000003', subject: 'Test concurrent recovery requests' },
    { key: 'recovery-observe', sha: '5100000000000000000000000000000000000004', subject: 'Add safe recovery conflict telemetry' },
    { key: 'refresh-lock', sha: '5100000000000000000000000000000000000005', subject: 'Serialize refresh token rotation' },
    { key: 'design-token-rename', sha: '5100000000000000000000000000000000000006', subject: 'Rename dashboard colour tokens' },
    { key: 'direct-runbook', sha: '5100000000000000000000000000000000000007', subject: 'Document recovery rollback procedure' },
  ],
  sessions: [
    {
      key: 'recovery-build', externalId: 'task5-session-recovery-build',
      gitAiSessionId: 's_task5_recovery_build', status: 'shipped',
      commits: ['recovery-guard', 'recovery-test'],
    },
    {
      key: 'recovery-review', externalId: 'task5-session-recovery-review',
      gitAiSessionId: 's_task5_recovery_review', status: 'shipped',
      commits: ['recovery-test', 'recovery-observe'],
    },
    {
      key: 'refresh-build', externalId: 'task5-session-refresh-build',
      gitAiSessionId: 's_task5_refresh_build', status: 'shipped', commits: ['refresh-lock'],
    },
    {
      key: 'design-token-build', externalId: 'task5-session-design-token-build',
      gitAiSessionId: 's_task5_design_token_build', status: 'shipped', commits: ['design-token-rename'],
    },
    {
      key: 'direct-doc', externalId: 'task5-session-direct-doc',
      gitAiSessionId: 's_task5_direct_doc', status: 'shipped', commits: ['direct-runbook'],
    },
    {
      key: 'abandoned-recovery', externalId: 'task5-session-abandoned-recovery',
      gitAiSessionId: 's_task5_abandoned_recovery', status: 'abandoned', commits: [],
    },
  ],
  intentions: [
    {
      key: 'recovery-v1', series: 'recovery-safety', version: 1, current: false,
      session: 'recovery-build', state: 'inferred', lifecycle: 'provisional',
      text: 'Make password recovery safer.',
    },
    {
      key: 'recovery-v2', series: 'recovery-safety', version: 2, current: true,
      session: 'recovery-build', state: 'corrected', lifecycle: 'finalized',
      text: 'Prevent a recovery token from being consumed twice by concurrent requests.',
    },
    {
      key: 'recovery-observability', series: 'recovery-observability', version: 1, current: true,
      session: 'recovery-review', state: 'observed', lifecycle: 'finalized',
      text: 'Record safe evidence when concurrent password recovery requests conflict.',
    },
    {
      key: 'refresh-race', series: 'refresh-race', version: 1, current: true,
      session: 'refresh-build', state: 'observed', lifecycle: 'finalized',
      text: 'Stop concurrent session refresh requests from rotating the same credential twice.',
    },
    {
      key: 'design-token', series: 'design-token', version: 1, current: true,
      session: 'design-token-build', state: 'observed', lifecycle: 'finalized',
      text: 'Rename dashboard colour design tokens without changing authentication.',
    },
    {
      key: 'unfinished', series: 'unfinished-recovery', version: 1, current: true,
      session: 'abandoned-recovery', state: 'inferred', lifecycle: 'abandoned',
      text: 'Investigate recovery latency under regional failover.',
    },
  ],
  evidenceScenarios: [
    { key: 'prompt-loop-1', session: 'recovery-build', type: 'prompt', trace: 't_recovery_guard', availability: 'available' },
    { key: 'prompt-loop-2', session: 'recovery-build', type: 'prompt', trace: 't_recovery_guard', availability: 'available' },
    { key: 'test-failed', session: 'recovery-build', type: 'tool_result', trace: 't_recovery_guard', tool: 'npm', status: 'failed', attempt: 1 },
    { key: 'test-retry', session: 'recovery-build', type: 'tool_call', trace: 't_recovery_guard', tool: 'npm', status: 'started', attempt: 2 },
    { key: 'test-passed', session: 'recovery-build', type: 'tool_result', trace: 't_recovery_guard', tool: 'npm', status: 'passed', attempt: 2 },
    { key: 'slow-test', session: 'recovery-review', type: 'tool_result', trace: 't_recovery_test', tool: 'playwright', status: 'passed', durationMs: 42_000 },
    { key: 'redacted-tool', session: 'recovery-review', type: 'tool_call', trace: 't_recovery_observe', tool: 'curl', availability: 'redacted' },
    { key: 'reasoning-gap', session: 'recovery-review', type: 'reasoning', trace: 't_recovery_observe', availability: 'unavailable' },
  ],
  fileEvidence: [
    {
      commit: 'recovery-guard', path: 'src/auth/recovery.ts',
      range: { startLine: 41, endLine: 58, traceId: 't_recovery_guard', checkpointId: 'cp_recovery_guard' },
    },
    {
      commit: 'recovery-test', path: 'tests/auth/recovery.test.ts',
      range: { startLine: 70, endLine: 103, traceId: 't_recovery_test', checkpointId: 'cp_recovery_test' },
    },
    {
      commit: 'recovery-test', path: 'src/auth/recovery.ts',
      range: { startLine: 60, endLine: 68, traceId: 't_recovery_review', checkpointId: 'cp_recovery_review' },
    },
  ],
  missingAttribution: { commit: 'recovery-observe', path: 'src/auth/recovery-metrics.ts', line: 19 },
  searchCases: {
    semanticQuery: 'authentication credential race condition',
    relevantIntentions: ['recovery-v2', 'refresh-race'],
    hardNegatives: ['design-token'],
    exactQueries: ['104', 'feature/recovery-token-race', '5100000', 'src/auth/recovery.ts', 'playwright'],
  },
  isolatedTenantIntention: 'Prevent a recovery token from being consumed twice by concurrent requests.',
  gates: {
    'E5-1': ['sessions'], 'E5-2': ['sessions', 'fileEvidence', 'evidenceScenarios'],
    'E5-3': ['tenants', 'evidenceScenarios'], 'E5-4': ['evidenceScenarios'],
    'E5-5': ['pullRequests', 'commits', 'sessions'], 'E5-6': ['pullRequests', 'fileEvidence'],
    'E5-7': ['evidenceScenarios', 'intentions'], 'E5-8': ['fileEvidence', 'missingAttribution'],
    'E5-9': ['intentions', 'searchCases', 'isolatedTenantIntention'],
    'E5-10': ['intentions', 'evidenceScenarios'], 'E5-11': ['commits'],
    'E5-12': ['pullRequests', 'intentions', 'evidenceScenarios', 'fileEvidence'],
  },
} as const;

export function validateTask5VerificationCorpus() {
  const corpus = task5VerificationCorpus;
  const commitKeys = new Set(corpus.commits.map(row => row.key));
  const sessionKeys = new Set(corpus.sessions.map(row => row.key));
  const intentionKeys = new Set(corpus.intentions.map(row => row.key));
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };

  check(String(corpus.tenants.primary) !== String(corpus.tenants.isolated), 'verification tenants must be distinct');
  check(corpus.sessions.some(row => row.commits.length === 0), 'a zero-commit session is required');
  check(corpus.sessions.some(row => row.commits.length === 1), 'a one-commit session is required');
  check(corpus.sessions.some(row => row.commits.length > 1), 'a multi-commit session is required');
  for (const session of corpus.sessions) {
    for (const commit of session.commits) check(commitKeys.has(commit), `unknown session commit: ${commit}`);
  }
  const sessionsPerCommit = new Map<string, number>();
  for (const session of corpus.sessions) for (const commit of session.commits) {
    sessionsPerCommit.set(commit, (sessionsPerCommit.get(commit) ?? 0) + 1);
  }
  check([...sessionsPerCommit.values()].some(count => count > 1), 'a multi-session commit is required');
  for (const pr of corpus.pullRequests) {
    for (const commit of [...pr.activeCommits, ...pr.historicalCommits]) {
      check(commitKeys.has(commit), `unknown pull-request commit: ${commit}`);
    }
  }
  for (const intention of corpus.intentions) {
    check(!intention.session || sessionKeys.has(intention.session), `unknown intention session: ${intention.session}`);
  }
  const recoveryVersions = corpus.intentions.filter(row => row.series === 'recovery-safety');
  check(recoveryVersions.length === 2, 'a corrected intention series requires two versions');
  check(recoveryVersions.filter(row => row.current).length === 1, 'an intention series requires one current version');
  check(corpus.evidenceScenarios.some(row => 'status' in row && row.status === 'failed'), 'a failed tool result is required');
  check(corpus.evidenceScenarios.some(row => 'attempt' in row && row.attempt === 2), 'a tool retry is required');
  check(corpus.evidenceScenarios.some(row => 'durationMs' in row && row.durationMs > 30_000), 'a slow tool is required');
  check(corpus.evidenceScenarios.some(row => 'availability' in row && row.availability === 'unavailable'), 'unavailable evidence is required');
  check(corpus.evidenceScenarios.some(row => 'availability' in row && row.availability === 'redacted'), 'redacted evidence is required');
  check(corpus.fileEvidence.length > 0 && Boolean(corpus.missingAttribution), 'exact and missing attribution are required');
  for (const key of [...corpus.searchCases.relevantIntentions, ...corpus.searchCases.hardNegatives]) {
    check(intentionKeys.has(key), `unknown search intention: ${key}`);
  }
  check(Object.keys(corpus.gates).length === 12, 'all E5-1 through E5-12 gates must be mapped');
  if (failures.length) throw new Error(`Invalid Task5 verification corpus:\n- ${failures.join('\n- ')}`);
  return {
    corpusId: TASK5_CORPUS_ID,
    pullRequests: corpus.pullRequests.length,
    commits: corpus.commits.length,
    sessions: corpus.sessions.length,
    intentions: corpus.intentions.length,
    evidenceScenarios: corpus.evidenceScenarios.length,
    gates: Object.keys(corpus.gates).length,
  };
}
