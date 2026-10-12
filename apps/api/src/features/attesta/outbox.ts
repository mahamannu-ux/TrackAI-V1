/**
 * Attesta outbox writer (Task15c; frozen contract docs/contracts/attesta/outbox.md).
 *
 * Task2 (A15.7, Codex) calls enqueueAttestaSubject inside the transaction that
 * records the observation, so the pointer row commits or rolls back with it.
 * Nothing here signs, builds or waits: the Attesta worker does that later.
 *
 * Tenant binding: the insert succeeds only if every source row exists in the
 * same tenant and agrees with the pointer (repository, sha, merge, deployment
 * status). The table has no foreign keys to those rows (outbox.md, "Why no
 * source foreign keys").
 *
 * Idempotency: one database key per kind; a replay returns the existing row,
 * and a replay whose pointer differs from the stored one is refused, never
 * silently merged.
 */
import { sql, type SQL } from 'drizzle-orm';

export type AttestaSubjectKind = 'commit_observed' | 'pr_merged' | 'deployed';

export const ATTESTA_SUBJECT_KINDS: readonly AttestaSubjectKind[] = ['commit_observed', 'pr_merged', 'deployed'];

interface CommonInput {
  tenantId: string;
  repositoryId: string;
  commitSha: string;
  /** Earliest time the worker may build the statement (default: now). */
  notBefore?: Date;
}

export interface CommitObservedInput extends CommonInput {
  kind: 'commit_observed';
  /** telemetry_metric_events.id of the Git AI commit-note event being normalized. */
  metricEventId: string;
  /** scm_commits.id the note normalized into. */
  commitId: string;
}

export interface PrMergedInput extends CommonInput {
  kind: 'pr_merged';
  provider: string;
  /** provider_event_deliveries.delivery_id of the merged pull_request delivery. */
  providerDeliveryId: string;
  /** scm_pull_requests.id. commitSha is its merge_commit_sha. */
  pullRequestId: string;
}

export interface DeployedInput extends CommonInput {
  kind: 'deployed';
  provider: string;
  /** The deployment_status delivery, when known. */
  providerDeliveryId?: string | null;
  /** scm_deployments.id of the production success row. commitSha is its sha. */
  deploymentId: string;
  deploymentExternalId: string;
  deploymentStatus: 'success';
}

export type EnqueueAttestaSubjectInput = CommitObservedInput | PrMergedInput | DeployedInput;

export interface EnqueueAttestaSubjectResult {
  id: string;
  /** false when the row already existed (a replay of the same observation). */
  inserted: boolean;
}

export type AttestaOutboxErrorCode =
  | 'ATTESTA_OUTBOX_INVALID_INPUT'
  | 'ATTESTA_OUTBOX_SOURCE_NOT_FOUND'
  | 'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT';

export class AttestaOutboxError extends Error {
  constructor(readonly code: AttestaOutboxErrorCode, message: string) {
    super(message);
    this.name = 'AttestaOutboxError';
  }
}

/** Anything that can run a drizzle SQL statement: the caller's transaction (or db). */
export interface AttestaOutboxExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** telemetry_metric_events.event_kind of Git AI commit and rewrite-commit events (decoder.ts EVENT_KIND). */
const COMMIT_EVENT_KINDS = [1, 7] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const BOUNDED_ID = /^[^\u0000-\u001f\u007f]{1,128}$/;

const KEYS: Record<AttestaSubjectKind, readonly string[]> = {
  commit_observed: ['kind', 'tenantId', 'repositoryId', 'commitSha', 'notBefore', 'metricEventId', 'commitId'],
  pr_merged: ['kind', 'tenantId', 'repositoryId', 'commitSha', 'notBefore', 'provider', 'providerDeliveryId', 'pullRequestId'],
  deployed: ['kind', 'tenantId', 'repositoryId', 'commitSha', 'notBefore', 'provider', 'providerDeliveryId', 'deploymentId', 'deploymentExternalId', 'deploymentStatus'],
};

/** The validated pointer: plain values copied once from the input (no getters re-read later). */
export interface NormalizedSubject {
  kind: AttestaSubjectKind;
  tenantId: string;
  repositoryId: string;
  commitSha: string;
  notBefore: Date | null;
  metricEventId: string | null;
  commitId: string | null;
  provider: string | null;
  providerDeliveryId: string | null;
  pullRequestId: string | null;
  deploymentId: string | null;
  deploymentExternalId: string | null;
  deploymentStatus: 'success' | null;
}

const invalid = (message: string) => new AttestaOutboxError('ATTESTA_OUTBOX_INVALID_INPUT', message);

function readUuid(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${key} must be a lowercase UUID`);
  return value;
}

function readDate(record: Record<string, unknown>, key: string): Date | null {
  const value = record[key];
  if (value === undefined) return null;
  if (!(value instanceof Date)) throw invalid(`${key} must be a Date`);
  const time = value.getTime();
  // Years 1970-9999 only: toISOString() of later years is not a timestamptz literal.
  if (!Number.isFinite(time) || time < 0 || time > 253402300799999) throw invalid(`${key} is not a valid time`);
  return new Date(time);
}

function readPattern(record: Record<string, unknown>, key: string, pattern: RegExp, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(`${key} must be ${what}`);
  return value;
}

/**
 * Validates the input and returns a plain snapshot. Exported for unit tests and
 * for callers that want to fail before opening a transaction.
 */
export function normalizeAttestaSubjectInput(input: unknown): NormalizedSubject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('input must be an object');
  // Snapshot own enumerable data once; every later read uses this copy.
  const record: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const kind = record.kind;
  if (typeof kind !== 'string' || !(ATTESTA_SUBJECT_KINDS as readonly string[]).includes(kind)) {
    throw invalid('kind must be commit_observed, pr_merged or deployed');
  }
  const typedKind = kind as AttestaSubjectKind;
  const allowed = KEYS[typedKind];
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw invalid(`unexpected field(s) for ${typedKind}: ${unexpected.sort().join(', ')}`);

  const base: NormalizedSubject = {
    kind: typedKind,
    tenantId: readUuid(record, 'tenantId'),
    repositoryId: readUuid(record, 'repositoryId'),
    commitSha: readPattern(record, 'commitSha', GIT_SHA, 'a 40 or 64 character lowercase hex git sha'),
    notBefore: readDate(record, 'notBefore'),
    metricEventId: null,
    commitId: null,
    provider: null,
    providerDeliveryId: null,
    pullRequestId: null,
    deploymentId: null,
    deploymentExternalId: null,
    deploymentStatus: null,
  };

  if (typedKind === 'commit_observed') {
    base.metricEventId = readUuid(record, 'metricEventId');
    base.commitId = readUuid(record, 'commitId');
  } else if (typedKind === 'pr_merged') {
    base.provider = readPattern(record, 'provider', PROVIDER, 'a lowercase provider name');
    base.providerDeliveryId = readPattern(record, 'providerDeliveryId', BOUNDED_ID, '1-128 characters without control characters');
    base.pullRequestId = readUuid(record, 'pullRequestId');
  } else {
    base.provider = readPattern(record, 'provider', PROVIDER, 'a lowercase provider name');
    const delivery = record.providerDeliveryId;
    base.providerDeliveryId = delivery === undefined || delivery === null
      ? null
      : readPattern(record, 'providerDeliveryId', BOUNDED_ID, '1-128 characters without control characters');
    base.deploymentId = readUuid(record, 'deploymentId');
    base.deploymentExternalId = readPattern(record, 'deploymentExternalId', BOUNDED_ID, '1-128 characters without control characters');
    if (record.deploymentStatus !== 'success') throw invalid('deploymentStatus must be success (only production successes are attested)');
    base.deploymentStatus = 'success';
  }
  return base;
}

/**
 * The source rows, which must exist in the same tenant and agree with the
 * pointer. Returns the row's event time, so event_at always comes from the
 * source (metric event time, merged_at, deployed_at), never from the caller.
 */
function sourceSelect(s: NormalizedSubject): { from: SQL; eventAt: SQL } {
  if (s.kind === 'commit_observed') {
    return {
      eventAt: sql`e.event_timestamp`,
      from: sql`telemetry_metric_events e
        join scm_commits c on c.tenant_id = e.tenant_id
        where e.tenant_id = ${s.tenantId}::uuid and e.id = ${s.metricEventId}::uuid
          and e.event_kind in (${COMMIT_EVENT_KINDS[0]}, ${COMMIT_EVENT_KINDS[1]})
          and c.id = ${s.commitId}::uuid and c.repository_id = ${s.repositoryId}::uuid
          and c.sha = ${s.commitSha}`,
    };
  }
  if (s.kind === 'pr_merged') {
    return {
      eventAt: sql`pr.merged_at`,
      from: sql`provider_event_deliveries d
        join scm_pull_requests pr on pr.tenant_id = d.tenant_id
        where d.tenant_id = ${s.tenantId}::uuid and d.provider = ${s.provider}
          and d.delivery_id = ${s.providerDeliveryId} and d.event_type = 'pr_closed'
          and (d.repository_id is null or d.repository_id = ${s.repositoryId}::uuid)
          and pr.id = ${s.pullRequestId}::uuid and pr.repository_id = ${s.repositoryId}::uuid
          and pr.merge_commit_sha = ${s.commitSha} and pr.merged_at is not null`,
    };
  }
  const delivery = s.providerDeliveryId === null
    ? sql`true`
    : sql`exists (select 1 from provider_event_deliveries d
        where d.tenant_id = ${s.tenantId}::uuid and d.provider = ${s.provider}
          and d.delivery_id = ${s.providerDeliveryId} and d.event_type = 'deployment_status'
          and (d.repository_id is null or d.repository_id = ${s.repositoryId}::uuid))`;
  return {
    eventAt: sql`dep.deployed_at`,
    from: sql`scm_deployments dep
      where dep.tenant_id = ${s.tenantId}::uuid and dep.id = ${s.deploymentId}::uuid
        and dep.repository_id = ${s.repositoryId}::uuid and dep.provider = ${s.provider}
        and dep.external_id = ${s.deploymentExternalId} and dep.status = 'success'
        and dep.production = true and dep.sha = ${s.commitSha}
        and ${delivery}`,
  };
}

function conflictTarget(kind: AttestaSubjectKind): SQL {
  if (kind === 'commit_observed') {
    return sql`(tenant_id, kind, metric_event_id) where kind = 'commit_observed'`;
  }
  if (kind === 'pr_merged') {
    return sql`(tenant_id, kind, provider, provider_delivery_id) where kind = 'pr_merged'`;
  }
  return sql`(tenant_id, kind, provider, deployment_external_id, deployment_status) where kind = 'deployed'`;
}

function keyMatch(s: NormalizedSubject): SQL {
  if (s.kind === 'commit_observed') return sql`metric_event_id = ${s.metricEventId}::uuid`;
  if (s.kind === 'pr_merged') return sql`provider = ${s.provider} and provider_delivery_id = ${s.providerDeliveryId}`;
  return sql`provider = ${s.provider} and deployment_external_id = ${s.deploymentExternalId}
    and deployment_status = ${s.deploymentStatus}`;
}

const asText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/**
 * Fields that must be identical when a replay finds the existing row: every
 * caller-supplied identity field, except a deployed row's delivery ID (a
 * second success delivery for the same deployment is the same observation;
 * the first delivery is kept). event_at comes from the source, not the caller.
 */
function differingFields(row: Record<string, unknown>, s: NormalizedSubject): string[] {
  const expected: Record<string, string | null> = {
    repository_id: s.repositoryId,
    commit_sha: s.commitSha,
    metric_event_id: s.metricEventId,
    commit_id: s.commitId,
    provider: s.provider,
    provider_delivery_id: s.kind === 'deployed' ? asText(row.provider_delivery_id) : s.providerDeliveryId,
    pull_request_id: s.pullRequestId,
    deployment_id: s.deploymentId,
    deployment_external_id: s.deploymentExternalId,
    deployment_status: s.deploymentStatus,
  };
  return Object.entries(expected)
    .filter(([column, value]) => asText(row[column]) !== value)
    .map(([column]) => column);
}

/**
 * Inserts the outbox pointer in the caller's open transaction, or returns the
 * existing row for a replay of the same observation.
 */
export async function enqueueAttestaSubject(
  tx: AttestaOutboxExecutor,
  input: EnqueueAttestaSubjectInput,
): Promise<EnqueueAttestaSubjectResult> {
  const s = normalizeAttestaSubjectInput(input);
  const notBefore = s.notBefore === null ? sql`now()` : sql`${s.notBefore.toISOString()}::timestamptz`;
  const source = sourceSelect(s);

  const inserted = await tx.execute(sql`
    insert into attesta_subjects (
      tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, provider,
      provider_delivery_id, pull_request_id, deployment_id, deployment_external_id,
      deployment_status, event_at, not_before
    )
    select ${s.tenantId}::uuid, ${s.repositoryId}::uuid, ${s.kind}, ${s.metricEventId}::uuid,
      ${s.commitId}::uuid, ${s.commitSha}, ${s.provider}, ${s.providerDeliveryId},
      ${s.pullRequestId}::uuid, ${s.deploymentId}::uuid, ${s.deploymentExternalId},
      ${s.deploymentStatus}, ${source.eventAt}, ${notBefore}
    from ${source.from}
    on conflict ${conflictTarget(s.kind)} do nothing
    returning id
  `);
  const newId = inserted.rows[0]?.id;
  if (typeof newId === 'string') return { id: newId, inserted: true };

  const existing = await tx.execute(sql`
    select id, repository_id, commit_sha, metric_event_id, commit_id, provider,
      provider_delivery_id, pull_request_id, deployment_id, deployment_external_id,
      deployment_status
    from attesta_subjects
    where tenant_id = ${s.tenantId}::uuid and kind = ${s.kind} and ${keyMatch(s)}
  `);
  const row = existing.rows[0];
  if (!row) {
    throw new AttestaOutboxError(
      'ATTESTA_OUTBOX_SOURCE_NOT_FOUND',
      `no matching source row for ${s.kind} in this tenant`,
    );
  }
  const differing = differingFields(row, s);
  if (differing.length > 0) {
    throw new AttestaOutboxError(
      'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT',
      `a ${s.kind} row with this key already exists with different ${differing.join(', ')}`,
    );
  }
  return { id: String(row.id), inserted: false };
}
