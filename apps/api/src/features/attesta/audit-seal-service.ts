/**
 * Audit seals (Task16e, A16.4; docs/contracts/attesta/audit-seal.md).
 *
 *   auditRowDigest / buildSealDocument / buildSealStatement   pure, deterministic
 *   planSealWindow                                            the cadence, pure
 *   checkSealRows / checkSealLinks                            the verify report's break finders, pure
 *   runAuditSealPass                                          per tenant: one repeatable-read snapshot →
 *                                                             sign (no transaction) → ONE ledger transaction
 *                                                             (re-check the last seal, chain, store, audit)
 *   pgSealStore                                               the tenant-bound PostgreSQL store
 *
 * Ported from SushiCorp @ 0bd67a5 (catalog RP-1) as Task15i4 translated it: a small signed
 * statement names the digest of a stored document; the document is rebuilt byte for byte
 * from the same rows. EV-1 (the chain) is reused through Attesta's chainStatement, not
 * re-ported. Deviation from the prompt: no job/lease columns on the seal table (a seal is
 * written once, in its ledger transaction; nothing is queued).
 *
 * Every query binds tenant_id, except listing the tenants to seal (an operator pass).
 * No network call inside a transaction (AGENTS.md §9 item 18). occurred_at is always the
 * exact microsecond text, never a JS Date.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { sql, type SQL } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { AUDIT_CATALOG_VERSION } from '../../core/audit/catalog';
import { recordAuditEvent } from '../../core/audit/record';
import { canonicalize, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import {
  AUDIT_SEAL_PREDICATE_TYPE, AttestaLedgerError, IN_TOTO_STATEMENT_TYPE, chainStatement, mapLedgerDatabaseError,
  statementSigningLimit,
  type LedgerExecutor,
} from './ledger';
import { digestsRoot } from './period-report-rules';
import { SigningRejected, SigningUnavailable, signVerified } from './signer-contract';
import type { SignerResolver } from './signer-resolver';

export const AUDIT_SEAL_DOCUMENT_FORMAT = 'https://trackai.dev/attesta/audit-seal-document/v1';
export const AUDIT_SEALER_NAME = 'trackai-audit-sealer';
/** Rows per seal; a larger backlog is sealed in back-to-back seals. */
export const MAX_SEAL_ROWS = 50_000;
/** `to` ≤ database clock − 5 minutes (evidence-pack.md settle margin). */
export const SEAL_SETTLE_MS = 300_000;
/** Seal rows when the last seal is at least this old… */
export const SEAL_MIN_INTERVAL_MS = 3_600_000;
/** …and seal even an empty window when the last seal is at least this old. */
export const SEAL_EMPTY_INTERVAL_MS = 86_400_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const US_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class AuditSealError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AuditSealError';
  }
}
const internal = (why: string) => new AuditSealError('ATTESTA_API_INTERNAL', `audit seal: ${why}`);

// ---------------------------------------------------------------------------
// Pure building blocks

/** One stored audit row as event-v1 returns it, without the derived severity and catalog_version. */
export interface StoredAuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  details: unknown;
  /** The exact microsecond text. */
  occurred_at: string;
}

export interface SealWindow { from: string; to: string }

export interface SealDocument {
  format: typeof AUDIT_SEAL_DOCUMENT_FORMAT;
  tenant_id: string;
  window: SealWindow;
  previous: string | null;
  catalog_version: number;
  count: number;
  rows: Array<{ id: string; digest: string }>;
  rows_root: string;
}

/** Only the event-v1 keys, so a stray column never changes a digest. */
export function eventOf(row: StoredAuditRow): StoredAuditRow {
  return {
    id: row.id, action: row.action, actor_type: row.actor_type, actor_id: row.actor_id,
    target_type: row.target_type, target_id: row.target_id, details: row.details, occurred_at: row.occurred_at,
  };
}

/** `"sha256:" + hex(SHA-256(JCS(row)))` (audit-seal.md "Row digest"). */
export function auditRowDigest(row: StoredAuditRow): string {
  if (!US_RE.test(row.occurred_at)) throw internal('occurred_at is not the exact microsecond text');
  return sha256Prefixed(canonicalize(eventOf(row)));
}

/** (occurred_at, id) ascending: the fixed-width text orders like the instant. */
export function compareRows(a: { occurred_at: string; id: string }, b: { occurred_at: string; id: string }): number {
  if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildSealDocumentInput {
  tenantId: string;
  window: SealWindow;
  previous: string | null;
  rows: readonly StoredAuditRow[];
  catalogVersion?: number;
}

/** The seal document and its exact bytes. Refuses rows outside the window or out of order. */
export function buildSealDocument(input: BuildSealDocumentInput): { document: SealDocument; text: string; digest: string } {
  const { window } = input;
  if (!UUID_RE.test(input.tenantId)) throw internal('tenant id is not a lowercase UUID');
  if (!US_RE.test(window.from) || !US_RE.test(window.to) || window.from >= window.to) throw internal('the window is malformed');
  if (input.previous !== null && !DIGEST_RE.test(input.previous)) throw internal('previous is malformed');
  if (input.rows.length > MAX_SEAL_ROWS) throw internal('too many rows for one seal');
  const rows = input.rows.map((row, i) => {
    if (row.occurred_at < window.from || row.occurred_at >= window.to) throw internal('a row lies outside the window');
    if (i > 0 && compareRows(input.rows[i - 1], row) >= 0) throw internal('rows are not in (occurred_at, id) order');
    return { id: row.id, digest: auditRowDigest(row) };
  });
  const document: SealDocument = {
    format: AUDIT_SEAL_DOCUMENT_FORMAT,
    tenant_id: input.tenantId,
    window: { from: window.from, to: window.to },
    previous: input.previous,
    catalog_version: input.catalogVersion ?? AUDIT_CATALOG_VERSION,
    count: rows.length,
    rows,
    rows_root: digestsRoot(rows.map((r) => r.digest)),
  };
  const text = canonicalize(document);
  return { document, text, digest: sha256Prefixed(text) };
}

export const sealSubjectName = (tenantId: string, window: SealWindow): string =>
  `trackai:tenant/${tenantId}/audit/${window.from}..${window.to}`;

let validators: { statement: ValidateFunction; document: ValidateFunction } | null = null;
function contractDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'predicate-audit-seal-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw internal('the audit-seal schemas are not found');
}
/** The statement (#/definitions/statement) and document validators. */
export function sealValidators(): { statement: ValidateFunction; document: ValidateFunction } {
  if (validators) return validators;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  const predicate = load('predicate-audit-seal-v1.schema.json');
  ajv.addSchema(predicate);
  validators = {
    statement: ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` }),
    document: ajv.compile(load('audit-seal-document-v1.schema.json')),
  };
  return validators;
}

/** The audit_seal statement over a built document (rules AS1–AS2 hold by construction; schemas checked). */
export function buildSealStatement(input: { document: SealDocument; documentDigest: string; asOf: string; builderVersion: string }): string {
  const d = input.document;
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: sealSubjectName(d.tenant_id, d.window), digest: { sha256: input.documentDigest.slice('sha256:'.length) } }],
    predicateType: AUDIT_SEAL_PREDICATE_TYPE,
    predicate: {
      tenant_id: d.tenant_id,
      window: d.window,
      count: d.count,
      rows_root: d.rows_root,
      catalog_version: d.catalog_version,
      previous_seal: d.previous,
      builder: { name: AUDIT_SEALER_NAME, version: input.builderVersion },
      as_of: input.asOf,
      previous: [] as unknown[],
    },
  };
  const text = canonicalize(statement);
  const v = sealValidators();
  if (!v.document(JSON.parse(canonicalize(d)))) throw new AuditSealError('ATTESTA_BUILDER_SCHEMA_INVALID', 'schema refused the seal document');
  if (!v.statement(JSON.parse(text))) throw new AuditSealError('ATTESTA_BUILDER_SCHEMA_INVALID', 'schema refused the seal statement');
  return text;
}

/** What the planner needs from one snapshot. */
export interface SealPlanInput {
  /** Database clock − 5 min, exact microsecond text. */
  cutoff: string;
  last: { windowTo: string; digest: string; ageMs: number } | null;
  /** The tenant's earliest row (first seal only). */
  earliest: string | null;
  /** Rows from the window start, (occurred_at, id) ascending, at most MAX_SEAL_ROWS + 1. */
  rows: readonly StoredAuditRow[];
}

export interface SealPlan { window: SealWindow; previous: string | null; rows: StoredAuditRow[] }

/**
 * The cadence (audit-seal.md "Windows and cadence"): a first seal from the earliest row;
 * later seals when there are rows and the last seal is ≥ 1 h old, or when it is ≥ 24 h old
 * (an empty window). More than MAX_SEAL_ROWS rows: `to` is the first row that does not fit,
 * so rows sharing one instant are never split. null when nothing is due.
 */
export function planSealWindow(input: SealPlanInput): SealPlan | null {
  const from = input.last ? input.last.windowTo : input.earliest;
  if (from === null || from >= input.cutoff) return null;
  const rows = input.rows.filter((r) => r.occurred_at >= from && r.occurred_at < input.cutoff);
  if (input.last) {
    // A backlog beyond one seal is always due (review finding): the hour rule is for a quiet trail.
    const due = rows.length > MAX_SEAL_ROWS
      || (rows.length > 0 && input.last.ageMs >= SEAL_MIN_INTERVAL_MS) || input.last.ageMs >= SEAL_EMPTY_INTERVAL_MS;
    if (!due) return null;
  } else if (rows.length === 0) {
    return null;
  }
  let to = input.cutoff;
  let sealed = rows;
  if (rows.length > MAX_SEAL_ROWS) {
    to = rows[MAX_SEAL_ROWS].occurred_at;
    sealed = rows.filter((r) => r.occurred_at < to);
    if (to <= from || sealed.length === 0) throw new AuditSealError('ATTESTA_API_INVALID_QUERY', 'more rows share one instant than one seal holds');
  }
  return { window: { from, to }, previous: input.last ? input.last.digest : null, rows: sealed.slice(0, MAX_SEAL_ROWS) };
}

// ---------------------------------------------------------------------------
// Break finders for the verify report (pure)

export type SealBreakKind = 'missing_row' | 'changed_row' | 'unsealed_row_in_sealed_window' | 'broken_previous' | 'statement_problem';
export interface SealBreak { kind: SealBreakKind; seal: string | null; row_id?: string }

/** One stored seal as the verifier reads it. */
export interface StoredSeal {
  windowFrom: string;
  windowTo: string;
  rowCount: number;
  previousDigest: string | null;
  sealDocument: string;
  sealDigest: string;
  tenantId: string;
}

/** Parses and checks one stored seal document (AS2–AS3 against its own columns). */
export function parseSealDocument(seal: StoredSeal): SealDocument | null {
  if (sha256Prefixed(seal.sealDocument) !== seal.sealDigest) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(seal.sealDocument);
  } catch {
    return null;
  }
  if (!sealValidators().document(doc)) return null;
  const d = doc as SealDocument;
  if (canonicalize(d) !== seal.sealDocument || d.tenant_id !== seal.tenantId || d.window.from !== seal.windowFrom
    || d.window.to !== seal.windowTo || d.count !== seal.rowCount || d.count !== d.rows.length
    || d.previous !== seal.previousDigest || digestsRoot(d.rows.map((r) => r.digest)) !== d.rows_root
    || new Set(d.rows.map((r) => r.id)).size !== d.rows.length) {
    return null;
  }
  return d;
}

/**
 * AS4: the current table's rows of a seal's window against the sealed list. `current` is
 * every row of the tenant in the window now.
 */
export function checkSealRows(doc: SealDocument, sealDigest: string, current: readonly StoredAuditRow[]): SealBreak[] {
  const out: SealBreak[] = [];
  const now = new Map(current.map((r) => [r.id, r]));
  const sealed = new Set<string>();
  for (const r of doc.rows) {
    sealed.add(r.id);
    const row = now.get(r.id);
    if (!row) out.push({ kind: 'missing_row', seal: sealDigest, row_id: r.id });
    else if (auditRowDigest(row) !== r.digest) out.push({ kind: 'changed_row', seal: sealDigest, row_id: r.id });
  }
  for (const row of current) {
    if (!sealed.has(row.id)) out.push({ kind: 'unsealed_row_in_sealed_window', seal: sealDigest, row_id: row.id });
  }
  return out;
}

/**
 * AS5: seals in window order, each `previous` the prior seal's digest and its `from` the prior
 * `to`. `predecessor` is the seal before the first one listed (null when the first listed seal
 * should be the tenant's first, undefined when it could not be found).
 */
export function checkSealLinks(
  seals: ReadonlyArray<{ windowFrom: string; windowTo: string; previousDigest: string | null; sealDigest: string }>,
  predecessor: { windowTo: string; sealDigest: string } | null | undefined,
): SealBreak[] {
  const out: SealBreak[] = [];
  let prior = predecessor;
  for (const s of seals) {
    const ok = prior === undefined ? false
      : prior === null ? s.previousDigest === null
        : s.previousDigest === prior.sealDigest && s.windowFrom === prior.windowTo;
    if (!ok) out.push({ kind: 'broken_previous', seal: s.sealDigest });
    prior = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass

export interface SealSnapshot {
  /** Database clock, ms ISO. */
  asOf: string;
  plan: SealPlan | null;
}

export interface ChainSealInput {
  tenantId: string;
  plan: SealPlan;
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

export interface SealStore {
  /** Tenants with at least one audit row (operator pass, across tenants on purpose). */
  tenantsWithAuditRows(): Promise<string[]>;
  readSnapshot(tenantId: string): Promise<SealSnapshot>;
  /**
   * One ledger transaction: the last seal is still the plan's previous → chainStatement →
   * the seal row → `audit.trail.sealed`. 'stale' when another pass sealed first (nothing written).
   */
  chainSeal(input: ChainSealInput): Promise<{ sealId: string; seq: number } | 'stale'>;
}

export interface SealPassDeps {
  store: SealStore;
  resolver: SignerResolver;
  builderVersion: string;
  actor: { type: 'service' | 'system_operator'; id: string };
  log?: (line: string) => void;
}

export type SealOutcome = 'sealed' | 'would_seal' | 'not_due' | 'no_key' | 'stale' | 'failed';
export interface SealResult { tenantId: string; outcome: SealOutcome; count?: number; window?: SealWindow; code?: string }

function codeOf(err: unknown): string {
  if (err instanceof AuditSealError) return err.code;
  if (err instanceof AttestaLedgerError) return err.code;
  if (err instanceof SigningRejected) return 'ATTESTA_SIGNER_REJECTED';
  if (err instanceof SigningUnavailable) return 'ATTESTA_SIGNER_UNAVAILABLE';
  return 'ATTESTA_API_INTERNAL';
}

/** Seal one tenant if a seal is due. `dryRun` reads and plans only. */
export async function sealTenant(deps: SealPassDeps, tenantId: string, options: { dryRun?: boolean } = {}): Promise<SealResult> {
  try {
    const snap = await deps.store.readSnapshot(tenantId);
    if (!snap.plan) return { tenantId, outcome: 'not_due' };
    const plan = snap.plan;
    const built = buildSealDocument({ tenantId, window: plan.window, previous: plan.previous, rows: plan.rows });
    if (options.dryRun) return { tenantId, outcome: 'would_seal', count: built.document.count, window: plan.window };
    const statementCanonical = buildSealStatement({
      document: built.document, documentDigest: built.digest, asOf: snap.asOf, builderVersion: deps.builderVersion,
    });
    const signer = await deps.resolver.resolve(tenantId);
    if (!signer) return { tenantId, outcome: 'no_key' };
    const payload = Buffer.from(statementCanonical, 'utf8');
    const requestId = `attesta-audit-seal:${tenantId}:${plan.window.from}`;
    const signedBytes = pae(IN_TOTO_PAYLOAD_TYPE, payload);
    // Statements stay within 1 MiB even where the signer allows more (ledger.ts).
    if (signedBytes.length > statementSigningLimit(signer.adapter.capabilities().maxPayloadBytes)) {
      throw new AuditSealError('ATTESTA_BUILDER_RULE_VIOLATION', 'the seal statement does not fit the statement signing limit');
    }
    const signed = await signVerified(signer.adapter, signedBytes, {
      credentialId: signer.credentialId, tenantId, requestId,
    });
    const keyid = sha256Prefixed(signed.publicKeySpkiDer);
    const chained = await deps.store.chainSeal({
      tenantId, plan, documentText: built.text, documentDigest: built.digest, statementCanonical,
      envelope: { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid, sig: signed.signature.toString('base64') }] },
      credentialId: signer.credentialId, keyid, signatureDer: signed.signature, publicKeySpkiDer: signed.publicKeySpkiDer,
      actor: deps.actor, requestId,
    });
    if (chained === 'stale') return { tenantId, outcome: 'stale' };
    return { tenantId, outcome: 'sealed', count: built.document.count, window: plan.window };
  } catch (err) {
    const code = codeOf(err);
    (deps.log ?? ((line: string) => console.error(line)))(`attesta-audit-seal ${code} tenant=${tenantId} cause=${err instanceof Error ? err.name : 'unknown'}`);
    return { tenantId, outcome: 'failed', code };
  }
}

/** Seals per tenant in one pass: a backlog of full chunks is sealed back to back. */
export const MAX_SEALS_PER_PASS = 20;

/**
 * One sealing pass over every tenant with audit rows (the worker loop and the CLI). A tenant
 * is sealed repeatedly while a seal is due (a backlog), up to MAX_SEALS_PER_PASS; a dry run
 * plans one window per tenant.
 */
export async function runAuditSealPass(deps: SealPassDeps, options: { dryRun?: boolean; tenantIds?: string[] } = {}): Promise<SealResult[]> {
  const tenants = options.tenantIds ?? await deps.store.tenantsWithAuditRows();
  const out: SealResult[] = [];
  for (const tenantId of tenants) {
    for (let i = 0; i < MAX_SEALS_PER_PASS; i += 1) {
      const r = await sealTenant(deps, tenantId, options);
      if (r.outcome !== 'not_due' || i === 0) out.push(r);
      if (r.outcome !== 'sealed') break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

export interface SealDbExecutor { execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }> }
export interface SealDatabase extends SealDbExecutor {
  transaction<T>(fn: (tx: SealDbExecutor) => Promise<T>,
    config?: { isolationLevel?: 'repeatable read'; accessMode?: 'read only' }): Promise<T>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The exact stored occurred_at text (read-service.ts OCCURRED_AT_TEXT). */
export const OCCURRED_AT_US = sql.raw(`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** Rows of the tenant with from ≤ occurred_at < to, in (occurred_at, id) order. */
export async function readAuditRows(tx: SealDbExecutor, tenantId: string, from: string, to: string, limit: number): Promise<StoredAuditRow[]> {
  const r = await tx.execute(sql`/* seal:rows */
    select id::text as id, action, actor_type, actor_id, target_type, target_id, details, ${OCCURRED_AT_US} as occurred_at
    from security_audit_events
    where tenant_id = ${tenantId}::uuid and occurred_at >= ${from}::timestamptz and occurred_at < ${to}::timestamptz
    order by occurred_at, id limit ${limit}`);
  return r.rows.map((x) => ({
    id: str(x.id), action: str(x.action), actor_type: str(x.actor_type), actor_id: str(x.actor_id),
    target_type: str(x.target_type), target_id: str(x.target_id), details: x.details ?? {}, occurred_at: str(x.occurred_at),
  }));
}

export function pgSealStore(db: SealDatabase = coreDb as unknown as SealDatabase): SealStore {
  return {
    async tenantsWithAuditRows() {
      const r = await db.execute(sql`/* seal:tenants */
        select t.id::text as id from sso_tenants t
        where exists (select 1 from security_audit_events e where e.tenant_id = t.id) order by t.id`);
      return r.rows.map((x) => str(x.id));
    },

    async readSnapshot(tenantId) {
      return db.transaction(async (tx) => {
        const clock = (await tx.execute(sql`/* seal:clock */
          select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as as_of,
                 to_char((now() - (${SEAL_SETTLE_MS}::int * interval '1 millisecond')) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cutoff`)).rows[0] ?? {};
        const last = (await tx.execute(sql`/* seal:last */
          select window_to, seal_digest, (extract(epoch from (now() - created_at)) * 1000)::bigint::text as age_ms
          from attesta_audit_seals where tenant_id = ${tenantId}::uuid order by window_to desc limit 1`)).rows[0];
        const earliest = last ? null : str((await tx.execute(sql`/* seal:earliest */
          select ${OCCURRED_AT_US} as occurred_at from security_audit_events
          where tenant_id = ${tenantId}::uuid order by occurred_at, id limit 1`)).rows[0]?.occurred_at) || null;
        const cutoff = str(clock.cutoff);
        const from = last ? str(last.window_to) : earliest;
        const rows = from !== null && from < cutoff ? await readAuditRows(tx, tenantId, from, cutoff, MAX_SEAL_ROWS + 1) : [];
        return {
          asOf: str(clock.as_of),
          plan: planSealWindow({
            cutoff,
            last: last ? { windowTo: str(last.window_to), digest: str(last.seal_digest), ageMs: Number(last.age_ms) } : null,
            earliest,
            rows,
          }),
        };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async chainSeal(input) {
      try {
        return await db.transaction(async (tx) => {
          // The insert guard's per-tenant lock, taken first so the re-check below holds until commit.
          await tx.execute(sql`/* seal:lock */
            select pg_advisory_xact_lock(hashtextextended(${'attesta_audit_seals:' + input.tenantId}, 0))`);
          const last = (await tx.execute(sql`/* seal:recheck */
            select window_to, seal_digest from attesta_audit_seals where tenant_id = ${input.tenantId}::uuid
            order by window_to desc limit 1`)).rows[0];
          const lastDigest = last ? str(last.seal_digest) : null;
          if (lastDigest !== input.plan.previous || (last && str(last.window_to) !== input.plan.window.from)) return 'stale' as const;
          const chained = await chainStatement(tx as LedgerExecutor, {
            tenantId: input.tenantId, statementCanonical: input.statementCanonical, envelope: input.envelope,
            credentialId: input.credentialId, keyid: input.keyid, signatureDer: input.signatureDer,
            publicKeySpkiDer: input.publicKeySpkiDer, previousSeen: [],
          });
          if (chained.duplicate) throw internal('a fresh seal statement was already chained');
          const inserted = await tx.execute(sql`/* seal:insert */
            insert into attesta_audit_seals (tenant_id, window_from, window_to, row_count, previous_digest, seal_document,
              seal_digest, record_id, statement_digest)
            values (${input.tenantId}::uuid, ${input.plan.window.from}, ${input.plan.window.to}, ${input.plan.rows.length},
              ${input.plan.previous}, ${input.documentText}, ${input.documentDigest}, ${chained.recordId}::uuid, ${chained.statementDigest})
            returning id::text as id`);
          const sealId = str(inserted.rows[0]?.id);
          if (!sealId) throw internal('the seal insert returned no id');
          await recordAuditEvent(tx, input.tenantId, {
            action: 'audit.trail.sealed',
            actorType: input.actor.type,
            actorId: input.actor.id,
            targetType: 'attesta_audit_seal',
            targetId: sealId,
            details: {
              window_from: input.plan.window.from,
              window_to: input.plan.window.to,
              count: input.plan.rows.length,
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
