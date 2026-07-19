import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Multi-Tenant Master Registry Table
 * (Maps to the SQL table you ran earlier)
 */
export const ssoTenants = pgTable('sso_tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyName: text('company_name').notNull(),
  domain: text('domain').notNull().unique(),
  supabaseProviderId: text('supabase_provider_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Shared ownership column for every tenant-scoped table.
 * Using this helper gives tenant-owned tables the shape required by withTenant().
 */
export const tenantIdColumn = () =>
  uuid('tenant_id').references(() => ssoTenants.id).notNull();

/**
 * Items Table Schema (Updated for Data Isolation)
 */
export const items = pgTable('items', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  tenantId: tenantIdColumn(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Type inference helpers
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Tenant = typeof ssoTenants.$inferSelect;
