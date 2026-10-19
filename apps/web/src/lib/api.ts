import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Backend API Client
// ---------------------------------------------------------------------------
// All requests to the Cloud Run backend flow through this module.
//
// CRITICAL SECURITY PATTERN:
//   1. The user authenticates with Supabase Auth (handled by Auth UI).
//   2. Supabase issues a JWT (access token) to the browser.
//   3. This module reads that JWT from the active session.
//   4. Every API call includes the JWT as `Authorization: Bearer <token>`.
//   5. The backend verifies this JWT using the shared SUPABASE_JWT_SECRET.
//
// The frontend NEVER queries the database directly. All data access goes
// through the backend API, which enforces its own authorization logic.
// ---------------------------------------------------------------------------

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081';

/**
 * Retrieves the current Supabase access token from the active session.
 * Returns null if no session exists (user not logged in).
 */
async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * Type-safe fetch wrapper that automatically attaches the Supabase JWT
 * to every request to the backend API.
 */
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Not authenticated. Please log in.');
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // Attach the Supabase JWT as a Bearer token.
      // The backend middleware will verify this token's signature.
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => ({ error: 'Unknown error' })) as Record<string, unknown>;
    const message = typeof problem?.error === 'string'
      ? problem.error
      : `API error: ${response.status}`;
    throw new ApiProblemError(
      message,
      typeof problem?.code === 'string' ? problem.code : null,
      typeof problem?.request_id === 'string' ? problem.request_id : null,
      response.status,
    );
  }

  return response.json();
}

async function apiDownload(endpoint: string): Promise<Blob> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated. Please log in.');
  const response = await fetch(`${API_URL}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

export type AuditedValue<T> = {
  observedValue: T;
  auditedValue: T;
  corrected: boolean;
  correctionReason: string | null;
  evidenceRef: string | null;
};

export type Repository = { id: string; provider: string; externalId: string; name: string; url: string; normalizedUrl: string | null; createdAt: string };
export type PullRequest = { id: string; repositoryId: string; externalId: string; title: string; state: string; authorEmail: string | null; authorLogin: string | null; headRef: string | null; baseRef: string | null; headSha: string | null; mergeCommitSha: string | null; mergedAt: string | null; createdAt: string; updatedAt: string };
export type Contributor = { id: string; repositoryId: string; name: string; email: string | null; machineId: string | null };
export type TelemetryModel = { key: string; tool: string; model: string | null };
export type SessionListItem = {
  id: string; externalSessionId: string; gitAiSessionId: string | null; displayName: string | null;
  agent: string; models: AuditedValue<string[]>; status: string; startedAt: string | null; endedAt: string | null;
  repositories: Array<{ id: string; name: string; url: string }>;
  commitCount: number; retainedCommitCount: number; historicalCommitCount: number; finalAiLines: number;
  totalTokens: number | null; usageAvailability: string;
};
export type CommitListItem = {
  id: string; sha: string; subject: string; branch: string | null; repository: { id: string; name: string } | null;
  authorName: string | null; authorEmail: string | null; committedAt: string | null; diffAddedLines: number;
  diffDeletedLines: number; finalAiLines: AuditedValue<number>; finalHumanLines: AuditedValue<number>;
  unknownLines: number; sessionCount: number; reachability: string; operationKind: string;
};
export type DashboardSummary = { organizationName: string; repositories: number; pullRequests: number; contributors: number; sessions: number; commits: number; retainedCommits: number; historicalCommits: number; finalAiLines: number; finalHumanLines: number };
export type LifecycleValue = {
  value: number | null;
  observedValue?: number | null;
  availability: 'recorded' | 'partial' | 'unavailable';
  evidenceTypes: string[];
  reason?: string;
};
export type LifecycleSummary = {
  generated: LifecycleValue; committed: LifecycleValue; inPullRequests: LifecycleValue;
  merged: LifecycleValue; production: LifecycleValue; mergedProxy: LifecycleValue;
  reworked: LifecycleValue; churned: LifecycleValue; reworkByActor: Record<string, number>;
  ratios: { generatedToCommitted: number | null; generatedToPullRequest: number | null; generatedToMerged: number | null; generatedToProduction: number | null };
};
export type LifecycleResponse = {
  summary: LifecycleSummary;
  totals: { sessions: number; commits: number; finalAiLines: number; finalHumanLines: number };
  generationCoverage: { complete: boolean; requiredCommitCount: number; coveredCommitCount: number; missingCommitIds: string[] };
  scope: Record<string, unknown>;
  evidence: Record<string, number>;
};
export type EvidenceFlowNode = {
  id: string; sequence: number; timestamp: string;
  type: 'developer_prompt' | 'agent_thinking' | 'agent_response' | 'tool_call' | 'tool_result' | 'commit';
  model: string | null; content: string | null; toolName?: string;
  arguments?: unknown; result?: unknown;
  linkageQuality: 'exact' | 'time-window' | 'unresolved'; availabilityReason?: string;
};
export type EvidenceFlowResponse = {
  provider: string; status: 'recorded' | 'unavailable'; reason: string | null;
  developmentOnly?: boolean; correlation?: string; nodes: EvidenceFlowNode[];
};

export type EvidenceState = 'observed' | 'inferred' | 'corrected';
export type EvidenceAvailability = 'available' | 'unavailable' | 'redacted' | 'expired';
export type EvidenceGraphNode = {
  type: string; id: string; label: string; occurredAt?: string | null;
  evidenceState: EvidenceState; availability: EvidenceAvailability;
  data?: Record<string, unknown>;
};
export type EvidenceGraphEdge = {
  fromType: string; fromId: string; toType: string; toId: string;
  relationship: string; evidenceState: EvidenceState; confidence: number; basis: string;
};
export type EvidenceGraphResponse = {
  root: { type: string; id: string };
  nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[]; nextCursor: number | null;
};
export type EvidenceExplanation = {
  intention: { text: string | null; evidenceState: EvidenceState | null; confidence: number | null };
  outcome: string;
  friction: {
    toolCalls: number; toolResults: number; unavailableEvidence: number;
    failedTools: number; slowTools: number; reworkSignals: number;
  };
  learnings: string[]; openItems: string[]; graph: EvidenceGraphResponse;
};
export type EvidenceSearchResult = {
  id: string; sessionId: string | null; text: string;
  evidenceState: EvidenceState; confidence: number; availability: EvidenceAvailability; score: number;
  lexicalRank: number | null; vectorRank: number | null;
  lexicalScore: number | null; vectorScore: number | null;
  match: 'exact' | 'hybrid' | 'lexical' | 'semantic'; matchReasons: string[];
  model: string; modelRevision: string; commitIds: string[];
};

export type EvidenceSearchFilters = {
  limit?: number; repositoryId?: string; commitId?: string; sessionId?: string;
  tool?: string; model?: string; path?: string;
};

export type EvidenceSemanticHealth = {
  model: string; configuredRevision: string; dimensions: number;
  intentions: number; availableIntentions: number; indexes: number;
  jobs: { pending: number; processing: number; completed: number; failed: number; skipped: number };
};

export type EvidenceWorkKind = 'pull_request' | 'direct_commit' | 'unfinished_intention';
export type EvidenceOutcome = 'open' | 'merged' | 'deployed' | 'closed' | 'direct_change' | 'unfinished';
export type EvidenceCoverage = 'recorded' | 'partial' | 'unavailable';
export type EvidenceWorkCard = {
  kind: EvidenceWorkKind; id: string; title: string;
  repository: { id: string; name: string } | null; branch: string | null;
  outcome: EvidenceOutcome; updatedAt: string;
  intention: { text: string | null; count: number; state: EvidenceState | null };
  keyInsight: string;
  evidenceQuality: {
    attribution: EvidenceCoverage; intention: EvidenceCoverage;
    rawContent: EvidenceCoverage; lifecycle: EvidenceCoverage;
  };
  counts: { commits: number; reworkedLines: number; evidenceGaps: number };
};
export type EvidenceWorkspaceResponse = {
  insights: { outcomes: string; attention: number; evidenceGaps: number };
  pullRequests: { items: EvidenceWorkCard[]; nextCursor: number | null; total: number };
  directChanges: { items: EvidenceWorkCard[]; nextCursor: number | null; total: number };
  unfinishedWork: { items: EvidenceWorkCard[]; nextCursor: number | null; total: number };
};
export type EvidenceWorkStory = {
  root: { type: 'pull_request' | 'commit' | 'intention' | 'code'; id: string; title: string; repository: string | null; branch: string | null };
  summary: {
    why: { primary: string | null; additional: number; state: EvidenceState | null; confidence: number | null };
    outcome: { status: EvidenceOutcome; label: string };
    keyInsight: string;
    evidenceQuality: EvidenceWorkCard['evidenceQuality'];
  };
  intentions: Array<{ id: string; text: string; state: EvidenceState; confidence: number; lifecycle: string; sessionId: string | null }>;
  lifecycle: {
    pullRequest: null | { id: string; title: string; state: string; headRef: string | null; baseRef: string | null };
    merge: null | { sha: string; mergedAt: string | null };
    deployments: Array<{ id: string; environment: string; status: string; production: boolean; deployedAt: string }>;
  };
  changes: Array<{
    id: string; sha: string; subject: string; branch: string | null; historical: boolean;
    files: Array<{ id: string; path: string; aiLines: number; humanLines: number; unknownLines: number; ranges: Array<Record<string, unknown>> }>;
  }>;
  insights: {
    failedTools: number; retries: number; slowTools: number; promptLoops: number;
    reworkedLines: number; abandoned: boolean; evidenceGaps: number;
    tests: Array<{ eventId: string; label: string; status: 'passed' | 'failed' | 'unknown' }>;
    signals: Array<{
      eventId: string;
      kind: 'failed_tool' | 'retry' | 'slow_tool' | 'prompt_loop' | 'evidence_gap';
      label: string; toolName: string | null; status: string | null;
      durationMs: number | null; attempt: number | null; occurredAt: string;
      evidenceState: EvidenceState; availability: EvidenceAvailability;
    }>;
    unresolved: string[];
  };
  graph: EvidenceGraphResponse;
  similarWork: {
    status: 'available' | 'unavailable';
    items: Array<EvidenceWorkCard & { matchReasons: string[] }>;
  };
  focus: null | { commitId: string; path: string; line: number; attribution: 'exact' | 'missing'; traceIds: string[] };
};
export type EvidenceWorkspaceSearchResult = EvidenceWorkCard & { matchReasons: string[]; score: number };
export type EvidenceWorkspaceSearchFilters = {
  repositoryId?: string; branch?: string; from?: string; to?: string; agent?: string;
  model?: string; outcome?: string; resultType?: string; limit?: number;
};

export type AdminContext = {
  tenantId: string;
  subject: string;
  email: string | null;
  membership: null | {
    id: string;
    role: 'tenant_admin' | 'tenant_auditor';
    status: 'active' | 'revoked';
    revokedAt: string | null;
  };
};

export type AdminMachineResources = {
  machines: Array<{
    id: string; installationId: string; displayName: string; platform: string | null;
    status: 'active' | 'revoked'; lastSeenAt: string | null; revokedAt: string | null;
    createdAt: string; updatedAt: string;
  }>;
  credentials: Array<{
    id: string; machineId: string; keyId: string; status: 'active' | 'revoked';
    rotatedFromCredentialId: string | null; issuedAt: string; expiresAt: string | null;
    lastUsedAt: string | null; revokedAt: string | null;
  }>;
};

export type AdminRepositoryResources = {
  repositories: Repository[];
  enrollments: Array<{
    id: string; repositoryId: string; status: 'active' | 'revoked'; effectiveFrom: string;
    generationSessionEvidenceFrom: string; commitNoteEvidenceFrom: string;
    effectiveUntil: string | null; reason: string | null; createdAt: string; updatedAt: string;
  }>;
  grants: Array<{
    id: string; machineId: string; enrollmentId: string; branchPatterns: string[];
    status: 'active' | 'revoked'; effectiveFrom: string; effectiveUntil: string | null;
    reason: string | null; revokedAt: string | null; createdAt: string;
  }>;
};

export type AdminBackfillResources = { authorizations: Array<{
  id: string; enrollmentId: string; evidenceFamily: 'generation_session' | 'commit_note';
  occurredFrom: string; occurredUntil: string; expiresAt: string; status: 'active' | 'revoked';
  authorizedBy: string; reason: string; revokedAt: string | null; createdAt: string;
}> };

export type AdminGitHubResources = { installations: Array<{
  id: string; providerHost: string; appId: string; installationExternalId: string;
  accountLogin: string; permissions: Record<string, string>; subscribedEvents: string[];
  status: 'active' | 'revoked'; revokedAt: string | null; createdAt: string; updatedAt: string;
}> };

export type AdminSecurityFindingResources = { findings: Array<{
  id: string; machineId: string; repositoryId: string; findingId: string;
  ruleId: 'trackai.exec.destructive_recursive_delete' | 'trackai.exec.download_pipe_shell' | 'trackai.exec.reverse_shell';
  ruleVersion: string; ruleSeverity: 'high' | 'critical'; effect: 'monitor';
  phase: 'requested' | 'observed_result' | 'partial' | 'unavailable';
  operatingSystem: 'macos' | 'linux' | 'windows' | 'wsl' | 'unavailable';
  occurredAt: string; receivedAt: string;
}> };

export type AdminOperationsResources = {
  evaluatedAt: string;
  health: 'healthy' | 'attention' | 'critical';
  metrics: { normalized: number; pending: number; failed: number; delayedPending: number };
  providers: {
    received: number; projected: number; applied: number; duplicate: number; stale: number;
    conflict: number; unsequenced: number; failed: number; expiredWork: number;
    recentFailureCodes: Array<{ code: string; value: number }>;
  };
  exports: { planned: number; running: number; completed: number; failed: number };
  clients: {
    activeMachines: number; currentReports: number; staleReports: number; unreportedMachines: number;
    pendingRetryable: number; waitingRetry: number; processing: number;
    quarantined: number; rowsWithErrors: number;
    machines: Array<{
      machineId: string; displayName: string; platform: string | null;
      observedAt: string | null; receivedAt: string | null;
      pendingRetryable: number; waitingRetry: number; processing: number;
      quarantined: number; rowsWithErrors: number;
      oldestPendingAt: string | null; lastDeliveredAt: string | null;
      status: 'current' | 'stale' | 'unreported';
    }>;
  };
  retention: {
    policy: { id: string | null; version: number; mode: 'retain' | 'archive_then_purge'; retentionDays: number | null };
    cutoffAt: string | null;
    dueCounts: Record<string, number>;
    archivedCounts: Record<string, number>;
    blockedCounts: Record<string, number>;
    decision: 'retain' | 'archive_required' | 'archive_ready';
  };
  limitations: { clientQueue: string; rawEvidence: string };
};

export type AdminExportResources = { exports: Array<{
  id: string;
  format: string;
  status: 'planned' | 'running' | 'completed' | 'failed';
  archivePurpose: boolean;
  scopeFrom: string;
  scopeUntil: string;
  reason: string;
  recordCounts: Record<string, number>;
  contentSha256: string | null;
  failureCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}> };

export const getRepositories = () => apiFetch<Repository[]>('/api/repositories');
export const getPullRequests = () => apiFetch<PullRequest[]>('/api/pull-requests');
export const getContributors = () => apiFetch<Contributor[]>('/api/contributors');
export const getModels = () => apiFetch<TelemetryModel[]>('/api/telemetry/models');
export const getSessions = () => apiFetch<SessionListItem[]>('/api/telemetry/sessions');
export const getSession = (id: string) => apiFetch<Record<string, any>>(`/api/telemetry/sessions/${encodeURIComponent(id)}`);
export const getCommits = () => apiFetch<CommitListItem[]>('/api/telemetry/commits');
export const getCommit = (id: string) => apiFetch<Record<string, any>>(`/api/telemetry/commits/${encodeURIComponent(id)}`);
export const getCommitEvidenceFlow = (id: string) => apiFetch<EvidenceFlowResponse>(`/api/telemetry/commits/${encodeURIComponent(id)}/evidence-flow`);
export const getEvidenceExplanation = (commitId: string) => apiFetch<EvidenceExplanation>(
  `/api/evidence/commits/${encodeURIComponent(commitId)}/explain`,
);
export const getEvidenceWorkspace = (cursor = 0, limit = 20) => apiFetch<EvidenceWorkspaceResponse>(
  `/api/evidence/workspace?cursor=${cursor}&limit=${limit}`,
);
export const getEvidenceWorkStory = (kind: EvidenceWorkKind, id: string) => {
  const rootType = kind === 'pull_request' ? 'pull_request'
    : kind === 'direct_commit' ? 'commit' : 'intention';
  return apiFetch<EvidenceWorkStory>(
    `/api/evidence/stories/${rootType}/${encodeURIComponent(id)}`,
  );
};
export const getEvidenceLineWhy = (commitId: string, path: string, line: number) => {
  const parameters = new URLSearchParams({ path, line: String(line) });
  return apiFetch<EvidenceWorkStory>(
    `/api/evidence/commits/${encodeURIComponent(commitId)}/why?${parameters.toString()}`,
  );
};
export const getEvidenceStoryLineWhy = (
  kind: EvidenceWorkKind, id: string, commitId: string, path: string, line: number,
) => {
  const rootType = kind === 'pull_request' ? 'pull_request'
    : kind === 'direct_commit' ? 'commit' : 'intention';
  const parameters = new URLSearchParams({ commitId, path, line: String(line) });
  return apiFetch<EvidenceWorkStory>(
    `/api/evidence/stories/${rootType}/${encodeURIComponent(id)}?${parameters.toString()}`,
  );
};
export const searchEvidenceWorkspace = (query: string, filters: EvidenceWorkspaceSearchFilters = {}) => {
  const parameters = new URLSearchParams({ q: query });
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  });
  return apiFetch<{ query: string; results: EvidenceWorkspaceSearchResult[] }>(
    `/api/evidence/workspace-search?${parameters.toString()}`,
  );
};
export const searchEvidenceIntentions = (query: string, filters: EvidenceSearchFilters = {}) => {
  const parameters = new URLSearchParams({ q: query });
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  });
  return apiFetch<{ query: string; results: EvidenceSearchResult[] }>(
    `/api/evidence/search?${parameters.toString()}`,
  );
};
export const getEvidenceRaw = (eventId: string) => apiFetch<Record<string, unknown>>(
  `/api/evidence/events/${encodeURIComponent(eventId)}/raw`,
);
export const getEvidenceFriction = () => apiFetch<{ sessions: Array<Record<string, unknown>> }>(
  '/api/evidence/analytics/friction',
);
export const getEvidenceSettings = () => apiFetch<{
  rawCollectionEnabled: boolean; provider: 'opencode'; retentionDays: number;
  consentedAt: string | null; disabledAt: string | null;
}>('/api/admin/evidence/settings');
export const getEvidenceSemanticHealth = () => apiFetch<EvidenceSemanticHealth>(
  '/api/admin/evidence/semantic-health',
);
export const setEvidenceCollection = (rawCollectionEnabled: boolean) => apiFetch(
  '/api/admin/evidence/settings',
  { method: 'PUT', body: JSON.stringify({ rawCollectionEnabled }) },
);
export const getPullRequestIntelligence = (id: string) => apiFetch<Record<string, any>>(`/api/pull-requests/${encodeURIComponent(id)}/intelligence`);
export const getDashboardSummary = () => apiFetch<DashboardSummary>('/api/dashboard/summary');
export const getLifecycle = (query = '') => apiFetch<LifecycleResponse>(`/api/metrics/lifecycle${query}`);
export const getAdminContext = () => apiFetch<AdminContext>('/api/admin/context');
export const getAdminMachines = () => apiFetch<AdminMachineResources>('/api/admin/machines');
export const getAdminRepositoryPolicies = () => apiFetch<AdminRepositoryResources>('/api/admin/repository-policies');
export const getAdminBackfillAuthorizations = () => apiFetch<AdminBackfillResources>('/api/admin/backfill-authorizations');
export const getAdminGitHubInstallations = () => apiFetch<AdminGitHubResources>('/api/admin/github-app/installations');
export const getAdminSecurityFindings = (limit = 100) => (
  apiFetch<AdminSecurityFindingResources>(`/api/admin/security-findings?limit=${limit}`)
);
export const getAdminOperationalMonitoring = () => (
  apiFetch<AdminOperationsResources>('/api/admin/operations/monitoring')
);
export const getAdminEvidenceExports = () => (
  apiFetch<AdminExportResources>('/api/admin/operations/exports')
);
export async function downloadAdminEvidenceExport(exportJobId: string): Promise<void> {
  const blob = await apiDownload(
    `/api/admin/operations/exports/${encodeURIComponent(exportJobId)}/download`,
  );
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trackai-evidence-export-${exportJobId}.json`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class ApiProblemError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly requestId: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiProblemError';
  }
}

export type QaKind = 'live' | 'verifiable' | 'signed';
export type QaFamily = 'code' | 'security';
export type QaAuditorFlag = 'yes' | 'partly' | 'no';
export type QaScopeLevel = 'tenant' | 'repository' | 'pull_request' | 'commit';
export type QaBuilder = 'T19.3' | 'T19.4' | 'Task19d' | 'A16.13a' | 'A16.13b' | 'Task15i4' | 'Task15p';
export type QaDimension =
  | 'model' | 'tool' | 'repository' | 'agent_family' | 'operating_system'
  | 'rule' | 'rule_category' | 'severity' | 'machine' | 'team';
export type QaAvailability = 'recorded' | 'partial' | 'unavailable';
export type QaReasonCode =
  | 'not_captured_yet' | 'not_monitored' | 'vendor_does_not_report'
  | 'never_written' | 'partial_linkage' | 'answer_not_built' | 'phase_2' | 'data_setting_off' | 'zero_denominator';
export type QaGapId =
  | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7'
  | 'G8' | 'G9' | 'G10' | 'G11' | 'G12' | 'G13' | 'G14' | 'G15' | 'G16' | 'G17';
export type QaWordingCode =
  | 'monitor_only_observed' | 'unknown_model_explicit' | 'merged_not_deployed_proxy'
  | 'churned_unavailable' | 'session_link_partial' | 'requested_not_confirmed'
  | 'metadata_only';
export type QaQuestionId = `Q${number}` | `S${number}`;
export type QaDrilldownScope =
  | 'repository' | 'pull_request' | 'commit' | 'file' | 'session' | 'finding' | 'statement';
export type QaValue =
  | { type: 'count'; count: number }
  | { type: 'ratio'; numerator: number; denominator: number }
  | { type: 'duration_ms'; ms: number };

export type QaReason = { code: QaReasonCode; gap?: QaGapId };
export type QaBreakdownItem = { dimension: QaDimension; key: string; value: QaValue };
export type QaEvidence = {
  count: number;
  statements_root: string;
  records: Array<{ seq: number; digest: string }>;
};
export type QaFigure = {
  key: string;
  availability: QaAvailability;
  reasons: QaReason[];
  value: QaValue | null;
  breakdown?: QaBreakdownItem[];
  evidence?: QaEvidence;
};
export type QaScope = {
  repository_id?: string;
  pull_request_id?: string;
  commit_sha?: string;
  from: string;
  to: string;
};
export type QaDrilldownItem = { scope: QaDrilldownScope; id: string; label: string };
export type QaEnvelope = {
  question_id: QaQuestionId;
  registry_version: number;
  kind: QaKind;
  as_of: string;
  scope: QaScope;
  availability: QaAvailability;
  reasons: QaReason[];
  figures: QaFigure[];
  previous?: { from: string; to: string; figures: QaFigure[] };
  wording: QaWordingCode[];
  drilldown: QaDrilldownItem[];
  signed_evidence?: {
    path: '/api/attesta/statements';
    query: {
      repository_id?: string;
      kind?: string;
      subject_sha?: string;
      from: string;
      to: string;
    };
  };
  signed?: { statement_digest: string; predicate_type: string };
};
export type QaQuestionKind = {
  kind: QaKind;
  builder: QaBuilder | null;
  built: boolean;
  open_gaps: QaGapId[];
};
export type QaQuestion = {
  id: QaQuestionId;
  family: QaFamily;
  rank: number;
  phase: 1 | 2;
  title: string;
  auditor: QaAuditorFlag;
  kinds: Array<{ kind: QaKind; builder: QaBuilder | null }>;
  gaps: QaGapId[];
  scopes: QaScopeLevel[];
  dimensions: QaDimension[];
  compare_previous: boolean;
  wording: QaWordingCode[];
};
export type QaQuestionList = { registry_version: number; items: QaQuestion[] };
export type QaQuestionDetail = {
  registry_version: number;
  question: QaQuestion;
  answers: QaQuestionKind[];
};
export type QaDrilldownPage = { items: QaDrilldownItem[]; next_cursor: string | null };
export type QaAnswerQuery = {
  kind: QaKind;
  from: string;
  to: string;
  repository_id?: string;
  pull_request_id?: string;
  commit_sha?: string;
  breakdown?: QaDimension;
  limit?: number;
  cursor?: string;
};

export const getQaQuestions = () => apiFetch<QaQuestionList>('/api/qa/questions');
export const getQaQuestion = (id: QaQuestionId) => (
  apiFetch<QaQuestionDetail>(`/api/qa/questions/${encodeURIComponent(id)}`)
);

export function getQaAnswer(
  id: QaQuestionId,
  query: QaAnswerQuery,
  drilldown: true,
): Promise<QaDrilldownPage>;
export function getQaAnswer(
  id: QaQuestionId,
  query: QaAnswerQuery,
  drilldown?: false,
): Promise<QaEnvelope>;
export function getQaAnswer(
  id: QaQuestionId,
  query: QaAnswerQuery,
  drilldown = false,
): Promise<QaEnvelope | QaDrilldownPage> {
  const parameters = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && (drilldown || key !== 'breakdown')) {
      parameters.set(key, String(value));
    }
  });
  const suffix = drilldown ? '/drilldown' : '/answer';
  return apiFetch<QaEnvelope | QaDrilldownPage>(
    `/api/qa/questions/${encodeURIComponent(id)}${suffix}?${parameters.toString()}`,
  );
}

export const registerAdminMachine = (input: {
  installationId: string; displayName: string; platform?: string;
}) => apiFetch<{ machine: AdminMachineResources['machines'][number] }>('/api/admin/machines', {
  method: 'POST', body: JSON.stringify(input),
});

export const issueAdminMachineCredential = (
  machineId: string,
  rotatedFromCredentialId?: string,
) => apiFetch<{ credential: {
  id: string; machineId: string; keyId: string; plaintext: string;
  issuedAt: string; expiresAt: string | null;
} }>(`/api/admin/machines/${encodeURIComponent(machineId)}/credentials`, {
  method: 'POST',
  body: JSON.stringify({ rotatedFromCredentialId }),
});

export const revokeAdminMachineCredential = (credentialId: string, reason: string) => (
  apiFetch<{ ok: true }>(`/api/admin/machine-credentials/${encodeURIComponent(credentialId)}/revoke`, {
    method: 'POST', body: JSON.stringify({ reason }),
  })
);

export const revokeAdminMachine = (machineId: string, reason: string) => (
  apiFetch<{ ok: true }>(`/api/admin/machines/${encodeURIComponent(machineId)}/revoke`, {
    method: 'POST', body: JSON.stringify({ reason }),
  })
);

export const enrollAdminRepository = (repositoryId: string, reason: string) => (
  apiFetch<{ enrollment: AdminRepositoryResources['enrollments'][number] }>('/api/admin/repository-enrollments', {
    method: 'POST', body: JSON.stringify({ repositoryId, reason }),
  })
);

export const revokeAdminRepositoryEnrollment = (enrollmentId: string, reason: string) => (
  apiFetch<{ ok: true }>(`/api/admin/repository-enrollments/${encodeURIComponent(enrollmentId)}/revoke`, {
    method: 'POST', body: JSON.stringify({ reason }),
  })
);

export const grantAdminMachineRepository = (input: {
  machineId: string; enrollmentId: string; branchPatterns: string[]; reason: string;
}) => apiFetch<{ grant: AdminRepositoryResources['grants'][number] }>('/api/admin/repository-grants', {
  method: 'POST', body: JSON.stringify(input),
});

export const revokeAdminMachineRepositoryGrant = (grantId: string, reason: string) => (
  apiFetch<{ ok: true }>(`/api/admin/repository-grants/${encodeURIComponent(grantId)}/revoke`, {
    method: 'POST', body: JSON.stringify({ reason }),
  })
);

export const replaceAdminMachineRepositoryGrantBranchScope = (
  grantId: string,
  branchPatterns: string[],
  reason: string,
) => apiFetch<{ grant: AdminRepositoryResources['grants'][number] }>(
  `/api/admin/repository-grants/${encodeURIComponent(grantId)}/branch-scope`,
  { method: 'POST', body: JSON.stringify({ branchPatterns, reason }) },
);

export const authorizeAdminRepositoryBackfill = (input: {
  enrollmentId: string;
  evidenceFamily: 'generation_session' | 'commit_note';
  occurredFrom: string;
  occurredUntil: string;
  expiresAt: string;
  reason: string;
}) => apiFetch<{ authorization: AdminBackfillResources['authorizations'][number] }>(
  '/api/admin/backfill-authorizations',
  { method: 'POST', body: JSON.stringify(input) },
);

export const revokeAdminRepositoryBackfill = (authorizationId: string, reason: string) => (
  apiFetch<{ ok: true }>(
    `/api/admin/backfill-authorizations/${encodeURIComponent(authorizationId)}/revoke`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  )
);

// ---------------------------------------------------------------------------
// Fleet administration (Task9e client of the frozen Task9a API)
// ---------------------------------------------------------------------------
// Exact bindings for the five existing administrator routes behind the
// `machine.manage` boundary. No route shape is invented here; the server
// remains authoritative and browser state never substitutes for it.

export type FleetMachineState =
  | 'current' | 'stale' | 'unreported' | 'unavailable' | 'mismatch' | 'revoked';

export type FleetChannel = 'latest' | 'next' | 'enterprise-latest' | 'enterprise-next';
export type FleetPlatform = 'macos' | 'windows';
export type FleetArchitecture = 'x86_64' | 'aarch64';
export type FleetServiceState = 'running' | 'stopped' | 'degraded' | 'unavailable';
export type FleetReportResult =
  | 'applied' | 'rejected_invalid' | 'rejected_expired' | 'rejected_incompatible'
  | 'verification_unavailable' | 'verification_rejected' | 'activation_failed' | 'unavailable';
export type FleetAssignmentSource = 'jamf' | 'intune' | 'manual' | 'unavailable';

export type FleetMachineQueue = {
  pendingRetryable: number;
  waitingRetry: number;
  processing: number;
  quarantined: number;
  rowsWithErrors: number;
};

export type FleetMachine = {
  id: string;
  installationId: string;
  displayName: string;
  status: FleetMachineState;
  machineStatus: 'active' | 'revoked';
  desiredConfiguration: {
    id: string;
    epoch: number;
    targetClientVersion: string;
    channel: FleetChannel;
    ring: string | null;
  } | null;
  observed: {
    acknowledgedConfigurationId: string | null;
    acknowledgedEpoch: number | null;
    resultCode: FleetReportResult | null;
    platform: FleetPlatform | null;
    osVersion: string | null;
    architecture: FleetArchitecture | null;
    gitaiVersion: string | null;
    serviceState: FleetServiceState | null;
    queue: FleetMachineQueue | null;
    mdmDeviceReference: string | null;
    mdmUserReference: string | null;
    assignmentEvidence: { source: FleetAssignmentSource; observedAt: string } | null;
    lastReportAt: string | null;
  } | null;
  reconciliation: 'unavailable';
  deliveryHealth:
    | {
        status: 'current' | 'stale' | 'unreported';
        observedAt: string | null;
        receivedAt: string | null;
        pendingRetryable: number;
        waitingRetry: number;
        processing: number;
        quarantined: number;
        rowsWithErrors: number;
      }
    | { status: 'unavailable' };
};

export type FleetConfiguration = {
  id: string;
  epoch: number;
  schemaVersion: 1;
  generatedAt: string;
  validUntil: string | null;
  targetClientVersion: string;
  channel: FleetChannel;
  ring: string | null;
};

export type FleetOffboardPreview = {
  machine: { id: string; installationId: string; displayName: string; status: 'active' | 'revoked' };
  activeCredentialCount: number;
  activeGrantCount: number;
  desiredConfigurationId: string | null;
  localCleanup: 'best_effort_not_requested_by_server';
};

export type FleetOffboardResult = {
  serverRevocation: 'applied';
  localCleanup: 'best_effort_not_requested_by_server';
  mdmCleanup: 'not_requested';
};

export const getFleetMachines = () => apiFetch<{ machines: FleetMachine[] }>(
  '/api/admin/fleet/machines',
);

export const createFleetConfiguration = (input: {
  targetClientVersion: string;
  channel: FleetChannel;
  ring: string | null;
  validUntil: string | null;
  reason: string;
}) => apiFetch<{ configuration: FleetConfiguration }>(
  '/api/admin/fleet/configurations',
  { method: 'POST', body: JSON.stringify(input) },
);

export const assignFleetConfiguration = (input: {
  configurationId: string;
  machineIds: string[];
  reason: string;
}) => apiFetch<{ ok: true }>(
  '/api/admin/fleet/assignments',
  { method: 'POST', body: JSON.stringify(input) },
);

export const previewFleetOffboard = (machineId: string) => apiFetch<FleetOffboardPreview>(
  `/api/admin/fleet/machines/${encodeURIComponent(machineId)}/offboard/preview`,
  { method: 'POST', body: JSON.stringify({}) },
);

export const applyFleetOffboard = (machineId: string, reason: string) => (
  apiFetch<FleetOffboardResult>(
    `/api/admin/fleet/machines/${encodeURIComponent(machineId)}/offboard`,
    { method: 'POST', body: JSON.stringify({ apply: true, reason }) },
  )
);

// ---------------------------------------------------------------------------
// Attesta (Task15k client of the frozen Task15i/Task15i2 API)
// ---------------------------------------------------------------------------
// Read-only attestation status plus the signed evidence-pack export behind
// the `attesta.read` / `attesta.export` boundaries. Error wording shown in
// the console comes from the RFC 7807 problem (`code`, `title`,
// `request_id`); the response body text is never surfaced otherwise.

export class AttestaApiError extends Error {
  code: string;
  status: number;
  requestId: string | null;

  constructor(message: string, code: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'AttestaApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

type AttestaProblem = {
  code?: unknown;
  title?: unknown;
  status?: unknown;
  request_id?: unknown;
};

async function attestaFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Not authenticated. Please log in.');
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => null) as AttestaProblem | null;
    const code = typeof problem?.code === 'string' && problem.code
      ? problem.code
      : 'ATTESTA_API_INTERNAL';
    const title = typeof problem?.title === 'string' && problem.title
      ? problem.title
      : code;
    const requestId = typeof problem?.request_id === 'string' && problem.request_id
      ? problem.request_id
      : response.headers.get('X-Request-ID');
    throw new AttestaApiError(title, code, response.status, requestId);
  }

  return response.json();
}

export type AttestaAnchorStatus = 'anchored' | 'pending' | 'missing';

export type AttestaStatement = {
  statement_digest: string;
  seq: number;
  recorded_at: string;
  statement_kind: string;
  predicate_type: string;
  repository_id: string;
  subject_sha: string;
  anchor_status: AttestaAnchorStatus;
  previous?: string[];
};

export type AttestaVerifyBreak = {
  seq: number;
  kind: string;
  detail_code: string;
};

export type AttestaVerifyReport = {
  report_version: number;
  ok: boolean;
  chain_intact: boolean;
  checked: number;
  breaks: AttestaVerifyBreak[];
  signatures: unknown;
  anchors: {
    status: 'checked' | 'not_checked';
    anchored?: number;
    pending?: number;
    missing?: number;
    invalid?: number;
    not_checkable?: number;
  };
  warnings?: unknown;
};

export type AttestaPackJob = {
  id: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  scope: { repository_id?: string | null; from: string; to: string };
  mode: string;
  counts?: { statements: number; anchored: number; pending: number } & Record<string, number>;
  pack_digest?: string;
  bytes?: number;
  error_code?: string;
  retryable?: boolean;
  created_at: string;
  finished_at?: string;
  content_path?: string;
};

export const getAttestaSubject = (repositoryId: string, sha: string) => attestaFetch<{ statements: AttestaStatement[] }>(
  `/api/attesta/subjects/${encodeURIComponent(repositoryId)}/${encodeURIComponent(sha)}`,
);

export const verifyAttestaChain = (range: { fromSeq?: number; toSeq?: number } = {}) => {
  const parameters = new URLSearchParams();
  if (range.fromSeq !== undefined) parameters.set('from_seq', String(range.fromSeq));
  if (range.toSeq !== undefined) parameters.set('to_seq', String(range.toSeq));
  const query = parameters.toString();
  return attestaFetch<AttestaVerifyReport>(`/api/attesta/verify${query ? `?${query}` : ''}`);
};

export const requestEvidencePack = (
  body: { repository_id?: string; from: string; to: string; mode?: string },
  idempotencyKey: string,
) => attestaFetch<{ id: string; status: AttestaPackJob['status']; replayed: boolean }>(
  '/api/attesta/evidence-packs',
  {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  },
);

export const getEvidencePack = (id: string) => attestaFetch<AttestaPackJob>(
  `/api/attesta/evidence-packs/${encodeURIComponent(id)}`,
);

export const downloadEvidencePack = (contentPath: string): Promise<Blob> => apiDownload(contentPath);

// ---------------------------------------------------------------------------
// Audit (Task16f console client of the Task16c read API)
// ---------------------------------------------------------------------------
// Read-only trail search behind the `audit.read` boundary (admins and
// auditors). Every list request writes one `audit.events.read` row, so the
// console sends a request only on Search and on Load more, never per
// keystroke. Error wording comes from the RFC 7807 problem (`code`,
// `title`, `request_id`); the response body text is never surfaced otherwise.

export class AuditApiError extends Error {
  code: string;
  status: number;
  requestId: string | null;

  constructor(message: string, code: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'AuditApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

type AuditProblem = {
  code?: unknown;
  title?: unknown;
  status?: unknown;
  request_id?: unknown;
};

async function auditFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Not authenticated. Please log in.');
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => null) as AuditProblem | null;
    const code = typeof problem?.code === 'string' && problem.code
      ? problem.code
      : 'AUDIT_API_UNAVAILABLE';
    const title = typeof problem?.title === 'string' && problem.title
      ? problem.title
      : code;
    const requestId = typeof problem?.request_id === 'string' && problem.request_id
      ? problem.request_id
      : response.headers.get('X-Request-ID');
    throw new AuditApiError(title, code, response.status, requestId);
  }

  return response.json();
}

/** One audit row as docs/contracts/audit/event-v1.schema.json describes it. */
export type AuditEvent = {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  occurred_at: string;
  severity: 'high' | 'notice' | 'info';
  catalog_version: number;
};

export type AuditCatalogAction = {
  action: string;
  owner: string;
  severity: 'high' | 'notice' | 'info';
  status: 'emitted' | 'reserved';
  actor_types: string[];
  target_type: string;
};

export type AuditCatalog = {
  catalog_version: number;
  actions: AuditCatalogAction[];
};

export type AuditEventPage = {
  events: AuditEvent[];
  next_cursor: string | null;
  catalog_version: number;
};

export type AuditFilters = {
  actions: string[];
  excludeActions: string[];
  severity?: 'high' | 'notice' | 'info';
  actorType?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
};

export const getAuditCatalog = () => auditFetch<AuditCatalog>('/api/audit/catalog');

export const listAuditEvents = (filters: AuditFilters, cursor?: string) => {
  const parameters = new URLSearchParams();
  for (const action of filters.actions) {
    if (action !== '') parameters.append('action', action);
  }
  for (const action of filters.excludeActions) {
    if (action !== '') parameters.append('exclude_action', action);
  }
  if (filters.severity) parameters.set('severity', filters.severity);
  if (filters.actorType) parameters.set('actor_type', filters.actorType);
  if (filters.actorId) parameters.set('actor_id', filters.actorId);
  if (filters.targetType) parameters.set('target_type', filters.targetType);
  if (filters.targetId) parameters.set('target_id', filters.targetId);
  if (filters.from) parameters.set('from', filters.from);
  if (filters.to) parameters.set('to', filters.to);
  if (cursor) parameters.set('cursor', cursor);
  const query = parameters.toString();
  return auditFetch<AuditEventPage>(`/api/audit/events${query ? `?${query}` : ''}`);
};

export type AuditVerifyBreak = {
  kind: 'missing_row' | 'changed_row' | 'unsealed_row_in_sealed_window' | 'broken_previous' | 'statement_problem';
  seal: string | null;
  row_id?: string;
};

export type AuditVerifyReport = {
  ok: boolean;
  from: string;
  to: string;
  seals_checked: number;
  breaks: AuditVerifyBreak[];
  breaks_truncated: boolean;
  unsealed_tail: { from: string | null; count: number };
  chain: { ok: boolean; checked: number };
};

export const verifyAuditTrail = (range: { from: string; to: string }) => {
  const parameters = new URLSearchParams({ from: range.from, to: range.to });
  return auditFetch<AuditVerifyReport>(`/api/audit/verify?${parameters.toString()}`);
};

export type AuditExportJob = {
  id: string;
  status: 'queued' | 'running' | 'ready' | 'failed';
  scope: { from: string; to: string };
  counts: { events: number; seals: number; sealed_events: number; unsealed_events: number; anchored: number; pending: number } | null;
  export_digest: string | null;
  bytes: number | null;
  error_code: string | null;
  retryable: boolean | null;
  created_at: string;
  finished_at: string | null;
  content_path: string | null;
};

export const requestAuditExport = (
  body: { from: string; to: string },
  idempotencyKey: string,
) => auditFetch<{ id: string; status: AuditExportJob['status']; replayed: boolean }>(
  '/api/audit/exports',
  {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  },
);

export const getAuditExport = (id: string) => auditFetch<AuditExportJob>(
  `/api/audit/exports/${encodeURIComponent(id)}`,
);

export const downloadAuditExport = (contentPath: string): Promise<Blob> => apiDownload(contentPath);

// ---------------------------------------------------------------------------
// Security (Task20i-b console client)
// ---------------------------------------------------------------------------

export type SecurityFindingGeneration = 'task6a' | 'v2';

export type SecurityFindingItem = {
  id: string;
  generation: SecurityFindingGeneration;
  rule_id: string;
  rule_version: string;
  rule_severity: string;
  rule_category: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  repository_id: string | null;
  repository_kind: string | null;
  machine_id: string;
  session_id: string | null;
  occurred_at: string;
  received_at: string;
  rule_pack_version: string;
  bundle_digest: string | null;
  lease_id: string | null;
  found_at_rest: boolean | null;
  phase: string | null;
  result_category: string | null;
};

export type SecurityFindingPage = {
  items: SecurityFindingItem[];
  next_cursor: string | null;
};

export type SecurityFindingDetail = {
  finding: SecurityFindingItem;
  machine_indicators_nearby: Array<{ type: string; value: string | null; count: number }>;
  nearby_enforcement: Array<{
    id: string;
    decision: string;
    mode: string;
    occurred_at: string;
    tool_name: string | null;
    session_id: string | null;
  }>;
};

export type SecurityCoverageRow = {
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
  acknowledgement: {
    result: string;
    refusal_code: string | null;
    received_at: string;
  } | 'not_acknowledged';
};

export type SecurityCoveragePage = {
  rows: SecurityCoverageRow[];
  next_cursor: string | null;
};

export type SecurityFindingsQuery = {
  from?: string;
  to?: string;
  severity?: string;
  category?: string;
  rule_id?: string;
  agent?: string;
  machine_id?: string;
  repository_id?: string;
  generation?: SecurityFindingGeneration;
  cursor?: string;
  limit?: number;
};

export type SecuritySettingsView = {
  schema_version: 'trackai.security-settings-view/1';
  numbat_commit: string;
  rule_settings_version: number;
  rules: Array<{
    id: string;
    group: string;
    enabled: boolean;
    severity: string;
    upstream: { enabled: boolean; severity: string; version: string };
  }>;
  data_settings_version: number;
  data_settings: {
    schema_version: 'trackai.security-data-settings/1';
    command_previews: boolean;
    file_paths: boolean;
    urls: boolean;
    host_identity: boolean;
    user_identity: boolean;
  };
  agents: string[];
  day_one_scan: boolean;
  monitor: { mode: 'off' | 'monitor'; version: number };
  bundle: {
    bundle_version: number;
    epoch: number;
    digest: string;
    issued_at: string;
    enabled_rule_count: number;
  } | null;
};

export type SecuritySettingsChange = {
  dry_run: boolean;
  reason: string;
  monitor_mode?: 'off' | 'monitor';
  rules?: Record<string, { enabled?: boolean; severity?: string }>;
  data_settings?: Partial<Pick<SecuritySettingsView['data_settings'],
    'command_previews' | 'file_paths' | 'urls' | 'host_identity' | 'user_identity'>>;
  agents?: string[];
  day_one_scan?: boolean;
};

export type SecuritySettingsPlan = {
  schema_version: 'trackai.security-settings-plan/1';
  dry_run: true;
  rule_changes: Array<{
    id: string;
    from: { enabled: boolean; severity: string };
    to: { enabled: boolean; severity: string };
  }>;
  data_settings_changed: boolean;
  monitor: { from: 'off' | 'monitor'; to: 'off' | 'monitor' };
  publishes_bundle: boolean;
  exceeds_signer_limit: boolean;
  next: {
    rule_settings_version: number;
    data_settings_version: number;
    monitor_version: number;
    bundle_version: number | null;
    epoch: number | null;
  };
  active_machine_count: number;
};

export type SecuritySettingsApplied = {
  schema_version: 'trackai.security-settings-applied/1';
  dry_run: false;
  changed: boolean;
  rule_settings_version: number;
  data_settings_version: number;
  monitor_version: number;
  bundle: {
    bundle_version: number;
    epoch: number;
    digest: string;
    issued_at: string;
  } | null;
};

export const getSecurityFindings = (query: SecurityFindingsQuery = {}) => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') parameters.set(key, String(value));
  }
  const suffix = parameters.size ? `?${parameters.toString()}` : '';
  return apiFetch<SecurityFindingPage>(`/api/admin/security/v2/findings${suffix}`);
};

export const getSecurityFinding = (id: string) => (
  apiFetch<SecurityFindingDetail>(`/api/admin/security/v2/findings/${encodeURIComponent(id)}`)
);

export const getSecurityCoverage = (cursor?: string) => {
  const parameters = new URLSearchParams();
  if (cursor) parameters.set('cursor', cursor);
  const suffix = parameters.size ? `?${parameters.toString()}` : '';
  return apiFetch<SecurityCoveragePage>(`/api/admin/security/v2/coverage${suffix}`);
};

export const getSecuritySettings = () => (
  apiFetch<SecuritySettingsView>('/api/admin/security/settings')
);

export const putSecuritySettings = (change: SecuritySettingsChange) => (
  apiFetch<SecuritySettingsPlan | SecuritySettingsApplied>('/api/admin/security/settings', {
    method: 'PUT',
    body: JSON.stringify(change),
  })
);
