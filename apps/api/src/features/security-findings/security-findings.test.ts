import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitSecurityFindingBatch,
  validateSecurityFindingUploadBatch,
} from './contract';

function safeFinding(overrides: Record<string, unknown> = {}) {
  return {
    findingId: 'finding-001',
    deliveryId: 'delivery-001',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sessionId: 'session-001',
    sourceEventId: 'event-001',
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
    clientVersion: '0.1.0-test',
    rulePackVersion: '0.1.0-test',
    ...overrides,
  };
}

function safeBatch(...findings: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 'trackai.security-finding-upload/0.1',
    findings: findings.length ? findings : [safeFinding()],
  };
}

test('security finding upload accepts only the closed metadata contract', () => {
  assert.equal(validateSecurityFindingUploadBatch(safeBatch()).findings.length, 1);
  assert.throws(
    () => validateSecurityFindingUploadBatch(safeBatch(safeFinding({
      commandText: 'must-not-cross-the-boundary',
    }))),
    /unsupported field/,
  );
  assert.throws(
    () => validateSecurityFindingUploadBatch(safeBatch(safeFinding({
      tenantId: 'client-chosen-tenant',
      machineId: 'client-chosen-machine',
    }))),
    /unsupported field/,
  );
});

test('authenticated admission derives tenant and machine and checks repository grants', async () => {
  const batch = validateSecurityFindingUploadBatch(safeBatch(
    safeFinding(),
    safeFinding({
      findingId: 'finding-002',
      deliveryId: 'delivery-002',
      repositoryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  ));
  const checked: string[] = [];
  const result = await admitSecurityFindingBatch({
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    authorization: { mode: 'monitor', validUntil: null, revokedAt: null },
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
    repositoryGrantAllows: async (repositoryId, branch) => {
      assert.equal(branch, null, 'v0.1 findings require a repository-wide grant');
      checked.push(repositoryId);
      return repositoryId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    },
  });

  assert.deepEqual(checked, [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]);
  assert.deepEqual(result.errors, [{
    index: 1,
    error: 'Machine repository grant is not active',
  }]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].tenantId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.accepted[0].machineId, '22222222-2222-4222-8222-222222222222');
  assert.equal(result.accepted[0].repositoryId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(result.accepted[0].schemaVersion, 'trackai.security-finding/0.1');
});

test('off expired and revoked monitor authorization fail closed', async () => {
  const batch = validateSecurityFindingUploadBatch(safeBatch());
  const base = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
    repositoryGrantAllows: async () => true,
  };

  await assert.rejects(
    admitSecurityFindingBatch({
      ...base,
      authorization: { mode: 'off', validUntil: null, revokedAt: null },
    }),
    /not active/,
  );
  await assert.rejects(
    admitSecurityFindingBatch({
      ...base,
      authorization: {
        mode: 'monitor',
        validUntil: new Date('2026-09-30T08:00:59Z'),
        revokedAt: null,
      },
    }),
    /not active/,
  );
  await assert.rejects(
    admitSecurityFindingBatch({
      ...base,
      authorization: {
        mode: 'monitor',
        validUntil: null,
        revokedAt: new Date('2026-09-30T08:00:00Z'),
      },
    }),
    /not active/,
  );
});
