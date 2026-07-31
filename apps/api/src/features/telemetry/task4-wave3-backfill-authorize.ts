import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { repositoryEnrollments } from '../../core/db/schema';
import { authorizeRepositoryBackfill } from '../../core/security/repository-security-service';

type Manifest = {
  version: number;
  actorId: string;
  entries: Array<{
    label: string;
    tenantId: string;
    enrollmentId: string;
  }>;
};

async function main(): Promise<void> {
  const runtimeDirValue = process.env.TASK4_WAVE3_RUNTIME_DIR?.trim();
  if (!runtimeDirValue) throw new Error('TASK4_WAVE3_RUNTIME_DIR is required');
  const manifestPath = resolve(runtimeDirValue, 'task4-wave2-client-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (manifest.version !== 1 || !manifest.actorId || !Array.isArray(manifest.entries)) {
    throw new Error('Wave 3 client manifest is invalid');
  }
  const companyA = manifest.entries.find(entry => entry.label === 'company_a');
  if (!companyA) throw new Error('Company A manifest entry is missing');
  const [enrollment] = await db.select({
    generationSessionEvidenceFrom: repositoryEnrollments.generationSessionEvidenceFrom,
    commitNoteEvidenceFrom: repositoryEnrollments.commitNoteEvidenceFrom,
    status: repositoryEnrollments.status,
  }).from(repositoryEnrollments).where(and(
    eq(repositoryEnrollments.tenantId, companyA.tenantId),
    eq(repositoryEnrollments.id, companyA.enrollmentId),
  )).limit(1);
  if (!enrollment || enrollment.status !== 'active') {
    throw new Error('Company A active enrollment is unavailable');
  }
  const occurredUntil = new Date(enrollment.generationSessionEvidenceFrom.getTime() - 1000);
  const occurredFrom = new Date(occurredUntil.getTime() - 2 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

  console.log('tenant=company_a');
  console.log('evidence_family=generation_session');
  console.log(`occurred_from=${occurredFrom.toISOString()}`);
  console.log(`occurred_until=${occurredUntil.toISOString()}`);
  console.log(`generation_watermark=${enrollment.generationSessionEvidenceFrom.toISOString()}`);
  console.log(`commit_note_watermark=${enrollment.commitNoteEvidenceFrom.toISOString()}`);
  console.log(`expires_at=${expiresAt.toISOString()}`);
  console.log('company_b_authorization=none');
  console.log('commit_note_authorization=none');

  if (process.env.TASK4_WAVE3_BACKFILL_APPLY !== '1') {
    console.log('database_changes=none');
    console.log('authorization=dry-run-complete');
    return;
  }
  const authorization = await authorizeRepositoryBackfill({
    tenantId: companyA.tenantId,
    enrollmentId: companyA.enrollmentId,
    evidenceFamily: 'generation_session',
    occurredFrom,
    occurredUntil,
    expiresAt,
    actorId: manifest.actorId,
    reason: 'Task4 Wave 3 controlled replay verification',
    now,
  });
  console.log(`authorization_id=${authorization.id}`);
  console.log('authorization=applied');
  console.log('audit_event=written');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Wave 3 backfill authorization failed');
  process.exitCode = 1;
});
