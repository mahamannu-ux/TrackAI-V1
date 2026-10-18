/**
 * The Postgres lease store (Task20f, D1/D4): security_activation_leases and
 * security_acknowledgements, both append-only, read and written only through
 * `withTenant()`; every machine-bound read also filters on the credential's machine.
 * Audit rows are written in the same transaction as the row they describe.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { recordAuditEvent } from '../../core/audit';
import {
  developerMachines,
  securityAcknowledgements,
  securityActivationLeases,
  securityDataSettingsVersions,
  securityRuleBundles,
} from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import type { SecurityDataSettingsV1 } from '../security-findings/v2-contract';
import type { LeaseIssuanceState, SecurityLeaseStore, StoredBundleRef, StoredLease } from './lease';
import { leaseSettingsFromRow } from './service';
import { defaultLeaseSettings } from './settings';

type Database = typeof db;

function storedLease(row: typeof securityActivationLeases.$inferSelect): StoredLease {
  return {
    id: row.id,
    machineId: row.machineId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    mode: row.mode,
    bundleDigest: row.bundleDigest,
    dataSettingsVersion: row.dataSettingsVersion,
    envelope: row.envelope,
    keyid: row.keyid,
  };
}

async function newestLeaseWith(database: Database, tenantId: string, machineId: string): Promise<StoredLease | null> {
  const [row] = await withTenant(database, tenantId)
    .select(securityActivationLeases, eq(securityActivationLeases.machineId, machineId))
    .orderBy(desc(securityActivationLeases.issuedAt), desc(securityActivationLeases.id))
    .limit(1);
  return row ? storedLease(row) : null;
}

async function bundleRef(database: Database, tenantId: string, digest: string): Promise<StoredBundleRef | null> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const [row] = await withTenant(database, tenantId)
    .select(securityRuleBundles, eq(securityRuleBundles.digest, digest)).limit(1);
  return row ? { id: row.id, digest: row.digest, epoch: row.epoch, bundleVersion: row.bundleVersion } : null;
}

async function issuanceStateWith(database: Database, tenantId: string): Promise<LeaseIssuanceState> {
  const tenant = withTenant(database, tenantId);
  const [data] = await tenant.select(securityDataSettingsVersions)
    .orderBy(desc(securityDataSettingsVersions.version)).limit(1);
  const [bundle] = await tenant.select(securityRuleBundles).orderBy(desc(securityRuleBundles.epoch)).limit(1);
  return {
    bundle: bundle ? { id: bundle.id, digest: bundle.digest, epoch: bundle.epoch, bundleVersion: bundle.bundleVersion } : null,
    dataSettingsVersion: data?.version ?? 0,
    monitorMode: data?.monitorMode ?? 'off',
    settings: data ? leaseSettingsFromRow(data) : defaultLeaseSettings(),
  };
}

export function pgSecurityLeaseStore(database: Database = db): SecurityLeaseStore {
  return {
    async machineIsActive(tenantId, machineId) {
      const [machine] = await withTenant(database, tenantId).select(
        developerMachines,
        and(eq(developerMachines.id, machineId), eq(developerMachines.status, 'active')),
      ).limit(1);
      return Boolean(machine);
    },

    issuanceState: (tenantId) => issuanceStateWith(database, tenantId),

    newestLease: (tenantId, machineId) => newestLeaseWith(database, tenantId, machineId),

    async leaseById(tenantId, machineId, leaseId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(leaseId)) return null;
      const [row] = await withTenant(database, tenantId).select(securityActivationLeases, and(
        eq(securityActivationLeases.machineId, machineId),
        eq(securityActivationLeases.id, leaseId),
      )).limit(1);
      return row ? storedLease(row) : null;
    },

    async insertLease(tenantId, lease, epoch, decide) {
      return database.transaction(async transaction => {
        const tx = transaction as unknown as Database;
        // Shared with every other lease insert, exclusive against a settings publish
        // (service.ts takes the same key exclusively): no publish commits between the
        // re-read below and this insert.
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`security_settings:${tenantId}`}, 0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`security_lease:${tenantId}:${lease.machineId}`}, 0))`);
        const current = await issuanceStateWith(tx, tenantId);
        const newest = await newestLeaseWith(tx, tenantId, lease.machineId);
        const decision = decide(newest, current);
        if (decision === 'stale') return null;
        if (decision === 'serve' && newest) return newest;
        await withTenant(tx, tenantId).insert(securityActivationLeases, {
          id: lease.id,
          machineId: lease.machineId,
          issuedAt: lease.issuedAt,
          expiresAt: lease.expiresAt,
          mode: lease.mode,
          bundleDigest: lease.bundleDigest,
          dataSettingsVersion: lease.dataSettingsVersion,
          envelope: lease.envelope,
          keyid: lease.keyid,
        });
        await recordAuditEvent(transaction, tenantId, {
          actorType: 'machine',
          actorId: lease.machineId,
          action: 'fleet.lease.issued',
          targetType: 'developer_machine',
          targetId: lease.machineId,
          details: {
            lease_id: lease.id,
            expires_at: lease.expiresAt.toISOString(),
            mode: lease.mode,
            bundle_digest: lease.bundleDigest,
            epoch,
          },
        });
        return lease;
      });
    },

    bundleByDigest: (tenantId, digest) => bundleRef(database, tenantId, digest),

    async bundleEnvelope(tenantId, digest) {
      if (!/^[a-f0-9]{64}$/.test(digest)) return null;
      const [row] = await withTenant(database, tenantId)
        .select(securityRuleBundles, eq(securityRuleBundles.digest, digest)).limit(1);
      return row?.envelope ?? null;
    },

    async currentDataSettings(tenantId): Promise<SecurityDataSettingsV1 | null> {
      const [data] = await withTenant(database, tenantId).select(securityDataSettingsVersions)
        .orderBy(desc(securityDataSettingsVersions.version)).limit(1);
      return data ? leaseSettingsFromRow(data).data : null;
    },

    async recordAcknowledgement(record, bundle) {
      await database.transaction(async transaction => {
        await withTenant(transaction as unknown as Database, record.tenantId).insert(securityAcknowledgements, {
          machineId: record.machineId,
          leaseId: record.lease.id,
          bundleDigest: record.bundleDigest,
          result: record.result,
          refusalCode: record.refusalCode,
          receivedAt: record.receivedAt,
        });
        if (record.result === 'applied' && bundle) {
          await recordAuditEvent(transaction, record.tenantId, {
            actorType: 'machine',
            actorId: record.machineId,
            action: 'policy.bundle.acknowledged',
            targetType: 'policy_bundle',
            targetId: bundle.id,
            details: {
              machine_id: record.machineId,
              version: bundle.bundleVersion,
              epoch: bundle.epoch,
              lease_id: record.lease.id,
              bundle_digest: bundle.digest,
            },
          });
        } else {
          await recordAuditEvent(transaction, record.tenantId, {
            actorType: 'machine',
            actorId: record.machineId,
            action: 'fleet.lease.refused',
            targetType: 'developer_machine',
            targetId: record.machineId,
            details: {
              lease_id: record.lease.id,
              bundle_digest: record.bundleDigest,
              refusal: record.refusalCode,
            },
          });
        }
      });
    },
  };
}
