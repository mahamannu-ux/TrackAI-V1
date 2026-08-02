import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import { ssoTenants } from '../../core/db/schema';
import {
  grantAdminMembership,
  lookupAdminMembership,
} from '../../core/security/admin-security-service';

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUPABASE_SUBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const domain = required('TASK4_ADMIN_BOOTSTRAP_TENANT_DOMAIN').toLowerCase();
  const subject = required('TASK4_ADMIN_BOOTSTRAP_SUBJECT');
  const role = required('TASK4_ADMIN_BOOTSTRAP_ROLE');
  const email = process.env.TASK4_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const apply = process.env.TASK4_ADMIN_BOOTSTRAP_APPLY === '1';

  if (!DOMAIN_PATTERN.test(domain)) throw new Error('Bootstrap tenant domain is invalid');
  if (!SUPABASE_SUBJECT_PATTERN.test(subject)) {
    throw new Error('Bootstrap JWT subject must be the complete Supabase user UUID');
  }
  if (role !== 'tenant_admin' && role !== 'tenant_auditor') {
    throw new Error('TASK4_ADMIN_BOOTSTRAP_ROLE must be tenant_admin or tenant_auditor');
  }
  if (email) {
    const parts = email.split('@');
    if (parts.length !== 2 || parts[1] !== domain) {
      throw new Error('Bootstrap email must belong to the selected tenant domain');
    }
  }

  const [tenant] = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants).where(eq(ssoTenants.domain, domain)).limit(1);
  if (!tenant) throw new Error('Bootstrap tenant was not found');

  const existing = await lookupAdminMembership(tenant.id, subject);
  if (existing && existing.role !== role) {
    throw new Error('Existing administrator role does not match the requested immutable role');
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`tenant=${tenant.domain}`);
  console.log(`role=${role}`);
  console.log(`membership_status=${existing?.status ?? 'missing'}`);
  console.log('subject=validated-not-printed');
  console.log(`email=${email ? 'validated-not-printed' : 'not-provided'}`);

  if (!apply) {
    console.log('database_changes=none');
    console.log('next=rerun-with-explicit-apply-after-review');
    return;
  }
  if (existing?.status === 'active') {
    console.log('membership=already-active');
    console.log('database_changes=none');
    return;
  }

  await grantAdminMembership({
    tenantId: tenant.id,
    subject,
    email,
    role,
    actorId: 'task4-system-operator-bootstrap',
    actorType: 'system_operator',
  });
  console.log(`membership=${existing ? 'reactivated' : 'granted'}`);
  console.log('audit_event=written');
  console.log('bootstrap=complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Administrator bootstrap failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
