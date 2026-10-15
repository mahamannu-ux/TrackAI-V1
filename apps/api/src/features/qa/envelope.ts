/**
 * Envelope validation (Task19a, T19.2): the schema plus the registry rules
 * (docs/contracts/qa/api.md). Stub until the validation commit.
 */
import type { QaAnswerContext } from './types';

export interface EnvelopeCheck {
  ok: boolean;
  /** The first failing rule's path, never a value. */
  path: string | null;
}

export function checkEnvelope(_envelope: unknown, _ctx?: QaAnswerContext): EnvelopeCheck {
  throw new Error('checkEnvelope: not implemented (Task19a interface stub)');
}
