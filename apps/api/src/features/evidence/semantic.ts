import { spawn } from 'node:child_process';

export const SEMANTIC_MODEL = 'BAAI/bge-small-en-v1.5';
export const SEMANTIC_DIMENSIONS = 384;
export const SEMANTIC_RRF_K = 60;
export const SEMANTIC_CANDIDATE_LIMIT = 50;
export const SEMANTIC_MAX_ATTEMPTS = 5;
export const SEMANTIC_MIN_COSINE_SCORE = 0.60;

export type EmbeddingKind = 'document' | 'query';

export function semanticQueryForEmbedding(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  if (/\brace conditions?\b/i.test(trimmed)) {
    const subject = trimmed.replace(/\brace conditions?\b/ig, '').replace(/\s+/g, ' ').trim();
    return `Find work about concurrent requests involving ${subject || 'shared state'}.`;
  }
  const words = trimmed.split(/\s+/);
  if (words.length <= 8 && !/[.!?]$/.test(trimmed)) return `Find work about ${trimmed}.`;
  return trimmed;
}

export function semanticCandidateIsRelevant(input: {
  exact: boolean; lexicalRank?: number; vectorScore?: number;
}): boolean {
  return input.exact || Boolean(input.lexicalRank)
    || (input.vectorScore ?? Number.NEGATIVE_INFINITY) >= SEMANTIC_MIN_COSINE_SCORE;
}

export interface EmbeddingEngine {
  readonly model: string;
  readonly revision: string;
  readonly checksum: string;
  embed(text: string, kind: EmbeddingKind): Promise<number[]>;
}

export class SemanticUnavailableError extends Error {
  readonly code = 'semantic_model_unavailable';

  constructor() {
    super('Semantic search is unavailable because the local model is not ready');
  }
}

export function normalizeEmbedding(values: number[]): number[] {
  if (values.length !== SEMANTIC_DIMENSIONS
    || values.some(value => !Number.isFinite(value))) {
    throw new Error('semantic_invalid_dimensions');
  }
  const magnitude = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error('semantic_zero_vector');
  }
  return values.map(value => value / magnitude);
}

/**
 * Runs the pinned BGE model through a deployment-local executable. The Node
 * worker passes customer text on stdin (never argv or logs) and expects one
 * JSON vector on stdout. Production packaging owns the ONNX artifact and sets
 * TRACKAI_BGE_EXECUTABLE, TRACKAI_BGE_REVISION and TRACKAI_BGE_CHECKSUM.
 */
export class LocalBgeCommandEngine implements EmbeddingEngine {
  readonly model = SEMANTIC_MODEL;
  readonly revision: string;
  readonly checksum: string;
  private readonly executable: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const executable = environment.TRACKAI_BGE_EXECUTABLE?.trim();
    const revision = environment.TRACKAI_BGE_REVISION?.trim();
    const checksum = environment.TRACKAI_BGE_CHECKSUM?.trim();
    if (!executable || !revision || !checksum) throw new SemanticUnavailableError();
    this.executable = executable;
    this.revision = revision;
    this.checksum = checksum;
  }

  embed(text: string, kind: EmbeddingKind): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [
        '--model', this.model,
        '--revision', this.revision,
        '--checksum', this.checksum,
        '--kind', kind,
        '--dimensions', String(SEMANTIC_DIMENSIONS),
      ], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH ?? '',
          TRACKAI_BGE_MODEL_PATH: process.env.TRACKAI_BGE_MODEL_PATH ?? '',
          TRACKAI_BGE_ALLOW_REMOTE: 'false',
        },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('semantic_timeout'));
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32_768) {
          child.kill('SIGKILL');
          reject(new Error('semantic_output_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new SemanticUnavailableError());
      });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error('semantic_inference_failed'));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (!Array.isArray(parsed)) throw new Error('semantic_invalid_output');
          resolve(normalizeEmbedding(parsed.map(Number)));
        } catch {
          reject(new Error('semantic_invalid_output'));
        }
      });
      child.stdin.end(text, 'utf8');
    });
  }
}

export type RankedCandidate = {
  id: string;
  fusedScore: number;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalScore?: number;
  vectorScore?: number;
};

export function reciprocalRankFusion(
  lexical: Array<{ id: string; score: number }>,
  vector: Array<{ id: string; score: number }>,
): RankedCandidate[] {
  const candidates = new Map<string, RankedCandidate>();
  const add = (rows: Array<{ id: string; score: number }>, kind: 'lexical' | 'vector') => {
    rows.forEach((row, index) => {
      const current = candidates.get(row.id) ?? { id: row.id, fusedScore: 0 };
      const rank = index + 1;
      current.fusedScore += 1 / (SEMANTIC_RRF_K + rank);
      if (kind === 'lexical') {
        current.lexicalRank = rank;
        current.lexicalScore = row.score;
      } else {
        current.vectorRank = rank;
        current.vectorScore = row.score;
      }
      candidates.set(row.id, current);
    });
  };
  add(lexical, 'lexical');
  add(vector, 'vector');
  return [...candidates.values()].sort((left, right) => {
    const score = right.fusedScore - left.fusedScore;
    return score || left.id.localeCompare(right.id);
  });
}

export function semanticSafeError(error: unknown): string {
  if (error instanceof SemanticUnavailableError) return error.code;
  if (!(error instanceof Error)) return 'semantic_unknown_failure';
  const allowed = new Set([
    'semantic_timeout',
    'semantic_output_too_large',
    'semantic_inference_failed',
    'semantic_invalid_output',
    'semantic_invalid_dimensions',
    'semantic_zero_vector',
  ]);
  return allowed.has(error.message) ? error.message : 'semantic_unknown_failure';
}
