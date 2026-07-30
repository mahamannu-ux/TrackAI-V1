import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type EvidenceLinkage = 'exact' | 'time-window' | 'unresolved';
export type EvidenceNodeType =
  | 'developer_prompt' | 'agent_thinking' | 'agent_response'
  | 'tool_call' | 'tool_result' | 'commit';

export type EvidenceFlowNode = {
  id: string;
  sequence: number;
  timestamp: string;
  type: EvidenceNodeType;
  model: string | null;
  content: string | null;
  toolName?: string;
  arguments?: unknown;
  result?: unknown;
  linkageQuality: EvidenceLinkage;
  availabilityReason?: string;
};

export type OpenCodeEvidenceRow = {
  messageId: string;
  messageTime: number;
  messageData: string;
  partId: string;
  partTime: number;
  partData: string;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseJson(value: string): JsonRecord {
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function modelFromMessage(message: JsonRecord) {
  const nested = record(message.model);
  return stringValue(message.modelID) ?? stringValue(nested.modelID);
}

function nodeTime(row: OpenCodeEvidenceRow, part: JsonRecord) {
  const stateTime = record(record(part.state).time);
  const partTime = record(part.time);
  const candidate = Number(stateTime.start ?? partTime.start ?? row.partTime ?? row.messageTime);
  return Number.isFinite(candidate) ? candidate : 0;
}

export function evidenceFlowEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV !== 'production' && env.TRACKAI_DEV_EVIDENCE_ENABLED === 'true';
}

/** Converts provider rows to a customer-facing flow without exposing internal IDs. */
export function normalizeOpenCodeEvidence(
  rows: OpenCodeEvidenceRow[],
  commit: { sha: string; subject: string; committedAt: Date },
): EvidenceFlowNode[] {
  const raw: Array<Omit<EvidenceFlowNode, 'sequence'>> = [];
  for (const row of rows) {
    const message = parseJson(row.messageData);
    const part = parseJson(row.partData);
    const role = stringValue(message.role);
    const type = stringValue(part.type);
    const observedTime = nodeTime(row, part);
    if (observedTime > commit.committedAt.getTime()) continue;
    const timestamp = new Date(observedTime).toISOString();
    const model = modelFromMessage(message);
    const text = stringValue(part.text);
    const linkageQuality: EvidenceLinkage = 'time-window';

    if (role === 'user' && type === 'text') {
      raw.push({ id: `prompt:${row.partId}`, timestamp, type: 'developer_prompt',
        model, content: text, linkageQuality,
        ...(text ? {} : { availabilityReason: 'OpenCode did not retain prompt text' }) });
    } else if (role === 'assistant' && type === 'reasoning') {
      raw.push({ id: `thinking:${row.partId}`, timestamp, type: 'agent_thinking',
        model, content: text, linkageQuality,
        ...(text ? {} : { availabilityReason: 'Thinking content was not provided by the model' }) });
    } else if (role === 'assistant' && type === 'text') {
      raw.push({ id: `response:${row.partId}`, timestamp, type: 'agent_response',
        model, content: text, linkageQuality,
        ...(text ? {} : { availabilityReason: 'OpenCode did not retain response text' }) });
    } else if (role === 'assistant' && type === 'tool') {
      const state = record(part.state);
      const toolName = stringValue(part.tool) ?? 'unknown tool';
      raw.push({ id: `tool-call:${row.partId}`, timestamp, type: 'tool_call', model,
        content: null, toolName, arguments: state.input ?? null, linkageQuality });
      if ('output' in state || 'error' in state) {
        const end = Number(record(state.time).end ?? nodeTime(row, part));
        raw.push({ id: `tool-result:${row.partId}`,
          timestamp: new Date(Number.isFinite(end) ? end : nodeTime(row, part)).toISOString(),
          type: 'tool_result', model, content: null, toolName,
          result: state.output ?? state.error ?? null, linkageQuality });
      }
    }
  }
  const priority: Record<EvidenceNodeType, number> = {
    developer_prompt: 0, agent_thinking: 1, agent_response: 2,
    tool_call: 3, tool_result: 4, commit: 5,
  };
  raw.push({ id: `commit:${commit.sha}`, timestamp: commit.committedAt.toISOString(),
    type: 'commit', model: null, content: commit.subject, linkageQuality: 'exact' });
  return raw
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp)
      || priority[left.type] - priority[right.type] || left.id.localeCompare(right.id))
    .map((node, index) => ({ ...node, sequence: index + 1 }));
}

function safeSessionId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('Unsupported OpenCode conversation ID');
  return value;
}

export async function loadOpenCodeEvidence(args: {
  databasePath: string;
  externalSessionId: string;
  after?: Date;
  through: Date;
  commit: { sha: string; subject: string; committedAt: Date };
}) {
  const sessionId = safeSessionId(args.externalSessionId);
  const after = args.after?.getTime() ?? 0;
  const through = args.through.getTime();
  const sql = `SELECT m.id AS messageId, m.time_created AS messageTime,
    m.data AS messageData, p.id AS partId, p.time_created AS partTime,
    p.data AS partData FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = '${sessionId}' AND p.time_created > ${after}
      AND p.time_created <= ${through}
    ORDER BY p.time_created, m.id, p.id;`;
  const { stdout } = await execFileAsync('sqlite3', [
    '-readonly', '-json', args.databasePath, sql,
  ], { maxBuffer: 20 * 1024 * 1024, timeout: 10_000 });
  const rows = JSON.parse(stdout || '[]') as OpenCodeEvidenceRow[];
  return normalizeOpenCodeEvidence(rows, args.commit);
}
