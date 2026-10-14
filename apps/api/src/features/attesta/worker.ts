/**
 * Attesta builder worker (Task15h, A15.8): claims `attesta_subjects` rows, builds,
 * signs and chains one statement per row, and maps every outcome to the outbox
 * protocol (docs/contracts/attesta/outbox.md "Worker protocol"; envelope.md steps
 * 1–7; errors.md).
 *
 * Ported from SushiCorp's anchoring worker `services/anchoring/service.py` @ 0bd67a5
 * (catalog EV-2) through outbox.md, which Task15c wrote from it: claim with
 * FOR UPDATE SKIP LOCKED, lease recovery, exponential backoff, a visible terminal
 * state. Deviations: (1) the success transition happens inside the ledger
 * transaction (chainStatement marks the row done against its claim), not in a
 * separate update; (2) every release is guarded by the claim (status, claimed_at
 * with microseconds, attempts), so a worker whose lease expired changes nothing;
 * (3) a claim that outlives its lease with the attempts already at the limit is
 * failed at recovery (code ATTESTA_LEDGER_CLAIM_LOST unless the row has one), so a
 * row that crashes the worker every time still ends visible (Task2 lesson);
 * (4) all times come from the database clock; (5) a row that only waits for an
 * earlier statement about its subject is retried without spending an attempt (the
 * row it waits for always ends done or failed); (6) the claim is a MATERIALIZED CTE
 * and takes only the kinds this worker knows.
 *
 * Network (signing) happens outside every transaction: read (repeatable read,
 * read only) → sign → one ledger transaction (AGENTS.md §9 item 18). The pass runs
 * across tenants; each row's reads and writes are bound to that row's tenant.
 * Nothing here logs: the caller prints the pass result, which holds codes and
 * counts only.
 */
import { sql, type SQL } from 'drizzle-orm';
import { recordAuditEvent } from '../../core/audit';
import {
  AttestaBuilderError, buildStatement, statementValidator,
  type AttestaSubjectRow, type BuilderOptions, type BuilderReadExecutor, type BuiltStatement,
} from './builder';
import { sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  AttestaLedgerError, chainStatement, mapLedgerDatabaseError,
  type ChainStatementInput, type ChainStatementResult, type LedgerExecutor,
} from './ledger';
import { ATTESTA_SUBJECT_KINDS, type AttestaSubjectKind } from './outbox';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';

export const DEFAULT_LEASE_MS = 600_000;
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_MAX_MS = 3_600_000;
const CODE_RE = /^ATTESTA_[A-Z0-9_]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WorkerExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** The database the worker needs: `execute` plus transactions (Drizzle's `db`). */
export interface WorkerDatabase extends WorkerExecutor {
  transaction<T>(
    fn: (tx: WorkerExecutor) => Promise<T>,
    config?: { isolationLevel?: 'repeatable read'; accessMode?: 'read only' },
  ): Promise<T>;
}

export interface BuilderPassOptions {
  /** Rows claimed in this pass. */
  limit: number;
  /** Attempts after which a retryable failure becomes terminal. */
  maxAttempts: number;
  /** `<semver>+<git commit>` stamped into every statement. */
  builderVersion: string;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Test seams; production callers pass none. */
  hooks?: {
    /** Runs after signing and before the ledger transaction (crash simulation). */
    afterSign?: (row: AttestaSubjectRow) => Promise<void>;
  };
  deps?: {
    build?: (tx: BuilderReadExecutor, row: AttestaSubjectRow, options: BuilderOptions) => Promise<BuiltStatement>;
    chain?: (tx: LedgerExecutor, input: ChainStatementInput) => Promise<ChainStatementResult>;
  };
}

export interface BuilderPassResult {
  /** Expired claims returned to pending. */
  recovered: number;
  /** Expired claims already at the attempt limit, failed. */
  recoveredFailed: number;
  claimed: number;
  done: number;
  /** Chained earlier under the same digest (outbox row marked done). */
  duplicates: number;
  retried: number;
  failed: number;
  /** The claim moved on (lease expired, another worker); this worker changed nothing. */
  claimLost: number;
  /** Unexpected error: the row stays claimed for lease recovery. */
  leftClaimed: number;
  /** Outcome codes and how often they occurred (no IDs, no content). */
  codes: Record<string, number>;
}

/** What to do with a row after an error (outbox.md, errors.md). */
export type ErrorAction =
  | { action: 'retry'; code: string; wait?: boolean }
  | { action: 'fail'; code: string }
  | { action: 'stop'; code: string }
  | { action: 'leave_claimed'; code: 'unexpected_error' };

export function classifyError(err: unknown): ErrorAction {
  if (err instanceof AttestaBuilderError) {
    return err.retryable ? { action: 'retry', code: err.code, wait: err.wait } : { action: 'fail', code: err.code };
  }
  if (err instanceof SigningUnavailable) return { action: 'retry', code: 'ATTESTA_SIGNER_UNAVAILABLE' };
  if (err instanceof SigningRejected) return { action: 'fail', code: 'ATTESTA_SIGNER_REJECTED' };
  if (err instanceof AttestaLedgerError) {
    if (err.code === 'ATTESTA_LEDGER_CLAIM_LOST') return { action: 'stop', code: err.code };
    // PREVIOUS_STALE (rebuild) and HEAD_CONFLICT are retryable; GUARD_VIOLATION
    // (ledger.ts also reports invalid input with it) is terminal (errors.md §Ledger).
    return { action: err.retryable ? 'retry' : 'fail', code: err.code };
  }
  return { action: 'leave_claimed', code: 'unexpected_error' };
}

export function backoffMs(attempts: number, baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS): number {
  const exp = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(maxMs, baseMs * 2 ** exp);
}

interface ClaimedRow extends AttestaSubjectRow {
  /** claimed_at as stored, with microseconds (never through a JS Date). */
  claimedAt: string;
  attempts: number;
  createdAt: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const TS_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const leaseInterval = (ms: number) => sql`make_interval(secs => ${ms / 1000}::double precision)`;

function toClaimed(r: Record<string, unknown>): ClaimedRow {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), repositoryId: String(r.repository_id),
    kind: String(r.kind) as AttestaSubjectKind, metricEventId: str(r.metric_event_id), commitId: str(r.commit_id),
    commitSha: String(r.commit_sha), provider: str(r.provider), providerDeliveryId: str(r.provider_delivery_id),
    pullRequestId: str(r.pull_request_id), deploymentId: str(r.deployment_id),
    deploymentExternalId: str(r.deployment_external_id), eventAt: String(r.event_at),
    claimedAt: String(r.claimed_at), attempts: Number(r.attempts), createdAt: String(r.created_at),
  };
}

/** Return expired claims to the queue; fail those already at the attempt limit. */
async function recoverExpired(db: WorkerDatabase, leaseMs: number, maxAttempts: number) {
  const failed = await db.execute(sql`/* worker:recover_fail */
    update attesta_subjects
    set status = 'failed', processed_at = now(),
        last_error_code = coalesce(last_error_code, 'ATTESTA_LEDGER_CLAIM_LOST')
    where status = 'claimed' and claimed_at < now() - ${leaseInterval(leaseMs)} and attempts >= ${maxAttempts}
    returning id`);
  const recovered = await db.execute(sql`/* worker:recover */
    update attesta_subjects set status = 'pending', claimed_at = null
    where status = 'claimed' and claimed_at < now() - ${leaseInterval(leaseMs)}
    returning id`);
  return { recovered: recovered.rows.length, recoveredFailed: failed.rows.length };
}

/**
 * outbox.md's claim, as a CTE: the frozen `WHERE id IN (SELECT … LIMIT n FOR UPDATE
 * SKIP LOCKED)` form lets PostgreSQL re-run the subquery and claim more than n rows
 * (IT-T15h-02 saw 6 claimed with n = 3). A MATERIALIZED CTE that locks the rows runs
 * exactly once, so the limit holds (contract finding F6 in the handoff).
 */
// Only the kinds this worker builds: a kind added later waits for a worker that knows it.
const KNOWN_KINDS = sql`(${sql.join(ATTESTA_SUBJECT_KINDS.map((k) => sql`${k}`), sql`, `)})`;

async function claim(db: WorkerDatabase, limit: number): Promise<ClaimedRow[]> {
  const r = await db.execute(sql`/* worker:claim */
    with picked as materialized (
      select id from attesta_subjects
      where status = 'pending' and not_before <= now() and kind in ${KNOWN_KINDS}
      order by created_at limit ${limit}
      for update skip locked)
    update attesta_subjects s set status = 'claimed', claimed_at = now(), attempts = s.attempts + 1
    from picked where s.id = picked.id and s.status = 'pending'
    returning s.id::text as id, s.tenant_id::text as tenant_id, s.repository_id::text as repository_id, s.kind,
      s.metric_event_id::text as metric_event_id, s.commit_id::text as commit_id, s.commit_sha, s.provider,
      s.provider_delivery_id, s.pull_request_id::text as pull_request_id, s.deployment_id::text as deployment_id,
      s.deployment_external_id,
      ${sql.raw(`to_char(s.event_at at time zone 'UTC', ${TS_MS})`)} as event_at,
      ${sql.raw(`to_char(s.claimed_at at time zone 'UTC', ${TS_US})`)} as claimed_at,
      s.attempts,
      ${sql.raw(`to_char(s.created_at at time zone 'UTC', ${TS_US})`)} as created_at`);
  return r.rows.map(toClaimed).sort((a, b) =>
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Release a row we still hold; false when the claim moved on (nothing changed). */
async function release(
  db: WorkerDatabase, row: ClaimedRow, outcome: 'retry' | 'fail', code: string, options: BuilderPassOptions, refundAttempt = false,
) {
  const guard = sql`tenant_id = ${row.tenantId} and id = ${row.id}::uuid and status = 'claimed'
    and claimed_at = ${row.claimedAt}::timestamptz and attempts = ${row.attempts}`;
  const r = outcome === 'retry'
    ? await db.execute(sql`/* worker:retry */
        update attesta_subjects
        set status = 'pending', claimed_at = null, last_error_code = ${code},
            attempts = attempts - ${refundAttempt ? 1 : 0},
            not_before = now() + ${leaseInterval(backoffMs(row.attempts, options.backoffBaseMs, options.backoffMaxMs))}
        where ${guard} returning id`)
    : await db.execute(sql`/* worker:fail */
        update attesta_subjects set status = 'failed', processed_at = now(), last_error_code = ${code}
        where ${guard} returning id`);
  return r.rows.length === 1;
}

/**
 * The ledger's commit-time guard is deferred, so a refusal or a serialization
 * failure can surface at COMMIT, outside chainStatement's own mapping.
 */
async function chainMapped(db: WorkerDatabase, fn: (tx: WorkerExecutor) => Promise<ChainStatementResult>) {
  try {
    return await db.transaction(fn);
  } catch (err) {
    throw mapLedgerDatabaseError(err) ?? err;
  }
}

async function processRow(
  db: WorkerDatabase, resolver: SignerResolver, row: ClaimedRow, options: BuilderPassOptions, result: BuilderPassResult,
): Promise<void> {
  const count = (code: string) => { result.codes[code] = (result.codes[code] ?? 0) + 1; };
  const build = options.deps?.build ?? buildStatement;
  const chain = options.deps?.chain ?? chainStatement;
  try {
    const signer = await resolver.resolve(row.tenantId);
    if (signer === null) {
      const released = await release(db, row, 'fail', 'ATTESTA_SIGNER_NO_CREDENTIAL', options);
      if (released) { result.failed += 1; count('ATTESTA_SIGNER_NO_CREDENTIAL'); } else result.claimLost += 1;
      return;
    }
    const maxPayloadBytes = signer.adapter.capabilities().maxPayloadBytes;
    // Steps 1–4: one read transaction; as_of is its now().
    const built = await db.transaction(
      (tx) => build(tx, row, { builderVersion: options.builderVersion, maxPayloadBytes }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    // Step 6: sign the PAE bytes; signVerified checks the answer against the published key.
    const payload = Buffer.from(built.canonical, 'utf8');
    const signed = await signVerified(signer.adapter, pae(IN_TOTO_PAYLOAD_TYPE, payload), {
      credentialId: signer.credentialId, tenantId: row.tenantId, requestId: `attesta-build:${row.id}:${row.attempts}`,
    });
    if (options.hooks?.afterSign) await options.hooks.afterSign(row);
    const keyid = sha256Prefixed(signed.publicKeySpkiDer);
    const envelope: DsseEnvelope = {
      payload: payload.toString('base64'),
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ keyid, sig: signed.signature.toString('base64') }],
    };
    // Steps 5 and 7: one ledger transaction (dedup on the digest, previous re-checked,
    // the row marked done against this claim). No network inside it.
    const chained = await chainMapped(db, (tx) => chain(tx, {
      tenantId: row.tenantId,
      statementCanonical: built.canonical,
      envelope,
      credentialId: signer.credentialId,
      keyid,
      signatureDer: signed.signature,
      publicKeySpkiDer: signed.publicKeySpkiDer,
      outboxClaim: { subjectId: row.id, claimedAt: row.claimedAt, attempts: row.attempts },
      previousSeen: built.previousSeen,
    }));
    if (chained.duplicate) { result.duplicates += 1; count('ATTESTA_LEDGER_DUPLICATE_STATEMENT'); } else result.done += 1;
  } catch (err) {
    const decision = classifyError(err);
    count(decision.code);
    if (decision.action === 'stop') { result.claimLost += 1; return; }
    if (decision.action === 'leave_claimed') { result.leftClaimed += 1; return; }
    const waiting = decision.action === 'retry' && decision.wait === true;
    const outcome = decision.action === 'retry' && (waiting || row.attempts < options.maxAttempts) ? 'retry' : 'fail';
    try {
      const released = await release(db, row, outcome, decision.code, options, waiting);
      if (!released) result.claimLost += 1;
      else if (outcome === 'retry') result.retried += 1;
      else result.failed += 1;
    } catch {
      result.leftClaimed += 1; // the database is gone; lease recovery returns the row
    }
  }
}

/**
 * One pass: recover expired claims, claim up to `limit` rows, then for each row
 * (in created_at order, outside any transaction) build → sign → chain.
 */
export async function runBuilderPass(
  db: WorkerDatabase,
  resolver: SignerResolver,
  options: BuilderPassOptions,
): Promise<BuilderPassResult> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new RangeError('limit must be 1-1000');
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) throw new RangeError('maxAttempts must be ≥ 1');
  if (!Number.isFinite(leaseMs) || leaseMs < 0) throw new RangeError('leaseMs must be ≥ 0');
  const result: BuilderPassResult = {
    recovered: 0, recoveredFailed: 0, claimed: 0, done: 0, duplicates: 0, retried: 0, failed: 0,
    claimLost: 0, leftClaimed: 0, codes: {},
  };
  // Fail the pass, not the rows, if the frozen schemas cannot be loaded here.
  if (!options.deps?.build) statementValidator();
  const recovery = await recoverExpired(db, leaseMs, options.maxAttempts);
  result.recovered = recovery.recovered;
  result.recoveredFailed = recovery.recoveredFailed;
  const rows = await claim(db, options.limit);
  result.claimed = rows.length;
  for (const row of rows) await processRow(db, resolver, row, options, result);
  return result;
}

// ---------------------------------------------------------------------------
// Audited re-queue (outbox.md; AGENTS.md §9 item 10: dry-run first)
// ---------------------------------------------------------------------------

export interface RequeueInput {
  tenantId: string;
  /** Only failed rows with this last_error_code are moved. */
  code: string;
  /** Who runs it (a token: no spaces, no email). */
  actorId: string;
  /** false: count only, change nothing. */
  confirm: boolean;
  /** With confirm: the dry-run's count; a different count at apply time changes nothing. */
  expect?: number;
}

export interface RequeueResult { dryRun: boolean; matched: number; requeued: number }

const ACTOR_RE = /^(?!.*@)[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export class RequeueScopeChanged extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`expected ${expected} failed rows but ${actual} match now; nothing changed, run the dry-run again`);
    this.name = 'RequeueScopeChanged';
  }
}

/**
 * Put a tenant's `failed` rows with one error code back in the queue
 * (status pending, processed_at and claimed_at null, attempts kept), and write one
 * security_audit_events row per run (actor, tenant, code, count; no row IDs).
 */
export async function requeueFailedSubjects(db: WorkerDatabase, input: RequeueInput): Promise<RequeueResult> {
  if (!UUID_RE.test(input.tenantId)) throw new RangeError('tenant must be a lowercase UUID');
  if (!CODE_RE.test(input.code)) throw new RangeError('code must match ^ATTESTA_[A-Z0-9_]{1,64}$');
  if (!ACTOR_RE.test(input.actorId)) throw new RangeError('actor must be a short token without spaces or @');
  if (input.expect !== undefined && (!Number.isSafeInteger(input.expect) || input.expect < 0)) throw new RangeError('expect must be a count');
  const counted = await db.execute(sql`/* worker:requeue_count */
    select count(*)::int as n from attesta_subjects
    where tenant_id = ${input.tenantId} and status = 'failed' and last_error_code = ${input.code}`);
  const matched = Number(counted.rows[0]?.n ?? 0);
  if (!input.confirm) return { dryRun: true, matched, requeued: 0 };
  const requeued = await db.transaction(async (tx) => {
    const moved = await tx.execute(sql`/* worker:requeue */
      update attesta_subjects
      set status = 'pending', processed_at = null, claimed_at = null, not_before = now()
      where tenant_id = ${input.tenantId} and status = 'failed' and last_error_code = ${input.code}
      returning id`);
    if (input.expect !== undefined && moved.rows.length !== input.expect) {
      // Thrown inside the transaction, so the update rolls back.
      throw new RequeueScopeChanged(input.expect, moved.rows.length);
    }
    await recordAuditEvent(tx, input.tenantId, {
      actorType: 'system_operator',
      actorId: input.actorId,
      action: 'attesta_subjects.requeued',
      targetType: 'attesta_outbox',
      targetId: input.tenantId,
      details: { code: input.code, count: moved.rows.length },
    });
    return moved.rows.length;
  });
  return { dryRun: false, matched, requeued };
}
