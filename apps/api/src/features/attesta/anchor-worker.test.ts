// Anchoring worker unit tests (Task15f2). The pass and drain cases are ported from
// SushiCorp tests/unit/anchoring/test_anchoring_service.py and the batch cases from
// tests/unit/evidence/test_evidence_anchoring.py @ 0bd67a5 (catalog EV-2), run
// against the TrackAI fakes (FakeRekor, FakeTsa) and an in-memory store that
// enforces what migration 0018 enforces (contiguous ranges, one anchored row per
// record and type). The Postgres store is proven live by IT-T15f-01…04.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { ATTESTA_PLATFORM_TENANT_ID, anchorSignerFromAdapter } from './anchor-contract';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { DualAnchor, verifyStoredAnchor, type AnchorType, type StoredAnchorKeys } from './anchor-dual';
import { LocalDevSigner, generateDevCredential } from './signer-local-dev';
import { merkleRoot } from './merkle';
import {
  ANCHOR_BACKOFF_MAX_MS, AnchorWorkerError, anchorBackoffMs, anchorBatchId, planTenant, rowsForOutcome, runAnchorPass,
  type AnchorRecordRef, type AnchorRowInput, type AnchorStore, type BatchRowInput, type RecordResult, type StoredBatchState,
  type TenantPlanInput, type TypeFailures,
} from './anchor-worker';

const TERMINAL = ['ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED', 'ATTESTA_ANCHOR_LOG_REJECTED'];
const T0 = Date.parse('2026-10-13T00:00:00.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// In-memory store (what 0018 enforces, in memory)
// ---------------------------------------------------------------------------

interface MemAnchor extends AnchorRowInput { batchId: string; createdAt: number }
interface MemTenant { records: AnchorRecordRef[]; batches: BatchRowInput[]; anchors: MemAnchor[]; resumes?: Array<{ batchId: string; createdAt: number }> }

class MemStore implements AnchorStore {
  tenantsData = new Map<string, MemTenant>();
  locked = new Set<string>();
  beforeRecord: ((tenantId: string, batch: BatchRowInput) => Promise<void> | void) | null = null;
  overrideUnbatched: ((tenantId: string, rows: AnchorRecordRef[]) => AnchorRecordRef[]) | null = null;
  constructor(public clock: { now: number }) {}

  t(tenantId: string): MemTenant {
    let t = this.tenantsData.get(tenantId);
    if (!t) { t = { records: [], batches: [], anchors: [] }; this.tenantsData.set(tenantId, t); }
    return t;
  }

  addRecords(tenantId: string, n: number, recordedAt = this.clock.now - 3_600_000): AnchorRecordRef[] {
    const t = this.t(tenantId);
    const out: AnchorRecordRef[] = [];
    for (let i = 0; i < n; i++) {
      const r = { id: randomUUID(), seq: t.records.length, recordHash: `sha256:${randomBytes(32).toString('hex')}`,
        recordedAt: new Date(recordedAt).toISOString() };
      t.records.push(r);
      out.push(r);
    }
    return out;
  }

  complete(t: MemTenant, b: BatchRowInput, type: AnchorType): boolean {
    return t.anchors.filter((a) => a.batchId === b.batchId && a.anchorType === type && a.status === 'anchored').length >= b.leafCount;
  }

  /** Mirrors pgAnchorStore's rule (Task15i3): only terminal failures newer than the batch's latest resume stop it. */
  lastResume(t: MemTenant, batchId: string): number {
    return Math.max(-Infinity, ...(t.resumes ?? []).filter((r) => r.batchId === batchId).map((r) => r.createdAt));
  }

  stopped(t: MemTenant, b: BatchRowInput): boolean {
    const since = this.lastResume(t, b.batchId);
    return t.anchors.some((a) => a.batchId === b.batchId && a.status === 'failed' && TERMINAL.includes(a.errorCode!) && a.createdAt > since);
  }

  /** An operator resume, stamped just after the clock (clock_timestamp() in the 0021 guard). */
  resume(tenantId: string, batchId: string): void {
    const t = this.t(tenantId);
    (t.resumes ??= []).push({ batchId, createdAt: this.clock.now + 1 });
  }

  async tenants({ tenantId, limit }: { tenantId?: string; limit?: number }) {
    const ids = [...this.tenantsData.keys()].sort().filter((id) => {
      if (tenantId && id !== tenantId) return false;
      const t = this.t(id);
      const last = t.batches.length ? t.batches[t.batches.length - 1].seqTo : -1;
      return t.records.length > last + 1 ||
        t.batches.some((b) => (!this.complete(t, b, 'rekor') || !this.complete(t, b, 'tsa')) && !this.stopped(t, b));
    });
    return limit ? ids.slice(0, limit) : ids;
  }

  async loadPlan(tenantId: string, limits: { unbatched: number; incomplete: number }): Promise<TenantPlanInput | null> {
    if (this.locked.has(tenantId)) return null;
    const t = this.t(tenantId);
    const last = t.batches.length ? t.batches[t.batches.length - 1].seqTo : -1;
    const incomplete: StoredBatchState[] = t.batches
      .filter((b) => !this.complete(t, b, 'rekor') || !this.complete(t, b, 'tsa'))
      .sort((x, y) => Number(this.stopped(t, x)) - Number(this.stopped(t, y)) || x.seqFrom - y.seqFrom)
      .slice(0, limits.incomplete)
      .map((b) => {
        const failures = {} as Record<AnchorType, TypeFailures>;
        for (const type of ['rekor', 'tsa'] as const) {
          const f = t.anchors.filter((a) => a.batchId === b.batchId && a.anchorType === type && a.status === 'failed');
          const since = this.lastResume(t, b.batchId);
          const terminal = f.filter((a) => TERMINAL.includes(a.errorCode!) && a.createdAt > since);
          failures[type] = {
            count: Math.ceil(f.length / b.leafCount),
            lastAt: f.length ? new Date(Math.max(...f.map((a) => a.createdAt))).toISOString() : null,
            terminalCode: terminal.length ? terminal[terminal.length - 1].errorCode : null,
          };
        }
        return { ...b, failures, records: t.records.filter((r) => r.seq >= b.seqFrom && r.seq <= b.seqTo) };
      });
    let unbatched = t.records.filter((r) => r.seq > last).slice(0, limits.unbatched);
    if (this.overrideUnbatched) unbatched = this.overrideUnbatched(tenantId, unbatched);
    return { lastBatchedSeq: last, incomplete, unbatched };
  }

  async record(tenantId: string, batch: BatchRowInput, rows: AnchorRowInput[]): Promise<RecordResult> {
    if (this.beforeRecord) await this.beforeRecord(tenantId, batch);
    const t = this.t(tenantId);
    const existing = t.batches.find((b) => b.batchId === batch.batchId);
    if (existing) {
      assert.deepEqual(existing, batch, 'stored batch re-formed with another range or root');
    } else {
      const last = t.batches.length ? t.batches[t.batches.length - 1].seqTo : -1;
      if (batch.seqFrom !== last + 1) return { status: 'superseded' };
      assert.equal(batch.batchId, anchorBatchId(tenantId, batch.seqFrom, batch.seqTo));
      const leaves = t.records.slice(batch.seqFrom, batch.seqTo + 1).map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
      assert.equal(batch.merkleRoot, `sha256:${merkleRoot(leaves).toString('hex')}`, 'root is the ledger root');
      t.batches.push({ ...batch });
    }
    let anchoredInserted = 0;
    const anchoredIds = new Set<string>();
    let anchoredExisting = 0;
    let failedInserted = 0;
    for (const r of rows) {
      const rec = t.records.find((x) => x.id === r.recordId);
      assert.ok(rec && rec.seq >= batch.seqFrom && rec.seq <= batch.seqTo, 'anchor names a record of its batch');
      if (r.status === 'anchored' && t.anchors.some((a) => a.recordId === r.recordId && a.anchorType === r.anchorType && a.status === 'anchored')) {
        anchoredExisting += 1;
        continue;
      }
      t.anchors.push({ ...r, batchId: batch.batchId, createdAt: this.clock.now });
      if (r.status === 'anchored') { anchoredInserted += 1; anchoredIds.add(r.recordId); } else failedInserted += 1;
    }
    return { status: 'recorded', anchoredInserted, anchoredRecords: anchoredIds.size, anchoredExisting, failedInserted };
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const pem = (k: KeyObject) => createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();

async function world() {
  const clock = { now: T0 };
  const store = new MemStore(clock);
  const rekor = new FakeRekor();
  rekor.clock = Math.floor(Date.now() / 1000);
  const tsa = await FakeTsa.create();
  const cred = generateDevCredential('dev:anchor', ATTESTA_PLATFORM_TENANT_ID);
  const signer = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
  const dual = () => new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, logPublicKeyPem: pem(rekor.logKey), production: false }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch }),
  );
  const anchor = dual();
  const keys: StoredAnchorKeys = {
    rekorLogKey: createPublicKey(rekor.logKey), anchorKeysSpkiDer: [await signer.publicKeySpkiDer()],
    tsaAnchors: loadTrustAnchors(tsa.anchorsPem),
  };
  const pass = (opts: Parameters<typeof runAnchorPass>[2] = {}, a = anchor) =>
    runAnchorPass(store, { anchor: a, now: () => new Date(clock.now) }, opts);
  return { clock, store, rekor, tsa, anchor, dual, keys, pass };
}

function rowsOf(store: MemStore, tenantId: string, filter: Partial<MemAnchor> = {}) {
  return store.t(tenantId).anchors.filter((a) => Object.entries(filter).every(([k, v]) => (a as any)[k] === v));
}

// ---------------------------------------------------------------------------
// Ported pass and drain cases
// ---------------------------------------------------------------------------

test('a pass anchors every record in contiguous batches, each proof verifies offline, and a second pass adds nothing', async () => {
  const w = await world();
  w.store.addRecords(A, 600);
  const r = await w.pass();
  assert.equal(r.batchesAnchored, 3);
  assert.equal(r.recordsAnchored, 600);
  const t = w.store.t(A);
  assert.deepEqual(t.batches.map((b) => [b.seqFrom, b.seqTo]), [[0, 255], [256, 511], [512, 599]]);
  assert.equal(rowsOf(w.store, A, { status: 'anchored' }).length, 1200);
  for (const a of t.anchors) {
    const rec = t.records.find((x) => x.id === a.recordId)!;
    const batch = t.batches.find((b) => b.batchId === a.batchId)!;
    const check = verifyStoredAnchor({
      anchorType: a.anchorType, proof: a.inclusionProof, recordHash: rec.recordHash, merkleRoot: batch.merkleRoot,
      rekorEntryUuid: a.rekorEntryUuid, tsaTokenB64: a.tsaTokenB64,
    }, w.keys);
    assert.equal(check.status, 'valid', `${a.anchorType} seq ${rec.seq}`);
    assert.equal((a.inclusionProof as any).merkle.leaf_index, rec.seq - batch.seqFrom);
    assert.equal((a.inclusionProof as any).merkle.tree_size, batch.leafCount);
  }
  // Only the 32-byte roots left: one Rekor entry and one TSA token per batch.
  assert.equal(w.rekor.bodies.length, 3);
  assert.equal(w.tsa.posts, 3);
  const again = await w.pass();
  assert.equal(again.tenants, 0);
  assert.equal(w.store.t(A).anchors.length, 1200);
});

test('a full batch anchors at once; a partial batch only after its oldest record waited partialAfterMs', async () => {
  const w = await world();
  w.store.addRecords(A, 300, w.clock.now); // fresh
  let r = await w.pass();
  assert.equal(r.batchesAnchored, 1); // 0-255 is full
  assert.equal(r.recordsWaiting, 44);
  w.clock.now += 599_000;
  r = await w.pass();
  assert.equal(r.batchesAnchored, 0);
  w.clock.now += 1_000; // the oldest record has now waited exactly 10 min
  r = await w.pass();
  assert.equal(r.batchesAnchored, 1);
  assert.deepEqual(w.store.t(A).batches.map((b) => [b.seqFrom, b.seqTo]), [[0, 255], [256, 299]]);
});

test('an outage writes failed rows; the retry after backoff re-plans the same batch_id and root, never re-cut', async () => {
  const w = await world();
  w.store.addRecords(A, 10);
  w.tsa.down = true;
  let r = await w.pass();
  assert.equal(r.batchesFailed, 1);
  assert.equal(r.stoppedOnOutage, true);
  assert.deepEqual(r.codes, { ATTESTA_ANCHOR_TSA_UNAVAILABLE: 1 });
  const [batch] = w.store.t(A).batches;
  assert.deepEqual([batch.seqFrom, batch.seqTo], [0, 9]);
  // Rekor verified but nothing is anchored (all or nothing): TSA failed rows only.
  assert.equal(rowsOf(w.store, A, { anchorType: 'tsa', status: 'failed' }).length, 10);
  assert.equal(rowsOf(w.store, A, { anchorType: 'rekor' }).length, 0);
  assert.equal(rowsOf(w.store, A, { status: 'anchored' }).length, 0);

  // More records arrive; the stored batch keeps its range.
  w.store.addRecords(A, 5);
  w.tsa.down = false;
  w.clock.now += 29_000;
  r = await w.pass();
  assert.equal(r.batchesBackoff, 1);
  assert.equal(r.batchesAnchored, 1); // the 5 new records (old enough) form 10-14
  w.clock.now += 1_000;
  r = await w.pass();
  assert.equal(r.batchesAnchored, 1);
  const t = w.store.t(A);
  assert.deepEqual(t.batches.map((b) => b.batchId), [anchorBatchId(A, 0, 9), anchorBatchId(A, 10, 14)]);
  assert.equal(t.batches[0].merkleRoot, batch.merkleRoot);
  assert.equal(rowsOf(w.store, A, { batchId: batch.batchId, status: 'anchored' }).length, 20);
  // The retry reused the in-process Rekor entry for the batch (no second log entry).
  assert.equal(w.rekor.bodies.length, 2);
});

test('each DualAnchorOutcome branch writes the right rows', async () => {
  const w = await world();
  // Rekor fails first: Rekor failed rows, TSA skipped (writes nothing).
  w.store.addRecords(A, 4);
  w.rekor.down = true;
  await w.pass();
  assert.deepEqual(w.store.t(A).anchors.map((a) => [a.anchorType, a.status, a.errorCode]),
    Array(4).fill(['rekor', 'failed', 'ATTESTA_ANCHOR_LOG_UNAVAILABLE']));
  assert.equal(w.tsa.posts, 0);
  assert.ok(w.store.t(A).anchors.every((a) => a.inclusionProof === null && a.rekorEntryUuid === null && a.tsaTokenB64 === null));
  // A lying TSA fails its own type only.
  w.rekor.down = false;
  w.tsa.nonceOffset = 1;
  w.clock.now += anchorBackoffMs(1);
  await w.pass();
  assert.equal(rowsOf(w.store, A, { anchorType: 'tsa', errorCode: 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID' }).length, 4);
  // Complete: one anchored row per record and type with the per-kind columns.
  w.tsa.nonceOffset = 0;
  w.clock.now += ANCHOR_BACKOFF_MAX_MS;
  await w.pass();
  const anchored = rowsOf(w.store, A, { status: 'anchored' });
  assert.equal(anchored.length, 8);
  for (const a of anchored) {
    if (a.anchorType === 'rekor') {
      assert.ok(a.rekorEntryUuid && a.tsaTokenB64 === null && (a.inclusionProof as any).anchor.ref === a.rekorEntryUuid);
    } else {
      assert.ok(a.tsaTokenB64 && a.rekorEntryUuid === null);
      assert.equal((a.inclusionProof as any).anchor.ref,
        `tsa:sha256:${createHash('sha256').update(Buffer.from(a.tsaTokenB64, 'base64')).digest('hex')}`);
    }
  }
});

test('backoff: 30 s doubling per failed attempt of that type, capped at 1 h', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 50].map(anchorBackoffMs),
    [0, 30_000, 60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000]);
  const failures = (count: number, lastAt: number): TypeFailures => ({ count, lastAt: new Date(lastAt).toISOString(), terminalCode: null });
  const recs: AnchorRecordRef[] = [{ id: randomUUID(), seq: 0, recordHash: `sha256:${'a'.repeat(64)}`, recordedAt: new Date(T0).toISOString() }];
  const root = `sha256:${merkleRoot([Buffer.from('a'.repeat(64), 'hex')]).toString('hex')}`;
  const stored = (rekor: TypeFailures, tsa: TypeFailures): TenantPlanInput => ({
    lastBatchedSeq: 0, unbatched: [],
    incomplete: [{ batchId: anchorBatchId(A, 0, 0), seqFrom: 0, seqTo: 0, merkleRoot: root, leafCount: 1, records: recs, failures: { rekor, tsa } }],
  });
  const none: TypeFailures = { count: 0, lastAt: null, terminalCode: null };
  const opts = { maxBatch: 256, partialAfterMs: 600_000, maxBatchesPerTenant: 16 };
  // Two failed TSA attempts: due 60 s after the last; the batch waits for its slowest type.
  assert.equal(planTenant(A, stored(none, failures(2, T0)), new Date(T0 + 59_999), opts).backoff, 1);
  assert.equal(planTenant(A, stored(none, failures(2, T0)), new Date(T0 + 60_000), opts).work.length, 1);
  assert.equal(planTenant(A, stored(failures(1, T0), failures(3, T0)), new Date(T0 + 119_999), opts).backoff, 1);
});

test('a terminal code (log rejected) stops that batch for good; later batches still anchor', async () => {
  const w = await world();
  w.store.addRecords(A, 3);
  w.rekor.failStatus = 400;
  let r = await w.pass();
  assert.deepEqual(r.codes, { ATTESTA_ANCHOR_LOG_REJECTED: 1 });
  assert.equal(r.stoppedOnOutage, false);
  w.rekor.failStatus = null;
  w.store.addRecords(A, 2);
  w.clock.now += 10 * ANCHOR_BACKOFF_MAX_MS;
  r = await w.pass();
  assert.equal(r.batchesStopped, 1);
  assert.equal(r.codes.ATTESTA_ANCHOR_LOG_REJECTED, 1);
  assert.equal(r.batchesAnchored, 1); // 3-4
  w.store.addRecords(A, 1);
  r = await w.pass();
  assert.equal(r.batchesStopped, 1); // still visible, never retried
  assert.equal(r.batchesAnchored, 1);
  r = await w.pass();
  assert.equal(r.tenants, 0); // a stopped batch alone makes no work
  assert.equal(rowsOf(w.store, A, { batchId: anchorBatchId(A, 0, 2), status: 'failed' }).length, 3);
});

test('resume (Task15i3): a resumed batch is retried with the normal backoff and anchors; a new terminal failure stops it again', async () => {
  const w = await world();
  w.store.addRecords(A, 3);
  const batchId = anchorBatchId(A, 0, 2);
  w.rekor.failStatus = 400;
  let r = await w.pass();
  assert.deepEqual(r.codes, { ATTESTA_ANCHOR_LOG_REJECTED: 1 });
  w.clock.now += 10 * ANCHOR_BACKOFF_MAX_MS;
  r = await w.pass();
  assert.equal(r.tenants, 0); // stopped
  // Resumed, still rejected: retried once, then stopped again by the new terminal failure.
  w.store.resume(A, batchId);
  w.clock.now += 1_000;
  r = await w.pass();
  assert.equal(r.tenants, 1);
  assert.equal(r.batchesFailed + r.batchesStopped >= 1, true);
  assert.equal(r.codes.ATTESTA_ANCHOR_LOG_REJECTED, 1);
  assert.equal(rowsOf(w.store, A, { batchId, status: 'failed' }).length, 6);
  w.clock.now += 10 * ANCHOR_BACKOFF_MAX_MS;
  r = await w.pass();
  assert.equal(r.tenants, 0); // stopped again: the old resume does not cover the new stop
  // A second resume after the new stop: the log accepts now, the batch anchors.
  w.rekor.failStatus = null;
  w.store.resume(A, batchId);
  w.clock.now += 1_000;
  r = await w.pass();
  assert.equal(r.batchesAnchored, 1);
  assert.equal(rowsOf(w.store, A, { batchId, status: 'anchored' }).length, 6);
  r = await w.pass();
  assert.equal(r.tenants, 0);
});

test('resume waits for the normal backoff of the failures so far', async () => {
  const w = await world();
  w.store.addRecords(A, 2);
  w.rekor.failStatus = 400;
  await w.pass();
  // Resumed right away: the failure count (1) sets the backoff from its time.
  w.store.resume(A, anchorBatchId(A, 0, 1));
  w.rekor.failStatus = null;
  let r = await w.pass();
  assert.equal(r.batchesAnchored, 0);
  w.clock.now += ANCHOR_BACKOFF_MAX_MS;
  r = await w.pass();
  assert.equal(r.batchesAnchored, 1);
});

test('a signer refusal retries with backoff (never terminal), so a fixed credential resumes anchoring', async () => {
  const w = await world();
  w.store.addRecords(A, 2);
  const cred = generateDevCredential('dev:anchor', B); // a credential of another tenant: the signer refuses
  const refusing = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
  const bad = new DualAnchor(
    new RekorAnchor({ url: 'http://rekor.test', signer: refusing, fetch: w.rekor.fetch, logPublicKeyPem: pem(w.rekor.logKey), production: false }),
    new TsaAnchor({ url: TSA_URL, trustAnchorsPem: w.tsa.anchorsPem, fetch: w.tsa.fetch }),
  );
  let r = await w.pass({}, bad);
  assert.deepEqual(r.codes, { ATTESTA_SIGNER_REJECTED: 1 });
  w.clock.now += anchorBackoffMs(1);
  r = await w.pass();
  assert.equal(r.batchesStopped, 0);
  assert.equal(r.batchesAnchored, 1);
  assert.equal(rowsOf(w.store, A, { batchId: anchorBatchId(A, 0, 2), status: 'anchored' }).length, 0);
});

test('a lost race is success: the concurrent winner\'s anchored rows stand, nothing is duplicated', async () => {
  const w = await world();
  w.store.addRecords(A, 6);
  const other = w.dual(); // a second worker process with its own adapters
  let raced = false;
  w.store.beforeRecord = async (tenantId, batch) => {
    if (raced) return;
    raced = true;
    // The other worker plans, submits and records the same batch first.
    w.store.beforeRecord = null;
    const r = await runAnchorPass(w.store, { anchor: other, now: () => new Date(w.clock.now) }, { tenantId });
    assert.equal(r.batchesAnchored, 1);
    assert.equal(batch.batchId, anchorBatchId(A, 0, 5));
  };
  const r = await w.pass();
  assert.equal(r.batchesAnchored, 0); // the loser anchored nothing new
  assert.equal(r.recordsAnchored, 0);
  assert.equal(r.alreadyAnchored, 12);
  assert.equal(r.tenantErrors, 0);
  assert.equal(rowsOf(w.store, A, { status: 'anchored' }).length, 12);
  assert.equal(w.store.t(A).batches.length, 1);
});

test('a batch recorded by another worker for an overlapping range supersedes ours; the next pass re-plans', async () => {
  // We planned 0-2; meanwhile two records arrived and another worker recorded 0-4.
  const w2 = await world();
  w2.store.addRecords(A, 3);
  w2.store.beforeRecord = (tenantId) => {
    w2.store.beforeRecord = null;
    const t = w2.store.t(tenantId);
    w2.store.addRecords(tenantId, 2);
    t.batches.push({ batchId: anchorBatchId(tenantId, 0, 4), seqFrom: 0, seqTo: 4, leafCount: 5,
      merkleRoot: `sha256:${merkleRoot(t.records.map((x) => Buffer.from(x.recordHash.slice(7), 'hex'))).toString('hex')}` });
  };
  let r = await w2.pass();
  assert.equal(r.superseded, 1);
  assert.equal(r.batchesAnchored, 0);
  assert.equal(w2.store.t(A).anchors.length, 0);
  r = await w2.pass();
  assert.equal(r.batchesAnchored, 1); // 0-4 re-planned from its stored range
  assert.equal(rowsOf(w2.store, A, { status: 'anchored' }).length, 10);
});

test('tenants are planned in isolation: a batch never mixes tenants; tenantId limits the pass', async () => {
  const w = await world();
  w.store.addRecords(A, 5);
  w.store.addRecords(B, 7);
  let r = await w.pass({ tenantId: B });
  assert.equal(r.tenants, 1);
  assert.equal(w.store.t(A).batches.length, 0);
  assert.deepEqual(w.store.t(B).batches.map((b) => b.batchId), [anchorBatchId(B, 0, 6)]);
  r = await w.pass();
  assert.equal(r.tenants, 1);
  for (const id of [A, B]) {
    const t = w.store.t(id);
    for (const b of t.batches) assert.ok(b.batchId.startsWith(`${id}:`));
    const ids = new Set(t.records.map((x) => x.id));
    assert.ok(t.anchors.every((a) => ids.has(a.recordId)));
  }
  // limitTenants caps the tenants per pass.
  w.store.addRecords(A, 1);
  w.store.addRecords(B, 1);
  r = await w.pass({ limitTenants: 1 });
  assert.equal(r.tenants, 1);
});

test('an outage stops the whole pass; a busy tenant is skipped; a broken invariant stops only its tenant', async () => {
  const w = await world();
  w.store.addRecords(A, 2);
  w.store.addRecords(B, 2);
  w.rekor.down = true;
  let r = await w.pass();
  assert.equal(r.stoppedOnOutage, true);
  assert.equal(r.tenants, 1);
  assert.equal(w.store.t(B).anchors.length, 0);
  w.rekor.down = false;
  w.clock.now += ANCHOR_BACKOFF_MAX_MS;
  w.store.locked.add(A);
  r = await w.pass();
  assert.equal(r.busy, 1);
  assert.equal(r.batchesAnchored, 1);
  w.store.locked.clear();
  // A's ledger read comes back with a hole: nothing is written for A, B is unaffected.
  w.store.addRecords(A, 2);
  w.store.addRecords(B, 2);
  w.store.overrideUnbatched = (tenantId, rows) => (tenantId === A ? rows.slice(1) : rows);
  r = await w.pass();
  assert.equal(r.tenantErrors, 1);
  assert.equal(r.codes.anchor_worker_invariant, 1);
  assert.equal(rowsOf(w.store, A, { status: 'anchored' }).length, 0);
  assert.equal(rowsOf(w.store, B, { status: 'anchored' }).length, 8);
});

test('planning: a stored batch that does not re-form from the ledger is refused, never re-cut', () => {
  const recs: AnchorRecordRef[] = [0, 1].map((seq) => ({ id: randomUUID(), seq, recordHash: `sha256:${randomBytes(32).toString('hex')}`,
    recordedAt: new Date(T0).toISOString() }));
  const none: TypeFailures = { count: 0, lastAt: null, terminalCode: null };
  const input: TenantPlanInput = { lastBatchedSeq: 1, unbatched: [], incomplete: [{ batchId: anchorBatchId(A, 0, 1), seqFrom: 0,
    seqTo: 1, merkleRoot: `sha256:${'0'.repeat(64)}`, leafCount: 2, records: recs, failures: { rekor: none, tsa: none } }] };
  assert.throws(() => planTenant(A, input, new Date(T0), { maxBatch: 256, partialAfterMs: 0, maxBatchesPerTenant: 4 }), AnchorWorkerError);
  assert.throws(() => rowsForOutcome({ batch: input.incomplete[0], records: recs, leaves: [], existing: true },
    { complete: true, rekor: { status: 'skipped' }, tsa: { status: 'skipped' } }), AnchorWorkerError);
});

test('options are bounded', async () => {
  const w = await world();
  await assert.rejects(w.pass({ maxBatch: 0 }), RangeError);
  await assert.rejects(w.pass({ maxBatch: 4097 }), RangeError);
  await assert.rejects(w.pass({ tenantId: 'A' }), RangeError);
  await assert.rejects(w.pass({ partialAfterMs: -1 }), RangeError);
});
