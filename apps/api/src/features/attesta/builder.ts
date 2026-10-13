/**
 * Attesta statement builder (Task15h, A15.8): one claimed `attesta_subjects` row →
 * one `ai-provenance/v1` in-toto statement, canonicalized, validated and sized to
 * fit the signer (docs/contracts/attesta/envelope.md builder steps 1–4).
 *
 * Every field comes only from its source in docs/contracts/attesta/fields.md (the
 * row is cited next to each field below), then rules 1–3 of fields.md apply:
 * normalize as Task2 does, hash what does not fit its pattern, derive model_key and
 * tools from the final values. B1–B3 are implemented in `projectionState`.
 *
 * Reads: one read transaction supplied by the caller (`as_of` = its now()). Every
 * query is bound to the row's tenant (`tenant_id = $tenant`), as ledger.ts and
 * outbox.ts do; the URL, the commit's stored note and author emails are hashed or
 * matched inside PostgreSQL, so they never reach this process. The only raw content
 * read is the Git AI note string of the source event, needed to derive note_digest
 * and the file hashes (parseAuthorshipNote, the function Task2 uses); it is never
 * logged, stored or put in an error message.
 *
 * Port from: none. SushiCorp builds decision records, not in-toto statements; the
 * snapshot-then-validate order is the Task15a lesson.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { sql, type SQL } from 'drizzle-orm';
import { parseAuthorshipNote } from '../telemetry/authorship-note';
import { modelAttributionsFromNote } from '../telemetry/model-lifecycle';
import { CanonicalizationError, canonicalize, sha256Prefixed } from './canonical';
import { checkStatementRules } from './contract-rules';
import { IN_TOTO_PAYLOAD_TYPE, pae } from './dsse';
import { AI_PROVENANCE_PREDICATE_TYPE, IN_TOTO_STATEMENT_TYPE, MAX_STATEMENT_BYTES } from './ledger';
import type { AttestaSubjectKind } from './outbox';

export const BUILDER_NAME = 'trackai-attesta-builder';
/** A statement built this long after its event is signed late (`delayed_build`). */
export const DELAYED_BUILD_AFTER_MS = 24 * 60 * 60 * 1000;
/** The schema's own bound on `files.entries`. */
export const MAX_FILE_ENTRIES = 2000;

// ---------------------------------------------------------------------------
// Errors (errors.md §Builder)
// ---------------------------------------------------------------------------

export type AttestaBuilderErrorCode =
  | 'ATTESTA_BUILDER_SOURCE_NOT_READY'
  | 'ATTESTA_BUILDER_SOURCE_MISSING'
  | 'ATTESTA_BUILDER_NOT_CANONICAL'
  | 'ATTESTA_BUILDER_SCHEMA_INVALID'
  | 'ATTESTA_BUILDER_RULE_VIOLATION'
  | 'ATTESTA_BUILDER_TOO_LARGE';

export class AttestaBuilderError extends Error {
  readonly retryable: boolean;
  /**
   * true when the row only waits for an earlier statement about its subject to be
   * chained: the worker retries it without spending an attempt (the blocking row
   * itself always ends done or failed, so the wait is finite).
   */
  readonly wait: boolean;
  constructor(readonly code: AttestaBuilderErrorCode, message: string, options: { wait?: boolean } = {}) {
    super(message);
    this.name = 'AttestaBuilderError';
    this.retryable = code === 'ATTESTA_BUILDER_SOURCE_NOT_READY';
    this.wait = this.retryable && options.wait === true;
  }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** A claimed outbox row, as the worker read it (outbox.md columns). */
export interface AttestaSubjectRow {
  id: string;
  tenantId: string;
  repositoryId: string;
  kind: AttestaSubjectKind;
  metricEventId: string | null;
  commitId: string | null;
  commitSha: string;
  provider: string | null;
  providerDeliveryId: string | null;
  pullRequestId: string | null;
  deploymentId: string | null;
  deploymentExternalId: string | null;
  /** event_at, RFC 3339 UTC with milliseconds. */
  eventAt: string;
}

export interface BuilderOptions {
  /** `<semver>+<git commit>` of the code that builds (statement `builder.version`). */
  builderVersion: string;
  /** The signer's limit on the bytes it signs (`capabilities().maxPayloadBytes`). */
  maxPayloadBytes: number;
}

export interface BuiltStatement {
  /** The validated snapshot: JSON.parse(canonical). */
  statement: Record<string, unknown>;
  /** The exact RFC 8785 bytes to sign (DSSE payload). */
  canonical: string;
  /** sha256Prefixed(canonical): the statement digest. */
  digest: string;
  /** The `previous` digests, oldest first (chainStatement's previousSeen). */
  previousSeen: string[];
}

/** Anything with `execute(sql)`: the caller's open read transaction. */
export interface BuilderReadExecutor {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// ---------------------------------------------------------------------------
// Patterns (predicate schema definitions) and rules 1–3 of fields.md
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^(?!.*@[^@]*\.)[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DELIVERY_REF_RE = /^([0-9A-Fa-f-]{8,64}|sha256:[0-9a-f]{64})$/;
const EXTERNAL_REF_RE = /^([0-9]{1,20}|sha256:[0-9a-f]{64})$/;
const RULE_PACK_RE = /^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?|sha256:[0-9a-f]{64})$/;
const OPERATION_KIND_RE = /^[a-z][a-z_]{0,31}$/;
const REACHABILITY = new Set(['observed', 'reachable', 'pull_request', 'superseded', 'unreachable']);
const BUILDER_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{7,40}$/;
const TS_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Rule 2: a value that fits stays; one that does not becomes `sha256:<hex>`. */
interface Fitted { value: string; hashed: boolean }
function fit(value: string, pattern: RegExp): Fitted {
  return pattern.test(value) ? { value, hashed: false } : { value: `sha256:${sha256Hex(value)}`, hashed: true };
}
/** sha256_hex fields carry bare hex, so their fallback is the bare hex digest. */
function fitHex(value: string): Fitted {
  return HEX64_RE.test(value) ? { value, hashed: false } : { value: sha256Hex(value), hashed: true };
}

/** Rule 1 (model-lifecycle.ts:5): trim; empty tool → unknown. */
function normalizeTool(tool: unknown): string {
  return (typeof tool === 'string' ? tool.trim() : '') || 'unknown';
}
/** Rule 1: trim; empty or the literal "unknown" model → null. */
function normalizeModel(model: unknown): string | null {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed === '' || trimmed === 'unknown' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Availability wrappers
// ---------------------------------------------------------------------------

type UnavailableReason = 'not_captured_yet' | 'not_applicable' | 'source_missing' | 'not_reported_by_source';
type PartialReason =
  | 'identity_matched_by_name_or_email' | 'only_some_sources_reported' | 'entries_truncated'
  | 'linked_by_session_string_not_key' | 'optional_source_field_missing'
  | 'present_only_when_findings_exist' | 'lineage_still_being_enriched' | 'values_hashed_unrepresentable';
type Field = Record<string, unknown>;

const recorded = (value: unknown): Field => ({ availability: 'recorded', value });
const partial = (value: unknown, reason: PartialReason): Field =>
  ({ availability: 'partial', partial_reason: reason, value });
const unavailable = (reason: UnavailableReason): Field => ({ availability: 'unavailable', reason });
const recordedOr = (value: unknown, partialReason: PartialReason | null): Field =>
  (partialReason ? partial(value, partialReason) : recorded(value));

// ---------------------------------------------------------------------------
// Source reading (one read transaction; every query tenant-bound)
// ---------------------------------------------------------------------------

async function rows(tx: BuilderReadExecutor, query: SQL): Promise<Array<Record<string, unknown>>> {
  return (await tx.execute(query)).rows;
}
const ts = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', ${TS_FMT})`);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
function int(v: unknown, label: string): number {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new AttestaBuilderError('ATTESTA_BUILDER_NOT_CANONICAL', `${label} is not a safe integer`);
  }
  return n;
}
function uuidList(ids: string[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
}
function textList(values: string[]): SQL {
  return sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

interface CommitSource {
  id: string;
  operationKind: string | null;
  reachability: string | null;
  firstSeenAt: string;
  authoredAt: string | null;
  committedAt: string | null;
  added: number; deleted: number; ai: number; human: number; unknown: number;
  sourceEventId: string | null;
  /** sha256 hex of scm_commits.authorship_note, computed in SQL (null when no note). */
  noteSha256: string | null;
  hasAuthor: boolean;
  /** Git AI normalized this commit: its `committed` lifecycle row exists (svc:851). */
  gitAiNormalized: boolean;
  committedLines: number | null;
}

interface MetricEventSource {
  id: string; fingerprint: string; eventAt: string; evidenceFamily: string; arrivalClass: string;
  eventKind: number; attrSha: string | null;
  /** decodeAttributes a.20 / a.23 / a.24: Task2's session fallback when the note names none (svc:299–307). */
  attrTool: string | null; attrSessionId: string | null;
  /** The Git AI note string as decoded from raw_event (decoder stringAt(v, 13)). */
  note: string | null;
}

interface LineageSource {
  sourceCommitId: string; sourceSha: string; resultSha: string; mergeMethod: string;
  confidence: number; sourceStatementDigest: string | null; sourceNormalized: boolean;
}

async function readRepository(tx: BuilderReadExecutor, row: AttestaSubjectRow) {
  const r = await rows(tx, sql`/* builder:repository */
    select id::text as id, provider,
      case when normalized_url is null then null
           else encode(sha256(convert_to(normalized_url, 'UTF8')), 'hex') end as url_sha256
    from scm_repositories where tenant_id = ${row.tenantId} and id = ${row.repositoryId}`);
  if (r.length !== 1) throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'repository not found for this tenant');
  return { id: String(r[0].id), provider: String(r[0].provider), urlSha256: str(r[0].url_sha256) };
}

async function readCommit(tx: BuilderReadExecutor, row: AttestaSubjectRow): Promise<CommitSource | null> {
  const r = await rows(tx, sql`/* builder:commit */
    select c.id::text as id, c.operation_kind, c.reachability,
      ${ts('c.first_seen_at')} as first_seen_at, ${ts('c.authored_at')} as authored_at,
      ${ts('c.committed_at')} as committed_at,
      c.diff_added_lines, c.diff_deleted_lines, c.observed_ai_lines, c.observed_human_lines,
      c.observed_unknown_lines, c.source_event_id::text as source_event_id,
      case when c.authorship_note is null then null
           else encode(sha256(convert_to(c.authorship_note, 'UTF8')), 'hex') end as note_sha256,
      (c.author_name is not null or c.author_email is not null) as has_author,
      l.line_count as committed_lines, (l.id is not null) as git_ai_normalized
    from scm_commits c
    left join ai_code_lifecycle_events l on l.tenant_id = c.tenant_id and l.stage = 'committed'
      and l.evidence_ref = 'commit:' || c.id::text
    where c.tenant_id = ${row.tenantId} and c.repository_id = ${row.repositoryId} and c.sha = ${row.commitSha}`);
  if (r.length === 0) return null;
  const c = r[0];
  return {
    id: String(c.id),
    operationKind: str(c.operation_kind),
    reachability: str(c.reachability),
    firstSeenAt: String(c.first_seen_at),
    authoredAt: str(c.authored_at),
    committedAt: str(c.committed_at),
    added: int(c.diff_added_lines, 'diff_added_lines'),
    deleted: int(c.diff_deleted_lines, 'diff_deleted_lines'),
    ai: int(c.observed_ai_lines, 'observed_ai_lines'),
    human: int(c.observed_human_lines, 'observed_human_lines'),
    unknown: int(c.observed_unknown_lines, 'observed_unknown_lines'),
    sourceEventId: str(c.source_event_id),
    noteSha256: str(c.note_sha256),
    hasAuthor: c.has_author === true,
    gitAiNormalized: c.git_ai_normalized === true,
    committedLines: c.committed_lines === null || c.committed_lines === undefined ? null : int(c.committed_lines, 'line_count'),
  };
}

async function readMetricEvent(tx: BuilderReadExecutor, row: AttestaSubjectRow): Promise<MetricEventSource> {
  const r = await rows(tx, sql`/* builder:metric_event */
    select e.id::text as id, e.event_fingerprint, ${ts('e.event_timestamp')} as event_at,
      e.evidence_family, e.arrival_class, e.event_kind,
      e.raw_event -> 'a' ->> '3' as attr_sha, e.raw_event -> 'v' -> '13' as note,
      e.raw_event -> 'a' ->> '20' as attr_tool,
      coalesce(nullif(e.raw_event -> 'a' ->> '23', ''), nullif(e.raw_event -> 'a' ->> '24', '')) as attr_session
    from telemetry_metric_events e
    where e.tenant_id = ${row.tenantId} and e.id = ${row.metricEventId}`);
  if (r.length !== 1) throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'source metric event not found for this tenant');
  const e = r[0];
  // decoder.ts stringAt: only a non-empty string is a note.
  const note = typeof e.note === 'string' && e.note.length > 0 ? e.note : null;
  return {
    id: String(e.id), fingerprint: String(e.event_fingerprint), eventAt: String(e.event_at),
    evidenceFamily: String(e.evidence_family), arrivalClass: String(e.arrival_class),
    eventKind: int(e.event_kind, 'event_kind'), attrSha: str(e.attr_sha), note,
    attrTool: str(e.attr_tool) || null, attrSessionId: str(e.attr_session),
  };
}

async function readDelivery(tx: BuilderReadExecutor, row: AttestaSubjectRow) {
  const r = await rows(tx, sql`/* builder:delivery */
    select provider, delivery_id, event_fingerprint, ${ts('received_at')} as received_at
    from provider_event_deliveries
    where tenant_id = ${row.tenantId} and provider = ${row.provider} and delivery_id = ${row.providerDeliveryId}`);
  if (r.length !== 1) throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'provider delivery not found for this tenant');
  return {
    provider: String(r[0].provider), deliveryId: String(r[0].delivery_id),
    fingerprint: String(r[0].event_fingerprint), receivedAt: String(r[0].received_at),
  };
}

/** svc:262–279: match on the normalized email when there is one, else on the name. */
async function readCommitter(tx: BuilderReadExecutor, row: AttestaSubjectRow, commitId: string): Promise<string | null> {
  const r = await rows(tx, sql`/* builder:committer */
    select ct.id::text as id
    from scm_commits c
    join scm_contributors ct on ct.tenant_id = c.tenant_id and ct.repository_id = c.repository_id
      and case when nullif(lower(trim(c.author_email)), '') is not null
               then lower(trim(ct.email)) = lower(trim(c.author_email))
               else lower(trim(ct.name)) = lower(trim(c.author_name)) end
    where c.tenant_id = ${row.tenantId} and c.id = ${commitId}::uuid
    order by ct.created_at, ct.id limit 1`);
  return r.length === 1 ? String(r[0].id) : null;
}

async function readLineage(tx: BuilderReadExecutor, row: AttestaSubjectRow): Promise<LineageSource[]> {
  const where = row.kind === 'pr_merged'
    ? sql`ml.pull_request_id = ${row.pullRequestId}::uuid`
    : sql`ml.result_sha = ${row.commitSha}`;
  const r = await rows(tx, sql`/* builder:lineage */
    select src.id::text as source_commit_id, src.sha as source_sha, ml.result_sha, ml.merge_method,
      ml.confidence,
      exists (select 1 from ai_code_lifecycle_events l where l.tenant_id = src.tenant_id
        and l.stage = 'committed' and l.evidence_ref = 'commit:' || src.id::text) as source_normalized,
      (select ar.statement_digest from attesta_records ar
        where ar.tenant_id = ml.tenant_id and ar.repository_id = src.repository_id
          and ar.subject_sha = src.sha and ar.statement_kind = 'commit_observed'
        order by ar.seq desc limit 1) as source_statement_digest
    from scm_merge_lineage ml
    join scm_commits src on src.tenant_id = ml.tenant_id and src.id = ml.source_commit_id
    where ml.tenant_id = ${row.tenantId} and src.repository_id = ${row.repositoryId} and ${where}
    order by ml.created_at, ml.id`);
  const seen = new Set<string>();
  const out: LineageSource[] = [];
  for (const l of r) {
    const sourceSha = String(l.source_sha);
    if (seen.has(sourceSha)) continue; // S11: each source commit once (first observation wins)
    seen.add(sourceSha);
    out.push({
      sourceCommitId: String(l.source_commit_id), sourceSha, resultSha: String(l.result_sha),
      mergeMethod: String(l.merge_method), confidence: int(l.confidence, 'confidence'),
      sourceStatementDigest: str(l.source_statement_digest), sourceNormalized: l.source_normalized === true,
    });
  }
  return out;
}

interface SessionRow { commitId: string; sessionId: string; tool: unknown; aiLines: number }
interface ModelRow { commitId: string; tool: unknown; model: unknown; sessionId: string | null; aiLines: number }

/**
 * The sessions and models one note named (B1 applied to attribution): Task2 upserts
 * ai_commit_sessions and ai_commit_model_attributions by key and never deletes
 * (svc:1029–1070), so rows from an earlier note for the same sha are still there.
 * A commit_observed statement reports only the identities its own note produced.
 */
interface NoteScope {
  /** (ai_sessions.tool, ai_sessions.external_session_id) pairs, as ensureSession keys them. */
  sessions: Array<[string, string]>;
  /** Task2's stored model keys for this note (modelAttributionsFromNote), used only to select rows. */
  modelKeys: string[];
}

function noteScope(event: MetricEventSource): NoteScope {
  const parsed = parseAuthorshipNote(event.note);
  const sessions: Array<[string, string]> = parsed.sessions.length > 0
    ? parsed.sessions.map((x) => [x.tool, x.externalId])
    : event.attrSessionId ? [[event.attrTool ?? 'unknown', event.attrSessionId]] : [];
  return { sessions, modelKeys: [...new Set(modelAttributionsFromNote(parsed).map((m) => m.modelKey))] };
}

async function readSessions(tx: BuilderReadExecutor, row: AttestaSubjectRow, commitIds: string[], scope: NoteScope | null): Promise<SessionRow[]> {
  if (scope && scope.sessions.length === 0) return [];
  const scoped = scope
    ? sql` and (s.tool, s.external_session_id) in (${sql.join(scope.sessions.map(([t, e]) => sql`(${t}, ${e})`), sql`, `)})`
    : sql``;
  const r = await rows(tx, sql`/* builder:sessions */
    select cs.commit_id::text as commit_id, s.id::text as session_id, s.tool, cs.observed_ai_lines
    from ai_commit_sessions cs
    join ai_sessions s on s.tenant_id = cs.tenant_id and s.id = cs.session_id
    where cs.tenant_id = ${row.tenantId} and cs.commit_id in ${uuidList(commitIds)}${scoped}
    order by s.id, cs.commit_id`);
  return r.map((x) => ({
    commitId: String(x.commit_id), sessionId: String(x.session_id), tool: x.tool,
    aiLines: int(x.observed_ai_lines, 'observed_ai_lines'),
  }));
}

async function readModels(tx: BuilderReadExecutor, row: AttestaSubjectRow, commitIds: string[], scope: NoteScope | null): Promise<ModelRow[]> {
  if (scope && scope.modelKeys.length === 0) return [];
  // model_key (s:1083) selects this note's rows; it is never copied (rule 3 derives it).
  const scoped = scope ? sql` and model_key in ${textList(scope.modelKeys)}` : sql``;
  const r = await rows(tx, sql`/* builder:models */
    select commit_id::text as commit_id, tool, model, session_id::text as session_id, observed_ai_lines
    from ai_commit_model_attributions
    where tenant_id = ${row.tenantId} and commit_id in ${uuidList(commitIds)}${scoped}
    order by commit_id, id`);
  return r.map((m) => ({
    commitId: String(m.commit_id), tool: m.tool, model: m.model, sessionId: str(m.session_id),
    aiLines: int(m.observed_ai_lines, 'observed_ai_lines'),
  }));
}

interface FindingGroup { category: string; severity: string; rulePack: string; n: number }
async function readFindings(tx: BuilderReadExecutor, row: AttestaSubjectRow, sessionIds: string[]): Promise<FindingGroup[]> {
  if (sessionIds.length === 0) return [];
  // s:474–505: no key to ai_sessions, so the finding's session string is matched to
  // the external session ID of the reported sessions (partial / linked_by_session_string_not_key).
  const r = await rows(tx, sql`/* builder:findings */
    select f.rule_category, f.rule_severity, f.rule_pack_version, count(*)::int as n
    from security_findings f
    where f.tenant_id = ${row.tenantId} and f.repository_id = ${row.repositoryId}
      and f.session_id in (
        select s.external_session_id from ai_sessions s
        where s.tenant_id = ${row.tenantId} and s.id in ${uuidList(sessionIds)})
    group by 1, 2, 3 order by 1, 2, 3`);
  return r.map((f) => ({
    category: String(f.rule_category), severity: String(f.rule_severity),
    rulePack: String(f.rule_pack_version), n: int(f.n, 'finding count'),
  }));
}

/** envelope.md step 1: earlier statements about (tenant, repository, sha), oldest first. */
async function readPrevious(tx: BuilderReadExecutor, row: AttestaSubjectRow) {
  const r = await rows(tx, sql`/* builder:previous */
    select statement_digest, statement_kind from attesta_records
    where tenant_id = ${row.tenantId} and repository_id = ${row.repositoryId} and subject_sha = ${row.commitSha}
    order by seq`);
  return r.map((p) => ({ digest: String(p.statement_digest), statement_kind: String(p.statement_kind) }));
}

/**
 * Chain order inside a subject (kept after contract finding F2 was resolved on
 * 2026-10-13: the schema now lets `previous` name any kind, but the natural order
 * commit → PR → deploy keeps statements readable, and a wait costs no attempt). A
 * pr_merged waits for pending commit_observed rows about its subject and its lineage
 * sources, and a deployed also for pending pr_merged rows. Failed rows never block
 * (they end visible in the outbox).
 */
async function waitForEarlierKinds(tx: BuilderReadExecutor, row: AttestaSubjectRow, sourceShas: string[]): Promise<void> {
  if (row.kind === 'commit_observed') return;
  const subjectKinds = row.kind === 'deployed' ? ['commit_observed', 'pr_merged'] : ['commit_observed'];
  const sources = sourceShas.length > 0
    ? sql` or (o.kind = 'commit_observed' and o.commit_sha in ${textList(sourceShas)})`
    : sql``;
  const r = await rows(tx, sql`/* builder:wait */
    select count(*)::int as n from attesta_subjects o
    where o.tenant_id = ${row.tenantId} and o.repository_id = ${row.repositoryId} and o.id <> ${row.id}::uuid
      and o.status in ('pending', 'claimed')
      and ((o.commit_sha = ${row.commitSha} and o.kind in ${textList(subjectKinds)})${sources})`);
  if (int(r[0]?.n ?? 0, 'count') > 0) {
    throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'an earlier statement about this subject is still queued', { wait: true });
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Sources {
  asOf: string;
  repository: { id: string; provider: string; urlSha256: string | null };
  commit: CommitSource | null;
  metricEvent: MetricEventSource | null;
  delivery: { provider: string; deliveryId: string; fingerprint: string; receivedAt: string } | null;
  /** The projections describe the observation this statement is about (B2). */
  projectionsCurrent: boolean;
  committerId: string | null;
  /** Commits whose sessions/models/findings this statement reports, and whether some sources were not reported. */
  attribution: { commitIds: string[]; someMissing: boolean } | null;
  sessions: SessionRow[];
  models: ModelRow[];
  findings: FindingGroup[];
  lifecycleLines: number | null;
  lineage: LineageSource[] | null;
  pullRequest: Record<string, unknown> | null;
  deployment: Record<string, unknown> | null;
  enrollment: Record<string, unknown> | null;
  monitor: { mode: unknown; version: unknown } | null;
  previous: Array<{ digest: string; statement_kind: string }>;
}

async function readSources(tx: BuilderReadExecutor, row: AttestaSubjectRow): Promise<Sources> {
  const asOfRows = await rows(tx, sql`/* builder:now */ select ${ts('now()')} as as_of`);
  const asOf = String(asOfRows[0]?.as_of);
  const repository = await readRepository(tx, row);
  const commit = await readCommit(tx, row);

  let metricEvent: MetricEventSource | null = null;
  let delivery: Sources['delivery'] = null;
  let projectionsCurrent: boolean;
  let lineage: LineageSource[] | null = null;
  let attribution: Sources['attribution'] = null;
  let lifecycleLines: number | null = null;
  let pullRequest: Record<string, unknown> | null = null;
  let deployment: Record<string, unknown> | null = null;

  if (row.kind === 'commit_observed') {
    metricEvent = await readMetricEvent(tx, row);
    // The pointer was bound at enqueue (outbox.md); a mismatch now means the
    // sources were replaced (reset), so the row cannot be attested.
    if (!commit || commit.id !== row.commitId || metricEvent.attrSha !== row.commitSha
      || (metricEvent.eventKind !== 1 && metricEvent.eventKind !== 7)) {
      throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'the commit or its source event no longer matches the pointer');
    }
    // B2: the projections describe this note only while the stored note is it.
    const eventNoteSha = metricEvent.note === null ? null : sha256Hex(metricEvent.note);
    projectionsCurrent = commit.noteSha256 === eventNoteSha;
    if (projectionsCurrent) {
      attribution = { commitIds: [commit.id], someMissing: false };
      lifecycleLines = commit.committedLines;
    }
  } else {
    delivery = await readDelivery(tx, row);
    // pr_merged / deployed: the subject commit's own Git AI projections are used
    // only when Git AI normalized it (no note event anchors them otherwise).
    projectionsCurrent = commit?.gitAiNormalized === true;
    lineage = await readLineage(tx, row);
    // Sessions and models of a merge or deployment are those of the commits it
    // carries: the lineage sources Git AI normalized, plus the subject itself.
    const ids = new Set<string>();
    if (commit && commit.gitAiNormalized) ids.add(commit.id);
    for (const l of lineage) if (l.sourceNormalized) ids.add(l.sourceCommitId);
    const someMissing = lineage.some((l) => !l.sourceNormalized);
    if (ids.size > 0) attribution = { commitIds: [...ids].sort(), someMissing };
    if (lineage.length === 0) lineage = null;

    if (row.kind === 'pr_merged') {
      const pr = await rows(tx, sql`/* builder:pull_request */
        select p.id::text as id, p.number, p.external_id, p.state, p.head_sha, p.merge_commit_sha,
          ${ts('p.merged_at')} as merged_at,
          (select i.id::text from scm_provider_identities i where i.tenant_id = p.tenant_id
             and i.provider = ${repository.provider} and i.provider_user_id = p.author_provider_id
           order by i.id limit 1) as author_identity_id
        from scm_pull_requests p
        where p.tenant_id = ${row.tenantId} and p.repository_id = ${row.repositoryId} and p.id = ${row.pullRequestId}::uuid`);
      if (pr.length !== 1 || pr[0].merge_commit_sha !== row.commitSha || pr[0].merged_at === null
        || pr[0].number === null) {
        throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'the merged pull request no longer matches the pointer');
      }
      pullRequest = pr[0];
      if (lineage) {
        const m = await rows(tx, sql`/* builder:lifecycle_merged */
          select coalesce(sum(line_count), 0)::text as n from ai_code_lifecycle_events
          where tenant_id = ${row.tenantId} and repository_id = ${row.repositoryId}
            and stage = 'merged' and pull_request_id = ${row.pullRequestId}::uuid`);
        lifecycleLines = int(m[0]?.n, 'merged line_count');
      }
    } else {
      const d = await rows(tx, sql`/* builder:deployment */
        select id::text as id, provider, external_id, environment, status, production,
          ${ts('deployed_at')} as deployed_at, sha
        from scm_deployments
        where tenant_id = ${row.tenantId} and repository_id = ${row.repositoryId} and id = ${row.deploymentId}::uuid`);
      if (d.length !== 1 || d[0].external_id !== row.deploymentExternalId || d[0].sha !== row.commitSha
        || d[0].status !== 'success' || d[0].production !== true) {
        throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'the deployment no longer matches the pointer');
      }
      deployment = d[0];
      const pr = await rows(tx, sql`/* builder:pull_request */
        select p.id::text as id, p.number, p.external_id, p.state, p.head_sha, p.merge_commit_sha,
          ${ts('p.merged_at')} as merged_at,
          (select i.id::text from scm_provider_identities i where i.tenant_id = p.tenant_id
             and i.provider = ${repository.provider} and i.provider_user_id = p.author_provider_id
           order by i.id limit 1) as author_identity_id
        from scm_pull_requests p
        where p.tenant_id = ${row.tenantId} and p.repository_id = ${row.repositoryId}
          and p.merge_commit_sha = ${row.commitSha} and p.merged_at is not null
        order by p.merged_at, p.id limit 2`);
      // Exactly one merged PR names this commit; none or two cannot be attributed.
      if (pr.length === 1 && pr[0].number !== null) pullRequest = pr[0];
      if (attribution) {
        // lc:476–536: written in the same transaction as the outbox row.
        const prefix = `deployment:${row.deploymentExternalId}:success:`;
        const p = await rows(tx, sql`/* builder:lifecycle_production */
          select coalesce(sum(line_count), 0)::text as n from ai_code_lifecycle_events
          where tenant_id = ${row.tenantId} and repository_id = ${row.repositoryId}
            and stage = 'production' and left(evidence_ref, ${prefix.length}) = ${prefix}`);
        lifecycleLines = int(p[0]?.n, 'production line_count');
      }
    }
    await waitForEarlierKinds(tx, row, (lineage ?? []).map((l) => l.sourceSha));
  }

  const committerId = commit && projectionsCurrent && commit.hasAuthor ? await readCommitter(tx, row, commit.id) : null;
  const scope = metricEvent ? noteScope(metricEvent) : null;
  const sessions = attribution ? await readSessions(tx, row, attribution.commitIds, scope) : [];
  const models = attribution ? await readModels(tx, row, attribution.commitIds, scope) : [];
  const findings = attribution ? await readFindings(tx, row, [...new Set(sessions.map((x) => x.sessionId))]) : [];

  const en = await rows(tx, sql`/* builder:enrollment */
    select id::text as id, status, ${ts('effective_from')} as effective_from,
      ${ts('effective_until')} as effective_until, ${ts('commit_note_evidence_from')} as commit_note_evidence_from
    from repository_enrollments where tenant_id = ${row.tenantId} and repository_id = ${row.repositoryId}`);
  // The mode in force as of as_of, by Task6's activation rule (activation.ts:43–46):
  // a revoked or expired monitor setting is off, never signed as monitoring.
  const mon = await rows(tx, sql`/* builder:security_monitor */
    select case when mode = 'monitor' and revoked_at is null and (valid_until is null or valid_until > now())
                then 'monitor' else 'off' end as mode, version
    from tenant_security_monitor_settings where tenant_id = ${row.tenantId}`);
  const previous = await readPrevious(tx, row);

  return {
    asOf, repository, commit, metricEvent, delivery, projectionsCurrent, committerId, attribution,
    sessions, models, findings, lifecycleLines, lineage, pullRequest, deployment,
    enrollment: en[0] ?? null,
    monitor: mon[0] ? { mode: mon[0].mode, version: mon[0].version } : null,
    previous,
  };
}

interface NoteFiles { entries: Array<Record<string, unknown>> }

/** B1: files come from the source event's note, parsed exactly as Task2 parses it (svc:900–918). */
function noteFiles(note: string): NoteFiles {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const file of parseAuthorshipNote(note).files) {
    // Stored JSON form of the ranges (undefined members dropped), as jsonb holds them.
    const stored: unknown = JSON.parse(JSON.stringify(file.ranges));
    // Task2 upserts by path, so a repeated path keeps its last values.
    byPath.set(file.path, {
      path_sha256: sha256Hex(file.path),
      ai_lines: file.aiLines,
      human_lines: file.humanLines,
      unknown_lines: unavailable('not_captured_yet'), // written as 0 without computing it (svc:908)
      attribution_ranges_sha256: sha256Hex(canonicalize(stored)),
    });
  }
  return { entries: [...byPath.values()] };
}

function assemble(row: AttestaSubjectRow, s: Sources, options: BuilderOptions, files: NoteFiles | null, keep: number) {
  const kind = row.kind;
  const c = s.commit;
  const current = s.projectionsCurrent;

  // signed_late: backfill arrival first, then a build long after the event.
  let signedLate = { value: false, reason: 'none' };
  if (s.metricEvent?.arrivalClass === 'backfill') signedLate = { value: true, reason: 'backfill' };
  else if (Date.parse(s.asOf) - Date.parse(row.eventAt) > DELAYED_BUILD_AFTER_MS) {
    signedLate = { value: true, reason: 'delayed_build' };
  }

  // source_evidence.metric_event: telemetry_metric_events (s:856–862), commit_observed only.
  let metricEventField: Field = unavailable('not_applicable');
  let noteDigest: Field = unavailable('source_missing');
  if (s.metricEvent) {
    const fp = fitHex(s.metricEvent.fingerprint);
    metricEventField = recordedOr({
      id: s.metricEvent.id, fingerprint: fp.value, event_at: s.metricEvent.eventAt,
      evidence_family: s.metricEvent.evidenceFamily, arrival_class: s.metricEvent.arrivalClass,
    }, fp.hashed ? 'values_hashed_unrepresentable' : null);
    // note_digest: SHA-256 of the note string as decoded from the source event (decision 2).
    noteDigest = s.metricEvent.note === null
      ? unavailable('not_reported_by_source')
      : recorded({ algorithm: 'sha256', encoding: 'utf-8', value: sha256Hex(s.metricEvent.note), source_event_id: s.metricEvent.id });
  }

  // source_evidence.provider_delivery: provider_event_deliveries (s:898–905).
  let deliveryField: Field = unavailable('not_applicable');
  if (s.delivery) {
    const id = fit(s.delivery.deliveryId, DELIVERY_REF_RE);
    const fp = fitHex(s.delivery.fingerprint);
    deliveryField = recordedOr({
      provider: s.delivery.provider, delivery_id: id.value, event_fingerprint: fp.value, received_at: s.delivery.receivedAt,
    }, id.hashed || fp.hashed ? 'values_hashed_unrepresentable' : null);
  }

  // first_seen: scm_commits.first_seen_at (s:963); source by source_event_id (s:973).
  const firstSeen = c
    ? recorded({ at: c.firstSeenAt, source: c.sourceEventId === null ? 'github_push' : 'git_ai_note' })
    : unavailable('source_missing');

  // commit: scm_commits (s:960–962). Git AI's own columns need a Git AI observation.
  const gitAiCommit = c !== null && (kind === 'commit_observed' || c.gitAiNormalized);
  const commitField = {
    sha: row.commitSha,
    operation_kind: gitAiCommit && c!.operationKind && OPERATION_KIND_RE.test(c!.operationKind)
      ? recorded(c!.operationKind) : unavailable('source_missing'),
    reachability: c && c.reachability && REACHABILITY.has(c.reachability) ? recorded(c.reachability) : unavailable('source_missing'),
    authored_at: gitAiCommit && c!.authoredAt ? recorded(c!.authoredAt) : unavailable('source_missing'),
    committed_at: gitAiCommit && c!.committedAt ? recorded(c!.committedAt) : unavailable('source_missing'),
  };

  // lines: scm_commits (s:965–970), computed at svc:770–774; B2.
  const lines = c && current
    ? recorded({ ai: c.ai, human: c.human, unknown: c.unknown, added: c.added, deleted: c.deleted })
    : unavailable('source_missing');

  // files: the source event's note (B1); truncated only to fit (envelope.md step 4).
  let filesField: Field;
  if (kind !== 'commit_observed') filesField = unavailable('source_missing');
  else if (files === null) filesField = unavailable('not_reported_by_source');
  else {
    const total = files.entries.length;
    const kept = files.entries.slice(0, keep);
    filesField = recordedOr({ total, omitted: total - kept.length, entries: kept },
      kept.length < total ? 'entries_truncated' : null);
  }

  // sessions, models, tools: ai_commit_sessions / ai_sessions (s:1002–1066),
  // ai_commit_model_attributions (s:1075–1084); rules 1–3.
  let sessionsField: Field = unavailable('source_missing');
  let modelsField: Field = unavailable('source_missing');
  let toolsField: Field = unavailable('source_missing');
  if (s.attribution) {
    const someMissing = s.attribution.someMissing;
    let hashed = false;
    const sessions = new Map<string, { session_id: string; tool: string; ai_lines: number }>();
    for (const r of s.sessions) {
      const tool = fit(normalizeTool(r.tool), TOKEN_RE);
      hashed ||= tool.hashed;
      const existing = sessions.get(r.sessionId);
      if (existing) existing.ai_lines += r.aiLines;
      else sessions.set(r.sessionId, { session_id: r.sessionId, tool: tool.value, ai_lines: r.aiLines });
    }
    const models = new Map<string, Record<string, unknown> & { ai_lines: number }>();
    let modelsHashed = false;
    let modelsOmitted = false;
    let toolsHashed = hashed;
    for (const r of s.models) {
      const tool = fit(normalizeTool(r.tool), TOKEN_RE);
      const rawModel = normalizeModel(r.model);
      const model = rawModel === null ? null : fit(rawModel, TOKEN_RE);
      modelsHashed ||= tool.hashed || Boolean(model?.hashed);
      toolsHashed ||= tool.hashed;
      const modelKey = `${tool.value}::${model?.value ?? 'unknown'}`;
      // S8 fixes model_key = tool::model, and a token is at most 128 characters, so a
      // pair too long to join (two hashed values, a long ARN) cannot be represented:
      // the row is left out and the field says so (contract finding F7).
      if (!TOKEN_RE.test(modelKey)) { modelsOmitted = true; continue; }
      const key = `${modelKey}\u0000${r.sessionId ?? ''}`;
      const existing = models.get(key);
      if (existing) existing.ai_lines += r.aiLines;
      else models.set(key, { tool: tool.value, model: model?.value ?? null, model_key: modelKey, ai_lines: r.aiLines, session_id: r.sessionId });
    }
    const sessionList = [...sessions.values()].sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
    const modelList = [...models.values()].sort((a, b) => {
      const ka = `${a.model_key}\u0000${a.session_id ?? ''}`;
      const kb = `${b.model_key}\u0000${b.session_id ?? ''}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const tools = [...new Set([...sessionList.map((x) => x.tool), ...modelList.map((x) => x.tool as string)])].sort();
    const reason = (h: boolean): PartialReason | null =>
      (someMissing ? 'only_some_sources_reported' : h ? 'values_hashed_unrepresentable' : null);
    sessionsField = recordedOr(sessionList, reason(hashed));
    modelsField = recordedOr(modelList, modelsOmitted ? 'only_some_sources_reported' : reason(modelsHashed));
    toolsField = recordedOr(tools, reason(toolsHashed));
  }

  // committer: scm_contributors (s:1546–1556) matched as svc:262–279.
  let committer: Field = unavailable('source_missing');
  if (s.committerId) committer = partial({ contributor_id: s.committerId }, 'identity_matched_by_name_or_email');

  // lifecycle: ai_code_lifecycle_events (s:1447–1459), this kind's stage.
  const stage = kind === 'commit_observed' ? 'committed' : kind === 'pr_merged' ? 'merged' : 'production';
  let lifecycle: Field = unavailable('source_missing');
  if (s.lifecycleLines !== null) {
    lifecycle = recordedOr({
      stage, ai_lines: s.lifecycleLines, calculation_version: unavailable('not_captured_yet'),
    }, s.attribution?.someMissing ? 'only_some_sources_reported' : null);
  }

  // pull_request: scm_pull_requests (s:809–826), author via scm_provider_identities (s:1495).
  let pullRequestField: Field = unavailable(kind === 'commit_observed' ? 'not_applicable' : 'source_missing');
  if (s.pullRequest) {
    const p = s.pullRequest;
    const ext = fit(String(p.external_id), EXTERNAL_REF_RE);
    const headSha = typeof p.head_sha === 'string' && GIT_SHA_RE.test(p.head_sha) ? p.head_sha : null;
    pullRequestField = recordedOr({
      id: String(p.id), provider: s.repository.provider, number: int(p.number, 'number'), external_id: ext.value,
      state: 'merged', head_sha: headSha, merge_commit_sha: String(p.merge_commit_sha), merged_at: String(p.merged_at),
      author_identity_id: typeof p.author_identity_id === 'string' ? recorded(p.author_identity_id) : unavailable('source_missing'),
    }, ext.hashed ? 'values_hashed_unrepresentable' : headSha === null ? 'optional_source_field_missing' : null);
  }

  // merge_lineage: scm_merge_lineage (s:1163–1172), source statements from attesta_records.
  let lineageField: Field = unavailable(kind === 'commit_observed' ? 'not_applicable' : 'source_missing');
  if (s.lineage) {
    // A source whose commit statement is not chained yet links later (fields.md).
    lineageField = recordedOr(s.lineage.map((l) => ({
      source_sha: l.sourceSha, result_sha: l.resultSha, merge_method: l.mergeMethod,
      confidence: l.confidence, source_statement_digest: l.sourceStatementDigest,
    })), s.lineage.some((l) => l.sourceStatementDigest === null) ? 'lineage_still_being_enriched' : null);
  }

  // deployment: scm_deployments (s:1179–1191).
  let deploymentField: Field = unavailable('not_applicable');
  if (s.deployment) {
    const d = s.deployment;
    const ext = fit(String(d.external_id), EXTERNAL_REF_RE);
    deploymentField = recordedOr({
      id: String(d.id), provider: String(d.provider), external_id: ext.value, environment: String(d.environment),
      status: 'success', production: true, deployed_at: String(d.deployed_at), sha: String(d.sha),
    }, ext.hashed ? 'values_hashed_unrepresentable' : null);
  }

  // policy.repository_enrollment: repository_enrollments (s:191–199).
  const en = s.enrollment;
  const enrollment = en
    ? recorded({
      id: String(en.id), status: en.status, effective_from: en.effective_from,
      effective_until: en.effective_until ?? null, commit_note_evidence_from: en.commit_note_evidence_from,
    })
    : unavailable('source_missing');
  // policy.security_monitor: tenant_security_monitor_settings (s:291–295).
  const monitor = s.monitor ? recorded({ mode: s.monitor.mode, version: s.monitor.version }) : unavailable('source_missing');

  // security_findings_observed + policy.rule_pack_versions: security_findings (s:474–505).
  let findingsField: Field = unavailable('source_missing');
  let rulePacks: Field = unavailable('source_missing');
  if (s.attribution) {
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const packs = new Set<string>();
    let total = 0;
    for (const f of s.findings) {
      total += f.n;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + f.n;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + f.n;
      packs.add(fit(f.rulePack, RULE_PACK_RE).value);
    }
    findingsField = partial({ total, by_category: byCategory, by_severity: bySeverity }, 'linked_by_session_string_not_key');
    rulePacks = partial([...packs].sort(), 'present_only_when_findings_exist');
  }

  const predicate = {
    statement_kind: kind,
    as_of: s.asOf,
    builder: { name: BUILDER_NAME, version: options.builderVersion },
    signed_late: signedLate,
    previous: s.previous,
    source_evidence: { metric_event: metricEventField, provider_delivery: deliveryField, note_digest: noteDigest },
    first_seen: firstSeen,
    repository: {
      id: s.repository.id, provider: s.repository.provider,
      url_sha256: s.repository.urlSha256 ? recorded(s.repository.urlSha256) : unavailable('source_missing'),
    },
    commit: commitField,
    lines,
    files: filesField,
    sessions: sessionsField,
    models: modelsField,
    tools: toolsField,
    committer,
    lifecycle,
    pull_request: pullRequestField,
    merge_lineage: lineageField,
    merged_by: unavailable('not_captured_yet'), // G4
    reviews: unavailable('not_captured_yet'), // G3
    deployment: deploymentField,
    policy: {
      repository_enrollment: enrollment,
      security_monitor: monitor,
      rule_pack_versions: rulePacks,
      org_ai_policy: unavailable('not_captured_yet'), // G2
    },
    security_findings_observed: findingsField,
    repo_snapshot: unavailable('not_captured_yet'), // G1
  };
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{
      name: `trackai:repository/${s.repository.id}/commit/${row.commitSha}`,
      digest: { gitCommit: row.commitSha },
    }],
    predicateType: AI_PROVENANCE_PREDICATE_TYPE,
    predicate,
  };
}

// ---------------------------------------------------------------------------
// Validation (the frozen schemas, compiled once)
// ---------------------------------------------------------------------------

let validator: ValidateFunction | null = null;

function contractDir(): string {
  // Walk up from this file to the repository's docs/contracts/attesta (src and dist
  // are at the same depth, and the contract is never copied).
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'statement-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('docs/contracts/attesta not found above the builder');
}

export function statementValidator(): ValidateFunction {
  if (validator) return validator;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  // The fixture test's settings (contract-fixtures.test.ts), so both check the same thing.
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  ajv.addSchema(load('predicate-ai-provenance-v1.schema.json'));
  validator = ajv.compile(load('statement-v1.schema.json'));
  return validator;
}

/** envelope.md steps 2–3 for one candidate: canonical bytes, then the snapshot checked. */
function finalizeCandidate(candidate: unknown): { canonical: string; snapshot: Record<string, unknown> } {
  let canonical: string;
  try {
    canonical = canonicalize(candidate);
  } catch (err) {
    if (err instanceof CanonicalizationError) {
      throw new AttestaBuilderError('ATTESTA_BUILDER_NOT_CANONICAL', 'the statement cannot be canonicalized');
    }
    throw err;
  }
  const snapshot = JSON.parse(canonical) as Record<string, unknown>;
  const validate = statementValidator();
  if (!validate(snapshot)) {
    const where = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.keyword}`).join('; ');
    throw new AttestaBuilderError('ATTESTA_BUILDER_SCHEMA_INVALID', `schema refused the statement at ${where}`);
  }
  const broken = checkStatementRules(snapshot);
  if (broken.length > 0) {
    throw new AttestaBuilderError('ATTESTA_BUILDER_RULE_VIOLATION', `statement breaks ${broken.join(', ')}`);
  }
  return { canonical, snapshot };
}

function paeLength(canonical: string): number {
  return pae(IN_TOTO_PAYLOAD_TYPE, Buffer.from(canonical, 'utf8')).length;
}

/**
 * Build, canonicalize, validate and size one statement (envelope.md steps 1–4).
 * `readTx` is the caller's open read transaction; `as_of` is its now().
 */
export async function buildStatement(
  readTx: BuilderReadExecutor,
  subjectRow: AttestaSubjectRow,
  options: BuilderOptions,
): Promise<BuiltStatement> {
  if (!BUILDER_VERSION_RE.test(options.builderVersion)) throw new RangeError('builderVersion must be <semver>+<git commit>');
  if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) {
    throw new RangeError('maxPayloadBytes must be a positive integer');
  }
  if (!UUID_RE.test(subjectRow.tenantId) || !UUID_RE.test(subjectRow.repositoryId) || !GIT_SHA_RE.test(subjectRow.commitSha)) {
    throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_MISSING', 'the outbox row is malformed');
  }
  // `previous` lists every earlier statement about the subject, of any kind, in chain
  // order (contract finding F2, resolved 2026-10-13: the schema no longer limits kinds).
  const sources = await readSources(readTx, subjectRow);
  // S5 compares TrackAI's own observation times with as_of; a time ahead of the
  // database clock (another server's clock) settles by itself, so wait for it.
  const observed = [sources.commit?.firstSeenAt, sources.delivery?.receivedAt];
  if (observed.some((t) => typeof t === 'string' && t > sources.asOf)) {
    throw new AttestaBuilderError('ATTESTA_BUILDER_SOURCE_NOT_READY', 'an observation time is ahead of the database clock');
  }
  const files = sources.metricEvent?.note ? noteFiles(sources.metricEvent.note) : null;
  const total = files?.entries.length ?? 0;

  const fits = (canonical: string) =>
    paeLength(canonical) <= options.maxPayloadBytes && Buffer.byteLength(canonical, 'utf8') <= MAX_STATEMENT_BYTES;
  const attempt = (keep: number) => finalizeCandidate(assemble(subjectRow, sources, options, files, keep));

  // Step 4: the most file entries that fit; never drop any other field.
  let keep = Math.min(total, MAX_FILE_ENTRIES);
  let result = attempt(keep);
  if (!fits(result.canonical)) {
    const none = attempt(0);
    if (!fits(none.canonical)) {
      throw new AttestaBuilderError('ATTESTA_BUILDER_TOO_LARGE', 'the statement does not fit the signer even with no file entries');
    }
    let lo = 0; // fits
    let hi = keep; // does not fit
    result = none;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = attempt(mid);
      if (fits(candidate.canonical)) { lo = mid; result = candidate; } else hi = mid;
    }
    keep = lo;
  }
  return {
    statement: result.snapshot,
    canonical: result.canonical,
    digest: sha256Prefixed(result.canonical),
    previousSeen: sources.previous.map((p) => p.digest),
  };
}
