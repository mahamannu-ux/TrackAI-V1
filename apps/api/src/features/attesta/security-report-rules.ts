/**
 * The `security_period_report` statement (Task15op-b, A15.16; docs/contracts/attesta/security-period-report.md,
 * predicate-security-period-report-v1.schema.json, security-period-report-document-v1.schema.json).
 *
 *   computeSecurityReportDocument   pure: the covering seals, the intact sealed rows of the period,
 *                                   the deny decisions and the machines' current platforms → the
 *                                   report document (figures, completeness, the lists)
 *   buildSecurityReportStatement    the in-toto statement naming the document's digest; schemas,
 *                                   then SR1–SR9, before anything is signed
 *   checkSecurityReport             rules SR1–SR9 between a statement, its document and (when given)
 *                                   the inputs it was computed from
 *   decisionDigest                  the enforcement-decision digest (the contract's projection)
 *
 * Pattern: period-report-rules.ts (Task15i4, SushiCorp RP-1 @ 0bd67a5): the figures come only from
 * sealed, verified rows, the document carries no clock or builder so a re-run gives the same bytes,
 * and a small signed statement names the document's digest. Deviations from P1–P10: a report
 * counts rows, not statements; every bucket figure keeps every row (a row with no value lands in
 * its fixed `unknown` / `unavailable` / `v2_unclassified` bucket), so SR5's sums always hold.
 *
 * Honest states (AGENTS.md rule 7): `blocked` is always unavailable (`monitor_only_observed`), a
 * Numbat deny is counted as a request, and a v2 platform is the machine's current state.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { canonicalize, sha256Prefixed } from './canonical';
import { IN_TOTO_STATEMENT_TYPE, SECURITY_PERIOD_REPORT_PREDICATE_TYPE } from './ledger';
import { digestsRoot } from './period-report-rules';
import { compareSecurityRows, securityRowDigest, type SecurityFindingRow } from './security-seal-service';

export const SECURITY_REPORT_DOCUMENT_FORMAT = 'https://trackai.dev/attesta/security-period-report-document/v1';
export const SECURITY_REPORT_BUILDER_NAME = 'trackai-security-report-builder';
/** `to` ≤ as_of − 10 minutes (the seals' settle margin). */
export const SECURITY_REPORT_SETTLE_MS = 600_000;
export const MAX_SECURITY_REPORT_DAYS = 366;
/** Buckets one figure may hold (the schema's bound). */
export const MAX_SECURITY_REPORT_BUCKETS = 10_000;
/** Entries in one document list (seals, decisions, machine_platforms; the schema's bound). */
export const MAX_SECURITY_REPORT_LIST = 100_000;

export const ROW_FIGURES = [
  'by_severity', 'by_category', 'by_rule', 'by_generation', 'by_repository', 'by_agent', 'by_model', 'by_platform', 'outcomes',
] as const;
export type BucketFigureName = (typeof ROW_FIGURES)[number];
export const SECURITY_FIGURES = [
  'findings', ...ROW_FIGURES, 'denied_by_request', 'rule_pack_versions', 'late_arrivals',
] as const;
export type SecurityFigureName = (typeof SECURITY_FIGURES)[number];

const PLATFORMS = new Set(['macos', 'linux', 'windows', 'wsl']);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const US_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export type SecurityReportCode =
  | 'ATTESTA_API_INVALID_QUERY' | 'ATTESTA_API_INTERNAL' | 'ATTESTA_SECURITY_PERIOD_NOT_SEALED' | 'ATTESTA_SECURITY_SEAL_BROKEN'
  | 'ATTESTA_BUILDER_TOO_LARGE' | 'ATTESTA_BUILDER_SCHEMA_INVALID' | 'ATTESTA_BUILDER_RULE_VIOLATION' | 'ATTESTA_SIGNER_NO_CREDENTIAL';

/** Errors carry no raw values (AGENTS.md §10). */
export class SecurityReportError extends Error {
  constructor(readonly code: SecurityReportCode, message: string) {
    super(message);
    this.name = 'SecurityReportError';
  }
}
const ruleError = (why: string) => new SecurityReportError('ATTESTA_BUILDER_RULE_VIOLATION', `security report: ${why}`);
const tooLarge = (why: string) => new SecurityReportError('ATTESTA_BUILDER_TOO_LARGE', `security report: ${why}`);

// ---------------------------------------------------------------------------
// Inputs

export interface SecurityReportScope {
  tenant_id: string;
  repository_id: string | null;
  from: string;
  to: string;
  basis: 'received_at';
}

/** One covering seal as the document lists it. */
export interface ReportSealRef { seq: number; statement_digest: string; seal_digest: string; window: { from: string; to: string } }

/** The columns of one counted row the figures read, plus its seal row digest. */
export interface ReportRow {
  id: string;
  digest: string;
  received_at: string;
  occurred_at: string;
  record_generation: string;
  machine_id: string;
  repository_id: string | null;
  rule_severity: string;
  rule_category: string;
  rule_id: string;
  agent_family: string | null;
  source_agent: string | null;
  model: string | null;
  operating_system: string | null;
  phase: string | null;
  rule_pack_version: string;
}

/** A stored row reduced to what a report reads; the digest is the seal's (security-findings-seal.md). */
export function reportRowOf(row: SecurityFindingRow): ReportRow {
  return {
    id: row.id, digest: securityRowDigest(row), received_at: row.received_at, occurred_at: row.occurred_at,
    record_generation: row.record_generation, machine_id: row.machine_id, repository_id: row.repository_id,
    rule_severity: row.rule_severity, rule_category: row.rule_category, rule_id: row.rule_id, agent_family: row.agent_family,
    source_agent: row.source_agent, model: row.model, operating_system: row.operating_system, phase: row.phase,
    rule_pack_version: row.rule_pack_version,
  };
}

/**
 * One `security_enforcement_decisions` row as the decision digest's projection: every column
 * except `tenant_id`, verbatim; timestamps the exact microsecond text, arrays JSON arrays.
 */
export interface DecisionRow {
  id: string;
  machine_id: string;
  record_id: string;
  decision: string;
  mode: string;
  rule_ids: string[];
  deny_rule_id: string | null;
  deny_rule_version: string | null;
  finding_record_ids: string[];
  tool_name: string | null;
  tool_call_id: string | null;
  session_id: string | null;
  source_agent: string;
  occurred_at: string;
  received_at: string;
}

export const DECISION_KEYS = [
  'id', 'machine_id', 'record_id', 'decision', 'mode', 'rule_ids', 'deny_rule_id', 'deny_rule_version', 'finding_record_ids',
  'tool_name', 'tool_call_id', 'session_id', 'source_agent', 'occurred_at', 'received_at',
] as const satisfies ReadonlyArray<keyof DecisionRow>;

/** `"sha256:" + hex(SHA-256(JCS(projection)))` over exactly DECISION_KEYS. */
export function decisionDigest(d: DecisionRow): string {
  if (!US_RE.test(d.occurred_at) || !US_RE.test(d.received_at)) throw ruleError('a decision timestamp is not the exact microsecond text');
  if (!Array.isArray(d.rule_ids) || !Array.isArray(d.finding_record_ids)
    || ![...d.rule_ids, ...d.finding_record_ids].every((v) => typeof v === 'string')) throw ruleError('a decision array is malformed');
  const out: Record<string, unknown> = {};
  for (const key of DECISION_KEYS) out[key] = d[key] === undefined ? null : d[key];
  return sha256Prefixed(canonicalize(out));
}

export interface SecurityReportInputs {
  tenantId: string;
  scope: SecurityReportScope;
  /** The seals whose window overlaps the period, in window order. */
  seals: readonly ReportSealRef[];
  /** The intact sealed rows with from ≤ received_at < to (and the scope's repository), (received_at, id) order. */
  rows: readonly ReportRow[];
  /** Deny decisions received in the period (tenant scope; [] for a repository). */
  decisions: readonly DecisionRow[];
  /** The current `fleet_machine_states.platform` of each v2 machine that has a state row (null when unset). */
  platforms: Readonly<Record<string, string | null>>;
}

// ---------------------------------------------------------------------------
// The document

export type Availability = 'recorded' | 'partial' | 'unavailable';
export type PartialReason = 'current_machine_state' | 'not_sealed' | 'values_hashed_unrepresentable';
export type UnavailableReason = 'not_captured_yet' | 'not_applicable' | 'source_missing';
export interface Bucket { key: string; count: number }
export interface SecurityFigure<V> { availability: Availability; value?: V; partial_reason?: PartialReason; reason?: UnavailableReason }
export interface CompletenessEntry { rows: number; recorded: number; partial: number; unavailable: number }

export type SecurityFigures = { [K in SecurityFigureName]: SecurityFigure<K extends BucketFigureName ? Bucket[] : number> };

export interface SecurityReportDocument {
  format: typeof SECURITY_REPORT_DOCUMENT_FORMAT;
  tenant_id: string;
  scope: SecurityReportScope;
  seals: ReportSealRef[];
  row_count: number;
  rows_root: string;
  decisions: Array<{ id: string; digest: string }>;
  machine_platforms: Array<{ machine_id: string; platform: string }>;
  figures: SecurityFigures;
  blocked: { availability: 'unavailable'; reason: 'monitor_only_observed' };
  coverage: { availability: 'unavailable'; reason: 'not_captured_yet' };
  completeness: Record<SecurityFigureName, CompletenessEntry>;
}

export const BLOCKED = { availability: 'unavailable', reason: 'monitor_only_observed' } as const;
export const COVERAGE = { availability: 'unavailable', reason: 'not_captured_yet' } as const;

/** The microsecond text of a millisecond bound (`…sss` + `000Z`), comparable with received_at. */
export const usOf = (ms: string): string => `${ms.slice(0, 23)}000Z`;

export const securityReportSubjectName = (scope: Pick<SecurityReportScope, 'tenant_id' | 'repository_id' | 'from' | 'to'>): string =>
  `trackai:tenant/${scope.tenant_id}${scope.repository_id === null ? '' : `/repository/${scope.repository_id}`}/security-period/${scope.from}..${scope.to}`;

/** A bucket key: the value when it is a token, else `sha256:<hex of its UTF-8>` (fields.md rule 2). */
export function bucketKey(value: string): { key: string; hashed: boolean } {
  return TOKEN_RE.test(value) ? { key: value, hashed: false } : { key: sha256Prefixed(Buffer.from(value, 'utf8')), hashed: true };
}

type RowState = 'recorded' | 'partial' | 'unavailable';
interface Placed { key: string; state: RowState }

const valued = (value: string): Placed => {
  const k = bucketKey(value);
  return { key: k.key, state: k.hashed ? 'partial' : 'recorded' };
};

/** Where one row lands in each bucket figure, and the state of the value it read there. */
function placeRow(name: BucketFigureName, row: ReportRow, platforms: Readonly<Record<string, string | null>>): Placed {
  const v2 = row.record_generation === 'v2';
  switch (name) {
    case 'by_severity': return valued(row.rule_severity);
    case 'by_category': return valued(row.rule_category);
    case 'by_rule': return valued(row.rule_id);
    case 'by_generation': return valued(row.record_generation);
    case 'by_repository': return row.repository_id === null ? { key: 'not_enrolled', state: 'recorded' } : valued(row.repository_id);
    case 'by_agent': {
      const agent = v2 ? row.source_agent : row.agent_family;
      return agent === null ? { key: 'unknown', state: 'unavailable' } : valued(agent);
    }
    case 'by_model': return v2 && row.model !== null ? valued(row.model) : { key: 'unknown', state: 'unavailable' };
    case 'by_platform': {
      if (!v2) {
        const os = row.operating_system;
        return os !== null && PLATFORMS.has(os) ? { key: os, state: 'recorded' } : { key: 'unavailable', state: 'unavailable' };
      }
      const p = platforms[row.machine_id];
      return typeof p === 'string' && PLATFORMS.has(p) ? { key: p, state: 'partial' } : { key: 'unavailable', state: 'unavailable' };
    }
    case 'outcomes': return v2 || row.phase === null ? { key: 'v2_unclassified', state: 'unavailable' } : valued(row.phase);
  }
}

/** SR6: a bucket figure's availability from its completeness (security-period-report.md "Availability"). */
export function bucketAvailability(name: BucketFigureName, c: CompletenessEntry): Pick<SecurityFigure<unknown>, 'availability' | 'partial_reason' | 'reason'> {
  if (c.rows > 0 && c.recorded + c.partial === 0) return { availability: 'unavailable', reason: 'source_missing' };
  if (c.partial > 0) return { availability: 'partial', partial_reason: name === 'by_platform' ? 'current_machine_state' : 'values_hashed_unrepresentable' };
  return { availability: 'recorded' };
}

/** SR6: `denied_by_request` from the scope and the decision count. */
export function deniedFigure(repositoryScope: boolean, decisions: number): { figure: SecurityFigure<number>; completeness: CompletenessEntry } {
  if (repositoryScope) return { figure: { availability: 'unavailable', reason: 'not_applicable' }, completeness: { rows: 0, recorded: 0, partial: 0, unavailable: 0 } };
  if (decisions === 0) return { figure: { availability: 'recorded', value: 0 }, completeness: { rows: 0, recorded: 0, partial: 0, unavailable: 0 } };
  return { figure: { availability: 'partial', partial_reason: 'not_sealed', value: decisions }, completeness: { rows: decisions, recorded: 0, partial: decisions, unavailable: 0 } };
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const compareDecisions = (a: DecisionRow, b: DecisionRow) => compareSecurityRows(a, b);

function validScope(tenantId: string, scope: SecurityReportScope): boolean {
  return UUID_RE.test(tenantId) && scope.tenant_id === tenantId && (scope.repository_id === null || UUID_RE.test(scope.repository_id))
    && validInstant(scope.from) && validInstant(scope.to) && scope.from < scope.to && scope.basis === 'received_at'
    && Date.parse(scope.to) - Date.parse(scope.from) <= MAX_SECURITY_REPORT_DAYS * 86_400_000;
}

/**
 * The report document. Deterministic: the same inputs give the same bytes (no clock, no builder).
 * Refuses inputs that are not what the snapshot rules allow (rows outside the period, the scope's
 * repository or every seal window, lists out of order) and anything over the size bounds.
 */
export function computeSecurityReportDocument(input: SecurityReportInputs): SecurityReportDocument {
  const { tenantId, scope } = input;
  if (!validScope(tenantId, scope)) throw ruleError('the scope is malformed');
  const fromUs = usOf(scope.from);
  const toUs = usOf(scope.to);
  if (input.seals.length > MAX_SECURITY_REPORT_LIST || input.decisions.length > MAX_SECURITY_REPORT_LIST) throw tooLarge('a document list is over its bound');
  input.seals.forEach((s, i) => {
    if (!(s.window.from < s.window.to && s.window.from < toUs && s.window.to > fromUs)) throw ruleError('a seal does not overlap the period');
    if (i > 0 && (input.seals[i - 1].window.to !== s.window.from || input.seals[i - 1].seq >= s.seq)) throw ruleError('the seals are not contiguous and ordered');
  });
  let sealIndex = 0;
  input.rows.forEach((row, i) => {
    if (row.received_at < fromUs || row.received_at >= toUs) throw ruleError('a row lies outside the period');
    if (scope.repository_id !== null && row.repository_id !== scope.repository_id) throw ruleError('a row is about another repository');
    if (i > 0 && compareSecurityRows(input.rows[i - 1], row) >= 0) throw ruleError('rows are not in (received_at, id) order');
    while (sealIndex < input.seals.length && input.seals[sealIndex].window.to <= row.received_at) sealIndex += 1;
    if (sealIndex === input.seals.length || input.seals[sealIndex].window.from > row.received_at) throw ruleError('a row lies in no covering seal');
  });
  if (scope.repository_id !== null && input.decisions.length > 0) throw ruleError('a repository report counts no decisions');
  input.decisions.forEach((d, i) => {
    if (d.decision !== 'deny' || d.received_at < fromUs || d.received_at >= toUs) throw ruleError('a decision is not a deny in the period');
    if (i > 0 && compareDecisions(input.decisions[i - 1], d) >= 0) throw ruleError('decisions are not in (received_at, id) order');
  });

  const n = input.rows.length;
  const figures = {} as Record<SecurityFigureName, SecurityFigure<unknown>>;
  const completeness = {} as Record<SecurityFigureName, CompletenessEntry>;
  const full = (): CompletenessEntry => ({ rows: n, recorded: n, partial: 0, unavailable: 0 });
  figures.findings = { availability: 'recorded', value: n };
  completeness.findings = full();
  for (const name of ROW_FIGURES) {
    const counts = new Map<string, number>();
    const c: CompletenessEntry = { rows: n, recorded: 0, partial: 0, unavailable: 0 };
    for (const row of input.rows) {
      const placed = placeRow(name, row, input.platforms);
      counts.set(placed.key, (counts.get(placed.key) ?? 0) + 1);
      c[placed.state] += 1;
    }
    if (counts.size > MAX_SECURITY_REPORT_BUCKETS) throw tooLarge(`${name} holds more than ${MAX_SECURITY_REPORT_BUCKETS} buckets`);
    const av = bucketAvailability(name, c);
    figures[name] = av.availability === 'unavailable' ? av : { ...av, value: [...counts].map(([key, count]) => ({ key, count })).sort(byKey) };
    completeness[name] = c;
  }
  const denied = deniedFigure(scope.repository_id !== null, input.decisions.length);
  figures.denied_by_request = denied.figure;
  completeness.denied_by_request = denied.completeness;
  figures.rule_pack_versions = { availability: 'recorded', value: new Set(input.rows.map((r) => r.rule_pack_version)).size };
  completeness.rule_pack_versions = full();
  figures.late_arrivals = { availability: 'recorded', value: input.rows.filter((r) => r.occurred_at < fromUs).length };
  completeness.late_arrivals = full();

  const machines = [...new Set(input.rows.filter((r) => r.record_generation === 'v2').map((r) => r.machine_id))].sort();
  if (machines.length > MAX_SECURITY_REPORT_LIST) throw tooLarge('machine_platforms is over its bound');
  const platformOf = (id: string) => {
    const p = input.platforms[id];
    return typeof p === 'string' && PLATFORMS.has(p) ? p : 'unavailable';
  };
  return {
    format: SECURITY_REPORT_DOCUMENT_FORMAT,
    tenant_id: tenantId,
    scope: { tenant_id: scope.tenant_id, repository_id: scope.repository_id, from: scope.from, to: scope.to, basis: 'received_at' },
    seals: input.seals.map((s) => ({ seq: s.seq, statement_digest: s.statement_digest, seal_digest: s.seal_digest, window: { from: s.window.from, to: s.window.to } })),
    row_count: n,
    rows_root: digestsRoot(input.rows.map((r) => r.digest)),
    decisions: input.decisions.map((d) => ({ id: d.id, digest: decisionDigest(d) })),
    machine_platforms: machines.map((machine_id) => ({ machine_id, platform: platformOf(machine_id) })),
    figures: figures as SecurityFigures,
    blocked: { ...BLOCKED },
    coverage: { ...COVERAGE },
    completeness,
  };
}

// ---------------------------------------------------------------------------
// The statement

export interface BuildSecurityReportInput {
  document: SecurityReportDocument;
  asOf: string;
  builderVersion: string;
  /** Statement digests of the earlier reports with the same subject name, oldest first. */
  previous: string[];
  /** The inputs the document was computed from: SR9 recomputes it. */
  inputs?: SecurityReportInputs;
}

export interface BuiltSecurityReport {
  documentText: string;
  documentDigest: string;
  statementCanonical: string;
  statementDigest: string;
}

export function inputsOf(doc: SecurityReportDocument) {
  return {
    seal_count: doc.seals.length,
    seals_root: digestsRoot(doc.seals.map((s) => s.statement_digest)),
    row_count: doc.row_count,
    rows_root: doc.rows_root,
    decision_count: doc.decisions.length,
    decisions_root: digestsRoot(doc.decisions.map((d) => d.digest)),
  };
}

/**
 * The statement and both byte strings, validated as snapshots: the schemas, then SR1–SR9
 * against the document (and its inputs when given). Only the returned bytes are signed.
 */
export function buildSecurityReportStatement(input: BuildSecurityReportInput): BuiltSecurityReport {
  const doc = input.document;
  const documentText = canonicalize(doc);
  const documentDigest = sha256Prefixed(documentText);
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: securityReportSubjectName(doc.scope), digest: { sha256: documentDigest.slice('sha256:'.length) } }],
    predicateType: SECURITY_PERIOD_REPORT_PREDICATE_TYPE,
    predicate: {
      scope: doc.scope,
      inputs: inputsOf(doc),
      figures: doc.figures,
      blocked: doc.blocked,
      coverage: doc.coverage,
      completeness: doc.completeness,
      builder: { name: SECURITY_REPORT_BUILDER_NAME, version: input.builderVersion },
      as_of: input.asOf,
      previous: input.previous.map((digest) => ({ digest })),
    },
  };
  const statementCanonical = canonicalize(statement);
  const v = securityReportValidators();
  if (!v.document(JSON.parse(documentText))) throw new SecurityReportError('ATTESTA_BUILDER_SCHEMA_INVALID', `schema refused the report document at ${where(v.document)}`);
  if (!v.statement(JSON.parse(statementCanonical))) throw new SecurityReportError('ATTESTA_BUILDER_SCHEMA_INVALID', `schema refused the report statement at ${where(v.statement)}`);
  const broken = checkSecurityReport({ statement: JSON.parse(statementCanonical), documentText, tenantId: doc.tenant_id, inputs: input.inputs });
  if (broken.length > 0) throw ruleError(`the report breaks ${broken.join(', ')}`);
  return { documentText, documentDigest, statementCanonical, statementDigest: sha256Prefixed(statementCanonical) };
}

function where(v: ValidateFunction): string {
  return (v.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.keyword}`).join('; ');
}

// ---------------------------------------------------------------------------
// Rules SR1–SR9 (security-period-report.md). Pure; never throws on hostile input.

export type SecurityReportRuleId = 'SR_SCHEMA' | 'SR1' | 'SR2' | 'SR3' | 'SR4' | 'SR5' | 'SR6' | 'SR7' | 'SR8' | 'SR9';

export interface CheckSecurityReportInput {
  /** The parsed statement snapshot. */
  statement: unknown;
  /** The document's stored bytes. */
  documentText: string;
  /** The tenant of the ledger record (SR2). */
  tenantId?: string;
  /** The inputs, when the checker has the database at hand (SR9). */
  inputs?: SecurityReportInputs;
}

const isAscending = <T>(xs: readonly T[], key: (x: T) => string) => xs.every((x, i) => i === 0 || key(xs[i - 1]) < key(x));

/**
 * Every rule the statement, its document and (optionally) its inputs break. A document that is
 * not its own JCS form, or a document or statement the schemas refuse, is `SR_SCHEMA` alone.
 */
export function checkSecurityReport(input: CheckSecurityReportInput): SecurityReportRuleId[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.documentText);
    if (canonicalize(parsed) !== input.documentText) return ['SR_SCHEMA'];
  } catch {
    return ['SR_SCHEMA'];
  }
  const v = securityReportValidators();
  if (!v.document(parsed) || !v.statement(input.statement)) return ['SR_SCHEMA'];
  const broken = new Set<SecurityReportRuleId>();
  const d = parsed as SecurityReportDocument;
  const st = input.statement as { subject: Array<{ name: string; digest: { sha256: string } }>; predicate: Record<string, unknown> };
  const p = st.predicate as unknown as {
    scope: SecurityReportScope; inputs: ReturnType<typeof inputsOf>; figures: SecurityFigures; blocked: unknown; coverage: unknown;
    completeness: Record<SecurityFigureName, CompletenessEntry>; as_of: string; previous: Array<{ digest: string }>;
  };
  const scope = p.scope;
  const fromUs = usOf(scope.from);
  const toUs = usOf(scope.to);

  // SR1 subject and bounds.
  if (st.subject[0].name !== securityReportSubjectName(scope) || 'sha256:' + st.subject[0].digest.sha256 !== sha256Prefixed(input.documentText)
    || !validInstant(scope.from) || !validInstant(scope.to) || !validInstant(p.as_of) || scope.from >= scope.to
    || Date.parse(scope.to) > Date.parse(p.as_of) - SECURITY_REPORT_SETTLE_MS
    || Date.parse(scope.to) - Date.parse(scope.from) > MAX_SECURITY_REPORT_DAYS * 86_400_000) broken.add('SR1');
  // SR2 one scope, the record's tenant; previous names each earlier report once.
  if (canonicalize(d.scope) !== canonicalize(scope) || d.tenant_id !== scope.tenant_id
    || (input.tenantId !== undefined && d.tenant_id !== input.tenantId)
    || new Set(p.previous.map((x) => x.digest)).size !== p.previous.length) broken.add('SR2');
  // SR3 the covering seals: window order, contiguous, unique, each overlapping the period, the last reaching `to`.
  const seals = d.seals;
  const sealsOk = seals.every((s, i) => s.window.from < s.window.to && s.window.from < toUs && s.window.to > fromUs
    && (i === 0 || (seals[i - 1].window.to === s.window.from && seals[i - 1].seq < s.seq)))
    && new Set(seals.map((s) => s.statement_digest)).size === seals.length && new Set(seals.map((s) => s.seal_digest)).size === seals.length
    && (seals.length === 0 ? d.row_count === 0 : seals[seals.length - 1].window.to >= toUs);
  if (!sealsOk || p.inputs.seal_count !== seals.length || p.inputs.seals_root !== digestsRoot(seals.map((s) => s.statement_digest))) broken.add('SR3');
  // SR4 roots and counts; the lists are ordered and unique.
  const repositoryScope = scope.repository_id !== null;
  const findings = d.figures.findings;
  if (p.inputs.row_count !== d.row_count || p.inputs.rows_root !== d.rows_root
    || p.inputs.decision_count !== d.decisions.length || p.inputs.decisions_root !== digestsRoot(d.decisions.map((x) => x.digest))
    || new Set(d.decisions.map((x) => x.id)).size !== d.decisions.length || (repositoryScope && d.decisions.length > 0)
    || findings.availability !== 'recorded' || findings.value !== d.row_count
    || (!repositoryScope && d.figures.denied_by_request.value !== d.decisions.length)
    || !isAscending(d.machine_platforms, (m) => m.machine_id)
    || (d.row_count === 0 && d.rows_root !== digestsRoot([]))) broken.add('SR4');
  // SR5 each bucket figure sums to the findings; keys sorted, unique, counts positive; count figures within the rows.
  for (const name of ROW_FIGURES) {
    const f = d.figures[name];
    if (f.value === undefined) continue;
    const sum = f.value.reduce((n, b) => n + b.count, 0);
    if (sum !== d.row_count || !isAscending(f.value, (b) => b.key) || f.value.some((b) => b.count < 1)) broken.add('SR5');
  }
  const late = d.figures.late_arrivals.value;
  const packs = d.figures.rule_pack_versions.value;
  if (late === undefined || late > d.row_count || packs === undefined || packs > d.row_count || (d.row_count > 0) !== (packs > 0)) broken.add('SR5');
  // SR6 completeness and availability follow the rule.
  for (const name of ROW_FIGURES) {
    const c = d.completeness[name];
    const av = bucketAvailability(name, c);
    const f = d.figures[name];
    if (c.rows !== d.row_count || c.recorded + c.partial + c.unavailable !== c.rows
      || av.availability !== f.availability || av.reason !== f.reason || av.partial_reason !== f.partial_reason
      || (f.availability === 'unavailable') !== (f.value === undefined)) broken.add('SR6');
  }
  for (const name of ['findings', 'rule_pack_versions', 'late_arrivals'] as const) {
    const c = d.completeness[name];
    if (d.figures[name].availability !== 'recorded' || canonicalize(c) !== canonicalize({ rows: d.row_count, recorded: d.row_count, partial: 0, unavailable: 0 })) broken.add('SR6');
  }
  const denied = deniedFigure(repositoryScope, d.decisions.length);
  if (canonicalize(denied.figure) !== canonicalize(d.figures.denied_by_request)
    || canonicalize(denied.completeness) !== canonicalize(d.completeness.denied_by_request)) broken.add('SR6');
  // A platform taken from a machine's current state makes by_platform partial, and only that does.
  const fromState = d.machine_platforms.some((m) => m.platform !== 'unavailable');
  if (fromState !== (d.figures.by_platform.partial_reason === 'current_machine_state')) broken.add('SR6');
  // SR7 blocked and coverage fixed.
  if (canonicalize(d.blocked) !== canonicalize(BLOCKED) || canonicalize(d.coverage) !== canonicalize(COVERAGE)
    || canonicalize(p.blocked) !== canonicalize(BLOCKED) || canonicalize(p.coverage) !== canonicalize(COVERAGE)) broken.add('SR7');
  // SR8 the predicate carries the document's figures.
  if (canonicalize(p.figures) !== canonicalize(d.figures) || canonicalize(p.completeness) !== canonicalize(d.completeness)) broken.add('SR8');
  // SR9 with the inputs at hand, the document is exactly what they give.
  if (input.inputs !== undefined) {
    try {
      if (canonicalize(computeSecurityReportDocument(input.inputs)) !== input.documentText) broken.add('SR9');
    } catch {
      broken.add('SR9');
    }
  }
  return [...broken].sort((a, b) => RULE_ORDER.indexOf(a) - RULE_ORDER.indexOf(b));
}

const RULE_ORDER: SecurityReportRuleId[] = ['SR_SCHEMA', 'SR1', 'SR2', 'SR3', 'SR4', 'SR5', 'SR6', 'SR7', 'SR8', 'SR9'];

function validInstant(v: unknown): boolean {
  return typeof v === 'string' && ISO_MS_RE.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
}

// ---------------------------------------------------------------------------
// Schemas

let validators: { statement: ValidateFunction; document: ValidateFunction } | null = null;
function contractDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'predicate-security-period-report-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new SecurityReportError('ATTESTA_API_INTERNAL', 'the security report schemas are not found');
}

/** The statement (#/definitions/statement) and document validators, strict as the fixture test. */
export function securityReportValidators(): { statement: ValidateFunction; document: ValidateFunction } {
  if (validators) return validators;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const predicate = load('predicate-security-period-report-v1.schema.json');
  ajv.addSchema(predicate);
  validators = {
    statement: ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` }),
    document: ajv.compile(load('security-period-report-document-v1.schema.json')),
  };
  return validators;
}
