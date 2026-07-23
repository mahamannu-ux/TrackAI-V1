import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  scmCommitFiles,
  scmCommits,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
  telemetryIngestBatches,
  telemetryMetricEvents,
} from '../../core/db/schema';
import { parseAuthorshipNote } from './authorship-note';
import {
  decodeAttributes,
  decodeCommitValues,
  decodeSessionUsage,
  EVENT_KIND,
  validateMetricEvent,
} from './decoder';
import { repositoryIdentity, normalizeRepositoryUrl } from './repository-url';
import { selectPullRequestMatch } from './pr-matching';
import type {
  DecodedAttributes,
  GitAiMetricEvent,
  GitAiMetricsBatch,
  ParsedAuthorshipSession,
} from './types';

export type UploadError = { index: number; error: string };

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function eventDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

function parseAuthor(value: string | null): { name: string | null; email: string | null } {
  if (!value) return { name: null, email: null };
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  return match
    ? { name: match[1].trim() || null, email: match[2].trim().toLowerCase() }
    : { name: value, email: null };
}

async function ensureRepository(tenantId: string, repoUrl: string) {
  const tenantDb = withTenant(db, tenantId);
  const identity = repositoryIdentity(repoUrl);
  const existingRepositories = await tenantDb.select(scmRepositories);
  const existing = existingRepositories.find((repository) => {
    if (repository.normalizedUrl === identity.normalizedUrl) return true;
    try {
      return normalizeRepositoryUrl(repository.url) === identity.normalizedUrl;
    } catch {
      return false;
    }
  });
  if (existing) {
    if (existing.normalizedUrl !== identity.normalizedUrl) {
      const [updated] = await tenantDb.update(
        scmRepositories,
        { normalizedUrl: identity.normalizedUrl },
        eq(scmRepositories.id, existing.id),
      );
      return updated ?? existing;
    }
    return existing;
  }

  const [repository] = await tenantDb.upsert(
    scmRepositories,
    {
      provider: identity.provider,
      externalId: identity.externalId,
      name: identity.name,
      url: identity.canonicalUrl,
      normalizedUrl: identity.normalizedUrl,
    },
    [scmRepositories.tenantId, scmRepositories.normalizedUrl],
    { name: identity.name, url: identity.canonicalUrl },
  );
  if (!repository) throw new Error('Repository upsert failed');
  return repository;
}

type SessionIdentity = {
  externalId: string;
  internalId: string | null;
  tool: string;
  model: string | null;
  humanAuthor: string | null;
};

function sessionIdentityFromAttrs(attrs: DecodedAttributes): SessionIdentity | null {
  const externalId = attrs.externalSessionId ?? attrs.sessionId;
  if (!externalId) return null;
  return {
    externalId,
    internalId: attrs.sessionId,
    tool: attrs.tool ?? 'unknown',
    model: attrs.model,
    humanAuthor: attrs.author,
  };
}

async function ensureSession(
  tenantId: string,
  identity: SessionIdentity,
  timestamp: Date,
  repositoryId?: string,
  status = 'active',
) {
  const tenantDb = withTenant(db, tenantId);
  const [existing] = await tenantDb.select(
    aiSessions,
    and(
      eq(aiSessions.tool, identity.tool),
      eq(aiSessions.externalSessionId, identity.externalId),
    ),
  );
  const existingModels = Array.isArray(existing?.observedModels)
    ? existing.observedModels.filter((value): value is string => typeof value === 'string')
    : [];
  const observedModels = identity.model && !existingModels.includes(identity.model)
    ? [...existingModels, identity.model]
    : existingModels;
  const startedAt = !existing?.startedAt || timestamp < existing.startedAt ? timestamp : existing.startedAt;
  const endedAt = !existing?.endedAt || timestamp > existing.endedAt ? timestamp : existing.endedAt;

  const [session] = await tenantDb.upsert(
    aiSessions,
    {
      externalSessionId: identity.externalId,
      gitAiSessionId: identity.internalId,
      tool: identity.tool,
      observedModels,
      humanAuthor: identity.humanAuthor,
      status,
      startedAt,
      endedAt,
    },
    [aiSessions.tenantId, aiSessions.tool, aiSessions.externalSessionId],
    {
      gitAiSessionId: identity.internalId ?? existing?.gitAiSessionId,
      observedModels,
      humanAuthor: identity.humanAuthor ?? existing?.humanAuthor,
      status: status === 'shipped' ? 'shipped' : existing?.status ?? status,
      startedAt,
      endedAt,
      updatedAt: new Date(),
    },
  );
  if (!session) throw new Error('Session upsert failed');

  if (repositoryId) {
    await tenantDb.insertDoNothing(
      aiSessionRepositories,
      { sessionId: session.id, repositoryId },
      [
        aiSessionRepositories.tenantId,
        aiSessionRepositories.sessionId,
        aiSessionRepositories.repositoryId,
      ],
    );
  }
  return session;
}

async function associateCommitWithPullRequest(tenantId: string, commitId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [commit] = await tenantDb.select(scmCommits, eq(scmCommits.id, commitId));
  if (!commit) return;
  const pullRequests = await tenantDb.select(
    scmPullRequests,
    eq(scmPullRequests.repositoryId, commit.repositoryId),
  );
  const match = selectPullRequestMatch(commit, pullRequests);
  if (!match) return;
  await tenantDb.upsert(
    scmPullRequestCommits,
    {
      pullRequestId: match.pullRequest.id,
      commitId: commit.id,
      matchMethod: match.method,
      confidence: match.confidence,
    },
    [
      scmPullRequestCommits.tenantId,
      scmPullRequestCommits.pullRequestId,
      scmPullRequestCommits.commitId,
    ],
    { matchMethod: match.method, confidence: match.confidence },
  );
}

async function normalizeCommit(
  tenantId: string,
  event: GitAiMetricEvent,
  attrs: DecodedAttributes,
  sourceEventId: string,
) {
  if (!attrs.repoUrl || !attrs.commitSha) return;
  const tenantDb = withTenant(db, tenantId);
  const repository = await ensureRepository(tenantId, attrs.repoUrl);
  const values = decodeCommitValues(event.v);
  const parsedNote = parseAuthorshipNote(values.authorshipNote);
  const author = parseAuthor(attrs.author);
  const noteAiLines = parsedNote.files.reduce((total, file) => total + file.aiLines, 0);
  const noteHumanLines = parsedNote.files.reduce((total, file) => total + file.humanLines, 0);
  const aiLines = parsedNote.files.length > 0 ? noteAiLines : values.aiLines;
  const humanLines = parsedNote.files.length > 0 ? noteHumanLines : values.humanLines;
  const unknownLines = Math.max(0, values.addedLines - aiLines - humanLines);
  const authoredAt = values.authoredAtSeconds ? eventDate(values.authoredAtSeconds) : eventDate(event.t);
  const committedAt = values.committedAtSeconds ? eventDate(values.committedAtSeconds) : eventDate(event.t);
  const [commit] = await tenantDb.upsert(
    scmCommits,
    {
      repositoryId: repository.id,
      sha: attrs.commitSha,
      branch: attrs.branch,
      authorName: author.name,
      authorEmail: author.email,
      subject: values.subject,
      body: values.body,
      authoredAt,
      committedAt,
      diffAddedLines: values.addedLines,
      diffDeletedLines: values.deletedLines,
      observedAiLines: aiLines,
      observedHumanLines: humanLines,
      observedUnknownLines: unknownLines,
      authorshipNote: values.authorshipNote,
      sourceEventId,
    },
    [scmCommits.tenantId, scmCommits.repositoryId, scmCommits.sha],
    {
      branch: attrs.branch,
      subject: values.subject,
      body: values.body,
      committedAt,
      diffAddedLines: values.addedLines,
      diffDeletedLines: values.deletedLines,
      observedAiLines: aiLines,
      observedHumanLines: humanLines,
      observedUnknownLines: unknownLines,
      authorshipNote: values.authorshipNote,
      updatedAt: new Date(),
    },
  );
  if (!commit) throw new Error('Commit upsert failed');

  for (const file of parsedNote.files) {
    await tenantDb.upsert(
      scmCommitFiles,
      {
        commitId: commit.id,
        path: file.path,
        observedAiLines: file.aiLines,
        observedHumanLines: file.humanLines,
        observedUnknownLines: 0,
        attributionRanges: file.ranges,
      },
      [scmCommitFiles.tenantId, scmCommitFiles.commitId, scmCommitFiles.path],
      {
        observedAiLines: file.aiLines,
        observedHumanLines: file.humanLines,
        attributionRanges: file.ranges,
      },
    );
  }

  const noteSessions: ParsedAuthorshipSession[] = parsedNote.sessions;
  const fallbackIdentity = sessionIdentityFromAttrs(attrs);
  const sessionIdentities: SessionIdentity[] = noteSessions.length > 0
    ? noteSessions.map((session) => ({
      externalId: session.externalId,
      internalId: session.internalId,
      tool: session.tool,
      model: session.model,
      humanAuthor: session.humanAuthor,
    }))
    : fallbackIdentity ? [fallbackIdentity] : [];
  for (const identity of sessionIdentities) {
    const session = await ensureSession(
      tenantId,
      identity,
      committedAt,
      repository.id,
      'shipped',
    );
    await tenantDb.upsert(
      aiCommitSessions,
      {
        commitId: commit.id,
        sessionId: session.id,
        observedAiLines: identity.internalId
          ? parsedNote.aiLinesBySession.get(identity.internalId) ?? 0
          : aiLines,
      },
      [aiCommitSessions.tenantId, aiCommitSessions.commitId, aiCommitSessions.sessionId],
      {
        observedAiLines: identity.internalId
          ? parsedNote.aiLinesBySession.get(identity.internalId) ?? 0
          : aiLines,
      },
    );
  }
  await associateCommitWithPullRequest(tenantId, commit.id);
}

async function normalizeSessionEvent(
  tenantId: string,
  event: GitAiMetricEvent,
  attrs: DecodedAttributes,
  sourceEventId: string,
) {
  const identity = sessionIdentityFromAttrs(attrs);
  if (!identity) return;
  const repository = attrs.repoUrl ? await ensureRepository(tenantId, attrs.repoUrl) : null;
  const session = await ensureSession(
    tenantId,
    identity,
    eventDate(event.t),
    repository?.id,
  );
  if (event.e !== EVENT_KIND.sessionEvent) return;
  const usage = decodeSessionUsage(event);
  if (!usage) return;
  const tenantDb = withTenant(db, tenantId);
  const evidenceKey = usage.externalEventId
    ? `git-ai:${attrs.tool ?? 'unknown'}:${usage.externalEventId}`
    : `git-ai:${sourceEventId}`;
  await tenantDb.upsert(
    aiSessionUsage,
    {
      sessionId: session.id,
      model: attrs.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costAmount: usage.costAmount === null ? null : String(usage.costAmount),
      costUnit: usage.costAmount === null ? null : 'USD',
      availability: 'recorded',
      evidenceSource: 'git_ai_kind5',
      sourceEventId,
      evidenceKey,
    },
    [aiSessionUsage.tenantId, aiSessionUsage.evidenceKey],
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costAmount: usage.costAmount === null ? null : String(usage.costAmount),
      availability: 'recorded',
    },
  );
}

async function normalizeEvent(
  tenantId: string,
  event: GitAiMetricEvent,
  sourceEventId: string,
) {
  const attrs = decodeAttributes(event.a);
  if (event.e === EVENT_KIND.committed || event.e === EVENT_KIND.rewriteCommitted) {
    await normalizeCommit(tenantId, event, attrs, sourceEventId);
    return;
  }
  if (
    event.e === EVENT_KIND.agentUsage
    || event.e === EVENT_KIND.checkpoint
    || event.e === EVENT_KIND.sessionEvent
  ) {
    await normalizeSessionEvent(tenantId, event, attrs, sourceEventId);
  }
}

export async function ingestMetricsBatch(
  tenantId: string,
  batch: GitAiMetricsBatch,
): Promise<UploadError[]> {
  const tenantDb = withTenant(db, tenantId);
  const payloadHash = fingerprint(batch);
  const [existingBatch] = await tenantDb.select(
    telemetryIngestBatches,
    eq(telemetryIngestBatches.payloadHash, payloadHash),
  );
  if (existingBatch) return [];

  const [storedBatch] = await tenantDb.insertDoNothing(
    telemetryIngestBatches,
    {
      apiVersion: batch.v,
      payloadHash,
      eventCount: batch.events.length,
      payload: batch,
    },
    [telemetryIngestBatches.tenantId, telemetryIngestBatches.payloadHash],
  );
  if (!storedBatch) return [];

  const errors: UploadError[] = [];
  for (let index = 0; index < batch.events.length; index += 1) {
    let event: GitAiMetricEvent;
    try {
      event = validateMetricEvent(batch.events[index]);
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : 'Invalid event' });
      continue;
    }
    const eventFingerprint = fingerprint(event);
    const [storedEvent] = await tenantDb.insertDoNothing(
      telemetryMetricEvents,
      {
        batchId: storedBatch.id,
        eventIndex: index,
        eventFingerprint,
        eventKind: event.e,
        eventTimestamp: eventDate(event.t),
        rawEvent: event,
        normalizationStatus: 'pending',
      },
      [telemetryMetricEvents.tenantId, telemetryMetricEvents.eventFingerprint],
    );
    if (!storedEvent) continue;
    try {
      await normalizeEvent(tenantId, event, storedEvent.id);
      await tenantDb.update(
        telemetryMetricEvents,
        { normalizationStatus: 'normalized', normalizationError: null },
        eq(telemetryMetricEvents.id, storedEvent.id),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Normalization failed';
      await tenantDb.update(
        telemetryMetricEvents,
        { normalizationStatus: 'failed', normalizationError: message },
        eq(telemetryMetricEvents.id, storedEvent.id),
      );
      errors.push({ index, error: message });
    }
  }
  return errors;
}

export async function reconcileRepositoryPullRequests(tenantId: string, repositoryId: string) {
  const tenantDb = withTenant(db, tenantId);
  const commits = await tenantDb.select(scmCommits, eq(scmCommits.repositoryId, repositoryId));
  for (const commit of commits) await associateCommitWithPullRequest(tenantId, commit.id);
}
