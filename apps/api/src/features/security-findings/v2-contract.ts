/**
 * [CONTRACT - FROZEN]
 * TypeScript view of docs/contracts/security-v2. Breaking changes require a
 * new major version beside this module; Task20d implements the two stubs.
 */

export const SECURITY_V2_UPLOAD_SCHEMA = 'trackai.security-upload/2' as const;
export const SECURITY_DATA_SETTINGS_SCHEMA = 'trackai.security-data-settings/1' as const;
export const SECURITY_RULE_BUNDLE_SCHEMA = 'trackai.security-rule-bundle/1' as const;
export const SECURITY_ACTIVATION_LEASE_SCHEMA = 'trackai.security-activation-lease/2' as const;
export const SECURITY_ACKNOWLEDGEMENT_SCHEMA = 'trackai.security-acknowledgement/1' as const;
export const SECURITY_V2_NUMBAT_SCHEMA = '0.5.0' as const;
export const SECURITY_V2_NUMBAT_PIN = '20a5a52' as const;

export const SECURITY_V2_MAX_UPLOAD_RECORDS = 500;
export const SECURITY_V2_MAX_UPLOAD_BYTES = 4_194_304;
export const SECURITY_V2_MAX_RULE_FILE_BYTES = 262_144;
export const SECURITY_V2_MAX_BUNDLE_BYTES = 4_194_304;
export const SECURITY_V2_MAX_REDACTED_CODE_POINTS = 200;
export const SECURITY_V2_DEFAULT_LEASE_VALIDITY_HOURS = 72;
export const SECURITY_V2_LEASE_REFRESH_SECONDS = 3_600;

export const SECURITY_V2_ERROR_CODES = [
  'SECURITY_V2_INVALID_BODY',
  'SECURITY_V2_UNSUPPORTED_SCHEMA',
  'SECURITY_V2_UNKNOWN_FIELD',
  'SECURITY_V2_FIELD_NOT_PERMITTED',
  'SECURITY_V2_LEASE_REQUIRED',
  'SECURITY_V2_LEASE_MISMATCH',
  'SECURITY_V2_PAYLOAD_TOO_LARGE',
  'SECURITY_V2_NOT_FOUND',
  'SECURITY_V2_LEASE_NOT_ISSUED',
  'SECURITY_V2_RATE_LIMITED',
  'SECURITY_V2_RECORD_CONFLICT',
  'SECURITY_V2_INTERNAL',
] as const;

export const SECURITY_V2_REFUSAL_CODES = [
  'SIGNATURE_REJECTED',
  'VERIFICATION_UNAVAILABLE',
  'LEASE_EXPIRED',
  'MACHINE_MISMATCH',
  'TENANT_MISMATCH',
  'EPOCH_REGRESSION',
  'BUNDLE_DIGEST_MISMATCH',
  'RULES_CHECK_FAILED',
  'UNSUPPORTED_SCHEMA',
] as const;

export type SecurityV2ErrorCode = typeof SECURITY_V2_ERROR_CODES[number];
export type SecurityV2RefusalCode = typeof SECURITY_V2_REFUSAL_CODES[number];
export type SecurityRecordId = `sha256:${string}`;
export type Sha256Digest = string;

export type SecuritySourceAgent =
  | 'claude-code' | 'cowork' | 'codex' | 'gemini-cli' | 'cursor'
  | 'windsurf' | 'copilot' | 'vscode' | 'opencode' | 'openclaw'
  | 'antigravity' | 'factory' | 'grok' | 'devin-cli' | 'hermes'
  | 'kimi-code' | 'pi' | 'qwen-code' | 'cline' | 'amp' | 'auggie'
  | 'kiro' | 'goose' | 'kilo' | 'openhands' | 'crush' | 'junie'
  | 'unknown';

export interface SecurityFindingV2 {
  kind: 'finding';
  record_id: SecurityRecordId;
  rule_id: string;
  rule_version: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  source_agent: SecuritySourceAgent;
  source_type: 'artifact' | 'hook' | 'otel';
  model?: string;
  model_provider?: string;
  session_id?: string;
  parent_session_id?: string;
  sub_agent_id?: string;
  confidence: 'high' | 'medium' | 'low';
  tags?: string[];
  detected_at: string;
  numbat_schema_version: typeof SECURITY_V2_NUMBAT_SCHEMA;
  bundle_digest: Sha256Digest;
  lease_id: string;
  found_at_rest: boolean;
  repository: { kind: 'enrolled'; id: string } | { kind: 'not_enrolled' };
  observed_command?: string;
  observed_file_path?: string;
  observed_url?: string;
  endpoint?: { hostname?: string; username?: string };
}

interface SecurityEnforcementV2Base {
  kind: 'enforcement';
  record_id: SecurityRecordId;
  rule_ids: string[];
  finding_record_ids: SecurityRecordId[];
  tool_name?: string;
  tool_call_id?: string;
  session_id?: string;
  source_agent: SecuritySourceAgent;
  timestamp: string;
}

export type SecurityEnforcementV2 = SecurityEnforcementV2Base & (
  | {
    decision: 'deny';
    mode: 'enforce';
    deny_rule_id: string;
    deny_rule_version: string;
  }
  | {
    decision: 'no_override';
    mode: 'monitor' | 'enforce';
    deny_rule_id?: never;
    deny_rule_version?: never;
  }
);

export interface SecurityIndicatorV2 {
  kind: 'indicator';
  record_id: SecurityRecordId;
  type: 'domain' | 'ipv4' | 'ipv6' | 'url' | 'email' | 'md5' | 'sha1' | 'sha256';
  value: string;
  count: number;
  first_seen: string;
  last_seen: string;
  source_agent: SecuritySourceAgent;
}

export interface SecurityScanSummaryV2 {
  kind: 'scan_summary';
  record_id: SecurityRecordId;
  status: 'complete' | 'partial' | 'error';
  artifacts_scanned: number;
  events_emitted: number;
  findings_emitted: number;
  indicators_emitted: number;
  diagnostics: number;
}

interface SecurityPermissionEventV2Base {
  kind: 'permission_event';
  record_id: SecurityRecordId;
  outcome: 'requested' | 'approved' | 'denied';
  tool_name?: string;
  source_agent: SecuritySourceAgent;
  timestamp: string;
}

export type SecurityPermissionEventV2 = SecurityPermissionEventV2Base & (
  | { join: 'exact'; tool_call_id: string; session_id?: string }
  | { join: 'same_session_window'; session_id: string; tool_call_id?: string }
  | { join: 'unavailable'; tool_call_id?: string; session_id?: string }
);

export type SecurityHealthStateV2 = 'ok' | 'failed' | 'unavailable';

export interface SecurityStatusV2 {
  kind: 'security_status';
  record_id: SecurityRecordId;
  observed_at: string;
  numbat_version: string;
  wired_agents: SecuritySourceAgent[];
  active_bundle_digest: Sha256Digest | null;
  lease_id: string | null;
  last_record_at: string | null;
  health: {
    hook_status: SecurityHealthStateV2;
    agent_effective_view: SecurityHealthStateV2;
    local_record: SecurityHealthStateV2;
    forwarder_ack: SecurityHealthStateV2;
  };
}

export interface SecurityAgentInventoryV2 {
  kind: 'agent_inventory';
  record_id: SecurityRecordId;
  observed_at: string;
  agents: Array<{
    agent: string;
    version: string | null;
    config: 'present' | 'absent' | 'unavailable';
    artifacts: 'present' | 'absent' | 'not_supported' | 'unavailable';
    wired: 'yes' | 'no' | 'not_supported' | 'unavailable';
  }>;
}

export type SecurityRecordV2 =
  | SecurityFindingV2
  | SecurityEnforcementV2
  | SecurityIndicatorV2
  | SecurityScanSummaryV2
  | SecurityPermissionEventV2
  | SecurityStatusV2
  | SecurityAgentInventoryV2;

export interface SecurityUploadV2 {
  schema_version: typeof SECURITY_V2_UPLOAD_SCHEMA;
  records: SecurityRecordV2[];
}

export interface SecurityDataSettingsV1 {
  schema_version: typeof SECURITY_DATA_SETTINGS_SCHEMA;
  command_previews: boolean;
  file_paths: boolean;
  urls: boolean;
  host_identity: boolean;
  user_identity: boolean;
}

export interface SecurityRuleBundleV1 {
  schema_version: typeof SECURITY_RULE_BUNDLE_SCHEMA;
  tenant_id: string;
  bundle_version: number;
  epoch: number;
  issued_at: string;
  numbat_pin: typeof SECURITY_V2_NUMBAT_PIN;
  compiler_version: string;
  agents: Partial<Record<Exclude<SecuritySourceAgent, 'unknown'>, {
    files: Array<{ path: string; sha256: Sha256Digest; content_b64: string }>;
    enabled_rule_ids: string[];
  }>>;
}

export interface SecurityActivationLeaseV2 {
  schema_version: typeof SECURITY_ACTIVATION_LEASE_SCHEMA;
  tenant_id: string;
  machine_id: string;
  lease_id: string;
  issued_at: string;
  expires_at: string;
  mode: 'off' | 'monitor' | 'monitor_and_pilot_block';
  agents: SecuritySourceAgent[];
  bundle_digest: Sha256Digest;
  data_settings: SecurityDataSettingsV1;
  day_one_scan: boolean;
}

export interface FleetConfigurationV3 {
  schemaVersion: 3;
  configurationId: string;
  epoch: number;
  issuedAt: string;
  validUntil: string | null;
  channel: 'latest' | 'next' | 'enterprise-latest' | 'enterprise-next';
  ring: string | null;
  repositoryPolicies: Array<{
    repositoryId: string;
    enrollmentId: string;
    grantId: string;
    branchPatterns: string[];
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>;
  securityLease: {
    leaseId: string;
    bundleDigest: Sha256Digest;
    expiresAt: string;
  };
  verification: { required: true; state: 'unavailable' };
  clientCompatibility: { minimumVersion: string; maximumVersion: string };
  desiredRelease: {
    version: string;
    releaseTag: string;
    manifestUrl: string;
    manifestSha256: Sha256Digest;
  };
}

export type SecurityAcknowledgementV1 = {
  schema_version: typeof SECURITY_ACKNOWLEDGEMENT_SCHEMA;
  lease_id: string;
  bundle_digest: Sha256Digest;
} & (
  | { result: 'applied'; refusal_code?: never }
  | { result: 'refused'; refusal_code: SecurityV2RefusalCode }
);

export type SecurityV2RecordOutcome = 'accepted' | 'duplicate' | 'rejected';

/** Whole-request validation failure (errors.md): a safe code, never a value. */
export class SecurityV2ValidationError extends Error {
  constructor(
    readonly code: 'SECURITY_V2_INVALID_BODY' | 'SECURITY_V2_UNKNOWN_FIELD' | 'SECURITY_V2_UNSUPPORTED_SCHEMA',
  ) {
    super(code);
    this.name = 'SecurityV2ValidationError';
  }
}

/** Per-record data-settings refusal (errors.md): the field names are safe metadata. */
export class SecurityV2FieldNotPermittedError extends Error {
  constructor(readonly fields: string[]) {
    super('SECURITY_V2_FIELD_NOT_PERMITTED');
    this.name = 'SecurityV2FieldNotPermittedError';
  }
}

/** One per-record entry of the upload result (api.md "POST"). */
export interface SecurityV2RecordResult {
  record_id: SecurityRecordId;
  result: SecurityV2RecordOutcome;
  /** Required only for `rejected`; forbidden for the other two results. */
  code?: SecurityV2ErrorCode;
}

export function validateSecurityUploadV2(_value: unknown): SecurityUploadV2 {
  throw new Error('not implemented (Task20d)');
}

export function checkDataSettings(
  _record: SecurityRecordV2,
  _settings: SecurityDataSettingsV1,
): void {
  throw new Error('not implemented (Task20d)');
}
