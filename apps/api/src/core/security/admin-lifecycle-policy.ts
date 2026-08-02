export interface ActiveCredentialRotationState {
  id: string;
  rotatedFromCredentialId: string | null;
}

export function validateMachineCredentialIssuance(
  activeCredentials: readonly ActiveCredentialRotationState[],
  rotatedFromCredentialId?: string,
): 'initial' | 'rotation' {
  if (!rotatedFromCredentialId) {
    if (activeCredentials.length > 0) {
      throw new Error('This machine already has an active credential; stage rotation instead');
    }
    return 'initial';
  }

  const previous = activeCredentials.find(row => row.id === rotatedFromCredentialId);
  if (!previous) throw new Error('Active credential to rotate was not found');
  if (activeCredentials.length > 1
    || activeCredentials.some(row => row.rotatedFromCredentialId === previous.id)) {
    throw new Error('This machine already has an active credential rotation overlap');
  }
  return 'rotation';
}

export interface GitHubCredentialRotationState {
  status: 'active' | 'retiring';
  credentialFingerprint: string;
}

export function planGitHubCredentialRotation(
  credentials: readonly GitHubCredentialRotationState[],
  replacementFingerprint: string,
): 'pending' | 'staged' | 'complete' {
  const active = credentials.filter(row => row.status === 'active');
  const retiring = credentials.filter(row => row.status === 'retiring');
  if (active.length === 1 && retiring.length === 0) {
    return active[0].credentialFingerprint === replacementFingerprint
      ? 'complete'
      : 'pending';
  }
  if (active.length === 1 && retiring.length === 1
    && active[0].credentialFingerprint === replacementFingerprint) {
    return 'staged';
  }
  throw new Error('GitHub App installation has an unsafe credential rotation state');
}

export const MAX_BACKFILL_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
export const MAX_BACKFILL_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface BackfillAuthorizationWindow {
  occurredFrom: Date;
  occurredUntil: Date;
  expiresAt: Date;
  watermark: Date;
  reason: string;
  now: Date;
}

export function validateBackfillAuthorizationWindow(input: BackfillAuthorizationWindow): string {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Backfill authorization reason is required');
  if (input.occurredUntil.getTime() < input.occurredFrom.getTime()) {
    throw new Error('Backfill occurredUntil must not precede occurredFrom');
  }
  if (input.occurredUntil.getTime() - input.occurredFrom.getTime() > MAX_BACKFILL_WINDOW_MS) {
    throw new Error('Backfill window cannot exceed 31 days');
  }
  if (input.expiresAt.getTime() <= input.now.getTime()
    || input.expiresAt.getTime() - input.now.getTime() > MAX_BACKFILL_AUTHORIZATION_TTL_MS) {
    throw new Error('Backfill authorization must expire within 24 hours');
  }
  if (input.occurredUntil.getTime() >= input.watermark.getTime()) {
    throw new Error('Backfill window must end before its enrollment watermark');
  }
  return reason;
}
