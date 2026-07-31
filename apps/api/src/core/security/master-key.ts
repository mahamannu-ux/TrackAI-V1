const MASTER_KEY_BYTES = 32;
const MAX_KEY_VERSIONS = 16;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface MasterKeyEnvironment {
  MASTER_ENCRYPTION_KEY_ACTIVE_VERSION?: string;
  MASTER_ENCRYPTION_KEYS_JSON?: string;
}

export class MasterKeyring {
  readonly activeVersion: string;
  readonly keyCount: number;
  readonly versions: readonly string[];
  readonly #keys: Map<string, Buffer>;

  constructor(activeVersion: string, keys: Map<string, Buffer>) {
    this.activeVersion = activeVersion;
    this.keyCount = keys.size;
    this.versions = Object.freeze([...keys.keys()]);
    this.#keys = keys;
    Object.freeze(this);
  }

  keyFor(version: string): Buffer {
    const key = this.#keys.get(version);
    if (!key) throw new Error(`Master encryption key version '${version}' is unavailable`);
    return Buffer.from(key);
  }

  toJSON(): { activeVersion: string; versions: readonly string[] } {
    return { activeVersion: this.activeVersion, versions: this.versions };
  }
}

function decodeMasterKey(version: string, encoded: unknown): Buffer {
  if (typeof encoded !== 'string' || !encoded || !BASE64_PATTERN.test(encoded)) {
    throw new Error(`Master encryption key version '${version}' must be valid base64`);
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`Master encryption key version '${version}' must decode to 32 bytes`);
  }
  return key;
}

export function loadMasterKeyring(env: MasterKeyEnvironment = process.env): MasterKeyring {
  const activeVersion = env.MASTER_ENCRYPTION_KEY_ACTIVE_VERSION?.trim();
  const rawKeyring = env.MASTER_ENCRYPTION_KEYS_JSON;
  if (!activeVersion || !rawKeyring) {
    throw new Error('Master encryption keyring is not configured');
  }
  if (!VERSION_PATTERN.test(activeVersion)) {
    throw new Error('Active master encryption key version is invalid');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeyring);
  } catch {
    throw new Error('MASTER_ENCRYPTION_KEYS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MASTER_ENCRYPTION_KEYS_JSON must be a JSON object');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_KEY_VERSIONS) {
    throw new Error(`Master encryption keyring must contain between 1 and ${MAX_KEY_VERSIONS} versions`);
  }

  const keys = new Map<string, Buffer>();
  for (const [version, encoded] of entries) {
    if (!VERSION_PATTERN.test(version)) {
      throw new Error('Master encryption key version labels must be URL-safe identifiers');
    }
    keys.set(version, decodeMasterKey(version, encoded));
  }
  if (!keys.has(activeVersion)) {
    throw new Error(`Active master encryption key version '${activeVersion}' is unavailable`);
  }
  return new MasterKeyring(activeVersion, keys);
}
