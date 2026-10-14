/**
 * Task15i4 period-report job (no database): the run on a memory store with the real dev
 * signer and the real ledger input validation, the retry on a stale `previous`, the failure
 * codes, and request parsing.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { sha256Prefixed } from './canonical';
import { AttestaLedgerError, validateChainInput } from './ledger';
import { checkPeriodReport, type ReportInput, type ReportScope } from './period-report-rules';
import {
  documentBody, parseReportRequest, runQueuedReports, parseStoredReportScope, reportStatusBody, runPeriodReport, sameReportRequest,
  type ChainReportInput, type ReportJob, type ReportJobDeps, type ReportSnapshot, type ReportStore,
} from './period-report-service';
import { AttestaQueryError } from './read-service';
import { devSignerResolver } from './signer-resolver';
import { input, reportStatement } from './testing/period-report-fixtures';

const T = 'aaaaaaaa-0000-4000-8000-00000000000a';
const R = 'cccccccc-0000-4000-8000-0000000000c1';
const ID = '11111111-0000-4000-8000-000000000001';
const sha = (l: string) => createHash('sha1').update(l).digest('hex');
const SCOPE: ReportScope = { repository_id: R, from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z', basis: 'recorded_at' };
const NOW = new Date('2026-10-14T08:00:00.000Z');
const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const signer = devSignerResolver({ sharedKeyPem: pem, env: {} });

const INPUTS: ReportInput[] = [
  input(1, reportStatement({ kind: 'commit_observed', repositoryId: R, sha: sha('a'), asOf: '2026-10-02T00:00:00.000Z', lines: { ai: 3, human: 1, added: 4, deleted: 0 } })),
  input(3, reportStatement({ kind: 'pr_merged', repositoryId: R, sha: sha('m'), asOf: '2026-10-03T00:00:00.000Z', mergedAiLines: 3, models: [['claude-code', 'opus', 3]] })),
];

class MemoryStore implements ReportStore {
  job: ReportJob = {
    id: ID, tenantId: T, idempotencyKey: 'key-00001', repositoryId: R, scope: { repository_id: R, from: SCOPE.from, to: SCOPE.to },
    status: 'queued', requestedBy: 'admin', requestId: 'req-1', attempts: 0, reportDigest: null, statementDigest: null, recordId: null,
    errorCode: null, createdAt: '2026-10-14T07:59:00.000Z', finishedAt: null,
  };
  doc: string | null = null;
  chained: ChainReportInput[] = [];
  snapshots = 0;
  staleOnce = false;
  previous: string[] = [];
  async createOrGet() { return { job: this.job, created: true }; }
  async get(tenantId: string, id: string) { return tenantId === T && id === ID ? { ...this.job } : null; }
  async findByKey() { return null; }
  async document() { return this.doc; }
  async openCount() { return 0; }
  async repositoryExists() { return true; }
  async inputCount() { return INPUTS.length; }
  async claim() {
    if (this.job.status !== 'queued') return null;
    this.job.status = 'running';
    this.job.attempts += 1;
    return this.job.attempts;
  }
  async readSnapshot(): Promise<ReportSnapshot> {
    this.snapshots += 1;
    return { asOf: NOW.toISOString(), chainRange: { from_seq: 0, to_seq: 4, to_record_hash: 'sha256:' + 'e'.repeat(64) }, inputs: INPUTS, previous: [...this.previous] };
  }
  async chainReady(_t: string, _id: string, attempts: number, i: ChainReportInput) {
    if (this.job.status !== 'running' || attempts !== this.job.attempts) return null;
    // The real ledger input checks: canonical bytes, the envelope over them, the signature.
    validateChainInput({ tenantId: T, statementCanonical: i.statementCanonical, envelope: i.envelope, credentialId: i.credentialId,
      keyid: i.keyid, signatureDer: i.signatureDer, publicKeySpkiDer: i.publicKeySpkiDer, previousSeen: i.previousSeen });
    if (this.staleOnce) {
      this.staleOnce = false;
      this.previous = [sha256Prefixed('a report chained meanwhile')];
      throw new AttestaLedgerError('ATTESTA_LEDGER_PREVIOUS_STALE', 'stale');
    }
    this.chained.push(i);
    this.doc = i.documentText;
    Object.assign(this.job, { status: 'ready', reportDigest: i.documentDigest, statementDigest: sha256Prefixed(i.statementCanonical),
      recordId: '22222222-0000-4000-8000-000000000002', finishedAt: NOW.toISOString() });
    return { recordId: this.job.recordId!, seq: 5 };
  }
  async finishFailed(_t: string, _id: string, _a: number | null, code: string) {
    Object.assign(this.job, { status: 'failed', errorCode: code });
    return true;
  }
  async runnable(): Promise<Array<{ tenantId: string; id: string }>> { return []; }
  async audit() {}
}

const deps = (store: ReportStore, over: Partial<ReportJobDeps> = {}): ReportJobDeps => ({
  store, resolver: async () => signer, builderVersion: () => '0.1.0+3c862ef', log: () => undefined, ...over,
});

describe('T15i4 period-report job', () => {
  test('claims, builds from the snapshot, signs, chains with the document, and is ready', async () => {
    const store = new MemoryStore();
    assert.equal(await runPeriodReport(deps(store), T, ID), 'ready');
    const c = store.chained[0];
    const statement = JSON.parse(c.statementCanonical);
    assert.equal(statement.predicateType, 'https://trackai.dev/attesta/period-report/v1');
    assert.equal(c.documentDigest, sha256Prefixed(c.documentText));
    assert.deepEqual(checkPeriodReport({ statement, documentText: c.documentText, tenantId: T, inputs: INPUTS }), []);
    assert.equal(documentBody(store.job, store.doc), c.documentText);
    const body = reportStatusBody(store.job);
    assert.equal(body.statement_digest, sha256Prefixed(c.statementCanonical));
    assert.equal(body.document_path, `/api/attesta/period-reports/${ID}/document`);
    assert.equal(await runPeriodReport(deps(store), T, ID), 'not_claimed');
  });

  test('a report chained meanwhile for the same scope rebuilds once and lists it in previous', async () => {
    const store = new MemoryStore();
    store.staleOnce = true;
    assert.equal(await runPeriodReport(deps(store), T, ID), 'ready');
    assert.equal(store.snapshots, 2);
    assert.deepEqual(JSON.parse(store.chained[0].statementCanonical).predicate.previous, [{ digest: sha256Prefixed('a report chained meanwhile') }]);
    assert.deepEqual(store.chained[0].previousSeen, [sha256Prefixed('a report chained meanwhile')]);
  });

  test('failures end the job with one code and never a ready row', async () => {
    const cases: Array<[Partial<ReportJobDeps>, string]> = [
      [{ resolver: async () => ({ resolve: async () => null }) }, 'ATTESTA_SIGNER_NO_CREDENTIAL'],
      [{ resolver: async () => { throw new Error('kms config'); } }, 'ATTESTA_SIGNER_UNAVAILABLE'],
      [{ builderVersion: () => 'not-a-version' }, 'ATTESTA_BUILDER_SCHEMA_INVALID'],
    ];
    for (const [over, code] of cases) {
      const store = new MemoryStore();
      assert.equal(await runPeriodReport(deps(store, over), T, ID), 'failed');
      assert.equal(store.job.errorCode, code);
      assert.equal(store.doc, null);
    }
    const store = new MemoryStore();
    store.readSnapshot = async () => ({ asOf: NOW.toISOString(), chainRange: { from_seq: 0, to_seq: 1, to_record_hash: 'sha256:' + 'e'.repeat(64) },
      inputs: [{ ...INPUTS[0], canonical: INPUTS[0].canonical.replace('"ai":3', '"ai":4') }], previous: [] });
    assert.equal(await runPeriodReport(deps(store), T, ID), 'failed');
    assert.equal(store.job.errorCode, 'ATTESTA_BUILDER_RULE_VIOLATION', 'a statement that does not hash to its digest');
  });

  test('recovery runs each queued or stranded job once', async () => {
    const store = new MemoryStore();
    store.runnable = async () => [{ tenantId: T, id: ID }];
    assert.deepEqual(await runQueuedReports(deps(store)), [{ id: ID, result: 'ready' }]);
    assert.deepEqual(await runQueuedReports(deps(store)), [{ id: ID, result: 'not_claimed' }]);
  });

  test('a stored document that does not match its digest is never served', () => {
    const job = { ...new MemoryStore().job, status: 'ready' as const, reportDigest: sha256Prefixed('{"a":1}') };
    assert.equal(documentBody(job, '{"a":1}'), '{"a":1}');
    assert.throws(() => documentBody(job, '{"a":2}'));
  });
});

describe('T15i4 period-report requests', () => {
  test('accepts {repository_id, from, to}, normalizes to UTC ms, and compares scopes', () => {
    const r = parseReportRequest({ repository_id: R, from: '2026-10-01T05:30:00.0001+05:30', to: '2026-10-07T23:59:59.999Z' }, NOW);
    assert.deepEqual(r.scope, { repository_id: R, from: '2026-10-01T00:00:00.001Z', to: '2026-10-07T23:59:59.999Z', basis: 'recorded_at' });
    assert.equal(sameReportRequest(r, { repository_id: R, from: '2026-10-01T00:00:00.001Z', to: '2026-10-07T23:59:59.999Z' }), true);
    assert.equal(sameReportRequest(r, { repository_id: R, from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }), false);
    assert.deepEqual(parseStoredReportScope({ repository_id: R, from: r.scope.from, to: r.scope.to }), r.scope);
  });

  test('refuses anything else', () => {
    const bad: unknown[] = [
      null, [], {}, { repository_id: R, from: SCOPE.from }, { repository_id: 'R', from: SCOPE.from, to: SCOPE.to },
      { from: SCOPE.from, to: SCOPE.to }, { repository_id: R, from: SCOPE.to, to: SCOPE.from },
      { repository_id: R, from: SCOPE.from, to: '2026-10-14T07:58:00.000Z' },
      { repository_id: R, from: SCOPE.from, to: SCOPE.to, mode: 'full' }, { repository_id: R, from: '2026-10-01', to: SCOPE.to },
    ];
    for (const b of bad) assert.throws(() => parseReportRequest(b, NOW), AttestaQueryError, JSON.stringify(b));
    assert.throws(() => parseStoredReportScope({ repository_id: R, from: SCOPE.from, to: SCOPE.to, extra: 1 }));
  });
});
