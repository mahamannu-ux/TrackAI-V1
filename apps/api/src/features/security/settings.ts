/**
 * Security rule and data settings (Task20f, T20.8): the shapes a tenant's CISO controls,
 * the default policy, and the pure validation and diff helpers. Storage is service.ts.
 *
 * Rule settings are switches only (TASK20.md §1 item 7): on/off and severity per pinned
 * rule. A per-agent block switch arrives with Task20k as an additive field.
 */
import type { SecurityDataSettingsV1 } from '../security-findings/v2-contract';
import { RULE_SEVERITIES, type Catalogue, type RuleSeverity } from './catalogue';

/**
 * The first-wave agents, spelled as security-v2 `SecuritySourceAgent` spells them
 * (Copilot CLI is `copilot`). Every bundle carries all five folders; the lease's
 * `agents` selects the active ones.
 */
export const SECURITY_AGENTS = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot'] as const;
export type SecurityAgent = typeof SECURITY_AGENTS[number];

/** TASK20.md §1 item 7: the seven noisy rules that start off (rule wave 2, Task20l). */
export const DEFAULT_DISABLED_RULES = [
  'exec.agent_runtime_bypass_flags',
  'integrity.git_hooks_bypass',
  'persistence.git_hook_write',
  'privilege.container_runtime_socket_access',
  'secrets.agent_read_env',
  'source.git_config_exec',
  'source.git_remote_tamper',
] as const;

export interface RuleSetting {
  enabled: boolean;
  severity: RuleSeverity;
}

/** Every pinned rule id → its setting. Always complete: exactly the catalogue's ids. */
export type RuleSettings = Record<string, RuleSetting>;

export const DATA_SETTING_KEYS = ['command_previews', 'file_paths', 'urls', 'host_identity', 'user_identity'] as const;
export type DataSettingKey = typeof DATA_SETTING_KEYS[number];

/** Everything a lease carries besides the bundle and the monitor mode. */
export interface LeaseSettings {
  data: SecurityDataSettingsV1;
  agents: SecurityAgent[];
  dayOneScan: boolean;
}

export type MonitorMode = 'off' | 'monitor';

export class SecuritySettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecuritySettingsError';
  }
}

/** The default policy: all pinned rules at their upstream severity, the seven noisy ones off. */
export function defaultRuleSettings(catalogue: Catalogue): RuleSettings {
  const disabled = new Set<string>(DEFAULT_DISABLED_RULES);
  const settings: RuleSettings = {};
  for (const rule of catalogue.manifest.rules) {
    settings[rule.id] = { enabled: rule.enabled && !disabled.has(rule.id), severity: rule.severity };
  }
  return settings;
}

export function defaultLeaseSettings(): LeaseSettings {
  return {
    data: {
      schema_version: 'trackai.security-data-settings/1',
      command_previews: false,
      file_paths: false,
      urls: false,
      host_identity: false,
      user_identity: false,
    },
    agents: [...SECURITY_AGENTS],
    dayOneScan: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored rule settings must name exactly the catalogue's rules with a valid setting each. */
export function validateRuleSettings(value: unknown, catalogue: Catalogue): RuleSettings {
  if (!isRecord(value)) throw new SecuritySettingsError('rule settings must be an object');
  const ids = catalogue.manifest.rules.map(rule => rule.id);
  const keys = Object.keys(value);
  if (keys.length !== ids.length || ids.some(id => !Object.prototype.hasOwnProperty.call(value, id))) {
    throw new SecuritySettingsError('rule settings must name exactly the pinned rules');
  }
  const out: RuleSettings = {};
  for (const id of ids) {
    const setting = value[id];
    if (!isRecord(setting) || Object.keys(setting).length !== 2
      || typeof setting.enabled !== 'boolean'
      || !(RULE_SEVERITIES as readonly unknown[]).includes(setting.severity)) {
      throw new SecuritySettingsError('a rule setting is invalid');
    }
    out[id] = { enabled: setting.enabled, severity: setting.severity as RuleSeverity };
  }
  return out;
}

/** Apply a partial change ({id: {enabled?, severity?}}) to complete settings; unknown ids refuse. */
export function applyRuleChanges(current: RuleSettings, changes: unknown): RuleSettings {
  if (changes === undefined) return { ...current };
  if (!isRecord(changes)) throw new SecuritySettingsError('rules must be an object');
  const next: RuleSettings = { ...current };
  for (const [id, change] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(current, id)) throw new SecuritySettingsError('rules names an unknown rule');
    if (!isRecord(change) || Object.keys(change).length === 0
      || Object.keys(change).some(key => key !== 'enabled' && key !== 'severity')) {
      throw new SecuritySettingsError('a rule change must set enabled and/or severity');
    }
    const setting = { ...current[id] };
    if (change.enabled !== undefined) {
      if (typeof change.enabled !== 'boolean') throw new SecuritySettingsError('enabled must be a boolean');
      setting.enabled = change.enabled;
    }
    if (change.severity !== undefined) {
      if (!(RULE_SEVERITIES as readonly unknown[]).includes(change.severity)) throw new SecuritySettingsError('severity is invalid');
      setting.severity = change.severity as RuleSeverity;
    }
    next[id] = setting;
  }
  return next;
}

/** Apply a partial data-settings change ({command_previews?: boolean, ...}). */
export function applyDataChanges(current: SecurityDataSettingsV1, changes: unknown): SecurityDataSettingsV1 {
  if (changes === undefined) return { ...current };
  if (!isRecord(changes)) throw new SecuritySettingsError('data_settings must be an object');
  const next = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (!(DATA_SETTING_KEYS as readonly string[]).includes(key)) throw new SecuritySettingsError('data_settings names an unknown switch');
    if (typeof value !== 'boolean') throw new SecuritySettingsError('a data setting must be a boolean');
    next[key as DataSettingKey] = value;
  }
  return next;
}

/** 1–5 distinct first-wave agents, returned in canonical order. */
export function validateAgents(value: unknown): SecurityAgent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SECURITY_AGENTS.length) {
    throw new SecuritySettingsError('agents must list 1 to 5 agents');
  }
  if (new Set(value).size !== value.length || value.some(agent => !(SECURITY_AGENTS as readonly unknown[]).includes(agent))) {
    throw new SecuritySettingsError('agents must be distinct first-wave agents');
  }
  return SECURITY_AGENTS.filter(agent => value.includes(agent));
}

export interface RuleChange {
  id: string;
  from: RuleSetting;
  to: RuleSetting;
}

/** Rules whose setting differs between two complete settings, by id. */
export function diffRuleSettings(before: RuleSettings, after: RuleSettings): RuleChange[] {
  return Object.keys(after).sort().flatMap(id => {
    const from = before[id];
    const to = after[id];
    return from && from.enabled === to.enabled && from.severity === to.severity ? [] : [{ id, from, to }];
  });
}

export function enabledDataSettings(data: SecurityDataSettingsV1): DataSettingKey[] {
  return DATA_SETTING_KEYS.filter(key => data[key]);
}

export function sameLeaseSettings(a: LeaseSettings, b: LeaseSettings): boolean {
  return a.dayOneScan === b.dayOneScan
    && a.agents.join(',') === b.agents.join(',')
    && DATA_SETTING_KEYS.every(key => a.data[key] === b.data[key]);
}
