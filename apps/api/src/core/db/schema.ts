import {
  bigint,
  boolean,
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
  authorEmail: text('author_email'),
  authorProviderId: text('author_provider_id'),
  authorLogin: text('author_login'),
  number: integer('number'),
  headRef: text('head_ref'),
  baseRef: text('base_ref'),
  headSha: text('head_sha'),
  mergeCommitSha: text('merge_commit_sha'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
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
  operationKind: text('operation_kind').notNull().default('commit'),
  patchId: text('patch_id'),
  reachability: text('reachability').notNull().default('observed'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
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

/** Immutable predecessor/successor evidence for commit rewrites and merges. */
export const scmCommitLineage = pgTable('scm_commit_lineage', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  predecessorCommitId: uuid('predecessor_commit_id').references(() => scmCommits.id),
  predecessorSha: text('predecessor_sha').notNull(),
  successorCommitId: uuid('successor_commit_id').references(() => scmCommits.id),
  successorSha: text('successor_sha').notNull(),
  operationKind: text('operation_kind').notNull(),
  evidenceSource: text('evidence_source').notNull(),
  confidence: integer('confidence').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantLineageUnique: unique('scm_commit_lineage_tenant_repo_predecessor_successor_operation_key')
    .on(table.tenantId, table.repositoryId, table.predecessorSha, table.successorSha, table.operationKind),
}));

/** Point-in-time capture of a pull request's authoritative GitHub commit list. */
export const scmPullRequestSnapshots = pgTable('scm_pull_request_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id).notNull(),
  headSha: text('head_sha'),
  snapshotKey: text('snapshot_key').notNull(),
  commitShas: jsonb('commit_shas').notNull().default([]),
  source: text('source').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPullRequestSnapshotUnique: unique('scm_pr_snapshots_tenant_pr_snapshot_key')
    .on(table.tenantId, table.pullRequestId, table.snapshotKey),
  tenantPullRequestCapturedIndex: index('scm_pr_snapshots_tenant_pr_captured_idx')
    .on(table.tenantId, table.pullRequestId, table.capturedAt),
}));

/** Temporal membership; removed commits remain historical evidence. */
export const scmPullRequestCommitMemberships = pgTable('scm_pull_request_commit_memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id).notNull(),
  commitId: uuid('commit_id').references(() => scmCommits.id).notNull(),
  firstSeenSnapshotId: uuid('first_seen_snapshot_id').references(() => scmPullRequestSnapshots.id).notNull(),
  lastSeenSnapshotId: uuid('last_seen_snapshot_id').references(() => scmPullRequestSnapshots.id).notNull(),
  active: boolean('active').notNull().default(true),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (table) => ({
  tenantPullRequestCommitMembershipUnique: unique('scm_pr_commit_memberships_tenant_pr_commit_key')
    .on(table.tenantId, table.pullRequestId, table.commitId),
}));

/** Source PR commits mapped to the resulting base-branch commit. */
export const scmMergeLineage = pgTable('scm_merge_lineage', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id).notNull(),
  sourceCommitId: uuid('source_commit_id').references(() => scmCommits.id).notNull(),
  resultCommitId: uuid('result_commit_id').references(() => scmCommits.id),
  resultSha: text('result_sha').notNull(),
  mergeMethod: text('merge_method').notNull(),
  confidence: integer('confidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantMergeLineageUnique: unique('scm_merge_lineage_tenant_pr_source_result_key')
    .on(table.tenantId, table.pullRequestId, table.sourceCommitId, table.resultSha),
}));

/** Successful or failed deployment observations from SCM/CI providers. */
export const scmDeployments = pgTable('scm_deployments', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  environment: text('environment').notNull(),
  ref: text('ref'),
  sha: text('sha').notNull(),
  status: text('status').notNull(),
  production: boolean('production').notNull().default(false),
  deployedAt: timestamp('deployed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderDeploymentUnique: unique('scm_deployments_tenant_provider_external_id_status_key')
    .on(table.tenantId, table.provider, table.externalId, table.status),
}));

/** Gross generation evidence. Raw content is intentionally not stored. */
export const aiGenerationObservations = pgTable('ai_generation_observations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id),
  sourceEventId: uuid('source_event_id').references(() => telemetryMetricEvents.id).notNull(),
  traceId: text('trace_id'),
  model: text('model'),
  filePath: text('file_path'),
  generatedLines: integer('generated_lines').notNull(),
  acceptedLines: integer('accepted_lines'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  evidenceSource: text('evidence_source').notNull(),
}, (table) => ({
  tenantSourceEventUnique: unique('ai_generation_observations_tenant_source_event_key')
    .on(table.tenantId, table.sourceEventId),
}));

/** Append-only transitions used to calculate lifecycle retention and rework. */
export const aiCodeLifecycleEvents = pgTable('ai_code_lifecycle_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  commitId: uuid('commit_id').references(() => scmCommits.id),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id),
  stage: text('stage').notNull(),
  lineCount: integer('line_count').notNull(),
  actorKind: text('actor_kind'),
  evidenceType: text('evidence_type').notNull(),
  evidenceRef: text('evidence_ref').notNull(),
  confidence: integer('confidence').notNull().default(100),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantLifecycleEvidenceUnique: unique('ai_code_lifecycle_events_tenant_stage_evidence_key')
    .on(table.tenantId, table.stage, table.evidenceRef),
}));

/** Stable provider identity, deliberately separate from optional email evidence. */
export const scmProviderIdentities = pgTable('scm_provider_identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  login: text('login').notNull(),
  displayName: text('display_name'),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderUserUnique: unique('scm_provider_identities_tenant_provider_user_key')
    .on(table.tenantId, table.provider, table.providerUserId),
}));

/** Optional tenant-controlled association between SCM and SSO identities. */
export const tenantIdentityLinks = pgTable('tenant_identity_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  providerIdentityId: uuid('provider_identity_id').references(() => scmProviderIdentities.id).notNull(),
  ssoSubject: text('sso_subject'),
  ssoEmail: text('sso_email'),
  status: text('status').notNull().default('unlinked'),
  linkedBy: text('linked_by'),
  linkedAt: timestamp('linked_at', { withTimezone: true }),
}, (table) => ({
  tenantProviderIdentityUnique: unique('tenant_identity_links_tenant_provider_identity_key')
    .on(table.tenantId, table.providerIdentityId),
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
  email: text('email'),
  providerIdentityId: uuid('provider_identity_id').references(() => scmProviderIdentities.id),
  machineId: text('machine_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryProviderIdentityUnique: unique(
    'scm_contributors_tenant_id_repository_id_provider_identity_key',
  ).on(table.tenantId, table.repositoryId, table.providerIdentityId),
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
