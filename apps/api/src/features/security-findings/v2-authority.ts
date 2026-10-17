/**
 * Security v2 authority (Task20d): the lease and data-settings view that ingest
 * needs, supplied by Task20f's database implementation. Until then the
 * unavailable authority resolves null everywhere, which refuses every upload
 * with SECURITY_V2_LEASE_REQUIRED (fail-closed, AGENTS.md §9 item 9).
 */
import type { SecurityDataSettingsV1 } from './v2-contract';

export interface SecurityLeaseView {
  leaseId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface SecurityV2Authority {
  currentLease(tenantId: string, machineId: string, now: Date): Promise<SecurityLeaseView | null>;
  leaseForMachine(
    tenantId: string,
    machineId: string,
    leaseId: string,
  ): Promise<SecurityLeaseView | null>;
  currentDataSettings(tenantId: string): Promise<SecurityDataSettingsV1 | null>;
}

/** null data settings mean the conservative default: all five switches false. */
export const unavailableSecurityV2Authority: SecurityV2Authority = {
  async currentLease() {
    return null;
  },
  async leaseForMachine() {
    return null;
  },
  async currentDataSettings() {
    return null;
  },
};
