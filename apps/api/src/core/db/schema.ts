import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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
  normalizedUrl: text('normalized_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderExternalIdUnique: unique(
    'scm_repositories_tenant_id_provider_external_id_key',
  ).on(table.tenantId, table.provider, table.externalId),
  tenantNormalizedUrlUnique: unique(
    'scm_repositories_tenant_id_normalized_url_key',
  ).on(table.tenantId, table.normalizedUrl),
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
  headRef: text('head_ref'),
  baseRef: text('base_ref'),
  headSha: text('head_sha'),
  mergeCommitSha: text('merge_commit_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryExternalIdUnique: unique(
    'scm_pull_requests_tenant_id_repository_id_external_id_key',
  ).on(table.tenantId, table.repositoryId, table.externalId),
}));

/** Raw Git AI batches retained as immutable, server-only audit evidence. */
export const telemetryIngestBatches = pgTable('telemetry_ingest_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  apiVersion: integer('api_version').notNull(),
  payloadHash: text('payload_hash').notNull(),
  eventCount: integer('event_count').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPayloadHashUnique: unique(
    'telemetry_ingest_batches_tenant_id_payload_hash_key',
  ).on(table.tenantId, table.payloadHash),
}));

/** Individual wire events, fingerprinted for retry-safe ingestion. */
export const telemetryMetricEvents = pgTable('telemetry_metric_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  batchId: uuid('batch_id').references(() => telemetryIngestBatches.id).notNull(),
  eventIndex: integer('event_index').notNull(),
  eventFingerprint: text('event_fingerprint').notNull(),
  eventKind: integer('event_kind').notNull(),
  eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
  rawEvent: jsonb('raw_event').notNull(),
  normalizationStatus: text('normalization_status').notNull().default('pending'),
  normalizationError: text('normalization_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantFingerprintUnique: unique(
    'telemetry_metric_events_tenant_id_event_fingerprint_key',
  ).on(table.tenantId, table.eventFingerprint),
  tenantKindTimestampIndex: index(
    'telemetry_metric_events_tenant_kind_timestamp_idx',
  ).on(table.tenantId, table.eventKind, table.eventTimestamp),
}));

/** Git commits normalized from Git AI commit and rewrite events. */
export const scmCommits = pgTable('scm_commits', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  sha: text('sha').notNull(),
  branch: text('branch'),
  authorName: text('author_name'),
  authorEmail: text('author_email'),
  subject: text('subject').notNull(),
  body: text('body'),
  authoredAt: timestamp('authored_at', { withTimezone: true }),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  diffAddedLines: integer('diff_added_lines').notNull().default(0),
  diffDeletedLines: integer('diff_deleted_lines').notNull().default(0),
  observedAiLines: integer('observed_ai_lines').notNull().default(0),
  observedHumanLines: integer('observed_human_lines').notNull().default(0),
  observedUnknownLines: integer('observed_unknown_lines').notNull().default(0),
  authorshipNote: text('authorship_note'),
  sourceEventId: uuid('source_event_id').references(() => telemetryMetricEvents.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryShaUnique: unique(
    'scm_commits_tenant_id_repository_id_sha_key',
  ).on(table.tenantId, table.repositoryId, table.sha),
  tenantCommittedAtIndex: index('scm_commits_tenant_committed_at_idx')
    .on(table.tenantId, table.committedAt),
}));

/** Final file/range attribution carried by a commit's authorship Note. */
export const scmCommitFiles = pgTable('scm_commit_files', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  commitId: uuid('commit_id').references(() => scmCommits.id).notNull(),
  path: text('path').notNull(),
  observedAiLines: integer('observed_ai_lines').notNull().default(0),
  observedHumanLines: integer('observed_human_lines').notNull().default(0),
  observedUnknownLines: integer('observed_unknown_lines').notNull().default(0),
  attributionRanges: jsonb('attribution_ranges').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantCommitPathUnique: unique(
    'scm_commit_files_tenant_id_commit_id_path_key',
  ).on(table.tenantId, table.commitId, table.path),
}));

/** Customer-visible agent conversations. */
export const aiSessions = pgTable('ai_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  externalSessionId: text('external_session_id').notNull(),
  gitAiSessionId: text('git_ai_session_id'),
  parentSessionId: text('parent_session_id'),
  tool: text('tool').notNull(),
  displayName: text('display_name'),
  observedModels: jsonb('observed_models').notNull().default([]),
  humanAuthor: text('human_author'),
  status: text('status').notNull().default('active'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantToolExternalSessionUnique: unique(
    'ai_sessions_tenant_id_tool_external_session_id_key',
  ).on(table.tenantId, table.tool, table.externalSessionId),
  tenantGitAiSessionIndex: index('ai_sessions_tenant_git_ai_session_idx')
    .on(table.tenantId, table.gitAiSessionId),
}));

export const aiSessionRepositories = pgTable('ai_session_repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  sessionId: uuid('session_id').references(() => aiSessions.id).notNull(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantSessionRepositoryUnique: unique(
    'ai_session_repositories_tenant_session_repository_key',
  ).on(table.tenantId, table.sessionId, table.repositoryId),
}));

/** Token/cost evidence. Null tokens mean unavailable, never zero-by-default. */
export const aiSessionUsage = pgTable('ai_session_usage', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  sessionId: uuid('session_id').references(() => aiSessions.id).notNull(),
  model: text('model'),
  inputTokens: bigint('input_tokens', { mode: 'number' }),
  outputTokens: bigint('output_tokens', { mode: 'number' }),
  reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }),
  costAmount: numeric('cost_amount', { precision: 20, scale: 6 }),
  costUnit: text('cost_unit'),
  availability: text('availability').notNull().default('unavailable'),
  evidenceSource: text('evidence_source').notNull(),
  sourceEventId: uuid('source_event_id').references(() => telemetryMetricEvents.id),
  evidenceKey: text('evidence_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantEvidenceKeyUnique: unique(
    'ai_session_usage_tenant_id_evidence_key_key',
  ).on(table.tenantId, table.evidenceKey),
}));

export const aiCommitSessions = pgTable('ai_commit_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  commitId: uuid('commit_id').references(() => scmCommits.id).notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id).notNull(),
  observedAiLines: integer('observed_ai_lines').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantCommitSessionUnique: unique(
    'ai_commit_sessions_tenant_commit_session_key',
  ).on(table.tenantId, table.commitId, table.sessionId),
}));

export const scmPullRequestCommits = pgTable('scm_pull_request_commits', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id).notNull(),
  commitId: uuid('commit_id').references(() => scmCommits.id).notNull(),
  matchMethod: text('match_method').notNull(),
  confidence: integer('confidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPullRequestCommitUnique: unique(
    'scm_pull_request_commits_tenant_pull_request_commit_key',
  ).on(table.tenantId, table.pullRequestId, table.commitId),
}));

/** Immutable overlays: observed evidence remains unchanged. */
export const telemetryCorrections = pgTable('telemetry_corrections', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  targetType: text('target_type').notNull(),
  targetKey: text('target_key').notNull(),
  fieldName: text('field_name').notNull(),
  correctedValue: jsonb('corrected_value').notNull(),
  reason: text('reason').notNull(),
  evidenceRef: text('evidence_ref'),
  createdBy: text('created_by').notNull().default('system'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantTargetFieldUnique: unique(
    'telemetry_corrections_tenant_target_field_key',
  ).on(table.tenantId, table.targetType, table.targetKey, table.fieldName),
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
export type TelemetryIngestBatch = typeof telemetryIngestBatches.$inferSelect;
export type TelemetryMetricEvent = typeof telemetryMetricEvents.$inferSelect;
export type SCMCommit = typeof scmCommits.$inferSelect;
export type SCMCommitFile = typeof scmCommitFiles.$inferSelect;
export type AISession = typeof aiSessions.$inferSelect;
export type AISessionUsage = typeof aiSessionUsage.$inferSelect;
export type TelemetryCorrection = typeof telemetryCorrections.$inferSelect;
