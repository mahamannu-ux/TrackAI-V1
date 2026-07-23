import type {
  AttributionRange,
  ParsedAuthorshipFile,
  ParsedAuthorshipNote,
  ParsedAuthorshipSession,
} from './types';

function rangeLength(startLine: number, endLine: number): number {
  return Math.max(0, endLine - startLine + 1);
}

function parseRange(authorId: string, token: string): AttributionRange | null {
  const match = token.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  const [sessionId, traceId] = authorId.split('::');
  const kind = authorId.startsWith('s_') ? 'ai' : 'human';
  return {
    authorId,
    kind,
    startLine,
    endLine,
    sessionId: kind === 'ai' ? sessionId : undefined,
    traceId: kind === 'ai' ? traceId : undefined,
  };
}

export function parseAuthorshipNote(note: string | null): ParsedAuthorshipNote {
  if (!note) return { files: [], sessions: [], aiLinesBySession: new Map() };
  const separator = note.indexOf('\n---\n');
  const rangeText = separator >= 0 ? note.slice(0, separator) : note;
  const metadataText = separator >= 0 ? note.slice(separator + 5) : '{}';
  const files: ParsedAuthorshipFile[] = [];
  let current: ParsedAuthorshipFile | null = null;

  for (const line of rangeText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      current = { path: line.trim(), ranges: [], aiLines: 0, humanLines: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const [authorId, ...rangeTokens] = line.trim().split(/\s+/);
    for (const token of rangeTokens.join('').split(',')) {
      const range = parseRange(authorId, token);
      if (!range) continue;
      current.ranges.push(range);
      const count = rangeLength(range.startLine, range.endLine);
      if (range.kind === 'ai') current.aiLines += count;
      else current.humanLines += count;
    }
  }

  const sessions: ParsedAuthorshipSession[] = [];
  try {
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    const sessionMap = metadata.sessions && typeof metadata.sessions === 'object'
      ? metadata.sessions as Record<string, unknown>
      : {};
    for (const [internalId, rawSession] of Object.entries(sessionMap)) {
      if (!rawSession || typeof rawSession !== 'object') continue;
      const session = rawSession as Record<string, unknown>;
      const agent = session.agent_id && typeof session.agent_id === 'object'
        ? session.agent_id as Record<string, unknown>
        : {};
      sessions.push({
        internalId,
        externalId: typeof agent.id === 'string' ? agent.id : internalId,
        tool: typeof agent.tool === 'string' ? agent.tool : 'unknown',
        model: typeof agent.model === 'string' ? agent.model : null,
        humanAuthor: typeof session.human_author === 'string' ? session.human_author : null,
      });
    }
  } catch {
    // Range evidence remains useful even when legacy metadata is malformed.
  }

  const aiLinesBySession = new Map<string, number>();
  for (const file of files) {
    for (const range of file.ranges) {
      if (!range.sessionId) continue;
      aiLinesBySession.set(
        range.sessionId,
        (aiLinesBySession.get(range.sessionId) ?? 0) + rangeLength(range.startLine, range.endLine),
      );
    }
  }
  return { files, sessions, aiLinesBySession };
}
