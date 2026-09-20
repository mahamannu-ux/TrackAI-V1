import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  evidenceIntentionEmbeddings,
  evidenceIntentions,
  scmRepositories,
  ssoTenants,
} from '../../core/db/schema';
import { validateOpenCodeEvidenceBatch } from './contract';
import {
  ingestOpenCodeEvidence,
  processSemanticJobs,
  searchIntentions,
  setEvidenceConsent,
} from './service';

let activeStage = 'startup';

async function main() {
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('This verification may run only against an explicitly ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const revision = process.env.TRACKAI_BGE_REVISION?.trim();
  const checksum = process.env.TRACKAI_BGE_CHECKSUM?.trim();
  if (!revision || !checksum || !process.env.TRACKAI_BGE_EXECUTABLE || !process.env.TRACKAI_BGE_MODEL_PATH) {
    throw new Error('Pinned local BGE configuration is required');
  }

  const marker = `task5-semantic-${randomUUID()}`;
  const now = new Date();
  activeStage = 'fixture_setup';
  const [primaryTenant, isolatedTenant] = await db.insert(ssoTenants).values([
    {
      companyName: 'Task5 semantic verification', domain: `${marker}.example.invalid`,
      supabaseProviderId: `${marker}-provider`, scmOrgIdentifier: `${marker}-org`,
    },
    {
      companyName: 'Task5 isolated semantic verification', domain: `${marker}-isolated.example.invalid`,
      supabaseProviderId: `${marker}-isolated-provider`, scmOrgIdentifier: `${marker}-isolated-org`,
    },
  ]).returning();
  const [primaryRepository, isolatedRepository] = await db.insert(scmRepositories).values([
    {
      tenantId: primaryTenant.id, provider: 'github', externalId: `${marker}-repository`,
      name: 'task5-semantic-verification', url: `https://example.invalid/${marker}.git`,
      normalizedUrl: `https://example.invalid/${marker}.git`,
    },
    {
      tenantId: isolatedTenant.id, provider: 'github', externalId: `${marker}-isolated-repository`,
      name: 'task5-isolated-semantic-verification',
      url: `https://example.invalid/${marker}-isolated.git`,
      normalizedUrl: `https://example.invalid/${marker}-isolated.git`,
    },
  ]).returning();
  await setEvidenceConsent({ tenantId: primaryTenant.id, actorId: `${marker}-admin`, enabled: true });
  await setEvidenceConsent({ tenantId: isolatedTenant.id, actorId: `${marker}-isolated-admin`, enabled: true });

  const createIntention = async (tenantId: string, repositoryId: string, key: string, intention: string) => {
    const result = await ingestOpenCodeEvidence({
      tenantId, now,
      batch: validateOpenCodeEvidenceBatch({
        provider: 'opencode', batchId: `${marker}-${key}-batch`,
        sourceVersion: 'git-ai/opencode-evidence/1', repositoryId,
        externalSessionId: `${marker}-${key}-session`,
        gitAiSessionId: `${marker}-${key}-git-ai-session`, intention,
        events: [{
          providerEventId: `${marker}-${key}-prompt`, type: 'prompt', occurredAt: now.toISOString(),
          traceId: `${marker}-${key}-trace`, model: 'task5-local-model', toolName: null,
          content: `Synthetic semantic fixture ${key}`, metadata: {},
        }],
      }),
    });
    if (!result.intentionId) throw new Error('semantic_intention_was_not_created');
    return result.intentionId;
  };

  const relatedRace = await createIntention(primaryTenant.id, primaryRepository.id, 'related-race',
    'Prevent concurrent password recovery tokens from overwriting one another');
  const relatedAtomic = await createIntention(primaryTenant.id, primaryRepository.id, 'related-atomic',
    'Use an atomic database update for account recovery token rotation');
  const hardNegative = await createIntention(primaryTenant.id, primaryRepository.id, 'hard-negative',
    'Rotate the office recovery handbook archive and database password');
  const unrelated = await createIntention(primaryTenant.id, primaryRepository.id, 'unrelated',
    'Improve invoice PDF rendering performance');
  const isolated = await createIntention(isolatedTenant.id, isolatedRepository.id, 'isolated-related',
    'Prevent concurrent password reset token races');

  activeStage = 'local_embedding_jobs';
  await processSemanticJobs({ limit: 100, now });
  const primaryIndexes = await db.select().from(evidenceIntentionEmbeddings)
    .where(eq(evidenceIntentionEmbeddings.tenantId, primaryTenant.id));
  const isolatedIndexes = await db.select().from(evidenceIntentionEmbeddings)
    .where(eq(evidenceIntentionEmbeddings.tenantId, isolatedTenant.id));
  if (primaryIndexes.length !== 4 || isolatedIndexes.length !== 1) {
    throw new Error('semantic_index_count_was_incorrect');
  }
  for (const row of [...primaryIndexes, ...isolatedIndexes]) {
    const vector = row.embedding as number[];
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    if (row.dimensions !== 384 || Math.abs(norm - 1) > 0.0001
      || row.modelRevision !== revision || row.modelChecksum !== checksum) {
      throw new Error('semantic_index_contract_was_incorrect');
    }
  }
  const available = await db.select().from(evidenceIntentions)
    .where(eq(evidenceIntentions.tenantId, primaryTenant.id));
  if (available.some(row => row.semanticAvailability !== 'available')) {
    throw new Error('semantic_availability_was_not_recorded');
  }

  activeStage = 'hybrid_retrieval';
  const results = await searchIntentions(primaryTenant.id, 'password recovery race condition');
  const order = results.map(row => row.id);
  const relatedPositions = [relatedRace, relatedAtomic].map(id => order.indexOf(id));
  const hardNegativePosition = order.indexOf(hardNegative);
  if (!results.length
    || ![relatedRace, relatedAtomic].includes(results[0].id)
    || relatedPositions.some(position => position < 0 || position > 2)
    || hardNegativePosition < 0
    || hardNegativePosition < Math.max(...relatedPositions)
    || (order.includes(unrelated) && order.indexOf(unrelated) < Math.min(...relatedPositions))
    || order.includes(isolated)) {
    throw new Error('semantic_hard_negative_ranking_failed');
  }
  if (!results.some(row => row.matchReasons.includes('semantic'))
    || !results.some(row => row.matchReasons.includes('lexical'))) {
    throw new Error('hybrid_match_reasons_were_missing');
  }

  activeStage = 'exact_and_semantic_queries';
  const exact = await searchIntentions(primaryTenant.id, 'Prevent concurrent password recovery tokens');
  if (exact[0]?.id !== relatedRace || exact[0]?.match !== 'exact') {
    throw new Error('exact_phrase_priority_failed');
  }
  const paraphrase = await searchIntentions(primaryTenant.id, 'make account reset persistence indivisible');
  if (![relatedRace, relatedAtomic].includes(paraphrase[0]?.id ?? '')) {
    throw new Error('semantic_paraphrase_retrieval_failed');
  }
  const isolatedResults = await searchIntentions(isolatedTenant.id, 'password recovery race condition');
  if (!isolatedResults.some(row => row.id === isolated)
    || isolatedResults.some(row => [relatedRace, relatedAtomic, hardNegative, unrelated].includes(row.id))) {
    throw new Error('semantic_tenant_isolation_failed');
  }

  console.log('pinned_local_bge_inference=verified');
  console.log('normalized_384_dimension_embeddings=verified');
  console.log('pgvector_cosine_retrieval=verified');
  console.log('postgres_lexical_retrieval=verified');
  console.log('rrf_hybrid_match_reasons=verified');
  console.log('hard_negative_relative_order=verified');
  console.log('semantic_paraphrase_retrieval=verified');
  console.log('semantic_tenant_isolation=verified');
  console.log('task5_semantic_live_verification=passed');
}

void main().catch(error => {
  console.log('task5_semantic_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`safe_error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
