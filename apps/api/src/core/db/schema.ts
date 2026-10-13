import {
  check,
  customType,
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
  vector,
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

/** PostgreSQL search document. Its terms are sensitive tenant-derived data. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

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

/** Narrow Task6 activation setting. This is independent from Task5 evidence consent. */
export const tenantSecurityMonitorSettings = pgTable('tenant_security_monitor_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  mode: text('mode').$type<'off' | 'monitor'>().notNull().default('off'),
  version: integer('version').notNull().default(1),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  updatedBy: text('updated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantUnique: unique('tenant_security_monitor_settings_tenant_key').on(table.tenantId),
  modeCheck: check('tenant_security_monitor_settings_mode_check',
    sql`${table.mode} in ('off', 'monitor')`),
  versionCheck: check('tenant_security_monitor_settings_version_check', sql`${table.version} >= 1`),
  intervalCheck: check('tenant_security_monitor_settings_interval_check', sql`
    (${table.validUntil} is null or ${table.validUntil} > ${table.createdAt})
    and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})
  `),
}));

/** Immutable desired-state snapshots for explicitly assigned managed machines. */
export const fleetConfigurations = pgTable('fleet_configurations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  epoch: integer('epoch').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  generatedBy: text('generated_by').notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  targetClientVersion: text('target_client_version').notNull(),
  clientMinimumVersion: text('client_minimum_version'),
  clientMaximumVersion: text('client_maximum_version'),
  releaseTag: text('release_tag'),
  manifestUrl: text('manifest_url'),
  manifestSha256: text('manifest_sha256'),
  channel: text('channel')
    .$type<'latest' | 'next' | 'enterprise-latest' | 'enterprise-next'>().notNull(),
  ring: text('ring'),
  snapshot: jsonb('snapshot').$type<{
    repositoryPolicies: Array<{
      machineId: string;
      repositoryId: string;
      enrollmentId: string;
      grantId: string;
      branchPatterns: string[];
      effectiveFrom: string;
      effectiveUntil: string | null;
    }>;
    securityActivation: { mode: 'off' | 'monitor'; version: number };
  }>().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('fleet_configurations_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantEpochUnique: unique('fleet_configurations_tenant_epoch_key')
    .on(table.tenantId, table.epoch),
  tenantGeneratedIndex: index('fleet_configurations_tenant_generated_idx')
    .on(table.tenantId, table.generatedAt),
  epochCheck: check('fleet_configurations_epoch_check', sql`${table.epoch} >= 1`),
  schemaVersionCheck: check('fleet_configurations_schema_version_check',
    sql`${table.schemaVersion} in (1, 2)`),
  releaseContractCheck: check('fleet_configurations_release_contract_check', sql`
    (${table.schemaVersion} = 1
      and ${table.clientMinimumVersion} is null
      and ${table.clientMaximumVersion} is null
      and ${table.releaseTag} is null
      and ${table.manifestUrl} is null
      and ${table.manifestSha256} is null)
    or (${table.schemaVersion} = 2
      and ${table.clientMinimumVersion} is not null
      and ${table.clientMaximumVersion} is not null
      and ${table.releaseTag} is not null
      and ${table.manifestUrl} is not null
      and ${table.manifestSha256} is not null)
  `),
  channelCheck: check('fleet_configurations_channel_check', sql`
    ${table.channel} in ('latest', 'next', 'enterprise-latest', 'enterprise-next')
  `),
  boundedMetadataCheck: check('fleet_configurations_bounded_metadata_check', sql`
    length(${table.generatedBy}) between 1 and 255
    and length(${table.targetClientVersion}) between 1 and 64
    and (${table.clientMinimumVersion} is null or length(${table.clientMinimumVersion}) between 1 and 64)
    and (${table.clientMaximumVersion} is null or length(${table.clientMaximumVersion}) between 1 and 64)
    and (${table.releaseTag} is null or length(${table.releaseTag}) between 1 and 128)
    and (${table.manifestUrl} is null or length(${table.manifestUrl}) between 1 and 512)
    and (${table.manifestSha256} is null or ${table.manifestSha256} ~ '^[0-9a-f]{64}$')
    and (${table.ring} is null or length(${table.ring}) between 1 and 64)
    and (${table.validUntil} is null or ${table.validUntil} > ${table.generatedAt})
    and jsonb_typeof(${table.snapshot}) = 'object'
    and octet_length(${table.snapshot}::text) <= 65536
  `),
}));

/** One desired/observed metadata-only state row per managed machine. */
export const fleetMachineStates = pgTable('fleet_machine_states', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  machineId: uuid('machine_id').notNull(),
  desiredConfigurationId: uuid('desired_configuration_id'),
  acknowledgedConfigurationId: uuid('acknowledged_configuration_id'),
  acknowledgedEpoch: integer('acknowledged_epoch'),
  acknowledgementResult: text('acknowledgement_result').$type<
    'applied' | 'rejected_invalid' | 'rejected_expired' | 'rejected_incompatible'
    | 'verification_unavailable' | 'verification_rejected' | 'activation_failed' | 'unavailable'
  >(),
  platform: text('platform').$type<'macos' | 'windows'>(),
  osVersion: text('os_version'),
  architecture: text('architecture').$type<'x86_64' | 'aarch64'>(),
  gitaiVersion: text('gitai_version'),
  serviceState: text('service_state').$type<'running' | 'stopped' | 'degraded' | 'unavailable'>(),
  pendingRetryable: integer('pending_retryable'),
  waitingRetry: integer('waiting_retry'),
  processing: integer('processing'),
  quarantined: integer('quarantined'),
  rowsWithErrors: integer('rows_with_errors'),
  mdmDeviceReference: text('mdm_device_reference'),
  mdmUserReference: text('mdm_user_reference'),
  assignmentSource: text('assignment_source')
    .$type<'jamf' | 'intune' | 'manual' | 'unavailable'>(),
  assignmentObservedAt: timestamp('assignment_observed_at', { withTimezone: true }),
  lastReportAt: timestamp('last_report_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('fleet_machine_states_tenant_id_id_key')
    .on(table.tenantId, table.id),
  tenantMachineUnique: unique('fleet_machine_states_tenant_machine_key')
    .on(table.tenantId, table.machineId),
  tenantMachineForeignKey: foreignKey({
    name: 'fleet_machine_states_tenant_machine_fk',
    columns: [table.tenantId, table.machineId],
    foreignColumns: [developerMachines.tenantId, developerMachines.id],
  }),
  tenantDesiredConfigurationForeignKey: foreignKey({
    name: 'fleet_machine_states_tenant_desired_configuration_fk',
    columns: [table.tenantId, table.desiredConfigurationId],
    foreignColumns: [fleetConfigurations.tenantId, fleetConfigurations.id],
  }),
  tenantAcknowledgedConfigurationForeignKey: foreignKey({
    name: 'fleet_machine_states_tenant_acknowledged_configuration_fk',
    columns: [table.tenantId, table.acknowledgedConfigurationId],
    foreignColumns: [fleetConfigurations.tenantId, fleetConfigurations.id],
  }),
  tenantDesiredIndex: index('fleet_machine_states_tenant_desired_idx')
    .on(table.tenantId, table.desiredConfigurationId),
  tenantReportIndex: index('fleet_machine_states_tenant_report_idx')
    .on(table.tenantId, table.lastReportAt),
  acknowledgementCheck: check('fleet_machine_states_acknowledgement_check', sql`
    (${table.acknowledgedConfigurationId} is null
      and ${table.acknowledgedEpoch} is null
      and ${table.acknowledgementResult} is null)
    or (${table.acknowledgedConfigurationId} is not null
      and ${table.acknowledgedEpoch} >= 1
      and ${table.acknowledgementResult} in (
        'applied', 'rejected_invalid', 'rejected_expired', 'rejected_incompatible',
        'verification_unavailable', 'verification_rejected', 'activation_failed', 'unavailable'
      ))
  `),
  postureCheck: check('fleet_machine_states_posture_check', sql`
    (${table.platform} is null or ${table.platform} in ('macos', 'windows'))
    and (${table.architecture} is null or ${table.architecture} in ('x86_64', 'aarch64'))
    and (${table.serviceState} is null or ${table.serviceState} in ('running', 'stopped', 'degraded', 'unavailable'))
    and (${table.assignmentSource} is null or ${table.assignmentSource} in ('jamf', 'intune', 'manual', 'unavailable'))
  `),
  countCheck: check('fleet_machine_states_count_check', sql`
    (${table.pendingRetryable} is null or ${table.pendingRetryable} between 0 and 1000000)
    and (${table.waitingRetry} is null or ${table.waitingRetry} between 0 and 1000000)
    and (${table.processing} is null or ${table.processing} between 0 and 1000000)
    and (${table.quarantined} is null or ${table.quarantined} between 0 and 1000000)
    and (${table.rowsWithErrors} is null or ${table.rowsWithErrors} between 0 and 1000000)
  `),
  boundedMetadataCheck: check('fleet_machine_states_bounded_metadata_check', sql`
    (${table.osVersion} is null or length(${table.osVersion}) between 1 and 128)
    and (${table.gitaiVersion} is null or length(${table.gitaiVersion}) between 1 and 64)
    and (${table.mdmDeviceReference} is null or length(${table.mdmDeviceReference}) between 1 and 255)
    and (${table.mdmUserReference} is null or length(${table.mdmUserReference}) between 1 and 255)
  `),
  assignmentEvidenceCheck: check('fleet_machine_states_assignment_evidence_check', sql`
    (${table.assignmentSource} is null and ${table.assignmentObservedAt} is null)
    or (${table.assignmentSource} is not null and ${table.assignmentObservedAt} is not null)
  `),
}));

/** Immutable, metadata-only Task6 monitor findings accepted from managed machines. */
export const securityFindings = pgTable('security_findings', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  machineId: uuid('machine_id').notNull(),
  repositoryId: uuid('repository_id').notNull(),
  findingId: text('finding_id').notNull(),
  deliveryId: text('delivery_id').notNull(),
  sessionId: text('session_id').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  correlationId: text('correlation_id'),
  ruleId: text('rule_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  ruleCategory: text('rule_category').notNull(),
  ruleSeverity: text('rule_severity').notNull(),
  routeId: text('route_id').notNull(),
  agentFamily: text('agent_family').notNull(),
  hostSurface: text('host_surface').notNull(),
  hostMode: text('host_mode').notNull(),
  captureChannel: text('capture_channel').notNull(),
  operatingSystem: text('operating_system').notNull(),
  timing: text('timing').notNull(),
  nativeEffect: text('native_effect').notNull(),
  activation: text('activation').notNull(),
  effect: text('effect').notNull(),
  phase: text('phase').notNull(),
  availability: text('availability').notNull(),
  completeness: text('completeness').notNull(),
  resultCategory: text('result_category').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  clientVersion: text('client_version').notNull(),
  rulePackVersion: text('rule_pack_version').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantDeliveryUnique: unique('security_findings_tenant_delivery_key')
    .on(table.tenantId, table.deliveryId),
  tenantFindingUnique: unique('security_findings_tenant_finding_key')
    .on(table.tenantId, table.findingId),
  tenantMachineForeignKey: foreignKey({
    name: 'security_findings_tenant_machine_fk',
    columns: [table.tenantId, table.machineId],
    foreignColumns: [developerMachines.tenantId, developerMachines.id],
  }),
  tenantRepositoryForeignKey: foreignKey({
    name: 'security_findings_tenant_repository_fk',
    columns: [table.tenantId, table.repositoryId],
    foreignColumns: [scmRepositories.tenantId, scmRepositories.id],
  }),
  tenantRepositoryOccurredIndex: index('security_findings_tenant_repository_occurred_idx')
    .on(table.tenantId, table.repositoryId, table.occurredAt),
  tenantMachineReceivedIndex: index('security_findings_tenant_machine_received_idx')
    .on(table.tenantId, table.machineId, table.receivedAt),
  ruleIdCheck: check('security_findings_rule_id_check', sql`${table.ruleId} in (
    'trackai.exec.destructive_recursive_delete',
    'trackai.exec.download_pipe_shell',
    'trackai.exec.reverse_shell'
  )`),
  ruleCategoryCheck: check('security_findings_rule_category_check',
    sql`${table.ruleCategory} = 'execution'`),
  ruleSeverityCheck: check('security_findings_rule_severity_check',
    sql`${table.ruleSeverity} in ('high', 'critical')`),
  routeCheck: check('security_findings_route_check', sql`
    ${table.routeId} = 'AC-CLI-03'
    and ${table.agentFamily} = 'opencode'
    and ${table.hostSurface} = 'terminal'
    and ${table.hostMode} = 'cli'
    and ${table.captureChannel} = 'provider-plugin'
    and ${table.nativeEffect} = 'observe_only'
  `),
  operatingSystemCheck: check('security_findings_operating_system_check',
    sql`${table.operatingSystem} in ('macos', 'linux', 'windows', 'wsl', 'unavailable')`),
  timingCheck: check('security_findings_timing_check',
    sql`${table.timing} in ('pre_action', 'post_action', 'at_rest', 'unavailable')`),
  activationCheck: check('security_findings_activation_check',
    sql`${table.activation} in ('configured', 'loaded', 'observed', 'unavailable')`),
  effectCheck: check('security_findings_effect_check', sql`${table.effect} = 'monitor'`),
  phaseCheck: check('security_findings_phase_check',
    sql`${table.phase} in ('requested', 'observed_result', 'partial', 'unavailable')`),
  availabilityCheck: check('security_findings_availability_check',
    sql`${table.availability} in ('available', 'unavailable', 'redacted', 'expired')`),
  completenessCheck: check('security_findings_completeness_check',
    sql`${table.completeness} in ('complete', 'partial')`),
  resultCategoryCheck: check('security_findings_result_category_check', sql`
    ${table.resultCategory} in (
      'not_observed', 'success', 'failure', 'cancelled', 'unknown', 'unavailable'
    )
  `),
  boundedMetadataCheck: check('security_findings_bounded_metadata_check', sql`
    length(${table.findingId}) between 1 and 128
    and length(${table.deliveryId}) between 1 and 128
    and length(${table.sessionId}) between 1 and 128
    and length(${table.sourceEventId}) between 1 and 128
    and (${table.correlationId} is null or length(${table.correlationId}) between 1 and 128)
    and length(${table.ruleVersion}) between 1 and 32
    and length(${table.clientVersion}) between 1 and 64
    and length(${table.rulePackVersion}) between 1 and 64
  `),
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

/** Fixed Task5 consent boundary. Task6 may later evaluate richer policy behind it. */
export const tenantEvidenceSettings = pgTable('tenant_evidence_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  rawCollectionEnabled: boolean('raw_collection_enabled').notNull().default(false),
  provider: text('provider').$type<'opencode'>().notNull().default('opencode'),
  retentionDays: integer('retention_days').notNull().default(30),
  consentedBy: text('consented_by'),
  consentedAt: timestamp('consented_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderUnique: unique('tenant_evidence_settings_tenant_provider_key')
    .on(table.tenantId, table.provider),
  retentionCheck: check('tenant_evidence_settings_retention_check',
    sql`${table.retentionDays} = 30`),
  providerCheck: check('tenant_evidence_settings_provider_check',
    sql`${table.provider} = 'opencode'`),
}));

/** Metadata-only provider event. Sensitive payloads live in evidence_event_contents. */
export const evidenceEvents = pgTable('evidence_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  sessionId: uuid('session_id').references(() => aiSessions.id).notNull(),
  repositoryId: uuid('repository_id').references(() => scmRepositories.id),
  provider: text('provider').$type<'opencode'>().notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').$type<
    'prompt' | 'reasoning' | 'response' | 'tool_call' | 'tool_result'
  >().notNull(),
  traceId: text('trace_id'),
  model: text('model'),
  toolName: text('tool_name'),
  evidenceState: text('evidence_state').$type<'observed' | 'inferred' | 'corrected'>()
    .notNull().default('observed'),
  availability: text('availability').$type<'available' | 'unavailable' | 'redacted' | 'expired'>()
    .notNull().default('available'),
  sourceVersion: text('source_version').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  contentSha256: text('content_sha256'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantProviderEventUnique: unique('evidence_events_tenant_provider_event_key')
    .on(table.tenantId, table.provider, table.providerEventId),
  tenantSessionTimeIndex: index('evidence_events_tenant_session_time_idx')
    .on(table.tenantId, table.sessionId, table.occurredAt),
  stateCheck: check('evidence_events_state_check',
    sql`${table.evidenceState} in ('observed', 'inferred', 'corrected')`),
  availabilityCheck: check('evidence_events_availability_check',
    sql`${table.availability} in ('available', 'unavailable', 'redacted', 'expired')`),
  typeCheck: check('evidence_events_type_check', sql`${table.eventType} in
    ('prompt', 'reasoning', 'response', 'tool_call', 'tool_result')`),
}));

/** Envelope-encrypted raw event content, intentionally separated from metadata. */
export const evidenceEventContents = pgTable('evidence_event_contents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  eventId: uuid('event_id').references(() => evidenceEvents.id, { onDelete: 'cascade' }).notNull(),
  encryptedValue: jsonb('encrypted_value').$type<Record<string, unknown>>().notNull(),
  redactionSummary: jsonb('redaction_summary').$type<Record<string, number>>()
    .notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantEventUnique: unique('evidence_event_contents_tenant_event_key')
    .on(table.tenantId, table.eventId),
  tenantExpiryIndex: index('evidence_event_contents_tenant_expiry_idx')
    .on(table.tenantId, table.expiresAt),
}));

/** Customer goal kept distinct from the verbatim prompt that may support it. */
export const evidenceIntentions = pgTable('evidence_intentions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  seriesId: uuid('series_id').notNull(),
  version: integer('version').notNull().default(1),
  lifecycle: text('lifecycle').$type<'provisional' | 'finalized' | 'abandoned'>()
    .notNull().default('provisional'),
  supersedesIntentionId: uuid('supersedes_intention_id'),
  isCurrent: boolean('is_current').notNull().default(true),
  sessionId: uuid('session_id').references(() => aiSessions.id),
  sourceEventId: uuid('source_event_id').references(() => evidenceEvents.id),
  encryptedValue: jsonb('encrypted_value').$type<Record<string, unknown>>().notNull(),
  contentFingerprint: text('content_fingerprint').notNull(),
  evidenceState: text('evidence_state').$type<'observed' | 'inferred' | 'corrected'>().notNull(),
  confidence: integer('confidence').notNull(),
  semanticAvailability: text('semantic_availability')
    .$type<'pending' | 'available' | 'unavailable' | 'expired'>().notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantSessionIndex: index('evidence_intentions_tenant_session_idx')
    .on(table.tenantId, table.sessionId),
  tenantSeriesVersionUnique: unique('evidence_intentions_tenant_series_version_key')
    .on(table.tenantId, table.seriesId, table.version),
  tenantCurrentSeriesIndex: index('evidence_intentions_tenant_current_series_idx')
    .on(table.tenantId, table.seriesId, table.isCurrent),
  stateCheck: check('evidence_intentions_state_check',
    sql`${table.evidenceState} in ('observed', 'inferred', 'corrected')`),
  confidenceCheck: check('evidence_intentions_confidence_check',
    sql`${table.confidence} between 0 and 100`),
  versionCheck: check('evidence_intentions_version_check', sql`${table.version} >= 1`),
  lifecycleCheck: check('evidence_intentions_lifecycle_check',
    sql`${table.lifecycle} in ('provisional', 'finalized', 'abandoned')`),
  semanticAvailabilityCheck: check('evidence_intentions_semantic_availability_check',
    sql`${table.semanticAvailability} in ('pending', 'available', 'unavailable', 'expired')`),
}));

/** Typed graph relationship; nodes remain owned by their authoritative tables. */
export const evidenceLinks = pgTable('evidence_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  fromType: text('from_type').notNull(),
  fromId: text('from_id').notNull(),
  toType: text('to_type').notNull(),
  toId: text('to_id').notNull(),
  relationship: text('relationship').notNull(),
  evidenceState: text('evidence_state').$type<'observed' | 'inferred' | 'corrected'>().notNull(),
  confidence: integer('confidence').notNull(),
  basis: text('basis').notNull(),
  correctedFromLinkId: uuid('corrected_from_link_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantEdgeUnique: unique('evidence_links_tenant_edge_key').on(
    table.tenantId, table.fromType, table.fromId, table.toType, table.toId, table.relationship,
  ),
  tenantFromIndex: index('evidence_links_tenant_from_idx')
    .on(table.tenantId, table.fromType, table.fromId),
  tenantToIndex: index('evidence_links_tenant_to_idx')
    .on(table.tenantId, table.toType, table.toId),
  stateCheck: check('evidence_links_state_check',
    sql`${table.evidenceState} in ('observed', 'inferred', 'corrected')`),
  confidenceCheck: check('evidence_links_confidence_check',
    sql`${table.confidence} between 0 and 100`),
}));

/** Encrypted customer narrative; never becomes an identity or attribution source. */
export const evidenceSummaries = pgTable('evidence_summaries', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  rootType: text('root_type').notNull(),
  rootId: text('root_id').notNull(),
  encryptedValue: jsonb('encrypted_value').$type<Record<string, unknown>>().notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantRootFingerprintUnique: unique('evidence_summaries_tenant_root_fingerprint_key')
    .on(table.tenantId, table.rootType, table.rootId, table.sourceFingerprint),
}));

/** Legacy encrypted token-set index. New search never reads this table. */
export const evidenceSemanticDocuments = pgTable('evidence_semantic_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  intentionId: uuid('intention_id').references(() => evidenceIntentions.id, { onDelete: 'cascade' })
    .notNull(),
  encryptedValue: jsonb('encrypted_value').$type<Record<string, unknown>>().notNull(),
  model: text('model').notNull().default('trackai-token-set-v1'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIntentionUnique: unique('evidence_semantic_documents_tenant_intention_key')
    .on(table.tenantId, table.intentionId),
}));

/** Searchable derived intention material. Never returned by customer APIs. */
export const evidenceIntentionEmbeddings = pgTable('evidence_intention_embeddings', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  intentionId: uuid('intention_id').notNull(),
  contentFingerprint: text('content_fingerprint').notNull(),
  model: text('model').notNull(),
  modelRevision: text('model_revision').notNull(),
  modelChecksum: text('model_checksum').notNull(),
  dimensions: integer('dimensions').notNull().default(384),
  embedding: vector('embedding', { dimensions: 384 }).notNull(),
  lexicalDocument: tsvector('lexical_document').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIntentionModelUnique: unique('evidence_intention_embeddings_tenant_intention_model_key')
    .on(table.tenantId, table.intentionId, table.modelRevision),
  tenantExpiryIndex: index('evidence_intention_embeddings_tenant_expiry_idx')
    .on(table.tenantId, table.expiresAt),
  dimensionsCheck: check('evidence_intention_embeddings_dimensions_check',
    sql`${table.dimensions} = 384`),
  tenantIntentionForeignKey: foreignKey({
    columns: [table.tenantId, table.intentionId],
    foreignColumns: [evidenceIntentions.tenantId, evidenceIntentions.id],
    name: 'evidence_intention_embeddings_tenant_intention_fk',
  }).onDelete('cascade'),
}));

/** Durable, idempotent local-model work; contains no plaintext customer content. */
export const evidenceSemanticJobs = pgTable('evidence_semantic_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  intentionId: uuid('intention_id').notNull(),
  contentFingerprint: text('content_fingerprint').notNull(),
  modelRevision: text('model_revision').notNull(),
  state: text('state').$type<'pending' | 'processing' | 'completed' | 'failed' | 'skipped'>()
    .notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  safeErrorCode: text('safe_error_code'),
  availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantJobUnique: unique('evidence_semantic_jobs_tenant_intention_fingerprint_model_key')
    .on(table.tenantId, table.intentionId, table.contentFingerprint, table.modelRevision),
  tenantStateAvailableIndex: index('evidence_semantic_jobs_tenant_state_available_idx')
    .on(table.tenantId, table.state, table.availableAt),
  stateCheck: check('evidence_semantic_jobs_state_check',
    sql`${table.state} in ('pending', 'processing', 'completed', 'failed', 'skipped')`),
  attemptCheck: check('evidence_semantic_jobs_attempt_check',
    sql`${table.attemptCount} between 0 and 5`),
  tenantIntentionForeignKey: foreignKey({
    columns: [table.tenantId, table.intentionId],
    foreignColumns: [evidenceIntentions.tenantId, evidenceIntentions.id],
    name: 'evidence_semantic_jobs_tenant_intention_fk',
  }).onDelete('cascade'),
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

/**
 * Attesta outbox (Task15c, frozen contract docs/contracts/attesta/outbox.md).
 * Task2 writes one thin pointer row in the same transaction as the observation;
 * Attesta's worker builds, signs and chains asynchronously. Source rows are
 * bound to the tenant at insert by enqueueAttestaSubject (no foreign keys to
 * them: those tables have no (tenant_id, id) key and Task2's reset deletes them).
 */
export const attestaSubjects = pgTable('attesta_subjects', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  repositoryId: uuid('repository_id').notNull(),
  kind: text('kind').$type<'commit_observed' | 'pr_merged' | 'deployed'>().notNull(),
  metricEventId: uuid('metric_event_id'),
  commitId: uuid('commit_id'),
  commitSha: text('commit_sha').notNull(),
  provider: text('provider'),
  providerDeliveryId: text('provider_delivery_id'),
  pullRequestId: uuid('pull_request_id'),
  deploymentId: uuid('deployment_id'),
  deploymentExternalId: text('deployment_external_id'),
  deploymentStatus: text('deployment_status'),
  eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  status: text('status').$type<'pending' | 'claimed' | 'done' | 'failed'>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  tenantIdIdUnique: unique('attesta_subjects_tenant_id_id_key').on(table.tenantId, table.id),
  tenantRepositoryForeignKey: foreignKey({
    name: 'attesta_subjects_tenant_repository_fk',
    columns: [table.tenantId, table.repositoryId],
    foreignColumns: [scmRepositories.tenantId, scmRepositories.id],
  }),
  // Idempotency keys, one per kind (ATTESTA_QUESTIONS.md decision 4).
  commitObservedKey: uniqueIndex('attesta_subjects_commit_observed_key')
    .on(table.tenantId, table.kind, table.metricEventId)
    .where(sql`${table.kind} = 'commit_observed'`),
  prMergedKey: uniqueIndex('attesta_subjects_pr_merged_key')
    .on(table.tenantId, table.kind, table.provider, table.providerDeliveryId)
    .where(sql`${table.kind} = 'pr_merged'`),
  deployedKey: uniqueIndex('attesta_subjects_deployed_key')
    .on(table.tenantId, table.kind, table.provider, table.deploymentExternalId, table.deploymentStatus)
    .where(sql`${table.kind} = 'deployed'`),
  claimIndex: index('attesta_subjects_status_not_before_idx').on(table.status, table.notBefore),
  tenantKindCreatedIndex: index('attesta_subjects_tenant_kind_created_idx')
    .on(table.tenantId, table.kind, table.createdAt),
  kindCheck: check('attesta_subjects_kind_check',
    sql`${table.kind} in ('commit_observed', 'pr_merged', 'deployed')`),
  kindShapeCheck: check('attesta_subjects_kind_shape_check', sql`
    (${table.kind} = 'commit_observed'
      and ${table.metricEventId} is not null and ${table.commitId} is not null
      and ${table.provider} is null and ${table.providerDeliveryId} is null
      and ${table.pullRequestId} is null and ${table.deploymentId} is null
      and ${table.deploymentExternalId} is null and ${table.deploymentStatus} is null)
    or (${table.kind} = 'pr_merged'
      and ${table.provider} is not null and ${table.providerDeliveryId} is not null
      and ${table.pullRequestId} is not null
      and ${table.metricEventId} is null and ${table.commitId} is null
      and ${table.deploymentId} is null and ${table.deploymentExternalId} is null
      and ${table.deploymentStatus} is null)
    or (${table.kind} = 'deployed'
      and ${table.provider} is not null and ${table.providerDeliveryId} is not null
      and ${table.deploymentId} is not null and ${table.deploymentExternalId} is not null and ${table.deploymentStatus} = 'success'
      and ${table.metricEventId} is null and ${table.commitId} is null
      and ${table.pullRequestId} is null)
  `),
  boundsCheck: check('attesta_subjects_bounds_check', sql`
    ${table.commitSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    and (${table.provider} is null or ${table.provider} ~ '^[a-z][a-z0-9_-]{0,31}$')
    and (${table.providerDeliveryId} is null or length(${table.providerDeliveryId}) between 1 and 128)
    and (${table.deploymentExternalId} is null or length(${table.deploymentExternalId}) between 1 and 128)
  `),
  statusCheck: check('attesta_subjects_status_check', sql`
    ${table.status} in ('pending', 'claimed', 'done', 'failed')
    and ${table.attempts} >= 0
    and (${table.status} <> 'claimed' or ${table.claimedAt} is not null)
    and (${table.status} not in ('done', 'failed') or ${table.processedAt} is not null)
    and (${table.status} <> 'pending' or (${table.processedAt} is null and ${table.claimedAt} is null))
    and (${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
  `),
}));

/** Raw bytes (PostgreSQL bytea). */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Attesta ledger (Task15d, binding design docs/contracts/attesta/tables.md).
 * One hash chain per tenant; ported from SushiCorp EV-1 @ 0bd67a5. The
 * database guards (migration 0017) make the chain append-only and gap-free;
 * writes go through chainStatement (features/attesta/ledger.ts) only.
 */
export const chainHead = pgTable('chain_head', {
  tenantId: uuid('tenant_id').references(() => ssoTenants.id).primaryKey(),
  /** The seq the next record must take. */
  nextSeq: bigint('next_seq', { mode: 'number' }).notNull(),
  /** record_hash of the record at next_seq - 1; GENESIS_PREV_HASH for an empty chain. */
  headHash: text('head_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nextSeqCheck: check('chain_head_next_seq_check', sql`${table.nextSeq} >= 0`),
  headHashCheck: check('chain_head_head_hash_check', sql`${table.headHash} ~ '^sha256:[0-9a-f]{64}$'`),
}));

export const attestaRecords = pgTable('attesta_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  prevHash: text('prev_hash').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  recordKind: text('record_kind').$type<'statement'>().notNull(),
  statementDigest: text('statement_digest').notNull(),
  predicateType: text('predicate_type').notNull(),
  statementKind: text('statement_kind').$type<'commit_observed' | 'pr_merged' | 'deployed'>(),
  repositoryId: uuid('repository_id').notNull(),
  subjectSha: text('subject_sha'),
  /** The exact RFC 8785 statement bytes that were signed. */
  statementCanonical: text('statement_canonical').notNull(),
  /** The exact RFC 8785 bytes hashed into record_hash. Never re-serialized. */
  canonicalRecord: text('canonical_record').notNull(),
  recordHash: text('record_hash').notNull(),
  outboxSubjectId: uuid('outbox_subject_id'),
}, (table) => ({
  tenantIdIdUnique: unique('attesta_records_tenant_id_id_key').on(table.tenantId, table.id),
  tenantSeqUnique: unique('attesta_records_tenant_seq_key').on(table.tenantId, table.seq),
  tenantDigestUnique: unique('attesta_records_tenant_statement_digest_key')
    .on(table.tenantId, table.statementDigest),
  // One outbox row yields at most one chained statement, however often it is retried.
  tenantOutboxUnique: uniqueIndex('attesta_records_tenant_outbox_subject_key')
    .on(table.tenantId, table.outboxSubjectId)
    .where(sql`${table.outboxSubjectId} is not null`),
  tenantRepositoryForeignKey: foreignKey({
    name: 'attesta_records_tenant_repository_fk',
    columns: [table.tenantId, table.repositoryId],
    foreignColumns: [scmRepositories.tenantId, scmRepositories.id],
  }),
  // "Statements about the same subject" (previous) under the chain lock.
  subjectIndex: index('attesta_records_tenant_subject_idx')
    .on(table.tenantId, table.repositoryId, table.subjectSha, table.seq),
  shapeCheck: check('attesta_records_shape_check', sql`
    ${table.seq} >= 0
    and ${table.recordKind} = 'statement'
    and ${table.prevHash} ~ '^sha256:[0-9a-f]{64}$'
    and ${table.recordHash} ~ '^sha256:[0-9a-f]{64}$'
    and ${table.statementDigest} ~ '^sha256:[0-9a-f]{64}$'
    and ${table.predicateType} = 'https://trackai.dev/attesta/ai-provenance/v1'
    and ${table.statementKind} is not null
    and ${table.statementKind} in ('commit_observed', 'pr_merged', 'deployed')
    and ${table.subjectSha} is not null
    and ${table.subjectSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  `),
}));

export const attestaEnvelopes = pgTable('attesta_envelopes', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  recordId: uuid('record_id').notNull(),
  payloadType: text('payload_type').notNull(),
  /** "sha256:" + hex(SHA-256(SPKI DER)) of the signing key. */
  keyid: text('keyid').notNull(),
  /** Internal signer credential; never published in the envelope. */
  credentialId: text('credential_id').notNull(),
  signatureDer: bytea('signature_der').notNull(),
  envelope: jsonb('envelope').notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('attesta_envelopes_tenant_id_id_key').on(table.tenantId, table.id),
  tenantRecordUnique: unique('attesta_envelopes_tenant_record_key').on(table.tenantId, table.recordId),
  tenantRecordForeignKey: foreignKey({
    name: 'attesta_envelopes_tenant_record_fk',
    columns: [table.tenantId, table.recordId],
    foreignColumns: [attestaRecords.tenantId, attestaRecords.id],
  }),
  shapeCheck: check('attesta_envelopes_shape_check', sql`
    ${table.payloadType} = 'application/vnd.in-toto+json'
    and ${table.keyid} ~ '^sha256:[0-9a-f]{64}$'
    and length(${table.credentialId}) between 1 and 256
    and octet_length(${table.signatureDer}) between 8 and 128
  `),
}));

/**
 * Attesta anchoring (Task15f2, A15.5; binding design docs/contracts/attesta/tables.md
 * §attesta_anchor_batches and attesta_anchors). Ported from SushiCorp EV-2 @ 0bd67a5.
 * Both tables are append-only (migration 0018 guards): one row per batch, one row per
 * record, anchor type and attempt; no row means pending. Anchoring never touches
 * attesta_records. Writes go through features/attesta/anchor-worker.ts only.
 */
export const attestaAnchorBatches = pgTable('attesta_anchor_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  /** "<tenant_id>:<seq_from>-<seq_to>": deterministic, so a retry re-forms the same root. */
  batchId: text('batch_id').notNull(),
  seqFrom: bigint('seq_from', { mode: 'number' }).notNull(),
  seqTo: bigint('seq_to', { mode: 'number' }).notNull(),
  /** "sha256:<hex>" RFC 6962 root over the 32 raw bytes of each record_hash. */
  merkleRoot: text('merkle_root').notNull(),
  leafCount: integer('leaf_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  batchIdUnique: unique('attesta_anchor_batches_batch_id_key').on(table.batchId),
  tenantIdIdUnique: unique('attesta_anchor_batches_tenant_id_id_key').on(table.tenantId, table.id),
  tenantBatchIdUnique: unique('attesta_anchor_batches_tenant_batch_id_key').on(table.tenantId, table.batchId),
  // The planner reads a tenant's last batch (max seq_to).
  tenantSeqToIndex: index('attesta_anchor_batches_tenant_seq_to_idx').on(table.tenantId, table.seqTo),
  shapeCheck: check('attesta_anchor_batches_shape_check', sql`
    ${table.seqFrom} >= 0
    and ${table.seqFrom} <= ${table.seqTo}
    and ${table.leafCount} = ${table.seqTo} - ${table.seqFrom} + 1
    and ${table.leafCount} <= 4096
    and ${table.batchId} = ${table.tenantId}::text || ':' || ${table.seqFrom}::text || '-' || ${table.seqTo}::text
    and ${table.merkleRoot} ~ '^sha256:[0-9a-f]{64}$'
  `),
}));

export const attestaAnchors = pgTable('attesta_anchors', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  batchId: text('batch_id').notNull(),
  recordId: uuid('record_id').notNull(),
  anchorType: text('anchor_type').$type<'rekor' | 'tsa'>().notNull(),
  status: text('status').$type<'anchored' | 'failed'>().notNull(),
  /** EV-2 v1 proof JSON (tables.md per-kind shape); null for a failed attempt. */
  inclusionProof: jsonb('inclusion_proof'),
  rekorEntryUuid: text('rekor_entry_uuid'),
  tsaTokenB64: text('tsa_token_b64'),
  /** errors.md §Anchoring code of a failed attempt. */
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tenantIdIdUnique: unique('attesta_anchors_tenant_id_id_key').on(table.tenantId, table.id),
  tenantBatchForeignKey: foreignKey({
    name: 'attesta_anchors_tenant_batch_fk',
    columns: [table.tenantId, table.batchId],
    foreignColumns: [attestaAnchorBatches.tenantId, attestaAnchorBatches.batchId],
  }),
  tenantRecordForeignKey: foreignKey({
    name: 'attesta_anchors_tenant_record_fk',
    columns: [table.tenantId, table.recordId],
    foreignColumns: [attestaRecords.tenantId, attestaRecords.id],
  }),
  // One anchored row per record and anchor type; failed attempts are not limited.
  anchoredUnique: uniqueIndex('attesta_anchors_anchored_key')
    .on(table.tenantId, table.recordId, table.anchorType)
    .where(sql`${table.status} = 'anchored'`),
  batchIndex: index('attesta_anchors_tenant_batch_idx').on(table.tenantId, table.batchId, table.anchorType),
  shapeCheck: check('attesta_anchors_shape_check', sql`
    ${table.anchorType} in ('rekor', 'tsa')
    and ${table.status} in ('anchored', 'failed')
    and (
      (${table.status} = 'anchored' and ${table.inclusionProof} is not null and ${table.errorCode} is null
        and (
          (${table.anchorType} = 'rekor' and ${table.rekorEntryUuid} is not null and ${table.tsaTokenB64} is null)
          or (${table.anchorType} = 'tsa' and ${table.tsaTokenB64} is not null and ${table.rekorEntryUuid} is null)))
      or (${table.status} = 'failed' and ${table.errorCode} is not null and ${table.inclusionProof} is null
        and ${table.rekorEntryUuid} is null and ${table.tsaTokenB64} is null)
    )
    and (${table.errorCode} is null or ${table.errorCode} ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
    and (${table.rekorEntryUuid} is null or ${table.rekorEntryUuid} ~ '^([0-9a-f]{16})?[0-9a-f]{64}$')
    and (${table.tsaTokenB64} is null or (length(${table.tsaTokenB64}) between 4 and 131072
      and ${table.tsaTokenB64} ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'))
  `),
}));

/**
 * Attesta trust inventory (Task15l2, A15.12 part 2; binding design
 * docs/contracts/attesta/trust.md "Hierarchy", "Rotation and revocation procedures",
 * "Registration"). Public material only: the private keys stay in KMS (tenant keys in
 * the tenant's own KMS). `credential_ref` names the adapter credential and is never
 * published, printed or logged. Migration 0019 adds the guards: keyids unique across
 * both key tables, status only forward and only with an attesta_key_events row in the
 * same transaction, platform key status only as the latest stored root document
 * lists it, documents append-only and chained (version + previous). Writes go through
 * features/attesta/trust-inventory.ts only.
 * Ported from SushiCorp A1b db/migrations/versions/0007_signing_inventory.py @ 0bd67a5
 * (catalog SG-1): public-only inventory, adapter-qualified opaque credential reference.
 */
const TRUST_KEY_STATUS_SQL = `'registered', 'active', 'retired', 'revoked'`;

export const attestaPlatformKeys = pgTable('attesta_platform_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** `sha256:` + hex(SHA-256(spki_der)). */
  keyid: text('keyid').notNull(),
  /** A platform online purpose; `root` keys live only in root documents. */
  purpose: text('purpose').notNull(),
  adapterName: text('adapter_name').notNull(),
  /** Adapter credential (names the KMS key through the credentials file). Internal only. */
  credentialRef: text('credential_ref').notNull(),
  spkiDer: bytea('spki_der').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true, precision: 3 }).notNull(),
  notAfter: timestamp('not_after', { withTimezone: true, precision: 3 }).notNull(),
  status: text('status').$type<'registered' | 'active' | 'retired' | 'revoked'>().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 3 }),
  revocationReason: text('revocation_reason').$type<'superseded' | 'compromised'>(),
  compromisedSince: timestamp('compromised_since', { withTimezone: true, precision: 3 }),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  /** `sha256:` of the signed proof-of-possession envelope (the envelope itself is not kept). */
  popDigest: text('pop_digest').notNull(),
}, (table) => ({
  keyidUnique: unique('attesta_platform_keys_keyid_key').on(table.keyid),
  shapeCheck: check('attesta_platform_keys_shape_check', sql`
    ${table.purpose} in ('anchor', 'activation_lease', 'fleet_config', 'policy_bundle', 'release', 'tenant_keyset')
    and ${table.keyid} = 'sha256:' || encode(sha256(${table.spkiDer}), 'hex')
    and length(${table.spkiDer}) = 91
    and ${table.adapterName} ~ '^[a-z][a-z0-9-]{0,31}$'
    and length(${table.credentialRef}) between 1 and 512
    and ${table.notBefore} < ${table.notAfter}
    and ${table.popDigest} ~ '^sha256:[0-9a-f]{64}$'
    and ${table.status} in (${sql.raw(TRUST_KEY_STATUS_SQL)})
    and (${table.status} in ('registered', 'active')) = (${table.revokedAt} is null)
    and (${table.status} = 'revoked') = (${table.revocationReason} is not null)
    and (${table.revocationReason} is null or ${table.revocationReason} in ('superseded', 'compromised'))
    and (coalesce(${table.revocationReason}, '') = 'compromised') = (${table.compromisedSince} is not null)
    and (${table.compromisedSince} is null or ${table.compromisedSince} <= ${table.revokedAt})
  `),
}));

export const attestaTenantKeys = pgTable('attesta_tenant_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: tenantIdColumn(),
  keyid: text('keyid').notNull(),
  /** Always `statement`: tenant keys sign that tenant's Attesta statements only. */
  purpose: text('purpose').notNull(),
  adapterName: text('adapter_name').notNull(),
  credentialRef: text('credential_ref').notNull(),
  spkiDer: bytea('spki_der').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true, precision: 3 }).notNull(),
  notAfter: timestamp('not_after', { withTimezone: true, precision: 3 }).notNull(),
  status: text('status').$type<'registered' | 'active' | 'retired' | 'revoked'>().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, precision: 3 }),
  revocationReason: text('revocation_reason').$type<'superseded' | 'compromised'>(),
  compromisedSince: timestamp('compromised_since', { withTimezone: true, precision: 3 }),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  popDigest: text('pop_digest').notNull(),
}, (table) => ({
  keyidUnique: unique('attesta_tenant_keys_keyid_key').on(table.keyid),
  tenantIdIdUnique: unique('attesta_tenant_keys_tenant_id_id_key').on(table.tenantId, table.id),
  // At most one active statement key per tenant (the resolver's answer is never ambiguous).
  oneActive: uniqueIndex('attesta_tenant_keys_one_active_key').on(table.tenantId).where(sql`${table.status} = 'active'`),
  shapeCheck: check('attesta_tenant_keys_shape_check', sql`
    ${table.purpose} = 'statement'
    and ${table.keyid} = 'sha256:' || encode(sha256(${table.spkiDer}), 'hex')
    and length(${table.spkiDer}) = 91
    and ${table.adapterName} ~ '^[a-z][a-z0-9-]{0,31}$'
    and length(${table.credentialRef}) between 1 and 512
    and ${table.notBefore} < ${table.notAfter}
    and ${table.popDigest} ~ '^sha256:[0-9a-f]{64}$'
    and ${table.status} in (${sql.raw(TRUST_KEY_STATUS_SQL)})
    and (${table.status} in ('registered', 'active')) = (${table.revokedAt} is null)
    and (${table.status} = 'revoked') = (${table.revocationReason} is not null)
    and (${table.revocationReason} is null or ${table.revocationReason} in ('superseded', 'compromised'))
    and (coalesce(${table.revocationReason}, '') = 'compromised') = (${table.compromisedSince} is not null)
    and (${table.compromisedSince} is null or ${table.compromisedSince} <= ${table.revokedAt})
  `),
}));

/** Append-only log of every applied inventory action (platform rows have no tenant). */
export const attestaKeyEvents = pgTable('attesta_key_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').references(() => ssoTenants.id),
  /** attesta_platform_keys.id (tenant_id null) or attesta_tenant_keys.id; null for publish / import_root. */
  keyId: uuid('key_id'),
  action: text('action').$type<'register' | 'activate' | 'retire' | 'revoke' | 'publish' | 'import_root'>().notNull(),
  actor: text('actor').notNull(),
  reason: text('reason'),
  documentVersion: bigint('document_version', { mode: 'number' }),
  requestId: text('request_id').notNull(),
  /** Forced to the transaction's now() by the 0019 guard (ties the event to its UPDATE). */
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  keyIndex: index('attesta_key_events_key_idx').on(table.keyId, table.action),
  tenantCreatedIndex: index('attesta_key_events_tenant_created_idx').on(table.tenantId, table.createdAt),
  shapeCheck: check('attesta_key_events_shape_check', sql`
    ${table.action} in ('register', 'activate', 'retire', 'revoke', 'publish', 'import_root')
    and (${table.action} in ('publish', 'import_root')) = (${table.keyId} is null)
    and (${table.action} in ('publish', 'import_root')) = (${table.documentVersion} is not null)
    and (${table.action} <> 'import_root' or ${table.tenantId} is null)
    and (${table.action} <> 'publish' or ${table.tenantId} is not null)
    and length(${table.actor}) between 1 and 128
    and (${table.reason} is null or length(${table.reason}) between 1 and 256)
    and length(${table.requestId}) between 1 and 128
    and (${table.documentVersion} is null or ${table.documentVersion} >= 1)
  `),
}));

/** Append-only signed trust documents: root documents (scope platform) and tenant key sets. */
export const attestaTrustDocuments = pgTable('attesta_trust_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** `platform` or the tenant UUID (lowercase). */
  scope: text('scope').notNull(),
  kind: text('kind').$type<'root' | 'keyset'>().notNull(),
  version: bigint('version', { mode: 'number' }).notNull(),
  /** `sha256:` of the payload bytes (what the next version's `previous` names). */
  digest: text('digest').notNull(),
  payloadType: text('payload_type').notNull(),
  /** The DSSE envelope exactly as signed. */
  envelope: jsonb('envelope').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  scopeVersionUnique: unique('attesta_trust_documents_scope_version_key').on(table.scope, table.version),
  shapeCheck: check('attesta_trust_documents_shape_check', sql`
    ((${table.kind} = 'root' and ${table.scope} = 'platform'
        and ${table.payloadType} = 'application/vnd.trackai.trust-root+json')
      or (${table.kind} = 'keyset'
        and ${table.scope} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and ${table.payloadType} = 'application/vnd.trackai.keyset+json'))
    and ${table.version} >= 1
    and ${table.digest} ~ '^sha256:[0-9a-f]{64}$'
  `),
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
export type TenantEvidenceSetting = typeof tenantEvidenceSettings.$inferSelect;
export type EvidenceEvent = typeof evidenceEvents.$inferSelect;
export type EvidenceEventContent = typeof evidenceEventContents.$inferSelect;
export type EvidenceIntention = typeof evidenceIntentions.$inferSelect;
export type EvidenceLink = typeof evidenceLinks.$inferSelect;
export type EvidenceSummary = typeof evidenceSummaries.$inferSelect;
export type EvidenceSemanticDocument = typeof evidenceSemanticDocuments.$inferSelect;
export type AttestaSubject = typeof attestaSubjects.$inferSelect;
export type AttestaAnchorBatch = typeof attestaAnchorBatches.$inferSelect;
export type AttestaAnchor = typeof attestaAnchors.$inferSelect;
