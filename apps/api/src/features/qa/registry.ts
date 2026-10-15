/**
 * The question registry as code (Task19a, T19.2). Stub until the registry commit.
 */
import type { QaQuestion } from './types';

export const QA_REGISTRY_VERSION = 1;
export const QA_QUESTIONS: readonly QaQuestion[] = [];
export const QA_QUESTIONS_BY_ID: ReadonlyMap<string, QaQuestion> = new Map();
