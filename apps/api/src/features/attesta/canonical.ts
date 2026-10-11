// Ported from SushiCorp B3 core/evidence/canonical.py @ 0bd67a5 (catalog EV-1).
// Deviations: (1) JCS via the `canonicalize` npm package instead of Python
// `rfc8785`; (2) snapshot validation: the value is walked once into an
// inert plain copy (accessor properties refused, each data property read
// exactly once) and only the copy is serialized, so a getter or Proxy
// cannot pass validation with one value and hash with another; values the
// JS package would silently mangle (`undefined`, `Date`, `Map`, class
// instances, unsafe integers) are refused during the snapshot, except
// doubles with |n| >= 1e21, which JCS renders in exponent form identically
// in every implementation (required by the corpus `values` vector and
// RFC 8785 Appendix B); (3) `CanonicalizationError extends Error` instead of
// `ValueError`; (4) no `UNHASHED_KEYS`/`unsigned_view`/`input_digest` helpers
// (no callers in Attesta phase 1); (5) `computeRecordHash`/`hashBytes` throw
// `CanonicalizationError` instead of `ValueError`.
// Everything hashed into the Attesta chain goes through `canonicalize`,
// which is RFC 8785 (JCS). It is deliberately not hand-rolled: an
// implementation that differs by one byte on some input (number formatting,
// key order under UTF-16, escaping) produces chains that verify here and
// nowhere else, silently destroying their value as evidence.

import { createHash } from 'node:crypto';
import canonicalizePackage from 'canonicalize';

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

export const HASH_PREFIX = 'sha256:';
export const GENESIS_PREV_HASH = 'sha256:' + '0'.repeat(64);

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate `value` and return an inert plain copy of it. Every own
 * enumerable data property is read exactly once; accessor properties are
 * refused. The serializer only ever sees the copy, so a getter or Proxy
 * cannot pass validation with one value and serialize with another.
 */
function snapshot(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number') {
      if (Number.isNaN(value)) throw new CanonicalizationError('NaN cannot be canonicalized');
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError('infinite numbers cannot be canonicalized');
      }
      // Integers outside the safe range are refused because a JS double may
      // already have rounded the caller's integer intent, and integer-typed
      // verifiers in other languages would hash different bytes. Doubles with
      // |n| >= 1e21 are exempt: JCS (RFC 8785 Section 3.2.2.3, via ES6
      // NumberToString) renders those in exponent form with identical
      // shortest-round-trip semantics in every implementation, as the
      // reference vectors require (corpus `values`: 1E30 -> "1e+30").
      if (Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21) {
        throw new CanonicalizationError(`integer ${value} is outside the safe JCS range`);
      }
    }
    return value;
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE_RE.test(value)) {
      throw new CanonicalizationError('strings with lone surrogates cannot be canonicalized');
    }
    return value;
  }
  if (typeof value === 'bigint') throw new CanonicalizationError('bigint cannot be canonicalized');
  if (typeof value === 'undefined') throw new CanonicalizationError('undefined cannot be canonicalized');
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new CanonicalizationError(`${typeof value} cannot be canonicalized`);
  }
  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError('circular values cannot be canonicalized');
  }
  if (Array.isArray(value)) {
    seen.add(obj);
    try {
      // Read the length once and each element once through its descriptor:
      // map/for-of skip gaps, which would silently become null on output.
      const len = value.length;
      const copy: unknown[] = [];
      for (let i = 0; i < len; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          throw new CanonicalizationError('sparse arrays cannot be canonicalized');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (descriptor === undefined) {
          throw new CanonicalizationError(`array index ${i} vanished during snapshot`);
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new CanonicalizationError(`accessor property ${JSON.stringify(String(i))} cannot be canonicalized`);
        }
        copy.push(snapshot(descriptor.value, seen));
      }
      return copy;
    } finally {
      seen.delete(obj);
    }
  }
  if (!isPlainObject(obj)) {
    const label = ArrayBuffer.isView(value) ? 'typed arrays' : obj.constructor?.name ?? 'this value';
    throw new CanonicalizationError(`${label} cannot be canonicalized (plain objects only)`);
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new CanonicalizationError('symbol keys cannot be canonicalized');
  }
  seen.add(obj);
  try {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (descriptor === undefined) {
        throw new CanonicalizationError(`property ${JSON.stringify(key)} vanished during snapshot`);
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new CanonicalizationError(`accessor property ${JSON.stringify(key)} cannot be canonicalized`);
      }
      copy[key] = snapshot(descriptor.value, seen);
    }
    return copy;
  } finally {
    seen.delete(obj);
  }
}

/** RFC 8785 canonical JSON text of `value`. Throws `CanonicalizationError`. */
export function canonicalize(value: unknown): string {
  const inert = snapshot(value, new Set());
  let out: string | undefined;
  try {
    out = canonicalizePackage(inert);
  } catch (err) {
    throw new CanonicalizationError(
      err instanceof Error ? err.message : 'value cannot be canonicalized',
    );
  }
  if (typeof out !== 'string') {
    throw new CanonicalizationError('value cannot be canonicalized');
  }
  return out;
}

/** `'sha256:'` plus the lowercase hex SHA-256 of `data`. */
export function sha256Prefixed(data: Buffer | string): string {
  return HASH_PREFIX + createHash('sha256').update(data).digest('hex');
}

/**
 * The frozen record-hash rule:
 * `sha256:` + hex(SHA-256(utf8(canonical) || utf8(prevHash))),
 * where `prevHash` is the prefixed text, not raw bytes.
 */
export function computeRecordHash(canonical: string, prevHash: string): string {
  if (!HASH_RE.test(prevHash)) {
    throw new CanonicalizationError(`malformed prevHash ${JSON.stringify(prevHash)}`);
  }
  return sha256Prefixed(Buffer.concat([Buffer.from(canonical, 'utf8'), Buffer.from(prevHash, 'utf8')]));
}

/** The 32 raw digest bytes of a `sha256:<hex>` string. */
export function hashBytes(prefixed: string): Buffer {
  if (!HASH_RE.test(prefixed)) {
    throw new CanonicalizationError(`malformed hash ${JSON.stringify(prefixed)}`);
  }
  return Buffer.from(prefixed.slice(HASH_PREFIX.length), 'hex');
}
