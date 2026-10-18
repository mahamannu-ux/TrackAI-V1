import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CatalogueError,
  NUMBAT_RULE_COUNT,
  catalogueDir,
  loadCatalogue,
  parseRuleScalars,
  sha256Hex,
  topLevelLines,
} from './catalogue';
import { importCatalogue } from './catalogue-import';

test('catalogue: the manifest matches the 51 pinned files byte for byte', () => {
  const dir = catalogueDir();
  const catalogue = loadCatalogue(dir);
  assert.equal(catalogue.manifest.rules.length, NUMBAT_RULE_COUNT);
  assert.equal(catalogue.files.size, NUMBAT_RULE_COUNT);
  const onDisk = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(group => readdirSync(join(dir, group.name)).map(file => `${group.name}/${file}`))
    .sort();
  assert.deepEqual(onDisk, catalogue.manifest.rules.map(rule => rule.path).sort(), 'no file outside the manifest');
  for (const rule of catalogue.manifest.rules) {
    assert.equal(sha256Hex(readFileSync(join(dir, rule.path))), rule.sha256, rule.path);
  }
  assert.ok(existsSync(join(dir, 'NOTICE.md')), 'Apache-2.0 notice ships with the copies');
  assert.match(readFileSync(join(dir, 'NOTICE.md'), 'utf8'), /20a5a52bab41c9bf6ee857efd43c7b198b055de5/);
});

test('catalogue: every pinned file has id, version, enabled and severity once each as plain top-level scalars', () => {
  const catalogue = loadCatalogue();
  for (const rule of catalogue.manifest.rules) {
    const text = catalogue.files.get(rule.id)!.toString('utf8');
    for (const key of ['id', 'version', 'enabled', 'severity']) {
      assert.equal(text.split('\n').filter(line => line.startsWith(`${key}:`)).length, 1, `${rule.path} ${key}`);
    }
    assert.deepEqual(parseRuleScalars(text, rule.path), {
      id: rule.id, version: rule.version, enabled: rule.enabled, severity: rule.severity,
    });
  }
});

test('catalogue: a file this compiler cannot edit fails loudly', () => {
  const good = 'id: a.b\nversion: "1.0"\nenabled: true\ntitle: t\nseverity: high\nexpr: x\n';
  assert.deepEqual(parseRuleScalars(good, 'a/b.yaml'), { id: 'a.b', version: '1.0', enabled: true, severity: 'high' });
  const bad = [
    good.replace('enabled: true\n', ''), // missing
    `${good}enabled: false\n`, // repeated
    good.replace('version: "1.0"', 'version: 1.0'), // unquoted
    good.replace('severity: high', 'severity: "high"'), // quoted
    good.replace('enabled: true', 'enabled: yes'),
    good.replace(/\n/g, '\r\n'),
  ];
  for (const text of bad) assert.throws(() => parseRuleScalars(text, 'a/b.yaml'), CatalogueError);
  // An indented `enabled:` inside a block is not top level, so it neither counts nor collides.
  assert.doesNotThrow(() => topLevelLines(`${good}description: |-\n  enabled: false\n`, 'a/b.yaml'));
});

test('catalogue: a tampered copy is refused at load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-'));
  const source = catalogueDir();
  execFileSync('cp', ['-R', `${source}/.`, dir]);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const first = manifest.rules[0];
  writeFileSync(join(dir, first.path), `${readFileSync(join(dir, first.path), 'utf8')}\n`);
  assert.throws(() => loadCatalogue(dir), /digest differs/);
});

test('catalogue import: refuses a checkout that is not the pinned commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'numbat-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x']);
  assert.throws(() => importCatalogue(repo, mkdtempSync(join(tmpdir(), 'out-'))), /not the pinned/);
});
