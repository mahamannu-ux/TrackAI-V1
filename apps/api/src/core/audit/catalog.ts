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

/** Goes up when an entry is added or an alias recorded; never for a change of meaning. */
export const AUDIT_CATALOG_VERSION = 1;

/** Every action, emitted and reserved (filled in the next commit). */
export const AUDIT_CATALOG: readonly AuditCatalogEntry[] = [];
