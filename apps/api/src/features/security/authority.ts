/**
 * The real security v2 authority (Task20f, D5): Task20d's `SecurityV2Authority` over the
 * lease and data-settings tables. With it, ingest accepts records only while the
 * credential's machine holds a current, non-`off` lease.
 */
import type { SecurityLeaseView, SecurityV2Authority } from '../security-findings/v2-authority';
import type { SecurityLeaseStore, StoredLease } from './lease';

function view(lease: StoredLease): SecurityLeaseView {
  return { leaseId: lease.id, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt };
}

export function createSecurityV2Authority(store: SecurityLeaseStore): SecurityV2Authority {
  return {
    /**
     * Only the machine's newest lease counts, and only while it is not `off` and
     * `issued_at <= now < expires_at`: an older monitor lease never revives after an
     * `off` lease has been issued. The tenant's current switch is checked too, so turning
     * monitoring off stops ingest at once, not only at the Endpoint's next refresh
     * (the server is authoritative; independent review, part b).
     */
    async currentLease(tenantId, machineId, now) {
      const newest = await store.newestLease(tenantId, machineId);
      if (!newest || newest.mode === 'off') return null;
      if ((await store.issuanceState(tenantId)).monitorMode === 'off') return null;
      if (now.getTime() < newest.issuedAt.getTime() || now.getTime() >= newest.expiresAt.getTime()) return null;
      return view(newest);
    },
    /** Any non-`off` lease ever issued to this machine (provenance of a past finding). */
    async leaseForMachine(tenantId, machineId, leaseId) {
      const lease = await store.leaseById(tenantId, machineId, leaseId);
      return lease && lease.mode !== 'off' ? view(lease) : null;
    },
    /** The newest data-settings version; null (all off) when the tenant has none. */
    currentDataSettings: (tenantId) => store.currentDataSettings(tenantId),
  };
}
