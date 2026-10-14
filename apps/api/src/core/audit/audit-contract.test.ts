// Task16b (A16.3): the audit contract, without a database. One fixture per action,
// shaped like the row today's emitter writes (the entry's file:line); the error codes;
// reserved refusals; the raw-content key-name scan; catalog.md in sync; and parity with
// the Task16a inventory (docs/plan/AUDIT_EVENT_CATALOG.md §1).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import Ajv from 'ajv';
import {
  AUDIT_CATALOG,
  AUDIT_CATALOG_BY_ACTION,
  AUDIT_CATALOG_VERSION,
  AuditContractError,
  type AuditActorType,
  type AuditDetailShape,
  type AuditEvent,
} from './catalog';
import { CATALOG_MD_PATH, renderAuditCatalog } from './generate-catalog';
import { buildAuditRow, recordAuditEvent } from './record';

const REPO = resolve(__dirname, '../../../../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';
const ADMIN_SUB = '55555555-5555-4555-8555-555555555555';
const HEX = 'a'.repeat(64);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ISO = '2026-10-14T12:00:00.000Z';

type Fixture = Omit<AuditEvent, 'action' | 'targetType'>;
const admin = (targetId: string, details: Record<string, unknown>): Fixture =>
  ({ actorType: 'tenant_admin', actorId: ADMIN_SUB, targetId, details });
const operator = (actorId: string, targetId: string, details: Record<string, unknown>): Fixture =>
  ({ actorType: 'system_operator', actorId, targetId, details });
const role = (actorType: AuditActorType, targetId: string, details: Record<string, unknown>): Fixture =>
  ({ actorType, actorId: ADMIN_SUB, targetId, details });

const enrolled = admin(U1, {
  repositoryId: U2, effectiveFrom: ISO, generationSessionEvidenceFrom: ISO, commitNoteEvidenceFrom: ISO,
  effectiveUntil: null, reason: null,
});
const credential = admin(U1, { machineId: U2, keyId: 'mk_live_abc', rotatedFromCredentialId: null, expiresAt: null });
const membership = operator('task4-admin-bootstrap', U1, { role: 'tenant_admin', subject: ADMIN_SUB });
const retention = admin(U1, { previousPolicyId: null, version: 1, mode: 'retain', retentionDays: null, reason: 'policy' });
const consent = admin(U1, { provider: 'opencode', retentionDays: 30 });
const keyChange = operator('ops', DIGEST, {
  requestId: 'attesta-keys:1', changes: [{ keyid: DIGEST, from: 'registered', to: 'active', revocationReason: null, compromisedSince: null }],
});
const packScope = { repository_id: null, from: ISO, to: ISO };
const reportScope = { repository_id: U2, from: ISO, to: ISO };

/** Today's row for every emitted action, from the call site its entry cites. */
const FIXTURES: Record<string, Fixture> = {
  'repository.enrolled': enrolled,
  'repository.reenrolled': admin(U1, { ...enrolled.details, effectiveUntil: ISO, reason: 'again' }),
  'repository_backfill.authorized': admin(U1, {
    enrollmentId: U2, evidenceFamily: 'generation_session', occurredFrom: ISO, occurredUntil: ISO, expiresAt: ISO, reason: 'backfill',
  }),
  'repository_grant.issued': admin(U1, {
    machineId: U2, enrollmentId: U2, branchPatterns: ['main', 'release/*'], effectiveFrom: ISO, effectiveUntil: null, reason: null,
  }),
  'repository_grant.branch_scope_replaced': admin(U1, {
    previousGrantId: U2, machineId: U2, enrollmentId: U2, previousBranchPatterns: [], branchPatterns: ['main'], reason: 'scope',
  }),
  'repository_grant.revoked': admin(U1, { machineId: U2, reason: 'left' }),
  'repository_backfill.revoked': admin(U1, { enrollmentId: U2, evidenceFamily: 'commit_note', reason: 'done' }),
  'repository.revoked': admin(U1, { repositoryId: U2, reason: 'gone', grantsRevoked: 2, backfillAuthorizationsRevoked: true }),
  'github_app.installation_created': admin(U1, {
    providerHost: 'github.com', appId: '123', installationExternalId: '456', accountLogin: 'acme', credentialId: U2,
    credentialFingerprint: HEX, permissions: { contents: 'read' }, subscribedEvents: ['push'],
  }),
  'github_app.credential_rotated': admin(U1, {
    installationId: U2, rotatedFromCredentialId: U2, overlapUntil: ISO, credentialFingerprint: HEX,
  }),
  'github_app.rotation_finished': admin(U1, { retiredCredentialIds: [U2], reason: 'rotated' }),
  'github_app.installation_revoked': admin(U1, { credentialsRevoked: true, reason: 'removed' }),
  'machine.registered': admin(U1, { installationId: 'gitai-install-1', displayName: 'Dana laptop' }),
  'machine_credential.issued': credential,
  'machine_credential.rotated': admin(U1, { ...credential.details, rotatedFromCredentialId: U2, expiresAt: ISO }),
  'machine_credential.revoked': admin(U1, { machineId: U2, keyId: 'mk_live_abc', reason: 'lost' }),
  'machine.revoked': admin(U1, { reason: 'stolen', credentialsRevoked: true, repositoryGrantsRevoked: 3 }),
  'admin_membership.granted': membership,
  'admin_membership.reactivated': membership,
  'admin_membership.revoked': operator('task4-placeholder-repair', U1, {
    reason: 'Operator placeholder was submitted instead of a verified Supabase subject UUID', correctiveOverlay: true,
  }),
  'retention_policy.created': retention,
  'retention_policy.replaced': admin(U1, { ...retention.details, previousPolicyId: U2, version: 2, mode: 'archive_then_purge', retentionDays: 90 }),
  'evidence_export.completed': admin(U1, {
    archivePurpose: false, scopeFrom: ISO, scopeUntil: ISO, recordCounts: { observed_metric_evidence: 4 },
    contentSha256: HEX, bytes: 1024, reason: 'audit',
  }),
  'evidence_export.failed': admin(U1, { failureCode: 'export_execution_failed', reason: 'audit' }),
  'evidence.collection.enabled': consent,
  'evidence.collection.disabled': consent,
  // Today's site writes tenant_user here (Task16c migration item; see KNOWN_TASK16C).
  'evidence.raw.read': role('tenant_user', U1, { provider: 'opencode', eventType: 'prompt_submitted' }),
  'evidence.intention.corrected': admin(U1, { correctedFromIntentionId: U2, reason: 'wrong' }),
  'evidence.retention.purged': admin(TENANT, {
    expiredEvents: 1, expiredIntentions: 2, expiredSummaries: 0, expiredSemanticIndexes: 2,
  }),
  'evidence.semantic.reindex_enqueued': admin(TENANT, { model: 'bge-small', modelRevision: 'unconfigured-local-bge', enqueued: 5 }),
  'security_findings.read': role('tenant_auditor', TENANT, { limit: 50, returned: 7 }),
  'telemetry_normalization.reconciled': operator('task4-wave5-pending-reconciler', TENANT, {
    selected: 3, normalized: 2, failed: 1, eventKinds: { checkpoint: 2, commit: 1 },
  }),
  'fleet_configuration.created': admin(U1, {
    epoch: 2, schemaVersion: 2, clientCompatibility: { minimumVersion: '1.0.0', maximumVersion: '2.0.0' },
    desiredRelease: { version: '1.2.0', releaseTag: 'v1.2.0', manifestUrl: 'https://example.test/m.json', manifestSha256: HEX },
    channel: 'latest', ring: null, reason: 'rollout', repositoryPolicyCount: 3, securityActivation: { mode: 'monitor', version: 1 },
  }),
  'fleet_configuration.assigned': admin(U1, { epoch: 2, machineIds: [U1, U2], reason: 'rollout' }),
  'fleet_machine.offboarded': admin(U1, {
    reason: 'left', desiredConfigurationId: null, activeCredentialCount: 1, activeGrantCount: 0,
    serverRevocation: 'applied', localCleanup: 'best_effort_not_requested_by_server', mdmCleanup: 'not_requested',
  }),
  'attesta.verify': role('tenant_auditor', '0-end', { request_id: 'req-1', ok: false, checked: 10, break_count: 1, failed: true }),
  'attesta.export.request': role('tenant_auditor', U1, { request_id: 'req-2', scope: packScope, mode: 'full', replayed: false }),
  'attesta.export.download': role('tenant_admin', U1, {
    request_id: 'req-3', scope: packScope, mode: 'repository_only', pack_digest: DIGEST,
    counts: { records: 3, statements: 3, redacted_records: 0, anchored: 2, pending: 1, anchor_rows: 2, anchor_batches: 1 },
  }),
  'attesta.report.request': role('tenant_admin', U1, { request_id: 'req-4', scope: reportScope, replayed: true }),
  'attesta.report.download': role('tenant_auditor', U1, {
    request_id: 'req-5', scope: reportScope, report_digest: DIGEST, statement_digest: DIGEST,
  }),
  'attesta.keys.register': operator('ops', DIGEST, { keyid: DIGEST, status: 'registered', requestId: 'attesta-keys:1' }),
  'attesta.keys.activate': keyChange,
  'attesta.keys.retire': keyChange,
  'attesta.keys.revoke': operator('ops', DIGEST, {
    requestId: 'attesta-keys:2', changes: [{ keyid: DIGEST, from: 'active', to: 'revoked', revocationReason: 'compromised', compromisedSince: ISO }],
  }),
  'attesta.keys.publish': operator('ops', `${TENANT}:3`, { requestId: 'attesta-keys:3', version: 3, digest: DIGEST, keyids: [DIGEST] }),
  'attesta_subjects.requeued': operator('ops', TENANT, { code: 'ATTESTA_SIGNER_UNAVAILABLE', count: 4 }),
  'attesta.anchor.resume': operator('ops', `${TENANT}:0-9`, {
    request_id: 'resume-1', terminal_code: 'LOG_REJECTED', records: 10, reason: 'log fixed',
  }),
};

/**
 * Emitters whose row today's contract refuses: Task16c changes the emitter, never this
 * contract (README.md; handoff migration list). Each entry: action → the expected code.
 */
const KNOWN_TASK16C: Record<string, string> = {
  'evidence.raw.read': 'AUDIT_ACTOR_NOT_ALLOWED', // service.ts:387 hardcodes tenant_user; use req.adminRole
};

function eventFor(action: string, fixture = FIXTURES[action]): AuditEvent {
  const entry = AUDIT_CATALOG_BY_ACTION.get(action);
  assert.ok(entry, `${action} is not in the catalog`);
  return { action, targetType: entry.targetType, ...fixture, details: structuredClone(fixture.details) };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AuditContractError) return error.code;
    throw error;
  }
  return undefined;
}

const emitted = AUDIT_CATALOG.filter(entry => entry.status === 'emitted');
const reserved = AUDIT_CATALOG.filter(entry => entry.status === 'reserved');

test('audit contract: 47 emitted actions, each validates as today\'s emitter writes it', () => {
  assert.equal(emitted.length, 47);
  assert.deepEqual(Object.keys(FIXTURES).sort(), emitted.map(entry => entry.action).sort(), 'one fixture per emitted action');
  for (const entry of emitted) {
    const event = eventFor(entry.action);
    if (KNOWN_TASK16C[entry.action]) {
      assert.equal(codeOf(() => buildAuditRow(TENANT, event)), KNOWN_TASK16C[entry.action], entry.action);
      continue;
    }
    const row = buildAuditRow(TENANT, event);
    assert.equal(row.tenantId, TENANT);
    assert.equal(row.action, entry.action);
    assert.equal(row.targetType, entry.targetType);
    assert.deepEqual(row.details, event.details, `${entry.action}: details pass through unchanged`);
  }
  // The Task16c fix makes the known row valid.
  const fixed = eventFor('evidence.raw.read', { ...FIXTURES['evidence.raw.read'], actorType: 'tenant_auditor' });
  assert.equal(buildAuditRow(TENANT, fixed).actorType, 'tenant_auditor');
});

test('audit contract: entries are well formed', () => {
  const names = AUDIT_CATALOG.flatMap(entry => [entry.action, ...entry.aliases]);
  assert.equal(new Set(names).size, names.length, 'actions and aliases are unique');
  assert.equal(AUDIT_CATALOG_VERSION, 1);
  for (const entry of AUDIT_CATALOG) {
    assert.ok(entry.actorTypes.length > 0, entry.action);
    assert.ok(entry.sources.length > 0, `${entry.action} cites its source`);
    assert.deepEqual(entry.aliases, [], 'v1 has no aliases');
    if (entry.targetIdKind === 'compound') assert.ok(entry.targetIdPattern, `${entry.action}: compound needs a pattern`);
    if (entry.targetIdPattern) assert.ok(entry.targetIdNote, `${entry.action}: a non-UUID target id is documented`);
    if (entry.status === 'emitted') {
      for (const source of entry.sources) {
        const [file, line] = source.split(':');
        const text = readFileSync(resolve(REPO, 'apps/api/src', file), 'utf8').split('\n');
        assert.ok(Number(line) <= text.length, `${entry.action}: ${source} exists`);
      }
    }
  }
  // New actions follow <domain>.<object>.<past_verb>, lower case, snake_case inside a segment.
  // `artifact.signed` is the name the lead prompt reserves for T14.7 (two segments);
  // T14.7 may rename it while it is reserved (no row exists yet).
  for (const entry of reserved.filter(candidate => candidate.action !== 'artifact.signed')) {
    assert.match(entry.action, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, entry.action);
  }
});

test('audit contract: severities match the founder-approved table (2026-10-15)', () => {
  const by = (severity: string) => emitted.filter(entry => entry.severity === severity).length;
  assert.deepEqual([by('high'), by('notice'), by('info')], [27, 12, 8]);
});

test('audit contract: each error code is raised', () => {
  const base = eventFor('repository_grant.revoked');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, action: 'repository.grant.nuked' })), 'AUDIT_UNKNOWN_ACTION');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, action: 'audit.events.read' })), 'AUDIT_RESERVED_ACTION');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, actorType: 'tenant_auditor' })), 'AUDIT_ACTOR_NOT_ALLOWED');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, actorType: 'robot' as AuditActorType })), 'AUDIT_ACTOR_NOT_ALLOWED');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, actorId: ' ' })), 'AUDIT_ACTOR_NOT_ALLOWED');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, targetId: 'not-a-uuid' })), 'AUDIT_TARGET_INVALID');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, targetType: 'developer_machine' })), 'AUDIT_TARGET_INVALID');
  assert.equal(codeOf(() => buildAuditRow('tenant-a', base)), 'AUDIT_TARGET_INVALID');
  // tenant kind: the target must be this tenant; compound: the documented format.
  const purge = eventFor('evidence.retention.purged');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...purge, targetId: OTHER })), 'AUDIT_TARGET_INVALID');
  const verify = eventFor('attesta.verify');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...verify, targetId: '5-3-1' })), 'AUDIT_TARGET_INVALID');
  assert.equal(buildAuditRow(TENANT, { ...verify, targetId: '5-30' }).targetId, '5-30');
  const resume = eventFor('attesta.anchor.resume');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...resume, targetId: U1 })), 'AUDIT_TARGET_INVALID');
  const key = eventFor('attesta.keys.register');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...key, targetId: U1 })), 'AUDIT_TARGET_INVALID');

  const details = (changes: Record<string, unknown>, from = base) => codeOf(() => buildAuditRow(TENANT, {
    ...from, details: { ...from.details, ...changes },
  }));
  assert.equal(details({ extra: 1 }), 'AUDIT_DETAILS_INVALID', 'unknown key');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, details: { reason: 'x' } })), 'AUDIT_DETAILS_INVALID', 'missing required');
  assert.equal(details({ machineId: 42 }), 'AUDIT_DETAILS_INVALID', 'wrong type');
  assert.equal(details({ machineId: null }), 'AUDIT_DETAILS_INVALID', 'null where not nullable');
  assert.equal(details({ reason: 'x'.repeat(1001) }), 'AUDIT_DETAILS_INVALID', 'oversize reason');
  assert.equal(details({ reason: 'x'.repeat(1000) }), undefined, 'a 1000-character reason fits');
  assert.equal(details({ request_id: 'req-9' }), undefined, 'request_id is reserved on every action');
  assert.equal(details({ request_id: 9 }), 'AUDIT_DETAILS_INVALID', 'request_id is a string');
  const grant = eventFor('repository_grant.issued');
  assert.equal(details({ branchPatterns: Array(201).fill('main') }, grant), 'AUDIT_DETAILS_INVALID', 'oversize array');
  assert.equal(details({ branchPatterns: ['x'.repeat(513)] }, grant), 'AUDIT_DETAILS_INVALID', 'oversize item');
  assert.equal(details({ effectiveFrom: '2026-10-14' }, grant), 'AUDIT_DETAILS_INVALID', 'timestamp needs time and zone');
  const keys = eventFor('attesta.keys.revoke');
  assert.equal(details({ changes: [{ keyid: DIGEST, from: 'active', to: 'gone', revocationReason: null, compromisedSince: null }] }, keys),
    'AUDIT_DETAILS_INVALID', 'nested enum');
  assert.equal(details({ changes: [{ keyid: DIGEST, from: 'active', to: 'revoked' }] }, keys), 'AUDIT_DETAILS_INVALID', 'nested required');
  const fleet = eventFor('fleet_configuration.created');
  assert.equal(details({ securityActivation: { mode: 'monitor', version: 1, extra: true } }, fleet), 'AUDIT_DETAILS_INVALID', 'nested unknown');
  const exportDone = eventFor('evidence_export.completed');
  assert.equal(details({ recordCounts: { a: -1 } }, exportDone), 'AUDIT_DETAILS_INVALID', 'counts are non-negative');
  assert.equal(codeOf(() => buildAuditRow(TENANT, { ...base, details: [] as unknown as Record<string, unknown> })), 'AUDIT_DETAILS_INVALID');
});

test('audit contract: error messages never carry a details value', () => {
  const secret = 'do-not-echo-7f3a';
  const base = eventFor('repository_grant.revoked');
  for (const details of [{ ...base.details, reason: secret.repeat(100) }, { ...base.details, [secret]: 1 }, { ...base.details, machineId: secret }]) {
    try {
      buildAuditRow(TENANT, { ...base, details });
      assert.fail('expected a contract error');
    } catch (error) {
      assert.ok(error instanceof AuditContractError);
      // An unknown key's name is reported (key names are not content); values never are.
      if (!(secret in details)) assert.ok(!error.message.includes(secret), error.message);
    }
  }
});

test('audit contract: every reserved action refuses', () => {
  const expected = [
    'artifact.signed', 'attesta.anchor.failed', 'audit.events.read', 'fleet.lease.issued', 'fleet.lease.refused',
    'policy.bundle.acknowledged', 'policy.bundle.activated', 'policy.bundle.published', 'security.finding.triaged',
    'security.monitor.changed',
  ];
  assert.deepEqual(reserved.map(entry => entry.action).sort(), expected);
  for (const entry of reserved) {
    const event: AuditEvent = {
      action: entry.action, actorType: entry.actorTypes[0], actorId: 'svc', targetType: entry.targetType,
      targetId: TENANT, details: {},
    };
    assert.equal(codeOf(() => buildAuditRow(TENANT, event)), 'AUDIT_RESERVED_ACTION', entry.action);
  }
  assert.equal(AUDIT_CATALOG_BY_ACTION.get('audit.events.read')?.severity, 'info');
});

// Whole words inside a key name (camelCase and snake_case split), so
// credentialFingerprint passes and tokenValue fails. private_key is two words.
const FORBIDDEN_WORDS = [
  'prompt', 'response', 'content', 'payload', 'command', 'diff', 'code', 'source', 'secret',
  'token', 'password', 'pem', 'plaintext',
];
const FORBIDDEN_PAIRS = [['private', 'key']];

function wordsOf(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function suggestsRawContent(key: string): boolean {
  const words = wordsOf(key);
  return words.some(word => FORBIDDEN_WORDS.includes(word))
    || FORBIDDEN_PAIRS.some(([a, b]) => words.some((word, i) => word === a && words[i + 1] === b));
}

/**
 * Frozen v1 names (README.md "Names") that contain a listed word but carry no raw
 * content: an error-code string, a count, or a digest. Only already-emitted keys may
 * appear here; a new key with such a word fails the scan.
 */
const FROZEN_NAME_EXCEPTIONS: Record<string, string> = {
  'evidence_export.completed.contentSha256': 'a SHA-256 digest of the export, not the content',
  'evidence_export.failed.failureCode': 'one of two fixed failure codes',
  'attesta_subjects.requeued.code': 'an ATTESTA_* error code',
  'attesta.anchor.resume.terminal_code': 'a terminal anchoring error code',
};

function keysOf(shape: AuditDetailShape, prefix: string): string[] {
  return Object.entries(shape).flatMap(([name, key]) => {
    const here = `${prefix}${name}`;
    const type = key.type;
    if (typeof type === 'object' && 'object' in type) return [here, ...keysOf(type.object, `${here}.`)];
    if (typeof type === 'object' && 'arrayOf' in type) return [here, ...keysOf(type.arrayOf, `${here}.`)];
    return [here];
  });
}

test('audit contract: no details key name suggests raw content', () => {
  assert.equal(suggestsRawContent('credentialFingerprint'), false);
  assert.equal(suggestsRawContent('tokenValue'), true);
  assert.equal(suggestsRawContent('private_key_pem'), true);
  assert.equal(suggestsRawContent('privateKeyRef'), true);
  assert.equal(suggestsRawContent('keyid'), false);
  assert.equal(suggestsRawContent('decoder'), false);
  const flagged: string[] = [];
  for (const entry of AUDIT_CATALOG) {
    for (const path of keysOf(entry.details, '')) {
      const leaf = path.split('.').at(-1) ?? path;
      if (!suggestsRawContent(leaf)) continue;
      const id = `${entry.action}.${path}`;
      if (FROZEN_NAME_EXCEPTIONS[id] && entry.status === 'emitted') continue;
      flagged.push(id);
    }
  }
  assert.deepEqual(flagged, [], `details keys that suggest raw content: ${flagged.join(', ')}`);
  for (const id of Object.keys(FROZEN_NAME_EXCEPTIONS)) {
    const entry = emitted.find(candidate => id.startsWith(`${candidate.action}.`)
      && Object.prototype.hasOwnProperty.call(candidate.details, id.slice(candidate.action.length + 1)));
    assert.ok(entry, `exception ${id} matches no emitted key (remove it)`);
  }
});

test('audit contract: docs/contracts/audit/catalog.md is generated and in sync', () => {
  const onDisk = readFileSync(CATALOG_MD_PATH, 'utf8');
  assert.equal(onDisk, renderAuditCatalog(), 'run: npm run audit:catalog -w apps/api');
});

test('audit contract: every action in the Task16a inventory is in the catalog, and vice versa', () => {
  const text = readFileSync(resolve(REPO, 'docs/plan/AUDIT_EVENT_CATALOG.md'), 'utf8');
  const section = text.slice(text.indexOf('## 1.'), text.indexOf('## 2.'));
  const inventory = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1];
    for (const match of first.matchAll(/`([^`]+)`/g)) inventory.add(match[1]);
  }
  assert.equal(inventory.size, 47, 'the inventory lists 47 actions');
  assert.deepEqual([...inventory].sort(), emitted.map(entry => entry.action).sort());
});

test('audit contract: an emitted row round-trips through event-v1.schema.json', () => {
  const schema = JSON.parse(readFileSync(resolve(REPO, 'docs/contracts/audit/event-v1.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  for (const entry of emitted) {
    if (KNOWN_TASK16C[entry.action]) continue;
    const row = buildAuditRow(TENANT, eventFor(entry.action));
    const apiRow = {
      id: U2, action: row.action, actor_type: row.actorType, actor_id: row.actorId, target_type: row.targetType,
      target_id: row.targetId, details: row.details, occurred_at: ISO,
      severity: entry.severity, catalog_version: AUDIT_CATALOG_VERSION,
    };
    assert.ok(validate(apiRow), `${entry.action}: ${ajv.errorsText(validate.errors)}`);
  }
  assert.equal(validate({ id: U2 }), false, 'the schema is closed and requires every field');
});

test('audit contract: recordAuditEvent inserts once through the executor, and never on a contract error', async () => {
  const calls: SQL[] = [];
  const executor = { execute: async (query: SQL) => { calls.push(query); return { rows: [] }; } };
  await recordAuditEvent(executor, TENANT, eventFor('repository_grant.revoked'));
  assert.equal(calls.length, 1);
  await assert.rejects(
    recordAuditEvent(executor, TENANT, { ...eventFor('repository_grant.revoked'), details: {} }),
    (error: unknown) => error instanceof AuditContractError && error.code === 'AUDIT_DETAILS_INVALID',
  );
  assert.equal(calls.length, 1, 'a refused event writes nothing');
});
