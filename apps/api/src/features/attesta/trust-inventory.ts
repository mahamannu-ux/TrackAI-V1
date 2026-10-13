/**
 * Attesta trust inventory (Task15l2, A15.12 part 2): which public keys exist, for
 * whom and for what, and the signed documents that publish them
 * (docs/contracts/attesta/trust.md "Hierarchy", "Rotation and revocation
 * procedures", "Registration").
 *
 *   registration   proof of possession: the key signs a fresh challenge naming its
 *                  scope, purpose and keyid; a keyid is registered once, ever
 *   tenant keys    activate (optionally replacing the active one), retire, revoke
 *   platform keys  change only by importing a root document signed offline
 *   documents      root import checked exactly as verifiers check it; key-set publish
 *                  from the inventory, forward-only checked before signing
 *
 * Every write goes through a `TrustStore` (pgTrustStore in production; the memory
 * store mirrors it for unit tests). Migration 0019's guards are the backstop: they
 * refuse a reused keyid, a status going backwards, a key UPDATE without its event row
 * and a document that does not extend its chain, even for a writer that bypasses
 * this file. No network call runs inside a transaction (plan → sign → record).
 * Credential references and key material are never printed or put in an error.
 *
 * Ported from SushiCorp A1b adapters/signing/inventory.py @ 0bd67a5 (catalog SG-1):
 * a public-only inventory keyed by the adapter-qualified credential, retired public
 * material kept forever (MODULE_A1b_HANDOFF.md "Rotation"), tenant-bound signers
 * (IT-A1b-03). New, with reasons:
 * - purposes: one key signs for one consumer only (trust.md "Hierarchy");
 * - proof of possession: without it a tenant could list another party's public key
 *   (trust.md "Registration", Task15l review finding 8);
 * - platform keys activated only through signed roots: one stolen online credential
 *   or database write must not authorize another key;
 * - signed key-set publishing: offline-checkable history from version 1, instead of
 *   SushiCorp's X.509 trust lists.
 */
import { createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { ATTESTA_PLATFORM_TENANT_ID } from './anchor-contract';
import { canonicalize, sha256Prefixed } from './canonical';
import { pae, type DsseEnvelope } from './dsse';
import { signVerified, SigningRejected, SigningUnavailable, type SigningAdapter, type SigningResult } from './signer-contract';
import {
  KEYSET_TYPE,
  PLATFORM_ONLINE_PURPOSES,
  PLATFORM_SCOPE,
  TRUST_ROOT_TYPE,
  verifyTrusted,
  type KeyPurpose,
  type TrustCode,
  type TrustDocumentBody,
  type TrustKeyEntry,
} from './trust-contract';
import {
  UUID_RE,
  documentSignedBy,
  forwardOnlyViolation,
  keyidOf,
  parseTimestamp,
  parseTrustDocument,
  signTrustDocument,
  trustDocumentPayload,
  type ParsedDocument,
} from './trust-documents';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InventoryStatus = 'registered' | 'active' | 'retired' | 'revoked';
export type PlatformPurpose = (typeof PLATFORM_ONLINE_PURPOSES)[number];

/** One row of attesta_platform_keys (tenantId null) or attesta_tenant_keys. */
export interface InventoryKey {
  id: string;
  tenantId: string | null;
  keyid: string;
  purpose: KeyPurpose;
  adapterName: string;
  /** Adapter credential; internal, never printed, logged or published. */
  credentialRef: string;
  spkiDer: Buffer;
  /** RFC 3339 UTC with milliseconds. */
  notBefore: string;
  notAfter: string;
  status: InventoryStatus;
  revokedAt: string | null;
  revocationReason: 'superseded' | 'compromised' | null;
  compromisedSince: string | null;
  popDigest: string;
  /** An `activate` event exists: the key may have signed, so it is published forever. */
  everActive: boolean;
}

export type NewInventoryKey = Omit<InventoryKey, 'id' | 'status' | 'revokedAt' | 'revocationReason' | 'compromisedSince' | 'everActive'>;

export interface KeyStatusChange {
  status: InventoryStatus;
  revokedAt: string | null;
  revocationReason: 'superseded' | 'compromised' | null;
  compromisedSince: string | null;
  notAfter: string;
}

export type KeyEventAction = 'register' | 'activate' | 'retire' | 'revoke' | 'publish' | 'import_root';

export interface KeyEvent {
  tenantId: string | null;
  keyId: string | null;
  action: KeyEventAction;
  actor: string;
  reason: string | null;
  documentVersion: number | null;
  requestId: string;
}

export interface AuditEvent {
  tenantId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

export interface StoredDocument {
  scope: string;
  kind: 'root' | 'keyset';
  version: number;
  digest: string;
  envelope: DsseEnvelope;
}

/** Persistence of the inventory. Every tenant read is bound to its tenant. */
export interface TrustStore {
  transaction<T>(fn: (store: TrustStore) => Promise<T>): Promise<T>;
  /** True when the keyid is registered anywhere (any tenant, the platform, any purpose). */
  keyidRegistered(keyid: string): Promise<boolean>;
  insertKey(key: NewInventoryKey): Promise<InventoryKey>;
  tenantKeys(tenantId: string): Promise<InventoryKey[]>;
  platformKeys(): Promise<InventoryKey[]>;
  /** Compare-and-set: refused when the row's status or revocation changed since `key` was read. */
  updateKey(key: InventoryKey, change: KeyStatusChange): Promise<void>;
  insertEvent(event: KeyEvent): Promise<void>;
  insertAudit(event: AuditEvent): Promise<void>;
  /** Documents of one scope, ascending version. */
  documents(scope: string): Promise<StoredDocument[]>;
  insertDocument(doc: StoredDocument): Promise<void>;
  /** Tenants with at least one key that was ever active (publish --all-tenants). */
  tenantsWithPublishableKeys(): Promise<string[]>;
  /**
   * The tenant's ledger records signed by `keyid` that have no anchored row yet: their
   * time evidence will be later than a revocation made now, so they would never verify.
   */
  unanchoredRecordsSignedBy(tenantId: string, keyid: string): Promise<number>;
}

/** Signing adapters by adapter name (`capabilities().adapterName`). */
export type TrustAdapters = Readonly<Record<string, SigningAdapter>>;

/** How verification is anchored here (trust.md "Hierarchy": production pins the root). */
export interface TrustConfig {
  /** keyids of the pinned root keys (ATTESTA_TRUST_ROOT_KEYIDS); required for root import and platform signing, in development too. */
  pinnedRootKeyids: string[];
  production: boolean;
}

export interface InventoryContext {
  store: TrustStore;
  adapters: TrustAdapters;
  config: TrustConfig;
  actor: string;
  requestId: string;
  now: () => Date;
}

/** A refused inventory action. `code` is a stable trust code; the message names no secret and no other tenant. */
export class TrustInventoryError extends Error {
  constructor(readonly code: TrustCode, message: string) {
    super(message);
    this.name = 'TrustInventoryError';
  }
}

const refuse = (message: string, code: TrustCode = 'ATTESTA_TRUST_INPUT_INVALID') => new TrustInventoryError(code, message);

/** Key-set lifetime (trust.md: 30 days, hard limit 31). */
export const KEYSET_LIFETIME_MS = 30 * 86_400_000;
export const DEFAULT_KEY_VALID_DAYS = 365;
export const MAX_KEY_VALID_DAYS = 1825;
/** Root draft lifetime (trust.md: 1 year, hard limit 366 days). */
export const ROOT_LIFETIME_DAYS = 365;

const iso = (d: Date | number): string => new Date(d).toISOString();
const ms = (t: string): number => {
  const v = parseTimestamp(t);
  if (v === null) throw refuse('timestamp must be RFC 3339 UTC with milliseconds');
  return v;
};

function assertTenant(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) throw refuse('--tenant must be a lowercase tenant UUID');
  // The platform's reserved signing tenant is never a customer tenant (its credentials sign platform documents).
  if (tenantId === ATTESTA_PLATFORM_TENANT_ID) throw refuse('--tenant cannot be the reserved platform tenant ID');
}

/** Every root import and platform signature starts from a pinned root, in development too (Task15f lesson). */
function requirePin(config: TrustConfig): void {
  if (config.pinnedRootKeyids.length === 0) {
    throw refuse('ATTESTA_TRUST_ROOT_KEYIDS is required (pin the root keyids, a development root too)', 'ATTESTA_TRUST_ROOT_NOT_PINNED');
  }
}

// ---------------------------------------------------------------------------
// Proof of possession (trust.md "Registration")
// ---------------------------------------------------------------------------

export const KEY_REGISTRATION_TYPE = 'https://trackai.dev/attesta/key-registration/v1';
export const KEY_REGISTRATION_PAYLOAD_TYPE = 'application/vnd.trackai.key-registration+json';

export interface RegistrationChallenge {
  _type: typeof KEY_REGISTRATION_TYPE;
  /** `platform` or the tenant UUID the key is registered for. */
  scope: string;
  purpose: KeyPurpose;
  keyid: string;
  /** 32 random bytes, standard base64: a proof is never reusable. */
  nonce: string;
  issued_at: string;
}

export function registrationChallenge(scope: string, purpose: KeyPurpose, keyid: string, now: Date,
  nonce: Buffer = randomBytes(32)): RegistrationChallenge {
  return { _type: KEY_REGISTRATION_TYPE, scope, purpose, keyid, nonce: nonce.toString('base64'), issued_at: iso(now) };
}

/**
 * Has the key sign the challenge's DSSE PAE through `signVerified` (verify before
 * use). `signingTenant` is the tenant the credential must be bound to (the platform's
 * reserved tenant for platform keys), so a credential configured for another tenant
 * cannot prove anything here.
 */
export async function proveRegistration(adapter: SigningAdapter, credentialRef: string, signingTenant: string,
  challenge: RegistrationChallenge, requestId: string): Promise<DsseEnvelope> {
  const payload = Buffer.from(canonicalize(challenge), 'utf8');
  const signed: SigningResult = await signVerified(adapter, pae(KEY_REGISTRATION_PAYLOAD_TYPE, payload), {
    credentialId: credentialRef, tenantId: signingTenant, requestId,
  });
  return {
    payload: payload.toString('base64'),
    payloadType: KEY_REGISTRATION_PAYLOAD_TYPE,
    signatures: [{ keyid: keyidOf(signed.publicKeySpkiDer), sig: signed.signature.toString('base64') }],
  };
}

/**
 * The proof is exactly this challenge (same scope, purpose, keyid, nonce and time:
 * a replayed or re-targeted proof differs in bytes), carries one signature named by
 * the challenged keyid, and that signature verifies with `spkiDer`. Throws otherwise.
 */
export function verifyRegistrationProof(envelope: DsseEnvelope, expected: RegistrationChallenge, spkiDer: Buffer): void {
  const bad = (why: string) => refuse(`proof of possession refused: ${why}`);
  if (envelope.payloadType !== KEY_REGISTRATION_PAYLOAD_TYPE) throw bad('payload type');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!payload.equals(Buffer.from(canonicalize(expected), 'utf8'))) throw bad('the signed challenge is not the one issued');
  if (keyidOf(spkiDer) !== expected.keyid) throw bad('the challenge names another key');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1 || envelope.signatures[0].keyid !== expected.keyid) {
    throw bad('signature keyid');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw bad('public key does not parse');
  }
  let ok = false;
  try {
    ok = verify('sha256', pae(envelope.payloadType, payload), { key, dsaEncoding: 'der' },
      Buffer.from(envelope.signatures[0].sig, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw bad('signature does not verify with the registered key');
}

// ---------------------------------------------------------------------------
// Signing through a registered key only
// ---------------------------------------------------------------------------

/**
 * The adapter, bound to one credential and the public key registered for it: any
 * answer carrying another key (a swapped KMS key, an edited credentials file) is
 * refused before signVerified ever accepts it.
 */
export function pinnedAdapter(adapter: SigningAdapter, credentialRef: string, spkiDer: Buffer): SigningAdapter {
  const mismatch = () => new SigningRejected('the signer key differs from the key registered in the trust inventory');
  return {
    capabilities: () => adapter.capabilities(),
    async sign(payload, credentialId, opts) {
      if (credentialId !== credentialRef) throw new SigningRejected('credential is not the registered one');
      const result = await adapter.sign(payload, credentialId, opts);
      if (!result || !Buffer.isBuffer(result.publicKeySpkiDer) || !result.publicKeySpkiDer.equals(spkiDer)) throw mismatch();
      return result;
    },
    async publicKey(credentialId) {
      if (credentialId !== credentialRef) throw new SigningRejected('credential is not the registered one');
      const key = await adapter.publicKey(credentialId);
      if (!Buffer.isBuffer(key) || !key.equals(spkiDer)) throw mismatch();
      return key;
    },
    listCredentials: (tenantId) => adapter.listCredentials(tenantId),
    health: () => adapter.health(),
  };
}

function adapterFor(adapters: TrustAdapters, name: string): SigningAdapter {
  const adapter = Object.prototype.hasOwnProperty.call(adapters, name) ? adapters[name] : undefined;
  if (!adapter) throw new SigningUnavailable(`signing adapter ${JSON.stringify(name)} is not configured`);
  return adapter;
}

// ---------------------------------------------------------------------------
// Chain checks with the verifier itself
// ---------------------------------------------------------------------------

/** A keyid no document lists (SHA-256 of a fixed label): the probe artifact's signer. */
const PROBE_KEYID = sha256Prefixed('attesta-trust-inventory-probe');

/**
 * Check stored (and candidate) documents exactly as verifiers do, by running
 * `verifyTrusted` on a probe artifact signed by a keyid no document lists: steps
 * 1–5 (root chain from the pin, threshold, forward-only, `previous`, expiry, and for
 * a tenant its key-set chain from version 1 signed by a root-listed `tenant_keyset`
 * key) run first, so reaching `KEY_UNKNOWN` (step 6) means every document check
 * passed. Any other code is the documents' failure. A pin is always required (no
 * trust on first use, in development either). No `lastTrusted`: the whole
 * stored chain is re-checked from the pin each time, so a row written around this
 * file (bypassing the signature checks) is caught here.
 */
export function checkDocumentChain(config: TrustConfig, now: Date, roots: readonly DsseEnvelope[],
  keyset?: { tenantId: string; documents: readonly DsseEnvelope[] }): TrustCode | null {
  const payload = Buffer.from('probe', 'utf8');
  const payloadType = 'application/vnd.trackai.probe';
  const verdict = verifyTrusted({
    payloadType,
    payload,
    envelope: { payload: payload.toString('base64'), payloadType, signatures: [{ keyid: PROBE_KEYID, sig: 'AA==' }] },
    purpose: keyset ? 'statement' : 'anchor',
    audience: keyset ? keyset.tenantId : PLATFORM_SCOPE,
    signedAt: iso(now),
    state: {
      pinnedRootKeyids: config.pinnedRootKeyids,
      rootDocuments: roots,
      keysetDocuments: keyset ? { [keyset.tenantId]: keyset.documents } : {},
      lastTrusted: {},
      now: iso(now),
      production: config.production,
      allowUnpinnedRoot: false,
    },
  });
  return verdict.code === 'ATTESTA_TRUST_KEY_UNKNOWN' ? null : verdict.code;
}

/** Parse an unsigned body as a document (shape only), for forward-only checks before signing. */
function parseUnsigned(body: TrustDocumentBody): ParsedDocument {
  const { payloadType, payload } = trustDocumentPayload(body);
  return parseTrustDocument({ payload: payload.toString('base64'), payloadType, signatures: [{ keyid: PROBE_KEYID, sig: 'AA==' }] });
}

function entryOf(k: InventoryKey): TrustKeyEntry {
  const e: TrustKeyEntry = {
    keyid: k.keyid, purpose: k.purpose, spki_der_b64: k.spkiDer.toString('base64'),
    not_before: k.notBefore, not_after: k.notAfter, status: k.status === 'registered' ? 'active' : k.status,
  };
  if (k.revokedAt) e.revoked_at = k.revokedAt;
  if (k.revocationReason) e.revocation_reason = k.revocationReason;
  if (k.compromisedSince) e.compromised_since = k.compromisedSince;
  return e;
}

// ---------------------------------------------------------------------------
// Plans: every changing command is planned (dry run), then applied
// ---------------------------------------------------------------------------

/** What a command would do. `lines` name keyids, statuses and versions only. */
export interface Plan {
  command: string;
  /** The number --expect must repeat to apply (documented per command). */
  expect: number;
  lines: string[];
}

const scopeLabel = (tenantId: string | null) => (tenantId ? `tenant ${tenantId}` : 'platform');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterInput {
  /** Tenant UUID for a `statement` key; null for a platform key. */
  tenantId: string | null;
  /** `statement` for tenant keys; a platform online purpose otherwise. */
  purpose: KeyPurpose;
  adapterName: string;
  credentialRef: string;
  validDays?: number;
}

interface RegistrationPlan extends Plan {
  keyid: string;
  spkiDer: Buffer;
  notBefore: string;
  notAfter: string;
}

function checkRegisterInput(input: RegisterInput): void {
  if (input.tenantId !== null) {
    assertTenant(input.tenantId);
    if (input.purpose !== 'statement') throw refuse('tenant keys have purpose statement only');
  } else if (!(PLATFORM_ONLINE_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw refuse(`platform keys need --purpose, one of ${PLATFORM_ONLINE_PURPOSES.join(', ')} (root keys live only in root documents)`);
  }
  const days = input.validDays ?? DEFAULT_KEY_VALID_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_VALID_DAYS) throw refuse(`--valid-days must be 1..${MAX_KEY_VALID_DAYS}`);
  if (typeof input.credentialRef !== 'string' || input.credentialRef.length === 0 || input.credentialRef.length > 512) {
    throw refuse('--credential is required');
  }
}

/** Dry run: read the public key from the adapter and check the keyid was never registered. */
export async function planRegistration(ctx: InventoryContext, input: RegisterInput): Promise<RegistrationPlan> {
  checkRegisterInput(input);
  const adapter = adapterFor(ctx.adapters, input.adapterName);
  const spkiDer = await adapter.publicKey(input.credentialRef);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw refuse('the adapter returned a public key that does not parse');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || spkiDer.length !== 91) {
    throw refuse('only ECDSA P-256 keys can be registered');
  }
  const keyid = keyidOf(spkiDer);
  if (await ctx.store.keyidRegistered(keyid)) {
    // Never say where: the keyid may belong to another tenant.
    throw refuse(`keyid ${keyid} is already registered (a keyid is registered once, for one scope and purpose)`);
  }
  const now = ctx.now();
  const notBefore = iso(now);
  const notAfter = iso(now.getTime() + (input.validDays ?? DEFAULT_KEY_VALID_DAYS) * 86_400_000);
  return {
    command: 'register', expect: 1, keyid, spkiDer, notBefore, notAfter,
    lines: [`register ${input.purpose} key ${keyid} for ${scopeLabel(input.tenantId)}: registered, valid ${notBefore} to ${notAfter}`],
  };
}

/** Register with proof of possession: plan, prove, verify, then store as `registered`. */
export async function registerKey(ctx: InventoryContext, input: RegisterInput): Promise<InventoryKey> {
  const plan = await planRegistration(ctx, input);
  const adapter = adapterFor(ctx.adapters, input.adapterName);
  const scope = input.tenantId ?? PLATFORM_SCOPE;
  const challenge = registrationChallenge(scope, input.purpose, plan.keyid, ctx.now());
  const proof = await proveRegistration(adapter, input.credentialRef, input.tenantId ?? ATTESTA_PLATFORM_TENANT_ID,
    challenge, `attesta-keys-register:${ctx.requestId}`);
  verifyRegistrationProof(proof, challenge, plan.spkiDer);
  const popDigest = sha256Prefixed(Buffer.from(canonicalize(proof), 'utf8'));
  return ctx.store.transaction(async (tx) => {
    let key: InventoryKey;
    try {
      key = await tx.insertKey({
        tenantId: input.tenantId, keyid: plan.keyid, purpose: input.purpose, adapterName: input.adapterName,
        credentialRef: input.credentialRef, spkiDer: plan.spkiDer, notBefore: plan.notBefore, notAfter: plan.notAfter, popDigest,
      });
    } catch (err) {
      if (isKeyidTaken(err)) throw refuse(`keyid ${plan.keyid} is already registered (a keyid is registered once, for one scope and purpose)`);
      throw err;
    }
    await tx.insertEvent({ tenantId: input.tenantId, keyId: key.id, action: 'register', actor: ctx.actor, reason: null,
      documentVersion: null, requestId: ctx.requestId });
    if (input.tenantId) {
      await tx.insertAudit({ tenantId: input.tenantId, actorId: ctx.actor, action: 'attesta.keys.register',
        targetType: 'attesta_tenant_key', targetId: plan.keyid, details: { keyid: plan.keyid, status: 'registered', requestId: ctx.requestId } });
    }
    return key;
  });
}

/** The 0019 guard (ATK01) or the unique constraint refused a keyid. */
function isKeyidTaken(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === 'ATK01' || code === '23505' || err instanceof KeyidTakenError;
}

/** Thrown by the memory store where PostgreSQL would raise ATK01. */
export class KeyidTakenError extends Error {}

// ---------------------------------------------------------------------------
// Tenant key status: activate, retire, revoke
// ---------------------------------------------------------------------------

interface Change {
  key: InventoryKey;
  action: 'activate' | 'retire' | 'revoke';
  to: KeyStatusChange;
}

export interface TenantKeyCommand {
  tenantId: string;
  keyid: string;
  /** activate: retire the currently active key in the same transaction. */
  replace?: boolean;
  /** revoke only. */
  reason?: 'superseded' | 'compromised';
  /** revoke compromised only: the first suspect instant. */
  compromisedSince?: string;
}

/** Only this tenant's keys are ever looked at; another tenant's keyid is simply "not found". */
async function tenantKey(store: TrustStore, tenantId: string, keyid: string): Promise<{ key: InventoryKey; all: InventoryKey[] }> {
  assertTenant(tenantId);
  const all = await store.tenantKeys(tenantId);
  const key = all.find((k) => k.keyid === keyid);
  if (!key) throw refuse(`no key ${keyid} is registered for tenant ${tenantId}`);
  return { key, all };
}

const unchanged = (k: InventoryKey): KeyStatusChange =>
  ({ status: k.status, revokedAt: k.revokedAt, revocationReason: k.revocationReason, compromisedSince: k.compromisedSince, notAfter: k.notAfter });

/**
 * A key that stops signing now must have every record it signed anchored first:
 * after `revoked_at` only anchor time evidence before it keeps a signature valid
 * (trust.md step 8), so a record anchored later would never verify. Compromise is
 * the exception (those records must not verify). In-flight statements (signed, not
 * yet chained) are not visible here: run the anchor pass after the builder drains.
 */
async function requireAnchored(store: TrustStore, key: InventoryKey): Promise<void> {
  const n = await store.unanchoredRecordsSignedBy(key.tenantId as string, key.keyid);
  if (n > 0) {
    throw refuse(`${n} ledger records signed by key ${key.keyid} are not anchored yet; run the anchor pass first, or they will never verify`);
  }
}

async function planTenantChanges(store: TrustStore, command: 'activate' | 'retire' | 'revoke', cmd: TenantKeyCommand,
  now: Date): Promise<Change[]> {
  const { key, all } = await tenantKey(store, cmd.tenantId, cmd.keyid);
  const at = iso(now);
  if (command === 'activate') {
    if (key.status !== 'registered') throw refuse(`key ${key.keyid} is ${key.status}; only a registered key can be activated`);
    if (ms(key.notAfter) <= now.getTime()) throw refuse(`key ${key.keyid} expired at ${key.notAfter}`);
    const changes: Change[] = [];
    const active = all.find((k) => k.status === 'active');
    if (active) {
      if (!cmd.replace) throw refuse(`tenant ${cmd.tenantId} already has active key ${active.keyid}; pass --replace to retire it`);
      await requireAnchored(store, active);
      changes.push({ key: active, action: 'retire', to: { ...unchanged(active), status: 'retired', revokedAt: at } });
    }
    changes.push({ key, action: 'activate', to: { ...unchanged(key), status: 'active' } });
    return changes;
  }
  if (command === 'retire') {
    if (key.status !== 'active') throw refuse(`key ${key.keyid} is ${key.status}; only the active key can be retired`);
    await requireAnchored(store, key);
    return [{ key, action: 'retire', to: { ...unchanged(key), status: 'retired', revokedAt: at } }];
  }
  const reason = cmd.reason;
  if (reason !== 'superseded' && reason !== 'compromised') throw refuse('--reason must be superseded or compromised');
  let since: string | null = null;
  if (reason === 'compromised') {
    if (!cmd.compromisedSince) throw refuse('--compromised-since <first suspect instant> is required for a compromised key');
    since = cmd.compromisedSince;
    if (ms(since) > now.getTime()) throw refuse('--compromised-since is in the future');
  } else if (cmd.compromisedSince) {
    throw refuse('--compromised-since applies to --reason compromised only');
  }
  // revoked_at: now for a key still in use; a retired key keeps the instant it stopped signing.
  const revokedAt = key.status === 'retired' || key.status === 'revoked' ? (key.revokedAt as string) : at;
  if (since !== null && ms(since) > ms(revokedAt)) {
    throw refuse(`--compromised-since must not be after the key stopped signing (${revokedAt}); later signatures are already refused`);
  }
  if (key.status === 'active' && reason === 'superseded') await requireAnchored(store, key);
  if (key.status === 'revoked') {
    const earlier = key.revocationReason === 'compromised' && since !== null && ms(since) < ms(key.compromisedSince as string);
    const upgrade = key.revocationReason === 'superseded' && reason === 'compromised';
    if (!earlier && !upgrade) throw refuse(`key ${key.keyid} is already revoked (${key.revocationReason})`);
  }
  return [{ key, action: 'revoke', to: { ...unchanged(key), status: 'revoked', revokedAt, revocationReason: reason, compromisedSince: since } }];
}

function describeChanges(command: string, changes: Change[]): Plan {
  const lines = changes.map((c) => {
    const extra = c.to.status === 'revoked'
      ? ` (${c.to.revocationReason}, revoked_at ${c.to.revokedAt}${c.to.compromisedSince ? `, compromised_since ${c.to.compromisedSince}` : ''})`
      : c.to.status === 'retired' ? ` (revoked_at ${c.to.revokedAt})` : '';
    return `${c.action} ${c.key.purpose} key ${c.key.keyid} of ${scopeLabel(c.key.tenantId)}: ${c.key.status} -> ${c.to.status}${extra}`;
  });
  if (changes.some((c) => c.key.status === 'active' && c.to.status !== 'active') && !changes.some((c) => c.to.status === 'active')) {
    lines.push('warning: the tenant has no active statement key afterwards; the builder stops signing (ATTESTA_SIGNER_NO_CREDENTIAL)');
  }
  lines.push('the next `publish` puts this into the tenant key set');
  return { command, expect: changes.length, lines };
}

/** Dry run of activate / retire / revoke (expect = number of keys changed). */
export async function planTenantKeyCommand(ctx: InventoryContext, command: 'activate' | 'retire' | 'revoke',
  cmd: TenantKeyCommand): Promise<Plan> {
  return describeChanges(command, await planTenantChanges(ctx.store, command, cmd, ctx.now()));
}

/**
 * Apply activate / retire / revoke: re-planned inside the transaction (so the scope
 * printed is the scope changed) and refused unless it changes exactly `expect` keys.
 * One event per key, one security audit row.
 */
export async function applyTenantKeyCommand(ctx: InventoryContext, command: 'activate' | 'retire' | 'revoke',
  cmd: TenantKeyCommand, expect: number): Promise<Plan> {
  return ctx.store.transaction(async (tx) => {
    const changes = await planTenantChanges(tx, command, cmd, ctx.now());
    if (changes.length !== expect) throw refuse(`--expect=${expect} but this would change ${changes.length} keys; run the dry run again`);
    // Retire the old key before activating the new one (one active key per tenant).
    for (const c of changes) {
      await tx.insertEvent({ tenantId: cmd.tenantId, keyId: c.key.id, action: c.action, actor: ctx.actor,
        reason: c.to.revocationReason, documentVersion: null, requestId: ctx.requestId });
      await tx.updateKey(c.key, c.to);
    }
    const plan = describeChanges(command, changes);
    await tx.insertAudit({ tenantId: cmd.tenantId, actorId: ctx.actor, action: `attesta.keys.${command}`,
      targetType: 'attesta_tenant_key', targetId: cmd.keyid,
      details: { requestId: ctx.requestId, changes: changes.map((c) => ({ keyid: c.key.keyid, from: c.key.status, to: c.to.status,
        revocationReason: c.to.revocationReason, compromisedSince: c.to.compromisedSince })) } });
    return plan;
  });
}

// ---------------------------------------------------------------------------
// Root documents: export a draft for the offline machine, import the signed result
// ---------------------------------------------------------------------------

export interface RootDraftInput {
  /** Registered platform keyids to list as active (nothing is added unless named). */
  add?: string[];
  /** Platform keyids (in the current root) to retire. */
  retire?: string[];
  /** Platform keyids (in the current root, or registered) to revoke with `reason`. */
  revoke?: string[];
  reason?: 'superseded' | 'compromised';
  compromisedSince?: string;
  /** Version 1 only: the root public keys (SPKI DER) and threshold. */
  rootSpkis?: Buffer[];
  threshold?: number;
}

export interface RootDraft {
  body: TrustDocumentBody;
  /** The current signed root, which the offline `sign` needs as --previous (null at version 1). */
  previous: DsseEnvelope | null;
  lines: string[];
}

/**
 * The next root document body: the current root's keys (root keys renewed to the new
 * expiry, as the offline `draft` does), every `registered` platform key added as
 * active, and the requested retirements and revocations. Checked forward-only and
 * against the schema before it is written; signing happens offline.
 */
export async function exportRootDraft(ctx: InventoryContext, input: RootDraftInput): Promise<RootDraft> {
  const now = ctx.now();
  const issuedAt = iso(now);
  const expires = iso(now.getTime() + ROOT_LIFETIME_DAYS * 86_400_000);
  const stored = await ctx.store.documents(PLATFORM_SCOPE);
  const current = stored.length > 0 ? parseTrustDocument(stored[stored.length - 1].envelope) : null;
  const rows = await ctx.store.platformKeys();
  const keys = new Map<string, TrustKeyEntry>();
  let threshold: number;
  if (current) {
    if (input.rootSpkis?.length || input.threshold !== undefined) {
      throw refuse('--root-pub and --threshold apply to version 1 only; rotate root keys with the offline attesta:trust-root draft --previous');
    }
    threshold = current.body.threshold as number;
    for (const [keyid, k] of current.keys) {
      keys.set(keyid, k.entry.purpose === 'root' && k.entry.status === 'active' ? { ...k.entry, not_after: expires } : { ...k.entry });
    }
  } else {
    const spkis = input.rootSpkis ?? [];
    if (spkis.length === 0) throw refuse('version 1 needs --root-pub <root public key PEM> (one per root key)');
    threshold = input.threshold ?? 1;
    for (const spki of spkis) {
      keys.set(keyidOf(spki), { keyid: keyidOf(spki), purpose: 'root', spki_der_b64: spki.toString('base64'),
        not_before: issuedAt, not_after: expires, status: 'active' });
    }
  }
  // Only keys the operator names: a platform row written by anyone with database access
  // must never reach the offline signature unasked.
  const added: string[] = [];
  for (const keyid of input.add ?? []) {
    const row = rows.find((r) => r.keyid === keyid);
    if (!row || row.status !== 'registered' || keys.has(keyid)) throw refuse(`--add ${keyid}: not a registered platform key outside the current root`);
    keys.set(row.keyid, { keyid: row.keyid, purpose: row.purpose, spki_der_b64: row.spkiDer.toString('base64'),
      not_before: row.notBefore, not_after: row.notAfter, status: 'active' });
    added.push(row.keyid);
  }
  const unnamed = rows.filter((r) => r.status === 'registered' && !keys.has(r.keyid)).length;
  const lines: string[] = [];
  for (const keyid of input.retire ?? []) {
    const e = keys.get(keyid);
    if (!e || e.purpose === 'root') throw refuse(`--retire ${keyid}: not a platform online key of the current root`);
    if (e.status !== 'active') throw refuse(`--retire ${keyid}: it is ${e.status}`);
    keys.set(keyid, { ...e, status: 'retired', revoked_at: issuedAt });
  }
  if ((input.revoke ?? []).length > 0) {
    const reason = input.reason;
    if (reason !== 'superseded' && reason !== 'compromised') throw refuse('--revoke needs --reason superseded|compromised');
    if (reason === 'compromised' && !input.compromisedSince) throw refuse('--compromised-since is required for --reason compromised');
    if (reason === 'superseded' && input.compromisedSince) throw refuse('--compromised-since applies to --reason compromised only');
    for (const keyid of input.revoke ?? []) {
      const e = keys.get(keyid);
      if (!e || e.purpose === 'root') throw refuse(`--revoke ${keyid}: not a platform online key of the current root or registered`);
      const revokedAt = e.revoked_at ?? issuedAt;
      if (input.compromisedSince && (ms(input.compromisedSince) > ms(revokedAt))) {
        throw refuse(`--compromised-since must not be after ${revokedAt} for ${keyid}`);
      }
      const next: TrustKeyEntry = { ...e, status: 'revoked', revoked_at: revokedAt, revocation_reason: reason };
      delete next.compromised_since;
      if (reason === 'compromised') next.compromised_since = input.compromisedSince;
      keys.set(keyid, next);
    }
  }
  const body: TrustDocumentBody = {
    _type: TRUST_ROOT_TYPE, scope: PLATFORM_SCOPE, version: current ? current.body.version + 1 : 1, issued_at: issuedAt, expires,
    previous: current ? current.digest : null, threshold, keys: [...keys.values()],
  };
  let parsed: ParsedDocument;
  try {
    parsed = parseUnsigned(body);
  } catch (err) {
    throw refuse(`the draft is not a valid root document: ${(err as Error).message}`, 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  }
  if (current) {
    const violation = forwardOnlyViolation(current, parsed);
    if (violation) throw refuse('the draft would move a platform key backwards', violation);
  }
  lines.push(`draft root version ${body.version}, threshold ${threshold}, ${body.keys.length} keys`);
  for (const k of body.keys) {
    const before = current?.keys.get(k.keyid)?.entry.status;
    const change = added.includes(k.keyid) ? ' (new)' : before && before !== k.status ? ` (was ${before})` : '';
    lines.push(`  ${k.purpose.padEnd(16)} ${k.keyid} ${k.status}${change}`);
  }
  if (unnamed > 0) lines.push(`  ${unnamed} registered platform key(s) not added (name them with --add <keyid>)`);
  return { body, previous: current ? stored[stored.length - 1].envelope : null, lines };
}

interface RootImportPlan extends Plan {
  doc: ParsedDocument;
  changes: Change[];
  notAfterOnly: Array<{ key: InventoryKey; to: KeyStatusChange }>;
}

const STATUS_RANK: Record<InventoryStatus, number> = { registered: 0, active: 1, retired: 2, revoked: 3 };

/** Dry run of import-root (expect = the document version). */
export async function planRootImport(ctx: InventoryContext, envelope: unknown, store: TrustStore = ctx.store): Promise<RootImportPlan> {
  let doc: ParsedDocument;
  try {
    doc = parseTrustDocument(envelope);
  } catch (err) {
    throw refuse(`--file: ${(err as Error).message}`, 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  }
  if (doc.kind !== 'root') throw refuse('--file is not a root document', 'ATTESTA_TRUST_DOCUMENT_MALFORMED');
  requirePin(ctx.config);
  const stored = await store.documents(PLATFORM_SCOPE);
  if (doc.body.version !== stored.length + 1) {
    const code: TrustCode = doc.body.version <= stored.length
      ? (stored[doc.body.version - 1].digest === doc.digest ? 'ATTESTA_TRUST_ROLLBACK' : 'ATTESTA_TRUST_DOCUMENT_CONFLICT')
      : 'ATTESTA_TRUST_DOCUMENT_UNAVAILABLE';
    throw refuse(`root version ${doc.body.version} does not follow the stored version ${stored.length}`, code);
  }
  const failure = checkDocumentChain(ctx.config, ctx.now(), [...stored.map((d) => d.envelope), doc.envelope]);
  if (failure) throw refuse(`the root document does not verify against the stored chain and the pin (${failure})`, failure);
  const rows = new Map((await store.platformKeys()).map((r) => [r.keyid, r]));
  const changes: Change[] = [];
  const notAfterOnly: RootImportPlan['notAfterOnly'] = [];
  const lines = [`import root version ${doc.body.version} (digest ${doc.digest})`];
  for (const [keyid, k] of doc.keys) {
    if (k.entry.purpose === 'root') continue;
    const row = rows.get(keyid);
    if (!row) throw refuse(`the root lists platform key ${keyid}, which is not registered here: register it first`);
    if (row.purpose !== k.entry.purpose || row.spkiDer.toString('base64') !== k.entry.spki_der_b64 || row.notBefore !== k.entry.not_before) {
      throw refuse(`the root lists key ${keyid} with another purpose, key or not_before than registered`);
    }
    if (ms(k.entry.not_after) > ms(row.notAfter)) throw refuse(`the root extends key ${keyid} beyond its registered not_after`);
    const to: KeyStatusChange = {
      status: k.entry.status, revokedAt: k.entry.revoked_at ?? null, revocationReason: k.entry.revocation_reason ?? null,
      compromisedSince: k.entry.compromised_since ?? null, notAfter: k.entry.not_after,
    };
    if (row.status === 'registered' && to.status === 'retired') throw refuse(`key ${keyid} is listed retired without ever being active`);
    if (STATUS_RANK[to.status] < STATUS_RANK[row.status]) throw refuse(`key ${keyid} would move from ${row.status} to ${to.status}`, 'ATTESTA_TRUST_KEYSET_REGRESSION');
    const statusChanged = to.status !== row.status;
    const revocationChanged = to.revokedAt !== row.revokedAt || to.revocationReason !== row.revocationReason || to.compromisedSince !== row.compromisedSince;
    if (statusChanged || revocationChanged) {
      const action = to.status === 'active' ? 'activate' : to.status === 'retired' ? 'retire' : 'revoke';
      changes.push({ key: row, action: statusChanged ? action : 'revoke', to });
      lines.push(`  ${row.purpose.padEnd(16)} ${keyid}: ${row.status} -> ${to.status}`);
    } else if (to.notAfter !== row.notAfter) {
      notAfterOnly.push({ key: row, to });
      lines.push(`  ${row.purpose.padEnd(16)} ${keyid}: not_after -> ${to.notAfter}`);
    }
  }
  return { command: 'import-root', expect: doc.body.version, lines, doc, changes, notAfterOnly };
}

/** Store a verified root document and sync the platform keys to what it lists, in one transaction. */
export async function importRoot(ctx: InventoryContext, envelope: unknown, expect: number): Promise<Plan> {
  return ctx.store.transaction(async (tx) => {
    const plan = await planRootImport(ctx, envelope, tx);
    if (plan.expect !== expect) throw refuse(`--expect=${expect} but the document is version ${plan.expect}`);
    await tx.insertDocument({ scope: PLATFORM_SCOPE, kind: 'root', version: plan.doc.body.version, digest: plan.doc.digest,
      envelope: plan.doc.envelope });
    await tx.insertEvent({ tenantId: null, keyId: null, action: 'import_root', actor: ctx.actor, reason: null,
      documentVersion: plan.doc.body.version, requestId: ctx.requestId });
    for (const c of plan.changes) {
      await tx.insertEvent({ tenantId: null, keyId: c.key.id, action: c.action, actor: ctx.actor, reason: c.to.revocationReason,
        documentVersion: null, requestId: ctx.requestId });
      await tx.updateKey(c.key, c.to);
    }
    for (const c of plan.notAfterOnly) await tx.updateKey(c.key, c.to);
    return { command: plan.command, expect: plan.expect, lines: plan.lines };
  });
}

// ---------------------------------------------------------------------------
// Platform signer (used by publish and anchoring)
// ---------------------------------------------------------------------------

/** No usable platform key: callers fail closed (anchoring does not start, publish stops). */
export class PlatformSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformSignerError';
  }
}

export interface PlatformSigner {
  adapter: SigningAdapter;
  credentialId: string;
  keyid: string;
}

/**
 * The platform key of `purpose` to sign with now: the stored root chain verifies
 * from the pin, the **latest** root lists the key `active` and valid now, and its
 * inventory row is active with the same public key. The adapter is pinned to that
 * key. Anything missing → PlatformSignerError (fail closed).
 */
export async function resolvePlatformSigner(store: TrustStore, adapters: TrustAdapters, purpose: PlatformPurpose,
  config: TrustConfig, now: Date): Promise<PlatformSigner> {
  if (!(PLATFORM_ONLINE_PURPOSES as readonly string[]).includes(purpose)) throw new PlatformSignerError(`${purpose} is not a platform purpose`);
  if (config.pinnedRootKeyids.length === 0) throw new PlatformSignerError('ATTESTA_TRUST_ROOT_KEYIDS is required');
  const roots = await store.documents(PLATFORM_SCOPE);
  if (roots.length === 0) throw new PlatformSignerError('no root document has been imported (attesta:keys import-root)');
  const failure = checkDocumentChain(config, now, roots.map((d) => d.envelope));
  if (failure) throw new PlatformSignerError(`the stored root documents do not verify from the pin (${failure})`);
  const latest = parseTrustDocument(roots[roots.length - 1].envelope);
  const t = now.getTime();
  const candidates = [...latest.keys.values()]
    .filter((k) => k.entry.purpose === purpose && k.entry.status === 'active' && k.notBefore <= t && t <= k.notAfter)
    .sort((a, b) => b.notBefore - a.notBefore || (a.entry.keyid < b.entry.keyid ? -1 : 1));
  if (candidates.length === 0) throw new PlatformSignerError(`the latest root document lists no active ${purpose} key valid now`);
  const entry = candidates[0].entry;
  const row = (await store.platformKeys()).find((r) => r.keyid === entry.keyid);
  if (!row || row.status !== 'active' || row.purpose !== purpose || row.spkiDer.toString('base64') !== entry.spki_der_b64) {
    throw new PlatformSignerError(`the ${purpose} key ${entry.keyid} is not active in the inventory (import the root that lists it)`);
  }
  if (!Object.prototype.hasOwnProperty.call(adapters, row.adapterName)) {
    throw new PlatformSignerError(`signing adapter ${JSON.stringify(row.adapterName)} for the ${purpose} key is not configured`);
  }
  return { adapter: pinnedAdapter(adapters[row.adapterName], row.credentialRef, row.spkiDer), credentialId: row.credentialRef, keyid: row.keyid };
}

// ---------------------------------------------------------------------------
// Key-set publishing
// ---------------------------------------------------------------------------

interface PublishPlan extends Plan {
  tenantId: string;
  body: TrustDocumentBody;
  stored: StoredDocument[];
  signerKeyid: string;
}

/** Keys published for a tenant: every key that was ever active (registered-only keys never signed). */
function publishable(keys: InventoryKey[]): InventoryKey[] {
  return keys.filter((k) => k.everActive && k.status !== 'registered')
    .sort((a, b) => (a.notBefore < b.notBefore ? -1 : a.notBefore > b.notBefore ? 1 : a.keyid < b.keyid ? -1 : 1));
}

/** Plan one tenant's next key set (no signing). */
export async function planPublish(ctx: InventoryContext, tenantId: string): Promise<PublishPlan> {
  assertTenant(tenantId);
  const now = ctx.now();
  const signer = await resolvePlatformSigner(ctx.store, ctx.adapters, 'tenant_keyset', ctx.config, now);
  const keys = publishable(await ctx.store.tenantKeys(tenantId));
  if (keys.length === 0) throw refuse(`tenant ${tenantId} has no key that was ever active; activate one first`);
  const stored = await ctx.store.documents(tenantId);
  const prev = stored.length > 0 ? parseTrustDocument(stored[stored.length - 1].envelope) : null;
  if (prev) {
    // Never extend a chain whose newest document no tenant_keyset key ever signed (a row
    // written around this file): its `previous` link would launder it. The key's current
    // validity is not required, so recovery after a tenant_keyset compromise still works.
    const roots = (await ctx.store.documents(PLATFORM_SCOPE)).map((d) => parseTrustDocument(d.envelope));
    const signedByKeysetKey = prev.signatures.some((sig) => roots.some((root) => {
      const k = root.keys.get(sig.keyid);
      return k !== undefined && k.entry.purpose === 'tenant_keyset' && documentSignedBy(prev, k.key, sig.sig);
    }));
    if (!signedByKeysetKey) {
      throw refuse(`the stored key set version ${prev.body.version} of tenant ${tenantId} is not signed by any tenant_keyset key; nothing signed`,
        'ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID');
    }
  }
  const body: TrustDocumentBody = {
    _type: KEYSET_TYPE, scope: tenantId, version: stored.length + 1, issued_at: iso(now),
    expires: iso(now.getTime() + KEYSET_LIFETIME_MS), previous: prev ? prev.digest : null, keys: keys.map(entryOf),
  };
  const next = parseUnsigned(body);
  // Forward-only before signing: never sign a key set verifiers would refuse.
  if (prev) {
    const violation = forwardOnlyViolation(prev, next);
    if (violation) throw refuse(`the inventory would move a published key of tenant ${tenantId} backwards; nothing signed`, violation);
  }
  const lines = [`publish key set version ${body.version} for tenant ${tenantId}, signed by tenant_keyset key ${signer.keyid}, expires ${body.expires}`];
  for (const k of body.keys) lines.push(`  ${k.keyid} ${k.status}${k.revocation_reason ? ` (${k.revocation_reason})` : ''}`);
  return { command: 'publish', expect: 1, lines, tenantId, body, stored, signerKeyid: signer.keyid };
}

/**
 * Publish one tenant's next key set: plan, sign with the root-listed `tenant_keyset`
 * key (outside any transaction), check the result with the verifier's own document
 * checks (chain from version 1, signer authorized by the latest root), then store it
 * with a `publish` event and a security audit row. A concurrent publish loses at the
 * 0019 version guard.
 */
export async function publishKeyset(ctx: InventoryContext, tenantId: string): Promise<Plan> {
  const plan = await planPublish(ctx, tenantId);
  const now = ctx.now();
  const signer = await resolvePlatformSigner(ctx.store, ctx.adapters, 'tenant_keyset', ctx.config, now);
  if (signer.keyid !== plan.signerKeyid) throw refuse('the tenant_keyset key changed while publishing; run again');
  const envelope = await signTrustDocument(plan.body, [{
    keyid: signer.keyid,
    sign: async (paeBytes) => (await signVerified(signer.adapter, paeBytes, {
      credentialId: signer.credentialId, tenantId: ATTESTA_PLATFORM_TENANT_ID, requestId: `attesta-keys-publish:${ctx.requestId}`,
    })).signature,
  }]);
  const roots = await ctx.store.documents(PLATFORM_SCOPE);
  const failure = checkDocumentChain(ctx.config, now, roots.map((d) => d.envelope),
    { tenantId, documents: [...plan.stored.map((d) => d.envelope), envelope] });
  if (failure) throw refuse(`the signed key set does not verify (${failure}); nothing stored`, failure);
  const doc = parseTrustDocument(envelope);
  await ctx.store.transaction(async (tx) => {
    await tx.insertDocument({ scope: tenantId, kind: 'keyset', version: doc.body.version, digest: doc.digest, envelope });
    await tx.insertEvent({ tenantId, keyId: null, action: 'publish', actor: ctx.actor, reason: null,
      documentVersion: doc.body.version, requestId: ctx.requestId });
    await tx.insertAudit({ tenantId, actorId: ctx.actor, action: 'attesta.keys.publish', targetType: 'attesta_trust_document',
      targetId: `${tenantId}:${doc.body.version}`, details: { requestId: ctx.requestId, version: doc.body.version, digest: doc.digest,
        keyids: doc.body.keys.map((k) => k.keyid) } });
  });
  return { command: 'publish', expect: 1, lines: [...plan.lines, `stored version ${doc.body.version} (digest ${doc.digest})`] };
}

// ---------------------------------------------------------------------------
// Listing (keyids, purposes, statuses and validity only)
// ---------------------------------------------------------------------------

export async function listKeys(store: TrustStore, tenantId: string | null): Promise<string[]> {
  const keys = tenantId === null ? await store.platformKeys() : (assertTenant(tenantId), await store.tenantKeys(tenantId));
  return keys.map((k) => `${k.purpose.padEnd(16)} ${k.keyid} ${k.status.padEnd(10)} ${k.notBefore} .. ${k.notAfter}` +
    (k.revokedAt ? ` revoked_at ${k.revokedAt}` : '') + (k.revocationReason ? ` (${k.revocationReason})` : '') +
    (k.compromisedSince ? ` compromised_since ${k.compromisedSince}` : ''));
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

/** A Drizzle database or transaction. */
export interface TrustDb {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
  transaction<T>(fn: (tx: TrustDb) => Promise<T>): Promise<T>;
}

const TS = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

const KEY_COLUMNS = (table: 'p' | 't') => sql`
  ${sql.raw(table)}.id::text as id, ${table === 't' ? sql`t.tenant_id::text` : sql`null`} as tenant_id, ${sql.raw(table)}.keyid,
  ${sql.raw(table)}.purpose, ${sql.raw(table)}.adapter_name, ${sql.raw(table)}.credential_ref, ${sql.raw(table)}.spki_der,
  ${TS(`${table}.not_before`)} as not_before, ${TS(`${table}.not_after`)} as not_after, ${sql.raw(table)}.status,
  ${TS(`${table}.revoked_at`)} as revoked_at, ${sql.raw(table)}.revocation_reason, ${TS(`${table}.compromised_since`)} as compromised_since,
  ${sql.raw(table)}.pop_digest,
  exists (select 1 from attesta_key_events e where e.key_id = ${sql.raw(table)}.id and e.action = 'activate') as ever_active`;

function toKey(r: Record<string, unknown>): InventoryKey {
  return {
    id: String(r.id), tenantId: (r.tenant_id as string | null) ?? null, keyid: String(r.keyid), purpose: r.purpose as KeyPurpose,
    adapterName: String(r.adapter_name), credentialRef: String(r.credential_ref), spkiDer: Buffer.from(r.spki_der as Buffer),
    notBefore: String(r.not_before), notAfter: String(r.not_after), status: r.status as InventoryStatus,
    revokedAt: (r.revoked_at as string | null) ?? null, revocationReason: (r.revocation_reason as InventoryKey['revocationReason']) ?? null,
    compromisedSince: (r.compromised_since as string | null) ?? null, popDigest: String(r.pop_digest), everActive: r.ever_active === true,
  };
}

const tsOrNull = (v: string | null) => (v === null ? sql`null` : sql`${v}::timestamptz`);

/** The production store over a Drizzle database (every tenant query bound to its tenant). */
export function pgTrustStore(db: TrustDb): TrustStore {
  const store: TrustStore = {
    transaction: (fn) => db.transaction((tx) => fn(pgTrustStore(tx))),
    async keyidRegistered(keyid) {
      const rows = (await db.execute(sql`select 1 from attesta_platform_keys where keyid = ${keyid}
        union all select 1 from attesta_tenant_keys where keyid = ${keyid} limit 1`)).rows;
      return rows.length > 0;
    },
    async insertKey(k) {
      const values = sql`${k.keyid}, ${k.purpose}, ${k.adapterName}, ${k.credentialRef}, ${k.spkiDer}, ${k.notBefore}::timestamptz,
        ${k.notAfter}::timestamptz, 'registered', ${k.popDigest}`;
      const rows = k.tenantId === null
        ? (await db.execute(sql`insert into attesta_platform_keys as p (keyid, purpose, adapter_name, credential_ref, spki_der,
            not_before, not_after, status, pop_digest) values (${values}) returning ${KEY_COLUMNS('p')}`)).rows
        : (await db.execute(sql`insert into attesta_tenant_keys as t (tenant_id, keyid, purpose, adapter_name, credential_ref, spki_der,
            not_before, not_after, status, pop_digest) values (${k.tenantId}::uuid, ${values}) returning ${KEY_COLUMNS('t')}`)).rows;
      return toKey(rows[0]);
    },
    async tenantKeys(tenantId) {
      return (await db.execute(sql`select ${KEY_COLUMNS('t')} from attesta_tenant_keys t
        where t.tenant_id = ${tenantId}::uuid order by t.not_before, t.keyid`)).rows.map(toKey);
    },
    async platformKeys() {
      return (await db.execute(sql`select ${KEY_COLUMNS('p')} from attesta_platform_keys p order by p.not_before, p.keyid`)).rows.map(toKey);
    },
    async updateKey(key, c) {
      const set = sql`status = ${c.status}, revoked_at = ${tsOrNull(c.revokedAt)}, revocation_reason = ${c.revocationReason},
        compromised_since = ${tsOrNull(c.compromisedSince)}, not_after = ${c.notAfter}::timestamptz`;
      const unchangedSince = sql`status = ${key.status} and revocation_reason is not distinct from ${key.revocationReason}
        and compromised_since is not distinct from ${tsOrNull(key.compromisedSince)}`;
      const result = key.tenantId === null
        ? await db.execute(sql`update attesta_platform_keys set ${set} where id = ${key.id}::uuid and ${unchangedSince} returning id`)
        : await db.execute(sql`update attesta_tenant_keys set ${set} where id = ${key.id}::uuid and tenant_id = ${key.tenantId}::uuid
            and ${unchangedSince} returning id`);
      if (result.rows.length !== 1) throw refuse(`key ${key.keyid} changed while this command ran; run the dry run again`);
    },
    async insertEvent(e) {
      await db.execute(sql`insert into attesta_key_events (tenant_id, key_id, action, actor, reason, document_version, request_id)
        values (${e.tenantId}::uuid, ${e.keyId}::uuid, ${e.action}, ${e.actor}, ${e.reason}, ${e.documentVersion}, ${e.requestId})`);
    },
    async insertAudit(a) {
      await db.execute(sql`insert into security_audit_events (tenant_id, actor_type, actor_id, action, target_type, target_id, details)
        values (${a.tenantId}::uuid, 'system_operator', ${a.actorId}, ${a.action}, ${a.targetType}, ${a.targetId}, ${JSON.stringify(a.details)}::jsonb)`);
    },
    async documents(scope) {
      return (await db.execute(sql`select scope, kind, version, digest, envelope from attesta_trust_documents
        where scope = ${scope} order by version`)).rows.map((r) => ({
        scope: String(r.scope), kind: r.kind as 'root' | 'keyset', version: Number(r.version), digest: String(r.digest),
        envelope: r.envelope as DsseEnvelope,
      }));
    },
    async insertDocument(d) {
      await db.execute(sql`insert into attesta_trust_documents (scope, kind, version, digest, payload_type, envelope)
        values (${d.scope}, ${d.kind}, ${d.version}, ${d.digest}, ${d.envelope.payloadType}, ${JSON.stringify(d.envelope)}::jsonb)`);
    },
    async unanchoredRecordsSignedBy(tenantId, keyid) {
      const rows = (await db.execute(sql`select count(*)::int as n from attesta_records r
        join attesta_envelopes e on e.tenant_id = r.tenant_id and e.record_id = r.id
        where r.tenant_id = ${tenantId}::uuid and e.envelope->'signatures'->0->>'keyid' = ${keyid}
          and not exists (select 1 from attesta_anchors a where a.tenant_id = r.tenant_id and a.record_id = r.id and a.status = 'anchored')`)).rows;
      return Number(rows[0]?.n ?? 0);
    },
    async tenantsWithPublishableKeys() {
      return (await db.execute(sql`select distinct t.tenant_id::text as tenant_id from attesta_tenant_keys t
        where t.status <> 'registered' and exists (select 1 from attesta_key_events e where e.key_id = t.id and e.action = 'activate')
        order by 1`)).rows.map((r) => String(r.tenant_id));
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Memory store (unit tests; mirrors pgTrustStore and the 0019 uniqueness rule)
// ---------------------------------------------------------------------------

export interface MemoryTrustState {
  keys: InventoryKey[];
  events: KeyEvent[];
  audits: AuditEvent[];
  documents: StoredDocument[];
  /** Unanchored ledger records by signing keyid (tests set it). */
  unanchored?: Record<string, number>;
}

/** In-memory TrustStore: transactions roll back on throw; keyids unique across scopes. */
export function memoryTrustStore(state: MemoryTrustState = { keys: [], events: [], audits: [], documents: [] }): TrustStore & { state: MemoryTrustState } {
  const clone = (s: MemoryTrustState): MemoryTrustState => ({
    keys: s.keys.map((k) => ({ ...k, spkiDer: Buffer.from(k.spkiDer) })), events: [...s.events], audits: [...s.audits], documents: [...s.documents],
    unanchored: s.unanchored,
  });
  const withEver = (k: InventoryKey): InventoryKey =>
    ({ ...k, everActive: state.events.some((e) => e.keyId === k.id && e.action === 'activate') });
  const store: TrustStore & { state: MemoryTrustState } = {
    state,
    async transaction(fn) {
      const snapshot = clone(state);
      try {
        return await fn(store);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
    async keyidRegistered(keyid) {
      return state.keys.some((k) => k.keyid === keyid);
    },
    async insertKey(k) {
      if (state.keys.some((x) => x.keyid === k.keyid)) throw new KeyidTakenError('keyid already registered');
      const key: InventoryKey = { ...k, id: randomUUID(), status: 'registered', revokedAt: null, revocationReason: null,
        compromisedSince: null, everActive: false };
      state.keys.push(key);
      return { ...key };
    },
    async tenantKeys(tenantId) {
      return state.keys.filter((k) => k.tenantId === tenantId).map(withEver);
    },
    async platformKeys() {
      return state.keys.filter((k) => k.tenantId === null).map(withEver);
    },
    async updateKey(key, c) {
      const row = state.keys.find((k) => k.id === key.id && k.tenantId === key.tenantId);
      if (!row || row.status !== key.status || row.revocationReason !== key.revocationReason || row.compromisedSince !== key.compromisedSince) {
        throw refuse(`key ${key.keyid} changed while this command ran; run the dry run again`);
      }
      Object.assign(row, c);
    },
    async insertEvent(e) {
      state.events.push({ ...e });
    },
    async insertAudit(a) {
      state.audits.push({ ...a });
    },
    async documents(scope) {
      return state.documents.filter((d) => d.scope === scope).sort((a, b) => a.version - b.version);
    },
    async insertDocument(d) {
      const max = Math.max(0, ...state.documents.filter((x) => x.scope === d.scope).map((x) => x.version));
      if (d.version !== max + 1) throw new Error('document version does not follow');
      state.documents.push({ ...d });
    },
    async unanchoredRecordsSignedBy(_tenantId, keyid) {
      return state.unanchored?.[keyid] ?? 0;
    },
    async tenantsWithPublishableKeys() {
      const ids = new Set(state.keys.filter((k) => k.tenantId !== null && withEver(k).everActive && k.status !== 'registered')
        .map((k) => k.tenantId as string));
      return [...ids].sort();
    },
  };
  return store;
}
