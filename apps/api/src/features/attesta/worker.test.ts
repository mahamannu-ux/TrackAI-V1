import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AttestaBuilderError, type AttestaBuilderErrorCode, type BuiltStatement } from './builder';
import { sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae } from './dsse';
import { AttestaLedgerError, type AttestaLedgerErrorCode, type ChainStatementInput } from './ledger';
import { SigningRejected, SigningUnavailable, type SigningAdapter } from './signer-contract';
import { generateDevCredential } from './signer-local-dev';
import { devSignerResolver, type SignerResolver } from './signer-resolver';
import {
  backoffMs, classifyError, requeueFailedSubjects, RequeueScopeChanged, runBuilderPass, type BuilderPassOptions, type WorkerDatabase, type WorkerExecutor,
} from './worker';

const TENANT = '00000000-0000-4000-8000-0000000000f1';
const REPO = '00000000-0000-4000-8000-000000000001';
const SHA = '3f2a9c4e1b7d6a5f8e0c2b4d6f8a1c3e5b7d9f0a';
const dialect = new PgDialect();

interface OutboxRow {
  id: string; status: string; attempts: number; claimed_at: string | null; last_error_code: string | null;
  not_before_delay_s: number | null; processed: boolean;
}

/** An in-memory attesta_subjects for the worker's own statements. */
class FakeDb implements WorkerDatabase {
  rows = new Map<string, OutboxRow>();
  audits: Array<{ params: unknown[] }> = [];
  txConfigs: unknown[] = [];
  recoverFail: string[] = [];
  recover: string[] = [];
  claimSql = '';
  claimParams: unknown[] = [];
  private claimCounter = 0;

  add(id: string, over: Partial<OutboxRow> = {}) {
    this.rows.set(id, { id, status: 'pending', attempts: 0, claimed_at: null, last_error_code: null,
      not_before_delay_s: null, processed: false, ...over });
  }

  async execute(query: SQL) {
    const { sql: text, params } = dialect.sqlToQuery(query);
    const tag = /\/\* worker:(\w+) \*\//.exec(text)?.[1];
    const byId = () => [...this.rows.values()].find((r) => params.includes(r.id));
    switch (tag) {
      case 'recover_fail': return { rows: this.recoverFail.map((id) => ({ id })) };
      case 'recover': return { rows: this.recover.map((id) => ({ id })) };
      case 'claim': {
        this.claimSql = text;
        this.claimParams = params;
        const limit = params[params.length - 1] as number;
        const out = [...this.rows.values()].filter((r) => r.status === 'pending').slice(0, limit).map((r) => {
          this.claimCounter += 1;
          r.status = 'claimed';
          r.attempts += 1;
          r.claimed_at = `2026-10-12T10:00:00.${String(100000 + this.claimCounter)}Z`;
          return {
            id: r.id, tenant_id: TENANT, repository_id: REPO, kind: 'commit_observed', metric_event_id: r.id,
            commit_id: r.id, commit_sha: SHA, provider: null, provider_delivery_id: null, pull_request_id: null,
            deployment_id: null, deployment_external_id: null, event_at: '2026-10-12T09:00:00.000Z',
            claimed_at: r.claimed_at, attempts: r.attempts, created_at: `2026-10-12T08:00:00.${r.id.slice(-6)}Z`,
          };
        });
        return { rows: out.reverse() }; // RETURNING order is not guaranteed; the worker sorts
      }
      case 'retry':
      case 'fail': {
        const r = byId();
        assert.ok(params.includes(TENANT), 'release is tenant-bound');
        if (!r || r.status !== 'claimed' || !params.includes(r.claimed_at) || !params.includes(r.attempts)) return { rows: [] };
        r.last_error_code = params[0] as string;
        if (tag === 'retry') {
          // params: code, refunded attempts (0/1), backoff seconds, then the guard.
          r.status = 'pending'; r.claimed_at = null; r.attempts -= params[1] as number; r.not_before_delay_s = params[2] as number;
        } else { r.status = 'failed'; r.processed = true; }
        return { rows: [{ id: r.id }] };
      }
      case 'requeue_count':
        return { rows: [{ n: [...this.rows.values()].filter((r) => r.status === 'failed' && r.last_error_code === params[1]).length }] };
      case 'requeue': {
        const moved = [...this.rows.values()].filter((r) => r.status === 'failed' && r.last_error_code === params[1]);
        for (const r of moved) { r.status = 'pending'; r.processed = false; r.claimed_at = null; }
        return { rows: moved.map((r) => ({ id: r.id })) };
      }
      case 'requeue_audit': this.audits.push({ params }); return { rows: [] };
      default: throw new Error(`unexpected worker query: ${text.slice(0, 50)}`);
    }
  }

  commitError: unknown = null;

  async transaction<T>(fn: (tx: WorkerExecutor) => Promise<T>, config?: unknown): Promise<T> {
    this.txConfigs.push(config ?? null);
    const saved = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
    const savedAudits = this.audits.length;
    try {
      const out = await fn(this);
      if (this.commitError && config === undefined) { const e = this.commitError; this.commitError = null; throw e; }
      return out;
    } catch (err) {
      if (config === undefined) { // a write transaction rolls back (in place)
        for (const [id, before] of saved) Object.assign(this.rows.get(id)!, before);
        this.audits.length = savedAudits;
      }
      throw err;
    }
  }
}

const canonical = '{"statement":"synthetic"}';
const built: BuiltStatement = { statement: {}, canonical, digest: sha256Prefixed(canonical), previousSeen: [] };

function setup(rows = 1, over: Partial<BuilderPassOptions> = {}) {
  const db = new FakeDb();
  for (let i = 0; i < rows; i += 1) db.add(`00000000-0000-4000-8000-00000000010${i}`);
  const chained: ChainStatementInput[] = [];
  const options: BuilderPassOptions = {
    limit: 10, maxAttempts: 3, builderVersion: '0.1.0+88301f7',
    deps: {
      build: async () => built,
      chain: async (_tx, input) => {
        chained.push(input);
        return { recordId: 'r', seq: chained.length - 1, recordHash: 'h', statementDigest: built.digest, duplicate: false };
      },
    },
    ...over,
  };
  const resolver = devSignerResolver({ credentials: [generateDevCredential('dev:t', TENANT)], env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv });
  return { db, chained, options, resolver };
}

test('T15h worker: success signs the PAE bytes and chains against the exact claim', async () => {
  const { db, chained, options, resolver } = setup(2);
  const result = await runBuilderPass(db, resolver, options);
  assert.equal(result.claimed, 2);
  assert.equal(result.done, 2);
  assert.equal(chained.length, 2);
  // Rows are processed in created_at order whatever order RETURNING gave.
  assert.deepEqual(chained.map((c) => c.outboxClaim!.subjectId), [...db.rows.keys()]);
  const input = chained[0];
  const row = db.rows.get(input.outboxClaim!.subjectId)!;
  assert.equal(input.outboxClaim!.claimedAt, row.claimed_at); // microseconds, as stored
  assert.equal(input.outboxClaim!.attempts, 1);
  assert.equal(input.statementCanonical, canonical);
  assert.equal(input.envelope.payload, Buffer.from(canonical).toString('base64'));
  assert.equal(input.envelope.payloadType, IN_TOTO_PAYLOAD_TYPE);
  assert.equal(input.keyid, sha256Prefixed(input.publicKeySpkiDer));
  assert.equal(input.envelope.signatures[0].keyid, input.keyid);
  const key = createPublicKey({ key: input.publicKeySpkiDer, format: 'der', type: 'spki' });
  assert.ok(verify('sha256', pae(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonical)), { key, dsaEncoding: 'der' }, input.signatureDer));
  assert.equal(input.credentialId, 'dev:t');
  // The build ran in a repeatable-read, read-only transaction; the chain in its own.
  assert.deepEqual(db.txConfigs[0], { isolationLevel: 'repeatable read', accessMode: 'read only' });
  assert.equal(db.txConfigs[1], null);
});

test('T15h worker: a duplicate digest counts as done (row marked done by the ledger)', async () => {
  const { db, options, resolver } = setup(1, {});
  options.deps!.chain = async () => ({ recordId: 'r', seq: 0, recordHash: 'h', statementDigest: built.digest, duplicate: true });
  const result = await runBuilderPass(db, resolver, options);
  assert.equal(result.duplicates, 1);
  assert.equal(result.codes.ATTESTA_LEDGER_DUPLICATE_STATEMENT, 1);
});

test('T15h worker: no credential fails the row with ATTESTA_SIGNER_NO_CREDENTIAL, nothing built', async () => {
  const { db, options } = setup(1);
  let built = 0;
  options.deps!.build = async () => { built += 1; throw new Error('unreachable'); };
  const none: SignerResolver = { resolve: async () => null };
  const result = await runBuilderPass(db, none, options);
  const row = [...db.rows.values()][0];
  assert.equal(result.failed, 1);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error_code, 'ATTESTA_SIGNER_NO_CREDENTIAL');
  assert.equal(built, 0);
});

function adapterThatThrows(err: Error): SignerResolver {
  const adapter: SigningAdapter = {
    capabilities: () => ({ adapterName: 'x', algorithms: ['ES256'], maxPayloadBytes: 1000, supportsCredentialListing: false }),
    sign: async () => { throw err; },
    listCredentials: async () => [],
    publicKey: async () => { throw err; },
    health: async () => true,
  };
  return { resolve: async () => ({ adapter, credentialId: 'kms:1' }) };
}

test('T15h worker: SigningUnavailable → pending with backoff; SigningRejected → failed', async () => {
  const a = setup(1);
  const r1 = await runBuilderPass(a.db, adapterThatThrows(new SigningUnavailable('down')), a.options);
  const row = [...a.db.rows.values()][0];
  assert.equal(r1.retried, 1);
  assert.equal(row.status, 'pending');
  assert.equal(row.claimed_at, null);
  assert.equal(row.last_error_code, 'ATTESTA_SIGNER_UNAVAILABLE');
  assert.equal(row.not_before_delay_s, backoffMs(1) / 1000);
  // Second attempt backs off twice as long.
  await runBuilderPass(a.db, adapterThatThrows(new SigningUnavailable('down')), a.options);
  assert.equal(row.not_before_delay_s, backoffMs(2) / 1000);
  const b = setup(1);
  const r2 = await runBuilderPass(b.db, adapterThatThrows(new SigningRejected('revoked')), b.options);
  assert.equal(r2.failed, 1);
  assert.equal([...b.db.rows.values()][0].last_error_code, 'ATTESTA_SIGNER_REJECTED');
});

test('T15h worker: a retryable failure at the attempt limit becomes failed (visible, not endless)', async () => {
  const { db, options, resolver } = setup(1, { maxAttempts: 2 });
  options.deps!.build = async () => { throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'queued'); };
  await runBuilderPass(db, resolver, options);
  const row = [...db.rows.values()][0];
  assert.equal(row.status, 'pending');
  const second = await runBuilderPass(db, resolver, options);
  assert.equal(second.failed, 1);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(row.last_error_code, 'ATTESTA_BUILDER_SOURCE_NOT_READY');
});

test('T15h worker: every builder and ledger code maps to its protocol outcome', async () => {
  const builderTerminal: AttestaBuilderErrorCode[] = ['ATTESTA_BUILDER_SOURCE_MISSING', 'ATTESTA_BUILDER_NOT_CANONICAL',
    'ATTESTA_BUILDER_SCHEMA_INVALID', 'ATTESTA_BUILDER_RULE_VIOLATION', 'ATTESTA_BUILDER_TOO_LARGE'];
  for (const code of builderTerminal) {
    const { db, options, resolver } = setup(1);
    options.deps!.build = async () => { throw new AttestaBuilderError(code, 'x'); };
    await runBuilderPass(db, resolver, options);
    const row = [...db.rows.values()][0];
    assert.deepEqual([row.status, row.last_error_code], ['failed', code], code);
  }
  const ledger: Array<[AttestaLedgerErrorCode, string]> = [
    ['ATTESTA_LEDGER_PREVIOUS_STALE', 'pending'], ['ATTESTA_LEDGER_HEAD_CONFLICT', 'pending'],
    ['ATTESTA_LEDGER_GUARD_VIOLATION', 'failed'],
  ];
  for (const [code, status] of ledger) {
    const { db, options, resolver } = setup(1);
    options.deps!.chain = async () => { throw new AttestaLedgerError(code, 'x'); };
    await runBuilderPass(db, resolver, options);
    const row = [...db.rows.values()][0];
    assert.deepEqual([row.status, row.last_error_code], [status, code], code);
  }
});

test('T15h worker: CLAIM_LOST stops the row and changes nothing', async () => {
  const { db, options, resolver } = setup(1);
  options.deps!.chain = async () => { throw new AttestaLedgerError('ATTESTA_LEDGER_CLAIM_LOST', 'x'); };
  const result = await runBuilderPass(db, resolver, options);
  const row = [...db.rows.values()][0];
  assert.equal(result.claimLost, 1);
  assert.equal(row.status, 'claimed');
  assert.equal(row.last_error_code, null);
});

test('T15h worker: a release whose claim moved on changes nothing', async () => {
  const { db, options, resolver } = setup(1);
  options.deps!.build = async (_tx, row) => {
    db.rows.get(row.id)!.claimed_at = '2026-10-12T11:00:00.000001Z'; // another worker re-claimed it
    throw new AttestaBuilderError('ATTESTA_BUILDER_SCHEMA_INVALID', 'x');
  };
  const result = await runBuilderPass(db, resolver, options);
  assert.equal(result.claimLost, 1);
  assert.equal([...db.rows.values()][0].status, 'claimed');
});

test('T15h worker: an unexpected error (crash) leaves the row claimed for lease recovery', async () => {
  const { db, options, resolver } = setup(1, { hooks: { afterSign: async () => { throw new Error('killed'); } } });
  const result = await runBuilderPass(db, resolver, options);
  assert.equal(result.leftClaimed, 1);
  assert.equal(result.codes.unexpected_error, 1);
  assert.equal([...db.rows.values()][0].status, 'claimed');
});

test('T15h worker: recovery counts and option bounds', async () => {
  const { db, options, resolver } = setup(0);
  db.recover = ['a', 'b'];
  db.recoverFail = ['c'];
  const result = await runBuilderPass(db, resolver, options);
  assert.deepEqual([result.recovered, result.recoveredFailed, result.claimed], [2, 1, 0]);
  await assert.rejects(runBuilderPass(db, resolver, { ...options, limit: 0 }), RangeError);
  await assert.rejects(runBuilderPass(db, resolver, { ...options, maxAttempts: 0 }), RangeError);
  await assert.rejects(runBuilderPass(db, resolver, { ...options, leaseMs: -1 }), RangeError);
});

test('T15h worker: classifyError and backoff', () => {
  assert.deepEqual(classifyError(new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'x')),
    { action: 'retry', code: 'ATTESTA_BUILDER_SOURCE_NOT_READY', wait: false });
  assert.deepEqual(classifyError(new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'x', { wait: true })),
    { action: 'retry', code: 'ATTESTA_BUILDER_SOURCE_NOT_READY', wait: true });
  // wait only applies to the retryable code.
  assert.equal(new AttestaBuilderError('ATTESTA_BUILDER_TOO_LARGE', 'x', { wait: true }).wait, false);
  assert.deepEqual(classifyError(new SigningUnavailable('x')), { action: 'retry', code: 'ATTESTA_SIGNER_UNAVAILABLE' });
  assert.deepEqual(classifyError(new SigningRejected('x')), { action: 'fail', code: 'ATTESTA_SIGNER_REJECTED' });
  assert.deepEqual(classifyError(new AttestaLedgerError('ATTESTA_LEDGER_CLAIM_LOST', 'x')), { action: 'stop', code: 'ATTESTA_LEDGER_CLAIM_LOST' });
  assert.deepEqual(classifyError(new TypeError('x')), { action: 'leave_claimed', code: 'unexpected_error' });
  assert.deepEqual([1, 2, 3, 8, 50].map((a) => backoffMs(a)), [30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
});

test('T15h re-queue: dry-run counts only; confirm moves failed rows and writes one audit row', async () => {
  const db = new FakeDb();
  db.add('00000000-0000-4000-8000-000000000201', { status: 'failed', attempts: 3, last_error_code: 'ATTESTA_SIGNER_NO_CREDENTIAL', processed: true });
  db.add('00000000-0000-4000-8000-000000000202', { status: 'failed', attempts: 1, last_error_code: 'ATTESTA_SIGNER_NO_CREDENTIAL', processed: true });
  db.add('00000000-0000-4000-8000-000000000203', { status: 'failed', attempts: 1, last_error_code: 'ATTESTA_BUILDER_TOO_LARGE', processed: true });
  const input = { tenantId: TENANT, code: 'ATTESTA_SIGNER_NO_CREDENTIAL', actorId: 'founder-cli', confirm: false };
  assert.deepEqual(await requeueFailedSubjects(db, input), { dryRun: true, matched: 2, requeued: 0 });
  assert.equal(db.audits.length, 0);
  assert.ok([...db.rows.values()].every((r) => r.status === 'failed'));
  assert.deepEqual(await requeueFailedSubjects(db, { ...input, confirm: true }), { dryRun: false, matched: 2, requeued: 2 });
  const statuses = [...db.rows.values()].map((r) => [r.status, r.attempts]);
  assert.deepEqual(statuses, [['pending', 3], ['pending', 1], ['failed', 1]]); // attempts kept
  assert.equal(db.audits.length, 1);
  const params = db.audits[0].params;
  assert.ok(params.includes('founder-cli') && params.includes(TENANT));
  const details = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('{')) as string);
  assert.deepEqual(details, { code: 'ATTESTA_SIGNER_NO_CREDENTIAL', count: 2 });
  await assert.rejects(requeueFailedSubjects(db, { ...input, tenantId: 'x' }), RangeError);
  await assert.rejects(requeueFailedSubjects(db, { ...input, code: 'free text' }), RangeError);
  await assert.rejects(requeueFailedSubjects(db, { ...input, actorId: 'me@example.com' }), RangeError);
});

test('T15h worker: an ordering wait is retried without spending an attempt, past the limit', async () => {
  const { db, options, resolver } = setup(1, { maxAttempts: 1 });
  options.deps!.build = async () => {
    throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'queued', { wait: true });
  };
  for (let i = 0; i < 3; i += 1) {
    const r = await runBuilderPass(db, resolver, options);
    assert.equal(r.retried, 1);
  }
  const row = [...db.rows.values()][0];
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ['pending', 0, 'ATTESTA_BUILDER_SOURCE_NOT_READY']);
  assert.equal(row.not_before_delay_s, backoffMs(1) / 1000);
});

test('T15h worker: errors raised at COMMIT are mapped to ledger codes', async () => {
  for (const [pgCode, status, code] of [['40001', 'pending', 'ATTESTA_LEDGER_HEAD_CONFLICT'], ['ATG01', 'failed', 'ATTESTA_LEDGER_GUARD_VIOLATION']]) {
    const { db, options, resolver } = setup(1);
    db.commitError = Object.assign(new Error('commit refused'), { code: pgCode });
    await runBuilderPass(db, resolver, options);
    const row = [...db.rows.values()][0];
    assert.deepEqual([row.status, row.last_error_code], [status, code], pgCode);
  }
});

test('T15h worker: the claim is a materialized CTE limited to the known kinds', async () => {
  const { db, options, resolver } = setup(1);
  await runBuilderPass(db, resolver, options);
  assert.match(db.claimSql, /with picked as materialized \(/);
  assert.match(db.claimSql, /for update skip locked/);
  assert.deepEqual(db.claimParams.slice(0, 3), ['commit_observed', 'pr_merged', 'deployed']);
});

test('T15h worker: with the real builder the frozen schemas are compiled before claiming', async () => {
  const { db, options, resolver } = setup(1);
  // No build stub: statementValidator() compiles from docs/contracts first, then the real
  // builder runs against this fake (which knows no builder queries), an unexpected error.
  const r = await runBuilderPass(db, resolver, { ...options, deps: { chain: options.deps!.chain } });
  assert.equal(r.claimed, 1);
  assert.equal(r.codes.unexpected_error, 1);
  assert.equal([...db.rows.values()][0].status, 'claimed');
});

test('T15h re-queue: a confirm whose count changed since the dry-run changes nothing', async () => {
  const db = new FakeDb();
  db.add('00000000-0000-4000-8000-000000000201', { status: 'failed', attempts: 1, last_error_code: 'ATTESTA_SIGNER_NO_CREDENTIAL', processed: true });
  db.add('00000000-0000-4000-8000-000000000202', { status: 'failed', attempts: 1, last_error_code: 'ATTESTA_SIGNER_NO_CREDENTIAL', processed: true });
  const input = { tenantId: TENANT, code: 'ATTESTA_SIGNER_NO_CREDENTIAL', actorId: 'founder-cli', confirm: true, expect: 1 };
  await assert.rejects(requeueFailedSubjects(db, input), RequeueScopeChanged);
  assert.ok([...db.rows.values()].every((r) => r.status === 'failed'));
  assert.equal(db.audits.length, 0);
  assert.deepEqual(await requeueFailedSubjects(db, { ...input, expect: 2 }), { dryRun: false, matched: 2, requeued: 2 });
  await assert.rejects(requeueFailedSubjects(db, { ...input, expect: -1 }), RangeError);
});
