export const ADMIN_ACTIONS = [
  'machine.manage',
  'repository.manage',
  'backfill.manage',
  'github_app.manage',
  'audit.read',
] as const;

export type AdminAction = typeof ADMIN_ACTIONS[number];

export interface AdminMembershipRecord {
  tenantId: string;
  subject: string;
  role: 'tenant_admin' | 'tenant_auditor';
  status: 'active' | 'revoked';
  revokedAt: Date | null;
}

export interface AdminDecisionInput {
  tenantId: string;
  subject: string;
  action: AdminAction;
}

/**
 * Task4's bounded administration decision contract.
 *
 * The relational membership is authoritative today. Task6 can place a
 * Cedar-like evaluator behind this same action/principal/resource boundary
 * without changing callers or treating the client JSON cache as authority.
 */
export function adminMembershipAllows(
  membership: AdminMembershipRecord | null,
  input: AdminDecisionInput,
): boolean {
  if (
    !membership
    || membership.status !== 'active'
    || membership.revokedAt !== null
    || membership.tenantId !== input.tenantId
    || membership.subject !== input.subject
  ) {
    return false;
  }

  if (membership.role === 'tenant_admin') return true;
  return membership.role === 'tenant_auditor' && input.action === 'audit.read';
}
