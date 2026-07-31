import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { db } from './index';
import { scmRepositories } from './schema';
import { withTenant } from './tenant';

test('tenant-scoped select keeps typed columns and the active tenant predicate', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const query = withTenant(db, tenantId).select(
    scmRepositories,
    eq(scmRepositories.provider, 'github'),
  );
  const built = query.toSQL();

  assert.match(built.sql, /from "scm_repositories"/);
  assert.match(built.sql, /"scm_repositories"\."tenant_id" = \$1/);
  assert.match(built.sql, /"scm_repositories"\."provider" = \$2/);
  assert.deepEqual(built.params, [tenantId, 'github']);
});
