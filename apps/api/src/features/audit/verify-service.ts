/**
 * The audit verify report (Task16e, A16.4; docs/contracts/attesta/audit-seal.md "The verify
 * report"): `GET /api/audit/verify?from&to`.
 *
 * For every seal overlapping [from, to): the stored document against its columns and digest,
 * each sealed row recomputed from the current table (missing, changed, late-inserted rows),
 * the `previous` links, and Attesta's own check of the seal's ledger record (chain link, hash,
 * statement, signature, anchors, key windows) through `verifyRange`, the function behind
 * `/api/attesta/verify`. Rows newer than the last seal are `unsealed_tail`, never verified.
 * One `audit.trail.verified` event per call.
 *
 * Every query binds tenant_id. Reads run in one repeatable-read snapshot; the per-seal
 * Attesta checks run after it (each in its own read-only snapshot).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { recordAuditEvent } from '../../core/audit/record';
import {
  MAX_SEAL_ROWS, OCCURRED_AT_US, checkSealLinks, checkSealRows, parseSealDocument, readAuditRows,
  type SealBreak, type SealDatabase, type StoredSeal,
} from '../attesta/audit-seal-service';
import { AUDIT_SEAL_PREDICATE_TYPE, deriveStatementColumns } from '../attesta/ledger';
import { verifyRange, type VerifyDeps } from '../attesta/read-service';
import { AuditQueryError } from './read-service';

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** The longest window one report checks (rows are recomputed in memory). */
export const MAX_VERIFY_DAYS = 31;
export const MAX_VERIFY_SEALS = 1000;
export const MAX_REPORT_BREAKS = 1000;

export interface AuditVerifyQuery { from: string; to: string }

/** `from` and `to` are required RFC 3339 instants, from < to, at most 31 days apart. */
export function parseAuditVerifyQuery(query: Record<string, unknown>): AuditVerifyQuery {
  for (const name of Object.keys(query)) {
    if (name !== 'from' && name !== 'to') throw new AuditQueryError('AUDIT_FILTER_INVALID', `unknown parameter ${name}`);
  }
  const one = (name: string): string => {
    const v = query[name];
    if (typeof v !== 'string' || !RFC3339_RE.test(v) || !Number.isFinite(Date.parse(v))) {
      throw new AuditQueryError('AUDIT_FILTER_INVALID', `${name} is invalid`);
    }
    return v;
  };
  const from = one('from');
  const to = one('to');
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > MAX_VERIFY_DAYS * 86_400_000) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'from/to span is invalid');
  return { from, to };
}

export interface AuditVerifyReport {
  ok: boolean;
  from: string;
  to: string;
  seals_checked: number;
  breaks: SealBreak[];
  breaks_truncated: boolean;
  unsealed_tail: { from: string | null; count: number };
  chain: { ok: boolean; checked: number };
}

/** One seal as read for the report, with its ledger record. */
export interface VerifySeal extends StoredSeal {
  seq: number | null;
  statementCanonical: string | null;
  recordStatementDigest: string | null;
  statementDigest: string;
}

export interface VerifySnapshot {
  seals: VerifySeal[];
  /** The seal before the first listed one: null when the first is the tenant's first, undefined when missing. */
  predecessor: { windowTo: string; sealDigest: string } | null | undefined;
  /** Every row of the tenant now in each listed seal's window, by seal digest. */
  rowsBySeal: Map<string, Awaited<ReturnType<typeof readAuditRows>>>;
  tail: { from: string | null; count: number };
  /** Seal digests named by audit_seal ledger records in the window that have no seal row (a removed seal). */
  orphans: string[];
}

/**
 * The pure part: seals, rows and links → breaks. `chainProblems` are the seal digests whose
 * Attesta record check was not ok.
 */
export function assembleVerifyReport(q: AuditVerifyQuery, snap: VerifySnapshot, chain: { ok: boolean; checked: number; problems: Set<string> }): AuditVerifyReport {
  const breaks: SealBreak[] = [];
  for (const seal of snap.seals) {
    const doc = parseSealDocument(seal);
    let statementOk = doc !== null && seal.statementCanonical !== null && seal.recordStatementDigest === seal.statementDigest;
    if (statementOk && doc) {
      try {
        const columns = deriveStatementColumns(seal.statementCanonical as string);
        const parsed = JSON.parse(seal.statementCanonical as string) as { subject: Array<{ digest: { sha256: string } }>; predicate: Record<string, unknown> };
        const p = parsed.predicate;
        statementOk = columns.tenantScope === seal.tenantId
          && parsed.subject[0].digest.sha256 === seal.sealDigest.slice('sha256:'.length)
          && JSON.stringify(p.window) === JSON.stringify(doc.window) && p.count === doc.count
          && p.rows_root === doc.rows_root && p.previous_seal === doc.previous && p.catalog_version === doc.catalog_version;
      } catch {
        statementOk = false;
      }
    }
    if (!statementOk || chain.problems.has(seal.sealDigest)) breaks.push({ kind: 'statement_problem', seal: seal.sealDigest });
    if (doc) breaks.push(...checkSealRows(doc, seal.sealDigest, snap.rowsBySeal.get(seal.sealDigest) ?? []));
  }
  breaks.push(...checkSealLinks(snap.seals, snap.predecessor));
  for (const digest of snap.orphans) breaks.push({ kind: 'broken_previous', seal: digest });
  return {
    ok: breaks.length === 0 && chain.ok,
    from: q.from,
    to: q.to,
    seals_checked: snap.seals.length,
    breaks: breaks.slice(0, MAX_REPORT_BREAKS),
    breaks_truncated: breaks.length > MAX_REPORT_BREAKS,
    unsealed_tail: snap.tail,
    chain: { ok: chain.ok, checked: chain.checked },
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The snapshot read: one repeatable-read, read-only transaction. */
export async function readVerifySnapshot(database: SealDatabase, tenantId: string, q: AuditVerifyQuery): Promise<VerifySnapshot> {
  return database.transaction(async (tx) => {
    const sealRows = (await tx.execute(sql`/* audit-verify:seals */
      select s.window_from, s.window_to, s.row_count, s.previous_digest, s.seal_document, s.seal_digest,
             s.statement_digest, r.seq::text as seq, r.statement_canonical, r.statement_digest as record_statement_digest
      from attesta_audit_seals s
      left join attesta_records r on r.tenant_id = s.tenant_id and r.id = s.record_id
      where s.tenant_id = ${tenantId}::uuid
        and s.window_from::timestamptz < ${q.to}::timestamptz and s.window_to::timestamptz > ${q.from}::timestamptz
      order by s.window_from limit ${MAX_VERIFY_SEALS + 1}`)).rows;
    if (sealRows.length > MAX_VERIFY_SEALS) throw new AuditQueryError('AUDIT_FILTER_INVALID', 'too many seals for one report');
    const seals: VerifySeal[] = sealRows.map((r) => ({
      tenantId, windowFrom: str(r.window_from), windowTo: str(r.window_to), rowCount: Number(r.row_count),
      previousDigest: strOrNull(r.previous_digest), sealDocument: str(r.seal_document), sealDigest: str(r.seal_digest),
      statementDigest: str(r.statement_digest), seq: typeof r.seq === 'string' ? Number(r.seq) : null,
      statementCanonical: strOrNull(r.statement_canonical), recordStatementDigest: strOrNull(r.record_statement_digest),
    }));
    let predecessor: VerifySnapshot['predecessor'] = null;
    const first = seals[0];
    if (first && first.previousDigest !== null) {
      const p = (await tx.execute(sql`/* audit-verify:predecessor */
        select window_to, seal_digest from attesta_audit_seals where tenant_id = ${tenantId}::uuid and seal_digest = ${first.previousDigest}`)).rows[0];
      predecessor = p ? { windowTo: str(p.window_to), sealDigest: str(p.seal_digest) } : undefined;
    }
    const rowsBySeal = new Map<string, Awaited<ReturnType<typeof readAuditRows>>>();
    for (const s of seals) {
      // Twice the seal bound: late inserts beyond that are still reported (as many as fit).
      rowsBySeal.set(s.sealDigest, await readAuditRows(tx, tenantId, s.windowFrom, s.windowTo, 2 * MAX_SEAL_ROWS));
    }
    const last = (await tx.execute(sql`/* audit-verify:last */
      select window_to from attesta_audit_seals where tenant_id = ${tenantId}::uuid order by window_to desc limit 1`)).rows[0];
    const tailFrom = last ? str(last.window_to) : null;
    const tail = (await tx.execute(tailFrom === null
      ? sql`/* audit-verify:tail */ select count(*)::int as n, min(${OCCURRED_AT_US}) as first from security_audit_events where tenant_id = ${tenantId}::uuid`
      : sql`/* audit-verify:tail */ select count(*)::int as n, ${tailFrom}::text as first from security_audit_events
          where tenant_id = ${tenantId}::uuid and occurred_at >= ${tailFrom}::timestamptz`)).rows[0] ?? {};
    // A seal row removed behind the guards leaves its chained statement: find those in the window.
    const orphanRows = (await tx.execute(sql`/* audit-verify:orphans */
      select r.statement_canonical from attesta_records r
      where r.tenant_id = ${tenantId}::uuid and r.predicate_type = ${AUDIT_SEAL_PREDICATE_TYPE}
        and not exists (select 1 from attesta_audit_seals s where s.tenant_id = r.tenant_id and s.record_id = r.id)
        and ((r.statement_canonical::jsonb)->'predicate'->'window'->>'from')::timestamptz < ${q.to}::timestamptz
        and ((r.statement_canonical::jsonb)->'predicate'->'window'->>'to')::timestamptz > ${q.from}::timestamptz
      order by r.seq limit ${MAX_REPORT_BREAKS}`)).rows;
    const orphans = orphanRows.map((r) => {
      try {
        const st = JSON.parse(str(r.statement_canonical)) as { subject: Array<{ digest: { sha256: string } }> };
        return `sha256:${st.subject[0].digest.sha256}`;
      } catch {
        return null;
      }
    }).filter((d): d is string => d !== null);
    return { seals, predecessor, rowsBySeal, tail: { from: strOrNull(tail.first), count: Number(tail.n ?? 0) }, orphans };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export interface AuditVerifyDeps {
  database: SealDatabase;
  /** The /api/attesta/verify dependencies (store, verifier, keys, anchors, clock). */
  attesta: VerifyDeps;
}

export interface AuditVerifyInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  requestId: string;
  query: AuditVerifyQuery;
}

/** The report, then one `audit.trail.verified` event. */
export async function verifyAuditTrail(deps: AuditVerifyDeps, input: AuditVerifyInput): Promise<AuditVerifyReport> {
  const snap = await readVerifySnapshot(deps.database, input.tenantId, input.query);
  // Each seal record checked on its own seq (a one-record range: its link to the predecessor,
  // hash, statement, signature, anchors), so the report never depends on unrelated records.
  // The Attesta check writes no attesta.verify row here: audit.trail.verified covers the call.
  const attesta: VerifyDeps = { ...deps.attesta, store: { ...deps.attesta.store, recordVerifyAudit: async () => undefined } };
  const problems = new Set<string>();
  let checked = 0;
  let chainOk = true;
  for (const seal of snap.seals) {
    if (seal.seq === null) continue;
    const report = await verifyRange(attesta, {
      tenantId: input.tenantId, actorId: input.actorId, actorRole: input.actorRole, requestId: input.requestId,
      fromSeq: seal.seq, toSeq: seal.seq,
    });
    checked += report.checked;
    if (!report.ok) {
      chainOk = false;
      if (report.breaks.some((b) => b.kind !== 'signatures_not_checked' && b.kind !== 'anchor_not_checkable')) problems.add(seal.sealDigest);
    }
  }
  const report = assembleVerifyReport(input.query, snap, { ok: chainOk, checked, problems });
  await recordAuditEvent(db, input.tenantId, {
    action: 'audit.trail.verified',
    actorType: input.actorRole,
    actorId: input.actorId,
    targetType: 'security_audit_events',
    targetId: input.tenantId,
    details: {
      from: input.query.from,
      to: input.query.to,
      ok: report.ok,
      seals_checked: report.seals_checked,
      break_count: report.breaks.length,
      request_id: input.requestId,
    },
  });
  return report;
}
