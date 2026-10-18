/**
 * Rule compiler (Task20f, T20.8): a tenant's rule settings → Numbat operator rule files,
 * one folder per agent. Pure: no clock, no database, no network.
 *
 * Rules (numbat@20a5a52:docs/rules.md:630-659):
 * - a same-id operator rule replaces the built-in as a whole, so an override is the
 *   complete upstream YAML with only `enabled`, `severity` and `version` changed;
 * - a rule equal to upstream ships no file (the embedded catalogue applies);
 * - an empty --rules-dir fails the command, so when nothing differs the folder carries
 *   one identity override (the first rule by id, upstream except header and version);
 * - `enforce` is never written here (blocking is Task20k).
 */
import { NUMBAT_PIN, topLevelLines, type Catalogue, type CatalogueRule } from './catalogue';
import {
  SECURITY_V2_MAX_BUNDLE_BYTES,
  SECURITY_V2_MAX_RULE_FILE_BYTES,
} from '../security-findings/v2-contract';
import { SECURITY_AGENTS, type RuleSettings, type SecurityAgent } from './settings';

export const COMPILER_VERSION = 'task20f.1';

export interface CompiledFile {
  /** `<group>/<file>.yaml`, the upstream path. */
  path: string;
  bytes: Buffer;
}

export interface CompiledAgentFolder {
  files: CompiledFile[];
  /** The effective enabled set, sorted. */
  enabledRuleIds: string[];
}

export interface CompiledRules {
  agents: Record<SecurityAgent, CompiledAgentFolder>;
  /** Ids of the rules that ship an override because they differ from upstream. */
  overriddenRuleIds: string[];
  /** True when no rule differs and the folder carries the identity override only. */
  identityOverride: boolean;
}

export class CompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompilerError';
  }
}

/** The header every compiled file starts with (NOTICE.md: "modified by TrackAI"). */
export function overrideHeader(path: string): string {
  return `# Modified by TrackAI (Task20f) from perplexityai/numbat@${NUMBAT_PIN} ${path}; Apache-2.0`;
}

/** The upstream file with the three scalars rewritten as text and the header added. */
export function overrideFile(rule: CatalogueRule, upstream: Buffer, setting: { enabled: boolean; severity: string }, settingsVersion: number): Buffer {
  if (!Number.isSafeInteger(settingsVersion) || settingsVersion < 0) throw new CompilerError('settings version is invalid');
  const text = upstream.toString('utf8');
  const lines = text.split('\n');
  const at = topLevelLines(text, rule.path);
  lines[at.enabled] = `enabled: ${setting.enabled ? 'true' : 'false'}`;
  lines[at.severity] = `severity: ${setting.severity}`;
  lines[at.version] = `version: "${rule.version}-trackai.${settingsVersion}"`;
  const bytes = Buffer.from(`${overrideHeader(rule.path)}\n${lines.join('\n')}`, 'utf8');
  if (bytes.length > SECURITY_V2_MAX_RULE_FILE_BYTES) throw new CompilerError(`${rule.path}: compiled file exceeds 256 KiB`);
  return bytes;
}

/** Compile complete rule settings at rule-settings version `settingsVersion`. */
export function compileRules(catalogue: Catalogue, settings: RuleSettings, settingsVersion: number): CompiledRules {
  const rules = [...catalogue.manifest.rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (Object.keys(settings).length !== rules.length) throw new CompilerError('settings must name exactly the pinned rules');
  const files: CompiledFile[] = [];
  const overridden: string[] = [];
  const enabled: string[] = [];
  for (const rule of rules) {
    const setting = settings[rule.id];
    if (!setting) throw new CompilerError('settings must name exactly the pinned rules');
    const upstream = catalogue.files.get(rule.id);
    if (!upstream) throw new CompilerError(`${rule.id}: catalogue file missing`);
    if (setting.enabled) enabled.push(rule.id);
    if (setting.enabled === rule.enabled && setting.severity === rule.severity) continue;
    overridden.push(rule.id);
    files.push({ path: rule.path, bytes: overrideFile(rule, upstream, setting, settingsVersion) });
  }
  const identityOverride = files.length === 0;
  if (identityOverride) {
    const first = rules[0];
    files.push({
      path: first.path,
      bytes: overrideFile(first, catalogue.files.get(first.id) as Buffer, first, settingsVersion),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const agents = {} as Record<SecurityAgent, CompiledAgentFolder>;
  for (const agent of SECURITY_AGENTS) agents[agent] = { files, enabledRuleIds: enabled };
  // Base64 grows 4/3 and every agent repeats the files: bound the encoded size before signing.
  const encoded = files.reduce((sum, file) => sum + Math.ceil(file.bytes.length / 3) * 4, 0) * SECURITY_AGENTS.length;
  if (encoded > SECURITY_V2_MAX_BUNDLE_BYTES) throw new CompilerError('compiled bundle exceeds 4 MiB');
  return { agents, overriddenRuleIds: overridden, identityOverride };
}
