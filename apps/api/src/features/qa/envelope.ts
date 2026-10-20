/**
 * Envelope validation (Task19a, T19.2): docs/contracts/qa/answer-v1.schema.json plus
 * the registry rules of docs/contracts/qa/api.md ("Answers and answerers"). The
 * service runs it on every envelope before it leaves the server, so a bad answerer
 * never reaches the client. Results carry the failing rule's path only, never a value.
 *
 * Validated with the `ajv` already in apps/api (no new dependency), with the
 * settings Attesta's schema checks use (features/attesta/builder.ts). The schema is
 * embedded (answer-schema.ts), because the API image ships no docs/ (Dockerfile).
 */
import Ajv, { type ValidateFunction } from 'ajv';
import { ANSWER_V1_SCHEMA } from './answer-schema';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION } from './registry';
import type { QaEnvelope, QaFigure, QaKind, QaQuestionId, QaScope } from './types';

export const MAX_PERIOD_MS = 366 * 24 * 60 * 60 * 1000;

export interface EnvelopeCheck {
  ok: boolean;
  /** The first failing rule's path, never a value. */
  path: string | null;
}

/** What the request asked for; an answer must match it exactly. */
export interface EnvelopeExpectation {
  questionId: QaQuestionId;
  kind: QaKind;
  scope: QaScope;
  breakdown: string | null;
}

let validator: ValidateFunction | null = null;

/** Compiled from the embedded schema (answer-schema.ts, generated from the frozen JSON), so no file is read at run time. */
export function envelopeSchemaValidator(): ValidateFunction {
  if (validator) return validator;
  const ajv = new Ajv({ strict: true, allErrors: true, strictTypes: false, strictRequired: false });
  validator = ajv.compile(ANSWER_V1_SCHEMA);
  return validator;
}

const fail = (path: string): EnvelopeCheck => ({ ok: false, path });
const OK: EnvelopeCheck = { ok: true, path: null };

function sameScope(a: QaScope, b: QaScope): boolean {
  const keys = ['repository_id', 'pull_request_id', 'commit_sha', 'file_id', 'line', 'from', 'to'] as const;
  return keys.every((key) => a[key] === b[key]);
}

function periodOk(from: string, to: string): boolean {
  const f = Date.parse(from);
  const t = Date.parse(to);
  return Number.isFinite(f) && Number.isFinite(t) && f <= t && t - f <= MAX_PERIOD_MS;
}

const UUID_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A bucket key never carries a path or an email (no person, no raw content):
 * repository and machine buckets are row ids (or `unknown`); model and tool keys may
 * contain `/` or `@` (vendor model names); every other key refuses `/`, `\` and `@`.
 */
function bucketKeyOk(dimension: string, key: string): boolean {
  if (dimension === 'repository' || dimension === 'machine') return key === 'unknown' || UUID_KEY_RE.test(key);
  if (dimension === 'model' || dimension === 'tool') return true;
  return !/[/\\@]/.test(key);
}

/** Registry rules for one figure list: keys unique, breakdowns allowed, honest reasons. */
function checkFigures(figures: QaFigure[], allowed: readonly string[], breakdown: string | null, at: string): EnvelopeCheck {
  const keys = new Set<string>();
  for (const [i, figure] of figures.entries()) {
    if (keys.has(figure.key)) return fail(`${at}/${i}/key (duplicate)`);
    keys.add(figure.key);
    if (figure.availability !== 'recorded' && figure.reasons.length === 0) return fail(`${at}/${i}/reasons (empty)`);
    for (const [j, item] of (figure.breakdown ?? []).entries()) {
      if (!allowed.includes(item.dimension)) return fail(`${at}/${i}/breakdown/${j}/dimension (not offered)`);
      if (!bucketKeyOk(item.dimension, item.key)) return fail(`${at}/${i}/breakdown/${j}/key (shape)`);
      if (breakdown !== null && item.dimension !== breakdown) return fail(`${at}/${i}/breakdown/${j}/dimension (not requested)`);
    }
  }
  return OK;
}

/**
 * Checks an envelope against the schema and the registry, and, with `expected`,
 * against the request it answers.
 */
export function checkEnvelope(value: unknown, expected?: EnvelopeExpectation): EnvelopeCheck {
  const validate = envelopeSchemaValidator();
  if (!validate(value)) {
    const first = validate.errors?.[0];
    return fail(`schema:${first?.instancePath || '/'} (${first?.keyword ?? 'invalid'})`);
  }
  const envelope = value as QaEnvelope;
  const question = QA_QUESTIONS_BY_ID.get(envelope.question_id);
  if (!question) return fail('/question_id (not registered)');
  if (envelope.registry_version !== QA_REGISTRY_VERSION) return fail('/registry_version');
  if (!question.kinds.some((offered) => offered.kind === envelope.kind)) return fail('/kind (not offered)');
  if (expected) {
    if (envelope.question_id !== expected.questionId) return fail('/question_id (not requested)');
    if (envelope.kind !== expected.kind) return fail('/kind (not requested)');
    if (!sameScope(envelope.scope, expected.scope)) return fail('/scope (not requested)');
  }
  if (!periodOk(envelope.scope.from, envelope.scope.to)) return fail('/scope (period)');
  if (envelope.availability !== 'recorded' && envelope.reasons.length === 0) return fail('/reasons (empty)');
  for (const code of question.wording) {
    if (!envelope.wording.includes(code)) return fail(`/wording (missing ${code})`);
  }
  const breakdown = expected?.breakdown ?? null;
  const figures = checkFigures(envelope.figures, question.dimensions, breakdown, '/figures');
  if (!figures.ok) return figures;
  if (question.compare_previous !== (envelope.previous !== undefined)) return fail('/previous (compare_previous)');
  if (envelope.previous) {
    const previous = envelope.previous;
    const prev = checkFigures(previous.figures, question.dimensions, breakdown, '/previous/figures');
    if (!prev.ok) return prev;
    if (previous.figures.map((f) => f.key).join('\n') !== envelope.figures.map((f) => f.key).join('\n')) {
      return fail('/previous/figures (keys differ)');
    }
    const length = Date.parse(envelope.scope.to) - Date.parse(envelope.scope.from);
    if (!periodOk(previous.from, previous.to)
      || Date.parse(previous.to) - Date.parse(previous.from) !== length
      || Date.parse(previous.to) !== Date.parse(envelope.scope.from) - 1) {
      return fail('/previous (period)');
    }
  }
  return OK;
}
