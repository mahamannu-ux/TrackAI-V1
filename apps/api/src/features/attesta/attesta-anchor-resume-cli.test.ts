/**
 * attesta:anchor-resume (Task15i3): dry run, apply, refusals, one resume per stop, and a
 * new terminal failure needing a new resume. The memory store mirrors the 0021 guard and
 * pgResumeStore's state query; IT-T15i3-03/04 prove the real SQL. One clock (T0).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESUME_AUDIT_ACTION, parseResumeArgs, resumeVerdict, runAnchorResumeCli,
  type ResumeBatchState, type ResumeInput, type ResumeStore,
} from './attesta-anchor-resume-cli';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const BATCH = `${A}:0-2`;

interface Failure { at: number; code: string }
class MemResumeStore implements ResumeStore {
  clock = T0;
  batches = new Map<string, { tenantId: string; seqFrom: number; seqTo: number; failures: Failure[]; anchored: boolean }>();
  resumes: Array<ResumeInput & { at: number }> = [];
  audits: Array<{ tenantId: string; action: string; actor: string; target: string; details: Record<string, unknown> }> = [];

  add(tenantId: string, batchId: string, failures: Failure[] = [], anchored = false): void {
    const [, range] = batchId.split(':');
    const [from, to] = range.split('-').map(Number);
    this.batches.set(batchId, { tenantId, seqFrom: from, seqTo: to, failures, anchored });
  }

  /** The worker's rule (anchor-worker.ts stoppedBatch): a terminal failure newer than the latest resume. */
  private state(tenantId: string, batchId: string) {
    const b = this.batches.get(batchId);
    if (!b || b.tenantId !== tenantId) return null;
    const lastAt = b.failures.length ? Math.max(...b.failures.map((f) => f.at)) : null;
    const lastResume = Math.max(-Infinity, ...this.resumes.filter((r) => r.tenantId === tenantId && r.batchId === batchId).map((r) => r.at));
    const terminals = b.failures.filter((f) => ['ATTESTA_ANCHOR_LOG_REJECTED', 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED'].includes(f.code));
    const open = terminals.filter((f) => f.at > lastResume).sort((x, y) => y.at - x.at);
    return { b, lastAt, terminal: open[0], everTerminal: terminals.length > 0 };
  }

  async batchState(tenantId: string, batchId: string): Promise<ResumeBatchState | null> {
    const s = this.state(tenantId, batchId);
    if (!s) return null;
    return {
      batchId, seqFrom: s.b.seqFrom, seqTo: s.b.seqTo, leafCount: s.b.seqTo - s.b.seqFrom + 1, complete: s.b.anchored,
      lastFailedAt: s.lastAt === null ? null : new Date(s.lastAt).toISOString(), terminalCode: s.terminal?.code ?? null,
      everTerminal: s.everTerminal,
    };
  }

  /** The 0021 guard, then the audit row, all or nothing. */
  async applyResume(input: ResumeInput): Promise<{ resumedAt: string }> {
    const guard = (m: string) => Object.assign(new Error(`attesta_anchor_resumes: ${m}`), { code: 'ATG01' });
    const s = this.state(input.tenantId, input.batchId);
    if (!s) throw guard('no such batch for this tenant');
    if (s.b.anchored) throw guard('the batch is anchored');
    if (!s.everTerminal) throw guard('the batch is not stopped by a terminal code');
    if (!s.terminal) throw guard('this stop was already resumed');
    const at = this.clock + 1; // clock_timestamp(): after every failure the statement sees
    this.resumes.push({ ...input, at });
    this.audits.push({ tenantId: input.tenantId, action: RESUME_AUDIT_ACTION, actor: input.actor, target: input.batchId,
      details: { request_id: input.requestId, terminal_code: input.terminalCode, records: input.records, reason: input.reason } });
    return { resumedAt: new Date(at).toISOString() };
  }
}

async function cli(store: ResumeStore, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAnchorResumeCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), store, requestId: () => 'req-1' });
  return { code, out, err };
}
const base = ['--tenant', A, '--batch', BATCH, '--actor', 'op.lead', '--reason', 'log entry fixed upstream'];
const rejected = (at = T0): Failure => ({ at, code: 'ATTESTA_ANCHOR_LOG_REJECTED' });

test('dry run: prints the batch, its range, record count and terminal code; writes nothing', async () => {
  const s = new MemResumeStore();
  s.add(A, BATCH, [rejected()]);
  const r = await cli(s, base);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, [
    'mode=dry-run', `tenant=${A}`, `batch=${BATCH}`, 'seq=0-2', 'records=3', `last_failed_at=${new Date(T0).toISOString()}`,
    'terminal_code=ATTESTA_ANCHOR_LOG_REJECTED',
    'next=rerun with --confirm=RESUME after review (writes one resume row and one audit row)',
  ]);
  assert.equal(s.resumes.length, 0);
  assert.equal(s.audits.length, 0);
});

test('apply: one resume row and one audit row (attesta.anchor.resume) with the request id', async () => {
  const s = new MemResumeStore();
  s.add(A, BATCH, [rejected()]);
  const r = await cli(s, [...base, '--confirm=RESUME']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.ok(r.out.includes('mode=apply'));
  assert.ok(r.out.includes('request_id=req-1'));
  assert.equal(s.resumes.length, 1);
  assert.deepEqual(s.audits, [{ tenantId: A, action: 'attesta.anchor.resume', actor: 'op.lead', target: BATCH,
    details: { request_id: 'req-1', terminal_code: 'ATTESTA_ANCHOR_LOG_REJECTED', records: 3, reason: 'log entry fixed upstream' } }]);
});

test('a batch that is not stopped is refused with the reason, dry run and apply alike', async () => {
  const cases: Array<[string, (s: MemResumeStore) => void, RegExp]> = [
    ['unknown batch', () => undefined, /no such batch/],
    ['anchored', (s) => s.add(A, BATCH, [rejected()], true), /anchored/],
    ['never failed', (s) => s.add(A, BATCH, []), /no failed attempt/],
    ['only retryable failures', (s) => s.add(A, BATCH, [{ at: T0, code: 'ATTESTA_ANCHOR_LOG_UNAVAILABLE' }]), /never failed with a terminal code/],
    ['another tenant\'s batch under its own tenant', (s) => s.add(B, BATCH), /no such batch/],
  ];
  for (const [name, setup, why] of cases) {
    for (const confirm of [[], ['--confirm=RESUME']]) {
      const s = new MemResumeStore();
      setup(s);
      const r = await cli(s, [...base, ...confirm]);
      assert.equal(r.code, 1, name);
      assert.match(r.err.join('\n'), why, name);
      assert.equal(s.resumes.length + s.audits.length, 0, name);
    }
  }
});

test('two resumes for one stop: the second is refused; a new terminal failure needs (and allows) a new one', async () => {
  const s = new MemResumeStore();
  s.add(A, BATCH, [rejected()]);
  assert.equal((await cli(s, [...base, '--confirm=RESUME'])).code, 0);
  const again = await cli(s, [...base, '--confirm=RESUME']);
  assert.equal(again.code, 1);
  assert.match(again.err.join('\n'), /already resumed/);
  // A race past the dry run: the guard refuses inside the transaction, and the CLI says so.
  const raced = new MemResumeStore();
  raced.add(A, BATCH, [rejected()]);
  const original = raced.batchState.bind(raced);
  raced.batchState = async (t, b) => ({ ...(await original(t, b))!, terminalCode: 'ATTESTA_ANCHOR_LOG_REJECTED' });
  raced.resumes.push({ tenantId: A, batchId: BATCH, actor: 'other', reason: 'x', requestId: 'r0', terminalCode: 'x', records: 3, at: T0 + 1 });
  const lost = await cli(raced, [...base, '--confirm=RESUME']);
  assert.equal(lost.code, 1);
  assert.match(lost.err.join('\n'), /refused by the database guard: this stop was already resumed/);
  // The retry after the resume is rejected again: a new stop, resumable once more.
  s.clock = T0 + 60_000;
  s.batches.get(BATCH)!.failures.push(rejected(T0 + 60_000));
  assert.equal(resumeVerdict(await s.batchState(A, BATCH)).stopped, true);
  assert.equal((await cli(s, [...base, '--confirm=RESUME'])).code, 0);
  assert.equal(s.resumes.length, 2);
  assert.equal(s.audits.length, 2);
});

test('a retryable failure recorded after the terminal one (two concurrent passes) does not hide the stop: still resumable', async () => {
  // The worker stops the batch while any terminal failure is newer than the latest resume; the
  // resume rule must be the same, or the batch would be stopped with no way to resume it.
  const s = new MemResumeStore();
  s.add(A, BATCH, [rejected(T0), { at: T0 + 5, code: 'ATTESTA_ANCHOR_LOG_UNAVAILABLE' }]);
  const dry = await cli(s, base);
  assert.equal(dry.code, 0, dry.err.join('\n'));
  assert.ok(dry.out.includes('terminal_code=ATTESTA_ANCHOR_LOG_REJECTED'));
  assert.equal((await cli(s, [...base, '--confirm=RESUME'])).code, 0);
  assert.match((await cli(s, base)).err.join('\n'), /already resumed/);
});

test('arguments are validated before anything reaches the store', async () => {
  const bad: Array<[string[], RegExp]> = [
    [['--tenant', 'A', '--batch', BATCH, '--actor', 'op', '--reason', 'r'], /--tenant/],
    [['--tenant', A, '--batch', `${B}:0-2`, '--actor', 'op', '--reason', 'r'], /another tenant/],
    [['--tenant', A, '--batch', `${A}:2-0`, '--actor', 'op', '--reason', 'r'], /range/],
    [['--tenant', A, '--batch', `${A}:01-2`, '--actor', 'op', '--reason', 'r'], /--batch/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'me@example.com', '--reason', 'r'], /--actor/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', ' '], /--reason/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', 'x'.repeat(257)], /--reason/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', 'a\nb'], /--reason/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', 'r', '--confirm=yes'], /--confirm/],
    [['--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', 'r', '--expect=1'], /unknown option/],
    [['--tenant', A, '--tenant', A, '--batch', BATCH, '--actor', 'op', '--reason', 'r'], /twice/],
  ];
  for (const [argv, why] of bad) {
    assert.throws(() => parseResumeArgs(argv), why, argv.join(' '));
    let touched = false;
    const store: ResumeStore = { batchState: async () => { touched = true; return null; }, applyResume: async () => { touched = true; return { resumedAt: '' }; } };
    assert.equal((await cli(store, argv)).code, 1);
    assert.equal(touched, false);
  }
});
