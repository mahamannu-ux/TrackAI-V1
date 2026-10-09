import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  developerMachines,
  fleetConfigurations,
  fleetMachineStates,
  machineCredentials,
  machineDeliveryHealthReports,
  machineRepositoryGrants,
  repositoryEnrollments,
  securityAuditEvents,
  tenantSecurityMonitorSettings,
} from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import { classifyClientDeliveryHealthStatus } from '../../core/operations/task4-operations-contract';
import { revokeDeveloperMachine } from '../../core/security/machine-security-service';
import {
  configurationEnvelope,
  type AssignFleetConfigurationInput,
  type CreateFleetConfigurationInput,
  type FleetConfigurationEnvelope,
  type FleetConfigurationSnapshot,
  type FleetReport,
} from './contract';

export class FleetServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly category: 'invalid_request' | 'not_found' | 'state_conflict',
  ) {
    super(category);
  }
}

function notFound(): never {
  throw new FleetServiceError(404, 'not_found');
}

function conflict(): never {
  throw new FleetServiceError(409, 'state_conflict');
}

async function activeMachine(tenantId: string, machineId: string) {
  const [machine] = await withTenant(db, tenantId).select(
    developerMachines,
    and(eq(developerMachines.id, machineId), eq(developerMachines.status, 'active')),
  ).limit(1);
  if (!machine) notFound();
  return machine;
}

export async function getFleetConfiguration(
  tenantId: string,
  machineId: string,
): Promise<FleetConfigurationEnvelope | null> {
  await activeMachine(tenantId, machineId);
  const tenant = withTenant(db, tenantId);
  const [state] = await tenant.select(
    fleetMachineStates,
    eq(fleetMachineStates.machineId, machineId),
  ).limit(1);
  if (!state?.desiredConfigurationId) return null;
  const [configuration] = await tenant.select(
    fleetConfigurations,
    eq(fleetConfigurations.id, state.desiredConfigurationId),
  ).limit(1);
  if (!configuration) conflict();
  return configurationEnvelope({ ...configuration, machineId });
}

export async function recordFleetReport(input: {
  tenantId: string;
  machineId: string;
  report: FleetReport;
}): Promise<void> {
  await activeMachine(input.tenantId, input.machineId);
  const tenant = withTenant(db, input.tenantId);
  const [existing] = await tenant.select(
    fleetMachineStates,
    eq(fleetMachineStates.machineId, input.machineId),
  ).limit(1);
  if (existing?.lastReportAt && input.report.reportedAt.getTime() < existing.lastReportAt.getTime()) {
    conflict();
  }

  if (input.report.acknowledgement) {
    const [acknowledged] = await tenant.select(
      fleetConfigurations,
      eq(fleetConfigurations.id, input.report.acknowledgement.configurationId),
    ).limit(1);
    if (!acknowledged || acknowledged.epoch !== input.report.acknowledgement.epoch) notFound();
    if (existing?.acknowledgedEpoch
      && input.report.acknowledgement.epoch < existing.acknowledgedEpoch) conflict();
    if (existing?.desiredConfigurationId) {
      const [desired] = await tenant.select(
        fleetConfigurations,
        eq(fleetConfigurations.id, existing.desiredConfigurationId),
      ).limit(1);
      if (!desired) conflict();
      if (input.report.acknowledgement.epoch > desired.epoch) conflict();
    }
  }

  const acknowledgement = input.report.acknowledgement;
  const values = {
    machineId: input.machineId,
    desiredConfigurationId: existing?.desiredConfigurationId ?? null,
    acknowledgedConfigurationId: acknowledgement?.configurationId
      ?? existing?.acknowledgedConfigurationId ?? null,
    acknowledgedEpoch: acknowledgement?.epoch ?? existing?.acknowledgedEpoch ?? null,
    acknowledgementResult: acknowledgement?.resultCode
      ?? existing?.acknowledgementResult ?? null,
    platform: input.report.platform,
    osVersion: input.report.osVersion,
    architecture: input.report.architecture,
    gitaiVersion: input.report.gitaiVersion,
    serviceState: input.report.serviceState,
    pendingRetryable: input.report.queue.pendingRetryable,
    waitingRetry: input.report.queue.waitingRetry,
    processing: input.report.queue.processing,
    quarantined: input.report.queue.quarantined,
    rowsWithErrors: input.report.queue.rowsWithErrors,
    mdmDeviceReference: input.report.mdmDeviceReference,
    mdmUserReference: input.report.mdmUserReference,
    assignmentSource: input.report.assignmentEvidence.source,
    assignmentObservedAt: input.report.assignmentEvidence.observedAt,
    lastReportAt: input.report.reportedAt,
    updatedAt: new Date(),
  };
  await tenant.upsert(
    fleetMachineStates,
    values,
    [fleetMachineStates.tenantId, fleetMachineStates.machineId],
    values,
  );
}

async function snapshotCurrentPolicy(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  now: Date,
): Promise<FleetConfigurationSnapshot> {
  const tenant = withTenant(transaction as unknown as typeof db, tenantId);
  const grants = await tenant.select(machineRepositoryGrants, and(
    eq(machineRepositoryGrants.status, 'active'),
    lte(machineRepositoryGrants.effectiveFrom, now),
    or(isNull(machineRepositoryGrants.effectiveUntil), gt(machineRepositoryGrants.effectiveUntil, now)),
  ));
  const enrollments = await tenant.select(repositoryEnrollments, and(
    eq(repositoryEnrollments.status, 'active'),
    lte(repositoryEnrollments.effectiveFrom, now),
    or(isNull(repositoryEnrollments.effectiveUntil), gt(repositoryEnrollments.effectiveUntil, now)),
  ));
  const machines = await tenant.select(developerMachines, eq(developerMachines.status, 'active'));
  const settings = await tenant.select(tenantSecurityMonitorSettings);
  const enrollmentById = new Map(enrollments.map(enrollment => [enrollment.id, enrollment]));
  const activeMachineIds = new Set(machines.map(machine => machine.id));
  const repositoryPolicies = grants.flatMap(grant => {
    const enrollment = enrollmentById.get(grant.enrollmentId);
    if (!enrollment || !activeMachineIds.has(grant.machineId)) return [];
    return [{
      machineId: grant.machineId,
      repositoryId: enrollment.repositoryId,
      enrollmentId: enrollment.id,
      grantId: grant.id,
      branchPatterns: grant.branchPatterns,
      effectiveFrom: grant.effectiveFrom.toISOString(),
      effectiveUntil: grant.effectiveUntil?.toISOString() ?? null,
    }];
  }).sort((left, right) => left.grantId.localeCompare(right.grantId));
  const setting = settings[0];
  const monitorActive = setting?.mode === 'monitor'
    && setting.revokedAt === null
    && (setting.validUntil === null || setting.validUntil.getTime() > now.getTime());
  return {
    repositoryPolicies,
    securityActivation: { mode: monitorActive ? 'monitor' : 'off', version: setting?.version ?? 0 },
  };
}

export async function createFleetConfiguration(input: {
  tenantId: string;
  actorId: string;
  configuration: CreateFleetConfigurationInput;
}) {
  return db.transaction(async transaction => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${input.tenantId}))`);
    const tenant = withTenant(transaction as unknown as typeof db, input.tenantId);
    const [latest] = await tenant.select(fleetConfigurations).orderBy(
      desc(fleetConfigurations.epoch),
    ).limit(1);
    const snapshot = await snapshotCurrentPolicy(transaction, input.tenantId, new Date());
    const [configuration] = await tenant.insert(fleetConfigurations, {
      epoch: (latest?.epoch ?? 0) + 1,
      schemaVersion: 1,
      generatedBy: input.actorId,
      validUntil: input.configuration.validUntil,
      targetClientVersion: input.configuration.targetClientVersion,
      channel: input.configuration.channel,
      ring: input.configuration.ring,
      snapshot,
    });
    await tenant.insert(securityAuditEvents, {
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'fleet_configuration.created',
      targetType: 'fleet_configuration',
      targetId: configuration.id,
      details: {
        epoch: configuration.epoch,
        targetClientVersion: configuration.targetClientVersion,
        channel: configuration.channel,
        ring: configuration.ring,
        reason: input.configuration.reason,
        repositoryPolicyCount: snapshot.repositoryPolicies.length,
        securityActivation: snapshot.securityActivation,
      },
    });
    return {
      id: configuration.id,
      epoch: configuration.epoch,
      schemaVersion: configuration.schemaVersion,
      generatedAt: configuration.generatedAt,
      validUntil: configuration.validUntil,
      targetClientVersion: configuration.targetClientVersion,
      channel: configuration.channel,
      ring: configuration.ring,
    };
  });
}

export async function assignFleetConfiguration(input: {
  tenantId: string;
  actorId: string;
  assignment: AssignFleetConfigurationInput;
}): Promise<void> {
  await db.transaction(async transaction => {
    const tenant = withTenant(transaction as unknown as typeof db, input.tenantId);
    const [configuration] = await tenant.select(
      fleetConfigurations,
      eq(fleetConfigurations.id, input.assignment.configurationId),
    ).limit(1);
    if (!configuration) notFound();
    const machines = await tenant.select(developerMachines, and(
      inArray(developerMachines.id, input.assignment.machineIds),
      eq(developerMachines.status, 'active'),
    ));
    if (machines.length !== input.assignment.machineIds.length) notFound();
    const assignedAt = new Date();
    for (const machineId of input.assignment.machineIds) {
      await tenant.upsert(
        fleetMachineStates,
        { machineId, desiredConfigurationId: configuration.id, updatedAt: assignedAt },
        [fleetMachineStates.tenantId, fleetMachineStates.machineId],
        { desiredConfigurationId: configuration.id, updatedAt: assignedAt },
      );
    }
    await tenant.insert(securityAuditEvents, {
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'fleet_configuration.assigned',
      targetType: 'fleet_configuration',
      targetId: configuration.id,
      details: {
        epoch: configuration.epoch,
        machineIds: [...input.assignment.machineIds].sort(),
        reason: input.assignment.reason,
      },
    });
  });
}

export function classifyFleetMachineStatus(input: {
  machineStatus: 'active' | 'revoked';
  state: typeof fleetMachineStates.$inferSelect | undefined;
  now: Date;
}): 'current' | 'stale' | 'unreported' | 'unavailable' | 'mismatch' | 'revoked' {
  if (input.machineStatus === 'revoked') return 'revoked';
  if (!input.state?.lastReportAt) return 'unreported';
  if (input.state.serviceState === 'unavailable') return 'unavailable';
  if (input.state.desiredConfigurationId
    && input.state.acknowledgedConfigurationId !== input.state.desiredConfigurationId) return 'mismatch';
  if (input.state.lastReportAt.getTime() < input.now.getTime() - 15 * 60 * 1_000) return 'stale';
  return 'current';
}

export async function listFleetMachines(tenantId: string, now = new Date()) {
  const tenant = withTenant(db, tenantId);
  const [machines, states, configurations, deliveryReports] = await Promise.all([
    tenant.select(developerMachines).orderBy(desc(developerMachines.createdAt)),
    tenant.select(fleetMachineStates),
    tenant.select(fleetConfigurations),
    tenant.select(machineDeliveryHealthReports),
  ]);
  const stateByMachine = new Map(states.map(state => [state.machineId, state]));
  const configurationById = new Map(configurations.map(configuration => [configuration.id, configuration]));
  const deliveryByMachine = new Map(deliveryReports.map(report => [report.machineId, report]));
  return {
    machines: machines.map(machine => {
      const state = stateByMachine.get(machine.id);
      const desired = state?.desiredConfigurationId
        ? configurationById.get(state.desiredConfigurationId)
        : undefined;
      const delivery = deliveryByMachine.get(machine.id);
      return {
        id: machine.id,
        installationId: machine.installationId,
        displayName: machine.displayName,
        status: classifyFleetMachineStatus({ machineStatus: machine.status, state, now }),
        machineStatus: machine.status,
        desiredConfiguration: desired ? {
          id: desired.id,
          epoch: desired.epoch,
          targetClientVersion: desired.targetClientVersion,
          channel: desired.channel,
          ring: desired.ring,
        } : null,
        observed: state ? {
          acknowledgedConfigurationId: state.acknowledgedConfigurationId,
          acknowledgedEpoch: state.acknowledgedEpoch,
          resultCode: state.acknowledgementResult,
          platform: state.platform,
          osVersion: state.osVersion,
          architecture: state.architecture,
          gitaiVersion: state.gitaiVersion,
          serviceState: state.serviceState,
          queue: state.lastReportAt ? {
            pendingRetryable: state.pendingRetryable,
            waitingRetry: state.waitingRetry,
            processing: state.processing,
            quarantined: state.quarantined,
            rowsWithErrors: state.rowsWithErrors,
          } : null,
          mdmDeviceReference: state.mdmDeviceReference,
          mdmUserReference: state.mdmUserReference,
          assignmentEvidence: state.assignmentSource ? {
            source: state.assignmentSource,
            observedAt: state.assignmentObservedAt,
          } : null,
          lastReportAt: state.lastReportAt,
        } : null,
        reconciliation: 'unavailable' as const,
        deliveryHealth: delivery ? {
          status: classifyClientDeliveryHealthStatus({ receivedAt: delivery.receivedAt, evaluatedAt: now }),
          observedAt: delivery.observedAt,
          receivedAt: delivery.receivedAt,
          pendingRetryable: delivery.pendingRetryable,
          waitingRetry: delivery.waitingRetry,
          processing: delivery.processing,
          quarantined: delivery.quarantined,
          rowsWithErrors: delivery.rowsWithErrors,
        } : { status: 'unavailable' as const },
      };
    }),
  };
}

export async function previewFleetOffboard(tenantId: string, machineId: string) {
  const machine = await activeMachine(tenantId, machineId);
  const tenant = withTenant(db, tenantId);
  const [credentials, grants, state] = await Promise.all([
    tenant.select(machineCredentials, and(
      eq(machineCredentials.machineId, machineId),
      eq(machineCredentials.status, 'active'),
    )),
    tenant.select(machineRepositoryGrants, and(
      eq(machineRepositoryGrants.machineId, machineId),
      eq(machineRepositoryGrants.status, 'active'),
    )),
    tenant.select(fleetMachineStates, eq(fleetMachineStates.machineId, machineId)).limit(1),
  ]);
  return {
    machine: {
      id: machine.id,
      installationId: machine.installationId,
      displayName: machine.displayName,
      status: machine.status,
    },
    activeCredentialCount: credentials.length,
    activeGrantCount: grants.length,
    desiredConfigurationId: state[0]?.desiredConfigurationId ?? null,
    localCleanup: 'best_effort_not_requested_by_server' as const,
  };
}

export async function applyFleetOffboard(input: {
  tenantId: string;
  machineId: string;
  actorId: string;
  reason: string;
}) {
  const preview = await previewFleetOffboard(input.tenantId, input.machineId);
  await revokeDeveloperMachine(input.tenantId, input.machineId, input.actorId, input.reason);
  await db.transaction(async transaction => {
    const tenant = withTenant(transaction as unknown as typeof db, input.tenantId);
    await tenant.update(
      fleetMachineStates,
      { desiredConfigurationId: null, updatedAt: new Date() },
      eq(fleetMachineStates.machineId, input.machineId),
    );
    await tenant.insert(securityAuditEvents, {
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'fleet_machine.offboarded',
      targetType: 'developer_machine',
      targetId: input.machineId,
      details: {
        reason: input.reason,
        desiredConfigurationId: preview.desiredConfigurationId,
        activeCredentialCount: preview.activeCredentialCount,
        activeGrantCount: preview.activeGrantCount,
        serverRevocation: 'applied',
        localCleanup: 'best_effort_not_requested_by_server',
        mdmCleanup: 'not_requested',
      },
    });
  });
  return {
    serverRevocation: 'applied' as const,
    localCleanup: 'best_effort_not_requested_by_server' as const,
    mdmCleanup: 'not_requested' as const,
  };
}
