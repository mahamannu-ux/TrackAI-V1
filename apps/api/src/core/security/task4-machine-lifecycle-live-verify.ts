import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db';
import {
  developerMachines,
  machineCredentials,
  securityAuditEvents,
  ssoTenants,
} from '../db/schema';
import {
  issueMachineCredential,
  lookupManagedMachineCredential,
  registerDeveloperMachine,
  revokeDeveloperMachine,
  revokeMachineCredential,
} from './machine-security-service';
import { resolveManagedMachineCredential } from './managed-machine-auth';

const COMPANY_A_DOMAIN = 'purpletealabs.net';
const COMPANY_B_DOMAIN = 'customer-b-oidc.com';

interface RegisteredProbeMachine {
  tenantId: string;
  machineId: string;
}

function corruptCredential(credential: string): string {
  const finalCharacter = credential.at(-1);
  return `${credential.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const marker = `task4-lifecycle-${randomUUID()}`;
  const actorId = marker;
  const registered: RegisteredProbeMachine[] = [];
  const revokedMachineIds = new Set<string>();
  let cleanupFailed = false;

  try {
    const tenants = await db.select({
      id: ssoTenants.id,
      domain: ssoTenants.domain,
    }).from(ssoTenants).where(inArray(ssoTenants.domain, [
      COMPANY_A_DOMAIN,
      COMPANY_B_DOMAIN,
    ]));
    const companyA = tenants.find(tenant => tenant.domain === COMPANY_A_DOMAIN);
    const companyB = tenants.find(tenant => tenant.domain === COMPANY_B_DOMAIN);
    if (!companyA || !companyB) {
      throw new Error('Canonical Company A/B tenants are required');
    }

    const machineA = await registerDeveloperMachine({
      tenantId: companyA.id,
      installationId: `${marker}-a`,
      displayName: 'Task4 lifecycle verification A',
      platform: 'single-mac-logical-installation',
      actorId,
    });
    registered.push({ tenantId: companyA.id, machineId: machineA.id });
    const machineB = await registerDeveloperMachine({
      tenantId: companyB.id,
      installationId: `${marker}-b`,
      displayName: 'Task4 lifecycle verification B',
      platform: 'single-mac-logical-installation',
      actorId,
    });
    registered.push({ tenantId: companyB.id, machineId: machineB.id });

    const credentialA1 = await issueMachineCredential({
      tenantId: companyA.id,
      machineId: machineA.id,
      actorId,
    });
    const credentialB = await issueMachineCredential({
      tenantId: companyB.id,
      machineId: machineB.id,
      actorId,
    });

    const identityA1 = await resolveManagedMachineCredential(
      credentialA1.plaintext,
      lookupManagedMachineCredential,
    );
    const identityB = await resolveManagedMachineCredential(
      credentialB.plaintext,
      lookupManagedMachineCredential,
    );
    const wrongSecret = await resolveManagedMachineCredential(
      corruptCredential(credentialA1.plaintext),
      lookupManagedMachineCredential,
    );
    if (identityA1?.tenantId !== companyA.id
      || identityB?.tenantId !== companyB.id
      || wrongSecret !== null) {
      throw new Error('Initial managed credential authentication failed');
    }

    const credentialA2 = await issueMachineCredential({
      tenantId: companyA.id,
      machineId: machineA.id,
      actorId,
      rotatedFromCredentialId: credentialA1.id,
    });
    const overlapOld = await resolveManagedMachineCredential(
      credentialA1.plaintext,
      lookupManagedMachineCredential,
    );
    const overlapNew = await resolveManagedMachineCredential(
      credentialA2.plaintext,
      lookupManagedMachineCredential,
    );
    if (!overlapOld || !overlapNew) {
      throw new Error('Controlled credential overlap failed');
    }

    await revokeMachineCredential(
      companyA.id,
      credentialA1.id,
      actorId,
      'Task4 live verification completed old-key overlap',
    );
    const revokedOld = await resolveManagedMachineCredential(
      credentialA1.plaintext,
      lookupManagedMachineCredential,
    );
    const activeNew = await resolveManagedMachineCredential(
      credentialA2.plaintext,
      lookupManagedMachineCredential,
    );
    if (revokedOld !== null || !activeNew) {
      throw new Error('Credential revocation behavior failed');
    }

    await revokeDeveloperMachine(
      companyA.id,
      machineA.id,
      actorId,
      'Task4 live verification complete',
    );
    revokedMachineIds.add(machineA.id);
    await revokeDeveloperMachine(
      companyB.id,
      machineB.id,
      actorId,
      'Task4 live verification complete',
    );
    revokedMachineIds.add(machineB.id);

    const revokedNew = await resolveManagedMachineCredential(
      credentialA2.plaintext,
      lookupManagedMachineCredential,
    );
    const revokedB = await resolveManagedMachineCredential(
      credentialB.plaintext,
      lookupManagedMachineCredential,
    );
    if (revokedNew !== null || revokedB !== null) {
      throw new Error('Whole-machine revocation failed');
    }

    const active = await db.select({
      machineStatus: developerMachines.status,
      credentialStatus: machineCredentials.status,
    }).from(developerMachines).leftJoin(
      machineCredentials,
      and(
        eq(machineCredentials.tenantId, developerMachines.tenantId),
        eq(machineCredentials.machineId, developerMachines.id),
      ),
    ).where(inArray(developerMachines.id, [machineA.id, machineB.id]));
    if (active.some(row => row.machineStatus !== 'revoked'
      || row.credentialStatus !== 'revoked')) {
      throw new Error('Verification left an active machine or credential');
    }

    const auditRows = await db.select({ action: securityAuditEvents.action })
      .from(securityAuditEvents)
      .where(inArray(securityAuditEvents.actorId, [actorId]));
    const actions = new Set(auditRows.map(row => row.action));
    const requiredActions = [
      'machine.registered',
      'machine_credential.issued',
      'machine_credential.rotated',
      'machine_credential.revoked',
      'machine.revoked',
    ];
    if (requiredActions.some(action => !actions.has(action))) {
      throw new Error('Required lifecycle audit evidence is missing');
    }

    console.log('logical_installations=2');
    console.log('initial_credentials=accepted');
    console.log('wrong_secret=rejected');
    console.log('rotation_overlap=old-and-new-accepted');
    console.log('old_credential_after_revoke=rejected');
    console.log('new_credential_during_overlap=accepted');
    console.log('whole_machine_revocation=all-credentials-rejected');
    console.log('active_probe_credentials=0');
    console.log('audit_lifecycle=complete');
    console.log('plaintext_tokens=never-printed-or-stored');
  } finally {
    for (const machine of registered) {
      if (revokedMachineIds.has(machine.machineId)) continue;
      try {
        await revokeDeveloperMachine(
          machine.tenantId,
          machine.machineId,
          actorId,
          'Task4 verification safety cleanup',
        );
      } catch {
        cleanupFailed = true;
      }
    }
    await pool.end();
    if (cleanupFailed) {
      console.log('safety_cleanup=failed');
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  const failure = error as Error & { code?: string };
  console.log('machine_lifecycle_verification=failed');
  console.log(`error_code=${failure.code ?? 'unknown'}`);
  process.exitCode = 1;
});
