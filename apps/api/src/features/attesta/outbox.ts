/**
 * Attesta outbox writer (Task15c; frozen contract docs/contracts/attesta/outbox.md).
 *
 * Task2 (A15.7, Codex) calls enqueueAttestaSubject inside the transaction that
 * records the observation, so the pointer row commits or rolls back with it.
 * Nothing here signs, builds or waits: the Attesta worker does that later.
 *
 * Source binding: the insert succeeds only if every source row exists in the
 * same tenant and the immutable event or delivery provably produced the named
 * projection (outbox.md, "Source binding"). The table has no foreign keys to
 * those rows (outbox.md, "Why no source foreign keys").
 *
 * Idempotency: one database key per kind; a replay returns the existing row,
 * and a replay whose pointer differs from the stored one is refused, never
 * silently merged.
 */
import { sql, type SQL } from 'drizzle-orm';
// Read-only use of Task2's canonical URL rule, so the binding matches how
// normalizeCommit chose the repository (no copy that could drift).
import { normalizeRepositoryUrl } from '../telemetry/repository-url';

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
  /** provider_event_deliveries.delivery_id of the successful deployment_status delivery. */
  providerDeliveryId: string;
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
    base.providerDeliveryId = readPattern(record, 'providerDeliveryId', BOUNDED_ID, '1-128 characters without control characters');
    base.deploymentId = readUuid(record, 'deploymentId');
    base.deploymentExternalId = readPattern(record, 'deploymentExternalId', BOUNDED_ID, '1-128 characters without control characters');
    if (record.deploymentStatus !== 'success') throw invalid('deploymentStatus must be success (only production successes are attested)');
    base.deploymentStatus = 'success';
  }
  return base;
}

/**
 * The facts that prove the source rows exist in this tenant and that the
 * immutable event or delivery produced the named projection. One row, joined
 * on primary keys and tenant; no row means "not found".
 */
function bindingQuery(s: NormalizedSubject): SQL {
  if (s.kind === 'commit_observed') {
    return sql`select e.event_kind, e.event_timestamp as event_at, e.event_timestamp::text as event_at_text,
        e.raw_event->'a'->>'1' as raw_repo_url, e.raw_event->'a'->>'3' as raw_sha,
        c.repository_id as commit_repository_id, c.sha as commit_sha,
        r.normalized_url as repository_normalized_url
      from telemetry_metric_events e, scm_commits c, scm_repositories r
      where e.tenant_id = ${s.tenantId}::uuid and e.id = ${s.metricEventId}::uuid
        and c.tenant_id = ${s.tenantId}::uuid and c.id = ${s.commitId}::uuid
        and r.tenant_id = ${s.tenantId}::uuid and r.id = ${s.repositoryId}::uuid`;
  }
  if (s.kind === 'pr_merged') {
    return sql`select d.event_type, d.repository_id as delivery_repository_id,
        d.raw_event->>'action' as raw_action,
        d.raw_event->'pull_request'->>'id' as raw_pr_id,
        d.raw_event->'pull_request'->>'merge_commit_sha' as raw_merge_sha,
        d.raw_event->'pull_request'->>'merged_at' as raw_merged_at,
        d.raw_event->'repository'->>'id' as raw_repo_id,
        pr.external_id as pr_external_id, pr.repository_id as pr_repository_id,
        pr.merge_commit_sha as pr_merge_sha, pr.merged_at as event_at, pr.merged_at::text as event_at_text,
        r.external_id as repository_external_id
      from provider_event_deliveries d, scm_pull_requests pr, scm_repositories r
      where d.tenant_id = ${s.tenantId}::uuid and d.provider = ${s.provider}
        and d.delivery_id = ${s.providerDeliveryId}
        and pr.tenant_id = ${s.tenantId}::uuid and pr.id = ${s.pullRequestId}::uuid
        and r.tenant_id = ${s.tenantId}::uuid and r.id = ${s.repositoryId}::uuid`;
  }
  return sql`select d.event_type, d.repository_id as delivery_repository_id,
      d.raw_event->'deployment'->>'id' as raw_deployment_id,
      d.raw_event->'deployment'->>'sha' as raw_sha,
      d.raw_event->'deployment_status'->>'state' as raw_state,
      d.raw_event->'repository'->>'id' as raw_repo_id,
      dep.repository_id as deployment_repository_id, dep.provider as deployment_provider,
      dep.external_id as deployment_external_id, dep.status as deployment_status,
      dep.production as deployment_production, dep.sha as deployment_sha,
      dep.deployed_at as event_at, dep.deployed_at::text as event_at_text,
      r.external_id as repository_external_id
    from provider_event_deliveries d, scm_deployments dep, scm_repositories r
    where d.tenant_id = ${s.tenantId}::uuid and d.provider = ${s.provider}
      and d.delivery_id = ${s.providerDeliveryId}
      and dep.tenant_id = ${s.tenantId}::uuid and dep.id = ${s.deploymentId}::uuid
      and r.tenant_id = ${s.tenantId}::uuid and r.id = ${s.repositoryId}::uuid`;
}

/** Provider JSON values are compared as Task2's parser reads them: trimmed text. */
const rawText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

function sameRepositoryUrl(rawUrl: unknown, normalized: unknown): boolean {
  const raw = rawText(rawUrl);
  if (raw === null || typeof normalized !== 'string') return false;
  try {
    return normalizeRepositoryUrl(raw) === normalized;
  } catch {
    return false;
  }
}

/**
 * True when the facts prove that the event or delivery produced exactly the
 * projection the pointer names. Exported for unit tests.
 */
export function sourceBindsToPointer(s: NormalizedSubject, f: Record<string, unknown>): boolean {
  if (s.kind === 'commit_observed') {
    return (COMMIT_EVENT_KINDS as readonly number[]).includes(Number(f.event_kind))
      && rawText(f.raw_sha) === s.commitSha
      && f.commit_sha === s.commitSha
      && f.commit_repository_id === s.repositoryId
      && sameRepositoryUrl(f.raw_repo_url, f.repository_normalized_url);
  }
  const deliveryRepositoryOk = f.delivery_repository_id === null
    || f.delivery_repository_id === undefined
    || f.delivery_repository_id === s.repositoryId;
  const repositoryOk = rawText(f.raw_repo_id) !== null && rawText(f.raw_repo_id) === f.repository_external_id;
  if (s.kind === 'pr_merged') {
    return f.event_type === 'pr_closed'
      && rawText(f.raw_action) === 'closed'
      && rawText(f.raw_merged_at) !== null
      && rawText(f.raw_pr_id) !== null && rawText(f.raw_pr_id) === f.pr_external_id
      && rawText(f.raw_merge_sha) === s.commitSha
      && f.pr_merge_sha === s.commitSha
      && f.pr_repository_id === s.repositoryId
      && f.event_at !== null && f.event_at !== undefined
      && deliveryRepositoryOk && repositoryOk;
  }
  return f.event_type === 'deployment_status'
    && rawText(f.raw_state) === 'success'
    && rawText(f.raw_deployment_id) !== null && rawText(f.raw_deployment_id) === s.deploymentExternalId
    && rawText(f.raw_sha) === s.commitSha
    && f.deployment_repository_id === s.repositoryId
    && f.deployment_provider === s.provider
    && f.deployment_external_id === s.deploymentExternalId
    && f.deployment_status === 'success'
    && f.deployment_production === true
    && f.deployment_sha === s.commitSha
    && deliveryRepositoryOk && repositoryOk;
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
  const notFound = () => new AttestaOutboxError(
    'ATTESTA_OUTBOX_SOURCE_NOT_FOUND',
    `no matching source rows for ${s.kind} in this tenant`,
  );

  // 1. Prove the sources (the same answer for missing, foreign and mismatched rows).
  const facts = (await tx.execute(bindingQuery(s))).rows[0];
  if (!facts || !sourceBindsToPointer(s, facts)) throw notFound();
  // Copied as PostgreSQL text and cast back, so microseconds survive (a JS Date keeps milliseconds).
  const eventAtText = facts.event_at_text;
  if (typeof eventAtText !== 'string' || eventAtText.length === 0) throw notFound();

  // 2. Insert, or find the replayed row.
  const inserted = await tx.execute(sql`
    insert into attesta_subjects (
      tenant_id, repository_id, kind, metric_event_id, commit_id, commit_sha, provider,
      provider_delivery_id, pull_request_id, deployment_id, deployment_external_id,
      deployment_status, event_at, not_before
    )
    values (${s.tenantId}::uuid, ${s.repositoryId}::uuid, ${s.kind}, ${s.metricEventId}::uuid,
      ${s.commitId}::uuid, ${s.commitSha}, ${s.provider}, ${s.providerDeliveryId},
      ${s.pullRequestId}::uuid, ${s.deploymentId}::uuid, ${s.deploymentExternalId},
      ${s.deploymentStatus}, ${eventAtText}::timestamptz, ${notBefore})
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
  // Unreachable unless the row was deleted between the two statements.
  if (!row) throw notFound();
  const differing = differingFields(row, s);
  if (differing.length > 0) {
    throw new AttestaOutboxError(
      'ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT',
      `a ${s.kind} row with this key already exists with different ${differing.join(', ')}`,
    );
  }
  return { id: String(row.id), inserted: false };
}
