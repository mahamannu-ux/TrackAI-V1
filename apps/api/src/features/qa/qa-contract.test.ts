/**
 * Q&A contract tests (Task19a, T19.2): the registry against the catalogue
 * (docs/plan/CUSTOMER_AUDITOR_QA.md), the generated questions.md, the no-person rule,
 * the security wording rule, and (from the validation commit) the envelope schema,
 * its fixtures and the registry checks. No database, no network.
 *
 * Shape from Task16b's audit-contract.test.ts (catalog as code, generated document
 * checked in sync).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { checkEnvelope, envelopeSchemaValidator } from './envelope';
import { ANSWER_V1_SCHEMA } from './answer-schema';
import { ANSWER_SCHEMA_TS_PATH, QUESTIONS_MD_PATH, renderAnswerSchemaModule, renderQuestions } from './generate-registry';
import { QA_GAPS, QA_QUESTIONS, QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from './registry';
import {
  QA_DIMENSIONS, QA_DRILLDOWN_SCOPES, QA_PERSON_WORDS, QA_SCOPES, type QaBuilder, type QaKind,
} from './types';

const REPO = resolve(__dirname, '../../../../..');
const CATALOGUE = readFileSync(resolve(REPO, 'docs/plan/CUSTOMER_AUDITOR_QA.md'), 'utf8');

/**
 * The registry's content digest per version. A change to any entry or gap without a
 * version bump fails here: bump QA_REGISTRY_VERSION, then record the new digest
 * (the failure message prints it). Old lines stay, so a version is never reused.
 */
const REGISTRY_DIGESTS: Record<number, string> = {
  1: 'sha256:c6119cc1e67c206bd2548b34db85eb147d662c9a0d6c3f1a03c31f0dc06c6377',
};

function registryDigest(): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ questions: QA_QUESTIONS, gaps: QA_GAPS })).digest('hex')}`;
}

interface CatalogueRow { id: string; rank: number; auditor: string }

/** Both question tables of the catalogue: code rows `| rank | Qn | … |`, security rows `| Sn | … |`. */
function catalogueRows(): CatalogueRow[] {
  const rows: CatalogueRow[] = [];
  for (const line of CATALOGUE.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const code = /^\d+$/.test(cells[1] ?? '') && /^Q\d+$/.test(cells[2] ?? '');
    const security = /^S\d+$/.test(cells[1] ?? '') && cells.length > 8;
    if (code) rows.push({ id: cells[2], rank: Number(cells[1]), auditor: cells[4].split(/[\s(]/)[0] });
    if (security) rows.push({ id: cells[1], rank: Number(cells[1].slice(1)), auditor: cells[3].split(/[\s(]/)[0] });
  }
  return rows;
}

/** The "Gaps found" table: gap id → questions (ranges like S10–S12 expanded). */
function catalogueGaps(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const section = CATALOGUE.slice(CATALOGUE.indexOf('## Gaps found'), CATALOGUE.indexOf('## Task6.a status'));
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (!/^G\d+$/.test(cells[1] ?? '')) continue;
    const ids: string[] = [];
    for (const part of cells[3].split(',').map((p) => p.trim())) {
      const range = /^([QS])(\d+)[–-][QS]?(\d+)$/.exec(part);
      if (range) for (let i = Number(range[2]); i <= Number(range[3]); i += 1) ids.push(`${range[1]}${i}`);
      else ids.push(part);
    }
    out.set(cells[1], ids);
  }
  return out;
}

test('qa registry: matches the catalogue (ids, ranks, auditor flags)', () => {
  const rows = catalogueRows();
  assert.equal(rows.length, 38, 'the catalogue has 38 questions');
  const fromRegistry = QA_QUESTIONS.map((q) => ({ id: q.id, rank: q.rank, auditor: q.auditor }))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(fromRegistry, [...rows].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(QA_QUESTIONS.filter((q) => q.family === 'code').length, 20);
  assert.equal(QA_QUESTIONS.filter((q) => q.family === 'security').length, 18);
  for (const q of QA_QUESTIONS) assert.equal(q.family === 'code', q.id.startsWith('Q'), `${q.id} family`);
});

test('qa registry: version is bumped whenever an entry or gap changes', () => {
  const digest = registryDigest();
  assert.equal(REGISTRY_DIGESTS[QA_REGISTRY_VERSION], digest,
    `the registry changed: bump QA_REGISTRY_VERSION and record ${QA_REGISTRY_VERSION + 1}: '${digest}'`);
});

test('qa registry: docs/contracts/qa/questions.md is generated and in sync', () => {
  assert.equal(readFileSync(QUESTIONS_MD_PATH, 'utf8'), renderQuestions(), 'run: npm run qa:registry -w apps/api');
});

test('qa registry: entries are well formed', () => {
  const ids = new Set<string>();
  const builders: Record<QaKind, ReadonlyArray<QaBuilder>> = {
    live: ['T19.3', 'T19.4', 'Task19d'],
    verifiable: ['A16.13a', 'A16.13b'],
    signed: ['Task15i4', 'Task15p'],
  };
  for (const q of QA_QUESTIONS) {
    assert.ok(!ids.has(q.id), `${q.id} is unique`);
    ids.add(q.id);
    assert.ok(q.title.length > 0 && q.title.length <= 200, `${q.id} title length`);
    assert.ok(!/[*`]/.test(q.title), `${q.id} title is plain words`);
    assert.ok(q.kinds.length > 0, `${q.id} offers a kind`);
    assert.equal(new Set(q.kinds.map((x) => x.kind)).size, q.kinds.length, `${q.id} kinds unique`);
    for (const { kind, builder } of q.kinds) {
      if (builder !== null) assert.ok(builders[kind].includes(builder), `${q.id} ${kind} builder ${builder}`);
    }
    if (q.phase === 2) assert.ok(q.kinds.every((x) => x.builder === null), `${q.id}: phase 2 is not scheduled`);
    // Auditor-flagged questions offer an auditor kind (D2); "no" questions offer none.
    const auditorKind = q.kinds.some((x) => x.kind !== 'live');
    if (q.auditor === 'yes') assert.ok(auditorKind, `${q.id} is auditor-flagged: needs verifiable or signed`);
    if (q.auditor === 'no') assert.ok(!auditorKind, `${q.id} is not for auditors`);
    assert.ok(q.scopes.length > 0, `${q.id} scopes`);
    assert.equal(new Set(q.dimensions).size, q.dimensions.length, `${q.id} dimensions unique`);
  }
  const compare = QA_QUESTIONS.filter((q) => q.compare_previous).map((q) => q.id).sort();
  assert.deepEqual(compare, ['Q20', 'S7']);
  assert.ok(QA_QUESTIONS.every((q) => q.id === 'Q17' ? q.phase === 2 : q.phase === 1), 'only Q17 is phase 2');
});

test('qa registry: no scope or dimension ever names a person', () => {
  const named = (word: string) => QA_PERSON_WORDS.some((person) => word.toLowerCase().includes(person));
  const vocab = [...QA_DIMENSIONS, ...QA_SCOPES, ...QA_DRILLDOWN_SCOPES];
  assert.deepEqual(vocab.filter(named), [], 'the vocabulary names a person');
  for (const q of QA_QUESTIONS) {
    assert.deepEqual([...q.dimensions, ...q.scopes].filter(named), [], `${q.id} names a person`);
  }
  // The scan itself works.
  assert.ok(named('developer') && named('Committer_id') && named('pr_author'));
});

test('qa registry: every security question carries monitor_only_observed', () => {
  for (const q of QA_QUESTIONS.filter((x) => x.family === 'security')) {
    assert.ok(q.wording.includes('monitor_only_observed'), `${q.id}`);
  }
  // Q11 is a code question about findings: worded the same way.
  assert.ok(QA_QUESTIONS_BY_ID.get('Q11')?.wording.includes('monitor_only_observed'));
});

test('qa registry: gaps agree with the questions and with the catalogue', () => {
  const catalogue = catalogueGaps();
  assert.deepEqual([...catalogue.keys()], QA_GAPS.map((g) => g.id), 'the catalogue lists G1–G13');
  for (const gap of QA_GAPS) {
    const users = QA_QUESTIONS.filter((q) => q.gaps.includes(gap.id)).map((q) => q.id).sort();
    assert.deepEqual([...gap.questions].sort(), users, `${gap.id}: QA_GAPS.questions vs the entries' gaps`);
    assert.deepEqual([...(catalogue.get(gap.id) ?? [])].sort(), users, `${gap.id}: catalogue "Gaps found" row`);
  }
});

// ---------------------------------------------------------------------------
// Envelope: schema, fixtures and registry checks

const FIXTURES = resolve(REPO, 'docs/contracts/qa/fixtures');
const fixture = (name: string): Record<string, any> => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));

test('qa envelope: one valid fixture per kind and availability, each passes', () => {
  const names = readdirSync(FIXTURES).filter((n) => n.startsWith('valid-')).sort();
  const expected = (['live', 'verifiable', 'signed'] as const).flatMap((kind) =>
    (['partial', 'recorded', 'unavailable'] as const).map((a) => `valid-${kind}-${a}.json`)).sort();
  assert.deepEqual(names, expected);
  for (const name of names) {
    const envelope = fixture(name.replace(/\.json$/, ''));
    const [, kind, availability] = name.replace(/\.json$/, '').split('-');
    assert.equal(envelope.kind, kind, name);
    assert.equal(envelope.availability, availability, name);
    assert.deepEqual(checkEnvelope(envelope), { ok: true, path: null }, name);
  }
});

test('qa envelope: every invalid fixture fails, for the reason it is named after', () => {
  const reasons: Record<string, string> = {
    'invalid-unavailable-zero': '/figures/0/value',
    'invalid-float': '/figures/0/value',
    'invalid-person-dimension': '/figures/0/breakdown/0/dimension',
    'invalid-live-with-evidence': '/figures/0',
    'invalid-signed-without-signed': '/',
    'invalid-not-captured-without-gap': '/figures/0/reasons/0',
    'invalid-drilldown-path-label': '/drilldown/0/label',
    'invalid-extra-field': '/figures/0',
    'invalid-verifiable-without-evidence': '/figures/0',
    'invalid-signed-previous-without-evidence': '/previous/figures/0',
  };
  const names = readdirSync(FIXTURES).filter((n) => n.startsWith('invalid-')).map((n) => n.replace(/\.json$/, '')).sort();
  assert.deepEqual(names, Object.keys(reasons).sort());
  const validate = envelopeSchemaValidator();
  for (const name of names) {
    assert.equal(checkEnvelope(fixture(name)).ok, false, name);
    assert.equal(validate(fixture(name)), false, name);
    const paths = (validate.errors ?? []).map((e) => e.instancePath || '/');
    assert.ok(paths.includes(reasons[name]), `${name}: fails at ${reasons[name]} (got ${paths.join(', ')})`);
  }
});

test('qa envelope: an unavailable figure never serializes as 0', () => {
  const envelope = fixture('valid-live-unavailable');
  const text = JSON.stringify(envelope);
  assert.match(text, /"value":null/);
  // Every way of writing 0 for it is refused.
  for (const zero of [0, { type: 'count', count: 0 }, { type: 'ratio', numerator: 0, denominator: 1 }, { type: 'duration_ms', ms: 0 }, '0', false]) {
    const broken = structuredClone(envelope);
    broken.figures[0].value = zero;
    assert.equal(checkEnvelope(broken).ok, false, JSON.stringify(zero));
  }
  // An unavailable figure has no breakdown buckets either.
  const withBuckets = structuredClone(envelope);
  withBuckets.figures[0].breakdown = [{ dimension: 'repository', key: 'r', value: { type: 'count', count: 0 } }];
  assert.equal(checkEnvelope(withBuckets).ok, false);
});

test('qa envelope: integers only, within ±(2^53 − 1); ratios never divide by zero', () => {
  const base = fixture('valid-live-recorded');
  const set = (value: unknown) => { const e = structuredClone(base); e.figures[0].value = value; return e; };
  assert.equal(checkEnvelope(set({ type: 'count', count: Number.MAX_SAFE_INTEGER })).ok, true);
  assert.equal(checkEnvelope(set({ type: 'count', count: Number.MAX_SAFE_INTEGER + 1 })).ok, false);
  assert.equal(checkEnvelope(set({ type: 'count', count: -1 })).ok, false);
  assert.equal(checkEnvelope(set({ type: 'ratio', numerator: 1, denominator: 0 })).ok, false);
  assert.equal(checkEnvelope(set({ type: 'ratio', numerator: 0.5, denominator: 2 })).ok, false);
  assert.equal(checkEnvelope(set({ type: 'duration_ms', ms: 1.5 })).ok, false);
  assert.equal(checkEnvelope(set({ type: 'share', value: 0.43 })).ok, false);
});

test('qa envelope: registry rules', () => {
  const live = fixture('valid-live-recorded');
  const mutate = (f: (e: Record<string, any>) => void, from = live) => { const e = structuredClone(from); f(e); return checkEnvelope(e); };
  assert.equal(mutate((e) => { e.question_id = 'Q99'; }).path, '/question_id (not registered)');
  assert.equal(mutate((e) => { e.registry_version = QA_REGISTRY_VERSION + 1; }).path, '/registry_version');
  assert.equal(mutate((e) => { e.question_id = 'Q7'; }).path, '/kind (not offered)');
  assert.equal(mutate((e) => { e.wording = []; }).path, '/wording (missing unknown_model_explicit)');
  assert.equal(mutate((e) => { e.figures[0].breakdown[0].dimension = 'machine'; }).path, '/figures/0/breakdown/0/dimension (not offered)');
  assert.equal(mutate((e) => { e.figures.push(structuredClone(e.figures[0])); }).path, '/figures/1/key (duplicate)');
  assert.equal(mutate((e) => { e.scope.from = '2025-01-01T00:00:00.000Z'; }).path, '/scope (period)');
  assert.equal(mutate((e) => { e.scope.from = '2026-12-01T00:00:00.000Z'; }).path, '/scope (period)');
  assert.equal(mutate((e) => { e.availability = 'partial'; e.figures[0].availability = 'partial'; }).path, '/reasons (empty)');
  // previous: exactly for compare_previous questions, same keys, same length, before the period.
  const s7 = fixture('valid-signed-recorded');
  assert.equal(mutate((e) => { delete e.previous; }, s7).path, '/previous (compare_previous)');
  assert.equal(mutate((e) => { e.previous = structuredClone(s7.previous); delete e.previous.figures[0].evidence; }).path, '/previous (compare_previous)');
  assert.equal(mutate((e) => { e.previous.figures[0].key = 'other'; }, s7).path, '/previous/figures (keys differ)');
  assert.equal(mutate((e) => { e.previous.from = '2026-04-01T00:00:00.000Z'; }, s7).path, '/previous (period)');
  // previous must end 1 ms before the period starts (no gap).
  assert.equal(mutate((e) => { e.previous.from = '2026-03-30T00:00:00.000Z'; e.previous.to = '2026-06-29T23:59:59.999Z'; }, s7).path, '/previous (period)');
  // Bucket keys: repository and machine are ids; no path or email elsewhere; model keys may hold '/'.
  assert.equal(mutate((e) => { e.figures[0].breakdown[0].key = 'src/payments/charge.ts'; e.figures[0].breakdown[0].dimension = 'severity'; }, s7).path, '/figures/0/breakdown/0/key (shape)');
  assert.equal(mutate((e) => { e.figures[0].breakdown[0].key = 'dev@example.com'; }, s7).path, '/figures/0/breakdown/0/key (shape)');
  assert.equal(mutate((e) => { e.figures[0].breakdown[0].key = 'openrouter/anthropic/claude'; }).ok, true);
  assert.equal(mutate((e) => { e.drilldown[0].label = 'dev@example.com'; }).ok, false);
  // Security answers must carry monitor_only_observed.
  assert.equal(mutate((e) => { e.wording = []; }, s7).path, '/wording (missing monitor_only_observed)');
  // Against the request: question, kind, scope and the requested breakdown.
  const expected = { questionId: 'Q3' as const, kind: 'live' as const, scope: structuredClone(live.scope), breakdown: 'model' };
  assert.deepEqual(checkEnvelope(live, expected), { ok: true, path: null });
  assert.equal(checkEnvelope(live, { ...expected, kind: 'verifiable' }).path, '/kind (not requested)');
  assert.equal(checkEnvelope(live, { ...expected, questionId: 'Q1' }).path, '/question_id (not requested)');
  assert.equal(checkEnvelope(live, { ...expected, scope: { ...expected.scope, repository_id: undefined } }).path, '/scope (not requested)');
  assert.equal(checkEnvelope(live, { ...expected, breakdown: 'tool' }).path, '/figures/0/breakdown/0/dimension (not requested)');
});

test('qa envelope: no field can carry raw content (closed objects all the way down)', () => {
  const walk = (node: unknown, at: string, out: string[]) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'object' || n.properties) {
      if (n.additionalProperties !== false) out.push(at);
    }
    for (const [k, v] of Object.entries(n)) walk(v, `${at}/${k}`, out);
  };
  const schema = JSON.parse(readFileSync(resolve(REPO, 'docs/contracts/qa/answer-v1.schema.json'), 'utf8'));
  const open: string[] = [];
  walk(schema, '#', open);
  // Conditional sub-schemas (if/then/else) only narrow properties already declared closed.
  assert.deepEqual(open.filter((p) => !/\/(if|then|else|allOf\/\d+|not)(\/|$)/.test(p)), []);
  const text = JSON.stringify(schema).toLowerCase();
  for (const word of ['prompt', 'command', '"path":{"type"', 'diff', 'content']) {
    assert.ok(!text.includes(word), `the schema declares no ${word} field`);
  }
});

// ---------------------------------------------------------------------------
// The embedded schema and the production layout (the API image ships only dist/, no docs/)

test('qa envelope: answer-schema.ts is generated from the frozen JSON and in sync', () => {
  assert.equal(readFileSync(ANSWER_SCHEMA_TS_PATH, 'utf8'), renderAnswerSchemaModule(), 'run: npm run qa:registry -w apps/api');
  assert.deepEqual(ANSWER_V1_SCHEMA, JSON.parse(readFileSync(resolve(REPO, 'docs/contracts/qa/answer-v1.schema.json'), 'utf8')));
});

test('qa envelope: the compiled validator works with no docs/ anywhere above it (production layout)', () => {
  let tsc: string;
  try { tsc = require.resolve('typescript/bin/tsc'); } catch { return; } // optional toolchain absent: skip
  const dir = mkdtempSync(join(tmpdir(), 'qa-dist-'));
  try {
    // As apps/api/Dockerfile: compile src/ to dist/; only dist/ is shipped.
    execFileSync(process.execPath, [tsc, '--outDir', join(dir, 'dist'), '--rootDir', resolve(__dirname, '../..'),
      '--module', 'commonjs', '--target', 'ES2022', '--esModuleInterop', '--strict', '--skipLibCheck',
      resolve(__dirname, 'envelope.ts')], { stdio: 'pipe' });
    const names = readdirSync(FIXTURES).filter((n) => n.endsWith('.json')).sort();
    const script = `const {checkEnvelope}=require(${JSON.stringify(join(dir, 'dist/features/qa/envelope.js'))});
      const input=JSON.parse(require('fs').readFileSync(0,'utf8'));
      process.stdout.write(JSON.stringify(input.map((e)=>checkEnvelope(e).ok)));`;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: dir,
      input: JSON.stringify(names.map((n) => JSON.parse(readFileSync(resolve(FIXTURES, n), 'utf8')))),
      env: { ...process.env, NODE_PATH: [resolve(REPO, 'node_modules'), resolve(REPO, 'apps/api/node_modules')].join(delimiter) },
    }).toString();
    assert.deepEqual(JSON.parse(out), names.map((n) => n.startsWith('valid-')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
