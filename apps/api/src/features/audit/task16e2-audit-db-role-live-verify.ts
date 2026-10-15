/**
 * IT-T16e2-01: the audit reader role is SELECT-only and tenant-bound on real
 * PostgreSQL. Run only through scripts/it-db.sh against its throwaway database.
 *
 * Ported from SushiCorp IT-ID2-02 @ 0bd67a5 (catalog AU-1). Deviations:
 * TrackAI grants only its audit tables and binds RLS with trackai.tenant_id.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { recordAuditEvent } from '../../core/audit/record';
import { db, pool } from '../../core/db';
import { withAuditReader } from '../../core/db/audit-reader';
import type { SealDatabase } from '../attesta/audit-seal-service';
import { readVerifySnapshot } from './verify-service';

const A = randomUUID();
const B = randomUUID();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`IT-T16e2 failed: ${message}`);
}

async function seedTenant(id: string, label: string): Promise<void> {
  const slug = `it-t16e2-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `insert into sso_tenants (id, company_name, domain, supabase_provider_id)
     values ($1, $2, $3, $4)`,
    [id, `IT Task16e2 ${label}`, `${slug}.example`, slug],
  );
  await recordAuditEvent(db, id, {
    action: 'audit.events.read',
    actorType: 'tenant_auditor',
    actorId: `auditor-${label}`,
    targetType: 'security_audit_events',
    targetId: id,
    details: { limit: 1, returned: 0, filters: [], request_id: `it-t16e2-${label}` },
  });
}

async function seedSyntheticSeal(tenantId: string, minute: number): Promise<void> {
  const client = await pool.connect();
  try {
    // The test is about 0024's privileges and RLS, not 0023's seal guard. The
    // throwaway database owner bypasses triggers/FKs only for this synthetic row.
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into attesta_audit_seals
       (tenant_id, window_from, window_to, row_count, previous_digest, seal_document,
        seal_digest, record_id, statement_digest)
       values ($1, $2, $3, 0, null, '{}', $4, $5, $6)`,
      [tenantId, `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000000Z`,
        `2026-01-01T00:${String(minute + 1).padStart(2, '0')}:00.000000Z`,
        `sha256:${minute.toString(16).padStart(64, '0')}`, randomUUID(),
        `sha256:${(minute + 10).toString(16).padStart(64, '0')}`],
    );
  } finally {
    await client.query('set session_replication_role = origin').catch(() => undefined);
    client.release();
  }
}

async function denied(statement: string, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('trackai.tenant_id', $1, true)`, [A]);
    await client.query('set local role trackai_audit_reader');
    try {
      await client.query(statement);
    } catch (error) {
      check((error as { code?: string }).code === '42501', `${label}: expected SQLSTATE 42501`);
      return;
    }
    throw new Error(`IT-T16e2 failed: ${label}: statement was allowed`);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function selectAsReader(setting: string | undefined, table: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (setting !== undefined) await client.query(`select set_config('trackai.tenant_id', $1, true)`, [setting]);
    await client.query('set local role trackai_audit_reader');
    const result = await client.query(`select tenant_id::text as tenant_id from ${table} order by tenant_id`);
    return result.rows.map(row => String(row.tenant_id));
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const database = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  check(process.env.TASK5_EPHEMERAL_DATABASE === '1' && database === 'trackai', 'must run through scripts/it-db.sh');

  await seedTenant(A, 'a');
  await seedTenant(B, 'b');
  await seedSyntheticSeal(A, 0);
  await seedSyntheticSeal(B, 2);

  // (a) No write privilege on either granted table, and no read privilege elsewhere.
  for (const table of ['security_audit_events', 'attesta_audit_seals']) {
    await denied(`insert into ${table} default values`, `${table} insert`);
    await denied(`update ${table} set tenant_id = tenant_id where false`, `${table} update`);
    await denied(`delete from ${table} where false`, `${table} delete`);
    await denied(`truncate ${table}`, `${table} truncate`);
  }
  await denied('select * from sso_tenants limit 1', 'other-table select');
  check(JSON.stringify(await selectAsReader(A, 'security_audit_events')) === JSON.stringify([A]),
    'audit events did not return exactly tenant A');
  check(JSON.stringify(await selectAsReader(A, 'attesta_audit_seals')) === JSON.stringify([A]),
    'audit seals did not return exactly tenant A');

  // (b) Missing and pooled-empty settings match nothing.
  check((await selectAsReader(undefined, 'security_audit_events')).length === 0, 'unset tenant matched rows');
  check((await selectAsReader('', 'security_audit_events')).length === 0, 'empty tenant matched rows');
  check((await selectAsReader(undefined, 'attesta_audit_seals')).length === 0, 'unset tenant matched seals');
  check((await selectAsReader('', 'attesta_audit_seals')).length === 0, 'empty tenant matched seals');

  const snapshot = await readVerifySnapshot(db as unknown as SealDatabase, A, {
    from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z',
  });
  check(snapshot.seals.length === 1, 'verify snapshot did not read tenant A seal');

  // (c) The helper resets before the read receipt is written in the same transaction.
  const [{ apiUser }] = (await db.execute<{ apiUser: string }>(sql`select current_user as "apiUser"`)).rows;
  await db.transaction(async tx => {
    const rows = await withAuditReader(tx, A, reader => reader.execute(sql`
      select tenant_id from security_audit_events order by occurred_at`));
    check(rows.rows.length === 1, 'helper did not return tenant A row');
    const [{ currentUser }] = (await tx.execute<{ currentUser: string }>(sql`select current_user as "currentUser"`)).rows;
    check(currentUser === apiUser, 'helper did not reset to the API role');
    await recordAuditEvent(tx, A, {
      action: 'audit.events.read', actorType: 'tenant_auditor', actorId: 'auditor-a',
      targetType: 'security_audit_events', targetId: A,
      details: { limit: 1, returned: 1, filters: [], request_id: 'it-t16e2-helper' },
    });
  });
  const receipt = await pool.query(
    `select count(*)::int as n from security_audit_events where tenant_id = $1 and details->>'request_id' = 'it-t16e2-helper'`,
    [A],
  );
  check(receipt.rows[0].n === 1, 'same transaction did not write the read receipt');

  console.log('IT-T16e2-01 PASS writes_denied=8 other_table=denied tenant_rows=isolated empty_unset=empty role_reset=yes audit_write=yes');
}

main().then(() => pool.end()).catch(async error => {
  console.error(error instanceof Error ? error.message : 'IT-T16e2 failed');
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
