import type { ParsedAuthorshipNote } from './types';

export const UNKNOWN_MODEL_KEY = 'unknown::unknown';

export function modelKey(tool: string | null | undefined, model: string | null | undefined) {
  const normalizedTool = tool?.trim() || 'unknown';
  const normalizedModel = model?.trim() || 'unknown';
  return `${normalizedTool}::${normalizedModel}`;
}

export function splitModelKey(key: string) {
  const separator = key.indexOf('::');
  if (separator < 0) return { tool: 'unknown', model: key || 'unknown' };
  return {
    tool: key.slice(0, separator) || 'unknown',
    model: key.slice(separator + 2) || 'unknown',
  };
}

export type NoteModelAttribution = {
  internalSessionId: string | null;
  externalSessionId: string | null;
  tool: string;
  model: string | null;
  modelKey: string;
  lines: number;
};

/** Preserve the Note's model split before external conversations are collapsed. */
export function modelAttributionsFromNote(note: ParsedAuthorshipNote): NoteModelAttribution[] {
  const sessions = new Map(note.sessions.map((session) => [session.internalId, session]));
  const grouped = new Map<string, NoteModelAttribution>();
  for (const [internalSessionId, lines] of note.aiLinesBySession) {
    if (lines <= 0) continue;
    const session = sessions.get(internalSessionId);
    const key = modelKey(session?.tool, session?.model);
    const existing = grouped.get(key);
    if (existing) {
      existing.lines += lines;
      continue;
    }
    grouped.set(key, {
      internalSessionId,
      externalSessionId: session?.externalId ?? null,
      tool: session?.tool ?? 'unknown',
      model: session?.model ?? null,
      modelKey: key,
      lines,
    });
  }
  return [...grouped.values()];
}

export function allocateReworkByOriginModel(input: {
  predecessor: Array<{ modelKey: string; lines: number }>;
  successor: Array<{ modelKey: string; lines: number }>;
  reworkedLines: number;
}) {
  const successor = new Map(input.successor.map((row) => [row.modelKey, row.lines]));
  let remaining = Math.max(0, input.reworkedLines);
  const result: Array<{ modelKey: string; lines: number; confidence: number }> = [];
  for (const row of input.predecessor) {
    const removed = Math.max(0, row.lines - (successor.get(row.modelKey) ?? 0));
    const attributed = Math.min(remaining, removed);
    if (attributed > 0) result.push({ modelKey: row.modelKey, lines: attributed, confidence: 100 });
    remaining -= attributed;
  }
  if (remaining > 0) result.push({ modelKey: UNKNOWN_MODEL_KEY, lines: remaining, confidence: 50 });
  return result;
}
