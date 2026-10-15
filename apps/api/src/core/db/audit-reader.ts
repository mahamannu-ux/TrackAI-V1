/**
 * Runs the audit-select part of a request under PostgreSQL's tenant-bound,
 * SELECT-only role. The caller keeps the surrounding transaction so it can
 * write the read receipt after this helper resets the role.
 *
 * Ported from SushiCorp ID2 @ 0bd67a5 (catalog AU-1).
 * Deviations: TrackAI binds tenant isolation through an RLS setting, and the
 * role can select only the audit trail and audit-seal tables.
 */
import { sql, type SQL } from 'drizzle-orm';

export interface AuditReaderExecutor {
  execute(query: SQL): PromiseLike<unknown> | unknown;
}

export async function withAuditReader<T, TExecutor extends AuditReaderExecutor>(
  tx: TExecutor,
  tenantId: string,
  fn: (tx: TExecutor) => Promise<T>,
): Promise<T> {
  await tx.execute(sql`select set_config('trackai.tenant_id', ${tenantId}, true)`);
  await tx.execute(sql.raw('set local role trackai_audit_reader'));
  try {
    return await fn(tx);
  } finally {
    await tx.execute(sql.raw('reset role'));
  }
}
