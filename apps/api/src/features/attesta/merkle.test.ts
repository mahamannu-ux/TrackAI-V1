import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  inclusionPath,
  leafHash,
  merkleRoot,
  nodeHash,
  proofFromJson,
  proofToJson,
  rootFromPath,
  verifyInclusion,
} from './merkle';

// RFC 6962 test data used by certificate-transparency implementations,
// copied exactly from the source suite.
const CT_LEAVES: Buffer[] = [
  Buffer.from([]),
  Buffer.from([0x00]),
  Buffer.from([0x10]),
  Buffer.from([0x20, 0x21]),
  Buffer.from([0x30, 0x31]),
  Buffer.from([0x40, 0x41, 0x42, 0x43]),
  Buffer.from([0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57]),
  Buffer.from([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f]),
];
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

for (let size = 1; size <= 8; size++) {
  test(`RFC 6962 known root for tree size ${size}`, () => {
    assert.equal(merkleRoot(CT_LEAVES.slice(0, size)).toString('hex'), CT_ROOTS[size - 1]);
  });
}

test('leaf and interior nodes are domain-separated', () => {
  assert.deepEqual(leafHash(Buffer.from('x')), createHash('sha256').update(Buffer.from([0x00, 0x78])).digest());
  assert.deepEqual(
    nodeHash(Buffer.from('a'), Buffer.from('b')),
    createHash('sha256').update(Buffer.from([0x01, 0x61, 0x62])).digest(),
  );
});

test('an empty batch is refused', () => {
  assert.throws(() => merkleRoot([]));
});

function leaves(n: number): Buffer[] {
  return Array.from({ length: n }, (_, i) => createHash('sha256').update(String(i)).digest());
}

for (let n = 1; n <= 33; n++) {
  test(`every leaf of a ${n}-leaf tree proves inclusion`, () => {
    const ls = leaves(n);
    const root = merkleRoot(ls);
    for (let i = 0; i < n; i++) {
      const path = inclusionPath(ls, i);
      assert.equal(verifyInclusion(ls[i], i, n, path, root), true, `leaf ${i} of ${n}`);
      assert.deepEqual(rootFromPath(leafHash(ls[i]), i, n, path), root);
    }
  });
}

test('a proof for one leaf fails for another leaf', () => {
  const ls = leaves(8);
  const root = merkleRoot(ls);
  const path = inclusionPath(ls, 2);
  assert.equal(verifyInclusion(ls[5], 2, 8, path, root), false);
  assert.equal(verifyInclusion(ls[2], 5, 8, path, root), false);
  assert.equal(verifyInclusion(ls[2], 2, 8, path, createHash('sha256').update('x').digest()), false);
});

test('a proof fails for a wrong tree size', () => {
  const ls = leaves(5);
  const root = merkleRoot(ls);
  const path = inclusionPath(ls, 4);
  assert.equal(verifyInclusion(ls[4], 4, 6, path, root), false);
  assert.equal(verifyInclusion(ls[4], 4, 4, path, root), false);
  assert.equal(verifyInclusion(ls[4], 5, 5, path, root), false);
});

test('truncated, tampered, and padded paths fail', () => {
  const ls = leaves(8);
  const root = merkleRoot(ls);
  const path = inclusionPath(ls, 3);
  assert.ok(path.length > 0);
  assert.equal(verifyInclusion(ls[3], 3, 8, path.slice(0, -1), root), false);
  const tampered = path.map((p) => Buffer.from(p));
  tampered[0] = Buffer.from(tampered[0]);
  tampered[0][0] ^= 1;
  assert.equal(verifyInclusion(ls[3], 3, 8, tampered, root), false);
  assert.equal(verifyInclusion(ls[3], 3, 8, [...path, root], root), false);
});

test('an interior node cannot pass as a leaf', () => {
  const ls = leaves(4);
  const root = merkleRoot(ls);
  const interior = nodeHash(leafHash(ls[0]), leafHash(ls[1]));
  const sibling = nodeHash(leafHash(ls[2]), leafHash(ls[3]));
  assert.equal(verifyInclusion(interior, 0, 2, [sibling], root), false);
});

test('rootFromPath rejects bad positions', () => {
  assert.throws(() => rootFromPath(Buffer.alloc(32), 3, 3, []));
  assert.throws(() => rootFromPath(Buffer.alloc(32), 0, 0, []));
  assert.throws(() => rootFromPath(Buffer.alloc(32), -1, 2, []));
});

test('inclusionPath checks its index', () => {
  assert.throws(() => inclusionPath(leaves(2), 2));
  assert.throws(() => inclusionPath(leaves(2), -1));
});

test('proof JSON round-trips', () => {
  const ls = leaves(7);
  const path = inclusionPath(ls, 3);
  const json = proofToJson(3, 7, path);
  assert.deepEqual(json, {
    leaf_index: 3,
    tree_size: 7,
    path: path.map((p) => p.toString('hex')),
  });
  const back = proofFromJson(JSON.parse(JSON.stringify(json)));
  assert.equal(back.leafIndex, 3);
  assert.equal(back.treeSize, 7);
  assert.deepEqual(back.path, path);
});

test('proofFromJson rejects bad JSON', () => {
  const bad: unknown[] = [
    null,
    { leaf_index: true, tree_size: 7, path: [] },
    { leaf_index: 1, tree_size: '7', path: [] },
    { leaf_index: 1, tree_size: 7, path: 'ab' },
    { leaf_index: 1, tree_size: 7, path: ['zz'] },
    { leaf_index: 1, tree_size: 7, path: ['ab'] },
    { leaf_index: 1, tree_size: 7, path: ['AB'.repeat(32)] },
    { leaf_index: 7, tree_size: 7, path: [] },
    { leaf_index: -1, tree_size: 7, path: [] },
    { leaf_index: 1.5, tree_size: 7, path: [] },
    [1, 7, []],
  ];
  for (const b of bad) {
    assert.throws(() => proofFromJson(b), Error, JSON.stringify(b));
  }
});
