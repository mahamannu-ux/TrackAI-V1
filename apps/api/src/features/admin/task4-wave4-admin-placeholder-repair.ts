import 'dotenv/config';

import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import { securityAuditEvents, ssoTenants, tenantAdminMemberships } from '../../core/db/schema';

const knownPlaceholders = [
  'PASTE-THE-COMPLETE-JWT-SUBJECT-HERE',
  'PASTE-THE-SAME-COMPLETE-JWT-SUBJECT-HERE',
];

async function main(): Promise<void> {
  const apply = process.env.TASK4_ADMIN_PLACEHOLDER_REPAIR_APPLY === '1';
  const rows = await db.select({
    id: tenantAdminMemberships.id,
    tenantId: tenantAdminMemberships.tenantId,
    domain: ssoTenants.domain,
    status: tenantAdminMemberships.status,
  }).from(tenantAdminMemberships).innerJoin(
    ssoTenants,
    eq(ssoTenants.id, tenantAdminMemberships.tenantId),
  ).where(inArray(tenantAdminMemberships.subject, knownPlaceholders));
  const active = rows.filter(row => row.status === 'active');

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`placeholder_memberships=${rows.length}`);
  console.log(`active_placeholder_memberships=${active.length}`);
  console.log(`affected_tenants=${[...new Set(active.map(row => row.domain))].sort().join(',') || 'none'}`);
  console.log('subjects=known-placeholders-not-printed');

  if (!apply) {
    console.log('database_changes=none');
    console.log('next=rerun-with-explicit-apply-after-review');
    return;
  }
  if (active.length === 0) {
    console.log('memberships=already-safe');
    console.log('database_changes=none');
    return;
  }

  const revokedAt = new Date();
  await db.transaction(async transaction => {
    for (const row of active) {
      const [revoked] = await transaction.update(tenantAdminMemberships).set({
        status: 'revoked',
        revokedAt,
      }).where(and(
        eq(tenantAdminMemberships.tenantId, row.tenantId),
        eq(tenantAdminMemberships.id, row.id),
        eq(tenantAdminMemberships.status, 'active'),
      )).returning({ id: tenantAdminMemberships.id });
      if (!revoked) throw new Error('Placeholder membership state changed during repair');
      await transaction.insert(securityAuditEvents).values({
        tenantId: row.tenantId,
        actorType: 'system_operator',
        actorId: 'task4-placeholder-repair',
        action: 'admin_membership.revoked',
        targetType: 'tenant_admin_membership',
        targetId: row.id,
        details: {
          reason: 'Operator placeholder was submitted instead of a verified Supabase subject UUID',
          correctiveOverlay: true,
        },
      });
    }
  });
  console.log(`memberships_revoked=${active.length}`);
  console.log(`audit_events_written=${active.length}`);
  console.log('raw_history=retained');
  console.log('repair=complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Administrator placeholder repair failed');
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
