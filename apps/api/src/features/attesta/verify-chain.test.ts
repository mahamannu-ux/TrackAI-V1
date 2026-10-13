/**
 * Chain verification: every break kind from one specific tamper, and the 10 000-record
 * tamper matrix ported from SushiCorp tests/unit/evidence/test_evidence_verify.py @ 0bd67a5.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { computeRecordHash, sha256Prefixed } from './canonical';
import { buildCanonicalRecord, type LedgerRecordFields } from './ledger';
import { buildChain, makeStatement, makeTestKey, signStatement } from './testing/ledger-fixtures';
import { createPublicKey } from 'node:crypto';
import { FakeRekor } from './testing/fake-rekor';
import { FakeTsa, TSA_URL } from './testing/fake-tsa';
import { ATTESTA_PLATFORM_TENANT_ID, anchorSignerFromAdapter } from './anchor-contract';
import { DualAnchor } from './anchor-dual';
import { RekorAnchor } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { anchorBatchId, rowsForOutcome } from './anchor-worker';
import { merkleRoot } from './merkle';
import { LocalDevSigner, generateDevCredential } from './signer-local-dev';
import {
  BREAK_DETAIL_CODES,
  verifyChain,
  verifyChainRows,
  type AnchorCheckOptions,
  type StoredRecordAnchor,
  type ChainBreakKind,
  type ChainHeadState,
  type ChainReport,
  type LedgerRow,
} from './verify-chain';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const REPO = '22222222-2222-4222-8222-222222222222';
const N = 10_000;

const big = buildChain(N, { tenantId: TENANT, repositoryId: REPO });
const small = buildChain(40, { tenantId: TENANT, repositoryId: REPO });

const verifyAll = (rows: LedgerRow[], head: ChainHeadState | null, extra: Partial<Parameters<typeof verifyChainRows>[1]> = {}) =>
  verifyChainRows(rows, { tenantId: TENANT, fromSeq: 0, toSeq: (head?.next_seq ?? rows.length) - 1, head, ...extra });

/** Breaks other than "signatures not checked" (the structural tests run without keys). */
const pairs = (r: ChainReport) => r.breaks.filter((b) => b.kind !== 'signatures_not_checked')
  .map((b) => [b.seq, b.kind] as [number, ChainBreakKind]);
const kinds = (r: ChainReport) => new Set(r.breaks.map((b) => b.kind));

function withRow(rows: LedgerRow[], i: number, patch: Partial<LedgerRow>): LedgerRow[] {
  const copy = rows.slice();
  copy[i] = { ...copy[i], ...patch };
  return copy;
}

function fieldsOf(row: LedgerRow): LedgerRecordFields {
  return JSON.parse(row.canonicalRecord) as LedgerRecordFields;
}

/**
 * Change a field after sealing, in the bytes and the column alike (what a tamperer
 * with UPDATE does), without re-hashing. Every record field has a typed copy, so a
 * bytes-only edit would also show as field_mismatch.
 */
function editBytes(row: LedgerRow): Partial<LedgerRow> {
  const f = fieldsOf(row);
  const recordedAt = '2020-01-01T00:00:00.000Z';
  return { canonicalRecord: buildCanonicalRecord({ ...f, recorded_at: recordedAt }), recordedAt };
}

// Deterministic sample positions (mulberry32, seed 42).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
/** Fixed edges plus five random positions, at least 4 apart so tampers never touch. */
function spaced(fixed: number[]): number[] {
  const out = [...fixed];
  while (out.length < fixed.length + 5) {
    const p = 4 + Math.floor(rand() * (N - 10));
    if (out.every((q) => Math.abs(q - p) >= 4)) out.push(p);
  }
  return out.sort((a, b) => a - b);
}
const SAMPLED = spaced([0, N / 2, N - 2]);

describe('intact chains', () => {
  it('a 10 000-record chain verifies clean, quickly, as a structured report', async () => {
    const started = performance.now();
    const report = await verifyAll(big.rows, big.head);
    const elapsed = performance.now() - started;
    assert.equal(report.chain_intact, true, JSON.stringify(report.breaks.slice(0, 3)));
    assert.equal(report.checked, N);
    // Without published keys the report is never ok: an unchecked signature is not a pass.
    assert.equal(report.ok, false);
    assert.deepEqual(report.breaks, [{ seq: 0, kind: 'signatures_not_checked', detail_code: 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED' }]);
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(report.head, big.head);
    assert.ok(elapsed < 15_000, `verifying ${N} records took ${elapsed.toFixed(0)} ms`);
    assert.doesNotThrow(() => JSON.stringify(report));
  });

  it('a signed chain verifies with the published key', async () => {
    const key = makeTestKey();
    const signed = buildChain(30, { tenantId: TENANT, repositoryId: REPO, key });
    const report = await verifyAll(signed.rows, signed.head, { keys: { [key.keyid]: key.publicKey } });
    assert.equal(report.ok, true, JSON.stringify(report.breaks));
    assert.equal(report.chain_intact, true);
    assert.equal(report.signatures, 'checked');
  });

  it('every break kind maps to a frozen errors.md code', () => {
    for (const code of Object.values(BREAK_DETAIL_CODES)) assert.match(code, /^ATTESTA_VERIFY_[A-Z_]+$/);
  });

  it('each break kind has its exact 2026-10-12 code (errors.md §Verification)', () => {
    assert.deepEqual({ ...BREAK_DETAIL_CODES }, {
      hash_mismatch: 'ATTESTA_VERIFY_RECORD_HASH_MISMATCH',
      link_mismatch: 'ATTESTA_VERIFY_PREV_HASH_MISMATCH',
      seq_gap: 'ATTESTA_VERIFY_SEQ_GAP',
      seq_mismatch: 'ATTESTA_VERIFY_SEQ_MISMATCH',
      field_mismatch: 'ATTESTA_VERIFY_FIELD_MISMATCH',
      tenant_mismatch: 'ATTESTA_VERIFY_TENANT_MISMATCH',
      not_canonical: 'ATTESTA_VERIFY_NOT_CANONICAL',
      out_of_order: 'ATTESTA_VERIFY_OUT_OF_ORDER',
      duplicate_seq: 'ATTESTA_VERIFY_DUPLICATE_SEQ',
      head_mismatch: 'ATTESTA_VERIFY_HEAD_MISMATCH',
      beyond_head: 'ATTESTA_VERIFY_BEYOND_HEAD',
      statement_digest_mismatch: 'ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH',
      statement_not_canonical: 'ATTESTA_VERIFY_NOT_CANONICAL',
      envelope_missing: 'ATTESTA_VERIFY_ENVELOPE_MISSING',
      envelope_payload_mismatch: 'ATTESTA_VERIFY_ENVELOPE_PAYLOAD_MISMATCH',
      signature_invalid: 'ATTESTA_VERIFY_SIGNATURE_INVALID',
      key_unknown: 'ATTESTA_VERIFY_KEY_UNKNOWN',
      signatures_not_checked: 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED',
      merkle_proof_invalid: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID',
      anchor_invalid: 'ATTESTA_VERIFY_ANCHOR_INVALID',
      anchor_missing: 'ATTESTA_VERIFY_ANCHOR_MISSING',
      anchor_not_checkable: 'ATTESTA_VERIFY_NOT_CHECKABLE',
    });
  });
});

describe('one tamper per break kind', () => {
  const rows = small.rows;
  const head = small.head;

  it('hash_mismatch: bytes edited after sealing', async () => {
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 7, editBytes(rows[7])), head)), [[7, 'hash_mismatch']]);
  });

  it('link_mismatch: a record replaced and re-hashed is caught by the next link', async () => {
    const edited = editBytes(rows[7]);
    const rehashed = { ...edited, recordHash: computeRecordHash(edited.canonicalRecord!, rows[7].prevHash) };
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 7, rehashed), head)), [[8, 'link_mismatch']]);
  });

  it('seq_gap: a deleted record, reported once per run, the next record not blamed', async () => {
    assert.deepEqual(pairs(await verifyAll([...rows.slice(0, 10), ...rows.slice(11)], head)), [[10, 'seq_gap']]);
    assert.deepEqual(pairs(await verifyAll([...rows.slice(0, 10), ...rows.slice(15)], head)), [[10, 'seq_gap']]);
  });

  it('seq_mismatch: contents of two records swapped under the seq column', async () => {
    let swapped = withRow(rows, 5, { ...rows[6], seq: 5 });
    swapped = withRow(swapped, 6, { ...rows[5], seq: 6 });
    const report = await verifyAll(swapped, head);
    assert.ok(kinds(report).has('seq_mismatch'));
    assert.ok(kinds(report).has('link_mismatch'));
    assert.ok(pairs(report).every(([s]) => s >= 5 && s <= 7));
  });

  it('field_mismatch: a typed column changed (the hashed bytes still say otherwise)', async () => {
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 3, { outboxSubjectId: OTHER_TENANT }), head)), [[3, 'field_mismatch']]);
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 3, { recordedAt: '2020-01-01T00:00:00.000Z' }), head)), [[3, 'field_mismatch']]);
  });

  it('tenant_mismatch: a record from another tenant', async () => {
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 4, { tenantId: OTHER_TENANT }), head)), [[4, 'tenant_mismatch']]);
  });

  it('not_canonical: stored bytes not in RFC 8785 form (even if re-hashed)', async () => {
    const pretty = JSON.stringify(JSON.parse(rows[2].canonicalRecord), null, 1);
    const report = await verifyAll(withRow(rows, 2, { canonicalRecord: pretty, recordHash: computeRecordHash(pretty, rows[2].prevHash) }), head);
    assert.ok(kinds(report).has('not_canonical'));
    assert.ok(!kinds(report).has('hash_mismatch'));
  });

  it('out_of_order and duplicate_seq: rows supplied out of sequence', async () => {
    const shuffled = rows.slice(0, 20);
    [shuffled[5], shuffled[6]] = [shuffled[6], shuffled[5]];
    const ooo = await verifyChainRows(shuffled, { tenantId: TENANT, fromSeq: 0, toSeq: 19 });
    assert.ok(pairs(ooo).some(([s, k]) => s === 5 && k === 'out_of_order'));
    const dup = await verifyChainRows([...rows.slice(0, 10), rows[9]], { tenantId: TENANT, fromSeq: 0, toSeq: 9 });
    assert.deepEqual(pairs(dup), [[9, 'duplicate_seq']]);
  });

  it('head_mismatch: the whole tail rewritten and re-hashed', async () => {
    const i = rows.length - 3;
    const rewritten = rows.slice(0, i);
    let prev = rewritten[i - 1].recordHash;
    for (const old of rows.slice(i)) {
      const f = fieldsOf(old);
      const canonicalRecord = buildCanonicalRecord({ ...f, prev_hash: prev, recorded_at: '2026-10-12T11:00:00.000Z' });
      const recordHash = computeRecordHash(canonicalRecord, prev);
      rewritten.push({ ...old, prevHash: prev, canonicalRecord, recordHash, recordedAt: '2026-10-12T11:00:00.000Z' });
      prev = recordHash;
    }
    assert.deepEqual(pairs(await verifyAll(rewritten, head)), [[rows.length - 1, 'head_mismatch']]);
  });

  it('beyond_head: records past what the head says', async () => {
    const behind = { next_seq: 38, head_hash: rows[37].recordHash };
    const report = await verifyChainRows(rows, { tenantId: TENANT, fromSeq: 0, toSeq: 39, head: behind });
    assert.deepEqual(pairs(report), [[38, 'beyond_head'], [39, 'beyond_head']]);
  });

  it('statement_digest_mismatch: the signed statement bytes replaced', async () => {
    const other = makeStatement({ repositoryId: REPO, subjectSha: rows[6].subjectSha!, asOf: '2026-10-12T12:00:00.000Z' });
    const env = { ...(rows[6].envelope as object), payload: Buffer.from(other).toString('base64') };
    const report = await verifyAll(withRow(rows, 6, { statementCanonical: other, envelope: env }), head);
    assert.deepEqual(pairs(report), [[6, 'statement_digest_mismatch']]);
  });

  it('statement_not_canonical: statement bytes not their own RFC 8785 form', async () => {
    const pretty = JSON.stringify(JSON.parse(rows[6].statementCanonical), null, 1);
    const env = { ...(rows[6].envelope as object), payload: Buffer.from(pretty).toString('base64') };
    const report = await verifyAll(withRow(rows, 6, { statementCanonical: pretty, envelope: env }), head);
    assert.ok(kinds(report).has('statement_not_canonical'));
  });

  it('envelope_missing and envelope_payload_mismatch', async () => {
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 9, { envelope: null }), head)), [[9, 'envelope_missing']]);
    const env = { ...(rows[9].envelope as object), payload: Buffer.from(rows[10].statementCanonical).toString('base64') };
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 9, { envelope: env }), head)), [[9, 'envelope_payload_mismatch']]);
    assert.deepEqual(pairs(await verifyAll(withRow(rows, 9, { envelopeKeyid: 'sha256:' + '1'.repeat(64) }), head)), [[9, 'envelope_payload_mismatch']]);
  });

  it('signature_invalid and key_unknown: checked against published keys', async () => {
    const key = makeTestKey();
    const signed = buildChain(12, { tenantId: TENANT, repositoryId: REPO, key });
    // A valid signature by the right key over different bytes, stored consistently.
    const forged = signStatement(signed.rows[2].statementCanonical + ' ', key).signatureDer.toString('base64');
    const env = signed.rows[4].envelope as { payload: string; payloadType: string; signatures: Array<{ keyid: string; sig: string }> };
    const tampered = withRow(signed.rows, 4, {
      envelope: { ...env, signatures: [{ keyid: key.keyid, sig: forged }] }, envelopeSignatureB64: forged,
    });
    const keys = { [key.keyid]: key.publicKey };
    assert.deepEqual(pairs(await verifyAll(tampered, signed.head, { keys })), [[4, 'signature_invalid']]);
    const stranger = makeTestKey();
    const unknown = await verifyAll(signed.rows, signed.head, { keys: { [stranger.keyid]: stranger.publicKey } });
    assert.equal(unknown.breaks.length, 12);
    assert.ok(unknown.breaks.every((b) => b.kind === 'key_unknown' && b.detail_code === 'ATTESTA_VERIFY_KEY_UNKNOWN'));
  });
});

// One 10 000-record verify per tamper kind, with the tamper applied at every sampled
// position at once: each must be found with exactly its kind and seq, and nothing else.
// (The source ran one verify per position; batching keeps npm test fast and is stricter,
// since every other tamper in the chain must not disturb the expected list.)
describe('10 000-record tamper matrix', () => {
  it('edit: one hash_mismatch per edited record', async () => {
    let rows = big.rows;
    for (const i of [...SAMPLED, 1, N - 1]) rows = withRow(rows, i, editBytes(big.rows[i]));
    const want = [...SAMPLED, 1, N - 1].sort((a, b) => a - b).map((i) => [i, 'hash_mismatch']);
    assert.deepEqual(pairs(await verifyAll(rows, big.head)), want);
  });

  it('delete: one seq_gap per deleted record, the next record not blamed', async () => {
    const drop = new Set(SAMPLED);
    const rows = big.rows.filter((r) => !drop.has(r.seq));
    assert.deepEqual(pairs(await verifyAll(rows, big.head)), [...drop].sort((a, b) => a - b).map((i) => [i, 'seq_gap']));
  });

  it('delete a run: reported once', async () => {
    const rows = [...big.rows.slice(0, 100), ...big.rows.slice(110)];
    assert.deepEqual(pairs(await verifyAll(rows, big.head)), [[100, 'seq_gap']]);
  });

  it('swap contents under the seq column: seq_mismatch at both, nothing outside the pair', async () => {
    let rows = big.rows;
    for (const i of SAMPLED) {
      rows = withRow(rows, i, { ...big.rows[i + 1], seq: i });
      rows = withRow(rows, i + 1, { ...big.rows[i], seq: i + 1 });
    }
    const report = await verifyAll(rows, big.head);
    for (const i of SAMPLED) {
      assert.ok(pairs(report).some(([s, k]) => s === i && k === 'seq_mismatch'), `seq ${i}`);
      assert.ok(pairs(report).some(([s, k]) => s === i + 1 && k === 'seq_mismatch'), `seq ${i + 1}`);
    }
    assert.ok(pairs(report).every(([s]) => SAMPLED.some((i) => s >= i && s <= i + 2)));
  });

  it('reorder rows as supplied: out_of_order at each pair', async () => {
    const rows = big.rows.slice();
    for (const i of SAMPLED) [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
    const report = await verifyAll(rows, big.head);
    for (const i of SAMPLED) assert.ok(pairs(report).some(([s, k]) => s === i && k === 'out_of_order'), `seq ${i}`);
    assert.ok(pairs(report).every(([s]) => SAMPLED.includes(s)));
  });

  for (const i of [1, N / 2, N - 1]) {
    it(`truncate the tail from seq ${i}`, async () => {
      assert.deepEqual(pairs(await verifyAll(big.rows.slice(0, i), big.head)), [[i, 'seq_gap']]);
    });
  }

  it('truncation is invisible without the head, and the report says so', async () => {
    const blind = await verifyChainRows(big.rows.slice(0, N - 1), { tenantId: TENANT, fromSeq: 0, toSeq: N - 1 });
    assert.equal(blind.chain_intact, true);
    assert.ok(blind.warnings.includes('head_not_supplied'));
  });
});

describe('ranges and limits', () => {
  it('a mid-range check needs the previous hash to check its first link', async () => {
    const part = small.rows.slice(10, 20);
    const blind = await verifyChainRows(part, { tenantId: TENANT, fromSeq: 10, toSeq: 19 });
    assert.equal(blind.chain_intact, true);
    assert.ok(blind.warnings.includes('first_link_not_checked'));
    const wrong = await verifyChainRows(part, { tenantId: TENANT, fromSeq: 10, toSeq: 19, expectedPrevHash: small.rows[8].recordHash });
    assert.deepEqual(pairs(wrong), [[10, 'link_mismatch']]);
  });

  it('the genesis record must link to the zero hash', async () => {
    const f = fieldsOf(small.rows[0]);
    const prevHash = sha256Prefixed('not genesis');
    const canonicalRecord = buildCanonicalRecord({ ...f, prev_hash: prevHash });
    const report = await verifyAll(withRow(small.rows, 0, { prevHash, canonicalRecord, recordHash: computeRecordHash(canonicalRecord, prevHash) }), small.head);
    assert.ok(pairs(report).some(([s, k]) => s === 0 && k === 'link_mismatch'));
  });

  it('caps the listed breaks and refuses bad arguments', async () => {
    const everything = small.rows.map((r) => ({ ...r, ...editBytes(r) }));
    const capped = await verifyAll(everything, small.head, { maxBreaks: 5 });
    assert.equal(capped.breaks.length, 5);
    assert.equal(capped.breaks_truncated, true);
    assert.equal(capped.ok, false);
    await assert.rejects(verifyChainRows([], { tenantId: TENANT, fromSeq: 5, toSeq: 4 }), RangeError);
    await assert.rejects(verifyChainRows([], { tenantId: TENANT, fromSeq: -1, toSeq: 4 }), RangeError);
    await assert.rejects(verifyChainRows([], { tenantId: TENANT, fromSeq: 2, toSeq: 4, expectedPrevHash: 'x' }), RangeError);
  });

  it('ignores rows outside the range, with a warning', async () => {
    const report = await verifyChainRows(small.rows, { tenantId: TENANT, fromSeq: 0, toSeq: 9, head: small.head });
    assert.equal(report.checked, 10);
    assert.ok(report.warnings.includes('rows_outside_range_ignored'));
    assert.equal(report.chain_intact, true);
  });
});

// verifyChain's database reader against a scripted executor: paging, tenant binding, head.
class FakeDb {
  queries: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly rows: LedgerRow[], private readonly head: ChainHeadState | null) {}
  async execute(query: SQL) {
    const q = new PgDialect().sqlToQuery(query);
    this.queries.push(q);
    if (q.sql.includes('left join chain_head')) {
      const max = this.rows.length ? String(this.rows[this.rows.length - 1].seq) : null;
      return { rows: [{ next_seq: this.head ? String(this.head.next_seq) : null, head_hash: this.head?.head_hash ?? null, max_seq: max }] };
    }
    if (q.sql.includes('left join attesta_envelopes')) {
      const [, after, to, limit] = q.params as [string, number, number, number];
      const page = this.rows.filter((r) => r.seq > after && r.seq <= to).slice(0, limit);
      return { rows: page.map((r) => ({
        seq: String(r.seq), tenant_id: r.tenantId, prev_hash: r.prevHash, record_hash: r.recordHash,
        canonical_record: r.canonicalRecord, recorded_at: r.recordedAt, record_kind: r.recordKind,
        statement_digest: r.statementDigest, predicate_type: r.predicateType, statement_kind: r.statementKind,
        repository_id: r.repositoryId, subject_sha: r.subjectSha, outbox_subject_id: r.outboxSubjectId,
        statement_canonical: r.statementCanonical, envelope: r.envelope, envelope_keyid: r.envelopeKeyid,
        envelope_payload_type: r.envelopePayloadType, envelope_signature_b64: r.envelopeSignatureB64,
      })) };
    }
    if (q.sql.includes('where tenant_id = $1 and seq = $2')) {
      const seq = q.params[1] as number;
      return { rows: this.rows.filter((r) => r.seq === seq).map((r) => ({ record_hash: r.recordHash })) };
    }
    throw new Error(`unexpected query ${q.sql}`);
  }
}

describe('verifyChain (database reader, scripted)', () => {
  it('pages through the chain with every query bound to the tenant', async () => {
    const db = new FakeDb(small.rows, small.head);
    const report = await verifyChain(db, TENANT, { pageSize: 7 });
    assert.equal(report.chain_intact, true, JSON.stringify(report.breaks));
    assert.equal(report.checked, 40);
    assert.equal(db.queries.filter((q) => q.sql.includes('left join attesta_envelopes')).length, 6);
    assert.ok(db.queries.every((q) => q.params[0] === TENANT));
  });

  it('checks a sub-range from its stored predecessor', async () => {
    const db = new FakeDb(small.rows, small.head);
    const report = await verifyChain(db, TENANT, { fromSeq: 20, toSeq: 29 });
    assert.equal(report.chain_intact, true);
    assert.equal(report.checked, 10);
    assert.ok(!report.warnings.includes('first_link_not_checked'));
  });

  it('a ranged check whose stored predecessor is gone reports the gap', async () => {
    const db = new FakeDb(small.rows.filter((r) => r.seq !== 19), small.head);
    const report = await verifyChain(db, TENANT, { fromSeq: 20, toSeq: 29 });
    assert.equal(report.chain_intact, false);
    assert.deepEqual(pairs(report), [[19, 'seq_gap']]);
  });

  it('runs every read in one read-only snapshot when the executor can open one', async () => {
    const inner = new FakeDb(small.rows, small.head);
    const configs: unknown[] = [];
    const db = Object.assign(inner, {
      transaction: async <T>(fn: (tx: FakeDb) => Promise<T>, config?: unknown) => {
        configs.push(config);
        return fn(inner);
      },
    });
    const report = await verifyChain(db, TENANT);
    assert.equal(report.chain_intact, true);
    assert.deepEqual(configs, [{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);
  });

  it('an empty chain is clean; records without a head are a break', async () => {
    const empty = await verifyChain(new FakeDb([], null), TENANT);
    assert.equal(empty.ok, true);
    assert.equal(empty.chain_intact, true);
    assert.equal(empty.checked, 0);
    const headless = await verifyChain(new FakeDb(small.rows, null), TENANT);
    assert.equal(headless.ok, false);
    assert.ok(headless.breaks.some((b) => b.kind === 'head_mismatch'));
  });

  it('refuses a malformed tenant or page size', async () => {
    await assert.rejects(verifyChain(new FakeDb([], null), 'not-a-uuid'), RangeError);
    await assert.rejects(verifyChain(new FakeDb([], null), TENANT, { pageSize: 0 }), RangeError);
  });
});


// ---------------------------------------------------------------------------
// Anchor checks (Task15f2; SushiCorp core/evidence/verify.py anchor break kinds)
// ---------------------------------------------------------------------------

describe('anchor checks', () => {
  const ANCHORED_AT = Date.parse('2026-10-12T12:00:00.000Z'); // two hours after the fixture records

  async function anchoredWorld(n: number, maxBatch: number, at = ANCHORED_AT) {
    const key = makeTestKey();
    const chain = buildChain(n, { tenantId: TENANT, repositoryId: REPO, key });
    const rekor = new FakeRekor();
    rekor.clock = Math.floor(at / 1000);
    const tsa = await FakeTsa.create({ genTime: new Date(at) });
    const now = () => new Date(at);
    const cred = generateDevCredential('dev:anchor', ATTESTA_PLATFORM_TENANT_ID);
    const signer = anchorSignerFromAdapter(new LocalDevSigner({ credentials: [cred], env: {} }), 'dev:anchor');
    const dual = new DualAnchor(
      new RekorAnchor({ url: 'http://rekor.test', signer, fetch: rekor.fetch, production: false,
        logPublicKeyPem: createPublicKey(rekor.logKey).export({ type: 'spki', format: 'pem' }).toString(), now }),
      new TsaAnchor({ url: TSA_URL, trustAnchorsPem: tsa.anchorsPem, fetch: tsa.fetch, now }),
    );
    const rows = chain.rows.map((r) => ({ ...r, anchors: [] as StoredRecordAnchor[] }));
    for (let from = 0; from < n; from += maxBatch) {
      const records = rows.slice(from, from + maxBatch).map((r) => ({ id: `id-${r.seq}`, seq: r.seq, recordHash: r.recordHash, recordedAt: r.recordedAt }));
      const leaves = records.map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
      const batch = { batchId: anchorBatchId(TENANT, records[0].seq, records[records.length - 1].seq), seqFrom: records[0].seq,
        seqTo: records[records.length - 1].seq, leafCount: records.length, merkleRoot: `sha256:${merkleRoot(leaves).toString('hex')}` };
      const outcome = await dual.anchor(merkleRoot(leaves), batch.batchId);
      assert.equal(outcome.complete, true);
      for (const a of rowsForOutcome({ batch, records, leaves, existing: false }, outcome)) {
        const seq = Number(a.recordId.slice(3));
        rows[seq].anchors.push({ anchorType: a.anchorType, batchId: batch.batchId, proof: a.inclusionProof,
          rekorEntryUuid: a.rekorEntryUuid, tsaTokenB64: a.tsaTokenB64,
          batch: { tenantId: TENANT, seqFrom: batch.seqFrom, seqTo: batch.seqTo, leafCount: batch.leafCount, merkleRoot: batch.merkleRoot } });
      }
    }
    const material = {
      rekorLogKey: createPublicKey(rekor.logKey), anchorKeysSpkiDer: [await signer.publicKeySpkiDer()],
      tsaAnchors: loadTrustAnchors(tsa.anchorsPem),
    };
    const verify = (r: LedgerRow[], extra: Partial<AnchorCheckOptions> = {}, nowMs = at) =>
      verifyAll(r, chain.head, { keys: { [key.keyid]: key.publicKey }, anchors: { ...material, now: new Date(nowMs), ...extra } });
    return { rows, chain, material, verify, key };
  }

  const anchorKinds = (r: ChainReport) => r.breaks.map((b) => [b.seq, b.kind, b.detail_code]);

  it('every record anchored in both types: ok, with TSA revocation unknown only a warning (report version 2)', async () => {
    const w = await anchoredWorld(10, 4);
    const seen: Array<[number, string]> = [];
    const r = await w.verify(w.rows, { onRecord: (seq, s) => seen.push([seq, s]) });
    assert.equal(r.ok, true, JSON.stringify(r.breaks));
    assert.equal(r.report_version, 2);
    assert.deepEqual(r.anchors, { status: 'checked', window_ms: 3_600_000, anchored: 10, pending: 0, missing: 0, invalid: 0, not_checkable: 0 });
    assert.deepEqual(r.warnings, ['tsa_revocation_unknown']);
    assert.equal(seen.length, 10);
    assert.ok(seen.every(([, s]) => s === 'anchored'));
  });

  it('without anchor material nothing changes and the report says anchors were not checked', async () => {
    const w = await anchoredWorld(3, 4);
    const r = await verifyAll(w.rows, w.chain.head, { keys: { [w.key.keyid]: w.key.publicKey } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.anchors, { status: 'not_checked' });
    assert.deepEqual(r.warnings, []);
  });

  it('pending inside the window, ANCHOR_MISSING beyond it; one type alone is not anchored', async () => {
    const w = await anchoredWorld(4, 4);
    const bare = w.rows.map((r) => ({ ...r, anchors: [] }));
    const recorded = Date.parse(w.rows[0].recordedAt);
    let r = await w.verify(bare, {}, recorded + 3_600_000);
    assert.equal(r.ok, true);
    assert.equal(r.anchors.status === 'checked' && r.anchors.pending, 4);
    r = await w.verify(bare, {}, recorded + 3_600_004);
    assert.deepEqual(anchorKinds(r), [0, 1, 2, 3].map((s) => [s, 'anchor_missing', 'ATTESTA_VERIFY_ANCHOR_MISSING']));
    assert.equal(r.ok, false);
    assert.equal(r.chain_intact, false);
    // A record stamped ahead of the verifier's clock (beyond the skew) is never pending.
    r = await w.verify(bare, {}, recorded - 300_001);
    assert.equal(r.anchors.status === 'checked' && r.anchors.missing, 4);
    r = await w.verify(bare, {}, Date.parse(w.rows[3].recordedAt) - 300_000);
    assert.equal(r.anchors.status === 'checked' && r.anchors.pending, 4);
    const rekorOnly = w.rows.map((x) => ({ ...x, anchors: x.anchors.filter((a) => a.anchorType === 'rekor') }));
    r = await w.verify(rekorOnly, {}, recorded + 7_200_000);
    assert.equal(r.anchors.status === 'checked' && r.anchors.missing, 4);
  });

  it('missing key material is NOT_CHECKABLE (once), never ok; the chain still reads intact', async () => {
    const w = await anchoredWorld(5, 4);
    for (const extra of [{ tsaAnchors: [] }, { rekorLogKey: undefined }, { anchorKeysSpkiDer: [] }]) {
      const r = await w.verify(w.rows, extra);
      assert.equal(r.ok, false);
      assert.equal(r.chain_intact, true);
      assert.deepEqual(r.breaks.map((b) => [b.kind, b.detail_code]), [['anchor_not_checkable', 'ATTESTA_VERIFY_NOT_CHECKABLE']]);
      assert.equal(r.anchors.status === 'checked' && r.anchors.not_checkable, 5);
    }
  });

  it('every stored-row fault is a break with its exact code', async () => {
    const w = await anchoredWorld(8, 4);
    const tamper = (seq: number, type: string, f: (a: StoredRecordAnchor) => StoredRecordAnchor) =>
      w.rows.map((r) => (r.seq !== seq ? r : { ...r, anchors: r.anchors.map((a) => (a.anchorType === type ? f(structuredClone(a)) : a)) }));
    const cases: Array<[string, LedgerRow[], ChainBreakKind]> = [
      ['path edited', tamper(1, 'tsa', (a) => { (a.proof as any).merkle.path[0] = '0'.repeat(64); return a; }), 'merkle_proof_invalid'],
      // seq 1's proof moved to seq 2's row: a valid path, but for another position.
      ['proof of another position', w.rows.map((r) => (r.seq !== 2 ? r : { ...r, anchors: w.rows[1].anchors })), 'merkle_proof_invalid'],
      ['leaf_index rebound', tamper(1, 'rekor', (a) => { (a.proof as any).merkle.leaf_index = 0; return a; }), 'merkle_proof_invalid'],
      ['batch of another tenant', tamper(1, 'rekor', (a) => ({ ...a, batch: { ...a.batch!, tenantId: OTHER_TENANT } })), 'merkle_proof_invalid'],
      ['batch_id not its range', tamper(1, 'rekor', (a) => ({ ...a, batchId: anchorBatchId(TENANT, 0, 4) })), 'merkle_proof_invalid'],
      ['record outside its batch', tamper(5, 'rekor', (a) => ({ ...a, batch: { ...a.batch!, seqFrom: 0, seqTo: 3, leafCount: 4 } })), 'merkle_proof_invalid'],
      ['batch row missing', tamper(1, 'tsa', (a) => ({ ...a, batch: null })), 'merkle_proof_invalid'],
      ['rekor entry edited', tamper(1, 'rekor', (a) => { (a.proof as any).anchor.log_index += 1; return a; }), 'anchor_invalid'],
      ['tsa token swapped', tamper(1, 'tsa', (a) => ({ ...a, tsaTokenB64: w.rows[5].anchors.find((x) => x.anchorType === 'tsa')!.tsaTokenB64 })), 'anchor_invalid'],
      ['stored revoked', tamper(1, 'tsa', (a) => { (a.proof as any).anchor.revocation = { status: 'revoked', reason: 'x' }; return a; }), 'anchor_invalid'],
    ];
    for (const [name, rows, kind] of cases) {
      const r = await w.verify(rows);
      assert.equal(r.ok, false, name);
      const anchorBreaks = r.breaks.filter((b) => b.kind !== 'anchor_missing');
      assert.ok(anchorBreaks.length >= 1 && anchorBreaks.every((b) => b.kind === kind), `${name}: ${JSON.stringify(r.breaks)}`);
      assert.equal(anchorBreaks[0].detail_code, BREAK_DETAIL_CODES[kind]);
      assert.ok(r.anchors.status === 'checked' && r.anchors.invalid >= 1, name);
    }
    // A wrong anchoring key or log key: every record's Rekor row is ANCHOR_INVALID.
    const wrong = await w.verify(w.rows, { anchorKeysSpkiDer: [makeTestKey().publicKey.export({ type: 'spki', format: 'der' }) as Buffer] });
    assert.equal(wrong.anchors.status === 'checked' && wrong.anchors.invalid, 8);
    assert.ok(wrong.breaks.every((b) => b.detail_code === 'ATTESTA_VERIFY_ANCHOR_INVALID'));
  });

  it('an anchor older than the record it holds is ANCHOR_INVALID (recorded_at bound to the anchor time)', async () => {
    // Anchored "before" the records were stamped: the log and TSA clocks agree with each other, not with recorded_at.
    const w = await anchoredWorld(3, 4, Date.parse('2026-10-12T09:00:00.000Z'));
    const r = await w.verify(w.rows);
    assert.deepEqual(r.breaks.map((b) => b.kind), Array(6).fill('anchor_invalid'));
  });
});
