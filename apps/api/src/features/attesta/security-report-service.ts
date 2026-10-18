/**
 * The security period report (Task15op-b, A15.16; docs/contracts/attesta/security-period-report.md).
 *
 *   parseSecurityReportScope   request validation (ATTESTA_API_INVALID_QUERY on anything else)
 *   checkCoveringSeal          one covering seal against its current rows and its predecessor, with
 *                              the seal service's own break finders (SS2–SS5)
 *   coverageRefusal            the period is sealed through `to` and the covering seals leave no gap
 *   buildSecurityReport        one repeatable-read snapshot → the document and statement
 *                              (security-report-rules.ts) → sign (no transaction) → chain, store and
 *                              audit in ONE ledger transaction; idempotent on the document digest
 *   pgSecurityReportStore      the tenant-bound PostgreSQL store
 *
 * Pattern: period-report-service.ts (Task15i4, SushiCorp RP-1 @ 0bd67a5). Deviations: the CLI
 * builds (no request job, so no lease or job table: the report row is written only with its
 * chained record), and the inputs are sealed rows whose seals are re-checked in the same snapshot
 * (the Task15op-a lesson: recompute every invariant from the rows, never trust a seal's own counts).
 *
 * Every query binds tenant_id. No network call inside a transaction (AGENTS.md §9 item 18). Rows
 * are read as the seal projection and reduced to the columns the figures read; no title, tag,
 * preview, session or command leaves the database in a document or a log (AGENTS.md rule 6).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { recordAuditEvent } from '../../core/audit/record';
import type { SealBreak, SealDatabase, SealDbExecutor } from './audit-seal-service';
import { sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  AttestaLedgerError, SECURITY_PERIOD_REPORT_PREDICATE_TYPE, chainStatement, mapLedgerDatabaseError, parseSeq, statementSigningLimit,
  type LedgerExecutor,
} from './ledger';
import {
  assembleSecurityVerifyReport, readSecurityRows, type SecurityFindingRow, type SecurityVerifySeal,
} from './security-seal-service';
import {
  MAX_SECURITY_REPORT_DAYS, MAX_SECURITY_REPORT_LIST, SECURITY_REPORT_SETTLE_MS, SecurityReportError, buildSecurityReportStatement,
  computeSecurityReportDocument, reportRowOf, securityReportSubjectName, usOf, type DecisionRow, type ReportRow,
  type SecurityReportCode, type SecurityReportInputs, type SecurityReportScope,
} from './security-report-rules';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';

/** Covering seals one report reads (a year of hourly seals and daily empty ones fits). */
export const MAX_SECURITY_REPORT_SEALS = 20_000;
/** Counted rows one report holds in memory; a larger period is refused (split it). */
export const MAX_SECURITY_REPORT_ROWS = 500_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const invalid = (why: string) => new SecurityReportError('ATTESTA_API_INVALID_QUERY', `security report: ${why}`);
const internal = (why: string) => new SecurityReportError('ATTESTA_API_INTERNAL', `security report: ${why}`);
const broken = (why: string) => new SecurityReportError('ATTESTA_SECURITY_SEAL_BROKEN', `security report: ${why}`);

// ---------------------------------------------------------------------------
// Request

export interface SecurityReportRequest { tenantId: string; repositoryId: string | null; from: string; to: string }

/**
 * `{tenantId, repositoryId | null, from, to}`: RFC 3339 UTC with milliseconds (`…T…sssZ`), from < to,
 * at most 366 days. `to` ≤ database clock − 10 minutes is checked in the snapshot (the database clock).
 */
export function parseSecurityReportScope(req: SecurityReportRequest): SecurityReportScope {
  if (typeof req.tenantId !== 'string' || !UUID_RE.test(req.tenantId)) throw invalid('the tenant must be a lowercase UUID');
  if (req.repositoryId !== null && (typeof req.repositoryId !== 'string' || !UUID_RE.test(req.repositoryId))) {
    throw invalid('the repository must be a lowercase UUID');
  }
  const instant = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !ISO_MS_RE.test(v) || !Number.isFinite(Date.parse(v)) || new Date(Date.parse(v)).toISOString() !== v) {
      throw invalid(`${name} must be RFC 3339 UTC with milliseconds`);
    }
    return v;
  };
  const from = instant(req.from, 'from');
  const to = instant(req.to, 'to');
  if (from >= to) throw invalid('from must be before to');
  if (Date.parse(to) - Date.parse(from) > MAX_SECURITY_REPORT_DAYS * 86_400_000) throw invalid('the period is longer than 366 days');
  return { tenant_id: req.tenantId, repository_id: req.repositoryId, from, to, basis: 'received_at' };
}

// ---------------------------------------------------------------------------
// Coverage (pure)

/**
 * SS2–SS5 for one covering seal, with the seal service's own finders (the verify report's code,
 * one seal at a time): its stored document and statement, its current rows, its link to the seal
 * before it. The Attesta signature and anchor check is /api/attesta/verify's, not repeated here.
 */
export function checkCoveringSeal(scope: SecurityReportScope, seal: SecurityVerifySeal,
  predecessor: { windowTo: string; sealDigest: string } | null | undefined, current: SecurityFindingRow[]): SealBreak[] {
  const report = assembleSecurityVerifyReport({ from: scope.from, to: scope.to }, {
    seals: [seal], predecessor, rowsBySeal: new Map([[seal.sealDigest, current]]), tail: { from: null, count: 0 }, orphans: [], beforeFirst: null,
  }, { ok: true, checked: 0, problems: new Set() });
  return report.breaks;
}

export interface CoverageInput {
  scope: SecurityReportScope;
  /** The tenant's latest seal's window_to, or null with no seal. */
  latestWindowTo: string | null;
  /** The tenant's first seal (previous null), or null. */
  firstSeal: { windowFrom: string; sealDigest: string } | null;
  /** The covering seals' windows and links, window order. */
  seals: ReadonlyArray<{ windowFrom: string; windowTo: string; previousDigest: string | null }>;
}

/**
 * NOT_SEALED until the latest seal reaches `to`; BROKEN when the covering seals leave part of the
 * period outside every seal (a removed seal leaves a gap no link check sees from inside the period).
 * null when the period is covered: by the seals, or (before the tenant's first seal) by the
 * before-first check the store runs.
 */
export function coverageRefusal(input: CoverageInput): SecurityReportCode | null {
  const fromUs = usOf(input.scope.from);
  const toUs = usOf(input.scope.to);
  if (input.latestWindowTo === null || input.latestWindowTo < toUs) return 'ATTESTA_SECURITY_PERIOD_NOT_SEALED';
  if (input.seals.length === 0) return input.firstSeal !== null && toUs <= input.firstSeal.windowFrom ? null : 'ATTESTA_SECURITY_SEAL_BROKEN';
  const first = input.seals[0];
  const last = input.seals[input.seals.length - 1];
  if ((first.windowFrom > fromUs && first.previousDigest !== null) || last.windowTo < toUs) return 'ATTESTA_SECURITY_SEAL_BROKEN';
  return null;
}

// ---------------------------------------------------------------------------
// The build

export interface StoredSecurityReport {
  id: string;
  tenantId: string;
  repositoryId: string | null;
  periodFrom: string;
  periodTo: string;
  reportDigest: string;
  statementDigest: string;
  createdAt: string;
}

export interface SecurityReportSnapshot {
  /** Database clock (ms ISO). */
  asOf: string;
  inputs: SecurityReportInputs;
  /** Statement digests of the earlier reports with the same subject name, seq order. */
  previous: string[];
  /** The stored reports of this scope, oldest first. */
  reports: StoredSecurityReport[];
}

export interface ChainSecurityReportInput {
  tenantId: string;
  scope: SecurityReportScope;
  statementCanonical: string;
  envelope: DsseEnvelope;
  credentialId: string;
  keyid: string;
  signatureDer: Buffer;
  publicKeySpkiDer: Buffer;
  previousSeen: string[];
  documentText: string;
  documentDigest: string;
  rowCount: number;
  sealCount: number;
  actor: { type: 'system_operator' | 'service'; id: string };
  requestId: string;
}

export interface SecurityReportStore {
  /** One repeatable-read snapshot; refuses (SecurityReportError) an unsealed, broken, invalid or too large period. */
  readSnapshot(scope: SecurityReportScope): Promise<SecurityReportSnapshot>;
  /** One ledger transaction: chainStatement → the report row → `attesta.security_report.built`. */
  chainReport(input: ChainSecurityReportInput): Promise<{ reportId: string; seq: number }>;
}

export interface SecurityReportDeps {
  store: SecurityReportStore;
  resolver: SignerResolver;
  builderVersion: string;
  actor: { type: 'system_operator' | 'service'; id: string };
  log?: (line: string) => void;
}

export type SecurityReportOutcome = 'built' | 'existing' | 'would_build' | 'refused';

export interface SecurityReportResult {
  outcome: SecurityReportOutcome;
  scope: SecurityReportScope;
  sealCount?: number;
  rowCount?: number;
  decisionCount?: number;
  reportId?: string;
  reportDigest?: string;
  statementDigest?: string;
  code?: string;
}

function codeOf(err: unknown): string {
  if (err instanceof SecurityReportError) return err.code;
  if (err instanceof AttestaLedgerError) return err.code;
  if (err instanceof SigningRejected) return 'ATTESTA_SIGNER_REJECTED';
  if (err instanceof SigningUnavailable) return 'ATTESTA_SIGNER_UNAVAILABLE';
  return 'ATTESTA_API_INTERNAL';
}

/**
 * Build one report. A document whose digest a stored report of the scope already has returns
 * that report (`existing`) and signs nothing; otherwise the statement names every earlier report
 * of the scope in `previous`. A report chained meanwhile (ATTESTA_LEDGER_PREVIOUS_STALE) rebuilds
 * once from a fresh snapshot. `dryRun` reads and computes only.
 */
export async function buildSecurityReport(deps: SecurityReportDeps, scope: SecurityReportScope,
  options: { dryRun?: boolean } = {}): Promise<SecurityReportResult> {
  const requestId = `attesta-security-report:${randomUUID()}`;
  try {
    for (let round = 1; ; round += 1) {
      const snap = await deps.store.readSnapshot(scope);
      const document = computeSecurityReportDocument(snap.inputs);
      const counts = { sealCount: document.seals.length, rowCount: document.row_count, decisionCount: document.decisions.length };
      const built = buildSecurityReportStatement({
        document, asOf: snap.asOf, builderVersion: deps.builderVersion, previous: snap.previous, inputs: snap.inputs,
      });
      const same = snap.reports.find((r) => r.reportDigest === built.documentDigest);
      if (same) {
        return { outcome: 'existing', scope, ...counts, reportId: same.id, reportDigest: same.reportDigest, statementDigest: same.statementDigest };
      }
      if (options.dryRun) return { outcome: 'would_build', scope, ...counts };
      const signer = await deps.resolver.resolve(scope.tenant_id);
      if (!signer) throw new SecurityReportError('ATTESTA_SIGNER_NO_CREDENTIAL', 'the tenant has no active statement key');
      const payload = Buffer.from(built.statementCanonical, 'utf8');
      const signedBytes = pae(IN_TOTO_PAYLOAD_TYPE, payload);
      if (signedBytes.length > statementSigningLimit(signer.adapter.capabilities().maxPayloadBytes)) {
        throw new SecurityReportError('ATTESTA_BUILDER_TOO_LARGE', 'the report statement does not fit the statement signing limit');
      }
      const signed = await signVerified(signer.adapter, signedBytes, { credentialId: signer.credentialId, tenantId: scope.tenant_id, requestId });
      const keyid = sha256Prefixed(signed.publicKeySpkiDer);
      try {
        const chained = await deps.store.chainReport({
          tenantId: scope.tenant_id, scope, statementCanonical: built.statementCanonical,
          envelope: { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid, sig: signed.signature.toString('base64') }] },
          credentialId: signer.credentialId, keyid, signatureDer: signed.signature, publicKeySpkiDer: signed.publicKeySpkiDer,
          previousSeen: snap.previous, documentText: built.documentText, documentDigest: built.documentDigest,
          rowCount: counts.rowCount, sealCount: counts.sealCount, actor: deps.actor, requestId,
        });
        return { outcome: 'built', scope, ...counts, reportId: chained.reportId, reportDigest: built.documentDigest, statementDigest: built.statementDigest };
      } catch (err) {
        if (err instanceof AttestaLedgerError && err.code === 'ATTESTA_LEDGER_PREVIOUS_STALE' && round === 1) continue;
        throw err;
      }
    }
  } catch (err) {
    const code = codeOf(err);
    (deps.log ?? ((line: string) => console.error(line)))(
      `attesta-security-report ${code} tenant=${scope.tenant_id} cause=${err instanceof Error ? err.name : 'unknown'}`);
    return { outcome: 'refused', scope, code };
  }
}

/** The status body of GET /security-period-reports/{id}. */
export function securityReportStatusBody(r: StoredSecurityReport) {
  return {
    id: r.id,
    scope: { tenant_id: r.tenantId, repository_id: r.repositoryId, from: r.periodFrom, to: r.periodTo, basis: 'received_at' },
    report_digest: r.reportDigest,
    statement_digest: r.statementDigest,
    created_at: r.createdAt,
  };
}

/** The stored document, checked against its digest; a mismatch is a 500, never a download. */
export function securityReportDocumentBody(r: StoredSecurityReport, stored: string | null): string {
  if (stored === null || sha256Prefixed(stored) !== r.reportDigest) throw internal('the stored document does not match its digest');
  return stored;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const usText = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const REPORT_COLUMNS = sql.raw(`id::text as id, tenant_id::text as tenant_id, repository_id::text as repository_id, period_from, period_to,
  report_digest, statement_digest, to_char(created_at at time zone 'UTC', ${TS_MS}) as created_at`);

function toStored(r: Record<string, unknown>): StoredSecurityReport {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), repositoryId: strOrNull(r.repository_id), periodFrom: str(r.period_from),
    periodTo: str(r.period_to), reportDigest: str(r.report_digest), statementDigest: str(r.statement_digest), createdAt: str(r.created_at),
  };
}

function decisionFromDb(x: Record<string, unknown>): DecisionRow {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((e) => String(e)) : []);
  return {
    id: str(x.id), machine_id: str(x.machine_id), record_id: str(x.record_id), decision: str(x.decision), mode: str(x.mode),
    rule_ids: arr(x.rule_ids), deny_rule_id: strOrNull(x.deny_rule_id), deny_rule_version: strOrNull(x.deny_rule_version),
    finding_record_ids: arr(x.finding_record_ids), tool_name: strOrNull(x.tool_name), tool_call_id: strOrNull(x.tool_call_id),
    session_id: strOrNull(x.session_id), source_agent: str(x.source_agent), occurred_at: str(x.occurred_at), received_at: str(x.received_at),
  };
}

/** The coverage and every counted row, read inside the caller's snapshot transaction. */
async function readCoverage(tx: SealDbExecutor, scope: SecurityReportScope): Promise<{ seals: SecurityVerifySeal[]; rows: ReportRow[] }> {
  const t = scope.tenant_id;
  const fromUs = usOf(scope.from);
  const toUs = usOf(scope.to);
  const latest = (await tx.execute(sql`/* security-report:latest_seal */
    select window_to from attesta_security_finding_seals where tenant_id = ${t}::uuid order by window_to desc limit 1`)).rows[0];
  const firstRow = (await tx.execute(sql`/* security-report:first_seal */
    select window_from, seal_digest from attesta_security_finding_seals where tenant_id = ${t}::uuid and previous_digest is null`)).rows[0];
  const sealRows = (await tx.execute(sql`/* security-report:seals */
    select s.window_from, s.window_to, s.row_count, s.task6a_count, s.v2_count, s.previous_digest, s.seal_document, s.seal_digest,
           s.statement_digest, r.seq::text as seq, r.statement_canonical, r.statement_digest as record_statement_digest
    from attesta_security_finding_seals s
    left join attesta_records r on r.tenant_id = s.tenant_id and r.id = s.record_id
    where s.tenant_id = ${t}::uuid
      and s.window_from::timestamptz < ${toUs}::timestamptz and s.window_to::timestamptz > ${fromUs}::timestamptz
    order by s.window_from limit ${MAX_SECURITY_REPORT_SEALS + 1}`)).rows;
  if (sealRows.length > MAX_SECURITY_REPORT_SEALS) throw new SecurityReportError('ATTESTA_BUILDER_TOO_LARGE', 'too many seals for one report');
  const seals: SecurityVerifySeal[] = sealRows.map((r) => ({
    tenantId: t, windowFrom: str(r.window_from), windowTo: str(r.window_to), rowCount: Number(r.row_count),
    task6aCount: Number(r.task6a_count), v2Count: Number(r.v2_count), previousDigest: strOrNull(r.previous_digest),
    sealDocument: str(r.seal_document), sealDigest: str(r.seal_digest), statementDigest: str(r.statement_digest),
    seq: typeof r.seq === 'string' ? parseSeq(r.seq) : null, statementCanonical: strOrNull(r.statement_canonical),
    recordStatementDigest: strOrNull(r.record_statement_digest),
  }));
  const firstSeal = firstRow ? { windowFrom: str(firstRow.window_from), sealDigest: str(firstRow.seal_digest) } : null;
  const refusal = coverageRefusal({ scope, latestWindowTo: latest ? str(latest.window_to) : null, firstSeal, seals });
  if (refusal === 'ATTESTA_SECURITY_PERIOD_NOT_SEALED') throw new SecurityReportError(refusal, 'security report: the period is not sealed through to');
  if (refusal !== null) throw broken('the covering seals leave a gap');

  let predecessor: { windowTo: string; sealDigest: string } | null | undefined = null;
  if (seals[0] && seals[0].previousDigest !== null) {
    const p = (await tx.execute(sql`/* security-report:predecessor */
      select window_to, seal_digest from attesta_security_finding_seals
      where tenant_id = ${t}::uuid and seal_digest = ${seals[0].previousDigest}`)).rows[0];
    predecessor = p ? { windowTo: str(p.window_to), sealDigest: str(p.seal_digest) } : undefined;
  }
  const rows: ReportRow[] = [];
  for (const seal of seals) {
    // One more than the seal holds: any extra row is a late insert, so the bound never hides a break.
    const current = await readSecurityRows(tx, t, seal.windowFrom, seal.windowTo, seal.rowCount + 1);
    if (checkCoveringSeal(scope, seal, predecessor, current).length > 0) throw broken('a covering seal shows a break');
    predecessor = { windowTo: seal.windowTo, sealDigest: seal.sealDigest };
    for (const row of current) {
      if (row.received_at < fromUs || row.received_at >= toUs) continue;
      if (scope.repository_id !== null && row.repository_id !== scope.repository_id) continue;
      rows.push(reportRowOf(row));
    }
    if (rows.length > MAX_SECURITY_REPORT_ROWS) throw new SecurityReportError('ATTESTA_BUILDER_TOO_LARGE', 'too many rows for one report; split the period');
  }
  // Rows received before the tenant's first seal are in no window: inserted after sealing.
  if (firstSeal && fromUs < firstSeal.windowFrom) {
    const end = toUs < firstSeal.windowFrom ? toUs : firstSeal.windowFrom;
    const early = await tx.execute(sql`/* security-report:before_first */
      select 1 as one from security_findings where tenant_id = ${t}::uuid
        and received_at >= ${fromUs}::timestamptz and received_at < ${end}::timestamptz limit 1`);
    if (early.rows.length > 0) throw broken('a row lies before the first seal');
  }
  return { seals, rows };
}

/** `clock` is chainStatement's recorded_at seam (live tests); production uses the default. */
export function pgSecurityReportStore(db: SealDatabase = coreDb as unknown as SealDatabase, options: { clock?: () => Date } = {}): SecurityReportStore & {
  get(tenantId: string, id: string): Promise<StoredSecurityReport | null>;
  document(tenantId: string, id: string): Promise<string | null>;
} {
  return {
    async readSnapshot(scope) {
      return db.transaction(async (tx) => {
        const t = scope.tenant_id;
        const asOf = str((await tx.execute(sql`/* security-report:clock */
          select ${sql.raw(`to_char(now() at time zone 'UTC', ${TS_MS})`)} as as_of`)).rows[0]?.as_of);
        if (!ISO_MS_RE.test(asOf)) throw internal('the database clock is malformed');
        if (Date.parse(scope.to) > Date.parse(asOf) - SECURITY_REPORT_SETTLE_MS) throw invalid('to must be at least 10 minutes before the database clock');
        if (scope.repository_id !== null) {
          // Another tenant's repository and an unknown one are the same refusal.
          const repo = await tx.execute(sql`/* security-report:repository */
            select 1 as ok from scm_repositories where tenant_id = ${t}::uuid and id = ${scope.repository_id}::uuid`);
          if (repo.rows.length === 0) throw invalid('the repository is not a repository of this tenant');
        }
        const { seals, rows } = await readCoverage(tx, scope);
        const decisions = scope.repository_id !== null ? [] : (await tx.execute(sql`/* security-report:decisions */
          select id::text as id, machine_id::text as machine_id, record_id, decision, mode, rule_ids, deny_rule_id, deny_rule_version,
                 finding_record_ids, tool_name, tool_call_id, session_id, source_agent,
                 ${usText('occurred_at')} as occurred_at, ${usText('received_at')} as received_at
          from security_enforcement_decisions
          where tenant_id = ${t}::uuid and decision = 'deny'
            and received_at >= ${usOf(scope.from)}::timestamptz and received_at < ${usOf(scope.to)}::timestamptz
          order by received_at, id limit ${MAX_SECURITY_REPORT_LIST + 1}`)).rows.map(decisionFromDb);
        if (decisions.length > MAX_SECURITY_REPORT_LIST) throw new SecurityReportError('ATTESTA_BUILDER_TOO_LARGE', 'too many decisions for one report');
        const machines = [...new Set(rows.filter((r) => r.record_generation === 'v2').map((r) => r.machine_id))];
        const platforms: Record<string, string | null> = {};
        for (let i = 0; i < machines.length; i += 5000) {
          const chunk = machines.slice(i, i + 5000);
          const states = await tx.execute(sql`/* security-report:platforms */
            select machine_id::text as machine_id, platform from fleet_machine_states
            where tenant_id = ${t}::uuid and machine_id = any(${`{${chunk.join(',')}}`}::uuid[])`);
          for (const s of states.rows) platforms[str(s.machine_id)] = strOrNull(s.platform);
        }
        const previous = (await tx.execute(sql`/* security-report:previous */
          select statement_digest from attesta_records
          where tenant_id = ${t}::uuid and predicate_type = ${SECURITY_PERIOD_REPORT_PREDICATE_TYPE}
            and repository_id is not distinct from ${scope.repository_id}::uuid
            and (statement_canonical::jsonb)->'subject'->0->>'name' = ${securityReportSubjectName(scope)}
          order by seq`)).rows.map((r) => str(r.statement_digest));
        const reports = (await tx.execute(sql`/* security-report:stored */
          select ${REPORT_COLUMNS} from attesta_security_period_reports
          where tenant_id = ${t}::uuid and repository_id is not distinct from ${scope.repository_id}::uuid
            and period_from = ${scope.from} and period_to = ${scope.to}
          order by created_at, id`)).rows.map(toStored);
        return {
          asOf,
          inputs: {
            tenantId: t, scope,
            seals: seals.map((s) => {
              if (s.seq === null) throw broken('a covering seal has no ledger record');
              return { seq: s.seq, statement_digest: s.statementDigest, seal_digest: s.sealDigest, window: { from: s.windowFrom, to: s.windowTo } };
            }),
            rows, decisions, platforms,
          },
          previous,
          reports,
        };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async chainReport(input) {
      try {
        return await db.transaction(async (tx) => {
          const chained = await chainStatement(tx as LedgerExecutor, {
            tenantId: input.tenantId, statementCanonical: input.statementCanonical, envelope: input.envelope,
            credentialId: input.credentialId, keyid: input.keyid, signatureDer: input.signatureDer,
            publicKeySpkiDer: input.publicKeySpkiDer, previousSeen: input.previousSeen,
          }, options.clock);
          if (chained.duplicate) throw internal('a fresh report statement was already chained');
          const inserted = await tx.execute(sql`/* security-report:insert */
            insert into attesta_security_period_reports (tenant_id, repository_id, period_from, period_to, report_document,
              report_digest, record_id, statement_digest)
            values (${input.tenantId}::uuid, ${input.scope.repository_id}::uuid, ${input.scope.from}, ${input.scope.to},
              ${input.documentText}, ${input.documentDigest}, ${chained.recordId}::uuid, ${chained.statementDigest})
            returning id::text as id`);
          const reportId = str(inserted.rows[0]?.id);
          if (!reportId) throw internal('the report insert returned no id');
          await recordAuditEvent(tx, input.tenantId, {
            action: 'attesta.security_report.built',
            actorType: input.actor.type,
            actorId: input.actor.id,
            targetType: 'attesta_security_period_report',
            targetId: reportId,
            details: {
              scope_from: input.scope.from,
              scope_to: input.scope.to,
              repository_id: input.scope.repository_id,
              report_digest: input.documentDigest,
              statement_digest: chained.statementDigest,
              row_count: input.rowCount,
              seal_count: input.sealCount,
              request_id: input.requestId,
            },
          });
          return { reportId, seq: chained.seq };
        });
      } catch (err) {
        throw mapLedgerDatabaseError(err) ?? err;
      }
    },

    async get(tenantId, id) {
      const r = await db.execute(sql`/* security-report:get */
        select ${REPORT_COLUMNS} from attesta_security_period_reports where tenant_id = ${tenantId}::uuid and id = ${id}::uuid`);
      return r.rows[0] ? toStored(r.rows[0]) : null;
    },

    async document(tenantId, id) {
      const r = await db.execute(sql`/* security-report:document */
        select report_document from attesta_security_period_reports where tenant_id = ${tenantId}::uuid and id = ${id}::uuid`);
      return strOrNull(r.rows[0]?.report_document);
    },
  };
}

/** The downloaded-document audit event (attesta.routes.ts). */
export async function recordSecurityReportDownload(input: {
  tenantId: string; actorId: string; actorRole: 'tenant_admin' | 'tenant_auditor'; report: StoredSecurityReport; requestId: string;
}): Promise<void> {
  await recordAuditEvent(coreDb, input.tenantId, {
    action: 'attesta.security_report.downloaded',
    actorType: input.actorRole,
    actorId: input.actorId,
    targetType: 'attesta_security_period_report',
    targetId: input.report.id,
    details: { report_digest: input.report.reportDigest, statement_digest: input.report.statementDigest, request_id: input.requestId },
  });
}
