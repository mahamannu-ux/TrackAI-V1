// In-memory Rekor v1 API (`hashedrekord` only) with real cryptography.
//
// Ported from SushiCorp tests/unit/anchor/fake_rekor.py @ 0bd67a5 (catalog EV-2).
// Deviations: (1) httpx `MockTransport` becomes a `FetchLike` (`fetch`
// property) returning WHATWG `Response` objects; `down` rejects with
// `TypeError('fetch failed')`, matching what Node's `fetch` throws on a
// refused connection; (2) signature verification uses `@noble/curves`
// `p256.verify` over the precomputed digest with `{ prehash: false,
// lowS: false, format: 'der' }` because Node's `crypto.verify` cannot check
// an ECDSA signature against a digest without re-hashing it; (3) `TREE_ID`
// is a `bigint` (it exceeds 2^53 - 1) with `REKOR_TREE_ID_HEX`/`REKOR_TREE_ID_DEC`
// string forms; (4) `KeyObject` pairs from `node:crypto` instead of
// `cryptography` key objects; entry bodies reuse Attesta's `canonicalize`,
// `leafHash`, `merkleRoot` and `inclusionPath` instead of reimplementing
// them; (5) `Error` instead of `AssertionError` on malformed proposals;
// (6) body canonicalization sits inside validation and becomes 400: Python
// integers are unbounded so its `dumps` cannot fail, but JCS refuses unsafe
// integers and a log answers those with 400, not a crash.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { canonicalize } from '../canonical';
import { inclusionPath, leafHash, merkleRoot } from '../merkle';
import type { FetchLike } from './fetch-like';

/** Tree ID of the fake log, as in the source. Larger than 2^53 - 1: keep it a bigint. */
export const REKOR_TREE_ID = 0x1122334455667788n;
/** 16 lowercase hex digits, the entry-ID prefix. */
export const REKOR_TREE_ID_HEX = REKOR_TREE_ID.toString(16).padStart(16, '0');
/** Decimal form, as it appears in the checkpoint's origin line. */
export const REKOR_TREE_ID_DEC = REKOR_TREE_ID.toString(10);
/** Origin line host of the fake log's signed checkpoint. */
export const REKOR_HOST = 'rekor.local';
/** Clock value before the first entry; each new entry advances it by one. */
export const REKOR_CLOCK_START = 1_790_000_000;

/** Mutates a freshly built entry before it is returned, to simulate a lying log. */
export type RekorTamper = (entryId: string, entry: Record<string, unknown>) => void;

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function notFound(): Response {
  return jsonResponse(404, { code: 404, message: 'not found' });
}

/** DER SubjectPublicKeyInfo of a key. */
function spkiDer(publicKey: KeyObject): Buffer {
  return Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
}

/** PEM SubjectPublicKeyInfo of a key. */
function spkiPem(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString('utf8');
}

/** 65-byte uncompressed P-256 point (0x04 || X || Y) for `@noble/curves`. */
function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('not a P-256 public key');
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hexField(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error('expected even-length hex');
  }
  return Buffer.from(value, 'hex');
}

/**
 * An in-memory Rekor v1 API for `hashedrekord` entries: validates the
 * signature over the stated digest, canonicalises the body (JCS), dedups on
 * the RFC 6962 leaf hash (409 + Location), and returns entries with an
 * inclusion proof, a signed checkpoint and a Signed Entry Timestamp.
 *
 * Knobs let tests make the log misbehave: `checkpointKey`/`setKey` forge
 * signatures under a foreign key, `tamper` mutates entries, `omitLocation`
 * drops the 409 Location header, `down` refuses connections, `failStatus`
 * answers every request with one status.
 */
export class FakeRekor {
  logKey: KeyObject;
  checkpointKey: KeyObject;
  setKey: KeyObject;
  bodies: Buffer[] = [];
  integrated: number[] = [];
  posts = 0;
  down = false;
  failStatus: number | null = null;
  tamper: RekorTamper | null = null;
  omitLocation = false;
  clock = REKOR_CLOCK_START;

  constructor() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.logKey = privateKey;
    this.checkpointKey = privateKey;
    this.setKey = privateKey;
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    if (this.failStatus !== null) {
      return jsonResponse(this.failStatus, { code: this.failStatus, message: 'boom' });
    }
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = url.pathname;
    if (method === 'POST' && path === '/api/v1/log/entries') {
      let raw: string;
      if (init?.body !== undefined && init.body !== null) {
        raw = await new Response(init.body).text();
      } else if (input instanceof Request) {
        raw = await input.text();
      } else {
        raw = '';
      }
      let proposed: unknown;
      try {
        proposed = JSON.parse(raw);
      } catch (err) {
        return jsonResponse(400, { code: 400, message: `validation: ${err instanceof Error ? err.message : err}` });
      }
      return this.post(proposed);
    }
    if (method === 'GET' && path.startsWith('/api/v1/log/entries/')) {
      return this.get(path.slice('/api/v1/log/entries/'.length));
    }
    if (method === 'GET' && path === '/api/v1/log/publicKey') {
      return new Response(spkiPem(createPublicKey(this.logKey)), {
        status: 200,
        headers: { 'Content-Type': 'application/x-pem-file' },
      });
    }
    if (method === 'GET' && path === '/api/v1/log') {
      return jsonResponse(200, { treeSize: this.bodies.length });
    }
    return notFound();
  };

  private post(proposed: unknown): Response {
    this.posts += 1;
    let body: Buffer;
    try {
      if (!isRecord(proposed)) throw new Error('entry must be an object');
      const spec = proposed['spec'];
      if (!isRecord(spec)) throw new Error('entry.spec must be an object');
      const data = spec['data'];
      const signature = spec['signature'];
      if (!isRecord(data) || !isRecord(data['hash'])) throw new Error('entry.spec.data.hash must be an object');
      if (!isRecord(signature) || !isRecord(signature['publicKey'])) {
        throw new Error('entry.spec.signature must carry content and publicKey');
      }
      const digest = hexField(data['hash']['value']);
      if (typeof signature['content'] !== 'string') throw new Error('signature content must be base64');
      const sigDer = Buffer.from(signature['content'], 'base64');
      if (typeof signature['publicKey']['content'] !== 'string') {
        throw new Error('signature publicKey content must be base64 of a PEM');
      }
      const keyPem = Buffer.from(signature['publicKey']['content'], 'base64').toString('utf8');
      const publicKey = createPublicKey(keyPem);
      if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('signature publicKey must be P-256');
      }
      const ok = p256.verify(sigDer, new Uint8Array(digest), rawPublicKey(publicKey), {
        prehash: false,
        lowS: false,
        format: 'der',
      });
      if (!ok) throw new Error('signature does not verify');
      // Inside the validation: JCS refuses some JSON-parseable values (unsafe
      // integers, for example), and a log answers those with 400, not a crash.
      body = Buffer.from(canonicalize(proposed), 'utf8');
    } catch (err) {
      return jsonResponse(400, { code: 400, message: `validation: ${err instanceof Error ? err.message : err}` });
    }
    const uuid = leafHash(body).toString('hex');
    const entryId = `${REKOR_TREE_ID_HEX}${uuid}`;
    if (this.bodies.some((b) => b.equals(body))) {
      const headers: Record<string, string> = this.omitLocation
        ? {}
        : { Location: `/api/v1/log/entries/${entryId}` };
      return jsonResponse(
        409,
        {
          code: 409,
          message: `an equivalent entry already exists in the transparency log with UUID ${entryId}`,
        },
        headers,
      );
    }
    this.bodies.push(body);
    this.clock += 1;
    this.integrated.push(this.clock);
    return jsonResponse(201, { [entryId]: this.entry(this.bodies.length - 1, entryId) });
  }

  private get(ident: string): Response {
    for (let i = 0; i < this.bodies.length; i++) {
      const uuid = leafHash(this.bodies[i]).toString('hex');
      const entryId = `${REKOR_TREE_ID_HEX}${uuid}`;
      if (ident.toLowerCase() === uuid || ident.toLowerCase() === entryId) {
        return jsonResponse(200, { [entryId]: this.entry(i, entryId) });
      }
    }
    return notFound();
  }

  private entry(index: number, entryId: string): Record<string, unknown> {
    const root = merkleRoot(this.bodies);
    const size = this.bodies.length;
    const bodyB64 = this.bodies[index].toString('base64');
    const logId = createHash('sha256').update(spkiDer(createPublicKey(this.logKey))).digest('hex');
    const base: Record<string, unknown> = {
      body: bodyB64,
      integratedTime: this.integrated[index],
      logID: logId,
      logIndex: index,
    };
    const setSig = sign('sha256', Buffer.from(canonicalize(base), 'utf8'), this.setKey);
    const entry: Record<string, unknown> = {
      ...base,
      verification: {
        inclusionProof: {
          checkpoint: this.checkpoint(size, root),
          hashes: inclusionPath(this.bodies, index).map((h) => h.toString('hex')),
          logIndex: index,
          rootHash: root.toString('hex'),
          treeSize: size,
        },
        signedEntryTimestamp: setSig.toString('base64'),
      },
    };
    this.tamper?.(entryId, entry);
    return entry;
  }

  private checkpoint(size: number, root: Buffer): string {
    const note =
      `${REKOR_HOST} - ${REKOR_TREE_ID_DEC}\n` +
      `${size}\n` +
      `${root.toString('base64')}\n` +
      `Timestamp: 1\n`;
    const sig = sign('sha256', Buffer.from(note, 'utf8'), this.checkpointKey);
    const hint = createHash('sha256')
      .update(spkiDer(createPublicKey(this.checkpointKey)))
      .digest()
      .subarray(0, 4);
    return note + '\n' + `\u2014 ${REKOR_HOST} ${Buffer.concat([hint, sig]).toString('base64')}\n`;
  }
}
