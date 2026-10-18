import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedCatalogue, type Catalogue } from './catalogue';
import { COMPILER_VERSION, CompilerError, compileRules, overrideHeader } from './compiler';
import { DEFAULT_DISABLED_RULES, SECURITY_AGENTS, applyRuleChanges, defaultRuleSettings } from './settings';

const catalogue = pinnedCatalogue();

/** Lines of `compiled` that differ from `upstream` (the header is line 0 of compiled). */
function changedLines(upstream: Buffer, compiled: Buffer): Array<[string, string]> {
  const a = upstream.toString('utf8').split('\n');
  const b = compiled.toString('utf8').split('\n').slice(1);
  assert.equal(a.length, b.length, 'only lines are rewritten, none added or removed');
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]] as [string, string]]));
}

test('compiler: the default policy ships the seven noisy rules disabled, in every agent folder', () => {
  const compiled = compileRules(catalogue, defaultRuleSettings(catalogue), 1);
  assert.deepEqual(compiled.overriddenRuleIds, [...DEFAULT_DISABLED_RULES].sort());
  assert.equal(compiled.identityOverride, false);
  assert.deepEqual(Object.keys(compiled.agents), [...SECURITY_AGENTS]);
  const reference = compiled.agents['claude-code'];
  assert.equal(reference.files.length, 7);
  assert.equal(reference.enabledRuleIds.length, 44);
  assert.ok(DEFAULT_DISABLED_RULES.every(id => !reference.enabledRuleIds.includes(id)));
  for (const agent of SECURITY_AGENTS) assert.deepEqual(compiled.agents[agent], reference);
  for (const file of reference.files) {
    const rule = catalogue.manifest.rules.find(candidate => candidate.path === file.path)!;
    const text = file.bytes.toString('utf8');
    assert.equal(text.split('\n')[0], overrideHeader(rule.path));
    assert.equal(text.split('\n')[0], `# Modified by TrackAI (Task20f) from perplexityai/numbat@20a5a52 ${rule.path}; Apache-2.0`);
    assert.deepEqual(changedLines(catalogue.files.get(rule.id)!, file.bytes), [
      [`version: "${rule.version}"`, `version: "${rule.version}-trackai.1"`],
      ['enabled: true', 'enabled: false'],
    ]);
    assert.ok(!/^enforce:/m.test(text), 'enforce is never written');
  }
});

test('compiler: golden bytes for a severity change', () => {
  const settings = applyRuleChanges(defaultRuleSettings(catalogue), { 'secrets.agent_read_env': { enabled: true, severity: 'critical' } });
  const compiled = compileRules(catalogue, settings, 7);
  const rule = catalogue.manifest.rules.find(candidate => candidate.id === 'secrets.agent_read_env')!;
  const file = compiled.agents.codex.files.find(candidate => candidate.path === rule.path)!;
  const upstream = catalogue.files.get(rule.id)!.toString('utf8');
  const expected = `${overrideHeader(rule.path)}\n${upstream
    .replace(/^version: ".*"$/m, `version: "${rule.version}-trackai.7"`)
    .replace(/^severity: .*$/m, 'severity: critical')}`;
  assert.equal(file.bytes.toString('utf8'), expected);
  assert.ok(compiled.agents.codex.enabledRuleIds.includes(rule.id), 're-enabled rule is in the enabled set');
  // Re-enabled but at a new severity: it still differs from upstream, so it still ships a file.
  assert.equal(compiled.agents.codex.files.length, 7);
});

test('compiler: a rule equal to upstream ships no file; nothing different ships one identity override', () => {
  const upstream: Record<string, { enabled: boolean; severity: 'info' | 'low' | 'medium' | 'high' | 'critical' }> = {};
  for (const rule of catalogue.manifest.rules) upstream[rule.id] = { enabled: rule.enabled, severity: rule.severity };
  const compiled = compileRules(catalogue, upstream, 3);
  assert.equal(compiled.identityOverride, true);
  assert.deepEqual(compiled.overriddenRuleIds, []);
  const first = [...catalogue.manifest.rules].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  const [file] = compiled.agents.cursor.files;
  assert.equal(compiled.agents.cursor.files.length, 1);
  assert.equal(file.path, first.path);
  assert.deepEqual(changedLines(catalogue.files.get(first.id)!, file.bytes), [
    [`version: "${first.version}"`, `version: "${first.version}-trackai.3"`],
  ]);
  assert.equal(compiled.agents.cursor.enabledRuleIds.length, 51);
});

test('compiler: refuses incomplete settings, bad versions and a catalogue it cannot edit', () => {
  const settings = defaultRuleSettings(catalogue);
  const missing = { ...settings };
  delete missing['secrets.agent_read_env'];
  assert.throws(() => compileRules(catalogue, missing, 1), CompilerError);
  assert.throws(() => compileRules(catalogue, settings, -1), CompilerError);
  const rule = catalogue.manifest.rules.find(candidate => candidate.id === DEFAULT_DISABLED_RULES[0])!;
  const broken: Catalogue = {
    manifest: catalogue.manifest,
    files: new Map([...catalogue.files].map(([id, bytes]) => [id, id === rule.id ? Buffer.from(bytes.toString('utf8').replace(/^enabled: true$/m, '')) : bytes])),
  };
  assert.throws(() => compileRules(broken, settings, 1), /no top-level enabled/);
  assert.equal(COMPILER_VERSION, 'task20f.1');
});
