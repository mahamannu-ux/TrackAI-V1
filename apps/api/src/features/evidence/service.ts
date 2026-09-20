import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import {
  aiCommitSessions,
  aiCodeLifecycleEvents,
  aiGenerationObservations,
  aiSessionRepositories,
  aiSessions,
  evidenceEventContents,
  evidenceEvents,
  evidenceIntentionEmbeddings,
  evidenceIntentions,
  evidenceLinks,
  evidenceSemanticDocuments,
  evidenceSemanticJobs,
  evidenceSummaries,
  scmCommitFiles,
  scmCommits,
  scmRepositories,
  securityAuditEvents,
  tenantEvidenceSettings,
} from '../../core/db/schema';
import { decryptEnvelope, encryptEnvelope, type EncryptedValue } from '../../core/security/envelope-encryption';
import { machineCanAccessRepository } from '../../core/security/repository-security-service';
import {
  contentFingerprint,
  inferredIntentionFromPrompt,
  redactSecrets,
  shouldCreateIntentionVersion,
  type EvidenceAvailability,
  type EvidenceState,
  type OpenCodeEvidenceBatchInput,
} from './contract';
import {
  LocalBgeCommandEngine,
  SEMANTIC_CANDIDATE_LIMIT,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MAX_ATTEMPTS,
  SEMANTIC_MODEL,
  normalizeEmbedding,
  reciprocalRankFusion,
  semanticSafeError,
  type EmbeddingEngine,
} from './semantic';

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;

function envelope(value: unknown, tenantId: string, purpose: string, resourceId: string) {
  return encryptEnvelope(JSON.stringify(value), { tenantId, purpose, resourceId }) as unknown as Record<string, unknown>;
}

function openEnvelope<T>(
  value: Record<string, unknown>, tenantId: string, purpose: string, resourceId: string,
): T {
  return JSON.parse(decryptEnvelope(value as unknown as EncryptedValue, {
    tenantId, purpose, resourceId,
  })) as T;
}

function configuredSemanticRevision() {
  return process.env.TRACKAI_BGE_REVISION?.trim() || 'unconfigured-local-bge';
}

async function enqueueSemanticJob(
  tenantId: string,
  intention: typeof evidenceIntentions.$inferSelect,
) {
  const created = await withTenant(db, tenantId).insertDoNothing(evidenceSemanticJobs, {
    intentionId: intention.id,
    contentFingerprint: intention.contentFingerprint,
    modelRevision: configuredSemanticRevision(),
    state: 'pending',
    attemptCount: 0,
    safeErrorCode: null,
    availableAt: new Date(),
    lockedAt: null,
    expiresAt: intention.expiresAt,
  }, [
    evidenceSemanticJobs.tenantId,
    evidenceSemanticJobs.intentionId,
    evidenceSemanticJobs.contentFingerprint,
    evidenceSemanticJobs.modelRevision,
  ]);
  return created.length > 0;
}

async function createOrReviseIntention(input: {
  tenantId: string;
  sessionId: string;
  sourceEventId: string | null;
  value: string;
  evidenceState: 'observed' | 'inferred';
  confidence: number;
  expiresAt: Date;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const redacted = redactSecrets(input.value);
  const value = String(redacted.value).replace(/\s+/g, ' ').trim();
  const fingerprint = contentFingerprint(value);
  const existing = (await tenantDb.select(
    evidenceIntentions,
    and(eq(evidenceIntentions.sessionId, input.sessionId), eq(evidenceIntentions.isCurrent, true)),
  )).sort((left, right) => right.version - left.version)[0];
  if (existing && !shouldCreateIntentionVersion({
    existingFingerprint: existing.contentFingerprint,
    existingState: existing.evidenceState,
    nextFingerprint: fingerprint,
    nextState: input.evidenceState,
  })) return existing;
  if (existing) {
    await tenantDb.update(evidenceIntentions, { isCurrent: false }, eq(evidenceIntentions.id, existing.id));
  }
  const id = randomUUID();
  const [created] = await tenantDb.insert(evidenceIntentions, {
    id,
    seriesId: existing?.seriesId ?? randomUUID(),
    version: (existing?.version ?? 0) + 1,
    lifecycle: 'provisional',
    supersedesIntentionId: existing?.id ?? null,
    isCurrent: true,
    sessionId: input.sessionId,
    sourceEventId: input.sourceEventId,
    encryptedValue: envelope(value, input.tenantId, 'evidence-intention', id),
    contentFingerprint: fingerprint,
    evidenceState: input.evidenceState,
    confidence: input.confidence,
    semanticAvailability: 'pending',
    expiresAt: input.expiresAt,
  });
  if (!created) throw new Error('Evidence intention creation failed');
  await enqueueSemanticJob(input.tenantId, created);
  return created;
}

export async function evidenceSettings(tenantId: string) {
  const [settings] = await withTenant(db, tenantId).select(
    tenantEvidenceSettings,
    eq(tenantEvidenceSettings.provider, 'opencode'),
  );
  return settings ?? {
    id: null,
    tenantId,
    provider: 'opencode' as const,
    rawCollectionEnabled: false,
    retentionDays: RETENTION_DAYS,
    consentedBy: null,
    consentedAt: null,
    disabledAt: null,
    updatedAt: null,
  };
}

export async function setEvidenceConsent(input: {
  tenantId: string;
  actorId: string;
  enabled: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async transaction => {
    const [settings] = await transaction.insert(tenantEvidenceSettings).values({
      tenantId: input.tenantId,
      provider: 'opencode',
      rawCollectionEnabled: input.enabled,
      retentionDays: RETENTION_DAYS,
      consentedBy: input.enabled ? input.actorId : null,
      consentedAt: input.enabled ? now : null,
      disabledAt: input.enabled ? null : now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [tenantEvidenceSettings.tenantId, tenantEvidenceSettings.provider],
      set: {
        rawCollectionEnabled: input.enabled,
        consentedBy: input.enabled ? input.actorId : null,
        consentedAt: input.enabled ? now : null,
        disabledAt: input.enabled ? null : now,
        updatedAt: now,
      },
    }).returning();
    if (!settings) throw new Error('Evidence consent update failed');
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: input.enabled ? 'evidence.collection.enabled' : 'evidence.collection.disabled',
      targetType: 'tenant_evidence_settings',
      targetId: settings.id,
      details: { provider: 'opencode', retentionDays: RETENTION_DAYS },
    });
    return settings;
  });
}

async function evidenceSession(
  tenantId: string,
  batch: OpenCodeEvidenceBatchInput,
  observedAt: Date,
) {
  const tenantDb = withTenant(db, tenantId);
  const [existing] = await tenantDb.select(aiSessions, and(
    eq(aiSessions.tool, 'opencode'),
    eq(aiSessions.externalSessionId, batch.externalSessionId),
  ));
  if (existing) {
    const models = new Set(Array.isArray(existing.observedModels) ? existing.observedModels as string[] : []);
    batch.events.forEach(event => { if (event.model) models.add(event.model); });
    const [updated] = await tenantDb.update(aiSessions, {
      gitAiSessionId: batch.gitAiSessionId ?? existing.gitAiSessionId,
      observedModels: [...models],
      startedAt: existing.startedAt && existing.startedAt < observedAt ? existing.startedAt : observedAt,
      endedAt: existing.endedAt && existing.endedAt > observedAt ? existing.endedAt : observedAt,
      updatedAt: new Date(),
    }, eq(aiSessions.id, existing.id));
    return updated ?? existing;
  }
  const models = [...new Set(batch.events.flatMap(event => event.model ? [event.model] : []))];
  const [created] = await tenantDb.upsert(aiSessions, {
    externalSessionId: batch.externalSessionId,
    gitAiSessionId: batch.gitAiSessionId,
    tool: 'opencode',
    displayName: `OpenCode session ${batch.externalSessionId.slice(0, 12)}`,
    observedModels: models,
    startedAt: observedAt,
    endedAt: observedAt,
  }, [aiSessions.tenantId, aiSessions.tool, aiSessions.externalSessionId], {
    ...(batch.gitAiSessionId ? { gitAiSessionId: batch.gitAiSessionId } : {}),
    observedModels: models,
    updatedAt: new Date(),
  });
  if (!created) throw new Error('Evidence session creation failed');
  return created;
}

async function validateEvidenceRepository(
  tenantId: string,
  repositoryId: string | null,
  machineId?: string,
) {
  if (!repositoryId) return null;
  const [repository] = await withTenant(db, tenantId).select(
    scmRepositories,
    eq(scmRepositories.id, repositoryId),
  );
  if (!repository) throw new Error('Evidence repository is not in the tenant');
  if (machineId && !await machineCanAccessRepository({
    tenantId, machineId, repositoryId, branch: null,
  })) {
    throw new Error('Machine repository grant is not active');
  }
  return repository;
}

export async function ingestOpenCodeEvidence(input: {
  tenantId: string;
  machineId?: string;
  batch: OpenCodeEvidenceBatchInput;
  now?: Date;
}) {
  const settings = await evidenceSettings(input.tenantId);
  if (!settings.rawCollectionEnabled) throw new Error('OpenCode evidence collection is not enabled');
  await validateEvidenceRepository(input.tenantId, input.batch.repositoryId, input.machineId);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RETENTION_MS);
  const firstObserved = input.batch.events.reduce(
    (earliest, event) => event.occurredAt < earliest ? event.occurredAt : earliest,
    input.batch.events[0].occurredAt,
  );
  const session = await evidenceSession(input.tenantId, input.batch, firstObserved);
  const tenantDb = withTenant(db, input.tenantId);
  const insertedEventIds: string[] = [];
  let duplicateCount = 0;
  let firstPrompt: { eventId: string; value: unknown } | null = null;

  for (const source of input.batch.events) {
    const redacted = redactSecrets(source.content);
    const hasContent = redacted.value !== null && redacted.value !== undefined;
    const availability: EvidenceAvailability = !hasContent
      ? 'unavailable'
      : redacted.changed ? 'redacted' : 'available';
    const metadata = redactSecrets(source.metadata);
    const [event] = await tenantDb.insertDoNothing(evidenceEvents, {
      sessionId: session.id,
      repositoryId: input.batch.repositoryId,
      provider: 'opencode',
      providerEventId: source.providerEventId,
      eventType: source.type,
      traceId: source.traceId,
      model: source.model,
      toolName: source.toolName,
      evidenceState: 'observed',
      availability,
      sourceVersion: input.batch.sourceVersion,
      metadata: { ...metadata.value as Record<string, unknown>, batchId: input.batch.batchId },
      contentSha256: hasContent ? contentFingerprint(redacted.value) : null,
      occurredAt: source.occurredAt,
      expiresAt,
    }, [evidenceEvents.tenantId, evidenceEvents.provider, evidenceEvents.providerEventId]);
    if (!event) { duplicateCount += 1; continue; }
    insertedEventIds.push(event.id);
    if (hasContent) {
      await tenantDb.insert(evidenceEventContents, {
        eventId: event.id,
        encryptedValue: envelope(redacted.value, input.tenantId, 'evidence-event', event.id),
        redactionSummary: { ...redacted.counts, ...metadata.counts },
        expiresAt,
      });
    }
    await tenantDb.insertDoNothing(evidenceLinks, {
      fromType: 'event', fromId: event.id,
      toType: 'session', toId: session.id,
      relationship: 'occurred_in', evidenceState: 'observed', confidence: 100,
      basis: 'provider_session_id', correctedFromLinkId: null,
    }, [
      evidenceLinks.tenantId, evidenceLinks.fromType, evidenceLinks.fromId,
      evidenceLinks.toType, evidenceLinks.toId, evidenceLinks.relationship,
    ]);
    if (source.traceId) {
      await tenantDb.insertDoNothing(evidenceLinks, {
        fromType: 'event', fromId: event.id,
        toType: 'trace', toId: source.traceId,
        relationship: 'reported_trace', evidenceState: 'observed', confidence: 100,
        basis: 'provider_trace_id', correctedFromLinkId: null,
      }, [
        evidenceLinks.tenantId, evidenceLinks.fromType, evidenceLinks.fromId,
        evidenceLinks.toType, evidenceLinks.toId, evidenceLinks.relationship,
      ]);
    }
    if (!firstPrompt && source.type === 'prompt') firstPrompt = { eventId: event.id, value: redacted.value };
  }

  const intentionText = input.batch.intention
    ?? inferredIntentionFromPrompt(firstPrompt?.value ?? null);
  let intentionId: string | null = null;
  if (intentionText && insertedEventIds.length > 0) {
    const explicit = Boolean(input.batch.intention);
    const intention = await createOrReviseIntention({
      tenantId: input.tenantId,
      sessionId: session.id,
      sourceEventId: explicit ? null : firstPrompt?.eventId ?? null,
      value: intentionText,
      evidenceState: explicit ? 'observed' : 'inferred',
      confidence: explicit ? 100 : 70,
      expiresAt,
    });
    if (intention) {
      intentionId = intention.id;
      await tenantDb.insertDoNothing(evidenceLinks, {
        fromType: 'intention', fromId: intention.id,
        toType: 'session', toId: session.id,
        relationship: 'describes', evidenceState: explicit ? 'observed' : 'inferred',
        confidence: explicit ? 100 : 70,
        basis: explicit ? 'explicit_client_intention' : 'first_prompt_summary',
        correctedFromLinkId: null,
      }, [
        evidenceLinks.tenantId, evidenceLinks.fromType, evidenceLinks.fromId,
        evidenceLinks.toType, evidenceLinks.toId, evidenceLinks.relationship,
      ]);
    }
  }

  return {
    accepted: insertedEventIds.length,
    duplicates: duplicateCount,
    sessionId: session.id,
    intentionId,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function readRawEvidence(input: {
  tenantId: string;
  eventId: string;
  actorId: string;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const [event] = await tenantDb.select(evidenceEvents, eq(evidenceEvents.id, input.eventId));
  if (!event) return null;
  const [content] = await tenantDb.select(evidenceEventContents, eq(evidenceEventContents.eventId, event.id));
  if (!content || content.expiresAt <= new Date()) return { event, content: null, availability: 'expired' as const };
  const value = openEnvelope<unknown>(content.encryptedValue, input.tenantId, 'evidence-event', event.id);
  await tenantDb.insert(securityAuditEvents, {
    actorType: 'tenant_user', actorId: input.actorId,
    action: 'evidence.raw.read', targetType: 'evidence_event', targetId: event.id,
    details: { provider: event.provider, eventType: event.eventType },
  });
  return { event, content: value, availability: event.availability };
}

export async function correctIntention(input: {
  tenantId: string;
  intentionId: string;
  actorId: string;
  value: string;
  reason: string;
  now?: Date;
}) {
  const value = input.value.replace(/\s+/g, ' ').trim();
  const reason = input.reason.trim();
  if (!value || value.length > 10_000) throw new Error('Corrected intention is invalid');
  if (!reason || reason.length > 1_000) throw new Error('Correction reason is required');
  const tenantDb = withTenant(db, input.tenantId);
  const [original] = await tenantDb.select(
    evidenceIntentions,
    eq(evidenceIntentions.id, input.intentionId),
  );
  if (!original) return null;
  if (original.expiresAt <= (input.now ?? new Date())) throw new Error('Expired intention cannot be corrected');
  const redacted = redactSecrets(value);
  const now = input.now ?? new Date();
  const series = await tenantDb.select(
    evidenceIntentions,
    eq(evidenceIntentions.seriesId, original.seriesId),
  );
  const current = series.find(row => row.isCurrent) ?? original;
  const nextVersion = Math.max(...series.map(row => row.version), original.version) + 1;
  await tenantDb.update(
    evidenceIntentions,
    { isCurrent: false },
    eq(evidenceIntentions.seriesId, original.seriesId),
  );
  const correctedId = randomUUID();
  const fingerprint = contentFingerprint(String(redacted.value));
  const [corrected] = await tenantDb.insert(evidenceIntentions, {
    id: correctedId,
    seriesId: original.seriesId,
    version: nextVersion,
    lifecycle: current.lifecycle,
    supersedesIntentionId: current.id,
    isCurrent: true,
    sessionId: original.sessionId,
    sourceEventId: original.sourceEventId,
    encryptedValue: envelope(redacted.value, input.tenantId, 'evidence-intention', correctedId),
    contentFingerprint: fingerprint,
    evidenceState: 'corrected',
    confidence: 100,
    semanticAvailability: 'pending',
    expiresAt: original.expiresAt,
    createdAt: now,
  });
  if (!corrected) throw new Error('Intention correction failed');
  await enqueueSemanticJob(input.tenantId, corrected);
  await tenantDb.insert(evidenceLinks, {
    fromType: 'intention', fromId: corrected.id,
    toType: 'intention', toId: original.id,
    relationship: 'corrects', evidenceState: 'corrected', confidence: 100,
    basis: 'tenant_admin_correction', correctedFromLinkId: null,
  });
  if (corrected.sessionId) await tenantDb.insert(evidenceLinks, {
    fromType: 'intention', fromId: corrected.id,
    toType: 'session', toId: corrected.sessionId,
    relationship: 'describes', evidenceState: 'corrected', confidence: 100,
    basis: 'tenant_admin_correction', correctedFromLinkId: null,
  });
  await tenantDb.insert(securityAuditEvents, {
    actorType: 'tenant_admin', actorId: input.actorId,
    action: 'evidence.intention.corrected', targetType: 'evidence_intention', targetId: corrected.id,
    details: { correctedFromIntentionId: original.id, reason },
  });
  return { id: corrected.id, correctedFromIntentionId: original.id,
    evidenceState: corrected.evidenceState, expiresAt: corrected.expiresAt.toISOString() };
}

export async function purgeExpiredEvidence(tenantId: string, actorId: string, now = new Date()) {
  const tenantDb = withTenant(db, tenantId);
  const expiredEvents = await tenantDb.select(evidenceEvents, lte(evidenceEvents.expiresAt, now));
  const expiredIntentions = await tenantDb.select(evidenceIntentions, lte(evidenceIntentions.expiresAt, now));
  const eventIds = expiredEvents.map(row => row.id);
  const intentionIds = expiredIntentions.map(row => row.id);
  if (eventIds.length) {
    await tenantDb.delete(evidenceEventContents, inArray(evidenceEventContents.eventId, eventIds));
    await tenantDb.update(evidenceEvents, {
      availability: 'expired', contentSha256: null,
    }, inArray(evidenceEvents.id, eventIds));
  }
  if (intentionIds.length) {
    await tenantDb.delete(evidenceIntentionEmbeddings,
      inArray(evidenceIntentionEmbeddings.intentionId, intentionIds));
    await tenantDb.delete(evidenceSemanticJobs,
      inArray(evidenceSemanticJobs.intentionId, intentionIds));
    await tenantDb.delete(evidenceSemanticDocuments,
      inArray(evidenceSemanticDocuments.intentionId, intentionIds));
    await tenantDb.delete(evidenceIntentions, inArray(evidenceIntentions.id, intentionIds));
    await tenantDb.delete(evidenceLinks, or(
      and(eq(evidenceLinks.fromType, 'intention'), inArray(evidenceLinks.fromId, intentionIds)),
      and(eq(evidenceLinks.toType, 'intention'), inArray(evidenceLinks.toId, intentionIds)),
    ));
  }
  const expiredSummaries = await tenantDb.delete(
    evidenceSummaries,
    lte(evidenceSummaries.expiresAt, now),
  );
  await tenantDb.insert(securityAuditEvents, {
    actorType: 'tenant_admin', actorId,
    action: 'evidence.retention.purged', targetType: 'tenant', targetId: tenantId,
    details: {
      expiredEvents: eventIds.length,
      expiredIntentions: intentionIds.length,
      expiredSummaries: expiredSummaries.length,
      expiredSemanticIndexes: intentionIds.length,
    },
  });
  return {
    expiredEvents: eventIds.length,
    expiredIntentions: intentionIds.length,
    expiredSummaries: expiredSummaries.length,
  };
}

type GraphNode = {
  type: string;
  id: string;
  label: string;
  occurredAt?: string | null;
  evidenceState: EvidenceState;
  availability: EvidenceAvailability;
  data?: Record<string, unknown>;
};

type GraphEdge = {
  fromType: string; fromId: string; toType: string; toId: string;
  relationship: string; evidenceState: EvidenceState; confidence: number; basis: string;
};

function graphEdgeKey(edge: GraphEdge) {
  return [
    edge.fromType, edge.fromId, edge.toType, edge.toId, edge.relationship,
    edge.evidenceState, edge.confidence, edge.basis,
  ].join(':');
}

export function uniqueGraphEdges(edges: GraphEdge[]) {
  return [...new Map(edges.map(edge => [graphEdgeKey(edge), edge])).values()];
}

export function edgesForNodePage(edges: GraphEdge[], pageKeys: ReadonlySet<string>) {
  // An edge belongs to the page containing its source node. Requiring both
  // endpoints to share a page silently drops cross-page relationships, while
  // emitting on either endpoint duplicates them when pages are merged.
  return edges.filter(edge => pageKeys.has(`${edge.fromType}:${edge.fromId}`));
}

function rangeRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
}

export async function evidenceGraph(input: {
  tenantId: string;
  rootType: 'commit' | 'session' | 'intention' | 'event' | 'trace' | 'checkpoint';
  rootId: string;
  path?: string;
  line?: number;
  cursor?: number;
  limit?: number;
}) {
  const tenantDb = withTenant(db, input.tenantId);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (node: GraphNode) => nodes.set(`${node.type}:${node.id}`, node);
  const addEdge = (edge: GraphEdge) => edges.push(edge);
  const sessionIds = new Set<string>();
  const commitIds = new Set<string>();

  if (input.rootType === 'commit') commitIds.add(input.rootId);
  if (input.rootType === 'session') sessionIds.add(input.rootId);
  if (input.rootType === 'event') {
    const [event] = await tenantDb.select(evidenceEvents, eq(evidenceEvents.id, input.rootId));
    if (event) sessionIds.add(event.sessionId);
  }
  if (input.rootType === 'intention') {
    const [intention] = await tenantDb.select(evidenceIntentions, eq(evidenceIntentions.id, input.rootId));
    if (intention?.sessionId) sessionIds.add(intention.sessionId);
  }
  if (input.rootType === 'trace') {
    const traced = await tenantDb.select(evidenceEvents, eq(evidenceEvents.traceId, input.rootId));
    traced.forEach(event => sessionIds.add(event.sessionId));
    const checkpointTraces = await tenantDb.select(
      aiGenerationObservations,
      eq(aiGenerationObservations.traceId, input.rootId),
    );
    checkpointTraces.forEach(checkpoint => {
      if (checkpoint.sessionId) sessionIds.add(checkpoint.sessionId);
    });
    if (traced.length || checkpointTraces.length) addNode({
      type: 'trace', id: input.rootId, label: `Trace ${input.rootId}`,
      evidenceState: 'observed', availability: 'available',
    });
  }
  if (input.rootType === 'checkpoint') {
    const [checkpoint] = await tenantDb.select(
      aiGenerationObservations,
      eq(aiGenerationObservations.sourceEventId, input.rootId),
    );
    if (checkpoint?.sessionId) sessionIds.add(checkpoint.sessionId);
  }

  if (commitIds.size) {
    const commits = await tenantDb.select(scmCommits, inArray(scmCommits.id, [...commitIds]));
    commits.forEach(commit => addNode({
      type: 'commit', id: commit.id, label: `${commit.sha.slice(0, 8)} ${commit.subject}`,
      occurredAt: (commit.committedAt ?? commit.createdAt).toISOString(),
      evidenceState: 'observed', availability: 'available',
      data: { sha: commit.sha, subject: commit.subject, reachability: commit.reachability },
    }));
    const commitSessionRows = await tenantDb.select(
      aiCommitSessions,
      inArray(aiCommitSessions.commitId, [...commitIds]),
    );
    commitSessionRows.forEach(link => {
      sessionIds.add(link.sessionId);
      addEdge({ fromType: 'commit', fromId: link.commitId, toType: 'session', toId: link.sessionId,
        relationship: 'contains_attribution_from', evidenceState: 'observed', confidence: 100,
        basis: 'git_ai_authorship_note' });
    });
    const files = await tenantDb.select(scmCommitFiles, inArray(scmCommitFiles.commitId, [...commitIds]));
    files.filter(file => !input.path || file.path === input.path).forEach(file => {
      addNode({ type: 'code_range', id: file.id, label: file.path,
        evidenceState: 'observed', availability: 'available', data: {
          path: file.path, aiLines: file.observedAiLines, humanLines: file.observedHumanLines,
        } });
      addEdge({ fromType: 'commit', fromId: file.commitId, toType: 'code_range', toId: file.id,
        relationship: 'contains', evidenceState: 'observed', confidence: 100, basis: 'git_ai_authorship_note' });
      for (const range of rangeRecords(file.attributionRanges)) {
        const start = Number(range.startLine); const end = Number(range.endLine);
        if (input.line && !(start <= input.line && input.line <= end)) continue;
        const traceId = typeof range.traceId === 'string' ? range.traceId : null;
        if (!traceId) continue;
        addNode({ type: 'trace', id: traceId, label: `Trace ${traceId}`,
          evidenceState: 'observed', availability: 'available', data: { startLine: start, endLine: end } });
        addEdge({ fromType: 'code_range', fromId: file.id, toType: 'trace', toId: traceId,
          relationship: 'attributed_to', evidenceState: 'observed', confidence: 100,
          basis: 'git_ai_range_attestation' });
      }
    });
  }

  if (sessionIds.size) {
    const sessions = await tenantDb.select(aiSessions, inArray(aiSessions.id, [...sessionIds]));
    sessions.forEach(session => addNode({ type: 'session', id: session.id,
      label: session.displayName ?? `${session.tool} session`, occurredAt: session.startedAt?.toISOString() ?? null,
      evidenceState: 'observed', availability: 'available',
      data: { tool: session.tool, gitAiSessionId: session.gitAiSessionId, models: session.observedModels },
    }));
    if (!commitIds.size) {
      const links = await tenantDb.select(aiCommitSessions, inArray(aiCommitSessions.sessionId, [...sessionIds]));
      links.forEach(link => {
        commitIds.add(link.commitId);
        addEdge({ fromType: 'commit', fromId: link.commitId, toType: 'session', toId: link.sessionId,
          relationship: 'contains_attribution_from', evidenceState: 'observed', confidence: 100,
          basis: 'git_ai_authorship_note' });
      });
      const commits = commitIds.size
        ? await tenantDb.select(scmCommits, inArray(scmCommits.id, [...commitIds])) : [];
      commits.forEach(commit => addNode({ type: 'commit', id: commit.id,
        label: `${commit.sha.slice(0, 8)} ${commit.subject}`,
        occurredAt: (commit.committedAt ?? commit.createdAt).toISOString(),
        evidenceState: 'observed', availability: 'available' }));
    }
    const events = await tenantDb.select(evidenceEvents, inArray(evidenceEvents.sessionId, [...sessionIds]));
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).forEach(event => {
      addNode({ type: 'event', id: event.id, label: event.toolName
        ? `${event.eventType}: ${event.toolName}` : event.eventType,
      occurredAt: event.occurredAt.toISOString(), evidenceState: event.evidenceState,
      availability: event.availability, data: {
        eventType: event.eventType, model: event.model, traceId: event.traceId,
        toolName: event.toolName, metadata: event.metadata,
      } });
      addEdge({ fromType: 'event', fromId: event.id, toType: 'session', toId: event.sessionId,
        relationship: 'occurred_in', evidenceState: 'observed', confidence: 100,
        basis: 'provider_session_id' });
      if (event.traceId) {
        addNode({ type: 'trace', id: event.traceId, label: `Trace ${event.traceId}`,
          evidenceState: 'observed', availability: 'available' });
        addEdge({ fromType: 'event', fromId: event.id, toType: 'trace', toId: event.traceId,
          relationship: 'reported_trace', evidenceState: 'observed', confidence: 100,
          basis: 'provider_trace_id' });
      }
    });
    const intentions = await tenantDb.select(evidenceIntentions, inArray(evidenceIntentions.sessionId, [...sessionIds]));
    intentions.forEach(intention => {
      const available = intention.expiresAt > new Date();
      const label = available
        ? openEnvelope<string>(intention.encryptedValue, input.tenantId, 'evidence-intention', intention.id)
        : 'Expired intention';
      addNode({ type: 'intention', id: intention.id, label,
        occurredAt: intention.createdAt.toISOString(), evidenceState: intention.evidenceState,
        availability: available ? 'available' : 'expired',
        data: {
          confidence: intention.confidence,
          seriesId: intention.seriesId,
          version: intention.version,
          lifecycle: intention.lifecycle,
          isCurrent: intention.isCurrent,
          semanticAvailability: intention.semanticAvailability,
        } });
      if (intention.sessionId) addEdge({ fromType: 'intention', fromId: intention.id,
        toType: 'session', toId: intention.sessionId, relationship: 'describes',
        evidenceState: intention.evidenceState, confidence: intention.confidence,
        basis: intention.evidenceState === 'observed' ? 'explicit_client_intention' : 'first_prompt_summary' });
    });
    const checkpoints = await tenantDb.select(
      aiGenerationObservations,
      inArray(aiGenerationObservations.sessionId, [...sessionIds]),
    );
    checkpoints.forEach(checkpoint => {
      addNode({ type: 'checkpoint', id: checkpoint.sourceEventId,
        label: `GitAI checkpoint · ${checkpoint.filePath ?? 'unknown file'}`,
        occurredAt: checkpoint.generatedAt.toISOString(), evidenceState: 'observed', availability: 'available',
        data: { traceId: checkpoint.traceId, generatedLines: checkpoint.generatedLines } });
      if (checkpoint.sessionId) addEdge({ fromType: 'checkpoint', fromId: checkpoint.sourceEventId,
        toType: 'session', toId: checkpoint.sessionId, relationship: 'recorded_in',
        evidenceState: 'observed', confidence: 100, basis: 'git_ai_checkpoint_event' });
      if (checkpoint.traceId) addEdge({ fromType: 'checkpoint', fromId: checkpoint.sourceEventId,
        toType: 'trace', toId: checkpoint.traceId, relationship: 'identified_by',
        evidenceState: 'observed', confidence: 100, basis: 'git_ai_checkpoint_trace' });
    });
  }

  const storedLinks = await tenantDb.select(evidenceLinks);
  for (const link of storedLinks) {
    if (nodes.has(`${link.fromType}:${link.fromId}`) && nodes.has(`${link.toType}:${link.toId}`)) {
      addEdge({ fromType: link.fromType, fromId: link.fromId, toType: link.toType,
        toId: link.toId, relationship: link.relationship, evidenceState: link.evidenceState,
        confidence: link.confidence, basis: link.basis });
    }
  }
  const allNodes = [...nodes.values()];
  const allEdges = uniqueGraphEdges(edges);
  const cursor = Math.max(0, input.cursor ?? 0);
  const limit = Math.min(200, Math.max(1, input.limit ?? 100));
  const page = allNodes.slice(cursor, cursor + limit);
  const pageKeys = new Set(page.map(node => `${node.type}:${node.id}`));
  return {
    root: { type: input.rootType, id: input.rootId },
    nodes: page,
    edges: edgesForNodePage(allEdges, pageKeys),
    nextCursor: cursor + limit < allNodes.length ? cursor + limit : null,
  };
}

export async function explainCommit(tenantId: string, commitId: string) {
  const graph = await evidenceGraph({ tenantId, rootType: 'commit', rootId: commitId, limit: 200 });
  const commit = graph.nodes.find(node => node.type === 'commit');
  if (!commit) return null;
  const intentions = graph.nodes.filter(node => node.type === 'intention')
    .sort((left, right) => {
      const current = Number(Boolean(right.data?.isCurrent)) - Number(Boolean(left.data?.isCurrent));
      if (current) return current;
      const priority: Record<EvidenceState, number> = { corrected: 0, observed: 1, inferred: 2 };
      const state = priority[left.evidenceState] - priority[right.evidenceState];
      if (state) return state;
      return Number(right.data?.version ?? 0) - Number(left.data?.version ?? 0);
    });
  const events = graph.nodes.filter(node => node.type === 'event');
  const checkpoints = graph.nodes.filter(node => node.type === 'checkpoint');
  const toolEvents = events.filter(node => node.data?.eventType === 'tool_call');
  const resultEvents = events.filter(node => node.data?.eventType === 'tool_result');
  const failedTools = events.filter(node => {
    const metadata = node.data?.metadata as Record<string, unknown> | undefined;
    return metadata?.status === 'failed' || metadata?.status === 'error' || Boolean(metadata?.errorCode);
  });
  const slowTools = events.filter(node => {
    const metadata = node.data?.metadata as Record<string, unknown> | undefined;
    return typeof metadata?.durationMs === 'number' && metadata.durationMs >= 30_000;
  });
  const sessionIds = graph.nodes.filter(node => node.type === 'session').map(node => node.id);
  const reworkRows = sessionIds.length
    ? await withTenant(db, tenantId).select(aiCodeLifecycleEvents, and(
      inArray(aiCodeLifecycleEvents.sessionId, sessionIds),
      eq(aiCodeLifecycleEvents.stage, 'reworked'),
    )) : [];
  const unavailable = graph.nodes.filter(node => node.availability !== 'available').length;
  const narrative = {
    intention: intentions[0] ? {
      text: intentions[0].label,
      evidenceState: intentions[0].evidenceState,
      confidence: intentions[0].data?.confidence ?? null,
    } : { text: null, evidenceState: null, confidence: null },
    outcome: commit.label,
    friction: {
      toolCalls: toolEvents.length,
      toolResults: resultEvents.length,
      unavailableEvidence: unavailable,
      failedTools: failedTools.length,
      slowTools: slowTools.length,
      reworkSignals: reworkRows.reduce((total, row) => total + row.lineCount, 0),
    },
    learnings: checkpoints.length
      ? [`${checkpoints.length} GitAI checkpoint${checkpoints.length === 1 ? '' : 's'} support this history.`]
      : ['No GitAI checkpoint observations are available for the linked sessions.'],
    openItems: unavailable ? [`${unavailable} evidence item${unavailable === 1 ? ' is' : 's are'} unavailable, redacted, or expired.`] : [],
  };
  const sourceFingerprint = contentFingerprint({
    nodes: graph.nodes.map(node => [node.type, node.id, node.evidenceState, node.availability]),
    edges: graph.edges.map(edge => [edge.fromType, edge.fromId, edge.toType, edge.toId,
      edge.relationship, edge.evidenceState]),
  });
  const tenantDb = withTenant(db, tenantId);
  const [existingSummary] = await tenantDb.select(evidenceSummaries, and(
    eq(evidenceSummaries.rootType, 'commit'),
    eq(evidenceSummaries.rootId, commitId),
    eq(evidenceSummaries.sourceFingerprint, sourceFingerprint),
  ));
  if (!existingSummary) {
    const summaryId = randomUUID();
    await tenantDb.insertDoNothing(evidenceSummaries, {
      id: summaryId,
      rootType: 'commit',
      rootId: commitId,
      encryptedValue: envelope(narrative, tenantId, 'evidence-summary', summaryId),
      sourceFingerprint,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    }, [
      evidenceSummaries.tenantId, evidenceSummaries.rootType,
      evidenceSummaries.rootId, evidenceSummaries.sourceFingerprint,
    ]);
  }
  return { ...narrative, graph };
}

export async function searchIntentions(tenantId: string, query: string, options: {
  limit?: number;
  repositoryId?: string;
  commitId?: string;
  sessionId?: string;
  tool?: string;
  model?: string;
  path?: string;
} = {}, engine: EmbeddingEngine = new LocalBgeCommandEngine()) {
  const tenantDb = withTenant(db, tenantId);
  const [sessions, commitLinks, sessionRepositories, commitFiles] = await Promise.all([
    tenantDb.select(aiSessions),
    tenantDb.select(aiCommitSessions),
    tenantDb.select(aiSessionRepositories),
    tenantDb.select(scmCommitFiles),
  ]);
  let eligibleSessionIds = new Set(sessions.map(session => session.id));
  const intersect = (candidate: Set<string>) => {
    eligibleSessionIds = new Set([...eligibleSessionIds].filter(id => candidate.has(id)));
  };
  if (options.sessionId) intersect(new Set([options.sessionId]));
  if (options.repositoryId) intersect(new Set(sessionRepositories
    .filter(link => link.repositoryId === options.repositoryId).map(link => link.sessionId)));
  if (options.commitId) intersect(new Set(commitLinks
    .filter(link => link.commitId === options.commitId).map(link => link.sessionId)));
  if (options.path) {
    const normalizedPath = options.path.toLowerCase();
    const commitIds = new Set(commitFiles.filter(file => file.path.toLowerCase().includes(normalizedPath))
      .map(file => file.commitId));
    intersect(new Set(commitLinks.filter(link => commitIds.has(link.commitId)).map(link => link.sessionId)));
  }
  if (options.tool) intersect(new Set(sessions.filter(session => session.tool === options.tool).map(session => session.id)));
  if (options.model) intersect(new Set(sessions.filter(session => Array.isArray(session.observedModels)
    && (session.observedModels as string[]).includes(options.model!)).map(session => session.id)));
  if (!eligibleSessionIds.size) return [];
  const eligibleIds = [...eligibleSessionIds];
  const now = new Date();
  const lexicalScore = sql<number>`ts_rank_cd(${evidenceIntentionEmbeddings.lexicalDocument}, websearch_to_tsquery('english', ${query}))`;
  const lexicalRows = await db.select({
    id: evidenceIntentions.id,
    score: lexicalScore,
  }).from(evidenceIntentionEmbeddings).innerJoin(
    evidenceIntentions,
    and(
      eq(evidenceIntentions.id, evidenceIntentionEmbeddings.intentionId),
      eq(evidenceIntentions.tenantId, evidenceIntentionEmbeddings.tenantId),
    ),
  ).where(and(
    eq(evidenceIntentionEmbeddings.tenantId, tenantId),
    eq(evidenceIntentions.tenantId, tenantId),
    eq(evidenceIntentions.isCurrent, true),
    eq(evidenceIntentions.semanticAvailability, 'available'),
    eq(evidenceIntentionEmbeddings.modelRevision, engine.revision),
    gt(evidenceIntentionEmbeddings.expiresAt, now),
    inArray(evidenceIntentions.sessionId, eligibleIds),
    sql`${evidenceIntentionEmbeddings.lexicalDocument} @@ websearch_to_tsquery('english', ${query})`,
  )).orderBy(desc(lexicalScore)).limit(SEMANTIC_CANDIDATE_LIMIT);

  const queryEmbedding = normalizeEmbedding(await engine.embed(query, 'query'));
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;
  const vectorScore = sql<number>`1 - (${evidenceIntentionEmbeddings.embedding} <=> ${vectorLiteral}::vector)`;
  const vectorRows = await db.select({
    id: evidenceIntentions.id,
    score: vectorScore,
  }).from(evidenceIntentionEmbeddings).innerJoin(
    evidenceIntentions,
    and(
      eq(evidenceIntentions.id, evidenceIntentionEmbeddings.intentionId),
      eq(evidenceIntentions.tenantId, evidenceIntentionEmbeddings.tenantId),
    ),
  ).where(and(
    eq(evidenceIntentionEmbeddings.tenantId, tenantId),
    eq(evidenceIntentions.tenantId, tenantId),
    eq(evidenceIntentions.isCurrent, true),
    eq(evidenceIntentions.semanticAvailability, 'available'),
    eq(evidenceIntentionEmbeddings.modelRevision, engine.revision),
    gt(evidenceIntentionEmbeddings.expiresAt, now),
    inArray(evidenceIntentions.sessionId, eligibleIds),
  )).orderBy(desc(vectorScore)).limit(SEMANTIC_CANDIDATE_LIMIT);

  const ranked = reciprocalRankFusion(
    lexicalRows.map(row => ({ id: row.id, score: Number(row.score) })),
    vectorRows.map(row => ({ id: row.id, score: Number(row.score) })),
  );
  if (!ranked.length) return [];
  const intentions = await tenantDb.select(
    evidenceIntentions,
    inArray(evidenceIntentions.id, ranked.map(row => row.id)),
  );
  const intentionById = new Map(intentions.map(intention => [intention.id, intention]));
  const normalizedQuery = query.toLowerCase();
  const results = ranked.flatMap(candidate => {
    const intention = intentionById.get(candidate.id);
    if (!intention || !intention.sessionId) return [];
    const text = openEnvelope<string>(
      intention.encryptedValue, tenantId, 'evidence-intention', intention.id,
    );
    const exactMatch = text.toLowerCase().includes(normalizedQuery);
    const matchReasons = [
      ...(exactMatch ? ['exact_phrase'] : []),
      ...(candidate.lexicalRank ? ['lexical'] : []),
      ...(candidate.vectorRank ? ['semantic'] : []),
    ];
    return [{
      id: intention.id,
      sessionId: intention.sessionId,
      text,
      evidenceState: intention.evidenceState,
      confidence: intention.confidence,
      availability: 'available' as const,
      score: candidate.fusedScore,
      lexicalRank: candidate.lexicalRank ?? null,
      vectorRank: candidate.vectorRank ?? null,
      lexicalScore: candidate.lexicalScore ?? null,
      vectorScore: candidate.vectorScore ?? null,
      match: exactMatch ? 'exact' as const
        : candidate.lexicalRank && candidate.vectorRank ? 'hybrid' as const
          : candidate.lexicalRank ? 'lexical' as const : 'semantic' as const,
      matchReasons,
      model: engine.model,
      modelRevision: engine.revision,
      commitIds: commitLinks.filter(link => link.sessionId === intention.sessionId)
        .map(link => link.commitId),
    }];
  });
  return results.sort(compareIntentionSearchResults).slice(0, Math.min(100, Math.max(1, options.limit ?? 20)));
}

export function compareIntentionSearchResults(left: {
  id: string; match: 'exact' | 'hybrid' | 'lexical' | 'semantic'; score: number;
  vectorScore: number | null; lexicalScore: number | null;
  evidenceState: EvidenceState; confidence: number;
}, right: {
  id: string; match: 'exact' | 'hybrid' | 'lexical' | 'semantic'; score: number;
  vectorScore: number | null; lexicalScore: number | null;
  evidenceState: EvidenceState; confidence: number;
}) {
    const exact = Number(right.match === 'exact') - Number(left.match === 'exact');
    if (exact) return exact;
    const relevance = right.score - left.score;
    if (relevance) return relevance;
    // RRF ties when lexical and vector ranks are swapped. Prefer the stronger
    // cosine score so a keyword-heavy hard negative cannot win by random ID.
    const vector = (right.vectorScore ?? Number.NEGATIVE_INFINITY)
      - (left.vectorScore ?? Number.NEGATIVE_INFINITY);
    if (vector) return vector;
    const lexical = (right.lexicalScore ?? Number.NEGATIVE_INFINITY)
      - (left.lexicalScore ?? Number.NEGATIVE_INFINITY);
    if (lexical) return lexical;
    const evidencePriority = { corrected: 0, observed: 1, inferred: 2 } as const;
    const evidence = evidencePriority[left.evidenceState] - evidencePriority[right.evidenceState];
    return evidence || right.confidence - left.confidence || left.id.localeCompare(right.id);
}

export async function processNextSemanticJob(
  engine: EmbeddingEngine = new LocalBgeCommandEngine(),
  now = new Date(),
) {
  const staleLock = new Date(now.getTime() - 5 * 60 * 1_000);
  const job = await db.transaction(async transaction => {
    const [candidate] = await transaction.select().from(evidenceSemanticJobs).where(and(
      lte(evidenceSemanticJobs.availableAt, now),
      gt(evidenceSemanticJobs.expiresAt, now),
      or(
        eq(evidenceSemanticJobs.state, 'pending'),
        and(eq(evidenceSemanticJobs.state, 'processing'), lte(evidenceSemanticJobs.lockedAt, staleLock)),
      ),
    )).orderBy(evidenceSemanticJobs.createdAt).limit(1).for('update', { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await transaction.update(evidenceSemanticJobs).set({
      state: 'processing',
      lockedAt: now,
      updatedAt: now,
    }).where(and(
      eq(evidenceSemanticJobs.tenantId, candidate.tenantId),
      eq(evidenceSemanticJobs.id, candidate.id),
    )).returning();
    return claimed ?? null;
  });
  if (!job) return null;
  const tenantDb = withTenant(db, job.tenantId);
  const [intention] = await tenantDb.select(
    evidenceIntentions,
    eq(evidenceIntentions.id, job.intentionId),
  );
  const skip = !intention
    || intention.expiresAt <= now
    || !intention.isCurrent
    || intention.contentFingerprint !== job.contentFingerprint
    || engine.revision !== job.modelRevision;
  if (skip) {
    await tenantDb.update(evidenceSemanticJobs, {
      state: 'skipped', lockedAt: null, safeErrorCode: null, updatedAt: now,
    }, eq(evidenceSemanticJobs.id, job.id));
    return { id: job.id, state: 'skipped' as const };
  }
  try {
    const text = openEnvelope<string>(
      intention.encryptedValue, job.tenantId, 'evidence-intention', intention.id,
    );
    const embedding = normalizeEmbedding(await engine.embed(text, 'document'));
    await db.insert(evidenceIntentionEmbeddings).values({
      tenantId: job.tenantId,
      intentionId: intention.id,
      contentFingerprint: intention.contentFingerprint,
      model: engine.model,
      modelRevision: engine.revision,
      modelChecksum: engine.checksum,
      dimensions: SEMANTIC_DIMENSIONS,
      embedding,
      lexicalDocument: sql`to_tsvector('english', ${text})`,
      expiresAt: intention.expiresAt,
    }).onConflictDoUpdate({
      target: [
        evidenceIntentionEmbeddings.tenantId,
        evidenceIntentionEmbeddings.intentionId,
        evidenceIntentionEmbeddings.modelRevision,
      ],
      set: {
        contentFingerprint: intention.contentFingerprint,
        model: engine.model,
        modelChecksum: engine.checksum,
        dimensions: SEMANTIC_DIMENSIONS,
        embedding,
        lexicalDocument: sql`to_tsvector('english', ${text})`,
        expiresAt: intention.expiresAt,
        createdAt: now,
      },
    });
    await tenantDb.update(evidenceIntentions, {
      semanticAvailability: 'available',
    }, eq(evidenceIntentions.id, intention.id));
    await tenantDb.update(evidenceSemanticJobs, {
      state: 'completed', lockedAt: null, safeErrorCode: null, updatedAt: now,
    }, eq(evidenceSemanticJobs.id, job.id));
    return { id: job.id, state: 'completed' as const };
  } catch (error) {
    const attempts = job.attemptCount + 1;
    const terminal = attempts >= SEMANTIC_MAX_ATTEMPTS;
    await tenantDb.update(evidenceSemanticJobs, {
      state: terminal ? 'failed' : 'pending',
      attemptCount: attempts,
      lockedAt: null,
      safeErrorCode: semanticSafeError(error),
      availableAt: new Date(now.getTime() + Math.min(60_000, 1_000 * (2 ** attempts))),
      updatedAt: now,
    }, eq(evidenceSemanticJobs.id, job.id));
    if (terminal) await tenantDb.update(evidenceIntentions, {
      semanticAvailability: 'unavailable',
    }, eq(evidenceIntentions.id, intention.id));
    return { id: job.id, state: terminal ? 'failed' as const : 'pending' as const };
  }
}

export async function processSemanticJobs(input: {
  limit?: number;
  engine?: EmbeddingEngine;
  now?: Date;
} = {}) {
  const engine = input.engine ?? new LocalBgeCommandEngine();
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const results: Array<{ id: string; state: string }> = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await processNextSemanticJob(engine, input.now ?? new Date());
    if (!result) break;
    results.push(result);
  }
  return results;
}

export async function semanticHealth(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [intentions, jobs, indexes] = await Promise.all([
    tenantDb.select(evidenceIntentions),
    tenantDb.select(evidenceSemanticJobs),
    tenantDb.select(evidenceIntentionEmbeddings),
  ]);
  const count = (state: string) => jobs.filter(job => job.state === state).length;
  return {
    model: SEMANTIC_MODEL,
    configuredRevision: configuredSemanticRevision(),
    dimensions: SEMANTIC_DIMENSIONS,
    intentions: intentions.length,
    availableIntentions: intentions.filter(row => row.semanticAvailability === 'available').length,
    indexes: indexes.length,
    jobs: {
      pending: count('pending'),
      processing: count('processing'),
      completed: count('completed'),
      failed: count('failed'),
      skipped: count('skipped'),
    },
  };
}

export async function enqueueSemanticReindex(input: {
  tenantId: string;
  actorId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const tenantDb = withTenant(db, input.tenantId);
  const intentions = await tenantDb.select(evidenceIntentions, and(
    eq(evidenceIntentions.isCurrent, true),
    gt(evidenceIntentions.expiresAt, now),
  ));
  let enqueued = 0;
  for (const intention of intentions) {
    if (await enqueueSemanticJob(input.tenantId, intention)) {
      enqueued += 1;
      await tenantDb.update(evidenceIntentions, {
        semanticAvailability: 'pending',
      }, eq(evidenceIntentions.id, intention.id));
    }
  }
  await tenantDb.insert(securityAuditEvents, {
    actorType: 'tenant_admin', actorId: input.actorId,
    action: 'evidence.semantic.reindex_enqueued', targetType: 'tenant', targetId: input.tenantId,
    details: { model: SEMANTIC_MODEL, modelRevision: configuredSemanticRevision(), enqueued },
  });
  return { model: SEMANTIC_MODEL, modelRevision: configuredSemanticRevision(), enqueued };
}

export async function frictionAnalytics(tenantId: string) {
  const tenantDb = withTenant(db, tenantId);
  const [events, commitLinks, reworkRows] = await Promise.all([
    tenantDb.select(evidenceEvents),
    tenantDb.select(aiCommitSessions),
    tenantDb.select(aiCodeLifecycleEvents, eq(aiCodeLifecycleEvents.stage, 'reworked')),
  ]);
  const committedSessions = new Set(commitLinks.map(link => link.sessionId));
  const reworkBySession = new Map<string, number>();
  reworkRows.forEach(row => {
    if (row.sessionId) reworkBySession.set(row.sessionId,
      (reworkBySession.get(row.sessionId) ?? 0) + row.lineCount);
  });
  const bySession = new Map<string, {
    toolCalls: number; toolResults: number; unavailable: number; retries: number;
    failedToolCalls: number; slowToolCalls: number; promptLoops: number; abandoned: boolean;
  }>();
  const lastToolBySession = new Map<string, string>();
  const pendingPromptsBySession = new Map<string, number>();
  for (const event of events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const current = bySession.get(event.sessionId) ?? {
      toolCalls: 0, toolResults: 0, unavailable: 0, retries: 0,
      failedToolCalls: 0, slowToolCalls: 0, promptLoops: 0, abandoned: false,
    };
    const metadata = event.metadata as Record<string, unknown>;
    if (event.eventType === 'tool_call') {
      current.toolCalls += 1;
      if (event.toolName && lastToolBySession.get(event.sessionId) === event.toolName) current.retries += 1;
      if (event.toolName) lastToolBySession.set(event.sessionId, event.toolName);
    }
    if (event.eventType === 'tool_result') current.toolResults += 1;
    if (metadata.status === 'failed' || metadata.status === 'error' || metadata.errorCode) {
      current.failedToolCalls += 1;
    }
    if (typeof metadata.durationMs === 'number' && metadata.durationMs >= 30_000) {
      current.slowToolCalls += 1;
    }
    if (event.eventType === 'prompt') {
      const pending = (pendingPromptsBySession.get(event.sessionId) ?? 0) + 1;
      pendingPromptsBySession.set(event.sessionId, pending);
      if (pending > 1) current.promptLoops += 1;
    }
    if (event.eventType === 'response') pendingPromptsBySession.set(event.sessionId, 0);
    if (metadata.abandoned === true) current.abandoned = true;
    if (event.availability !== 'available') current.unavailable += 1;
    bySession.set(event.sessionId, current);
  }
  return [...bySession.entries()].map(([sessionId, values]) => ({
    sessionId, ...values,
    unmatchedToolCalls: Math.max(0, values.toolCalls - values.toolResults),
    weakOutcome: !committedSessions.has(sessionId),
    reworkedLines: reworkBySession.get(sessionId) ?? 0,
    evidenceBasis: ['opencode_event_metadata', 'git_ai_commit_session', 'task2_lifecycle_rework'],
  })).sort((left, right) => (
    right.retries + right.unmatchedToolCalls + right.failedToolCalls + right.slowToolCalls
  ) - (
    left.retries + left.unmatchedToolCalls + left.failedToolCalls + left.slowToolCalls
  ));
}
