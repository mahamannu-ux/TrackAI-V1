import type {
  DecodedAttributes,
  GitAiMetricEvent,
  GitAiMetricsBatch,
  SparseMap,
} from './types';

export const EVENT_KIND = {
  committed: 1,
  agentUsage: 2,
  installHooks: 3,
  checkpoint: 4,
  sessionEvent: 5,
  otelTrace: 6,
  rewriteCommitted: 7,
} as const;

export function stringAt(map: SparseMap, position: number): string | null {
  const value = map[String(position)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function numberAt(map: SparseMap, position: number): number | null {
  const value = map[String(position)];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringArrayAt(map: SparseMap, position: number): string[] {
  const value = map[String(position)];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function numberArrayAt(map: SparseMap, position: number): number[] {
  const value = map[String(position)];
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

export function decodeAttributes(attrs: SparseMap): DecodedAttributes {
  let customAttributes: Record<string, string> = {};
  const customJson = stringAt(attrs, 30);
  if (customJson) {
    try {
      const parsed = JSON.parse(customJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        customAttributes = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
      }
    } catch {
      customAttributes = {};
    }
  }

  return {
    gitAiVersion: stringAt(attrs, 0),
    repoUrl: stringAt(attrs, 1),
    author: stringAt(attrs, 2),
    commitSha: stringAt(attrs, 3),
    baseCommitSha: stringAt(attrs, 4),
    branch: stringAt(attrs, 5),
    tool: stringAt(attrs, 20),
    model: stringAt(attrs, 21),
    externalSessionId: stringAt(attrs, 23),
    sessionId: stringAt(attrs, 24),
    traceId: stringAt(attrs, 25),
    parentSessionId: stringAt(attrs, 26),
    externalParentSessionId: stringAt(attrs, 27),
    customAttributes,
  };
}

export function validateMetricsBatch(value: unknown): GitAiMetricsBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object');
  }
  const candidate = value as Partial<GitAiMetricsBatch>;
  if (candidate.v !== 1) throw new Error('Unsupported metrics API version');
  if (!Array.isArray(candidate.events)) throw new Error('events must be an array');
  if (candidate.events.length > 1000) throw new Error('events exceeds the 1000 event limit');
  return candidate as GitAiMetricsBatch;
}

export function validateMetricEvent(value: unknown): GitAiMetricEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('event must be an object');
  }
  const event = value as Partial<GitAiMetricEvent>;
  if (!Number.isInteger(event.t) || (event.t ?? 0) < 0) throw new Error('invalid event timestamp');
  if (!Number.isInteger(event.e) || (event.e ?? 0) < 1) throw new Error('invalid event kind');
  if (!event.v || typeof event.v !== 'object' || Array.isArray(event.v)) throw new Error('invalid event values');
  if (!event.a || typeof event.a !== 'object' || Array.isArray(event.a)) throw new Error('invalid event attributes');
  return event as GitAiMetricEvent;
}

export function decodeCommitValues(values: SparseMap) {
  const toolModelPairs = stringArrayAt(values, 3);
  const aiByTool = numberArrayAt(values, 5);
  return {
    humanLines: numberAt(values, 0) ?? 0,
    deletedLines: numberAt(values, 1) ?? 0,
    addedLines: numberAt(values, 2) ?? 0,
    toolModelPairs,
    aiByTool,
    aiLines: aiByTool[0] ?? 0,
    acceptedAiLines: numberArrayAt(values, 6)[0] ?? 0,
    subject: stringAt(values, 11) ?? 'Untitled commit',
    body: stringAt(values, 12),
    authorshipNote: stringAt(values, 13),
    hunks: stringAt(values, 14),
    authoredAtSeconds: numberAt(values, 15),
    committedAtSeconds: numberAt(values, 16),
    patchId: stringAt(values, 17),
  };
}

export function decodeRewriteValues(values: SparseMap) {
  const operationKind = stringAt(values, 15) ?? 'rewrite';
  return {
    ...decodeCommitValues(values),
    operationKind,
    originalCommitShas: stringArrayAt(values, 16),
    subject: stringAt(values, 11) ?? `Rewrite: ${operationKind.replaceAll('_', ' ')}`,
  };
}

export function decodeCheckpointValues(values: SparseMap) {
  return {
    checkpointTimestamp: numberAt(values, 0),
    kind: stringAt(values, 1),
    filePath: stringAt(values, 2),
    linesAdded: numberAt(values, 3) ?? 0,
    linesDeleted: numberAt(values, 4) ?? 0,
    linesAddedSloc: numberAt(values, 5),
    linesDeletedSloc: numberAt(values, 6),
    externalToolUseId: stringAt(values, 7),
    editKind: stringAt(values, 8),
    checkpointType: stringAt(values, 9),
  };
}

export function decodeSessionUsage(event: GitAiMetricEvent) {
  const raw = event.v['0'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const wrapper = raw as Record<string, unknown>;
  const message = wrapper.message && typeof wrapper.message === 'object'
    ? wrapper.message as Record<string, unknown>
    : wrapper;
  const data = message.data && typeof message.data === 'object'
    ? message.data as Record<string, unknown>
    : message;
  if (data.role !== 'assistant') return null;
  const tokenCandidate = data.tokens ?? data.usage;
  const tokens = tokenCandidate && typeof tokenCandidate === 'object'
    ? tokenCandidate as Record<string, unknown>
    : null;
  if (!tokens) return null;
  const cache = tokens.cache && typeof tokens.cache === 'object'
    ? tokens.cache as Record<string, unknown>
    : {};
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const model = typeof data.model === 'string'
    ? data.model
    : typeof data.modelID === 'string'
      ? data.modelID
      : data.model && typeof data.model === 'object'
        && typeof (data.model as Record<string, unknown>).modelID === 'string'
        ? (data.model as Record<string, unknown>).modelID as string
        : null;
  return {
    model,
    inputTokens: numeric(tokens.input) ?? numeric(tokens.input_tokens),
    outputTokens: numeric(tokens.output) ?? numeric(tokens.output_tokens),
    reasoningTokens: numeric(tokens.reasoning),
    cacheReadTokens: numeric(cache.read) ?? numeric(tokens.cache_read_input_tokens),
    cacheWriteTokens: numeric(cache.write) ?? numeric(tokens.cache_creation_input_tokens),
    costAmount: numeric(data.cost),
    externalEventId: typeof event.v['1'] === 'string' ? event.v['1'] : null,
  };
}
