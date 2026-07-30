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
    aiAuthoredLinesDeleted: numberAt(values, 11),
    humanAuthoredLinesDeleted: numberAt(values, 12),
    unknownAuthoredLinesDeleted: numberAt(values, 13),
  };
}

export function decodeAiAuthoredDeletionLines(
  rawHunks: string | null,
  predecessorFiles: Array<{ path: string; attributionRanges: unknown }> = [],
): number | null {
  if (!rawHunks) return null;
  try {
    const hunks = JSON.parse(rawHunks) as unknown;
    if (!Array.isArray(hunks)) return null;
    const predecessorRanges = new Map<string, Array<Array<{
      kind: string;
      startLine: number;
      endLine: number;
    }>>>();
    for (const file of predecessorFiles) {
      if (!Array.isArray(file.attributionRanges)) continue;
      const ranges = file.attributionRanges.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const range = value as Record<string, unknown>;
        return (range.kind === 'ai' || range.kind === 'human')
          && typeof range.startLine === 'number'
          && typeof range.endLine === 'number'
          ? [{ kind: range.kind, startLine: range.startLine, endLine: range.endLine }]
          : [];
      });
      const history = predecessorRanges.get(file.path) ?? [];
      history.push(ranges);
      predecessorRanges.set(file.path, history);
    }
    return hunks.reduce((total, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return total;
      const hunk = value as Record<string, unknown>;
      if (hunk.hunk_kind !== 'deletion') return total;
      const start = typeof hunk.start_line === 'number' ? hunk.start_line : null;
      const end = typeof hunk.end_line === 'number' ? hunk.end_line : null;
      const aiAuthored = typeof hunk.session_id === 'string'
        || (typeof hunk.prompt_id === 'string' && hunk.prompt_id.startsWith('s_'));
      if (start === null || end === null || end < start) return total;
      if (aiAuthored) return total + end - start + 1;
      const path = typeof hunk.file_path === 'string' ? hunk.file_path : null;
      const history = path ? predecessorRanges.get(path) ?? [] : [];
      let inheritedAiLines = 0;
      for (let line = start; line <= end; line += 1) {
        for (const ranges of history) {
          const owner = ranges.find((range) => line >= range.startLine && line <= range.endLine);
          if (!owner) continue;
          if (owner.kind === 'ai') inheritedAiLines += 1;
          break;
        }
      }
      return total + inheritedAiLines;
    }, 0);
  } catch {
    return null;
  }
}

export function decodeDeletionFilePaths(rawHunks: string | null): Set<string> {
  if (!rawHunks) return new Set();
  try {
    const hunks = JSON.parse(rawHunks) as unknown;
    if (!Array.isArray(hunks)) return new Set();
    return new Set(hunks.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const hunk = value as Record<string, unknown>;
      return hunk.hunk_kind === 'deletion' && typeof hunk.file_path === 'string'
        ? [normalizeEvidencePath(hunk.file_path)]
        : [];
    }));
  } catch {
    return new Set();
  }
}

export function checkpointDeletionMatchesCommitFiles(
  checkpointFilePath: string | null,
  commitDeletionPaths: Set<string>,
) {
  if (!checkpointFilePath || commitDeletionPaths.size === 0) return true;
  return commitDeletionPaths.has(normalizeEvidencePath(checkpointFilePath));
}

function normalizeEvidencePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
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
    costUnit: numeric(data.cost) === null ? null : 'USD',
    externalEventId: typeof event.v['1'] === 'string' ? event.v['1'] : null,
  };
}

export function decodeOtelUsage(event: GitAiMetricEvent) {
  const raw = event.v['0'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const wrapper = raw as Record<string, unknown>;
  const span = wrapper.span && typeof wrapper.span === 'object' && !Array.isArray(wrapper.span)
    ? wrapper.span as Record<string, unknown>
    : null;
  if (!span || span.operation_name !== 'chat') return null;
  const attributes = wrapper.attributes
    && typeof wrapper.attributes === 'object'
    && !Array.isArray(wrapper.attributes)
    ? wrapper.attributes as Record<string, unknown>
    : {};
  const numeric = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  const inputTokens = numeric(span.input_tokens)
    ?? numeric(attributes['gen_ai.usage.input_tokens']);
  const outputTokens = numeric(span.output_tokens)
    ?? numeric(attributes['gen_ai.usage.output_tokens']);
  const reasoningTokens = numeric(span.reasoning_tokens)
    ?? numeric(attributes['gen_ai.usage.reasoning_tokens'])
    ?? numeric(attributes['gen_ai.usage.reasoning.output_tokens']);
  const cacheReadTokens = numeric(span.cached_tokens)
    ?? numeric(attributes['gen_ai.usage.cache_read.input_tokens']);
  if (
    inputTokens === null
    && outputTokens === null
    && reasoningTokens === null
    && cacheReadTokens === null
  ) return null;
  const model = typeof span.response_model === 'string' && span.response_model.length > 0
    ? span.response_model
    : typeof span.request_model === 'string' && span.request_model.length > 0
      ? span.request_model
      : null;
  const copilotNanoAiu = numeric(attributes['copilot_chat.copilot_usage_nano_aiu']);
  return {
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens: null,
    costAmount: copilotNanoAiu,
    costUnit: copilotNanoAiu === null ? null : 'copilot_nano_aiu',
    externalEventId: typeof event.v['1'] === 'string' ? event.v['1'] : null,
  };
}
