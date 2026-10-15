/**
 * The answerer registry (Task19a, T19.2; docs/contracts/qa/api.md "Answers and
 * answerers"). Task19b/19c (live) and Task16 A16.13 (verifiable, signed) plug their
 * answers in here; Task19a registers none. One answerer per question and kind.
 */
import { QA_QUESTIONS_BY_ID } from './registry';
import type { QaAnswerer, QaKind, QaQuestionId } from './types';

export class AnswererRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswererRegistrationError';
  }
}

export interface AnswererRegistry {
  register(questionId: QaQuestionId, kind: QaKind, answerer: QaAnswerer): void;
  get(questionId: QaQuestionId, kind: QaKind): QaAnswerer | undefined;
}

const key = (questionId: string, kind: QaKind) => `${questionId}/${kind}`;

/** A fresh registry (tests use their own; the app uses `defaultAnswerers`). */
export function createAnswererRegistry(): AnswererRegistry {
  const answerers = new Map<string, QaAnswerer>();
  return {
    register(questionId, kind, answerer) {
      const question = QA_QUESTIONS_BY_ID.get(questionId);
      if (!question) throw new AnswererRegistrationError(`unknown question ${questionId}`);
      if (!question.kinds.some((offered) => offered.kind === kind)) {
        throw new AnswererRegistrationError(`${questionId} does not offer kind ${kind}`);
      }
      if (answerers.has(key(questionId, kind))) {
        throw new AnswererRegistrationError(`${questionId}/${kind} already has an answerer`);
      }
      answerers.set(key(questionId, kind), answerer);
    },
    get(questionId, kind) {
      return answerers.get(key(questionId, kind));
    },
  };
}

/** The app's registry. */
export const defaultAnswerers: AnswererRegistry = createAnswererRegistry();

/** Registers an answerer in the app's registry (throws on a duplicate or a kind not offered). */
export function registerAnswerer(questionId: QaQuestionId, kind: QaKind, answerer: QaAnswerer): void {
  defaultAnswerers.register(questionId, kind, answerer);
}
