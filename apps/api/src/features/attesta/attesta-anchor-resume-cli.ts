/**
 * Operator resume of an anchor batch stopped by a terminal code (Task15i3; tables.md
 * "attesta_anchor_resumes", errors.md §Anchoring):
 *
 *   npm run attesta:anchor-resume -w apps/api -- --tenant <uuid> --batch <tenant>:<from>-<to> --actor <name> --reason <text> [--confirm=RESUME]
 *
 * A **dry run by default** (AGENTS.md §9 item 10): prints the batch, its range and
 * record count, the terminal code that stopped it and when, and the flag that applies
 * it. With `--confirm=RESUME` it writes, in one transaction, one append-only
 * `attesta_anchor_resumes` row and one `security_audit_events` row
 * (`attesta.anchor.resume`). A batch that is not stopped (unknown, anchored, its
 * latest failure not terminal, or already resumed since that stop) is refused with
 * the reason; the 0021 guard refuses the same cases again inside the transaction, so
 * a race between the dry run and the apply cannot resume a batch twice. The anchor
 * worker then retries the batch once with the normal backoff; a new terminal failure
 * stops it again (anchor-worker.ts deviation 3b).
 *
 * Output names the tenant, the batch, counts, codes and times only. There is no route:
 * resuming is an operator action.
 *
 * Port from: SushiCorp EV-2 @ 0bd67a5 `core/evidence/anchoring.py` ("a rejected batch is
 * skipped until an operator acts"; SushiCorp has no resume command itself). The
 * dry-run / --confirm / --actor pattern is attesta-keys-cli.ts and attesta-requeue-cli.ts.
 * New: the append-only resume row (tables stay append-only) and one resume per stop.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { TERMINAL_ANCHOR_CODES } from './anchor-contract';
import { parseSeq } from './ledger';
import type { WorkerDatabase } from './worker';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BATCH_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})$/;
/** As attesta:requeue: a short token, never an email. */
const ACTOR_RE = /^(?!.*@)[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const RESUME_AUDIT_ACTION = 'attesta.anchor.resume';
export const MAX_REASON_LENGTH = 256;

/** What the store knows about one batch, every comparison done by the database clock. */
export interface ResumeBatchState {
  batchId: string;
  seqFrom: number;
  seqTo: number;
  leafCount: number;
  /** Anchored in both types for every record. */
  complete: boolean;
  /** created_at of the latest failed attempt (ms ISO), or null when it never failed. */
  lastFailedAt: string | null;
  /** The terminal code of the latest failed attempt, or null when that attempt was not terminal. */
  terminalCode: string | null;
  /** A resume row is newer than the latest failed attempt. */
  resumedSinceStop: boolean;
}

export interface ResumeInput {
  tenantId: string;
  batchId: string;
  actor: string;
  reason: string;
  requestId: string;
  terminalCode: string;
  records: number;
}

export interface ResumeStore {
  /** The batch of this tenant, or null (another tenant's batch is null too). */
  batchState(tenantId: string, batchId: string): Promise<ResumeBatchState | null>;
  /** One transaction: the resume row (0021 guard) and the audit row. Returns the resume time. */
  applyResume(input: ResumeInput): Promise<{ resumedAt: string }>;
}

export type ResumeRefusal = 'not_found' | 'anchored' | 'never_failed' | 'not_terminal' | 'already_resumed';

/** Stopped (resumable) or why not. REVOKED > CLEAN > UNKNOWN style: anything unclear is refused. */
export function resumeVerdict(state: ResumeBatchState | null): { stopped: true; code: string } | { stopped: false; why: ResumeRefusal } {
  if (state === null) return { stopped: false, why: 'not_found' };
  if (state.complete) return { stopped: false, why: 'anchored' };
  if (state.lastFailedAt === null) return { stopped: false, why: 'never_failed' };
  if (state.terminalCode === null || !TERMINAL_ANCHOR_CODES.has(state.terminalCode as never)) return { stopped: false, why: 'not_terminal' };
  if (state.resumedSinceStop) return { stopped: false, why: 'already_resumed' };
  return { stopped: true, code: state.terminalCode };
}

const REFUSAL_TEXT: Record<ResumeRefusal, string> = {
  not_found: 'no such batch for this tenant',
  anchored: 'the batch is anchored in both types; nothing to resume',
  never_failed: 'the batch has no failed attempt; the worker retries it on its own',
  not_terminal: 'its latest failed attempt is not a terminal code; the worker retries it with backoff',
  already_resumed: 'this stop was already resumed; a new terminal failure is needed before another resume',
};

export interface ResumeCliIo {
  out(line: string): void;
  err(line: string): void;
  store: ResumeStore;
  requestId?: () => string;
}

export class ResumeCliError extends Error {}

function parseArgs(argv: string[]): Map<string, string> {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new ResumeCliError(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!['tenant', 'batch', 'actor', 'reason', 'confirm'].includes(name)) throw new ResumeCliError(`unknown option --${name}`);
    if (opts.has(name)) throw new ResumeCliError(`--${name} given twice`);
    let value: string | undefined;
    if (eq > 0) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ResumeCliError(`--${name} needs a value`);
      i++;
    }
    opts.set(name, value);
  }
  return opts;
}

export interface ResumeArgs {
  tenantId: string;
  batchId: string;
  actor: string;
  reason: string;
  confirm: boolean;
}

/** Validate every argument before anything reaches the store (Task15i lesson). */
export function parseResumeArgs(argv: string[]): ResumeArgs {
  const opts = parseArgs(argv);
  const tenantId = opts.get('tenant') ?? '';
  const batchId = opts.get('batch') ?? '';
  const actor = opts.get('actor') ?? '';
  const reason = opts.get('reason') ?? '';
  const confirm = opts.get('confirm');
  if (!UUID_RE.test(tenantId)) throw new ResumeCliError('--tenant must be a lowercase UUID');
  const m = BATCH_RE.exec(batchId);
  if (!m) throw new ResumeCliError('--batch must be "<tenant uuid>:<seq_from>-<seq_to>"');
  // A batch id names its tenant: refusing a foreign one here keeps the scope exact.
  if (m[1] !== tenantId) throw new ResumeCliError('--batch belongs to another tenant than --tenant');
  if (!Number.isSafeInteger(Number(m[2])) || !Number.isSafeInteger(Number(m[3])) || Number(m[2]) > Number(m[3])) {
    throw new ResumeCliError('--batch range is invalid');
  }
  if (!ACTOR_RE.test(actor)) throw new ResumeCliError('--actor must be a short name without spaces or @');
  if (reason.trim() === '' || reason.length > MAX_REASON_LENGTH || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new ResumeCliError(`--reason must be 1-${MAX_REASON_LENGTH} printable characters`);
  }
  if (confirm !== undefined && confirm !== 'RESUME') throw new ResumeCliError('--confirm must be exactly RESUME');
  return { tenantId, batchId, actor, reason, confirm: confirm === 'RESUME' };
}

/** The CLI body; returns the exit code (0 done or dry run, 1 refused or failed). */
export async function runAnchorResumeCli(argv: string[], io: ResumeCliIo): Promise<number> {
  let args: ResumeArgs;
  try {
    args = parseResumeArgs(argv);
  } catch (err) {
    io.err(err instanceof ResumeCliError ? err.message : 'invalid arguments');
    return 1;
  }
  const state = await io.store.batchState(args.tenantId, args.batchId);
  const verdict = resumeVerdict(state);
  io.out(`mode=${args.confirm ? 'apply' : 'dry-run'}`);
  io.out(`tenant=${args.tenantId}`);
  io.out(`batch=${args.batchId}`);
  if (state) {
    io.out(`seq=${state.seqFrom}-${state.seqTo}`);
    io.out(`records=${state.leafCount}`);
    io.out(`last_failed_at=${state.lastFailedAt ?? 'none'}`);
    io.out(`terminal_code=${state.terminalCode ?? 'none'}`);
  }
  if (!verdict.stopped) {
    io.err(`refused: batch ${args.batchId} is not stopped (${REFUSAL_TEXT[verdict.why]})`);
    return 1;
  }
  if (!args.confirm) {
    io.out('next=rerun with --confirm=RESUME after review (writes one resume row and one audit row)');
    return 0;
  }
  const requestId = (io.requestId ?? randomUUID)();
  try {
    const { resumedAt } = await io.store.applyResume({
      tenantId: args.tenantId, batchId: args.batchId, actor: args.actor, reason: args.reason, requestId,
      terminalCode: verdict.code, records: state!.leafCount,
    });
    io.out(`resumed_at=${resumedAt}`);
    io.out(`request_id=${requestId}`);
    io.out(`audit=security_audit_events row written (${RESUME_AUDIT_ACTION})`);
    io.out('next=the anchor worker retries this batch once, with the normal backoff');
    return 0;
  } catch (err) {
    // The 0021 guard re-checks inside the transaction (a concurrent resume or a change since the dry run).
    if (hasSqlState(err, 'ATG01')) {
      io.err(`refused by the database guard: ${guardMessage(err)}`);
      return 1;
    }
    throw err;
  }
}

function hasSqlState(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The guard's own message (fixed texts in 0021, no values), else a generic one. */
function guardMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const m = (current as { message?: unknown }).message;
    if (typeof m === 'string' && m.startsWith('attesta_anchor_resumes: ')) return m.slice('attesta_anchor_resumes: '.length);
    current = (current as { cause?: unknown }).cause;
  }
  return 'the batch is not resumable';
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const terminalList = sql`(${sql.join([...TERMINAL_ANCHOR_CODES].map((c) => sql`${c}`), sql`, `)})`;

/** Every query binds tenant_id explicitly (as ledger.ts and anchor-worker.ts do). */
export function pgResumeStore(db: WorkerDatabase): ResumeStore {
  return {
    async batchState(tenantId, batchId) {
      const r = await db.execute(sql`/* anchor_resume:state */
        with f as (
          select max(a.created_at) as last_failed from attesta_anchors a
          where a.tenant_id = ${tenantId} and a.batch_id = ${batchId} and a.status = 'failed'
        )
        select b.batch_id, b.seq_from::text as seq_from, b.seq_to::text as seq_to, b.leaf_count,
          ${sql.raw(`to_char(f.last_failed at time zone 'UTC', ${TS_MS})`)} as last_failed_at,
          (select a.error_code from attesta_anchors a
             where a.tenant_id = b.tenant_id and a.batch_id = b.batch_id and a.status = 'failed'
               and a.created_at = f.last_failed and a.error_code in ${terminalList}
             order by a.error_code limit 1) as terminal_code,
          exists (select 1 from attesta_anchor_resumes x
             where x.tenant_id = b.tenant_id and x.batch_id = b.batch_id and x.created_at > f.last_failed) as resumed_since_stop,
          ((select count(*) from attesta_anchors a where a.tenant_id = b.tenant_id and a.batch_id = b.batch_id
              and a.anchor_type = 'rekor' and a.status = 'anchored') >= b.leaf_count
           and (select count(*) from attesta_anchors a where a.tenant_id = b.tenant_id and a.batch_id = b.batch_id
              and a.anchor_type = 'tsa' and a.status = 'anchored') >= b.leaf_count) as complete
        from attesta_anchor_batches b cross join f
        where b.tenant_id = ${tenantId} and b.batch_id = ${batchId}`);
      const row = r.rows[0];
      if (!row) return null;
      return {
        batchId: String(row.batch_id),
        seqFrom: parseSeq(row.seq_from),
        seqTo: parseSeq(row.seq_to),
        leafCount: Number(row.leaf_count),
        complete: row.complete === true,
        lastFailedAt: typeof row.last_failed_at === 'string' ? row.last_failed_at : null,
        terminalCode: typeof row.terminal_code === 'string' ? row.terminal_code : null,
        resumedSinceStop: row.resumed_since_stop === true,
      };
    },

    async applyResume(input) {
      return db.transaction(async (tx) => {
        const inserted = await tx.execute(sql`/* anchor_resume:insert */
          insert into attesta_anchor_resumes (tenant_id, batch_id, actor, reason, request_id)
          values (${input.tenantId}, ${input.batchId}, ${input.actor}, ${input.reason}, ${input.requestId})
          returning ${sql.raw(`to_char(created_at at time zone 'UTC', ${TS_MS})`)} as created_at`);
        await tx.execute(sql`/* anchor_resume:audit */
          insert into security_audit_events (tenant_id, actor_type, actor_id, action, target_type, target_id, details)
          values (${input.tenantId}, 'system_operator', ${input.actor}, ${RESUME_AUDIT_ACTION}, 'attesta_anchor_batch', ${input.batchId},
            ${JSON.stringify({ request_id: input.requestId, terminal_code: input.terminalCode, records: input.records, reason: input.reason })}::jsonb)`);
        return { resumedAt: String(inserted.rows[0]?.created_at) };
      });
    },
  };
}

async function main(): Promise<void> {
  await import('dotenv/config');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { db, pool } = await import('../../core/db');
  try {
    process.exitCode = await runAnchorResumeCli(process.argv.slice(2), {
      out: (l) => console.log(l), err: (l) => console.error(l), store: pgResumeStore(db as unknown as WorkerDatabase),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'attesta:anchor-resume failed');
    process.exitCode = 1;
  });
}
