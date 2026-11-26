/**
 * Task19i: the four synthetic users and two synthetic tenants of the T19.9 walkthrough
 * (IT-T19i-01). Shared by the seed (task19i-walkthrough-seed.ts), the local sign-in stub
 * (task19i-walkthrough-auth.ts) and the Playwright spec (apps/web/e2e/).
 *
 * Everything here is synthetic: `.invalid` domains (RFC 2606) that can never receive
 * mail, and throwaway passwords accepted only by the local stub, which refuses to run
 * outside an ephemeral database. None of these is a credential for any real service.
 */
export interface WalkthroughUser {
  /** The JWT subject; also the tenant_admin_memberships subject. */
  subject: string;
  email: string;
  /** Accepted only by the local stub (never a real password). */
  password: string;
  company: 'a' | 'b';
  role: 'tenant_admin' | 'tenant_auditor';
}

export interface WalkthroughCompany {
  label: 'a' | 'b';
  name: string;
  domain: string;
  /** The GitHub organization login webhooks are routed by (sso_tenants.scm_org_identifier). */
  githubOrg: string;
}

export const WALKTHROUGH_COMPANIES: Record<'a' | 'b', WalkthroughCompany> = {
  a: { label: 'a', name: 'Walkthrough Company A', domain: 'company-a.task19i.invalid', githubOrg: 'task19i-company-a' },
  b: { label: 'b', name: 'Walkthrough Company B', domain: 'company-b.task19i.invalid', githubOrg: 'task19i-company-b' },
};

const user = (company: 'a' | 'b', role: 'tenant_admin' | 'tenant_auditor'): WalkthroughUser => {
  const who = role === 'tenant_admin' ? 'admin' : 'auditor';
  return {
    subject: `task19i-${who}-${company}`,
    email: `${who}@${WALKTHROUGH_COMPANIES[company].domain}`,
    password: `task19i-${who}-${company}-local-only`,
    company,
    role,
  };
};

export const WALKTHROUGH_USERS = {
  adminA: user('a', 'tenant_admin'),
  auditorA: user('a', 'tenant_auditor'),
  adminB: user('b', 'tenant_admin'),
  auditorB: user('b', 'tenant_auditor'),
} as const;

export type WalkthroughUserKey = keyof typeof WALKTHROUGH_USERS;

/** Refuses anything but a local throwaway database (AGENTS.md §9 item 5). */
export function assertEphemeralDatabase(what: string): void {
  if (process.env.NODE_ENV === 'production' || process.env.TASK5_EPHEMERAL_DATABASE !== '1'
    || process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error(`${what} may run only outside production with an ephemeral database (run through scripts/it-db.sh)`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`${what}: DATABASE_URL is required`);
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error(`${what}: a local disposable database is required`);
  }
}
