export const CLIENT_DELIVERY_HEALTH_VERSION = 1 as const;
export const MAX_CLIENT_DELIVERY_HEALTH_COUNT = 1_000_000;
export const MAX_CLIENT_HEALTH_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MAX_CLIENT_HEALTH_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type ClientDeliveryHealthReport = {
  version: typeof CLIENT_DELIVERY_HEALTH_VERSION;
  observedAt: Date;
  pendingRetryable: number;
  waitingRetry: number;
  processing: number;
  quarantined: number;
  rowsWithErrors: number;
  oldestPendingAt: Date | null;
  lastDeliveredAt: Date | null;
};

const fields = [
  'version', 'observedAt', 'pendingRetryable', 'waitingRetry', 'processing',
  'quarantined', 'rowsWithErrors', 'oldestPendingAt', 'lastDeliveredAt',
] as const;

function timestamp(value: unknown, name: string, nullable: boolean): Date | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be an ISO timestamp${nullable ? ' or null' : ''}`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0
    || Number(value) > MAX_CLIENT_DELIVERY_HEALTH_COUNT) {
    throw new Error(`${name} must be an integer between 0 and ${MAX_CLIENT_DELIVERY_HEALTH_COUNT}`);
  }
  return Number(value);
}

export function validateClientDeliveryHealthReport(
  value: unknown,
  receivedAt = new Date(),
): ClientDeliveryHealthReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Client delivery health report must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.includes(key as typeof fields[number]))) {
    throw new Error('Client delivery health report contains an unsupported field');
  }
  if (input.version !== CLIENT_DELIVERY_HEALTH_VERSION) {
    throw new Error('Unsupported client delivery health report version');
  }
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('Health report receipt time is invalid');
  const observedAt = timestamp(input.observedAt, 'observedAt', false)!;
  if (observedAt.getTime() > receivedAt.getTime() + MAX_CLIENT_HEALTH_CLOCK_SKEW_MS) {
    throw new Error('Client delivery health report is too far in the future');
  }
  if (observedAt.getTime() < receivedAt.getTime() - MAX_CLIENT_HEALTH_AGE_MS) {
    throw new Error('Client delivery health report is too old');
  }
  const oldestPendingAt = timestamp(input.oldestPendingAt, 'oldestPendingAt', true);
  const lastDeliveredAt = timestamp(input.lastDeliveredAt, 'lastDeliveredAt', true);
  if (oldestPendingAt && oldestPendingAt > observedAt) {
    throw new Error('oldestPendingAt cannot be later than observedAt');
  }
  if (lastDeliveredAt && lastDeliveredAt > observedAt) {
    throw new Error('lastDeliveredAt cannot be later than observedAt');
  }
  return {
    version: CLIENT_DELIVERY_HEALTH_VERSION,
    observedAt,
    pendingRetryable: count(input.pendingRetryable, 'pendingRetryable'),
    waitingRetry: count(input.waitingRetry, 'waitingRetry'),
    processing: count(input.processing, 'processing'),
    quarantined: count(input.quarantined, 'quarantined'),
    rowsWithErrors: count(input.rowsWithErrors, 'rowsWithErrors'),
    oldestPendingAt,
    lastDeliveredAt,
  };
}
