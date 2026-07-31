import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  developerMachines,
  machineCredentials,
  securityAuditEvents,
} from '../db/schema';
import { createMachineCredential } from './machine-credential';
import type { StoredManagedMachineCredential } from './managed-machine-auth';

export interface RegisterMachineInput {
  tenantId: string;
  installationId: string;
  displayName: string;
  platform?: string;
  actorId: string;
}

export interface IssueMachineCredentialInput {
  tenantId: string;
  machineId: string;
  actorId: string;
  expiresAt?: Date;
  rotatedFromCredentialId?: string;
}

export async function lookupManagedMachineCredential(
  keyId: string,
): Promise<StoredManagedMachineCredential | null> {
  const [row] = await db.select({
    tenantId: machineCredentials.tenantId,
    machineId: machineCredentials.machineId,
    keyId: machineCredentials.keyId,
    secretHash: machineCredentials.secretHash,
    credentialStatus: machineCredentials.status,
    expiresAt: machineCredentials.expiresAt,
    credentialRevokedAt: machineCredentials.revokedAt,
    machineStatus: developerMachines.status,
    machineRevokedAt: developerMachines.revokedAt,
  }).from(machineCredentials).innerJoin(developerMachines, and(
    eq(developerMachines.tenantId, machineCredentials.tenantId),
    eq(developerMachines.id, machineCredentials.machineId),
  )).where(eq(machineCredentials.keyId, keyId)).limit(1);
  return row ?? null;
}

export async function recordManagedMachineUse(
  identity: { tenantId: string; machineId: string; keyId: string },
  usedAt = new Date(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.update(machineCredentials).set({ lastUsedAt: usedAt }).where(and(
      eq(machineCredentials.tenantId, identity.tenantId),
      eq(machineCredentials.machineId, identity.machineId),
      eq(machineCredentials.keyId, identity.keyId),
    ));
    await transaction.update(developerMachines).set({ lastSeenAt: usedAt, updatedAt: usedAt }).where(and(
      eq(developerMachines.tenantId, identity.tenantId),
      eq(developerMachines.id, identity.machineId),
    ));
  });
}

export async function registerDeveloperMachine(input: RegisterMachineInput) {
  return db.transaction(async (transaction) => {
    const [machine] = await transaction.insert(developerMachines).values({
      tenantId: input.tenantId,
      installationId: input.installationId,
      displayName: input.displayName,
      platform: input.platform,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: 'machine.registered',
      targetType: 'developer_machine',
      targetId: machine.id,
      details: { installationId: input.installationId, displayName: input.displayName },
    });
    return machine;
  });
}

export async function issueMachineCredential(input: IssueMachineCredentialInput) {
  return db.transaction(async (transaction) => {
    const [machine] = await transaction.select({ id: developerMachines.id })
      .from(developerMachines).where(and(
        eq(developerMachines.tenantId, input.tenantId),
        eq(developerMachines.id, input.machineId),
        eq(developerMachines.status, 'active'),
      )).limit(1);
    if (!machine) throw new Error('Active developer machine was not found');

    if (input.rotatedFromCredentialId) {
      const [previous] = await transaction.select({ id: machineCredentials.id })
        .from(machineCredentials).where(and(
          eq(machineCredentials.tenantId, input.tenantId),
          eq(machineCredentials.machineId, input.machineId),
          eq(machineCredentials.id, input.rotatedFromCredentialId),
          eq(machineCredentials.status, 'active'),
        )).limit(1);
      if (!previous) throw new Error('Active credential to rotate was not found');
    }

    const created = createMachineCredential();
    const [credential] = await transaction.insert(machineCredentials).values({
      tenantId: input.tenantId,
      machineId: input.machineId,
      keyId: created.keyId,
      secretHash: created.secretHash,
      expiresAt: input.expiresAt,
      rotatedFromCredentialId: input.rotatedFromCredentialId,
    }).returning();
    await transaction.insert(securityAuditEvents).values({
      tenantId: input.tenantId,
      actorType: 'tenant_admin',
      actorId: input.actorId,
      action: input.rotatedFromCredentialId ? 'machine_credential.rotated' : 'machine_credential.issued',
      targetType: 'machine_credential',
      targetId: credential.id,
      details: {
        machineId: input.machineId,
        keyId: created.keyId,
        rotatedFromCredentialId: input.rotatedFromCredentialId ?? null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      },
    });
    return {
      id: credential.id,
      machineId: credential.machineId,
      keyId: credential.keyId,
      plaintext: created.plaintext,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    };
  });
}

export async function revokeMachineCredential(
  tenantId: string,
  credentialId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const revokedAt = new Date();
    const [credential] = await transaction.update(machineCredentials).set({
      status: 'revoked', revokedAt,
    }).where(and(
      eq(machineCredentials.tenantId, tenantId),
      eq(machineCredentials.id, credentialId),
      eq(machineCredentials.status, 'active'),
    )).returning({ id: machineCredentials.id, machineId: machineCredentials.machineId, keyId: machineCredentials.keyId });
    if (!credential) throw new Error('Active machine credential was not found');
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'machine_credential.revoked',
      targetType: 'machine_credential',
      targetId: credential.id,
      details: { machineId: credential.machineId, keyId: credential.keyId, reason },
    });
  });
}

export async function revokeDeveloperMachine(
  tenantId: string,
  machineId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const revokedAt = new Date();
    const [machine] = await transaction.update(developerMachines).set({
      status: 'revoked', revokedAt, updatedAt: revokedAt,
    }).where(and(
      eq(developerMachines.tenantId, tenantId),
      eq(developerMachines.id, machineId),
      eq(developerMachines.status, 'active'),
    )).returning({ id: developerMachines.id });
    if (!machine) throw new Error('Active developer machine was not found');

    await transaction.update(machineCredentials).set({ status: 'revoked', revokedAt }).where(and(
      eq(machineCredentials.tenantId, tenantId),
      eq(machineCredentials.machineId, machineId),
      eq(machineCredentials.status, 'active'),
    ));
    await transaction.insert(securityAuditEvents).values({
      tenantId,
      actorType: 'tenant_admin',
      actorId,
      action: 'machine.revoked',
      targetType: 'developer_machine',
      targetId: machine.id,
      details: { reason, credentialsRevoked: true },
    });
  });
}
