/**
 * Offline audit-export verifier (Task16f2, A16.7 finishing work;
 * docs/contracts/audit/export.md "What a verifier checks", steps 1–7).
 *
 * A pure function an auditor runs on a laptop with no TrackAI account and no
 * network: `verifyAuditExport(download, options)` says whether an
 * `{export, signature}` download from `GET /api/audit/exports/:id/content` is
 * genuine and complete. Exit codes 0 (all checked and passed), 1 (a break) and
 * 2 (something not checkable, for example a pending anchor). Unsealed events are
 * reported, never a pass and never a break. This function never throws and never
 * reads a file, a clock or the network (`options.now` is the clock).
 *
 * Trust, signature and anchor steps reuse the pack verifier's helpers
 * (features/attesta/offline-verifier.ts, itself SushiCorp EV-2
 * offline_verify.py @ 0bd67a5): verifyTrusted for the trust chain and every
 * signature, verifyStoredAnchor for the seal records' anchor rows, the same
 * dual-anchoring and pending rules. The export-specific shape, seal and event
 * steps implement export.md directly. Only the user's pin, Rekor key and TSA
 * anchors are trusted; every value inside the download is a claim.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  canonicalize,
  computeRecordHash,
  sha256Prefixed,
} from '../attesta/canonical';
import { IN_TOTO_PAYLOAD_TYPE, type DsseEnvelope } from '../attesta/dsse';
import {
  TRUST_CODE_STATUS,
  verifyTrusted,
  type CustomerPinnedKey,
  type TimeEvidence,
  type TrustVerdict,
  type TrustedDocumentRef,
} from '../attesta/trust-contract';
import { DIGEST_RE, parseTimestamp } from '../attesta/trust-documents';
import {
  verifyStoredAnchor,
  type StoredAnchorKeys,
  type StoredAnchorRow,
} from '../attesta/anchor-dual';
import { loadLogPublicKey } from '../attesta/anchor-rekor';
import { loadTrustAnchors } from '../attesta/anchor-tsa';
import {
  AUDIT_SEAL_PREDICATE_TYPE,
} from '../attesta/ledger';
import {
  anchorClaimTimeMs,
  anchorWindowsFor,
  decimalOffsetsToHex,
  rekorTimeIso,
  tsaTimeIso,
} from '../attesta/offline-verifier';
import {
  checkSealRows,
  parseSealDocument,
  sealValidators,
  type SealBreak,
  type SealDocument,
  type StoredAuditRow,
} from '../attesta/audit-seal-service';

// ---------------------------------------------------------------------------
// Copied constants (frozen contract strings; never import the export service:
// it pulls in the database)
// ---------------------------------------------------------------------------

/** docs/contracts/audit/export.md: the export format URI. */
const AUDIT_EXPORT_FORMAT = 'https://trackai.dev/audit/export/v1';
/** The export signature payload type (distinct from statements and packs on purpose). */
const AUDIT_EXPORT_PAYLOAD_TYPE = 'application/vnd.trackai.audit-export+json';
/** Anchor times may lag `recorded_at` by this much (writer and log clock skew). */
const ANCHOR_SKEW_MS = 300_000;
/** The download's top-level keys, sorted (export.md "The export"). */
const DOWNLOAD_KEYS = 'export,signature';
const EXPORT_KEYS = 'events,manifest,seal_evidence,seals';
/** ms ISO → the exact microsecond text the audit rows use (export-service toMicro). */
const toMicro = (iso: string): string => `${iso.slice(0, -1)}000Z`;
/** The scope widened to the listed seals' whole windows (export-service coveredRange). */
function coveredRange(scope: { from: string; to: string }, seals: ReadonlyArray<{ windowFrom: string; windowTo: string }>): { from: string; to: string } {
  let from = toMicro(scope.from);
  let to = toMicro(scope.to);
  for (const s of seals) {
    if (s.windowFrom < from) from = s.windowFrom;
    if (s.windowTo > to) to = s.windowTo;
  }
  return { from, to };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything the verifier trusts. The pin, keys and anchors are the user's, never the download's. */
export interface AuditExportVerifyOptions {
  /** Root keyids pinned out of band (required unless `customerPins` is given). */
  pinnedRootKeyids: readonly string[];
  /** Customer pins for the export's tenant (replaces the platform key set for it). */
  customerPins?: readonly CustomerPinnedKey[];
  /** The Rekor log's public key (PEM, from Sigstore). Without it Rekor rows are not checkable. */
  rekorLogKeyPem?: string;
  /** The TSA trust anchors (PEM bundle, from the TSA). Without them TSA rows are not checkable. */
  tsaAnchorsPem?: string;
  /** Pinned Rekor shard offsets (`{"<decimal tree id>": <offset>}`), supplied by the user like the log key. */
  rekorLogIndexOffsets?: Readonly<Record<string, number>>;
  /** The check time, RFC 3339 UTC with milliseconds (the CLI passes the real clock). */
  now: string;
}

export type AuditExportCheckStatus = 'passed' | 'failed' | 'not_checkable';

/** One check's outcome: codes and counts only, never event details or key material. */
export interface AuditExportCheck {
  id: 'trust' | 'signature' | 'shape' | 'seals' | 'seal_evidence' | 'events';
  status: AuditExportCheckStatus;
  detail_code?: string;
}

/** A tamper finding, in the verify report's kinds. */
export interface AuditExportBreak {
  kind: SealBreak['kind'];
  seal_digest: string;
  row_id?: string;
}

export interface AuditExportReport {
  exit_code: 0 | 1 | 2;
  checks: AuditExportCheck[];
  breaks: AuditExportBreak[];
  unsealed: { count: number };
  /**
   * The verifier itself is broken (its schema files are missing, or an unexpected
   * failure escaped the checks): a fixed generic message, never download contents.
   * Absent when only the download was judged.
   */
  verifier_error?: string;
}

// ---------------------------------------------------------------------------
// Small helpers (the download is attacker-controlled: nothing here throws)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v);
const sortedKeys = (v: Obj): string => Object.keys(v).sort().join();

function jcs(value: unknown): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function decodeB64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Schema validators (the seal service's ajv setup, copied for the export schema)
// ---------------------------------------------------------------------------

function contractDirs(): { audit: string; attesta: string } {
  let dir: string = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const audit = join(dir, 'docs', 'contracts', 'audit');
    if (existsSync(join(audit, 'export-v1.schema.json'))) {
      return { audit, attesta: join(dir, 'docs', 'contracts', 'attesta') };
    }
    dir = dirname(dir);
  }
  throw new Error('docs/contracts not found above the verifier');
}

let exportValidator: ValidateFunction | null = null;
function exportSchemaValidator(): ValidateFunction {
  if (exportValidator) return exportValidator;
  const { audit } = contractDirs();
  const schema = JSON.parse(readFileSync(join(audit, 'export-v1.schema.json'), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  exportValidator = ajv.compile(schema);
  return exportValidator;
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

const FAILED = 'failed' as const;
const NOT_CHECKABLE = 'not_checkable' as const;

type CheckId = AuditExportCheck['id'];

/** Check one download; never throws (attacker input is data, not an exception). */
export function verifyAuditExport(download: unknown, options: AuditExportVerifyOptions): AuditExportReport {
  try {
    return verify(download, options);
  } catch {
    // The verifier itself failed (never the download's verdict): not checkable,
    // never a break. Every check carries the code.
    const nc = (id: CheckId): AuditExportCheck => ({ id, status: NOT_CHECKABLE, detail_code: 'ATTESTA_VERIFY_NOT_CHECKABLE' });
    return {
      exit_code: 2,
      checks: [nc('trust'), nc('signature'), nc('shape'), nc('seals'), nc('seal_evidence'), nc('events')],
      breaks: [],
      unsealed: { count: 0 },
      verifier_error: 'unexpected verifier failure',
    };
  }
}

interface ParsedSeal {
  seq: number;
  digest: string;
  doc: SealDocument | null;
  documentText: string;
}

interface ParsedStatement {
  seq: number;
  statementDigest: string;
  statementCanonical: string;
  envelope: DsseEnvelope;
  anchorStatus: string;
}

interface ParsedRecord {
  seq: number;
  recordHash: string;
  prevHash: string;
  canonicalRecord: string;
  parsed: Obj | null;
}

function verify(download: unknown, options: AuditExportVerifyOptions): AuditExportReport {
  const breaks: AuditExportBreak[] = [];
  let schemaEnvFailed = false;

  // --- download shape (attacker bytes first; every check below assumes as little as possible)
  const dl = isObj(download) ? download : null;
  const signature = dl !== null && isObj(dl.signature) ? (dl.signature as unknown as DsseEnvelope) : null;
  let exportObj: Obj | null = null;
  if (dl !== null) {
    const raw = (dl as Obj).export;
    if (typeof raw === 'string') {
      const parsed = parseJson(raw);
      exportObj = isObj(parsed) ? parsed : null;
    } else if (isObj(raw)) {
      exportObj = raw;
    }
  }
  if (dl === null || sortedKeys(dl) !== DOWNLOAD_KEYS || exportObj === null || signature === null) {
    const nc = (id: CheckId): AuditExportCheck => ({ id, status: NOT_CHECKABLE, detail_code: 'ATTESTA_VERIFY_NOT_CHECKABLE' });
    return {
      exit_code: 2,
      checks: [nc('trust'), nc('signature'), nc('shape'), nc('seals'), nc('seal_evidence'), nc('events')],
      breaks,
      unsealed: { count: 0 },
    };
  }

  const manifest = isObj(exportObj.manifest) ? exportObj.manifest : null;
  const tenantId = manifest !== null && typeof manifest.tenant_id === 'string' ? manifest.tenant_id : '';
  const generatedAt = manifest !== null && typeof manifest.generated_at === 'string' ? manifest.generated_at : '';
  const eventsRaw: unknown[] = Array.isArray(exportObj.events) ? exportObj.events : [];
  const sealsRaw: unknown[] = Array.isArray(exportObj.seals) ? exportObj.seals : [];
  const sealEvidence = isObj(exportObj.seal_evidence) ? exportObj.seal_evidence : null;
  const trustSection = sealEvidence !== null && isObj(sealEvidence.trust) ? sealEvidence.trust : null;

  // --- user anchor material (the auditor's files, never the download's claims)
  let rekorLogKey;
  try {
    rekorLogKey = options.rekorLogKeyPem !== undefined ? loadLogPublicKey(options.rekorLogKeyPem) : undefined;
  } catch {
    rekorLogKey = undefined;
  }
  let tsaAnchors: ReturnType<typeof loadTrustAnchors> | undefined;
  try {
    tsaAnchors = options.tsaAnchorsPem !== undefined ? loadTrustAnchors(options.tsaAnchorsPem) : undefined;
  } catch {
    tsaAnchors = undefined;
  }
  const userOffsets = options.rekorLogIndexOffsets !== undefined
    ? decimalOffsetsToHex(options.rekorLogIndexOffsets).offsets
    : undefined;

  // --- 1+2. trust (verifyTrusted on the export signature) and signature (exact payload bytes)
  let trust: AuditExportCheck = { id: 'trust', status: FAILED };
  let signatureCheck: AuditExportCheck = { id: 'signature', status: FAILED };
  let trusted: Record<string, TrustedDocumentRef> | undefined;
  let windowsPlatform: { digest: string } | undefined;
  {
    const rootDocs = trustSection !== null && Array.isArray(trustSection.root_documents)
      ? (trustSection.root_documents as DsseEnvelope[]) : [];
    const keysetDocs = trustSection !== null && Array.isArray(trustSection.keyset_documents)
      ? (trustSection.keyset_documents as DsseEnvelope[]) : [];
    const payloadBytes = signature !== null ? decodeB64((signature as unknown as Obj).payload) : null;
    const baseState = {
      pinnedRootKeyids: [...(options.pinnedRootKeyids ?? [])],
      rootDocuments: rootDocs,
      keysetDocuments: tenantId !== '' ? { [tenantId]: keysetDocs } : {},
      lastTrusted: {},
      now: options.now,
      production: true,
    };
    const input = {
      payloadType: AUDIT_EXPORT_PAYLOAD_TYPE,
      payload: payloadBytes ?? Buffer.alloc(0),
      envelope: (signature ?? { payload: '', payloadType: '', signatures: [] }) as DsseEnvelope,
      purpose: 'statement',
      audience: tenantId,
      signedAt: generatedAt,
    } as const;
    let verdict: TrustVerdict = { status: 'unavailable', code: 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE' };
    try {
      verdict = verifyTrusted({
        ...input,
        state: {
          ...baseState,
          ...(options.customerPins !== undefined && tenantId !== '' ? { customerPins: { [tenantId]: options.customerPins } } : {}),
        },
      });
    } catch {
      verdict = { status: 'rejected', code: 'ATTESTA_TRUST_INPUT_INVALID' };
    }
    if (options.customerPins !== undefined && (options.pinnedRootKeyids ?? []).length > 0 && payloadBytes !== null) {
      try {
        const platformVerdict = verifyTrusted({ ...input, state: { ...baseState, production: true } });
        if (platformVerdict.status === 'verified' && platformVerdict.trusted?.platform !== undefined) {
          windowsPlatform = platformVerdict.trusted.platform;
        }
      } catch {
        windowsPlatform = undefined;
      }
    }
    if (verdict.status === 'verified') {
      trust = { id: 'trust', status: 'passed' };
      trusted = verdict.trusted;
    } else if (verdict.status === 'rejected') {
      trust = { id: 'trust', status: FAILED, detail_code: verdict.code };
    } else {
      trust = { id: 'trust', status: NOT_CHECKABLE, detail_code: verdict.code };
    }
    // The payload must be the JCS of {manifest, export_digest} over THIS export.
    let payloadOk = false;
    if (exportObj !== null && manifest !== null && payloadBytes !== null) {
      const exportText = jcs(exportObj);
      if (exportText !== null) {
        const recomputed = sha256Prefixed(exportText);
        const decoded = parseJson(payloadBytes.toString('utf8'));
        if (isObj(decoded)) {
          const manifestText = jcs(manifest);
          payloadOk = payloadBytes.toString('utf8') === jcs({ manifest, export_digest: recomputed })
            && manifestText !== null
            && manifestText === jcs(decoded.manifest)
            && decoded.export_digest === recomputed;
        }
      }
    }
    const payloadTypeOk = isObj(signature) && (signature as Obj).payloadType === AUDIT_EXPORT_PAYLOAD_TYPE;
    if (verdict.status === 'verified' && payloadOk && payloadTypeOk) {
      signatureCheck = { id: 'signature', status: 'passed' };
    } else {
      signatureCheck = { id: 'signature', status: FAILED, detail_code: 'ATTESTA_VERIFY_SIGNATURE_INVALID' };
    }
  }
  // Windows come ONLY from the root document the trust check accepted.
  const rootDocs = trustSection !== null && Array.isArray(trustSection.root_documents)
    ? (trustSection.root_documents as DsseEnvelope[]) : [];
  const windowDigest = trusted?.platform?.digest ?? windowsPlatform?.digest;
  const anchorWindows = windowDigest !== undefined
    ? anchorWindowsFor(rootDocs, windowDigest)
    : undefined;

  // --- 3. shape (keys, format, schema, section digests, counts, order, covered)
  let shape: AuditExportCheck = { id: 'shape', status: FAILED };
  let events: StoredAuditRow[] = [];
  let seals: ParsedSeal[] = [];
  // Best-effort parse for the later steps: they report their own breaks even when
  // the shape already failed (a tampered download fails loudly, never silently).
  for (const e of eventsRaw) {
    if (isObj(e)) events.push(e as unknown as StoredAuditRow);
  }
  for (const s of sealsRaw) {
    if (!isObj(s) || typeof s.seal_digest !== 'string' || typeof s.document !== 'string') continue;
    const doc = parseJson(s.document);
    seals.push({
      seq: typeof s.seq === 'number' ? s.seq : NaN,
      digest: s.seal_digest,
      doc: isObj(doc) ? doc as unknown as SealDocument : null,
      documentText: s.document,
    });
  }
  const sealWindows = (): Array<{ from: string; to: string }> => {
    const out: Array<{ from: string; to: string }> = [];
    for (const seal of seals) {
      const window = seal.doc !== null && isObj(seal.doc.window) ? seal.doc.window as Obj : null;
      if (window === null || typeof window.from !== 'string' || typeof window.to !== 'string') continue;
      out.push({ from: window.from, to: window.to });
    }
    return out;
  };
  {
    let ok = exportObj !== null && sortedKeys(exportObj) === EXPORT_KEYS;
    if (ok && (manifest === null || manifest.format !== AUDIT_EXPORT_FORMAT)) ok = false;
    let schemaMissing = false;
    if (ok && exportObj !== null) {
      let validate: ValidateFunction | null = null;
      try {
        validate = exportSchemaValidator();
      } catch {
        validate = null;
      }
      if (validate === null) {
        schemaMissing = true;
      } else if (validate(exportObj) !== true) {
        ok = false;
      }
    }
    if (ok && exportObj !== null && manifest !== null && isObj(manifest.sections)) {
      const sections = manifest.sections;
      for (const name of ['events', 'seals', 'seal_evidence'] as const) {
        const text = jcs(exportObj[name]);
        if (text === null || sections[name] !== sha256Prefixed(text)) {
          ok = false;
          break;
        }
      }
    } else if (ok) {
      ok = false;
    }
    if (ok && manifest !== null && exportObj !== null) {
      const statementsRaw: unknown[] = sealEvidence !== null && Array.isArray(sealEvidence.statements) ? sealEvidence.statements : [];
      const anchored = statementsRaw.filter((s) => isObj(s) && s.anchor_status === 'anchored').length;
      const windows = sealWindows();
      const inSeal = (at: unknown): boolean => typeof at === 'string'
        && windows.some((w) => at >= w.from && at < w.to);
      const sealed = eventsRaw.filter((e) => isObj(e) && inSeal(e.occurred_at)).length;
      const expected = {
        events: eventsRaw.length,
        seals: sealsRaw.length,
        sealed_events: sealed,
        unsealed_events: eventsRaw.length - sealed,
        anchored,
        pending: statementsRaw.length - anchored,
      };
      if (jcs(manifest.counts) !== jcs(expected)) ok = false;
      const seen = new Set<string>();
      let prevAt = '';
      let prevId = '';
      let first = true;
      for (const e of eventsRaw) {
        if (!isObj(e) || typeof e.occurred_at !== 'string' || typeof e.id !== 'string' || seen.has(e.id)) {
          ok = false;
          break;
        }
        seen.add(e.id);
        if (!first && (e.occurred_at < prevAt || (e.occurred_at === prevAt && e.id <= prevId))) {
          ok = false;
          break;
        }
        first = false;
        prevAt = e.occurred_at;
        prevId = e.id;
      }
      const scope = isObj(manifest.scope) ? manifest.scope : null;
      if (scope === null || typeof scope.from !== 'string' || typeof scope.to !== 'string'
        || !isObj(manifest.covered)) {
        ok = false;
      } else {
        const covered = manifest.covered as Obj;
        if (typeof covered.from !== 'string' || typeof covered.to !== 'string') {
          ok = false;
        } else {
          const scopeFrom = Date.parse(scope.from);
          const scopeTo = Date.parse(scope.to);
          const coveredFrom = Date.parse(covered.from);
          const coveredTo = Date.parse(covered.to);
          if (![scopeFrom, scopeTo, coveredFrom, coveredTo].every((t) => Number.isFinite(t))
            || coveredFrom > scopeFrom || scopeTo > coveredTo) {
            ok = false;
          } else {
            const widened = coveredRange(
              { from: scope.from, to: scope.to },
              sealWindows().map((w) => ({ windowFrom: w.from, windowTo: w.to })),
            );
            if (widened.from !== covered.from || widened.to !== covered.to) ok = false;
          }
        }
      }
    }
    if (schemaMissing) {
      schemaEnvFailed = true;
      shape = { id: 'shape', status: NOT_CHECKABLE, detail_code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };
    } else {
      shape = ok ? { id: 'shape', status: 'passed' } : { id: 'shape', status: FAILED, detail_code: 'AUDIT_EXPORT_SHAPE_INVALID' };
    }
  }

  // --- 4. seals (document checks, window order, previous links)
  let sealsCheck: AuditExportCheck = { id: 'seals', status: FAILED };
  const validDocs = new Map<string, SealDocument>();
  {
    let ok = true;
    const fail = (digest: string): void => {
      ok = false;
      breaks.push({ kind: 'statement_problem', seal_digest: digest });
    };
    for (const seal of seals) {
      const doc = seal.doc;
      const stored = doc !== null && isObj(doc.window) && typeof (doc.window as Obj).from === 'string'
        && typeof (doc.window as Obj).to === 'string'
        && (typeof doc.previous === 'string' || doc.previous === null) && typeof doc.count === 'number'
        ? {
          windowFrom: (doc.window as Obj).from as string, windowTo: (doc.window as Obj).to as string,
          rowCount: doc.count, previousDigest: doc.previous, sealDocument: seal.documentText,
          sealDigest: seal.digest, tenantId,
        }
        : null;
      const parsed = stored !== null ? parseSealDocument(stored) : null;
      if (parsed === null) {
        fail(seal.digest);
        continue;
      }
      validDocs.set(seal.digest, parsed);
    }
    for (let i = 1; i < seals.length; i += 1) {
      const prev = validDocs.get(seals[i - 1].digest);
      const doc = validDocs.get(seals[i].digest);
      if (!prev || !doc || doc.previous !== seals[i - 1].digest || doc.window.from !== prev.window.to) {
        ok = false;
        breaks.push({ kind: 'broken_previous', seal_digest: seals[i].digest });
      }
    }
    sealsCheck = ok
      ? { id: 'seals', status: 'passed' }
      : { id: 'seals', status: FAILED, detail_code: 'AUDIT_EXPORT_SEAL_INVALID' };
  }

  // --- 5. seal evidence (one statement and record per seal, signatures, anchors)
  let evidence: AuditExportCheck = { id: 'seal_evidence', status: FAILED };
  const rekorIsoBySeq = new Map<number, string>();
  const tsaIsoBySeq = new Map<number, string>();
  const recordsRaw: unknown[] = sealEvidence !== null && Array.isArray(sealEvidence.records) ? sealEvidence.records : [];
  const statementsRaw: unknown[] = sealEvidence !== null && Array.isArray(sealEvidence.statements) ? sealEvidence.statements : [];
  const anchorsRaw: unknown[] = sealEvidence !== null && Array.isArray(sealEvidence.anchors) ? sealEvidence.anchors : [];
  const batchesRaw: unknown[] = sealEvidence !== null && Array.isArray(sealEvidence.anchor_batches) ? sealEvidence.anchor_batches : [];
  {
    let hardCode: string | undefined;
    let softCode: string | undefined;
    let broke = false;
    const failHard = (code: string): void => {
      if (hardCode === undefined) hardCode = code;
    };
    const failSoft = (code: string): void => {
      if (softCode === undefined) softCode = code;
    };
    const breakSeal = (digest: string): void => {
      broke = true;
      breaks.push({ kind: 'statement_problem', seal_digest: digest });
    };
    const statementsBySeq = new Map<number, ParsedStatement[]>();
    for (const s of statementsRaw) {
      if (!isObj(s) || typeof s.seq !== 'number' || !Number.isInteger(s.seq)
        || typeof s.statement_digest !== 'string' || typeof s.statement_canonical !== 'string'
        || !isObj(s.envelope) || typeof s.anchor_status !== 'string') {
        failHard('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        continue;
      }
      const list = statementsBySeq.get(s.seq) ?? [];
      list.push({
        seq: s.seq, statementDigest: s.statement_digest, statementCanonical: s.statement_canonical,
        envelope: s.envelope as unknown as DsseEnvelope, anchorStatus: s.anchor_status,
      });
      statementsBySeq.set(s.seq, list);
    }
    const recordsBySeq = new Map<number, ParsedRecord[]>();
    for (const r of recordsRaw) {
      if (!isObj(r) || typeof r.seq !== 'number' || !Number.isInteger(r.seq)
        || typeof r.record_hash !== 'string' || typeof r.prev_hash !== 'string' || typeof r.canonical_record !== 'string') {
        failHard('ATTESTA_VERIFY_RECORD_HASH_MISMATCH');
        continue;
      }
      const parsed = parseJson(r.canonical_record);
      const list = recordsBySeq.get(r.seq) ?? [];
      list.push({
        seq: r.seq, recordHash: r.record_hash, prevHash: r.prev_hash,
        canonicalRecord: r.canonical_record, parsed: isObj(parsed) ? parsed : null,
      });
      recordsBySeq.set(r.seq, list);
    }
    const batchById = new Map<string, Obj>();
    for (const b of batchesRaw) {
      if (isObj(b) && typeof b.batch_id === 'string') batchById.set(b.batch_id, b);
    }
    const rootDocs = trustSection !== null && Array.isArray(trustSection.root_documents)
      ? (trustSection.root_documents as DsseEnvelope[]) : [];
    const keysetDocs = trustSection !== null && Array.isArray(trustSection.keyset_documents)
      ? (trustSection.keyset_documents as DsseEnvelope[]) : [];
    let sealValidatorsOk = true;
    try {
      sealValidators();
    } catch {
      sealValidatorsOk = false;
    }

    for (const seal of seals) {
      const seq = seal.seq;
      const digest = seal.digest;
      const doc = validDocs.get(digest) ?? null;
      // A corrupt document is already reported by the seals step; nothing more to check here.
      if (doc === null) continue;
      const statements = Number.isInteger(seq) ? (statementsBySeq.get(seq) ?? []) : [];
      const records = Number.isInteger(seq) ? (recordsBySeq.get(seq) ?? []) : [];
      if (!Number.isInteger(seq) || statements.length !== 1 || records.length !== 1) {
        failHard('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        breakSeal(digest);
        continue;
      }
      const st = statements[0];
      const rec = records[0];
      // The statement names its bytes; the record names the statement.
      if (!isDigest(st.statementDigest) || sha256Prefixed(st.statementCanonical) !== st.statementDigest) {
        failHard('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        breakSeal(digest);
        continue;
      }
      const recParsed = rec.parsed;
      let recordOk = false;
      if (recParsed !== null && isDigest(rec.recordHash) && isDigest(rec.prevHash)) {
        try {
          recordOk = computeRecordHash(rec.canonicalRecord, rec.prevHash) === rec.recordHash
            && recParsed.seq === seq
            && recParsed.tenant_id === tenantId
            && recParsed.statement_digest === st.statementDigest
            && recParsed.predicate_type === AUDIT_SEAL_PREDICATE_TYPE
            && recParsed.statement_kind === null
            && recParsed.repository_id === null
            && recParsed.subject_sha === null
            && recParsed.outbox_subject_id === null;
        } catch {
          recordOk = false;
        }
      }
      if (!recordOk) {
        failHard('ATTESTA_VERIFY_RECORD_HASH_MISMATCH');
        breakSeal(digest);
        continue;
      }
      // The statement: canonical bytes, schema, AS1–AS2 against the document.
      const payloadBytes = decodeB64((st.envelope as unknown as Obj).payload);
      const snapshot = parseJson(st.statementCanonical);
      const snapshotObj = isObj(snapshot) ? snapshot : null;
      const subjects = snapshotObj !== null ? snapshotObj.subject : undefined;
      const subject = Array.isArray(subjects) && subjects.length === 1 && isObj(subjects[0]) ? subjects[0] as Obj : null;
      const predicate = snapshotObj !== null && isObj(snapshotObj.predicate) ? snapshotObj.predicate as Obj : null;
      const subjectDigest = subject !== null && isObj(subject.digest) ? subject.digest as Obj : null;
      let statementOk = payloadBytes !== null && payloadBytes.toString('utf8') === st.statementCanonical
        && snapshotObj !== null && jcs(snapshot) === st.statementCanonical
        && subject !== null && predicate !== null && subjectDigest !== null
        && snapshotObj.predicateType === AUDIT_SEAL_PREDICATE_TYPE
        && subject.name === `trackai:tenant/${tenantId}/audit/${doc?.window.from ?? ''}..${doc?.window.to ?? ''}`
        && subjectDigest.sha256 === digest.slice('sha256:'.length)
        && predicate.tenant_id === tenantId
        && JSON.stringify(predicate.window) === JSON.stringify(doc?.window ?? null)
        && predicate.count === doc?.count && predicate.rows_root === doc?.rows_root
        && predicate.catalog_version === doc?.catalog_version && predicate.previous_seal === (doc?.previous ?? null);
      if (statementOk) {
        if (!sealValidatorsOk) {
          failSoft('ATTESTA_VERIFY_NOT_CHECKABLE');
          continue;
        }
        try {
          if (!sealValidators().statement(snapshot)) statementOk = false;
        } catch {
          statementOk = false;
        }
      }
      if (!statementOk) {
        failHard('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        breakSeal(digest);
        continue;
      }
      // Anchors for this record: rows name an existing batch and prove inclusion.
      const rows = anchorsRaw.filter((a) => isObj(a) && a.seq === seq);
      let rekorOk = false;
      let tsaOk = false;
      let anchorInvalid = false;
      for (const raw of rows) {
        const a = raw as Obj;
        if (typeof a.anchor_type !== 'string' || typeof a.batch_id !== 'string') {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          anchorInvalid = true;
          continue;
        }
        const batch = batchById.get(a.batch_id);
        if (batch === undefined || typeof batch.seq_from !== 'number' || typeof batch.seq_to !== 'number'
          || typeof batch.leaf_count !== 'number' || !Number.isInteger(batch.seq_from) || !Number.isInteger(batch.seq_to)
          || !Number.isInteger(batch.leaf_count) || batch.leaf_count < 1
          || batch.seq_to - batch.seq_from + 1 !== batch.leaf_count
          || a.batch_id !== `${tenantId}:${batch.seq_from}-${batch.seq_to}`
          || !isDigest(batch.merkle_root)) {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          anchorInvalid = true;
          continue;
        }
        const proof = isObj(a.inclusion_proof) ? a.inclusion_proof as Obj : null;
        const merkle = proof !== null && isObj(proof.merkle) ? proof.merkle as Obj : null;
        if (proof === null || merkle === null || merkle.leaf_index !== seq - (batch.seq_from as number)
          || merkle.tree_size !== batch.leaf_count) {
          failHard('ATTESTA_VERIFY_MERKLE_PROOF_INVALID');
          anchorInvalid = true;
          continue;
        }
        const parsed = rec.parsed;
        const recordedAt = parsed !== null && typeof parsed.recorded_at === 'string' ? parsed.recorded_at as string : null;
        const claimedTime = anchorClaimTimeMs(a);
        const recordedMs = recordedAt !== null ? parseTimestamp(recordedAt) : null;
        if (recordedMs === null || claimedTime === null || claimedTime < recordedMs - ANCHOR_SKEW_MS) {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          anchorInvalid = true;
          continue;
        }
        const row: StoredAnchorRow = {
          anchorType: a.anchor_type as string,
          proof: proof as unknown,
          recordHash: rec.recordHash,
          merkleRoot: batch.merkle_root as string,
          rekorEntryUuid: (a.rekor_entry_uuid as string | null) ?? null,
          tsaTokenB64: (a.tsa_token_b64 as string | null) ?? null,
        };
        const keys: StoredAnchorKeys = {
          ...(rekorLogKey !== undefined ? { rekorLogKey } : {}),
          ...(userOffsets !== undefined ? { rekorLogIndexOffsets: userOffsets } : {}),
          ...(anchorWindows !== undefined ? { anchorKeyWindows: anchorWindows } : {}),
          ...(tsaAnchors !== undefined ? { tsaAnchors } : {}),
        };
        let checked;
        try {
          checked = verifyStoredAnchor(row, keys);
        } catch {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          anchorInvalid = true;
          continue;
        }
        if (checked.status === 'valid') {
          if (row.anchorType === 'rekor') {
            rekorOk = true;
            const iso = rekorTimeIso(proof);
            if (iso !== null) rekorIsoBySeq.set(seq, iso);
          } else if (row.anchorType === 'tsa') {
            tsaOk = true;
            const iso = tsaTimeIso(proof);
            if (iso !== null) tsaIsoBySeq.set(seq, iso);
          } else {
            failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
            anchorInvalid = true;
          }
        } else if (checked.status === 'invalid') {
          failHard(checked.code);
          anchorInvalid = true;
        } else {
          failSoft('ATTESTA_VERIFY_NOT_CHECKABLE');
        }
      }
      if (st.anchorStatus !== 'anchored' && st.anchorStatus !== 'pending') {
        failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
        breakSeal(digest);
        continue;
      }
      if (st.anchorStatus === 'pending') {
        // Proven after all is a lie; otherwise pending reads not_checkable, never a break.
        if (rekorOk || tsaOk) {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          breakSeal(digest);
        } else {
          failSoft('ATTESTA_VERIFY_NOT_CHECKABLE');
        }
        continue;
      }
      if (anchorInvalid) {
        breakSeal(digest);
        continue;
      }
      if (!rekorOk || !tsaOk) {
        if ((rekorOk === false && rekorLogKey === undefined) || (tsaOk === false && tsaAnchors === undefined)) {
          failSoft('ATTESTA_VERIFY_NOT_CHECKABLE');
        } else {
          failHard('ATTESTA_VERIFY_ANCHOR_INVALID');
          breakSeal(digest);
        }
        continue;
      }
      // The statement signature, with the record's anchor time as bound evidence.
      const parsed = rec.parsed;
      const recordedAt = parsed !== null && typeof parsed.recorded_at === 'string' ? parsed.recorded_at as string : '';
      const timeEvidence: TimeEvidence | undefined = rekorIsoBySeq.get(seq) !== undefined
        ? { kind: 'rekor_integrated_time', time: rekorIsoBySeq.get(seq) as string, binds: 'ledger_statement', digest: sha256Prefixed(payloadBytes as Buffer) }
        : tsaIsoBySeq.get(seq) !== undefined
          ? { kind: 'tsa_gen_time', time: tsaIsoBySeq.get(seq) as string, binds: 'ledger_statement', digest: sha256Prefixed(payloadBytes as Buffer) }
          : undefined;
      let verdict: TrustVerdict;
      try {
        verdict = verifyTrusted({
          payloadType: IN_TOTO_PAYLOAD_TYPE,
          payload: payloadBytes as Buffer,
          envelope: st.envelope,
          purpose: 'statement',
          audience: tenantId,
          signedAt: recordedAt,
          ...(timeEvidence !== undefined ? { timeEvidence } : {}),
          state: {
            pinnedRootKeyids: [...(options.pinnedRootKeyids ?? [])],
            rootDocuments: rootDocs,
            keysetDocuments: tenantId !== '' ? { [tenantId]: keysetDocs } : {},
            ...(options.customerPins !== undefined && tenantId !== '' ? { customerPins: { [tenantId]: options.customerPins } } : {}),
            lastTrusted: {},
            now: options.now,
            production: true,
          },
        });
      } catch {
        failHard('ATTESTA_VERIFY_SIGNATURE_INVALID');
        breakSeal(digest);
        continue;
      }
      if (verdict.status !== 'verified') {
        if ((TRUST_CODE_STATUS as Record<string, string>)[verdict.code] === 'unavailable') {
          failSoft(verdict.code);
        } else {
          failHard(verdict.code);
          breakSeal(digest);
        }
      }
    }
    if (hardCode !== undefined || broke) {
      evidence = { id: 'seal_evidence', status: FAILED, ...(hardCode !== undefined ? { detail_code: hardCode } : {}) };
    } else if (softCode !== undefined) {
      evidence = { id: 'seal_evidence', status: NOT_CHECKABLE, detail_code: softCode };
    } else {
      evidence = { id: 'seal_evidence', status: 'passed' };
    }
  }

  // --- 6. events against seals (missing, changed, late-inserted rows)
  let eventsCheck: AuditExportCheck = { id: 'events', status: FAILED };
  let unsealedCount = 0;
  {
    let ok = true;
    const stepBreaks: AuditExportBreak[] = [];
    const covered = manifest !== null && isObj(manifest.covered) ? manifest.covered as Obj : null;
    const coveredFrom = covered !== null && typeof covered.from === 'string' ? covered.from : null;
    const coveredTo = covered !== null && typeof covered.to === 'string' ? covered.to : null;
    const inCovered = (at: unknown): boolean => typeof at === 'string'
      && coveredFrom !== null && coveredTo !== null && at >= coveredFrom && at < coveredTo;
    const windows = seals
      .map((seal) => ({ digest: seal.digest, doc: validDocs.get(seal.digest) ?? null }))
      .filter((w): w is { digest: string; doc: SealDocument } => w.doc !== null);
    for (const e of events) {
      if (!inCovered((e as StoredAuditRow).occurred_at)) ok = false;
    }
    const inAnyWindow = (at: string): boolean => windows.some((w) => at >= w.doc.window.from && at < w.doc.window.to);
    unsealedCount = events.filter((e) => !inAnyWindow((e as StoredAuditRow).occurred_at)).length;
    windows.forEach((w, index) => {
      const current = events.filter((e) => {
        const at = (e as StoredAuditRow).occurred_at;
        return typeof at === 'string' && at >= w.doc.window.from && at < w.doc.window.to;
      });
      if (index === 0 && w.doc.previous === null) {
        for (const e of events) {
          const at = (e as StoredAuditRow).occurred_at;
          if (typeof at === 'string' && at < w.doc.window.from && !current.includes(e)) current.push(e);
        }
      }
      try {
        for (const b of checkSealRows(w.doc, w.digest, current)) {
          ok = false;
          stepBreaks.push({ kind: b.kind, seal_digest: b.seal ?? '', ...(b.row_id !== undefined ? { row_id: b.row_id } : {}) });
        }
      } catch {
        ok = false;
      }
    });
    breaks.push(...stepBreaks);
    if (!ok) {
      eventsCheck = {
        id: 'events', status: FAILED,
        detail_code: stepBreaks.length > 0 ? stepBreaks[0].kind : 'AUDIT_EXPORT_EVENTS_INVALID',
      };
    } else {
      eventsCheck = { id: 'events', status: 'passed' };
    }
  }

  const checks: AuditExportCheck[] = [trust, signatureCheck, shape, sealsCheck, evidence, eventsCheck];
  const failed = checks.some((c) => c.status === FAILED) || breaks.length > 0;
  const result = failed ? 'failed' : checks.some((c) => c.status === NOT_CHECKABLE) ? 'not_checkable' : 'passed';
  return {
    exit_code: result === 'failed' ? 1 : result === 'not_checkable' ? 2 : 0,
    checks,
    breaks,
    unsealed: { count: unsealedCount },
    ...(schemaEnvFailed ? { verifier_error: 'contract schemas unavailable' } : {}),
  };
}
