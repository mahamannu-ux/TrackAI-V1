import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Items Table Schema
 *
 * A simple table to demonstrate end-to-end CRUD wiring.
 * - id: UUID primary key, auto-generated
 * - name: Text field for the item name
 * - createdAt: Timestamp, auto-set to current time on insert
 */
export const items = pgTable('items', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Type inference helpers for use in route handlers
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
