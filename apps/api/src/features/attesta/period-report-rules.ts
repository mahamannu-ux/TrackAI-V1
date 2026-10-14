/**
 * The `period_report` statement (Task15i4, A15.9 part 3; docs/contracts/attesta/period-report.md,
 * predicate-period-report-v1.schema.json, period-report-document-v1.schema.json).
 *
 *   computeReportDocument     pure: the repository's signed ai-provenance statements in a
 *                             window → the report document (figures, contributions, completeness)
 *   buildReportStatement      the in-toto statement naming the document's digest
 *   checkPeriodReport         rules P1–P10 between a statement, its document and (when given)
 *                             the statements it summed; used before signing, by the offline
 *                             verifier and by tests
 *   reportValidators          the frozen schemas, compiled once (strict Ajv, as the fixture test)
 *
 * Ported from SushiCorp @ 0bd67a5 (catalog RP-1): services/reporting/models.py and signing.py
 * (every number carries the records it came from as {count, records}; regeneration is
 * byte-identical; the generation time never enters the body; the signature covers a small
 * statement naming the report digest, never the report). Deviations:
 *  1. The statement is an in-toto Statement in a DSSE envelope, chained like any statement
 *     (SushiCorp signed a JCS attestation and chained a decision record).
 *  2. Figures are integers and ratios basis points (0–10000, floored), never floats or
 *     percentage strings.
 *  3. Records are named by statement digest and seq (SushiCorp: seq ranges).
 *  4. No PDF rendering; JSON only.
 *
 * Task2 owns the metric semantics (AGENTS.md rule 8): every figure sums a signed predicate
 * field as Task2 defined it (fields.md); nothing here redefines a metric.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { canonicalize, hashBytes, sha256Prefixed } from './canonical';
import { merkleRoot } from './merkle';

export const PERIOD_REPORT_PREDICATE_TYPE = 'https://trackai.dev/attesta/period-report/v1';
export const AI_PROVENANCE_TYPE = 'https://trackai.dev/attesta/ai-provenance/v1';
export const REPORT_DOCUMENT_FORMAT = 'https://trackai.dev/attesta/period-report-document/v1';
export const REPORT_BUILDER_NAME = 'trackai-attesta-report-builder';
export const IN_TOTO_STATEMENT = 'https://in-toto.io/Statement/v1';
/** Statements one report may sum (the evidence-pack segment bound). */
export const MAX_REPORT_STATEMENTS = 50_000;
/** `to` must be this far before as_of (evidence-pack.md: writers stamp recorded_at just before commit). */
export const REPORT_SETTLE_MS = 300_000;
export const MAX_PREVIOUS_REPORTS = 64;

export const FIGURES = [
  'commits_observed', 'lines_changed', 'prs_merged', 'merged_lines', 'merged_ai_lines',
  'merged_ai_lines_by_model', 'production_deployments',
] as const;
export type FigureName = (typeof FIGURES)[number];
export const RATIOS = ['ai_share_of_changed_lines_bp', 'ai_share_of_merged_lines_bp'] as const;
export type RatioName = (typeof RATIOS)[number];

export type StatementKind = 'commit_observed' | 'pr_merged' | 'deployed';
export interface LineCounts { ai: number; human: number; unknown: number; added: number; deleted: number }
export interface ModelLines { tool: string; model: string | null; model_key: string; ai_lines: number }
type FigureValue = number | LineCounts | ModelLines[];

export interface ReportScope { repository_id: string; from: string; to: string; basis: 'recorded_at' }

/** One stored, signed ai-provenance statement in the window (its exact bytes). */
export interface ReportInput { seq: number; digest: string; canonical: string }

export interface Completeness { inputs: number; recorded: number; partial: number; unavailable: number }
export interface FigureRecord { seq: number; digest: string; availability: 'recorded' | 'partial'; contribution: FigureValue }
export interface Figure {
  availability: 'recorded' | 'partial' | 'unavailable';
  value?: FigureValue;
  partial_reason?: 'only_some_sources_reported';
  reason?: 'source_missing';
  statements_root: string;
}
export interface DocumentFigure extends Figure { contributions: { count: number; records: FigureRecord[] } }
export interface Ratio {
  availability: 'recorded' | 'partial' | 'unavailable';
  value?: number;
  partial_reason?: 'only_some_sources_reported';
  reason?: 'source_missing' | 'not_applicable';
}

export interface ReportDocument {
  format: typeof REPORT_DOCUMENT_FORMAT;
  tenant_id: string;
  scope: ReportScope;
  statements: Array<{ seq: number; digest: string; statement_kind: StatementKind }>;
  figures: Record<FigureName, DocumentFigure>;
  ratios: Record<RatioName, Ratio>;
  repo_share: { availability: 'unavailable'; reason: 'not_captured_yet' };
  completeness: Record<FigureName, Completeness>;
}

export interface ChainRange { from_seq: number; to_seq: number; to_record_hash: string | null }

/** Errors carry no raw values (AGENTS.md §10). */
export class PeriodReportError extends Error {
  constructor(readonly code: 'ATTESTA_BUILDER_SCHEMA_INVALID' | 'ATTESTA_BUILDER_RULE_VIOLATION' | 'ATTESTA_BUILDER_NOT_CANONICAL'
    | 'ATTESTA_API_INVALID_QUERY', message: string) {
    super(message);
    this.name = 'PeriodReportError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ruleError = (why: string) => new PeriodReportError('ATTESTA_BUILDER_RULE_VIOLATION', `period report: ${why}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `trackai:repository/<uuid>/period/<from>..<to>` (period-report.md "Statement"). */
export function reportSubjectName(scope: Pick<ReportScope, 'repository_id' | 'from' | 'to'>): string {
  return `trackai:repository/${scope.repository_id}/period/${scope.from}..${scope.to}`;
}

/**
 * RFC 6962 root over statement digests (leaf data: the 32 raw bytes of each digest), in the
 * order given; the empty tree's root is SHA-256 of the empty string (RFC 6962 §2.1).
 */
export function digestsRoot(digests: readonly string[]): string {
  if (digests.length === 0) return sha256Prefixed(Buffer.alloc(0));
  return 'sha256:' + merkleRoot(digests.map((d) => hashBytes(d))).toString('hex');
}

function safeAdd(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw ruleError('a figure exceeds the safe integer range');
  return s;
}

/** floor(10000 · num / den) for non-negative safe integers, exactly (BigInt). */
export function basisPoints(num: number, den: number): number {
  if (den <= 0) throw new RangeError('denominator must be positive');
  return Number((BigInt(num) * 10000n) / BigInt(den));
}

// ---------------------------------------------------------------------------
// Reading one signed statement (stored bytes, never Task2 tables)

interface ParsedInput {
  seq: number;
  digest: string;
  kind: StatementKind;
  sha: string;
  repositoryId: string;
  predicate: Obj;
}

function parseInput(input: ReportInput): ParsedInput {
  let s: unknown;
  try {
    s = JSON.parse(input.canonical);
  } catch {
    throw ruleError('an input statement is not JSON');
  }
  if (sha256Prefixed(input.canonical) !== input.digest) throw ruleError('an input statement does not hash to its digest');
  if (!isObj(s) || s.predicateType !== AI_PROVENANCE_TYPE || !isObj(s.predicate)) throw ruleError('an input is not an ai-provenance statement');
  const p = s.predicate;
  const kind = p.statement_kind;
  if (kind !== 'commit_observed' && kind !== 'pr_merged' && kind !== 'deployed') throw ruleError('an input has an unknown kind');
  const repo = isObj(p.repository) ? p.repository.id : undefined;
  const subject = Array.isArray(s.subject) && isObj(s.subject[0]) && isObj(s.subject[0].digest) ? s.subject[0].digest.gitCommit : undefined;
  if (typeof repo !== 'string' || typeof subject !== 'string') throw ruleError('an input lacks its repository or subject');
  return { seq: input.seq, digest: input.digest, kind, sha: subject, repositoryId: repo, predicate: p };
}

/** An availability-wrapped predicate field: {availability, value?}. */
function field(p: Obj, name: string): { availability: 'recorded' | 'partial' | 'unavailable'; value: unknown } {
  const f = p[name];
  if (!isObj(f) || (f.availability !== 'recorded' && f.availability !== 'partial' && f.availability !== 'unavailable')) {
    throw ruleError(`an input's ${name} is malformed`);
  }
  return { availability: f.availability, value: f.value };
}

const COUNT_OK = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function lineCounts(v: unknown): LineCounts {
  if (!isObj(v) || !['ai', 'human', 'unknown', 'added', 'deleted'].every((k) => COUNT_OK(v[k]))) {
    throw ruleError('an input has malformed line counts');
  }
  return { ai: v.ai as number, human: v.human as number, unknown: v.unknown as number, added: v.added as number, deleted: v.deleted as number };
}

/** models[] of one statement grouped by model_key (sessions summed), sorted by model_key. */
function modelLines(v: unknown): ModelLines[] {
  if (!Array.isArray(v)) throw ruleError('an input has malformed models');
  const byKey = new Map<string, ModelLines>();
  for (const m of v) {
    if (!isObj(m) || typeof m.tool !== 'string' || !(m.model === null || typeof m.model === 'string')
      || typeof m.model_key !== 'string' || !COUNT_OK(m.ai_lines)) {
      throw ruleError('an input has a malformed model row');
    }
    const prior = byKey.get(m.model_key);
    if (prior) {
      if (prior.tool !== m.tool || prior.model !== m.model) throw ruleError('one model_key names two models');
      prior.ai_lines = safeAdd(prior.ai_lines, m.ai_lines);
    } else {
      byKey.set(m.model_key, { tool: m.tool, model: m.model as string | null, model_key: m.model_key, ai_lines: m.ai_lines });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.model_key < b.model_key ? -1 : a.model_key > b.model_key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Selection (P4): which statement stands for what, and which field each figure reads

interface FigureSpec {
  kind: StatementKind;
  /** The deduplication key: subject sha, or the deployment id. */
  key: (s: ParsedInput) => string;
  /** The field read, its availability and the contribution it makes. */
  read: (s: ParsedInput) => { availability: 'recorded' | 'partial' | 'unavailable'; contribution: FigureValue | null };
  zero: () => FigureValue;
}

const bySha = (s: ParsedInput) => s.sha;
const identity = (availability: 'recorded' | 'partial' | 'unavailable') => ({ availability, contribution: availability === 'unavailable' ? null : 1 });
const linesOf = (s: ParsedInput) => {
  const f = field(s.predicate, 'lines');
  return { availability: f.availability, contribution: f.availability === 'unavailable' ? null : lineCounts(f.value) };
};
const zeroLines = (): LineCounts => ({ ai: 0, human: 0, unknown: 0, added: 0, deleted: 0 });

export const FIGURE_SPECS: Record<FigureName, FigureSpec> = {
  commits_observed: { kind: 'commit_observed', key: bySha, read: () => identity('recorded'), zero: () => 0 },
  lines_changed: { kind: 'commit_observed', key: bySha, read: linesOf, zero: zeroLines },
  prs_merged: {
    kind: 'pr_merged', key: bySha, zero: () => 0,
    read: (s) => identity(field(s.predicate, 'pull_request').availability),
  },
  merged_lines: { kind: 'pr_merged', key: bySha, read: linesOf, zero: zeroLines },
  merged_ai_lines: {
    kind: 'pr_merged', key: bySha, zero: () => 0,
    read: (s) => {
      const f = field(s.predicate, 'lifecycle');
      if (f.availability === 'unavailable') return { availability: 'unavailable', contribution: null };
      if (!isObj(f.value) || f.value.stage !== 'merged' || !COUNT_OK(f.value.ai_lines)) throw ruleError('a merged lifecycle is malformed');
      return { availability: f.availability, contribution: f.value.ai_lines };
    },
  },
  merged_ai_lines_by_model: {
    kind: 'pr_merged', key: bySha, zero: () => [],
    read: (s) => {
      const f = field(s.predicate, 'models');
      return { availability: f.availability, contribution: f.availability === 'unavailable' ? null : modelLines(f.value) };
    },
  },
  production_deployments: {
    kind: 'deployed', zero: () => 0,
    key: (s) => {
      const f = field(s.predicate, 'deployment');
      if (!isObj(f.value) || typeof f.value.id !== 'string') throw ruleError('a deployed statement has no deployment id');
      return f.value.id;
    },
    read: (s) => identity(field(s.predicate, 'deployment').availability),
  },
};

/** The latest statement (highest seq) per key, seq ascending. */
function latestPerKey(statements: ParsedInput[], spec: FigureSpec): ParsedInput[] {
  const latest = new Map<string, ParsedInput>();
  for (const s of statements) {
    if (s.kind !== spec.kind) continue;
    const k = spec.key(s);
    const prior = latest.get(k);
    if (!prior || prior.seq < s.seq) latest.set(k, s);
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

function addValue(total: FigureValue, part: FigureValue): FigureValue {
  if (typeof total === 'number' && typeof part === 'number') return safeAdd(total, part);
  if (Array.isArray(total) && Array.isArray(part)) {
    const byKey = new Map(total.map((m) => [m.model_key, { ...m }]));
    for (const m of part) {
      const prior = byKey.get(m.model_key);
      if (prior) {
        if (prior.tool !== m.tool || prior.model !== m.model) throw ruleError('one model_key names two models');
        prior.ai_lines = safeAdd(prior.ai_lines, m.ai_lines);
      } else byKey.set(m.model_key, { ...m });
    }
    return [...byKey.values()].sort((a, b) => (a.model_key < b.model_key ? -1 : a.model_key > b.model_key ? 1 : 0));
  }
  if (!Array.isArray(total) && !Array.isArray(part) && typeof total === 'object' && typeof part === 'object') {
    return { ai: safeAdd(total.ai, part.ai), human: safeAdd(total.human, part.human), unknown: safeAdd(total.unknown, part.unknown),
      added: safeAdd(total.added, part.added), deleted: safeAdd(total.deleted, part.deleted) };
  }
  throw ruleError('figure values of different shapes');
}

/** P6: the figure's availability from its completeness. */
export function figureAvailability(c: Completeness): Pick<Figure, 'availability' | 'partial_reason' | 'reason'> {
  const contributing = c.recorded + c.partial;
  if (c.inputs > 0 && contributing === 0) return { availability: 'unavailable', reason: 'source_missing' };
  if (c.partial + c.unavailable > 0) return { availability: 'partial', partial_reason: 'only_some_sources_reported' };
  return { availability: 'recorded' };
}

/** P7: a share of AI lines in basis points from a line-count figure. */
export function ratioFrom(figure: Figure): Ratio {
  if (figure.availability === 'unavailable') return { availability: 'unavailable', reason: 'source_missing' };
  const v = figure.value as LineCounts;
  const den = v.ai + v.human + v.unknown;
  if (den === 0) return { availability: 'unavailable', reason: 'not_applicable' };
  const value = basisPoints(v.ai, den);
  return figure.availability === 'partial'
    ? { availability: 'partial', value, partial_reason: 'only_some_sources_reported' }
    : { availability: 'recorded', value };
}

/**
 * The report document for a window: `inputs` are every ai-provenance statement of the
 * repository with recorded_at in [from, to], with their stored bytes. Deterministic: the
 * same inputs give the same document bytes (no clock, no chain head).
 */
export function computeReportDocument(args: { tenantId: string; scope: ReportScope; inputs: ReportInput[] }): ReportDocument {
  const { tenantId, scope } = args;
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(scope.repository_id)) throw ruleError('ids are not lowercase UUIDs');
  if (args.inputs.length > MAX_REPORT_STATEMENTS) throw new PeriodReportError('ATTESTA_API_INVALID_QUERY', 'too many statements for one report');
  const parsed = args.inputs.map(parseInput).sort((a, b) => a.seq - b.seq);
  const seen = new Set<string>();
  parsed.forEach((s, i) => {
    if (i > 0 && parsed[i - 1].seq === s.seq) throw ruleError('two inputs share a seq');
    if (seen.has(s.digest)) throw ruleError('an input is listed twice');
    seen.add(s.digest);
    if (s.repositoryId !== scope.repository_id) throw ruleError('an input is about another repository');
  });

  const figures = {} as Record<FigureName, DocumentFigure>;
  const completeness = {} as Record<FigureName, Completeness>;
  for (const name of FIGURES) {
    const spec = FIGURE_SPECS[name];
    const selected = latestPerKey(parsed, spec);
    const c: Completeness = { inputs: selected.length, recorded: 0, partial: 0, unavailable: 0 };
    const records: FigureRecord[] = [];
    let total = spec.zero();
    for (const s of selected) {
      const r = spec.read(s);
      c[r.availability] += 1;
      if (r.availability === 'unavailable' || r.contribution === null) continue;
      total = addValue(total, r.contribution);
      records.push({ seq: s.seq, digest: s.digest, availability: r.availability, contribution: r.contribution });
    }
    const av = figureAvailability(c);
    const fig: DocumentFigure = { ...av, statements_root: digestsRoot(records.map((r) => r.digest)), contributions: { count: records.length, records } };
    if (av.availability !== 'unavailable') fig.value = total;
    figures[name] = fig;
    completeness[name] = c;
  }
  return {
    format: REPORT_DOCUMENT_FORMAT,
    tenant_id: tenantId,
    scope: { repository_id: scope.repository_id, from: scope.from, to: scope.to, basis: 'recorded_at' },
    statements: parsed.map((s) => ({ seq: s.seq, digest: s.digest, statement_kind: s.kind })),
    figures,
    ratios: {
      ai_share_of_changed_lines_bp: ratioFrom(figures.lines_changed),
      ai_share_of_merged_lines_bp: ratioFrom(figures.merged_lines),
    },
    repo_share: { availability: 'unavailable', reason: 'not_captured_yet' },
    completeness,
  };
}

/** A figure as the predicate carries it (P8): the document's without contributions. */
export function predicateFigure(f: DocumentFigure): Figure {
  const { contributions: _contributions, ...rest } = f;
  return rest;
}

export interface BuildReportStatementInput {
  document: ReportDocument;
  chainRange: ChainRange;
  asOf: string;
  builderVersion: string;
  /** Digests of earlier reports for the same scope, oldest first. */
  previous: string[];
}

export interface BuiltReport {
  documentText: string;
  documentDigest: string;
  statement: Obj;
  statementCanonical: string;
  statementDigest: string;
}

/**
 * The statement and both byte strings, validated as snapshots (envelope.md step 3): schema,
 * then P1–P10 against the document. Only the returned bytes are signed.
 */
export function buildReportStatement(input: BuildReportStatementInput): BuiltReport {
  const doc = input.document;
  let documentText: string;
  try {
    documentText = canonicalize(doc);
  } catch {
    throw new PeriodReportError('ATTESTA_BUILDER_NOT_CANONICAL', 'the report document cannot be canonicalized');
  }
  const documentDigest = sha256Prefixed(documentText);
  const figures = Object.fromEntries(FIGURES.map((n) => [n, predicateFigure(doc.figures[n])]));
  const statement = {
    _type: IN_TOTO_STATEMENT,
    subject: [{ name: reportSubjectName(doc.scope), digest: { sha256: documentDigest.slice('sha256:'.length) } }],
    predicateType: PERIOD_REPORT_PREDICATE_TYPE,
    predicate: {
      scope: doc.scope,
      chain_range: input.chainRange,
      inputs: { statement_count: doc.statements.length, statements_root: digestsRoot(doc.statements.map((s) => s.digest)) },
      figures,
      ratios: doc.ratios,
      repo_share: doc.repo_share,
      completeness: doc.completeness,
      builder: { name: REPORT_BUILDER_NAME, version: input.builderVersion },
      as_of: input.asOf,
      signed_late: { value: false, reason: 'none' },
      previous: input.previous.map((digest) => ({ digest })),
    },
  };
  let statementCanonical: string;
  try {
    statementCanonical = canonicalize(statement);
  } catch {
    throw new PeriodReportError('ATTESTA_BUILDER_NOT_CANONICAL', 'the report statement cannot be canonicalized');
  }
  const snapshot = JSON.parse(statementCanonical) as unknown;
  const docSnapshot = JSON.parse(documentText) as unknown;
  const v = reportValidators();
  if (!v.statement(snapshot)) throw new PeriodReportError('ATTESTA_BUILDER_SCHEMA_INVALID', `schema refused the report statement at ${where(v.statement)}`);
  if (!v.document(docSnapshot)) throw new PeriodReportError('ATTESTA_BUILDER_SCHEMA_INVALID', `schema refused the report document at ${where(v.document)}`);
  const broken = checkPeriodReport({ statement: snapshot, documentText, tenantId: doc.tenant_id });
  if (broken.length > 0) throw ruleError(`the report breaks ${broken.join(', ')}`);
  return { documentText, documentDigest, statement, statementCanonical, statementDigest: sha256Prefixed(statementCanonical) };
}

function where(v: ValidateFunction): string {
  return (v.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.keyword}`).join('; ');
}

// ---------------------------------------------------------------------------
// Rules P1–P10 (period-report.md). Pure; never throws on hostile input.

export type ReportRuleId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P_SCHEMA';

export interface CheckPeriodReportInput {
  /** The parsed statement snapshot. */
  statement: unknown;
  /** The document's stored bytes. */
  documentText: string;
  /** The tenant of the ledger record (P2). */
  tenantId?: string;
  /**
   * The statements the document claims to sum, with their stored bytes, when the checker
   * has them (a full evidence pack, the database). Then P4 and P9 recompute every
   * contribution and the selection from the signed fields themselves.
   */
  inputs?: ReportInput[];
}

/**
 * Every rule the statement, its document and (optionally) its inputs break. A document that
 * is not its own JCS form or fails its schema is `P_SCHEMA` (nothing else is checked then).
 */
export function checkPeriodReport(input: CheckPeriodReportInput): ReportRuleId[] {
  const broken = new Set<ReportRuleId>();
  let doc: unknown;
  try {
    doc = JSON.parse(input.documentText);
    if (canonicalize(doc) !== input.documentText) return ['P_SCHEMA'];
  } catch {
    return ['P_SCHEMA'];
  }
  const v = reportValidators();
  if (!v.document(doc) || !v.statement(input.statement)) return ['P_SCHEMA'];
  const d = doc as ReportDocument;
  const st = input.statement as { subject: Array<{ name: string; digest: { sha256: string } }>; predicate: Obj };
  const p = st.predicate as unknown as {
    scope: ReportScope; chain_range: ChainRange; inputs: { statement_count: number; statements_root: string };
    figures: Record<FigureName, Figure>; ratios: Record<RatioName, Ratio>; repo_share: unknown;
    completeness: Record<FigureName, Completeness>; as_of: string; previous: Array<{ digest: string }>;
  };

  // P1 subject: name from the scope, digest = SHA-256 of the document bytes; from ≤ to ≤ as_of − settle.
  if (st.subject[0].name !== reportSubjectName(p.scope)
    || 'sha256:' + st.subject[0].digest.sha256 !== sha256Prefixed(input.documentText)
    || !(validInstant(p.scope.from) && validInstant(p.scope.to) && validInstant(p.as_of))
    || p.scope.from > p.scope.to || Date.parse(p.scope.to) > Date.parse(p.as_of) - REPORT_SETTLE_MS) broken.add('P1');
  // P2 the document is about the statement's scope and the record's tenant.
  if (canonicalize(d.scope) !== canonicalize(p.scope) || (input.tenantId !== undefined && d.tenant_id !== input.tenantId)) broken.add('P2');
  // P3 inputs: seq ascending, digests unique, count and root.
  const seqsAscending = d.statements.every((s, i) => i === 0 || d.statements[i - 1].seq < s.seq);
  const unique = new Set(d.statements.map((s) => s.digest)).size === d.statements.length;
  if (!seqsAscending || !unique || p.inputs.statement_count !== d.statements.length
    || p.inputs.statements_root !== digestsRoot(d.statements.map((s) => s.digest))) broken.add('P3');
  if (p.chain_range.to_seq >= 0 && d.statements.some((s) => s.seq < p.chain_range.from_seq || s.seq > p.chain_range.to_seq)) broken.add('P3');
  if (p.chain_range.to_seq < p.chain_range.from_seq - 1 || (p.chain_range.to_seq === -1) !== (p.chain_range.to_record_hash === null)) broken.add('P3');
  // An empty chain (to_seq −1) holds no statement and starts at seq 0 (review finding).
  if (p.chain_range.to_seq === -1 && (d.statements.length > 0 || p.chain_range.from_seq !== 0)) broken.add('P3');

  const kindBySeq = new Map(d.statements.map((s) => [s.seq, s]));
  for (const name of FIGURES) {
    const f = d.figures[name];
    const c = d.completeness[name];
    const spec = FIGURE_SPECS[name];
    const recs = f.contributions.records;
    // P4 (document part): each record is a listed statement of the figure's kind, seq ascending, once.
    if (f.contributions.count !== recs.length
      || !recs.every((r, i) => (i === 0 || recs[i - 1].seq < r.seq) && kindBySeq.get(r.seq)?.digest === r.digest
        && kindBySeq.get(r.seq)?.statement_kind === spec.kind)
      || f.statements_root !== digestsRoot(recs.map((r) => r.digest))) broken.add('P4');
    // P5 value = the sum of the contributions.
    try {
      let total = spec.zero();
      for (const r of recs) total = addValue(total, normalizeContribution(name, r.contribution));
      if (f.availability !== 'unavailable' && canonicalize(total) !== canonicalize(f.value)) broken.add('P5');
    } catch {
      broken.add('P5');
    }
    // P6 availability from completeness; contributors are exactly recorded + partial.
    const av = figureAvailability(c);
    const kindCount = d.statements.filter((s) => s.statement_kind === spec.kind).length;
    if (c.recorded + c.partial + c.unavailable !== c.inputs || recs.length !== c.recorded + c.partial
      || recs.filter((r) => r.availability === 'partial').length !== c.partial || c.inputs > kindCount
      || av.availability !== f.availability || av.reason !== f.reason || av.partial_reason !== f.partial_reason) broken.add('P6');
    // P8 the predicate carries the same figure.
    if (canonicalize(predicateFigure(f)) !== canonicalize(p.figures[name])) broken.add('P8');
  }
  // P7 ratios from their figures.
  if (canonicalize(ratioFrom(d.figures.lines_changed)) !== canonicalize(d.ratios.ai_share_of_changed_lines_bp)
    || canonicalize(ratioFrom(d.figures.merged_lines)) !== canonicalize(d.ratios.ai_share_of_merged_lines_bp)) broken.add('P7');
  // P8 ratios, repo_share and completeness agree.
  if (canonicalize(d.ratios) !== canonicalize(p.ratios) || canonicalize(d.repo_share) !== canonicalize(p.repo_share)
    || canonicalize(d.completeness) !== canonicalize(p.completeness)) broken.add('P8');
  // P10 previous: each once.
  if (new Set(p.previous.map((x) => x.digest)).size !== p.previous.length) broken.add('P10');

  // P9 with the inputs: the document is exactly what the signed statements give.
  if (input.inputs !== undefined) {
    try {
      const again = computeReportDocument({ tenantId: d.tenant_id, scope: d.scope, inputs: input.inputs });
      if (canonicalize(again) !== input.documentText) broken.add('P9');
    } catch {
      broken.add('P9');
    }
  }
  return [...broken].sort((a, b) => order(a) - order(b));
}

const RULE_ORDER: ReportRuleId[] = ['P_SCHEMA', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const order = (id: ReportRuleId) => RULE_ORDER.indexOf(id);

function validInstant(v: string): boolean {
  return ISO_MS_RE.test(v) && new Date(Date.parse(v)).toISOString() === v;
}

function normalizeContribution(name: FigureName, c: FigureValue): FigureValue {
  if (name === 'merged_ai_lines_by_model') return modelLines(c);
  if (name === 'lines_changed' || name === 'merged_lines') return lineCounts(c);
  if (!COUNT_OK(c)) throw ruleError('a contribution is malformed');
  return c;
}

// ---------------------------------------------------------------------------
// Schemas

let validators: { statement: ValidateFunction; document: ValidateFunction } | null = null;

function contractDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'predicate-period-report-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('docs/contracts/attesta not found above the period report rules');
}

/** The statement (#/definitions/statement) and document validators, strict as the fixture test. */
export function reportValidators(): { statement: ValidateFunction; document: ValidateFunction } {
  if (validators) return validators;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const predicate = load('predicate-period-report-v1.schema.json');
  ajv.addSchema(predicate);
  validators = {
    statement: ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` }),
    document: ajv.compile(load('period-report-document-v1.schema.json')),
  };
  return validators;
}

export const isReportDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v);
