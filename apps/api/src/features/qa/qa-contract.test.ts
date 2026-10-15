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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { QUESTIONS_MD_PATH, renderQuestions } from './generate-registry';
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
