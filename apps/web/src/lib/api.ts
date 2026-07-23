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

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

export interface Item {
  id: string;
  name: string;
  created_at: string;
}

/** Fetch all items from the backend */
export async function getItems(): Promise<Item[]> {
  return apiFetch<Item[]>('/api/items');
}

/** Create a new item via the backend */
export async function createItem(name: string): Promise<Item> {
  return apiFetch<Item>('/api/items', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export type AuditedValue<T> = {
  observedValue: T;
  auditedValue: T;
  corrected: boolean;
  correctionReason: string | null;
  evidenceRef: string | null;
};

export type Repository = { id: string; provider: string; externalId: string; name: string; url: string; normalizedUrl: string | null; createdAt: string };
export type PullRequest = { id: string; repositoryId: string; externalId: string; title: string; state: string; authorEmail: string; headRef: string | null; baseRef: string | null; headSha: string | null; mergeCommitSha: string | null; createdAt: string; updatedAt: string };
export type Contributor = { id: string; repositoryId: string; name: string; email: string; machineId: string | null };
export type SessionListItem = {
  id: string; externalSessionId: string; gitAiSessionId: string | null; displayName: string | null;
  agent: string; models: AuditedValue<string[]>; status: string; startedAt: string | null; endedAt: string | null;
  repositories: Array<{ id: string; name: string; url: string }>; commitCount: number; finalAiLines: number;
  totalTokens: number | null; usageAvailability: string;
};
export type CommitListItem = {
  id: string; sha: string; subject: string; branch: string | null; repository: { id: string; name: string } | null;
  authorName: string | null; authorEmail: string | null; committedAt: string | null; diffAddedLines: number;
  diffDeletedLines: number; finalAiLines: AuditedValue<number>; finalHumanLines: AuditedValue<number>;
  unknownLines: number; sessionCount: number;
};
export type DashboardSummary = { organizationName: string; repositories: number; pullRequests: number; contributors: number; sessions: number; commits: number; finalAiLines: number; finalHumanLines: number };

export const getRepositories = () => apiFetch<Repository[]>('/api/repositories');
export const getPullRequests = () => apiFetch<PullRequest[]>('/api/pull-requests');
export const getContributors = () => apiFetch<Contributor[]>('/api/contributors');
export const getSessions = () => apiFetch<SessionListItem[]>('/api/telemetry/sessions');
export const getSession = (id: string) => apiFetch<Record<string, any>>(`/api/telemetry/sessions/${encodeURIComponent(id)}`);
export const getCommits = () => apiFetch<CommitListItem[]>('/api/telemetry/commits');
export const getCommit = (id: string) => apiFetch<Record<string, any>>(`/api/telemetry/commits/${encodeURIComponent(id)}`);
export const getPullRequestIntelligence = (id: string) => apiFetch<Record<string, any>>(`/api/pull-requests/${encodeURIComponent(id)}/intelligence`);
export const getDashboardSummary = () => apiFetch<DashboardSummary>('/api/dashboard/summary');
