/**
 * Generates docs/contracts/qa/questions.md from registry.ts, and answer-schema.ts from
 * docs/contracts/qa/answer-v1.schema.json (the CF-1 "generated and test-checked"
 * pattern, as Task16b's generate-catalog.ts: qa-contract.test.ts fails when either is
 * stale). The schema is embedded in code because the API image ships only the
 * compiled src/ (apps/api/Dockerfile), never docs/.
 *
 *   npm run qa:registry -w apps/api
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QA_GAPS, QA_QUESTIONS, QA_REGISTRY_VERSION } from './registry';
import type { QaQuestion } from './types';

export const QUESTIONS_MD_PATH = resolve(__dirname, '../../../../../docs/contracts/qa/questions.md');
export const ANSWER_SCHEMA_JSON_PATH = resolve(__dirname, '../../../../../docs/contracts/qa/answer-v1.schema.json');
export const ANSWER_SCHEMA_TS_PATH = resolve(__dirname, 'answer-schema.ts');

/** answer-schema.ts: the frozen JSON schema, byte for byte as parsed, as a TypeScript constant. */
export function renderAnswerSchemaModule(): string {
  const schema = JSON.parse(readFileSync(ANSWER_SCHEMA_JSON_PATH, 'utf8')) as unknown;
  return [
    '// Generated from docs/contracts/qa/answer-v1.schema.json by `npm run qa:registry -w apps/api`.',
    '// Do not edit by hand: qa-contract.test.ts fails when this file differs from the contract.',
    '// Embedded so the compiled API validates envelopes without reading docs/ at run time.',
    '/* eslint-disable */',
    `export const ANSWER_V1_SCHEMA: Record<string, unknown> = ${JSON.stringify(schema, null, 2)};`,
    '',
  ].join('\n');
}

const list = (items: readonly string[]) => (items.length === 0 ? '—' : items.join(', '));
const cell = (text: string) => text.replace(/\|/g, '\\|');

function kinds(question: QaQuestion): string {
  if (question.kinds.length === 0) return '—';
  return question.kinds.map((entry) => `${entry.kind} (${entry.builder ?? 'not scheduled'})`).join(', ');
}

function row(question: QaQuestion): string {
  return [
    question.id,
    String(question.rank),
    question.phase === 2 ? '2' : '1',
    cell(question.title),
    question.auditor,
    kinds(question),
    list(question.gaps),
    list(question.scopes),
    list(question.dimensions),
    question.compare_previous ? 'yes' : 'no',
    list(question.wording),
  ].join(' | ');
}

export function renderQuestions(): string {
  const header = [
    '| Id | Rank | Phase | Question | Auditor | Kinds (builder) | Gaps | Scopes | Dimensions | Previous period | Wording |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const family = (name: QaQuestion['family']) => QA_QUESTIONS
    .filter((question) => question.family === name)
    .map((question) => `| ${row(question)} |`);
  return [
    '# Q&A question registry (generated)',
    '',
    '<!-- Generated from apps/api/src/features/qa/registry.ts by `npm run qa:registry -w apps/api`. Do not edit by hand: a unit test fails when this file is out of date. -->',
    '',
    `Registry version ${QA_REGISTRY_VERSION}. ${QA_QUESTIONS.length} questions, ${QA_GAPS.length} gaps. Rules: \`README.md\` in this folder; the source catalogue is \`docs/plan/CUSTOMER_AUDITOR_QA.md\`.`,
    'Every security answer carries `monitor_only_observed`. No scope or dimension names a person.',
    '',
    '## Code questions',
    '',
    ...header,
    ...family('code'),
    '',
    '## Security and policy questions',
    '',
    ...header,
    ...family('security'),
    '',
    '## Gaps',
    '',
    '| Gap | What is missing | Owner | Open | Questions |',
    '|---|---|---|---|---|',
    ...QA_GAPS.map((gap) => `| ${gap.id} | ${cell(gap.title)} | ${cell(gap.owner)} | ${gap.open ? 'yes' : 'no'} | ${list(gap.questions)} |`),
    '',
  ].join('\n');
}

if (require.main === module) {
  writeFileSync(QUESTIONS_MD_PATH, renderQuestions());
  writeFileSync(ANSWER_SCHEMA_TS_PATH, renderAnswerSchemaModule());
  console.log(`qa registry written (version ${QA_REGISTRY_VERSION}, ${QA_QUESTIONS.length} questions)`);
}
