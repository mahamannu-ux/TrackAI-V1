/**
 * Security-finding seals (Task15op-a, A15.15, gap G6; docs/contracts/attesta/security-findings-seal.md).
 *
 *   securityRowDigest / buildSecuritySealDocument / buildSecuritySealStatement   pure, deterministic
 *   planSecuritySealWindow                                                       the cadence, pure
 *   parseSecuritySealDocument / checkSecuritySealRows (+ checkSealLinks)         break finders, pure
 *   runSecuritySealPass                                                          per tenant: one repeatable-read
 *                                                                                snapshot → sign (no transaction) →
 *                                                                                ONE ledger transaction
 *   pgSecuritySealStore                                                          the tenant-bound PostgreSQL store
 *   verifySecuritySeals                                                          GET /api/attesta/security-seals/verify
 *
 * Pattern: Task16e audit-seal / Task15i4 period-report (SushiCorp RP-1 @ 0bd67a5): a small
 * signed statement names the digest of a stored document rebuilt byte for byte from the same
 * rows. EV-1 (the chain) is reused through chainStatement. Deviations from audit seals: the
 * window compares received_at (a late upload lands in a later window), a 10-minute settle
 * margin, 8 000 rows a seal (the document stays near the 1 MiB statement bound), and per-
 * generation counts. The ingest path (Task20d) is untouched.
 *
 * Every query binds tenant_id, except listing the tenants to seal (an operator pass). No
 * network call inside a transaction (AGENTS.md §9 item 18). Timestamps are always the exact
 * microsecond text, never a JS Date. Rows are read as a fixed metadata projection: no title,
 * tags or preview ever leaves the table here (AGENTS.md rule 6).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { sql } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { recordAuditEvent } from '../../core/audit/record';
import { checkSealLinks, compareRows as compareAuditRows, type SealBreak, type SealDatabase, type SealDbExecutor } from './audit-seal-service';
import { canonicalize, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  AttestaLedgerError, IN_TOTO_STATEMENT_TYPE, SECURITY_FINDINGS_SEAL_PREDICATE_TYPE, chainStatement, deriveStatementColumns,
  mapLedgerDatabaseError, statementSigningLimit, type LedgerExecutor,
} from './ledger';
import { digestsRoot } from './period-report-rules';
import { AttestaQueryError, verifyRange, type VerifyDeps } from './read-service';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';

export const SECURITY_SEAL_DOCUMENT_FORMAT = 'https://trackai.dev/attesta/security-findings-seal-document/v1';
export const SECURITY_SEALER_NAME = 'trackai-security-sealer';
/** Rows per seal: 8 000 × 129 bytes keeps a document near 1 MiB (ATTESTA_STATEMENT_MAX_SIGNED_BYTES). */
export const MAX_SECURITY_SEAL_ROWS = 8_000;
/** `to` ≤ database clock − 10 minutes: received_at is the API's clock (v2-storage.ts). */
export const SECURITY_SEAL_SETTLE_MS = 600_000;
/** Seal rows when the last seal is at least this old… */
export const SECURITY_SEAL_MIN_INTERVAL_MS = 3_600_000;
/** …and seal even an empty window when the last seal is at least this old. */
export const SECURITY_SEAL_EMPTY_INTERVAL_MS = 86_400_000;
/** With `--now`, an empty seal only when the last seal's `to` is at least this far behind the cutoff. */
export const SECURITY_SEAL_NOW_MIN_GAP_MS = 60_000;
/** Seals per tenant in one pass: a backlog of full chunks is sealed back to back. */
export const MAX_SECURITY_SEALS_PER_PASS = 50;
/**
 * One instant is never split, so a seal may exceed MAX_SECURITY_SEAL_ROWS only when every row
 * shares one received_at (at least 16 full uploads in one millisecond), up to this hard ceiling.
 */
export const MAX_SECURITY_INSTANT_ROWS = 50_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const US_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class SecuritySealError extends Error {
  /** INSTANT_OVERFLOW: the instant more than a seal's rows share (the store then reads that instant alone). */
  instant?: string;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SecuritySealError';
  }
}
const internal = (why: string) => new SecuritySealError('ATTESTA_API_INTERNAL', `security seal: ${why}`);

// ---------------------------------------------------------------------------
// Pure building blocks

/**
 * One stored finding row as the fixed projection (security-findings-seal.md "Row digest"): every
 * column of security_findings except tenant_id (the document's) and the free-text title and tags,
 * each stored value verbatim, null when empty; timestamps as the exact microsecond text.
 */
export interface SecurityFindingRow {
  id: string;
  record_generation: string;
  machine_id: string;
  repository_id: string | null;
  repository_kind: string | null;
  rule_id: string;
  rule_version: string;
  rule_category: string;
  rule_severity: string;
  effect: string | null;
  agent_family: string | null;
  source_agent: string | null;
  source_type: string | null;
  model: string | null;
  model_provider: string | null;
  session_id: string | null;
  parent_session_id: string | null;
  sub_agent_id: string | null;
  record_id: string | null;
  finding_id: string | null;
  delivery_id: string | null;
  source_event_id: string | null;
  correlation_id: string | null;
  occurred_at: string;
  received_at: string;
  detected_at: string | null;
  rule_pack_version: string;
  bundle_digest: string | null;
  lease_id: string | null;
  numbat_schema_version: string | null;
  confidence: string | null;
  found_at_rest: boolean | null;
  route_id: string | null;
  host_surface: string | null;
  host_mode: string | null;
  capture_channel: string | null;
  native_effect: string | null;
  activation: string | null;
  phase: string | null;
  timing: string | null;
  availability: string | null;
  completeness: string | null;
  result_category: string | null;
  operating_system: string | null;
  client_version: string | null;
}

export const SECURITY_ROW_KEYS = [
  'id', 'record_generation', 'machine_id', 'repository_id', 'repository_kind', 'rule_id', 'rule_version',
  'rule_category', 'rule_severity', 'effect', 'agent_family', 'source_agent', 'source_type', 'model', 'model_provider',
  'session_id', 'parent_session_id', 'sub_agent_id', 'record_id', 'finding_id', 'delivery_id', 'source_event_id',
  'correlation_id', 'occurred_at', 'received_at', 'detected_at', 'rule_pack_version', 'bundle_digest', 'lease_id',
  'numbat_schema_version', 'confidence', 'found_at_rest', 'route_id', 'host_surface', 'host_mode', 'capture_channel',
  'native_effect', 'activation', 'phase', 'timing', 'availability', 'completeness', 'result_category',
  'operating_system', 'client_version',
] as const satisfies ReadonlyArray<keyof SecurityFindingRow>;

export interface SealWindow { from: string; to: string }
export interface Generations { task6a: number; v2: number }

export interface SecuritySealDocument {
  format: typeof SECURITY_SEAL_DOCUMENT_FORMAT;
  tenant_id: string;
  window: SealWindow;
  previous: string | null;
  count: number;
  generations: Generations;
  rows: Array<{ id: string; digest: string }>;
  rows_root: string;
}

/** Only the projection keys, so a stray column (a title, say) never reaches a digest. */
export function projectionOf(row: SecurityFindingRow): SecurityFindingRow {
  const out: Record<string, unknown> = {};
  for (const key of SECURITY_ROW_KEYS) out[key] = row[key] === undefined ? null : row[key];
  return out as unknown as SecurityFindingRow;
}

/** `"sha256:" + hex(SHA-256(JCS(projection)))`. */
export function securityRowDigest(row: SecurityFindingRow): string {
  if (!US_RE.test(row.received_at) || !US_RE.test(row.occurred_at) || (row.detected_at !== null && !US_RE.test(row.detected_at))) {
    throw internal('a timestamp is not the exact microsecond text');
  }
  return sha256Prefixed(canonicalize(projectionOf(row)));
}

/** (received_at, id) ascending: the fixed-width text orders like the instant. */
export function compareSecurityRows(a: { received_at: string; id: string }, b: { received_at: string; id: string }): number {
  return compareAuditRows({ occurred_at: a.received_at, id: a.id }, { occurred_at: b.received_at, id: b.id });
}

export function generationsOf(rows: ReadonlyArray<{ record_generation: string }>): Generations {
  let task6a = 0;
  let v2 = 0;
  for (const r of rows) {
    if (r.record_generation === 'task6a') task6a += 1;
    else if (r.record_generation === 'v2') v2 += 1;
    else throw internal('a row has an unknown record_generation');
  }
  return { task6a, v2 };
}

export interface BuildSecuritySealDocumentInput {
  tenantId: string;
  window: SealWindow;
  previous: string | null;
  rows: readonly SecurityFindingRow[];
}

/** The seal document and its exact bytes. Refuses rows outside the window or out of order. */
export function buildSecuritySealDocument(input: BuildSecuritySealDocumentInput): { document: SecuritySealDocument; text: string; digest: string } {
  const { window } = input;
  if (!UUID_RE.test(input.tenantId)) throw internal('tenant id is not a lowercase UUID');
  if (!US_RE.test(window.from) || !US_RE.test(window.to) || window.from >= window.to) throw internal('the window is malformed');
  if (input.previous !== null && !DIGEST_RE.test(input.previous)) throw internal('previous is malformed');
  const oneInstant = input.rows.every((r) => r.received_at === input.rows[0].received_at);
  if (input.rows.length > (oneInstant ? MAX_SECURITY_INSTANT_ROWS : MAX_SECURITY_SEAL_ROWS)) throw internal('too many rows for one seal');
  const rows = input.rows.map((row, i) => {
    if (row.received_at < window.from || row.received_at >= window.to) throw internal('a row lies outside the window');
    if (i > 0 && compareSecurityRows(input.rows[i - 1], row) >= 0) throw internal('rows are not in (received_at, id) order');
    return { id: row.id, digest: securityRowDigest(row) };
  });
  const document: SecuritySealDocument = {
    format: SECURITY_SEAL_DOCUMENT_FORMAT,
    tenant_id: input.tenantId,
    window: { from: window.from, to: window.to },
    previous: input.previous,
    count: rows.length,
    generations: generationsOf(input.rows),
    rows,
    rows_root: digestsRoot(rows.map((r) => r.digest)),
  };
  const text = canonicalize(document);
  return { document, text, digest: sha256Prefixed(text) };
}

export const securitySealSubjectName = (tenantId: string, window: SealWindow): string =>
  `trackai:tenant/${tenantId}/security-findings/${window.from}..${window.to}`;

let validators: { statement: ValidateFunction; document: ValidateFunction } | null = null;
function contractDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'predicate-security-findings-seal-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw internal('the security seal schemas are not found');
}
/** The statement (#/definitions/statement) and document validators. */
export function securitySealValidators(): { statement: ValidateFunction; document: ValidateFunction } {
  if (validators) return validators;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const predicate = load('predicate-security-findings-seal-v1.schema.json');
  ajv.addSchema(predicate);
  validators = {
    statement: ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` }),
    document: ajv.compile(load('security-findings-seal-document-v1.schema.json')),
  };
  return validators;
}

/** The security_findings_seal statement over a built document (SS1–SS2 by construction; schemas checked). */
export function buildSecuritySealStatement(input: { document: SecuritySealDocument; documentDigest: string; asOf: string; builderVersion: string }): string {
  const d = input.document;
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: securitySealSubjectName(d.tenant_id, d.window), digest: { sha256: input.documentDigest.slice('sha256:'.length) } }],
    predicateType: SECURITY_FINDINGS_SEAL_PREDICATE_TYPE,
    predicate: {
      tenant_id: d.tenant_id,
      window: d.window,
      count: d.count,
      generations: d.generations,
      rows_root: d.rows_root,
      previous_seal: d.previous,
      builder: { name: SECURITY_SEALER_NAME, version: input.builderVersion },
      as_of: input.asOf,
      previous: [] as unknown[],
    },
  };
  const text = canonicalize(statement);
  const v = securitySealValidators();
  if (!v.document(JSON.parse(canonicalize(d)))) throw new SecuritySealError('ATTESTA_BUILDER_SCHEMA_INVALID', 'schema refused the seal document');
  if (!v.statement(JSON.parse(text))) throw new SecuritySealError('ATTESTA_BUILDER_SCHEMA_INVALID', 'schema refused the seal statement');
  return text;
}

/** What the planner needs from one snapshot. */
export interface SecuritySealPlanInput {
  /** Database clock − 10 min, exact microsecond text. */
  cutoff: string;
  last: { windowTo: string; digest: string; ageMs: number } | null;
  /** The tenant's earliest received_at (first seal only). */
  earliest: string | null;
  /** Rows from the window start, (received_at, id) ascending, at most MAX_SECURITY_SEAL_ROWS + 1. */
  rows: readonly SecurityFindingRow[];
  /** `--now`: drop the age rule (an operator about to build a report). */
  now?: boolean;
  /** The pass just sealed a chunk the row cap cut: the rest of the backlog is due at once (never an empty window). */
  backlog?: boolean;
  /** Every row at the instant an earlier plan reported as overflowing (at most MAX_SECURITY_INSTANT_ROWS + 1). */
  instantRows?: readonly SecurityFindingRow[];
}

export interface SecuritySealPlan {
  window: SealWindow;
  previous: string | null;
  rows: SecurityFindingRow[];
  /** true when `to` was cut before the cutoff by the row cap: the rest of the backlog is due at once. */
  chunked: boolean;
}

/** The next microsecond of an exact microsecond text. */
export function nextMicrosecond(us: string): string {
  if (!US_RE.test(us)) throw internal('not the exact microsecond text');
  let ms = Date.parse(`${us.slice(0, 23)}Z`);
  let micro = Number(us.slice(23, 26)) + 1;
  if (micro === 1000) {
    ms += 1;
    micro = 0;
  }
  return `${new Date(ms).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}Z`;
}

const msOf = (us: string): number => Date.parse(us.slice(0, 23) + 'Z');

/**
 * The cadence (security-findings-seal.md "Windows and cadence"): a first seal from the
 * earliest row; later seals when there are rows and the last seal is ≥ 1 h old, or when it is
 * ≥ 24 h old (an empty window). `now` seals any rows at once, and an empty window when the last
 * `to` is at least a minute behind the cutoff (so a second run is not due); `backlog` seals the
 * rows left after a chunked seal in the same pass. More than MAX_SECURITY_SEAL_ROWS rows: `to`
 * is the first row that does not fit, so one instant is never split; when the window's first
 * instant alone holds more, that instant is sealed alone (`instantRows`). null when nothing is due.
 */
export function planSecuritySealWindow(input: SecuritySealPlanInput): SecuritySealPlan | null {
  const from = input.last ? input.last.windowTo : input.earliest;
  if (from === null || from >= input.cutoff) return null;
  const rows = input.rows.filter((r) => r.received_at >= from && r.received_at < input.cutoff);
  if (input.last) {
    const due = rows.length > MAX_SECURITY_SEAL_ROWS
      || (rows.length > 0 && (input.now || input.backlog || input.last.ageMs >= SECURITY_SEAL_MIN_INTERVAL_MS))
      || input.last.ageMs >= SECURITY_SEAL_EMPTY_INTERVAL_MS
      || (input.now === true && msOf(input.cutoff) - msOf(from) >= SECURITY_SEAL_NOW_MIN_GAP_MS);
    if (!due) return null;
  } else if (rows.length === 0) {
    return null;
  }
  const previous = input.last ? input.last.digest : null;
  if (rows.length <= MAX_SECURITY_SEAL_ROWS) return { window: { from, to: input.cutoff }, previous, rows, chunked: false };
  const to = rows[MAX_SECURITY_SEAL_ROWS].received_at;
  const sealed = rows.filter((r) => r.received_at < to);
  if (sealed.length > 0) return { window: { from, to }, previous, rows: sealed, chunked: true };
  // More than a seal's rows at the window's first instant: one instant is never split, so that
  // instant is sealed alone, up to MAX_SECURITY_INSTANT_ROWS ([from, instant + 1 µs)).
  const instant = rows[0].received_at;
  const all = input.instantRows?.filter((r) => r.received_at === instant);
  if (!all || all.length > MAX_SECURITY_INSTANT_ROWS) {
    const err = new SecuritySealError('ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW', 'more rows share one instant than one seal holds');
    err.instant = instant;
    throw err;
  }
  return { window: { from, to: nextMicrosecond(instant) }, previous, rows: [...all], chunked: true };
}

// ---------------------------------------------------------------------------
// Break finders (pure)

/** One stored seal as the verifier reads it. */
export interface StoredSecuritySeal {
  windowFrom: string;
  windowTo: string;
  rowCount: number;
  task6aCount: number;
  v2Count: number;
  previousDigest: string | null;
  sealDocument: string;
  sealDigest: string;
  tenantId: string;
}

/** Parses and checks one stored seal document against its own columns (SS2–SS3). */
export function parseSecuritySealDocument(seal: StoredSecuritySeal): SecuritySealDocument | null {
  if (sha256Prefixed(seal.sealDocument) !== seal.sealDigest) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(seal.sealDocument);
  } catch {
    return null;
  }
  if (!securitySealValidators().document(doc)) return null;
  const d = doc as SecuritySealDocument;
  if (canonicalize(d) !== seal.sealDocument || d.tenant_id !== seal.tenantId || d.window.from !== seal.windowFrom
    || d.window.to !== seal.windowTo || d.count !== seal.rowCount || d.count !== d.rows.length
    || d.generations.task6a !== seal.task6aCount || d.generations.v2 !== seal.v2Count
    || d.generations.task6a + d.generations.v2 !== d.count
    || d.previous !== seal.previousDigest || digestsRoot(d.rows.map((r) => r.digest)) !== d.rows_root
    || new Set(d.rows.map((r) => r.id)).size !== d.rows.length) {
    return null;
  }
  return d;
}

/** SS3–SS4: the current table's rows of a seal's window against the sealed list and its invariants. */
export function checkSecuritySealRows(doc: SecuritySealDocument, sealDigest: string, current: readonly SecurityFindingRow[]): SealBreak[] {
  const out: SealBreak[] = [];
  const now = new Map(current.map((r) => [r.id, r]));
  const sealed = new Set<string>();
  for (const r of doc.rows) {
    sealed.add(r.id);
    const row = now.get(r.id);
    if (!row) out.push({ kind: 'missing_row', seal: sealDigest, row_id: r.id });
    else if (securityRowDigest(row) !== r.digest) out.push({ kind: 'changed_row', seal: sealDigest, row_id: r.id });
  }
  for (const row of current) {
    if (!sealed.has(row.id)) out.push({ kind: 'unsealed_row_in_sealed_window', seal: sealDigest, row_id: row.id });
  }
  if (!sealedInvariantsHold(doc, now)) out.push({ kind: 'statement_problem', seal: sealDigest });
  return out;
}

/**
 * SS3–SS4 recomputed from the current rows (Codex review): a signed seal that lists its rows out
 * of (received_at, id) order, miscounts the generations, or holds more than
 * MAX_SECURITY_SEAL_ROWS rows that do not all share one instant (with `to` = that instant + 1 µs)
 * was not built by the sealer, whatever its root says. Only intact rows (present, same digest)
 * are used: a missing or changed row is already its own break and its stored values are not
 * trusted here; the generation recount needs every sealed row intact.
 */
function sealedInvariantsHold(doc: SecuritySealDocument, now: ReadonlyMap<string, SecurityFindingRow>): boolean {
  const intact: SecurityFindingRow[] = [];
  for (const r of doc.rows) {
    const row = now.get(r.id);
    if (row && securityRowDigest(row) === r.digest) intact.push(row);
  }
  for (let i = 1; i < intact.length; i += 1) {
    if (compareSecurityRows(intact[i - 1], intact[i]) >= 0) return false;
  }
  if (intact.length === doc.rows.length) {
    const g = generationsOfSafe(intact);
    if (!g || g.task6a !== doc.generations.task6a || g.v2 !== doc.generations.v2) return false;
  }
  if (doc.count > MAX_SECURITY_SEAL_ROWS && intact.length > 0) {
    const instant = intact[0].received_at;
    if (intact.some((r) => r.received_at !== instant) || doc.window.to !== nextMicrosecond(instant)) return false;
  }
  return true;
}

function generationsOfSafe(rows: readonly SecurityFindingRow[]): Generations | null {
  try {
    return generationsOf(rows);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pass

export interface SecuritySealSnapshot { asOf: string; plan: SecuritySealPlan | null }

export interface ChainSecuritySealInput {
  tenantId: string;
  plan: SecuritySealPlan;
  document: SecuritySealDocument;
  documentText: string;
  documentDigest: string;
  statementCanonical: string;
  envelope: DsseEnvelope;
  credentialId: string;
  keyid: string;
  signatureDer: Buffer;
  publicKeySpkiDer: Buffer;
  actor: { type: 'service' | 'system_operator'; id: string };
  requestId: string;
}

export interface SecuritySealStore {
  /** Tenants with at least one finding row (operator pass, across tenants on purpose). */
  tenantsWithFindings(): Promise<string[]>;
  readSnapshot(tenantId: string, options: { now?: boolean; backlog?: boolean }): Promise<SecuritySealSnapshot>;
  /**
   * One ledger transaction: the last seal is still the plan's previous → chainStatement → the
   * seal row → `audit.trail.security_findings_sealed`. 'stale' when another pass sealed first.
   */
  chainSeal(input: ChainSecuritySealInput): Promise<{ sealId: string; seq: number } | 'stale'>;
}

export interface SecuritySealPassDeps {
  store: SecuritySealStore;
  resolver: SignerResolver;
  builderVersion: string;
  actor: { type: 'service' | 'system_operator'; id: string };
  log?: (line: string) => void;
}

export type SecuritySealOutcome = 'sealed' | 'would_seal' | 'not_due' | 'no_key' | 'stale' | 'failed';
export interface SecuritySealResult {
  tenantId: string;
  outcome: SecuritySealOutcome;
  count?: number;
  generations?: Generations;
  window?: SealWindow;
  /** The seal was cut by the row cap: the pass continues with the backlog. */
  chunked?: boolean;
  code?: string;
}

function codeOf(err: unknown): string {
  if (err instanceof SecuritySealError) return err.code;
  if (err instanceof AttestaLedgerError) return err.code;
  if (err instanceof SigningRejected) return 'ATTESTA_SIGNER_REJECTED';
  if (err instanceof SigningUnavailable) return 'ATTESTA_SIGNER_UNAVAILABLE';
  return 'ATTESTA_API_INTERNAL';
}

/** Seal one tenant if a seal is due. `dryRun` reads and plans only. */
export async function sealSecurityTenant(deps: SecuritySealPassDeps, tenantId: string,
  options: { dryRun?: boolean; now?: boolean; backlog?: boolean } = {}): Promise<SecuritySealResult> {
  try {
    const snap = await deps.store.readSnapshot(tenantId, { now: options.now, backlog: options.backlog });
    if (!snap.plan) return { tenantId, outcome: 'not_due' };
    const plan = snap.plan;
    const built = buildSecuritySealDocument({ tenantId, window: plan.window, previous: plan.previous, rows: plan.rows });
    const summary = { count: built.document.count, generations: built.document.generations, window: plan.window, chunked: plan.chunked };
    if (options.dryRun) return { tenantId, outcome: 'would_seal', ...summary };
    const statementCanonical = buildSecuritySealStatement({
      document: built.document, documentDigest: built.digest, asOf: snap.asOf, builderVersion: deps.builderVersion,
    });
    const signer = await deps.resolver.resolve(tenantId);
    if (!signer) return { tenantId, outcome: 'no_key' };
    const payload = Buffer.from(statementCanonical, 'utf8');
    const requestId = `attesta-security-seal:${tenantId}:${plan.window.from}`;
    const signedBytes = pae(IN_TOTO_PAYLOAD_TYPE, payload);
    // Statements stay within 1 MiB even where the signer allows more (ledger.ts).
    if (signedBytes.length > statementSigningLimit(signer.adapter.capabilities().maxPayloadBytes)) {
      throw new SecuritySealError('ATTESTA_BUILDER_TOO_LARGE', 'the seal statement does not fit the statement signing limit');
    }
    const signed = await signVerified(signer.adapter, signedBytes, { credentialId: signer.credentialId, tenantId, requestId });
    const keyid = sha256Prefixed(signed.publicKeySpkiDer);
    const chained = await deps.store.chainSeal({
      tenantId, plan, document: built.document, documentText: built.text, documentDigest: built.digest, statementCanonical,
      envelope: { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid, sig: signed.signature.toString('base64') }] },
      credentialId: signer.credentialId, keyid, signatureDer: signed.signature, publicKeySpkiDer: signed.publicKeySpkiDer,
      actor: deps.actor, requestId,
    });
    if (chained === 'stale') return { tenantId, outcome: 'stale' };
    return { tenantId, outcome: 'sealed', ...summary };
  } catch (err) {
    const code = codeOf(err);
    // An instant over the hard ceiling stops this tenant's sealing until an operator acts: an
    // alertable line naming the instant (a timestamp, never row content).
    const instant = err instanceof SecuritySealError && err.instant ? ` instant=${err.instant}` : '';
    (deps.log ?? ((line: string) => console.error(line)))(`attesta-security-seal ${code} tenant=${tenantId}${instant} cause=${err instanceof Error ? err.name : 'unknown'}`);
    return { tenantId, outcome: 'failed', code };
  }
}

/**
 * One sealing pass over every tenant with findings (the CLI). A tenant is sealed repeatedly
 * while a seal is due (a backlog), up to MAX_SECURITY_SEALS_PER_PASS; a dry run plans one window.
 */
export async function runSecuritySealPass(deps: SecuritySealPassDeps,
  options: { dryRun?: boolean; now?: boolean; tenantIds?: string[] } = {}): Promise<SecuritySealResult[]> {
  const tenants = options.tenantIds ?? await deps.store.tenantsWithFindings();
  const out: SecuritySealResult[] = [];
  for (const tenantId of tenants) {
    for (let i = 0; i < MAX_SECURITY_SEALS_PER_PASS; i += 1) {
      // `now` applies to the first seal only. The pass continues only after a seal the row cap
      // cut short: its leftover rows are due at once (the backlog), nothing else is.
      const r = await sealSecurityTenant(deps, tenantId, { dryRun: options.dryRun, now: options.now && i === 0, backlog: i > 0 });
      if (r.outcome !== 'not_due' || i === 0) out.push(r);
      if (r.outcome !== 'sealed' || !r.chunked) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const usText = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
export const RECEIVED_AT_US = usText('received_at');

/** Rows of the tenant with from ≤ received_at < to, in (received_at, id) order, as the projection. */
export async function readSecurityRows(tx: SealDbExecutor, tenantId: string, from: string, to: string, limit: number,
  ids?: readonly string[]): Promise<SecurityFindingRow[]> {
  const r = await tx.execute(sql`/* security-seal:rows */
    select id::text as id, record_generation, machine_id::text as machine_id, repository_id::text as repository_id, repository_kind,
           rule_id, rule_version, rule_category, rule_severity, effect, agent_family, source_agent, source_type, model, model_provider,
           session_id, parent_session_id, sub_agent_id, record_id, finding_id, delivery_id, source_event_id, correlation_id,
           ${usText('occurred_at')} as occurred_at, ${RECEIVED_AT_US} as received_at, ${usText('detected_at')} as detected_at,
           rule_pack_version, bundle_digest, lease_id, numbat_schema_version, confidence, found_at_rest, route_id, host_surface,
           host_mode, capture_channel, native_effect, activation, phase, timing, availability, completeness, result_category,
           operating_system, client_version
    from security_findings
    where tenant_id = ${tenantId}::uuid and received_at >= ${from}::timestamptz and received_at < ${to}::timestamptz
      ${ids ? sql`and id = any(${`{${ids.join(',')}}`}::uuid[])` : sql``}
    order by received_at, id limit ${limit}`);
  return r.rows.map(rowFromDb);
}

export function rowFromDb(x: Record<string, unknown>): SecurityFindingRow {
  const out: Record<string, unknown> = {};
  for (const key of SECURITY_ROW_KEYS) {
    const v = x[key];
    out[key] = key === 'found_at_rest' ? (typeof v === 'boolean' ? v : null) : REQUIRED_TEXT.has(key) ? str(v) : strOrNull(v);
  }
  return out as unknown as SecurityFindingRow;
}

const REQUIRED_TEXT = new Set<string>(['id', 'record_generation', 'machine_id', 'rule_id', 'rule_version', 'rule_category',
  'rule_severity', 'occurred_at', 'received_at', 'rule_pack_version']);

export function pgSecuritySealStore(db: SealDatabase = coreDb as unknown as SealDatabase): SecuritySealStore {
  return {
    async tenantsWithFindings() {
      const r = await db.execute(sql`/* security-seal:tenants */
        select t.id::text as id from sso_tenants t
        where exists (select 1 from security_findings f where f.tenant_id = t.id) order by t.id`);
      return r.rows.map((x) => str(x.id));
    },

    async readSnapshot(tenantId, options) {
      return db.transaction(async (tx) => {
        const clock = (await tx.execute(sql`/* security-seal:clock */
          select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as as_of,
                 to_char((now() - (${SECURITY_SEAL_SETTLE_MS}::int * interval '1 millisecond')) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cutoff`)).rows[0] ?? {};
        const last = (await tx.execute(sql`/* security-seal:last */
          select window_to, seal_digest, (extract(epoch from (now() - created_at)) * 1000)::bigint::text as age_ms
          from attesta_security_finding_seals where tenant_id = ${tenantId}::uuid order by window_to desc limit 1`)).rows[0];
        const earliest = last ? null : str((await tx.execute(sql`/* security-seal:earliest */
          select ${RECEIVED_AT_US} as received_at from security_findings
          where tenant_id = ${tenantId}::uuid order by received_at, id limit 1`)).rows[0]?.received_at) || null;
        const cutoff = str(clock.cutoff);
        const from = last ? str(last.window_to) : earliest;
        const rows = from !== null && from < cutoff ? await readSecurityRows(tx, tenantId, from, cutoff, MAX_SECURITY_SEAL_ROWS + 1) : [];
        const input = {
          cutoff,
          last: last ? { windowTo: str(last.window_to), digest: str(last.seal_digest), ageMs: Number(last.age_ms) } : null,
          earliest,
          rows,
          now: options.now,
          backlog: options.backlog,
        };
        let plan: SecuritySealPlan | null;
        try {
          plan = planSecuritySealWindow(input);
        } catch (err) {
          if (!(err instanceof SecuritySealError) || !err.instant) throw err;
          // The window's first instant holds more than a seal's rows: read that instant alone.
          const instantRows = await readSecurityRows(tx, tenantId, err.instant, nextMicrosecond(err.instant), MAX_SECURITY_INSTANT_ROWS + 1);
          plan = planSecuritySealWindow({ ...input, instantRows });
        }
        return { asOf: str(clock.as_of), plan };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async chainSeal(input) {
      try {
        return await db.transaction(async (tx) => {
          // The insert guard's per-tenant lock, taken first so the re-check below holds until commit.
          await tx.execute(sql`/* security-seal:lock */
            select pg_advisory_xact_lock(hashtextextended(${'attesta_security_finding_seals:' + input.tenantId}, 0))`);
          const last = (await tx.execute(sql`/* security-seal:recheck */
            select window_to, seal_digest from attesta_security_finding_seals where tenant_id = ${input.tenantId}::uuid
            order by window_to desc limit 1`)).rows[0];
          const lastDigest = last ? str(last.seal_digest) : null;
          if (lastDigest !== input.plan.previous || (last && str(last.window_to) !== input.plan.window.from)) return 'stale' as const;
          const chained = await chainStatement(tx as LedgerExecutor, {
            tenantId: input.tenantId, statementCanonical: input.statementCanonical, envelope: input.envelope,
            credentialId: input.credentialId, keyid: input.keyid, signatureDer: input.signatureDer,
            publicKeySpkiDer: input.publicKeySpkiDer, previousSeen: [],
          });
          if (chained.duplicate) throw internal('a fresh seal statement was already chained');
          const g = input.document.generations;
          const inserted = await tx.execute(sql`/* security-seal:insert */
            insert into attesta_security_finding_seals (tenant_id, window_from, window_to, row_count, task6a_count, v2_count,
              previous_digest, seal_document, seal_digest, record_id, statement_digest)
            values (${input.tenantId}::uuid, ${input.plan.window.from}, ${input.plan.window.to}, ${input.document.count},
              ${g.task6a}, ${g.v2}, ${input.plan.previous}, ${input.documentText}, ${input.documentDigest},
              ${chained.recordId}::uuid, ${chained.statementDigest})
            returning id::text as id`);
          const sealId = str(inserted.rows[0]?.id);
          if (!sealId) throw internal('the seal insert returned no id');
          await recordAuditEvent(tx, input.tenantId, {
            action: 'audit.trail.security_findings_sealed',
            actorType: input.actor.type,
            actorId: input.actor.id,
            targetType: 'attesta_security_finding_seal',
            targetId: sealId,
            details: {
              window_from: input.plan.window.from,
              window_to: input.plan.window.to,
              count: input.document.count,
              task6a_count: g.task6a,
              v2_count: g.v2,
              seal_digest: input.documentDigest,
              request_id: input.requestId,
            },
          });
          return { sealId, seq: chained.seq };
        });
      } catch (err) {
        throw mapLedgerDatabaseError(err) ?? err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The verify report (GET /api/attesta/security-seals/verify?from&to)

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const MAX_SECURITY_VERIFY_DAYS = 31;
export const MAX_SECURITY_VERIFY_SEALS = 1000;
export const MAX_SECURITY_REPORT_BREAKS = 1000;
/** Rows one report loads (sealed rows plus late inserts); a wider window is refused. */
export const MAX_SECURITY_VERIFY_ROWS = 500_000;

export interface SecurityVerifyQuery { from: string; to: string }

/** `from` and `to` are required RFC 3339 instants, from < to, at most 31 days apart. */
export function parseSecurityVerifyQuery(query: Record<string, unknown>): SecurityVerifyQuery {
  for (const name of Object.keys(query)) {
    if (name !== 'from' && name !== 'to') throw new AttestaQueryError(`unknown parameter ${name}`);
  }
  const one = (name: string): string => {
    const v = query[name];
    if (typeof v !== 'string' || !RFC3339_RE.test(v) || !Number.isFinite(Date.parse(v))) throw new AttestaQueryError(`${name} is invalid`);
    return v;
  };
  const from = one('from');
  const to = one('to');
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > MAX_SECURITY_VERIFY_DAYS * 86_400_000) throw new AttestaQueryError('from/to span is invalid');
  return { from, to };
}

export interface SecurityVerifyReport {
  ok: boolean;
  from: string;
  to: string;
  seals_checked: number;
  breaks: SealBreak[];
  breaks_truncated: boolean;
  unsealed_tail: { from: string | null; count: number };
  chain: { ok: boolean; checked: number };
}

export interface SecurityVerifySeal extends StoredSecuritySeal {
  seq: number | null;
  statementCanonical: string | null;
  recordStatementDigest: string | null;
  statementDigest: string;
}

export interface SecurityVerifySnapshot {
  seals: SecurityVerifySeal[];
  /** The seal before the first listed one: null when the first is the tenant's first, undefined when missing. */
  predecessor: { windowTo: string; sealDigest: string } | null | undefined;
  /** Every row of the tenant now in each listed seal's window, by seal digest. */
  rowsBySeal: Map<string, SecurityFindingRow[]>;
  tail: { from: string | null; count: number };
  /** Seal digests named by seal ledger records in the window that have no seal row (a removed seal). */
  orphans: string[];
  /** Rows received before the tenant's first seal (in no window), with that seal's digest. */
  beforeFirst: { seal: string; rowIds: string[] } | null;
  /** A window held more rows than one report reads: late inserts beyond the bound are not all listed. */
  rowsTruncated?: boolean;
}

/** The sealed row ids of a stored document (an unparsable one has none: it is a statement problem). */
function sealedIdsOf(sealDocument: string): string[] {
  try {
    const d = JSON.parse(sealDocument) as { rows?: Array<{ id?: unknown }> };
    return (d.rows ?? []).map((r) => r.id).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));
  } catch {
    return [];
  }
}

/** The pure part: seals, rows and links → breaks. `chain.problems` are seal digests whose record check failed. */
export function assembleSecurityVerifyReport(q: SecurityVerifyQuery, snap: SecurityVerifySnapshot,
  chain: { ok: boolean; checked: number; problems: Set<string> }): SecurityVerifyReport {
  const breaks: SealBreak[] = [];
  for (const seal of snap.seals) {
    const doc = parseSecuritySealDocument(seal);
    let statementOk = doc !== null && seal.statementCanonical !== null && seal.recordStatementDigest === seal.statementDigest;
    if (statementOk && doc) {
      try {
        const columns = deriveStatementColumns(seal.statementCanonical as string);
        const parsed = JSON.parse(seal.statementCanonical as string) as { subject: Array<{ digest: { sha256: string } }>; predicate: Record<string, unknown> };
        const p = parsed.predicate;
        statementOk = columns.predicateType === SECURITY_FINDINGS_SEAL_PREDICATE_TYPE && columns.tenantScope === seal.tenantId
          && parsed.subject[0].digest.sha256 === seal.sealDigest.slice('sha256:'.length)
          && canonicalize(p.window) === canonicalize(doc.window) && p.count === doc.count
          && canonicalize(p.generations) === canonicalize(doc.generations)
          && p.rows_root === doc.rows_root && p.previous_seal === doc.previous;
      } catch {
        statementOk = false;
      }
    }
    if (!statementOk || chain.problems.has(seal.sealDigest)) breaks.push({ kind: 'statement_problem', seal: seal.sealDigest });
    if (doc) breaks.push(...checkSecuritySealRows(doc, seal.sealDigest, snap.rowsBySeal.get(seal.sealDigest) ?? []));
  }
  breaks.push(...checkSealLinks(snap.seals, snap.predecessor));
  for (const digest of snap.orphans) breaks.push({ kind: 'broken_previous', seal: digest });
  for (const rowId of snap.beforeFirst?.rowIds ?? []) {
    breaks.push({ kind: 'unsealed_row_in_sealed_window', seal: snap.beforeFirst?.seal ?? null, row_id: rowId });
  }
  return {
    ok: breaks.length === 0 && chain.ok,
    from: q.from,
    to: q.to,
    seals_checked: snap.seals.length,
    breaks: breaks.slice(0, MAX_SECURITY_REPORT_BREAKS),
    breaks_truncated: breaks.length > MAX_SECURITY_REPORT_BREAKS || snap.rowsTruncated === true,
    unsealed_tail: snap.tail,
    chain: { ok: chain.ok, checked: chain.checked },
  };
}

/** The snapshot read: one repeatable-read, read-only transaction, every query tenant-bound. */
export async function readSecurityVerifySnapshot(database: SealDatabase, tenantId: string, q: SecurityVerifyQuery): Promise<SecurityVerifySnapshot> {
  return database.transaction(async (tx) => {
    const sealRows = (await tx.execute(sql`/* security-verify:seals */
      select s.window_from, s.window_to, s.row_count, s.task6a_count, s.v2_count, s.previous_digest, s.seal_document,
             s.seal_digest, s.statement_digest, s.record_id::text as record_id
      from attesta_security_finding_seals s
      where s.tenant_id = ${tenantId}::uuid
        and s.window_from::timestamptz < ${q.to}::timestamptz and s.window_to::timestamptz > ${q.from}::timestamptz
      order by s.window_from limit ${MAX_SECURITY_VERIFY_SEALS + 1}`)).rows;
    if (sealRows.length > MAX_SECURITY_VERIFY_SEALS) throw new AttestaQueryError('too many seals for one report');
    if (sealRows.reduce((n, r) => n + Number(r.row_count), 0) > MAX_SECURITY_VERIFY_ROWS / 2) {
      throw new AttestaQueryError('too many sealed rows for one report; narrow from/to');
    }
    const windows = sealRows.map((r) => ({
      tenantId, windowFrom: str(r.window_from), windowTo: str(r.window_to), rowCount: Number(r.row_count),
      task6aCount: Number(r.task6a_count), v2Count: Number(r.v2_count),
      previousDigest: strOrNull(r.previous_digest), sealDocument: str(r.seal_document), sealDigest: str(r.seal_digest),
      statementDigest: str(r.statement_digest), recordId: str(r.record_id),
    }));
    let predecessor: SecurityVerifySnapshot['predecessor'] = null;
    const first = windows[0];
    if (first && first.previousDigest !== null) {
      const p = (await tx.execute(sql`/* security-verify:predecessor */
        select window_to, seal_digest from attesta_security_finding_seals
        where tenant_id = ${tenantId}::uuid and seal_digest = ${first.previousDigest}`)).rows[0];
      predecessor = p ? { windowTo: str(p.window_to), sealDigest: str(p.seal_digest) } : undefined;
    }
    const rowsBySeal = new Map<string, SecurityFindingRow[]>();
    let loaded = 0;
    let rowsTruncated = false;
    for (const s of windows) {
      // The window's rows up to a bound (late inserts beyond it are reported as far as they fit,
      // and the report says it was cut), plus every sealed id looked up directly, so a flood of
      // late rows never makes a sealed row look missing.
      const limit = Math.max(2 * MAX_SECURITY_SEAL_ROWS, s.rowCount + MAX_SECURITY_SEAL_ROWS);
      const rows = await readSecurityRows(tx, tenantId, s.windowFrom, s.windowTo, limit);
      if (rows.length === limit) {
        rowsTruncated = true;
        const seen = new Set(rows.map((r) => r.id));
        const missingIds = sealedIdsOf(s.sealDocument).filter((rowId) => !seen.has(rowId));
        for (let i = 0; i < missingIds.length; i += 5000) {
          rows.push(...await readSecurityRows(tx, tenantId, s.windowFrom, s.windowTo, 5000, missingIds.slice(i, i + 5000)));
        }
        rows.sort(compareSecurityRows);
      }
      rowsBySeal.set(s.sealDigest, rows);
      loaded += rows.length;
      if (loaded > MAX_SECURITY_VERIFY_ROWS) throw new AttestaQueryError('too many rows for one report; narrow from/to');
    }
    const firstSeal = (await tx.execute(sql`/* security-verify:first */
      select window_from, seal_digest from attesta_security_finding_seals
      where tenant_id = ${tenantId}::uuid and previous_digest is null`)).rows[0];
    let beforeFirst: SecurityVerifySnapshot['beforeFirst'] = null;
    if (firstSeal) {
      const early = (await tx.execute(sql`/* security-verify:before_first */
        select id::text as id from security_findings
        where tenant_id = ${tenantId}::uuid and received_at < ${str(firstSeal.window_from)}::timestamptz
        order by received_at, id limit ${MAX_SECURITY_REPORT_BREAKS}`)).rows;
      if (early.length > 0) beforeFirst = { seal: str(firstSeal.seal_digest), rowIds: early.map((r) => str(r.id)) };
    }
    const last = (await tx.execute(sql`/* security-verify:last */
      select window_to from attesta_security_finding_seals where tenant_id = ${tenantId}::uuid
      order by window_to desc limit 1`)).rows[0];
    const tailFrom = last ? str(last.window_to) : null;
    const tail = (await tx.execute(tailFrom === null
      ? sql`/* security-verify:tail */ select count(*)::int as n, min(${RECEIVED_AT_US}) as first from security_findings
          where tenant_id = ${tenantId}::uuid`
      : sql`/* security-verify:tail */ select count(*)::int as n, ${tailFrom}::text as first from security_findings
          where tenant_id = ${tenantId}::uuid and received_at >= ${tailFrom}::timestamptz`)).rows[0] ?? {};

    const recordIds = windows.map((s) => s.recordId);
    const recordRows = recordIds.length === 0 ? [] : (await tx.execute(sql`/* security-verify:records */
      select id::text as id, seq::text as seq, statement_canonical, statement_digest
      from attesta_records where tenant_id = ${tenantId}::uuid
        and id in (${sql.join(recordIds.map((id) => sql`${id}::uuid`), sql.raw(', '))})`)).rows;
    const records = new Map(recordRows.map((r) => [str(r.id), r]));
    const seals: SecurityVerifySeal[] = windows.map((s) => {
      const r = records.get(s.recordId);
      return { ...s, seq: typeof r?.seq === 'string' ? Number(r.seq) : null,
        statementCanonical: strOrNull(r?.statement_canonical), recordStatementDigest: strOrNull(r?.statement_digest) };
    });

    // A seal row removed behind the guards leaves its chained statement.
    const orphanRows = (await tx.execute(sql`/* security-verify:orphans */
      select r.statement_canonical from attesta_records r
      where r.tenant_id = ${tenantId}::uuid and r.predicate_type = ${SECURITY_FINDINGS_SEAL_PREDICATE_TYPE}
        and ((r.statement_canonical::jsonb)->'predicate'->'window'->>'from')::timestamptz < ${q.to}::timestamptz
        and ((r.statement_canonical::jsonb)->'predicate'->'window'->>'to')::timestamptz > ${q.from}::timestamptz
        and not exists (select 1 from attesta_security_finding_seals s
          where s.tenant_id = r.tenant_id and s.seal_digest = 'sha256:' || ((r.statement_canonical::jsonb)->'subject'->0->'digest'->>'sha256'))
      order by r.seq limit ${MAX_SECURITY_REPORT_BREAKS}`)).rows;
    const orphans = orphanRows.map((r) => {
      try {
        const st = JSON.parse(str(r.statement_canonical)) as { subject: Array<{ digest: { sha256: string } }> };
        return `sha256:${st.subject[0].digest.sha256}`;
      } catch {
        return null;
      }
    }).filter((d): d is string => d !== null);
    return { seals, predecessor, rowsBySeal, tail: { from: strOrNull(tail.first), count: Number(tail.n ?? 0) }, orphans, beforeFirst, rowsTruncated };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export interface SecurityVerifyDeps {
  database: SealDatabase;
  /** The /api/attesta/verify dependencies (store, verifier, keys, anchors, clock). */
  attesta: VerifyDeps;
}

export interface SecurityVerifyInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  requestId: string;
  query: SecurityVerifyQuery;
}

/** The report, then one `audit.trail.security_findings_verified` event. */
export async function verifySecuritySeals(deps: SecurityVerifyDeps, input: SecurityVerifyInput): Promise<SecurityVerifyReport> {
  const snap = await readSecurityVerifySnapshot(deps.database, input.tenantId, input.query);
  // Each seal record checked on its own seq; the Attesta check writes no attesta.verify row
  // here (audit.trail.security_findings_verified covers the call).
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
  const report = assembleSecurityVerifyReport(input.query, snap, { ok: chainOk, checked, problems });
  await recordAuditEvent(deps.database, input.tenantId, {
    action: 'audit.trail.security_findings_verified',
    actorType: input.actorRole,
    actorId: input.actorId,
    targetType: 'security_findings',
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
