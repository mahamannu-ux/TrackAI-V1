/**
 * IT-T16b-01: the audit emitter against real PostgreSQL (all migrations applied).
 *
 *   scripts/it-db.sh npm run verify:task16b-audit-live -w apps/api
 *
 * (a) A valid event recorded inside a transaction is readable through withTenant for
 *     Company A and invisible to Company B.
 * (b) A contract error inside a transaction rolls back that transaction's other write
 *     (fail closed: no audit, no change); the same transaction with a valid event commits both.
 * (c) The stored row round-trips through docs/contracts/audit/event-v1.schema.json with
 *     the derived severity and catalog_version.
 *
 * Throwaway database only (TASK6_EPHEMERAL_DATABASE=1, set by scripts/it-db.sh). Prints
 * only safe summary lines, never a details value.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db';
import { developerMachines, securityAuditEvents, ssoTenants } from '../db/schema';
import { withTenant } from '../db/tenant';
import { AUDIT_CATALOG_BY_ACTION, AUDIT_CATALOG_VERSION, AuditContractError } from './catalog';
import { recordAuditEvent } from './record';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T16b-01 failed: ${message}`);
}

async function tenant(label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await db.insert(ssoTenants).values({
    companyName: `IT-T16b ${label}`,
    domain: `it-t16b-${label}-${suffix}.test`,
    supabaseProviderId: `it-t16b-${suffix}`,
  }).returning({ id: ssoTenants.id });
  return row.id;
}

async function main(): Promise<void> {
  if (process.env.TASK6_EPHEMERAL_DATABASE !== '1') {
    throw new Error('TASK6_EPHEMERAL_DATABASE=1 is required (run through scripts/it-db.sh)');
  }
  const companyA = await tenant('a');
  const companyB = await tenant('b');
  const actorId = randomUUID();

  // (a) valid event inside a transaction; Company A sees it, Company B does not.
  const machineA = await db.transaction(async (tx) => {
    const [machine] = await tx.insert(developerMachines).values({
      tenantId: companyA, installationId: `it-${randomUUID()}`, displayName: 'IT-T16b laptop',
    }).returning({ id: developerMachines.id });
    await recordAuditEvent(tx, companyA, {
      action: 'machine.registered', actorType: 'tenant_admin', actorId,
      targetType: 'developer_machine', targetId: machine.id,
      details: { installationId: 'it-install', displayName: 'IT-T16b laptop', request_id: 'it-t16b-01a' },
    });
    return machine.id;
  });
  const seenByA = await withTenant(db, companyA).select(securityAuditEvents, eq(securityAuditEvents.targetId, machineA));
  const seenByB = await withTenant(db, companyB).select(securityAuditEvents, eq(securityAuditEvents.targetId, machineA));
  check(seenByA.length === 1 && seenByA[0].action === 'machine.registered', 'Company A reads its audit row');
  check(seenByA[0].tenantId === companyA, 'the row carries Company A');
  check(seenByB.length === 0, 'Company B cannot read Company A\'s audit row');
  console.log('IT-T16b-01a ok: recorded in a transaction; visible to A, invisible to B');

  // (b) a contract error rolls back the transaction's other write.
  const installationId = `it-${randomUUID()}`;
  let refused: AuditContractError | null = null;
  try {
    await db.transaction(async (tx) => {
      const [machine] = await tx.insert(developerMachines).values({
        tenantId: companyA, installationId, displayName: 'IT-T16b rollback',
      }).returning({ id: developerMachines.id });
      await recordAuditEvent(tx, companyA, {
        action: 'machine.registered', actorType: 'tenant_admin', actorId,
        targetType: 'developer_machine', targetId: machine.id,
        details: { installationId, displayName: 'IT-T16b rollback', unexpected: true },
      });
    });
  } catch (error) {
    if (!(error instanceof AuditContractError)) throw error;
    refused = error;
  }
  check(refused?.code === 'AUDIT_DETAILS_INVALID', 'the invalid event is refused with AUDIT_DETAILS_INVALID');
  const leftover = await db.select({ id: developerMachines.id }).from(developerMachines).where(and(
    eq(developerMachines.tenantId, companyA), eq(developerMachines.installationId, installationId),
  ));
  check(leftover.length === 0, 'the machine written before the refused audit event rolled back');
  // A reserved action fails the same way.
  let reserved: AuditContractError | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(developerMachines).values({ tenantId: companyA, installationId, displayName: 'IT-T16b reserved' });
      await recordAuditEvent(tx, companyA, {
        action: 'fleet.lease.issued', actorType: 'service', actorId: 'it', targetType: 'developer_machine',
        targetId: randomUUID(), details: {},
      });
    });
  } catch (error) {
    if (!(error instanceof AuditContractError)) throw error;
    reserved = error;
  }
  check(reserved?.code === 'AUDIT_RESERVED_ACTION', 'a reserved action is refused');
  const stillNone = await db.select({ id: developerMachines.id }).from(developerMachines).where(and(
    eq(developerMachines.tenantId, companyA), eq(developerMachines.installationId, installationId),
  ));
  check(stillNone.length === 0, 'the reserved-action transaction rolled back too');
  console.log('IT-T16b-01b ok: a contract error (unknown key, reserved action) rolls back the transaction\'s other write');

  // (c) round-trip through the v1 schema with the derived fields.
  const schemaPath = resolve(__dirname, '../../../../../docs/contracts/audit/event-v1.schema.json');
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  const stored = seenByA[0];
  const entry = AUDIT_CATALOG_BY_ACTION.get(stored.action);
  check(entry, 'the stored action is in the catalog');
  const apiRow = {
    id: stored.id,
    action: stored.action,
    actor_type: stored.actorType,
    actor_id: stored.actorId,
    target_type: stored.targetType,
    target_id: stored.targetId,
    details: stored.details,
    occurred_at: stored.occurredAt.toISOString(),
    severity: entry.severity,
    catalog_version: AUDIT_CATALOG_VERSION,
  };
  check(validate(apiRow), `the stored row matches event-v1.schema.json (${ajv.errorsText(validate.errors)})`);
  // jsonb orders keys its own way; compare values, not key order.
  check(isDeepStrictEqual(stored.details, {
    installationId: 'it-install', displayName: 'IT-T16b laptop', request_id: 'it-t16b-01a',
  }), 'details are stored exactly as recorded');
  console.log(`IT-T16b-01c ok: row round-trips through event-v1 (severity ${entry.severity}, catalog_version ${AUDIT_CATALOG_VERSION})`);
  console.log('IT-T16b-01 passed');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'IT-T16b-01 failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
