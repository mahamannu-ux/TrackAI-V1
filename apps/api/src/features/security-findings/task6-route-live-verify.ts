import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  scmRepositories,
  securityFindings,
  ssoTenants,
  tenantSecurityMonitorSettings,
} from '../../core/db/schema';
import { authenticateMachine } from '../../core/middleware/machine-auth';
import {
  issueMachineCredential,
  registerDeveloperMachine,
  revokeMachineCredential,
} from '../../core/security/machine-security-service';
import {
  enrollRepository,
  grantMachineRepository,
} from '../../core/security/repository-security-service';
import securityFindingsRouter from './security-findings.routes';

interface HttpResult {
  status: number;
  cacheControl: string | null;
  body: unknown;
}

function finding(repositoryId: string, suffix: string, overrides: Record<string, unknown> = {}) {
  return {
    findingId: `finding-${suffix}`,
    deliveryId: `delivery-${suffix}`,
    repositoryId,
    sessionId: `session-${suffix}`,
    sourceEventId: `event-${suffix}`,
    rule: {
      id: 'trackai.exec.download_pipe_shell',
      version: '1.4',
      category: 'execution',
      severity: 'high',
    },
    capability: {
      routeId: 'AC-CLI-03',
      agentFamily: 'opencode',
      hostSurface: 'terminal',
      hostMode: 'cli',
      captureChannel: 'provider-plugin',
      operatingSystem: 'linux',
      timing: 'pre_action',
      nativeEffect: 'observe_only',
      activation: 'observed',
    },
    effect: 'monitor',
    phase: 'requested',
    availability: 'available',
    completeness: 'complete',
    resultCategory: 'not_observed',
    occurredAt: '2026-09-30T08:00:00Z',
    clientVersion: 'task6-live-test',
    rulePackVersion: 'task6-live-test',
    ...overrides,
  };
}

function batch(...findings: Array<Record<string, unknown>>) {
  return { schemaVersion: 'trackai.security-finding-upload/0.1', findings };
}

async function post(baseUrl: string, credential: string, body: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}/worker/security/findings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': credential },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: await response.json(),
  };
}

function requireResult(
  actual: HttpResult,
  status: number,
  expectedBody: unknown,
  name: string,
): void {
  if (actual.status !== status || JSON.stringify(actual.body) !== JSON.stringify(expectedBody)) {
    throw new Error(`${name} returned an unexpected safe response`);
  }
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
    || databaseUrl.pathname !== '/trackai_task6_security_live') {
    throw new Error('Task6 live verification requires the exact disposable local database');
  }

  const actorId = 'task6-live-verifier';
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
        companyName: 'Task6 Live A',
        domain: `task6-live-a-${suffix}.invalid`,
        supabaseProviderId: `task6-live-a-${suffix}`,
      },
      {
        id: tenantB,
        companyName: 'Task6 Live B',
        domain: `task6-live-b-${suffix}.invalid`,
        supabaseProviderId: `task6-live-b-${suffix}`,
      },
    ]);
    await db.insert(scmRepositories).values([
      {
        id: repositoryA,
        tenantId: tenantA,
        provider: 'github',
        externalId: `task6-live-a-${suffix}`,
        name: 'Task6 Live A',
        url: `https://example.invalid/task6-live-a-${suffix}`,
        normalizedUrl: `https://example.invalid/task6-live-a-${suffix}`,
      },
      {
        id: repositoryB,
        tenantId: tenantB,
        provider: 'github',
        externalId: `task6-live-b-${suffix}`,
        name: 'Task6 Live B',
        url: `https://example.invalid/task6-live-b-${suffix}`,
        normalizedUrl: `https://example.invalid/task6-live-b-${suffix}`,
      },
    ]);

    const machineA = await registerDeveloperMachine({
      tenantId: tenantA,
      installationId: `task6-live-machine-a-${suffix}`,
      displayName: 'Task6 Live Machine A',
      actorId,
    });
    const machineB = await registerDeveloperMachine({
      tenantId: tenantB,
      installationId: `task6-live-machine-b-${suffix}`,
      displayName: 'Task6 Live Machine B',
      actorId,
    });
    const credentialA = await issueMachineCredential({
      tenantId: tenantA, machineId: machineA.id, actorId,
    });
    const credentialB = await issueMachineCredential({
      tenantId: tenantB, machineId: machineB.id, actorId,
    });
    const enrollmentA = await enrollRepository({
      tenantId: tenantA, repositoryId: repositoryA, actorId,
    });
    const enrollmentB = await enrollRepository({
      tenantId: tenantB, repositoryId: repositoryB, actorId,
    });
    await grantMachineRepository({
      tenantId: tenantA,
      machineId: machineA.id,
      enrollmentId: enrollmentA.id,
      branchPatterns: [],
      actorId,
    });
    await grantMachineRepository({
      tenantId: tenantB,
      machineId: machineB.id,
      enrollmentId: enrollmentB.id,
      branchPatterns: [],
      actorId,
    });
    await db.insert(tenantSecurityMonitorSettings).values([
      { tenantId: tenantA, mode: 'monitor', updatedBy: actorId },
      { tenantId: tenantB, mode: 'off', updatedBy: actorId },
    ]);

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/worker/security', authenticateMachine, securityFindingsRouter);
    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Task6 live server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    console.error = (...values: unknown[]) => capturedLogs.push(values.map(String).join(' '));
    const acceptedBody = batch(finding(repositoryA, 'accepted'));
    const accepted = await post(baseUrl, credentialA.plaintext, acceptedBody);
    requireResult(accepted, 200, { errors: [] }, 'accepted finding');
    if (accepted.cacheControl !== 'no-store') throw new Error('Accepted response was cacheable');

    const replay = await post(baseUrl, credentialA.plaintext, acceptedBody);
    requireResult(replay, 200, { errors: [] }, 'exact replay');
    const changedReplay = await post(baseUrl, credentialA.plaintext, batch(finding(
      repositoryA,
      'accepted',
      { resultCategory: 'success' },
    )));
    requireResult(changedReplay, 200, {
      errors: [{ index: 0, error: 'finding_identity_collision' }],
    }, 'changed replay');

    const crossing = await post(
      baseUrl,
      credentialA.plaintext,
      batch(finding(repositoryB, 'cross-tenant')),
    );
    requireResult(crossing, 200, {
      errors: [{ index: 0, error: 'repository_not_authorized' }],
    }, 'cross-tenant repository');
    const monitorOff = await post(
      baseUrl,
      credentialB.plaintext,
      batch(finding(repositoryB, 'monitor-off')),
    );
    requireResult(monitorOff, 200, {
      errors: [{ index: 0, error: 'security_monitoring_not_active' }],
    }, 'monitor off');

    const secret = 'task6-live-secret-must-not-appear';
    const rawContent = await post(baseUrl, credentialA.plaintext, batch(finding(
      repositoryA,
      'raw-content',
      { commandText: secret },
    )));
    requireResult(rawContent, 400, { error: 'Invalid security finding upload' }, 'raw content');
    if ((JSON.stringify(rawContent.body) + capturedLogs.join('')).includes(secret)) {
      throw new Error('Raw content appeared in response or logs');
    }

    await revokeMachineCredential(
      tenantA,
      credentialA.id,
      actorId,
      'Task6 live revocation check',
    );
    const revoked = await post(
      baseUrl,
      credentialA.plaintext,
      batch(finding(repositoryA, 'revoked')),
    );
    if (revoked.status !== 401) throw new Error('Revoked credential was not blocked');

    const storedA = await db.select({ id: securityFindings.id })
      .from(securityFindings).where(eq(securityFindings.tenantId, tenantA));
    const storedB = await db.select({ id: securityFindings.id })
      .from(securityFindings).where(eq(securityFindings.tenantId, tenantB));
    if (storedA.length !== 1 || storedB.length !== 0) {
      throw new Error('Task6 stored finding counts crossed the approved boundary');
    }

    console.error = originalConsoleError;
    console.log('managed_machine_authentication=passed');
    console.log('exact_replay=acknowledged');
    console.log('changed_replay=blocked');
    console.log('cross_tenant_repository=blocked');
    console.log('monitor_off=blocked');
    console.log('revoked_credential=blocked');
    console.log('raw_content_capture=absent');
    console.log('tenant_a_findings=1');
    console.log('tenant_b_findings=0');
  } finally {
    console.error = originalConsoleError;
    if (server) await new Promise<void>((resolve, reject) => server?.close(error => (
      error ? reject(error) : resolve()
    )));
    await pool.end();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Task6 live route verification failed');
  process.exitCode = 1;
});
