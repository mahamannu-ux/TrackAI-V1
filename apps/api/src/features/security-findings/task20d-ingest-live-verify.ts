/**
 * IT-T20d-01 (docs/prompts/Task20): drives the real /worker/security/v2 router
 * over HTTP against the throwaway TrackAI database — machine-authenticated
 * managed credentials, the real persistSecururityV2Upload storage path with
 * envelope-encrypted previews, replay/conflict behaviour, lease-window and
 * data-settings admission, monotonic indicators, and Company A / Company B
 * tenant isolation.
 *
 * Run (founder): scripts/it-db.sh npm run verify:task20d-ingest-live -w apps/api
 * with IT_PG_DATABASES/IT_PG_EXPORTS naming trackai_task20d_ingest_live.
 * The lease and data-settings authority is fixed in this file: the lease store
 * itself is Task20f, so IT-T20d-01 covers ingest, not activation.
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  scmRepositories,
  securityAgentInventorySnapshots,
  securityEnforcementDecisions,
  securityFindingPreviews,
  securityFindings,
  securityIndicators,
  ssoTenants,
} from '../../core/db/schema';
import { authenticateMachine } from '../../core/middleware/machine-auth';
import {
  issueMachineCredential,
  registerDeveloperMachine,
  revokeMachineCredential,
} from '../../core/security/machine-security-service';
import { enrollRepository } from '../../core/security/repository-security-service';
import { decryptEnvelope } from '../../core/security/envelope-encryption';
import securityFindingsRouter, { createSecurityFindingsRouter } from './security-findings.routes';
import {
  SECURITY_DATA_SETTINGS_SCHEMA,
  SECURITY_V2_NUMBAT_SCHEMA,
} from './v2-contract';
import type { SecurityLeaseView, SecurityV2Authority } from './v2-authority';
import { SECURITY_V2_PREVIEW_PURPOSE } from './v2-storage';

interface HttpResult {
  status: number;
  cacheControl: string | null;
  body: unknown;
}

const SECRET = 'task20d-live-secret-must-not-appear';

let idCounter = 0;
function recordId(): string {
  const hex = (idCounter += 1).toString(16).padStart(2, '0');
  const a = randomUUID().replaceAll('-', '');
  const b = randomUUID().replaceAll('-', '');
  return `sha256:${a}${b.slice(0, 30)}${hex}`;
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'finding',
    record_id: recordId(),
    rule_id: 'nb.cmd.dangerous_deletion',
    rule_version: '2.1',
    severity: 'high',
    title: 'Destructive deletion was observed',
    source_agent: 'opencode',
    source_type: 'hook',
    confidence: 'high',
    detected_at: new Date(Date.now() - 1_800_000).toISOString(),
    numbat_schema_version: SECURITY_V2_NUMBAT_SCHEMA,
    bundle_digest: 'ab'.repeat(32),
    lease_id: 'lease-live-task20d',
    found_at_rest: false,
    repository: { kind: 'not_enrolled' },
    ...overrides,
  };
}

function enforcement(): Record<string, unknown> {
  return {
    kind: 'enforcement',
    record_id: recordId(),
    rule_ids: ['nb.cmd.dangerous_deletion'],
    finding_record_ids: [],
    decision: 'no_override',
    mode: 'monitor',
    source_agent: 'opencode',
    timestamp: new Date(Date.now() - 1_790_000).toISOString(),
  };
}

function indicator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'indicator',
    record_id: recordId(),
    type: 'domain',
    value: 'tracker.example.internal',
    count: 3,
    first_seen: new Date(Date.now() - 3_600_000).toISOString(),
    last_seen: new Date(Date.now() - 1_800_000).toISOString(),
    source_agent: 'opencode',
    ...overrides,
  };
}

function upload(...records: Array<Record<string, unknown>>) {
  return { schema_version: 'trackai.security-upload/2', records };
}

async function postV2(baseUrl: string, credential: string | null, body: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}/worker/security/v2/records`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential === null ? {} : { 'x-api-key': credential }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  };
}

function requireResult(actual: HttpResult, status: number, predicate: (body: any) => boolean, name: string): void {
  if (actual.status !== status || !predicate(actual.body)) {
    throw new Error(`${name}: unexpected response ${actual.status} ${JSON.stringify(actual.body)
      .replace(new RegExp(SECRET, 'g'), '[redacted]')}`);
  }
}

function requireNoStore(actual: HttpResult, name: string): void {
  if (actual.cacheControl !== 'no-store') throw new Error(`${name}: response was cacheable`);
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (it-db.sh sets it)');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
    || databaseUrl.pathname !== '/trackai_task20d_ingest_live') {
    throw new Error('Task20d live verification requires the exact disposable local database');
  }

  const actorId = 'task20d-live-verifier';
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const repositoryA = randomUUID();
  const repositoryB = randomUUID();
  const suffix = randomUUID();
  let server: Server | undefined;
  const capturedLogs: string[] = [];
  const originalConsoleError = console.error;
  try {
    await db.insert(ssoTenants).values([
      {
        id: tenantA,
        companyName: 'Task20d Live A',
        domain: `task20d-live-a-${suffix}.invalid`,
        supabaseProviderId: `task20d-live-a-${suffix}`,
      },
      {
        id: tenantB,
        companyName: 'Task20d Live B',
        domain: `task20d-live-b-${suffix}.invalid`,
        supabaseProviderId: `task20d-live-b-${suffix}`,
      },
    ]);
    await db.insert(scmRepositories).values([
      {
        id: repositoryA,
        tenantId: tenantA,
        provider: 'github',
        externalId: `task20d-live-a-${suffix}`,
        name: 'Task20d Live A',
        url: `https://example.invalid/task20d-live-a-${suffix}`,
        normalizedUrl: `https://example.invalid/task20d-live-a-${suffix}`,
      },
      {
        id: repositoryB,
        tenantId: tenantB,
        provider: 'github',
        externalId: `task20d-live-b-${suffix}`,
        name: 'Task20d Live B',
        url: `https://example.invalid/task20d-live-b-${suffix}`,
        normalizedUrl: `https://example.invalid/task20d-live-b-${suffix}`,
      },
    ]);
    const machineA = await registerDeveloperMachine({
      tenantId: tenantA,
      installationId: `task20d-live-machine-a-${suffix}`,
      displayName: 'Task20d Live Machine A',
      actorId,
    });
    const machineB = await registerDeveloperMachine({
      tenantId: tenantB,
      installationId: `task20d-live-machine-b-${suffix}`,
      displayName: 'Task20d Live Machine B',
      actorId,
    });
    const credentialA = await issueMachineCredential({
      tenantId: tenantA, machineId: machineA.id, actorId,
    });
    const credentialB = await issueMachineCredential({
      tenantId: tenantB, machineId: machineB.id, actorId,
    });
    await enrollRepository({ tenantId: tenantA, repositoryId: repositoryA, actorId });
    await enrollRepository({ tenantId: tenantB, repositoryId: repositoryB, actorId });

    // The Task20f lease store will answer these; ingest verifies against a
    // fixed in-file authority (Tenant A allows all five preview switches,
    // Tenant B runs the conservative all-off default).
    const lease: SecurityLeaseView = {
      leaseId: 'lease-live-task20d',
      issuedAt: new Date(Date.now() - 3_600_000),
      expiresAt: new Date(Date.now() + 3 * 3_600_000),
    };
    const settingsA = {
      schema_version: SECURITY_DATA_SETTINGS_SCHEMA,
      command_previews: true,
      file_paths: true,
      urls: true,
      host_identity: true,
      user_identity: true,
    };
    const authority: SecurityV2Authority = {
      async currentLease(tenantId) {
        return tenantId === tenantA || tenantId === tenantB ? lease : null;
      },
      async leaseForMachine(_tenantId, _machineId, leaseId) {
        return leaseId === lease.leaseId ? lease : null;
      },
      async currentDataSettings(tenantId) {
        return tenantId === tenantA ? settingsA : null;
      },
    };

    const app = express();
    app.use(
      '/worker/security',
      authenticateMachine,
      createSecurityFindingsRouter({ v2Dependencies: { authority } }),
    );
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Task20d live server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    console.error = (...values: unknown[]) => capturedLogs.push(values.map(String).join(' '));

    // 1. A missing or revoked managed credential is refused before routing.
    const unauthenticated = await postV2(baseUrl, 'task20d-not-a-key', upload(finding()));
    requireResult(unauthenticated, 401, () => true, 'unauthenticated');

    // 2. Mixed-kinds accepted upload for Tenant A, previews sealed encrypted.
    const secretFinding = finding({
      observed_command: SECRET,
      endpoint: { hostname: 'laptop-a.invalid' },
    });
    const acceptedUpload = upload(
      secretFinding,
      enforcement(),
      indicator(),
    );
    const accepted = await postV2(baseUrl, credentialA.plaintext, acceptedUpload);
    requireResult(accepted, 200, body => (body as any).schema_version === 'trackai.security-upload-result/2'
      && (body as any).results.every((entry: any) => entry.result === 'accepted'), 'accepted upload');
    requireNoStore(accepted, 'accepted upload');

    // 3. Exact replay duplicates without resealing previews.
    const previewsBefore = await db.select({ id: securityFindingPreviews.id })
      .from(securityFindingPreviews).where(eq(securityFindingPreviews.tenantId, tenantA));
    const replay = await postV2(baseUrl, credentialA.plaintext, acceptedUpload);
    requireResult(replay, 200, body => (body as any).results.every((entry: any) => entry.result === 'duplicate'), 'exact replay');
    const previewsAfterReplay = await db.select({ id: securityFindingPreviews.id })
      .from(securityFindingPreviews).where(eq(securityFindingPreviews.tenantId, tenantA));
    if (previewsAfterReplay.length !== previewsBefore.length) {
      throw new Error('Exact replay resealed previews');
    }

    // 4. A changed field on the same record id is a conflict.
    const changedReplay = await postV2(baseUrl, credentialA.plaintext, upload({
      ...secretFinding,
      title: 'A changed title for the same record id',
    }));
    requireResult(changedReplay, 200, body => (body as any).results[0].result === 'rejected'
      && (body as any).results[0].code === 'SECURITY_V2_RECORD_CONFLICT', 'changed replay');

    // 5. Lease window and unknown lease ids are refused before storage.
    const beforeLease = await postV2(baseUrl, credentialA.plaintext, upload(finding({
      detected_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    })));
    requireResult(beforeLease, 200, body => (body as any).results[0].code === 'SECURITY_V2_LEASE_MISMATCH', 'lease window');
    const unknownLease = await postV2(baseUrl, credentialA.plaintext, upload(finding({ lease_id: 'lease-unknown' })));
    requireResult(unknownLease, 200, body => (body as any).results[0].code === 'SECURITY_V2_LEASE_MISMATCH', 'unknown lease');

    // 6. Enrolled-repository checks are tenant-bound.
    const crossTenantRepository = await postV2(baseUrl, credentialA.plaintext, upload({
      ...finding(), repository: { kind: 'enrolled', id: repositoryB },
    }));
    requireResult(crossTenantRepository, 200, body => (body as any).results[0].code === 'SECURITY_V2_INVALID_BODY', 'cross-tenant repository');
    const enrolledOwn = await postV2(baseUrl, credentialA.plaintext, upload({
      ...finding(), repository: { kind: 'enrolled', id: repositoryA },
    }));
    requireResult(enrolledOwn, 200, body => (body as any).results[0].result === 'accepted', 'own enrolled repository');

    // 7. Tenant B runs the all-off settings: a carrying record is refused,
    // a metadata-only finding is accepted.
    const carryingB = await postV2(baseUrl, credentialB.plaintext, upload(finding({ observed_command: SECRET })));
    requireResult(carryingB, 200, body => (body as any).results[0].code === 'SECURITY_V2_FIELD_NOT_PERMITTED', 'off settings carrying');
    const cleanB = await postV2(baseUrl, credentialB.plaintext, upload(
      finding({ observed_command: undefined, endpoint: undefined }),
      indicator(),
    ));
    requireResult(cleanB, 200, body => (body as any).results[0].result === 'accepted'
      && (body as any).results[1].code === 'SECURITY_V2_FIELD_NOT_PERMITTED', 'off settings metadata-only');
    requireNoStore(carryingB, 'off settings carrying');

    // 8. Indicators merge monotonically per component.
    const originalIndicator = acceptedUpload.records[2] as Record<string, unknown>;
    const raised = await postV2(baseUrl, credentialA.plaintext, upload({
      ...originalIndicator,
      count: 9,
      last_seen: new Date(Date.now() - 600_000).toISOString(),
    }));
    requireResult(raised, 200, body => (body as any).results[0].result === 'accepted', 'raised indicator');
    const [storedIndicator] = await db.select()
      .from(securityIndicators).where(eq(securityIndicators.tenantId, tenantA));
    if (!storedIndicator || storedIndicator.count !== 9) {
      throw new Error('Indicator maximum did not merge');
    }

    // 9. Previews are recoverable only through the exact envelope context, and
    // no plaintext column anywhere carries the secret.
    const [previewRow] = await db.select()
      .from(securityFindingPreviews)
      .where(and(eq(securityFindingPreviews.tenantId, tenantA), eq(securityFindingPreviews.field, 'observed_command')));
    if (!previewRow) throw new Error('The permitted preview was not stored');
    const plaintext = decryptEnvelope(previewRow.valueEncrypted as any, {
      tenantId: tenantA,
      purpose: SECURITY_V2_PREVIEW_PURPOSE,
      resourceId: `${previewRow.findingId}:observed_command`,
    });
    if (plaintext !== SECRET) throw new Error('Preview envelope did not round-trip');
    const findingRows = await db.select()
      .from(securityFindings).where(eq(securityFindings.tenantId, tenantA));
    const tenantARows = JSON.stringify(findingRows) + JSON.stringify(previewRow);
    if (tenantARows.includes(SECRET)) {
      throw new Error('The secret appeared in plaintext in a stored row');
    }

    // 10. Logs carry codes and counts only.
    const allLogs = capturedLogs.join('\n');
    if (allLogs.includes(SECRET) || allLogs.includes('tracker.example.internal')) {
      throw new Error('A value or identifier appeared in the logs');
    }

    // 11. Revoked credentials are refused.
    await revokeMachineCredential(tenantA, credentialA.id, actorId, 'Task20d live revocation check');
    const revoked = await postV2(baseUrl, credentialA.plaintext, upload(finding()));
    if (revoked.status !== 401) throw new Error('Revoked credential was not blocked');

    // 12. Stored counts stay inside the approved boundary.
    const countRows = async (table: any, tenantId: string): Promise<number> => {
      const rows = await db.select({ id: table.id }).from(table).where(eq(table.tenantId, tenantId));
      return rows.length;
    };
    const findingsA = await countRows(securityFindings, tenantA);
    const findingsB = await countRows(securityFindings, tenantB);
    const previewsA = await countRows(securityFindingPreviews, tenantA);
    const previewsB = await countRows(securityFindingPreviews, tenantB);
    const enforcementA = await countRows(securityEnforcementDecisions, tenantA);
    const indicatorA = await countRows(securityIndicators, tenantA);
    const inventoryA = await countRows(securityAgentInventorySnapshots, tenantA);
    if (findingsA !== 2 || findingsB !== 1 || previewsA !== 2 || previewsB !== 0
      || enforcementA !== 1 || indicatorA !== 1 || inventoryA !== 0) {
      throw new Error(`Stored counts crossed the boundary: A findings=${findingsA} previews=${previewsA} `
        + `enforcement=${enforcementA} indicators=${indicatorA}; B findings=${findingsB} previews=${previewsB}`);
    }

    console.error = originalConsoleError;
    console.log('unauthenticated=refused');
    console.log('accepted_upload=stored');
    console.log('exact_replay=duplicated_without_resealing');
    console.log('changed_replay=conflict');
    console.log('lease_window_and_unknown_lease=rejected');
    console.log('own_enrolled_repository=accepted');
    console.log('cross_tenant_repository=refused');
    console.log('off_settings_carrying=refused_metadata_only=accepted');
    console.log('indicator_maxima=monotonic');
    console.log('preview_envelope=round_trips_and_plaintext_absent_in_rows');
    console.log('logs=codes_and_counts_only');
    console.log('revoked_credential=blocked');
    console.log(`stored_counts=A(findings=2,previews=2,enforcement=1,indicators=1) B(findings=1,previews=0)`);
  } finally {
    console.error = originalConsoleError;
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => (
      error ? reject(error) : resolve()
    )));
    await pool.end();
  }
}


void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task20d live ingest verification failed');
  process.exitCode = 1;
});
