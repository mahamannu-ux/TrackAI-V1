/**
 * Signed audit export (Task16e, A16.7; docs/contracts/audit/export.md).
 *
 *   parseExportRequest     POST body validation ({from, to}, ≤ 366 days, to ≤ now)
 *   buildAuditExport       pure and deterministic: events, seals, seal evidence, manifest
 *   runAuditExport         the job: claim (lease) → one repeatable-read snapshot → build →
 *                          sign (outside any transaction) → export sink → ready | failed
 *   pgExportStore          the tenant-bound PostgreSQL store (table audit_exports, 0023)
 *
 * The job, lease, replay and sink pattern is the evidence packs' (evidence-pack-service.ts,
 * Task15i2), and so are the seal_evidence section shapes (its exported entry builders) and
 * the trust material. Ported from SushiCorp @ 0bd67a5 (catalog RP-1): the signature covers a
 * small statement naming the export digest, never the bytes themselves.
 *
 * Every query binds tenant_id, except `runnable` (an operator recovery pass).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db as coreDb } from '../../core/db';
import { AUDIT_CATALOG_VERSION } from '../../core/audit/catalog';
import { recordAuditEvent } from '../../core/audit/record';
import type { EvidenceExportSink } from '../../core/operations/evidence-export-sink';
import { readAuditRows, type SealDatabase, type StoredAuditRow } from '../attesta/audit-seal-service';
import { canonicalize, sha256Prefixed } from '../attesta/canonical';
import { pae, type DsseEnvelope } from '../attesta/dsse';
import {
  defaultPackJobDeps, packAnchorEntries, packAnchorStatus, packBatchEntries, packRecordEntry, packStatementEntry,
  signedByNewestKeyset, type PackTrustMaterial, type SegmentAnchor, type SegmentBatch,
} from '../attesta/evidence-pack-service';
import { parseSeq } from '../attesta/ledger';
import { SigningRejected, SigningUnavailable, signVerified } from '../attesta/signer-contract';
import type { SignerResolver } from '../attesta/signer-resolver';

export const AUDIT_EXPORT_FORMAT = 'https://trackai.dev/audit/export/v1';
export const AUDIT_EXPORT_PAYLOAD_TYPE = 'application/vnd.trackai.audit-export+json';
export const MAX_EXPORT_DAYS = 366;
export const MAX_EXPORT_EVENTS = 200_000;
export const EXPORT_LEASE_MS = 600_000;
export const MAX_OPEN_EXPORTS = 4;
export const EXPORT_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,64}$/;

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed';
export type ExportErrorCode =
  | 'AUDIT_EXPORT_TOO_LARGE' | 'AUDIT_EXPORT_SIGNER_NO_CREDENTIAL' | 'AUDIT_EXPORT_SIGNER_UNAVAILABLE'
  | 'AUDIT_EXPORT_UNAVAILABLE' | 'AUDIT_EXPORT_INTERNAL';
export const RETRYABLE_EXPORT_CODES: ReadonlySet<string> = new Set([
  'AUDIT_EXPORT_SIGNER_UNAVAILABLE', 'AUDIT_EXPORT_UNAVAILABLE', 'AUDIT_EXPORT_INTERNAL',
]);

export class ExportJobError extends Error {
  constructor(readonly code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportJobError';
  }
}
/** A refused request (400); the route maps it to AUDIT_FILTER_INVALID. */
export class ExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const internal = (why: string) => new ExportJobError('AUDIT_EXPORT_INTERNAL', `audit export: ${why}`);

// ---------------------------------------------------------------------------
// Request

export interface ExportScope { from: string; to: string }

export function parseExportIdempotencyKey(raw: unknown): string {
  if (typeof raw !== 'string' || !EXPORT_IDEMPOTENCY_KEY_RE.test(raw)) throw new ExportRequestError('Idempotency-Key is invalid');
  return raw;
}

/** `{from, to}` RFC 3339, normalized to UTC milliseconds; from < to ≤ now; at most 366 days. */
export function parseExportRequest(body: unknown, now: Date): ExportScope {
  const b = body as Record<string, unknown> | null;
  if (typeof b !== 'object' || b === null || Array.isArray(b) || Object.keys(b).sort().join(',') !== 'from,to') {
    throw new ExportRequestError('body must be exactly {from, to}');
  }
  const one = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !RFC3339_RE.test(v) || !Number.isFinite(Date.parse(v))) throw new ExportRequestError(`${name} is invalid`);
    return new Date(Date.parse(v)).toISOString();
  };
  const from = one(b.from, 'from');
  const to = one(b.to, 'to');
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0) throw new ExportRequestError('from is not before to');
  if (span > MAX_EXPORT_DAYS * 86_400_000) throw new ExportRequestError('the scope exceeds one year');
  if (Date.parse(to) > now.getTime()) throw new ExportRequestError('to is in the future');
  return { from, to };
}

/** The stored scope, re-validated (a row is data, never trusted shape). */
export function parseStoredExportScope(raw: unknown): ExportScope {
  const s = raw as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || Object.keys(s).sort().join(',') !== 'from,to'
    || typeof s.from !== 'string' || !ISO_MS_RE.test(s.from) || typeof s.to !== 'string' || !ISO_MS_RE.test(s.to)) {
    throw internal('the stored scope is malformed');
  }
  return { from: s.from, to: s.to };
}

/** ms ISO → the exact microsecond text the audit rows use. */
export const toMicro = (iso: string): string => `${iso.slice(0, -1)}000Z`;

// ---------------------------------------------------------------------------
// The export (pure)

export interface ExportSeal {
  seq: number;
  windowFrom: string;
  windowTo: string;
  sealDigest: string;
  sealDocument: string;
  prevHash: string;
  recordHash: string;
  canonicalRecord: string;
  statementDigest: string;
  statementCanonical: string;
  envelope: unknown;
}

export interface ExportSnapshot {
  generatedAt: string;
  events: StoredAuditRow[];
  seals: ExportSeal[];
  anchors: SegmentAnchor[];
  batches: SegmentBatch[];
}

export interface ExportCounts {
  events: number;
  seals: number;
  sealed_events: number;
  unsealed_events: number;
  anchored: number;
  pending: number;
}

export interface ExportManifest {
  format: typeof AUDIT_EXPORT_FORMAT;
  export_id: string;
  tenant_id: string;
  scope: ExportScope;
  covered: { from: string; to: string };
  generated_at: string;
  catalog_version: number;
  counts: ExportCounts;
  sections: { events: string; seals: string; seal_evidence: string };
}

export interface BuiltExport { text: string; digest: string; manifest: ExportManifest; counts: ExportCounts }

/** The range the events cover: the scope widened to the listed seals' whole windows. */
export function coveredRange(scope: ExportScope, seals: ReadonlyArray<{ windowFrom: string; windowTo: string }>): { from: string; to: string } {
  let from = toMicro(scope.from);
  let to = toMicro(scope.to);
  for (const s of seals) {
    if (s.windowFrom < from) from = s.windowFrom;
    if (s.windowTo > to) to = s.windowTo;
  }
  return { from, to };
}

const sectionDigest = (value: unknown) => sha256Prefixed(canonicalize(value));

export function buildAuditExport(input: {
  exportId: string; tenantId: string; scope: ExportScope; snapshot: ExportSnapshot; trust: PackTrustMaterial;
}): BuiltExport {
  const { snapshot: snap } = input;
  if (!UUID_RE.test(input.exportId) || !UUID_RE.test(input.tenantId)) throw internal('ids are not lowercase UUIDs');
  if (!ISO_MS_RE.test(snap.generatedAt)) throw internal('generated_at is malformed');
  if (snap.events.length > MAX_EXPORT_EVENTS) throw new ExportJobError('AUDIT_EXPORT_TOO_LARGE', 'too many events for one export');
  const covered = coveredRange(input.scope, snap.seals);
  const events = snap.events.map((e) => {
    if (e.occurred_at < covered.from || e.occurred_at >= covered.to) throw internal('an event lies outside the covered range');
    return { id: e.id, action: e.action, actor_type: e.actor_type, actor_id: e.actor_id, target_type: e.target_type,
      target_id: e.target_id, details: e.details, occurred_at: e.occurred_at };
  });
  const seals = snap.seals.map((s) => {
    if (sha256Prefixed(s.sealDocument) !== s.sealDigest) throw internal('a seal document does not match its digest');
    return { seq: s.seq, seal_digest: s.sealDigest, document: s.sealDocument };
  });
  const anchorsBySeq = new Map<number, SegmentAnchor[]>();
  for (const a of snap.anchors) anchorsBySeq.set(a.seq, [...(anchorsBySeq.get(a.seq) ?? []), a]);
  let anchored = 0;
  const statements = snap.seals.map((s) => {
    const status = packAnchorStatus(anchorsBySeq.get(s.seq) ?? []);
    if (status === 'anchored') anchored += 1;
    return packStatementEntry(s, status);
  });
  const sealSeqs = new Set(snap.seals.map((s) => s.seq));
  const anchors = packAnchorEntries(snap.anchors.filter((a) => sealSeqs.has(a.seq)));
  const sealEvidence = {
    records: snap.seals.map((s) => packRecordEntry(s)),
    statements,
    anchors,
    anchor_batches: packBatchEntries(snap.batches, new Set(anchors.map((a) => a.batch_id))),
    trust: input.trust.trust,
  };
  const inSeal = (e: { occurred_at: string }) => snap.seals.some((s) => e.occurred_at >= s.windowFrom && e.occurred_at < s.windowTo);
  const sealedEvents = events.filter(inSeal).length;
  const counts: ExportCounts = {
    events: events.length, seals: seals.length, sealed_events: sealedEvents, unsealed_events: events.length - sealedEvents,
    anchored, pending: seals.length - anchored,
  };
  const manifest: ExportManifest = {
    format: AUDIT_EXPORT_FORMAT,
    export_id: input.exportId,
    tenant_id: input.tenantId,
    scope: { from: input.scope.from, to: input.scope.to },
    covered,
    generated_at: snap.generatedAt,
    catalog_version: AUDIT_CATALOG_VERSION,
    counts,
    sections: { events: sectionDigest(events), seals: sectionDigest(seals), seal_evidence: sectionDigest(sealEvidence) },
  };
  const text = canonicalize({ manifest, events, seals, seal_evidence: sealEvidence });
  return { text, digest: sha256Prefixed(text), manifest, counts };
}

/** The RP-1 statement the export signature covers. */
export function exportSignaturePayload(manifest: ExportManifest, exportDigest: string): Buffer {
  return Buffer.from(canonicalize({ manifest, export_digest: exportDigest }), 'utf8');
}

/** Sign with the tenant's active statement key (the pack-signature rule; not chained). */
export async function signExport(built: BuiltExport, resolver: SignerResolver, tenantId: string, requestId: string): Promise<DsseEnvelope> {
  const payload = exportSignaturePayload(built.manifest, built.digest);
  try {
    const resolved = await resolver.resolve(tenantId);
    if (!resolved) throw new ExportJobError('AUDIT_EXPORT_SIGNER_NO_CREDENTIAL', 'the tenant has no active statement key');
    const result = await signVerified(resolved.adapter, pae(AUDIT_EXPORT_PAYLOAD_TYPE, payload), {
      credentialId: resolved.credentialId, tenantId, requestId,
    });
    return {
      payload: payload.toString('base64'),
      payloadType: AUDIT_EXPORT_PAYLOAD_TYPE,
      signatures: [{ keyid: sha256Prefixed(result.publicKeySpkiDer), sig: result.signature.toString('base64') }],
    };
  } catch (err) {
    if (err instanceof ExportJobError) throw err;
    if (err instanceof SigningRejected) throw new ExportJobError('AUDIT_EXPORT_SIGNER_UNAVAILABLE', 'the signer refused the export');
    throw new ExportJobError('AUDIT_EXPORT_SIGNER_UNAVAILABLE', err instanceof SigningUnavailable ? 'the signer is unavailable' : 'the signer failed');
  }
}

// ---------------------------------------------------------------------------
// Jobs

export interface ExportJob {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  scope: unknown;
  status: ExportStatus;
  requestId: string;
  attempts: number;
  exportDigest: string | null;
  storageReference: string | null;
  bytes: number | null;
  counts: ExportCounts | null;
  signatureEnvelope: DsseEnvelope | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExportAuditInput {
  tenantId: string;
  actorId: string;
  actorRole: 'tenant_admin' | 'tenant_auditor';
  action: 'audit.export.requested' | 'audit.export.downloaded';
  exportId: string;
  details: Record<string, unknown>;
}

export interface ExportStore {
  createOrGet(input: { tenantId: string; idempotencyKey: string; scope: ExportScope; requestedBy: string; requestId: string }):
    Promise<{ job: ExportJob; created: boolean }>;
  get(tenantId: string, id: string): Promise<ExportJob | null>;
  findByKey(tenantId: string, idempotencyKey: string): Promise<ExportJob | null>;
  openCount(tenantId: string): Promise<number>;
  claim(tenantId: string, id: string, leaseMs: number): Promise<number | null>;
  readSnapshot(tenantId: string, scope: ExportScope): Promise<ExportSnapshot>;
  finishReady(tenantId: string, id: string, attempts: number, out: {
    exportDigest: string; storageReference: string; bytes: number; counts: ExportCounts; signatureEnvelope: DsseEnvelope;
  }): Promise<boolean>;
  finishFailed(tenantId: string, id: string, attempts: number | null, code: ExportErrorCode): Promise<boolean>;
  runnable(limit: number): Promise<Array<{ tenantId: string; id: string }>>;
  audit(input: ExportAuditInput): Promise<void>;
}

export interface ExportJobDeps {
  store: ExportStore;
  sink: () => EvidenceExportSink | null;
  resolver: () => Promise<SignerResolver>;
  trust: (tenantId: string) => Promise<PackTrustMaterial>;
  log?: (line: string) => void;
  leaseMs?: number;
}

export type ExportRunResult = 'ready' | 'failed' | 'not_claimed' | 'lease_lost';

/** Run one job (runEvidencePack's sequence). A partial export is never ready. */
export async function runAuditExport(deps: ExportJobDeps, tenantId: string, exportId: string): Promise<ExportRunResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const attempts = await deps.store.claim(tenantId, exportId, deps.leaseMs ?? EXPORT_LEASE_MS);
  if (attempts === null) return 'not_claimed';
  let written: { storageReference: string; bytes: number } | null = null;
  let sink: EvidenceExportSink | null = null;
  try {
    const job = await deps.store.get(tenantId, exportId);
    if (!job || job.status !== 'running') throw internal('the claimed job is not running');
    const scope = parseStoredExportScope(job.scope);
    sink = deps.sink();
    if (!sink) throw new ExportJobError('AUDIT_EXPORT_UNAVAILABLE', 'the export sink is not configured');
    const snapshot = await deps.store.readSnapshot(tenantId, scope);
    let trust: PackTrustMaterial;
    try {
      trust = await deps.trust(tenantId);
    } catch {
      throw new ExportJobError('AUDIT_EXPORT_UNAVAILABLE', 'the trust material cannot be read');
    }
    const built = buildAuditExport({ exportId, tenantId, scope, snapshot, trust });
    let resolver: SignerResolver;
    try {
      resolver = await deps.resolver();
    } catch {
      throw new ExportJobError('AUDIT_EXPORT_SIGNER_UNAVAILABLE', 'the signer cannot be configured');
    }
    const envelope = await signExport(built, resolver, tenantId, job.requestId);
    // As for packs: the signature must verify with the export's own newest key set.
    if (!signedByNewestKeyset(envelope, trust.trust)) {
      throw new ExportJobError('AUDIT_EXPORT_SIGNER_UNAVAILABLE', 'the signing key is not active in the export\'s newest key set');
    }
    try {
      written = await sink.write(exportId, built.text);
    } catch {
      throw new ExportJobError('AUDIT_EXPORT_UNAVAILABLE', 'the export sink refused the export');
    }
    const ok = await deps.store.finishReady(tenantId, exportId, attempts, {
      exportDigest: built.digest, storageReference: written.storageReference, bytes: written.bytes,
      counts: built.counts, signatureEnvelope: envelope,
    });
    if (!ok) {
      await sink.remove(written.storageReference).catch(() => undefined);
      return 'lease_lost';
    }
    return 'ready';
  } catch (err) {
    const code: ExportErrorCode = err instanceof ExportJobError ? err.code : 'AUDIT_EXPORT_INTERNAL';
    if (written && sink) await sink.remove(written.storageReference).catch(() => undefined);
    log(`audit-export ${code} export_id=${exportId} cause=${err instanceof Error ? err.name : 'unknown'}`);
    const ok = await deps.store.finishFailed(tenantId, exportId, attempts, code).catch(() => false);
    return ok ? 'failed' : 'lease_lost';
  }
}

export function exportStatusBody(job: ExportJob, basePath = '/api/audit/exports') {
  return {
    id: job.id,
    status: job.status,
    scope: job.scope,
    counts: job.counts,
    export_digest: job.exportDigest,
    bytes: job.bytes,
    error_code: job.errorCode,
    retryable: job.errorCode === null ? null : RETRYABLE_EXPORT_CODES.has(job.errorCode),
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    content_path: job.status === 'ready' ? `${basePath}/${job.id}/content` : null,
  };
}

/** `{"export": <stored bytes>, "signature": <envelope>}`; the stored bytes must match the digest. */
export function exportDownloadBody(job: ExportJob, stored: string): string {
  if (job.status !== 'ready' || !job.exportDigest || !job.signatureEnvelope) throw internal('the job is not ready');
  if (sha256Prefixed(stored) !== job.exportDigest) throw internal('the stored export does not match its digest');
  return `{"export":${stored},"signature":${JSON.stringify(job.signatureEnvelope)}}`;
}

// ---------------------------------------------------------------------------
// PostgreSQL store

const TS_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const JOB_COLUMNS = sql.raw(`id::text as id, tenant_id::text as tenant_id, idempotency_key, scope, status, request_id, attempts,
  export_digest, storage_reference, bytes::text as bytes, counts, signature_envelope, error_code,
  to_char(created_at at time zone 'UTC', ${TS_MS}) as created_at, to_char(finished_at at time zone 'UTC', ${TS_MS}) as finished_at`);

function toJob(r: Record<string, unknown>): ExportJob {
  return {
    id: str(r.id), tenantId: str(r.tenant_id), idempotencyKey: str(r.idempotency_key), scope: r.scope,
    status: str(r.status) as ExportStatus, requestId: str(r.request_id), attempts: Number(r.attempts),
    exportDigest: strOrNull(r.export_digest), storageReference: strOrNull(r.storage_reference),
    bytes: typeof r.bytes === 'string' ? Number(r.bytes) : null, counts: (r.counts ?? null) as ExportCounts | null,
    signatureEnvelope: (r.signature_envelope ?? null) as DsseEnvelope | null, errorCode: strOrNull(r.error_code),
    createdAt: str(r.created_at), finishedAt: strOrNull(r.finished_at),
  };
}

export function pgExportStore(db: SealDatabase = coreDb as unknown as SealDatabase): ExportStore {
  return {
    async createOrGet({ tenantId, idempotencyKey, scope, requestedBy, requestId }) {
      const inserted = await db.execute(sql`/* audit-export:create */
        insert into audit_exports (tenant_id, idempotency_key, scope, requested_by, request_id)
        values (${tenantId}::uuid, ${idempotencyKey}, ${JSON.stringify(scope)}::jsonb, ${requestedBy}, ${requestId})
        on conflict (tenant_id, idempotency_key) do nothing
        returning ${JOB_COLUMNS}`);
      if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
      const existing = await db.execute(sql`/* audit-export:by_key */
        select ${JOB_COLUMNS} from audit_exports where tenant_id = ${tenantId}::uuid and idempotency_key = ${idempotencyKey}`);
      if (!existing.rows[0]) throw internal('the idempotent job vanished');
      return { job: toJob(existing.rows[0]), created: false };
    },

    async get(tenantId, id) {
      const r = await db.execute(sql`/* audit-export:get */
        select ${JOB_COLUMNS} from audit_exports where tenant_id = ${tenantId}::uuid and id = ${id}::uuid`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async findByKey(tenantId, idempotencyKey) {
      const r = await db.execute(sql`/* audit-export:by_key */
        select ${JOB_COLUMNS} from audit_exports where tenant_id = ${tenantId}::uuid and idempotency_key = ${idempotencyKey}`);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    },

    async openCount(tenantId) {
      const r = await db.execute(sql`/* audit-export:open */
        select count(*)::int as n from audit_exports where tenant_id = ${tenantId}::uuid
          and ((status = 'queued' and created_at > now() - (${EXPORT_LEASE_MS}::int * interval '1 millisecond'))
            or (status = 'running' and lease_until > now()))`);
      return Number(r.rows[0]?.n ?? 0);
    },

    async claim(tenantId, id, leaseMs) {
      const r = await db.execute(sql`/* audit-export:claim */
        update audit_exports
        set status = 'running', attempts = attempts + 1, lease_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
        where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
          and (status = 'queued' or (status = 'running' and lease_until < now()))
        returning attempts`);
      return r.rows[0] ? Number(r.rows[0].attempts) : null;
    },

    async readSnapshot(tenantId, scope) {
      return db.transaction(async (tx) => {
        const generatedAt = str((await tx.execute(sql`/* audit-export:clock */
          select ${sql.raw(`to_char(now() at time zone 'UTC', ${TS_MS})`)} as generated_at`)).rows[0]?.generated_at);
        const sealRows = (await tx.execute(sql`/* audit-export:seals */
          select s.window_from, s.window_to, s.seal_digest, s.seal_document, r.seq::text as seq, r.prev_hash, r.record_hash,
                 r.canonical_record, r.statement_digest, r.statement_canonical, e.envelope
          from attesta_audit_seals s
          join attesta_records r on r.tenant_id = s.tenant_id and r.id = s.record_id
          left join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
          where s.tenant_id = ${tenantId}::uuid
            and s.window_from::timestamptz < ${scope.to}::timestamptz and s.window_to::timestamptz > ${scope.from}::timestamptz
          order by s.window_from`)).rows;
        const seals: ExportSeal[] = sealRows.map((r) => ({
          seq: parseSeq(r.seq), windowFrom: str(r.window_from), windowTo: str(r.window_to), sealDigest: str(r.seal_digest),
          sealDocument: str(r.seal_document), prevHash: str(r.prev_hash), recordHash: str(r.record_hash),
          canonicalRecord: str(r.canonical_record), statementDigest: str(r.statement_digest),
          statementCanonical: str(r.statement_canonical), envelope: r.envelope ?? null,
        }));
        const covered = coveredRange(scope, seals);
        const events = await readAuditRows(tx, tenantId, covered.from, covered.to, MAX_EXPORT_EVENTS + 1);
        if (events.length > MAX_EXPORT_EVENTS) throw new ExportJobError('AUDIT_EXPORT_TOO_LARGE', 'too many events for one export');
        const seqs = seals.map((s) => s.seq);
        const anchorRows = seqs.length === 0 ? [] : (await tx.execute(sql`/* audit-export:anchors */
          select r.seq::text as seq, a.anchor_type, a.batch_id, a.inclusion_proof, a.rekor_entry_uuid, a.tsa_token_b64
          from attesta_anchors a join attesta_records r on r.tenant_id = a.tenant_id and r.id = a.record_id
          where a.tenant_id = ${tenantId}::uuid and a.status = 'anchored'
            and r.seq in (${sql.join(seqs.map((q) => sql`${q}`), sql`, `)})
          order by r.seq, a.anchor_type`)).rows;
        const batchIds = [...new Set(anchorRows.map((a) => str(a.batch_id)))];
        const batchRows = batchIds.length === 0 ? [] : (await tx.execute(sql`/* audit-export:batches */
          select batch_id, seq_from::text as seq_from, seq_to::text as seq_to, leaf_count, merkle_root
          from attesta_anchor_batches where tenant_id = ${tenantId}::uuid
            and batch_id in (${sql.join(batchIds.map((id) => sql`${id}`), sql`, `)}) order by seq_from`)).rows;
        return {
          generatedAt,
          events,
          seals,
          anchors: anchorRows.map((a) => ({
            seq: parseSeq(a.seq), anchorType: a.anchor_type === 'tsa' ? 'tsa' as const : 'rekor' as const, batchId: str(a.batch_id),
            inclusionProof: a.inclusion_proof ?? null, rekorEntryUuid: strOrNull(a.rekor_entry_uuid), tsaTokenB64: strOrNull(a.tsa_token_b64),
          })),
          batches: batchRows.map((x) => ({
            batchId: str(x.batch_id), seqFrom: parseSeq(x.seq_from), seqTo: parseSeq(x.seq_to),
            leafCount: Number(x.leaf_count), merkleRoot: str(x.merkle_root),
          })),
        };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async finishReady(tenantId, id, attempts, out) {
      const r = await db.execute(sql`/* audit-export:ready */
        update audit_exports
        set status = 'ready', lease_until = null, export_digest = ${out.exportDigest}, storage_reference = ${out.storageReference},
            bytes = ${out.bytes}, counts = ${JSON.stringify(out.counts)}::jsonb,
            signature_envelope = ${JSON.stringify(out.signatureEnvelope)}::jsonb, updated_at = now(), finished_at = now()
        where tenant_id = ${tenantId}::uuid and id = ${id}::uuid and status = 'running' and attempts = ${attempts}
        returning id`);
      return r.rows.length === 1;
    },

    async finishFailed(tenantId, id, attempts, code) {
      const r = await db.execute(sql`/* audit-export:failed */
        update audit_exports
        set status = 'failed', lease_until = null, error_code = ${code}, updated_at = now(), finished_at = now()
        where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
          and ${attempts === null ? sql`status = 'queued'` : sql`status = 'running' and attempts = ${attempts}`}
        returning id`);
      return r.rows.length === 1;
    },

    async runnable(limit) {
      // Across tenants on purpose (an operator recovery pass); each job then runs with its own tenant_id.
      const r = await db.execute(sql`/* audit-export:runnable */
        select tenant_id::text as tenant_id, id::text as id from audit_exports
        where status = 'queued' or (status = 'running' and lease_until < now())
        order by created_at limit ${limit}`);
      return r.rows.map((x) => ({ tenantId: str(x.tenant_id), id: str(x.id) }));
    },

    async audit(input) {
      await recordAuditEvent(coreDb, input.tenantId, {
        actorType: input.actorRole,
        actorId: input.actorId,
        action: input.action,
        targetType: 'audit_export',
        targetId: input.exportId,
        details: input.details,
      });
    },
  };
}

/** Production wiring: the evidence packs' sink, signer resolver and trust material. */
export function defaultExportJobDeps(env: NodeJS.ProcessEnv = process.env): ExportJobDeps {
  const packs = defaultPackJobDeps(env);
  return { store: pgExportStore(), sink: packs.sink, resolver: packs.resolver, trust: packs.trust };
}

export const newExportId = (): string => randomUUID();