/**
 * Audit read API, read side (Task16c, A16.6).
 *
 * Query parsing, the opaque keyset cursor, tenant-bound queries and the audited
 * read (every list and get writes one `audit.events.read` event in the same
 * transaction it reads in). Route handlers (audit.routes.ts) stay thin.
 *
 * Ported from SushiCorp AP-1 @ 0bd67a5 (catalog AP-1), via
 * features/attesta/read-service.ts: strict unknown-parameter refusal, keyset paging
 * with an opaque cursor that is validated (a bad cursor is a 400, never a 500),
 * `limit` 1..200. Deviations:
 *  1. The page boundary is (`occurred_at`, `id`) descending; `occurred_at` is
 *     carried as the exact stored text (microseconds), never through a JS `Date`
 *     (a `Date` keeps milliseconds and would skip or repeat rows).
 *  2. The cursor binds the request's filters (first 16 hex of sha256 over the
 *     canonical filter string); a cursor reused with other filters is a 400.
 *  3. `severity` is a filter that expands to the catalog actions with that
 *     severity; `action` accepts emitted and reserved catalog actions.
 *  4. Every read is audited in the same transaction (founder 2026-10-15): the
 *     select runs first, so the read's own event is never in its own result.
 *
 * Every query binds `tenant_id` first. Times are read as text with microseconds.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { withAuditReader } from '../../core/db/audit-reader';
import { securityAuditEvents } from '../../core/db/schema';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATALOG,
  AUDIT_CATALOG_BY_ACTION,
  AUDIT_CATALOG_VERSION,
  type AuditSeverity,
} from '../../core/audit/catalog';
import { recordAuditEvent } from '../../core/audit/record';
import type { AuditApiCode } from './http';

/** A refused query parameter (400) or a refused cursor (400). */
export class AuditQueryError extends Error {
  constructor(readonly code: Extract<AuditApiCode, 'AUDIT_FILTER_INVALID' | 'AUDIT_CURSOR_INVALID'>, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AuditQueryError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_TYPE_RE = /^[a-z][a-z0-9_]*$/;
// RFC 3339 with a zone (Z or ±hh:mm) and a four-digit year (record.ts ISO_RE).
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// The exact stored text the API returns (to_char ... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"').
const OCCURRED_AT_TEXT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const SEVERITIES = ['high', 'notice', 'info'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ACTIONS = 20;

/** Every catalog action, emitted or reserved: the valid `action` filter values. */
const ALL_ACTIONS = new Set(AUDIT_CATALOG.map(entry => entry.action));

/** One audit row as event-v1.schema.json describes it (snake_case, derived fields). */
export interface AuditEventV1 {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  details: unknown;
  occurred_at: string;
  severity: AuditSeverity;
  catalog_version: number;
}

/** A stored row: the table's columns with `occurred_at` as the exact stored text. */
export interface AuditStoredRow {
  id: string;
  tenantId: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: unknown;
  occurredAt: string;
}

/**
 * Derives the read shape from a stored row. A row whose action is not in the
 * catalog is still returned, never hidden, with `severity: 'high'`.
 */
export function toAuditEventV1(row: AuditStoredRow): AuditEventV1 {
  const entry = AUDIT_CATALOG_BY_ACTION.get(row.action);
  return {
    id: row.id,
    action: row.action,
    actor_type: row.actorType,
    actor_id: row.actorId,
    target_type: row.targetType,
    target_id: row.targetId,
    details: row.details,
    occurred_at: row.occurredAt,
    severity: entry?.severity ?? 'high',
    catalog_version: AUDIT_CATALOG_VERSION,
  };
}

/** The resolved list query: values for the store, names for the audit event. */
export interface AuditListQuery {
  actions: string[] | null;
  excludedActions: string[] | null;
  actorType: string | null;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  from: string | null;
  to: string | null;
  /** Names of the filters used, never their values (written into `audit.events.read`). */
  filterNames: string[];
  /** The canonical filter string the cursor binds. */
  canonical: string;
}

export interface AuditCursor {
  o: string;
  i: string;
}

function badFilter(message: string): never {
  throw new AuditQueryError('AUDIT_FILTER_INVALID', message);
}

function badCursor(message: string): never {
  throw new AuditQueryError('AUDIT_CURSOR_INVALID', message);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) badFilter('limit is invalid');
  return parsed;
}

function parseTimestamp(value: unknown, name: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !RFC3339_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
    badFilter(`${name} is invalid`);
  }
  return raw;
}

/**
 * Parses and validates `GET /events` query parameters. Unknown parameters,
 * invalid values and `from` at or after `to` are AUDIT_FILTER_INVALID; a cursor
 * that does not decode or binds other filters is AUDIT_CURSOR_INVALID.
 */
export function parseAuditListQuery(query: Record<string, unknown>): {
  listQuery: AuditListQuery;
  limit: number;
  cursor: AuditCursor | null;
  filterHash: string;
} {
  const allowed = new Set(['action', 'exclude_action', 'severity', 'actor_type', 'actor_id', 'target_type', 'target_id', 'from', 'to', 'limit', 'cursor']);
  for (const name of Object.keys(query)) {
    if (!allowed.has(name)) badFilter(`unknown parameter ${name}`);
  }
  const single = (name: string): unknown => {
    const value = query[name];
    if (value === undefined) return undefined;
    const items = asArray(value);
    if (items.length !== 1) badFilter(`${name} is invalid`);
    return items[0];
  };

  let actions: string[] | null = null;
  const filterNames: string[] = [];
  if (query.action !== undefined) {
    const items = asArray(query.action);
    if (items.length === 0 || items.length > MAX_ACTIONS
      || items.some(item => typeof item !== 'string' || !ALL_ACTIONS.has(item))) {
      badFilter('action is invalid');
    }
    actions = [...new Set(items as string[])].sort();
    filterNames.push('action');
  }
  let excludedActions: string[] | null = null;
  if (query.exclude_action !== undefined) {
    const items = asArray(query.exclude_action);
    if (items.length === 0 || items.length > MAX_ACTIONS
      || items.some(item => typeof item !== 'string' || !ALL_ACTIONS.has(item))) {
      badFilter('exclude_action is invalid');
    }
    excludedActions = [...new Set(items as string[])].sort();
    filterNames.push('exclude_action');
  }
  if (actions !== null && excludedActions !== null
    && actions.some(action => (excludedActions as string[]).includes(action))) {
    badFilter('action and exclude_action overlap');
  }
  if (query.severity !== undefined) {
    const raw = single('severity');
    if (typeof raw !== 'string' || !(SEVERITIES as readonly string[]).includes(raw)) badFilter('severity is invalid');
    const withSeverity = AUDIT_CATALOG
      .filter(entry => entry.severity === raw)
      .map(entry => entry.action)
      .sort();
    actions = actions === null ? withSeverity : actions.filter(action => withSeverity.includes(action));
    filterNames.push('severity');
  }

  let actorType: string | null = null;
  const actorTypeRaw = single('actor_type');
  if (actorTypeRaw !== undefined) {
    if (typeof actorTypeRaw !== 'string' || !(AUDIT_ACTOR_TYPES as readonly string[]).includes(actorTypeRaw)) {
      badFilter('actor_type is invalid');
    }
    actorType = actorTypeRaw;
    filterNames.push('actor_type');
  }
  let actorId: string | null = null;
  const actorIdRaw = single('actor_id');
  if (actorIdRaw !== undefined) {
    if (typeof actorIdRaw !== 'string' || actorIdRaw.length === 0 || actorIdRaw.length > 256) badFilter('actor_id is invalid');
    actorId = actorIdRaw;
    filterNames.push('actor_id');
  }
  let targetType: string | null = null;
  const targetTypeRaw = single('target_type');
  if (targetTypeRaw !== undefined) {
    if (typeof targetTypeRaw !== 'string' || !TARGET_TYPE_RE.test(targetTypeRaw)) badFilter('target_type is invalid');
    targetType = targetTypeRaw;
    filterNames.push('target_type');
  }
  let targetId: string | null = null;
  const targetIdRaw = single('target_id');
  if (targetIdRaw !== undefined) {
    if (typeof targetIdRaw !== 'string' || targetIdRaw.length === 0 || targetIdRaw.length > 256) badFilter('target_id is invalid');
    targetId = targetIdRaw;
    filterNames.push('target_id');
  }
  let from: string | null = null;
  if (query.from !== undefined) {
    from = parseTimestamp(query.from, 'from');
    filterNames.push('from');
  }
  let to: string | null = null;
  if (query.to !== undefined) {
    to = parseTimestamp(query.to, 'to');
    filterNames.push('to');
  }
  if (from !== null && to !== null && Date.parse(from) >= Date.parse(to)) badFilter('from is not before to');

  const limit = parseLimit(query.limit);
  const canonical = JSON.stringify({
    actions, exclude_action: excludedActions, actor_type: actorType, actor_id: actorId,
    target_type: targetType, target_id: targetId, from, to,
  });
  const filterHash = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);

  let cursor: AuditCursor | null = null;
  if (query.cursor !== undefined) {
    const raw = single('cursor');
    if (typeof raw !== 'string') badCursor('cursor does not decode');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      badCursor('cursor does not decode');
    }
    const o = (parsed as { o?: unknown }).o;
    const i = (parsed as { i?: unknown }).i;
    const f = (parsed as { f?: unknown }).f;
    if (typeof o !== 'string' || !OCCURRED_AT_TEXT_RE.test(o)
      || typeof i !== 'string' || !UUID_RE.test(i)
      || typeof f !== 'string') {
      badCursor('cursor does not decode');
    }
    if (f !== filterHash) badCursor('cursor binds other filters');
    cursor = { o, i };
  }
  return { listQuery: { actions, excludedActions, actorType, actorId, targetType, targetId, from, to, filterNames, canonical }, limit, cursor, filterHash };
}

/** Encodes a page cursor over the exact stored `occurred_at` text and the row id. */
export function encodeAuditCursor(o: string, i: string, filterHash: string): string {
  return Buffer.from(JSON.stringify({ o, i, f: filterHash }), 'utf8').toString('base64url');
}

/** Parses `GET /events/:id`: the id must be a UUID, else AUDIT_FILTER_INVALID. */
export function parseAuditId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) badFilter('id is invalid');
  return value;
}

export type AuditReaderRole = 'tenant_admin' | 'tenant_auditor';

export interface AuditListInput {
  tenantId: string;
  actorId: string;
  actorRole: AuditReaderRole;
  requestId: string;
  listQuery: AuditListQuery;
  filterHash: string;
  limit: number;
  cursor: AuditCursor | null;
}

export interface AuditGetInput {
  tenantId: string;
  actorId: string;
  actorRole: AuditReaderRole;
  requestId: string;
  id: string;
}

export interface AuditReadStore {
  listAndAudit(input: AuditListInput): Promise<{ events: AuditEventV1[]; nextCursor: string | null }>;
  getAndAudit(input: AuditGetInput): Promise<AuditEventV1 | null>;
}

/** The exact stored `occurred_at` text (microseconds, never through a JS Date). */
const OCCURRED_AT_TEXT = sql<string>`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function listConditions(listQuery: AuditListQuery, tenantId: string, cursor: AuditCursor | null) {
  return [
    // Tenant isolation is the first condition of every query.
    eq(securityAuditEvents.tenantId, tenantId),
    // Exclusions run right after the tenant condition, before the inclusions.
    ...(listQuery.excludedActions !== null ? [notInArray(securityAuditEvents.action, listQuery.excludedActions)] : []),
    ...(listQuery.actions !== null ? [inArray(securityAuditEvents.action, listQuery.actions)] : []),
    ...(listQuery.actorType !== null ? [eq(securityAuditEvents.actorType, listQuery.actorType)] : []),
    ...(listQuery.actorId !== null ? [eq(securityAuditEvents.actorId, listQuery.actorId)] : []),
    ...(listQuery.targetType !== null ? [eq(securityAuditEvents.targetType, listQuery.targetType)] : []),
    ...(listQuery.targetId !== null ? [eq(securityAuditEvents.targetId, listQuery.targetId)] : []),
    ...(listQuery.from !== null ? [gte(securityAuditEvents.occurredAt, sql`${listQuery.from}::timestamptz`)] : []),
    ...(listQuery.to !== null ? [lt(securityAuditEvents.occurredAt, sql`${listQuery.to}::timestamptz`)] : []),
    // Keyset paging over the exact stored values, never through a JS Date.
    ...(cursor !== null ? [sql`(occurred_at, id) < (${cursor.o}::timestamptz, ${cursor.i}::uuid)`] : []),
  ];
}

function readAuditDetails(limit: number, returned: number, filters: string[], requestId: string) {
  return { limit, returned, filters, request_id: requestId };
}

/** A Drizzle database transaction (the select half of a read-and-audit). */
type AuditTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function selectPage(
  tx: AuditTx,
  tenantId: string,
  input: Pick<AuditListInput, 'listQuery' | 'limit' | 'cursor'>,
): Promise<AuditStoredRow[]> {
  const rows = await tx.select({
    id: securityAuditEvents.id,
    tenantId: securityAuditEvents.tenantId,
    actorType: securityAuditEvents.actorType,
    actorId: securityAuditEvents.actorId,
    action: securityAuditEvents.action,
    targetType: securityAuditEvents.targetType,
    targetId: securityAuditEvents.targetId,
    details: securityAuditEvents.details,
    occurredAt: OCCURRED_AT_TEXT,
  }).from(securityAuditEvents)
    .where(and(...listConditions(input.listQuery, tenantId, input.cursor)))
    .orderBy(desc(securityAuditEvents.occurredAt), desc(securityAuditEvents.id))
    .limit(input.limit + 1);
  return rows.map(row => ({ ...row, details: row.details as unknown }));
}

/** The production store: one transaction per read, select first, then the audit write. */
export const pgAuditStore: AuditReadStore = {
  async listAndAudit(input) {
    return db.transaction(async tx => {
      const rows = await withAuditReader(tx, input.tenantId,
        reader => selectPage(reader, input.tenantId, input));
      const page = rows.slice(0, input.limit);
      const events = page.map(toAuditEventV1);
      const last = page[page.length - 1];
      const nextCursor = rows.length > input.limit && last
        ? encodeAuditCursor(last.occurredAt, last.id, input.filterHash)
        : null;
      await recordAuditEvent(tx, input.tenantId, {
        action: 'audit.events.read',
        actorType: input.actorRole,
        actorId: input.actorId,
        targetType: 'security_audit_events',
        targetId: input.tenantId,
        details: readAuditDetails(input.limit, events.length, input.listQuery.filterNames, input.requestId),
      });
      return { events, nextCursor };
    });
  },

  async getAndAudit(input) {
    return db.transaction(async tx => {
      const [row] = await withAuditReader(tx, input.tenantId, reader => reader.select({
          id: securityAuditEvents.id,
          tenantId: securityAuditEvents.tenantId,
          actorType: securityAuditEvents.actorType,
          actorId: securityAuditEvents.actorId,
          action: securityAuditEvents.action,
          targetType: securityAuditEvents.targetType,
          targetId: securityAuditEvents.targetId,
          details: securityAuditEvents.details,
          occurredAt: OCCURRED_AT_TEXT,
        }).from(securityAuditEvents)
          .where(and(
            // Tenant isolation remains the first condition; RLS is the backstop.
            eq(securityAuditEvents.tenantId, input.tenantId),
            eq(securityAuditEvents.id, input.id),
          ))
          .limit(1));
      const event = row ? toAuditEventV1({ ...row, details: row.details as unknown }) : null;
      await recordAuditEvent(tx, input.tenantId, {
        action: 'audit.events.read',
        actorType: input.actorRole,
        actorId: input.actorId,
        targetType: 'security_audit_events',
        targetId: input.tenantId,
        details: readAuditDetails(1, event === null ? 0 : 1, ['id'], input.requestId),
      });
      return event;
    });
  },
};
