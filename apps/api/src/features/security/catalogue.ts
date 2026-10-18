/**
 * The pinned Numbat rule catalogue (Task20f, T20.8): the 51 upstream rule files at
 * perplexityai/numbat@20a5a52, copied byte for byte under ./catalogue/20a5a52/, and
 * their generated manifest. Regenerate both with `npm run security:catalogue-import -w
 * apps/api -- <numbat checkout>`, which refuses any other commit.
 *
 * The rule YAML is Apache-2.0 material (catalogue/20a5a52/NOTICE.md;
 * docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md "Task20: binary redistribution").
 *
 * Only four top-level scalars are ever read or rewritten (`id`, `version`, `enabled`,
 * `severity`), as text, line by line: TrackAI carries no YAML dependency, and every
 * pinned file has each key exactly once at column 0 (catalogue.test.ts). A future pin
 * that breaks that fails loudly here instead of being guessed at.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The short pin the bundle payload carries (security-rule-bundle-v1 `numbat_pin`). */
export const NUMBAT_PIN = '20a5a52' as const;
/** The full commit of the mirror tag v0.2.0-trackai.1. */
export const NUMBAT_COMMIT = '20a5a52bab41c9bf6ee857efd43c7b198b055de5' as const;
export const NUMBAT_RULE_COUNT = 51;

export const RULE_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type RuleSeverity = typeof RULE_SEVERITIES[number];

export interface CatalogueRule {
  /** Rule id, e.g. `exec.agent_runtime_bypass_flags`. */
  id: string;
  /** Rules group folder, e.g. `exec`. */
  group: string;
  /** `<group>/<file>.yaml`: the path inside the catalogue and inside every bundle folder. */
  path: string;
  /** Hex SHA-256 of the upstream file bytes. */
  sha256: string;
  /** Upstream `version` (the quoted string's contents). */
  version: string;
  severity: RuleSeverity;
  enabled: boolean;
}

export interface CatalogueManifest {
  schema_version: 'trackai.numbat-catalogue/1';
  numbat_commit: typeof NUMBAT_COMMIT;
  rules: CatalogueRule[];
}

export interface Catalogue {
  manifest: CatalogueManifest;
  /** Upstream bytes by rule id. */
  files: ReadonlyMap<string, Buffer>;
}

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueError';
  }
}

/** The four keys TrackAI reads; each must appear exactly once as a top-level line. */
export const TOP_LEVEL_KEYS = ['id', 'version', 'enabled', 'severity'] as const;
export type TopLevelKey = typeof TOP_LEVEL_KEYS[number];

const RULE_ID_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/;
const PATH_RE = /^[a-z0-9_]+\/[a-z0-9_]+\.yaml$/;

/** The index of each top-level key's single line; throws when a key is missing or repeated. */
export function topLevelLines(text: string, path: string): Record<TopLevelKey, number> {
  const lines = text.split('\n');
  const found: Partial<Record<TopLevelKey, number>> = {};
  lines.forEach((line, index) => {
    for (const key of TOP_LEVEL_KEYS) {
      if (line.startsWith(`${key}:`)) {
        if (found[key] !== undefined) throw new CatalogueError(`${path}: top-level ${key} appears twice`);
        found[key] = index;
      }
    }
  });
  for (const key of TOP_LEVEL_KEYS) {
    if (found[key] === undefined) throw new CatalogueError(`${path}: no top-level ${key} line`);
  }
  return found as Record<TopLevelKey, number>;
}

/** The four scalars of one upstream file, in the exact forms the pin uses. */
export function parseRuleScalars(text: string, path: string): Pick<CatalogueRule, 'id' | 'version' | 'severity' | 'enabled'> {
  if (text.includes('\r')) throw new CatalogueError(`${path}: CR line endings are not supported`);
  const lines = text.split('\n');
  const at = topLevelLines(text, path);
  const value = (key: TopLevelKey, re: RegExp): string => {
    const match = re.exec(lines[at[key]]);
    if (!match) throw new CatalogueError(`${path}: top-level ${key} is not a plain scalar this compiler can edit`);
    return match[1];
  };
  const id = value('id', /^id: ([a-z0-9._-]+)$/);
  const version = value('version', /^version: "([^"\\]+)"$/);
  const enabled = value('enabled', /^enabled: (true|false)$/);
  const severity = value('severity', /^severity: (info|low|medium|high|critical)$/);
  if (!RULE_ID_RE.test(id)) throw new CatalogueError(`${path}: rule id is invalid`);
  if (!VERSION_RE.test(version)) throw new CatalogueError(`${path}: version is invalid`);
  return { id, version, enabled: enabled === 'true', severity: severity as RuleSeverity };
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The catalogue folder. `tsc` copies no YAML into dist/, so a built server reads the
 * source tree beside it (dist/features/security → src/features/security).
 */
export function catalogueDir(): string {
  const candidates = [
    join(__dirname, 'catalogue', NUMBAT_PIN),
    resolve(__dirname, '../../../src/features/security/catalogue', NUMBAT_PIN),
  ];
  const found = candidates.find(dir => existsSync(join(dir, 'manifest.json')));
  if (!found) throw new CatalogueError('the pinned Numbat catalogue is not installed');
  return found;
}

/** Load and verify the catalogue: every file's digest and scalars must match the manifest. */
export function loadCatalogue(dir = catalogueDir()): Catalogue {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CatalogueManifest;
  if (manifest.schema_version !== 'trackai.numbat-catalogue/1' || manifest.numbat_commit !== NUMBAT_COMMIT) {
    throw new CatalogueError('catalogue manifest is not for the pinned Numbat commit');
  }
  if (!Array.isArray(manifest.rules) || manifest.rules.length !== NUMBAT_RULE_COUNT) {
    throw new CatalogueError(`catalogue must hold exactly ${NUMBAT_RULE_COUNT} rules`);
  }
  const files = new Map<string, Buffer>();
  const paths = new Set<string>();
  for (const rule of manifest.rules) {
    if (!PATH_RE.test(rule.path) || !rule.path.startsWith(`${rule.group}/`) || paths.has(rule.path)) {
      throw new CatalogueError(`catalogue path ${JSON.stringify(rule.path)} is invalid`);
    }
    paths.add(rule.path);
    const bytes = readFileSync(join(dir, rule.path));
    if (sha256Hex(bytes) !== rule.sha256) throw new CatalogueError(`${rule.path}: digest differs from the manifest`);
    const scalars = parseRuleScalars(bytes.toString('utf8'), rule.path);
    if (scalars.id !== rule.id || scalars.version !== rule.version
      || scalars.severity !== rule.severity || scalars.enabled !== rule.enabled) {
      throw new CatalogueError(`${rule.path}: scalars differ from the manifest`);
    }
    if (files.has(rule.id)) throw new CatalogueError(`rule ${rule.id} appears twice`);
    files.set(rule.id, bytes);
  }
  return { manifest, files };
}

let cached: Catalogue | undefined;
/** The process-wide verified catalogue (loaded once). */
export function pinnedCatalogue(): Catalogue {
  cached ??= loadCatalogue();
  return cached;
}
