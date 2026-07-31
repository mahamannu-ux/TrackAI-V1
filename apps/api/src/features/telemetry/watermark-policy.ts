import { EVENT_KIND, validateMetricEvent } from './decoder';
import type { GitAiMetricEvent } from './types';

export type EvidenceFamily = 'generation_session' | 'commit_note' | 'operational';
export type EvidenceArrivalClass = 'current' | 'delayed' | 'backfill' | 'rejected';

export interface EvidenceWatermarks {
  generationSessionFrom: Date;
  commitNoteFrom: Date;
}

export interface BackfillAuthorizationWindow {
  evidenceFamily: Exclude<EvidenceFamily, 'operational'>;
  occurredFrom: Date;
  occurredUntil: Date;
  expiresAt: Date;
}

export interface EvidenceWatermarkDecision {
  family: EvidenceFamily;
  arrivalClass: EvidenceArrivalClass;
  occurredAt: Date;
  reason: string | null;
}

const DEFAULT_DELAY_THRESHOLD_SECONDS = 5 * 60;

export function evidenceFamilyForEvent(eventKind: number): EvidenceFamily {
  if (eventKind === EVENT_KIND.committed || eventKind === EVENT_KIND.rewriteCommitted) {
    return 'commit_note';
  }
  if (
    eventKind === EVENT_KIND.agentUsage
    || eventKind === EVENT_KIND.checkpoint
    || eventKind === EVENT_KIND.sessionEvent
    || eventKind === EVENT_KIND.otelTrace
  ) {
    return 'generation_session';
  }
  return 'operational';
}

function authorizationAllows(
  authorization: BackfillAuthorizationWindow,
  family: Exclude<EvidenceFamily, 'operational'>,
  occurredAt: Date,
  receivedAt: Date,
): boolean {
  return authorization.evidenceFamily === family
    && authorization.expiresAt.getTime() >= receivedAt.getTime()
    && authorization.occurredFrom.getTime() <= occurredAt.getTime()
    && authorization.occurredUntil.getTime() >= occurredAt.getTime();
}

export function evaluateEvidenceWatermark(input: {
  event: GitAiMetricEvent;
  watermarks: EvidenceWatermarks;
  receivedAt: Date;
  authorization?: BackfillAuthorizationWindow;
  delayThresholdSeconds?: number;
}): EvidenceWatermarkDecision {
  const event = validateMetricEvent(input.event);
  const occurredAt = new Date(event.t * 1000);
  const family = evidenceFamilyForEvent(event.e);
  if (family === 'operational') {
    return { family, arrivalClass: 'current', occurredAt, reason: null };
  }

  const watermark = family === 'generation_session'
    ? input.watermarks.generationSessionFrom
    : input.watermarks.commitNoteFrom;
  if (occurredAt.getTime() < watermark.getTime()) {
    if (input.authorization
      && authorizationAllows(input.authorization, family, occurredAt, input.receivedAt)) {
      return { family, arrivalClass: 'backfill', occurredAt, reason: null };
    }
    return {
      family,
      arrivalClass: 'rejected',
      occurredAt,
      reason: `Evidence predates the ${family} enrollment watermark`,
    };
  }

  const delayThresholdSeconds = input.delayThresholdSeconds ?? DEFAULT_DELAY_THRESHOLD_SECONDS;
  const delayed = input.receivedAt.getTime() - occurredAt.getTime()
    > delayThresholdSeconds * 1000;
  return {
    family,
    arrivalClass: delayed ? 'delayed' : 'current',
    occurredAt,
    reason: null,
  };
}
