import type { SQL } from 'drizzle-orm';
import type { AuditEvent, AuditRow } from './catalog';

/** A Drizzle database or transaction: the object today's sites call `.execute` on. */
export interface AuditExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** Validates an event against its catalog entry and returns the row, or throws AuditContractError. */
export function buildAuditRow(_tenantId: string, _event: AuditEvent): AuditRow {
  throw new Error('buildAuditRow: not implemented yet (Task16b interfaces commit)');
}

/** Inserts one validated row through the caller's executor (inside its transaction). */
export async function recordAuditEvent(_executor: AuditExecutor, _tenantId: string, _event: AuditEvent): Promise<void> {
  throw new Error('recordAuditEvent: not implemented yet (Task16b interfaces commit)');
}
