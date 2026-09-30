import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { tenantSecurityMonitorSettings } from '../../core/db/schema';

const REFRESH_INTERVAL_MS = 60_000;
const LEASE_LIFETIME_MS = 300_000;

export interface SecurityActivationSetting {
  mode: 'off' | 'monitor';
  version: number;
  validUntil: Date | null;
  revokedAt: Date | null;
}

export interface SecurityActivationLease {
  schemaVersion: 'trackai.security-activation/0.1';
  mode: 'off' | 'monitor';
  version: number;
  issuedAt: string;
  refreshAfter: string;
  expiresAt: string;
}

interface SecurityActivationRequest {
  tenantId?: string;
  machineId?: string;
  managedMachineCredential?: boolean;
}

interface SecurityActivationResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(payload: unknown): unknown };
}

interface SecurityActivationDependencies {
  load(tenantId: string, machineId: string, now: Date): Promise<SecurityActivationLease>;
  logError(message: string): void;
}

export function createSecurityActivationLease(
  setting: SecurityActivationSetting | null,
  now: Date,
): SecurityActivationLease {
  const active = setting?.mode === 'monitor'
    && setting.revokedAt === null
    && (setting.validUntil === null || setting.validUntil.getTime() > now.getTime());
  const normalExpiry = new Date(now.getTime() + LEASE_LIFETIME_MS);
  const expiresAt = active && setting.validUntil !== null
    && setting.validUntil.getTime() < normalExpiry.getTime()
    ? setting.validUntil
    : normalExpiry;
  const normalRefresh = new Date(now.getTime() + REFRESH_INTERVAL_MS);
  const refreshAfter = normalRefresh.getTime() < expiresAt.getTime()
    ? normalRefresh
    : expiresAt;

  return {
    schemaVersion: 'trackai.security-activation/0.1',
    mode: active ? 'monitor' : 'off',
    version: setting?.version ?? 0,
    issuedAt: now.toISOString(),
    refreshAfter: refreshAfter.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function loadSecurityActivationLease(
  tenantId: string,
  _machineId: string,
  now: Date,
): Promise<SecurityActivationLease> {
  const [setting] = await db.select({
    mode: tenantSecurityMonitorSettings.mode,
    version: tenantSecurityMonitorSettings.version,
    validUntil: tenantSecurityMonitorSettings.validUntil,
    revokedAt: tenantSecurityMonitorSettings.revokedAt,
  }).from(tenantSecurityMonitorSettings).where(
    eq(tenantSecurityMonitorSettings.tenantId, tenantId),
  ).limit(1);

  return createSecurityActivationLease(setting ?? null, now);
}

export function createSecurityActivationHandler(
  dependencies: SecurityActivationDependencies = {
    load: loadSecurityActivationLease,
    logError: message => console.error(message),
  },
) {
  return async (
    req: SecurityActivationRequest,
    res: SecurityActivationResponse,
  ): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.managedMachineCredential !== true || !req.tenantId || !req.machineId) {
      res.status(403).json({ error: 'Managed machine authentication is required' });
      return;
    }

    try {
      const lease = await dependencies.load(req.tenantId, req.machineId, new Date());
      res.status(200).json(lease);
    } catch {
      dependencies.logError('Security activation refresh failed');
      res.status(503).json({ error: 'Security activation is temporarily unavailable' });
    }
  };
}
