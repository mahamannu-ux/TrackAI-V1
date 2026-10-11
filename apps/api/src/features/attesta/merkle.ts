// Ported from SushiCorp B3 core/evidence/merkle.py @ 0bd67a5 (catalog EV-1).
// Deviations: (1) camelCase names (`merkleRoot`, `inclusionPath`,
// `rootFromPath`, `verifyInclusion`, `leafHash`, `nodeHash`) per the session
// spec; (2) the `InclusionProof` dataclass becomes the `InclusionProofJson`
// interface plus `proofToJson`/`proofFromJson` functions; `from_json`
// range checks added (`leaf_index`/`tree_size` must be non-negative integers
// with `leaf_index < tree_size`); (3) `verifyInclusion` returns false (never
// throws) on any malformed input, including a wrong-length expected root;
// (4) `TypeError`/`RangeError` from the spec surface as `Error`/`RangeError`
// from the natural JS operations (`Buffer` bounds, `timingSafeEqual`).
// RFC 6962 / RFC 9162 Merkle trees over a batch of record hashes: one tree
// per anchoring batch, each leaf's data the 32 raw bytes of a record's
// `record_hash`. Leaves and interior nodes are domain-separated (0x00 /
// 0x01 prefixes) so an interior node can never be passed off as a leaf.

import { createHash, timingSafeEqual } from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** SHA-256(0x00 ‖ data). */
export function leafHash(data: Buffer): Buffer {
  return createHash('sha256').update(LEAF_PREFIX).update(data).digest();
}

/** SHA-256(0x01 ‖ left ‖ right). */
export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(NODE_PREFIX).update(left).update(right).digest();
}

/** Largest power of two strictly less than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(hashes: Buffer[]): Buffer {
  if (hashes.length === 1) return hashes[0];
  const k = split(hashes.length);
  return nodeHash(mth(hashes.slice(0, k)), mth(hashes.slice(k)));
}

/** MTH(D[n]) over leaf *data* (not pre-hashed). An empty batch is refused. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new Error('a Merkle batch must contain at least one leaf');
  return mth(leaves.map((d) => leafHash(d)));
}

function pathFor(m: number, hashes: Buffer[]): Buffer[] {
  if (hashes.length === 1) return [];
  const k = split(hashes.length);
  if (m < k) return [...pathFor(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  return [...pathFor(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

/** PATH(m, D[n]): audit path for leaf `index`, bottom-up. */
export function inclusionPath(leaves: Buffer[], index: number): Buffer[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`leaf index ${index} outside tree of size ${leaves.length}`);
  }
  return pathFor(index, leaves.map((d) => leafHash(d)));
}

/**
 * Recompute the root from a leaf hash and its audit path (RFC 9162
 * Section 2.1.3.2). Throws if the path is longer or shorter than this
 * position requires, so a truncated or padded proof can never verify.
 */
export function rootFromPath(leaf: Buffer, index: number, treeSize: number, path: Buffer[]): Buffer {
  if (!Number.isInteger(treeSize) || treeSize < 1 || !Number.isInteger(index) || index < 0 || index >= treeSize) {
    throw new RangeError(`leaf index ${index} outside tree of size ${treeSize}`);
  }
  let fn = index;
  let sn = treeSize - 1;
  let r: Buffer = Buffer.from(leaf);
  for (const p of path) {
    if (sn === 0) throw new Error('inclusion path is longer than the tree allows');
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn !== 0 && fn % 2 === 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (sn !== 0) throw new Error('inclusion path is shorter than the tree requires');
  return r;
}

/** True iff `data` is leaf `index` of the size-`treeSize` tree with `root`. */
export function verifyInclusion(
  leaf: Buffer,
  index: number,
  treeSize: number,
  path: Buffer[],
  expectedRoot: Buffer,
): boolean {
  try {
    const root = rootFromPath(leafHash(leaf), index, treeSize, path);
    if (root.length !== expectedRoot.length) return false;
    return timingSafeEqual(root, expectedRoot);
  } catch {
    return false;
  }
}

/** Where one record sits in its batch tree. Stored with the evidence row. */
export interface InclusionProofJson {
  /** lowercase hex */
  leaf_index: number;
  tree_size: number;
  /** lowercase hex, one 32-byte node each */
  path: string[];
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

export function proofToJson(leafIndex: number, treeSize: number, path: Buffer[]): InclusionProofJson {
  return { leaf_index: leafIndex, tree_size: treeSize, path: path.map((p) => p.toString('hex')) };
}

export function proofFromJson(data: unknown): { leafIndex: number; treeSize: number; path: Buffer[] } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('merkle proof must be an object');
  }
  const { leaf_index: index, tree_size: size, path } = data as Record<string, unknown>;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new Error('merkle proof leaf_index must be a non-negative integer');
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    throw new Error('merkle proof tree_size must be a positive integer');
  }
  if (index >= size) throw new Error('merkle proof leaf_index must be below tree_size');
  if (!Array.isArray(path) || !path.every((p): p is string => typeof p === 'string')) {
    throw new Error('merkle proof path must be a list of hex strings');
  }
  if (!path.every((p) => HEX_32_BYTES.test(p))) {
    throw new Error('merkle proof path entries must be 32 bytes of lowercase hex');
  }
  return { leafIndex: index, treeSize: size, path: path.map((p) => Buffer.from(p, 'hex')) };
}
