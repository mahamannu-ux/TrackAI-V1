export type SparseMap = Record<string, unknown>;

export type GitAiMetricEvent = {
  t: number;
  e: number;
  v: SparseMap;
  a: SparseMap;
};

export type GitAiMetricsBatch = {
  v: number;
  events: GitAiMetricEvent[];
};

export type DecodedAttributes = {
  gitAiVersion: string | null;
  repoUrl: string | null;
  author: string | null;
  commitSha: string | null;
  baseCommitSha: string | null;
  branch: string | null;
  tool: string | null;
  model: string | null;
  externalSessionId: string | null;
  sessionId: string | null;
  traceId: string | null;
  parentSessionId: string | null;
  externalParentSessionId: string | null;
  customAttributes: Record<string, string>;
};

export type AttributionRange = {
  authorId: string;
  kind: 'ai' | 'human';
  startLine: number;
  endLine: number;
  sessionId?: string;
  traceId?: string;
};

export type ParsedAuthorshipFile = {
  path: string;
  ranges: AttributionRange[];
  aiLines: number;
  humanLines: number;
};

export type ParsedAuthorshipSession = {
  internalId: string;
  externalId: string;
  tool: string;
  model: string | null;
  humanAuthor: string | null;
};

export type ParsedAuthorshipNote = {
  files: ParsedAuthorshipFile[];
  sessions: ParsedAuthorshipSession[];
  aiLinesBySession: Map<string, number>;
};
