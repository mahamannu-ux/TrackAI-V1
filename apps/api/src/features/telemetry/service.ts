import { createHash } from 'crypto';
import { and, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiCommitModelAttributions,
  aiCodeLifecycleEvents,
  aiGenerationObservations,
  aiModelLifecycleEvents,
  aiSessionRepositories,
  aiSessions,
  aiSessionUsage,
  scmCommitFiles,
  scmCommitLineage,
  scmCommits,
  scmContributors,
  scmPullRequestCommits,
  scmPullRequests,
  scmRepositories,
  ssoTenants,
  telemetryIngestBatches,
  telemetryMetricEvents,
} from '../../core/db/schema';
import { parseAuthorshipNote } from './authorship-note';
import {
  decodeAiAuthoredDeletionLines,
  decodeDeletionFilePaths,
  checkpointDeletionMatchesCommitFiles,
  decodeAttributes,
  decodeCheckpointValues,
  decodeCommitValues,
  decodeOtelUsage,
  decodeRewriteValues,
  decodeSessionUsage,
  EVENT_KIND,
  validateMetricEvent,
} from './decoder';
import { repositoryIdentity, normalizeRepositoryUrl } from './repository-url';
import { selectPullRequestMatch } from './pr-matching';
import {
  aggregateExternalSessionLines,
  checkpointDeletionBuckets,
  checkpointLifecycleLines,
  committedLinesForOperation,
  fallbackSessionName,
  operationSupersedesPredecessor,
  NORMALIZED_COMMIT_REACHABILITY,
  shouldAbandonSiblingTip,
} from './lifecycle';
import { allocateReworkByOriginModel, modelAttributionsFromNote, modelKey, splitModelKey } from './model-lifecycle';
import { repositoryIsInTenantScope } from './repository-scope';
import type {
  DecodedAttributes,
  GitAiMetricEvent,
  GitAiMetricsBatch,
  ParsedAuthorshipSession,
} from './types';

export type UploadError = { index: number; error: string };

export async function validateBatchRepositoryScope(
  tenantId: string,
  batch: GitAiMetricsBatch,
): Promise<UploadError[]> {
  const tenantDb = withTenant(db, tenantId);
  const [tenant] = await db
    .select({ scmOrgIdentifier: ssoTenants.scmOrgIdentifier })
    .from(ssoTenants)
    .where(eq(ssoTenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error('Telemetry tenant is not registered');

  const enrolledRepositories = new Set(
    (await tenantDb.select(scmRepositories))
      .map((repository) => repository.normalizedUrl)
      .filter((value): value is string => Boolean(value)),
  );

  const errors: UploadError[] = [];
  batch.events.forEach((rawEvent, index) => {
    let event: GitAiMetricEvent;
    try {
      event = validateMetricEvent(rawEvent);
    } catch {
      // Ordinary validation reports malformed events with the established
      // indexed-error contract after the repository authorization preflight.
      return;
    }

    const repoUrl = decodeAttributes(event.a).repoUrl;
    if (!repoUrl) return;

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeRepositoryUrl(repoUrl);
    } catch {
      errors.push({ index, error: 'Repository URL is invalid' });
      return;
    }

    if (!repositoryIsInTenantScope(
      normalizedUrl,
      enrolledRepositories,
      tenant.scmOrgIdentifier,
    )) {
      errors.push({ index, error: 'Repository is not enrolled for this tenant' });
    }
  });

  return errors;
}

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

async function ensureObservedCommitContributor(
  tenantId: string,
  repositoryId: string,
  author: { name: string | null; email: string | null },
) {
  if (!author.name && !author.email) return;
  const tenantDb = withTenant(db, tenantId);
  const contributors = await tenantDb.select(
    scmContributors,
    eq(scmContributors.repositoryId, repositoryId),
  );
  const normalizedEmail = author.email?.trim().toLowerCase() ?? null;
  const normalizedName = author.name?.trim().toLowerCase() ?? null;
  const existing = contributors.find((contributor) => normalizedEmail
    ? contributor.email?.trim().toLowerCase() === normalizedEmail
    : contributor.name.trim().toLowerCase() === normalizedName);
  if (existing) return;
  await tenantDb.insertDoNothing(
    scmContributors,
    {
      repositoryId,
      name: author.name ?? normalizedEmail ?? 'Unknown commit author',
      email: normalizedEmail,
    },
    [scmContributors.id],
  );
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
      displayName: existing?.displayName
        ?? fallbackSessionName(identity.tool, startedAt, identity.externalId),
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

async function attachRecentReworkEvidence(
  tenantId: string,
  repositoryId: string,
  commitId: string,
  committedAt: Date,
  aiAuthoredDeletedLines: number | null,
  commitDeletionPaths: Set<string>,
) {
  if (aiAuthoredDeletedLines === null) return;
  const tenantDb = withTenant(db, tenantId);
  const windowStart = new Date(committedAt.getTime() - (2 * 60 * 60 * 1000));
  const existingCommitRework = await tenantDb.select(
    aiCodeLifecycleEvents,
    and(
      eq(aiCodeLifecycleEvents.commitId, commitId),
      eq(aiCodeLifecycleEvents.stage, 'reworked'),
    ),
  );
  const recentCandidates = await tenantDb.select(
    aiCodeLifecycleEvents,
    and(
      eq(aiCodeLifecycleEvents.repositoryId, repositoryId),
      or(
        eq(aiCodeLifecycleEvents.stage, 'deletion_observed'),
        eq(aiCodeLifecycleEvents.stage, 'reworked'),
      ),
      isNull(aiCodeLifecycleEvents.commitId),
      gte(aiCodeLifecycleEvents.occurredAt, windowStart),
      lte(aiCodeLifecycleEvents.occurredAt, committedAt),
    ),
  );
  const candidates = [];
  for (const evidence of recentCandidates) {
    const sourceEventId = evidence.evidenceRef.startsWith('checkpoint-delete:')
      ? evidence.evidenceRef.split(':')[1] ?? null
      : null;
    if (!sourceEventId) {
      candidates.push(evidence);
      continue;
    }
    const [sourceEvent] = await tenantDb.select(
      telemetryMetricEvents,
      eq(telemetryMetricEvents.id, sourceEventId),
    );
    if (!sourceEvent) continue;
    const checkpointFilePath = decodeCheckpointValues(
      validateMetricEvent(sourceEvent.rawEvent).v,
    ).filePath;
    if (checkpointDeletionMatchesCommitFiles(checkpointFilePath, commitDeletionPaths)) {
      candidates.push(evidence);
    }
  }

  let remainingAiRework = Math.max(
    0,
    aiAuthoredDeletedLines
      - existingCommitRework.reduce((total, evidence) => total + evidence.lineCount, 0),
  );
  if (remainingAiRework <= 0) return;
  for (const evidence of candidates) {
    if (evidence.stage === 'reworked') {
      const attributedLines = Math.min(remainingAiRework, evidence.lineCount);
      const uncommittedRemainder = evidence.lineCount - attributedLines;
      if (uncommittedRemainder > 0) {
        await tenantDb.insertDoNothing(
          aiCodeLifecycleEvents,
          {
            repositoryId,
            sessionId: evidence.sessionId,
            stage: 'reworked',
            lineCount: uncommittedRemainder,
            actorKind: evidence.actorKind,
            evidenceType: evidence.evidenceType,
            evidenceRef: `${evidence.evidenceRef}:uncommitted:${commitId}`,
            confidence: evidence.confidence,
            occurredAt: evidence.occurredAt,
          },
          [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
        );
      }
      await tenantDb.update(
        aiCodeLifecycleEvents,
        {
          commitId,
          lineCount: attributedLines,
          evidenceType: 'git_ai_checkpoint_deletion_with_commit_hunk_attribution',
        },
        eq(aiCodeLifecycleEvents.id, evidence.id),
      );
      remainingAiRework -= attributedLines;
      if (remainingAiRework <= 0) break;
      continue;
    }
    const attributedLines = Math.min(remainingAiRework, evidence.lineCount);
    await tenantDb.update(
      aiCodeLifecycleEvents,
      {
        commitId,
        stage: attributedLines > 0 ? 'reworked' : 'deletion_observed',
        lineCount: attributedLines > 0 ? attributedLines : evidence.lineCount,
        evidenceType: attributedLines > 0
          ? 'git_ai_checkpoint_deletion_with_commit_hunk_attribution'
          : evidence.evidenceType,
      },
      eq(aiCodeLifecycleEvents.id, evidence.id),
    );
    remainingAiRework -= attributedLines;
    if (evidence.sessionId) {
      await tenantDb.insertDoNothing(
        aiCommitSessions,
        { commitId, sessionId: evidence.sessionId, observedAiLines: 0 },
        [aiCommitSessions.tenantId, aiCommitSessions.commitId, aiCommitSessions.sessionId],
      );
    }
    if (remainingAiRework <= 0) break;
  }
  if (remainingAiRework > 0) {
    await tenantDb.insertDoNothing(
      aiCodeLifecycleEvents,
      {
        repositoryId,
        commitId,
        stage: 'reworked',
        lineCount: remainingAiRework,
        actorKind: 'unknown',
        evidenceType: 'git_ai_commit_hunk_deletion',
        evidenceRef: `commit-delete:${commitId}:unallocated`,
        confidence: 80,
        occurredAt: committedAt,
      },
      [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
    );
  }
}

async function projectCommitReworkByOriginModel(
  tenantId: string,
  repositoryId: string,
  commitId: string,
  predecessorSha: string | null,
  occurredAt: Date,
) {
  const tenantDb = withTenant(db, tenantId);
  const [reworkRows, successorRows] = await Promise.all([
    tenantDb.select(aiCodeLifecycleEvents, and(
      eq(aiCodeLifecycleEvents.commitId, commitId),
      eq(aiCodeLifecycleEvents.stage, 'reworked'),
    )),
    tenantDb.select(aiCommitModelAttributions, eq(aiCommitModelAttributions.commitId, commitId)),
  ]);
  const total = reworkRows.reduce((sum, row) => sum + row.lineCount, 0);
  if (total <= 0) return;
  const [predecessor] = predecessorSha
    ? await tenantDb.select(scmCommits, and(
      eq(scmCommits.repositoryId, repositoryId), eq(scmCommits.sha, predecessorSha),
    ))
    : [];
  const predecessorRows = predecessor
    ? await tenantDb.select(aiCommitModelAttributions,
      eq(aiCommitModelAttributions.commitId, predecessor.id))
    : [];
  const actorModels = new Set<string>();
  for (const row of reworkRows) {
    const sourceId = row.evidenceRef.startsWith('checkpoint-delete:')
      ? row.evidenceRef.split(':')[1] : null;
    if (!sourceId) continue;
    const [source] = await tenantDb.select(
      telemetryMetricEvents, eq(telemetryMetricEvents.id, sourceId),
    );
    if (!source) continue;
    const attrs = decodeAttributes(validateMetricEvent(source.rawEvent).a);
    if (attrs.tool || attrs.model) actorModels.add(modelKey(attrs.tool, attrs.model));
  }
  for (const allocation of allocateReworkByOriginModel({
    predecessor: predecessorRows.map((row) => ({ modelKey: row.modelKey, lines: row.observedAiLines })),
    successor: successorRows.map((row) => ({ modelKey: row.modelKey, lines: row.observedAiLines })),
    reworkedLines: total,
  })) {
    const identity = splitModelKey(allocation.modelKey);
    await tenantDb.upsert(aiModelLifecycleEvents, {
      repositoryId, commitId, tool: identity.tool,
      model: identity.model === 'unknown' ? null : identity.model,
      modelKey: allocation.modelKey, stage: 'reworked', lineCount: allocation.lines,
      actorKind: reworkRows.length === 1 ? reworkRows[0].actorKind : 'mixed',
      actorModelKey: actorModels.size === 1 ? [...actorModels][0] : null,
      evidenceType: 'model_origin_from_commit_lineage',
      evidenceRef: `commit-model-rework:${commitId}:${allocation.modelKey}`,
      confidence: allocation.confidence, occurredAt,
    }, [aiModelLifecycleEvents.tenantId, aiModelLifecycleEvents.stage, aiModelLifecycleEvents.evidenceRef], {
      lineCount: allocation.lines, confidence: allocation.confidence, occurredAt,
    });
  }
}

async function attachGenerationEvidenceToCommit(
  tenantId: string,
  repositoryId: string,
  commitId: string,
  sessionId: string,
  committedAt: Date,
) {
  const tenantDb = withTenant(db, tenantId);
  const candidates = await tenantDb.select(
    aiCodeLifecycleEvents,
    and(
      eq(aiCodeLifecycleEvents.repositoryId, repositoryId),
      eq(aiCodeLifecycleEvents.sessionId, sessionId),
      eq(aiCodeLifecycleEvents.stage, 'generated'),
      isNull(aiCodeLifecycleEvents.commitId),
      lte(aiCodeLifecycleEvents.occurredAt, committedAt),
    ),
  );
  for (const evidence of candidates) {
    await tenantDb.update(
      aiCodeLifecycleEvents,
      { commitId },
      eq(aiCodeLifecycleEvents.id, evidence.id),
    );
  }
  const modelCandidates = await tenantDb.select(
    aiModelLifecycleEvents,
    and(
      eq(aiModelLifecycleEvents.repositoryId, repositoryId),
      eq(aiModelLifecycleEvents.sessionId, sessionId),
      eq(aiModelLifecycleEvents.stage, 'generated'),
      isNull(aiModelLifecycleEvents.commitId),
      lte(aiModelLifecycleEvents.occurredAt, committedAt),
    ),
  );
  for (const evidence of modelCandidates) {
    await tenantDb.update(
      aiModelLifecycleEvents,
      { commitId },
      eq(aiModelLifecycleEvents.id, evidence.id),
    );
  }
}

async function inferResetRecommitLineage(
  tenantId: string,
  repositoryId: string,
  commitId: string,
  sha: string,
  branch: string | null,
  patchId: string | null,
  committedAt: Date,
) {
  if (!branch || !patchId) return;
  const tenantDb = withTenant(db, tenantId);
  const candidates = await tenantDb.select(
    scmCommits,
    and(
      eq(scmCommits.repositoryId, repositoryId),
      eq(scmCommits.branch, branch),
      eq(scmCommits.patchId, patchId),
      ne(scmCommits.id, commitId),
      lte(scmCommits.committedAt, committedAt),
    ),
  );
  for (const predecessor of candidates) {
    await tenantDb.insertDoNothing(
      scmCommitLineage,
      {
        repositoryId,
        predecessorCommitId: predecessor.id,
        predecessorSha: predecessor.sha,
        successorCommitId: commitId,
        successorSha: sha,
        operationKind: 'recommit_after_reset',
        evidenceSource: 'same_branch_patch_identity',
        confidence: 85,
        observedAt: committedAt,
      },
      [
        scmCommitLineage.tenantId,
        scmCommitLineage.repositoryId,
        scmCommitLineage.predecessorSha,
        scmCommitLineage.successorSha,
        scmCommitLineage.operationKind,
      ],
    );
    await tenantDb.update(
      scmCommits,
      { reachability: 'superseded', lastSeenAt: committedAt },
      eq(scmCommits.id, predecessor.id),
    );
    // A reset/recommit changes commit identity, not the underlying generation.
    // Move the immutable checkpoint relationship to the retained successor so
    // generation coverage and ratios do not become unavailable or double-count.
    await tenantDb.update(
      aiCodeLifecycleEvents,
      { commitId },
      and(
        eq(aiCodeLifecycleEvents.commitId, predecessor.id),
        eq(aiCodeLifecycleEvents.stage, 'generated'),
      ),
    );
  }
}

async function recordParentAndInferAbandonedTips(
  tenantId: string,
  repositoryId: string,
  commitId: string,
  sha: string,
  branch: string | null,
  baseCommitSha: string | null,
  committedAt: Date,
) {
  if (!branch || !baseCommitSha || baseCommitSha === sha) return;
  const tenantDb = withTenant(db, tenantId);
  const [baseCommit] = await tenantDb.select(
    scmCommits,
    and(eq(scmCommits.repositoryId, repositoryId), eq(scmCommits.sha, baseCommitSha)),
  );
  await tenantDb.insertDoNothing(
    scmCommitLineage,
    {
      repositoryId,
      predecessorCommitId: baseCommit?.id ?? null,
      predecessorSha: baseCommitSha,
      successorCommitId: commitId,
      successorSha: sha,
      operationKind: 'parent',
      evidenceSource: 'git_ai_base_commit',
      confidence: 100,
      observedAt: committedAt,
    },
    [
      scmCommitLineage.tenantId,
      scmCommitLineage.repositoryId,
      scmCommitLineage.predecessorSha,
      scmCommitLineage.successorSha,
      scmCommitLineage.operationKind,
    ],
  );

  // Two different commits observed on the same branch with the same immediate
  // parent imply that the earlier local tip was reset/replaced. Preserve it as
  // immutable history but exclude it from the current retained denominator.
  const siblings = await tenantDb.select(
    scmCommitLineage,
    and(
      eq(scmCommitLineage.repositoryId, repositoryId),
      eq(scmCommitLineage.predecessorSha, baseCommitSha),
      eq(scmCommitLineage.operationKind, 'parent'),
    ),
  );
  for (const sibling of siblings) {
    if (sibling.successorSha === sha) continue;
    const [candidate] = await tenantDb.select(
      scmCommits,
      and(eq(scmCommits.repositoryId, repositoryId), eq(scmCommits.sha, sibling.successorSha)),
    );
    if (!candidate || !shouldAbandonSiblingTip(candidate, { sha, branch, committedAt })) continue;
    await tenantDb.update(
      scmCommits,
      { reachability: 'unreachable', lastSeenAt: committedAt },
      eq(scmCommits.id, candidate.id),
    );
  }
}

async function loadPredecessorAttributionHistory(
  tenantId: string,
  repositoryId: string,
  baseCommitSha: string | null,
) {
  if (!baseCommitSha) return [];
  const tenantDb = withTenant(db, tenantId);
  const history: Array<{ path: string; attributionRanges: unknown }> = [];
  const visited = new Set<string>();
  let currentSha: string | null = baseCommitSha;

  // Commit Notes contain attribution for changed files, not a full tree snapshot.
  // Walk the linear parent chain newest-first so unchanged files inherit their
  // nearest recorded line ownership across unrelated intermediate commits.
  while (currentSha && !visited.has(currentSha) && visited.size < 1_000) {
    visited.add(currentSha);
    const [commit] = await tenantDb.select(
      scmCommits,
      and(eq(scmCommits.repositoryId, repositoryId), eq(scmCommits.sha, currentSha)),
    );
    if (commit) {
      const files = await tenantDb.select(
        scmCommitFiles,
        eq(scmCommitFiles.commitId, commit.id),
      );
      history.push(...files.map((file) => ({
        path: file.path,
        attributionRanges: file.attributionRanges,
      })));
    }
    const parents: Array<{ predecessorSha: string }> = await tenantDb.select(
      scmCommitLineage,
      and(
        eq(scmCommitLineage.repositoryId, repositoryId),
        eq(scmCommitLineage.successorSha, currentSha),
        eq(scmCommitLineage.operationKind, 'parent'),
      ),
    );
    currentSha = parents[0]?.predecessorSha ?? null;
  }
  return history;
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
  const values = event.e === EVENT_KIND.rewriteCommitted
    ? decodeRewriteValues(event.v)
    : { ...decodeCommitValues(event.v), operationKind: 'commit', originalCommitShas: [] };
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
      operationKind: values.operationKind,
      patchId: values.patchId,
      reachability: NORMALIZED_COMMIT_REACHABILITY,
      lastSeenAt: committedAt,
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
      operationKind: values.operationKind,
      patchId: values.patchId,
      reachability: NORMALIZED_COMMIT_REACHABILITY,
      lastSeenAt: committedAt,
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

  await ensureObservedCommitContributor(tenantId, repository.id, author);

  await recordParentAndInferAbandonedTips(
    tenantId,
    repository.id,
    commit.id,
    commit.sha,
    attrs.branch,
    attrs.baseCommitSha,
    committedAt,
  );

  if (values.operationKind === 'commit') {
    await inferResetRecommitLineage(
      tenantId,
      repository.id,
      commit.id,
      commit.sha,
      attrs.branch,
      values.patchId,
      committedAt,
    );
  }

  await tenantDb.upsert(
    aiCodeLifecycleEvents,
    {
      repositoryId: repository.id,
      commitId: commit.id,
      stage: 'committed',
      lineCount: committedLinesForOperation(values.operationKind, aiLines),
      evidenceType: 'git_ai_authorship',
      evidenceRef: `commit:${commit.id}`,
      occurredAt: committedAt,
    },
    [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
    {
      lineCount: committedLinesForOperation(values.operationKind, aiLines),
      evidenceType: 'git_ai_authorship',
      occurredAt: committedAt,
    },
  );

  for (const predecessorSha of values.originalCommitShas) {
    const [predecessor] = await tenantDb.select(
      scmCommits,
      and(eq(scmCommits.repositoryId, repository.id), eq(scmCommits.sha, predecessorSha)),
    );
    await tenantDb.insertDoNothing(
      scmCommitLineage,
      {
        repositoryId: repository.id,
        predecessorCommitId: predecessor?.id ?? null,
        predecessorSha,
        successorCommitId: commit.id,
        successorSha: commit.sha,
        operationKind: values.operationKind,
        evidenceSource: 'git_ai_rewrite_event',
        confidence: 100,
        observedAt: committedAt,
      },
      [
        scmCommitLineage.tenantId,
        scmCommitLineage.repositoryId,
        scmCommitLineage.predecessorSha,
        scmCommitLineage.successorSha,
        scmCommitLineage.operationKind,
      ],
    );
    if (predecessor && operationSupersedesPredecessor(values.operationKind)) {
      await tenantDb.update(
        scmCommits,
        { reachability: 'superseded', lastSeenAt: committedAt },
        eq(scmCommits.id, predecessor.id),
      );
    }
  }

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
  const externalSessionContributions: Array<{ sessionId: string; lines: number }> = [];
  const internalSessionRows = new Map<string, string>();
  for (const identity of sessionIdentities) {
    const session = await ensureSession(
      tenantId,
      identity,
      committedAt,
      repository.id,
      'shipped',
    );
    externalSessionContributions.push({
      sessionId: session.id,
      lines: identity.internalId
        ? parsedNote.aiLinesBySession.get(identity.internalId) ?? 0
        : aiLines,
    });
    if (identity.internalId) internalSessionRows.set(identity.internalId, session.id);
  }
  for (const [sessionId, observedAiLines] of aggregateExternalSessionLines(
    externalSessionContributions,
  )) {
    await tenantDb.upsert(
      aiCommitSessions,
      {
        commitId: commit.id,
        sessionId,
        observedAiLines,
      },
      [aiCommitSessions.tenantId, aiCommitSessions.commitId, aiCommitSessions.sessionId],
      {
        observedAiLines,
      },
    );
    await attachGenerationEvidenceToCommit(
      tenantId,
      repository.id,
      commit.id,
      sessionId,
      committedAt,
    );
  }

  const modelAttributions = modelAttributionsFromNote(parsedNote);
  for (const attribution of modelAttributions) {
    const sessionId = attribution.internalSessionId
      ? internalSessionRows.get(attribution.internalSessionId) ?? null
      : null;
    await tenantDb.upsert(
      aiCommitModelAttributions,
      {
        commitId: commit.id,
        sessionId,
        internalSessionId: attribution.internalSessionId,
        tool: attribution.tool,
        model: attribution.model,
        modelKey: attribution.modelKey,
        observedAiLines: committedLinesForOperation(values.operationKind, attribution.lines),
        evidenceType: 'git_ai_authorship_note_model_range',
        evidenceRef: `commit:${commit.id}:model:${attribution.modelKey}`,
      },
      [
        aiCommitModelAttributions.tenantId,
        aiCommitModelAttributions.commitId,
        aiCommitModelAttributions.modelKey,
      ],
      {
        sessionId,
        internalSessionId: attribution.internalSessionId,
        observedAiLines: committedLinesForOperation(values.operationKind, attribution.lines),
        evidenceType: 'git_ai_authorship_note_model_range',
        evidenceRef: `commit:${commit.id}:model:${attribution.modelKey}`,
        updatedAt: new Date(),
      },
    );
    await tenantDb.upsert(
      aiModelLifecycleEvents,
      {
        repositoryId: repository.id,
        sessionId,
        commitId: commit.id,
        tool: attribution.tool,
        model: attribution.model,
        modelKey: attribution.modelKey,
        stage: 'committed',
        lineCount: committedLinesForOperation(values.operationKind, attribution.lines),
        actorKind: 'ai',
        actorModelKey: attribution.modelKey,
        evidenceType: 'git_ai_authorship_note_model_range',
        evidenceRef: `commit:${commit.id}:model:${attribution.modelKey}`,
        occurredAt: committedAt,
      },
      [
        aiModelLifecycleEvents.tenantId,
        aiModelLifecycleEvents.stage,
        aiModelLifecycleEvents.evidenceRef,
      ],
      {
        sessionId,
        lineCount: committedLinesForOperation(values.operationKind, attribution.lines),
        occurredAt: committedAt,
      },
    );
  }
  const predecessorFiles = await loadPredecessorAttributionHistory(
    tenantId,
    repository.id,
    attrs.baseCommitSha,
  );
  await attachRecentReworkEvidence(
    tenantId,
    repository.id,
    commit.id,
    committedAt,
    decodeAiAuthoredDeletionLines(values.hunks, predecessorFiles),
    decodeDeletionFilePaths(values.hunks),
  );
  await projectCommitReworkByOriginModel(
    tenantId, repository.id, commit.id, attrs.baseCommitSha, committedAt,
  );
  await associateCommitWithPullRequest(tenantId, commit.id);
}

async function normalizeSessionEvent(
  tenantId: string,
  event: GitAiMetricEvent,
  attrs: DecodedAttributes,
  sourceEventId: string,
) {
  const usage = event.e === EVENT_KIND.sessionEvent
    ? decodeSessionUsage(event)
    : event.e === EVENT_KIND.otelTrace
      ? decodeOtelUsage(event)
      : null;
  const decodedIdentity = sessionIdentityFromAttrs(attrs);
  if (!decodedIdentity) return;
  const identity = {
    ...decodedIdentity,
    model: decodedIdentity.model ?? usage?.model ?? null,
  };
  const repository = attrs.repoUrl ? await ensureRepository(tenantId, attrs.repoUrl) : null;
  const session = await ensureSession(
    tenantId,
    identity,
    eventDate(event.t),
    repository?.id,
  );
  if (!usage) return;
  const tenantDb = withTenant(db, tenantId);
  const evidenceKey = usage.externalEventId
    ? `git-ai:${attrs.tool ?? 'unknown'}:${usage.externalEventId}`
    : `git-ai:${sourceEventId}`;
  await tenantDb.upsert(
    aiSessionUsage,
    {
      sessionId: session.id,
      model: usage.model ?? attrs.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costAmount: usage.costAmount === null ? null : String(usage.costAmount),
      costUnit: usage.costUnit,
      availability: 'recorded',
      evidenceSource: event.e === EVENT_KIND.otelTrace ? 'git_ai_kind6_otel' : 'git_ai_kind5',
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

async function normalizeCheckpoint(
  tenantId: string,
  event: GitAiMetricEvent,
  attrs: DecodedAttributes,
  sourceEventId: string,
) {
  const checkpoint = decodeCheckpointValues(event.v);
  const isAi = checkpoint.kind === 'ai_agent' || checkpoint.kind === 'ai_tab';
  const isHuman = checkpoint.kind === 'known_human' || checkpoint.kind === 'human';
  if (!isAi && !isHuman) return;
  // All lifecycle funnel stages use physical attributed lines. Final Git Note
  // attribution is physical LoC, so comparing it with SLOC would undercount
  // generation whenever AI emits blank/comment-only lines.
  const { generatedPhysicalLoc: generatedLines, deletedPhysicalLoc: deletedLines }
    = checkpointLifecycleLines(checkpoint);
  if (generatedLines <= 0 && deletedLines <= 0) return;
  const repository = attrs.repoUrl ? await ensureRepository(tenantId, attrs.repoUrl) : null;
  const identity = isAi ? sessionIdentityFromAttrs(attrs) : null;
  const rawTimestamp = checkpoint.checkpointTimestamp;
  const observedAt = rawTimestamp
    ? new Date(rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000)
    : eventDate(event.t);
  const session = identity
    ? await ensureSession(tenantId, identity, observedAt, repository?.id)
    : null;
  const tenantDb = withTenant(db, tenantId);
  if (isAi && generatedLines > 0) {
    await tenantDb.upsert(
      aiGenerationObservations,
      {
        sessionId: session?.id ?? null,
        repositoryId: repository?.id ?? null,
        sourceEventId,
        traceId: attrs.traceId,
        model: attrs.model,
        filePath: checkpoint.filePath,
        generatedLines,
        acceptedLines: null,
        generatedAt: observedAt,
        evidenceSource: 'git_ai_checkpoint_physical_loc',
      },
      [aiGenerationObservations.tenantId, aiGenerationObservations.sourceEventId],
      {
        sessionId: session?.id ?? null,
        repositoryId: repository?.id ?? null,
        traceId: attrs.traceId,
        model: attrs.model,
        filePath: checkpoint.filePath,
        generatedLines,
        generatedAt: observedAt,
        evidenceSource: 'git_ai_checkpoint_physical_loc',
      },
    );
    if (repository) {
      await tenantDb.upsert(
        aiCodeLifecycleEvents,
        {
          repositoryId: repository.id,
          sessionId: session?.id ?? null,
          stage: 'generated',
          lineCount: generatedLines,
          actorKind: 'ai',
          evidenceType: 'git_ai_checkpoint_physical_loc',
          evidenceRef: `checkpoint:${sourceEventId}`,
          occurredAt: observedAt,
        },
        [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
        {
          sessionId: session?.id ?? null,
          lineCount: generatedLines,
          evidenceType: 'git_ai_checkpoint_physical_loc',
          occurredAt: observedAt,
        },
      );
      const key = modelKey(attrs.tool, attrs.model);
      await tenantDb.upsert(
        aiModelLifecycleEvents,
        {
          repositoryId: repository.id,
          sessionId: session?.id ?? null,
          tool: attrs.tool ?? 'unknown',
          model: attrs.model,
          modelKey: key,
          stage: 'generated',
          lineCount: generatedLines,
          actorKind: 'ai',
          actorModelKey: key,
          evidenceType: 'git_ai_checkpoint_physical_loc',
          evidenceRef: `checkpoint:${sourceEventId}:model:${key}`,
          occurredAt: observedAt,
        },
        [
          aiModelLifecycleEvents.tenantId,
          aiModelLifecycleEvents.stage,
          aiModelLifecycleEvents.evidenceRef,
        ],
        { sessionId: session?.id ?? null, lineCount: generatedLines, occurredAt: observedAt },
      );
    }
  }
  if (repository && deletedLines > 0) {
    const deletionBuckets = checkpointDeletionBuckets(checkpoint);
    for (const evidence of [
      {
        stage: 'reworked',
        lineCount: deletionBuckets.aiReworkedLines,
        evidenceType: 'git_ai_checkpoint_ai_authored_deletion',
      },
      {
        stage: 'deletion_observed',
        lineCount: deletionBuckets.unresolvedLines,
        evidenceType: 'git_ai_checkpoint_deletion',
      },
    ]) {
      if (evidence.lineCount <= 0) continue;
      await tenantDb.upsert(
        aiCodeLifecycleEvents,
        {
          repositoryId: repository.id,
          sessionId: session?.id ?? null,
          stage: evidence.stage,
          lineCount: evidence.lineCount,
          actorKind: isAi ? 'ai' : 'human',
          evidenceType: evidence.evidenceType,
          evidenceRef: `checkpoint-delete:${sourceEventId}`,
          confidence: 100,
          occurredAt: observedAt,
        },
        [aiCodeLifecycleEvents.tenantId, aiCodeLifecycleEvents.stage, aiCodeLifecycleEvents.evidenceRef],
        {
          sessionId: session?.id ?? null,
          lineCount: evidence.lineCount,
          actorKind: isAi ? 'ai' : 'human',
          evidenceType: evidence.evidenceType,
          occurredAt: observedAt,
        },
      );
    }
  }
}

/** Rebuild normalized generation/rework rows from immutable raw checkpoint events. */
export async function rebuildGenerationEvidence(
  tenantId: string,
  repositoryUrl: string,
  apply: boolean,
) {
  const tenantDb = withTenant(db, tenantId);
  const targetRepository = normalizeRepositoryUrl(repositoryUrl);
  if (!targetRepository) throw new Error('A valid repository URL is required');
  const rows = await tenantDb.select(
    telemetryMetricEvents,
    eq(telemetryMetricEvents.eventKind, EVENT_KIND.checkpoint),
  );
  let checkpointEvents = 0;
  let generatedPhysicalLoc = 0;
  let deletedPhysicalLoc = 0;
  for (const row of rows) {
    const event = validateMetricEvent(row.rawEvent);
    const attrs = decodeAttributes(event.a);
    if (!attrs.repoUrl || normalizeRepositoryUrl(attrs.repoUrl) !== targetRepository) continue;
    const checkpoint = decodeCheckpointValues(event.v);
    const isAi = checkpoint.kind === 'ai_agent' || checkpoint.kind === 'ai_tab';
    const isHuman = checkpoint.kind === 'known_human' || checkpoint.kind === 'human';
    if (!isAi && !isHuman) continue;
    checkpointEvents += 1;
    if (isAi) generatedPhysicalLoc += checkpoint.linesAdded;
    deletedPhysicalLoc += checkpoint.linesDeleted;
    if (apply) await normalizeCheckpoint(tenantId, event, attrs, row.id);
  }
  return { targetRepository, checkpointEvents, generatedPhysicalLoc, deletedPhysicalLoc };
}

/** Rebuild commit reachability, rewrite/reset lineage and committed totals. */
export async function rebuildCommitLifecycle(
  tenantId: string,
  repositoryUrl: string,
  apply: boolean,
) {
  const tenantDb = withTenant(db, tenantId);
  const targetRepository = normalizeRepositoryUrl(repositoryUrl);
  if (!targetRepository) throw new Error('A valid repository URL is required');
  const rows = (await tenantDb.select(telemetryMetricEvents))
    .filter((row) => row.eventKind === EVENT_KIND.committed
      || row.eventKind === EVENT_KIND.rewriteCommitted)
    .map((row) => ({ row, event: validateMetricEvent(row.rawEvent) }))
    .filter(({ event }) => {
      const repoUrl = decodeAttributes(event.a).repoUrl;
      return Boolean(repoUrl) && normalizeRepositoryUrl(repoUrl!) === targetRepository;
    })
    .sort((left, right) => left.event.t - right.event.t);
  if (apply) {
    const [repository] = await tenantDb.select(
      scmRepositories,
      eq(scmRepositories.normalizedUrl, targetRepository),
    );
    if (repository) {
      await tenantDb.delete(
        aiCodeLifecycleEvents,
        and(
          eq(aiCodeLifecycleEvents.repositoryId, repository.id),
          eq(aiCodeLifecycleEvents.evidenceType, 'git_ai_commit_hunk_deletion'),
        ),
      );
      await tenantDb.update(
        aiCodeLifecycleEvents,
        { commitId: null },
        and(
          eq(aiCodeLifecycleEvents.repositoryId, repository.id),
          eq(aiCodeLifecycleEvents.stage, 'generated'),
        ),
      );
    }
  }
  let commitEvents = 0;
  let rewriteEvents = 0;
  for (const { row, event } of rows) {
    commitEvents += 1;
    if (event.e === EVENT_KIND.rewriteCommitted) rewriteEvents += 1;
    if (apply) {
      await normalizeCommit(tenantId, event, decodeAttributes(event.a), row.id);
    }
  }
  return { targetRepository, commitEvents, rewriteEvents };
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
    || event.e === EVENT_KIND.sessionEvent
    || event.e === EVENT_KIND.otelTrace
  ) {
    await normalizeSessionEvent(tenantId, event, attrs, sourceEventId);
  }
  if (event.e === EVENT_KIND.checkpoint) {
    await normalizeSessionEvent(tenantId, event, attrs, sourceEventId);
    await normalizeCheckpoint(tenantId, event, attrs, sourceEventId);
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
