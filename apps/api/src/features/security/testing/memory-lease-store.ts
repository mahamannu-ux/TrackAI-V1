/**
 * An in-memory SecurityLeaseStore for unit tests (no database). It keeps the same
 * bindings as the Postgres store: every read is tenant-bound, machine reads filter on
 * the machine, and each audit event goes through the real `buildAuditRow`, so a row the
 * catalogue would refuse fails the test.
 */
import { buildAuditRow, type AuditEvent } from '../../../core/audit';
import type { SecurityDataSettingsV1 } from '../../security-findings/v2-contract';
import type { AcknowledgementRecord, LeaseIssuanceState, SecurityLeaseStore, StoredBundleRef, StoredLease } from '../lease';
import { defaultLeaseSettings, type LeaseSettings, type MonitorMode } from '../settings';

interface TenantState {
  machines: Map<string, 'active' | 'revoked'>;
  bundles: Array<StoredBundleRef & { envelope: Buffer }>;
  data: Array<{ version: number; monitorMode: MonitorMode; settings: LeaseSettings }>;
  leases: StoredLease[];
  acknowledgements: AcknowledgementRecord[];
}

export interface MemoryLeaseStore extends SecurityLeaseStore {
  tenants: Map<string, TenantState>;
  audit: Array<{ tenantId: string; action: string; details: Record<string, unknown> }>;
  addMachine(tenantId: string, machineId: string, status?: 'active' | 'revoked'): void;
  addBundle(tenantId: string, bundle: StoredBundleRef & { envelope: Buffer }): void;
  setData(tenantId: string, monitorMode: MonitorMode, settings?: Partial<LeaseSettings>): number;
}

export function memoryLeaseStore(): MemoryLeaseStore {
  const tenants = new Map<string, TenantState>();
  const audit: MemoryLeaseStore['audit'] = [];
  const of = (tenantId: string): TenantState => {
    let state = tenants.get(tenantId);
    if (!state) {
      state = { machines: new Map(), bundles: [], data: [], leases: [], acknowledgements: [] };
      tenants.set(tenantId, state);
    }
    return state;
  };
  const record = (tenantId: string, event: AuditEvent) => {
    const row = buildAuditRow(tenantId, event);
    audit.push({ tenantId, action: row.action, details: row.details as Record<string, unknown> });
  };
  const newest = (tenantId: string, machineId: string) => {
    const leases = of(tenantId).leases.filter(lease => lease.machineId === machineId);
    return leases.reduce<StoredLease | null>((best, lease) => (!best || lease.issuedAt >= best.issuedAt ? lease : best), null);
  };
  return {
    tenants,
    audit,
    addMachine(tenantId, machineId, status = 'active') {
      of(tenantId).machines.set(machineId, status);
    },
    addBundle(tenantId, bundle) {
      of(tenantId).bundles.push(bundle);
    },
    setData(tenantId, monitorMode, settings = {}) {
      const state = of(tenantId);
      const version = state.data.length + 1;
      state.data.push({ version, monitorMode, settings: { ...defaultLeaseSettings(), ...settings } });
      return version;
    },

    async machineIsActive(tenantId, machineId) {
      return of(tenantId).machines.get(machineId) === 'active';
    },
    async issuanceState(tenantId): Promise<LeaseIssuanceState> {
      const state = of(tenantId);
      const bundle = state.bundles.reduce<StoredBundleRef | null>((best, row) => (!best || row.epoch > best.epoch ? row : best), null);
      const data = state.data.at(-1);
      return {
        bundle: bundle ? { id: bundle.id, digest: bundle.digest, epoch: bundle.epoch, bundleVersion: bundle.bundleVersion } : null,
        dataSettingsVersion: data?.version ?? 0,
        monitorMode: data?.monitorMode ?? 'off',
        settings: data?.settings ?? defaultLeaseSettings(),
      };
    },
    async newestLease(tenantId, machineId) {
      return newest(tenantId, machineId);
    },
    async leaseById(tenantId, machineId, leaseId) {
      return of(tenantId).leases.find(lease => lease.id === leaseId && lease.machineId === machineId) ?? null;
    },
    async insertLease(tenantId, lease, epoch, keep) {
      const latest = newest(tenantId, lease.machineId);
      if (latest && keep(latest)) return latest;
      of(tenantId).leases.push(lease);
      record(tenantId, {
        actorType: 'machine', actorId: lease.machineId, action: 'fleet.lease.issued',
        targetType: 'developer_machine', targetId: lease.machineId,
        details: { lease_id: lease.id, expires_at: lease.expiresAt.toISOString(), mode: lease.mode, bundle_digest: lease.bundleDigest, epoch },
      });
      return lease;
    },
    async bundleByDigest(tenantId, digest) {
      const row = of(tenantId).bundles.find(bundle => bundle.digest === digest);
      return row ? { id: row.id, digest: row.digest, epoch: row.epoch, bundleVersion: row.bundleVersion } : null;
    },
    async bundleEnvelope(tenantId, digest) {
      return of(tenantId).bundles.find(bundle => bundle.digest === digest)?.envelope ?? null;
    },
    async currentDataSettings(tenantId): Promise<SecurityDataSettingsV1 | null> {
      return of(tenantId).data.at(-1)?.settings.data ?? null;
    },
    async recordAcknowledgement(ack, bundle) {
      of(ack.tenantId).acknowledgements.push(ack);
      if (ack.result === 'applied' && bundle) {
        record(ack.tenantId, {
          actorType: 'machine', actorId: ack.machineId, action: 'policy.bundle.acknowledged',
          targetType: 'policy_bundle', targetId: bundle.id,
          details: { machine_id: ack.machineId, version: bundle.bundleVersion, epoch: bundle.epoch, lease_id: ack.lease.id, bundle_digest: bundle.digest },
        });
      } else {
        record(ack.tenantId, {
          actorType: 'machine', actorId: ack.machineId, action: 'fleet.lease.refused',
          targetType: 'developer_machine', targetId: ack.machineId,
          details: { lease_id: ack.lease.id, bundle_digest: ack.bundleDigest, refusal: ack.refusalCode },
        });
      }
    },
  };
}
