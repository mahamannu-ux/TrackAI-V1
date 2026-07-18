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
 * Items Table Schema (Updated for Data Isolation)
 */
export const items = pgTable('items', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // NEW: Every single item row is now locked to a specific enterprise customer UUID
  tenantId: uuid('tenant_id').references(() => ssoTenants.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Type inference helpers
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Tenant = typeof ssoTenants.$inferSelect;
