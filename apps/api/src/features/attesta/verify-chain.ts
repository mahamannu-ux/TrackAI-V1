/**
 * Attesta chain verification as a structured report (Task15d, A15.3; tables.md
 * "Verification reads the stored bytes and never re-serializes"; errors.md
 * §Verification).
 *
 * Ported from SushiCorp EV-1 @ 0bd67a5 core/evidence/verify.py (catalog EV-1):
 * the same break kinds (hash, link, seq gap, seq mismatch, field, tenant, not
 * canonical, out of order, duplicate seq, head mismatch, beyond head), the gap
 * reported once per missing run, the record after a gap not blamed for its link,
 * and the chain head used to catch tail truncation and rewrites.
 * Deviations:
 *  1. Streams rows in pages with bounded memory: no per-record list in the report
 *     (counts only), breaks capped by `maxBreaks`; rows are never sorted, so an
 *     out-of-order row is reported and skipped, and the hole it leaves is a gap.
 *  2. Each break carries a frozen errors.md `detail_code` beside its kind; the
 *     contract has no dedicated code for some kinds, so they map to the nearest
 *     one (table below) and `kind` keeps the precise reason.
 *  3. Added kinds for the statement layer: statement digest mismatch, statement
 *     not canonical, envelope missing, envelope payload mismatch, signature
 *     invalid and key unknown (signatures checked with verifyEnvelope against the
 *     caller's published keys). Anchor kinds arrive with A15.5.
 *  4. No free-text `detail` per break (codes only, so nothing raw leaks).
 */
import type { KeyObject } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { CanonicalizationError, canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, verifyEnvelope, type DsseEnvelope } from './dsse';
import { AttestaLedgerError, deriveStatementColumns, parseSeq } from './ledger';

export const CHAIN_REPORT_VERSION = 1;

export type ChainBreakKind =
  | 'hash_mismatch'
  | 'link_mismatch'
  | 'seq_gap'
  | 'seq_mismatch'
  | 'field_mismatch'
  | 'tenant_mismatch'
  | 'not_canonical'
  | 'out_of_order'
  | 'duplicate_seq'
  | 'head_mismatch'
  | 'beyond_head'
  | 'statement_digest_mismatch'
  | 'statement_not_canonical'
  | 'envelope_missing'
  | 'envelope_payload_mismatch'
  | 'signature_invalid'
  | 'key_unknown'
  | 'signatures_not_checked'
  | 'merkle_proof_invalid'
  | 'anchor_invalid'
  | 'anchor_missing'
  | 'anchor_not_checkable';

export type AttestaVerifyCode =
  | 'ATTESTA_VERIFY_SEQ_GAP'
  | 'ATTESTA_VERIFY_PREV_HASH_MISMATCH'
  | 'ATTESTA_VERIFY_RECORD_HASH_MISMATCH'
  | 'ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH'
  | 'ATTESTA_VERIFY_NOT_CANONICAL'
  | 'ATTESTA_VERIFY_SIGNATURE_INVALID'
  | 'ATTESTA_VERIFY_KEY_UNKNOWN'
  | 'ATTESTA_VERIFY_NOT_CHECKABLE'
  | 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID'
  | 'ATTESTA_VERIFY_ANCHOR_MISSING'
  | 'ATTESTA_VERIFY_ANCHOR_INVALID'
  | 'ATTESTA_VERIFY_SEQ_MISMATCH'
  | 'ATTESTA_VERIFY_FIELD_MISMATCH'
  | 'ATTESTA_VERIFY_TENANT_MISMATCH'
  | 'ATTESTA_VERIFY_OUT_OF_ORDER'
  | 'ATTESTA_VERIFY_DUPLICATE_SEQ'
  | 'ATTESTA_VERIFY_HEAD_MISMATCH'
  | 'ATTESTA_VERIFY_BEYOND_HEAD'
  | 'ATTESTA_VERIFY_ENVELOPE_MISSING'
  | 'ATTESTA_VERIFY_ENVELOPE_PAYLOAD_MISMATCH'
  | 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED';

/**
 * Kind → frozen errors.md code: one exact code per kind (errors.md §Verification,
 * added 2026-10-12, switched in Task15f2). An unchecked signature or anchor is
 * never a pass (AGENTS.md §9 item 19): `signatures_not_checked` and
 * `anchor_not_checkable` keep `ok` false while `chain_intact` says whether the
 * chain itself held.
 */
export const BREAK_DETAIL_CODES: Readonly<Record<ChainBreakKind, AttestaVerifyCode>> = {
  hash_mismatch: 'ATTESTA_VERIFY_RECORD_HASH_MISMATCH',
  link_mismatch: 'ATTESTA_VERIFY_PREV_HASH_MISMATCH',
  seq_gap: 'ATTESTA_VERIFY_SEQ_GAP',
  seq_mismatch: 'ATTESTA_VERIFY_SEQ_MISMATCH',
  field_mismatch: 'ATTESTA_VERIFY_FIELD_MISMATCH',
  tenant_mismatch: 'ATTESTA_VERIFY_TENANT_MISMATCH',
  not_canonical: 'ATTESTA_VERIFY_NOT_CANONICAL',
  out_of_order: 'ATTESTA_VERIFY_OUT_OF_ORDER',
  duplicate_seq: 'ATTESTA_VERIFY_DUPLICATE_SEQ',
  head_mismatch: 'ATTESTA_VERIFY_HEAD_MISMATCH',
  beyond_head: 'ATTESTA_VERIFY_BEYOND_HEAD',
  statement_digest_mismatch: 'ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH',
  statement_not_canonical: 'ATTESTA_VERIFY_NOT_CANONICAL',
  envelope_missing: 'ATTESTA_VERIFY_ENVELOPE_MISSING',
  envelope_payload_mismatch: 'ATTESTA_VERIFY_ENVELOPE_PAYLOAD_MISMATCH',
  signature_invalid: 'ATTESTA_VERIFY_SIGNATURE_INVALID',
  key_unknown: 'ATTESTA_VERIFY_KEY_UNKNOWN',
  signatures_not_checked: 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED',
  merkle_proof_invalid: 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID',
  anchor_invalid: 'ATTESTA_VERIFY_ANCHOR_INVALID',
  anchor_missing: 'ATTESTA_VERIFY_ANCHOR_MISSING',
  anchor_not_checkable: 'ATTESTA_VERIFY_NOT_CHECKABLE',
};

export interface ChainBreak {
  seq: number;
  kind: ChainBreakKind;
  detail_code: AttestaVerifyCode;
}

export interface ChainHeadState {
  next_seq: number;
  head_hash: string;
}

export interface ChainReport {
  report_version: typeof CHAIN_REPORT_VERSION;
  tenant_id: string;
  range: { from_seq: number; to_seq: number };
  /** Rows in range that were checked. */
  checked: number;
  /** true only when nothing broke and every signature was checked against a published key. */
  ok: boolean;
  /** true when the only finding (if any) is that signatures were not checked. */
  chain_intact: boolean;
  breaks: ChainBreak[];
  /** true when more breaks were found than `maxBreaks` lets the report list. */
  breaks_truncated: boolean;
  head: ChainHeadState | null;
  /** `checked` when published keys were supplied and every envelope was checked against them. */
  signatures: 'checked' | 'not_checked';
  /** Machine-readable notes (no raw values): what could not be checked. */
  warnings: string[];
}

/** One stored record with its envelope, as the verifier reads it. */
export interface LedgerRow {
  seq: number;
  tenantId: string;
  prevHash: string;
  recordHash: string;
  canonicalRecord: string;
  /** Column value, ms ISO form. */
  recordedAt: string;
  recordKind: string;
  statementDigest: string;
  predicateType: string;
  statementKind: string | null;
  repositoryId: string;
  subjectSha: string | null;
  outboxSubjectId: string | null;
  statementCanonical: string;
  envelope: unknown | null;
  envelopeKeyid: string | null;
  envelopePayloadType: string | null;
  /** base64 of the stored signature_der column. */
  envelopeSignatureB64: string | null;
}

export interface VerifyRowsOptions {
  tenantId: string;
  fromSeq: number;
  toSeq: number;
  /** record_hash of record fromSeq - 1 (genesis is implied for fromSeq 0). */
  expectedPrevHash?: string | null;
  /** The tenant's chain_head; without it tail truncation is not checked. */
  head?: ChainHeadState | null;
  /** Published keys by keyid; without them signatures are not checked. */
  keys?: Record<string, KeyObject>;
  maxBreaks?: number;
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GENESIS = 'sha256:' + '0'.repeat(64);
const RECORD_KEYS = ['outbox_subject_id', 'predicate_type', 'prev_hash', 'record_kind', 'recorded_at',
  'repository_id', 'seq', 'statement_digest', 'statement_kind', 'subject_sha', 'tenant_id'];
const BASE64_RE = /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const DEFAULT_MAX_BREAKS = 1000;
export const DEFAULT_PAGE_SIZE = 500;

function assertRange(fromSeq: number, toSeq: number): void {
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 0 || toSeq < fromSeq) {
    throw new RangeError('need 0 <= fromSeq <= toSeq (safe integers)');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Collector {
  breaks: ChainBreak[] = [];
  total = 0;
  chainBreaks = 0;
  constructor(private readonly max: number) {}
  add(seq: number, kind: ChainBreakKind): void {
    this.total++;
    if (kind !== 'signatures_not_checked') this.chainBreaks++;
    if (this.breaks.length < this.max) this.breaks.push({ seq, kind, detail_code: BREAK_DETAIL_CODES[kind] });
  }
}

/** Cross-check one row's columns against its hashed record bytes. */
function checkRecordContent(row: LedgerRow, tenantId: string, out: Collector): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.canonicalRecord);
  } catch {
    out.add(row.seq, 'not_canonical');
    return;
  }
  if (!isObject(parsed)) {
    out.add(row.seq, 'not_canonical');
    return;
  }
  let canonical: string | null = null;
  try {
    canonical = canonicalize(parsed);
  } catch (err) {
    if (!(err instanceof CanonicalizationError)) throw err;
  }
  if (canonical !== row.canonicalRecord) out.add(row.seq, 'not_canonical');
  if (parsed.seq !== row.seq) out.add(row.seq, 'seq_mismatch');
  if (parsed.tenant_id !== row.tenantId || row.tenantId !== tenantId) out.add(row.seq, 'tenant_mismatch');
  const keys = Object.keys(parsed).sort();
  const fieldsAgree =
    keys.length === RECORD_KEYS.length && keys.every((k, i) => k === RECORD_KEYS[i]) &&
    parsed.prev_hash === row.prevHash &&
    parsed.recorded_at === row.recordedAt &&
    parsed.record_kind === row.recordKind &&
    parsed.statement_digest === row.statementDigest &&
    parsed.predicate_type === row.predicateType &&
    parsed.statement_kind === row.statementKind &&
    parsed.repository_id === row.repositoryId &&
    parsed.subject_sha === row.subjectSha &&
    parsed.outbox_subject_id === row.outboxSubjectId;
  if (!fieldsAgree) out.add(row.seq, 'field_mismatch');
}

/** The statement bytes: their digest, their canonical form, the typed copies. */
function checkStatement(row: LedgerRow, out: Collector): void {
  const digest = sha256Prefixed(Buffer.from(row.statementCanonical, 'utf8'));
  if (digest !== row.statementDigest) {
    // The hashed record names statement_digest, so a changed statement shows here.
    out.add(row.seq, 'statement_digest_mismatch');
  }
  // deriveStatementColumns re-canonicalizes the bytes once; only on refusal do we
  // look again to tell "not canonical" from "inconsistent".
  try {
    const c = deriveStatementColumns(row.statementCanonical);
    if (c.predicateType !== row.predicateType || c.statementKind !== row.statementKind ||
        c.repositoryId !== row.repositoryId || c.subjectSha !== row.subjectSha) {
      out.add(row.seq, 'field_mismatch');
    }
  } catch (err) {
    if (!(err instanceof AttestaLedgerError)) throw err;
    let canonical = false;
    try {
      canonical = canonicalize(JSON.parse(row.statementCanonical)) === row.statementCanonical;
    } catch {
      canonical = false;
    }
    out.add(row.seq, canonical ? 'field_mismatch' : 'statement_not_canonical');
  }
}

function checkEnvelope(row: LedgerRow, keys: Record<string, KeyObject> | undefined, out: Collector): void {
  const env = row.envelope;
  if (env === null || env === undefined) {
    out.add(row.seq, 'envelope_missing');
    return;
  }
  let consistent = false;
  if (isObject(env) && typeof env.payload === 'string' && BASE64_RE.test(env.payload) &&
      env.payloadType === IN_TOTO_PAYLOAD_TYPE && row.envelopePayloadType === IN_TOTO_PAYLOAD_TYPE &&
      Array.isArray(env.signatures) && env.signatures.length === 1 && isObject(env.signatures[0])) {
    const sig = env.signatures[0];
    consistent =
      Buffer.from(env.payload, 'base64').equals(Buffer.from(row.statementCanonical, 'utf8')) &&
      sig.keyid === row.envelopeKeyid &&
      typeof sig.sig === 'string' && sig.sig === row.envelopeSignatureB64;
  }
  if (!consistent) {
    out.add(row.seq, 'envelope_payload_mismatch');
    return;
  }
  if (!keys) return;
  const keyid = row.envelopeKeyid ?? '';
  if (!Object.prototype.hasOwnProperty.call(keys, keyid)) {
    out.add(row.seq, 'key_unknown');
    return;
  }
  if (!verifyEnvelope(env as unknown as DsseEnvelope, { [keyid]: keys[keyid] }).ok) {
    out.add(row.seq, 'signature_invalid');
  }
}

/**
 * Verify `rows` as the tenant's records with fromSeq <= seq <= toSeq, in the
 * order supplied (the database reader supplies seq order). Never throws on a
 * tampered row: every finding is a break.
 */
export async function verifyChainRows(
  rows: AsyncIterable<LedgerRow> | Iterable<LedgerRow>,
  opts: VerifyRowsOptions,
): Promise<ChainReport> {
  const { tenantId, fromSeq, toSeq } = opts;
  assertRange(fromSeq, toSeq);
  const head = opts.head ?? null;
  const out = new Collector(opts.maxBreaks ?? DEFAULT_MAX_BREAKS);
  const warnings: string[] = [];
  let link: string | null = fromSeq === 0 ? GENESIS : (opts.expectedPrevHash ?? null);
  if (link === null) warnings.push('first_link_not_checked');
  else if (!HASH_RE.test(link)) throw new RangeError('malformed expectedPrevHash');
  if (!head) warnings.push('head_not_supplied');

  let expectedNext = fromSeq;
  let lastSeq: number | null = null;
  let checked = 0;
  let outside = 0;
  let tailHash: string | null = null;
  const lastWritten = head ? head.next_seq - 1 : null;

  for await (const row of rows) {
    if (row.seq < fromSeq || row.seq > toSeq) {
      outside++;
      continue;
    }
    if (lastSeq !== null && row.seq === lastSeq) {
      out.add(row.seq, 'duplicate_seq');
      continue;
    }
    if (lastSeq !== null && row.seq < lastSeq) {
      out.add(row.seq, 'out_of_order');
      continue;
    }
    if (row.seq > expectedNext) {
      out.add(expectedNext, 'seq_gap');
      link = null; // predecessor missing: this back-link cannot be checked
    }
    checked++;
    if (lastWritten !== null && row.seq > lastWritten) out.add(row.seq, 'beyond_head');

    let recomputed: string | null = null;
    try {
      recomputed = computeRecordHash(row.canonicalRecord, row.prevHash);
    } catch (err) {
      if (!(err instanceof CanonicalizationError)) throw err;
    }
    if (recomputed === null || recomputed !== row.recordHash) out.add(row.seq, 'hash_mismatch');
    if (link !== null && row.prevHash !== link) out.add(row.seq, 'link_mismatch');
    checkRecordContent(row, tenantId, out);
    checkStatement(row, out);
    checkEnvelope(row, opts.keys, out);

    if (lastWritten !== null && row.seq === lastWritten) tailHash = row.recordHash;
    link = row.recordHash;
    expectedNext = row.seq + 1;
    lastSeq = row.seq;
  }
  if (outside > 0) warnings.push('rows_outside_range_ignored');
  if (!opts.keys && checked > 0) out.add(fromSeq, 'signatures_not_checked');

  if (head && lastWritten !== null) {
    const upper = Math.min(toSeq, lastWritten);
    if (expectedNext <= upper) out.add(expectedNext, 'seq_gap');
    if (lastWritten >= fromSeq && lastWritten <= toSeq && tailHash !== null && tailHash !== head.head_hash) {
      out.add(lastWritten, 'head_mismatch');
    }
  }

  return {
    report_version: CHAIN_REPORT_VERSION,
    tenant_id: tenantId,
    range: { from_seq: fromSeq, to_seq: toSeq },
    checked,
    ok: out.total === 0,
    chain_intact: out.chainBreaks === 0,
    breaks: out.breaks,
    breaks_truncated: out.total > out.breaks.length,
    head,
    signatures: opts.keys ? 'checked' : 'not_checked',
    warnings,
  };
}

/**
 * Anything with `execute(sql)`: `db` or an open transaction. When `transaction` is
 * present (the Drizzle database), every read runs in one REPEATABLE READ, READ ONLY
 * transaction, so the head and all pages are one snapshot.
 */
export interface ChainReadExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
  transaction?<T>(
    fn: (tx: ChainReadExecutor) => Promise<T>,
    config?: { isolationLevel?: 'repeatable read'; accessMode?: 'read only' },
  ): Promise<T>;
}

export interface VerifyChainOptions {
  fromSeq?: number;
  toSeq?: number;
  keys?: Record<string, KeyObject>;
  pageSize?: number;
  maxBreaks?: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toRow(r: Record<string, unknown>): LedgerRow {
  return {
    seq: parseSeq(r.seq),
    tenantId: str(r.tenant_id),
    prevHash: str(r.prev_hash),
    recordHash: str(r.record_hash),
    canonicalRecord: str(r.canonical_record),
    recordedAt: str(r.recorded_at),
    recordKind: str(r.record_kind),
    statementDigest: str(r.statement_digest),
    predicateType: str(r.predicate_type),
    statementKind: strOrNull(r.statement_kind),
    repositoryId: str(r.repository_id),
    subjectSha: strOrNull(r.subject_sha),
    outboxSubjectId: strOrNull(r.outbox_subject_id),
    statementCanonical: str(r.statement_canonical),
    envelope: r.envelope ?? null,
    envelopeKeyid: strOrNull(r.envelope_keyid),
    envelopePayloadType: strOrNull(r.envelope_payload_type),
    envelopeSignatureB64: strOrNull(r.envelope_signature_b64),
  };
}

async function* pages(
  db: ChainReadExecutor, tenantId: string, fromSeq: number, toSeq: number, pageSize: number,
): AsyncGenerator<LedgerRow> {
  let after = fromSeq - 1;
  for (;;) {
    const result = await db.execute(sql`
      select r.seq::text as seq, r.tenant_id::text as tenant_id, r.prev_hash, r.record_hash,
             r.canonical_record,
             to_char(r.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at,
             r.record_kind, r.statement_digest, r.predicate_type, r.statement_kind,
             r.repository_id::text as repository_id, r.subject_sha,
             r.outbox_subject_id::text as outbox_subject_id, r.statement_canonical,
             e.envelope, e.keyid as envelope_keyid, e.payload_type as envelope_payload_type,
             translate(encode(e.signature_der, 'base64'), E'\\n', '') as envelope_signature_b64
      from attesta_records r
      left join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
      where r.tenant_id = ${tenantId} and r.seq > ${after} and r.seq <= ${toSeq}
      order by r.seq
      limit ${pageSize}`);
    for (const r of result.rows) {
      const row = toRow(r);
      after = row.seq;
      yield row;
    }
    if (result.rows.length < pageSize) return;
  }
}

/**
 * Verify the tenant's chain over [fromSeq, toSeq] (default: the whole chain up to
 * its head) from the stored bytes. Every query is bound to `tenantId`.
 */
export async function verifyChain(
  db: ChainReadExecutor,
  tenantId: string,
  options: VerifyChainOptions = {},
): Promise<ChainReport> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenantId)) {
    throw new RangeError('tenantId is not a lowercase UUID');
  }
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5000) throw new RangeError('pageSize must be 1-5000');
  if (typeof db.transaction === 'function') {
    return db.transaction((tx) => verifySnapshot(tx, tenantId, options, pageSize),
      { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  return verifySnapshot(db, tenantId, options, pageSize);
}

async function verifySnapshot(
  db: ChainReadExecutor,
  tenantId: string,
  options: VerifyChainOptions,
  pageSize: number,
): Promise<ChainReport> {

  const headRows = (await db.execute(sql`
    select next_seq::text as next_seq, head_hash,
           (select max(seq)::text from attesta_records where tenant_id = ${tenantId}) as max_seq
    from (select 1) one
    left join chain_head h on h.tenant_id = ${tenantId}`)).rows;
  const h = headRows[0] ?? {};
  const head: ChainHeadState | null = typeof h.next_seq === 'string'
    ? { next_seq: parseSeq(h.next_seq, 'chain_head.next_seq'), head_hash: str(h.head_hash) }
    : null;
  const maxSeq = typeof h.max_seq === 'string' ? parseSeq(h.max_seq, 'max seq') : -1;

  const fromSeq = options.fromSeq ?? 0;
  const lastKnown = Math.max(head ? head.next_seq - 1 : -1, maxSeq);
  const toSeq = options.toSeq ?? lastKnown;
  if (toSeq < fromSeq && options.toSeq === undefined) {
    // An empty chain (and nothing stored past it): nothing to check.
    assertRange(fromSeq, fromSeq);
    return {
      report_version: CHAIN_REPORT_VERSION, tenant_id: tenantId, range: { from_seq: fromSeq, to_seq: toSeq },
      checked: 0, ok: true, chain_intact: true, breaks: [], breaks_truncated: false, head,
      signatures: options.keys ? 'checked' : 'not_checked', warnings: head ? [] : ['head_not_supplied'],
    };
  }
  assertRange(fromSeq, toSeq);

  let expectedPrevHash: string | null = null;
  if (fromSeq > 0) {
    const prev = (await db.execute(sql`
      select record_hash from attesta_records where tenant_id = ${tenantId} and seq = ${fromSeq - 1}`)).rows;
    expectedPrevHash = typeof prev[0]?.record_hash === 'string' && HASH_RE.test(prev[0].record_hash as string)
      ? (prev[0].record_hash as string) : null;
  }

  const report = await verifyChainRows(pages(db, tenantId, fromSeq, toSeq, pageSize), {
    tenantId, fromSeq, toSeq, expectedPrevHash, head, keys: options.keys, maxBreaks: options.maxBreaks,
  });
  const prepend = (seq: number, kind: ChainBreakKind) => {
    report.breaks.unshift({ seq, kind, detail_code: BREAK_DETAIL_CODES[kind] });
    report.ok = false;
    report.chain_intact = false;
  };
  if (fromSeq > 0 && expectedPrevHash === null && (lastKnown >= fromSeq - 1)) {
    // The predecessor of a ranged check is gone although the chain reached past it.
    prepend(fromSeq - 1, 'seq_gap');
  }
  if (!head && maxSeq >= 0) {
    // Records without a head: the head row was removed behind the guards.
    prepend(0, 'head_mismatch');
  }
  return report;
}
