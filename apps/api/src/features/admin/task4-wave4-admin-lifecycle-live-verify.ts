import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../core/db';
import {
  machineRepositoryGrants,
  repositoryBackfillAuthorizations,
  repositoryEnrollments,
  scmRepositories,
  securityAuditEvents,
  ssoTenants,
} from '../../core/db/schema';
import { adminMembershipAllows, type AdminAction } from '../../core/security/admin-authorization';
import {
  issueMachineCredential,
  lookupManagedMachineCredential,
  registerDeveloperMachine,
  revokeDeveloperMachine,
  revokeMachineCredential,
} from '../../core/security/machine-security-service';
import { resolveManagedMachineCredential } from '../../core/security/managed-machine-auth';
import {
  authorizeRepositoryBackfill,
  enrollRepository,
  grantMachineRepository,
  machineCanAccessRepository,
  replaceMachineRepositoryGrantBranchScope,
  revokeMachineRepositoryGrant,
  revokeRepositoryBackfillAuthorization,
  revokeRepositoryEnrollment,
} from '../../core/security/repository-security-service';

const COMPANY_A_DOMAIN = 'purpletealabs.net';
const COMPANY_B_DOMAIN = 'customer-b-oidc.com';

const lifecycleCountsSql = `
  SELECT
    (SELECT count(*)::text FROM telemetry_metric_events) AS telemetry_metric_events,
    (SELECT count(*)::text FROM scm_commits) AS scm_commits,
    (SELECT count(*)::text FROM scm_pull_requests) AS scm_pull_requests,
    (SELECT count(*)::text FROM ai_sessions) AS ai_sessions,
    (SELECT count(*)::text FROM ai_session_usage) AS ai_session_usage,
    (SELECT count(*)::text FROM ai_commit_sessions) AS ai_commit_sessions,
    (SELECT count(*)::text FROM ai_commit_model_attributions) AS ai_commit_model_attributions,
    (SELECT count(*)::text FROM scm_commit_lineage) AS scm_commit_lineage,
    (SELECT count(*)::text FROM scm_pull_request_snapshots) AS scm_pull_request_snapshots,
    (SELECT count(*)::text FROM scm_pull_request_commit_memberships) AS scm_pull_request_commit_memberships,
    (SELECT count(*)::text FROM scm_merge_lineage) AS scm_merge_lineage,
    (SELECT count(*)::text FROM scm_deployments) AS scm_deployments,
    (SELECT count(*)::text FROM ai_generation_observations) AS ai_generation_observations,
    (SELECT count(*)::text FROM ai_code_lifecycle_events) AS ai_code_lifecycle_events,
    (SELECT count(*)::text FROM ai_model_lifecycle_events) AS ai_model_lifecycle_events,
    (SELECT count(*)::text FROM telemetry_corrections) AS telemetry_corrections
`;

type IssuedCredential = Awaited<ReturnType<typeof issueMachineCredential>>;

interface TenantProbe {
  label: 'company_a' | 'company_b';
  tenantId: string;
  repositoryOneId: string;
  repositoryTwoId: string;
  enrollmentOneId: string;
  enrollmentTwoId: string;
  primaryMachineId: string;
  secondaryMachineId: string;
  primaryCredential: IssuedCredential;
  replacementCredential: IssuedCredential;
  secondaryCredential: IssuedCredential;
  primaryRepositoryOneGrantId: string;
  primaryRepositoryTwoGrantId: string;
  secondaryRepositoryOneGrantId: string;
  generationBackfillId: string;
  commitBackfillId: string;
}

interface CleanupTarget {
  tenantId: string;
  machineIds: string[];
  enrollmentIds: string[];
}

async function expectRejected(
  operation: () => Promise<unknown>,
  expected: RegExp,
): Promise<void> {
  await assert.rejects(operation, expected);
}

async function credentialAccepted(credential: string): Promise<boolean> {
  return Boolean(await resolveManagedMachineCredential(
    credential,
    lookupManagedMachineCredential,
  ));
}

async function setupTenantProbe(input: {
  label: TenantProbe['label'];
  tenantId: string;
  marker: string;
  actorId: string;
  cleanupTargets: CleanupTarget[];
}): Promise<TenantProbe> {
  const repositoryBase = `${input.marker}-${input.label}`;
  const [repositoryOne, repositoryTwo] = await db.insert(scmRepositories).values([
    {
      tenantId: input.tenantId,
      provider: 'github',
      externalId: `${repositoryBase}-repository-one`,
      name: `${repositoryBase}-repository-one`,
      url: `https://github.com/trackai-task4-verification/${repositoryBase}-repository-one`,
      normalizedUrl: `https://github.com/trackai-task4-verification/${repositoryBase}-repository-one`,
    },
    {
      tenantId: input.tenantId,
      provider: 'github',
      externalId: `${repositoryBase}-repository-two`,
      name: `${repositoryBase}-repository-two`,
      url: `https://github.com/trackai-task4-verification/${repositoryBase}-repository-two`,
      normalizedUrl: `https://github.com/trackai-task4-verification/${repositoryBase}-repository-two`,
    },
  ]).returning({ id: scmRepositories.id });

  const cleanupTarget = {
    tenantId: input.tenantId,
    machineIds: [] as string[],
    enrollmentIds: [] as string[],
  };
  input.cleanupTargets.push(cleanupTarget);
  const primaryMachine = await registerDeveloperMachine({
    tenantId: input.tenantId,
    installationId: `${repositoryBase}-primary`,
    displayName: `Task4 Wave 4 ${input.label} primary`,
    platform: 'single-mac-disposable-verifier',
    actorId: input.actorId,
  });
  cleanupTarget.machineIds.push(primaryMachine.id);
  const secondaryMachine = await registerDeveloperMachine({
    tenantId: input.tenantId,
    installationId: `${repositoryBase}-secondary`,
    displayName: `Task4 Wave 4 ${input.label} secondary`,
    platform: 'single-mac-disposable-verifier',
    actorId: input.actorId,
  });
  cleanupTarget.machineIds.push(secondaryMachine.id);

  const primaryCredential = await issueMachineCredential({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    actorId: input.actorId,
  });
  const replacementCredential = await issueMachineCredential({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    actorId: input.actorId,
    rotatedFromCredentialId: primaryCredential.id,
  });
  const secondaryCredential = await issueMachineCredential({
    tenantId: input.tenantId,
    machineId: secondaryMachine.id,
    actorId: input.actorId,
  });

  assert.equal(await credentialAccepted(primaryCredential.plaintext), true);
  assert.equal(await credentialAccepted(replacementCredential.plaintext), true);
  await expectRejected(() => issueMachineCredential({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    actorId: input.actorId,
    rotatedFromCredentialId: primaryCredential.id,
  }), /rotation overlap/);

  const policyNow = new Date();
  const enrollmentOne = await enrollRepository({
    tenantId: input.tenantId,
    repositoryId: repositoryOne.id,
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable lifecycle verification',
    effectiveFrom: policyNow,
    generationSessionEvidenceFrom: policyNow,
    commitNoteEvidenceFrom: policyNow,
  });
  cleanupTarget.enrollmentIds.push(enrollmentOne.id);
  const enrollmentTwo = await enrollRepository({
    tenantId: input.tenantId,
    repositoryId: repositoryTwo.id,
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable lifecycle verification',
    effectiveFrom: policyNow,
    generationSessionEvidenceFrom: policyNow,
    commitNoteEvidenceFrom: policyNow,
  });
  cleanupTarget.enrollmentIds.push(enrollmentTwo.id);

  const primaryRepositoryOneGrant = await grantMachineRepository({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    enrollmentId: enrollmentOne.id,
    branchPatterns: ['main', 'feature/*'],
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable lifecycle verification',
  });
  const primaryRepositoryTwoGrant = await grantMachineRepository({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    enrollmentId: enrollmentTwo.id,
    branchPatterns: [],
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable lifecycle verification',
  });
  const secondaryRepositoryOneGrant = await grantMachineRepository({
    tenantId: input.tenantId,
    machineId: secondaryMachine.id,
    enrollmentId: enrollmentOne.id,
    branchPatterns: [],
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable lifecycle verification',
  });
  await expectRejected(() => grantMachineRepository({
    tenantId: input.tenantId,
    machineId: primaryMachine.id,
    enrollmentId: enrollmentOne.id,
    branchPatterns: ['main'],
    actorId: input.actorId,
  }), /already has active access/);

  const backfillNow = new Date();
  const backfillWindow = {
    occurredFrom: new Date(policyNow.getTime() - 86_400_000),
    occurredUntil: new Date(policyNow.getTime() - 1),
    expiresAt: new Date(backfillNow.getTime() + 3_600_000),
    now: backfillNow,
  };
  const generationBackfill = await authorizeRepositoryBackfill({
    tenantId: input.tenantId,
    enrollmentId: enrollmentOne.id,
    evidenceFamily: 'generation_session',
    ...backfillWindow,
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable generation backfill',
  });
  const commitBackfill = await authorizeRepositoryBackfill({
    tenantId: input.tenantId,
    enrollmentId: enrollmentTwo.id,
    evidenceFamily: 'commit_note',
    ...backfillWindow,
    actorId: input.actorId,
    reason: 'Task4 Wave 4 disposable commit backfill',
  });
  await expectRejected(() => authorizeRepositoryBackfill({
    tenantId: input.tenantId,
    enrollmentId: enrollmentOne.id,
    evidenceFamily: 'generation_session',
    ...backfillWindow,
    actorId: input.actorId,
    reason: 'Task4 duplicate backfill rejection probe',
  }), /already exists/);

  return {
    label: input.label,
    tenantId: input.tenantId,
    repositoryOneId: repositoryOne.id,
    repositoryTwoId: repositoryTwo.id,
    enrollmentOneId: enrollmentOne.id,
    enrollmentTwoId: enrollmentTwo.id,
    primaryMachineId: primaryMachine.id,
    secondaryMachineId: secondaryMachine.id,
    primaryCredential,
    replacementCredential,
    secondaryCredential,
    primaryRepositoryOneGrantId: primaryRepositoryOneGrant.id,
    primaryRepositoryTwoGrantId: primaryRepositoryTwoGrant.id,
    secondaryRepositoryOneGrantId: secondaryRepositoryOneGrant.id,
    generationBackfillId: generationBackfill.id,
    commitBackfillId: commitBackfill.id,
  };
}

async function exerciseTenantProbe(probe: TenantProbe, actorId: string): Promise<void> {
  const access = (repositoryId: string, branch: string | null) => machineCanAccessRepository({
    tenantId: probe.tenantId,
    machineId: probe.primaryMachineId,
    repositoryId,
    branch,
    // Generate this at each check. A fixed timestamp can become older than a
    // replacement grant after several remote database round trips.
    now: new Date(Date.now() + 1_000),
  });

  assert.equal(await access(probe.repositoryOneId, 'main'), true);
  assert.equal(await access(probe.repositoryOneId, 'feature/demo'), true);
  assert.equal(await access(probe.repositoryOneId, 'release/1'), false);

  const replacementGrant = await replaceMachineRepositoryGrantBranchScope({
    tenantId: probe.tenantId,
    grantId: probe.primaryRepositoryOneGrantId,
    branchPatterns: ['main', 'release/*'],
    actorId,
    reason: 'Task4 Wave 4 verify atomic branch replacement',
  });
  probe.primaryRepositoryOneGrantId = replacementGrant.id;
  assert.equal(await access(probe.repositoryOneId, 'main'), true);
  assert.equal(await access(probe.repositoryOneId, 'feature/demo'), false);
  assert.equal(await access(probe.repositoryOneId, 'release/1'), true);

  await revokeMachineCredential(
    probe.tenantId,
    probe.primaryCredential.id,
    actorId,
    'Task4 Wave 4 completed credential overlap',
  );
  assert.equal(await credentialAccepted(probe.primaryCredential.plaintext), false);
  assert.equal(await credentialAccepted(probe.replacementCredential.plaintext), true);

  await revokeMachineRepositoryGrant(
    probe.tenantId,
    probe.primaryRepositoryTwoGrantId,
    actorId,
    'Task4 Wave 4 verify narrow grant revocation',
  );
  assert.equal(await access(probe.repositoryTwoId, 'main'), false);
  assert.equal(await access(probe.repositoryOneId, 'main'), true);
  const replacementRepositoryTwoGrant = await grantMachineRepository({
    tenantId: probe.tenantId,
    machineId: probe.primaryMachineId,
    enrollmentId: probe.enrollmentTwoId,
    branchPatterns: [],
    actorId,
    reason: 'Task4 Wave 4 restore independent repository access',
  });
  probe.primaryRepositoryTwoGrantId = replacementRepositoryTwoGrant.id;

  await revokeRepositoryBackfillAuthorization(
    probe.tenantId,
    probe.commitBackfillId,
    actorId,
    'Task4 Wave 4 verify narrow backfill revocation',
  );
  const [revokedBackfill] = await db.select({
    status: repositoryBackfillAuthorizations.status,
  }).from(repositoryBackfillAuthorizations).where(and(
    eq(repositoryBackfillAuthorizations.tenantId, probe.tenantId),
    eq(repositoryBackfillAuthorizations.id, probe.commitBackfillId),
  )).limit(1);
  assert.equal(revokedBackfill?.status, 'revoked');
  assert.equal(await access(probe.repositoryTwoId, 'main'), true);

  await revokeDeveloperMachine(
    probe.tenantId,
    probe.secondaryMachineId,
    actorId,
    'Task4 Wave 4 verify whole-machine cascade',
  );
  const [machineRevokedGrant] = await db.select({ status: machineRepositoryGrants.status })
    .from(machineRepositoryGrants).where(and(
      eq(machineRepositoryGrants.tenantId, probe.tenantId),
      eq(machineRepositoryGrants.id, probe.secondaryRepositoryOneGrantId),
    )).limit(1);
  assert.equal(machineRevokedGrant?.status, 'revoked');
  assert.equal(await credentialAccepted(probe.secondaryCredential.plaintext), false);
  assert.equal(await credentialAccepted(probe.replacementCredential.plaintext), true);
  assert.equal(await access(probe.repositoryOneId, 'main'), true);

  await revokeRepositoryEnrollment(
    probe.tenantId,
    probe.enrollmentOneId,
    actorId,
    'Task4 Wave 4 verify repository-policy cascade',
  );
  const [repositoryCascade] = await db.select({
    enrollmentStatus: repositoryEnrollments.status,
    grantStatus: machineRepositoryGrants.status,
    backfillStatus: repositoryBackfillAuthorizations.status,
  }).from(repositoryEnrollments).innerJoin(machineRepositoryGrants, and(
    eq(machineRepositoryGrants.tenantId, repositoryEnrollments.tenantId),
    eq(machineRepositoryGrants.enrollmentId, repositoryEnrollments.id),
    eq(machineRepositoryGrants.id, probe.primaryRepositoryOneGrantId),
  )).innerJoin(repositoryBackfillAuthorizations, and(
    eq(repositoryBackfillAuthorizations.tenantId, repositoryEnrollments.tenantId),
    eq(repositoryBackfillAuthorizations.enrollmentId, repositoryEnrollments.id),
    eq(repositoryBackfillAuthorizations.id, probe.generationBackfillId),
  )).where(and(
    eq(repositoryEnrollments.tenantId, probe.tenantId),
    eq(repositoryEnrollments.id, probe.enrollmentOneId),
  )).limit(1);
  assert.deepEqual(repositoryCascade, {
    enrollmentStatus: 'revoked',
    grantStatus: 'revoked',
    backfillStatus: 'revoked',
  });
  assert.equal(await access(probe.repositoryOneId, 'main'), false);
  assert.equal(await access(probe.repositoryTwoId, 'main'), true);
  assert.equal(await credentialAccepted(probe.replacementCredential.plaintext), true);
}

async function cleanupProbe(target: CleanupTarget, actorId: string): Promise<boolean> {
  let succeeded = true;
  for (const enrollmentId of target.enrollmentIds) {
    try {
      await revokeRepositoryEnrollment(
        target.tenantId,
        enrollmentId,
        actorId,
        'Task4 Wave 4 verifier safety cleanup',
      );
    } catch (error) {
      if (!/not found/.test((error as Error).message)) succeeded = false;
    }
  }
  for (const machineId of target.machineIds) {
    try {
      await revokeDeveloperMachine(
        target.tenantId,
        machineId,
        actorId,
        'Task4 Wave 4 verifier safety cleanup',
      );
    } catch (error) {
      if (!/not found/.test((error as Error).message)) succeeded = false;
    }
  }
  return succeeded;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const marker = `task4-wave4-matrix-${randomUUID()}`;
  const actorId = marker;
  const cleanupTargets: CleanupTarget[] = [];
  let cleanupSucceeded = true;

  try {
    const beforeLifecycle = (await pool.query(lifecycleCountsSql)).rows[0];
    const tenants = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
      .from(ssoTenants)
      .where(inArray(ssoTenants.domain, [COMPANY_A_DOMAIN, COMPANY_B_DOMAIN]));
    const companyA = tenants.find(tenant => tenant.domain === COMPANY_A_DOMAIN);
    const companyB = tenants.find(tenant => tenant.domain === COMPANY_B_DOMAIN);
    if (!companyA || !companyB) throw new Error('Canonical Company A/B tenants are required');

    if (process.env.TASK4_WAVE4_ADMIN_LIFECYCLE_APPLY !== '1') {
      console.log('mode=dry-run');
      console.log('company_a_tenant=present');
      console.log('company_b_tenant=present');
      console.log('planned_logical_machines=4');
      console.log('planned_disposable_repositories=4');
      console.log('credential_rotation=would-stage-and-revoke-old-key');
      console.log('grant_branch_machine_backfill_repository_revocations=would-exercise');
      console.log('cross_tenant_and_auditor_denials=would-exercise');
      console.log('cleanup=would-revoke-all-disposable-active-resources');
      console.log('audit_history=would-retain');
      console.log('database_changes=none');
      console.log('next=rerun-with-explicit-apply-after-review');
      return;
    }

    const probeA = await setupTenantProbe({
      label: 'company_a', tenantId: companyA.id, marker, actorId, cleanupTargets,
    });
    const probeB = await setupTenantProbe({
      label: 'company_b', tenantId: companyB.id, marker, actorId, cleanupTargets,
    });

    await expectRejected(() => issueMachineCredential({
      tenantId: probeA.tenantId,
      machineId: probeB.primaryMachineId,
      actorId,
    }), /Active developer machine was not found/);
    await expectRejected(() => grantMachineRepository({
      tenantId: probeA.tenantId,
      machineId: probeA.primaryMachineId,
      enrollmentId: probeB.enrollmentOneId,
      actorId,
    }), /Active repository enrollment was not found/);
    await expectRejected(() => replaceMachineRepositoryGrantBranchScope({
      tenantId: probeA.tenantId,
      grantId: probeB.primaryRepositoryOneGrantId,
      branchPatterns: ['main'],
      actorId,
      reason: 'Task4 Wave 4 cross-tenant rejection probe',
    }), /Active machine repository grant was not found/);
    await expectRejected(() => revokeMachineCredential(
      probeA.tenantId,
      probeB.primaryCredential.id,
      actorId,
      'Task4 Wave 4 cross-tenant rejection probe',
    ), /Active machine credential was not found/);

    const auditorMembership = {
      tenantId: probeA.tenantId,
      subject: `${marker}-auditor`,
      role: 'tenant_auditor' as const,
      status: 'active' as const,
      revokedAt: null,
    };
    assert.equal(adminMembershipAllows(auditorMembership, {
      tenantId: probeA.tenantId,
      subject: auditorMembership.subject,
      action: 'audit.read',
    }), true);
    for (const action of [
      'machine.manage', 'repository.manage', 'backfill.manage', 'github_app.manage',
    ] satisfies AdminAction[]) {
      assert.equal(adminMembershipAllows(auditorMembership, {
        tenantId: probeA.tenantId,
        subject: auditorMembership.subject,
        action,
      }), false);
    }

    await exerciseTenantProbe(probeA, actorId);
    await exerciseTenantProbe(probeB, actorId);

    for (const target of cleanupTargets) {
      cleanupSucceeded = await cleanupProbe(target, actorId) && cleanupSucceeded;
    }

    const auditRows = await db.select({
      tenantId: securityAuditEvents.tenantId,
      action: securityAuditEvents.action,
    }).from(securityAuditEvents).where(eq(securityAuditEvents.actorId, actorId));
    const requiredAuditActions = [
      'machine.registered',
      'machine_credential.issued',
      'machine_credential.rotated',
      'machine_credential.revoked',
      'machine.revoked',
      'repository.enrolled',
      'repository_grant.issued',
      'repository_grant.branch_scope_replaced',
      'repository_grant.revoked',
      'repository_backfill.authorized',
      'repository_backfill.revoked',
      'repository.revoked',
    ];
    for (const tenantId of [probeA.tenantId, probeB.tenantId]) {
      const tenantActions = new Set(auditRows
        .filter(row => row.tenantId === tenantId)
        .map(row => row.action));
      for (const action of requiredAuditActions) assert.equal(tenantActions.has(action), true);
    }

    const activeProbeRows = await pool.query<{ count: string }>(`
      SELECT (
        SELECT count(*) FROM developer_machines
        WHERE installation_id LIKE $1 AND status = 'active'
      ) + (
        SELECT count(*) FROM machine_credentials c
        JOIN developer_machines m ON m.tenant_id = c.tenant_id AND m.id = c.machine_id
        WHERE m.installation_id LIKE $1 AND c.status = 'active'
      ) + (
        SELECT count(*) FROM repository_enrollments e
        JOIN scm_repositories r ON r.tenant_id = e.tenant_id AND r.id = e.repository_id
        WHERE r.external_id LIKE $1 AND e.status = 'active'
      ) + (
        SELECT count(*) FROM machine_repository_grants g
        JOIN developer_machines m ON m.tenant_id = g.tenant_id AND m.id = g.machine_id
        WHERE m.installation_id LIKE $1 AND g.status = 'active'
      ) + (
        SELECT count(*) FROM repository_backfill_authorizations b
        JOIN repository_enrollments e ON e.tenant_id = b.tenant_id AND e.id = b.enrollment_id
        JOIN scm_repositories r ON r.tenant_id = e.tenant_id AND r.id = e.repository_id
        WHERE r.external_id LIKE $1 AND b.status = 'active'
      ) AS count
    `, [`${marker}%`]);
    const afterLifecycle = (await pool.query(lifecycleCountsSql)).rows[0];
    const lifecycleUnchanged = JSON.stringify(beforeLifecycle) === JSON.stringify(afterLifecycle);

    assert.equal(cleanupSucceeded, true);
    assert.equal(activeProbeRows.rows[0].count, '0');
    assert.equal(lifecycleUnchanged, true);

    console.log('logical_tenants=2');
    console.log('logical_machines=4');
    console.log('credential_rotation_overlap=old-and-new-accepted');
    console.log('third_active_credential=blocked');
    console.log('old_credential_after_revoke=rejected');
    console.log('replacement_credential=accepted');
    console.log('single_repository_grant_revocation=narrow');
    console.log('branch_scope_replacement=atomic-and-enforced');
    console.log('single_backfill_revocation=current-access-unchanged');
    console.log('whole_machine_revocation=credentials-and-grants-only');
    console.log('repository_policy_revocation=grants-and-backfill-only');
    console.log('duplicate_grant_and_backfill=blocked');
    console.log('cross_tenant_resource_ids=blocked');
    console.log('auditor_mutations=blocked');
    console.log('audit_history=retained');
    console.log('plaintext_credentials=never-printed-or-stored');
    console.log('active_disposable_rows=0');
    console.log('task2_lifecycle_counts=unchanged');
    console.log('verification=passed');
  } finally {
    for (const target of cleanupTargets) {
      cleanupSucceeded = await cleanupProbe(target, actorId) && cleanupSucceeded;
    }
    await pool.end();
    if (!cleanupSucceeded) {
      console.log('safety_cleanup=failed');
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  const failure = error as Error & { code?: string };
  console.log('wave4_admin_lifecycle_verification=failed');
  console.log(`error_code=${failure.code ?? 'unknown'}`);
  process.exitCode = 1;
});
