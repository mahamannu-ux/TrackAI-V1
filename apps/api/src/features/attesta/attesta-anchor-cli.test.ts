// The anchoring CLI's argument parsing and its one-line summary (Task15f2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOP_SLEEP_MS, formatPass, parseAnchorArgs } from './attesta-anchor-cli';

const TENANT = '11111111-1111-4111-8111-111111111111';

test('CLI: one pass by default; --loop sleeps 5 minutes; --tenant and --max-batch reach the pass', () => {
  assert.deepEqual(parseAnchorArgs([]), {
    options: { tenantId: undefined, maxBatch: undefined, partialAfterMs: undefined, limitTenants: undefined },
    loop: false, sleepMs: DEFAULT_LOOP_SLEEP_MS,
  });
  assert.equal(DEFAULT_LOOP_SLEEP_MS, 300_000);
  const p = parseAnchorArgs(['--loop', '--tenant', TENANT, '--max-batch=64', '--partial-after-ms', '0']);
  assert.equal(p.loop, true);
  assert.deepEqual(p.options, { tenantId: TENANT, maxBatch: 64, partialAfterMs: 0, limitTenants: undefined });
});

test('CLI: unknown options, malformed values and a bad tenant are refused', () => {
  for (const bad of [['--tenant', 'A'], ['--max-batch', '-1'], ['--max-batch=1.5'], ['--frobnicate'], ['--loop=yes'],
    ['--sleep-ms', '10'], ['positional']]) {
    assert.throws(() => parseAnchorArgs(bad), Error, bad.join(' '));
  }
});

test('CLI: the summary line holds counts and codes only', () => {
  const line = formatPass({
    tenants: 2, busy: 0, batchesAnchored: 3, recordsAnchored: 600, batchesFailed: 1, batchesStopped: 1, batchesBackoff: 0,
    superseded: 0, alreadyAnchored: 0, recordsWaiting: 4, tenantErrors: 0, stoppedOnOutage: false,
    codes: { ATTESTA_ANCHOR_TSA_UNAVAILABLE: 1, ATTESTA_ANCHOR_LOG_REJECTED: 1 },
  });
  assert.match(line, /^attesta_anchor_pass tenants=2 .*records_anchored=600 .*codes=ATTESTA_ANCHOR_LOG_REJECTED:1,ATTESTA_ANCHOR_TSA_UNAVAILABLE:1$/);
  assert.doesNotMatch(line, /[0-9a-f]{8}-[0-9a-f]{4}|https?:/);
});
