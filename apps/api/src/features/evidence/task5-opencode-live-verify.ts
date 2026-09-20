import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  evidenceEventContents,
  evidenceEvents,
  evidenceIntentions,
  evidenceSemanticJobs,
  scmRepositories,
  securityAuditEvents,
  ssoTenants,
} from '../../core/db/schema';
import { authenticateMachine } from '../../core/middleware/machine-auth';
import {
  issueMachineCredential,
  registerDeveloperMachine,
} from '../../core/security/machine-security-service';
import {
  enrollRepository,
  grantMachineRepository,
  revokeMachineRepositoryGrant,
} from '../../core/security/repository-security-service';
import { evidenceWorkerRouter } from './evidence.routes';
import { readRawEvidence, setEvidenceConsent } from './service';

let activeStage = 'startup';

function batch(repositoryId: string, marker: string, suffix: string, content: unknown) {
  return {
    provider: 'opencode',
    batchId: `${marker}-batch-${suffix}`,
    sourceVersion: 'git-ai/opencode-evidence/1',
    repositoryId,
    externalSessionId: `${marker}-session`,
    gitAiSessionId: 's_task5_opencode_live',
    events: [
      {
        providerEventId: `${marker}-prompt-${suffix}`,
        type: 'prompt',
        occurredAt: new Date().toISOString(),
        traceId: 't_task5_opencode_live',
        model: 'task5-local-model',
        toolName: null,
        content,
        metadata: {},
      },
      {
        providerEventId: `${marker}-reasoning-${suffix}`,
        type: 'reasoning',
        occurredAt: new Date().toISOString(),
        traceId: 't_task5_opencode_live',
        model: 'task5-local-model',
        toolName: null,
        content: null,
        metadata: {},
      },
    ],
  };
}

async function main() {
  if (process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
    throw new Error('This verification may run only against an explicitly ephemeral database');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task5-opencode-${randomUUID()}`;
  const actorId = `${marker}-admin`;
  activeStage = 'fixture_setup';
  const [tenant] = await db.insert(ssoTenants).values({
    companyName: 'Task5 OpenCode verification',
    domain: `${marker}.example.invalid`,
    supabaseProviderId: `${marker}-provider`,
    scmOrgIdentifier: `${marker}-org`,
  }).returning();
  const [repository] = await db.insert(scmRepositories).values({
    tenantId: tenant.id,
    provider: 'github',
    externalId: `${marker}-repository`,
    name: 'task5-opencode-verification',
    url: `https://example.invalid/${marker}.git`,
    normalizedUrl: `https://example.invalid/${marker}.git`,
  }).returning();
  const machine = await registerDeveloperMachine({
    tenantId: tenant.id,
    installationId: `${marker}-machine`,
    displayName: 'Task5 OpenCode verification machine',
    platform: 'ephemeral-ci',
    actorId,
  });
  const credential = await issueMachineCredential({
    tenantId: tenant.id, machineId: machine.id, actorId,
  });
  const enrollment = await enrollRepository({
    tenantId: tenant.id, repositoryId: repository.id, actorId,
    reason: 'Ephemeral Task5 OpenCode verification',
  });
  const grant = await grantMachineRepository({
    tenantId: tenant.id, machineId: machine.id, enrollmentId: enrollment.id,
    actorId, reason: 'Ephemeral Task5 OpenCode verification',
  });
  await setEvidenceConsent({ tenantId: tenant.id, actorId, enabled: true });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/worker/evidence', authenticateMachine, evidenceWorkerRouter);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Verification server address is unavailable');
    const endpoint = `http://127.0.0.1:${address.port}/worker/evidence/opencode/batches`;
    const send = (body: Record<string, unknown>, apiKey = credential.plaintext) => fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });

    activeStage = 'authenticated_ingestion';
    const redactionSentinel = `synthetic-${randomUUID()}`;
    const acceptedBatch = batch(
      repository.id, marker, 'accepted', `Investigate recovery conflict; token=${redactionSentinel}`,
    );
    const firstResponse = await send(acceptedBatch);
    const first = await firstResponse.json() as Record<string, unknown>;
    if (firstResponse.status !== 202 || first.accepted !== 2 || first.duplicates !== 0) {
      throw new Error('first_authenticated_delivery_failed');
    }

    activeStage = 'idempotent_replay';
    const replayResponse = await send(acceptedBatch);
    const replay = await replayResponse.json() as Record<string, unknown>;
    if (replayResponse.status !== 202 || replay.accepted !== 0 || replay.duplicates !== 2) {
      throw new Error('idempotent_replay_failed');
    }

    const events = await db.select().from(evidenceEvents).where(eq(evidenceEvents.tenantId, tenant.id));
    const contents = await db.select().from(evidenceEventContents)
      .where(eq(evidenceEventContents.tenantId, tenant.id));
    const intentions = await db.select().from(evidenceIntentions)
      .where(eq(evidenceIntentions.tenantId, tenant.id));
    const jobs = await db.select().from(evidenceSemanticJobs)
      .where(eq(evidenceSemanticJobs.tenantId, tenant.id));
    if (events.length !== 2 || contents.length !== 1 || intentions.length !== 1 || jobs.length !== 1) {
      throw new Error('persisted_replay_counts_failed');
    }
    const prompt = events.find(event => event.eventType === 'prompt');
    const reasoning = events.find(event => event.eventType === 'reasoning');
    if (!prompt || prompt.availability !== 'redacted' || !reasoning
      || reasoning.availability !== 'unavailable') {
      throw new Error('availability_classification_failed');
    }
    const raw = await readRawEvidence({ tenantId: tenant.id, eventId: prompt.id, actorId });
    const rawText = JSON.stringify(raw?.content ?? null);
    if (rawText.includes(redactionSentinel) || !rawText.includes('[REDACTED:assigned_secret]')) {
      throw new Error('pre_storage_redaction_failed');
    }
    const [rawAudit] = await db.select().from(securityAuditEvents).where(and(
      eq(securityAuditEvents.tenantId, tenant.id),
      eq(securityAuditEvents.action, 'evidence.raw.read'),
    ));
    if (!rawAudit) throw new Error('raw_read_audit_failed');

    activeStage = 'consent_denial';
    await setEvidenceConsent({ tenantId: tenant.id, actorId, enabled: false });
    const deniedByConsent = await send(batch(repository.id, marker, 'no-consent', 'Synthetic denied event'));
    if (deniedByConsent.status !== 403) throw new Error('disabled_consent_did_not_fail_closed');

    activeStage = 'repository_denial';
    await setEvidenceConsent({ tenantId: tenant.id, actorId, enabled: true });
    await revokeMachineRepositoryGrant(
      tenant.id, grant.id, actorId, 'Ephemeral Task5 authorization denial verification',
    );
    const deniedByGrant = await send(batch(repository.id, marker, 'no-grant', 'Synthetic denied event'));
    if (deniedByGrant.status !== 403) throw new Error('revoked_grant_did_not_fail_closed');
    const deniedEvents = await db.select().from(evidenceEvents).where(and(
      eq(evidenceEvents.tenantId, tenant.id),
      eq(evidenceEvents.providerEventId, `${marker}-prompt-no-grant`),
    ));
    if (deniedEvents.length !== 0) throw new Error('denied_event_was_persisted');

    activeStage = 'invalid_credential_denial';
    const invalidCredential = await send(
      batch(repository.id, marker, 'bad-credential', 'Synthetic denied event'),
      'not-a-managed-credential',
    );
    if (invalidCredential.status !== 401) throw new Error('invalid_credential_did_not_fail_closed');

    console.log('managed_machine_authentication=passed');
    console.log('opencode_first_delivery=accepted');
    console.log('opencode_replay=deduplicated');
    console.log('reasoning_unavailable=preserved');
    console.log('secret_redaction_before_storage=passed');
    console.log('raw_read_audit=recorded');
    console.log('disabled_consent=blocked');
    console.log('revoked_repository_grant=blocked');
    console.log('invalid_machine_credential=blocked');
    console.log('task5_opencode_live_verification=passed');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
}

void main().catch(error => {
  console.log('task5_opencode_live_verification=failed');
  console.log(`failure_stage=${activeStage}`);
  console.log(`safe_error=${error instanceof Error ? error.message : 'unknown'}`);
  process.exitCode = 1;
});
