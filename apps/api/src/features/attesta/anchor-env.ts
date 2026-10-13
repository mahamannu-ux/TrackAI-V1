/**
 * Anchoring configuration from the environment (Task15f2; Task15f checkpoint
 * decision 1): the platform anchoring credential, the Rekor and TSA endpoints, the
 * pinned Rekor log key with its shard offsets, and the TSA trust anchors.
 *
 *   ATTESTA_ANCHOR_CREDENTIAL_ID      outside production: dev platform credential (signs as ATTESTA_PLATFORM_TENANT_ID)
 *   ATTESTA_DEV_ANCHOR_KEY_FILE       outside production: P-256 PEM for the local dev signer
 *   ATTESTA_REKOR_URL                 e.g. https://rekor.sigstage.dev
 *   ATTESTA_REKOR_LOG_KEY_FILE        PEM of the log's public key (always pinned here)
 *   ATTESTA_REKOR_LOG_INDEX_OFFSETS   optional JSON {"<tree id>": <offset>} (sharded logs)
 *   ATTESTA_TSA_URL                   e.g. https://freetsa.org/tsr
 *   ATTESTA_TSA_ANCHORS_FILE          PEM bundle the TSA certificate must chain to
 *
 * In production the platform anchoring key comes from the trust inventory (Task15l2):
 * the `anchor` key the latest imported root document lists active (re-resolved on
 * every call, so a rotation or revocation takes effect at once), through the KMS
 * adapters of ATTESTA_KMS_CREDENTIALS_FILE, with the root chain checked from
 * ATTESTA_TRUST_ROOT_KEYIDS (trust-resolver.ts `platformSigner`). No such key → the
 * worker does not start (fail closed). ATTESTA_ANCHOR_CREDENTIAL_ID and the dev key
 * file are development only. Errors name variables, never values; nothing here logs.
 */
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as pkijs from 'pkijs';
import { ATTESTA_PLATFORM_TENANT_ID, AnchorError, anchorSignerFromAdapter, isProduction, type AnchorSigner, type FetchLike } from './anchor-contract';
import { DualAnchor, type AnchorKeyWindow, type StoredAnchorKeys } from './anchor-dual';
import { RekorAnchor, loadLogPublicKey } from './anchor-rekor';
import { TsaAnchor, loadTrustAnchors } from './anchor-tsa';
import { LocalDevSigner } from './signer-local-dev';
import { PlatformSignerError, pgTrustStore, type TrustAdapters, type TrustConfig, type TrustDb, type TrustStore } from './trust-inventory';
import { TrustConfigError, adaptersFromEnv, platformKeyWindows, platformSigner, trustConfigFromEnv } from './trust-resolver';

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
 * The development anchoring signer: a LocalDevSigner holding
 * ATTESTA_DEV_ANCHOR_KEY_FILE as ATTESTA_ANCHOR_CREDENTIAL_ID (a `dev:` id). Refused
 * in production, where `platformAnchorSignerFromEnv` resolves the key instead.
 */
export function anchorSignerFromEnv(env: NodeJS.ProcessEnv = process.env, read: ReadFile = defaultRead): AnchorSigner {
  if (isProduction(env)) {
    throw new AnchorConfigError(
      'production anchoring resolves the platform anchor key from the trust inventory (platformAnchorSignerFromEnv); refusing a development key');
  }
  const credentialId = required(env, 'ATTESTA_ANCHOR_CREDENTIAL_ID');
  const pem = readNamed(read, env, 'ATTESTA_DEV_ANCHOR_KEY_FILE');
  let adapter: LocalDevSigner;
  try {
    adapter = new LocalDevSigner({ credentials: [{ credentialId, tenantId: ATTESTA_PLATFORM_TENANT_ID, privateKeyPem: pem }], env });
  } catch {
    throw new AnchorConfigError('ATTESTA_DEV_ANCHOR_KEY_FILE / ATTESTA_ANCHOR_CREDENTIAL_ID: not a usable dev P-256 credential (id must start with "dev:")');
  }
  return anchorSignerFromAdapter(adapter, credentialId);
}

async function inventoryFromEnv(env: NodeJS.ProcessEnv, deps: PlatformAnchorDeps): Promise<{ config: TrustConfig; store: TrustStore }> {
  const config = trustConfigFromEnv(env);
  if (config.pinnedRootKeyids.length === 0) throw new AnchorConfigError('ATTESTA_TRUST_ROOT_KEYIDS is required');
  const store = deps.store ?? pgTrustStore((await import('../../core/db')).db as unknown as TrustDb);
  return { config, store };
}

/**
 * Production verification material: every `anchor` key the latest chain-verified
 * root lists (current, retired and revoked) with its signing window, so anchors
 * signed before and after a rotation are both checkable, and none made by a key
 * after its retirement, revocation or compromise counts. Built per call: a verifier
 * calls it (or `platformKeyWindows`) for each run rather than keeping a startup snapshot.
 */
export async function platformAnchorKeysFromEnv(env: NodeJS.ProcessEnv = process.env, deps: PlatformAnchorDeps = {}): Promise<AnchorKeyWindow[]> {
  try {
    const { config, store } = await inventoryFromEnv(env, deps);
    return await platformKeyWindows(store, 'anchor', config, { now: deps.now });
  } catch (err) {
    if (err instanceof AnchorConfigError) throw err;
    if (err instanceof TrustConfigError || err instanceof PlatformSignerError) throw new AnchorConfigError(err.message);
    throw new AnchorConfigError('the platform anchor keys cannot be read from the trust inventory');
  }
}

export interface PlatformAnchorDeps {
  read?: ReadFile;
  /** Test seams; production reads the database of DATABASE_URL and builds adapters from the environment. */
  store?: TrustStore;
  adapters?: TrustAdapters;
  now?: () => Date;
}

/**
 * Production: the `anchor` platform key from the trust inventory. Checked once at
 * start, so a missing piece (no pin, no root, no active anchor key in the latest
 * root, no adapter) is an AnchorConfigError and the worker does not start. Then
 * resolved again for every call: after an `import-root` that retires, revokes or
 * replaces the anchor key, a running worker never signs with the old key (a call
 * that finds no authorized key fails with ATTESTA_SIGNER_REJECTED, which the worker
 * retries with backoff while anchoring stays stopped).
 */
export async function platformAnchorSignerFromEnv(env: NodeJS.ProcessEnv = process.env, deps: PlatformAnchorDeps = {}): Promise<AnchorSigner> {
  let resolve: () => Promise<AnchorSigner>;
  try {
    const { config, store } = await inventoryFromEnv(env, deps);
    const adapters = deps.adapters ?? await adaptersFromEnv(env, { read: deps.read ?? defaultRead });
    resolve = async () => {
      const signer = await platformSigner(store, adapters, 'anchor', config, { now: deps.now });
      return anchorSignerFromAdapter(signer.adapter, signer.credentialId);
    };
    await resolve();
  } catch (err) {
    if (err instanceof AnchorConfigError) throw err;
    if (err instanceof TrustConfigError || err instanceof PlatformSignerError) throw new AnchorConfigError(err.message);
    throw new AnchorConfigError('the platform anchor key cannot be resolved from the trust inventory');
  }
  const current = async (): Promise<AnchorSigner> => {
    try {
      return await resolve();
    } catch (err) {
      if (err instanceof PlatformSignerError) {
        throw new AnchorError('ATTESTA_SIGNER_REJECTED', 'no anchor key is authorized by the latest root document', { cause: err });
      }
      throw new AnchorError('ATTESTA_SIGNER_UNAVAILABLE', 'the anchor key cannot be resolved from the trust inventory', { cause: err });
    }
  };
  return {
    publicKeySpkiDer: async () => (await current()).publicKeySpkiDer(),
    sign: async (artifact) => (await current()).sign(artifact),
  };
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
  opts: { rekorFetch?: FetchLike; tsaFetch?: FetchLike; read?: ReadFile; signer?: AnchorSigner; platform?: Omit<PlatformAnchorDeps, 'read'> } = {},
): Promise<AnchorEnv> {
  const read = opts.read ?? defaultRead;
  const signer = opts.signer ?? (isProduction(env)
    ? await platformAnchorSignerFromEnv(env, { read, ...opts.platform })
    : anchorSignerFromEnv(env, read));
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
    // Production: every anchor key the latest verified root lists, each bound to its signing window
    // (rebuilt on each anchorFromEnv call). Development: the one dev key.
    verify: isProduction(env) && !opts.signer
      ? { rekorLogKey, rekorLogIndexOffsets: logIndexOffsets, tsaAnchors, anchorKeysSpkiDer: [],
          anchorKeyWindows: await platformAnchorKeysFromEnv(env, { read, ...opts.platform }) }
      : { rekorLogKey, rekorLogIndexOffsets: logIndexOffsets, tsaAnchors, anchorKeysSpkiDer: [await signer.publicKeySpkiDer()] },
  };
}
