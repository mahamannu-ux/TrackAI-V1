// Shared surface of the A15.5 anchoring adapters (Rekor, RFC 3161 TSA, dual):
// the error type with its errors.md code, the anchoring signer, the reserved
// platform tenant, and a bounded cache.
//
// Ported from SushiCorp A2 adapters/anchor/base.py and keys.py @ 0bd67a5
// (catalog EV-2). Deviations: (1) one `AnchorError` carrying a frozen
// errors.md code and a `retryable` flag instead of the AnchorUnavailable /
// AnchorRejected pair, so the worker can store `error_code` as is; (2) the
// anchoring key is not a key file: it is a platform credential behind the
// frozen `SigningAdapter` contract (founder decision 2026-10-12, Task15f
// checkpoint), so production signs in KMS; (3) KMS and the dev signer sign
// with random nonces, so a root resubmitted after a crash may be logged twice
// in Rekor (SushiCorp relied on RFC 6979 for Rekor's 409 dedup); idempotency
// on `batch_id` is the database's job (one `anchored` row per record and
// type), the adapters' bounded caches only spare repeat calls in-process.

import { randomUUID } from 'node:crypto';
import { SigningError, SigningRejected, signVerified, type SigningAdapter } from './signer-contract';

export type { FetchLike } from './testing/fetch-like';

/** Frozen errors.md codes the anchoring adapters raise. */
export type AnchorErrorCode =
  | 'ATTESTA_ANCHOR_LOG_UNAVAILABLE'
  | 'ATTESTA_ANCHOR_LOG_PROOF_INVALID'
  | 'ATTESTA_ANCHOR_TSA_UNAVAILABLE'
  | 'ATTESTA_ANCHOR_TSA_TOKEN_INVALID'
  | 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED'
  | 'ATTESTA_ANCHOR_LOG_REJECTED'
  | 'ATTESTA_SIGNER_UNAVAILABLE'
  | 'ATTESTA_SIGNER_REJECTED';

/**
 * Codes that stop a batch for good in the anchoring worker (errors.md: terminal;
 * Task2-attesta-trigger lesson: a persistent error ends in a visible terminal state,
 * never an endless retry). ATTESTA_SIGNER_REJECTED is not retryable inside one call,
 * but the worker retries it with backoff: a credential fixed by an operator then
 * resumes anchoring, and nothing stops a batch for good on a signer refusal.
 */
export const TERMINAL_ANCHOR_CODES: ReadonlySet<AnchorErrorCode> = new Set<AnchorErrorCode>([
  'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED',
  'ATTESTA_ANCHOR_LOG_REJECTED',
]);

/** Why an anchor attempt failed. Messages carry no raw values, only reasons. */
export class AnchorError extends Error {
  readonly code: AnchorErrorCode;
  /** false only for configuration faults and terminal signer or log refusals. */
  readonly retryable: boolean;
  constructor(code: AnchorErrorCode, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AnchorError';
    this.code = code;
    this.retryable = opts.retryable ?? (!TERMINAL_ANCHOR_CODES.has(code) && code !== 'ATTESTA_SIGNER_REJECTED');
  }
}

/** A caller bug (root not 32 bytes, empty or reused batch_id). Never retried, never stored as an anchor failure. */
export class AnchorInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorInputError';
  }
}

/**
 * Reserved tenant ID under which the platform anchoring credential signs.
 * Real tenant IDs are random v4 UUIDs, so the nil UUID is never issued; Rekor
 * sees only the platform key, never which tenant anchored a root.
 */
export const ATTESTA_PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Signs batch roots for the public log. Public key is SPKI DER (P-256). */
export interface AnchorSigner {
  publicKeySpkiDer(): Promise<Buffer>;
  /** DER ECDSA P-256 signature over SHA-256(artifact), already verified. */
  sign(artifact: Buffer): Promise<Buffer>;
}

/**
 * The platform anchoring credential through the frozen signer contract:
 * `signVerified` checks every signature against the published key before
 * use. Signer failures keep their errors.md mapping (unavailable → retry,
 * rejected → terminal).
 */
export function anchorSignerFromAdapter(adapter: SigningAdapter, credentialId: string): AnchorSigner {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SigningRejected) {
        throw new AnchorError('ATTESTA_SIGNER_REJECTED', 'anchoring credential refused to sign', { cause: err });
      }
      if (err instanceof SigningError) {
        throw new AnchorError('ATTESTA_SIGNER_UNAVAILABLE', 'anchoring signer unavailable', { cause: err });
      }
      throw new AnchorError('ATTESTA_SIGNER_UNAVAILABLE', 'anchoring signer failed', { cause: err });
    }
  };
  return {
    publicKeySpkiDer: () => wrap(() => adapter.publicKey(credentialId)),
    sign: (artifact) =>
      wrap(async () =>
        (await signVerified(adapter, artifact, {
          credentialId,
          tenantId: ATTESTA_PLATFORM_TENANT_ID,
          requestId: `anchor-${randomUUID()}`,
        })).signature),
  };
}

/** True when the process runs as production (the pinned-key rules apply). */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/** Insertion-ordered map that forgets its oldest entry beyond `max` (closes SushiCorp A2b limitation #11). */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('cache size must be a positive integer');
  }
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

/** Shared input check: a batch root is exactly 32 bytes and has a batch_id. */
export function assertAnchorInput(root: Buffer, batchId: string): void {
  if (!Buffer.isBuffer(root) || root.length !== 32) throw new AnchorInputError('merkle root must be 32 bytes');
  if (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > 256) {
    throw new AnchorInputError('batch_id is required (at most 256 characters)');
  }
}

/** `fetch` with a timeout; any transport failure becomes the given unavailable code. */
export async function fetchWithTimeout(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  code: 'ATTESTA_ANCHOR_LOG_UNAVAILABLE' | 'ATTESTA_ANCHOR_TSA_UNAVAILABLE',
  what: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { redirect: 'error', ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AnchorError(code, `${what} unreachable`, { cause: err });
  }
}

/**
 * Read at most `max` bytes of a response body, aborting the stream beyond it,
 * so a hostile endpoint cannot make us buffer an unbounded body. A dropped
 * connection is `unavailable`; an oversized body is `tooLarge`.
 */
export async function readCapped(
  res: Response,
  max: number,
  codes: { unavailable: AnchorErrorCode; tooLarge: AnchorErrorCode },
  what: string,
): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new AnchorError(codes.tooLarge, `${what} response too large`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new AnchorError(codes.tooLarge, `${what} response too large`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof AnchorError) throw err;
    throw new AnchorError(codes.unavailable, `${what} connection dropped`, { cause: err });
  }
  return Buffer.concat(chunks, total);
}
