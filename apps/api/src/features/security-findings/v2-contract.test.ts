import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  checkDataSettings,
  SecurityV2FieldNotPermittedError,
  validateSecurityUploadV2,
  type SecurityDataSettingsV1,
  type SecurityFindingV2,
  type SecurityRecordId,
  type SecurityRecordV2,
  type SecurityUploadV2,
} from './v2-contract';

const CONTRACT_DIR = join(__dirname, '../../../../../docs/contracts/security-v2');
const FIXTURE_DIR = join(CONTRACT_DIR, 'fixtures');
const REPOSITORY_DIR = resolve(CONTRACT_DIR, '../../..');
const NUMBAT_DIR = join(dirname(dirname(REPOSITORY_DIR)), 'numbat');
const REPLAY_RUN_ID = 'run-20261017T100000.000000000-0123456789abcdef';
const REPLAY_EVENT_ID = `hook-${REPLAY_RUN_ID}`;
const REPLAY_FINDING_ID = 'fnd-49e7e870ff96953b2b8e5dd3';
const REPLAY_ENFORCEMENT_ID = 'enf-8f62f739638bc81b28547bc9';
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

interface ManifestCase {
  file: string;
  schema: string;
  expectedValid: boolean;
  rationale: string;
}

const manifest = readJson(join(FIXTURE_DIR, 'manifest.json')) as {
  schemaVersion: string;
  cases: ManifestCase[];
};
const schemaFiles = readdirSync(CONTRACT_DIR).filter((file) => file.endsWith('.schema.json'));
const schemas = schemaFiles.map((file) => readJson(join(CONTRACT_DIR, file)) as Record<string, unknown>);

function contractAjv(): Ajv {
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value: string) => Number.isFinite(Date.parse(value)),
  });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
  });
  for (const schema of schemas) ajv.addSchema(schema);
  return ajv;
}

function validatorFor(ajv: Ajv, fixture: ManifestCase): ValidateFunction {
  const schemaPath = join(FIXTURE_DIR, fixture.schema);
  const schema = readJson(schemaPath) as { $id: string };
  const validate = ajv.getSchema(schema.$id);
  assert.ok(validate, `missing validator for ${fixture.schema}`);
  return validate;
}

test('T20a security v2: all Draft 7 schemas compile in strict mode', () => {
  const ajv = contractAjv();
  for (const schema of schemas) {
    assert.equal(typeof ajv.getSchema(schema.$id as string), 'function');
  }
});

test('T20a security v2: manifest lists every JSON fixture exactly once', () => {
  assert.equal(manifest.schemaVersion, 'trackai.security-v2-contract-fixtures/1');
  const listed = manifest.cases.map((fixture) => fixture.file).sort();
  const onDisk = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
    .sort();
  assert.deepEqual(listed, onDisk);
  assert.equal(new Set(listed).size, listed.length);
});

for (const fixture of manifest.cases) {
  test(`T20a security v2 fixture: ${fixture.file}`, () => {
    const validate = validatorFor(contractAjv(), fixture);
    const actual = validate(readJson(join(FIXTURE_DIR, fixture.file))) as boolean;
    assert.equal(
      actual,
      fixture.expectedValid,
      `${fixture.file}: ${JSON.stringify(validate.errors?.slice(0, 5))}`,
    );
    assert.ok(fixture.rationale.length > 0);
  });
}

test('T20a security v2: every object schema is closed', () => {
  const open: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}/${index}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'object' && schema.additionalProperties !== false) open.push(path);
    for (const [key, child] of Object.entries(schema)) walk(child, `${path}/${key}`);
  };
  schemas.forEach((schema) => walk(schema, schema.$id as string));
  assert.deepEqual(open, []);
});

test('T20a security v2: strings, arrays, and integers are bounded', () => {
  const unbounded: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}/${index}`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    const finiteSet = schema.const !== undefined || Array.isArray(schema.enum);
    if (schema.type === 'string' && !finiteSet && typeof schema.maxLength !== 'number') {
      unbounded.push(`${path} (string)`);
    }
    if (schema.type === 'array' && typeof schema.maxItems !== 'number') {
      unbounded.push(`${path} (array)`);
    }
    if (schema.type === 'integer'
      && (typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number'
        || schema.maximum > Number.MAX_SAFE_INTEGER)) {
      unbounded.push(`${path} (integer)`);
    }
    for (const [key, child] of Object.entries(schema)) walk(child, `${path}/${key}`);
  };
  schemas.forEach((schema) => walk(schema, schema.$id as string));
  assert.deepEqual(unbounded, []);
});

test('T20a security v2: each forbidden field has a dedicated invalid fixture', () => {
  const required = [
    'tool_input', 'tool_result', 'content', 'content_preview', 'evidence_refs',
    'project_path', 'project_path_hash', 'sample_project_path_hash',
    'endpoint.uid', 'endpoint.device_id',
  ];
  const invalidReasons = manifest.cases
    .filter((fixture) => !fixture.expectedValid)
    .map((fixture) => fixture.rationale);
  for (const field of required) {
    assert.equal(
      invalidReasons.filter((reason) => reason.includes(`forbidden ${field}.`)).length,
      1,
      `${field} must have exactly one named invalid case`,
    );
  }
});

test('T20a security v2: upload kinds each have valid and invalid coverage', () => {
  const kinds = [
    'finding', 'enforcement', 'indicator', 'scan-summary', 'permission-event',
    'security-status', 'agent-inventory',
  ];
  for (const kind of kinds) {
    assert.ok(manifest.cases.some((fixture) => fixture.file === `valid-${kind}.json`));
    assert.ok(manifest.cases.some(
      (fixture) => fixture.file.startsWith(`invalid-${kind}-`) && !fixture.expectedValid,
    ));
  }
});

test('T20a security v2: valid upload record IDs use the frozen preimage', () => {
  const sourceKeys: Record<string, string[]> = {
    finding: [REPLAY_FINDING_ID],
    enforcement: [REPLAY_ENFORCEMENT_ID],
    indicator: ['run-placeholder', 'domain', 'example.invalid'],
    scan_summary: ['scan-placeholder'],
    permission_event: ['permission-placeholder'],
    security_status: ['2026-10-17T10:00:00Z'],
    agent_inventory: ['2026-10-17T10:00:00Z'],
  };
  for (const fixture of manifest.cases.filter(
    (entry) => entry.expectedValid && entry.schema === '../security-upload-v2.schema.json',
  )) {
    const upload = readJson(join(FIXTURE_DIR, fixture.file)) as {
      records: Array<{ kind: string; record_id: string }>;
    };
    const record = upload.records[0];
    const preimage = ['trackai.security-record/2', record.kind, ...sourceKeys[record.kind]].join('\0');
    const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
    assert.equal(record.record_id, `sha256:${digest}`, basename(fixture.file));
  }
});

test('T20a security v2: adapted source IDs reproduce pinned Numbat algorithms', () => {
  const findingHash = createHash('sha256');
  for (const part of ['secrets.agent_read_env', '1.3', REPLAY_EVENT_ID]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    findingHash.update(length).update(bytes);
  }
  assert.equal(`fnd-${findingHash.digest('hex').slice(0, 24)}`, REPLAY_FINDING_ID);

  const decisionHash = createHash('sha256')
    .update(`${REPLAY_RUN_ID}\0${REPLAY_EVENT_ID}`, 'utf8')
    .digest('hex');
  assert.equal(`enf-${decisionHash.slice(0, 24)}`, REPLAY_ENFORCEMENT_ID);

  const findingUpload = readJson(join(FIXTURE_DIR, 'valid-finding.json')) as {
    records: Array<{ record_id: string; source_agent: string; source_type: string }>;
  };
  const enforcementUpload = readJson(join(FIXTURE_DIR, 'valid-enforcement.json')) as {
    records: Array<{ finding_record_ids: string[]; source_agent: string }>;
  };
  assert.equal(findingUpload.records[0].source_agent, 'codex');
  assert.equal(findingUpload.records[0].source_type, 'hook');
  assert.equal(enforcementUpload.records[0].source_agent, 'codex');
  assert.deepEqual(
    enforcementUpload.records[0].finding_record_ids,
    [findingUpload.records[0].record_id],
  );
});

test('T20a security v2: replay preserves the pinned persisted-hook relationship', {
  skip: !existsSync(join(NUMBAT_DIR, 'cmd/numbat/hook_test.go')),
}, () => {
  const hookTest = readFileSync(join(NUMBAT_DIR, 'cmd/numbat/hook_test.go'), 'utf8');
  const hookSource = readFileSync(join(NUMBAT_DIR, 'cmd/numbat/hook.go'), 'utf8');
  const testStart = hookTest.indexOf('func TestHookWritesFindingToFileSinkNotStdout');
  const testEnd = hookTest.indexOf('\nfunc ', testStart + 1);
  assert.ok(testStart >= 0 && testEnd > testStart);
  const persistedHookTest = hookTest.slice(testStart, testEnd);
  assert.ok(persistedHookTest.includes('"tool_name":"Bash","tool_input":{"command":"cat .env"}'));
  const sourcePayload = persistedHookTest.match(/payload := `([^`]+)`/)?.[1];
  assert.ok(sourcePayload);
  assert.equal(sourcePayload.includes('tool_call_id'), false);
  assert.equal(sourcePayload.includes('tool_use_id'), false);
  assert.match(persistedHookTest, /decision\.FindingIDs, \[\]string\{f\.FindingID\}/);
  assert.match(persistedHookTest, /decision\.ActionEventIDs, f\.CitedEventIDs/);
  assert.match(hookSource, /events := hook\.MapEvents\(lc, agent, sourceAgent, hookEventID\(run\), payload\)/);
  assert.match(hookSource, /return "hook-" \+ run/);
});

test('T20a security v2: valid bundle file digest matches decoded content', () => {
  const bundle = readJson(join(FIXTURE_DIR, 'valid-rule-bundle.json')) as {
    agents: Record<string, { files: Array<{ sha256: string; content_b64: string }> }>;
  };
  for (const agent of Object.values(bundle.agents)) {
    for (const file of agent.files) {
      const content = Buffer.from(file.content_b64, 'base64');
      assert.ok(content.byteLength <= 262_144);
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
    }
  }
});

test('T20a security v2: bundled rule is the pinned rules-check success case', {
  skip: !existsSync(join(NUMBAT_DIR, 'cmd/numbat/rules_dir_test.go')),
}, () => {
  const pin = execFileSync('git', ['-C', NUMBAT_DIR, 'rev-parse', '--short=7', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(pin, '20a5a52');
  const bundle = readJson(join(FIXTURE_DIR, 'valid-rule-bundle.json')) as {
    agents: Record<string, { files: Array<{ content_b64: string }> }>;
  };
  const rule = Buffer.from(bundle.agents['claude-code'].files[0].content_b64, 'base64')
    .toString('utf8');
  const pinnedRuleCheckTest = readFileSync(join(NUMBAT_DIR, 'cmd/numbat/rules_dir_test.go'), 'utf8');
  assert.ok(pinnedRuleCheckTest.includes(rule));
  assert.match(pinnedRuleCheckTest, /runCLI\("rules", "check", "--rules-dir", dir\)/);
});

test('T20a security v2: adapted fixture notice records source, pin, and license', () => {
  const notice = readFileSync(join(FIXTURE_DIR, 'NOTICE.md'), 'utf8');
  assert.match(notice, /Numbat/);
  assert.match(notice, /20a5a52/);
  assert.match(notice, /Apache License 2\.0/);
  assert.match(notice, /secrets_fixture\.ndjson/);
  assert.match(notice, /enforcement is hook-only/);
  assert.match(notice, new RegExp(REPLAY_FINDING_ID));
  assert.match(notice, new RegExp(REPLAY_ENFORCEMENT_ID));
});

test('T20d security v2: validateSecurityUploadV2 accepts every valid upload fixture and rejects the invalid ones', () => {
  const ajv = contractAjv();
  void ajv;
  for (const fixture of manifest.cases.filter(
    (entry) => entry.schema === '../security-upload-v2.schema.json',
  )) {
    const upload = readJson(join(FIXTURE_DIR, fixture.file));
    if (fixture.expectedValid) {
      const validated = validateSecurityUploadV2(upload);
      assert.equal(validated.schema_version, 'trackai.security-upload/2', fixture.file);
      assert.ok(validated.records.length >= 1, fixture.file);
    } else {
      assert.throws(() => validateSecurityUploadV2(upload), fixture.file);
    }
  }
});

test('T20d security v2: validation maps failures to the three safe codes', () => {
  assert.throws(
    () => validateSecurityUploadV2({ schema_version: 'trackai.security-upload/1', records: [] }),
    (error: { code?: string }) => error.code === 'SECURITY_V2_UNSUPPORTED_SCHEMA',
  );
  assert.throws(
    () => validateSecurityUploadV2({
      schema_version: 'trackai.security-upload/2',
      records: [{
        kind: 'finding', record_id: 'sha256:'.concat('a'.repeat(64)),
      }],
    }),
    (error: { code?: string }) => error.code === 'SECURITY_V2_INVALID_BODY',
  );
  assert.throws(
    () => validateSecurityUploadV2({
      schema_version: 'trackai.security-upload/2',
      records: [{
        kind: 'finding', record_id: 'sha256:'.concat('a'.repeat(64)),
        tool_input: 'raw',
      }],
    }),
    (error: { code?: string }) => error.code === 'SECURITY_V2_UNKNOWN_FIELD',
  );
  assert.throws(
    () => validateSecurityUploadV2({ schema_version: 'trackai.security-upload/2' }),
    (error: { code?: string }) => error.code === 'SECURITY_V2_INVALID_BODY',
  );
  assert.throws(
    () => validateSecurityUploadV2('not an object'),
    (error: { code?: string }) => error.code === 'SECURITY_V2_INVALID_BODY',
  );
});

const ALL_OFF_SETTINGS: SecurityDataSettingsV1 = {
  schema_version: 'trackai.security-data-settings/1',
  command_previews: false,
  file_paths: false,
  urls: false,
  host_identity: false,
  user_identity: false,
};

const ALL_ON_SETTINGS: SecurityDataSettingsV1 = {
  schema_version: 'trackai.security-data-settings/1',
  command_previews: true,
  file_paths: true,
  urls: true,
  host_identity: true,
  user_identity: true,
};

test('T20d security v2: checkDataSettings governs finding fields by switch', () => {
  const recordId: SecurityRecordId = `sha256:${'a'.repeat(64)}`;
  const base: SecurityFindingV2 = {
    kind: 'finding',
    record_id: recordId,
    rule_id: 'secrets.agent_read_env',
    rule_version: '1.3',
    severity: 'high',
    title: 'Rule title',
    source_agent: 'codex',
    source_type: 'hook',
    confidence: 'medium',
    detected_at: '2026-10-17T10:00:00Z',
    numbat_schema_version: '0.5.0',
    bundle_digest: 'b'.repeat(64),
    lease_id: 'lease-1',
    found_at_rest: false,
    repository: { kind: 'not_enrolled' },
  };
  // Nothing optional: allowed with all settings off.
  assert.doesNotThrow(() => checkDataSettings(base, ALL_OFF_SETTINGS));
  // Each optional field is refused while its switch is off.
  assert.throws(
    () => checkDataSettings({ ...base, observed_command: 'cat /etc/hosts' }, ALL_OFF_SETTINGS),
    (error: SecurityV2FieldNotPermittedError) => error.fields.length === 1,
  );
  assert.doesNotThrow(() => checkDataSettings(
    { ...base, observed_command: 'cat /etc/hosts', observed_file_path: '/x', observed_url: 'https://x.invalid', endpoint: { hostname: 'h', username: 'u' } },
    ALL_ON_SETTINGS,
  ));
  assert.throws(
    () => checkDataSettings(
      { ...base, endpoint: { hostname: 'h', username: 'u' } },
      ALL_OFF_SETTINGS,
    ),
    (error: SecurityV2FieldNotPermittedError) => error.fields.length === 2,
  );
});

test('T20d security v2: the whole indicator kind is governed by the urls switch', () => {
  const indicator = readJson(join(FIXTURE_DIR, 'valid-indicator.json')) as SecurityUploadV2;
  assert.throws(
    () => checkDataSettings(indicator.records[0], ALL_OFF_SETTINGS),
    SecurityV2FieldNotPermittedError,
  );
  assert.doesNotThrow(() => checkDataSettings(indicator.records[0], ALL_ON_SETTINGS));
  const partial: SecurityDataSettingsV1 = { ...ALL_OFF_SETTINGS, urls: true };
  assert.doesNotThrow(() => checkDataSettings(indicator.records[0], partial));
});

test('T20d security v2: kinds without optional content pass any settings', () => {
  for (const file of ['valid-enforcement.json', 'valid-scan-summary.json', 'valid-permission-event.json', 'valid-security-status.json', 'valid-agent-inventory.json']) {
    const upload = readJson(join(FIXTURE_DIR, file)) as SecurityUploadV2;
    for (const record of upload.records) {
      assert.doesNotThrow(() => checkDataSettings(record, ALL_OFF_SETTINGS), file);
    }
  }
});
