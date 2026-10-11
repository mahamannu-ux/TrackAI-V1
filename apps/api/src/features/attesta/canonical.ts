// Ported from SushiCorp B3 core/evidence/canonical.py @ 0bd67a5 (catalog EV-1).
// Deviations: (1) JCS via the `canonicalize` npm package instead of Python
// `rfc8785`; (2) explicit pre-walk validation (the JS package silently drops
// `unsafe`, so every such value is refused before serialization, except
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

function assertSerializable(value: unknown, seen: Set<object>): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'string') {
    if (kind === 'string' && LONE_SURROGATE_RE.test(value as string)) {
      throw new CanonicalizationError('strings with lone surrogates cannot be canonicalized');
    }
    return;
  }
  if (kind === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) throw new CanonicalizationError('NaN cannot be canonicalized');
    if (!Number.isFinite(n)) throw new CanonicalizationError('infinite numbers cannot be canonicalized');
    // Integers outside the safe range are refused because a JS double may
    // already have rounded the caller's integer intent, and integer-typed
    // verifiers in other languages would hash different bytes. Doubles with
    // |n| >= 1e21 are exempt: JCS (RFC 8785 Section 3.2.2.3, via ES6
    // NumberToString) renders those in exponent form with identical
    // shortest-round-trip semantics in every implementation, as the
    // reference vectors require (corpus `values`: 1E30 -> "1e+30").
    if (Number.isInteger(n) && !Number.isSafeInteger(n) && Math.abs(n) < 1e21) {
      throw new CanonicalizationError(`integer ${n} is outside the safe JCS range`);
    }
    return;
  }
  if (kind === 'bigint') throw new CanonicalizationError('bigint cannot be canonicalized');
  if (kind === 'undefined') throw new CanonicalizationError('undefined cannot be canonicalized');
  if (kind === 'function' || kind === 'symbol') {
    throw new CanonicalizationError(`${kind} cannot be canonicalized`);
  }
  if (seen.has(value as object)) {
    throw new CanonicalizationError('circular values cannot be canonicalized');
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertSerializable(item, seen);
      return;
    }
    if (!isPlainObject(value as object)) {
      const label = ArrayBuffer.isView(value)
        ? 'typed arrays'
        : (value as object).constructor?.name ?? 'this value';
      throw new CanonicalizationError(`${label} cannot be canonicalized (plain objects only)`);
    }
    for (const entry of Object.entries(value as Record<string, unknown>)) {
      assertSerializable(entry[1], seen);
    }
  } finally {
    seen.delete(value as object);
  }
}

/** RFC 8785 canonical JSON text of `value`. Throws `CanonicalizationError`. */
export function canonicalize(value: unknown): string {
  assertSerializable(value, new Set());
  let out: string | undefined;
  try {
    out = canonicalizePackage(value);
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
