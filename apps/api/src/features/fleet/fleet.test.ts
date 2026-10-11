import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type RequestHandler, type Router } from 'express';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { fleetConfigurations, fleetMachineStates } from '../../core/db/schema';
import {
  configurationEnvelope,
  parseCreateFleetConfiguration,
  parseFleetAssignment,
  parseFleetReport,
} from './contract';
import { createFleetAdminRouter, createFleetWorkerRouter } from './fleet.routes';
import { classifyFleetMachineStatus, FleetServiceError } from './service';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const machineA = '33333333-3333-4333-8333-333333333333';
const machineB = '99999999-9999-4999-8999-999999999999';
const configurationA = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-10-09T10:00:00.000Z');
const manifestSha256 = 'a'.repeat(64);

function v2Configuration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    clientCompatibility: { minimumVersion: '1.6.19', maximumVersion: '1.6.20' },
    desiredRelease: {
      version: '1.6.20',
      releaseTag: 'v1.6.20',
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS',
      manifestSha256,
    },
    channel: 'enterprise-latest',
    ring: 'early',
    validUntil: '2026-10-10T10:00:00.000Z',
    reason: 'pin the exact release',
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    reportedAt: '2026-10-09T09:59:00.000Z',
    acknowledgement: {
      configurationId: configurationA,
      epoch: 1,
      resultCode: 'applied',
    },
    platform: 'macos',
    osVersion: '15.7',
    architecture: 'x86_64',
    gitaiVersion: '1.2.3',
    serviceState: 'running',
    queue: {
      pendingRetryable: 1,
      waitingRetry: 2,
      processing: 0,
      quarantined: 0,
      rowsWithErrors: 0,
    },
    mdmDeviceReference: 'device-ref-1',
    mdmUserReference: null,
    assignmentEvidence: { source: 'jamf', observedAt: '2026-10-09T09:58:00.000Z' },
    ...overrides,
  };
}

interface RouteResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function invoke(
  router: Router,
  input: {
    method: string;
    url: string;
    body?: unknown;
    tenantId?: string;
    machineId?: string;
    managedMachineCredential?: boolean;
    subject?: string;
  },
): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(router);
    const headers: Record<string, string> = {};
    const req = {
      method: input.method,
      url: input.url,
      originalUrl: input.url,
      headers: {},
      body: input.body,
      tenantId: input.tenantId,
      machineId: input.machineId,
      managedMachineCredential: input.managedMachineCredential,
      user: input.subject ? { sub: input.subject } : undefined,
    };
    const finish = (status: number, body: unknown) => resolve({ status, body, headers });
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
      getHeader(name: string) { return headers[name.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { finish(this.statusCode, body); return this; },
      send(body?: unknown) { finish(this.statusCode, body); return this; },
      end(body?: unknown) { finish(this.statusCode, body); return this; },
    };
    app(req as never, res as never, reject);
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    getConfiguration: async () => null,
    recordReport: async () => undefined,
    listMachines: async () => ({ machines: [] }),
    createConfiguration: async () => ({ id: configurationA, epoch: 1 }),
    assignConfiguration: async () => undefined,
    previewOffboard: async () => ({
      activeCredentialCount: 1,
      activeGrantCount: 2,
      desiredConfigurationId: configurationA,
      localCleanup: 'best_effort_not_requested_by_server',
    }),
    applyOffboard: async () => ({
      serverRevocation: 'applied',
      localCleanup: 'best_effort_not_requested_by_server',
      mdmCleanup: 'not_requested',
    }),
    now: () => now,
    logError: () => undefined,
    ...overrides,
  } as never;
}

test('fleet report contract is closed, bounded, and future-safe', () => {
  assert.equal(parseFleetReport(report(), now).queue.waitingRetry, 2);
  assert.throws(() => parseFleetReport(report({ tenantId: tenantB }), now), /unsupported fields/);
  assert.throws(() => parseFleetReport(report({ queue: {
    pendingRetryable: -1, waitingRetry: 0, processing: 0, quarantined: 0, rowsWithErrors: 0,
  } }), now), /pendingRetryable/);
  assert.throws(() => parseFleetReport(report({ reportedAt: '2026-10-09T10:06:00.000Z' }), now));
  assert.throws(() => parseFleetReport(report({ serviceState: 'healthy' }), now));
  assert.throws(() => parseFleetReport(report({ osVersion: 'x'.repeat(129) }), now));
});

test('configuration and assignment inputs reject caller policy and unbounded rollout targets', () => {
  const configuration = parseCreateFleetConfiguration({
    targetClientVersion: '1.2.3',
    channel: 'enterprise-latest',
    ring: 'early',
    validUntil: '2026-10-10T10:00:00.000Z',
    reason: 'start the early ring',
  }, now);
  assert.equal(configuration.channel, 'enterprise-latest');
  assert.equal(configuration.schemaVersion, 1);
  assert.throws(() => parseCreateFleetConfiguration({
    targetClientVersion: '1.2.3', channel: 'latest', reason: 'x', policy: { secret: 'no' },
  }, now), /unsupported fields/);
  assert.throws(() => parseFleetAssignment({
    configurationId: configurationA,
    machineIds: Array.from({ length: 101 }, () => machineA),
    reason: 'too many',
  }));
});

test('schema-v2 creation is closed and validates compatibility and immutable release identity', () => {
  const configuration = parseCreateFleetConfiguration(v2Configuration(), now);
  assert.equal(configuration.schemaVersion, 2);
  if (configuration.schemaVersion !== 2) assert.fail('expected schema v2');
  assert.equal(configuration.clientCompatibility.minimumVersion, '1.6.19');
  assert.equal(configuration.desiredRelease.manifestSha256, manifestSha256);

  const invalid = [
    v2Configuration({ clientCompatibility: { minimumVersion: '1.6.21', maximumVersion: '1.6.20' } }),
    v2Configuration({ clientCompatibility: { minimumVersion: '01.6.19', maximumVersion: '1.6.20' } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object, releaseTag: 'v1.6.20/other',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object, releaseTag: '..',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object,
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/latest/download/SHA256SUMS',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object,
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.19/SHA256SUMS',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object,
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS?x=1',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object,
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS#x',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object,
      manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20%2fother/SHA256SUMS',
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object, manifestSha256: 'A'.repeat(64),
    } }),
    v2Configuration({ desiredRelease: {
      ...v2Configuration().desiredRelease as object, manifestSha256: 'a'.repeat(63),
    } }),
    v2Configuration({ targetClientVersion: '1.6.20' }),
  ];
  for (const value of invalid) assert.throws(() => parseCreateFleetConfiguration(value, now));
  assert.throws(() => parseCreateFleetConfiguration({
    schemaVersion: 1,
    targetClientVersion: '1.6.20',
    channel: 'latest',
    ring: null,
    validUntil: null,
    reason: 'cannot masquerade',
  }, now), /unsupported fields/);
});

test('configuration envelope exposes the Task15 fail-closed seam and no secret material', () => {
  const envelope = configurationEnvelope({
    machineId: machineA,
    id: configurationA,
    epoch: 3,
    generatedAt: now,
    validUntil: null,
    schemaVersion: 1,
    targetClientVersion: '1.2.3',
    clientMinimumVersion: null,
    clientMaximumVersion: null,
    releaseTag: null,
    manifestUrl: null,
    manifestSha256: null,
    channel: 'latest',
    ring: null,
    snapshot: {
      repositoryPolicies: [{
        machineId: machineA,
        repositoryId: '55555555-5555-4555-8555-555555555555',
        enrollmentId: '66666666-6666-4666-8666-666666666666',
        grantId: '77777777-7777-4777-8777-777777777777',
        branchPatterns: ['main'],
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
      }, {
        machineId: machineB,
        repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        enrollmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        branchPatterns: ['release/*'],
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
      }],
      securityActivation: { mode: 'monitor', version: 2 },
    },
  });
  assert.deepEqual(envelope.verification, { required: true, state: 'unavailable' });
  assert.deepEqual(Object.keys(envelope), [
    'schemaVersion', 'configurationId', 'epoch', 'issuedAt', 'validUntil',
    'targetClientVersion', 'channel', 'ring', 'repositoryPolicies',
    'securityActivation', 'verification',
  ]);
  assert.equal('clientCompatibility' in envelope, false);
  assert.equal('desiredRelease' in envelope, false);
  assert.equal(envelope.repositoryPolicies.length, 1);
  assert.equal('machineId' in envelope.repositoryPolicies[0], false);
  assert.doesNotMatch(JSON.stringify(envelope), /credential|secret|prompt|raw/i);
});

test('schema-v2 envelope separates compatibility from desired release and remains machine-scoped', () => {
  const envelope = configurationEnvelope({
    machineId: machineA,
    id: configurationA,
    epoch: 4,
    generatedAt: now,
    validUntil: null,
    schemaVersion: 2,
    targetClientVersion: '1.6.20',
    clientMinimumVersion: '1.6.19',
    clientMaximumVersion: '1.6.20',
    releaseTag: 'v1.6.20',
    manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS',
    manifestSha256,
    channel: 'enterprise-next',
    ring: null,
    snapshot: {
      repositoryPolicies: [{
        machineId: machineA,
        repositoryId: '55555555-5555-4555-8555-555555555555',
        enrollmentId: '66666666-6666-4666-8666-666666666666',
        grantId: '77777777-7777-4777-8777-777777777777',
        branchPatterns: ['main'],
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
      }, {
        machineId: machineB,
        repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        enrollmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        branchPatterns: ['release/*'],
        effectiveFrom: now.toISOString(),
        effectiveUntil: null,
      }],
      securityActivation: { mode: 'monitor', version: 2 },
    },
  });
  assert.equal(envelope.schemaVersion, 2);
  if (envelope.schemaVersion !== 2) assert.fail('expected schema v2');
  assert.deepEqual(envelope.clientCompatibility, {
    minimumVersion: '1.6.19', maximumVersion: '1.6.20',
  });
  assert.equal(envelope.desiredRelease.version, '1.6.20');
  assert.equal('targetClientVersion' in envelope, false);
  assert.equal(envelope.repositoryPolicies.length, 1);
  assert.deepEqual(envelope.verification, { required: true, state: 'unavailable' });
});

test('worker routes require managed credentials and derive tenant and machine from authentication', async () => {
  let storedIdentity: { tenantId: string; machineId: string } | undefined;
  const router = createFleetWorkerRouter(dependencies({
    recordReport: async (input: { tenantId: string; machineId: string }) => {
      storedIdentity = input;
    },
  }));
  const denied = await invoke(router, { method: 'POST', url: '/report', body: report() });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'managed_machine_required' });
  assert.equal(denied.headers['cache-control'], 'no-store');
  const accepted = await invoke(router, {
    method: 'POST',
    url: '/report',
    body: report({ tenantId: tenantB, machineId: 'body-machine' }),
    tenantId: tenantA,
    machineId: machineA,
    managedMachineCredential: true,
  });
  assert.equal(accepted.status, 400);
  const valid = await invoke(router, {
    method: 'POST', url: '/report', body: report(), tenantId: tenantA,
    machineId: machineA, managedMachineCredential: true,
  });
  assert.deepEqual(valid.body, { ok: true });
  assert.equal(storedIdentity?.tenantId, tenantA);
  assert.equal(storedIdentity?.machineId, machineA);
});

test('configuration route returns no-content or the assigned no-store envelope', async () => {
  const empty = await invoke(createFleetWorkerRouter(dependencies()), {
    method: 'GET', url: '/configuration', tenantId: tenantA,
    machineId: machineA, managedMachineCredential: true,
  });
  assert.equal(empty.status, 204);
  const assigned = await invoke(createFleetWorkerRouter(dependencies({
    getConfiguration: async () => ({ configurationId: configurationA, verification: {
      required: true, state: 'unavailable',
    } }),
  })), {
    method: 'GET', url: '/configuration', tenantId: tenantA,
    machineId: machineA, managedMachineCredential: true,
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.headers['cache-control'], 'no-store');
});

test('admin routes reuse one authorization boundary and keep tenant A separate from B', async () => {
  let listedTenant: string | undefined;
  const allow: RequestHandler = (_req, _res, next) => next();
  const router = createFleetAdminRouter(dependencies({
    listMachines: async (tenantId: string) => {
      listedTenant = tenantId;
      return { machines: [] };
    },
  }), allow);
  const result = await invoke(router, {
    method: 'GET', url: '/machines', tenantId: tenantA, subject: 'admin-a',
  });
  assert.equal(result.status, 200);
  assert.equal(listedTenant, tenantA);

  const deny: RequestHandler = (_req, res) => {
    res.status(403).json({ error: 'Forbidden: Tenant administrator permission is required' });
  };
  const auditor = await invoke(createFleetAdminRouter(dependencies(), deny), {
    method: 'GET', url: '/machines', tenantId: tenantB, subject: 'auditor-b',
  });
  assert.equal(auditor.status, 403);
});

test('admin creation keeps v1 compatible and returns a closed schema-v2 response', async () => {
  const allow: RequestHandler = (_req, _res, next) => next();
  let captured: unknown;
  const router = createFleetAdminRouter(dependencies({
    createConfiguration: async (input: { configuration: unknown }) => {
      captured = input.configuration;
      return {
        id: configurationA,
        epoch: 2,
        schemaVersion: 2,
        generatedAt: now,
        validUntil: null,
        clientCompatibility: { minimumVersion: '1.6.19', maximumVersion: '1.6.20' },
        desiredRelease: {
          version: '1.6.20', releaseTag: 'v1.6.20',
          manifestUrl: 'https://github.com/mahamannu-ux/git-ai/releases/download/v1.6.20/SHA256SUMS',
          manifestSha256,
        },
        channel: 'enterprise-latest',
        ring: 'early',
      };
    },
  }), allow);
  const result = await invoke(router, {
    method: 'POST', url: '/configurations', tenantId: tenantA, subject: 'admin-a',
    body: v2Configuration(),
  });
  assert.equal(result.status, 201);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal((captured as { schemaVersion: number }).schemaVersion, 2);
  const response = result.body as { configuration: Record<string, unknown> };
  assert.equal(response.configuration.schemaVersion, 2);
  assert.equal('targetClientVersion' in response.configuration, false);
});

test('assignment supports rollback and offboard preview cannot revoke', async () => {
  const assignments: string[] = [];
  let applies = 0;
  const allow: RequestHandler = (_req, _res, next) => next();
  const router = createFleetAdminRouter(dependencies({
    assignConfiguration: async (input: { assignment: { configurationId: string } }) => {
      assignments.push(input.assignment.configurationId);
    },
    applyOffboard: async () => {
      applies += 1;
      return { serverRevocation: 'applied' };
    },
  }), allow);
  for (const configurationId of [configurationA, '88888888-8888-4888-8888-888888888888']) {
    const result = await invoke(router, {
      method: 'POST', url: '/assignments', tenantId: tenantA, subject: 'admin-a',
      body: { configurationId, machineIds: [machineA], reason: 'bounded rollout' },
    });
    assert.equal(result.status, 200);
  }
  assert.equal(assignments.length, 2);
  const preview = await invoke(router, {
    method: 'POST', url: `/machines/${machineA}/offboard/preview`, tenantId: tenantA,
    subject: 'admin-a', body: {},
  });
  assert.equal(preview.status, 200);
  assert.equal(applies, 0);
  const rejectedApply = await invoke(router, {
    method: 'POST', url: `/machines/${machineA}/offboard`, tenantId: tenantA,
    subject: 'admin-a', body: { apply: false, reason: 'not confirmed' },
  });
  assert.equal(rejectedApply.status, 400);
  assert.equal(applies, 0);
});

test('safe route errors do not expose internal messages', async () => {
  const router = createFleetWorkerRouter(dependencies({
    getConfiguration: async () => { throw new Error('private SQL details'); },
  }));
  const result = await invoke(router, {
    method: 'GET', url: '/configuration', tenantId: tenantA,
    machineId: machineA, managedMachineCredential: true,
  });
  assert.deepEqual(result.body, { error: 'fleet_unavailable' });
  const missing = await invoke(createFleetWorkerRouter(dependencies({
    getConfiguration: async () => { throw new FleetServiceError(404, 'not_found'); },
  })), {
    method: 'GET', url: '/configuration', tenantId: tenantA,
    machineId: machineA, managedMachineCredential: true,
  });
  assert.deepEqual(missing.body, { error: 'not_found' });
});

test('fleet status keeps revoked, unreported, unavailable, mismatch, stale and current distinct', () => {
  const state = {
    desiredConfigurationId: configurationA,
    acknowledgedConfigurationId: configurationA,
    lastReportAt: new Date('2026-10-09T09:59:00Z'),
    serviceState: 'running',
  } as typeof fleetMachineStates.$inferSelect;
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'revoked', state, now }), 'revoked');
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'active', state: undefined, now }), 'unreported');
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'active', state: { ...state, serviceState: 'unavailable' }, now }), 'unavailable');
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'active', state: { ...state, acknowledgedConfigurationId: null }, now }), 'mismatch');
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'active', state: { ...state, lastReportAt: new Date('2026-10-09T09:00:00Z') }, now }), 'stale');
  assert.equal(classifyFleetMachineStatus({ machineStatus: 'active', state, now }), 'current');
});

test('fleet tables retain tenant composite keys, bounded checks and tenant foreign keys', () => {
  const configurations = getTableConfig(fleetConfigurations);
  const states = getTableConfig(fleetMachineStates);
  assert.ok(configurations.uniqueConstraints.some(key => key.getName() === 'fleet_configurations_tenant_id_id_key'));
  assert.ok(configurations.uniqueConstraints.some(key => key.getName() === 'fleet_configurations_tenant_epoch_key'));
  assert.ok(states.uniqueConstraints.some(key => key.getName() === 'fleet_machine_states_tenant_machine_key'));
  assert.equal(states.foreignKeys.length, 4);
  assert.ok(states.checks.length >= 5);
  assert.ok(configurations.checks.some(check => (
    check.name === 'fleet_configurations_release_contract_check'
  )));
});
