import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GENESIS_PREV_HASH, canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import {
  AttestaLedgerError,
  buildCanonicalRecord,
  chainStatement,
  deriveStatementColumns,
  mapLedgerDatabaseError,
  nextRecordedAt,
  parseSeq,
  validateChainInput,
  type ChainStatementInput,
  type LedgerExecutor,
} from './ledger';
import { chainInput, makeStatement, makeTestKey, shaOf, signStatement } from './testing/ledger-fixtures';

const TENANT = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const KEY = makeTestKey();
const STATEMENT = makeStatement({ repositoryId: REPO, subjectSha: shaOf('a') });

function code(fn: () => unknown, label = ""): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AttestaLedgerError, `expected AttestaLedgerError, got ${String(err)}`);
    return err.code;
  }
  assert.fail(`expected a refusal ${label}`);
}

async function asyncCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof AttestaLedgerError, `expected AttestaLedgerError, got ${String(err)}`);
    return err.code;
  }
  assert.fail("expected a refusal");
}

describe('record hash rule (independent oracle)', () => {
  it('matches a hand-computed known answer (Python hashlib)', () => {
    const canonical = buildCanonicalRecord({
      seq: 0, prev_hash: GENESIS_PREV_HASH, recorded_at: '2026-10-12T10:00:00.000Z', tenant_id: TENANT,
      record_kind: 'statement', statement_digest: 'sha256:' + 'ab'.repeat(32),
      predicate_type: 'https://trackai.dev/attesta/ai-provenance/v1', statement_kind: 'commit_observed',
      repository_id: REPO, subject_sha: 'c'.repeat(40), outbox_subject_id: null,
    });
    assert.equal(canonical,
      '{"outbox_subject_id":null,"predicate_type":"https://trackai.dev/attesta/ai-provenance/v1","prev_hash":"sha256:'
      + '0'.repeat(64) + '","record_kind":"statement","recorded_at":"2026-10-12T10:00:00.000Z","repository_id":"'
      + REPO + '","seq":0,"statement_digest":"sha256:' + 'ab'.repeat(32) + '","statement_kind":"commit_observed",'
      + '"subject_sha":"' + 'c'.repeat(40) + '","tenant_id":"' + TENANT + '"}');
    assert.equal(computeRecordHash(canonical, GENESIS_PREV_HASH),
      'sha256:6c0b4dcddbc87050fa95f285e6b5aba6e2f94fc4fee58df4651cd6bf7a5c5e09');
  });
});

describe('deriveStatementColumns', () => {
  it('derives the typed copies from the bytes', () => {
    const prevDigest = sha256Prefixed('x');
    const s = makeStatement({ repositoryId: REPO, subjectSha: shaOf(1), kind: 'pr_merged',
      previous: [{ digest: prevDigest, statement_kind: 'commit_observed' }] });
    const c = deriveStatementColumns(s);
    assert.deepEqual(c, {
      statementDigest: sha256Prefixed(Buffer.from(s, 'utf8')), predicateType: 'https://trackai.dev/attesta/ai-provenance/v1',
      statementKind: 'pr_merged', repositoryId: REPO, subjectSha: shaOf(1), previous: [prevDigest],
    });
  });

  it('refuses inconsistent or non-canonical statements', () => {
    const obj = JSON.parse(STATEMENT);
    const variants: Array<[string, string]> = [
      ['not canonical', JSON.stringify(obj, null, 1)],
      ['not JSON', '{'],
      ['predicate type', JSON.stringify({ ...obj, predicateType: 'https://example.com/other' })],
      ['two subjects', JSON.stringify({ ...obj, subject: [obj.subject[0], obj.subject[0]] })],
      ['name mismatch', JSON.stringify({ ...obj, subject: [{ ...obj.subject[0], name: `trackai:repository/${REPO}/commit/${shaOf('b')}` }] })],
      ['kind', JSON.stringify({ ...obj, predicate: { ...obj.predicate, statement_kind: 'reviewed' } })],
      ['previous digest', JSON.stringify({ ...obj, predicate: { ...obj.predicate, previous: [{ digest: 'nope' }] } })],
      ['repository id', JSON.stringify({ ...obj, predicate: { ...obj.predicate, repository: { id: 'X' } } })],
    ];
    for (const [label, text] of variants) {
      // Structural variants are re-canonicalized so only the intended defect remains.
      const raw = label === 'not canonical' || label === 'not JSON';
      const input = raw ? text : canonicalize(JSON.parse(text));
      assert.equal(code(() => deriveStatementColumns(input)), 'ATTESTA_LEDGER_GUARD_VIOLATION', label);
    }
  });
});

describe('validateChainInput', () => {
  const good = () => chainInput(TENANT, STATEMENT, KEY);

  it('accepts a consistent input and snapshots it', () => {
    const input = good();
    const snap = validateChainInput(input);
    input.signatureDer[0] ^= 0xff; // the caller mutates afterwards
    assert.notDeepEqual(snap.signatureDer, input.signatureDer);
    assert.equal(snap.columns.subjectSha, shaOf('a'));
    assert.equal(snap.outboxClaim, null);
  });

  it('refuses every inconsistency a buggy builder could pass', () => {
    const other = makeStatement({ repositoryId: REPO, subjectSha: shaOf('other') });
    const otherKey = makeTestKey();
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    const base = good();
    const cases: Array<[string, ChainStatementInput]> = [
      ['unknown field', { ...base, repositoryId: REPO } as unknown as ChainStatementInput],
      ['uppercase tenant', { ...base, tenantId: 'ABCDEF01-1111-4111-8111-111111111111' }],
      ['keyid not the key', { ...base, publicKeySpkiDer: otherKey.spki }],
      ['non-P256 key', { ...base, publicKeySpkiDer: ed, keyid: sha256Prefixed(ed),
        envelope: { ...base.envelope, signatures: [{ keyid: sha256Prefixed(ed), sig: base.envelope.signatures[0].sig }] } }],
      ['payload is another statement', { ...base, envelope: signStatement(other, KEY).envelope }],
      ['extra envelope field', { ...base, envelope: { ...base.envelope, extra: 1 } as never }],
      ['two signatures', { ...base, envelope: { ...base.envelope, signatures: [base.envelope.signatures[0], base.envelope.signatures[0]] } }],
      ['sig differs from signatureDer', { ...base, signatureDer: signStatement(STATEMENT, KEY).signatureDer }],
      ['signature over other bytes', (() => {
        const forged = signStatement(other, KEY).signatureDer;
        return { ...base, signatureDer: forged, envelope: { ...base.envelope, signatures: [{ keyid: KEY.keyid, sig: forged.toString('base64') }] } };
      })()],
      ['loose base64', { ...base, envelope: { ...base.envelope, payload: base.envelope.payload + '\n' } }],
      ['previousSeen disagrees', { ...base, previousSeen: [sha256Prefixed('x')] }],
      ['claim with a Date', { ...base, outboxClaim: { subjectId: SUBJECT_ID, claimedAt: new Date() as unknown as string, attempts: 1 } }],
      ['claim negative attempts', { ...base, outboxClaim: { subjectId: SUBJECT_ID, claimedAt: '2026-10-12T10:00:00.123456Z', attempts: -1 } }],
      ['empty credential', { ...base, credentialId: '' }],
    ];
    for (const [label, input] of cases) {
      assert.equal(code(() => validateChainInput(input), label), 'ATTESTA_LEDGER_GUARD_VIOLATION', label);
    }
  });

  it('refuses accessor properties (a getter cannot pass one value and store another)', () => {
    const input = good();
    let reads = 0;
    Object.defineProperty(input, 'keyid', { enumerable: true, get: () => (reads++ === 0 ? KEY.keyid : 'sha256:' + '0'.repeat(64)) });
    assert.equal(code(() => validateChainInput(input)), 'ATTESTA_LEDGER_GUARD_VIOLATION');
  });
});

describe('parseSeq and nextRecordedAt', () => {
  it('converts pg bigint text explicitly and refuses unsafe values', () => {
    assert.equal(parseSeq('0'), 0);
    assert.equal(parseSeq('42'), 42);
    assert.equal(parseSeq(7), 7);
    for (const bad of ['-1', '01', '1.5', 'abc', '9007199254740991', '99999999999999999', null]) {
      assert.equal(code(() => parseSeq(bad)), 'ATTESTA_LEDGER_GUARD_VIOLATION', String(bad));
    }
  });

  it('never goes back in time', () => {
    const now = new Date('2026-10-12T10:00:00.000Z');
    assert.equal(nextRecordedAt(now, null), '2026-10-12T10:00:00.000Z');
    assert.equal(nextRecordedAt(now, '2026-10-12T09:00:00.000Z'), '2026-10-12T10:00:00.000Z');
    assert.equal(nextRecordedAt(now, '2026-10-12T11:00:00.000Z'), '2026-10-12T11:00:00.000Z');
    assert.equal(code(() => nextRecordedAt(now, 'yesterday')), 'ATTESTA_LEDGER_GUARD_VIOLATION');
  });
});

describe('mapLedgerDatabaseError', () => {
  const pgErr = (c: string, constraint?: string) => Object.assign(new Error('x'), { code: c, constraint });
  it('maps guard refusals and leaves other errors alone', () => {
    assert.equal(mapLedgerDatabaseError(pgErr('ATH01'))?.code, 'ATTESTA_LEDGER_HEAD_CONFLICT');
    assert.equal(mapLedgerDatabaseError(pgErr('ATH01'))?.retryable, true);
    assert.equal(mapLedgerDatabaseError(pgErr('ATG01'))?.code, 'ATTESTA_LEDGER_GUARD_VIOLATION');
    assert.equal(mapLedgerDatabaseError(pgErr('ATG01'))?.retryable, false);
    assert.equal(mapLedgerDatabaseError(pgErr('40001'))?.code, 'ATTESTA_LEDGER_HEAD_CONFLICT');
    assert.equal(mapLedgerDatabaseError(pgErr('23505', 'attesta_records_tenant_seq_key'))?.code, 'ATTESTA_LEDGER_HEAD_CONFLICT');
    assert.equal(mapLedgerDatabaseError(pgErr('23505', 'attesta_records_tenant_statement_digest_key'))?.code, 'ATTESTA_LEDGER_GUARD_VIOLATION');
    assert.equal(mapLedgerDatabaseError(pgErr('23503', 'attesta_records_tenant_repository_fk'))?.code, 'ATTESTA_LEDGER_GUARD_VIOLATION');
    assert.equal(mapLedgerDatabaseError(Object.assign(new Error('wrapped'), { cause: pgErr('ATG01') }))?.code, 'ATTESTA_LEDGER_GUARD_VIOLATION');
    assert.equal(mapLedgerDatabaseError(pgErr('23505', 'scm_commits_pkey')), null);
    assert.equal(mapLedgerDatabaseError(pgErr('08006')), null);
    assert.equal(mapLedgerDatabaseError(new Error('plain')), null);
  });
});

// A scripted executor: each ledger query carries a /* ledger:<tag> */ comment.
type Responder = (params: unknown[]) => Array<Record<string, unknown>> | Error;
class FakeTx implements LedgerExecutor {
  calls: Array<{ tag: string; params: unknown[] }> = [];
  constructor(private readonly responders: Record<string, Responder>) {}
  async execute(query: SQL) {
    const rendered = new PgDialect().sqlToQuery(query);
    const tag = /\/\* ledger:([a-z_]+) \*\//.exec(rendered.sql)?.[1] ?? 'unknown';
    this.calls.push({ tag, params: rendered.params });
    const r = this.responders[tag];
    const out = r ? r(rendered.params) : [];
    if (out instanceof Error) throw out;
    return { rows: out };
  }
  tags() {
    return this.calls.map((c) => c.tag);
  }
}

const CLAIM = { subjectId: SUBJECT_ID, claimedAt: '2026-10-12T10:00:00.123456Z', attempts: 1 };
const claimRow = (over: Record<string, unknown> = {}) => [{
  status: 'claimed', attempts: 1, same_claim: true, repository_id: REPO, commit_sha: shaOf('a'), kind: 'commit_observed', ...over,
}];

function fresh(over: Record<string, Responder> = {}): FakeTx {
  return new FakeTx({
    head_lock: () => [{ next_seq: '0', head_hash: GENESIS_PREV_HASH }],
    claim_lock: () => claimRow(),
    claim_done: () => [{ id: SUBJECT_ID }],
    record_insert: () => [{ id: '44444444-4444-4444-8444-444444444444' }],
    ...over,
  });
}

describe('chainStatement (scripted executor)', () => {
  const clock = () => new Date('2026-10-12T10:00:00.000Z');

  it('chains the genesis record in the documented order', async () => {
    const tx = fresh();
    const result = await chainStatement(tx, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock);
    assert.deepEqual(tx.tags(), ['head_insert', 'head_lock', 'claim_lock', 'dedup', 'outbox_chained', 'previous',
      'record_insert', 'envelope_insert', 'head_advance', 'claim_done', 'commit_guard', 'commit_guard_defer']);
    const insert = tx.calls.find((c) => c.tag === 'record_insert')!;
    const canonical = insert.params.find((p) => typeof p === 'string' && p.startsWith('{"outbox_subject_id"')) as string;
    assert.ok(canonical.includes(`"outbox_subject_id":"${SUBJECT_ID}"`));
    assert.ok(canonical.includes('"recorded_at":"2026-10-12T10:00:00.000Z"'));
    assert.equal(result.seq, 0);
    assert.equal(result.duplicate, false);
    assert.equal(result.recordHash, computeRecordHash(canonical, GENESIS_PREV_HASH));
    assert.equal(result.statementDigest, sha256Prefixed(Buffer.from(STATEMENT, 'utf8')));
    const advance = tx.calls.find((c) => c.tag === 'head_advance')!;
    assert.ok(advance.params.includes(result.recordHash));
  });

  it('returns the existing record for a duplicate digest and still marks the row done', async () => {
    const tx = fresh({ dedup: () => [{ id: 'r1', seq: '5', record_hash: 'sha256:' + '1'.repeat(64) }] });
    const result = await chainStatement(tx, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock);
    assert.equal(result.duplicate, true);
    assert.equal(result.seq, 5);
    assert.ok(tx.tags().includes('claim_done'));
    assert.ok(!tx.tags().includes('record_insert'));
  });

  it('refuses a stale previous list (retry), and a list that is not a prefix (terminal)', async () => {
    const chained = sha256Prefixed('earlier');
    const stale = fresh({ previous: () => [{ statement_digest: chained }] });
    assert.equal(await asyncCode(chainStatement(stale, chainInput(TENANT, STATEMENT, KEY), clock)), 'ATTESTA_LEDGER_PREVIOUS_STALE');
    assert.ok(!stale.tags().includes('record_insert'));

    const withPrev = makeStatement({ repositoryId: REPO, subjectSha: shaOf('a'), asOf: '2026-10-12T10:00:01.000Z',
      previous: [{ digest: sha256Prefixed('never-chained'), statement_kind: 'commit_observed' }] });
    const wrong = fresh({ previous: () => [{ statement_digest: chained }] });
    assert.equal(await asyncCode(chainStatement(wrong, chainInput(TENANT, withPrev, KEY), clock)), 'ATTESTA_LEDGER_GUARD_VIOLATION');
  });

  it('detects a lost claim at lock time and at the done update', async () => {
    for (const over of [{ status: 'pending' }, { same_claim: false }, { attempts: 2 }]) {
      const tx = fresh({ claim_lock: () => claimRow(over) });
      assert.equal(await asyncCode(chainStatement(tx, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock)),
        'ATTESTA_LEDGER_CLAIM_LOST', JSON.stringify(over));
    }
    const gone = fresh({ claim_lock: () => [] });
    assert.equal(await asyncCode(chainStatement(gone, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock)), 'ATTESTA_LEDGER_CLAIM_LOST');
    const late = fresh({ claim_done: () => [] });
    assert.equal(await asyncCode(chainStatement(late, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock)), 'ATTESTA_LEDGER_CLAIM_LOST');
  });

  it('refuses a statement about a different subject than the claimed row, and a row already chained', async () => {
    for (const over of [{ commit_sha: shaOf('z') }, { repository_id: SUBJECT_ID }, { kind: 'deployed' }]) {
      const tx = fresh({ claim_lock: () => claimRow(over) });
      assert.equal(await asyncCode(chainStatement(tx, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock)),
        'ATTESTA_LEDGER_GUARD_VIOLATION', JSON.stringify(over));
    }
    const chained = fresh({ outbox_chained: () => [{ '?column?': 1 }] });
    assert.equal(await asyncCode(chainStatement(chained, chainInput(TENANT, STATEMENT, KEY, { outboxClaim: CLAIM }), clock)), 'ATTESTA_LEDGER_GUARD_VIOLATION');
  });

  it('refuses an unsafe seq from the database and clamps recorded_at', async () => {
    const unsafe = fresh({ head_lock: () => [{ next_seq: '9007199254740991', head_hash: GENESIS_PREV_HASH }] });
    assert.equal(await asyncCode(chainStatement(unsafe, chainInput(TENANT, STATEMENT, KEY), clock)), 'ATTESTA_LEDGER_GUARD_VIOLATION');

    const later = fresh({
      head_lock: () => [{ next_seq: '3', head_hash: 'sha256:' + '2'.repeat(64) }],
      last_recorded: () => [{ recorded_at: '2026-10-12T12:00:00.000Z' }],
    });
    const r = await chainStatement(later, chainInput(TENANT, STATEMENT, KEY), clock);
    assert.equal(r.seq, 3);
    const canonical = later.calls.find((c) => c.tag === 'record_insert')!.params
      .find((p) => typeof p === 'string' && p.startsWith('{"outbox_subject_id"')) as string;
    assert.ok(canonical.includes('"recorded_at":"2026-10-12T12:00:00.000Z"'));
    assert.ok(canonical.includes('"prev_hash":"sha256:' + '2'.repeat(64) + '"'));
  });

  it('maps a guard refusal raised by the database', async () => {
    const tx = fresh({ record_insert: () => Object.assign(new Error('head moved'), { code: 'ATH01' }) });
    const err = await chainStatement(tx, chainInput(TENANT, STATEMENT, KEY), clock).catch((e) => e);
    assert.ok(err instanceof AttestaLedgerError);
    assert.equal(err.code, 'ATTESTA_LEDGER_HEAD_CONFLICT');
    assert.ok(!String(err.message).includes(STATEMENT.slice(0, 20)));
    const other = fresh({ record_insert: () => Object.assign(new Error('connection lost'), { code: '08006' }) });
    const passthrough = await chainStatement(other, chainInput(TENANT, STATEMENT, KEY), clock).catch((e) => e);
    assert.ok(!(passthrough instanceof AttestaLedgerError));
  });
});
