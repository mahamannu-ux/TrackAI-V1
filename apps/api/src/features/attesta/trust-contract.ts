/**
 * Attesta trust layer contract (Task15l, A15.12): which keys are trusted, for
 * what, and until when; and the one verifier every consumer calls.
 *
 * [CONTRACT - FROZEN] Do not change this file once merged; additions only
 * (new optional fields, new codes added to errors.md first). The rules it
 * implements are in docs/contracts/attesta/trust.md; the cross-language test
 * vectors are in ./vectors/trust/ (GitAI's Rust verifier must give the same
 * answers).
 *
 * Consumers: D6.1 (signed, machine-bound activation lease), Task9 (signed fleet
 * configuration, IT-M9-01), Task6.b P6.8 (policy bundles), Task14 T14.7
 * (release artifacts), A15.9 (evidence packs carry the documents). They call
 * `verifyTrusted` and get exactly Task9's three states.
 *
 * Ported from SushiCorp B4 core/trust/{revocation,verdict}.py @ 0bd67a5
 * (catalog TR-1): three states with UNKNOWN never CLEAN (here: `unavailable`
 * is never `verified`); a stale, missing or future-dated source is UNKNOWN.
 * New, not in SushiCorp (which trusts per-tenant X.509 trust lists): key
 * purposes, signed key-set documents in DSSE envelopes, TUF-style root
 * rotation by threshold, and compromise bound to independent time evidence.
 */
import type { DsseEnvelope } from './dsse';
import { verifyTrustedImpl } from './trust-verify';

// ---------------------------------------------------------------------------
// Document format (trust.md "Documents"; trust-document-v1.schema.json)
// ---------------------------------------------------------------------------

export const TRUST_ROOT_PAYLOAD_TYPE = 'application/vnd.trackai.trust-root+json';
export const KEYSET_PAYLOAD_TYPE = 'application/vnd.trackai.keyset+json';
export const TRUST_ROOT_TYPE = 'https://trackai.dev/attesta/trust-root/v1';
export const KEYSET_TYPE = 'https://trackai.dev/attesta/keyset/v1';
/** `scope` of the root document; every other scope is a tenant UUID. */
export const PLATFORM_SCOPE = 'platform';

/** What a key may sign. A key has exactly one purpose. */
export const KEY_PURPOSES = [
  'root',
  'anchor',
  'activation_lease',
  'fleet_config',
  'policy_bundle',
  'release',
  'tenant_keyset',
  'statement',
] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** Platform online keys, listed in the root document beside the root keys. */
export const PLATFORM_ONLINE_PURPOSES = [
  'anchor',
  'activation_lease',
  'fleet_config',
  'policy_bundle',
  'release',
  'tenant_keyset',
] as const satisfies readonly KeyPurpose[];

/** Purposes a consumer may pass to `verifyTrusted` (root and tenant_keyset sign documents only). */
export const ARTIFACT_PURPOSES = [
  'anchor',
  'activation_lease',
  'fleet_config',
  'policy_bundle',
  'release',
  'statement',
] as const satisfies readonly KeyPurpose[];
export type ArtifactPurpose = (typeof ARTIFACT_PURPOSES)[number];

export type KeyStatus = 'active' | 'retired' | 'revoked';
export type RevocationReason = 'superseded' | 'compromised';

/** One key in a document. RFC 3339 UTC timestamps with milliseconds (`…T00:00:00.000Z`). */
export interface TrustKeyEntry {
  /** `sha256:` + hex(SHA-256(SPKI DER)); the verifier recomputes it. */
  keyid: string;
  purpose: KeyPurpose;
  /** Standard base64 of the SPKI DER (ECDSA P-256). Public material only. */
  spki_der_b64: string;
  not_before: string;
  not_after: string;
  status: KeyStatus;
  /** `retired` and `revoked`: the instant the key stopped being valid for new signatures. */
  revoked_at?: string;
  /** `revoked` only. */
  revocation_reason?: RevocationReason;
  /** `revoked` + `compromised` only: signatures from then on are never trusted. */
  compromised_since?: string;
}

/** The JSON payload of a trust document (RFC 8785 bytes inside a DSSE envelope). */
export interface TrustDocumentBody {
  _type: typeof TRUST_ROOT_TYPE | typeof KEYSET_TYPE;
  /** `platform` (root document) or a tenant UUID (key set). */
  scope: string;
  /** Strictly increasing per scope, starting at 1. */
  version: number;
  issued_at: string;
  expires: string;
  /** `sha256:` digest of the previous version's payload bytes; null exactly at version 1. */
  previous: string | null;
  /** Root documents only: root signatures required (k of n). */
  threshold?: number;
  keys: TrustKeyEntry[];
}

/** A key the auditor or customer pins for their own tenant (founder decision 2026-10-13). */
export type CustomerPinnedKey = Omit<TrustKeyEntry, 'purpose'> & { purpose: 'statement' };

// ---------------------------------------------------------------------------
// Verifier interface (trust.md "Verification")
// ---------------------------------------------------------------------------

/** Everything the verifier trusts or holds. No database, no network. */
export interface TrustState {
  /** keyids of the root keys pinned at install or enrollment. */
  pinnedRootKeyids: readonly string[];
  /** Root signatures from pinned keys required on the start document (default 1). */
  pinnedRootThreshold?: number;
  /** Every root document held, any order. */
  rootDocuments: readonly DsseEnvelope[];
  /** Key-set documents held, by tenant UUID: the latest and optionally its predecessors. */
  keysetDocuments: Readonly<Record<string, readonly DsseEnvelope[]>>;
  /** Customer pins by tenant UUID; when present for a tenant they replace its platform key set. */
  customerPins?: Readonly<Record<string, readonly CustomerPinnedKey[]>>;
  /**
   * The newest document this verifier accepted before, by scope (`platform` = root):
   * persisted from `TrustVerdict.trusted`. The chain then starts at exactly that
   * document (same version and digest), so an older or forked document, or a key
   * removed from the root since, cannot be replayed (rollback and fork protection).
   * Without an entry: a root chain starts at the pin; a key set chain must start at
   * version 1 (full history, so a forged document cannot hide a revocation).
   */
  lastTrusted: Readonly<Record<string, TrustedDocumentRef>>;
  /** The verifier's clock, RFC 3339 UTC. */
  now: string;
  /**
   * The latest trusted time this verifier has seen, persisted from
   * `TrustVerdict.trustedTime`. A `now` more than the skew behind it is refused
   * (`CLOCK_BEHIND`), so a rolled-back clock cannot revive expired documents while
   * newer revocations are withheld. Consumers persist it; absent on first use.
   */
  trustedTimeFloor?: string;
  /** Allowed clock skew in ms (default 300000 = 5 minutes). */
  clockSkewMs?: number;
  /** Production: a pinned root is mandatory and `allowUnpinnedRoot` is ignored. */
  production: boolean;
  /** Outside production only: trust the lowest held root document on first use. */
  allowUnpinnedRoot?: boolean;
}

/**
 * Independent proof that the signed payload existed at `time`: an RFC 3161 TSA
 * `genTime` or a Rekor `integratedTime` over a Merkle root whose inclusion proof
 * covers this payload. The caller verifies the token or entry and the inclusion
 * first; the verifier checks only that it names this payload's digest.
 */
export interface TimeEvidence {
  kind: 'tsa_gen_time' | 'rekor_integrated_time';
  time: string;
  /**
   * What the evidence proves existed at `time`:
   * - `signature`: the DER signature bytes of this envelope (any purpose). Only the
   *   key holder could produce them, so this proves the signature predates `time`.
   * - `ledger_statement` (purpose `statement` only): this payload, as a statement
   *   recorded in the audience tenant's own Attesta ledger and covered by its anchor.
   *   The builder signs before chaining, so the record proves TrackAI held a signed
   *   statement then. A public timestamp over arbitrary bytes is never this.
   */
  binds: 'signature' | 'ledger_statement';
  /** `sha256:` + hex(SHA-256(bytes)) of the signature (`signature`) or the payload (`ledger_statement`). */
  digest: string;
}

/** A document a verifier accepted: its scope's version and payload digest. */
export interface TrustedDocumentRef {
  version: number;
  digest: string;
}

export interface VerifyTrustedInput {
  /** DSSE payload type of the artifact (e.g. `application/vnd.in-toto+json`). */
  payloadType: string;
  /** The signed payload bytes; must equal the envelope's decoded payload. */
  payload: Buffer;
  /** Exactly one signature. */
  envelope: DsseEnvelope;
  purpose: ArtifactPurpose;
  /** Tenant UUID for `statement`; `platform` for every other purpose. */
  audience: string;
  /**
   * When the artifact claims it was signed (RFC 3339 UTC). It is not covered by the
   * signature: it is trusted only while the key is active and inside its validity
   * at `now`; a retired, revoked or expired key needs bound `timeEvidence`.
   */
  signedAt: string;
  timeEvidence?: TimeEvidence;
  state: TrustState;
}

export type TrustStatus = 'verified' | 'rejected' | 'unavailable';

/** Stable codes (errors.md "Trust (A15.12)"). Each maps to exactly one status. */
export const TRUST_CODE_STATUS = {
  ATTESTA_TRUST_VERIFIED: 'verified',
  ATTESTA_TRUST_ROOT_NOT_PINNED: 'unavailable',
  ATTESTA_TRUST_DOCUMENT_UNAVAILABLE: 'unavailable',
  ATTESTA_TRUST_DOCUMENT_EXPIRED: 'unavailable',
  ATTESTA_TRUST_DOCUMENT_FROM_FUTURE: 'unavailable',
  ATTESTA_TRUST_REVOCATION_UNKNOWN: 'unavailable',
  ATTESTA_TRUST_CLOCK_BEHIND: 'unavailable',
  ATTESTA_TRUST_DOCUMENT_MALFORMED: 'rejected',
  ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID: 'rejected',
  ATTESTA_TRUST_THRESHOLD_NOT_MET: 'rejected',
  ATTESTA_TRUST_DOCUMENT_CONFLICT: 'rejected',
  ATTESTA_TRUST_ROLLBACK: 'rejected',
  ATTESTA_TRUST_KEYSET_REGRESSION: 'rejected',
  ATTESTA_TRUST_KEY_UNKNOWN: 'rejected',
  ATTESTA_TRUST_PURPOSE_MISMATCH: 'rejected',
  ATTESTA_TRUST_AUDIENCE_MISMATCH: 'rejected',
  ATTESTA_TRUST_KEY_NOT_VALID_AT: 'rejected',
  ATTESTA_TRUST_KEY_REVOKED: 'rejected',
  ATTESTA_TRUST_SIGNATURE_INVALID: 'rejected',
  ATTESTA_TRUST_INPUT_INVALID: 'rejected',
} as const satisfies Record<string, TrustStatus>;
export type TrustCode = keyof typeof TRUST_CODE_STATUS;

export interface TrustVerdict {
  status: TrustStatus;
  code: TrustCode;
  /** On `verified`: the keyid that signed the artifact. */
  keyid?: string;
  /**
   * On `verified`: the newest document accepted per scope in this call (empty with
   * customer pins). Consumers persist it into `lastTrusted` once they accept the
   * result (rollback and fork protection).
   */
  trusted?: Record<string, TrustedDocumentRef>;
  /** On `verified`: max(`trustedTimeFloor`, `now`), for consumers to persist as the next floor. */
  trustedTime?: string;
}

/** Signature of the verifier. Pure: never throws, never reads a clock, a file or the network. */
export type VerifyTrusted = (input: VerifyTrustedInput) => TrustVerdict;

// Bounds checked before any signature work (trust.md "Bounds").
export const TRUST_MAX_DOCUMENT_BYTES = 262_144;
/** About 700 key entries fit in TRUST_MAX_DOCUMENT_BYTES; this is the separate count bound. */
export const TRUST_MAX_KEYS_PER_DOCUMENT = 1_000;
export const TRUST_MAX_SIGNATURES_PER_DOCUMENT = 16;
/** Key sets keep full history (weekly publish), so a scope may hold many versions. */
export const TRUST_MAX_DOCUMENTS_PER_SCOPE = 1_024;
/** Tenant scopes in `keysetDocuments`, `customerPins` and `lastTrusted`. */
export const TRUST_MAX_SCOPES = 256;
/** Sum of all held documents' base64 payload lengths. */
export const TRUST_MAX_TOTAL_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const TRUST_MAX_SIGNED_BYTES = 16 * 1024 * 1024;
export const TRUST_DEFAULT_CLOCK_SKEW_MS = 300_000;
/** `expires` − `issued_at` bounds (trust.md: key sets 30 days + 1 day margin, roots 1 year + 1 day). */
export const TRUST_MAX_KEYSET_LIFETIME_MS = 31 * 86_400_000;
export const TRUST_MAX_ROOT_LIFETIME_MS = 366 * 86_400_000;

/**
 * The verifier (trust-verify.ts). Until the Task15l main PR this was a stub that
 * threw; replacing that body is the one change to this file trust.md allows.
 */
export const verifyTrusted: VerifyTrusted = (input) => verifyTrustedImpl(input);
