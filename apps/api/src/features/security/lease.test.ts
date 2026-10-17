/**
 * Task20f part b unit tests: lazy lease issuance and reuse, lease history, the signed
 * lease under the test trust root, the three machine routes and api.md isolation cases
 * 3–8 (Company A/B, machine X/Y), the real authority gating Task20d's ingest, and the
 * acknowledgement audit rows. The real v2 router, lease router, signer and verifier run
 * in-process; only storage is in memory (testing/memory-lease-store.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import express, { type RequestHandler } from 'express';
import { canonicalize } from '../attesta/canonical';
import type { DsseEnvelope } from '../attesta/dsse';
import { createSecurityV2Router, type SecurityV2Persist } from '../security-findings/v2.routes';
import { SECURITY_V2_NUMBAT_SCHEMA } from '../security-findings/v2-contract';
import { createSecurityV2Authority } from './authority';
import {
  AcknowledgementParseError,
  LEASE_REUSE_MS,
  LEASE_VALIDITY_MS,
  SecurityLeaseNotIssued,
  currentOrIssueLease,
  parseAcknowledgement,
} from './lease';
import { createSecurityLeaseRouter } from './lease.routes';
import { SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE, SecuritySigningUnavailable, type SecurityDocumentSigner } from './signing';
import { memoryLeaseStore, type MemoryLeaseStore } from './testing/memory-lease-store';
import { trustFixture } from './testing/trust-fixture';

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MACHINE_X = '11111111-1111-4111-8111-111111111111';
const MACHINE_Y = '22222222-2222-4222-8222-222222222222';
const MACHINE_B = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-10-17T12:00:00.000Z');
const CONTRACT = resolve(__dirname, '../../../../../docs/contracts/security-v2');
const fixture = trustFixture(T0);

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function contractAjv(): Ajv {
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  ajv.addFormat('date-time', { type: 'string', validate: (value: string) => Number.isFinite(Date.parse(value)) });
  ajv.addFormat('uri', { type: 'string', validate: (value: string) => { try { new URL(value); return true; } catch { return false; } } });
  for (const file of readdirSync(CONTRACT).filter(name => name.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(CONTRACT, file), 'utf8')));
  }
  return ajv;
}
const validateLease = contractAjv().getSchema('https://trackai.dev/contracts/security-v2/security-activation-lease-v2.schema.json')!;

interface World {
  store: MemoryLeaseStore;
  bundleA: { id: string; digest: string; envelope: Buffer };
  bundleB: { id: string; digest: string; envelope: Buffer };
}

/** Company A: machines X and Y, one bundle, monitoring on. Company B: machine B, its own bundle. */
function world(options: { monitor?: boolean } = {}): World {
  const store = memoryLeaseStore();
  store.addMachine(COMPANY_A, MACHINE_X);
  store.addMachine(COMPANY_A, MACHINE_Y);
  store.addMachine(COMPANY_B, MACHINE_B);
  const bundleA = { id: randomUUID(), digest: digestOf('bundle-a'), envelope: Buffer.from('{"payload":"YQ==","payloadType":"a","signatures":[]}') };
  const bundleB = { id: randomUUID(), digest: digestOf('bundle-b'), envelope: Buffer.from('{"payload":"Yg==","payloadType":"b","signatures":[]}') };
  store.addBundle(COMPANY_A, { ...bundleA, epoch: 1, bundleVersion: 1 });
  store.addBundle(COMPANY_B, { ...bundleB, epoch: 1, bundleVersion: 1 });
  store.setData(COMPANY_A, options.monitor === false ? 'off' : 'monitor', { agents: ['claude-code', 'codex'], dayOneScan: true });
  store.setData(COMPANY_B, 'monitor');
  return { store, bundleA, bundleB };
}

function decode(envelope: Buffer): { envelope: DsseEnvelope; payload: Record<string, unknown> } {
  const parsed = JSON.parse(envelope.toString('utf8')) as DsseEnvelope;
  return { envelope: parsed, payload: JSON.parse(Buffer.from(parsed.payload, 'base64').toString('utf8')) as Record<string, unknown> };
}

async function issue(store: MemoryLeaseStore, tenantId: string, machineId: string, now: Date, signer = fixture.signer('activation_lease')) {
  return currentOrIssueLease({ store, signer, tenantId, machineId, now });
}

test('lease: issued lazily, signed with activation_lease, valid against the contract, and verified by verifyTrusted', async () => {
  const { store, bundleA } = world();
  const lease = await issue(store, COMPANY_A, MACHINE_X, T0);
  const { envelope, payload } = decode(lease.envelope);
  assert.equal(envelope.payloadType, SECURITY_ACTIVATION_LEASE_PAYLOAD_TYPE);
  assert.ok(validateLease(payload), JSON.stringify(validateLease.errors));
  assert.deepEqual(payload, {
    schema_version: 'trackai.security-activation-lease/2', tenant_id: COMPANY_A, machine_id: MACHINE_X, lease_id: lease.id,
    issued_at: T0.toISOString(), expires_at: new Date(T0.getTime() + 72 * 3_600_000).toISOString(), mode: 'monitor',
    agents: ['claude-code', 'codex'], bundle_digest: bundleA.digest,
    data_settings: {
      schema_version: 'trackai.security-data-settings/1', command_previews: false, file_paths: false, urls: false,
      host_identity: false, user_identity: false,
    },
    day_one_scan: true,
  });
  assert.equal(Buffer.from(envelope.payload, 'base64').toString('utf8'), canonicalize(payload), 'RFC 8785 bytes');
  assert.equal(lease.keyid, fixture.lease.keyid);
  const verdict = fixture.verify({ envelope, purpose: 'activation_lease', signedAt: String(payload.issued_at), now: T0 });
  assert.equal(verdict.status, 'verified', verdict.code);
  assert.equal(fixture.verify({ envelope, purpose: 'policy_bundle', signedAt: String(payload.issued_at), now: T0 }).status, 'rejected');
  const tampered = Buffer.from(canonicalize({ ...payload, machine_id: MACHINE_Y }), 'utf8');
  const forged = { ...envelope, payload: tampered.toString('base64') };
  assert.equal(fixture.verify({ envelope: forged, purpose: 'activation_lease', signedAt: String(payload.issued_at), now: T0 }).status, 'rejected');
  assert.deepEqual(store.audit.map(row => row.action), ['fleet.lease.issued']);
  assert.deepEqual(store.audit[0].details, {
    lease_id: lease.id, expires_at: lease.expiresAt.toISOString(), mode: 'monitor', bundle_digest: bundleA.digest, epoch: 1,
  });
});

test('lease: reused under 1 h for the same bundle and settings; reissued after 1 h, a new bundle or new settings; history kept', async () => {
  const { store } = world();
  const first = await issue(store, COMPANY_A, MACHINE_X, T0);
  const again = await issue(store, COMPANY_A, MACHINE_X, new Date(T0.getTime() + LEASE_REUSE_MS - 1));
  assert.equal(again.id, first.id, 'reused');
  assert.ok(again.envelope.equals(first.envelope), 'exact stored bytes');

  const afterHour = await issue(store, COMPANY_A, MACHINE_X, new Date(T0.getTime() + LEASE_REUSE_MS));
  assert.notEqual(afterHour.id, first.id, 'an hour-old lease is refreshed');

  store.addBundle(COMPANY_A, { id: randomUUID(), digest: digestOf('bundle-a2'), envelope: Buffer.from('{}'), epoch: 2, bundleVersion: 2 });
  const t2 = new Date(T0.getTime() + LEASE_REUSE_MS + 60_000);
  const afterBundle = await issue(store, COMPANY_A, MACHINE_X, t2);
  assert.equal(afterBundle.bundleDigest, digestOf('bundle-a2'), 'a new bundle reissues at once');

  store.setData(COMPANY_A, 'monitor', { agents: ['cursor'] });
  const afterSettings = await issue(store, COMPANY_A, MACHINE_X, new Date(t2.getTime() + 1_000));
  assert.notEqual(afterSettings.id, afterBundle.id, 'new data settings reissue at once');
  assert.deepEqual(decode(afterSettings.envelope).payload.agents, ['cursor']);

  const history = store.tenants.get(COMPANY_A)!.leases.filter(lease => lease.machineId === MACHINE_X);
  assert.equal(history.length, 4, 'every issued lease is kept');
  assert.deepEqual(store.audit.filter(row => row.action === 'fleet.lease.issued').map(row => row.details.epoch), [1, 1, 2, 2]);
});

test('lease: concurrent first fetches store one lease and one audit row; a stale fetch never outranks an off switch', async () => {
  const { store } = world();
  const [first, second] = await Promise.all([issue(store, COMPANY_A, MACHINE_X, T0), issue(store, COMPANY_A, MACHINE_X, T0)]);
  assert.equal(first.id, second.id);
  assert.equal(store.tenants.get(COMPANY_A)!.leases.length, 1);
  assert.equal(store.audit.filter(row => row.action === 'fleet.lease.issued').length, 1);

  // A fetch that read "monitor" before the switch finishes after an off lease was stored: it serves the off lease.
  const stale = world();
  const realState = stale.store.issuanceState.bind(stale.store);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  stale.store.issuanceState = async tenantId => { const state = await realState(tenantId); await gate; return state; };
  const t2 = new Date(T0.getTime() + 1_000);
  const slow = issue(stale.store, COMPANY_A, MACHINE_X, t2);
  await new Promise(done => setImmediate(done));
  stale.store.issuanceState = realState;
  stale.store.setData(COMPANY_A, 'off');
  const off = await issue(stale.store, COMPANY_A, MACHINE_X, T0);
  release();
  const served = await slow;
  assert.equal(off.mode, 'off');
  assert.equal(served.id, off.id, 'the stale monitor lease is not stored');
  assert.equal(stale.store.tenants.get(COMPANY_A)!.leases.length, 1);
});

test('lease: an off lease carries no agents and validates; no bundle or an inactive machine gets nothing', async () => {
  const off = world({ monitor: false });
  const lease = await issue(off.store, COMPANY_A, MACHINE_X, T0);
  const { payload } = decode(lease.envelope);
  assert.equal(payload.mode, 'off');
  assert.deepEqual(payload.agents, []);
  assert.ok(validateLease(payload), JSON.stringify(validateLease.errors));

  const empty = memoryLeaseStore();
  empty.addMachine(COMPANY_A, MACHINE_X);
  await assert.rejects(issue(empty, COMPANY_A, MACHINE_X, T0), (error: unknown) => error instanceof SecurityLeaseNotIssued && error.reason === 'no_bundle');
  const { store } = world();
  store.addMachine(COMPANY_A, MACHINE_Y, 'revoked');
  await assert.rejects(issue(store, COMPANY_A, MACHINE_Y, T0), (error: unknown) => error instanceof SecurityLeaseNotIssued && error.reason === 'machine_inactive');
  assert.equal(store.tenants.get(COMPANY_A)!.leases.length, 0);
});

test('lease: signing unavailable writes nothing', async () => {
  const { store } = world();
  const unavailable: SecurityDocumentSigner = {
    purpose: 'activation_lease',
    resolve: async () => { throw new SecuritySigningUnavailable('no key'); },
  };
  await assert.rejects(issue(store, COMPANY_A, MACHINE_X, T0, unavailable), SecuritySigningUnavailable);
  assert.equal(store.tenants.get(COMPANY_A)!.leases.length, 0);
  assert.equal(store.audit.length, 0);
  await assert.rejects(issue(store, COMPANY_A, MACHINE_X, T0, fixture.signer('policy_bundle')), /activation_lease key/);
});

test('acknowledgement parser: closed, conditional refusal code, unknown fields refused', () => {
  const base = { schema_version: 'trackai.security-acknowledgement/1', lease_id: randomUUID(), bundle_digest: 'a'.repeat(64) };
  assert.deepEqual(parseAcknowledgement({ ...base, result: 'applied' }).refusalCode, null);
  assert.equal(parseAcknowledgement({ ...base, result: 'refused', refusal_code: 'EPOCH_REGRESSION' }).refusalCode, 'EPOCH_REGRESSION');
  const code = (value: unknown) => {
    try { parseAcknowledgement(value); } catch (error) { return (error as AcknowledgementParseError).code; }
    return 'ok';
  };
  assert.equal(code({ ...base, result: 'applied', refusal_code: 'EPOCH_REGRESSION' }), 'SECURITY_V2_INVALID_BODY');
  assert.equal(code({ ...base, result: 'refused' }), 'SECURITY_V2_INVALID_BODY');
  assert.equal(code({ ...base, result: 'refused', refusal_code: 'BECAUSE' }), 'SECURITY_V2_INVALID_BODY');
  assert.equal(code({ ...base, result: 'applied', tenant_id: COMPANY_B }), 'SECURITY_V2_UNKNOWN_FIELD');
  assert.equal(code({ ...base, result: 'applied', machine_id: MACHINE_Y }), 'SECURITY_V2_UNKNOWN_FIELD');
  assert.equal(code({ ...base, schema_version: 'trackai.security-acknowledgement/2', result: 'applied' }), 'SECURITY_V2_UNSUPPORTED_SCHEMA');
  assert.equal(code({ ...base, bundle_digest: 'A'.repeat(64), result: 'applied' }), 'SECURITY_V2_INVALID_BODY');
  assert.equal(code([]), 'SECURITY_V2_INVALID_BODY');
});

// --- HTTP: the real v2 router with the lease router and the real authority ----------------

interface Harness {
  base: string;
  persisted: number;
  close(): Promise<void>;
}

async function harness(store: MemoryLeaseStore, options: { now?: () => Date; signer?: SecurityDocumentSigner } = {}): Promise<Harness> {
  const state = { persisted: 0 };
  const persist: SecurityV2Persist = async ({ upload }) => {
    state.persisted += upload.records.length;
    return upload.records.map(record => ({ record_id: record.record_id, result: 'accepted' as const }));
  };
  const now = options.now ?? (() => T0);
  const authority = createSecurityV2Authority(store);
  // Test credential: the managed machine credential the app-level middleware would set.
  const credential: RequestHandler = (req, _res, next) => {
    const tenant = req.get('x-test-tenant');
    const machine = req.get('x-test-machine');
    if (tenant && machine) {
      req.tenantId = tenant;
      req.machineId = machine;
      req.managedMachineCredential = true;
    }
    next();
  };
  const app = express();
  app.use('/worker/security/v2', credential, createSecurityV2Router({
    authority: { ...authority, currentLease: (t, m) => authority.currentLease(t, m, now()) },
    persist,
    log: () => undefined,
    leaseRoutes: createSecurityLeaseRouter({ store, signer: options.signer ?? fixture.signer('activation_lease'), now, log: () => undefined }),
  }));
  const server: Server = createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const result: Harness = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/worker/security/v2`,
    get persisted() { return state.persisted; },
    close: () => new Promise<void>(done => server.close(() => done())),
  };
  return result;
}

const as = (tenant: string, machine: string) => ({ 'x-test-tenant': tenant, 'x-test-machine': machine });

async function getLease(h: Harness, tenant: string, machine: string, headers: Record<string, string> = {}) {
  return fetch(`${h.base}/lease`, { headers: { ...as(tenant, machine), ...headers } });
}

async function acknowledge(h: Harness, tenant: string, machine: string, body: unknown) {
  return fetch(`${h.base}/acknowledgements`, {
    method: 'POST', headers: { ...as(tenant, machine), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function finding(leaseId: string, detectedAt: Date) {
  return {
    kind: 'finding', record_id: `sha256:${digestOf(randomUUID())}`, rule_id: 'nb.cmd.dangerous_deletion', rule_version: 'r1',
    severity: 'high', title: 'Destructive deletion was observed', source_agent: 'claude-code', source_type: 'hook', confidence: 'high',
    detected_at: detectedAt.toISOString(), numbat_schema_version: SECURITY_V2_NUMBAT_SCHEMA, bundle_digest: 'a'.repeat(64),
    lease_id: leaseId, found_at_rest: false, repository: { kind: 'not_enrolled' },
  };
}

async function upload(h: Harness, tenant: string, machine: string, records: unknown[]) {
  return fetch(`${h.base}/records`, {
    method: 'POST', headers: { ...as(tenant, machine), 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 'trackai.security-upload/2', records }),
  });
}

async function problem(response: Response): Promise<{ status: number; code: string; cache: string | null; requestId: string | null }> {
  const body = await response.json() as { code: string };
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/problem+json');
  return { status: response.status, code: body.code, cache: response.headers.get('cache-control'), requestId: response.headers.get('x-request-id') };
}

test('GET /lease: exact stored bytes, no-store, request id echoed; case 3: X never receives Y\'s lease', async () => {
  const { store } = world();
  const h = await harness(store);
  try {
    const response = await getLease(h, COMPANY_A, MACHINE_X, { 'X-Request-ID': 'req-20f-1' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-request-id'), 'req-20f-1');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const stored = store.tenants.get(COMPANY_A)!.leases[0];
    assert.ok(bytes.equals(stored.envelope), 'served unchanged');

    const forY = Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_Y)).arrayBuffer());
    assert.equal(decode(forY).payload.machine_id, MACHINE_Y);
    assert.notEqual(decode(forY).payload.lease_id, stored.id);
    // Headers and query text cannot select another machine.
    const viaQuery = await fetch(`${h.base}/lease?machine_id=${MACHINE_Y}`, { headers: as(COMPANY_A, MACHINE_X) });
    assert.equal(decode(Buffer.from(await viaQuery.arrayBuffer())).payload.machine_id, MACHINE_X);
  } finally {
    await h.close();
  }
  const empty = memoryLeaseStore();
  empty.addMachine(COMPANY_A, MACHINE_X);
  const h2 = await harness(empty);
  try {
    const none = await problem(await getLease(h2, COMPANY_A, MACHINE_X));
    assert.deepEqual([none.status, none.code, none.cache], [404, 'SECURITY_V2_LEASE_NOT_ISSUED', 'no-store']);
    assert.ok(none.requestId);
    const anonymous = await problem(await fetch(`${h2.base}/lease`));
    assert.deepEqual([anonymous.status, anonymous.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
  } finally {
    await h2.close();
  }
});

test('GET /lease: signing unavailable answers 500 SECURITY_V2_INTERNAL and stores nothing', async () => {
  const { store } = world();
  const h = await harness(store, { signer: { purpose: 'activation_lease', resolve: async () => { throw new SecuritySigningUnavailable('none'); } } });
  try {
    const answer = await problem(await getLease(h, COMPANY_A, MACHINE_X));
    assert.deepEqual([answer.status, answer.code], [500, 'SECURITY_V2_INTERNAL']);
    assert.equal(store.tenants.get(COMPANY_A)!.leases.length, 0);
  } finally {
    await h.close();
  }
});

test('GET /bundles/{sha256}: own bundle exact bytes; case 4: foreign, missing and malformed digests answer the same 404', async () => {
  const { store, bundleA, bundleB } = world();
  const h = await harness(store);
  try {
    const own = await fetch(`${h.base}/bundles/${bundleA.digest}`, { headers: as(COMPANY_A, MACHINE_X) });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await own.arrayBuffer()).equals(bundleA.envelope));
    const answers = [];
    for (const digest of [bundleB.digest, digestOf('missing'), 'A'.repeat(64), 'abc', `${bundleA.digest}0`]) {
      const answer = await problem(await fetch(`${h.base}/bundles/${digest}`, { headers: as(COMPANY_A, MACHINE_X) }));
      answers.push([answer.status, answer.code, answer.cache]);
    }
    assert.deepEqual(answers, Array(5).fill([404, 'SECURITY_V2_NOT_FOUND', 'no-store']));
  } finally {
    await h.close();
  }
});

test('POST /acknowledgements: applied and refused are stored and audited; cases 5–7 write nothing', async () => {
  const { store, bundleA } = world();
  const h = await harness(store);
  try {
    const leaseX = decode(Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_X)).arrayBuffer())).payload;
    const leaseY = decode(Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_Y)).arrayBuffer())).payload;
    const leaseB = decode(Buffer.from(await (await getLease(h, COMPANY_B, MACHINE_B)).arrayBuffer())).payload;
    const ack = (lease: Record<string, unknown>, extra: Record<string, unknown> = { result: 'applied' }) => ({
      schema_version: 'trackai.security-acknowledgement/1', lease_id: lease.lease_id, bundle_digest: lease.bundle_digest, ...extra,
    });

    const applied = await acknowledge(h, COMPANY_A, MACHINE_X, ack(leaseX));
    assert.equal(applied.status, 204);
    assert.equal(applied.headers.get('cache-control'), 'no-store');
    assert.equal(await applied.text(), '');
    const refusedDigest = digestOf('the bundle it refused');
    const refused = await acknowledge(h, COMPANY_A, MACHINE_X,
      { ...ack(leaseX, { result: 'refused', refusal_code: 'BUNDLE_DIGEST_MISMATCH' }), bundle_digest: refusedDigest });
    assert.equal(refused.status, 204);
    const stored = store.tenants.get(COMPANY_A)!.acknowledgements;
    assert.deepEqual(stored.map(row => [row.result, row.bundleDigest, row.refusalCode]),
      [['applied', bundleA.digest, null], ['refused', refusedDigest, 'BUNDLE_DIGEST_MISMATCH']]);
    const audited = store.audit.filter(row => row.action !== 'fleet.lease.issued');
    assert.deepEqual(audited.map(row => row.action), ['policy.bundle.acknowledged', 'fleet.lease.refused']);
    assert.deepEqual(audited[0].details, { machine_id: MACHINE_X, version: 1, epoch: 1, lease_id: leaseX.lease_id, bundle_digest: bundleA.digest });
    assert.deepEqual(audited[1].details, { lease_id: leaseX.lease_id, bundle_digest: refusedDigest, refusal: 'BUNDLE_DIGEST_MISMATCH' });

    const before = stored.length;
    const answers: unknown[] = [];
    for (const [machine, body] of [
      [MACHINE_X, ack(leaseY)], // case 5: machine Y's lease
      [MACHINE_X, ack(leaseB)], // case 6: Company B's lease
      [MACHINE_X, { ...ack(leaseX), bundle_digest: digestOf('other') }], // applied must name the lease's digest
      [MACHINE_X, { ...ack(leaseX), lease_id: 'not-a-uuid' }],
      [MACHINE_X, { ...ack(leaseX), lease_id: randomUUID() }],
    ] as const) {
      const answer = await problem(await acknowledge(h, COMPANY_A, machine, body));
      answers.push([answer.status, answer.code]);
    }
    assert.deepEqual(answers, Array(5).fill([404, 'SECURITY_V2_NOT_FOUND']));
    // Case 7: identity selectors in the body are unknown fields, refused before any lookup.
    for (const extra of [{ tenant_id: COMPANY_A }, { machine_id: MACHINE_X }]) {
      const answer = await problem(await acknowledge(h, COMPANY_A, MACHINE_X, { ...ack(leaseX), ...extra }));
      assert.deepEqual([answer.status, answer.code], [400, 'SECURITY_V2_UNKNOWN_FIELD']);
    }
    const badSchema = await problem(await acknowledge(h, COMPANY_A, MACHINE_X, { ...ack(leaseX), schema_version: 'x/9' }));
    assert.deepEqual([badSchema.status, badSchema.code], [400, 'SECURITY_V2_UNSUPPORTED_SCHEMA']);
    assert.equal(stored.length, before, 'no acknowledgement written');
    assert.equal(store.tenants.get(COMPANY_B)!.acknowledgements.length, 0);
  } finally {
    await h.close();
  }
});

test('authority and ingest: records accepted under an issued lease; case 8: expired, off, absent or another machine\'s lease refuses', async () => {
  const { store } = world();
  let clock = T0;
  const h = await harness(store, { now: () => clock });
  const authority = createSecurityV2Authority(store);
  try {
    // Absent: no lease yet.
    let answer = await problem(await upload(h, COMPANY_A, MACHINE_X, [finding(randomUUID(), T0)]));
    assert.deepEqual([answer.status, answer.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);

    const leaseX = decode(Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_X)).arrayBuffer())).payload;
    const accepted = await upload(h, COMPANY_A, MACHINE_X, [finding(String(leaseX.lease_id), new Date(T0.getTime() + 60_000))]);
    assert.equal(accepted.status, 200);
    assert.equal(h.persisted, 1);
    assert.deepEqual(await authority.currentDataSettings(COMPANY_A), store.tenants.get(COMPANY_A)!.data.at(-1)!.settings.data);

    // Machine Y has no lease of its own: X's lease id in Y's body changes nothing.
    answer = await problem(await upload(h, COMPANY_A, MACHINE_Y, [finding(String(leaseX.lease_id), T0)]));
    assert.deepEqual([answer.status, answer.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
    assert.equal(await authority.leaseForMachine(COMPANY_A, MACHINE_Y, String(leaseX.lease_id)), null);
    assert.equal(await authority.leaseForMachine(COMPANY_B, MACHINE_X, String(leaseX.lease_id)), null);
    // Company B's machine with Company A's lease: refused.
    answer = await problem(await upload(h, COMPANY_B, MACHINE_B, [finding(String(leaseX.lease_id), T0)]));
    assert.equal(answer.code, 'SECURITY_V2_LEASE_REQUIRED');

    // Expired: the lease window has passed.
    clock = new Date(T0.getTime() + LEASE_VALIDITY_MS);
    assert.equal(await authority.currentLease(COMPANY_A, MACHINE_X, clock), null);
    answer = await problem(await upload(h, COMPANY_A, MACHINE_X, [finding(String(leaseX.lease_id), T0)]));
    assert.deepEqual([answer.status, answer.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
    // ...but it stays provenance for a past finding.
    assert.equal((await authority.leaseForMachine(COMPANY_A, MACHINE_X, String(leaseX.lease_id)))?.leaseId, leaseX.lease_id);

    // Off: monitoring switched off stops ingest at once, before the Endpoint fetches its off lease.
    clock = new Date(T0.getTime() + 2 * 3_600_000);
    store.setData(COMPANY_A, 'monitor', { agents: ['claude-code', 'codex'] });
    const fresh = decode(Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_X)).arrayBuffer())).payload;
    assert.ok(await authority.currentLease(COMPANY_A, MACHINE_X, clock));
    store.setData(COMPANY_A, 'off');
    assert.equal(await authority.currentLease(COMPANY_A, MACHINE_X, clock), null, 'the switch wins over a valid monitor lease');
    answer = await problem(await upload(h, COMPANY_A, MACHINE_X, [finding(String(fresh.lease_id), clock)]));
    assert.deepEqual([answer.status, answer.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
    // The next fetch issues an off lease, and the older monitor lease never revives.
    const offLease = decode(Buffer.from(await (await getLease(h, COMPANY_A, MACHINE_X)).arrayBuffer())).payload;
    assert.equal(offLease.mode, 'off');
    assert.equal(await authority.currentLease(COMPANY_A, MACHINE_X, clock), null);
    assert.equal(await authority.leaseForMachine(COMPANY_A, MACHINE_X, String(offLease.lease_id)), null);
    answer = await problem(await upload(h, COMPANY_A, MACHINE_X, [finding(String(leaseX.lease_id), T0)]));
    assert.deepEqual([answer.status, answer.code], [403, 'SECURITY_V2_LEASE_REQUIRED']);
    assert.equal(h.persisted, 1, 'nothing else reached storage');
  } finally {
    await h.close();
  }
});
