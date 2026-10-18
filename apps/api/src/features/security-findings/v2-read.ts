/**
 * Security reads v2 (Task20i-a, T20.7b): the admin and auditor read API over the
 * security tables Task20d and Task20f store (findings of both generations, plus
 * the Endpoint coverage view the security console calls).
 *
 * Metadata only (AGENTS.md rule 6): previews are deferred to phase 2, so this
 * module never reads the encrypted preview table, not even its field column.
 * `title` is Numbat's bounded rule title from the pinned catalogue
 * (docs/contracts/security-v2/README.md: bounded title from the pinned rule, not
 * event content), never user content.
 *
 * Every read is tenant-bound through `withTenant()` (the tenant comes only from
 * the session, never from a parameter) and audited in the same transaction as
 * the read: `security_findings.read` with exactly the frozen details
 * `{limit, returned}` (docs/contracts/audit/catalog.md; the richer route and
 * filter names need a Task16 audit-contract PR, tracked as a follow-up).
 * Per the Task20 lead answer, prompt section 2.1 item 5's `{route, filters,
 * returned}` shape is superseded by this contract.
 */
import { and, asc, desc, eq, gt, gte, lte, or, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import { recordAuditEvent } from '../../core/audit';
import {
  developerMachines,
  fleetMachineStates,
  securityAcknowledgements,
  securityActivationLeases,
  securityAgentInventorySnapshots,
  securityEnforcementDecisions,
  securityFindings,
  securityIndicators,
  securityRuleBundles,
  securityStatusSnapshots,
} from '../../core/db/schema';

export type SecurityFindingGeneration = 'task6a' | 'v2';

/** One finding row as the read API returns it (snake_case, generation-neutral). */
export interface SecurityFindingItem {
  id: string;
  generation: SecurityFindingGeneration;
  rule_id: string;
  rule_version: string;
  rule_severity: string;
  rule_category: string;
  /** Numbat's bounded rule title for v2; null for every Task6.a row. */
  title: string | null;
  /** Task6.a `agent_family`, or v2 `source_agent`. */
  agent: string | null;
  /** v2 `model`; null for every Task6.a row. */
  model: string | null;
  /** Null for v2 `not_enrolled` (machine-wide) rows. */
  repository_id: string | null;
  /** v2 `enrolled` or `not_enrolled`; null for every Task6.a row. */
  repository_kind: string | null;
  machine_id: string;
  session_id: string | null;
  occurred_at: string;
  received_at: string;
  rule_pack_version: string;
  /** v2 only; null for every Task6.a row. */
  bundle_digest: string | null;
  /** v2 only; null for every Task6.a row. */
  lease_id: string | null;
  /** v2 only; null for every Task6.a row. */
  found_at_rest: boolean | null;
  /** Task6.a only; null for every v2 row. */
  phase: string | null;
  /** Task6.a only; null for every v2 row. */
  result_category: string | null;
}

/** The finding columns this API reads, in a stable order (a unit test pins it). */
export const SECURITY_READ_FINDING_COLUMNS = [
  'id', 'generation', 'rule_id', 'rule_version', 'rule_severity', 'rule_category',
  'title', 'agent', 'model', 'repository_id', 'repository_kind', 'machine_id',
  'session_id', 'occurred_at', 'received_at', 'rule_pack_version', 'bundle_digest',
  'lease_id', 'found_at_rest', 'phase', 'result_category',
] as const satisfies readonly (keyof SecurityFindingItem)[];

/** One indicator near a finding: kind, value (redacted for URL and email) and count. */
export interface SecurityReadIndicator {
  type: string;
  /** Null for `url` and `email`: full values wait for the preview phase. */
  value: string | null;
  count: number;
}

/** One enforcement decision near a finding, labelled nearby, never caused-by. */
export interface SecurityReadNearbyEnforcement {
  id: string;
  decision: string;
  mode: string;
  occurred_at: string;
  tool_name: string | null;
  session_id: string | null;
}

export interface SecurityFindingDetail {
  finding: SecurityFindingItem;
  /**
   * Same machine, seen within ±5 minutes of the finding; not linked to it,
   * so never read as caused-by. URL and email values are null (preview phase).
   */
  machine_indicators_nearby: SecurityReadIndicator[];
  /** Same machine and session within five minutes, labelled nearby. */
  nearby_enforcement: SecurityReadNearbyEnforcement[];
}

export interface SecurityFindingsPage {
  items: SecurityFindingItem[];
  next_cursor: string | null;
}

/** One enrolled machine's coverage row (honest literal states, never 0/omitted). */
export interface SecurityCoverageRow {
  machine_id: string;
  platform: string | 'unreported';
  status: {
    observed_at: string;
    numbat_version: string;
    wired_agents: string[];
    active_bundle_digest: string | null;
    lease_id: string | null;
    last_record_at: string | null;
    hook_status: string;
    agent_effective_view: string;
    local_record: string;
    forwarder_ack: string;
  } | 'unreported';
  inventory: { observed_at: string; agents: unknown } | 'unreported';
  lease: { mode: string; expires_at: string; bundle_epoch: number | 'unknown' } | 'no_lease';
  acknowledgement: { result: string; refusal_code: string | null; received_at: string } | 'not_acknowledged';
}

export interface SecurityCoveragePage {
  rows: SecurityCoverageRow[];
  next_cursor: string | null;
}

/** A refused findings-list or coverage query (400). */
export class SecurityReadQueryError extends Error {
  constructor(message: string) {
    super(`SECURITY_READ_INVALID_QUERY: ${message}`);
    this.name = 'SecurityReadQueryError';
  }
}

export type SecurityReaderRole = 'tenant_admin' | 'tenant_auditor';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 3339 with a zone (Z or ±hh:mm), matching the audit emitter's ISO_RE.
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const BOUNDED_RE = /^[^\s]{1,128}$/;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const GENERATIONS: readonly SecurityFindingGeneration[] = ['task6a', 'v2'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const NEARBY_MS = 5 * 60 * 1_000;
const MAX_INDICATORS = 100;
const MAX_NEARBY = 100;

/** Indicator types whose stored value the detail route returns; URL and email values stay null. */
const INDICATOR_VALUE_SHOWN = ['domain', 'ipv4', 'ipv6', 'md5', 'sha1', 'sha256'] as const;

/** Maps a stored indicator row to the redacted detail shape. */
export function toNearbyIndicator(row: {
  type: string;
  value: string;
  count: number;
}): SecurityReadIndicator {
  return {
    type: row.type,
    value: (INDICATOR_VALUE_SHOWN as readonly string[]).includes(row.type) ? row.value : null,
    count: row.count,
  };
}

/** Maps a full finding row to the allowlisted item. Never reads a preview. */
export function toFindingItem(row: typeof securityFindings.$inferSelect): SecurityFindingItem {
  const generation = row.recordGeneration as SecurityFindingGeneration;
  return {
    id: row.id,
    generation,
    rule_id: row.ruleId,
    rule_version: row.ruleVersion,
    rule_severity: row.ruleSeverity,
    rule_category: row.ruleCategory,
    title: row.title,
    agent: generation === 'v2' ? row.sourceAgent : row.agentFamily,
    model: generation === 'v2' ? row.model : null,
    repository_id: row.repositoryId,
    repository_kind: row.repositoryKind,
    machine_id: row.machineId,
    session_id: row.sessionId,
    occurred_at: row.occurredAt.toISOString(),
    received_at: row.receivedAt.toISOString(),
    rule_pack_version: row.rulePackVersion,
    bundle_digest: row.bundleDigest,
    lease_id: row.leaseId,
    found_at_rest: row.foundAtRest,
    phase: row.phase,
    result_category: row.resultCategory,
  };
}

function singleValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new SecurityReadQueryError(`${name} is invalid`);
  }
  return value;
}

function parseLimit(value: unknown): number {
  const raw = singleValue(value, 'limit');
  if (raw === undefined) return DEFAULT_LIMIT;
  if (raw.trim() === '') throw new SecurityReadQueryError('limit is invalid');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new SecurityReadQueryError('limit is invalid');
  }
  return parsed;
}

function parseTimestamp(value: unknown, name: string): Date {
  const raw = singleValue(value, name);
  if (raw === undefined || !RFC3339_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new SecurityReadQueryError(`${name} is invalid`);
  }
  return new Date(raw);
}

function parseBounded(value: unknown, name: string): string | null {
  const raw = singleValue(value, name);
  if (raw === undefined) return null;
  if (!BOUNDED_RE.test(raw)) throw new SecurityReadQueryError(`${name} is invalid`);
  return raw;
}

function parseUuid(value: unknown, name: string): string | null {
  const raw = singleValue(value, name);
  if (raw === undefined) return null;
  if (!UUID_RE.test(raw)) throw new SecurityReadQueryError(`${name} is invalid`);
  return raw;
}

export interface SecurityFindingsFilters {
  from: Date;
  to: Date;
  severity: string | null;
  category: string | null;
  ruleId: string | null;
  agent: string | null;
  machineId: string | null;
  repositoryId: string | null;
  repositoryNotEnrolled: boolean;
  generation: SecurityFindingGeneration | null;
}

export interface ParsedFindingsQuery {
  filters: SecurityFindingsFilters;
  limit: number;
  cursor: { o: string; i: string } | null;
  filterHash: string;
}

const FINDINGS_PARAMS = new Set([
  'from', 'to', 'severity', 'category', 'rule_id', 'agent', 'machine_id',
  'repository_id', 'generation', 'limit', 'cursor',
]);

function findingsFilterHash(explicit: {
  from: string | null;
  to: string | null;
  severity: string | null;
  category: string | null;
  ruleId: string | null;
  agent: string | null;
  machineId: string | null;
  repositoryId: string | null;
  repositoryNotEnrolled: boolean;
  generation: SecurityFindingGeneration | null;
}): string {
  const canonical = JSON.stringify({
    from: explicit.from,
    to: explicit.to,
    severity: explicit.severity,
    category: explicit.category,
    rule_id: explicit.ruleId,
    agent: explicit.agent,
    machine_id: explicit.machineId,
    repository_id: explicit.repositoryId,
    repository_not_enrolled: explicit.repositoryNotEnrolled,
    generation: explicit.generation,
  });
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (Math.imul(hash, 31) + canonical.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Parses `GET /findings` query parameters. Unknown parameters, invalid values,
 * `from` at or after `to`, and a window over 366 days are INVALID_QUERY; a
 * cursor that does not decode or binds other filters is INVALID_QUERY. The
 * default window is the last 30 days.
 */
export function parseFindingsQuery(query: Record<string, unknown>, now: Date = new Date()): ParsedFindingsQuery {
  for (const name of Object.keys(query)) {
    if (!FINDINGS_PARAMS.has(name)) throw new SecurityReadQueryError(`unknown parameter ${name}`);
  }
  const to = query.to === undefined ? now : parseTimestamp(query.to, 'to');
  const from = query.from === undefined
    ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000)
    : parseTimestamp(query.from, 'from');
  if (from.getTime() >= to.getTime()) throw new SecurityReadQueryError('from is not before to');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw new SecurityReadQueryError('the window is over 366 days');
  }
  const severityRaw = parseBounded(query.severity, 'severity');
  if (severityRaw !== null && !(SEVERITIES as readonly string[]).includes(severityRaw)) {
    throw new SecurityReadQueryError('severity is invalid');
  }
  const generationRaw = singleValue(query.generation, 'generation');
  if (generationRaw !== undefined && !(GENERATIONS as readonly string[]).includes(generationRaw as SecurityFindingGeneration)) {
    throw new SecurityReadQueryError('generation is invalid');
  }
  const repositoryRaw = singleValue(query.repository_id, 'repository_id');
  let repositoryId: string | null = null;
  let repositoryNotEnrolled = false;
  if (repositoryRaw !== undefined) {
    if (repositoryRaw === 'not_enrolled') repositoryNotEnrolled = true;
    else if (UUID_RE.test(repositoryRaw)) repositoryId = repositoryRaw;
    else throw new SecurityReadQueryError('repository_id is invalid');
  }
  const filters: SecurityFindingsFilters = {
    from,
    to,
    severity: severityRaw,
    category: parseBounded(query.category, 'category'),
    ruleId: parseBounded(query.rule_id, 'rule_id'),
    agent: parseBounded(query.agent, 'agent'),
    machineId: parseUuid(query.machine_id, 'machine_id'),
    repositoryId,
    repositoryNotEnrolled,
    generation: (generationRaw ?? null) as SecurityFindingGeneration | null,
  };
  const limit = parseLimit(query.limit);
  const filterHash = findingsFilterHash({
    from: query.from === undefined ? null : (singleValue(query.from, 'from') ?? null),
    to: query.to === undefined ? null : (singleValue(query.to, 'to') ?? null),
    severity: severityRaw,
    category: filters.category,
    ruleId: filters.ruleId,
    agent: filters.agent,
    machineId: filters.machineId,
    repositoryId: filters.repositoryId,
    repositoryNotEnrolled: filters.repositoryNotEnrolled,
    generation: filters.generation,
  });
  let cursor: { o: string; i: string } | null = null;
  const cursorRaw = singleValue(query.cursor, 'cursor');
  if (cursorRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
    } catch {
      throw new SecurityReadQueryError('cursor does not decode');
    }
    const o = (parsed as { o?: unknown }).o;
    const i = (parsed as { i?: unknown }).i;
    const f = (parsed as { f?: unknown }).f;
    if (typeof o !== 'string' || !Number.isFinite(Date.parse(o))
      || typeof i !== 'string' || !UUID_RE.test(i)
      || typeof f !== 'string') {
      throw new SecurityReadQueryError('cursor does not decode');
    }
    if (f !== filterHash) throw new SecurityReadQueryError('cursor binds other filters');
    cursor = { o, i };
  }
  return { filters, limit, cursor, filterHash };
}

/** Encodes a findings page cursor over (`occurred_at` desc, `id` desc). */
export function encodeFindingsCursor(o: string, i: string, filterHash: string): string {
  return Buffer.from(JSON.stringify({ o, i, f: filterHash }), 'utf8').toString('base64url');
}

/** Parses `GET /findings/:id`: the id must be a UUID, else INVALID_QUERY. */
export function parseFindingId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new SecurityReadQueryError('id is invalid');
  }
  return value;
}

export interface ParsedCoverageQuery {
  limit: number;
  cursor: string | null;
}

const COVERAGE_PARAMS = new Set(['limit', 'cursor']);

/** Parses `GET /coverage` query parameters: keyset by machine id. */
export function parseCoverageQuery(query: Record<string, unknown>): ParsedCoverageQuery {
  for (const name of Object.keys(query)) {
    if (!COVERAGE_PARAMS.has(name)) throw new SecurityReadQueryError(`unknown parameter ${name}`);
  }
  const limit = parseLimit(query.limit);
  let cursor: string | null = null;
  const cursorRaw = singleValue(query.cursor, 'cursor');
  if (cursorRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
    } catch {
      throw new SecurityReadQueryError('cursor does not decode');
    }
    const m = (parsed as { m?: unknown }).m;
    if (typeof m !== 'string' || !UUID_RE.test(m)) throw new SecurityReadQueryError('cursor does not decode');
    cursor = m;
  }
  return { limit, cursor };
}

/** Encodes a coverage page cursor over the machine id. */
export function encodeCoverageCursor(machineId: string): string {
  return Buffer.from(JSON.stringify({ m: machineId }), 'utf8').toString('base64url');
}

export interface SecurityListInput {
  tenantId: string;
  actorId: string;
  actorRole: SecurityReaderRole;
  filters: SecurityFindingsFilters;
  limit: number;
  cursor: { o: string; i: string } | null;
  filterHash: string;
}

export interface SecurityGetInput {
  tenantId: string;
  actorId: string;
  actorRole: SecurityReaderRole;
  id: string;
}

export interface SecurityCoverageInput {
  tenantId: string;
  actorId: string;
  actorRole: SecurityReaderRole;
  limit: number;
  cursor: string | null;
}

export interface SecurityV2ReadStore {
  listFindingsAndAudit(input: SecurityListInput): Promise<SecurityFindingsPage>;
  getFindingAndAudit(input: SecurityGetInput): Promise<SecurityFindingDetail | null>;
  listCoverageAndAudit(input: SecurityCoverageInput): Promise<SecurityCoveragePage>;
}

type SecurityTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The one audit call site for these reads (catalog.ts sources names this line):
 * `security_findings.read` with exactly the frozen details `{limit, returned}`.
 */
async function auditSecurityRead(
  tx: SecurityTx,
  tenantId: string,
  actorRole: SecurityReaderRole,
  actorId: string,
  limit: number,
  returned: number,
): Promise<void> {
  await recordAuditEvent(tx, tenantId, {
    actorType: actorRole,
    actorId,
    action: 'security_findings.read',
    targetType: 'security_findings',
    targetId: tenantId,
    details: { limit, returned },
  });
}

function listConditions(filters: SecurityFindingsFilters, cursor: { o: string; i: string } | null) {
  return [
    ...(filters.severity !== null ? [eq(securityFindings.ruleSeverity, filters.severity)] : []),
    ...(filters.category !== null ? [eq(securityFindings.ruleCategory, filters.category)] : []),
    ...(filters.ruleId !== null ? [eq(securityFindings.ruleId, filters.ruleId)] : []),
    ...(filters.agent !== null
      ? [or(eq(securityFindings.agentFamily, filters.agent), eq(securityFindings.sourceAgent, filters.agent))]
      : []),
    ...(filters.machineId !== null ? [eq(securityFindings.machineId, filters.machineId)] : []),
    ...(filters.repositoryId !== null ? [eq(securityFindings.repositoryId, filters.repositoryId)] : []),
    ...(filters.repositoryNotEnrolled ? [eq(securityFindings.repositoryKind, 'not_enrolled')] : []),
    ...(filters.generation !== null ? [eq(securityFindings.recordGeneration, filters.generation)] : []),
    gte(securityFindings.occurredAt, filters.from),
    lte(securityFindings.occurredAt, filters.to),
    // Keyset paging over (occurred_at desc, id desc).
    ...(cursor !== null ? [sql`(occurred_at, id) < (${cursor.o}::timestamptz, ${cursor.i}::uuid)`] : []),
  ];
}

function coverageRow(input: {
  machineId: string;
  platform: string | null;
  status: typeof securityStatusSnapshots.$inferSelect | undefined;
  inventory: typeof securityAgentInventorySnapshots.$inferSelect | undefined;
  lease: typeof securityActivationLeases.$inferSelect | undefined;
  bundleEpoch: number | null;
  acknowledgement: typeof securityAcknowledgements.$inferSelect | undefined;
}): SecurityCoverageRow {
  return {
    machine_id: input.machineId,
    platform: input.platform ?? 'unreported',
    status: input.status ? {
      observed_at: input.status.observedAt.toISOString(),
      numbat_version: input.status.numbatVersion,
      wired_agents: input.status.wiredAgents,
      active_bundle_digest: input.status.activeBundleDigest,
      lease_id: input.status.leaseId,
      last_record_at: input.status.lastRecordAt?.toISOString() ?? null,
      hook_status: input.status.hookStatus,
      agent_effective_view: input.status.agentEffectiveView,
      local_record: input.status.localRecord,
      forwarder_ack: input.status.forwarderAck,
    } : 'unreported',
    inventory: input.inventory ? {
      observed_at: input.inventory.observedAt.toISOString(),
      agents: input.inventory.agents as unknown,
    } : 'unreported',
    lease: input.lease ? {
      mode: input.lease.mode,
      expires_at: input.lease.expiresAt.toISOString(),
      bundle_epoch: input.bundleEpoch ?? 'unknown',
    } : 'no_lease',
    acknowledgement: input.acknowledgement ? {
      result: input.acknowledgement.result,
      refusal_code: input.acknowledgement.refusalCode,
      received_at: input.acknowledgement.receivedAt.toISOString(),
    } : 'not_acknowledged',
  };
}

/** The production store: one transaction per read, select first, then the audit write. */
export const pgSecurityV2ReadStore: SecurityV2ReadStore = {
  async listFindingsAndAudit(input) {
    return db.transaction(async tx => {
      const tenant = withTenant(tx as unknown as typeof db, input.tenantId);
      const rows = await tenant.select(securityFindings, and(...listConditions(input.filters, input.cursor)))
        .orderBy(desc(securityFindings.occurredAt), desc(securityFindings.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const items = page.map(toFindingItem);
      const last = page[page.length - 1];
      const nextCursor = rows.length > input.limit && last
        ? encodeFindingsCursor(last.occurredAt.toISOString(), last.id, input.filterHash)
        : null;
      await auditSecurityRead(tx, input.tenantId, input.actorRole, input.actorId, input.limit, items.length);
      return { items, next_cursor: nextCursor };
    });
  },

  async getFindingAndAudit(input) {
    return db.transaction(async tx => {
      const tenant = withTenant(tx as unknown as typeof db, input.tenantId);
      const [row] = await tenant.select(securityFindings, eq(securityFindings.id, input.id)).limit(1);
      if (!row) {
        await auditSecurityRead(tx, input.tenantId, input.actorRole, input.actorId, 1, 0);
        return null;
      }
      const windowStart = new Date(row.occurredAt.getTime() - NEARBY_MS);
      const windowEnd = new Date(row.occurredAt.getTime() + NEARBY_MS);
      const indicators = await tenant.select(securityIndicators, and(
        eq(securityIndicators.machineId, row.machineId),
        lte(securityIndicators.firstSeen, windowEnd),
        gte(securityIndicators.lastSeen, windowStart),
      ))
        .orderBy(desc(securityIndicators.lastSeen), desc(securityIndicators.id))
        .limit(MAX_INDICATORS);
      const nearby = row.sessionId === null ? [] : await tenant.select(securityEnforcementDecisions, and(
        eq(securityEnforcementDecisions.machineId, row.machineId),
        eq(securityEnforcementDecisions.sessionId, row.sessionId),
        gte(securityEnforcementDecisions.occurredAt, new Date(row.occurredAt.getTime() - NEARBY_MS)),
        lte(securityEnforcementDecisions.occurredAt, new Date(row.occurredAt.getTime() + NEARBY_MS)),
      ))
        .orderBy(desc(securityEnforcementDecisions.occurredAt), desc(securityEnforcementDecisions.id))
        .limit(MAX_NEARBY);
      await auditSecurityRead(tx, input.tenantId, input.actorRole, input.actorId, 1, 1);
      return {
        finding: toFindingItem(row),
        machine_indicators_nearby: indicators.map(toNearbyIndicator),
        nearby_enforcement: nearby.map(decision => ({
          id: decision.id,
          decision: decision.decision,
          mode: decision.mode,
          occurred_at: decision.occurredAt.toISOString(),
          tool_name: decision.toolName,
          session_id: decision.sessionId,
        })),
      };
    });
  },

  async listCoverageAndAudit(input) {
    return db.transaction(async tx => {
      const tenant = withTenant(tx as unknown as typeof db, input.tenantId);
      const machines = await tenant.select(developerMachines, and(
        eq(developerMachines.status, 'active'),
        ...(input.cursor !== null ? [gt(developerMachines.id, input.cursor)] : []),
      ))
        .orderBy(asc(developerMachines.id))
        .limit(input.limit + 1);
      const page = machines.slice(0, input.limit);
      const rows: SecurityCoverageRow[] = [];
      for (const machine of page) {
        const [fleet] = await tenant.select(fleetMachineStates, eq(fleetMachineStates.machineId, machine.id)).limit(1);
        const [status] = await tenant.select(securityStatusSnapshots, eq(securityStatusSnapshots.machineId, machine.id))
          .orderBy(desc(securityStatusSnapshots.observedAt), desc(securityStatusSnapshots.id)).limit(1);
        const [inventory] = await tenant.select(securityAgentInventorySnapshots, eq(securityAgentInventorySnapshots.machineId, machine.id))
          .orderBy(desc(securityAgentInventorySnapshots.observedAt), desc(securityAgentInventorySnapshots.id)).limit(1);
        const [lease] = await tenant.select(securityActivationLeases, eq(securityActivationLeases.machineId, machine.id))
          .orderBy(desc(securityActivationLeases.issuedAt), desc(securityActivationLeases.id)).limit(1);
        let bundleEpoch: number | null = null;
        if (lease) {
          const [bundle] = await tenant.select(securityRuleBundles, eq(securityRuleBundles.digest, lease.bundleDigest)).limit(1);
          bundleEpoch = bundle?.epoch ?? null;
        }
        const [acknowledgement] = await tenant.select(securityAcknowledgements, eq(securityAcknowledgements.machineId, machine.id))
          .orderBy(desc(securityAcknowledgements.receivedAt), desc(securityAcknowledgements.id)).limit(1);
        rows.push(coverageRow({
          machineId: machine.id,
          platform: fleet?.platform ?? null,
          status,
          inventory,
          lease,
          bundleEpoch,
          acknowledgement,
        }));
      }
      const last = page[page.length - 1];
      const nextCursor = machines.length > input.limit && last ? encodeCoverageCursor(last.id) : null;
      await auditSecurityRead(tx, input.tenantId, input.actorRole, input.actorId, input.limit, rows.length);
      return { rows, next_cursor: nextCursor };
    });
  },
};
