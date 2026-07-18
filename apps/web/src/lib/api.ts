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
