/**
 * Offline evidence-pack verifier (Task15j, A15.10; docs/contracts/attesta/evidence-pack.md
 * "What a verifier checks").
 *
 * A pure function an acquirer's counsel runs on a laptop with no TrackAI account and no
 * network: `verifyEvidencePack(download, options)` says whether `{pack, signature}` is
 * genuine and complete. Exit codes 0 (passed), 1 (broken) and 2 (not checkable) follow the
 * ported source. Only the user's pin, Rekor key and TSA anchors are trusted; every value
 * inside the pack is a claim, so each check is written with the test that would pass if
 * the check were forgotten. This function never throws and never reads a file, a clock
 * or the network (`options.now` is the clock).
 *
 * Ported from SushiCorp services/anchoring/offline_verify.py @ 0bd67a5 (catalog EV-2)
 * - Node instead of Python;
 * - the trust documents travel in the pack, but the pin is the user's;
 * - DSSE and in-toto instead of JCS records;
 * - two pack modes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  GENESIS_PREV_HASH,
  canonicalize,
  computeRecordHash,
  sha256Prefixed,
} from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, type DsseEnvelope } from './dsse';
import {
  TRUST_CODE_STATUS,
  verifyTrusted,
  type CustomerPinnedKey,
  type TimeEvidence,
  type TrustedDocumentRef,
  type TrustVerdict,
} from './trust-contract';
import { DIGEST_RE, UUID_RE, parseTimestamp, parseTrustDocument } from './trust-documents';
import {
  verifyStoredAnchor,
  type AnchorKeyWindow,
  type StoredAnchorKeys,
  type StoredAnchorRow,
} from './anchor-dual';
import { loadLogPublicKey } from './anchor-rekor';
import { loadTrustAnchors } from './anchor-tsa';
import { checkStatementRules } from './contract-rules';

// ---------------------------------------------------------------------------
// Copied constants (never import the builder, service or env: they pull in the database)
// ---------------------------------------------------------------------------

/** docs/contracts/attesta/evidence-pack.md: the pack format URI. */
const EVIDENCE_PACK_FORMAT = 'https://trackai.dev/attesta/evidence-pack/v1';
/** The RP-1 pack signature payload type (differs from statements' on purpose). */
const EVIDENCE_PACK_PAYLOAD_TYPE = 'application/vnd.trackai.evidence-pack+json';
/** `to` must be this far before `generated_at` (writers stamp `recorded_at` pre-commit). */
const PACK_SETTLE_MS = 300_000;
/** Pending anchors older than this at `generated_at` are missing, not young. */
const DEFAULT_ANCHOR_WINDOW_MS = 3_600_000;
/** Anchor times may lag `recorded_at` by this much (writer and log clock skew). */
const ANCHOR_SKEW_MS = 300_000;
/** Pack top-level keys, sorted (evidence-pack.md "The pack"). */
const PACK_KEYS = [
  'anchor_batches',
  'anchors',
  'manifest',
  'records',
  'reports',
  'statements',
  'trust',
  'verification_hint',
  'verifier',
];
/** Manifest section names carrying a SHA-256 in `manifest.sections`. */
const SECTION_NAMES = [
  'records',
  'statements',
  'anchors',
  'anchor_batches',
  'trust',
  'verification_hint',
  'reports',
  'verifier',
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything the verifier trusts. The pin, keys and anchors are the user's, never the pack's. */
export interface OfflineVerifyOptions {
  /** Root keyids pinned out of band (required unless `customerPins` is given). */
  pinnedRootKeyids: readonly string[];
  /** Customer pins for the pack's tenant (replaces the platform key set for it). */
  customerPins?: readonly CustomerPinnedKey[];
  /** The Rekor log's public key (PEM, from Sigstore). Without it Rekor rows are not checkable. */
  rekorLogKeyPem?: string;
  /** The TSA trust anchors (PEM bundle, from the TSA). Without them TSA rows are not checkable. */
  tsaAnchorsPem?: string;
  /** Persisted from a previous `trusted` (rollback and fork protection). */
  lastTrusted?: Readonly<Record<string, TrustedDocumentRef>>;
  /** Persisted from a previous `trustedTime` (a rolled-back clock cannot revive documents). */
  trustedTimeFloor?: string;
  /** The check time, RFC 3339 UTC with milliseconds (the CLI passes the real clock). */
  now: string;
  /** Pending age at `generated_at` past which a missing anchor is a break (default 1 hour). */
  anchorWindowMs?: number;
  /**
   * Pinned Rekor shard offsets (`{"<decimal tree id>": <offset>}`, as a checkpoint
   * prints the tree ID), supplied by the user like the log key. The pack's own value
   * is attacker-controlled and only cross-checked (a mismatch warns). Without this,
   * entries verify with offset 0 (unsharded trees).
   */
  rekorLogIndexOffsets?: Readonly<Record<string, number>>;
}

export type OfflineCheckStatus = 'passed' | 'failed' | 'not_checkable' | 'warning';

/** One check's outcome: codes, seqs and counts only, never statement contents or key material. */
export interface OfflineCheck {
  id:
    | 'trust_and_signature'
    | 'structure'
    | 'chain'
    | 'completeness'
    | 'statements'
    | 'anchors'
    | 'reports';
  status: OfflineCheckStatus;
  code?: string;
  count?: number;
}

export interface OfflineReport {
  report_version: 1;
  result: 'passed' | 'failed' | 'not_checkable';
  exit_code: 0 | 1 | 2;
  tenant_id: string;
  pack_id: string;
  generated_at: string;
  checks: OfflineCheck[];
  counts: { records: number; statements: number; anchors_verified: number };
  /** Newest documents accepted by the trust check: persist into `lastTrusted` once accepted. */
  trusted?: Record<string, TrustedDocumentRef>;
  /** max(`trustedTimeFloor`, `now`): persist as the next floor once accepted. */
  trustedTime?: string;
  /**
   * The verifier itself is broken (its schema files are missing, or an unexpected
   * failure escaped the checks): a fixed generic message, never pack contents. The
   * CLI prints it as `verifier error: <message>`. Absent when only the pack was judged.
   */
  verifier_error?: string;
}

// ---------------------------------------------------------------------------
// Small helpers (the pack is attacker-controlled: nothing here throws)
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
// Schema validators (the builder's ajv setup, copied; the builder pulls in the database)
// ---------------------------------------------------------------------------

/** Test-only schema directory override (see __setSchemaDirForTests). */
let schemaDirOverride: string | undefined;

function contractDir(): string {
  // Test seam only (__setSchemaDirForTests): points the walk at an empty directory
  // so tests can prove environment failures read not_checkable, never failed.
  let dir: string = schemaDirOverride ?? __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs', 'contracts', 'attesta');
    if (existsSync(join(candidate, 'evidence-pack-v1.schema.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('docs/contracts/attesta not found above the verifier');
}

/** Test-only override for the schema directory (resets the cached validators). */
export function __setSchemaDirForTests(dir: string | undefined): void {
  schemaDirOverride = dir;
  packValidator = null;
  statementValidator = null;
  reportStatementValidator = null;
}

let packValidator: ValidateFunction | null = null;
function evidencePackValidator(): ValidateFunction {
  if (packValidator) return packValidator;
  const dir = contractDir();
  const schema = JSON.parse(readFileSync(join(dir, 'evidence-pack-v1.schema.json'), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  packValidator = ajv.compile(schema);
  return packValidator;
}

let statementValidator: ValidateFunction | null = null;
function statementSchemaValidator(): ValidateFunction {
  if (statementValidator) return statementValidator;
  const dir = contractDir();
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  ajv.addSchema(load('predicate-ai-provenance-v1.schema.json'));
  statementValidator = ajv.compile(load('statement-v1.schema.json'));
  return statementValidator;
}

/** Task15i4: a period_report statement in a pack is checked against its own frozen schema. */
const PERIOD_REPORT_TYPE = 'https://trackai.dev/attesta/period-report/v1';
let reportStatementValidator: ValidateFunction | null = null;
function reportSchemaValidator(): ValidateFunction {
  if (reportStatementValidator) return reportStatementValidator;
  const dir = contractDir();
  const predicate = JSON.parse(readFileSync(join(dir, 'predicate-period-report-v1.schema.json'), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  ajv.addSchema(predicate);
  reportStatementValidator = ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` });
  return reportStatementValidator;
}

/** Task16e: an audit_seal statement in a whole-tenant pack is checked against its own frozen schema. */
const AUDIT_SEAL_TYPE = 'https://trackai.dev/attesta/audit-seal/v1';
let sealStatementValidator: ValidateFunction | null = null;
function sealSchemaValidator(): ValidateFunction {
  if (sealStatementValidator) return sealStatementValidator;
  const predicate = JSON.parse(readFileSync(join(contractDir(), 'predicate-audit-seal-v1.schema.json'), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  ajv.addSchema(predicate);
  sealStatementValidator = ajv.compile({ $ref: `${String(predicate.$id)}#/definitions/statement` });
  return sealStatementValidator;
}

// ---------------------------------------------------------------------------
// Copied rules (never import anchor-env or trust-resolver: they pull in server config)
// ---------------------------------------------------------------------------

/**
 * `{"<decimal tree id>": <offset>}` to the 16-hex form the Rekor check looks up.
 * The rule is copied from anchor-env.ts `parseLogIndexOffsets` (decimal tree IDs as the
 * checkpoint prints them, each naming one tree). Applied to the USER's offsets only:
 * the pack's value is attacker-controlled and never feeds verification.
 */
/** Task16f2: reused by the offline audit-export verifier (no behaviour change). */
export function decimalOffsetsToHex(raw: unknown): { offsets?: Record<string, number>; bad: boolean } {
  if (raw === null || raw === undefined) return { bad: false };
  if (!isObj(raw)) return { bad: true };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[0-9]{1,20}$/.test(k)) return { bad: true };
    try {
      if (BigInt(k) > 0xffffffffffffffffn) return { bad: true };
    } catch {
      return { bad: true };
    }
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return { bad: true };
    const hex = BigInt(k).toString(16).padStart(16, '0');
    if (Object.prototype.hasOwnProperty.call(out, hex)) return { bad: true };
    out[hex] = v;
  }
  return { offsets: out, bad: false };
}

/**
 * Anchoring-key windows from the trust-verified newest root document. The rule is copied
 * from trust-resolver.ts `platformKeyWindows`: an active key signs until replaced;
 * anything else stops at `revoked_at` (`retired`, `superseded`) or `compromised_since`.
 * Undefined when no root was accepted (then Rekor rows are not checkable, never valid:
 * the pack's own key list is attacker-controlled).
 */
/** Task16f2: reused by the offline audit-export verifier (no behaviour change). */
export function anchorWindowsFor(roots: DsseEnvelope[], digest: string): AnchorKeyWindow[] | undefined {
  const match = roots.find((d) => {
    if (!isObj(d) || typeof d.payload !== 'string') return false;
    const raw = decodeB64(d.payload);
    return raw !== null && sha256Prefixed(raw) === digest;
  });
  if (match === undefined) return undefined;
  try {
    const parsed = parseTrustDocument(match);
    return [...parsed.keys.values()]
      .filter((k) => k.entry.purpose === 'anchor')
      .map((k) => ({
        spkiDer: Buffer.from(k.entry.spki_der_b64, 'base64'),
        notBeforeMs: k.notBefore,
        notAfterMs: k.notAfter,
        untilMs: k.entry.status === 'active'
          ? null
          : k.entry.revocation_reason === 'compromised'
            ? k.compromisedSince
            : k.revokedAt,
      }));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

interface ParsedRecord {
  seq: number;
  recordHash: string;
  parsed: Obj | null;
}

const FAILED: OfflineCheckStatus = 'failed';
const NOT_CHECKABLE: OfflineCheckStatus = 'not_checkable';
const WARNING: OfflineCheckStatus = 'warning';

/** Check one download; never throws (attacker input is data, not an exception). */
export function verifyEvidencePack(download: unknown, options: OfflineVerifyOptions): OfflineReport {
  try {
    return verify(download, options);
  } catch {
    // The verifier itself failed (never the pack's verdict): not checkable, never
    // a break. Every check carries the code; the CLI prints verifier_error.
    const nc = (id: OfflineCheck['id'], count?: number): OfflineCheck => ({
      id, status: NOT_CHECKABLE, code: 'ATTESTA_VERIFY_NOT_CHECKABLE', ...(count !== undefined ? { count } : {}),
    });
    return {
      report_version: 1,
      result: 'not_checkable',
      exit_code: 2,
      tenant_id: '',
      pack_id: '',
      generated_at: '',
      checks: [nc('trust_and_signature'), nc('structure'), nc('chain'), nc('completeness'), nc('statements', 0), nc('anchors', 0), nc('reports')],
      counts: { records: 0, statements: 0, anchors_verified: 0 },
      verifier_error: 'unexpected verifier failure',
    };
  }
}

function verify(download: unknown, options: OfflineVerifyOptions): OfflineReport {
  const windowMs = options.anchorWindowMs ?? DEFAULT_ANCHOR_WINDOW_MS;
  // Set when the verifier's own schema files cannot be loaded: the affected checks
  // read not_checkable (never failed), and the report carries verifier_error.
  let schemaEnvFailed = false;

  // --- download shape (attacker bytes first; every check below assumes as little as possible)
  const dl = isObj(download) ? download : null;
  const pack = dl !== null && isObj(dl.pack) ? dl.pack : null;
  const signature = dl !== null && isObj(dl.signature) ? (dl.signature as unknown as DsseEnvelope) : null;
  const shapeOk = dl !== null && sortedKeys(dl) === 'pack,signature' && pack !== null && sortedKeys(pack) === PACK_KEYS.join();

  const manifest = pack !== null && isObj(pack.manifest) ? pack.manifest : null;
  const tenantId = manifest !== null && typeof manifest.tenant_id === 'string' ? manifest.tenant_id : '';
  const packId = manifest !== null && typeof manifest.pack_id === 'string' ? manifest.pack_id : '';
  const generatedAt = manifest !== null && typeof manifest.generated_at === 'string' ? manifest.generated_at : '';
  const recordsRaw: unknown[] = pack !== null && Array.isArray(pack.records) ? pack.records : [];
  const statementsRaw: unknown[] = pack !== null && Array.isArray(pack.statements) ? pack.statements : [];
  const trustSection = pack !== null && isObj(pack.trust) ? pack.trust : null;

  // --- 1. trust_and_signature (verifyTrusted with the USER's pin, production hard-coded)
  let trust: OfflineCheck = { id: 'trust_and_signature', status: FAILED };
  let trusted: Record<string, TrustedDocumentRef> | undefined;
  let trustedTime: string | undefined;
  // With customer pins the platform root is skipped (trust.md step 2), so no
  // trusted.platform comes back. A second call without the pins, verified or not,
  // supplies anchor windows only; the verdict above still decides this check.
  let windowsPlatform: TrustedDocumentRef | undefined;
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
      lastTrusted: options.lastTrusted ?? {},
      now: options.now,
      ...(options.trustedTimeFloor !== undefined ? { trustedTimeFloor: options.trustedTimeFloor } : {}),
      production: true,
    };
    const input = {
      payloadType: EVIDENCE_PACK_PAYLOAD_TYPE,
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
    // The payload must be the JCS of {manifest, pack_digest} over THIS pack.
    let payloadOk = false;
    if (pack !== null && manifest !== null && payloadBytes !== null) {
      const packText = jcs(pack);
      if (packText !== null) {
        const recomputed = sha256Prefixed(packText);
        const decoded = parseJson(payloadBytes.toString('utf8'));
        if (isObj(decoded)) {
          const manifestText = jcs(manifest);
          payloadOk = payloadBytes.toString('utf8') === jcs({ manifest, pack_digest: recomputed })
            && manifestText !== null
            && manifestText === jcs(decoded.manifest)
            && decoded.pack_digest === recomputed;
        }
      }
    }
    if (verdict.status === 'verified' && payloadOk) {
      trust = { id: 'trust_and_signature', status: 'passed' };
      trusted = verdict.trusted;
      trustedTime = verdict.trustedTime;
    } else if (verdict.status === 'verified') {
      // Signed by a trusted key, but over other bytes: this pack was altered after signing.
      trust = { id: 'trust_and_signature', status: FAILED, code: 'ATTESTA_VERIFY_SIGNATURE_INVALID' };
    } else if (verdict.status === 'rejected') {
      trust = { id: 'trust_and_signature', status: FAILED, code: verdict.code };
    } else {
      trust = { id: 'trust_and_signature', status: NOT_CHECKABLE, code: verdict.code };
    }
  }

  // --- 2. structure (keys, format, schema, section digests, counts, duplicates)
  let structure: OfflineCheck = { id: 'structure', status: FAILED };
  {
    let ok = shapeOk;
    if (ok && (manifest === null || manifest.format !== EVIDENCE_PACK_FORMAT)) ok = false;
    let schemaMissing = false;
    if (ok && pack !== null) {
      let validate: ValidateFunction | null = null;
      try {
        validate = evidencePackValidator();
      } catch {
        validate = null;
      }
      if (validate === null) {
        schemaMissing = true;
      } else if (validate(pack) !== true) {
        try {
          // v1 freezes `reports: []`; a pack carrying period reports (Task15i4) is
          // well-formed future data this verifier cannot check, so schema errors
          // confined to `/reports` defer to the reports check (not_checkable),
          // never to a structure break.
          const errs = (validate.errors ?? []) as Array<{ instancePath?: string }>;
          const onlyReports = errs.length > 0 && errs.every((e) => (e.instancePath ?? '').split('/')[1] === 'reports');
          if (!onlyReports) ok = false;
        } catch {
          ok = false;
        }
      }
    }
    if (ok && pack !== null && manifest !== null && isObj(manifest.sections)) {
      const sections = manifest.sections;
      for (const name of SECTION_NAMES) {
        const text = jcs(pack[name]);
        if (text === null || sections[name] !== sha256Prefixed(text)) {
          ok = false;
          break;
        }
      }
    } else if (ok) {
      ok = false;
    }
    if (ok && manifest !== null && pack !== null) {
      if (jcs(manifest.counts) !== jcs(expectedCounts(pack))) ok = false;
      const scope = isObj(manifest.scope) ? manifest.scope : null;
      const mode = scope !== null ? scope.mode : undefined;
      const completeness = manifest.completeness;
      if (!((mode === 'full' && completeness === 'provable') || (mode === 'repository_only' && completeness === 'not_provable'))) ok = false;
      const seen = new Set<number>();
      for (const s of statementsRaw) {
        const seq = isObj(s) && typeof s.seq === 'number' ? s.seq : NaN;
        if (!Number.isInteger(seq) || seen.has(seq)) {
          ok = false;
          break;
        }
        seen.add(seq);
      }
    }
    if (schemaMissing) {
      schemaEnvFailed = true;
      structure = { id: 'structure', status: NOT_CHECKABLE, code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };
    } else {
      structure = ok ? { id: 'structure', status: 'passed' } : { id: 'structure', status: FAILED };
    }
  }

  // --- 3. chain (contiguous seq, links, recomputed hashes, canonical form, head)
  let chain: OfflineCheck = { id: 'chain', status: FAILED };
  let chainCode: string | undefined;
  const parsedBySeq = new Map<number, Obj>();
  const recordHashBySeq = new Map<number, string>();
  const orderedRecords: ParsedRecord[] = [];
  {
    const fail = (code: string): void => {
      if (chainCode === undefined) chainCode = code;
    };
    let ok = pack !== null && manifest !== null && isObj(manifest.chain_range);
    const range = manifest !== null && isObj(manifest.chain_range) ? manifest.chain_range : null;
    const fromSeq = range !== null && typeof range.from_seq === 'number' ? range.from_seq : NaN;
    const toSeq = range !== null && typeof range.to_seq === 'number' ? range.to_seq : NaN;
    const prevHash = range !== null && typeof range.prev_hash === 'string' ? range.prev_hash : '';
    const head: unknown = range !== null ? range.head : undefined;
    if (!ok || !Number.isInteger(fromSeq) || fromSeq < 0 || !Number.isInteger(toSeq) || toSeq < -1) {
      ok = false;
      fail('ATTESTA_VERIFY_SEQ_GAP');
    }
    if (ok && recordsRaw.length !== Math.max(0, toSeq - fromSeq + 1)) {
      ok = false;
      fail('ATTESTA_VERIFY_SEQ_GAP');
    }
    if (ok && fromSeq === 0 && prevHash !== GENESIS_PREV_HASH) {
      ok = false;
      fail('ATTESTA_VERIFY_PREV_HASH_MISMATCH');
    }
    let prev = prevHash;
    if (ok) {
      recordsRaw.forEach((raw, i) => {
        const r = isObj(raw) ? raw : null;
        const seq = r !== null && typeof r.seq === 'number' ? r.seq : NaN;
        const rh = r !== null && typeof r.prev_hash === 'string' ? r.prev_hash : '';
        const hash = r !== null && typeof r.record_hash === 'string' ? r.record_hash : '';
        if (r === null || seq !== fromSeq + i) {
          ok = false;
          fail('ATTESTA_VERIFY_SEQ_GAP');
          return;
        }
        if (rh !== prev) {
          ok = false;
          fail('ATTESTA_VERIFY_PREV_HASH_MISMATCH');
        }
        if (!isDigest(hash)) {
          ok = false;
          fail('ATTESTA_VERIFY_RECORD_HASH_MISMATCH');
        }
        const canon = r !== null && typeof r.canonical_record === 'string' ? r.canonical_record : null;
        let parsed: Obj | null = null;
        if (canon !== null) {
          const value = parseJson(canon);
          if (!isObj(value)) {
            ok = false;
            fail('ATTESTA_VERIFY_RECORD_HASH_MISMATCH');
          } else if (jcs(value) !== canon) {
            ok = false;
            fail('ATTESTA_VERIFY_NOT_CANONICAL');
          } else {
            let recomputed: string | null = null;
            try {
              recomputed = computeRecordHash(canon, rh);
            } catch {
              recomputed = null;
            }
            if (recomputed !== hash) {
              ok = false;
              fail('ATTESTA_VERIFY_RECORD_HASH_MISMATCH');
            }
            if (value.seq !== seq) {
              ok = false;
              fail('ATTESTA_VERIFY_SEQ_MISMATCH');
            }
            if (value.prev_hash !== rh) {
              ok = false;
              fail('ATTESTA_VERIFY_FIELD_MISMATCH');
            }
            if (value.tenant_id !== tenantId) {
              ok = false;
              fail('ATTESTA_VERIFY_TENANT_MISMATCH');
            }
            parsed = value;
          }
        }
        orderedRecords.push({ seq, recordHash: hash, parsed });
        if (parsed !== null) parsedBySeq.set(seq, parsed);
        recordHashBySeq.set(seq, hash);
        prev = hash;
      });
    }
    if (ok && head !== undefined && head !== null) {
      const h = isObj(head) ? head : null;
      if (h === null || h.next_seq !== toSeq + 1 || h.head_hash !== prev) {
        ok = false;
        fail('ATTESTA_VERIFY_HEAD_MISMATCH');
      }
    }
    chain = ok
      ? { id: 'chain', status: 'passed' }
      : { id: 'chain', status: FAILED, ...(chainCode !== undefined ? { code: chainCode } : {}) };
  }

  // --- user anchor material (the auditor's files, never the pack's claims)
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
  // Only the user's offsets ever reach the Rekor check. A malformed user value is
  // treated as absent here (the CLI rejects it upfront with exit 2).
  const userOffsets = options.rekorLogIndexOffsets !== undefined
    ? decimalOffsetsToHex(options.rekorLogIndexOffsets).offsets
    : undefined;
  // Windows come ONLY from the root document the trust check accepted.
  const rootDocs = trustSection !== null && Array.isArray(trustSection.root_documents)
    ? (trustSection.root_documents as DsseEnvelope[]) : [];
  const windowDigest = trusted?.platform?.digest ?? windowsPlatform?.digest;
  const anchorWindows = windowDigest !== undefined
    ? anchorWindowsFor(rootDocs, windowDigest)
    : undefined;

  // --- 6. anchors (run before statements; the report keeps the contract's order)
  let anchors: OfflineCheck;
  let anchorsVerified = 0;
  // Per statement seq, from rows that verified: bound time evidence for retired keys.
  const rekorIsoBySeq = new Map<number, string>();
  const tsaIsoBySeq = new Map<number, string>();
  {
    let failedCode: string | undefined;
    let checkable = true;
    let warned = false;
    const fail = (code: string): void => {
      if (failedCode === undefined) failedCode = code;
    };
    const batchesRaw: unknown[] = pack !== null && Array.isArray(pack.anchor_batches) ? pack.anchor_batches : [];
    const anchorsRaw: unknown[] = pack !== null && Array.isArray(pack.anchors) ? pack.anchors : [];
    const batchById = new Map<string, Obj>();
    for (const b of batchesRaw) {
      if (isObj(b) && typeof b.batch_id === 'string') batchById.set(b.batch_id, b);
    }
    const statementSeqs = new Set<number>();
    const anchorStatusBySeq = new Map<number, unknown>();
    for (const s of statementsRaw) {
      if (isObj(s) && typeof s.seq === 'number' && Number.isInteger(s.seq)) {
        statementSeqs.add(s.seq);
        anchorStatusBySeq.set(s.seq, s.anchor_status);
      }
    }
    // Every batch named by a row must exist, be the tenant's, and be named by a row.
    const namedBatches = new Set<string>();
    interface RowInput { row: StoredAnchorRow; seq: number; proof: Obj }
    const rows: RowInput[] = [];
    for (const a of anchorsRaw) {
      if (!isObj(a) || typeof a.seq !== 'number' || !Number.isInteger(a.seq) || typeof a.batch_id !== 'string') {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      const seq = a.seq;
      const batchId = a.batch_id;
      namedBatches.add(batchId);
      const batch = batchById.get(batchId);
      // Anchor rows prove in-scope records only: anything else is not this pack's evidence.
      if (batch === undefined || !statementSeqs.has(seq)) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      if (typeof batch.seq_from !== 'number' || typeof batch.seq_to !== 'number' || typeof batch.leaf_count !== 'number'
        || !Number.isInteger(batch.seq_from) || !Number.isInteger(batch.seq_to) || !Number.isInteger(batch.leaf_count)
        || batch.leaf_count < 1 || batch.seq_to - batch.seq_from + 1 !== batch.leaf_count
        || batchId !== `${tenantId}:${batch.seq_from}-${batch.seq_to}`
        || !isDigest(batch.merkle_root)) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      const proof = isObj(a.inclusion_proof) ? a.inclusion_proof : null;
      const merkle = proof !== null && isObj(proof.merkle) ? proof.merkle : null;
      if (proof === null || merkle === null || merkle.leaf_index !== seq - batch.seq_from
        || merkle.tree_size !== batch.leaf_count) {
        fail('ATTESTA_VERIFY_MERKLE_PROOF_INVALID');
        continue;
      }
      // The anchor must not predate its record (5 minutes of clock skew allowed).
      const record = parsedBySeq.get(seq);
      const recordedAt = record !== undefined && typeof record.recorded_at === 'string'
        ? parseTimestamp(record.recorded_at)
        : null;
      const claimedTime = anchorClaimTimeMs(a);
      if (recordedAt === null || claimedTime === null || claimedTime < recordedAt - ANCHOR_SKEW_MS) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      const recordHash = recordHashBySeq.get(seq);
      if (recordHash === undefined) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      rows.push({
        row: {
          anchorType: a.anchor_type as string,
          proof: proof as unknown,
          recordHash,
          merkleRoot: batch.merkle_root as string,
          rekorEntryUuid: (a.rekor_entry_uuid as string | null) ?? null,
          tsaTokenB64: (a.tsa_token_b64 as string | null) ?? null,
        },
        seq,
        proof,
      });
    }
    for (const b of batchesRaw) {
      if (isObj(b) && typeof b.batch_id === 'string' && !namedBatches.has(b.batch_id)) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
      }
    }
    const keys: StoredAnchorKeys = {
      ...(rekorLogKey !== undefined ? { rekorLogKey } : {}),
      ...(userOffsets !== undefined ? { rekorLogIndexOffsets: userOffsets } : {}),
      ...(anchorWindows !== undefined ? { anchorKeyWindows: anchorWindows } : {}),
      ...(tsaAnchors !== undefined ? { tsaAnchors } : {}),
    };
    const rekorOkBySeq = new Map<number, boolean>();
    const tsaOkBySeq = new Map<number, boolean>();
    const rekorRowBySeq = new Map<number, boolean>();
    const tsaRowBySeq = new Map<number, boolean>();
    const invalidBySeq = new Map<number, boolean>();
    for (const seq of statementSeqs) {
      rekorOkBySeq.set(seq, false);
      tsaOkBySeq.set(seq, false);
      rekorRowBySeq.set(seq, false);
      tsaRowBySeq.set(seq, false);
      invalidBySeq.set(seq, false);
    }
    for (const { row, seq, proof } of rows) {
      if (!statementSeqs.has(seq)) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      if (row.anchorType === 'rekor') rekorRowBySeq.set(seq, true);
      else if (row.anchorType === 'tsa') tsaRowBySeq.set(seq, true);
      let checked;
      try {
        checked = verifyStoredAnchor(row, keys);
      } catch {
        invalidBySeq.set(seq, true);
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      if (checked.status === 'valid') {
        anchorsVerified += 1;
        if (row.anchorType === 'rekor') {
          rekorOkBySeq.set(seq, true);
          const iso = rekorTimeIso(proof);
          if (iso !== null) rekorIsoBySeq.set(seq, iso);
        } else if (row.anchorType === 'tsa') {
          tsaOkBySeq.set(seq, true);
          const iso = tsaTimeIso(proof);
          if (iso !== null) tsaIsoBySeq.set(seq, iso);
        } else {
          invalidBySeq.set(seq, true);
          fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        }
      } else if (checked.status === 'invalid') {
        invalidBySeq.set(seq, true);
        fail(checked.code);
      } else {
        checkable = false;
      }
    }
    // Anchor_status agreement, and pending age measured at generated_at (never now).
    const generatedMs = parseTimestamp(generatedAt);
    for (const seq of statementSeqs) {
      const status = anchorStatusBySeq.get(seq);
      const both = (rekorOkBySeq.get(seq) ?? false) && (tsaOkBySeq.get(seq) ?? false);
      if (status !== 'anchored' && status !== 'pending') {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      if (status === 'anchored') {
        // Dual anchoring is all or nothing: a claimed anchor missing either type's
        // row is invalid (a half-proof is no proof). With both rows present but
        // neither usable, missing material makes it not checkable (invalid rows
        // already failed above).
        if (both || invalidBySeq.get(seq) === true) continue;
        if (rekorRowBySeq.get(seq) === true && tsaRowBySeq.get(seq) === true) {
          checkable = false;
        } else {
          fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        }
        continue;
      }
      // Pending: proven after all is a lie; missing past the window is a break, within it a warning.
      if (both) {
        fail('ATTESTA_VERIFY_ANCHOR_INVALID');
        continue;
      }
      if (invalidBySeq.get(seq) === true || failedCode !== undefined) continue;
      const record = parsedBySeq.get(seq);
      const recordedAt = record !== undefined && typeof record.recorded_at === 'string'
        ? parseTimestamp(record.recorded_at)
        : null;
      if (generatedMs === null || recordedAt === null) {
        checkable = false;
        continue;
      }
      if (generatedMs - recordedAt > windowMs) {
        fail('ATTESTA_VERIFY_ANCHOR_MISSING');
      } else {
        warned = true;
      }
    }
    // The pack's key lists are hints only: a mismatch with the user's material is a warning.
    if (failedCode === undefined && (anchorsRaw.length > 0 || batchesRaw.length > 0)) {
      if (anchorWindows !== undefined && trustSection !== null && Array.isArray(trustSection.anchoring_keys)) {
        const packIds = (trustSection.anchoring_keys as unknown[])
          .filter((k): k is Obj => isObj(k) && typeof k.keyid === 'string')
          .map((k) => k.keyid as string)
          .sort()
          .join();
        const windowIds = anchorWindows.map((w) => sha256Prefixed(w.spkiDer)).sort().join();
        if (packIds !== windowIds) warned = true;
      }
      const hasRekorRows = anchorsRaw.some((a) => isObj(a) && a.anchor_type === 'rekor');
      if (hasRekorRows && rekorLogKey !== undefined && trustSection !== null) {
        try {
          const userB64 = Buffer.from(rekorLogKey.export({ type: 'spki', format: 'der' })).toString('base64');
          if (trustSection.rekor_log_key_spki_b64 !== userB64) warned = true;
        } catch {
          warned = true;
        }
      }
      const hasTsaRows = anchorsRaw.some((a) => isObj(a) && a.anchor_type === 'tsa');
      if (hasTsaRows && tsaAnchors !== undefined && trustSection !== null && Array.isArray(trustSection.tsa_anchors_der_b64)) {
        try {
          const userSet = tsaAnchors
            .map((c) => Buffer.from(c.toSchema(true).toBER(false) as ArrayBuffer).toString('base64'))
            .sort()
            .join();
          const packSet = [...(trustSection.tsa_anchors_der_b64 as string[])].sort().join();
          if (userSet !== packSet) warned = true;
        } catch {
          warned = true;
        }
      }
      // The pack's offsets are a hint only: they never feed verification, and a
      // mismatch with the user's pinned offsets warns.
      if (options.rekorLogIndexOffsets !== undefined && trustSection !== null
        && trustSection.rekor_log_index_offsets !== null && trustSection.rekor_log_index_offsets !== undefined) {
        const packText = jcs(trustSection.rekor_log_index_offsets);
        const userText = jcs(options.rekorLogIndexOffsets);
        if (packText === null || userText === null || packText !== userText) warned = true;
      }
    }
    if (failedCode !== undefined) {
      anchors = { id: 'anchors', status: FAILED, code: failedCode, count: anchorsVerified };
    } else if (!checkable) {
      anchors = { id: 'anchors', status: NOT_CHECKABLE, code: 'ATTESTA_VERIFY_NOT_CHECKABLE', count: anchorsVerified };
    } else if (warned) {
      anchors = { id: 'anchors', status: WARNING, count: anchorsVerified };
    } else {
      anchors = { id: 'anchors', status: 'passed', count: anchorsVerified };
    }
  }

  // --- 4. completeness (full: window, boundaries, settle, exact in-scope set)
  let completeness: OfflineCheck;
  {
    const scope = manifest !== null && isObj(manifest.scope) ? manifest.scope : null;
    const mode = scope !== null ? scope.mode : undefined;
    const repoId = scope !== null ? scope.repository_id : undefined;
    const from = scope !== null && typeof scope.from === 'string' ? scope.from : '';
    const to = scope !== null && typeof scope.to === 'string' ? scope.to : '';
    if (mode === 'repository_only') {
      // Redacted records prove the links but not the scope: never a pass.
      completeness = { id: 'completeness', status: NOT_CHECKABLE, code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };
    } else if (mode !== 'full' || scope === null || (repoId !== null && (typeof repoId !== 'string' || !UUID_RE.test(repoId)))) {
      completeness = { id: 'completeness', status: FAILED };
    } else {
      let ok = true;
      const fromMs = parseTimestamp(from);
      const toMs = parseTimestamp(to);
      const genMs = parseTimestamp(generatedAt);
      if (fromMs === null || toMs === null || genMs === null || fromMs > toMs) {
        ok = false;
      }
      // A full pack carries every record's bytes (its metadata names other repositories).
      const ordered = [...orderedRecords].sort((a, b) => a.seq - b.seq);
      if (ok && ordered.some((r) => r.parsed === null)) ok = false;
      const range = manifest !== null && isObj(manifest.chain_range) ? manifest.chain_range : null;
      const head = range !== null ? range.head : undefined;
      if (ok && ordered.length > 0) {
        const first = ordered[0].parsed as Obj;
        const last = ordered[ordered.length - 1].parsed as Obj;
        if (!(ordered[0].seq === 0 || (typeof first.recorded_at === 'string' && first.recorded_at < from))) ok = false;
        if (!(head !== undefined && head !== null) && !(typeof last.recorded_at === 'string' && last.recorded_at > to)) ok = false;
      }
      if (ok && toMs !== null && genMs !== null && toMs > genMs - PACK_SETTLE_MS) ok = false;
      if (ok) {
        const expected = new Map<number, string>();
        for (const r of ordered) {
          const p = r.parsed;
          if (p === null) continue;
          const at = p.recorded_at;
          const repo = p.repository_id;
          if (typeof at !== 'string' || at < from || at > to) continue;
          if (repoId !== null && repo !== repoId) continue;
          if (typeof p.statement_digest !== 'string') {
            ok = false;
            break;
          }
          expected.set(r.seq, p.statement_digest as string);
        }
        if (ok) {
          const listed = new Map<number, string>();
          for (const s of statementsRaw) {
            if (!isObj(s) || typeof s.seq !== 'number' || typeof s.statement_digest !== 'string') {
              ok = false;
              break;
            }
            listed.set(s.seq, s.statement_digest);
          }
          if (ok) {
            if (listed.size !== expected.size) {
              ok = false;
            } else {
              for (const [seq, digest] of expected) {
                if (listed.get(seq) !== digest) {
                  ok = false;
                  break;
                }
              }
            }
          }
        }
      }
      completeness = ok ? { id: 'completeness', status: 'passed' } : { id: 'completeness', status: FAILED };
    }
  }

  // --- 5. statements (digest, envelope, canonical form, schema, rules, trusted signature)
  let statements: OfflineCheck;
  let reportStatements = 0;
  {
    // Tamper evidence (a bad signature, a wrong key, a broken rule) is a break;
    // absent trust information (an expired or missing document) is not checkable.
    const breaks = new Map<string, number>();
    const unknowns = new Map<string, number>();
    let failedStatements = 0;
    let uncheckableStatements = 0;
    const bump = (code: string): void => {
      if ((TRUST_CODE_STATUS as Record<string, string>)[code] === 'unavailable') {
        unknowns.set(code, (unknowns.get(code) ?? 0) + 1);
        uncheckableStatements += 1;
      } else {
        breaks.set(code, (breaks.get(code) ?? 0) + 1);
        failedStatements += 1;
      }
    };
    const topOf = (m: Map<string, number>): string => {
      let top = '';
      let topCount = -1;
      for (const [code, n] of m) {
        if (n > topCount) {
          top = code;
          topCount = n;
        }
      }
      return top;
    };
    const rootDocs = trustSection !== null && Array.isArray(trustSection.root_documents)
      ? (trustSection.root_documents as DsseEnvelope[]) : [];
    const keysetDocs = trustSection !== null && Array.isArray(trustSection.keyset_documents)
      ? (trustSection.keyset_documents as DsseEnvelope[]) : [];
    let statementValidatorOk = true;
    try {
      statementSchemaValidator();
      reportSchemaValidator();
      sealSchemaValidator();
    } catch {
      statementValidatorOk = false;
    }
    for (const s of statementsRaw) {
      if (!isObj(s) || typeof s.seq !== 'number' || !Number.isInteger(s.seq)
        || typeof s.statement_canonical !== 'string' || typeof s.statement_digest !== 'string') {
        bump('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        continue;
      }
      const seq = s.seq;
      const text = s.statement_canonical;
      const digest = s.statement_digest;
      if (!isDigest(digest) || sha256Prefixed(text) !== digest) {
        bump('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        continue;
      }
      // The statement must be its record's statement (same digest as the chain claims).
      const record = parsedBySeq.get(seq);
      if (record === undefined || record.statement_digest !== digest) {
        bump('ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH');
        continue;
      }
      const envelope = isObj(s.envelope) ? (s.envelope as unknown as DsseEnvelope) : null;
      const payloadBytes = envelope !== null ? decodeB64((envelope as unknown as Obj).payload) : null;
      if (envelope === null || payloadBytes === null || payloadBytes.toString('utf8') !== text) {
        bump('ATTESTA_VERIFY_ENVELOPE_PAYLOAD_MISMATCH');
        continue;
      }
      if (jcs(parseJson(text)) !== text) {
        bump('ATTESTA_VERIFY_NOT_CANONICAL');
        continue;
      }
      if (!statementValidatorOk) {
        // The schema files are an environment dependency, not pack evidence.
        schemaEnvFailed = true;
        unknowns.set('ATTESTA_VERIFY_NOT_CHECKABLE', (unknowns.get('ATTESTA_VERIFY_NOT_CHECKABLE') ?? 0) + 1);
        uncheckableStatements += 1;
        continue;
      }
      const snapshot = parseJson(text);
      // Task15i4: a period_report statement is its own predicate type. Its schema and its
      // record's typed copies are checked here; its figures need the report document
      // (P1–P10), which v1 packs do not carry, so the reports check says not checkable.
      const isReport = isObj(snapshot) && snapshot.predicateType === PERIOD_REPORT_TYPE;
      if (isReport) reportStatements += 1;
      // Task16e: an audit seal's schema and typed record copies are checked here; its rows need
      // the audit export (docs/contracts/audit/export.md), not a pack.
      const isSeal = isObj(snapshot) && snapshot.predicateType === AUDIT_SEAL_TYPE;
      try {
        const validator = isReport ? reportSchemaValidator() : isSeal ? sealSchemaValidator() : statementSchemaValidator();
        if (validator(snapshot) !== true) {
          bump('ATTESTA_VERIFY_SCHEMA_INVALID');
          continue;
        }
      } catch {
        bump('ATTESTA_VERIFY_SCHEMA_INVALID');
        continue;
      }
      if (!isReport && !isSeal && checkStatementRules(snapshot).length > 0) {
        bump('ATTESTA_VERIFY_RULE_VIOLATION');
        continue;
      }
      // The record's typed copies must be what the signed statement says (the
      // ledger's 0017/0022 guard rule): an exporter that rewrites a record without
      // re-signing its statement is caught here, not just by the chain links.
      const matches = isReport ? recordMatchesReport(record, snapshot)
        : isSeal ? recordMatchesSeal(record, snapshot, tenantId) : recordMatchesStatement(record, snapshot);
      if (!matches) {
        bump('ATTESTA_VERIFY_FIELD_MISMATCH');
        continue;
      }
      // The signature, with the record's anchor time as bound evidence for retired keys.
      const recordedAt = typeof record.recorded_at === 'string' ? (record.recorded_at as string) : '';
      const rekorIso = rekorIsoBySeq.get(seq) ?? null;
      const tsaIso = tsaIsoBySeq.get(seq) ?? null;
      const timeEvidence: TimeEvidence | undefined = rekorIso !== null
        ? { kind: 'rekor_integrated_time', time: rekorIso, binds: 'ledger_statement', digest: sha256Prefixed(payloadBytes) }
        : tsaIso !== null
          ? { kind: 'tsa_gen_time', time: tsaIso, binds: 'ledger_statement', digest: sha256Prefixed(payloadBytes) }
          : undefined;
      let verdict: TrustVerdict;
      try {
        verdict = verifyTrusted({
          payloadType: IN_TOTO_PAYLOAD_TYPE,
          payload: payloadBytes,
          envelope,
          purpose: 'statement',
          audience: tenantId,
          signedAt: recordedAt,
          ...(timeEvidence !== undefined ? { timeEvidence } : {}),
          state: {
            pinnedRootKeyids: [...(options.pinnedRootKeyids ?? [])],
            rootDocuments: rootDocs,
            keysetDocuments: tenantId !== '' ? { [tenantId]: keysetDocs } : {},
            ...(options.customerPins !== undefined && tenantId !== '' ? { customerPins: { [tenantId]: options.customerPins } } : {}),
            lastTrusted: options.lastTrusted ?? {},
            now: options.now,
            ...(options.trustedTimeFloor !== undefined ? { trustedTimeFloor: options.trustedTimeFloor } : {}),
            production: true,
          },
        });
      } catch {
        bump('ATTESTA_VERIFY_SIGNATURE_INVALID');
        continue;
      }
      if (verdict.status !== 'verified') {
        bump(verdict.code);
      }
    }
    if (failedStatements === 0 && uncheckableStatements === 0) {
      statements = { id: 'statements', status: 'passed', count: 0 };
    } else if (failedStatements > 0) {
      statements = { id: 'statements', status: FAILED, code: topOf(breaks), count: failedStatements };
    } else {
      statements = { id: 'statements', status: NOT_CHECKABLE, code: topOf(unknowns), count: uncheckableStatements };
    }
  }

  // --- 7. reports (reserved: period reports verify from Task15i4 on)
  let reports: OfflineCheck;
  {
    const value = pack !== null ? pack.reports : undefined;
    if (!Array.isArray(value)) {
      reports = { id: 'reports', status: FAILED };
    } else if (value.length > 0 || reportStatements > 0) {
      // A period_report statement's figures cannot be recomputed without its document.
      reports = { id: 'reports', status: NOT_CHECKABLE, code: 'ATTESTA_VERIFY_NOT_CHECKABLE' };
    } else {
      reports = { id: 'reports', status: 'passed' };
    }
  }

  const checks: OfflineCheck[] = [trust, structure, chain, completeness, statements, anchors, reports];
  const result = checks.some((c) => c.status === FAILED)
    ? 'failed'
    : checks.some((c) => c.status === NOT_CHECKABLE)
      ? 'not_checkable'
      : 'passed';
  return {
    report_version: 1,
    result,
    exit_code: result === 'failed' ? 1 : result === 'not_checkable' ? 2 : 0,
    tenant_id: tenantId,
    pack_id: packId,
    generated_at: generatedAt,
    checks,
    counts: { records: recordsRaw.length, statements: statementsRaw.length, anchors_verified: anchorsVerified },
    ...(trusted !== undefined ? { trusted } : {}),
    ...(trustedTime !== undefined ? { trustedTime } : {}),
    ...(schemaEnvFailed ? { verifier_error: 'contract schemas unavailable' } : {}),
  };
}

/** The anchor's claimed time in ms (a claim until its row verifies). */
/** Task16f2: reused by the offline audit-export verifier (no behaviour change). */
export function anchorClaimTimeMs(a: Obj): number | null {
  const proof = isObj(a.inclusion_proof) ? a.inclusion_proof : null;
  const anchor = proof !== null && isObj(proof.anchor) ? proof.anchor : null;
  if (anchor === null) return null;
  if (anchor.type === 'rekor') {
    const entry = isObj(anchor.rekor_entry) ? anchor.rekor_entry : null;
    const t = entry !== null ? entry.integratedTime : undefined;
    return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t * 1000 : null;
  }
  if (anchor.type === 'tsa') {
    return typeof anchor.gen_time === 'string' ? parseTimestamp(anchor.gen_time) : null;
  }
  return null;
}

/** Verified Rekor time as ISO (the row already verified; the entry's time is bound to it). */
/** Task16f2: reused by the offline audit-export verifier (no behaviour change). */
export function rekorTimeIso(proof: Obj): string | null {
  const anchor = isObj(proof.anchor) ? proof.anchor : null;
  const entry = anchor !== null && isObj(anchor.rekor_entry) ? anchor.rekor_entry : null;
  const t = entry !== null ? entry.integratedTime : undefined;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) return null;
  try {
    return new Date(t * 1000).toISOString();
  } catch {
    return null;
  }
}

/** Verified TSA gen_time (the row already verified; the proof's time equals the token's). */
/** Task16f2: reused by the offline audit-export verifier (no behaviour change). */
export function tsaTimeIso(proof: Obj): string | null {
  const anchor = isObj(proof.anchor) ? proof.anchor : null;
  const t = anchor !== null ? anchor.gen_time : undefined;
  if (typeof t !== 'string' || parseTimestamp(t) === null) return null;
  return t;
}

/** The ledger's 0017 guard rule: typed record copies equal the signed statement's
 * identity (predicate type and kind, repository, subject sha, and the subject name
 * built from them). Missing or mistyped fields compare as distinct, as in SQL. */
function recordMatchesStatement(record: Obj, snapshot: unknown): boolean {
  if (!isObj(snapshot)) return false;
  const subject = snapshot.subject;
  if (!Array.isArray(subject) || subject.length !== 1 || !isObj(subject[0])) return false;
  const first = subject[0];
  const digest = isObj(first.digest) ? first.digest : null;
  const predicate = isObj(snapshot.predicate) ? snapshot.predicate : null;
  const repository = predicate !== null && isObj(predicate.repository) ? predicate.repository : null;
  if (typeof snapshot.predicateType !== 'string'
    || predicate === null || typeof predicate.statement_kind !== 'string'
    || repository === null || typeof repository.id !== 'string'
    || digest === null || typeof digest.gitCommit !== 'string'
    || typeof first.name !== 'string') {
    return false;
  }
  const repoId = repository.id as string;
  const sha = digest.gitCommit as string;
  return record.predicate_type === snapshot.predicateType
    && record.statement_kind === predicate.statement_kind
    && record.repository_id === repoId
    && record.subject_sha === sha
    && first.name === `trackai:repository/${repoId}/commit/${sha}`;
}

/** The 0022 guard rule for a period_report record: kind, sha and outbox subject null, the
 * repository from the predicate's scope, one subject named after that scope with a sha256 digest. */
function recordMatchesReport(record: Obj, snapshot: unknown): boolean {
  if (!isObj(snapshot) || !Array.isArray(snapshot.subject) || snapshot.subject.length !== 1 || !isObj(snapshot.subject[0])) return false;
  const first = snapshot.subject[0];
  const digest = isObj(first.digest) ? first.digest : null;
  const predicate = isObj(snapshot.predicate) ? snapshot.predicate : null;
  const scope = predicate !== null && isObj(predicate.scope) ? predicate.scope : null;
  if (scope === null || typeof scope.repository_id !== 'string' || typeof scope.from !== 'string' || typeof scope.to !== 'string'
    || digest === null || Object.keys(digest).join(',') !== 'sha256' || typeof digest.sha256 !== 'string') return false;
  return record.predicate_type === snapshot.predicateType
    && record.statement_kind === null && record.subject_sha === null && record.outbox_subject_id === null
    && record.repository_id === scope.repository_id
    && first.name === `trackai:repository/${scope.repository_id}/period/${scope.from}..${scope.to}`;
}

/** The 0023 guard rule for an audit_seal record: repository, kind, sha and outbox subject null,
 * the predicate's tenant is the pack's, one subject named after that tenant and window with a sha256 digest. */
function recordMatchesSeal(record: Obj, snapshot: unknown, tenantId: string): boolean {
  if (!isObj(snapshot) || !Array.isArray(snapshot.subject) || snapshot.subject.length !== 1 || !isObj(snapshot.subject[0])) return false;
  const first = snapshot.subject[0];
  const digest = isObj(first.digest) ? first.digest : null;
  const predicate = isObj(snapshot.predicate) ? snapshot.predicate : null;
  const window = predicate !== null && isObj(predicate.window) ? predicate.window : null;
  if (predicate === null || window === null || typeof window.from !== 'string' || typeof window.to !== 'string'
    || predicate.tenant_id !== tenantId
    || digest === null || Object.keys(digest).join(',') !== 'sha256' || typeof digest.sha256 !== 'string') return false;
  return record.predicate_type === snapshot.predicateType
    && record.repository_id === null && record.statement_kind === null && record.subject_sha === null && record.outbox_subject_id === null
    && first.name === `trackai:tenant/${tenantId}/audit/${window.from}..${window.to}`;
}

/** Counts recomputed from the pack's own content (never the manifest's claims). */
function expectedCounts(pack: Obj): Obj {
  const records = Array.isArray(pack.records) ? pack.records : [];
  const statements = Array.isArray(pack.statements) ? pack.statements : [];
  const anchors = Array.isArray(pack.anchors) ? pack.anchors : [];
  const batches = Array.isArray(pack.anchor_batches) ? pack.anchor_batches : [];
  const anchored = statements.filter((s) => isObj(s) && s.anchor_status === 'anchored').length;
  return {
    records: records.length,
    statements: statements.length,
    redacted_records: records.filter((r) => !(isObj(r) && typeof r.canonical_record === 'string')).length,
    anchored,
    pending: statements.length - anchored,
    anchor_rows: anchors.length,
    anchor_batches: new Set(
      batches.filter((b) => isObj(b)).map((b) => (b as Obj).batch_id),
    ).size,
  };
}
