import {
  check,
  foreignKey,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

/** Explicit authorization for protected tenant-administration actions. */
export const tenantAdminMemberships = pgTable('tenant_admin_memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  subject: text('subject').notNull(),
  email: text('email'),
  role: text('role').$type<'tenant_admin' | 'tenant_auditor'>().notNull(),
  status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
  grantedBy: text('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  tenantSubjectUnique: unique('tenant_admin_memberships_tenant_subject_key')
    .on(table.tenantId, table.subject),
  tenantIdIdUnique: unique('tenant_admin_memberships_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantRoleStatusIndex: index('tenant_admin_memberships_tenant_role_status_idx')
    .on(table.tenantId, table.role, table.status),
  roleCheck: check('tenant_admin_memberships_role_check',
    sql`${table.role} in ('tenant_admin', 'tenant_auditor')`),
  statusCheck: check('tenant_admin_memberships_status_check',
    sql`${table.status} in ('active', 'revoked')`),
}));

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
  tenantIdIdUnique: unique('scm_repositories_tenant_id_id_key')
    .on(table.tenantId, table.id),
}));

/** Developer installations enrolled by a tenant administrator. */
export const developerMachines = pgTable('developer_machines', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  installationId: text('installation_id').notNull(),
  displayName: text('display_name').notNull(),
  platform: text('platform'),
  status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantInstallationUnique: unique('developer_machines_tenant_installation_key')
    .on(table.tenantId, table.installationId),
  tenantIdIdUnique: unique('developer_machines_tenant_id_id_key')
    .on(table.tenantId, table.id),
  statusCheck: check('developer_machines_status_check',
    sql`${table.status} in ('active', 'revoked')`),
}));

/** Opaque machine credentials; plaintext tokens are returned once and never stored. */
export const machineCredentials = pgTable('machine_credentials', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  machineId: uuid('machine_id').notNull(),
  keyId: text('key_id').notNull().unique(),
  secretHash: text('secret_hash').notNull(),
  status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
  rotatedFromCredentialId: uuid('rotated_from_credential_id'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => ({
  tenantIdIdUnique: unique('machine_credentials_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantMachineForeignKey: foreignKey({
    name: 'machine_credentials_tenant_machine_fk',
    columns: [table.tenantId, table.machineId],
    foreignColumns: [developerMachines.tenantId, developerMachines.id],
  }),
  rotatedFromForeignKey: foreignKey({
    name: 'machine_credentials_rotated_from_fk',
    columns: [table.tenantId, table.rotatedFromCredentialId],
    foreignColumns: [table.tenantId, table.id],
  }),
  tenantMachineStatusIndex: index('machine_credentials_tenant_machine_status_idx')
    .on(table.tenantId, table.machineId, table.status),
  statusCheck: check('machine_credentials_status_check',
    sql`${table.status} in ('active', 'revoked')`),
  hashCheck: check('machine_credentials_secret_hash_check',
    sql`${table.secretHash} ~ '^[a-f0-9]{64}$'`),
}));

/** Latest metadata-only delivery health reported by an authenticated machine. */
export const machineDeliveryHealthReports = pgTable('machine_delivery_health_reports', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  machineId: uuid('machine_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  pendingRetryable: integer('pending_retryable').notNull(),
  waitingRetry: integer('waiting_retry').notNull(),
  processing: integer('processing').notNull(),
  quarantined: integer('quarantined').notNull(),
  rowsWithErrors: integer('rows_with_errors').notNull(),
  oldestPendingAt: timestamp('oldest_pending_at', { withTimezone: true }),
  lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
}, (table) => ({
  tenantMachineForeignKey: foreignKey({
    name: 'machine_delivery_health_reports_tenant_machine_fk',
    columns: [table.tenantId, table.machineId],
    foreignColumns: [developerMachines.tenantId, developerMachines.id],
  }),
  tenantMachineUnique: unique('machine_delivery_health_reports_tenant_machine_key')
    .on(table.tenantId, table.machineId),
  tenantReceivedIndex: index('machine_delivery_health_reports_tenant_received_idx')
    .on(table.tenantId, table.receivedAt),
  schemaVersionCheck: check('machine_delivery_health_reports_schema_version_check',
    sql`${table.schemaVersion} = 1`),
  countCheck: check('machine_delivery_health_reports_count_check', sql`
    ${table.pendingRetryable} between 0 and 1000000
    and ${table.waitingRetry} between 0 and 1000000
    and ${table.processing} between 0 and 1000000
    and ${table.quarantined} between 0 and 1000000
    and ${table.rowsWithErrors} between 0 and 1000000
  `),
  timestampCheck: check('machine_delivery_health_reports_timestamp_check', sql`
    (${table.oldestPendingAt} is null or ${table.oldestPendingAt} <= ${table.observedAt})
    and (${table.lastDeliveredAt} is null or ${table.lastDeliveredAt} <= ${table.observedAt})
  `),
}));

/** Tenant-owned registry entry for an approved canonical repository. */
export const repositoryEnrollments = pgTable('repository_enrollments', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').notNull(),
  status: text('status').notNull().default('active'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
  generationSessionEvidenceFrom: timestamp('generation_session_evidence_from', { withTimezone: true })
    .defaultNow().notNull(),
  commitNoteEvidenceFrom: timestamp('commit_note_evidence_from', { withTimezone: true })
    .defaultNow().notNull(),
  effectiveUntil: timestamp('effective_until', { withTimezone: true }),
  enrolledBy: text('enrolled_by').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRepositoryUnique: unique('repository_enrollments_tenant_repository_key')
    .on(table.tenantId, table.repositoryId),
  tenantIdIdUnique: unique('repository_enrollments_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantRepositoryForeignKey: foreignKey({
    name: 'repository_enrollments_tenant_repository_fk',
    columns: [table.tenantId, table.repositoryId],
    foreignColumns: [scmRepositories.tenantId, scmRepositories.id],
  }),
  statusCheck: check('repository_enrollments_status_check',
    sql`${table.status} in ('active', 'revoked')`),
  intervalCheck: check('repository_enrollments_interval_check',
    sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`),
}));

/** Explicit, bounded approval to ingest evidence older than an enrollment watermark. */
export const repositoryBackfillAuthorizations = pgTable('repository_backfill_authorizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  enrollmentId: uuid('enrollment_id').notNull(),
  evidenceFamily: text('evidence_family').notNull(),
  occurredFrom: timestamp('occurred_from', { withTimezone: true }).notNull(),
  occurredUntil: timestamp('occurred_until', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'),
  authorizedBy: text('authorized_by').notNull(),
  reason: text('reason').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('repository_backfill_authorizations_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantEnrollmentForeignKey: foreignKey({
    name: 'repository_backfill_authorizations_tenant_enrollment_fk',
    columns: [table.tenantId, table.enrollmentId],
    foreignColumns: [repositoryEnrollments.tenantId, repositoryEnrollments.id],
  }),
  tenantEnrollmentStatusIndex: index(
    'repository_backfill_authorizations_tenant_enrollment_status_idx',
  ).on(table.tenantId, table.enrollmentId, table.status, table.expiresAt),
  familyCheck: check('repository_backfill_authorizations_family_check',
    sql`${table.evidenceFamily} in ('generation_session', 'commit_note')`),
  statusCheck: check('repository_backfill_authorizations_status_check',
    sql`${table.status} in ('active', 'revoked')`),
  intervalCheck: check('repository_backfill_authorizations_interval_check',
    sql`${table.occurredUntil} >= ${table.occurredFrom}`),
}));

/** Effective machine-to-repository grants. Rows are retained after revocation. */
export const machineRepositoryGrants = pgTable('machine_repository_grants', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  machineId: uuid('machine_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  branchPatterns: jsonb('branch_patterns').$type<string[]>().notNull().default([]),
  status: text('status').notNull().default('active'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
  effectiveUntil: timestamp('effective_until', { withTimezone: true }),
  grantedBy: text('granted_by').notNull(),
  reason: text('reason'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantMachineForeignKey: foreignKey({
    name: 'machine_repository_grants_tenant_machine_fk',
    columns: [table.tenantId, table.machineId],
    foreignColumns: [developerMachines.tenantId, developerMachines.id],
  }),
  tenantEnrollmentForeignKey: foreignKey({
    name: 'machine_repository_grants_tenant_enrollment_fk',
    columns: [table.tenantId, table.enrollmentId],
    foreignColumns: [repositoryEnrollments.tenantId, repositoryEnrollments.id],
  }),
  tenantMachineStatusIndex: index('machine_repository_grants_tenant_machine_status_idx')
    .on(table.tenantId, table.machineId, table.status),
  tenantEnrollmentStatusIndex: index('machine_repository_grants_tenant_enrollment_status_idx')
    .on(table.tenantId, table.enrollmentId, table.status),
  statusCheck: check('machine_repository_grants_status_check',
    sql`${table.status} in ('active', 'revoked')`),
  intervalCheck: check('machine_repository_grants_interval_check',
    sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`),
}));

/** Append-only security administration audit trail. */
export const securityAuditEvents = pgTable('security_audit_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  details: jsonb('details').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantOccurredAtIndex: index('security_audit_events_tenant_occurred_at_idx')
    .on(table.tenantId, table.occurredAt),
}));

/** Versioned tenant retention settings. New tenants default to no automatic purge. */
export const tenantRetentionPolicies = pgTable('tenant_retention_policies', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  version: integer('version').notNull(),
  mode: text('mode').$type<'retain' | 'archive_then_purge'>().notNull(),
  retentionDays: integer('retention_days'),
  status: text('status').$type<'active' | 'superseded'>().notNull().default('active'),
  createdBy: text('created_by').notNull(),
  reason: text('reason').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('tenant_retention_policies_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantVersionUnique: unique('tenant_retention_policies_tenant_version_key')
    .on(table.tenantId, table.version),
  tenantActiveUnique: uniqueIndex('tenant_retention_policies_one_active_idx')
    .on(table.tenantId).where(sql`${table.status} = 'active'`),
  modeCheck: check('tenant_retention_policies_mode_check',
    sql`${table.mode} in ('retain', 'archive_then_purge')`),
  statusCheck: check('tenant_retention_policies_status_check',
    sql`${table.status} in ('active', 'superseded')`),
  configurationCheck: check('tenant_retention_policies_configuration_check', sql`
    (${table.mode} = 'retain' and ${table.retentionDays} is null)
    or (${table.mode} = 'archive_then_purge' and ${table.retentionDays} between 1 and 3650)
  `),
  lifecycleCheck: check('tenant_retention_policies_lifecycle_check', sql`
    (${table.status} = 'active' and ${table.supersededAt} is null)
    or (${table.status} = 'superseded' and ${table.supersededAt} is not null)
  `),
}));

/** Metadata-only, tenant-scoped export job and reproducibility manifest. */
export const evidenceExportJobs = pgTable('evidence_export_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  format: text('format').notNull(),
  status: text('status').$type<'planned' | 'running' | 'completed' | 'failed'>()
    .notNull().default('planned'),
  archivePurpose: boolean('archive_purpose').notNull().default(false),
  scopeFrom: timestamp('scope_from', { withTimezone: true }),
  scopeUntil: timestamp('scope_until', { withTimezone: true }),
  requestedBy: text('requested_by').notNull(),
  reason: text('reason').notNull(),
  recordCounts: jsonb('record_counts').$type<Record<string, number>>().notNull().default({}),
  contentSha256: text('content_sha256'),
  storageReference: text('storage_reference'),
  failureCode: text('failure_code'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('evidence_export_jobs_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantStatusCreatedIndex: index('evidence_export_jobs_tenant_status_created_idx')
    .on(table.tenantId, table.status, table.createdAt),
  statusCheck: check('evidence_export_jobs_status_check', sql`
    ${table.status} in ('planned', 'running', 'completed', 'failed')
  `),
  scopeCheck: check('evidence_export_jobs_scope_check', sql`
    (${table.scopeFrom} is null and ${table.scopeUntil} is null)
    or (${table.scopeFrom} is not null and ${table.scopeUntil} is not null
      and ${table.scopeUntil} > ${table.scopeFrom})
  `),
  digestCheck: check('evidence_export_jobs_digest_check', sql`
    ${table.contentSha256} is null or ${table.contentSha256} ~ '^[a-f0-9]{64}$'
  `),
  lifecycleCheck: check('evidence_export_jobs_lifecycle_check', sql`
    (${table.status} = 'planned' and ${table.startedAt} is null and ${table.completedAt} is null)
    or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null)
    or (${table.status} in ('completed', 'failed')
      and ${table.startedAt} is not null and ${table.completedAt} is not null)
  `),
}));

/** Per-record proof that purgeable evidence was included in a completed archive. */
export const evidenceArchiveEntries = pgTable('evidence_archive_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  exportJobId: uuid('export_job_id').notNull(),
  evidenceFamily: text('evidence_family')
    .$type<'telemetry_metric_evidence' | 'provider_delivery_evidence'>().notNull(),
  evidenceId: uuid('evidence_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  contentSha256: text('content_sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantExportForeignKey: foreignKey({
    name: 'evidence_archive_entries_tenant_export_fk',
    columns: [table.tenantId, table.exportJobId],
    foreignColumns: [evidenceExportJobs.tenantId, evidenceExportJobs.id],
  }),
  exportEvidenceUnique: unique('evidence_archive_entries_export_evidence_key')
    .on(table.tenantId, table.exportJobId, table.evidenceFamily, table.evidenceId),
  tenantEvidenceIndex: index('evidence_archive_entries_tenant_evidence_idx')
    .on(table.tenantId, table.evidenceFamily, table.evidenceId),
  familyCheck: check('evidence_archive_entries_family_check', sql`
    ${table.evidenceFamily} in ('telemetry_metric_evidence', 'provider_delivery_evidence')
  `),
  digestCheck: check('evidence_archive_entries_digest_check',
    sql`${table.contentSha256} ~ '^[a-f0-9]{64}$'`),
}));

/** Dry-run-first retention execution record. It never contains customer evidence. */
export const retentionRuns = pgTable('retention_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  policyId: uuid('policy_id').notNull(),
  archiveExportJobId: uuid('archive_export_job_id'),
  mode: text('mode').$type<'dry_run' | 'apply'>().notNull(),
  status: text('status').$type<'planned' | 'blocked' | 'completed' | 'failed'>()
    .notNull().default('planned'),
  cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
  candidateCounts: jsonb('candidate_counts').$type<Record<string, number>>()
    .notNull().default({}),
  purgedCounts: jsonb('purged_counts').$type<Record<string, number>>()
    .notNull().default({}),
  requestedBy: text('requested_by').notNull(),
  reason: text('reason').notNull(),
  failureCode: text('failure_code'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantPolicyForeignKey: foreignKey({
    name: 'retention_runs_tenant_policy_fk',
    columns: [table.tenantId, table.policyId],
    foreignColumns: [tenantRetentionPolicies.tenantId, tenantRetentionPolicies.id],
  }),
  tenantArchiveForeignKey: foreignKey({
    name: 'retention_runs_tenant_archive_fk',
    columns: [table.tenantId, table.archiveExportJobId],
    foreignColumns: [evidenceExportJobs.tenantId, evidenceExportJobs.id],
  }),
  tenantStatusCreatedIndex: index('retention_runs_tenant_status_created_idx')
    .on(table.tenantId, table.status, table.createdAt),
  modeCheck: check('retention_runs_mode_check', sql`${table.mode} in ('dry_run', 'apply')`),
  statusCheck: check('retention_runs_status_check', sql`
    ${table.status} in ('planned', 'blocked', 'completed', 'failed')
  `),
  applyArchiveCheck: check('retention_runs_apply_archive_check', sql`
    ${table.mode} = 'dry_run' or ${table.archiveExportJobId} is not null
  `),
  completionCheck: check('retention_runs_completion_check', sql`
    (${table.status} = 'planned' and ${table.completedAt} is null)
    or (${table.status} in ('blocked', 'completed', 'failed') and ${table.completedAt} is not null)
  `),
}));

/** Tenant ownership and least-privilege metadata for one GitHub App installation. */
export const githubAppInstallations = pgTable('github_app_installations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  providerHost: text('provider_host').notNull().default('github.com'),
  appId: text('app_id').notNull(),
  installationExternalId: text('installation_external_id').notNull(),
  accountLogin: text('account_login').notNull(),
  permissions: jsonb('permissions').$type<Record<string, string>>().notNull().default({}),
  subscribedEvents: jsonb('subscribed_events').$type<string[]>().notNull().default([]),
  status: text('status').$type<'active' | 'revoked'>().notNull().default('active'),
  createdBy: text('created_by').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('github_app_installations_tenant_id_id_key')
    .on(table.tenantId, table.id),
  providerInstallationUnique: unique('github_app_installations_provider_external_key')
    .on(table.providerHost, table.installationExternalId),
  tenantAccountUnique: unique('github_app_installations_tenant_provider_account_key')
    .on(table.tenantId, table.providerHost, table.accountLogin),
  tenantStatusIndex: index('github_app_installations_tenant_status_idx')
    .on(table.tenantId, table.status),
  statusCheck: check('github_app_installations_status_check',
    sql`${table.status} in ('active', 'revoked')`),
}));

/** Immutable encrypted GitHub App credential versions retained across rotation. */
export const githubAppCredentialVersions = pgTable('github_app_credential_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  installationId: uuid('installation_id').notNull(),
  encryptedCredential: jsonb('encrypted_credential').$type<Record<string, unknown>>().notNull(),
  masterKeyVersion: text('master_key_version').notNull(),
  credentialFingerprint: text('credential_fingerprint').notNull(),
  status: text('status').$type<'active' | 'retiring' | 'revoked'>().notNull().default('active'),
  rotatedFromCredentialId: uuid('rotated_from_credential_id'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
  effectiveUntil: timestamp('effective_until', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('github_app_credential_versions_tenant_id_id_key')
    .on(table.tenantId, table.id),
  installationFingerprintUnique: unique('github_app_credential_versions_installation_fingerprint_key')
    .on(table.tenantId, table.installationId, table.credentialFingerprint),
  tenantInstallationForeignKey: foreignKey({
    name: 'github_app_credential_versions_tenant_installation_fk',
    columns: [table.tenantId, table.installationId],
    foreignColumns: [githubAppInstallations.tenantId, githubAppInstallations.id],
  }),
  rotatedFromForeignKey: foreignKey({
    name: 'github_app_credential_versions_rotated_from_fk',
    columns: [table.tenantId, table.rotatedFromCredentialId],
    foreignColumns: [table.tenantId, table.id],
  }),
  tenantInstallationStatusIndex: index('github_app_credential_versions_tenant_installation_status_idx')
    .on(table.tenantId, table.installationId, table.status, table.effectiveFrom),
  statusCheck: check('github_app_credential_versions_status_check',
    sql`${table.status} in ('active', 'retiring', 'revoked')`),
  intervalCheck: check('github_app_credential_versions_interval_check',
    sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`),
  fingerprintCheck: check('github_app_credential_versions_fingerprint_check',
    sql`${table.credentialFingerprint} ~ '^[a-f0-9]{64}$'`),
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
  enrollmentId: uuid('enrollment_id'),
  evidenceFamily: text('evidence_family').notNull().default('legacy_unclassified'),
  arrivalClass: text('arrival_class').notNull().default('legacy_unclassified'),
  backfillAuthorizationId: uuid('backfill_authorization_id'),
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
  tenantEnrollmentForeignKey: foreignKey({
    name: 'telemetry_metric_events_tenant_enrollment_fk',
    columns: [table.tenantId, table.enrollmentId],
    foreignColumns: [repositoryEnrollments.tenantId, repositoryEnrollments.id],
  }),
  tenantBackfillAuthorizationForeignKey: foreignKey({
    name: 'telemetry_metric_events_tenant_backfill_authorization_fk',
    columns: [table.tenantId, table.backfillAuthorizationId],
    foreignColumns: [
      repositoryBackfillAuthorizations.tenantId,
      repositoryBackfillAuthorizations.id,
    ],
  }),
  evidenceFamilyCheck: check('telemetry_metric_events_evidence_family_check',
    sql`${table.evidenceFamily} in (
      'generation_session', 'commit_note', 'operational', 'legacy_unclassified'
    )`),
  arrivalClassCheck: check('telemetry_metric_events_arrival_class_check',
    sql`${table.arrivalClass} in (
      'current', 'delayed', 'backfill', 'legacy_unclassified'
    )`),
}));

/** Immutable provider webhook deliveries retained for idempotency and audit. */
export const providerEventDeliveries = pgTable('provider_event_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id'),
  provider: text('provider').notNull(),
  deliveryId: text('delivery_id').notNull(),
  eventType: text('event_type').notNull(),
  eventFingerprint: text('event_fingerprint').notNull(),
  providerOccurredAt: timestamp('provider_occurred_at', { withTimezone: true }),
  rawEvent: jsonb('raw_event').notNull(),
  processingStatus: text('processing_status').notNull().default('received'),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  errorCode: text('error_code'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  tenantRepositoryForeignKey: foreignKey({
    name: 'provider_event_deliveries_tenant_repository_fk',
    columns: [table.tenantId, table.repositoryId],
    foreignColumns: [scmRepositories.tenantId, scmRepositories.id],
  }),
  tenantProviderDeliveryUnique: unique(
    'provider_event_deliveries_tenant_provider_delivery_key',
  ).on(table.tenantId, table.provider, table.deliveryId),
  tenantProviderFingerprintIndex: index(
    'provider_event_deliveries_tenant_provider_fingerprint_idx',
  ).on(table.tenantId, table.provider, table.eventFingerprint),
  tenantReceivedAtIndex: index('provider_event_deliveries_tenant_received_at_idx')
    .on(table.tenantId, table.receivedAt),
  statusCheck: check('provider_event_deliveries_status_check', sql`${table.processingStatus} in (
    'received', 'projected', 'applied', 'duplicate', 'stale', 'conflict', 'unsequenced', 'failed'
  )`),
}));

/** Last authoritative version applied to each mutable provider projection. */
export const providerProjectionCursors = pgTable('provider_projection_cursors', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  provider: text('provider').notNull(),
  projectionType: text('projection_type').notNull(),
  projectionKey: text('projection_key').notNull(),
  lastProviderOccurredAt: timestamp('last_provider_occurred_at', { withTimezone: true }),
  lastEventFingerprint: text('last_event_fingerprint').notNull(),
  lastDeliveryId: text('last_delivery_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderProjectionUnique: unique(
    'provider_projection_cursors_tenant_provider_projection_key',
  ).on(table.tenantId, table.provider, table.projectionType, table.projectionKey),
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

/** Final retained AI attribution grouped by the originating tool/model. */
export const aiCommitModelAttributions = pgTable('ai_commit_model_attributions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  commitId: uuid('commit_id').references(() => scmCommits.id).notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  internalSessionId: text('internal_session_id'),
  tool: text('tool').notNull(),
  model: text('model'),
  modelKey: text('model_key').notNull(),
  observedAiLines: integer('observed_ai_lines').notNull().default(0),
  evidenceType: text('evidence_type').notNull(),
  evidenceRef: text('evidence_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantCommitModelUnique: unique('ai_commit_model_attributions_tenant_commit_model_key')
    .on(table.tenantId, table.commitId, table.modelKey),
  tenantModelIndex: index('ai_commit_model_attributions_tenant_model_idx')
    .on(table.tenantId, table.modelKey),
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

/** Model-specific projection; aggregate lifecycle evidence remains authoritative. */
export const aiModelLifecycleEvents = pgTable('ai_model_lifecycle_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id).notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  commitId: uuid('commit_id').references(() => scmCommits.id),
  pullRequestId: uuid('pull_request_id').references(() => scmPullRequests.id),
  tool: text('tool').notNull(),
  model: text('model'),
  modelKey: text('model_key').notNull(),
  stage: text('stage').notNull(),
  lineCount: integer('line_count').notNull(),
  actorKind: text('actor_kind'),
  actorModelKey: text('actor_model_key'),
  evidenceType: text('evidence_type').notNull(),
  evidenceRef: text('evidence_ref').notNull(),
  confidence: integer('confidence').notNull().default(100),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantModelLifecycleUnique: unique('ai_model_lifecycle_events_tenant_stage_evidence_key')
    .on(table.tenantId, table.stage, table.evidenceRef),
  tenantModelLifecycleIndex: index('ai_model_lifecycle_events_tenant_model_idx')
    .on(table.tenantId, table.modelKey, table.occurredAt),
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
export type Tenant = typeof ssoTenants.$inferSelect;
export type TenantAdminMembership = typeof tenantAdminMemberships.$inferSelect;
export type SCMRepository = typeof scmRepositories.$inferSelect;
export type NewSCMRepository = typeof scmRepositories.$inferInsert;
export type DeveloperMachine = typeof developerMachines.$inferSelect;
export type MachineCredential = typeof machineCredentials.$inferSelect;
export type RepositoryEnrollment = typeof repositoryEnrollments.$inferSelect;
export type RepositoryBackfillAuthorization = typeof repositoryBackfillAuthorizations.$inferSelect;
export type MachineRepositoryGrant = typeof machineRepositoryGrants.$inferSelect;
export type SecurityAuditEvent = typeof securityAuditEvents.$inferSelect;
export type TenantRetentionPolicy = typeof tenantRetentionPolicies.$inferSelect;
export type EvidenceExportJob = typeof evidenceExportJobs.$inferSelect;
export type EvidenceArchiveEntry = typeof evidenceArchiveEntries.$inferSelect;
export type RetentionRun = typeof retentionRuns.$inferSelect;
export type GitHubAppInstallation = typeof githubAppInstallations.$inferSelect;
export type GitHubAppCredentialVersion = typeof githubAppCredentialVersions.$inferSelect;
export type SCMPullRequest = typeof scmPullRequests.$inferSelect;
export type NewSCMPullRequest = typeof scmPullRequests.$inferInsert;
export type SCMContributor = typeof scmContributors.$inferSelect;
export type NewSCMContributor = typeof scmContributors.$inferInsert;
export type SCMBranch = typeof scmBranches.$inferSelect;
export type NewSCMBranch = typeof scmBranches.$inferInsert;
export type TelemetryIngestBatch = typeof telemetryIngestBatches.$inferSelect;
export type TelemetryMetricEvent = typeof telemetryMetricEvents.$inferSelect;
export type ProviderEventDelivery = typeof providerEventDeliveries.$inferSelect;
export type ProviderProjectionCursor = typeof providerProjectionCursors.$inferSelect;
export type SCMCommit = typeof scmCommits.$inferSelect;
export type SCMCommitFile = typeof scmCommitFiles.$inferSelect;
export type AISession = typeof aiSessions.$inferSelect;
export type AISessionUsage = typeof aiSessionUsage.$inferSelect;
export type TelemetryCorrection = typeof telemetryCorrections.$inferSelect;
