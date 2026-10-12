/**
 * Attesta ledger writer (Task15d, A15.3; binding design docs/contracts/attesta/tables.md,
 * envelope.md step 7, outbox.md worker protocol).
 *
 * Ported from SushiCorp EV-1 @ 0bd67a5 (catalog EV-1): core/evidence/records.py
 * (build, canonicalize, hash one record at a chain position, clock read inside the
 * lock) and db/repositories/decisions.py via the B3/D1 handoffs (seq from the
 * tenant's chain_head under SELECT … FOR UPDATE, never a sequence).
 * Deviations:
 *  1. The record is an in-toto statement record (tables.md), not a decision record;
 *     its typed columns are derived from the signed statement, never passed in.
 *  2. Drizzle/pg raw SQL inside the caller's transaction instead of a SQLAlchemy
 *     session and a sealer callback; there is no separate repository class.
 *  3. The ledger transaction also marks the outbox row done against its claim and
 *     re-checks `previous` under the chain lock (envelope.md step 7; SushiCorp had
 *     no outbox).
 *  4. recorded_at is clamped to the previous record's when the clock steps back
 *     (SushiCorp relied on the clock); the database guard refuses a step back too.
 *  5. The input carries the signer's public key (publicKeySpkiDer, from
 *     signVerified's result) so the keyid binding and the signature are checked
 *     locally before anything is stored ("never store an envelope whose signature
 *     did not verify", envelope.md step 6). Verifying is CPU only: no network.
 *
 * No network, no signing and no builder call happen here (AGENTS.md §9 item 18):
 * the caller signs first, then opens the transaction and calls chainStatement.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  CanonicalizationError,
  GENESIS_PREV_HASH,
  canonicalize,
  computeRecordHash,
  sha256Prefixed,
} from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';

export const AI_PROVENANCE_PREDICATE_TYPE = 'https://trackai.dev/attesta/ai-provenance/v1';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const LEDGER_RECORD_KIND = 'statement';
/** Largest statement the ledger accepts (bytes); signers cap lower (1 MiB local dev). */
export const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;

export type AttestaStatementKind = 'commit_observed' | 'pr_merged' | 'deployed';
const STATEMENT_KINDS: readonly AttestaStatementKind[] = ['commit_observed', 'pr_merged', 'deployed'];

export type AttestaLedgerErrorCode =
  | 'ATTESTA_LEDGER_DUPLICATE_STATEMENT'
  | 'ATTESTA_LEDGER_HEAD_CONFLICT'
  | 'ATTESTA_LEDGER_PREVIOUS_STALE'
  | 'ATTESTA_LEDGER_CLAIM_LOST'
  | 'ATTESTA_LEDGER_GUARD_VIOLATION';

const RETRYABLE: ReadonlySet<AttestaLedgerErrorCode> = new Set([
  'ATTESTA_LEDGER_HEAD_CONFLICT',
  'ATTESTA_LEDGER_PREVIOUS_STALE',
]);

/** Errors carry an errors.md code and a message without raw values. */
export class AttestaLedgerError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: AttestaLedgerErrorCode, message: string) {
    super(message);
    this.name = 'AttestaLedgerError';
    this.retryable = RETRYABLE.has(code);
  }
}

/** Anything with `execute(sql)`: the caller's open Drizzle transaction. */
export interface LedgerExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface OutboxClaim {
  /** attesta_subjects.id the statement was built for. */
  subjectId: string;
  /**
   * The row's claimed_at exactly as stored, RFC 3339 UTC with up to microsecond
   * precision (read it with to_char(... 'US'), not through a JS Date, which drops
   * microseconds and would never match).
   */
  claimedAt: string;
  /** The row's attempts value after the claim. */
  attempts: number;
}

export interface ChainStatementInput {
  tenantId: string;
  /** The exact RFC 8785 bytes that were signed. */
  statementCanonical: string;
  envelope: DsseEnvelope;
  credentialId: string;
  keyid: string;
  signatureDer: Buffer;
  /** SPKI DER of the key that signed (SigningResult.publicKeySpkiDer from signVerified). */
  publicKeySpkiDer: Buffer;
  outboxClaim?: OutboxClaim;
  /** Digests of the statements about this subject the builder read, oldest first. */
  previousSeen: string[];
}

export interface ChainStatementResult {
  recordId: string;
  seq: number;
  recordHash: string;
  statementDigest: string;
  /** true when the statement digest was already chained (the outbox row is still marked done). */
  duplicate: boolean;
}

/** The fields of the hashed ledger record, in tables.md order. */
export interface LedgerRecordFields {
  seq: number;
  prev_hash: string;
  recorded_at: string;
  tenant_id: string;
  record_kind: typeof LEDGER_RECORD_KIND;
  statement_digest: string;
  predicate_type: string;
  statement_kind: AttestaStatementKind | null;
  repository_id: string;
  subject_sha: string | null;
  outbox_subject_id: string | null;
}

/** The typed copies of a statement, derived from its canonical bytes. */
export interface StatementColumns {
  statementDigest: string;
  predicateType: string;
  statementKind: AttestaStatementKind;
  repositoryId: string;
  subjectSha: string;
  /** predicate.previous digests, oldest first. */
  previous: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const BASE64_RE = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CLAIMED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEQ_TEXT_RE = /^(0|[1-9][0-9]{0,15})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function guard(message: string): AttestaLedgerError {
  return new AttestaLedgerError('ATTESTA_LEDGER_GUARD_VIOLATION', message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((k, i) => k === want[i]);
}

/** Own data property, read once; accessors are refused (Task15a lesson). */
function dataProp(obj: object, key: string, label: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d === undefined) return undefined;
  if (d.get !== undefined || d.set !== undefined) throw guard(`${label}: accessor properties are refused`);
  return d.value;
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !BASE64_RE.test(value)) throw guard(`${label} is not strict base64`);
  return Buffer.from(value, 'base64');
}

/** A bigint read from pg as text, converted explicitly (AGENTS.md §9 item 20). */
export function parseSeq(value: unknown, label = 'seq'): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !SEQ_TEXT_RE.test(text)) throw guard(`${label} is not a non-negative integer`);
  const n = Number(text);
  // next_seq + 1 must stay exact too.
  if (!Number.isSafeInteger(n + 1)) throw guard(`${label} is outside the safe integer range`);
  return n;
}

/**
 * Derive the typed columns from a statement's canonical bytes (ai-provenance v1).
 * The builder validates the full schema and S1–S12 (envelope.md step 3); the ledger
 * checks only what it stores and links on. `period_report` arrives with A15.9.
 */
export function deriveStatementColumns(statementCanonical: string): StatementColumns {
  if (typeof statementCanonical !== 'string' || statementCanonical.length === 0) {
    throw guard('statementCanonical must be a non-empty string');
  }
  if (Buffer.byteLength(statementCanonical, 'utf8') > MAX_STATEMENT_BYTES) {
    throw guard('statementCanonical is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(statementCanonical);
  } catch {
    throw guard('statementCanonical is not JSON');
  }
  let again: string;
  try {
    again = canonicalize(parsed);
  } catch (err) {
    if (err instanceof CanonicalizationError) throw guard('statementCanonical cannot be canonicalized');
    throw err;
  }
  if (again !== statementCanonical) throw guard('statementCanonical is not its own RFC 8785 form');
  if (!isPlainRecord(parsed)) throw guard('statement must be an object');
  if (parsed._type !== IN_TOTO_STATEMENT_TYPE) throw guard('statement _type is not in-toto Statement v1');
  if (parsed.predicateType !== AI_PROVENANCE_PREDICATE_TYPE) throw guard('unsupported predicateType');
  const subjects = parsed.subject;
  if (!Array.isArray(subjects) || subjects.length !== 1 || !isPlainRecord(subjects[0])) {
    throw guard('statement must have exactly one subject');
  }
  const subject = subjects[0];
  const digest = subject.digest;
  const subjectSha = isPlainRecord(digest) ? digest.gitCommit : undefined;
  if (typeof subjectSha !== 'string' || !SHA_RE.test(subjectSha)) throw guard('subject digest is not a git commit sha');
  const predicate = parsed.predicate;
  if (!isPlainRecord(predicate)) throw guard('statement predicate must be an object');
  const statementKind = predicate.statement_kind;
  if (typeof statementKind !== 'string' || !(STATEMENT_KINDS as readonly string[]).includes(statementKind)) {
    throw guard('predicate statement_kind is not a known kind');
  }
  const repository = predicate.repository;
  const repositoryId = isPlainRecord(repository) ? repository.id : undefined;
  if (typeof repositoryId !== 'string' || !UUID_RE.test(repositoryId)) throw guard('predicate repository.id is not a UUID');
  if (subject.name !== `trackai:repository/${repositoryId}/commit/${subjectSha}`) {
    throw guard('subject name does not match the repository and commit');
  }
  const previousRaw = predicate.previous;
  if (!Array.isArray(previousRaw)) throw guard('predicate previous must be an array');
  const previous = previousRaw.map((entry) => {
    const d = isPlainRecord(entry) ? entry.digest : undefined;
    if (typeof d !== 'string' || !HASH_RE.test(d)) throw guard('predicate previous holds a malformed digest');
    return d;
  });
  return {
    statementDigest: sha256Prefixed(Buffer.from(statementCanonical, 'utf8')),
    predicateType: AI_PROVENANCE_PREDICATE_TYPE,
    statementKind: statementKind as AttestaStatementKind,
    repositoryId,
    subjectSha,
    previous,
  };
}

/** The RFC 8785 bytes hashed into record_hash (tables.md `canonical_record`). */
export function buildCanonicalRecord(fields: LedgerRecordFields): string {
  return canonicalize({
    seq: fields.seq,
    prev_hash: fields.prev_hash,
    recorded_at: fields.recorded_at,
    tenant_id: fields.tenant_id,
    record_kind: fields.record_kind,
    statement_digest: fields.statement_digest,
    predicate_type: fields.predicate_type,
    statement_kind: fields.statement_kind,
    repository_id: fields.repository_id,
    subject_sha: fields.subject_sha,
    outbox_subject_id: fields.outbox_subject_id,
  });
}

/** The validated, inert copy chainStatement works from (exported for tests). */
export interface ChainSnapshot {
  tenantId: string;
  statementCanonical: string;
  columns: StatementColumns;
  envelope: DsseEnvelope;
  credentialId: string;
  keyid: string;
  signatureDer: Buffer;
  outboxClaim: OutboxClaim | null;
  previousSeen: string[];
}

/**
 * Validate every input once into a snapshot; only the snapshot is used afterwards,
 * so a getter or a later mutation by the caller cannot change what was checked.
 */
export function validateChainInput(input: ChainStatementInput): ChainSnapshot {
  if (!isPlainRecord(input)) throw guard('input must be a plain object');
  const allowed = ['tenantId', 'statementCanonical', 'envelope', 'credentialId', 'keyid', 'signatureDer',
    'publicKeySpkiDer', 'outboxClaim', 'previousSeen'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw guard('input has an unknown field');
  const read = (key: string) => dataProp(input, key, 'input');

  const tenantId = read('tenantId');
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw guard('tenantId is not a lowercase UUID');
  const statementCanonical = read('statementCanonical');
  if (typeof statementCanonical !== 'string') throw guard('statementCanonical must be a string');
  const columns = deriveStatementColumns(statementCanonical);

  const credentialId = read('credentialId');
  if (typeof credentialId !== 'string' || credentialId.length < 1 || credentialId.length > 256 || CONTROL_RE.test(credentialId)) {
    throw guard('credentialId must be 1-256 printable characters');
  }
  const keyid = read('keyid');
  if (typeof keyid !== 'string' || !HASH_RE.test(keyid)) throw guard('keyid is not sha256:<hex>');
  const sigIn = read('signatureDer');
  if (!Buffer.isBuffer(sigIn) || sigIn.length < 8 || sigIn.length > 128) throw guard('signatureDer must be 8-128 bytes');
  const signatureDer = Buffer.from(sigIn);
  const spkiIn = read('publicKeySpkiDer');
  if (!Buffer.isBuffer(spkiIn) || spkiIn.length === 0) throw guard('publicKeySpkiDer must be a Buffer');
  const spki = Buffer.from(spkiIn);
  if (sha256Prefixed(spki) !== keyid) throw guard('keyid is not the SHA-256 of the signing key');

  // Envelope: one shape, exactly the statement bytes, exactly this signature.
  const envIn = read('envelope');
  if (!isPlainRecord(envIn) || !hasExactKeys(envIn, ['payload', 'payloadType', 'signatures'])) {
    throw guard('envelope must have exactly payload, payloadType and signatures');
  }
  const payloadType = dataProp(envIn, 'payloadType', 'envelope');
  if (payloadType !== IN_TOTO_PAYLOAD_TYPE) throw guard('envelope payloadType is not in-toto');
  const payloadB64 = dataProp(envIn, 'payload', 'envelope');
  const payload = decodeBase64(payloadB64, 'envelope payload');
  if (!payload.equals(Buffer.from(statementCanonical, 'utf8'))) {
    throw guard('envelope payload is not the statement bytes');
  }
  const sigs = dataProp(envIn, 'signatures', 'envelope');
  if (!Array.isArray(sigs) || sigs.length !== 1) throw guard('envelope must carry exactly one signature');
  const sig0 = dataProp(sigs, '0', 'envelope signature');
  if (!isPlainRecord(sig0) || !hasExactKeys(sig0, ['keyid', 'sig'])) throw guard('envelope signature must be {keyid, sig}');
  const sigKeyid = dataProp(sig0, 'keyid', 'envelope signature');
  const sigB64 = dataProp(sig0, 'sig', 'envelope signature');
  if (sigKeyid !== keyid) throw guard('envelope keyid differs from keyid');
  if (!decodeBase64(sigB64, 'envelope sig').equals(signatureDer)) throw guard('envelope sig differs from signatureDer');

  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw guard('publicKeySpkiDer is not a public key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw guard('signing key is not ECDSA P-256');
  }
  let verified = false;
  try {
    verified = verify('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key, dsaEncoding: 'der' }, signatureDer);
  } catch {
    verified = false;
  }
  if (!verified) throw guard('envelope signature does not verify');

  const previousIn = read('previousSeen');
  if (!Array.isArray(previousIn)) throw guard('previousSeen must be an array');
  const previousSeen: string[] = [];
  for (let i = 0; i < previousIn.length; i++) {
    const d = dataProp(previousIn, String(i), 'previousSeen');
    if (typeof d !== 'string' || !HASH_RE.test(d)) throw guard('previousSeen holds a malformed digest');
    previousSeen.push(d);
  }
  if (previousSeen.length !== columns.previous.length || previousSeen.some((d, i) => d !== columns.previous[i])) {
    throw guard('previousSeen differs from the statement previous list');
  }

  let outboxClaim: OutboxClaim | null = null;
  const claimIn = read('outboxClaim');
  if (claimIn !== undefined) {
    if (!isPlainRecord(claimIn) || !hasExactKeys(claimIn, ['subjectId', 'claimedAt', 'attempts'])) {
      throw guard('outboxClaim must be {subjectId, claimedAt, attempts}');
    }
    const subjectId = dataProp(claimIn, 'subjectId', 'outboxClaim');
    const claimedAt = dataProp(claimIn, 'claimedAt', 'outboxClaim');
    const attempts = dataProp(claimIn, 'attempts', 'outboxClaim');
    if (typeof subjectId !== 'string' || !UUID_RE.test(subjectId)) throw guard('outboxClaim subjectId is not a UUID');
    if (typeof claimedAt !== 'string' || !CLAIMED_AT_RE.test(claimedAt) || Number.isNaN(Date.parse(claimedAt))) {
      throw guard('outboxClaim claimedAt must be an RFC 3339 UTC string');
    }
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) {
      throw guard('outboxClaim attempts must be a non-negative integer');
    }
    outboxClaim = { subjectId, claimedAt, attempts };
  }

  return {
    tenantId,
    statementCanonical,
    columns,
    envelope: {
      payload: payloadB64 as string,
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ keyid, sig: sigB64 as string }],
    },
    credentialId,
    keyid,
    signatureDer,
    outboxClaim,
    previousSeen,
  };
}

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function findPgError(err: unknown): PgLikeError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const e = current as PgLikeError;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    current = e.cause;
  }
  return null;
}

const LEDGER_CONSTRAINT_RE = /^(attesta_records|attesta_envelopes|chain_head)_/;

/**
 * Map a database refusal from the ledger guards to an errors.md code, or null when
 * the error is not one of ours (connection loss and the like are rethrown as is).
 * Exported so a caller can map an error raised at its own COMMIT.
 */
export function mapLedgerDatabaseError(err: unknown): AttestaLedgerError | null {
  if (err instanceof AttestaLedgerError) return err;
  const pg = findPgError(err);
  if (!pg) return null;
  const code = pg.code as string;
  const constraint = typeof pg.constraint === 'string' ? pg.constraint : '';
  if (code === 'ATH01' || code === '40001' || code === '40P01') {
    return new AttestaLedgerError('ATTESTA_LEDGER_HEAD_CONFLICT', 'the chain head moved; retry');
  }
  if (code === 'ATG01') {
    return guard('a ledger guard refused the write');
  }
  if (code === '23505' && (constraint === 'attesta_records_tenant_seq_key' || constraint === 'chain_head_pkey')) {
    return new AttestaLedgerError('ATTESTA_LEDGER_HEAD_CONFLICT', 'the chain head moved; retry');
  }
  if ((code === '23505' || code === '23503' || code === '23514') && LEDGER_CONSTRAINT_RE.test(constraint)) {
    return guard('a ledger constraint refused the write');
  }
  return null;
}

async function run(tx: LedgerExecutor, query: SQL): Promise<Array<Record<string, unknown>>> {
  try {
    return (await tx.execute(query)).rows;
  } catch (err) {
    const mapped = mapLedgerDatabaseError(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/** recorded_at: now, never earlier than the previous record's (both ms ISO). */
export function nextRecordedAt(now: Date, previous: string | null): string {
  const stamp = now.toISOString();
  if (!ISO_MS_RE.test(stamp)) throw guard('the clock is outside the representable range');
  if (previous === null) return stamp;
  if (!ISO_MS_RE.test(previous)) throw guard('the previous recorded_at is malformed');
  return stamp < previous ? previous : stamp;
}

/**
 * Chain one signed statement for `tenantId` inside the caller's open transaction.
 * The caller commits; on any thrown error it must roll back. Throws
 * AttestaLedgerError (errors.md §Ledger); other errors (connection loss) pass through.
 */
export async function chainStatement(
  tx: LedgerExecutor,
  input: ChainStatementInput,
  clock: () => Date = () => new Date(),
): Promise<ChainStatementResult> {
  const s = validateChainInput(input);
  const c = s.columns;

  // 0. The commit-time guard must run after the envelope and head are written,
  //    even if the caller set its constraints IMMEDIATE.
  await run(tx, sql`/* ledger:commit_guard_defer */ set constraints attesta_records_commit_guard deferred`);

  // 1. The tenant's chain lock. Creating the head is race-safe: a concurrent
  //    creator waits on the primary key, then DO NOTHING.
  await run(tx, sql`/* ledger:head_insert */
    insert into chain_head (tenant_id, next_seq, head_hash)
    values (${s.tenantId}, 0, ${GENESIS_PREV_HASH})
    on conflict (tenant_id) do nothing`);
  const headRows = await run(tx, sql`/* ledger:head_lock */
    select next_seq::text as next_seq, head_hash from chain_head
    where tenant_id = ${s.tenantId} for update`);
  if (headRows.length !== 1) throw guard('the chain head could not be locked');
  const nextSeq = parseSeq(headRows[0].next_seq, 'chain_head.next_seq');
  const headHash = headRows[0].head_hash;
  if (typeof headHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(headHash)) throw guard('chain_head.head_hash is malformed');

  // 2. The outbox claim, locked; it must still be ours and name this subject.
  if (s.outboxClaim) {
    const claim = s.outboxClaim;
    const rows = await run(tx, sql`/* ledger:claim_lock */
      select status, attempts, (claimed_at = ${claim.claimedAt}::timestamptz) as same_claim,
             repository_id::text as repository_id, commit_sha, kind
      from attesta_subjects where tenant_id = ${s.tenantId} and id = ${claim.subjectId} for update`);
    const row = rows[0];
    if (!row || row.status !== 'claimed' || row.same_claim !== true || Number(row.attempts) !== claim.attempts) {
      throw new AttestaLedgerError('ATTESTA_LEDGER_CLAIM_LOST', 'the outbox row is no longer claimed by this attempt');
    }
    if (row.repository_id !== c.repositoryId || row.commit_sha !== c.subjectSha || row.kind !== c.statementKind) {
      throw guard('the statement is not about the claimed outbox subject');
    }
  }

  const markDone = async () => {
    if (!s.outboxClaim) return;
    const claim = s.outboxClaim;
    const done = await run(tx, sql`/* ledger:claim_done */
      update attesta_subjects set status = 'done', processed_at = now()
      where tenant_id = ${s.tenantId} and id = ${claim.subjectId} and status = 'claimed'
        and claimed_at = ${claim.claimedAt}::timestamptz and attempts = ${claim.attempts}
      returning id`);
    if (done.length !== 1) {
      throw new AttestaLedgerError('ATTESTA_LEDGER_CLAIM_LOST', 'the outbox row is no longer claimed by this attempt');
    }
  };

  // 3. Deduplicate on the statement digest (envelope.md): the existing record wins.
  const existing = await run(tx, sql`/* ledger:dedup */
    select id::text as id, seq::text as seq, record_hash from attesta_records
    where tenant_id = ${s.tenantId} and statement_digest = ${c.statementDigest}`);
  if (existing.length === 1) {
    await markDone();
    return {
      recordId: String(existing[0].id),
      seq: parseSeq(existing[0].seq),
      recordHash: String(existing[0].record_hash),
      statementDigest: c.statementDigest,
      duplicate: true,
    };
  }
  if (s.outboxClaim) {
    const chained = await run(tx, sql`/* ledger:outbox_chained */
      select 1 from attesta_records
      where tenant_id = ${s.tenantId} and outbox_subject_id = ${s.outboxClaim.subjectId}`);
    if (chained.length > 0) throw guard('the outbox row already has a chained statement');
  }

  // 4. previous, re-read under the lock: concurrent statements about one subject always link.
  const prevRows = await run(tx, sql`/* ledger:previous */
    select statement_digest from attesta_records
    where tenant_id = ${s.tenantId} and repository_id = ${c.repositoryId} and subject_sha = ${c.subjectSha}
    order by seq`);
  const current = prevRows.map((r) => String(r.statement_digest));
  const seen = s.previousSeen;
  const samePrefix = seen.every((d, i) => current[i] === d);
  if (!samePrefix) throw guard('previousSeen is not a list of statements chained about this subject');
  if (current.length > seen.length) {
    throw new AttestaLedgerError('ATTESTA_LEDGER_PREVIOUS_STALE', 'a statement about this subject was chained after the build read previous');
  }

  // 5. recorded_at, inside the lock, never before the previous record's.
  let previousRecordedAt: string | null = null;
  if (nextSeq > 0) {
    const last = await run(tx, sql`/* ledger:last_recorded */
      select to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at
      from attesta_records where tenant_id = ${s.tenantId} and seq = ${nextSeq - 1}`);
    if (last.length !== 1 || typeof last[0].recorded_at !== 'string') throw guard('the previous record is missing');
    previousRecordedAt = last[0].recorded_at;
  }
  const recordedAt = nextRecordedAt(clock(), previousRecordedAt);

  // 6. Build, hash, store, advance.
  const fields: LedgerRecordFields = {
    seq: nextSeq,
    prev_hash: headHash,
    recorded_at: recordedAt,
    tenant_id: s.tenantId,
    record_kind: LEDGER_RECORD_KIND,
    statement_digest: c.statementDigest,
    predicate_type: c.predicateType,
    statement_kind: c.statementKind,
    repository_id: c.repositoryId,
    subject_sha: c.subjectSha,
    outbox_subject_id: s.outboxClaim ? s.outboxClaim.subjectId : null,
  };
  const canonicalRecord = buildCanonicalRecord(fields);
  const recordHash = computeRecordHash(canonicalRecord, headHash);

  const inserted = await run(tx, sql`/* ledger:record_insert */
    insert into attesta_records (tenant_id, seq, prev_hash, recorded_at, record_kind, statement_digest,
      predicate_type, statement_kind, repository_id, subject_sha, statement_canonical, canonical_record,
      record_hash, outbox_subject_id)
    values (${s.tenantId}, ${nextSeq}, ${headHash}, ${recordedAt}::timestamptz, ${LEDGER_RECORD_KIND},
      ${c.statementDigest}, ${c.predicateType}, ${c.statementKind}, ${c.repositoryId}, ${c.subjectSha},
      ${s.statementCanonical}, ${canonicalRecord}, ${recordHash}, ${fields.outbox_subject_id})
    returning id::text as id`);
  const recordId = inserted[0]?.id;
  if (typeof recordId !== 'string') throw guard('the record insert returned no id');
  await run(tx, sql`/* ledger:envelope_insert */
    insert into attesta_envelopes (tenant_id, record_id, payload_type, keyid, credential_id, signature_der, envelope)
    values (${s.tenantId}, ${recordId}, ${IN_TOTO_PAYLOAD_TYPE}, ${s.keyid}, ${s.credentialId},
      ${s.signatureDer}, ${JSON.stringify(s.envelope)}::jsonb)`);
  await run(tx, sql`/* ledger:head_advance */
    update chain_head set next_seq = next_seq + 1, head_hash = ${recordHash}, updated_at = now()
    where tenant_id = ${s.tenantId}`);
  await markDone();
  // Run the commit-time guard now, so its refusal surfaces here as a ledger error
  // rather than at the caller's COMMIT; then defer it again for the next statement
  // (the trigger's own default; the caller's other constraints are untouched).
  await run(tx, sql`/* ledger:commit_guard */ set constraints attesta_records_commit_guard immediate`);
  await run(tx, sql`/* ledger:commit_guard_defer */ set constraints attesta_records_commit_guard deferred`);

  return { recordId, seq: nextSeq, recordHash, statementDigest: c.statementDigest, duplicate: false };
}
