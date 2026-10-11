import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanonicalizationError,
  GENESIS_PREV_HASH,
  HASH_PREFIX,
  canonicalize,
  computeRecordHash,
  hashBytes,
  sha256Prefixed,
} from './canonical';

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'jcs');
const CASES = ['arrays', 'french', 'structures', 'unicode', 'values', 'weird'];

for (const name of CASES) {
  test(`RFC 8785 reference vector: ${name}`, () => {
    const input = JSON.parse(readFileSync(join(VECTORS, `input_${name}.json`), 'utf8'));
    const expected = readFileSync(join(VECTORS, `output_${name}.json`), 'utf8').replace(/\n+$/, '');
    assert.equal(canonicalize(input), expected);
  });
}

// RFC 8785 Appendix B: IEEE-754 bit pattern -> required JCS number text.
// Five of the 24 patterns decode to integer-valued doubles below 1e21 and
// outside the safe range. Per decision 3 (see canonical.ts) those are
// refused (UNSAFE_INTEGER_BITS): below 1e21 JCS emits integer literals,
// where a JS double may already have rounded the caller's integer intent
// and integer-typed verifiers elsewhere would hash different bytes. The
// cases below are the remaining 19, including large magnitudes, which JCS
// renders in exponent form identically in every implementation.
const APPENDIX_B: Array<[string, string]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

// Appendix B patterns that decode to integers outside MIN/MAX_SAFE_INTEGER
// but below 1e21, where JCS would emit an integer literal. Refused instead
// of serialized (decision 3; rationale in canonical.ts).
const UNSAFE_INTEGER_BITS = [
  '4340000000000000',
  'c340000000000000',
  '4430000000000000',
  '444b1ae4d6e2ef4e',
  '444b1ae4d6e2ef4f',
];

for (const bits of UNSAFE_INTEGER_BITS) {
  test(`RFC 8785 Appendix B number ${bits} refused as unsafe integer`, () => {
    const value = Buffer.from(bits, 'hex').readDoubleBE(0);
    assert.equal(Number.isInteger(value) && !Number.isSafeInteger(value), true);
    assert.equal(Math.abs(value) < 1e21, true);
    assert.throws(() => canonicalize(value), CanonicalizationError);
  });
}

test('large-magnitude integers use exponent form and are accepted', () => {
  assert.equal(canonicalize(1e21), '1e+21');
  assert.equal(canonicalize(1e30), '1e+30');
});

for (const [bits, expected] of APPENDIX_B) {
  test(`RFC 8785 Appendix B number ${bits}`, () => {
    const value = Buffer.from(bits, 'hex').readDoubleBE(0);
    assert.equal(canonicalize(value), expected);
  });
}

test('key order uses UTF-16 code units', () => {
  // U+1F600 (surrogate pair D83D DE00) sorts before U+FB33 in UTF-16
  // but after it in UTF-32.
  assert.equal(canonicalize({ 'דּ': 1, '😀': 2 }), '{"😀":2,"דּ":1}');
  assert.equal(
    canonicalize({ '€': 1, '\r': 2, '1': 3, '😀': 4 }),
    '{"\\r":2,"1":3,"€":1,"😀":4}',
  );
});

test('canonical form is a fixed point over nested samples', () => {
  const samples: unknown[] = [
    null,
    true,
    0,
    -0,
    1.5,
    'héllo € 𝌆',
    [1, 'two', null, true, [3], { a: 4 }],
    { b: [1, { c: null }], a: { z: 1, y: [true, false] } },
    { '😀': [{ 'דּ': [1, 2, { 'é': '€' }] }], '': { ' ': 0 } },
    { n: 9007199254740991, m: -9007199254740991, f: 123.456 },
  ];
  for (const sample of samples) {
    const once = canonicalize(sample);
    assert.equal(canonicalize(JSON.parse(once)), once);
  }
});

test('each refusal throws CanonicalizationError', () => {
  class Point {
    constructor(public x = 1) {}
  }
  const bad: Array<[string, unknown]> = [
    ['NaN', NaN],
    ['+Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['unsafe integer above', 2 ** 53],
    ['unsafe integer below', -(2 ** 53)],
    ['bigint', 1n],
    ['top-level undefined', undefined],
    ['undefined in array', [1, undefined, 2]],
    ['undefined as value', { a: undefined }],
    ['function value', { f: () => 1 }],
    ['symbol value', { s: Symbol('s') }],
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['class instance', new Point()],
    ['lone surrogate', 'lone \ud800 surrogate'],
    ['trailing surrogate', 'trailing \udc00 surrogate'],
    ['Buffer', Buffer.from('x')],
    ['Uint8Array', new Uint8Array([1])],
  ];
  for (const [label, value] of bad) {
    assert.throws(() => canonicalize(value), CanonicalizationError, label);
  }
  assert.throws(() => canonicalize(undefined), (err: unknown) => err instanceof CanonicalizationError);
});

test('record hash known answer matches the frozen rule', () => {
  assert.equal(
    computeRecordHash('{"a":1}', GENESIS_PREV_HASH),
    'sha256:c130ff982818a1918a815cc089bdd2cbf7a00146c2fd354c5fe1db5b15574397',
  );
  assert.equal(GENESIS_PREV_HASH, `${HASH_PREFIX}${'0'.repeat(64)}`);
});

test('record hash refuses a malformed prevHash', () => {
  assert.throws(() => computeRecordHash('{}', 'sha256:XYZ'), CanonicalizationError);
  assert.throws(() => computeRecordHash('{}', 'deadbeef'), CanonicalizationError);
  assert.throws(() => computeRecordHash('{}', `sha256:${'0'.repeat(63)}`), CanonicalizationError);
});

test('hashBytes round-trips and refuses malformed input', () => {
  assert.deepEqual(hashBytes(`sha256:${'01'.repeat(32)}`), Buffer.alloc(32, 1));
  for (const bad of [`${'01'.repeat(32)}`, `sha256:${'0'.repeat(63)}`, `sha256:${'G'.repeat(64)}`]) {
    assert.throws(() => hashBytes(bad), CanonicalizationError);
  }
});

test('sha256Prefixed matches a known digest', () => {
  assert.equal(
    sha256Prefixed(''),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(sha256Prefixed(Buffer.from('abc')).slice(HASH_PREFIX.length), 
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
