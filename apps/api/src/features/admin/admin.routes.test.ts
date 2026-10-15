// Task16c (A16.5) rule 7: the route bounds what the audit emitter would refuse.
// dateValue refuses years outside 1–9999 and stringArray refuses items over 512
// characters, so a bad request answers 400 through the existing badRequest
// instead of a 500 from the emitter. Every dateValue/stringArray call site in
// admin.routes.ts sits inside its handler's try/catch → badRequest (400), so
// pinning the helpers' throws pins the routes' 400s. No database.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminAuditHandler, dateValue, optionalDateValue, stringArray } from './admin.routes';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  throw new Error('expected a throw');
}

test('admin routes: dateValue refuses years outside 1–9999 as invalid', () => {
  assert.equal(dateValue('2026-10-15T00:00:00Z', 'scopeFrom').toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(dateValue('0001-01-01T00:00:00Z', 'scopeFrom').getUTCFullYear(), 1);
  assert.equal(dateValue('9999-12-31T23:59:59Z', 'scopeUntil').getUTCFullYear(), 9999);
  assert.equal(messageOf(() => dateValue('+010000-01-01T00:00:00Z', 'scopeFrom')), 'scopeFrom is invalid');
  assert.equal(messageOf(() => dateValue('0000-01-01T00:00:00Z', 'scopeFrom')), 'scopeFrom is invalid');
  assert.equal(messageOf(() => dateValue('not-a-date', 'scopeUntil')), 'scopeUntil is invalid');
  assert.equal(messageOf(() => dateValue(42, 'scopeFrom')), 'scopeFrom is required');
  assert.equal(optionalDateValue(undefined, 'expiresAt'), undefined);
  assert.equal(optionalDateValue(null, 'expiresAt'), undefined);
  assert.equal(optionalDateValue('', 'expiresAt'), undefined);
  assert.equal(messageOf(() => optionalDateValue('+010000-01-01T00:00:00Z', 'expiresAt')), 'expiresAt is invalid');
});

test('admin routes: stringArray refuses items over 512 characters', () => {
  assert.deepEqual(stringArray(undefined, 'branchPatterns'), []);
  assert.deepEqual(stringArray(['main', 'release/*'], 'branchPatterns'), ['main', 'release/*']);
  assert.deepEqual(stringArray(['x'.repeat(512)], 'branchPatterns'), ['x'.repeat(512)]);
  assert.equal(
    messageOf(() => stringArray(['main', 'x'.repeat(513)], 'branchPatterns')),
    'branchPatterns must be a string array',
  );
  assert.equal(
    messageOf(() => stringArray('main', 'branchPatterns')),
    'branchPatterns must be a string array',
  );
  assert.equal(
    messageOf(() => stringArray(['main', 42], 'branchPatterns')),
    'branchPatterns must be a string array',
  );
  assert.equal(
    messageOf(() => stringArray(new Array(65).fill('main'), 'branchPatterns')),
    'branchPatterns must be a string array',
  );
});

test('admin routes: legacy audit list fails closed when the read or audit write throws', async () => {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: (code: number) => { statusCode = code; return res; },
    json: (payload: unknown) => { body = payload; return res; },
  };
  const req = (over: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-a', user: { sub: 'admin-a' }, adminRole: 'tenant_admin', query: {}, ...over,
  });
  // A failing audit write (or read) answers 503 with the generic body and no rows.
  const failing = createAdminAuditHandler(async () => { throw new Error('audit unavailable'); });
  await failing(req() as never, res as never);
  assert.equal(statusCode, 503);
  assert.deepEqual(body, { error: 'Audit trail is temporarily unavailable' });
  assert.equal(headers['cache-control'], 'no-store');
  // Only the identity error stays a 400; the list function never runs.
  let listed = false;
  const idle = createAdminAuditHandler(async () => { listed = true; return []; });
  statusCode = 200; body = undefined;
  await idle(req({ tenantId: undefined }) as never, res as never);
  assert.equal(statusCode, 400);
  assert.deepEqual(body, { error: 'Administrator identity is unavailable' });
  assert.equal(listed, false);
  // Success keeps the camelCase shape.
  const rows = [{ id: 'r1', actorType: 'tenant_admin' }];
  const ok = createAdminAuditHandler(async () => rows);
  statusCode = 200; body = undefined;
  await ok(req() as never, res as never);
  assert.equal(statusCode, 200);
  assert.deepEqual(body, { events: rows });
});
