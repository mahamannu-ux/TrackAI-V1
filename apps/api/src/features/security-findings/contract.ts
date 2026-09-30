const RULE_IDS = [
  'trackai.exec.destructive_recursive_delete',
  'trackai.exec.download_pipe_shell',
  'trackai.exec.reverse_shell',
] as const;

const OPERATING_SYSTEMS = ['macos', 'linux', 'windows', 'wsl', 'unavailable'] as const;
const TIMINGS = ['pre_action', 'post_action', 'at_rest', 'unavailable'] as const;
const ACTIVATIONS = ['configured', 'loaded', 'observed', 'unavailable'] as const;
const PHASES = ['requested', 'observed_result', 'partial', 'unavailable'] as const;
const AVAILABILITY = ['available', 'unavailable', 'redacted', 'expired'] as const;
const COMPLETENESS = ['complete', 'partial'] as const;
const RESULT_CATEGORIES = [
  'not_observed', 'success', 'failure', 'cancelled', 'unknown', 'unavailable',
] as const;

type RuleId = typeof RULE_IDS[number];
type OperatingSystem = typeof OPERATING_SYSTEMS[number];
type Timing = typeof TIMINGS[number];
type Activation = typeof ACTIVATIONS[number];
type Phase = typeof PHASES[number];
type Availability = typeof AVAILABILITY[number];
type Completeness = typeof COMPLETENESS[number];
type ResultCategory = typeof RESULT_CATEGORIES[number];

export interface SecurityFindingUpload {
  findingId: string;
  deliveryId: string;
  repositoryId: string;
  sessionId: string;
  sourceEventId: string;
  correlationId?: string;
  rule: {
    id: RuleId;
    version: string;
    category: 'execution';
    severity: 'high' | 'critical';
  };
  capability: {
    routeId: 'AC-CLI-03';
    agentFamily: 'opencode';
    hostSurface: 'terminal';
    hostMode: 'cli';
    captureChannel: 'provider-plugin';
    operatingSystem: OperatingSystem;
    timing: Timing;
    nativeEffect: 'observe_only';
    activation: Activation;
  };
  effect: 'monitor';
  phase: Phase;
  availability: Availability;
  completeness: Completeness;
  resultCategory: ResultCategory;
  occurredAt: string;
  clientVersion: string;
  rulePackVersion: string;
}

export interface SecurityFindingUploadBatch {
  schemaVersion: 'trackai.security-finding-upload/0.1';
  findings: SecurityFindingUpload[];
}

export interface CanonicalSecurityFinding extends SecurityFindingUpload {
  schemaVersion: 'trackai.security-finding/0.1';
  tenantId: string;
  machineId: string;
}

export interface SecurityMonitorAuthorization {
  mode: 'off' | 'monitor';
  validUntil: Date | null;
  revokedAt: Date | null;
}

export interface SecurityFindingAdmissionResult {
  accepted: CanonicalSecurityFinding[];
  errors: Array<{ index: number; error: string }>;
}

function closedObject(
  value: unknown,
  name: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const unsupported = Object.keys(object).find(key => !allowedFields.includes(key));
  if (unsupported) throw new Error(`${name} contains unsupported field ${unsupported}`);
  return object;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function optionalBoundedString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, name, maximum);
}

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${name} is unsupported`);
  }
  return value as T;
}

function constant<T extends string>(value: unknown, name: string, expected: T): T {
  if (value !== expected) throw new Error(`${name} must be ${expected}`);
  return expected;
}

function timestamp(value: unknown, name: string): string {
  const result = boundedString(value, name, 64);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(result) || !Number.isFinite(new Date(result).getTime())) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return result;
}

function validateRule(value: unknown, index: number): SecurityFindingUpload['rule'] {
  const name = `findings[${index}].rule`;
  const rule = closedObject(value, name, ['id', 'version', 'category', 'severity']);
  return {
    id: oneOf(rule.id, `${name}.id`, RULE_IDS),
    version: boundedString(rule.version, `${name}.version`, 32),
    category: constant(rule.category, `${name}.category`, 'execution'),
    severity: oneOf(rule.severity, `${name}.severity`, ['high', 'critical'] as const),
  };
}

function validateCapability(value: unknown, index: number): SecurityFindingUpload['capability'] {
  const name = `findings[${index}].capability`;
  const capability = closedObject(value, name, [
    'routeId', 'agentFamily', 'hostSurface', 'hostMode', 'captureChannel',
    'operatingSystem', 'timing', 'nativeEffect', 'activation',
  ]);
  return {
    routeId: constant(capability.routeId, `${name}.routeId`, 'AC-CLI-03'),
    agentFamily: constant(capability.agentFamily, `${name}.agentFamily`, 'opencode'),
    hostSurface: constant(capability.hostSurface, `${name}.hostSurface`, 'terminal'),
    hostMode: constant(capability.hostMode, `${name}.hostMode`, 'cli'),
    captureChannel: constant(capability.captureChannel, `${name}.captureChannel`, 'provider-plugin'),
    operatingSystem: oneOf(capability.operatingSystem, `${name}.operatingSystem`, OPERATING_SYSTEMS),
    timing: oneOf(capability.timing, `${name}.timing`, TIMINGS),
    nativeEffect: constant(capability.nativeEffect, `${name}.nativeEffect`, 'observe_only'),
    activation: oneOf(capability.activation, `${name}.activation`, ACTIVATIONS),
  };
}

function validateFinding(value: unknown, index: number): SecurityFindingUpload {
  const name = `findings[${index}]`;
  const finding = closedObject(value, name, [
    'findingId', 'deliveryId', 'repositoryId', 'sessionId', 'sourceEventId', 'correlationId',
    'rule', 'capability', 'effect', 'phase', 'availability', 'completeness',
    'resultCategory', 'occurredAt', 'clientVersion', 'rulePackVersion',
  ]);
  return {
    findingId: boundedString(finding.findingId, `${name}.findingId`, 128),
    deliveryId: boundedString(finding.deliveryId, `${name}.deliveryId`, 128),
    repositoryId: boundedString(finding.repositoryId, `${name}.repositoryId`, 128),
    sessionId: boundedString(finding.sessionId, `${name}.sessionId`, 128),
    sourceEventId: boundedString(finding.sourceEventId, `${name}.sourceEventId`, 128),
    correlationId: optionalBoundedString(finding.correlationId, `${name}.correlationId`, 128),
    rule: validateRule(finding.rule, index),
    capability: validateCapability(finding.capability, index),
    effect: constant(finding.effect, `${name}.effect`, 'monitor'),
    phase: oneOf(finding.phase, `${name}.phase`, PHASES),
    availability: oneOf(finding.availability, `${name}.availability`, AVAILABILITY),
    completeness: oneOf(finding.completeness, `${name}.completeness`, COMPLETENESS),
    resultCategory: oneOf(finding.resultCategory, `${name}.resultCategory`, RESULT_CATEGORIES),
    occurredAt: timestamp(finding.occurredAt, `${name}.occurredAt`),
    clientVersion: boundedString(finding.clientVersion, `${name}.clientVersion`, 64),
    rulePackVersion: boundedString(finding.rulePackVersion, `${name}.rulePackVersion`, 64),
  };
}

export function validateSecurityFindingUploadBatch(value: unknown): SecurityFindingUploadBatch {
  const batch = closedObject(value, 'batch', ['schemaVersion', 'findings']);
  constant(batch.schemaVersion, 'schemaVersion', 'trackai.security-finding-upload/0.1');
  if (!Array.isArray(batch.findings) || batch.findings.length < 1 || batch.findings.length > 100) {
    throw new Error('findings must contain between 1 and 100 items');
  }
  const findings = batch.findings.map(validateFinding);
  const findingIds = new Set(findings.map(finding => finding.findingId));
  const deliveryIds = new Set(findings.map(finding => finding.deliveryId));
  if (findingIds.size !== findings.length || deliveryIds.size !== findings.length) {
    throw new Error('findingId and deliveryId values must be unique in a batch');
  }
  return { schemaVersion: 'trackai.security-finding-upload/0.1', findings };
}

function authorizationIsActive(
  authorization: SecurityMonitorAuthorization,
  receivedAt: Date,
): boolean {
  return authorization.mode === 'monitor'
    && authorization.revokedAt === null
    && (authorization.validUntil === null || authorization.validUntil.getTime() > receivedAt.getTime());
}

export async function admitSecurityFindingBatch(input: {
  tenantId: string;
  machineId: string;
  authorization: SecurityMonitorAuthorization;
  batch: SecurityFindingUploadBatch;
  receivedAt: Date;
  repositoryGrantAllows: (
    repositoryId: string,
    branch: null,
    tenantId: string,
    machineId: string,
  ) => Promise<boolean>;
}): Promise<SecurityFindingAdmissionResult> {
  if (!authorizationIsActive(input.authorization, input.receivedAt)) {
    throw new Error('Security monitoring is not active for this tenant');
  }
  const accepted: CanonicalSecurityFinding[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  for (const [index, finding] of input.batch.findings.entries()) {
    if (!await input.repositoryGrantAllows(
      finding.repositoryId,
      null,
      input.tenantId,
      input.machineId,
    )) {
      errors.push({ index, error: 'Machine repository grant is not active' });
      continue;
    }
    accepted.push({
      ...finding,
      schemaVersion: 'trackai.security-finding/0.1',
      tenantId: input.tenantId,
      machineId: input.machineId,
    });
  }
  return { accepted, errors };
}
