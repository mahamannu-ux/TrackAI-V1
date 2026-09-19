import { createHash } from 'node:crypto';

export const EVIDENCE_EVENT_TYPES = [
  'prompt', 'reasoning', 'response', 'tool_call', 'tool_result',
] as const;

export type EvidenceEventType = typeof EVIDENCE_EVENT_TYPES[number];
export type EvidenceState = 'observed' | 'inferred' | 'corrected';
export type EvidenceAvailability = 'available' | 'unavailable' | 'redacted' | 'expired';

export interface OpenCodeEvidenceEventInput {
  providerEventId: string;
  type: EvidenceEventType;
  occurredAt: Date;
  traceId: string | null;
  model: string | null;
  toolName: string | null;
  content: unknown;
  metadata: Record<string, unknown>;
}

export interface OpenCodeEvidenceBatchInput {
  batchId: string;
  sourceVersion: string;
  repositoryId: string | null;
  externalSessionId: string;
  gitAiSessionId: string | null;
  intention: string | null;
  events: OpenCodeEvidenceEventInput[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${name} must be a string no longer than ${maximum} characters`);
  }
  return value;
}

function isoDate(value: unknown, name: string): Date {
  if (typeof value !== 'string') throw new Error(`${name} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

const SAFE_METADATA_FIELDS = new Set([
  'status', 'durationMs', 'attempt', 'errorCode', 'exitCode', 'abandoned',
]);

function safeMetadata(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  const source = object(value, name);
  const forbidden = Object.keys(source).filter(key => !SAFE_METADATA_FIELDS.has(key));
  if (forbidden.length) {
    throw new Error(`${name} contains unsupported fields; raw payloads belong in content`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(source)) {
    if (key === 'status' || key === 'errorCode') {
      result[key] = optionalString(candidate, `${name}.${key}`, 100);
    } else if (key === 'abandoned') {
      if (typeof candidate !== 'boolean') throw new Error(`${name}.abandoned must be a boolean`);
      result[key] = candidate;
    } else {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        throw new Error(`${name}.${key} must be a finite number`);
      }
      result[key] = candidate;
    }
  }
  return result;
}

export function validateOpenCodeEvidenceBatch(value: unknown): OpenCodeEvidenceBatchInput {
  const batch = object(value, 'batch');
  if (batch.provider !== 'opencode') throw new Error('provider must be opencode');
  if (!Array.isArray(batch.events) || batch.events.length === 0 || batch.events.length > 500) {
    throw new Error('events must contain between 1 and 500 items');
  }
  const providerIds = new Set<string>();
  const events = batch.events.map((raw, index): OpenCodeEvidenceEventInput => {
    const event = object(raw, `events[${index}]`);
    const providerEventId = requiredString(event.providerEventId, `events[${index}].providerEventId`, 300);
    if (providerIds.has(providerEventId)) throw new Error('providerEventId values must be unique in a batch');
    providerIds.add(providerEventId);
    if (!EVIDENCE_EVENT_TYPES.includes(event.type as EvidenceEventType)) {
      throw new Error(`events[${index}].type is unsupported`);
    }
    const metadata = safeMetadata(event.metadata, `events[${index}].metadata`);
    return {
      providerEventId,
      type: event.type as EvidenceEventType,
      occurredAt: isoDate(event.occurredAt, `events[${index}].occurredAt`),
      traceId: optionalString(event.traceId, `events[${index}].traceId`, 200),
      model: optionalString(event.model, `events[${index}].model`, 300),
      toolName: optionalString(event.toolName, `events[${index}].toolName`, 300),
      content: event.content ?? null,
      metadata,
    };
  });
  return {
    batchId: requiredString(batch.batchId, 'batchId', 200),
    sourceVersion: requiredString(batch.sourceVersion, 'sourceVersion', 100),
    repositoryId: optionalString(batch.repositoryId, 'repositoryId', 100),
    externalSessionId: requiredString(batch.externalSessionId, 'externalSessionId', 300),
    gitAiSessionId: optionalString(batch.gitAiSessionId, 'gitAiSessionId', 200),
    intention: optionalString(batch.intention, 'intention', 10_000),
    events,
  };
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/gi },
  { name: 'github_token', pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'assigned_secret', pattern: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi },
];

export interface RedactionResult {
  value: unknown;
  counts: Record<string, number>;
  changed: boolean;
}

export function redactSecrets(value: unknown): RedactionResult {
  const counts: Record<string, number> = {};
  const redactString = (input: string) => {
    let output = input;
    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, () => {
        counts[name] = (counts[name] ?? 0) + 1;
        return `[REDACTED:${name}]`;
      });
    }
    return output;
  };
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') return redactString(candidate);
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .map(([key, nested]) => [key, visit(nested)]));
    }
    return candidate;
  };
  const redacted = visit(value);
  return { value: redacted, counts, changed: Object.keys(counts).length > 0 };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'for', 'from', 'in', 'is', 'of', 'on', 'the', 'to', 'with']);

export function semanticTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)))].sort();
}

export function semanticSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

export function inferredIntentionFromPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const firstSentence = compact.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? compact;
  return firstSentence.slice(0, 500);
}
