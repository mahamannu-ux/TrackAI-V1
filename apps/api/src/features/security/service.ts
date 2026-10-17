/**
 * Security settings service (Task20f, T20.8): the tenant's current rule settings, data
 * settings and monitor switch; the dry-run plan of a change; and the publish that stores
 * new versions, compiles and signs a new rule bundle, and audits it (gap G8).
 *
 * Order (AGENTS.md §9 item 18): plan (read) → compile and sign (no transaction, may call
 * KMS) → record (one transaction under the tenant lock, re-checking that nothing moved
 * since the plan; a concurrent publish answers `stale_plan` and the caller retries).
 * The v2 monitor switch is stored on the versioned lease-settings row
 * (security_data_settings_versions.monitor_mode), never in Task6.a's
 * tenant_security_monitor_settings: writing that row would also activate the Task6.a
 * route (AGENTS.md §9 item 11; independent review, 2026-10-17). Every table here is
 * append-only.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { recordAuditEvent } from '../../core/audit';
import {
  developerMachines,
  securityDataSettingsVersions,
  securityRuleBundles,
  securityRuleSettingsVersions,
} from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { NUMBAT_PIN, pinnedCatalogue, type Catalogue } from './catalogue';
import { canonicalize } from '../attesta/canonical';
import { LOCAL_DEV_MAX_PAYLOAD_BYTES } from '../attesta/signer-local-dev';
import { KMS_MAX_PAYLOAD_BYTES } from '../attesta/signer-kms';
import { COMPILER_VERSION, compileRules } from './compiler';
import { bundlePayload, signBundle } from './bundle';
import {
  SECURITY_AGENTS,
  SecuritySettingsError,
  applyDataChanges,
  applyRuleChanges,
  defaultLeaseSettings,
  defaultRuleSettings,
  diffRuleSettings,
  enabledDataSettings,
  sameLeaseSettings,
  validateAgents,
  validateRuleSettings,
  type LeaseSettings,
  type MonitorMode,
  type RuleChange,
  type RuleSettings,
  type SecurityAgent,
} from './settings';
import { SecurityDocumentTooLarge, type SecurityDocumentSigner } from './signing';

type Database = typeof db;
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

export class SecuritySettingsConflict extends Error {
  constructor(readonly category: 'stale_plan') {
    super(category);
    this.name = 'SecuritySettingsConflict';
  }
}

export interface CurrentBundle {
  id: string;
  bundleVersion: number;
  epoch: number;
  digest: string;
  issuedAt: Date;
  ruleSettingsVersion: number;
  enabledRuleCount: number;
}

export interface CurrentSecuritySettings {
  /** 0 = the default policy, never stored. */
  ruleSettingsVersion: number;
  rules: RuleSettings;
  /** 0 = the defaults (all off, monitoring off), never stored. */
  dataSettingsVersion: number;
  lease: LeaseSettings;
  /** Stored on the lease-settings row, so its version is the data-settings version. */
  monitor: { mode: MonitorMode; version: number };
  bundle: CurrentBundle | null;
}

export async function readSecuritySettings(tenantId: string, options: { executor?: Executor; catalogue?: Catalogue; now?: Date } = {}): Promise<CurrentSecuritySettings> {
  const catalogue = options.catalogue ?? pinnedCatalogue();
  const tenant = withTenant((options.executor ?? db) as Database, tenantId);
  const [rules] = await tenant.select(securityRuleSettingsVersions).orderBy(desc(securityRuleSettingsVersions.version)).limit(1);
  const [data] = await tenant.select(securityDataSettingsVersions).orderBy(desc(securityDataSettingsVersions.version)).limit(1);
  const [bundle] = await tenant.select(securityRuleBundles).orderBy(desc(securityRuleBundles.epoch)).limit(1);
  const lease: LeaseSettings = data ? {
    data: {
      schema_version: 'trackai.security-data-settings/1',
      command_previews: data.commandPreviews,
      file_paths: data.filePaths,
      urls: data.urls,
      host_identity: data.hostIdentity,
      user_identity: data.userIdentity,
    },
    agents: validateAgents(data.agents),
    dayOneScan: data.dayOneScan,
  } : defaultLeaseSettings();
  return {
    ruleSettingsVersion: rules?.version ?? 0,
    rules: rules ? validateRuleSettings(rules.rules, catalogue) : defaultRuleSettings(catalogue),
    dataSettingsVersion: data?.version ?? 0,
    lease,
    monitor: { mode: data?.monitorMode ?? 'off', version: data?.version ?? 0 },
    bundle: bundle ? {
      id: bundle.id,
      bundleVersion: bundle.bundleVersion,
      epoch: bundle.epoch,
      digest: bundle.digest,
      issuedAt: bundle.issuedAt,
      ruleSettingsVersion: bundle.ruleSettingsVersion,
      enabledRuleCount: bundle.enabledRuleCount,
    } : null,
  };
}

/** A settings change as the admin API and the CLI accept it (all parts optional). */
export interface SecuritySettingsChange {
  reason: string;
  monitorMode?: MonitorMode;
  rules?: unknown;
  dataSettings?: unknown;
  agents?: unknown;
  dayOneScan?: unknown;
}

const CHANGE_KEYS = ['dry_run', 'reason', 'monitor_mode', 'rules', 'data_settings', 'agents', 'day_one_scan'] as const;

/** The admin API / CLI body: `{dry_run, reason, monitor_mode?, rules?, data_settings?, agents?, day_one_scan?}`. */
export function parseSettingsChange(value: unknown): { dryRun: boolean; change: SecuritySettingsChange } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SecuritySettingsError('body must be an object');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !(CHANGE_KEYS as readonly string[]).includes(key))) throw new SecuritySettingsError('body has an unknown field');
  if (typeof body.dry_run !== 'boolean') throw new SecuritySettingsError('dry_run is required');
  if (typeof body.reason !== 'string' || body.reason.trim() === '' || body.reason.length > 1000) throw new SecuritySettingsError('reason is required (at most 1000 characters)');
  if (body.monitor_mode !== undefined && body.monitor_mode !== 'off' && body.monitor_mode !== 'monitor') {
    throw new SecuritySettingsError('monitor_mode must be off or monitor');
  }
  if (body.day_one_scan !== undefined && typeof body.day_one_scan !== 'boolean') throw new SecuritySettingsError('day_one_scan must be a boolean');
  return {
    dryRun: body.dry_run,
    change: {
      reason: body.reason,
      monitorMode: body.monitor_mode as MonitorMode | undefined,
      rules: body.rules,
      dataSettings: body.data_settings,
      agents: body.agents,
      dayOneScan: body.day_one_scan,
    },
  };
}

export interface SecuritySettingsPlan {
  current: CurrentSecuritySettings;
  rules: RuleSettings;
  lease: LeaseSettings;
  monitorMode: MonitorMode;
  ruleChanges: RuleChange[];
  leaseChanged: boolean;
  monitorChanged: boolean;
  /** A new bundle is made when rules change, or monitoring turns on and no bundle exists yet. */
  publishesBundle: boolean;
  /** A new rule-settings version is stored (rules changed, or the first bundle from the default policy). */
  writesRuleVersion: boolean;
  /**
   * The compiled bundle would exceed the signers' 1 MiB payload cap (both Attesta
   * adapters today), so applying this plan would answer SECURITY_SETTINGS_TOO_LARGE.
   */
  exceedsSignerLimit: boolean;
  next: { ruleSettingsVersion: number; dataSettingsVersion: number; monitorVersion: number; bundleVersion: number | null; epoch: number | null };
  activeMachineCount: number;
}

export async function planSecuritySettings(tenantId: string, change: SecuritySettingsChange,
  options: { executor?: Executor; catalogue?: Catalogue; now?: Date } = {}): Promise<SecuritySettingsPlan> {
  const current = await readSecuritySettings(tenantId, options);
  const rules = applyRuleChanges(current.rules, change.rules);
  const lease: LeaseSettings = {
    data: applyDataChanges(current.lease.data, change.dataSettings),
    agents: change.agents === undefined ? current.lease.agents : validateAgents(change.agents),
    dayOneScan: change.dayOneScan === undefined ? current.lease.dayOneScan : change.dayOneScan as boolean,
  };
  const monitorMode = change.monitorMode ?? current.monitor.mode;
  const ruleChanges = diffRuleSettings(current.rules, rules);
  const leaseChanged = !sameLeaseSettings(current.lease, lease);
  const monitorChanged = monitorMode !== current.monitor.mode;
  const writesLeaseVersion = leaseChanged || monitorChanged;
  const publishesBundle = ruleChanges.length > 0 || (current.bundle === null && monitorMode === 'monitor');
  // A bundle always compiles a stored rule-settings version, so the first bundle from the
  // default policy stores the defaults as version 1 (bundle_version = rule-settings version).
  const writesRuleVersion = ruleChanges.length > 0 || (publishesBundle && current.ruleSettingsVersion === 0);
  const ruleSettingsVersion = writesRuleVersion ? current.ruleSettingsVersion + 1 : current.ruleSettingsVersion;
  const dataSettingsVersion = writesLeaseVersion ? current.dataSettingsVersion + 1 : current.dataSettingsVersion;
  let exceedsSignerLimit = false;
  if (publishesBundle) {
    // Compile now so the dry run reports what the apply would refuse (the PAE header adds under 200 bytes).
    const catalogue = options.catalogue ?? pinnedCatalogue();
    const payload = bundlePayload({
      tenantId, bundleVersion: ruleSettingsVersion, epoch: (current.bundle?.epoch ?? 0) + 1, issuedAt: options.now ?? new Date(),
      compiled: compileRules(catalogue, rules, ruleSettingsVersion),
    });
    exceedsSignerLimit = Buffer.byteLength(canonicalize(payload), 'utf8') + 256 > Math.min(KMS_MAX_PAYLOAD_BYTES, LOCAL_DEV_MAX_PAYLOAD_BYTES);
  }
  return {
    current, rules, lease, monitorMode, ruleChanges, leaseChanged, monitorChanged, publishesBundle, writesRuleVersion, exceedsSignerLimit,
    next: {
      ruleSettingsVersion,
      dataSettingsVersion,
      monitorVersion: dataSettingsVersion,
      bundleVersion: publishesBundle ? ruleSettingsVersion : current.bundle?.bundleVersion ?? null,
      epoch: publishesBundle ? (current.bundle?.epoch ?? 0) + 1 : current.bundle?.epoch ?? null,
    },
    activeMachineCount: await activeMachineCount(tenantId, options.executor ?? db),
  };
}

export interface AppliedSecuritySettings {
  changed: boolean;
  ruleSettingsVersion: number;
  dataSettingsVersion: number;
  monitorVersion: number;
  bundle: CurrentBundle | null;
}

export interface ApplyDeps {
  signer: SecurityDocumentSigner;
  catalogue?: Catalogue;
  now?: () => Date;
  database?: Database;
}

/**
 * Publish a change. Nothing is written when nothing changes, when signing is unavailable
 * (SecuritySigningUnavailable propagates before the transaction) or when another publish
 * landed after the plan (SecuritySettingsConflict).
 */
export async function applySecuritySettings(input: {
  tenantId: string;
  actor: { type: 'tenant_admin' | 'system_operator'; id: string };
  change: SecuritySettingsChange;
  requestId?: string;
}, deps: ApplyDeps): Promise<AppliedSecuritySettings> {
  const database = deps.database ?? db;
  const catalogue = deps.catalogue ?? pinnedCatalogue();
  const now = (deps.now ?? (() => new Date()))();
  const plan = await planSecuritySettings(input.tenantId, input.change, { executor: database, catalogue, now });
  const { current, next } = plan;
  if (!plan.publishesBundle && !plan.leaseChanged && !plan.monitorChanged && !plan.writesRuleVersion) {
    return { changed: false, ruleSettingsVersion: current.ruleSettingsVersion, dataSettingsVersion: current.dataSettingsVersion, monitorVersion: current.monitor.version, bundle: current.bundle };
  }

  if (plan.exceedsSignerLimit) throw new SecurityDocumentTooLarge('the compiled rule bundle exceeds the signer payload cap');
  // Compile and sign outside any transaction (a KMS call may be slow or fail).
  let signed: Awaited<ReturnType<typeof signBundle>> | null = null;
  let enabledRuleCount = 0;
  if (plan.publishesBundle) {
    const compiled = compileRules(catalogue, plan.rules, next.ruleSettingsVersion);
    enabledRuleCount = compiled.agents[SECURITY_AGENTS[0]].enabledRuleIds.length;
    signed = await signBundle(deps.signer, bundlePayload({
      tenantId: input.tenantId,
      bundleVersion: next.bundleVersion as number,
      epoch: next.epoch as number,
      issuedAt: now,
      compiled,
    }));
  }

  return database.transaction(async transaction => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`security_settings:${input.tenantId}`}, 0))`);
    const tenant = withTenant(transaction as unknown as Database, input.tenantId);
    const again = await readSecuritySettings(input.tenantId, { executor: transaction as unknown as Executor, catalogue, now });
    if (again.ruleSettingsVersion !== current.ruleSettingsVersion || again.dataSettingsVersion !== current.dataSettingsVersion
      || again.monitor.version !== current.monitor.version || (again.bundle?.epoch ?? 0) !== (current.bundle?.epoch ?? 0)) {
      throw new SecuritySettingsConflict('stale_plan');
    }
    if (plan.writesRuleVersion) {
      await tenant.insert(securityRuleSettingsVersions, {
        version: next.ruleSettingsVersion, rules: plan.rules, numbatPin: NUMBAT_PIN, createdBy: input.actor.id, reason: input.change.reason,
      });
    }
    if (plan.leaseChanged || plan.monitorChanged) {
      await tenant.insert(securityDataSettingsVersions, {
        version: next.dataSettingsVersion,
        commandPreviews: plan.lease.data.command_previews,
        filePaths: plan.lease.data.file_paths,
        urls: plan.lease.data.urls,
        hostIdentity: plan.lease.data.host_identity,
        userIdentity: plan.lease.data.user_identity,
        agents: plan.lease.agents,
        dayOneScan: plan.lease.dayOneScan,
        monitorMode: plan.monitorMode,
        createdBy: input.actor.id,
        reason: input.change.reason,
      });
    }
    let bundle = current.bundle;
    if (signed) {
      const [row] = await tenant.insert(securityRuleBundles, {
        bundleVersion: next.bundleVersion as number,
        epoch: next.epoch as number,
        ruleSettingsVersion: next.ruleSettingsVersion,
        digest: signed.digest,
        envelope: signed.envelopeBytes,
        keyid: signed.keyid,
        compilerVersion: COMPILER_VERSION,
        numbatPin: NUMBAT_PIN,
        enabledRuleCount,
        issuedAt: now,
        createdBy: input.actor.id,
      });
      bundle = {
        id: row.id, bundleVersion: row.bundleVersion, epoch: row.epoch, digest: row.digest, issuedAt: row.issuedAt,
        ruleSettingsVersion: row.ruleSettingsVersion, enabledRuleCount: row.enabledRuleCount,
      };
    }
    const requestId = input.requestId ? { request_id: input.requestId } : {};
    const actor = { actorType: input.actor.type, actorId: input.actor.id };
    await recordAuditEvent(transaction, input.tenantId, {
      ...actor,
      action: 'security.settings.changed',
      targetType: 'tenant_security_settings',
      targetId: input.tenantId,
      details: {
        rule_settings_version: next.ruleSettingsVersion,
        data_settings_version: next.dataSettingsVersion,
        bundle_version: bundle?.bundleVersion ?? 0,
        epoch: bundle?.epoch ?? 0,
        changed_rule_count: plan.ruleChanges.length,
        enabled_data_settings: enabledDataSettings(plan.lease.data),
        day_one_scan: plan.lease.dayOneScan,
        agents: plan.lease.agents,
        reason: input.change.reason,
        ...requestId,
      },
    });
    if (signed && bundle) {
      await recordAuditEvent(transaction, input.tenantId, {
        ...actor,
        action: 'policy.bundle.published',
        targetType: 'policy_bundle',
        targetId: bundle.id,
        details: {
          version: bundle.bundleVersion,
          epoch: bundle.epoch,
          bundle_digest: bundle.digest,
          rule_settings_version: bundle.ruleSettingsVersion,
          enabled_rule_count: bundle.enabledRuleCount,
          reason: input.change.reason,
          ...requestId,
        },
      });
    }
    if (plan.monitorChanged) {
      await recordAuditEvent(transaction, input.tenantId, {
        ...actor,
        action: 'security.monitor.changed',
        targetType: 'tenant_security_settings',
        targetId: input.tenantId,
        details: { mode: plan.monitorMode, previous_mode: current.monitor.mode, version: next.monitorVersion, reason: input.change.reason, ...requestId },
      });
    }
    return {
      changed: true,
      ruleSettingsVersion: next.ruleSettingsVersion,
      dataSettingsVersion: next.dataSettingsVersion,
      monitorVersion: next.monitorVersion,
      bundle,
    };
  });
}

/** The stored envelope bytes of a tenant's bundle by digest; null for a missing or foreign digest. */
export async function bundleEnvelopeByDigest(tenantId: string, digest: string, executor: Executor = db): Promise<Buffer | null> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const [row] = await withTenant(executor as Database, tenantId)
    .select(securityRuleBundles, eq(securityRuleBundles.digest, digest)).limit(1);
  return row?.envelope ?? null;
}

/** The active-machine count, for the publish dry run. */
export async function activeMachineCount(tenantId: string, executor: Executor = db): Promise<number> {
  const rows = await withTenant(executor as Database, tenantId)
    .select(developerMachines, eq(developerMachines.status, 'active'));
  return rows.length;
}

export type { SecurityAgent };
