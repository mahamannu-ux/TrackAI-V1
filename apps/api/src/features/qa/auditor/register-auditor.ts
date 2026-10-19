/**
 * Registers the auditor's verifiable and signed answerers (Task16 A16.13a +
 * A16.13b, Task16h) in the app registry. Imported once by qa.routes.ts beside
 * Task19's live registrations; tests pass their own registry.
 *
 * Not built here (their default stays `answer_not_built` plus their gaps):
 * verifiable Q5, Q6, Q12, Q15, S2, S3, S4, S5, S6, S13, S14, S16; signed S2.
 */
import { defaultAnswerers, type AnswererRegistry } from '../answerers';
import type { QaAnswerer, QaKind, QaQuestionId } from '../types';
import {
  answerQ1, answerQ3, answerQ4, answerQ7, answerQ8, answerQ9, answerQ11, answerQ13, answerQ14, answerQ16,
} from './code-verifiable';
import {
  answerS1, answerS7, answerS8, answerS9, answerS10, answerS11, answerS12, answerS15,
} from './security-verifiable';
import { answerCodeSignedQ, answerSecuritySignedQ } from './signed';

/** Every auditor answerer, as [question, kind, answerer]. */
export const AUDITOR_ANSWERERS: ReadonlyArray<readonly [QaQuestionId, QaKind, QaAnswerer]> = [
  ['Q1', 'verifiable', answerQ1],
  ['Q3', 'verifiable', answerQ3],
  ['Q4', 'verifiable', answerQ4],
  ['Q7', 'verifiable', answerQ7],
  ['Q8', 'verifiable', answerQ8],
  ['Q9', 'verifiable', answerQ9],
  ['Q11', 'verifiable', answerQ11],
  ['Q13', 'verifiable', answerQ13],
  ['Q14', 'verifiable', answerQ14],
  ['Q16', 'verifiable', answerQ16],
  ['S1', 'verifiable', answerS1],
  ['S7', 'verifiable', answerS7],
  ['S8', 'verifiable', answerS8],
  ['S9', 'verifiable', answerS9],
  ['S10', 'verifiable', answerS10],
  ['S11', 'verifiable', answerS11],
  ['S12', 'verifiable', answerS12],
  ['S15', 'verifiable', answerS15],
  ['Q1', 'signed', answerCodeSignedQ],
  ['Q3', 'signed', answerCodeSignedQ],
  ['Q9', 'signed', answerCodeSignedQ],
  ['Q13', 'signed', answerCodeSignedQ],
  ['S1', 'signed', answerSecuritySignedQ],
  ['S7', 'signed', answerSecuritySignedQ],
  ['S8', 'signed', answerSecuritySignedQ],
  ['S9', 'signed', answerSecuritySignedQ],
  ['S10', 'signed', answerSecuritySignedQ],
  ['S11', 'signed', answerSecuritySignedQ],
  ['S12', 'signed', answerSecuritySignedQ],
];

/** Registers every auditor answerer (the app registry by default). */
export function registerAuditorAnswerers(registry: AnswererRegistry = defaultAnswerers): void {
  for (const [questionId, kind, answerer] of AUDITOR_ANSWERERS) registry.register(questionId, kind, answerer);
}

// Self-registers on import, like ./answers/register-code and ../security-answerers.
registerAuditorAnswerers();
