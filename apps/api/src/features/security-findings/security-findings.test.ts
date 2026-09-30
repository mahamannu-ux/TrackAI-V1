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
import {
  persistSecurityFindingBatchWithStore,
  type SecurityFindingStorageTransaction,
  type SecurityFindingTransactionRunner,
} from './storage-service';
import { createSecurityFindingUploadHandler } from './security-findings.routes';
import {
  createSecurityActivationLease,
  createSecurityActivationHandler,
} from './activation';
import { adminMembershipAllows } from '../../core/security/admin-authorization';
import {
  createSecurityFindingAdminReadHandler,
  readSecurityFindingsWithStore,
} from './admin-read';

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

function storageRunner(input: {
  authorization?: { mode: 'off' | 'monitor'; validUntil: Date | null; revokedAt: Date | null } | null;
  grant?: boolean;
  existing?: SecurityFindingStorageTransaction['findExisting'];
  insert?: SecurityFindingStorageTransaction['insertIfAbsent'];
} = {}): { runner: SecurityFindingTransactionRunner; transactions: () => number } {
  let completedTransactions = 0;
  const runner: SecurityFindingTransactionRunner = async callback => {
    const transaction: SecurityFindingStorageTransaction = {
      loadAuthorization: async () => input.authorization === undefined
        ? { mode: 'monitor', validUntil: null, revokedAt: null }
        : input.authorization,
      repositoryGrantAllows: async () => input.grant ?? true,
      findExisting: input.existing ?? (async () => []),
      insertIfAbsent: input.insert ?? (async () => true),
    };
    const result = await callback(transaction);
    completedTransactions += 1;
    return result;
  };
  return { runner, transactions: () => completedTransactions };
}

test('finding storage acknowledges only after its transaction commits', async () => {
  const fixture = storageRunner();
  const batch = validateSecurityFindingUploadBatch(safeBatch());
  const result = await persistSecurityFindingBatchWithStore({
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
  }, fixture.runner);

  assert.deepEqual(result.acknowledged, [{
    index: 0,
    findingId: 'finding-001',
    deliveryId: 'delivery-001',
    outcome: 'stored',
  }]);
  assert.deepEqual(result.errors, []);
  assert.equal(fixture.transactions(), 1);
});

test('finding storage acknowledges exact replay but rejects changed reuse', async () => {
  const batch = validateSecurityFindingUploadBatch(safeBatch());
  const canonical = {
    ...batch.findings[0],
    schemaVersion: 'trackai.security-finding/0.1' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
  };
  const exact = storageRunner({
    existing: async () => [{ ...canonical, occurredAt: '2026-09-30T08:00:00.000Z' }],
    insert: async () => false,
  });
  const exactResult = await persistSecurityFindingBatchWithStore({
    tenantId: canonical.tenantId,
    machineId: canonical.machineId,
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
  }, exact.runner);
  assert.equal(exactResult.acknowledged[0].outcome, 'replayed');

  const changed = storageRunner({
    existing: async () => [{ ...canonical, resultCategory: 'success' }],
  });
  const changedResult = await persistSecurityFindingBatchWithStore({
    tenantId: canonical.tenantId,
    machineId: canonical.machineId,
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
  }, changed.runner);
  assert.deepEqual(changedResult.acknowledged, []);
  assert.deepEqual(changedResult.errors, [{ index: 0, error: 'identity_collision' }]);
});

test('finding storage fails closed when monitoring or repository permission is inactive', async () => {
  const batch = validateSecurityFindingUploadBatch(safeBatch());
  const base = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    batch,
    receivedAt: new Date('2026-09-30T08:01:00Z'),
  };
  const off = storageRunner({ authorization: null });
  const denied = storageRunner({ grant: false });

  assert.deepEqual((await persistSecurityFindingBatchWithStore(base, off.runner)).errors, [
    { index: 0, error: 'monitor_inactive' },
  ]);
  assert.deepEqual((await persistSecurityFindingBatchWithStore(base, denied.runner)).errors, [
    { index: 0, error: 'repository_grant_inactive' },
  ]);
});

function routeResponse() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown;
  return {
    response: {
      setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); },
      status: (value: number) => {
        statusCode = value;
        return { json: (payload: unknown) => { body = payload; } };
      },
      json: (payload: unknown) => { body = payload; },
    },
    result: () => ({ headers, statusCode, body }),
  };
}

test('finding upload route requires managed authentication and returns safe partial errors', async () => {
  let persisted = 0;
  const handler = createSecurityFindingUploadHandler({
    persist: async input => {
      persisted += 1;
      assert.equal(input.tenantId, '11111111-1111-4111-8111-111111111111');
      assert.equal(input.machineId, '22222222-2222-4222-8222-222222222222');
      return {
        acknowledged: [{
          index: 0, findingId: 'finding-001', deliveryId: 'delivery-001', outcome: 'stored',
        }],
        errors: [{ index: 1, error: 'repository_grant_inactive' }],
      };
    },
    logError: () => assert.fail('successful request must not log'),
  });
  const denied = routeResponse();
  await handler({
    body: safeBatch(),
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: 'client-header-is-not-authoritative',
    managedMachineCredential: false,
  }, denied.response);
  assert.equal(denied.result().statusCode, 403);
  assert.equal(persisted, 0);

  const accepted = routeResponse();
  await handler({
    body: safeBatch(safeFinding(), safeFinding({
      findingId: 'finding-002', deliveryId: 'delivery-002',
    })),
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    managedMachineCredential: true,
  }, accepted.response);
  assert.equal(accepted.result().statusCode, 200);
  assert.equal(accepted.result().headers.get('cache-control'), 'no-store');
  assert.deepEqual(accepted.result().body, {
    errors: [{ index: 1, error: 'repository_not_authorized' }],
  });
  assert.equal(persisted, 1);
});

test('finding upload route never echoes or logs rejected raw content', async () => {
  const secret = 'customer-secret-command-value';
  const logs: string[] = [];
  const handler = createSecurityFindingUploadHandler({
    persist: async () => assert.fail('invalid content must not reach storage'),
    logError: message => logs.push(message),
  });
  const rejected = routeResponse();
  await handler({
    body: safeBatch(safeFinding({ commandText: secret })),
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    managedMachineCredential: true,
  }, rejected.response);

  const captured = JSON.stringify(rejected.result().body) + logs.join('');
  assert.equal(rejected.result().statusCode, 400);
  assert.equal(captured.includes(secret), false);
  assert.deepEqual(logs, []);
});

test('Task6 upload router is mounted behind existing machine authentication', () => {
  const indexSource = readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  assert.match(
    indexSource,
    /app\.use\('\/worker\/security', authenticateMachine, securityFindingsRouter\)/,
  );
});

test('Task6 live route verifier is restricted to its disposable database', () => {
  const verifier = readFileSync(
    path.resolve(process.cwd(), 'src/features/security-findings/task6-route-live-verify.ts'),
    'utf8',
  );
  const packageJson = JSON.parse(readFileSync(
    path.resolve(process.cwd(), 'package.json'),
    'utf8',
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['verify:task6-route-live'],
    'tsx src/features/security-findings/task6-route-live-verify.ts',
  );
  assert.match(verifier, /TASK6_EPHEMERAL_DATABASE/);
  assert.match(verifier, /trackai_task6_security_live/);
  assert.match(verifier, /exact_replay=acknowledged/);
  assert.match(verifier, /changed_replay=blocked/);
  assert.match(verifier, /cross_tenant_repository=blocked/);
  assert.match(verifier, /reverse_cross_tenant_repository=blocked/);
  assert.match(verifier, /monitor_off=blocked/);
  assert.match(verifier, /revoked_credential=blocked/);
  assert.match(verifier, /raw_content_capture=absent/);
});

test('security activation lease is short-lived and fail-closed', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  assert.deepEqual(createSecurityActivationLease(null, now), {
    schemaVersion: 'trackai.security-activation/0.1',
    mode: 'off',
    version: 0,
    issuedAt: '2026-09-30T10:00:00.000Z',
    refreshAfter: '2026-09-30T10:01:00.000Z',
    expiresAt: '2026-09-30T10:05:00.000Z',
  });
  const monitor = createSecurityActivationLease({
    mode: 'monitor',
    version: 3,
    validUntil: new Date('2026-09-30T10:03:00Z'),
    revokedAt: null,
  }, now);
  assert.equal(monitor.mode, 'monitor');
  assert.equal(monitor.expiresAt, '2026-09-30T10:03:00.000Z');
  for (const setting of [
    { mode: 'off' as const, version: 4, validUntil: null, revokedAt: null },
    { mode: 'monitor' as const, version: 5, validUntil: now, revokedAt: null },
    { mode: 'monitor' as const, version: 6, validUntil: null, revokedAt: now },
  ]) {
    assert.equal(createSecurityActivationLease(setting, now).mode, 'off');
  }
});

test('security activation endpoint requires managed authentication and is not cacheable', async () => {
  const handler = createSecurityActivationHandler({
    load: async (tenantId, machineId, now) => {
      assert.equal(tenantId, '11111111-1111-4111-8111-111111111111');
      assert.equal(machineId, '22222222-2222-4222-8222-222222222222');
      return createSecurityActivationLease({
        mode: 'monitor', version: 2, validUntil: null, revokedAt: null,
      }, now);
    },
    logError: () => assert.fail('successful activation fetch must not log'),
  });
  const denied = routeResponse();
  await handler({ managedMachineCredential: false }, denied.response);
  assert.equal(denied.result().statusCode, 403);

  const accepted = routeResponse();
  await handler({
    tenantId: '11111111-1111-4111-8111-111111111111',
    machineId: '22222222-2222-4222-8222-222222222222',
    managedMachineCredential: true,
  }, accepted.response);
  assert.equal(accepted.result().statusCode, 200);
  assert.equal(accepted.result().headers.get('cache-control'), 'no-store');
  assert.equal((accepted.result().body as { mode: string }).mode, 'monitor');
});

test('task6_read authorization allows active administrators and auditors only', () => {
  const admin = {
    tenantId: 'tenant-a', subject: 'admin-a', role: 'tenant_admin' as const,
    status: 'active' as const, revokedAt: null,
  };
  const auditor = { ...admin, subject: 'auditor-a', role: 'tenant_auditor' as const };
  assert.equal(adminMembershipAllows(admin, {
    tenantId: 'tenant-a', subject: 'admin-a', action: 'security_findings.read',
  }), true);
  assert.equal(adminMembershipAllows(auditor, {
    tenantId: 'tenant-a', subject: 'auditor-a', action: 'security_findings.read',
  }), true);
  assert.equal(adminMembershipAllows(auditor, {
    tenantId: 'tenant-b', subject: 'auditor-a', action: 'security_findings.read',
  }), false);
  assert.equal(adminMembershipAllows({ ...auditor, status: 'revoked', revokedAt: new Date() }, {
    tenantId: 'tenant-a', subject: 'auditor-a', action: 'security_findings.read',
  }), false);
  assert.equal(adminMembershipAllows(null, {
    tenantId: 'tenant-a', subject: 'ordinary-user', action: 'security_findings.read',
  }), false);
});

test('task6_read service binds the tenant and records an audited read', async () => {
  const calls: unknown[] = [];
  const findings = await readSecurityFindingsWithStore({
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorId: 'auditor-subject',
    actorRole: 'tenant_auditor',
    limit: 999,
  }, {
    readAndAudit: async input => {
      calls.push(input);
      return [{
        id: 'finding-row-1',
        repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        machineId: '22222222-2222-4222-8222-222222222222',
        findingId: 'finding-001',
        ruleId: 'trackai.exec.download_pipe_shell',
        ruleVersion: '1.4',
        ruleSeverity: 'high',
        effect: 'monitor',
        phase: 'requested',
        occurredAt: new Date('2026-09-30T08:00:00Z'),
        receivedAt: new Date('2026-09-30T08:00:01Z'),
        commandText: 'must-not-leave-the-service',
      }];
    },
  });

  assert.deepEqual(calls, [{
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorId: 'auditor-subject',
    actorRole: 'tenant_auditor',
    limit: 200,
  }]);
  assert.equal(JSON.stringify(findings).includes('must-not-leave-the-service'), false);
  assert.deepEqual(findings, [{
    id: 'finding-row-1',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    machineId: '22222222-2222-4222-8222-222222222222',
    findingId: 'finding-001',
    ruleId: 'trackai.exec.download_pipe_shell',
    ruleVersion: '1.4',
    ruleSeverity: 'high',
    effect: 'monitor',
    phase: 'requested',
    occurredAt: new Date('2026-09-30T08:00:00Z'),
    receivedAt: new Date('2026-09-30T08:00:01Z'),
  }]);
});

test('task6_read route is no-store and does not expose raw fields', async () => {
  const secret = 'customer-command-must-not-cross';
  const inputs: unknown[] = [];
  const handler = createSecurityFindingAdminReadHandler({
    read: async input => {
      inputs.push(input);
      return [{
        id: 'finding-row-1',
        repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        machineId: '22222222-2222-4222-8222-222222222222',
        findingId: 'finding-001',
        ruleId: 'trackai.exec.download_pipe_shell',
        ruleVersion: '1.4',
        ruleSeverity: 'high',
        effect: 'monitor',
        phase: 'requested',
        occurredAt: new Date('2026-09-30T08:00:00Z'),
        receivedAt: new Date('2026-09-30T08:00:01Z'),
        commandText: secret,
      }];
    },
    logError: () => assert.fail('successful read must not log'),
  });
  const accepted = routeResponse();
  await handler({
    tenantId: '11111111-1111-4111-8111-111111111111',
    user: { sub: 'auditor-subject' },
    adminRole: 'tenant_auditor',
    query: { limit: '50' },
  }, accepted.response);

  assert.equal(accepted.result().statusCode, 200);
  assert.equal(accepted.result().headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(accepted.result().body).includes(secret), false);
  assert.deepEqual(inputs, [{
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorId: 'auditor-subject',
    actorRole: 'tenant_auditor',
    limit: 50,
  }]);

  const denied = routeResponse();
  await handler({
    tenantId: '11111111-1111-4111-8111-111111111111',
    user: { sub: 'ordinary-user' },
    query: {},
  }, denied.response);
  assert.equal(denied.result().statusCode, 403);
  assert.equal(inputs.length, 1);
});

test('task6_read route is mounted behind the administrator authorization boundary', () => {
  const routeSource = readFileSync(
    path.resolve(process.cwd(), 'src/features/admin/admin.routes.ts'),
    'utf8',
  );
  assert.match(routeSource, /router\.get\('\/security-findings', requireSecurityFindingRead/);
});

test('task6_ui presents findings as monitor-only metadata to authorized roles', () => {
  const apiSource = readFileSync(
    path.resolve(process.cwd(), '../web/src/lib/api.ts'),
    'utf8',
  );
  const dashboardSource = readFileSync(
    path.resolve(process.cwd(), '../web/src/app/dashboard/page.tsx'),
    'utf8',
  );
  assert.match(apiSource, /export type AdminSecurityFindingResources/);
  assert.match(apiSource, /getAdminSecurityFindings/);
  assert.match(dashboardSource, /Security findings/);
  assert.match(dashboardSource, /Monitor only/);
  assert.match(dashboardSource, /TrackAI did not block this action/);
  assert.match(dashboardSource, /loadSecurityFindings/);
  assert.match(dashboardSource, /Refresh findings/);
  assert.doesNotMatch(
    dashboardSource,
    /getAdminEvidenceExports\(\),\s*getAdminSecurityFindings\(\)/,
  );
  assert.doesNotMatch(dashboardSource, /finding\.commandText|finding\.prompt|finding\.payload/);
});

test('task6_acceptance fixture is synthetic guarded and covers all three roles', () => {
  const seedSource = readFileSync(
    path.resolve(process.cwd(), 'src/features/security-findings/task6-acceptance-seed.ts'),
    'utf8',
  );
  const authSource = readFileSync(
    path.resolve(process.cwd(), 'src/features/evidence/task5-acceptance-auth.ts'),
    'utf8',
  );
  const packageJson = JSON.parse(readFileSync(
    path.resolve(process.cwd(), 'package.json'),
    'utf8',
  )) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['seed:task6-acceptance'],
    'tsx src/features/security-findings/task6-acceptance-seed.ts',
  );
  assert.match(seedSource, /TASK6_EPHEMERAL_DATABASE !== '1'/);
  assert.match(seedSource, /task6-acceptance-auditor/);
  assert.match(seedSource, /trackai\.exec\.download_pipe_shell/);
  assert.doesNotMatch(seedSource, /commandText|promptText|rawPayload|customer-secret/);
  assert.match(authSource, /auditor@task5\.acceptance\.invalid/);
  assert.match(authSource, /developer@task5\.acceptance\.invalid/);
  assert.match(authSource, /admin@task5\.acceptance\.invalid/);
});
