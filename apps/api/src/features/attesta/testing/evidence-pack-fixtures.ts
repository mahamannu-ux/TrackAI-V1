/**
 * Synthetic evidence-pack fixtures (Task15i2) shared by the unit tests of the pack
 * service and the routes: a bootstrapped trust inventory on its memory store with an
 * in-process KMS behind the real KmsSigner, a tenant chain built exactly as the
 * ledger builds it (records alternate two repositories, one minute apart, the first
 * four anchored in one batch), the segment the pg store would read for a scope, and
 * memory implementations of the pack store and the export sink. No customer data;
 * every key is generated per run. One injected clock (T0) for everything.
 */
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import type { EvidenceExportSink } from '../../../core/operations/evidence-export-sink';
import { ATTESTA_PLATFORM_TENANT_ID } from '../anchor-contract';
import { GENESIS_PREV_HASH, computeRecordHash, sha256Prefixed } from '../canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from '../dsse';
import {
  inScope, packTrustFrom,
  type PackAuditInput, type PackCounts, type PackJob, type PackRequest, type PackScope, type PackStore, type PackTrustMaterial,
  type Segment, type SegmentAnchor, type SegmentBatch, type SegmentRecord,
} from '../evidence-pack-service';
import { AI_PROVENANCE_PREDICATE_TYPE, LEDGER_RECORD_KIND, buildCanonicalRecord } from '../ledger';
import { inclusionPath, merkleRoot, proofToJson } from '../merkle';
import { SigningRejected, SigningUnavailable } from '../signer-contract';
import { KmsSigner, type KmsProvider } from '../signer-kms';
import { makeStatement, shaOf } from './ledger-fixtures';
import type { TrustDocumentBody } from '../trust-contract';
import { keyidOf, signTrustDocument } from '../trust-documents';
import {
  applyTenantKeyCommand, exportRootDraft, importRoot, memoryTrustStore, planTenantKeyCommand, publishKeyset, registerKey,
  type InventoryContext, type TrustAdapters, type TrustConfig,
} from '../trust-inventory';
import { inventorySignerResolver, publishedKeysFor } from '../trust-resolver';

export const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const R1 = 'cccccccc-0000-4000-8000-0000000000c1';
export const R2 = 'cccccccc-0000-4000-8000-0000000000c2';
export const PACK_1 = '11111111-0000-4000-8000-000000000001';
export const PACK_2 = '11111111-0000-4000-8000-000000000002';
/** One injected clock for every fixture (Task15l2 lesson). */
export const T0 = Date.parse('2026-10-13T12:00:00.000Z');
export const MIN = 60_000;
export const at = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Keys and trust: a bootstrapped inventory (root v1, keyset key, tenant statement keys)

export interface Key { priv: KeyObject; spki: Buffer; keyid: string }
export function newKey(): Key {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  return { priv: privateKey, spki, keyid: keyidOf(spki) };
}

export class FakeKms implements KmsProvider {
  readonly name = 'aws' as const;
  down = false;
  constructor(readonly keys: Map<string, Key>) {}
  async publicKeySpkiDer(ref: string): Promise<Buffer> {
    const k = this.keys.get(ref);
    if (!k) throw new SigningRejected('unknown key');
    return Buffer.from(k.spki);
  }
  async signDigest(ref: string, digest: Buffer): Promise<Buffer> {
    if (this.down) throw new SigningUnavailable('kms down');
    const k = this.keys.get(ref) as Key;
    const d = Buffer.from((k.priv.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
    return Buffer.from(p256.sign(new Uint8Array(digest), new Uint8Array(d), { prehash: false, format: 'der' }));
  }
  async health(): Promise<boolean> { return true; }
}

export async function trustWorld() {
  const k = { root: newKey(), anchor: newKey(), keyset: newKey(), a1: newKey(), b1: newKey() };
  const kms = new FakeKms(new Map([['ref-anchor', k.anchor], ['ref-keyset', k.keyset], ['ref-a1', k.a1], ['ref-b1', k.b1]]));
  const cred = (id: string, tenantId: string, key: Key) =>
    ({ credentialId: `aws-kms:${id}`, tenantId, displayName: id, keyReference: `ref-${id}`, publicKeySha256: key.keyid });
  const adapters: TrustAdapters = { 'kms-aws': new KmsSigner({ provider: kms, credentials: [
    cred('anchor', ATTESTA_PLATFORM_TENANT_ID, k.anchor), cred('keyset', ATTESTA_PLATFORM_TENANT_ID, k.keyset),
    cred('a1', A, k.a1), cred('b1', B, k.b1)] }) };
  const store = memoryTrustStore();
  const config: TrustConfig = { pinnedRootKeyids: [k.root.keyid], production: false };
  const now = () => new Date(T0 - 10 * MIN);
  const ctx: InventoryContext = { store, adapters, config, actor: 'op', requestId: 'r', now };
  const reg = (tenantId: string | null, id: string, purpose: 'statement' | 'anchor' | 'tenant_keyset' = 'statement') =>
    registerKey(ctx, { tenantId, purpose, adapterName: 'kms-aws', credentialRef: `aws-kms:${id}` });
  await reg(null, 'anchor', 'anchor');
  await reg(null, 'keyset', 'tenant_keyset');
  const signRoot = (body: TrustDocumentBody) => signTrustDocument(body, [{ keyid: k.root.keyid,
    sign: (b: Buffer) => cryptoSign('sha256', b, { key: k.root.priv, dsaEncoding: 'der' }) }]);
  await importRoot(ctx, await signRoot((await exportRootDraft(ctx, { rootSpkis: [k.root.spki], add: [k.anchor.keyid, k.keyset.keyid] })).body), 1);
  const activate = async (tenantId: string, keyid: string) => {
    const plan = await planTenantKeyCommand(ctx, 'activate', { tenantId, keyid });
    await applyTenantKeyCommand(ctx, 'activate', { tenantId, keyid }, plan.expect);
  };
  for (const [tenant, id, key] of [[A, 'a1', k.a1], [B, 'b1', k.b1]] as const) {
    await reg(tenant, id);
    await activate(tenant, key.keyid);
    await publishKeyset(ctx, tenant);
  }
  const resolver = inventorySignerResolver(store, adapters, config, { now: () => new Date(T0) });
  const material = async (tenantId: string): Promise<PackTrustMaterial> => packTrustFrom({
    published: await publishedKeysFor(store, tenantId),
    anchors: { rekorLogKey: createPublicKey(k.anchor.priv), anchorKeysSpkiDer: [k.anchor.spki], tsaAnchors: [],
      rekorLogIndexOffsets: { '1122334455667788': 7 } },
    pinnedRootKeyids: config.pinnedRootKeyids,
  });
  return { k, kms, store, adapters, config, ctx, reg, activate, resolver, material };
}
export type World = Awaited<ReturnType<typeof trustWorld>>;

// ---------------------------------------------------------------------------
// A chain for tenant A: records alternate R1/R2 one minute apart, signed with A's key;
// records 0..3 anchored in one batch (both types), the rest pending.

export interface ChainRecord extends SegmentRecord { statementCanonicalAll: string; envelopeAll: DsseEnvelope }

export function buildFixtureChain(tenantId: string, key: Key, n = 12, base = T0 - 3 * 60 * MIN): { records: ChainRecord[]; anchors: SegmentAnchor[]; batches: SegmentBatch[] } {
  const records: ChainRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let seq = 0; seq < n; seq++) {
    const repositoryId = seq % 2 === 0 ? R1 : R2;
    const subjectSha = shaOf(`${tenantId}-${seq}`);
    const statementCanonical = makeStatement({ repositoryId, subjectSha, asOf: at(base + seq * MIN - 1000) });
    const statementDigest = sha256Prefixed(statementCanonical);
    const recordedAt = at(base + seq * MIN);
    const canonicalRecord = buildCanonicalRecord({
      seq, prev_hash: prev, recorded_at: recordedAt, tenant_id: tenantId, record_kind: LEDGER_RECORD_KIND,
      statement_digest: statementDigest, predicate_type: AI_PROVENANCE_PREDICATE_TYPE, statement_kind: 'commit_observed',
      repository_id: repositoryId, subject_sha: subjectSha, outbox_subject_id: null,
    });
    const recordHash = computeRecordHash(canonicalRecord, prev);
    const payload = Buffer.from(statementCanonical, 'utf8');
    const sig = cryptoSign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: key.priv, dsaEncoding: 'der' });
    const envelope: DsseEnvelope = { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ keyid: key.keyid, sig: sig.toString('base64') }] };
    records.push({ seq, prevHash: prev, recordHash, canonicalRecord, recordedAt, repositoryId, statementDigest,
      statementCanonical, envelope, statementCanonicalAll: statementCanonical, envelopeAll: envelope });
    prev = recordHash;
  }
  if (n < 4) return { records, anchors: [], batches: [] };
  const leaves = records.slice(0, 4).map((r) => Buffer.from(r.recordHash.slice(7), 'hex'));
  const batchId = `${tenantId}:0-3`;
  const batches = [{ batchId, seqFrom: 0, seqTo: 3, leafCount: 4, merkleRoot: 'sha256:' + merkleRoot(leaves).toString('hex') }];
  const anchors: SegmentAnchor[] = [];
  for (let i = 0; i < 4; i++) {
    const merkle = proofToJson(i, 4, inclusionPath(leaves, i));
    anchors.push({ seq: i, anchorType: 'rekor', batchId, rekorEntryUuid: 'a'.repeat(64), tsaTokenB64: null,
      inclusionProof: { version: 1, merkle, anchor: { type: 'rekor', ref: 'a'.repeat(64), log_index: 1, proof_b64: 'AA==', rekor_entry: { integratedTime: 1 } } } });
    anchors.push({ seq: i, anchorType: 'tsa', batchId, rekorEntryUuid: null, tsaTokenB64: 'AAAA',
      inclusionProof: { version: 1, merkle, anchor: { type: 'tsa', ref: 'tsa:x', log_index: null, proof_b64: null, rekor_entry: null,
        gen_time: at(T0), serial_number: '1', policy: '1.2.3', revocation: { status: 'clean', reason: null } } } });
  }
  return { records, anchors, batches };
}

/** The segment the pg store would read: the same boundary rules, from the fixture. */
export function segmentOf(chain: ReturnType<typeof buildFixtureChain>, scope: PackScope, generatedAt: string, headOverride?: Segment['head']): Segment {
  const rs = chain.records;
  const before = rs.filter((r) => r.recordedAt < scope.from).map((r) => r.seq);
  const after = rs.filter((r) => r.recordedAt > scope.to).map((r) => r.seq);
  const fromSeq = before.length ? Math.max(...before) : 0;
  const toSeq = after.length ? Math.min(...after) : rs.length - 1;
  const records = rs.slice(fromSeq, toSeq + 1).map((r) => ({
    ...r, statementCanonical: inScope(r, scope) ? r.statementCanonicalAll : null, envelope: inScope(r, scope) ? r.envelopeAll : null,
  }));
  const scopedSeqs = new Set(records.filter((r) => inScope(r, scope)).map((r) => r.seq));
  const anchors = chain.anchors.filter((a) => scopedSeqs.has(a.seq));
  return {
    generatedAt, fromSeq, toSeq: rs.length === 0 ? -1 : toSeq,
    prevHash: fromSeq === 0 ? GENESIS_PREV_HASH : rs[fromSeq - 1].recordHash,
    head: headOverride !== undefined ? headOverride : after.length === 0 && rs.length > 0 ? { next_seq: rs.length, head_hash: rs[rs.length - 1].recordHash } : null,
    records: records.map(({ statementCanonicalAll: _s, envelopeAll: _e, ...r }) => r),
    anchors, batches: chain.batches.filter((b) => anchors.some((a) => a.batchId === b.batchId)),
  };
}

export class MemorySink implements EvidenceExportSink {
  files = new Map<string, string>();
  failWrite = false;
  async write(exportId: string, content: string) {
    if (this.failWrite) throw new Error('disk full');
    const ref = `mem:${exportId}:${this.files.size}`;
    this.files.set(ref, content);
    return { storageReference: ref, bytes: Buffer.byteLength(content) };
  }
  async read(ref: string) { const v = this.files.get(ref); if (v === undefined) throw new Error('gone'); return v; }
  async remove(ref: string) { this.files.delete(ref); }
}

export class MemoryPackStore implements PackStore {
  jobs: Array<PackJob & { leaseUntil: number | null }> = [];
  audits: PackAuditInput[] = [];
  clock = T0;
  readCount = 0;
  constructor(readonly chains: Map<string, ReturnType<typeof buildFixtureChain>>) {}
  async createOrGet(i: { tenantId: string; idempotencyKey: string; request: PackRequest; requestedBy: string; requestId: string }) {
    const found = this.jobs.find((j) => j.tenantId === i.tenantId && j.idempotencyKey === i.idempotencyKey);
    if (found) return { job: { ...found }, created: false };
    const job = { id: `22222222-0000-4000-8000-${String(this.jobs.length + 1).padStart(12, '0')}`, tenantId: i.tenantId,
      idempotencyKey: i.idempotencyKey, scope: i.request.scope, mode: i.request.mode, status: 'queued' as const,
      requestedBy: i.requestedBy, requestId: i.requestId, attempts: 0, packDigest: null, storageReference: null, bytes: null,
      counts: null, signatureEnvelope: null, errorCode: null, createdAt: at(this.clock), finishedAt: null, leaseUntil: null };
    this.jobs.push(job);
    return { job: { ...job }, created: true };
  }
  private find(t: string, id: string) { return this.jobs.find((j) => j.tenantId === t && j.id === id); }
  async get(t: string, id: string) { const j = this.find(t, id); return j ? { ...j } : null; }
  async findByKey(t: string, k: string) { const j = this.jobs.find((x) => x.tenantId === t && x.idempotencyKey === k); return j ? { ...j } : null; }
  async openCount(t: string) {
    return this.jobs.filter((j) => j.tenantId === t && ((j.status === 'queued' && Date.parse(j.createdAt) > this.clock - 600_000)
      || (j.status === 'running' && (j.leaseUntil ?? 0) > this.clock))).length;
  }
  async repositoryExists(_t: string, r: string) { return r === R1 || r === R2; }
  async segmentSize(t: string, scope: PackScope) { const s = segmentOf(this.chains.get(t) ?? buildFixtureChain(t, newKey(), 0), scope, at(this.clock)); return s.toSeq - s.fromSeq + 1; }
  async claim(t: string, id: string, leaseMs: number) {
    const j = this.find(t, id);
    if (!j || !(j.status === 'queued' || (j.status === 'running' && (j.leaseUntil ?? 0) < this.clock))) return null;
    j.status = 'running';
    j.attempts += 1;
    j.leaseUntil = this.clock + leaseMs;
    return j.attempts;
  }
  async readSegment(t: string, scope: PackScope) { this.readCount++; return segmentOf(this.chains.get(t) ?? buildFixtureChain(t, newKey(), 0), scope, at(this.clock)); }
  async finishReady(t: string, id: string, attempts: number, out: { packDigest: string; storageReference: string; bytes: number; counts: PackCounts; signatureEnvelope: DsseEnvelope }) {
    const j = this.find(t, id);
    if (!j || j.status !== 'running' || j.attempts !== attempts) return false;
    Object.assign(j, { status: 'ready', leaseUntil: null, ...out, finishedAt: at(this.clock) });
    return true;
  }
  async finishFailed(t: string, id: string, attempts: number | null, code: string) {
    const j = this.find(t, id);
    if (!j || (attempts === null ? j.status !== 'queued' : j.status !== 'running' || j.attempts !== attempts)) return false;
    Object.assign(j, { status: 'failed', leaseUntil: null, errorCode: code, finishedAt: at(this.clock) });
    return true;
  }
  async runnable(limit: number) {
    return this.jobs.filter((j) => j.status === 'queued' || (j.status === 'running' && (j.leaseUntil ?? 0) < this.clock))
      .slice(0, limit).map((j) => ({ tenantId: j.tenantId, id: j.id }));
  }
  async audit(input: PackAuditInput) { this.audits.push(input); }
}

