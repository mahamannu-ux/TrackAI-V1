export const FLEET_SCHEMA_VERSION = 1 as const;
export const FLEET_CHANNELS = [
  'latest',
  'next',
  'enterprise-latest',
  'enterprise-next',
] as const;
export const FLEET_PLATFORMS = ['macos', 'windows'] as const;
export const FLEET_ARCHITECTURES = ['x86_64', 'aarch64'] as const;
export const FLEET_SERVICE_STATES = ['running', 'stopped', 'degraded', 'unavailable'] as const;
export const FLEET_REPORT_RESULTS = [
  'applied',
  'rejected_invalid',
  'rejected_expired',
  'rejected_incompatible',
  'verification_unavailable',
  'verification_rejected',
  'activation_failed',
  'unavailable',
] as const;
export const FLEET_ASSIGNMENT_SOURCES = ['jamf', 'intune', 'manual', 'unavailable'] as const;

export type FleetChannel = typeof FLEET_CHANNELS[number];
export type FleetPlatform = typeof FLEET_PLATFORMS[number];
export type FleetArchitecture = typeof FLEET_ARCHITECTURES[number];
export type FleetServiceState = typeof FLEET_SERVICE_STATES[number];
export type FleetReportResult = typeof FLEET_REPORT_RESULTS[number];
export type FleetAssignmentSource = typeof FLEET_ASSIGNMENT_SOURCES[number];

export interface FleetRepositoryPolicyReference {
  repositoryId: string;
  enrollmentId: string;
  grantId: string;
  branchPatterns: string[];
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface FleetConfigurationSnapshot {
  repositoryPolicies: Array<FleetRepositoryPolicyReference & { machineId: string }>;
  securityActivation: {
    mode: 'off' | 'monitor';
    version: number;
  };
}

export interface FleetConfigurationEnvelope {
  schemaVersion: 1;
  configurationId: string;
  epoch: number;
  issuedAt: string;
  validUntil: string | null;
  targetClientVersion: string;
  channel: FleetChannel;
  ring: string | null;
  repositoryPolicies: FleetRepositoryPolicyReference[];
  securityActivation: { mode: 'off' | 'monitor'; version: number };
  verification: { required: true; state: 'unavailable' };
}

export interface FleetReport {
  schemaVersion: 1;
  reportedAt: Date;
  acknowledgement: {
    configurationId: string;
    epoch: number;
    resultCode: FleetReportResult;
  } | null;
  platform: FleetPlatform;
  osVersion: string;
  architecture: FleetArchitecture;
  gitaiVersion: string;
  serviceState: FleetServiceState;
  queue: {
    pendingRetryable: number;
    waitingRetry: number;
    processing: number;
    quarantined: number;
    rowsWithErrors: number;
  };
  mdmDeviceReference: string | null;
  mdmUserReference: string | null;
  assignmentEvidence: {
    source: FleetAssignmentSource;
    observedAt: Date;
  };
}

export interface CreateFleetConfigurationInput {
  targetClientVersion: string;
  channel: FleetChannel;
  ring: string | null;
  validUntil: Date | null;
  reason: string;
}

export interface AssignFleetConfigurationInput {
  configurationId: string;
  machineIds: string[];
  reason: string;
}

export interface ApplyFleetOffboardInput {
  apply: true;
  reason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUE_COUNT = 1_000_000;
const MAX_FUTURE_MS = 5 * 60 * 1_000;

function record(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) {
    throw new Error(`${name} contains unsupported fields`);
  }
  return result;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function nullableBoundedString(value: unknown, name: string, max: number): string | null {
  return value === undefined || value === null ? null : boundedString(value, name, max);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${name} is unsupported`);
  }
  return value as T;
}

function uuid(value: unknown, name: string): string {
  const result = boundedString(value, name, 36);
  if (!UUID.test(result)) throw new Error(`${name} must be a UUID`);
  return result;
}

function dateValue(
  value: unknown,
  name: string,
  now: Date,
  allowNull = false,
  boundFuture = true,
): Date | null {
  if (allowNull && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string') throw new Error(`${name} is invalid`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())
    || (boundFuture && result.getTime() > now.getTime() + MAX_FUTURE_MS)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function count(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_QUEUE_COUNT) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

export function parseCreateFleetConfiguration(
  value: unknown,
  now = new Date(),
): CreateFleetConfigurationInput {
  const input = record(value, [
    'targetClientVersion', 'channel', 'ring', 'validUntil', 'reason',
  ], 'configuration');
  const validUntil = dateValue(input.validUntil, 'validUntil', now, true, false);
  if (validUntil && validUntil.getTime() <= now.getTime()) {
    throw new Error('validUntil must be in the future');
  }
  return {
    targetClientVersion: boundedString(input.targetClientVersion, 'targetClientVersion', 64),
    channel: enumValue(input.channel, FLEET_CHANNELS, 'channel'),
    ring: nullableBoundedString(input.ring, 'ring', 64),
    validUntil,
    reason: boundedString(input.reason, 'reason', 1_000),
  };
}

export function parseFleetAssignment(value: unknown): AssignFleetConfigurationInput {
  const input = record(value, ['configurationId', 'machineIds', 'reason'], 'assignment');
  if (!Array.isArray(input.machineIds) || input.machineIds.length < 1 || input.machineIds.length > 100) {
    throw new Error('machineIds must contain 1 to 100 machines');
  }
  const machineIds = input.machineIds.map((item, index) => uuid(item, `machineIds[${index}]`));
  if (new Set(machineIds).size !== machineIds.length) throw new Error('machineIds must be unique');
  return {
    configurationId: uuid(input.configurationId, 'configurationId'),
    machineIds,
    reason: boundedString(input.reason, 'reason', 1_000),
  };
}

export function parseFleetOffboard(value: unknown): ApplyFleetOffboardInput {
  const input = record(value, ['apply', 'reason'], 'offboard');
  if (input.apply !== true) throw new Error('apply must be true after reviewing the preview');
  return { apply: true, reason: boundedString(input.reason, 'reason', 1_000) };
}

export function parseFleetReport(value: unknown, now = new Date()): FleetReport {
  const input = record(value, [
    'schemaVersion', 'reportedAt', 'acknowledgement', 'platform', 'osVersion',
    'architecture', 'gitaiVersion', 'serviceState', 'queue', 'mdmDeviceReference',
    'mdmUserReference', 'assignmentEvidence',
  ], 'report');
  if (input.schemaVersion !== FLEET_SCHEMA_VERSION) throw new Error('schemaVersion is unsupported');
  const queue = record(input.queue, [
    'pendingRetryable', 'waitingRetry', 'processing', 'quarantined', 'rowsWithErrors',
  ], 'queue');
  const assignment = record(input.assignmentEvidence, ['source', 'observedAt'], 'assignmentEvidence');
  let acknowledgement: FleetReport['acknowledgement'] = null;
  if (input.acknowledgement !== undefined && input.acknowledgement !== null) {
    const ack = record(
      input.acknowledgement,
      ['configurationId', 'epoch', 'resultCode'],
      'acknowledgement',
    );
    if (!Number.isSafeInteger(ack.epoch) || (ack.epoch as number) < 1) {
      throw new Error('acknowledgement.epoch is invalid');
    }
    acknowledgement = {
      configurationId: uuid(ack.configurationId, 'acknowledgement.configurationId'),
      epoch: ack.epoch as number,
      resultCode: enumValue(ack.resultCode, FLEET_REPORT_RESULTS, 'acknowledgement.resultCode'),
    };
  }
  const reportedAt = dateValue(input.reportedAt, 'reportedAt', now) as Date;
  const assignmentObservedAt = dateValue(
    assignment.observedAt,
    'assignmentEvidence.observedAt',
    now,
  ) as Date;
  if (assignmentObservedAt.getTime() > reportedAt.getTime()) {
    throw new Error('assignmentEvidence.observedAt cannot be after reportedAt');
  }
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    reportedAt,
    acknowledgement,
    platform: enumValue(input.platform, FLEET_PLATFORMS, 'platform'),
    osVersion: boundedString(input.osVersion, 'osVersion', 128),
    architecture: enumValue(input.architecture, FLEET_ARCHITECTURES, 'architecture'),
    gitaiVersion: boundedString(input.gitaiVersion, 'gitaiVersion', 64),
    serviceState: enumValue(input.serviceState, FLEET_SERVICE_STATES, 'serviceState'),
    queue: {
      pendingRetryable: count(queue.pendingRetryable, 'queue.pendingRetryable'),
      waitingRetry: count(queue.waitingRetry, 'queue.waitingRetry'),
      processing: count(queue.processing, 'queue.processing'),
      quarantined: count(queue.quarantined, 'queue.quarantined'),
      rowsWithErrors: count(queue.rowsWithErrors, 'queue.rowsWithErrors'),
    },
    mdmDeviceReference: nullableBoundedString(input.mdmDeviceReference, 'mdmDeviceReference', 255),
    mdmUserReference: nullableBoundedString(input.mdmUserReference, 'mdmUserReference', 255),
    assignmentEvidence: {
      source: enumValue(assignment.source, FLEET_ASSIGNMENT_SOURCES, 'assignmentEvidence.source'),
      observedAt: assignmentObservedAt,
    },
  };
}

export function validateFleetConfigurationSnapshot(value: unknown): FleetConfigurationSnapshot {
  const snapshot = record(value, ['repositoryPolicies', 'securityActivation'], 'snapshot');
  if (!Array.isArray(snapshot.repositoryPolicies) || snapshot.repositoryPolicies.length > 1_000) {
    throw new Error('snapshot.repositoryPolicies is invalid');
  }
  const repositoryPolicies = snapshot.repositoryPolicies.map((value, index) => {
    const policy = record(value, [
      'machineId', 'repositoryId', 'enrollmentId', 'grantId', 'branchPatterns',
      'effectiveFrom', 'effectiveUntil',
    ], `snapshot.repositoryPolicies[${index}]`);
    if (!Array.isArray(policy.branchPatterns)
      || policy.branchPatterns.length > 64
      || policy.branchPatterns.some(pattern => (
        typeof pattern !== 'string' || !pattern || pattern.length > 255
      ))) {
      throw new Error(`snapshot.repositoryPolicies[${index}].branchPatterns is invalid`);
    }
    const effectiveFrom = new Date(boundedString(
      policy.effectiveFrom,
      `snapshot.repositoryPolicies[${index}].effectiveFrom`,
      64,
    ));
    if (!Number.isFinite(effectiveFrom.getTime())) throw new Error('snapshot effectiveFrom is invalid');
    let effectiveUntil: string | null = null;
    if (policy.effectiveUntil !== null) {
      effectiveUntil = boundedString(
        policy.effectiveUntil,
        `snapshot.repositoryPolicies[${index}].effectiveUntil`,
        64,
      );
      if (!Number.isFinite(new Date(effectiveUntil).getTime())) {
        throw new Error('snapshot effectiveUntil is invalid');
      }
    }
    return {
      machineId: uuid(policy.machineId, `snapshot.repositoryPolicies[${index}].machineId`),
      repositoryId: uuid(policy.repositoryId, `snapshot.repositoryPolicies[${index}].repositoryId`),
      enrollmentId: uuid(policy.enrollmentId, `snapshot.repositoryPolicies[${index}].enrollmentId`),
      grantId: uuid(policy.grantId, `snapshot.repositoryPolicies[${index}].grantId`),
      branchPatterns: [...policy.branchPatterns] as string[],
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveUntil: effectiveUntil === null ? null : new Date(effectiveUntil).toISOString(),
    };
  });
  const activation = record(snapshot.securityActivation, ['mode', 'version'], 'securityActivation');
  if ((activation.mode !== 'off' && activation.mode !== 'monitor')
    || !Number.isSafeInteger(activation.version)
    || (activation.version as number) < 0) {
    throw new Error('securityActivation is invalid');
  }
  return {
    repositoryPolicies,
    securityActivation: {
      mode: activation.mode,
      version: activation.version as number,
    },
  };
}

export function configurationEnvelope(input: {
  machineId: string;
  id: string;
  epoch: number;
  generatedAt: Date;
  validUntil: Date | null;
  targetClientVersion: string;
  channel: FleetChannel;
  ring: string | null;
  snapshot: FleetConfigurationSnapshot;
}): FleetConfigurationEnvelope {
  const snapshot = validateFleetConfigurationSnapshot(input.snapshot);
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    configurationId: input.id,
    epoch: input.epoch,
    issuedAt: input.generatedAt.toISOString(),
    validUntil: input.validUntil?.toISOString() ?? null,
    targetClientVersion: input.targetClientVersion,
    channel: input.channel,
    ring: input.ring,
    repositoryPolicies: snapshot.repositoryPolicies
      .filter(policy => policy.machineId === input.machineId)
      .map(({ machineId: _machineId, ...policy }) => policy),
    securityActivation: snapshot.securityActivation,
    verification: { required: true, state: 'unavailable' },
  };
}
