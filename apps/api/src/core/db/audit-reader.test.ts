import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withAuditReader } from './audit-reader';

const TENANT = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();

function recordingExecutor(statements: Array<{ sql: string; params: unknown[] }>) {
  return {
    async execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      statements.push({ sql: rendered.sql, params: rendered.params });
      return { rows: [] };
    },
  };
}

test('audit reader binds the tenant, enters the role, runs the select, then resets', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = recordingExecutor(statements);

  const result = await withAuditReader(tx, TENANT, async executor => {
    statements.push({ sql: 'fn', params: [] });
    assert.equal(executor, tx);
    return 'selected';
  });

  assert.equal(result, 'selected');
  assert.deepEqual(statements, [
    { sql: "select set_config('trackai.tenant_id', $1, true)", params: [TENANT] },
    { sql: 'set local role trackai_audit_reader', params: [] },
    { sql: 'fn', params: [] },
    { sql: 'reset role', params: [] },
  ]);
});

test('audit reader resets the role when the select throws', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = recordingExecutor(statements);
  const failure = new Error('select failed');

  await assert.rejects(
    withAuditReader(tx, TENANT, async () => {
      statements.push({ sql: 'fn:error', params: [] });
      throw failure;
    }),
    error => error === failure,
  );

  assert.deepEqual(statements, [
    { sql: "select set_config('trackai.tenant_id', $1, true)", params: [TENANT] },
    { sql: 'set local role trackai_audit_reader', params: [] },
    { sql: 'fn:error', params: [] },
    { sql: 'reset role', params: [] },
  ]);
});
