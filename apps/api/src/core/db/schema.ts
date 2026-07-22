import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Multi-Tenant Master Registry Table
 * (Maps to the SQL table you ran earlier)
 */
export const ssoTenants = pgTable('sso_tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyName: text('company_name').notNull(),
  domain: text('domain').notNull().unique(),
  supabaseProviderId: text('supabase_provider_id').notNull(),
  scmOrgIdentifier: text('scm_org_identifier').unique(),
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

/**
 * Provider repositories connected to a tenant workspace.
 */
export const scmRepositories = pgTable('scm_repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderExternalIdUnique: unique(
    'scm_repositories_tenant_id_provider_external_id_key',
  ).on(table.tenantId, table.provider, table.externalId),
}));

/**
 * Pull requests synchronized from an SCM repository.
 */
export const scmPullRequests = pgTable('scm_pull_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id')
    .references(() => scmRepositories.id)
    .notNull(),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  authorEmail: text('author_email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryExternalIdUnique: unique(
    'scm_pull_requests_tenant_id_repository_id_external_id_key',
  ).on(table.tenantId, table.repositoryId, table.externalId),
}));

/**
 * Contributors observed in pull-request activity for a tenant repository.
 */
export const scmContributors = pgTable('scm_contributors', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id')
    .references(() => scmRepositories.id)
    .notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  machineId: text('machine_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryEmailUnique: unique(
    'scm_contributors_tenant_id_repository_id_email_key',
  ).on(table.tenantId, table.repositoryId, table.email),
}));

/**
 * Branches observed for a tenant repository.
 */
export const scmBranches = pgTable('scm_branches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id')
    .references(() => scmRepositories.id)
    .notNull(),
  name: text('name').notNull(),
  lastCommitSha: text('last_commit_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryNameUnique: unique(
    'scm_branches_tenant_id_repository_id_name_key',
  ).on(table.tenantId, table.repositoryId, table.name),
}));

// Type inference helpers
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Tenant = typeof ssoTenants.$inferSelect;
export type SCMRepository = typeof scmRepositories.$inferSelect;
export type NewSCMRepository = typeof scmRepositories.$inferInsert;
export type SCMPullRequest = typeof scmPullRequests.$inferSelect;
export type NewSCMPullRequest = typeof scmPullRequests.$inferInsert;
export type SCMContributor = typeof scmContributors.$inferSelect;
export type NewSCMContributor = typeof scmContributors.$inferInsert;
export type SCMBranch = typeof scmBranches.$inferSelect;
export type NewSCMBranch = typeof scmBranches.$inferInsert;
