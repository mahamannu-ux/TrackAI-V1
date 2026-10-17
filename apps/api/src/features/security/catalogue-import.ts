/**
 * Regenerate the pinned Numbat catalogue (Task20f): copy the 51 rule files byte for byte
 * from a Numbat checkout and write manifest.json and NOTICE.md.
 *
 *   npm run security:catalogue-import -w apps/api -- /path/to/numbat
 *
 * Refuses unless the checkout's HEAD is exactly the pinned commit, so a pin move is a
 * deliberate code change (NUMBAT_COMMIT in catalogue.ts), never a side effect.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  NUMBAT_COMMIT,
  NUMBAT_PIN,
  NUMBAT_RULE_COUNT,
  parseRuleScalars,
  sha256Hex,
  type CatalogueManifest,
  type CatalogueRule,
} from './catalogue';

const NOTICE = `# Numbat rule catalogue: notice

The YAML files in this folder are copied unchanged from **Numbat**
(https://github.com/perplexityai/numbat), commit \`${NUMBAT_COMMIT}\`
(TrackAI mirror tag \`v0.2.0-trackai.1\`), \`rules/<group>/<file>.yaml\`.

Numbat is licensed under the Apache License, Version 2.0. A copy of the licence is at
https://www.apache.org/licenses/LICENSE-2.0 and ships with the TrackAI Endpoint package
(\`docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md\`).

Rule files that TrackAI compiles into a tenant's rule bundle are **modified by TrackAI**:
the compiler (\`../../compiler.ts\`) adds a first comment line naming the source file and
changes only the top-level \`enabled\`, \`severity\` and \`version\` values. The files here
are the unmodified originals; \`manifest.json\` records each file's SHA-256.
`;

export function importCatalogue(numbatDir: string, outRoot: string): CatalogueManifest {
  const head = execFileSync('git', ['-C', numbatDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== NUMBAT_COMMIT) {
    throw new Error(`refusing: the Numbat checkout is at ${head}, not the pinned ${NUMBAT_COMMIT}`);
  }
  const rulesDir = join(numbatDir, 'rules');
  const rules: CatalogueRule[] = [];
  for (const group of readdirSync(rulesDir).sort()) {
    if (!statSync(join(rulesDir, group)).isDirectory()) continue;
    for (const file of readdirSync(join(rulesDir, group)).sort()) {
      if (!file.endsWith('.yaml')) continue;
      const path = `${group}/${file}`;
      const bytes = readFileSync(join(rulesDir, path));
      rules.push({ ...parseRuleScalars(bytes.toString('utf8'), path), group, path, sha256: sha256Hex(bytes) });
    }
  }
  if (rules.length !== NUMBAT_RULE_COUNT) throw new Error(`expected ${NUMBAT_RULE_COUNT} rule files, found ${rules.length}`);
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = join(outRoot, NUMBAT_PIN);
  rmSync(out, { recursive: true, force: true });
  for (const rule of rules) {
    mkdirSync(join(out, rule.group), { recursive: true });
    copyFileSync(join(rulesDir, rule.path), join(out, rule.path));
  }
  const manifest: CatalogueManifest = {
    schema_version: 'trackai.numbat-catalogue/1',
    numbat_commit: NUMBAT_COMMIT,
    rules: rules.map(({ id, group, path, sha256, version, severity, enabled }) => ({ id, group, path, sha256, version, severity, enabled })),
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'NOTICE.md'), NOTICE);
  return manifest;
}

if (require.main === module) {
  const numbatDir = process.argv[2];
  if (!numbatDir) {
    console.error('usage: security:catalogue-import <numbat checkout>');
    process.exit(2);
  }
  const manifest = importCatalogue(resolve(numbatDir), resolve(__dirname, 'catalogue'));
  console.log(`catalogue written: ${manifest.rules.length} rules at ${NUMBAT_COMMIT}`);
}
