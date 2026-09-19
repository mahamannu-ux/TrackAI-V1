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
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
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

export type EvidencePerspective = 'leader' | 'developer' | 'security';
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
    unresolved: string[];
  };
  graph: EvidenceGraphResponse;
  similarWork: { status: 'available' | 'unavailable'; items: EvidenceWorkCard[] };
  focus: null | { path: string; line: number; attribution: 'exact' | 'missing'; traceIds: string[] };
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

export type AdminAuditResources = { events: Array<{
  id: string; actorType: string; actorId: string; action: string; targetType: string;
  targetId: string; details: Record<string, unknown>; occurredAt: string;
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
export const getAdminAudit = (limit = 100) => apiFetch<AdminAuditResources>(`/api/admin/audit?limit=${limit}`);
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
