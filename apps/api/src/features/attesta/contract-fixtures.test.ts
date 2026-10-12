/**
 * Checks every Attesta contract fixture against the frozen schemas, the
 * cross-field rules (S1-S8) and the expected results in fixtures/manifest.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { canonicalize } from './canonical';
import { checkStatementRules } from './contract-rules';

const CONTRACT_DIR = join(__dirname, '../../../../../docs/contracts/attesta');
const FIXTURE_DIR = join(CONTRACT_DIR, 'fixtures');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

interface ManifestCase {
  file: string;
  schema: string;
  expectedSchemaValid: boolean;
  expectedRuleViolations: string[] | null;
  rationale: string;
}

const predicateSchema = readJson(join(CONTRACT_DIR, 'predicate-ai-provenance-v1.schema.json')) as Record<string, unknown>;
const statementSchema = readJson(join(CONTRACT_DIR, 'statement-v1.schema.json')) as Record<string, unknown>;
const manifest = readJson(join(FIXTURE_DIR, 'manifest.json')) as { cases: ManifestCase[] };

function compileStatementValidator() {
  // strictRequired is off: availability_rules names keys defined by each field, not locally.
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  ajv.addSchema(predicateSchema);
  return ajv.compile(statementSchema);
}

test('T15c contract: schemas compile in strict mode', () => {
  assert.equal(typeof compileStatementValidator(), 'function');
});

test('T15c contract: the manifest lists every fixture exactly once', () => {
  const listed = manifest.cases.map((c) => c.file).sort();
  const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f !== 'manifest.json').sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(new Set(listed).size, listed.length);
});

for (const fixture of manifest.cases) {
  test(`T15c contract fixture ${fixture.file}`, () => {
    const validate = compileStatementValidator();
    assert.equal(fixture.schema, '../statement-v1.schema.json');
    const value = readJson(join(FIXTURE_DIR, fixture.file));
    const schemaValid = validate(value) as boolean;
    assert.equal(schemaValid, fixture.expectedSchemaValid,
      `${fixture.file}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
    if (schemaValid) {
      assert.deepEqual(checkStatementRules(value), fixture.expectedRuleViolations ?? []);
      // Every schema-valid statement must canonicalize (it becomes the DSSE payload).
      assert.equal(typeof canonicalize(value), 'string');
    } else {
      assert.equal(fixture.expectedRuleViolations, null);
    }
  });
}

test('T15c contract: valid fixtures carry no free text', () => {
  for (const fixture of manifest.cases.filter((c) => c.file.startsWith('valid-'))) {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(readJson(join(FIXTURE_DIR, fixture.file)));
    for (const s of strings) {
      assert.doesNotMatch(s, /\s|@[^/]*\./, `${fixture.file}: "${s}" looks like free text or an email`);
    }
  }
});

test('T15c contract: every object in the predicate schema is closed', () => {
  const open: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}/${i}`)); return; }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'object' && schema.additionalProperties === undefined) open.push(path);
    if (schema.type === 'object' && schema.additionalProperties === true) open.push(path);
    for (const [key, child] of Object.entries(schema)) walk(child, `${path}/${key}`);
  };
  walk(predicateSchema, '#');
  walk(statementSchema, '#');
  assert.deepEqual(open, []);
});

test('T15c contract: integers are bounded to the safe range', () => {
  const unbounded: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}/${i}`)); return; }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'number') unbounded.push(`${path} (number)`);
    if (schema.type === 'integer'
      && (typeof schema.maximum !== 'number' || schema.maximum > Number.MAX_SAFE_INTEGER
        || typeof schema.minimum !== 'number' || schema.minimum < -Number.MAX_SAFE_INTEGER)) {
      unbounded.push(path);
    }
    for (const [key, child] of Object.entries(schema)) walk(child, `${path}/${key}`);
  };
  walk(predicateSchema, '#');
  assert.deepEqual(unbounded, []);
});
