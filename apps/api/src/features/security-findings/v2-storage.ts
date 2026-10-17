/**
 * Security v2 record storage (Task20d; docs/contracts/security-v2/api.md
 * "POST /records" and README "Storage and idempotency").
 *
 * Admission keeps the frozen order: a current lease for the machine (checked by
 * the route), then per record the lease window (findings), the tenant's data
 * settings (refuse, never strip), and the enrolled-repository check for
 * findings. All writes run in one transaction per request with the tenant
 * facade, and the results are returned in request order.
 *
 * Value handling (AGENTS.md rule 6): finding previews are encrypted with an
 * envelope context that binds the tenant, the finding and the field; plaintext
 * never reaches a column, a log or a response.
 */
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { db } from '../../core/db';
import * as schema from '../../core/db/schema';
import {
  repositoryEnrollments,
  securityAgentInventorySnapshots,
  securityEnforcementDecisions,
  securityFindingPreviews,
  securityFindings,
  securityIndicators,
  securityPermissionEvents,
  securityScanSummaries,
  securityStatusSnapshots,
} from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { encryptEnvelope, decryptEnvelope, type EncryptedValue } from '../../core/security/envelope-encryption';
import {
  SECURITY_DATA_SETTINGS_SCHEMA,
  checkDataSettings,
  SecurityV2FieldNotPermittedError,
  type SecurityAgentInventoryV2,
  type SecurityDataSettingsV1,
  type SecurityEnforcementV2,
  type SecurityEnforcementV2Base,
  type SecurityFindingV2,
  type SecurityIndicatorV2,
  type SecurityPermissionEventV2,
  type SecurityRecordV2,
  type SecurityScanSummaryV2,
  type SecurityStatusV2,
  type SecurityUploadV2,
  type SecurityV2ErrorCode,
  type SecurityV2RecordResult,
} from './v2-contract';
import type { SecurityV2Authority } from './v2-authority';

/** The envelope purpose every finding preview is encrypted under. */
export const SECURITY_V2_PREVIEW_PURPOSE = 'security-v2-finding-preview' as const;

export type SecurityV2PreviewField =
  | 'observed_command'
  | 'observed_file_path'
  | 'observed_url'
  | 'endpoint_hostname'
  | 'endpoint_username';

export interface SecurityV2StoredIndicator {
  type: SecurityIndicatorV2['type'];
  value: string;
  count: number;
  first_seen: string;
  last_seen: string;
  source_agent: string;
}

export interface SecurityV2EncryptedPreview {
  field: SecurityV2PreviewField;
  encrypted: EncryptedValue;
}

/**
 * The per-request storage surface. Every method is tenant-bound by the runner;
 * record identity is (tenant, machine, record_id) everywhere.
 */
export interface SecurityV2StorageTransaction {
  enrollmentActive(tenantId: string, repositoryId: string, now: Date): Promise<boolean>;
  /** The stored canonical record (previews decrypted), or null when absent. */
  findRecord(input: {
    tenantId: string;
    machineId: string;
    recordId: string;
    kind: Exclude<SecurityRecordV2['kind'], 'indicator'>;
  }): Promise<SecurityRecordV2 | null>;
  /** Inserts a write-once record; null when the identity already exists. Findings return their row id. */
  insertRecord(record: SecurityRecordV2, receivedAt: Date): Promise<string | null>;
  findIndicator(input: {
    tenantId: string;
    machineId: string;
    recordId: string;
  }): Promise<SecurityV2StoredIndicator | null>;
  insertIndicator(record: SecurityIndicatorV2, receivedAt: Date): Promise<boolean>;
  /** Component-wise maxima on count and last_seen; the other columns never move. */
  updateIndicatorMaxima(input: {
    tenantId: string;
    machineId: string;
    recordId: string;
    count: number;
    lastSeen: Date;
  }, receivedAt: Date): Promise<void>;
  insertFindingPreviews(input: {
    tenantId: string;
    findingRowId: string;
    machineId: string;
    previews: SecurityV2EncryptedPreview[];
  }, receivedAt: Date): Promise<void>;
}

export type SecurityV2StorageRunner = <T>(
  callback: (transaction: SecurityV2StorageTransaction) => Promise<T>,
) => Promise<T>;

const ALL_OFF_SETTINGS: SecurityDataSettingsV1 = {
  schema_version: SECURITY_DATA_SETTINGS_SCHEMA,
  command_previews: false,
  file_paths: false,
  urls: false,
  host_identity: false,
  user_identity: false,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Record fields whose comparison is by instant, not by string form. */
const INSTANT_KEYS = new Set([
  'detected_at',
  'timestamp',
  'first_seen',
  'last_seen',
  'observed_at',
  'last_record_at',
]);

function valueMatches(a: unknown, b: unknown, key: string): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (typeof a === 'string' && typeof b === 'string' && INSTANT_KEYS.has(key)) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valueMatches(item, b[index], key));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].every(k => valueMatches(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      k,
    ));
  }
  return a === b;
}

/**
 * Write-once replay equality (README "Storage and idempotency"): same
 * (tenant, machine, record_id), same kind, every defined field equal, with
 * timestamps compared as instants. A differing field is a conflict, never a
 * silent rewrite.
 */
export function canonicalRecordMatches(
  existing: SecurityRecordV2,
  candidate: SecurityRecordV2,
): boolean {
  if (existing.kind !== candidate.kind) return false;
  const keys = new Set([...Object.keys(existing), ...Object.keys(candidate)]);
  const asObject = (record: SecurityRecordV2): Record<string, unknown> => record as unknown as Record<string, unknown>;
  return [...keys].every(key => valueMatches(
    asObject(existing)[key],
    asObject(candidate)[key],
    key,
  ));
}

const SCALAR_PREVIEW_FIELDS: ReadonlyArray<readonly [keyof SecurityFindingV2, SecurityV2PreviewField]> = [
  ['observed_command', 'observed_command'],
  ['observed_file_path', 'observed_file_path'],
  ['observed_url', 'observed_url'],
];

/** The preview values a finding carries, in the preview table's field names. */
export function previewValuesOf(record: SecurityFindingV2): Array<[SecurityV2PreviewField, string]> {
  const values: Array<[SecurityV2PreviewField, string]> = [];
  for (const [key, field] of SCALAR_PREVIEW_FIELDS) {
    const value = record[key];
    if (typeof value === 'string') values.push([field, value]);
  }
  if (record.endpoint?.hostname !== undefined) values.push(['endpoint_hostname', record.endpoint.hostname]);
  if (record.endpoint?.username !== undefined) values.push(['endpoint_username', record.endpoint.username]);
  return values;
}

function rejected(recordId: string, code: SecurityV2ErrorCode): SecurityV2RecordResult {
  return { record_id: recordId as SecurityRecordId2, result: 'rejected', code };
}

type SecurityRecordId2 = SecurityRecordV2['record_id'];

async function admitRecord(
  transaction: SecurityV2StorageTransaction,
  tenantId: string,
  machineId: string,
  record: SecurityRecordV2,
  receivedAt: Date,
): Promise<SecurityV2RecordResult> {
  const accepted: SecurityV2RecordResult = {
    record_id: record.record_id,
    result: 'accepted',
  };
  const duplicate: SecurityV2RecordResult = {
    record_id: record.record_id,
    result: 'duplicate',
  };

  if (record.kind === 'indicator') {
    const identity = { tenantId, machineId, recordId: record.record_id };
    let existing = await transaction.findIndicator(identity);
    if (!existing) {
      if (await transaction.insertIndicator(record, receivedAt)) return accepted;
      existing = await transaction.findIndicator(identity);
      if (!existing) return rejected(record.record_id, 'SECURITY_V2_INTERNAL');
    }
    // Identity fields are write-once; a change is a conflict (README).
    if (existing.type !== record.type
      || existing.value !== record.value
      || existing.source_agent !== record.source_agent
      || new Date(existing.first_seen).getTime() !== new Date(record.first_seen).getTime()) {
      return rejected(record.record_id, 'SECURITY_V2_RECORD_CONFLICT');
    }
    const countGreater = record.count > existing.count;
    const lastSeenLater = new Date(record.last_seen).getTime() > new Date(existing.last_seen).getTime();
    if (!countGreater && !lastSeenLater) return duplicate;
    await transaction.updateIndicatorMaxima({
      tenantId,
      machineId,
      recordId: record.record_id,
      count: Math.max(record.count, existing.count),
      lastSeen: lastSeenLater ? new Date(record.last_seen) : new Date(existing.last_seen),
    }, receivedAt);
    return accepted;
  }

  // Enrolled-repository check (api.md admission order, step 5): no grant check
  // here — Task4 grants govern Task2 flows, not security findings.
  if (record.kind === 'finding' && record.repository.kind === 'enrolled') {
    if (!UUID_RE.test(record.repository.id)
      || !await transaction.enrollmentActive(tenantId, record.repository.id, receivedAt)) {
      return rejected(record.record_id, 'SECURITY_V2_INVALID_BODY');
    }
  }

  const identity = {
    tenantId,
    machineId,
    recordId: record.record_id,
    kind: record.kind as Exclude<SecurityRecordV2['kind'], 'indicator'>,
  };
  const existing = await transaction.findRecord(identity);
  if (existing) {
    return canonicalRecordMatches(existing, record) ? duplicate : rejected(record.record_id, 'SECURITY_V2_RECORD_CONFLICT');
  }
  const rowId = await transaction.insertRecord(record, receivedAt);
  if (rowId === null) {
    // Raced with a concurrent upload of the same record: re-read decides.
    const raced = await transaction.findRecord(identity);
    return raced && canonicalRecordMatches(raced, record)
      ? duplicate
      : rejected(record.record_id, 'SECURITY_V2_RECORD_CONFLICT');
  }
  if (record.kind === 'finding') {
    const previews = previewValuesOf(record);
    if (previews.length > 0) {
      await transaction.insertFindingPreviews({
        tenantId,
        findingRowId: rowId,
        machineId,
        previews: previews.map(([field, plaintext]) => ({
          field,
          encrypted: encryptEnvelope(plaintext, {
            tenantId,
            purpose: SECURITY_V2_PREVIEW_PURPOSE,
            resourceId: `${rowId}:${field}`,
          }),
        })),
      }, receivedAt);
    }
  }
  return accepted;
}

/**
 * The request's storage phase: per-record lease window and data settings
 * (outside the transaction, authority calls have no database work), then all
 * remaining records in one transaction, results in request order.
 */
export async function persistSecurityV2UploadWithStore(input: {
  tenantId: string;
  machineId: string;
  upload: SecurityUploadV2;
  settings: SecurityDataSettingsV1 | null;
  authority: SecurityV2Authority;
  receivedAt: Date;
}, runTransaction: SecurityV2StorageRunner): Promise<SecurityV2RecordResult[]> {
  const results: SecurityV2RecordResult[] = new Array(input.upload.records.length);
  const pending: Array<{ index: number; record: SecurityRecordV2 }> = [];
  const effectiveSettings = input.settings ?? ALL_OFF_SETTINGS;

  for (const [index, record] of input.upload.records.entries()) {
    if (record.kind === 'finding') {
      // Lease window (api.md admission order, step 4): detected_at must fall
      // in [issued_at, expires_at) of the lease the record names.
      const lease = await input.authority.leaseForMachine(
        input.tenantId,
        input.machineId,
        record.lease_id,
      );
      const detectedAt = new Date(record.detected_at);
      if (!lease
        || detectedAt.getTime() < lease.issuedAt.getTime()
        || detectedAt.getTime() >= lease.expiresAt.getTime()) {
        results[index] = rejected(record.record_id, 'SECURITY_V2_LEASE_MISMATCH');
        continue;
      }
    }
    try {
      checkDataSettings(record, effectiveSettings);
    } catch (error) {
      if (error instanceof SecurityV2FieldNotPermittedError) {
        results[index] = rejected(record.record_id, 'SECURITY_V2_FIELD_NOT_PERMITTED');
        continue;
      }
      throw error;
    }
    pending.push({ index, record });
  }

  if (pending.length > 0) {
    await runTransaction(async transaction => {
      for (const { index, record } of pending) {
        results[index] = await admitRecord(
          transaction,
          input.tenantId,
          input.machineId,
          record,
          input.receivedAt,
        );
      }
    });
  }
  return results;
}

type StorageDbTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

function tenantOf(transaction: StorageDbTransaction, tenantId: string) {
  // withTenant only calls select/insert/update/delete, which the transaction
  // supports; the cast keeps one facade type for both the pool and transactions.
  return withTenant(transaction as unknown as typeof db, tenantId);
}

function isInstant(value: Date | null): string | undefined {
  return value === null ? undefined : value.toISOString();
}

function rowToEnforcement(row: typeof securityEnforcementDecisions.$inferSelect): SecurityEnforcementV2 {
  // The deny fields ride in the union members, not the base shape, so the row's
  // guard-checked columns are reassembled and cast once at the boundary.
  return {
    kind: 'enforcement',
    record_id: row.recordId as SecurityRecordId2,
    rule_ids: row.ruleIds,
    finding_record_ids: row.findingRecordIds as SecurityEnforcementV2['finding_record_ids'],
    decision: row.decision as SecurityEnforcementV2['decision'],
    mode: row.mode as SecurityEnforcementV2['mode'],
    source_agent: row.sourceAgent as SecurityEnforcementV2['source_agent'],
    timestamp: row.occurredAt.toISOString(),
    ...(row.toolName !== null ? { tool_name: row.toolName } : {}),
    ...(row.toolCallId !== null ? { tool_call_id: row.toolCallId } : {}),
    ...(row.sessionId !== null ? { session_id: row.sessionId } : {}),
    ...(row.denyRuleId !== null
      ? { deny_rule_id: row.denyRuleId, deny_rule_version: row.denyRuleVersion as string }
      : {}),
  } as SecurityEnforcementV2;
}

function rowToScanSummary(row: typeof securityScanSummaries.$inferSelect): SecurityScanSummaryV2 {
  return {
    kind: 'scan_summary',
    record_id: row.recordId as SecurityRecordId2,
    status: row.status as SecurityScanSummaryV2['status'],
    artifacts_scanned: row.artifactsScanned,
    events_emitted: row.eventsEmitted,
    findings_emitted: row.findingsEmitted,
    indicators_emitted: row.indicatorsEmitted,
    diagnostics: row.diagnostics,
  };
}

function rowToPermissionEvent(row: typeof securityPermissionEvents.$inferSelect): SecurityPermissionEventV2 {
  const shape = row.join === 'exact'
    ? { join: 'exact' as const, tool_call_id: row.toolCallId! }
    : row.join === 'same_session_window'
      ? { join: 'same_session_window' as const, session_id: row.sessionId! }
      : { join: 'unavailable' as const };
  const base: SecurityPermissionEventV2 = {
    kind: 'permission_event',
    record_id: row.recordId as SecurityRecordId2,
    outcome: row.outcome as SecurityPermissionEventV2['outcome'],
    source_agent: row.sourceAgent as SecurityPermissionEventV2['source_agent'],
    timestamp: row.occurredAt.toISOString(),
    ...shape,
  };
  if (row.toolName !== null) base.tool_name = row.toolName;
  if (row.join === 'exact' && row.sessionId !== null) base.session_id = row.sessionId;
  if (row.join !== 'exact' && row.toolCallId !== null) base.tool_call_id = row.toolCallId;
  if (row.join === 'unavailable' && row.sessionId !== null) base.session_id = row.sessionId;
  return base;
}

function rowToStatus(row: typeof securityStatusSnapshots.$inferSelect): SecurityStatusV2 {
  const record: SecurityStatusV2 = {
    kind: 'security_status',
    record_id: row.recordId as SecurityRecordId2,
    observed_at: row.observedAt.toISOString(),
    numbat_version: row.numbatVersion,
    wired_agents: row.wiredAgents as SecurityStatusV2['wired_agents'],
    active_bundle_digest: row.activeBundleDigest,
    lease_id: row.leaseId,
    last_record_at: isInstant(row.lastRecordAt) ?? null,
    health: {
      hook_status: row.hookStatus as SecurityStatusV2['health']['hook_status'],
      agent_effective_view: row.agentEffectiveView as SecurityStatusV2['health']['agent_effective_view'],
      local_record: row.localRecord as SecurityStatusV2['health']['local_record'],
      forwarder_ack: row.forwarderAck as SecurityStatusV2['health']['forwarder_ack'],
    },
  };
  return record;
}

function rowToAgentInventory(row: typeof securityAgentInventorySnapshots.$inferSelect): SecurityAgentInventoryV2 {
  return {
    kind: 'agent_inventory',
    record_id: row.recordId as SecurityRecordId2,
    observed_at: row.observedAt.toISOString(),
    agents: row.agents as SecurityAgentInventoryV2['agents'],
  };
}

type FindingRow = typeof securityFindings.$inferSelect;
type PreviewRow = typeof securityFindingPreviews.$inferSelect;

function decryptPreview(
  preview: Pick<PreviewRow, 'field' | 'valueEncrypted'>,
  tenantId: string,
  findingRowId: string,
): string {
  // The stored envelope decrypts only under the same tenant, finding and field
  // it was sealed with (envelope-encryption AAD); the runtime keyring holds the
  // master key versions the tenant's envelopes may use.
  return decryptEnvelope(preview.valueEncrypted as EncryptedValue, {
    tenantId,
    purpose: SECURITY_V2_PREVIEW_PURPOSE,
    resourceId: `${findingRowId}:${preview.field}`,
  });
}

function rowToFinding(
  row: FindingRow,
  previews: PreviewRow[],
  tenantId: string,
): SecurityFindingV2 {
  // Every guarded column is NOT NULL for a v2 row by security_findings_v2_check.
  const record: SecurityFindingV2 = {
    kind: 'finding',
    record_id: row.recordId as SecurityRecordId2,
    rule_id: row.ruleId,
    rule_version: row.ruleVersion,
    severity: row.ruleSeverity as SecurityFindingV2['severity'],
    title: row.title as string,
    source_agent: row.sourceAgent as SecurityFindingV2['source_agent'],
    source_type: row.sourceType as SecurityFindingV2['source_type'],
    confidence: row.confidence as SecurityFindingV2['confidence'],
    detected_at: row.detectedAt?.toISOString() as string,
    numbat_schema_version: row.numbatSchemaVersion as SecurityFindingV2['numbat_schema_version'],
    bundle_digest: row.bundleDigest as string,
    lease_id: row.leaseId as string,
    found_at_rest: row.foundAtRest as boolean,
    repository: row.repositoryKind === 'enrolled'
      ? { kind: 'enrolled', id: row.repositoryId as string }
      : { kind: 'not_enrolled' },
  };
  if (row.model !== null) record.model = row.model;
  if (row.modelProvider !== null) record.model_provider = row.modelProvider;
  if (row.sessionId !== null) record.session_id = row.sessionId;
  if (row.parentSessionId !== null) record.parent_session_id = row.parentSessionId;
  if (row.subAgentId !== null) record.sub_agent_id = row.subAgentId;
  if (row.tags !== null) record.tags = row.tags;
  for (const preview of previews) {
    const plaintext = decryptPreview(preview, tenantId, row.id);
    if (preview.field === 'observed_command') record.observed_command = plaintext;
    else if (preview.field === 'observed_file_path') record.observed_file_path = plaintext;
    else if (preview.field === 'observed_url') record.observed_url = plaintext;
    else if (preview.field === 'endpoint_hostname') {
      record.endpoint = { ...record.endpoint, hostname: plaintext };
    } else {
      record.endpoint = { ...record.endpoint, username: plaintext };
    }
  }
  return record;
}

function databaseSecurityV2StorageTransaction(
  transaction: StorageDbTransaction,
  tenantId: string,
  machineId: string,
): SecurityV2StorageTransaction {
  const tenant = tenantOf(transaction, tenantId);
  return {
    async enrollmentActive(_boundTenantId, repositoryId, now) {
      const rows = await tenant.select(repositoryEnrollments, and(
        eq(repositoryEnrollments.repositoryId, repositoryId),
        eq(repositoryEnrollments.status, 'active'),
        lte(repositoryEnrollments.effectiveFrom, now),
        or(
          isNull(repositoryEnrollments.effectiveUntil),
          gt(repositoryEnrollments.effectiveUntil, now),
        ),
      )).limit(1);
      return rows.length > 0;
    },
    async findRecord(input) {
      if (input.kind === 'finding') {
        const [row] = await tenant.select(securityFindings, and(
          eq(securityFindings.machineId, input.machineId),
          eq(securityFindings.recordId, input.recordId),
          eq(securityFindings.recordGeneration, 'v2'),
        )).limit(1);
        if (!row) return null;
        const previews = await tenant.select(securityFindingPreviews, and(
          eq(securityFindingPreviews.findingId, row.id),
        ));
        return rowToFinding(row, previews, tenantId);
      }
      if (input.kind === 'enforcement') {
        const [row] = await tenant.select(securityEnforcementDecisions, and(
          eq(securityEnforcementDecisions.machineId, input.machineId),
          eq(securityEnforcementDecisions.recordId, input.recordId),
        )).limit(1);
        return row ? rowToEnforcement(row) : null;
      }
      if (input.kind === 'scan_summary') {
        const [row] = await tenant.select(securityScanSummaries, and(
          eq(securityScanSummaries.machineId, input.machineId),
          eq(securityScanSummaries.recordId, input.recordId),
        )).limit(1);
        return row ? rowToScanSummary(row) : null;
      }
      if (input.kind === 'permission_event') {
        const [row] = await tenant.select(securityPermissionEvents, and(
          eq(securityPermissionEvents.machineId, input.machineId),
          eq(securityPermissionEvents.recordId, input.recordId),
        )).limit(1);
        return row ? rowToPermissionEvent(row) : null;
      }
      if (input.kind === 'security_status') {
        const [row] = await tenant.select(securityStatusSnapshots, and(
          eq(securityStatusSnapshots.machineId, input.machineId),
          eq(securityStatusSnapshots.recordId, input.recordId),
        )).limit(1);
        return row ? rowToStatus(row) : null;
      }
      const [row] = await tenant.select(securityAgentInventorySnapshots, and(
        eq(securityAgentInventorySnapshots.machineId, input.machineId),
        eq(securityAgentInventorySnapshots.recordId, input.recordId),
      )).limit(1);
      return row ? rowToAgentInventory(row) : null;
    },
    async insertRecord(record, receivedAt) {
      if (record.kind === 'finding') {
        // The v2 arbiter is a partial unique index, which ON CONFLICT target
        // inference cannot name; a bare DO NOTHING covers it. tenantId is
        // stamped from the request, never from the record.
        const [row] = await transaction.insert(securityFindings).values({
          tenantId,
          machineId,
          recordGeneration: 'v2',
          ruleId: record.rule_id,
          ruleVersion: record.rule_version,
          ruleCategory: record.rule_id.split('.')[0],
          ruleSeverity: record.severity,
          effect: 'monitor',
          occurredAt: new Date(record.detected_at),
          rulePackVersion: `bundle:${record.bundle_digest.slice(0, 16)}`,
          receivedAt,
          repositoryId: record.repository.kind === 'enrolled' ? record.repository.id : null,
          findingId: null,
          deliveryId: null,
          sessionId: record.session_id ?? null,
          sourceEventId: null,
          routeId: null,
          agentFamily: null,
          hostSurface: null,
          hostMode: null,
          captureChannel: null,
          operatingSystem: null,
          timing: null,
          nativeEffect: null,
          activation: null,
          phase: null,
          availability: null,
          completeness: null,
          resultCategory: null,
          clientVersion: null,
          recordId: record.record_id,
          sourceAgent: record.source_agent,
          sourceType: record.source_type,
          model: record.model ?? null,
          modelProvider: record.model_provider ?? null,
          parentSessionId: record.parent_session_id ?? null,
          subAgentId: record.sub_agent_id ?? null,
          confidence: record.confidence,
          title: record.title,
          tags: record.tags ?? null,
          foundAtRest: record.found_at_rest,
          detectedAt: new Date(record.detected_at),
          numbatSchemaVersion: record.numbat_schema_version,
          bundleDigest: record.bundle_digest,
          leaseId: record.lease_id,
          repositoryKind: record.repository.kind,
        }).onConflictDoNothing().returning({ id: securityFindings.id });
        return row?.id ?? null;
      }
      if (record.kind === 'enforcement') {
        const rows = await tenant.insertDoNothing(securityEnforcementDecisions, {
          machineId,
          recordId: record.record_id,
          decision: record.decision,
          mode: record.mode,
          ruleIds: record.rule_ids,
          denyRuleId: record.deny_rule_id ?? null,
          denyRuleVersion: record.deny_rule_version ?? null,
          findingRecordIds: record.finding_record_ids,
          toolName: record.tool_name ?? null,
          toolCallId: record.tool_call_id ?? null,
          sessionId: record.session_id ?? null,
          sourceAgent: record.source_agent,
          occurredAt: new Date(record.timestamp),
          receivedAt,
        }, [
          securityEnforcementDecisions.tenantId,
          securityEnforcementDecisions.machineId,
          securityEnforcementDecisions.recordId,
        ]);
        return rows[0]?.id ?? null;
      }
      if (record.kind === 'scan_summary') {
        const rows = await tenant.insertDoNothing(securityScanSummaries, {
          machineId,
          recordId: record.record_id,
          status: record.status,
          artifactsScanned: record.artifacts_scanned,
          eventsEmitted: record.events_emitted,
          findingsEmitted: record.findings_emitted,
          indicatorsEmitted: record.indicators_emitted,
          diagnostics: record.diagnostics,
          receivedAt,
        }, [
          securityScanSummaries.tenantId,
          securityScanSummaries.machineId,
          securityScanSummaries.recordId,
        ]);
        return rows[0]?.id ?? null;
      }
      if (record.kind === 'permission_event') {
        const rows = await tenant.insertDoNothing(securityPermissionEvents, {
          machineId,
          recordId: record.record_id,
          outcome: record.outcome,
          toolName: record.tool_name ?? null,
          toolCallId: record.tool_call_id ?? null,
          sessionId: record.session_id ?? null,
          sourceAgent: record.source_agent,
          occurredAt: new Date(record.timestamp),
          join: record.join,
          receivedAt,
        }, [
          securityPermissionEvents.tenantId,
          securityPermissionEvents.machineId,
          securityPermissionEvents.recordId,
        ]);
        return rows[0]?.id ?? null;
      }
      if (record.kind === 'security_status') {
        const rows = await tenant.insertDoNothing(securityStatusSnapshots, {
          machineId,
          recordId: record.record_id,
          observedAt: new Date(record.observed_at),
          numbatVersion: record.numbat_version,
          wiredAgents: record.wired_agents,
          activeBundleDigest: record.active_bundle_digest,
          leaseId: record.lease_id,
          lastRecordAt: record.last_record_at === null ? null : new Date(record.last_record_at),
          hookStatus: record.health.hook_status,
          agentEffectiveView: record.health.agent_effective_view,
          localRecord: record.health.local_record,
          forwarderAck: record.health.forwarder_ack,
          receivedAt,
        }, [
          securityStatusSnapshots.tenantId,
          securityStatusSnapshots.machineId,
          securityStatusSnapshots.recordId,
        ]);
        return rows[0]?.id ?? null;
      }
      if (record.kind !== 'agent_inventory') {
        // Unreachable: the kinds above are exhaustive over the union.
        throw new Error(`unsupported record kind for insertRecord`);
      }
      const rows = await tenant.insertDoNothing(securityAgentInventorySnapshots, {
        machineId,
        recordId: record.record_id,
        observedAt: new Date(record.observed_at),
        agents: record.agents,
        receivedAt,
      }, [
        securityAgentInventorySnapshots.tenantId,
        securityAgentInventorySnapshots.machineId,
        securityAgentInventorySnapshots.recordId,
      ]);
      return rows[0]?.id ?? null;
    },
    async findIndicator(input) {
      const [row] = await tenant.select(securityIndicators, and(
        eq(securityIndicators.machineId, input.machineId),
        eq(securityIndicators.recordId, input.recordId),
      )).limit(1);
      return row
        ? {
          type: row.type as SecurityV2StoredIndicator['type'],
          value: row.value,
          count: row.count,
          first_seen: row.firstSeen.toISOString(),
          last_seen: row.lastSeen.toISOString(),
          source_agent: row.sourceAgent,
        }
        : null;
    },
    async insertIndicator(record, receivedAt) {
      const rows = await tenant.insertDoNothing(securityIndicators, {
        machineId,
        recordId: record.record_id,
        type: record.type,
        value: record.value,
        count: record.count,
        firstSeen: new Date(record.first_seen),
        lastSeen: new Date(record.last_seen),
        sourceAgent: record.source_agent,
        receivedAt,
      }, [
        securityIndicators.tenantId,
        securityIndicators.machineId,
        securityIndicators.recordId,
      ]);
      return rows.length > 0;
    },
    async updateIndicatorMaxima(input, receivedAt) {
      // SQL-side greatest keeps the maxima monotonic when two uploads race;
      // a TS-side max computed from an earlier read could move them backwards.
      await tenant.update(securityIndicators, {
        count: sql`greatest(${securityIndicators.count}, ${input.count})` as unknown as number,
        lastSeen: sql`greatest(${securityIndicators.lastSeen}, ${input.lastSeen})` as unknown as Date,
        receivedAt,
      }, and(
        eq(securityIndicators.machineId, input.machineId),
        eq(securityIndicators.recordId, input.recordId),
      ));
    },
    async insertFindingPreviews(input, receivedAt) {
      for (const preview of input.previews) {
        await tenant.insert(securityFindingPreviews, {
          machineId: input.machineId,
          findingId: input.findingRowId,
          field: preview.field,
          valueEncrypted: preview.encrypted as unknown as Record<string, unknown>,
          receivedAt,
        });
      }
    },
  };
}

export async function persistSecurityV2Upload(input: {
  tenantId: string;
  machineId: string;
  upload: SecurityUploadV2;
  settings: SecurityDataSettingsV1 | null;
  authority: SecurityV2Authority;
  receivedAt: Date;
}): Promise<SecurityV2RecordResult[]> {
  return persistSecurityV2UploadWithStore(input, callback => db.transaction(
    transaction => callback(
      databaseSecurityV2StorageTransaction(transaction, input.tenantId, input.machineId),
    ),
  ));
}
