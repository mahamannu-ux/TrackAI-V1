// Task16c (A16.5): the emitter is the only writer. Every audit row goes through
// recordAuditEvent() (core/audit/record.ts); this test walks apps/api/src/**/*.ts
// and fails on a direct insert into security_audit_events anywhere else, except
// the allow-listed probes below. No database.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const SRC = resolve(__dirname, '../..');

/** A direct Drizzle insert, any spacing: `.insert(securityAuditEvents).values(` etc. */
const DRIZZLE_INSERT_RE = /\.insert\s*\(\s*securityAuditEvents\s*\)/;
/** A raw SQL insert, any letter case. */
const RAW_INSERT_RE = /insert\s+into\s+security_audit_events/i;

/**
 * Files allowed a direct insert, each with its one-line reason (prompt §2.1 item 8).
 * Test files (*.test.ts) are skipped wholesale, not listed here.
 */
const ALLOW_LIST: Record<string, string> = {
  'core/security/task4-wave1-live-verify.ts':
    'rolled-back probe that verifies the 0021 guard rejects bad rows, then rolls back',
  'features/attesta/t15i3-verify-keys-resume-live-verify.ts':
    'deliberate direct inserts that test the 0021 trigger on the anchor resume path',
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
}

test('audit only-writer: recordAuditEvent() is the only writer of security_audit_events', () => {
  const files: string[] = [];
  walk(SRC, files);
  const matched = new Set<string>();
  const violations: string[] = [];
  for (const full of files) {
    const rel = relative(SRC, full).split(sep).join('/');
    if (rel.endsWith('.test.ts')) continue;
    if (rel.startsWith('core/audit/')) continue;
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    const hits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => DRIZZLE_INSERT_RE.test(line) || RAW_INSERT_RE.test(line));
    if (hits.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(ALLOW_LIST, rel)) {
      matched.add(rel);
      continue;
    }
    for (const { line, index } of hits) {
      violations.push(`${rel}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(violations, [], 'direct audit inserts outside the allow-list');
  const stale = Object.keys(ALLOW_LIST).filter(rel => !matched.has(rel));
  assert.deepEqual(stale, [], 'allow-list entries whose file no longer inserts directly');
});
