/**
 * Security findings read module (Task19c, T19.4).
 *
 * One tenant-bound read for the security live answerers. It loads the tenant's
 * security findings in a period — both generations of `security_findings`
 * (`record_generation` `task6a` or `v2`) — plus the metadata tables the
 * answers need (enforcement decisions, status snapshots, machine platforms and
 * agent sessions). The pure functions in security-answerers.ts read this
 * shape; they never touch the database.
 *
 * Metadata only (AGENTS.md rule 6): the preview table (`security_finding_previews`,
 * encrypted command, path and URL previews) is never read here. Each finding
 * is mapped to a fixed allowlist of metadata columns; `title`, `tags` and every
 * preview are discarded.
 *
 * Generation-neutral columns (prompt §2.1 item 3): `rule_id`, `rule_category`,
 * `rule_severity`, `repository_id` (null for v2 `not_enrolled`), `machine_id`,
 * `session_id`, `occurred_at`; the agent is Task6.a `agent_family` or v2
 * `source_agent`; the model is v2 `model` or null for Task6.a.
 *
 * Task19j adds the Task20 coverage data (G7, G8, G11 closed): every Endpoint status
 * report in the period with its health fields, the activation leases that overlap
 * the period, the tenant's signed rule bundles, the enrolled machines, and the
 * security-settings and lease audit events. Each is projected to an allowlist: no
 * actor id, no reason text, no envelope bytes are ever read into an answer.
 */
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  aiSessions,
  developerMachines,
  fleetMachineStates,
  securityActivationLeases,
  securityAuditEvents,
  securityRuleBundles,
  securityEnforcementDecisions,
  securityPermissionEvents,
  securityAgentInventorySnapshots,
  securityScanSummaries,
  securityIndicators,
  securityDataSettingsVersions,
  securityFindings,
  securityStatusSnapshots,
} from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';

export type FindingGeneration = 'task6a' | 'v2';
export type RepositoryKind = 'enrolled' | 'not_enrolled';

/**
 * The metadata-only shape of one finding row. This is the complete allowlist of
 * finding columns a live security answer may read (a unit test pins it).
 */
export interface SecurityFindingRow {
  id: string;
  generation: FindingGeneration;
  ruleId: string;
  ruleCategory: string;
  ruleSeverity: string;
  repositoryId: string | null;
  repositoryKind: RepositoryKind | null;
  machineId: string;
  sessionId: string | null;
  occurredAt: Date;
  rulePackVersion: string;
  /** v2 only: the verified lease the record was uploaded under (security-v2 README); null for Task6.a. */
  leaseId: string | null;
  /** Task6.a `agent_family`, or v2 `source_agent`; null when neither is set. */
  agent: string | null;
  /** v2 `model`; null for every Task6.a row (the model is not captured there, G10). */
  model: string | null;
  /** Task6.a phase (`requested`, `observed_result`, `partial`, `unavailable`); null for v2. */
  phase: string | null;
  /** Task6.a result category; null for v2. */
  resultCategory: string | null;
}

/** The finding columns a live answer reads, in a stable order (a unit test pins this list). */
export const SECURITY_FINDING_METADATA_COLUMNS = [
  'id', 'generation', 'ruleId', 'ruleCategory', 'ruleSeverity', 'repositoryId',
  'repositoryKind', 'machineId', 'sessionId', 'occurredAt', 'rulePackVersion',
  'agent', 'model', 'phase', 'resultCategory', 'leaseId',
] as const satisfies readonly (keyof SecurityFindingRow)[];

export interface EnforcementDecisionRow {
  id: string;
  decision: string;
  machineId: string;
  occurredAt: Date;
}

export interface StatusSnapshotRow {
  id: string;
  machineId: string;
  observedAt: Date;
}

export interface SessionRow {
  id: string;
  externalSessionId: string;
  tool: string;
}

export interface PermissionEventRow {
  machineId: string;
  sessionId: string | null;
  sourceAgent: string;
  outcome: string;
}

export interface IndicatorRow {
  type: string;
  value: string;
  count: number;
  sourceAgent: string;
}

export interface DataSettingsRow {
  version: number;
  urls: boolean;
  createdAt: Date;
}

/** One agent row of an Endpoint inventory snapshot (security-v2 README "agent_inventory"). */
export interface InventoryAgentRow {
  agent: string;
  config: string;
  artifacts: string;
  wired: string;
}

/** The latest inventory snapshot per machine, observed in the period (Task19h). */
export interface InventorySnapshotRow {
  machineId: string;
  observedAt: Date;
  agents: InventoryAgentRow[];
}

/** One Numbat scan summary (the opt-in day-one scan). No agent is projected (security-v2 README "scan_summary"). */
export interface ScanSummaryRow {
  machineId: string;
  status: string;
  artifactsScanned: number;
  receivedAt: Date;
}

/** A v2 finding from the day-one scan: metadata only, cut to the period by `received_at`. */
export interface AtRestFindingRow {
  machineId: string;
  ruleCategory: string;
  ruleSeverity: string;
}

/** One Endpoint `security_status` report (security-v2 README), health fields as reported. */
export interface StatusReportRow {
  machineId: string;
  observedAt: Date;
  numbatVersion: string;
  activeBundleDigest: string | null;
  leaseId: string | null;
  /** `ok`, `failed` or `unavailable`, in Numbat's rollout order. */
  health: { hook: string; view: string; local: string; forwarder: string };
}

/** One signed activation lease (Task20f); the envelope itself is never read. */
export interface LeaseRow {
  id: string;
  machineId: string;
  issuedAt: Date;
  expiresAt: Date;
  mode: string;
  bundleDigest: string;
}

/** One signed rule bundle (Task20f), by digest. */
export interface BundleRow {
  digest: string;
  bundleVersion: number;
  epoch: number;
  numbatPin: string;
  issuedAt: Date;
}

/** An enrolled machine (`developer_machines`), revoked ones included: answers judge enrolment over the period. */
export interface EnrolledMachineRow {
  machineId: string;
  enrolledAt: Date;
  revokedAt: Date | null;
}

/** The security audit actions a Q&A answer may count (docs/contracts/audit/catalog.md, Task20). */
export const SECURITY_AUDIT_ACTIONS = [
  'security.monitor.changed', 'security.settings.changed', 'policy.bundle.published',
  'fleet.lease.issued', 'fleet.lease.refused',
] as const;
export type SecurityAuditAction = typeof SECURITY_AUDIT_ACTIONS[number];

/** A security audit event, projected: never the actor, never the reason text. */
export interface SecurityAuditRow {
  action: SecurityAuditAction;
  occurredAt: Date;
  /** `security.monitor.changed` only: the new mode. */
  mode: string | null;
  /** `fleet.lease.refused` only: the refusal code. */
  refusal: string | null;
  /** Lease events only: the machine (the target id). */
  machineId: string | null;
}

/** Everything a pure security answer reads: period-filtered by the loader. */
export interface SecurityContext {
  findings: SecurityFindingRow[];
  enforcement: EnforcementDecisionRow[];
  statusSnapshots: StatusSnapshotRow[];
  /** Latest `fleet_machine_states.platform` per machine; absent = no platform row. */
  machinePlatforms: Map<string, string | null>;
  sessions: SessionRow[];
  permissionEvents: PermissionEventRow[];
  indicators: IndicatorRow[];
  dataSettings: DataSettingsRow[];
  inventory: InventorySnapshotRow[];
  scanSummaries: ScanSummaryRow[];
  atRestFindings: AtRestFindingRow[];
  /** Task19j: every status report in the period (statusSnapshots keeps the old shape). */
  statusReports: StatusReportRow[];
  /** Task19j: leases whose validity overlaps the period. */
  leases: LeaseRow[];
  bundles: BundleRow[];
  machines: EnrolledMachineRow[];
  securityAudit: SecurityAuditRow[];
}

/** Projects one audit row to the allowlist; anything outside SECURITY_AUDIT_ACTIONS is dropped. */
export function toSecurityAuditRow(row: { action: string; occurredAt: Date; targetId: string; details: unknown }): SecurityAuditRow | null {
  if (!(SECURITY_AUDIT_ACTIONS as readonly string[]).includes(row.action)) return null;
  const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details)
    ? row.details as Record<string, unknown> : {};
  const action = row.action as SecurityAuditAction;
  const lease = action === 'fleet.lease.issued' || action === 'fleet.lease.refused';
  return {
    action,
    occurredAt: row.occurredAt,
    mode: action === 'security.monitor.changed' && typeof details.mode === 'string' ? details.mode : null,
    refusal: action === 'fleet.lease.refused' && typeof details.refusal === 'string' ? details.refusal : null,
    machineId: lease ? row.targetId : null,
  };
}

/** Keeps each machine's latest snapshot and only the four projected agent fields (no version is claimed). */
export function latestInventory(rows: Array<{ machineId: string; observedAt: Date; agents: unknown }>): InventorySnapshotRow[] {
  const latest = new Map<string, { machineId: string; observedAt: Date; agents: unknown }>();
  for (const row of rows) {
    const current = latest.get(row.machineId);
    if (!current || row.observedAt.getTime() > current.observedAt.getTime()) latest.set(row.machineId, row);
  }
  return [...latest.values()].map((row) => ({
    machineId: row.machineId,
    observedAt: row.observedAt,
    agents: (Array.isArray(row.agents) ? row.agents : []).flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      return typeof value.agent === 'string' ? [{
        agent: value.agent,
        config: typeof value.config === 'string' ? value.config : 'unavailable',
        artifacts: typeof value.artifacts === 'string' ? value.artifacts : 'unavailable',
        wired: typeof value.wired === 'string' ? value.wired : 'unavailable',
      }] : [];
    }),
  }));
}

type FindingSelect = typeof securityFindings.$inferSelect;
type EnforcementSelect = typeof securityEnforcementDecisions.$inferSelect;
type StatusSelect = typeof securityStatusSnapshots.$inferSelect;
type MachineStateSelect = typeof fleetMachineStates.$inferSelect;
type SessionSelect = typeof aiSessions.$inferSelect;

/** Maps a full finding row to the metadata allowlist. Never reads a preview column. */
export function toFindingRow(row: FindingSelect): SecurityFindingRow {
  const generation = row.recordGeneration as FindingGeneration;
  return {
    id: row.id,
    generation,
    ruleId: row.ruleId,
    ruleCategory: row.ruleCategory,
    ruleSeverity: row.ruleSeverity,
    repositoryId: row.repositoryId,
    repositoryKind: (row.repositoryKind as RepositoryKind | null) ?? null,
    machineId: row.machineId,
    sessionId: row.sessionId,
    occurredAt: row.occurredAt,
    rulePackVersion: row.rulePackVersion,
    leaseId: row.recordGeneration === 'v2' ? row.leaseId ?? null : null,
    agent: generation === 'v2' ? row.sourceAgent : row.agentFamily,
    model: generation === 'v2' ? row.model : null,
    phase: row.phase,
    resultCategory: row.resultCategory,
  };
}

/** The latest platform per machine (fleet_machine_states holds snapshots over time). */
export function latestPlatforms(rows: MachineStateSelect[]): Map<string, string | null> {
  const latest = new Map<string, { platform: string | null; at: number }>();
  for (const row of rows) {
    const at = row.updatedAt.getTime();
    const current = latest.get(row.machineId);
    if (!current || at > current.at) latest.set(row.machineId, { platform: row.platform, at });
  }
  return new Map([...latest.entries()].map(([machineId, value]) => [machineId, value.platform]));
}

/** Builds the pure context from already-loaded rows (used by the loader and by tests). */
export function buildSecurityContext(input: {
  findings: FindingSelect[];
  enforcement: EnforcementSelect[];
  statusSnapshots: StatusSelect[];
  machineStates: MachineStateSelect[];
  sessions: SessionSelect[];
  permissionEvents?: Array<typeof securityPermissionEvents.$inferSelect>;
  indicators?: Array<typeof securityIndicators.$inferSelect>;
  dataSettings?: Array<typeof securityDataSettingsVersions.$inferSelect>;
  inventory?: Array<typeof securityAgentInventorySnapshots.$inferSelect>;
  scanSummaries?: Array<typeof securityScanSummaries.$inferSelect>;
  atRestFindings?: FindingSelect[];
  leases?: Array<typeof securityActivationLeases.$inferSelect>;
  bundles?: Array<typeof securityRuleBundles.$inferSelect>;
  machines?: Array<typeof developerMachines.$inferSelect>;
  securityAudit?: Array<typeof securityAuditEvents.$inferSelect>;
}): SecurityContext {
  return {
    findings: input.findings.map(toFindingRow),
    enforcement: input.enforcement.map((row) => ({
      id: row.id, decision: row.decision, machineId: row.machineId, occurredAt: row.occurredAt,
    })),
    statusSnapshots: input.statusSnapshots.map((row) => ({
      id: row.id, machineId: row.machineId, observedAt: row.observedAt,
    })),
    machinePlatforms: latestPlatforms(input.machineStates),
    sessions: input.sessions.map((row) => ({
      id: row.id, externalSessionId: row.externalSessionId, tool: row.tool,
    })),
    permissionEvents: (input.permissionEvents ?? []).map((row) => ({
      machineId: row.machineId, sessionId: row.sessionId, sourceAgent: row.sourceAgent, outcome: row.outcome,
    })),
    indicators: (input.indicators ?? []).map((row) => ({
      type: row.type, value: row.value, count: row.count, sourceAgent: row.sourceAgent,
    })),
    dataSettings: (input.dataSettings ?? []).map((row) => ({
      version: row.version, urls: row.urls, createdAt: row.createdAt,
    })),
    inventory: latestInventory(input.inventory ?? []),
    scanSummaries: (input.scanSummaries ?? []).map((row) => ({
      machineId: row.machineId, status: row.status, artifactsScanned: row.artifactsScanned, receivedAt: row.receivedAt,
    })),
    atRestFindings: (input.atRestFindings ?? [])
      .filter((row) => row.recordGeneration === 'v2' && row.foundAtRest === true)
      .map((row) => ({ machineId: row.machineId, ruleCategory: row.ruleCategory, ruleSeverity: row.ruleSeverity })),
    statusReports: input.statusSnapshots.map((row) => ({
      machineId: row.machineId, observedAt: row.observedAt, numbatVersion: row.numbatVersion,
      activeBundleDigest: row.activeBundleDigest, leaseId: row.leaseId,
      health: { hook: row.hookStatus, view: row.agentEffectiveView, local: row.localRecord, forwarder: row.forwarderAck },
    })),
    leases: (input.leases ?? []).map((row) => ({
      id: row.id, machineId: row.machineId, issuedAt: row.issuedAt, expiresAt: row.expiresAt, mode: row.mode, bundleDigest: row.bundleDigest,
    })),
    bundles: (input.bundles ?? []).map((row) => ({
      digest: row.digest, bundleVersion: row.bundleVersion, epoch: row.epoch, numbatPin: row.numbatPin, issuedAt: row.issuedAt,
    })),
    machines: (input.machines ?? []).map((row) => ({
      machineId: row.id, enrolledAt: row.createdAt, revokedAt: row.status === 'revoked' ? row.revokedAt ?? row.updatedAt : null,
    })),
    securityAudit: (input.securityAudit ?? []).flatMap((row) => {
      const projected = toSecurityAuditRow(row);
      return projected ? [projected] : [];
    }),
  };
}

/**
 * Loads the tenant's security context for `[fromMs, toMs]` (inclusive) through
 * `withTenant()` (AGENTS.md gotcha 3). Findings, enforcement decisions and
 * status snapshots are cut to the period by their own timestamps; machine
 * platforms and sessions are not period-bound.
 */
export async function loadSecurityContext(
  tenantId: string,
  fromMs: number,
  toMs: number,
): Promise<SecurityContext> {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const tenantDb = withTenant(db, tenantId);
  const [findings, enforcement, statusSnapshots, machineStates, sessions, permissionEvents, indicators, dataSettings,
    inventory, scanSummaries, atRestFindings, leases, bundles, machines, securityAudit] = await Promise.all([
    tenantDb.select(securityFindings, and(gte(securityFindings.occurredAt, from), lte(securityFindings.occurredAt, to))),
    tenantDb.select(securityEnforcementDecisions, and(
      gte(securityEnforcementDecisions.occurredAt, from), lte(securityEnforcementDecisions.occurredAt, to))),
    tenantDb.select(securityStatusSnapshots, and(
      gte(securityStatusSnapshots.observedAt, from), lte(securityStatusSnapshots.observedAt, to))),
    tenantDb.select(fleetMachineStates),
    tenantDb.select(aiSessions),
    tenantDb.select(securityPermissionEvents, and(
      gte(securityPermissionEvents.occurredAt, from), lte(securityPermissionEvents.occurredAt, to))),
    // A cumulative indicator belongs to every period its observation window overlaps.
    tenantDb.select(securityIndicators, and(
      lte(securityIndicators.firstSeen, to), gte(securityIndicators.lastSeen, from))),
    tenantDb.select(securityDataSettingsVersions, lte(securityDataSettingsVersions.createdAt, to)),
    tenantDb.select(securityAgentInventorySnapshots, and(
      gte(securityAgentInventorySnapshots.observedAt, from), lte(securityAgentInventorySnapshots.observedAt, to))),
    // Scan summaries and day-one findings carry no activity time for the scan itself:
    // an at-rest finding's occurred_at is the old session's time, so both use received_at.
    tenantDb.select(securityScanSummaries, and(
      gte(securityScanSummaries.receivedAt, from), lte(securityScanSummaries.receivedAt, to))),
    tenantDb.select(securityFindings, and(eq(securityFindings.foundAtRest, true),
      gte(securityFindings.receivedAt, from), lte(securityFindings.receivedAt, to))),
    // A lease belongs to every period its validity overlaps.
    tenantDb.select(securityActivationLeases, and(
      lte(securityActivationLeases.issuedAt, to), gte(securityActivationLeases.expiresAt, from))),
    tenantDb.select(securityRuleBundles, lte(securityRuleBundles.issuedAt, to)),
    tenantDb.select(developerMachines),
    tenantDb.select(securityAuditEvents, and(inArray(securityAuditEvents.action, [...SECURITY_AUDIT_ACTIONS]),
      gte(securityAuditEvents.occurredAt, from), lte(securityAuditEvents.occurredAt, to))),
  ]);
  return buildSecurityContext({ findings, enforcement, statusSnapshots, machineStates, sessions, permissionEvents,
    indicators, dataSettings, inventory, scanSummaries, atRestFindings, leases, bundles, machines, securityAudit });
}
