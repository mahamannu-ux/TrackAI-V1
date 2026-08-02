import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { securityAuditEvents, tenantAdminMemberships } from '../db/schema';
import type { AdminMembershipRecord } from './admin-authorization';

export interface AdminMembershipDetails extends AdminMembershipRecord {
  id: string;
  email: string | null;
}

export async function lookupAdminMembership(
  tenantId: string,
  subject: string,
): Promise<AdminMembershipDetails | null> {
  const [membership] = await db.select({
    id: tenantAdminMemberships.id,
    tenantId: tenantAdminMemberships.tenantId,
    subject: tenantAdminMemberships.subject,
    email: tenantAdminMemberships.email,
    role: tenantAdminMemberships.role,
    status: tenantAdminMemberships.status,
    revokedAt: tenantAdminMemberships.revokedAt,
  }).from(tenantAdminMemberships).where(and(
    eq(tenantAdminMemberships.tenantId, tenantId),
    eq(tenantAdminMemberships.subject, subject),
  )).limit(1);
  return membership ?? null;
}

export interface GrantAdminMembershipInput {
  tenantId: string;
  subject: string;
  email?: string;
  role: 'tenant_admin' | 'tenant_auditor';
  actorId: string;
  actorType: 'system_operator' | 'tenant_admin';
  now?: Date;
}

export async function grantAdminMembership(input: GrantAdminMembershipInput) {
  const subject = input.subject.trim();
  const email = input.email?.trim().toLowerCase();
  if (!subject || subject.length > 255) throw new Error('Administrator subject is invalid');
  if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Administrator email is invalid');
  const now = input.now ?? new Date();

  return db.transaction(async transaction => {
    const [existing] = await transaction.select().from(tenantAdminMemberships).where(and(
      eq(tenantAdminMemberships.tenantId, input.tenantId),
      eq(tenantAdminMemberships.subject, subject),
    )).limit(1);
    if (existing?.status === 'active') throw new Error('Administrator membership is already active');
    if (existing && existing.role !== input.role) {
      throw new Error('Revoked administrator membership cannot change role during reactivation');
    }
    const [membership] = existing
      ? await transaction.update(tenantAdminMemberships).set({
        status: 'active', revokedAt: null, email: email ?? existing.email,
      }).where(and(
        eq(tenantAdminMemberships.tenantId, input.tenantId),
        eq(tenantAdminMemberships.id, existing.id),
        eq(tenantAdminMemberships.status, 'revoked'),
      )).returning()
      : await transaction.insert(tenantAdminMemberships).values({
        tenantId: input.tenantId,
        subject,
        email,
        role: input.role,
        grantedBy: input.actorId,
        grantedAt: now,
      }).returning();
    if (!membership) throw new Error('Administrator membership state changed during update');
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: existing ? 'admin_membership.reactivated' : 'admin_membership.granted',
      targetType: 'tenant_admin_membership',
      targetId: membership.id,
      details: { role: membership.role, subject: membership.subject },
    });
    return membership;
  });
}

export async function revokeAdminMembership(
  tenantId: string,
  membershipId: string,
  actorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  if (!reason.trim()) throw new Error('Administrator revocation reason is required');
  await db.transaction(async transaction => {
    const [membership] = await transaction.update(tenantAdminMemberships).set({
      status: 'revoked', revokedAt: now,
    }).where(and(
      eq(tenantAdminMemberships.tenantId, tenantId),
      eq(tenantAdminMemberships.id, membershipId),
      eq(tenantAdminMemberships.status, 'active'),
    )).returning({
      id: tenantAdminMemberships.id,
      subject: tenantAdminMemberships.subject,
      role: tenantAdminMemberships.role,
    });
    if (!membership) throw new Error('Active administrator membership was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'admin_membership.revoked',
      targetType: 'tenant_admin_membership',
      targetId: membership.id,
      details: { subject: membership.subject, role: membership.role, reason: reason.trim() },
    });
  });
}
