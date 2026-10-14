import { sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATALOG_BY_ACTION,
  AuditContractError,
  type AuditCatalogEntry,
  type AuditDetailKey,
  type AuditDetailShape,
  type AuditDetailType,
  type AuditEvent,
  type AuditRow,
} from './catalog';

/**
 * A Drizzle database or transaction: the object today's sites call `.insert` /
 * `.execute` on (raw-SQL sites included). The emitter only needs `execute`, so it
 * runs on whatever the caller holds, inside the caller's transaction.
 */
export interface AuditExecutor {
  execute(query: SQL): Promise<unknown>;
}

// Case-insensitive: the admin and fleet routes accept upper-case UUIDs (admin.routes.ts:99,
// fleet/contract.ts:165) and PostgreSQL stores them unchanged in text columns.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_STRING = 512;
const MAX_REASON = 1000;
const MAX_ITEMS = 200;
const MAX_MAP_KEYS = 64;
const MAX_ACTOR_ID = 256;
const MAX_TARGET_ID = 256;
/** The whole serialized details object; a bound on what one row can carry. */
const MAX_DETAILS_BYTES = 16_384;

/** `request_id` (AP-1 X-Request-ID) is an optional key on every action. */
const RESERVED_REQUEST_ID: AuditDetailKey = { type: 'string', required: false, nullable: false };

function refuse(code: AuditContractError['code'], message: string): never {
  throw new AuditContractError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isString = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.length <= max;

/** True when `value` fits `type`. Never reports the value itself. */
function fits(type: AuditDetailType, value: unknown, path: string, action: string): boolean {
  if (typeof type === 'object') {
    if ('enum' in type) return typeof value === 'string' && type.enum.includes(value);
    if ('object' in type) {
      if (!isPlainObject(value)) return false;
      checkShape(type.object, value, `${path}.`, action);
      return true;
    }
    if (!Array.isArray(value) || value.length > MAX_ITEMS) return false;
    value.forEach((item, index) => {
      if (!isPlainObject(item)) refuse('AUDIT_DETAILS_INVALID', `${action}: ${path}[${index}] is not an object`);
      checkShape(type.arrayOf, item, `${path}[${index}].`, action);
    });
    return true;
  }
  switch (type) {
    case 'string': return isString(value, MAX_STRING);
    case 'reason': return isString(value, MAX_REASON);
    case 'integer': return Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'iso_timestamp': return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
    case 'uuid': return typeof value === 'string' && UUID_RE.test(value);
    case 'sha256_hex': return typeof value === 'string' && SHA256_HEX_RE.test(value);
    case 'sha256_digest': return typeof value === 'string' && SHA256_DIGEST_RE.test(value);
    case 'string[]':
      return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(item => isString(item, MAX_STRING));
    case 'uuid[]':
      return Array.isArray(value) && value.length <= MAX_ITEMS
        && value.every(item => typeof item === 'string' && UUID_RE.test(item));
    case 'counts':
      return isPlainObject(value) && Object.keys(value).length <= MAX_MAP_KEYS
        && Object.entries(value).every(([key, item]) => isString(key, MAX_STRING) && Number.isSafeInteger(item) && (item as number) >= 0);
    case 'string_map':
      return isPlainObject(value) && Object.keys(value).length <= MAX_MAP_KEYS
        && Object.entries(value).every(([key, item]) => isString(key, MAX_STRING) && isString(item, MAX_STRING));
  }
}

function checkShape(shape: AuditDetailShape, value: Record<string, unknown>, prefix: string, action: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      refuse('AUDIT_DETAILS_INVALID', `${action}: unknown key ${prefix}${key}`);
    }
  }
  for (const [key, spec] of Object.entries(shape)) {
    const present = Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (!present) {
      if (spec.required) refuse('AUDIT_DETAILS_INVALID', `${action}: missing required key ${prefix}${key}`);
      continue;
    }
    const item = value[key];
    if (item === null) {
      if (!spec.nullable) refuse('AUDIT_DETAILS_INVALID', `${action}: key ${prefix}${key} may not be null`);
      continue;
    }
    if (!fits(spec.type, item, `${prefix}${key}`, action)) {
      refuse('AUDIT_DETAILS_INVALID', `${action}: key ${prefix}${key} has the wrong type or size`);
    }
  }
}

function checkTarget(entry: AuditCatalogEntry, tenantId: string, event: AuditEvent): void {
  const { action } = entry;
  if (event.targetType !== entry.targetType) {
    refuse('AUDIT_TARGET_INVALID', `${action}: target_type must be ${entry.targetType}`);
  }
  const id = event.targetId;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TARGET_ID) {
    refuse('AUDIT_TARGET_INVALID', `${action}: target_id is missing or too long`);
  }
  const ok = entry.targetIdKind === 'tenant'
    ? id === tenantId
    : entry.targetIdPattern ? entry.targetIdPattern.test(id) : UUID_RE.test(id);
  if (!ok) refuse('AUDIT_TARGET_INVALID', `${action}: target_id does not match its kind (${entry.targetIdKind})`);
}

/**
 * Validates one event against its catalog entry and returns the row to insert, or
 * throws AuditContractError. Pure: no I/O, no logging.
 */
export function buildAuditRow(tenantId: string, event: AuditEvent): AuditRow {
  const entry = AUDIT_CATALOG_BY_ACTION.get(event?.action);
  if (!entry) refuse('AUDIT_UNKNOWN_ACTION', `action is not in the audit catalog`);
  if (entry.status === 'reserved') {
    refuse('AUDIT_RESERVED_ACTION', `${entry.action} is reserved for ${entry.owner} and not emitted yet`);
  }
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    refuse('AUDIT_TARGET_INVALID', `${entry.action}: tenant id is not a UUID`);
  }
  if (!(AUDIT_ACTOR_TYPES as readonly string[]).includes(event.actorType)
    || !entry.actorTypes.includes(event.actorType)) {
    refuse('AUDIT_ACTOR_NOT_ALLOWED', `${entry.action}: actor_type is not one of ${entry.actorTypes.join(', ')}`);
  }
  if (typeof event.actorId !== 'string' || !event.actorId.trim() || event.actorId.length > MAX_ACTOR_ID) {
    refuse('AUDIT_ACTOR_NOT_ALLOWED', `${entry.action}: actor_id is missing or too long`);
  }
  checkTarget(entry, tenantId, event);
  if (!isPlainObject(event.details)) refuse('AUDIT_DETAILS_INVALID', `${entry.action}: details is not an object`);
  const shape: AuditDetailShape = Object.prototype.hasOwnProperty.call(entry.details, 'request_id')
    ? entry.details
    : { ...entry.details, request_id: RESERVED_REQUEST_ID };
  checkShape(shape, event.details, '', entry.action);
  // Undefined values are dropped exactly as JSON storage would drop them.
  const details = JSON.parse(JSON.stringify(event.details)) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(details)) > MAX_DETAILS_BYTES) {
    refuse('AUDIT_DETAILS_INVALID', `${entry.action}: details exceed ${MAX_DETAILS_BYTES} bytes`);
  }
  return {
    tenantId,
    actorType: event.actorType,
    actorId: event.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: event.targetId,
    details,
  };
}

/**
 * Validates and inserts one audit row through the caller's executor. A contract error
 * throws before any write, so inside a transaction the caller's change rolls back with
 * it: no audit, no change (fail closed). Values are bound parameters; nothing is logged.
 */
export async function recordAuditEvent(executor: AuditExecutor, tenantId: string, event: AuditEvent): Promise<void> {
  const row = buildAuditRow(tenantId, event);
  await executor.execute(sql`insert into security_audit_events
    (tenant_id, actor_type, actor_id, action, target_type, target_id, details)
    values (${row.tenantId}::uuid, ${row.actorType}, ${row.actorId}, ${row.action}, ${row.targetType}, ${row.targetId},
      ${JSON.stringify(row.details)}::jsonb)`);
}
