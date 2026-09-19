import type { OpenCodeEvidenceRow } from '../telemetry/opencode-evidence';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function parsed(value: string): JsonRecord {
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function timestamp(row: OpenCodeEvidenceRow, part: JsonRecord) {
  const stateTime = record(record(part.state).time);
  const partTime = record(part.time);
  const milliseconds = Number(stateTime.start ?? partTime.start ?? row.partTime ?? row.messageTime);
  return new Date(Number.isFinite(milliseconds) ? milliseconds : 0).toISOString();
}

/**
 * GitAI client-side adapter for OpenCode's exported message/part rows.
 * It returns the server contract but never logs, caches, or writes raw content.
 */
export function openCodeRowsToEvidenceEvents(
  rows: OpenCodeEvidenceRow[],
  traceByProviderPartId: Readonly<Record<string, string>> = {},
) {
  const events: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const message = parsed(row.messageData);
    const part = parsed(row.partData);
    const role = text(message.role);
    const type = text(part.type);
    const state = record(part.state);
    const stateTime = record(state.time);
    const started = Number(stateTime.start);
    const ended = Number(stateTime.end);
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? ended - started : undefined;
    const base = {
      occurredAt: timestamp(row, part),
      traceId: traceByProviderPartId[row.partId] ?? null,
      model: text(message.modelID) ?? text(record(message.model).modelID),
      metadata: {
        ...(text(state.status) ? { status: text(state.status) } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    };
    if (role === 'user' && type === 'text') {
      events.push({ ...base, providerEventId: row.partId, type: 'prompt',
        toolName: null, content: text(part.text) });
    } else if (role === 'assistant' && type === 'reasoning') {
      events.push({ ...base, providerEventId: row.partId, type: 'reasoning',
        toolName: null, content: text(part.text) });
    } else if (role === 'assistant' && type === 'text') {
      events.push({ ...base, providerEventId: row.partId, type: 'response',
        toolName: null, content: text(part.text) });
    } else if (role === 'assistant' && type === 'tool') {
      const toolName = text(part.tool);
      events.push({ ...base, providerEventId: `${row.partId}:call`, type: 'tool_call',
        toolName, content: state.input ?? null });
      if ('output' in state || 'error' in state) {
        events.push({ ...base, providerEventId: `${row.partId}:result`, type: 'tool_result',
          toolName, content: state.output ?? state.error ?? null,
          metadata: { ...(base.metadata as JsonRecord),
            ...('error' in state ? { status: 'failed', errorCode: 'provider_tool_error' } : {}) },
        });
      }
    }
  }
  return events;
}

export async function uploadOpenCodeEvidenceBatch(input: {
  baseUrl: string;
  apiKey: string;
  machineId?: string;
  batch: Record<string, unknown>;
  fetchImplementation?: typeof fetch;
}) {
  const endpoint = new URL('/worker/evidence/opencode/batches', input.baseUrl);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
    throw new Error('Evidence upload requires HTTPS outside localhost');
  }
  const response = await (input.fetchImplementation ?? fetch)(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      ...(input.machineId ? { 'x-trackai-machine-id': input.machineId } : {}),
    },
    body: JSON.stringify(input.batch),
  });
  if (!response.ok) throw new Error(`Evidence upload failed with status ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}
