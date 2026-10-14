/**
 * Task16b (A16.3): the audit contract's types. One row of `security_audit_events`
 * (core/db/schema.ts:572-586) is described by one catalog entry; the emitter
 * (record.ts) refuses any row its entry does not describe. Contract: docs/contracts/audit/.
 */

/** Who acted (closed; README.md "Actor vocabulary"). */
export const AUDIT_ACTOR_TYPES = [
  'tenant_admin',
  'tenant_auditor',
  'tenant_user',
  'system_operator',
  'machine',
  'service',
] as const;
export type AuditActorType = typeof AUDIT_ACTOR_TYPES[number];

/** Derived from the catalog, never stored (no migration): README.md "Severity". */
export const AUDIT_SEVERITIES = ['high', 'notice', 'info'] as const;
export type AuditSeverity = typeof AUDIT_SEVERITIES[number];

/** `reserved` entries are planned; the emitter refuses them until the owning Task flips them. */
export type AuditStatus = 'emitted' | 'reserved';

/**
 * `row`: the id of the row acted on (a UUID unless the entry gives `targetIdPattern`);
 * `tenant`: a collection or tenant-scope event, target_id is the tenant id;
 * `compound`: a documented format, given as `targetIdPattern`.
 */
export type AuditTargetIdKind = 'row' | 'tenant' | 'compound';

/** Scalar detail types (README.md "Details"). */
export type AuditScalarType =
  | 'string' // at most 512 characters
  | 'reason' // operator free text, at most 1000 characters
  | 'integer' // a safe integer
  | 'boolean'
  | 'iso_timestamp' // RFC 3339 with a zone (Z or ±hh:mm)
  | 'uuid'
  | 'sha256_hex' // 64 lowercase hex characters
  | 'sha256_digest' // "sha256:" + 64 lowercase hex characters (Attesta digests and keyids)
  | 'string[]' // at most 200 items of `string`
  | 'uuid[]' // at most 200 items of `uuid`
  | 'counts' // an object of at most 64 keys, each a non-negative safe integer
  | 'string_map'; // an object of at most 64 keys, each a `string`

/** A detail type: a scalar, an enum, a declared object, or an array of a declared object. */
export type AuditDetailType =
  | AuditScalarType
  | { readonly enum: readonly string[] }
  | { readonly object: AuditDetailShape }
  | { readonly arrayOf: AuditDetailShape };

export interface AuditDetailKey {
  readonly type: AuditDetailType;
  /** Required: the key is always present. Optional keys may be absent. */
  readonly required: boolean;
  /** The value may be JSON null (today's emitters write null, never omit, for these). */
  readonly nullable: boolean;
}

export type AuditDetailShape = Readonly<Record<string, AuditDetailKey>>;

export interface AuditCatalogEntry {
  /** Frozen for v1: the exact string today's emitter writes (README.md "Names"). */
  readonly action: string;
  /** The Task that owns the emitter. */
  readonly owner: string;
  readonly status: AuditStatus;
  readonly severity: AuditSeverity;
  /** Actor types allowed for this action. */
  readonly actorTypes: readonly AuditActorType[];
  /** The exact target_type written. */
  readonly targetType: string;
  readonly targetIdKind: AuditTargetIdKind;
  /** Required for `compound`; for `row` it replaces the UUID check (non-UUID row ids). */
  readonly targetIdPattern?: RegExp;
  /** Plain-words description of a compound or non-UUID target id. */
  readonly targetIdNote?: string;
  /** Every details key, exactly as today's emitter writes it. `request_id` is implied (optional) everywhere. */
  readonly details: AuditDetailShape;
  /** Earlier names of this action (a future rename); none in v1. */
  readonly aliases: readonly string[];
  /** Emitting file:line (paths under apps/api/src/), or the owning plan for reserved entries. */
  readonly sources: readonly string[];
}

/** What a caller hands to the emitter. */
export interface AuditEvent {
  action: string;
  actorType: AuditActorType;
  actorId: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

/** The validated row the emitter inserts (column names as in core/db/schema.ts). */
export interface AuditRow {
  tenantId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

export const AUDIT_CONTRACT_ERROR_CODES = [
  'AUDIT_UNKNOWN_ACTION',
  'AUDIT_RESERVED_ACTION',
  'AUDIT_ACTOR_NOT_ALLOWED',
  'AUDIT_TARGET_INVALID',
  'AUDIT_DETAILS_INVALID',
] as const;
export type AuditContractErrorCode = typeof AUDIT_CONTRACT_ERROR_CODES[number];

/**
 * A row the contract refuses. The message names the action and the key, never a
 * details value (README.md: the emitter never logs a details value).
 */
export class AuditContractError extends Error {
  constructor(readonly code: AuditContractErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AuditContractError';
  }
}


// ---------------------------------------------------------------------------
// The catalog

/** Goes up when an entry is added or an alias recorded; never for a change of an existing row's meaning. */
export const AUDIT_CATALOG_VERSION = 1;

const r = (type: AuditDetailType): AuditDetailKey => ({ type, required: true, nullable: false });
/** Required, may be null: today's emitter writes `null` rather than omitting the key. */
const rn = (type: AuditDetailType): AuditDetailKey => ({ type, required: true, nullable: true });
const o = (type: AuditDetailType): AuditDetailKey => ({ type, required: false, nullable: false });
const oneOf = (...values: string[]): AuditDetailType => ({ enum: values });

const ADMIN: readonly AuditActorType[] = ['tenant_admin'];
/** Behind a guard both roles pass: the value comes from req.adminRole. */
const ADMIN_OR_AUDITOR: readonly AuditActorType[] = ['tenant_admin', 'tenant_auditor'];
const OPERATOR: readonly AuditActorType[] = ['system_operator'];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEQ = '(0|[1-9][0-9]{0,15})';
const KEYID_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** attesta_anchor_batches.batch_id "<tenant_id>:<seq_from>-<seq_to>" (attesta-anchor-resume-cli.ts:34). */
const BATCH_ID_PATTERN = new RegExp(`^${UUID}:${SEQ}-${SEQ}$`, 'i');
const BATCH_ID_NOTE = 'the anchor batch_id text "<tenant_id>:<seq_from>-<seq_to>", not the batch row uuid';

type Spec = Omit<AuditCatalogEntry, 'action' | 'aliases' | 'status'> & { status?: AuditStatus };

/** One entry per action; two actions written by one call site share a spec. */
function entries(actions: readonly string[], spec: Spec): AuditCatalogEntry[] {
  return actions.map(action => ({ status: 'emitted', ...spec, action, aliases: [] }));
}

const EVIDENCE_FAMILY = oneOf('generation_session', 'commit_note', 'operational');
const KEY_STATUS = oneOf('registered', 'active', 'retired', 'revoked');
const PACK_SCOPE: AuditDetailType = {
  object: { repository_id: rn('uuid'), from: r('iso_timestamp'), to: r('iso_timestamp') },
};
const REPORT_SCOPE: AuditDetailType = {
  object: { repository_id: r('uuid'), from: r('iso_timestamp'), to: r('iso_timestamp') },
};

/**
 * Every action written to security_audit_events, from the Task16a inventory
 * (docs/plan/AUDIT_EVENT_CATALOG.md §1, 47 actions) plus the reserved A16.11 entries.
 * Each entry's details are exactly what the cited call site writes (paths under apps/api/src/).
 */
export const AUDIT_CATALOG: readonly AuditCatalogEntry[] = [
  // --- Task4: repositories (core/security/repository-security-service.ts) -------------
  // :115 enrollRepository
  ...entries(['repository.enrolled', 'repository.reenrolled'], {
    owner: 'Task4', severity: 'notice', actorTypes: ADMIN,
    targetType: 'repository_enrollment', targetIdKind: 'row',
    details: {
      repositoryId: r('uuid'),
      effectiveFrom: r('iso_timestamp'),
      generationSessionEvidenceFrom: r('iso_timestamp'),
      commitNoteEvidenceFrom: r('iso_timestamp'),
      effectiveUntil: rn('iso_timestamp'),
      reason: rn('reason'),
    },
    sources: ['core/security/repository-security-service.ts:115'],
  }),
  // :184 authorizeRepositoryBackfill
  ...entries(['repository_backfill.authorized'], {
    owner: 'Task4', severity: 'notice', actorTypes: ADMIN,
    targetType: 'repository_backfill_authorization', targetIdKind: 'row',
    details: {
      enrollmentId: r('uuid'),
      evidenceFamily: r(EVIDENCE_FAMILY),
      occurredFrom: r('iso_timestamp'),
      occurredUntil: r('iso_timestamp'),
      expiresAt: r('iso_timestamp'),
      reason: r('reason'),
    },
    sources: ['core/security/repository-security-service.ts:184'],
  }),
  // :251 grantMachineRepository
  ...entries(['repository_grant.issued'], {
    owner: 'Task4', severity: 'notice', actorTypes: ADMIN,
    targetType: 'machine_repository_grant', targetIdKind: 'row',
    details: {
      machineId: r('uuid'),
      enrollmentId: r('uuid'),
      branchPatterns: r('string[]'),
      effectiveFrom: r('iso_timestamp'),
      effectiveUntil: rn('iso_timestamp'),
      reason: rn('reason'),
    },
    sources: ['core/security/repository-security-service.ts:251'],
  }),
  // :314 replaceMachineRepositoryGrantBranchScope
  ...entries(['repository_grant.branch_scope_replaced'], {
    owner: 'Task4', severity: 'notice', actorTypes: ADMIN,
    targetType: 'machine_repository_grant', targetIdKind: 'row',
    details: {
      previousGrantId: r('uuid'),
      machineId: r('uuid'),
      enrollmentId: r('uuid'),
      previousBranchPatterns: r('string[]'),
      branchPatterns: r('string[]'),
      reason: r('reason'),
    },
    sources: ['core/security/repository-security-service.ts:314'],
  }),
  // :350 revokeMachineRepositoryGrant
  ...entries(['repository_grant.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'machine_repository_grant', targetIdKind: 'row',
    details: { machineId: r('uuid'), reason: r('reason') },
    sources: ['core/security/repository-security-service.ts:350'],
  }),
  // :383 revokeRepositoryBackfillAuthorization
  ...entries(['repository_backfill.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'repository_backfill_authorization', targetIdKind: 'row',
    details: { enrollmentId: r('uuid'), evidenceFamily: r(EVIDENCE_FAMILY), reason: r('reason') },
    sources: ['core/security/repository-security-service.ts:383'],
  }),
  // :429 revokeRepositoryEnrollment
  ...entries(['repository.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'repository_enrollment', targetIdKind: 'row',
    details: {
      repositoryId: r('uuid'),
      reason: r('reason'),
      grantsRevoked: r('integer'),
      backfillAuthorizationsRevoked: r('boolean'),
    },
    sources: ['core/security/repository-security-service.ts:429'],
  }),

  // --- Task4: GitHub App (core/security/github-app-security-service.ts) ---------------
  // :114 createGitHubAppInstallation (metadata and the fingerprint; never the private key)
  ...entries(['github_app.installation_created'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'github_app_installation', targetIdKind: 'row',
    details: {
      providerHost: r('string'),
      appId: r('string'),
      installationExternalId: r('string'),
      accountLogin: r('string'),
      credentialId: r('uuid'),
      credentialFingerprint: r('sha256_hex'),
      permissions: r('string_map'),
      subscribedEvents: r('string[]'),
    },
    sources: ['core/security/github-app-security-service.ts:114'],
  }),
  // :192 rotateGitHubAppCredential
  ...entries(['github_app.credential_rotated'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'github_app_credential', targetIdKind: 'row',
    details: {
      installationId: r('uuid'),
      rotatedFromCredentialId: r('uuid'),
      overlapUntil: r('iso_timestamp'),
      credentialFingerprint: r('sha256_hex'),
    },
    sources: ['core/security/github-app-security-service.ts:192'],
  }),
  // :227 finishGitHubAppCredentialRotation
  ...entries(['github_app.rotation_finished'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'github_app_installation', targetIdKind: 'row',
    details: { retiredCredentialIds: r('uuid[]'), reason: r('reason') },
    sources: ['core/security/github-app-security-service.ts:227'],
  }),
  // :263 revokeGitHubAppInstallation
  ...entries(['github_app.installation_revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'github_app_installation', targetIdKind: 'row',
    details: { credentialsRevoked: r('boolean'), reason: r('reason') },
    sources: ['core/security/github-app-security-service.ts:263'],
  }),

  // --- Task4: machines (core/security/machine-security-service.ts) --------------------
  // :74 registerDeveloperMachine
  ...entries(['machine.registered'], {
    owner: 'Task4', severity: 'notice', actorTypes: ADMIN,
    targetType: 'developer_machine', targetIdKind: 'row',
    details: { installationId: r('string'), displayName: r('string') },
    sources: ['core/security/machine-security-service.ts:74'],
  }),
  // :117 issueMachineCredential (keyId only; the plaintext is returned once, never audited)
  ...entries(['machine_credential.issued', 'machine_credential.rotated'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'machine_credential', targetIdKind: 'row',
    details: {
      machineId: r('uuid'),
      keyId: r('string'),
      rotatedFromCredentialId: rn('uuid'),
      expiresAt: rn('iso_timestamp'),
    },
    sources: ['core/security/machine-security-service.ts:117'],
  }),
  // :158 revokeMachineCredential
  ...entries(['machine_credential.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'machine_credential', targetIdKind: 'row',
    details: { machineId: r('uuid'), keyId: r('string'), reason: r('reason') },
    sources: ['core/security/machine-security-service.ts:158'],
  }),
  // :199 revokeDeveloperMachine
  ...entries(['machine.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'developer_machine', targetIdKind: 'row',
    details: { reason: r('reason'), credentialsRevoked: r('boolean'), repositoryGrantsRevoked: r('integer') },
    sources: ['core/security/machine-security-service.ts:199'],
  }),

  // --- Task4: administrator memberships -----------------------------------------------
  // core/security/admin-security-service.ts:73 grantAdminMembership (actorType from its
  // input: system_operator from the bootstrap CLI, tenant_admin allowed by the type).
  ...entries(['admin_membership.granted', 'admin_membership.reactivated'], {
    owner: 'Task4', severity: 'high', actorTypes: ['system_operator', 'tenant_admin'],
    targetType: 'tenant_admin_membership', targetIdKind: 'row',
    details: { role: r(oneOf('tenant_admin', 'tenant_auditor')), subject: r('string') },
    sources: ['core/security/admin-security-service.ts:73', 'features/admin/task4-wave4-admin-bootstrap.ts:68'],
  }),
  // Two writers, two shapes: the service (:107: subject, role, reason) and the repair CLI
  // (task4-wave4-admin-placeholder-repair.ts:54: reason, correctiveOverlay).
  ...entries(['admin_membership.revoked'], {
    owner: 'Task4', severity: 'high', actorTypes: ['tenant_admin', 'system_operator'],
    targetType: 'tenant_admin_membership', targetIdKind: 'row',
    details: {
      subject: o('string'),
      role: o(oneOf('tenant_admin', 'tenant_auditor')),
      reason: r('reason'),
      correctiveOverlay: o('boolean'),
    },
    sources: ['core/security/admin-security-service.ts:107', 'features/admin/task4-wave4-admin-placeholder-repair.ts:54'],
  }),

  // --- Task4: operations ----------------------------------------------------------------
  // core/operations/retention-policy-service.ts:101 replaceTenantRetentionPolicy
  ...entries(['retention_policy.created', 'retention_policy.replaced'], {
    owner: 'Task4', severity: 'high', actorTypes: ADMIN,
    targetType: 'tenant_retention_policy', targetIdKind: 'row',
    details: {
      previousPolicyId: rn('uuid'),
      version: r('integer'),
      mode: r(oneOf('retain', 'archive_then_purge')),
      retentionDays: rn('integer'),
      reason: r('reason'),
    },
    sources: ['core/operations/retention-policy-service.ts:101'],
  }),
  // core/operations/evidence-export-service.ts:367 (digests and counts, never records)
  ...entries(['evidence_export.completed'], {
    owner: 'Task4', severity: 'info', actorTypes: ADMIN,
    targetType: 'evidence_export_job', targetIdKind: 'row',
    details: {
      archivePurpose: r('boolean'),
      scopeFrom: r('iso_timestamp'),
      scopeUntil: r('iso_timestamp'),
      recordCounts: r('counts'),
      contentSha256: r('sha256_hex'),
      bytes: r('integer'),
      reason: r('reason'),
    },
    sources: ['core/operations/evidence-export-service.ts:367'],
  }),
  // :399 failure path; failureCode from safeFailureCode (:56)
  ...entries(['evidence_export.failed'], {
    owner: 'Task4', severity: 'info', actorTypes: ADMIN,
    targetType: 'evidence_export_job', targetIdKind: 'row',
    details: {
      failureCode: r(oneOf('export_record_limit_exceeded', 'export_execution_failed')),
      reason: r('reason'),
    },
    sources: ['core/operations/evidence-export-service.ts:399'],
  }),
  // features/operations/task4-wave5-pending-reconcile.ts:27 (CLI, apply mode)
  ...entries(['telemetry_normalization.reconciled'], {
    owner: 'Task4', severity: 'notice', actorTypes: OPERATOR,
    targetType: 'tenant_evidence', targetIdKind: 'tenant',
    details: { selected: r('integer'), normalized: r('integer'), failed: r('integer'), eventKinds: r('counts') },
    sources: ['features/operations/task4-wave5-pending-reconcile.ts:27'],
  }),

  // --- Task5: governed evidence (features/evidence/service.ts) -----------------------
  // :186 setEvidenceConsent
  ...entries(['evidence.collection.enabled', 'evidence.collection.disabled'], {
    owner: 'Task5', severity: 'high', actorTypes: ADMIN,
    targetType: 'tenant_evidence_settings', targetIdKind: 'row',
    details: { provider: r(oneOf('opencode')), retentionDays: r('integer') },
    sources: ['features/evidence/service.ts:186'],
  }),
  // :386 readRawEvidence. Behind the evidence.raw.read guard, so the actor is
  // req.adminRole; today's site hardcodes tenant_user (Task16a observation 1), which
  // this contract refuses: a Task16c migration item.
  ...entries(['evidence.raw.read'], {
    owner: 'Task5', severity: 'high', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'evidence_event', targetIdKind: 'row',
    details: { provider: r('string'), eventType: r('string') },
    sources: ['features/evidence/service.ts:386'],
  }),
  // :459 correctIntention
  ...entries(['evidence.intention.corrected'], {
    owner: 'Task5', severity: 'notice', actorTypes: ADMIN,
    targetType: 'evidence_intention', targetIdKind: 'row',
    details: { correctedFromIntentionId: r('uuid'), reason: r('reason') },
    sources: ['features/evidence/service.ts:459'],
  }),
  // :497 purgeExpiredEvidence (counts only)
  ...entries(['evidence.retention.purged'], {
    owner: 'Task5', severity: 'high', actorTypes: ADMIN,
    targetType: 'tenant', targetIdKind: 'tenant',
    details: {
      expiredEvents: r('integer'),
      expiredIntentions: r('integer'),
      expiredSummaries: r('integer'),
      expiredSemanticIndexes: r('integer'),
    },
    sources: ['features/evidence/service.ts:497'],
  }),
  // :1159 enqueueSemanticReindex
  ...entries(['evidence.semantic.reindex_enqueued'], {
    owner: 'Task5', severity: 'notice', actorTypes: ADMIN,
    targetType: 'tenant', targetIdKind: 'tenant',
    details: { model: r('string'), modelRevision: r('string'), enqueued: r('integer') },
    sources: ['features/evidence/service.ts:1159'],
  }),

  // --- Task6.a: security findings ----------------------------------------------------
  // features/security-findings/admin-read.ts:73 (actorType from req.adminRole)
  ...entries(['security_findings.read'], {
    owner: 'Task6.a', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'security_findings', targetIdKind: 'tenant',
    details: { limit: r('integer'), returned: r('integer') },
    sources: ['features/security-findings/admin-read.ts:73'],
  }),

  // --- Task9: fleet (features/fleet/service.ts) ---------------------------------------
  // :264 createFleetConfiguration; schema version 1 writes targetClientVersion, version 2
  // writes clientCompatibility and desiredRelease instead.
  ...entries(['fleet_configuration.created'], {
    owner: 'Task9', severity: 'notice', actorTypes: ADMIN,
    targetType: 'fleet_configuration', targetIdKind: 'row',
    details: {
      epoch: r('integer'),
      schemaVersion: r('integer'),
      targetClientVersion: o('string'),
      clientCompatibility: o({ object: { minimumVersion: r('string'), maximumVersion: r('string') } }),
      desiredRelease: o({
        object: { version: r('string'), releaseTag: r('string'), manifestUrl: r('string'), manifestSha256: r('string') },
      }),
      channel: r(oneOf('latest', 'next', 'enterprise-latest', 'enterprise-next')),
      ring: rn('string'),
      reason: r('reason'),
      repositoryPolicyCount: r('integer'),
      securityActivation: r({ object: { mode: r(oneOf('off', 'monitor')), version: r('integer') } }),
    },
    sources: ['features/fleet/service.ts:264'],
  }),
  // :316 assignFleetConfiguration (1 to 100 machines, fleet/contract.ts:362)
  ...entries(['fleet_configuration.assigned'], {
    owner: 'Task9', severity: 'high', actorTypes: ADMIN,
    targetType: 'fleet_configuration', targetIdKind: 'row',
    details: { epoch: r('integer'), machineIds: r('uuid[]'), reason: r('reason') },
    sources: ['features/fleet/service.ts:316'],
  }),
  // :463 applyFleetOffboard
  ...entries(['fleet_machine.offboarded'], {
    owner: 'Task9', severity: 'high', actorTypes: ADMIN,
    targetType: 'developer_machine', targetIdKind: 'row',
    details: {
      reason: r('reason'),
      desiredConfigurationId: rn('uuid'),
      activeCredentialCount: r('integer'),
      activeGrantCount: r('integer'),
      serverRevocation: r(oneOf('applied')),
      localCleanup: r(oneOf('best_effort_not_requested_by_server')),
      mdmCleanup: r(oneOf('not_requested')),
    },
    sources: ['features/fleet/service.ts:463'],
  }),

  // --- Task15: Attesta ------------------------------------------------------------------
  // features/attesta/read-service.ts:407 (actorType from req.adminRole)
  ...entries(['attesta.verify'], {
    owner: 'Task15', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'attesta_chain', targetIdKind: 'compound',
    targetIdPattern: new RegExp(`^${SEQ}-(${SEQ}|end)$`),
    targetIdNote: 'the verified range "<from_seq>-<to_seq>", or "<from_seq>-end" when open',
    details: {
      request_id: r('string'),
      ok: r('boolean'),
      checked: r('integer'),
      break_count: r('integer'),
      failed: o('boolean'),
    },
    sources: ['features/attesta/read-service.ts:407'],
  }),
  // features/attesta/evidence-pack-service.ts:793 audit hook, called from attesta.routes.ts:221 and :241
  ...entries(['attesta.export.request'], {
    owner: 'Task15', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'attesta_evidence_pack', targetIdKind: 'row',
    details: {
      request_id: r('string'),
      scope: r(PACK_SCOPE),
      mode: r(oneOf('full', 'repository_only')),
      replayed: r('boolean'),
    },
    sources: ['features/attesta/evidence-pack-service.ts:793', 'features/attesta/attesta.routes.ts:221', 'features/attesta/attesta.routes.ts:241'],
  }),
  // same hook, attesta.routes.ts:267 (the job is ready, so the digest and counts are set)
  ...entries(['attesta.export.download'], {
    owner: 'Task15', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'attesta_evidence_pack', targetIdKind: 'row',
    details: {
      request_id: r('string'),
      scope: r(PACK_SCOPE),
      mode: r(oneOf('full', 'repository_only')),
      pack_digest: r('sha256_digest'),
      counts: r('counts'),
    },
    sources: ['features/attesta/evidence-pack-service.ts:793', 'features/attesta/attesta.routes.ts:267'],
  }),
  // features/attesta/period-report-service.ts:511 audit hook, via attesta.routes.ts:297
  ...entries(['attesta.report.request'], {
    owner: 'Task15', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'attesta_period_report', targetIdKind: 'row',
    details: { request_id: r('string'), scope: r(REPORT_SCOPE), replayed: r('boolean') },
    sources: ['features/attesta/period-report-service.ts:511', 'features/attesta/attesta.routes.ts:297'],
  }),
  // same hook, attesta.routes.ts:341
  ...entries(['attesta.report.download'], {
    owner: 'Task15', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'attesta_period_report', targetIdKind: 'row',
    details: {
      request_id: r('string'),
      scope: r(REPORT_SCOPE),
      report_digest: r('sha256_digest'),
      statement_digest: r('sha256_digest'),
    },
    sources: ['features/attesta/period-report-service.ts:511', 'features/attesta/attesta.routes.ts:341'],
  }),
  // features/attesta/trust-inventory.ts:480 registerKey, inserted by insertAudit (:1063,
  // actor_type hardcoded system_operator). Camel-case requestId is frozen (observation 12).
  ...entries(['attesta.keys.register'], {
    owner: 'Task15', severity: 'high', actorTypes: OPERATOR,
    targetType: 'attesta_tenant_key', targetIdKind: 'row',
    targetIdPattern: KEYID_PATTERN,
    targetIdNote: 'the keyid "sha256:<hex>", not the key row uuid',
    details: { keyid: r('sha256_digest'), status: r(oneOf('registered')), requestId: r('string') },
    sources: ['features/attesta/trust-inventory.ts:480', 'features/attesta/trust-inventory.ts:1063'],
  }),
  // :626 applyTenantKeyCommand, one row per command (`attesta.keys.${command}`)
  ...entries(['attesta.keys.activate', 'attesta.keys.retire', 'attesta.keys.revoke'], {
    owner: 'Task15', severity: 'high', actorTypes: OPERATOR,
    targetType: 'attesta_tenant_key', targetIdKind: 'row',
    targetIdPattern: KEYID_PATTERN,
    targetIdNote: 'the keyid "sha256:<hex>" named on the command line, not the key row uuid',
    details: {
      requestId: r('string'),
      changes: r({
        arrayOf: {
          keyid: r('sha256_digest'),
          from: r(KEY_STATUS),
          to: r(KEY_STATUS),
          revocationReason: rn(oneOf('superseded', 'compromised')),
          compromisedSince: rn('string'),
        },
      }),
    },
    sources: ['features/attesta/trust-inventory.ts:626', 'features/attesta/trust-inventory.ts:1063'],
  }),
  // :967 publishKeyset
  ...entries(['attesta.keys.publish'], {
    owner: 'Task15', severity: 'high', actorTypes: OPERATOR,
    targetType: 'attesta_trust_document', targetIdKind: 'compound',
    targetIdPattern: new RegExp(`^${UUID}:${SEQ}$`, 'i'),
    targetIdNote: 'the key set "<tenant_id>:<version>"',
    details: { requestId: r('string'), version: r('integer'), digest: r('sha256_digest'), keyids: r('string[]') },
    sources: ['features/attesta/trust-inventory.ts:967', 'features/attesta/trust-inventory.ts:1063'],
  }),
  // features/attesta/worker.ts:371 requeueFailedSubjects (raw SQL in the caller's transaction)
  ...entries(['attesta_subjects.requeued'], {
    owner: 'Task15', severity: 'notice', actorTypes: OPERATOR,
    targetType: 'attesta_outbox', targetIdKind: 'tenant',
    details: { code: r('string'), count: r('integer') },
    sources: ['features/attesta/worker.ts:371'],
  }),
  // features/attesta/attesta-anchor-resume-cli.ts:279. Migration 0021's commit trigger
  // reads action, target_id and details->>'request_id' of this row: frozen.
  ...entries(['attesta.anchor.resume'], {
    owner: 'Task15', severity: 'notice', actorTypes: OPERATOR,
    targetType: 'attesta_anchor_batch', targetIdKind: 'compound',
    targetIdPattern: BATCH_ID_PATTERN, targetIdNote: BATCH_ID_NOTE,
    details: { request_id: r('string'), terminal_code: r('string'), records: r('integer'), reason: r('reason') },
    sources: ['features/attesta/attesta-anchor-resume-cli.ts:279'],
  }),

  // --- Reserved (A16.11 and Task16c): refused until the owning Task flips them ----------
  // The owning Task may still change a reserved entry's shape before its first row
  // (no row means no meaning to keep); after that, additive changes only.
  ...entries(['audit.events.read'], {
    status: 'reserved', owner: 'Task16c', severity: 'info', actorTypes: ADMIN_OR_AUDITOR,
    targetType: 'security_audit_events', targetIdKind: 'tenant',
    // The filter summary is the names of the filters used, never their values or any row.
    details: { limit: r('integer'), returned: r('integer'), filters: r('string[]') },
    sources: ['docs/plan/TASK16.md A16.6 (founder 2026-10-15: audit reads are audited)'],
  }),
  ...entries(['attesta.anchor.failed'], {
    status: 'reserved', owner: 'Task15', severity: 'notice', actorTypes: ['service'],
    targetType: 'attesta_anchor_batch', targetIdKind: 'compound',
    targetIdPattern: BATCH_ID_PATTERN, targetIdNote: BATCH_ID_NOTE,
    details: { outcome: r('string'), terminal: r('boolean'), records: r('integer') },
    sources: ['docs/plan/TASK16.md A16.11 (anchor success is recorded in attesta_anchors, not audited)'],
  }),
  ...entries(['fleet.lease.issued'], {
    status: 'reserved', owner: 'D6.1', severity: 'high', actorTypes: ['machine', 'service'],
    targetType: 'developer_machine', targetIdKind: 'row',
    details: { lease_id: r('uuid'), expires_at: r('iso_timestamp'), policy_version: o('integer') },
    sources: ['docs/plan/TASK16.md A16.11 (D6.1 activation lease)'],
  }),
  ...entries(['fleet.lease.refused'], {
    status: 'reserved', owner: 'D6.1', severity: 'notice', actorTypes: ['machine', 'service'],
    targetType: 'developer_machine', targetIdKind: 'row',
    details: { refusal: r('string') },
    sources: ['docs/plan/TASK16.md A16.11 (D6.1 activation lease)'],
  }),
  ...entries(['policy.bundle.published'], {
    status: 'reserved', owner: 'Task6.b', severity: 'high', actorTypes: ADMIN,
    targetType: 'policy_bundle', targetIdKind: 'row',
    details: { version: r('integer'), bundle_digest: r('sha256_digest'), reason: r('reason') },
    sources: ['docs/plan/TASK16.md A16.11 (Task6.b policy bundles)'],
  }),
  ...entries(['policy.bundle.activated'], {
    status: 'reserved', owner: 'Task6.b', severity: 'high', actorTypes: ADMIN,
    targetType: 'policy_bundle', targetIdKind: 'row',
    details: { version: r('integer'), reason: r('reason') },
    sources: ['docs/plan/TASK16.md A16.11 (Task6.b policy bundles)'],
  }),
  ...entries(['policy.bundle.acknowledged'], {
    status: 'reserved', owner: 'Task6.b', severity: 'notice', actorTypes: ['machine'],
    targetType: 'policy_bundle', targetIdKind: 'row',
    details: { machine_id: r('uuid'), version: r('integer') },
    sources: ['docs/plan/TASK16.md A16.11 (Task6.b policy bundles)'],
  }),
  ...entries(['artifact.signed'], {
    status: 'reserved', owner: 'Task14', severity: 'notice', actorTypes: ['service', 'system_operator'],
    targetType: 'artifact', targetIdKind: 'row',
    details: { artifact_digest: r('sha256_digest'), keyid: r('sha256_digest') },
    sources: ['docs/plan/TASK16.md A16.11 (T14.7 artifact signing)'],
  }),
  ...entries(['security.monitor.changed'], {
    status: 'reserved', owner: 'Task6', severity: 'high', actorTypes: ADMIN,
    targetType: 'tenant_security_settings', targetIdKind: 'tenant',
    details: { mode: r(oneOf('off', 'monitor')), previous_mode: r(oneOf('off', 'monitor')), reason: r('reason') },
    sources: ['docs/plan/CUSTOMER_AUDITOR_QA.md gap G8 (no API writer today)'],
  }),
  ...entries(['security.finding.triaged'], {
    status: 'reserved', owner: 'Task6', severity: 'notice', actorTypes: ADMIN,
    targetType: 'security_finding', targetIdKind: 'row',
    details: { triage_state: r('string'), reason: r('reason') },
    sources: ['docs/plan/CUSTOMER_AUDITOR_QA.md gap G13'],
  }),
];

/** Lookup by action (and alias). */
export const AUDIT_CATALOG_BY_ACTION: ReadonlyMap<string, AuditCatalogEntry> = new Map(
  AUDIT_CATALOG.flatMap(entry => [entry.action, ...entry.aliases].map(name => [name, entry] as const)),
);
