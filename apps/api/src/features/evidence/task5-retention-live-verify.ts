import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  evidenceEventContents,
  evidenceEvents,
  evidenceIntentionEmbeddings,
  evidenceIntentions,
  evidenceLinks,
  evidenceSemanticDocuments,
  evidenceSemanticJobs,
  evidenceSummaries,
  scmRepositories,
  securityAuditEvents,
  ssoTenants,
} from '../../core/db/schema';
import { encryptEnvelope } from '../../core/security/envelope-encryption';
import { validateOpenCodeEvidenceBatch } from './contract';
import {
  correctIntention,
  ingestOpenCodeEvidence,
  purgeExpiredEvidence,
  setEvidenceConsent,
} from './service';

let activeStage = 'startup';

async function main() {
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('This verification may run only against an explicitly ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task5-retention-${randomUUID()}`;
  const actorId = `${marker}-admin`;
  const createdAt = new Date();

  activeStage = 'fixture_setup';
  const [tenant] = await db.insert(ssoTenants).values({
    companyName: 'Task5 retention verification',
    domain: `${marker}.example.invalid`,
    supabaseProviderId: `${marker}-provider`,
    scmOrgIdentifier: `${marker}-org`,
  }).returning();
  const [repository] = await db.insert(scmRepositories).values({
    tenantId: tenant.id,
    provider: 'github',
    externalId: `${marker}-repository`,
    name: 'task5-retention-verification',
    url: `https://example.invalid/${marker}.git`,
    normalizedUrl: `https://example.invalid/${marker}.git`,
  }).returning();
  await setEvidenceConsent({ tenantId: tenant.id, actorId, enabled: true });

  const ingestion = await ingestOpenCodeEvidence({
    tenantId: tenant.id,
    now: createdAt,
    batch: validateOpenCodeEvidenceBatch({
      provider: 'opencode',
      batchId: `${marker}-batch`,
      sourceVersion: 'git-ai/opencode-evidence/1',
      repositoryId: repository.id,
      externalSessionId: `${marker}-session`,
      gitAiSessionId: `${marker}-git-ai-session`,
      intention: 'Make password recovery concurrency safe',
      events: [{
        providerEventId: `${marker}-prompt`,
        type: 'prompt',
        occurredAt: createdAt.toISOString(),
        traceId: `${marker}-trace`,
        model: 'task5-local-model',
        toolName: null,
        content: 'Synthetic retention evidence',
        metadata: {},
      }],
    }),
  });
  if (!ingestion.intentionId) throw new Error('intention_was_not_created');

  activeStage = 'correction_expiry';
  const [original] = await db.select().from(evidenceIntentions).where(and(
    eq(evidenceIntentions.tenantId, tenant.id),
    eq(evidenceIntentions.id, ingestion.intentionId),
  ));
  const corrected = await correctIntention({
    tenantId: tenant.id,
    intentionId: original.id,
    actorId,
    value: 'Make password recovery token persistence atomic',
    reason: 'Synthetic correction for retention verification',
    now: new Date(createdAt.getTime() + 1_000),
  });
  if (!corrected || corrected.expiresAt !== original.expiresAt.toISOString()) {
    throw new Error('correction_extended_source_retention');
  }
  const [correctedRow] = await db.select().from(evidenceIntentions).where(and(
    eq(evidenceIntentions.tenantId, tenant.id),
    eq(evidenceIntentions.id, corrected.id),
  ));

  activeStage = 'derived_records';
  const summaryId = randomUUID();
  await db.insert(evidenceSummaries).values({
    id: summaryId,
    tenantId: tenant.id,
    rootType: 'intention',
    rootId: correctedRow.id,
    encryptedValue: encryptEnvelope(JSON.stringify({ synthetic: true }), {
      tenantId: tenant.id, purpose: 'evidence-summary', resourceId: summaryId,
    }) as unknown as Record<string, unknown>,
    sourceFingerprint: `${marker}-summary`,
    expiresAt: correctedRow.expiresAt,
  });
  const semanticDocumentId = randomUUID();
  await db.insert(evidenceSemanticDocuments).values({
    id: semanticDocumentId,
    tenantId: tenant.id,
    intentionId: correctedRow.id,
    encryptedValue: encryptEnvelope(JSON.stringify({ synthetic: true }), {
      tenantId: tenant.id, purpose: 'evidence-semantic-document', resourceId: semanticDocumentId,
    }) as unknown as Record<string, unknown>,
    model: 'task5-retention-verification',
    expiresAt: correctedRow.expiresAt,
  });
  await db.insert(evidenceIntentionEmbeddings).values({
    tenantId: tenant.id,
    intentionId: correctedRow.id,
    contentFingerprint: correctedRow.contentFingerprint,
    model: 'BAAI/bge-small-en-v1.5',
    modelRevision: 'task5-retention-verification',
    modelChecksum: 'synthetic-checksum',
    dimensions: 384,
    embedding: Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0),
    lexicalDocument: sql`to_tsvector('english', 'synthetic retention verification')`,
    expiresAt: correctedRow.expiresAt,
  });

  activeStage = 'expire_records';
  const expiredAt = new Date(createdAt.getTime() - 1_000);
  await db.update(evidenceEvents).set({ expiresAt: expiredAt })
    .where(eq(evidenceEvents.tenantId, tenant.id));
  await db.update(evidenceEventContents).set({ expiresAt: expiredAt })
    .where(eq(evidenceEventContents.tenantId, tenant.id));
  await db.update(evidenceIntentions).set({ expiresAt: expiredAt })
    .where(eq(evidenceIntentions.tenantId, tenant.id));
  await db.update(evidenceSemanticJobs).set({ expiresAt: expiredAt })
    .where(eq(evidenceSemanticJobs.tenantId, tenant.id));
  await db.update(evidenceSemanticDocuments).set({ expiresAt: expiredAt })
    .where(eq(evidenceSemanticDocuments.tenantId, tenant.id));
  await db.update(evidenceIntentionEmbeddings).set({ expiresAt: expiredAt })
    .where(eq(evidenceIntentionEmbeddings.tenantId, tenant.id));
  await db.update(evidenceSummaries).set({ expiresAt: expiredAt })
    .where(eq(evidenceSummaries.tenantId, tenant.id));

  activeStage = 'purge';
  const result = await purgeExpiredEvidence(tenant.id, actorId, createdAt);
  if (result.expiredEvents !== 1 || result.expiredIntentions !== 2 || result.expiredSummaries !== 1) {
    throw new Error('purge_counts_were_incorrect');
  }

  const [events, contents, intentions, embeddings, documents, jobs, summaries, intentionLinks] = await Promise.all([
    db.select().from(evidenceEvents).where(eq(evidenceEvents.tenantId, tenant.id)),
    db.select().from(evidenceEventContents).where(eq(evidenceEventContents.tenantId, tenant.id)),
    db.select().from(evidenceIntentions).where(eq(evidenceIntentions.tenantId, tenant.id)),
    db.select().from(evidenceIntentionEmbeddings).where(eq(evidenceIntentionEmbeddings.tenantId, tenant.id)),
    db.select().from(evidenceSemanticDocuments).where(eq(evidenceSemanticDocuments.tenantId, tenant.id)),
    db.select().from(evidenceSemanticJobs).where(eq(evidenceSemanticJobs.tenantId, tenant.id)),
    db.select().from(evidenceSummaries).where(eq(evidenceSummaries.tenantId, tenant.id)),
    db.select().from(evidenceLinks).where(and(
      eq(evidenceLinks.tenantId, tenant.id),
      eq(evidenceLinks.fromType, 'intention'),
    )),
  ]);
  if (events.length !== 1 || events[0].availability !== 'expired' || events[0].contentSha256 !== null) {
    throw new Error('expired_event_metadata_was_not_safely_preserved');
  }
  if (contents.length || intentions.length || embeddings.length || documents.length
    || jobs.length || summaries.length || intentionLinks.length) {
    throw new Error('derived_or_raw_evidence_survived_purge');
  }
  const [audit] = await db.select().from(securityAuditEvents).where(and(
    eq(securityAuditEvents.tenantId, tenant.id),
    eq(securityAuditEvents.action, 'evidence.retention.purged'),
  ));
  if (!audit || audit.actorId !== actorId) throw new Error('retention_audit_was_not_recorded');

  console.log('correction_retention_extension=blocked');
  console.log('expired_event_metadata=preserved_without_content');
  console.log('raw_content_deletion=verified');
  console.log('intention_and_version_deletion=verified');
  console.log('embedding_lexical_job_summary_deletion=verified');
  console.log('retention_audit=recorded');
  console.log('task5_retention_live_verification=passed');
}

void main().catch(error => {
  console.log('task5_retention_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`safe_error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
