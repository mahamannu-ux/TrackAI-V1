/**
 * Independent oracle for evidence pack v1 (Task15i2). Written from
 * docs/contracts/attesta/evidence-pack.md, `trust.md` "Documents" and `envelope.md`
 * only, NOT from evidence-pack-service.ts: it re-derives every record hash, every
 * Merkle path, every statement digest and every DSSE signature from the download, with
 * its own SHA-256, RFC 6962 audit-path and PAE code. The one shared primitive is the
 * RFC 8785 canonicalizer (canonical.ts, proven against the JCS vectors).
 *
 * The seed of Muse's A15.10 offline verifier tests. Deliberately simpler than A15.10:
 * it does not verify Rekor entries or TSA tokens (only that each anchor's Merkle path
 * reaches its batch root), does not apply key validity windows or revocation times,
 * and walks the root chain by signatures only (no thresholds above 1, no expiry).
 * The pin is the caller's (`userPinnedRootKeyids`), never the pack's hint.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalize } from '../canonical';

export interface OracleResult {
  /** No break found (completeness may still be not checkable). */
  ok: boolean;
  breaks: string[];
  completeness: 'checked' | 'not_checkable';
  counts: { records: number; statements: number; anchorPaths: number };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const prefixed = (b: Buffer | string) => 'sha256:' + sha256Hex(b);
const GENESIS = 'sha256:' + '0'.repeat(64);
const SETTLE_MS = 5 * 60_000;

function paeBytes(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `, 'utf8'), payload]);
}

/** One-signature DSSE envelope check against keys by keyid; returns the payload or null. */
function dsse(env: unknown, payloadType: string, keys: Map<string, KeyObject>): { payload: Buffer; keyid: string } | null {
  if (!isObj(env) || env.payloadType !== payloadType || typeof env.payload !== 'string' || !Array.isArray(env.signatures)) return null;
  const payload = Buffer.from(env.payload, 'base64');
  if (payload.toString('base64') !== env.payload) return null;
  for (const s of env.signatures) {
    if (!isObj(s) || typeof s.keyid !== 'string' || typeof s.sig !== 'string') continue;
    const key = keys.get(s.keyid);
    if (key && verify('sha256', paeBytes(payloadType, payload), key, Buffer.from(s.sig, 'base64'))) return { payload, keyid: s.keyid };
  }
  return null;
}

function keyOf(entry: Obj): [string, KeyObject] | null {
  if (typeof entry.keyid !== 'string' || typeof entry.spki_der_b64 !== 'string') return null;
  const der = Buffer.from(entry.spki_der_b64, 'base64');
  if (prefixed(der) !== entry.keyid) return null; // trust.md rule 2: the keyid is recomputed
  return [entry.keyid, createPublicKey({ key: der, format: 'der', type: 'spki' })];
}

function docKeys(payload: Buffer): Obj[] {
  const body = JSON.parse(payload.toString('utf8')) as Obj;
  return Array.isArray(body.keys) ? (body.keys as unknown[]).filter(isObj) : [];
}

/** RFC 9162 §2.1.3.2: the root from a leaf hash and its audit path. */
function rootFromPath(leaf: Buffer, index: number, size: number, path: Buffer[]): Buffer | null {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return null;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  const node = (a: Buffer, b: Buffer) => createHash('sha256').update(Buffer.from([1])).update(a).update(b).digest();
  for (const p of path) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = node(p, r);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = node(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : null;
}

/**
 * Check a download `{pack, signature}` (parsed JSON) as an offline verifier would,
 * with the root pin supplied by the user.
 */
export function oracleVerifyPack(download: unknown, userPinnedRootKeyids: readonly string[]): OracleResult {
  const breaks: string[] = [];
  const out = (ok = breaks.length === 0, completeness: OracleResult['completeness'] = 'not_checkable', counts = { records: 0, statements: 0, anchorPaths: 0 }) =>
    ({ ok, breaks, completeness, counts });
  if (!isObj(download) || !isObj(download.pack) || Object.keys(download).sort().join() !== 'pack,signature') {
    breaks.push('download shape');
    return out(false);
  }
  const pack = download.pack;
  const expectedKeys = ['anchor_batches', 'anchors', 'manifest', 'records', 'reports', 'statements', 'trust', 'verification_hint', 'verifier'];
  if (Object.keys(pack).sort().join() !== expectedKeys.join()) breaks.push('pack top-level keys');
  const m = pack.manifest as Obj;
  if (!isObj(m) || m.format !== 'https://trackai.dev/attesta/evidence-pack/v1') {
    breaks.push('manifest format');
    return out(false);
  }
  const packDigest = prefixed(canonicalize(pack));

  // --- trust: root chain from the USER's pin, then the tenant's key sets.
  const trust = pack.trust as Obj;
  let rootKeys = new Map<string, KeyObject>();
  let newestRootKeys: Obj[] = [];
  const roots = Array.isArray(trust?.root_documents) ? trust.root_documents as unknown[] : [];
  roots.forEach((doc, i) => {
    let signerKeys = rootKeys;
    if (i === 0) {
      // Version 1 is signed by its own root keys; only the user's pinned ones count.
      const payload = isObj(doc) && typeof doc.payload === 'string' ? Buffer.from(doc.payload, 'base64') : Buffer.alloc(0);
      signerKeys = new Map(docKeys(payload).filter((k) => k.purpose === 'root' && userPinnedRootKeyids.includes(k.keyid as string))
        .map(keyOf).filter((x): x is [string, KeyObject] => x !== null));
    }
    const ok = dsse(doc, 'application/vnd.trackai.trust-root+json', signerKeys);
    if (!ok) {
      breaks.push(`root document ${i + 1} not signed by a trusted root key`);
      return;
    }
    const keys = docKeys(ok.payload);
    rootKeys = new Map(keys.filter((k) => k.purpose === 'root').map(keyOf).filter((x): x is [string, KeyObject] => x !== null));
    newestRootKeys = keys;
  });
  if (roots.length === 0) breaks.push('no root document');
  const keysetSigners = new Map(newestRootKeys.filter((k) => k.purpose === 'tenant_keyset').map(keyOf).filter((x): x is [string, KeyObject] => x !== null));
  const statementKeys = new Map<string, KeyObject>();
  let activeKeys = new Map<string, KeyObject>();
  const keysets = Array.isArray(trust?.keyset_documents) ? trust.keyset_documents as unknown[] : [];
  keysets.forEach((doc, i) => {
    const ok = dsse(doc, 'application/vnd.trackai.keyset+json', keysetSigners);
    if (!ok) {
      breaks.push(`key set ${i + 1} not signed by a tenant_keyset key of the root`);
      return;
    }
    const body = JSON.parse(ok.payload.toString('utf8')) as Obj;
    if (body.scope !== m.tenant_id) breaks.push(`key set ${i + 1} is for another tenant`);
    activeKeys = new Map();
    for (const k of docKeys(ok.payload)) {
      const kv = keyOf(k);
      if (!kv || k.purpose !== 'statement') continue;
      statementKeys.set(kv[0], kv[1]);
      if (k.status === 'active') activeKeys.set(kv[0], kv[1]);
    }
  });

  // --- the pack signature (RP-1)
  const sig = dsse(download.signature, 'application/vnd.trackai.evidence-pack+json', activeKeys);
  if (!sig) breaks.push('pack signature does not verify with an active key of the newest key set');
  else {
    const body = JSON.parse(sig.payload.toString('utf8')) as Obj;
    if (canonicalize(body) !== sig.payload.toString('utf8')) breaks.push('signature payload not canonical');
    if (body.pack_digest !== packDigest) breaks.push('pack digest does not match the signature');
    if (canonicalize(body.manifest) !== canonicalize(m)) breaks.push('signed manifest differs from the pack manifest');
  }

  // --- section digests
  const sections = isObj(m.sections) ? m.sections : {};
  for (const name of ['records', 'statements', 'anchors', 'anchor_batches', 'trust', 'verification_hint', 'reports', 'verifier']) {
    if (sections[name] !== prefixed(canonicalize(pack[name]))) breaks.push(`section digest ${name}`);
  }

  // --- records: contiguous, linked, hashes recomputed
  const range = m.chain_range as Obj;
  const scope = m.scope as Obj;
  const records = Array.isArray(pack.records) ? pack.records as Obj[] : [];
  const fromSeq = Number(range?.from_seq);
  let prev = range?.prev_hash;
  if (fromSeq === 0 && prev !== GENESIS) breaks.push('seq 0 must follow genesis');
  const parsed: Array<Obj | null> = [];
  records.forEach((r, i) => {
    if (r.seq !== fromSeq + i) breaks.push(`seq gap at ${fromSeq + i}`);
    if (r.prev_hash !== prev) breaks.push(`link broken at ${r.seq}`);
    if (typeof r.canonical_record === 'string') {
      if (prefixed(Buffer.concat([Buffer.from(r.canonical_record, 'utf8'), Buffer.from(String(r.prev_hash), 'utf8')])) !== r.record_hash) {
        breaks.push(`record hash at ${r.seq}`);
      }
      const c = JSON.parse(r.canonical_record) as Obj;
      if (canonicalize(c) !== r.canonical_record) breaks.push(`record not canonical at ${r.seq}`);
      if (c.seq !== r.seq || c.prev_hash !== r.prev_hash || c.tenant_id !== m.tenant_id) breaks.push(`record fields at ${r.seq}`);
      parsed.push(c);
    } else {
      parsed.push(null);
    }
    prev = r.record_hash;
  });
  if (records.length !== Number(range?.to_seq) - fromSeq + 1 && !(records.length === 0 && range?.to_seq === -1)) breaks.push('segment length');
  const head = range?.head as Obj | null;
  if (head) {
    if (head.next_seq !== Number(range.to_seq) + 1) breaks.push('head next_seq');
    if (records.length > 0 && head.head_hash !== prev) breaks.push('head hash');
  }

  // --- window and completeness
  const inScope = (c: Obj) => typeof c.recorded_at === 'string' && c.recorded_at >= String(scope.from) && c.recorded_at <= String(scope.to) &&
    (scope.repository_id === null || c.repository_id === scope.repository_id);
  let completeness: OracleResult['completeness'] = 'not_checkable';
  const expected = new Map<number, string>();
  if (scope.mode === 'full' && parsed.every((c) => c !== null)) {
    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (first && fromSeq !== 0 && !(String(first.recorded_at) < String(scope.from))) breaks.push('first record is inside the window');
    if (last && !head && !(String(last.recorded_at) > String(scope.to))) breaks.push('last record is inside the window and the head is not reached');
    if (Date.parse(String(scope.to)) > Date.parse(String(m.generated_at)) - SETTLE_MS) breaks.push('window not settled');
    for (const c of parsed as Obj[]) if (inScope(c)) expected.set(Number(c.seq), String(c.statement_digest));
    completeness = 'checked';
  } else {
    for (const c of parsed) if (c && inScope(c)) expected.set(Number(c.seq), String(c.statement_digest));
  }

  // --- statements: digest, record link, envelope signature
  const statements = Array.isArray(pack.statements) ? pack.statements as Obj[] : [];
  const listed = new Set<number>();
  for (const s of statements) {
    const seq = Number(s.seq);
    listed.add(seq);
    if (typeof s.statement_canonical !== 'string' || prefixed(Buffer.from(s.statement_canonical, 'utf8')) !== s.statement_digest) {
      breaks.push(`statement digest at ${seq}`);
    }
    if (expected.get(seq) !== s.statement_digest) breaks.push(`statement at ${seq} is not the in-scope record's`);
    const env = dsse(s.envelope, 'application/vnd.in-toto+json', statementKeys);
    if (!env) breaks.push(`statement signature at ${seq}`);
    else if (env.payload.toString('utf8') !== s.statement_canonical) breaks.push(`envelope payload at ${seq}`);
  }
  if (completeness === 'checked') {
    for (const seq of expected.keys()) if (!listed.has(seq)) breaks.push(`in-scope statement ${seq} left out`);
  }
  const anchoredCount = statements.filter((s) => s.anchor_status === 'anchored').length;
  const counts = m.counts as Obj;
  if (counts?.statements !== statements.length || counts?.pending !== statements.length - anchoredCount) breaks.push('counts');

  // --- anchors: Merkle path from the record hash to the batch root
  const batches = new Map((Array.isArray(pack.anchor_batches) ? pack.anchor_batches as Obj[] : []).map((b) => [b.batch_id, b]));
  const hashBySeq = new Map(records.map((r) => [Number(r.seq), String(r.record_hash)]));
  let anchorPaths = 0;
  for (const a of Array.isArray(pack.anchors) ? pack.anchors as Obj[] : []) {
    const b = batches.get(a.batch_id);
    const proof = isObj(a.inclusion_proof) && isObj(a.inclusion_proof.merkle) ? a.inclusion_proof.merkle : null;
    const recordHash = hashBySeq.get(Number(a.seq));
    if (!b || !proof || !recordHash || !Array.isArray(proof.path)) {
      breaks.push(`anchor at ${a.seq} incomplete`);
      continue;
    }
    if (proof.leaf_index !== Number(a.seq) - Number(b.seq_from) || proof.tree_size !== b.leaf_count) breaks.push(`anchor binding at ${a.seq}`);
    const leaf = createHash('sha256').update(Buffer.from([0])).update(Buffer.from(recordHash.slice(7), 'hex')).digest();
    const root = rootFromPath(leaf, Number(proof.leaf_index), Number(proof.tree_size), (proof.path as string[]).map((h) => Buffer.from(h, 'hex')));
    if (!root || 'sha256:' + root.toString('hex') !== b.merkle_root) breaks.push(`merkle path at ${a.seq}`);
    else anchorPaths += 1;
  }
  return out(breaks.length === 0, completeness, { records: records.length, statements: statements.length, anchorPaths });
}
