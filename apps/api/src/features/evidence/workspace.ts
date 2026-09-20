import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCodeLifecycleEvents,
  aiCommitSessions,
  aiSessions,
  evidenceEventContents,
  evidenceEvents,
  evidenceIntentions,
  scmCommitFiles,
  scmCommits,
  scmDeployments,
  scmPullRequestCommitMemberships,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
} from '../../core/db/schema';
import { decryptEnvelope, type EncryptedValue } from '../../core/security/envelope-encryption';
import { evidenceGraph, frictionAnalytics, searchIntentions } from './service';

type EvidenceState = 'observed' | 'inferred' | 'corrected';
type Coverage = 'recorded' | 'partial' | 'unavailable';
type WorkKind = 'pull_request' | 'direct_commit' | 'unfinished_intention';
type RootKind = 'pull_request' | 'commit' | 'intention' | 'code';

export type WorkCard = {
  kind: WorkKind;
  id: string;
  title: string;
  repository: { id: string; name: string } | null;
  branch: string | null;
  outcome: 'open' | 'merged' | 'deployed' | 'closed' | 'direct_change' | 'unfinished';
  updatedAt: string;
  intention: { text: string | null; count: number; state: EvidenceState | null };
  keyInsight: string;
  evidenceQuality: {
    attribution: Coverage;
    intention: Coverage;
    rawContent: Coverage;
    lifecycle: Coverage;
  };
  counts: { commits: number; reworkedLines: number; evidenceGaps: number };
};

export type WorkStory = {
  root: { type: RootKind; id: string; title: string; repository: string | null; branch: string | null };
  summary: {
    why: { primary: string | null; additional: number; state: EvidenceState | null; confidence: number | null };
    outcome: { status: WorkCard['outcome']; label: string };
    keyInsight: string;
    evidenceQuality: WorkCard['evidenceQuality'];
  };
  intentions: Array<{
    id: string; text: string; state: EvidenceState; confidence: number;
    lifecycle: 'provisional' | 'finalized' | 'abandoned'; sessionId: string | null;
  }>;
  lifecycle: {
    pullRequest: null | { id: string; title: string; state: string; headRef: string | null; baseRef: string | null };
    merge: null | { sha: string; mergedAt: string | null };
    deployments: Array<{ id: string; environment: string; status: string; production: boolean; deployedAt: string }>;
  };
  changes: Array<{
    id: string; sha: string; subject: string; branch: string | null; historical: boolean;
    files: Array<{
      id: string; path: string; aiLines: number; humanLines: number; unknownLines: number;
      ranges: Array<Record<string, unknown>>;
    }>;
  }>;
  insights: {
    failedTools: number; retries: number; slowTools: number; promptLoops: number;
    reworkedLines: number; abandoned: boolean; evidenceGaps: number;
    tests: Array<{ eventId: string; label: string; status: 'passed' | 'failed' | 'unknown' }>;
    unresolved: string[];
  };
  graph: {
    root: { type: string; id: string };
    nodes: Awaited<ReturnType<typeof evidenceGraph>>['nodes'];
    edges: Awaited<ReturnType<typeof evidenceGraph>>['edges'];
    nextCursor: number | null;
  };
  similarWork: { status: 'available' | 'unavailable'; items: WorkCard[] };
  focus: null | { path: string; line: number; attribution: 'exact' | 'missing'; traceIds: string[] };
};

type Records = Awaited<ReturnType<typeof loadRecords>>;

function openValue<T>(
  value: Record<string, unknown>, tenantId: string, purpose: string, resourceId: string,
): T {
  return JSON.parse(decryptEnvelope(value as unknown as EncryptedValue, {
    tenantId, purpose, resourceId,
  })) as T;
}

function ranges(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item !== null && typeof item === 'object') as Array<Record<string, unknown>>
    : [];
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asText).join(' ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(asText).join(' ');
  return '';
}

export function isTestCommand(value: unknown): boolean {
  return /(^|\s)(npm|pnpm|yarn|bun|cargo|go|task|make|pytest|python\s+-m\s+pytest|rspec|dotnet)\s+(run\s+)?test\b|\b(test|vitest|jest|playwright|cypress)\b/i
    .test(asText(value));
}

async function loadRecords(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [repositories, pullRequests, legacyPrLinks, memberships, commits, files, commitSessions,
    sessions, intentions, events, contents, rework, deployments] = await Promise.all([
    tenantDb.select(scmRepositories),
    tenantDb.select(scmPullRequests),
    tenantDb.select(scmPullRequestCommits),
    tenantDb.select(scmPullRequestCommitMemberships),
    tenantDb.select(scmCommits),
    tenantDb.select(scmCommitFiles),
    tenantDb.select(aiCommitSessions),
    tenantDb.select(aiSessions),
    tenantDb.select(evidenceIntentions),
    tenantDb.select(evidenceEvents),
    tenantDb.select(evidenceEventContents),
    tenantDb.select(aiCodeLifecycleEvents),
    tenantDb.select(scmDeployments),
  ]);
  return { repositories, pullRequests, legacyPrLinks, memberships, commits, files, commitSessions,
    sessions, intentions, events, contents, rework, deployments };
}

export function currentPullRequestCommitIds(
  memberships: Array<{ pullRequestId: string; commitId: string; active: boolean }>,
  legacyLinks: Array<{ pullRequestId: string; commitId: string }>,
  pullRequestId: string,
): string[] {
  const temporal = memberships.filter(row => row.pullRequestId === pullRequestId);
  return temporal.length
    ? temporal.filter(row => row.active).map(row => row.commitId)
    : legacyLinks.filter(row => row.pullRequestId === pullRequestId).map(row => row.commitId);
}

function currentCommitIds(records: Records, pullRequestId: string): string[] {
  return currentPullRequestCommitIds(records.memberships, records.legacyPrLinks, pullRequestId);
}

function historicalCommitIds(records: Records, pullRequestId: string): string[] {
  return records.memberships.filter(row => row.pullRequestId === pullRequestId && !row.active)
    .map(row => row.commitId);
}

function prForCommit(records: Records, commitId: string) {
  return records.pullRequests.find(pr => currentCommitIds(records, pr.id).includes(commitId)) ?? null;
}

function sessionsForCommits(records: Records, commitIds: string[]): string[] {
  const wanted = new Set(commitIds);
  return [...new Set(records.commitSessions.filter(row => wanted.has(row.commitId)).map(row => row.sessionId))];
}

function currentIntentions(records: Records, sessionIds: string[]) {
  const wanted = new Set(sessionIds);
  return records.intentions.filter(row => row.isCurrent && row.sessionId && wanted.has(row.sessionId));
}

function intentionText(tenantId: string, intention: Records['intentions'][number]): string | null {
  if (intention.expiresAt <= new Date()) return null;
  return openValue<string>(intention.encryptedValue, tenantId, 'evidence-intention', intention.id);
}

function coverageFor(records: Records, commitIds: string[], sessionIds: string[], intentionCount: number) {
  const linkedCommits = new Set(records.commitSessions.filter(row => sessionIds.includes(row.sessionId)).map(row => row.commitId));
  const relevantEvents = records.events.filter(row => sessionIds.includes(row.sessionId));
  const available = relevantEvents.filter(row => row.availability === 'available' || row.availability === 'redacted').length;
  const attribution: Coverage = !commitIds.length ? 'unavailable'
    : commitIds.every(id => linkedCommits.has(id)) ? 'recorded'
      : linkedCommits.size ? 'partial' : 'unavailable';
  return {
    attribution,
    intention: (intentionCount ? 'recorded' : 'unavailable') as Coverage,
    rawContent: (available && available === relevantEvents.length ? 'recorded'
      : available ? 'partial' : 'unavailable') as Coverage,
    lifecycle: 'recorded' as Coverage,
  };
}

function outcomeFor(records: Records, pullRequest: Records['pullRequests'][number] | null, commitIds: string[]) {
  const shas = new Set(records.commits.filter(row => commitIds.includes(row.id)).map(row => row.sha));
  if (pullRequest?.mergeCommitSha) shas.add(pullRequest.mergeCommitSha);
  const deployed = records.deployments.some(row => shas.has(row.sha) && row.status === 'success');
  if (deployed) return 'deployed' as const;
  if (!pullRequest) return 'direct_change' as const;
  if (pullRequest.state === 'merged' || pullRequest.mergedAt) return 'merged' as const;
  if (pullRequest.state === 'open') return 'open' as const;
  return 'closed' as const;
}

function sessionFriction(
  rows: Array<Record<string, unknown>>, sessionIds: string[], records: Records,
) {
  const wanted = new Set(sessionIds);
  const selected = rows.filter(row => wanted.has(String(row.sessionId)));
  const sum = (key: string) => selected.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const gaps = records.events.filter(row => wanted.has(row.sessionId) && row.availability !== 'available').length;
  return {
    failedTools: sum('failedToolCalls'), retries: sum('retries'), slowTools: sum('slowToolCalls'),
    promptLoops: sum('promptLoops'), reworkedLines: sum('reworkedLines'),
    abandoned: selected.some(row => Boolean(row.abandoned)), evidenceGaps: gaps,
  };
}

export function keyInsight(values: ReturnType<typeof sessionFriction>) {
  if (values.failedTools) return `${values.failedTools} failed tool operation${values.failedTools === 1 ? '' : 's'} ${values.failedTools === 1 ? 'needs' : 'need'} review.`;
  if (values.slowTools) return `${values.slowTools} slow tool operation${values.slowTools === 1 ? '' : 's'} affected this work.`;
  if (values.reworkedLines) return `${values.reworkedLines} attributed line${values.reworkedLines === 1 ? '' : 's'} were reworked.`;
  if (values.evidenceGaps) return `${values.evidenceGaps} evidence item${values.evidenceGaps === 1 ? ' is' : 's are'} unavailable, redacted or expired.`;
  return 'No material workflow friction was observed in the available evidence.';
}

function cardForPr(
  tenantId: string, records: Records, friction: Array<Record<string, unknown>>,
  pr: Records['pullRequests'][number],
): WorkCard {
  const commitIds = currentCommitIds(records, pr.id);
  const sessionIds = sessionsForCommits(records, commitIds);
  const intentions = currentIntentions(records, sessionIds);
  const primary = intentions.map(row => ({ row, text: intentionText(tenantId, row) })).find(row => row.text);
  const values = sessionFriction(friction, sessionIds, records);
  const repository = records.repositories.find(row => row.id === pr.repositoryId);
  return {
    kind: 'pull_request', id: pr.id, title: pr.title,
    repository: repository ? { id: repository.id, name: repository.name } : null,
    branch: pr.headRef, outcome: outcomeFor(records, pr, commitIds), updatedAt: pr.updatedAt.toISOString(),
    intention: { text: primary?.text ?? null, count: intentions.length, state: primary?.row.evidenceState ?? null },
    keyInsight: keyInsight(values),
    evidenceQuality: coverageFor(records, commitIds, sessionIds, intentions.length),
    counts: { commits: commitIds.length, reworkedLines: values.reworkedLines, evidenceGaps: values.evidenceGaps },
  };
}

function cardForCommit(
  tenantId: string, records: Records, friction: Array<Record<string, unknown>>,
  commit: Records['commits'][number],
): WorkCard {
  const sessionIds = sessionsForCommits(records, [commit.id]);
  const intentions = currentIntentions(records, sessionIds);
  const primary = intentions.map(row => ({ row, text: intentionText(tenantId, row) })).find(row => row.text);
  const values = sessionFriction(friction, sessionIds, records);
  const repository = records.repositories.find(row => row.id === commit.repositoryId);
  return {
    kind: 'direct_commit', id: commit.id, title: commit.subject,
    repository: repository ? { id: repository.id, name: repository.name } : null,
    branch: commit.branch, outcome: 'direct_change',
    updatedAt: (commit.committedAt ?? commit.updatedAt).toISOString(),
    intention: { text: primary?.text ?? null, count: intentions.length, state: primary?.row.evidenceState ?? null },
    keyInsight: keyInsight(values),
    evidenceQuality: coverageFor(records, [commit.id], sessionIds, intentions.length),
    counts: { commits: 1, reworkedLines: values.reworkedLines, evidenceGaps: values.evidenceGaps },
  };
}

function cardForIntention(
  tenantId: string, records: Records, friction: Array<Record<string, unknown>>,
  intention: Records['intentions'][number],
): WorkCard {
  const sessionIds = intention.sessionId ? [intention.sessionId] : [];
  const values = sessionFriction(friction, sessionIds, records);
  const text = intentionText(tenantId, intention);
  return {
    kind: 'unfinished_intention', id: intention.id, title: text ?? 'Unavailable intention',
    repository: null, branch: null, outcome: 'unfinished', updatedAt: intention.createdAt.toISOString(),
    intention: { text, count: 1, state: intention.evidenceState }, keyInsight: keyInsight(values),
    evidenceQuality: {
      attribution: 'unavailable', intention: text ? 'recorded' : 'unavailable',
      rawContent: coverageFor(records, [], sessionIds, 1).rawContent, lifecycle: 'unavailable',
    },
    counts: { commits: 0, reworkedLines: values.reworkedLines, evidenceGaps: values.evidenceGaps },
  };
}

export async function evidenceWorkspace(tenantId: string, input: { cursor?: number; limit?: number } = {}) {
  const records = await loadRecords(tenantId);
  const friction = await frictionAnalytics(tenantId) as Array<Record<string, unknown>>;
  const mapped = new Set(records.pullRequests.flatMap(pr => currentCommitIds(records, pr.id)));
  const linkedSessions = new Set(records.commitSessions.map(row => row.sessionId));
  const pullRequests = records.pullRequests.map(pr => cardForPr(tenantId, records, friction, pr))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const directChanges = records.commits.filter(commit => !mapped.has(commit.id))
    .map(commit => cardForCommit(tenantId, records, friction, commit))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unfinishedWork = records.intentions.filter(row => row.isCurrent && (!row.sessionId || !linkedSessions.has(row.sessionId)))
    .map(row => cardForIntention(tenantId, records, friction, row))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cursor = Math.max(0, input.cursor ?? 0);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const page = <T>(values: T[]) => ({
    items: values.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < values.length ? cursor + limit : null,
    total: values.length,
  });
  const all = [...pullRequests, ...directChanges, ...unfinishedWork];
  return {
    insights: {
      outcomes: `${pullRequests.filter(row => row.outcome === 'merged' || row.outcome === 'deployed').length} of ${pullRequests.length} PRs merged or deployed`,
      attention: all.filter(row => !row.keyInsight.startsWith('No material')).length,
      evidenceGaps: all.reduce((total, row) => total + row.counts.evidenceGaps, 0),
    },
    pullRequests: page(pullRequests), directChanges: page(directChanges), unfinishedWork: page(unfinishedWork),
  };
}

function mergeGraphs(graphs: Array<Awaited<ReturnType<typeof evidenceGraph>>>, root: { type: string; id: string }) {
  const nodes = new Map<string, Awaited<ReturnType<typeof evidenceGraph>>['nodes'][number]>();
  const edges = new Map<string, Awaited<ReturnType<typeof evidenceGraph>>['edges'][number]>();
  graphs.forEach(graph => {
    graph.nodes.forEach(node => nodes.set(`${node.type}:${node.id}`, node));
    graph.edges.forEach(edge => edges.set([
      edge.fromType, edge.fromId, edge.toType, edge.toId, edge.relationship,
    ].join(':'), edge));
  });
  return { root, nodes: [...nodes.values()], edges: [...edges.values()], nextCursor: null };
}

export function exactRangeTraceIds(edges: Array<{
  fromType: string; relationship: string; toType: string; toId: string;
}>): string[] {
  return edges.filter(edge => edge.fromType === 'code_range'
    && edge.relationship === 'attributed_to' && edge.toType === 'trace').map(edge => edge.toId);
}

async function testSignals(tenantId: string, records: Records, sessionIds: string[]) {
  const wanted = new Set(sessionIds);
  const events = records.events.filter(row => wanted.has(row.sessionId));
  const contentByEvent = new Map(records.contents.map(row => [row.eventId, row]));
  const tests: WorkStory['insights']['tests'] = [];
  for (const event of events.filter(row => row.eventType === 'tool_call')) {
    const content = contentByEvent.get(event.id);
    if (!content) continue;
    const raw = openValue<unknown>(content.encryptedValue, tenantId, 'evidence-event', event.id);
    if (!isTestCommand(raw)) continue;
    const result = events.find(row => row.providerEventId === event.providerEventId.replace(/:call$/, ':result'));
    const status = result?.metadata?.status;
    tests.push({
      eventId: event.id,
      label: `${event.toolName ?? 'Tool'} test command`,
      status: status === 'failed' || status === 'error' ? 'failed' : result ? 'passed' : 'unknown',
    });
  }
  return tests;
}

export async function evidenceWorkStory(input: {
  tenantId: string; rootType: Exclude<RootKind, 'code'>; rootId: string;
  focus?: { path: string; line: number };
}): Promise<WorkStory | null> {
  const records = await loadRecords(input.tenantId);
  const frictionRows = await frictionAnalytics(input.tenantId) as Array<Record<string, unknown>>;
  let pr: Records['pullRequests'][number] | null = null;
  let commitIds: string[] = [];
  let historicalIds: string[] = [];
  let rootTitle = '';
  if (input.rootType === 'pull_request') {
    pr = records.pullRequests.find(row => row.id === input.rootId) ?? null;
    if (!pr) return null;
    commitIds = currentCommitIds(records, pr.id);
    historicalIds = historicalCommitIds(records, pr.id);
    rootTitle = pr.title;
  } else if (input.rootType === 'commit') {
    const commit = records.commits.find(row => row.id === input.rootId);
    if (!commit) return null;
    commitIds = [commit.id]; pr = prForCommit(records, commit.id); rootTitle = commit.subject;
  } else {
    const intention = records.intentions.find(row => row.id === input.rootId && row.isCurrent);
    if (!intention) return null;
    commitIds = intention.sessionId
      ? records.commitSessions.filter(row => row.sessionId === intention.sessionId).map(row => row.commitId) : [];
    pr = commitIds.map(id => prForCommit(records, id)).find(Boolean) ?? null;
    rootTitle = intentionText(input.tenantId, intention) ?? 'Unavailable intention';
  }
  const sessionIds = input.rootType === 'intention'
    ? records.intentions.filter(row => row.id === input.rootId).flatMap(row => row.sessionId ? [row.sessionId] : [])
    : sessionsForCommits(records, commitIds);
  const intentions = currentIntentions(records, sessionIds).flatMap(row => {
    const text = intentionText(input.tenantId, row);
    return text ? [{ id: row.id, text, state: row.evidenceState, confidence: row.confidence,
      lifecycle: row.lifecycle, sessionId: row.sessionId }] : [];
  });
  const graphs = await Promise.all(commitIds.map(commitId => evidenceGraph({
    tenantId: input.tenantId, rootType: 'commit', rootId: commitId,
    path: input.focus?.path, line: input.focus?.line, limit: 200,
  })));
  if (!commitIds.length && sessionIds.length) {
    graphs.push(await evidenceGraph({ tenantId: input.tenantId, rootType: 'session', rootId: sessionIds[0], limit: 200 }));
  }
  const graph = mergeGraphs(graphs, { type: input.rootType, id: input.rootId });
  const focusTraces = exactRangeTraceIds(graph.edges);
  const focus = input.focus ? {
    ...input.focus, attribution: (focusTraces.length ? 'exact' : 'missing') as 'exact' | 'missing',
    traceIds: focusTraces,
  } : null;
  const values = sessionFriction(frictionRows, sessionIds, records);
  const tests = await testSignals(input.tenantId, records, sessionIds);
  const outcome = commitIds.length ? outcomeFor(records, pr, commitIds) : 'unfinished';
  const commits = records.commits.filter(row => commitIds.includes(row.id) || historicalIds.includes(row.id));
  const repository = records.repositories.find(row => row.id === (pr?.repositoryId ?? commits[0]?.repositoryId));
  const shas = new Set(commits.filter(row => !historicalIds.includes(row.id)).map(row => row.sha));
  if (pr?.mergeCommitSha) shas.add(pr.mergeCommitSha);
  const deployments = records.deployments.filter(row => shas.has(row.sha));
  const quality = coverageFor(records, commitIds, sessionIds, intentions.length);
  if (!pr && commitIds.length) quality.lifecycle = 'partial';
  if (!commitIds.length) quality.lifecycle = 'unavailable';
  const outcomeLabels: Record<WorkCard['outcome'], string> = {
    open: 'Open pull request', merged: 'Merged', deployed: 'Deployed', closed: 'Closed without merge',
    direct_change: 'Direct change outside a pull request', unfinished: 'No linked commit outcome',
  };
  const unresolved = [
    ...(values.failedTools ? [`${values.failedTools} failed tool operation${values.failedTools === 1 ? '' : 's'}`] : []),
    ...(tests.some(test => test.status === 'failed') ? ['A captured test command failed'] : []),
    ...(focus?.attribution === 'missing' ? ['No exact GitAI range attribution exists for this line'] : []),
    ...(!deployments.length && (outcome === 'merged' || outcome === 'open') ? ['Production deployment is not observed'] : []),
  ];
  const primary = intentions[0];
  const story: WorkStory = {
    root: { type: input.focus ? 'code' : input.rootType, id: input.rootId, title: rootTitle,
      repository: repository?.name ?? null, branch: pr?.headRef ?? commits[0]?.branch ?? null },
    summary: {
      why: { primary: primary?.text ?? null, additional: Math.max(0, intentions.length - 1),
        state: primary?.state ?? null, confidence: primary?.confidence ?? null },
      outcome: { status: outcome, label: outcomeLabels[outcome] },
      keyInsight: keyInsight(values), evidenceQuality: quality,
    },
    intentions,
    lifecycle: {
      pullRequest: pr ? { id: pr.id, title: pr.title, state: pr.state, headRef: pr.headRef, baseRef: pr.baseRef } : null,
      merge: pr?.mergeCommitSha ? { sha: pr.mergeCommitSha, mergedAt: pr.mergedAt?.toISOString() ?? null } : null,
      deployments: deployments.map(row => ({ id: row.id, environment: row.environment, status: row.status,
        production: row.production, deployedAt: row.deployedAt.toISOString() })),
    },
    changes: commits.map(commit => ({
      id: commit.id, sha: commit.sha, subject: commit.subject, branch: commit.branch,
      historical: historicalIds.includes(commit.id),
      files: records.files.filter(file => file.commitId === commit.id).map(file => ({
        id: file.id, path: file.path, aiLines: file.observedAiLines, humanLines: file.observedHumanLines,
        unknownLines: file.observedUnknownLines, ranges: ranges(file.attributionRanges),
      })),
    })),
    insights: { ...values, tests, unresolved }, graph,
    similarWork: { status: 'unavailable', items: [] }, focus,
  };
  if (primary?.text) {
    try {
      const similar = await searchIntentions(input.tenantId, primary.text, { limit: 4 });
      const items = similar.filter(result => result.id !== primary.id).slice(0, 3).flatMap(result => {
        const candidate = records.intentions.find(row => row.id === result.id);
        if (!candidate) return [];
        const candidateCommits = candidate.sessionId
          ? records.commitSessions.filter(row => row.sessionId === candidate.sessionId).map(row => row.commitId) : [];
        const candidatePr = candidateCommits.map(id => prForCommit(records, id)).find(Boolean) ?? null;
        if (candidatePr) return [cardForPr(input.tenantId, records, frictionRows, candidatePr)];
        const candidateCommit = records.commits.find(row => candidateCommits.includes(row.id));
        return candidateCommit ? [cardForCommit(input.tenantId, records, frictionRows, candidateCommit)]
          : [cardForIntention(input.tenantId, records, frictionRows, candidate)];
      });
      story.similarWork = { status: 'available', items: [...new Map(items.map(item => [`${item.kind}:${item.id}`, item])).values()] };
    } catch {
      story.similarWork = { status: 'unavailable', items: [] };
    }
  }
  return story;
}

export async function searchEvidenceWorkspace(tenantId: string, query: string, filters: {
  repositoryId?: string; branch?: string; from?: string; to?: string; agent?: string;
  model?: string; outcome?: string; resultType?: string; limit?: number;
}) {
  const records = await loadRecords(tenantId);
  const friction = await frictionAnalytics(tenantId) as Array<Record<string, unknown>>;
  const normalized = query.toLowerCase();
  const from = filters.from ? new Date(filters.from) : null;
  const to = filters.to ? new Date(filters.to) : null;
  const sessionAllowed = (sessionIds: string[]) => {
    if (filters.agent && !sessionIds.some(id => records.sessions.find(row => row.id === id)?.tool === filters.agent)) return false;
    if (filters.model && !sessionIds.some(id => {
      const models = records.sessions.find(row => row.id === id)?.observedModels;
      return Array.isArray(models) && models.includes(filters.model);
    })) return false;
    return true;
  };
  const cardAllowed = (card: WorkCard) => (!filters.repositoryId || card.repository?.id === filters.repositoryId)
    && (!filters.branch || card.branch === filters.branch)
    && (!filters.outcome || card.outcome === filters.outcome)
    && (!from || new Date(card.updatedAt) >= from)
    && (!to || new Date(card.updatedAt) <= to);
  const results: Array<WorkCard & { matchReasons: string[]; score: number }> = [];
  for (const pr of records.pullRequests) {
    const commitIds = currentCommitIds(records, pr.id);
    const sessionIds = sessionsForCommits(records, commitIds);
    if (!sessionAllowed(sessionIds)) continue;
    const commitRows = records.commits.filter(row => commitIds.includes(row.id));
    const fileRows = records.files.filter(row => commitIds.includes(row.commitId));
    const eventRows = records.events.filter(row => sessionIds.includes(row.sessionId));
    const reasons = [
      ...([pr.title, pr.headRef, pr.baseRef].some(value => value?.toLowerCase().includes(normalized)) ? ['pull_request'] : []),
      ...(commitRows.some(row => [row.sha, row.subject, row.branch].some(value => value?.toLowerCase().includes(normalized))) ? ['commit'] : []),
      ...(fileRows.some(row => row.path.toLowerCase().includes(normalized)) ? ['file_path'] : []),
      ...(eventRows.some(row => row.toolName?.toLowerCase().includes(normalized)
        || row.model?.toLowerCase().includes(normalized)
        || String(row.metadata?.errorCode ?? '').toLowerCase().includes(normalized)) ? ['evidence_metadata'] : []),
    ];
    const card = cardForPr(tenantId, records, friction, pr);
    if (reasons.length && cardAllowed(card) && (!filters.resultType || filters.resultType === 'pull_request')) {
      results.push({ ...card, matchReasons: reasons, score: 2 + reasons.length });
    }
  }
  const mapped = new Set(records.pullRequests.flatMap(pr => currentCommitIds(records, pr.id)));
  for (const commit of records.commits.filter(row => !mapped.has(row.id))) {
    const sessionIds = sessionsForCommits(records, [commit.id]);
    if (!sessionAllowed(sessionIds)) continue;
    const fileMatch = records.files.some(row => row.commitId === commit.id && row.path.toLowerCase().includes(normalized));
    const commitMatch = [commit.sha, commit.subject, commit.branch].some(value => value?.toLowerCase().includes(normalized));
    const eventMatch = records.events.some(row => sessionIds.includes(row.sessionId)
      && (row.toolName?.toLowerCase().includes(normalized)
        || row.model?.toLowerCase().includes(normalized)
        || String(row.metadata?.errorCode ?? '').toLowerCase().includes(normalized)));
    const card = cardForCommit(tenantId, records, friction, commit);
    if ((fileMatch || commitMatch || eventMatch) && cardAllowed(card)
      && (!filters.resultType || filters.resultType === 'direct_commit')) {
      results.push({ ...card, matchReasons: [commitMatch ? 'commit' : '', fileMatch ? 'file_path' : '',
        eventMatch ? 'evidence_metadata' : ''].filter(Boolean), score: 2 });
    }
  }
  for (const intention of records.intentions.filter(row => row.isCurrent)) {
    const text = intentionText(tenantId, intention);
    if (!text?.toLowerCase().includes(normalized)) continue;
    const intentionSessionIds = intention.sessionId ? [intention.sessionId] : [];
    if (!sessionAllowed(intentionSessionIds)) continue;
    const commitIds = intention.sessionId
      ? records.commitSessions.filter(row => row.sessionId === intention.sessionId).map(row => row.commitId) : [];
    const parentPr = commitIds.map(id => prForCommit(records, id)).find(Boolean) ?? null;
    const parentCommit = records.commits.find(row => commitIds.includes(row.id)) ?? null;
    const card = parentPr ? cardForPr(tenantId, records, friction, parentPr)
      : parentCommit ? cardForCommit(tenantId, records, friction, parentCommit)
        : cardForIntention(tenantId, records, friction, intention);
    if (filters.resultType && filters.resultType !== card.kind) continue;
    if (cardAllowed(card)) results.push({ ...card, matchReasons: ['exact_intention'], score: 5 });
  }
  try {
    const semantic = await searchIntentions(tenantId, query, { limit: filters.limit ?? 20 });
    for (const result of semantic) {
      const intention = records.intentions.find(row => row.id === result.id);
      if (!intention) continue;
      const commitIds = intention.sessionId
        ? records.commitSessions.filter(row => row.sessionId === intention.sessionId).map(row => row.commitId) : [];
      const semanticSessionIds = intention.sessionId ? [intention.sessionId] : [];
      if (!sessionAllowed(semanticSessionIds)) continue;
      const parentPr = commitIds.map(id => prForCommit(records, id)).find(Boolean) ?? null;
      const parentCommit = records.commits.find(row => commitIds.includes(row.id)) ?? null;
      const card = parentPr ? cardForPr(tenantId, records, friction, parentPr)
        : parentCommit ? cardForCommit(tenantId, records, friction, parentCommit)
          : cardForIntention(tenantId, records, friction, intention);
      if (filters.resultType && filters.resultType !== card.kind) continue;
      if (cardAllowed(card)) results.push({ ...card, matchReasons: result.matchReasons, score: 1 + result.score });
    }
  } catch {
    // Exact metadata search remains available when the local semantic model is not ready.
  }
  const unique = new Map<string, typeof results[number]>();
  results.sort((a, b) => b.score - a.score).forEach(result => {
    const key = `${result.kind}:${result.id}`;
    const existing = unique.get(key);
    if (!existing) unique.set(key, result);
    else unique.set(key, {
      ...existing,
      matchReasons: [...new Set([...existing.matchReasons, ...result.matchReasons])],
      score: Math.max(existing.score, result.score),
    });
  });
  return [...unique.values()].sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.min(50, Math.max(1, filters.limit ?? 20)));
}
