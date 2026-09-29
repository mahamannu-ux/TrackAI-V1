import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  securityFindings,
  tenantSecurityMonitorSettings,
} from '../../core/db/schema';
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

test('security storage schema is tenant-bound and contains metadata only', () => {
  const settings = getTableConfig(tenantSecurityMonitorSettings);
  const findings = getTableConfig(securityFindings);
  const settingColumns = new Set(settings.columns.map(column => column.name));
  const findingColumns = new Set(findings.columns.map(column => column.name));

  assert.deepEqual([...settingColumns].sort(), [
    'created_at', 'id', 'mode', 'revoked_at', 'tenant_id', 'updated_at',
    'updated_by', 'valid_until', 'version',
  ].sort());
  assert.deepEqual([...findingColumns].sort(), [
    'activation', 'agent_family', 'availability', 'capture_channel', 'client_version',
    'completeness', 'correlation_id', 'delivery_id', 'effect', 'finding_id', 'host_mode',
    'host_surface', 'id', 'machine_id', 'native_effect', 'occurred_at', 'operating_system',
    'phase', 'received_at', 'repository_id', 'result_category', 'route_id', 'rule_category',
    'rule_id', 'rule_pack_version', 'rule_severity', 'rule_version', 'session_id',
    'source_event_id', 'tenant_id', 'timing',
  ].sort());
  for (const column of findingColumns) {
    assert.equal(
      /command|prompt|response|reasoning|path|url|argument|output|payload|content|secret|credential/.test(column),
      false,
      `${column} must not store raw or secret-bearing content`,
    );
  }
  assert.equal(settings.uniqueConstraints.length, 1);
  assert.equal(settings.checks.length >= 2, true);
  assert.equal(findings.uniqueConstraints.length, 2);
  assert.equal(findings.foreignKeys.length >= 3, true);
  assert.equal(findings.checks.length >= 8, true);
});

test('security storage migration enables RLS without direct browser policies', () => {
  const migration = readFileSync(
    path.resolve(process.cwd(), 'drizzle/0013_task6_security_storage.sql'),
    'utf8',
  );
  assert.match(migration, /ALTER TABLE "tenant_security_monitor_settings" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE "security_findings" ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.doesNotMatch(
    migration,
    /"(?:command|prompt|response|reasoning|path|url|argument|output|payload|content|secret|credential)[^"]*"/i,
  );
  assert.match(migration, /security_findings_tenant_machine_fk/);
  assert.match(migration, /security_findings_tenant_repository_fk/);
  assert.match(migration, /CREATE TRIGGER security_findings_immutable/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "security_findings"/);
});

test('security storage migration dry-run is bounded and always rolls back', () => {
  const dryRun = readFileSync(
    path.resolve(process.cwd(), 'src/features/security-findings/task6-storage-migration-dry-run.ts'),
    'utf8',
  );
  const packageJson = JSON.parse(readFileSync(
    path.resolve(process.cwd(), 'package.json'),
    'utf8',
  )) as { scripts: Record<string, string> };

  assert.equal(
    packageJson.scripts['verify:task6-storage-migration-dry-run'],
    'tsx src/features/security-findings/task6-storage-migration-dry-run.ts',
  );
  assert.match(dryRun, /Task6 storage tables already exist/);
  assert.match(dryRun, /SET LOCAL lock_timeout/);
  assert.match(dryRun, /SET LOCAL statement_timeout/);
  assert.match(dryRun, /cross_tenant_machine=blocked/);
  assert.match(dryRun, /cross_tenant_repository=blocked/);
  assert.match(dryRun, /duplicate_delivery=blocked/);
  assert.match(dryRun, /changed_duplicate_delivery=blocked/);
  assert.match(dryRun, /finding_update=blocked/);
  assert.match(dryRun, /finding_delete=blocked/);
  assert.match(dryRun, /migration_dry_run=rolled-back/);
  assert.doesNotMatch(dryRun, /commandText|promptText|responseText|rawPayload/);
});
