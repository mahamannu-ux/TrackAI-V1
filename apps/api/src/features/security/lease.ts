/**
 * Security activation leases (Task20f, T20.8; design note D4): the per-machine signed
 * `trackai.security-activation-lease/2`, issued lazily, kept forever as provenance, and
 * the Endpoint's acknowledgement of a lease and bundle.
 *
 * The rules live here as pure logic over a `SecurityLeaseStore`; lease-store.ts is the
 * Postgres store (withTenant, append-only tables, audit in the same transaction), and
 * the tests use an in-memory one. Tenant and machine always come from the caller's
 * credential, never from a request.
 *
 * Order (AGENTS.md §9 item 18): read the state → sign (no transaction; may call KMS) →
 * record (one transaction that re-checks the newest lease, so two concurrent fetches
 * keep one lease when the first is still reusable).
 */
import { randomUUID } from 'node:crypto';
import {
  SECURITY_ACKNOWLEDGEMENT_SCHEMA,
  SECURITY_ACTIVATION_LEASE_SCHEMA,
  SECURITY_V2_DEFAULT_LEASE_VALIDITY_HOURS,
  SECURITY_V2_LEASE_REFRESH_SECONDS,
  SECURITY_V2_REFUSAL_CODES,
  type SecurityActivationLeaseV2,
  type SecurityDataSettingsV1,
  type SecurityV2RefusalCode,
} from '../security-findings/v2-contract';
import type { LeaseSettings, MonitorMode } from './settings';
import { signSecurityDocument, type SecurityDocumentSigner } from './signing';

export const LEASE_VALIDITY_MS = SECURITY_V2_DEFAULT_LEASE_VALIDITY_HOURS * 3_600_000;
/** A stored lease is reused while it is younger than this (the Endpoint refreshes hourly). */
export const LEASE_REUSE_MS = SECURITY_V2_LEASE_REFRESH_SECONDS * 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type LeaseMode = 'off' | 'monitor' | 'monitor_and_pilot_block';

export interface StoredLease {
  id: string;
  machineId: string;
  issuedAt: Date;
  expiresAt: Date;
  mode: LeaseMode;
  bundleDigest: string;
  dataSettingsVersion: number;
  /** The exact envelope JSON bytes, served unchanged. */
  envelope: Buffer;
  keyid: string;
}

/** What a new lease is issued from: the tenant's newest bundle and lease-settings row. */
export interface LeaseIssuanceState {
  bundle: { id: string; digest: string; epoch: number; bundleVersion: number } | null;
  /** 0 = no stored row (defaults: monitoring off). */
  dataSettingsVersion: number;
  monitorMode: MonitorMode;
  settings: LeaseSettings;
}

export interface StoredBundleRef {
  id: string;
  digest: string;
  epoch: number;
  bundleVersion: number;
}

export interface AcknowledgementRecord {
  tenantId: string;
  machineId: string;
  lease: StoredLease;
  bundleDigest: string;
  result: 'applied' | 'refused';
  refusalCode: SecurityV2RefusalCode | null;
  receivedAt: Date;
}

/**
 * Storage for leases. Every method is tenant-bound; machine-bound ones never return
 * another machine's row. `insertLease` writes `fleet.lease.issued` and
 * `recordAcknowledgement` writes `policy.bundle.acknowledged` or `fleet.lease.refused`
 * in the same transaction as the row.
 */
export interface SecurityLeaseStore {
  machineIsActive(tenantId: string, machineId: string): Promise<boolean>;
  issuanceState(tenantId: string): Promise<LeaseIssuanceState>;
  newestLease(tenantId: string, machineId: string): Promise<StoredLease | null>;
  leaseById(tenantId: string, machineId: string, leaseId: string): Promise<StoredLease | null>;
  /**
   * Under a lock shared with settings publication (so no publish commits meanwhile) and
   * the per-machine lock, re-read the tenant's issuance state and the machine's newest
   * lease, and let `decide` choose: store this signed lease, serve the newest one, or
   * report the signed state stale. Returns what is served, or null when stale (nothing
   * written).
   */
  insertLease(tenantId: string, lease: StoredLease, epoch: number,
    decide: (newest: StoredLease | null, current: LeaseIssuanceState) => LeaseInsertDecision): Promise<StoredLease | null>;
  bundleByDigest(tenantId: string, digest: string): Promise<StoredBundleRef | null>;
  bundleEnvelope(tenantId: string, digest: string): Promise<Buffer | null>;
  currentDataSettings(tenantId: string): Promise<SecurityDataSettingsV1 | null>;
  recordAcknowledgement(record: AcknowledgementRecord, bundle: StoredBundleRef | null): Promise<void>;
}

export type LeaseInsertDecision = 'insert' | 'serve' | 'stale';

/** The issuance state a lease was signed under is still the tenant's current one. */
export function sameIssuanceState(signed: LeaseIssuanceState, current: LeaseIssuanceState): boolean {
  return signed.bundle?.digest === current.bundle?.digest
    && signed.dataSettingsVersion === current.dataSettingsVersion
    && signed.monitorMode === current.monitorMode;
}

/** How often a lease is re-signed when settings move while it is being signed. */
const LEASE_ISSUE_ATTEMPTS = 3;

/** Settings kept moving while the lease was being signed (500 SECURITY_V2_INTERNAL; nothing written). */
export class SecurityLeaseStateMoved extends Error {
  constructor() {
    super('state_moved');
    this.name = 'SecurityLeaseStateMoved';
  }
}

/** No lease can be issued: no bundle yet, or the machine is not active (404 LEASE_NOT_ISSUED). */
export class SecurityLeaseNotIssued extends Error {
  constructor(readonly reason: 'no_bundle' | 'machine_inactive') {
    super(reason);
    this.name = 'SecurityLeaseNotIssued';
  }
}

/** The acknowledgement names no lease of this machine, or `applied` names another digest (404 NOT_FOUND). */
export class SecurityAcknowledgementNotFound extends Error {
  constructor() {
    super('not_found');
    this.name = 'SecurityAcknowledgementNotFound';
  }
}

/** True while a stored lease may be served again for the current state (D4). */
export function leaseIsReusable(lease: StoredLease | null, state: LeaseIssuanceState, now: Date): lease is StoredLease {
  if (!lease || !state.bundle) return false;
  const age = now.getTime() - lease.issuedAt.getTime();
  return age >= 0 && age < LEASE_REUSE_MS
    && now.getTime() < lease.expiresAt.getTime()
    && lease.bundleDigest === state.bundle.digest
    && lease.dataSettingsVersion === state.dataSettingsVersion
    && lease.mode === state.monitorMode;
}

export function leasePayload(input: {
  tenantId: string;
  machineId: string;
  leaseId: string;
  issuedAt: Date;
  state: LeaseIssuanceState & { bundle: NonNullable<LeaseIssuanceState['bundle']> };
}): SecurityActivationLeaseV2 {
  const mode = input.state.monitorMode;
  return {
    schema_version: SECURITY_ACTIVATION_LEASE_SCHEMA,
    tenant_id: input.tenantId,
    machine_id: input.machineId,
    lease_id: input.leaseId,
    issued_at: input.issuedAt.toISOString(),
    expires_at: new Date(input.issuedAt.getTime() + LEASE_VALIDITY_MS).toISOString(),
    mode,
    // An off lease activates no agent (the contract requires agents only for monitor modes).
    agents: mode === 'off' ? [] : [...input.state.settings.agents],
    bundle_digest: input.state.bundle.digest,
    data_settings: { ...input.state.settings.data },
    day_one_scan: input.state.settings.dayOneScan,
  };
}

/**
 * `GET /lease`: the machine's newest lease while it is reusable, otherwise a new one
 * signed with the activation_lease key, stored, and audited (`fleet.lease.issued`).
 * Throws SecurityLeaseNotIssued, or SecuritySigningUnavailable (nothing is written).
 */
export async function currentOrIssueLease(input: {
  store: SecurityLeaseStore;
  signer: SecurityDocumentSigner;
  tenantId: string;
  machineId: string;
  now: Date;
}): Promise<StoredLease> {
  if (input.signer.purpose !== 'activation_lease') throw new Error('a lease is signed with the activation_lease key');
  const { store, tenantId, machineId, now } = input;
  if (!await store.machineIsActive(tenantId, machineId)) throw new SecurityLeaseNotIssued('machine_inactive');
  for (let attempt = 0; attempt < LEASE_ISSUE_ATTEMPTS; attempt += 1) {
    const served = await issueOnce(input.signer, store, tenantId, machineId, now);
    if (served) return served;
  }
  throw new SecurityLeaseStateMoved();
}

/** One read → sign → record round; null when the settings moved during signing. */
async function issueOnce(signer: SecurityDocumentSigner, store: SecurityLeaseStore, tenantId: string, machineId: string,
  now: Date): Promise<StoredLease | null> {
  const state = await store.issuanceState(tenantId);
  const bundle = state.bundle;
  if (!bundle) throw new SecurityLeaseNotIssued('no_bundle');
  const newest = await store.newestLease(tenantId, machineId);
  if (leaseIsReusable(newest, state, now)) return newest;

  const leaseId = randomUUID();
  const payload = leasePayload({ tenantId, machineId, leaseId, issuedAt: now, state: { ...state, bundle } });
  const signed = await signSecurityDocument(signer, payload);
  const lease: StoredLease = {
    id: leaseId,
    machineId,
    issuedAt: now,
    expiresAt: new Date(payload.expires_at),
    mode: payload.mode,
    bundleDigest: bundle.digest,
    dataSettingsVersion: state.dataSettingsVersion,
    envelope: signed.envelopeBytes,
    keyid: signed.keyid,
  };
  // Under the locks: a lease signed for settings that changed meanwhile (an `off` switch
  // included) is never stored, so it is re-signed for the current state (cross-review fix);
  // a lease another fetch stored meanwhile is served when it is still reusable or newer.
  return store.insertLease(tenantId, lease, bundle.epoch, (latest, current) => {
    if (!sameIssuanceState(state, current)) return 'stale';
    if (latest && (latest.issuedAt.getTime() > now.getTime() || leaseIsReusable(latest, current, now))) return 'serve';
    return 'insert';
  });
}

export interface SecurityAcknowledgementV1Input {
  leaseId: string;
  bundleDigest: string;
  result: 'applied' | 'refused';
  refusalCode: SecurityV2RefusalCode | null;
}

export type AcknowledgementParseCode =
  | 'SECURITY_V2_INVALID_BODY'
  | 'SECURITY_V2_UNKNOWN_FIELD'
  | 'SECURITY_V2_UNSUPPORTED_SCHEMA';

export class AcknowledgementParseError extends Error {
  constructor(readonly code: AcknowledgementParseCode) {
    super(code);
    this.name = 'AcknowledgementParseError';
  }
}

const ACK_KEYS = ['schema_version', 'lease_id', 'bundle_digest', 'result', 'refusal_code'];

/**
 * security-acknowledgement-v1, closed. Unknown fields (a `tenant_id` or `machine_id`
 * included) are refused, never stripped (api.md isolation case 7).
 */
export function parseAcknowledgement(value: unknown): SecurityAcknowledgementV1Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !ACK_KEYS.includes(key))) throw new AcknowledgementParseError('SECURITY_V2_UNKNOWN_FIELD');
  if (body.schema_version !== SECURITY_ACKNOWLEDGEMENT_SCHEMA) {
    throw new AcknowledgementParseError(typeof body.schema_version === 'string' ? 'SECURITY_V2_UNSUPPORTED_SCHEMA' : 'SECURITY_V2_INVALID_BODY');
  }
  const leaseId = body.lease_id;
  if (typeof leaseId !== 'string' || leaseId.length < 1 || leaseId.length > 128 || /\s/.test(leaseId)) {
    throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
  }
  if (typeof body.bundle_digest !== 'string' || !SHA256_RE.test(body.bundle_digest)) throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
  if (body.result === 'applied') {
    if (body.refusal_code !== undefined) throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
    return { leaseId, bundleDigest: body.bundle_digest, result: 'applied', refusalCode: null };
  }
  if (body.result === 'refused') {
    const code = body.refusal_code;
    if (typeof code !== 'string' || !(SECURITY_V2_REFUSAL_CODES as readonly string[]).includes(code)) {
      throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
    }
    return { leaseId, bundleDigest: body.bundle_digest, result: 'refused', refusalCode: code as SecurityV2RefusalCode };
  }
  throw new AcknowledgementParseError('SECURITY_V2_INVALID_BODY');
}

/**
 * `POST /acknowledgements`: binds the named lease to this credential's tenant and
 * machine. A missing, foreign-tenant or other-machine lease, and an `applied` naming a
 * digest other than the lease's, all throw SecurityAcknowledgementNotFound and write
 * nothing. A refusal stores the digest the Endpoint reports (it may be the bundle it
 * refused to apply).
 */
export async function recordLeaseAcknowledgement(input: {
  store: SecurityLeaseStore;
  tenantId: string;
  machineId: string;
  acknowledgement: SecurityAcknowledgementV1Input;
  now: Date;
}): Promise<void> {
  const { store, tenantId, machineId, acknowledgement } = input;
  // Lease ids are uuids; anything else names no lease (and never reaches a uuid cast).
  if (!UUID_RE.test(acknowledgement.leaseId)) throw new SecurityAcknowledgementNotFound();
  const lease = await store.leaseById(tenantId, machineId, acknowledgement.leaseId);
  if (!lease) throw new SecurityAcknowledgementNotFound();
  let bundle: StoredBundleRef | null = null;
  if (acknowledgement.result === 'applied') {
    if (acknowledgement.bundleDigest !== lease.bundleDigest) throw new SecurityAcknowledgementNotFound();
    bundle = await store.bundleByDigest(tenantId, lease.bundleDigest);
    if (!bundle) throw new SecurityAcknowledgementNotFound();
  }
  await store.recordAcknowledgement({
    tenantId,
    machineId,
    lease,
    bundleDigest: acknowledgement.bundleDigest,
    result: acknowledgement.result,
    refusalCode: acknowledgement.refusalCode,
    receivedAt: input.now,
  }, bundle);
}
