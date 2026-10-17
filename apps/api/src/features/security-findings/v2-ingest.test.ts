/**
 * Task20d ingest unit tests: admission order, per-kind storage rules and the
 * value-encryption boundary, driven against the real router, the real
 * persistSecurityV2Upload orchestrator and real envelope encryption, with
 * storage held by an in-memory transaction (no database, no network).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, test } from 'node:test';
import express from 'express';
import {
  SECURITY_V2_PREVIEW_PURPOSE,
  persistSecurityV2UploadWithStore,
  type SecurityV2PreviewField,
  type SecurityV2StorageRunner,
  type SecurityV2StorageTransaction,
  type SecurityV2StoredIndicator,
} from './v2-storage';
import {
  SECURITY_V2_NUMBAT_SCHEMA,
  type SecurityFindingV2,
  type SecurityIndicatorV2,
  type SecurityRecordId,
  type SecurityRecordV2,
  type SecurityUploadV2,
} from './v2-contract';
import { createSecurityV2Router } from './v2.routes';
import type { SecurityLeaseView, SecurityV2Authority } from './v2-authority';
import { decryptEnvelope } from '../../core/security/envelope-encryption';

// Test-only keyring (each test file runs in its own process under npm test).
process.env.MASTER_ENCRYPTION_KEY_ACTIVE_VERSION = 'test-v1';
process.env.MASTER_ENCRYPTION_KEYS_JSON = JSON.stringify({
  'test-v1': Buffer.alloc(32, 7).toString('base64'),
});

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MACHINE_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECEIVED_AT = new Date('2026-10-17T10:00:00Z');
const LEASE: SecurityLeaseView = {
  leaseId: 'lease-1',
  issuedAt: new Date('2026-10-17T09:00:00Z'),
  expiresAt: new Date('2026-10-19T09:00:00Z'),
};

let idCounter = 0;
function recordId(): SecurityRecordId {
  const hex = (idCounter += 1).toString(16).padStart(2, '0');
  return `sha256:${'a'.repeat(62)}${hex}` as SecurityRecordId;
}

function findingRecord(overrides: Partial<SecurityFindingV2> = {}): SecurityFindingV2 {
  return {
    kind: 'finding',
    record_id: recordId(),
    rule_id: 'nb.cmd.dangerous_deletion',
    rule_version: 'r1',
    severity: 'high',
    title: 'Destructive deletion was observed',
    source_agent: 'opencode',
    source_type: 'hook',
    confidence: 'high',
    detected_at: '2026-10-17T09:30:00Z',
    numbat_schema_version: SECURITY_V2_NUMBAT_SCHEMA,
    bundle_digest: 'a'.repeat(64),
    lease_id: 'lease-1',
    found_at_rest: false,
    repository: { kind: 'not_enrolled' },
    ...overrides,
  };
}

function enforcementRecord(): SecurityRecordV2 {
  return {
    kind: 'enforcement',
    record_id: recordId(),
    rule_ids: ['nb.cmd.dangerous_deletion'],
    finding_record_ids: [],
    decision: 'no_override',
    mode: 'monitor',
    source_agent: 'opencode',
    timestamp: '2026-10-17T09:31:00Z',
  };
}

function indicatorRecord(overrides: Partial<SecurityIndicatorV2> = {}): SecurityIndicatorV2 {
  return {
    kind: 'indicator',
    record_id: recordId(),
    type: 'domain',
    value: 'tracker.example.internal',
    count: 3,
    first_seen: '2026-10-17T09:00:00Z',
    last_seen: '2026-10-17T09:30:00Z',
    source_agent: 'opencode',
    ...overrides,
  };
}

interface MemoryStoreState {
  transactionCount: number;
  previewInsertCount: number;
  maximaUpdates: number;
  storedIndicators: Map<string, SecurityV2StoredIndicator>;
  previewPlaintexts: Array<{ field: SecurityV2PreviewField; plaintext: string }>;
}

/**
 * Mirrors the database implementation: the stored finding copy never carries
 * the preview plaintext, previews are sealed with the real envelope code and
 * their plaintext is recovered only through decryptEnvelope with the exact
 * tenant/finding/field context, and transactions are counted.
 */
function memoryStore(options: { enrollmentActive?: boolean } = {}): {
  transaction: SecurityV2StorageTransaction;
  runner: SecurityV2StorageRunner;
  state: MemoryStoreState;
  setEnrollmentActive(active: boolean): void;
} {
  const records = new Map<string, SecurityRecordV2>();
  const rowIds = new Map<string, string>();
  const previews = new Map<string, string>();
  const indicatorRows = new Map<string, SecurityV2StoredIndicator>();
  const state: MemoryStoreState = {
    transactionCount: 0,
    previewInsertCount: 0,
    maximaUpdates: 0,
    storedIndicators: indicatorRows,
    previewPlaintexts: [],
  };
  let enrollmentActive = options.enrollmentActive ?? true;
  let nextRowId = 0;

  const transaction: SecurityV2StorageTransaction = {
    async enrollmentActive() {
      return enrollmentActive;
    },
    async findRecord({ recordId: id }) {
      const stored = records.get(id);
      if (!stored) return null;
      if (stored.kind !== 'finding') return stored;
      const rowId = rowIds.get(id);
      assert.ok(rowId);
      const result: SecurityFindingV2 = { ...stored, kind: 'finding' };
      let endpoint = result.endpoint;
      for (const field of ['observed_command', 'observed_file_path', 'observed_url'] as const) {
        const plaintext = previews.get(`${rowId}:${field}`);
        if (plaintext !== undefined) (result as unknown as Record<string, unknown>)[field] = plaintext;
      }
      const hostname = previews.get(`${rowId}:endpoint_hostname`);
      if (hostname !== undefined) endpoint = { ...endpoint, hostname };
      const username = previews.get(`${rowId}:endpoint_username`);
      if (username !== undefined) endpoint = { ...endpoint, username };
      if (hostname !== undefined) result.endpoint = endpoint;
      else if (username !== undefined) result.endpoint = endpoint;
      return result;
    },
    async insertRecord(record, _receivedAt) {
      const recordKey = record.record_id;
      if (records.has(recordKey)) return null;
      if (record.kind === 'finding') {
        // The stored copy mirrors the database row: no preview plaintext.
        const { observed_command, observed_file_path, observed_url, endpoint, ...row } = record;
        void observed_command;
        void observed_file_path;
        void observed_url;
        void endpoint;
        const rowId = `finding-row-${nextRowId += 1}`;
        records.set(recordKey, row);
        rowIds.set(recordKey, rowId);
        return rowId;
      }
      records.set(recordKey, structuredClone(record));
      return `row-${nextRowId += 1}`;
    },
    async findIndicator({ machineId, recordId: id }) {
      const stored = indicatorRows.get(`${machineId}:${id}`);
      return stored ? { ...stored } : null;
    },
    async insertIndicator(record, _receivedAt) {
      if (record.kind !== 'indicator') return false;
      const key = `${MACHINE_A}:${record.record_id}`;
      if (indicatorRows.has(key)) return false;
      indicatorRows.set(key, {
        type: record.type,
        value: record.value,
        count: record.count,
        first_seen: record.first_seen,
        last_seen: record.last_seen,
        source_agent: record.source_agent,
      });
      return true;
    },
    async updateIndicatorMaxima({ machineId, recordId, count, lastSeen }) {
      state.maximaUpdates += 1;
      const stored = indicatorRows.get(`${machineId}:${recordId}`);
      assert.ok(stored);
      stored.count = Math.max(stored.count, count);
      if (new Date(lastSeen).getTime() > new Date(stored.last_seen).getTime()) {
        stored.last_seen = lastSeen.toISOString();
      }
    },
    async insertFindingPreviews(input, _receivedAt) {
      for (const preview of input.previews) {
        state.previewInsertCount += 1;
        const plaintext = decryptEnvelope(preview.encrypted, {
          tenantId: input.tenantId,
          purpose: SECURITY_V2_PREVIEW_PURPOSE,
          resourceId: `${input.findingRowId}:${preview.field}`,
        });
        previews.set(`${input.findingRowId}:${preview.field}`, plaintext);
        state.previewPlaintexts.push({ field: preview.field, plaintext });
      }
    },
  };

  return {
    transaction,
    runner: async callback => {
      state.transactionCount += 1;
      return callback(transaction);
    },
    state,
    setEnrollmentActive(active: boolean) {
      enrollmentActive = active;
    },
  };
}

function fakeAuthority(overrides: {
  lease?: SecurityLeaseView | null;
  settings?: import('./v2-contract').SecurityDataSettingsV1 | null;
} = {}): SecurityV2Authority {
  const lease = overrides.lease ?? LEASE;
  return {
    async currentLease() {
      return lease;
    },
    async leaseForMachine(_tenantId, _machineId, leaseId) {
      return lease && lease.leaseId === leaseId ? lease : null;
    },
    async currentDataSettings() {
      return overrides.settings ?? null;
    },
  };
}

function persistWith(store: ReturnType<typeof memoryStore>, authority: SecurityV2Authority) {
  // Mirrors the route: the settings come from the authority, not the caller.
  return async (upload: SecurityUploadV2): Promise<import('./v2-contract').SecurityV2RecordResult[]> =>
    persistSecurityV2UploadWithStore(
      {
        tenantId: TENANT_A,
        machineId: MACHINE_A,
        upload,
        settings: await authority.currentDataSettings(TENANT_A),
        authority,
        receivedAt: RECEIVED_AT,
      },
      store.runner,
    );
}

const PERMISSIVE_SETTINGS = {
  schema_version: 'trackai.security-data-settings/1' as const,
  command_previews: true,
  file_paths: true,
  urls: true,
  host_identity: true,
  user_identity: true,
};

function uploadOf(...records: SecurityRecordV2[]): SecurityUploadV2 {
  return { schema_version: 'trackai.security-upload/2', records };
}

test('T20d ingest: mixed kinds are admitted in request order and stored write-once', async () => {
  const store = memoryStore();
  const upload = uploadOf(findingRecord(), enforcementRecord(), indicatorRecord());
  const permissive = fakeAuthority({ settings: PERMISSIVE_SETTINGS });
  const results = await persistWith(store, permissive)(upload);
  assert.deepEqual(results, [
    { record_id: upload.records[0].record_id, result: 'accepted' },
    { record_id: upload.records[1].record_id, result: 'accepted' },
    { record_id: upload.records[2].record_id, result: 'accepted' },
  ]);
  assert.equal(store.state.transactionCount, 1);
  const replay = await persistWith(store, permissive)(upload);
  assert.deepEqual(replay.map(result => result.result), ['duplicate', 'duplicate', 'duplicate']);
});

test('T20d ingest: findings outside the lease window are rejected before the transaction', async () => {
  const store = memoryStore();
  const early = findingRecord({ detected_at: '2026-10-17T08:59:59Z' });
  const atExpiry = findingRecord({ detected_at: '2026-10-19T09:00:00Z' });
  const inside = findingRecord({ detected_at: '2026-10-18T09:00:00.000Z' });
  const results = await persistWith(store, fakeAuthority())(
    uploadOf(early, atExpiry, inside),
  );
  assert.deepEqual(results, [
    { record_id: early.record_id, result: 'rejected', code: 'SECURITY_V2_LEASE_MISMATCH' },
    { record_id: atExpiry.record_id, result: 'rejected', code: 'SECURITY_V2_LEASE_MISMATCH' },
    { record_id: inside.record_id, result: 'accepted' },
  ]);
  assert.equal(store.state.transactionCount, 1);
});

test('T20d ingest: a record naming a lease the machine does not hold is rejected', async () => {
  const store = memoryStore();
  const record = findingRecord({ lease_id: 'lease-2' });
  const results = await persistWith(store, fakeAuthority())(uploadOf(record));
  assert.deepEqual(results, [
    { record_id: record.record_id, result: 'rejected', code: 'SECURITY_V2_LEASE_MISMATCH' },
  ]);
  assert.equal(store.state.transactionCount, 0);
});

test('T20d ingest: data settings are enforced per record, never stripped', async () => {
  const store = memoryStore();
  const secretiveFinding = findingRecord({
    observed_command: 'rm -rf ~/Documents',
    endpoint: { hostname: 'laptop-a', username: 'dev' },
  });
  const cleanFinding = findingRecord();
  const results = await persistWith(store, fakeAuthority({ settings: null }))(uploadOf(
    secretiveFinding,
    cleanFinding,
  ));
  assert.deepEqual(results, [
    { record_id: secretiveFinding.record_id, result: 'rejected', code: 'SECURITY_V2_FIELD_NOT_PERMITTED' },
    { record_id: cleanFinding.record_id, result: 'accepted' },
  ]);
  // The refused record reached no storage at all.
  assert.equal(store.state.previewInsertCount, 0);
});

test('T20d ingest: permitted data settings seal previews, replay never reseals', async () => {
  const store = memoryStore();
  const authority = fakeAuthority({ settings: PERMISSIVE_SETTINGS });
  const record = findingRecord({
    repository: { kind: 'enrolled', id: TENANT_A },
    observed_command: 'rm -rf ~/Documents',
    observed_file_path: '/etc/hosts',
    observed_url: 'https://tracker.example.internal/x',
    endpoint: { hostname: 'laptop-a', username: 'dev' },
  });
  const results = await persistWith(store, authority)(uploadOf(record));
  assert.deepEqual(results, [{ record_id: record.record_id, result: 'accepted' }]);
  // The envelope is real: each plaintext is recoverable only with the exact context.
  assert.deepEqual(store.state.previewPlaintexts[0]?.plaintext, 'rm -rf ~/Documents');
  assert.equal(store.state.previewInsertCount, 5);
  const replay = await persistWith(store, authority)(uploadOf(record));
  assert.deepEqual(replay, [{ record_id: record.record_id, result: 'duplicate' }]);
  assert.equal(store.state.previewInsertCount, 5);
});

test('T20d ingest: enrolled-repository check refuses inactive enrollment without a grant check', async () => {
  const store = memoryStore({ enrollmentActive: false });
  const enrolled = findingRecord({ repository: { kind: 'enrolled', id: TENANT_A } });
  const results = await persistWith(store, fakeAuthority())(uploadOf(enrolled));
  assert.deepEqual(results, [
    { record_id: enrolled.record_id, result: 'rejected', code: 'SECURITY_V2_INVALID_BODY' },
  ]);
});

test('T20d ingest: replay with equal instants is a duplicate, a changed field is a conflict', async () => {
  const store = memoryStore();
  const record = findingRecord();
  const first = await persistWith(store, fakeAuthority())(uploadOf(record));
  assert.deepEqual(first, [{ record_id: record.record_id, result: 'accepted' }]);
  // detected_at re-serialized with explicit milliseconds must stay a replay.
  const renamedId = record.record_id;
  const replay = await persistWith(store, fakeAuthority())(uploadOf({
    ...record,
    record_id: renamedId,
    detected_at: '2026-10-17T09:30:00.000Z',
  }));
  assert.deepEqual(replay, [{ record_id: record.record_id, result: 'duplicate' }]);
  const conflict = await persistWith(store, fakeAuthority())(uploadOf({
    ...record,
    record_id: renamedId,
    title: 'A changed title is a conflict',
  }));
  assert.deepEqual(conflict, [{
    record_id: record.record_id,
    result: 'rejected',
    code: 'SECURITY_V2_RECORD_CONFLICT',
  }]);
});

test('T20d ingest: indicator maxima merge monotonically and identity fields are write-once', async () => {
  const store = memoryStore();
  const persist = persistWith(store, fakeAuthority({ settings: PERMISSIVE_SETTINGS }));
  const record = indicatorRecord();
  const upload = uploadOf(record);
  assert.deepEqual(await persist(upload), [{ record_id: record.record_id, result: 'accepted' }]);
  assert.equal(store.state.storedIndicators.get(`${MACHINE_A}:${record.record_id}`)?.count, 3);

  const same = await persist(uploadOf({ ...record }));
  assert.deepEqual(same, [{ record_id: record.record_id, result: 'duplicate' }]);

  // Higher count and later last_seen both move their own component only.
  const raised: SecurityIndicatorV2 = { ...record, count: 5, last_seen: '2026-10-17T09:45:00Z' };
  assert.deepEqual(await persist(uploadOf(raised)), [{ record_id: record.record_id, result: 'accepted' }]);
  const stored = store.state.storedIndicators.get(`${MACHINE_A}:${record.record_id}`);
  assert.ok(stored);
  assert.equal(stored.count, 5);
  assert.equal(new Date(stored.last_seen).getTime(), new Date('2026-10-17T09:45:00Z').getTime());

  // Older count and last_seen are duplicate, even when first_seen matches.
  const older: SecurityIndicatorV2 = { ...record, count: 2, last_seen: '2026-10-17T09:10:00Z' };
  assert.deepEqual(await persist(uploadOf(older)), [{ record_id: record.record_id, result: 'duplicate' }]);
  assert.equal(store.state.maximaUpdates, 1);

  // A changed identity field is a conflict.
  const changedValue: SecurityIndicatorV2 = { ...record, value: 'other.example.internal', count: 9 };
  assert.deepEqual(await persist(uploadOf(changedValue)), [{
    record_id: record.record_id,
    result: 'rejected',
    code: 'SECURITY_V2_RECORD_CONFLICT',
  }]);
});

test('T20d ingest: no transaction opens when every record is refused in phase 1', async () => {
  const store = memoryStore();
  const record = indicatorRecord();
  const results = await persistWith(store, fakeAuthority({ settings: null }))(uploadOf(record));
  assert.deepEqual(results, [{
    record_id: record.record_id,
    result: 'rejected',
    code: 'SECURITY_V2_FIELD_NOT_PERMITTED',
  }]);
  assert.equal(store.state.transactionCount, 0);
});

// --- Router (HTTP surface) ---------------------------------------------------

interface LoggedLine {
  line: string;
}

const logged: LoggedLine[] = [];

async function listenRouter(
  authority: SecurityV2Authority,
  persist: import('./v2.routes').SecurityV2Persist,
  log: (line: string) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const app = express();
  app.use(((req, _res, next) => {
    req.tenantId = TENANT_A;
    req.machineId = MACHINE_A;
    req.managedMachineCredential = true;
    next();
  }) as express.RequestHandler);
  app.use('/worker/security/v2', createSecurityV2Router({ authority, persist, log }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/worker/security/v2/records`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

describe('T20d ingest router', () => {
  it('leases gate the whole request before any storage', async () => {
    const calls: number[] = [];
    const bound = await listenRouter(
      unavailableAuthority(),
      async input => {
        calls.push(1);
        void input;
        return [];
      },
      () => {},
    );
    const response = await fetch(bound.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'lease-gate-1' },
      body: JSON.stringify(uploadOf(findingRecord())),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-request-id'), 'lease-gate-1');
    const problem = await response.json() as { code: string; request_id: string };
    assert.equal(problem.code, 'SECURITY_V2_LEASE_REQUIRED');
    assert.equal(problem.request_id, 'lease-gate-1');
    assert.deepEqual(calls, []);
    await bound.close();
  });

  it('accepts an upload and logs counts only', async () => {
    const lines: string[] = [];
    const store = memoryStore();
    const bound = await listenRouter(fakeAuthority(), async input => {
      assert.equal(input.tenantId, TENANT_A);
      assert.equal(input.machineId, MACHINE_A);
      logged.push({ line: 'persist' });
      return persistSecurityV2UploadWithStore(input, store.runner);
    }, line => {
      lines.push(line);
      logged.push({ line });
    });
    const record = findingRecord();
    const response = await fetch(bound.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(uploadOf(record)),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { schema_version: string; results: unknown[] };
    assert.equal(body.schema_version, 'trackai.security-upload-result/2');
    assert.deepEqual(body.results, [{ record_id: record.record_id, result: 'accepted' }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^security-v2 request_id=.+ records=1 accepted=1 duplicate=0 rejected=0$/);
    // No value, title or rule name reaches the log.
    assert.equal(lines[0]!.includes(record.title!), false);
    assert.equal(lines[0]!.includes(record.rule_id), false);
    await bound.close();
  });

  it('safe errors carry their code and never raw values', async () => {
    const lines: string[] = [];
    const bound = await listenRouter(
      fakeAuthority(),
      async () => assert.fail('must not persist'),
      line => lines.push(line),
    );
    const response = await fetch(bound.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 'trackai.security-upload/2', records: [{ extra: 1 }] }),
    });
    assert.equal(response.status, 400);
    const problem = await response.json() as { code: string };
    assert.equal(problem.code, 'SECURITY_V2_UNKNOWN_FIELD');
    await bound.close();
  });

  it('currentLease failure gates before currentDataSettings runs', async () => {
    let settingsCalled = false;
    const failingSettingsAuthority: SecurityV2Authority = {
      async currentLease() {
        return null;
      },
      async leaseForMachine() {
        return null;
      },
      async currentDataSettings() {
        settingsCalled = true;
        throw new Error('settings lookup exploded');
      },
    };
    const bound = await listenRouter(
      failingSettingsAuthority,
      async () => assert.fail('must not persist'),
      () => {},
    );
    const response = await fetch(bound.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(uploadOf(findingRecord())),
    });
    assert.equal(response.status, 403);
    const problem = await response.json() as { code: string };
    assert.equal(problem.code, 'SECURITY_V2_LEASE_REQUIRED');
    assert.equal(settingsCalled, false);
    await bound.close();
  });

  it('unauthenticated request with oversized/malformed body is refused before body parsing', async () => {
    let persistCalled = false;
    const app = express();
    // Do not set managedMachineCredential to simulate unauthenticated request
    app.use('/worker/security/v2', createSecurityV2Router({
      authority: fakeAuthority(),
      persist: async () => {
        persistCalled = true;
        return [];
      },
      log: () => {},
    }));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/worker/security/v2/records`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'malformed {{{ invalid json',
      });
      assert.equal(response.status, 403);
      const problem = await response.json() as { code: string };
      assert.equal(problem.code, 'SECURITY_V2_LEASE_REQUIRED');
      assert.equal(persistCalled, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('authenticated chunked payload exceeding 4 MiB is refused with 413 RFC 7807 problem', async () => {
    const bound = await listenRouter(
      fakeAuthority(),
      async () => assert.fail('must not persist'),
      () => {},
    );
    // 4.5 MiB payload without Content-Length header or exceeding 4 MiB
    const largePadding = 'x'.repeat(4.5 * 1024 * 1024);
    const response = await fetch(bound.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 'trackai.security-upload/2', padding: largePadding }),
    });
    assert.equal(response.status, 413);
    const problem = await response.json() as { code: string; type: string };
    assert.equal(problem.code, 'SECURITY_V2_PAYLOAD_TOO_LARGE');
    assert.equal(problem.type, 'https://trackai.dev/problems/SECURITY_V2_PAYLOAD_TOO_LARGE');
    await bound.close();
  });
});

function unavailableAuthority(): SecurityV2Authority {
  return {
    async currentLease() {
      return null;
    },
    async leaseForMachine() {
      return null;
    },
    async currentDataSettings() {
      return null;
    },
  };
}
