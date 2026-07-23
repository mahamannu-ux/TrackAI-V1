import { and, eq, type SQL } from 'drizzle-orm';
import type {
  AnyPgColumn,
  PgTable,
  PgUpdateSetSource,
} from 'drizzle-orm/pg-core';
import { db } from './index';

type TenantScopedTable = PgTable & {
  tenantId: AnyPgColumn<{ data: string }>;
};

type TenantInsert<TTable extends TenantScopedTable> = Omit<
  TTable['$inferInsert'],
  'tenantId'
>;

/**
 * Creates a request-local database facade for tenant-owned tables.
 *
 * Every read, update, and delete is constrained by tenantId. Inserts ignore any
 * caller-supplied tenantId and stamp the active tenant instead.
 */
export function withTenant(database: typeof db, tenantId: string) {
  const tenantWhere = <TTable extends TenantScopedTable>(
    table: TTable,
    condition?: SQL,
  ) => and(eq(table.tenantId, tenantId), condition);

  return {
    select<TTable extends TenantScopedTable>(table: TTable, condition?: SQL) {
      return database
        .select()
        .from(table)
        .where(tenantWhere(table, condition));
    },

    insert<TTable extends TenantScopedTable>(
      table: TTable,
      values: TenantInsert<TTable>,
    ) {
      const tenantValues = {
        ...values,
        tenantId,
      } as TTable['$inferInsert'];

      return database.insert(table).values(tenantValues).returning();
    },

    insertDoNothing<TTable extends TenantScopedTable>(
      table: TTable,
      values: TenantInsert<TTable>,
      conflictTarget: AnyPgColumn[],
    ) {
      const tenantValues = { ...values, tenantId } as TTable['$inferInsert'];
      return database
        .insert(table)
        .values(tenantValues)
        .onConflictDoNothing({ target: conflictTarget as any })
        .returning();
    },

    upsert<TTable extends TenantScopedTable>(
      table: TTable,
      values: TenantInsert<TTable>,
      conflictTarget: AnyPgColumn[],
      updateValues: Partial<TenantInsert<TTable>>,
    ) {
      const tenantValues = { ...values, tenantId } as TTable['$inferInsert'];
      const { tenantId: _ignoredTenantId, ...safeUpdateValues } = updateValues as
        Partial<TenantInsert<TTable>> & { tenantId?: unknown };
      return database
        .insert(table)
        .values(tenantValues)
        .onConflictDoUpdate({
          target: conflictTarget as any,
          set: safeUpdateValues as any,
        })
        .returning();
    },

    update<TTable extends TenantScopedTable>(
      table: TTable,
      values: Partial<TenantInsert<TTable>>,
      condition?: SQL,
    ) {
      const { tenantId: _ignoredTenantId, ...safeValues } = values as
        Partial<TenantInsert<TTable>> & { tenantId?: unknown };

      return database
        .update(table)
        .set(safeValues as unknown as PgUpdateSetSource<TTable>)
        .where(tenantWhere(table, condition))
        .returning();
    },

    delete<TTable extends TenantScopedTable>(table: TTable, condition?: SQL) {
      return database
        .delete(table)
        .where(tenantWhere(table, condition))
        .returning();
    },
  };
}
