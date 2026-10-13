/**
 * Anchoring configuration from the environment (Task15f2; Task15f checkpoint
 * decision 1): the platform anchoring credential, the Rekor and TSA endpoints, the
 * pinned Rekor log key with its shard offsets, and the TSA trust anchors.
 *
 *   ATTESTA_ANCHOR_CREDENTIAL_ID      platform credential (signs as ATTESTA_PLATFORM_TENANT_ID)
 *   ATTESTA_DEV_ANCHOR_KEY_FILE       outside production: P-256 PEM for the local dev signer
 *   ATTESTA_REKOR_URL                 e.g. https://rekor.sigstage.dev
 *   ATTESTA_REKOR_LOG_KEY_FILE        PEM of the log's public key (always pinned here)
 *   ATTESTA_REKOR_LOG_INDEX_OFFSETS   optional JSON {"<tree id>": <offset>} (sharded logs)
 *   ATTESTA_TSA_URL                   e.g. https://freetsa.org/tsr
 *   ATTESTA_TSA_ANCHORS_FILE          PEM bundle the TSA certificate must chain to
 *
 * In production the platform credential comes from the trust layer (Task15l); until
 * it exists this refuses to start (fail closed). Errors name variables, never values;
 * nothing here logs.
 */
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as pkijs from 'pkijs';
import { ATTESTA_PLATFORM_TENANT_ID, anchorSignerFromAdapter, isProduction, type AnchorSigner, type FetchLike } from './anchor-contract';
import { DualAnchor, type StoredAnchorKeys } from './anchor-dual';
import { RekorAnchor, loadLogPublicKey } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { LocalDevSigner } from './signer-local-dev';

/** A configuration problem: the worker must not start. Message names variables only. */
export class AnchorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorConfigError';
  }
}

type ReadFile = (path: string) => string;
const defaultRead: ReadFile = (path) => readFileSync(path, 'utf8');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new AnchorConfigError(`${name} is required`);
  return v;
}

function readNamed(read: ReadFile, env: NodeJS.ProcessEnv, name: string): string {
  const path = required(env, name);
  try {
    return read(path);
  } catch {
    throw new AnchorConfigError(`${name} names a file that cannot be read`);
  }
}

function endpoint(env: NodeJS.ProcessEnv, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AnchorConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction(env))) {
    throw new AnchorConfigError(`${name} must be https${isProduction(env) ? ' in production' : ''}`);
  }
  if (url.username || url.password) throw new AnchorConfigError(`${name} must not carry credentials`);
  return raw.replace(/\/+$/, '');
}

/**
 * The platform anchoring signer. Outside production: a LocalDevSigner holding
 * ATTESTA_DEV_ANCHOR_KEY_FILE as ATTESTA_ANCHOR_CREDENTIAL_ID (a `dev:` id). In
 * production: refused until Task15l supplies the platform resolver.
 */
export function anchorSignerFromEnv(env: NodeJS.ProcessEnv = process.env, read: ReadFile = defaultRead): AnchorSigner {
  const credentialId = required(env, 'ATTESTA_ANCHOR_CREDENTIAL_ID');
  if (isProduction(env)) {
    throw new AnchorConfigError(
      'production anchoring needs the platform signer resolver (Task15l); refusing to start with a development key');
  }
  const pem = readNamed(read, env, 'ATTESTA_DEV_ANCHOR_KEY_FILE');
  let adapter: LocalDevSigner;
  try {
    adapter = new LocalDevSigner({ credentials: [{ credentialId, tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: pem }], env });
  } catch {
    throw new AnchorConfigError('ATTESTA_DEV_ANCHOR_KEY_FILE / ATTESTA_ANCHOR_CREDENTIAL_ID: not a usable dev P-256 credential (id must start with "dev:")');
  }
  return anchorSignerFromAdapter(adapter, credentialId);
}

/**
 * `{"<decimal tree id>": <non-negative offset>}` (the tree ID as a checkpoint origin
 * prints it, e.g. "rekor.sigstage.dev - 1193050959916656506"), or undefined when
 * unset. Returned keyed by the 16-hex tree ID, the form verifyRekorEntry looks up.
 */
export function parseLogIndexOffsets(raw: string | undefined): Record<string, number> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnchorConfigError('ATTESTA_REKOR_LOG_INDEX_OFFSETS is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnchorConfigError('ATTESTA_REKOR_LOG_INDEX_OFFSETS must be an object of tree ID → offset');
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^[0-9]{1,20}$/.test(k) || BigInt(k) > 0xffffffffffffffffn || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new AnchorConfigError('ATTESTA_REKOR_LOG_INDEX_OFFSETS entries must be "<decimal tree id>": <non-negative integer>');
    }
    const hex = BigInt(k).toString(16).padStart(16, '0');
    if (Object.prototype.hasOwnProperty.call(out, hex)) throw new AnchorConfigError('ATTESTA_REKOR_LOG_INDEX_OFFSETS names a tree twice');
    out[hex] = v;
  }
  return out;
}

/** What the verify report needs to check stored anchors offline. */
export interface AnchorVerifyMaterial extends StoredAnchorKeys {
  rekorLogKey: KeyObject;
  anchorKeysSpkiDer: Buffer[];
  tsaAnchors: pkijs.Certificate[];
}

export interface AnchorEnv {
  anchor: DualAnchor;
  verify: AnchorVerifyMaterial;
}

/**
 * Build the dual anchor and the matching verify material from the environment.
 * `rekorFetch` / `tsaFetch` are test seams (the in-process fakes); production uses the global fetch.
 */
export async function anchorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { rekorFetch?: FetchLike; tsaFetch?: FetchLike; read?: ReadFile; signer?: AnchorSigner } = {},
): Promise<AnchorEnv> {
  const read = opts.read ?? defaultRead;
  const signer = opts.signer ?? anchorSignerFromEnv(env, read);
  const rekorUrl = endpoint(env, 'ATTESTA_REKOR_URL');
  const tsaUrl = endpoint(env, 'ATTESTA_TSA_URL');
  const logKeyPem = readNamed(read, env, 'ATTESTA_REKOR_LOG_KEY_FILE');
  let rekorLogKey: KeyObject;
  try {
    rekorLogKey = loadLogPublicKey(logKeyPem);
  } catch {
    throw new AnchorConfigError('ATTESTA_REKOR_LOG_KEY_FILE is not a supported public key');
  }
  const logIndexOffsets = parseLogIndexOffsets(env.ATTESTA_REKOR_LOG_INDEX_OFFSETS);
  const anchorsPem = readNamed(read, env, 'ATTESTA_TSA_ANCHORS_FILE');
  let tsaAnchors: pkijs.Certificate[];
  try {
    tsaAnchors = loadTrustAnchors(anchorsPem);
  } catch {
    throw new AnchorConfigError('ATTESTA_TSA_ANCHORS_FILE holds no readable certificate');
  }
  const rekor = new RekorAnchor({
    url: rekorUrl, signer, logPublicKeyPem: rekorLogKey.export({ type: 'spki', format: 'pem' }).toString(),
    logIndexOffsets, fetch: opts.rekorFetch, production: isProduction(env),
  });
  const tsa = new TsaAnchor({ url: tsaUrl, trustAnchorsPem: anchorsPem, fetch: opts.tsaFetch });
  return {
    anchor: new DualAnchor(rekor, tsa),
    verify: { rekorLogKey, rekorLogIndexOffsets: logIndexOffsets, anchorKeysSpkiDer: [await signer.publicKeySpkiDer()], tsaAnchors },
  };
}
