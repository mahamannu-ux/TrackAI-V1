import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { db, pool } from '../../core/db';
import {
  aiCommitSessions,
  aiGenerationObservations,
  scmCommitFiles,
  scmCommits,
  scmRepositories,
  ssoTenants,
  telemetryIngestBatches,
  telemetryMetricEvents,
} from '../../core/db/schema';
import { validateOpenCodeEvidenceBatch } from './contract';
import { evidenceGraph, ingestOpenCodeEvidence, setEvidenceConsent } from './service';
import { evidenceWorkStory } from './workspace';

let activeStage = 'startup';

function edgeKey(edge: {
  fromType: string; fromId: string; toType: string; toId: string;
  relationship: string; basis: string;
}) {
  return [edge.fromType, edge.fromId, edge.toType, edge.toId, edge.relationship, edge.basis].join(':');
}

async function main() {
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('This verification may run only against an explicitly ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task5-graph-${randomUUID()}`;
  const traceId = `${marker}-trace`;
  const exactPath = 'src/auth/recovery.ts';
  const missingPath = 'src/auth/unattributed.ts';

  activeStage = 'fixture_setup';
  const [tenant] = await db.insert(ssoTenants).values({
    companyName: 'Task5 graph verification',
    domain: `${marker}.example.invalid`,
    supabaseProviderId: `${marker}-provider`,
    scmOrgIdentifier: `${marker}-org`,
  }).returning();
  const [isolatedTenant] = await db.insert(ssoTenants).values({
    companyName: 'Task5 isolated graph verification',
    domain: `${marker}-isolated.example.invalid`,
    supabaseProviderId: `${marker}-isolated-provider`,
    scmOrgIdentifier: `${marker}-isolated-org`,
  }).returning();
  const [repository] = await db.insert(scmRepositories).values({
    tenantId: tenant.id,
    provider: 'github',
    externalId: `${marker}-repository`,
    name: 'task5-graph-verification',
    url: `https://example.invalid/${marker}.git`,
    normalizedUrl: `https://example.invalid/${marker}.git`,
  }).returning();
  await setEvidenceConsent({ tenantId: tenant.id, actorId: `${marker}-admin`, enabled: true });

  activeStage = 'opencode_evidence';
  const occurredAt = new Date();
  const ingestion = await ingestOpenCodeEvidence({
    tenantId: tenant.id,
    now: occurredAt,
    batch: validateOpenCodeEvidenceBatch({
      provider: 'opencode',
      batchId: `${marker}-batch`,
      sourceVersion: 'git-ai/opencode-evidence/1',
      repositoryId: repository.id,
      externalSessionId: `${marker}-session`,
      gitAiSessionId: `${marker}-git-ai-session`,
      intention: 'Prevent concurrent password recovery tokens from overwriting one another',
      events: [
        {
          providerEventId: `${marker}-prompt`, type: 'prompt', occurredAt: occurredAt.toISOString(),
          traceId, model: 'task5-local-model', toolName: null,
          content: 'Synthetic recovery concurrency instruction', metadata: {},
        },
        {
          providerEventId: `${marker}-tool`, type: 'tool_call', occurredAt: occurredAt.toISOString(),
          traceId, model: 'task5-local-model', toolName: 'synthetic-test-runner',
          content: 'npm test', metadata: { attempt: 1 },
        },
      ],
    }),
  });
  if (!ingestion.intentionId) throw new Error('intention_was_not_created');

  activeStage = 'git_ai_attribution';
  const [commit] = await db.insert(scmCommits).values({
    tenantId: tenant.id,
    repositoryId: repository.id,
    sha: 'a'.repeat(40),
    branch: 'feature/task5-verification',
    subject: 'Prevent recovery token race',
    committedAt: occurredAt,
    diffAddedLines: 21,
    observedAiLines: 18,
    observedUnknownLines: 3,
  }).returning();
  await db.insert(aiCommitSessions).values({
    tenantId: tenant.id, commitId: commit.id, sessionId: ingestion.sessionId, observedAiLines: 18,
  });
  await db.insert(scmCommitFiles).values([
    {
      tenantId: tenant.id, commitId: commit.id, path: exactPath, observedAiLines: 18,
      attributionRanges: [{ startLine: 41, endLine: 58, traceId, authorType: 'ai' }],
    },
    {
      tenantId: tenant.id, commitId: commit.id, path: missingPath, observedUnknownLines: 3,
      attributionRanges: [],
    },
  ]);

  const [telemetryBatch] = await db.insert(telemetryIngestBatches).values({
    tenantId: tenant.id,
    apiVersion: 3,
    payloadHash: `${marker}-payload-hash`,
    eventCount: 1,
    payload: { synthetic: true },
  }).returning();
  const [telemetryEvent] = await db.insert(telemetryMetricEvents).values({
    tenantId: tenant.id,
    batchId: telemetryBatch.id,
    eventIndex: 0,
    eventFingerprint: `${marker}-event-fingerprint`,
    eventKind: 1,
    eventTimestamp: occurredAt,
    rawEvent: { synthetic: true },
    evidenceFamily: 'generation_session',
    arrivalClass: 'current',
    normalizationStatus: 'normalized',
  }).returning();
  await db.insert(aiGenerationObservations).values({
    tenantId: tenant.id,
    sessionId: ingestion.sessionId,
    repositoryId: repository.id,
    sourceEventId: telemetryEvent.id,
    traceId,
    model: 'task5-local-model',
    filePath: exactPath,
    generatedLines: 18,
    acceptedLines: 18,
    generatedAt: occurredAt,
    evidenceSource: 'git_ai_checkpoint',
  });

  activeStage = 'paginated_graph';
  const complete = await evidenceGraph({ tenantId: tenant.id, rootType: 'commit', rootId: commit.id, limit: 200 });
  const pagedNodes = new Map<string, (typeof complete.nodes)[number]>();
  const pagedEdges = new Map<string, (typeof complete.edges)[number]>();
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = await evidenceGraph({
      tenantId: tenant.id, rootType: 'commit', rootId: commit.id, cursor, limit: 2,
    });
    page.nodes.forEach(node => pagedNodes.set(`${node.type}:${node.id}`, node));
    for (const edge of page.edges) {
      const key = edgeKey(edge);
      if (pagedEdges.has(key)) throw new Error('edge_duplicated_across_pages');
      pagedEdges.set(key, edge);
    }
    cursor = page.nextCursor;
  }
  const completeNodeKeys = new Set(complete.nodes.map(node => `${node.type}:${node.id}`));
  const completeEdgeKeys = new Set(complete.edges.map(edgeKey));
  if (pagedNodes.size !== completeNodeKeys.size
    || [...pagedNodes.keys()].some(key => !completeNodeKeys.has(key))) {
    throw new Error('paginated_nodes_do_not_match_complete_graph');
  }
  if (pagedEdges.size !== completeEdgeKeys.size
    || [...pagedEdges.keys()].some(key => !completeEdgeKeys.has(key))) {
    throw new Error('paginated_edges_do_not_match_complete_graph');
  }
  const requiredNodeTypes = ['commit', 'code_range', 'session', 'event', 'trace', 'intention', 'checkpoint'];
  if (requiredNodeTypes.some(type => !complete.nodes.some(node => node.type === type))) {
    throw new Error('graph_node_type_missing');
  }
  const requiredBases = [
    'git_ai_authorship_note', 'git_ai_range_attestation', 'provider_trace_id',
    'git_ai_checkpoint_event', 'git_ai_checkpoint_trace',
  ];
  if (requiredBases.some(basis => !complete.edges.some(edge => edge.basis === basis))) {
    throw new Error('graph_evidence_basis_missing');
  }

  activeStage = 'reverse_provenance';
  const exact = await evidenceWorkStory({
    tenantId: tenant.id, rootType: 'commit', rootId: commit.id,
    focus: { path: exactPath, line: 45 },
  });
  if (!exact || exact.focus?.attribution !== 'exact' || !exact.focus.traceIds.includes(traceId)) {
    throw new Error('exact_file_line_attribution_failed');
  }
  const missing = await evidenceWorkStory({
    tenantId: tenant.id, rootType: 'commit', rootId: commit.id,
    focus: { path: missingPath, line: 7 },
  });
  if (!missing || missing.focus?.attribution !== 'missing' || missing.focus.traceIds.length !== 0
    || !missing.insights.unresolved.includes('No exact GitAI range attribution exists for this line')) {
    throw new Error('missing_attribution_was_not_reported_honestly');
  }

  activeStage = 'alternate_roots';
  const roots = [
    ['session', ingestion.sessionId],
    ['trace', traceId],
    ['checkpoint', telemetryEvent.id],
    ['intention', ingestion.intentionId],
  ] as const;
  for (const [rootType, rootId] of roots) {
    const graph = await evidenceGraph({ tenantId: tenant.id, rootType, rootId, limit: 200 });
    if (!graph.nodes.length) throw new Error(`${rootType}_root_did_not_resolve`);
  }

  activeStage = 'tenant_isolation';
  const isolatedGraph = await evidenceGraph({
    tenantId: isolatedTenant.id, rootType: 'commit', rootId: commit.id, limit: 200,
  });
  const isolatedStory = await evidenceWorkStory({
    tenantId: isolatedTenant.id, rootType: 'commit', rootId: commit.id,
  });
  if (isolatedGraph.nodes.length !== 0 || isolatedGraph.edges.length !== 0 || isolatedStory !== null) {
    throw new Error('cross_tenant_graph_data_exposed');
  }

  console.log('graph_pagination=lossless_and_nonduplicating');
  console.log('graph_relationship_bases=verified');
  console.log('file_line_exact_attribution=verified');
  console.log('file_line_missing_attribution=reported');
  console.log('alternate_graph_roots=verified');
  console.log('graph_tenant_isolation=verified');
  console.log('task5_graph_live_verification=passed');
}

void main().catch(error => {
  console.log('task5_graph_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`safe_error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
