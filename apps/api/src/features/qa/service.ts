/**
 * Q&A service (Task19a, T19.2): question lookup, kind and role checks, parameter
 * and scope validation, and answers through the answerer registry, each validated
 * before it leaves the server (docs/contracts/qa/api.md). Route handlers stay thin
 * (qa.routes.ts); queries live here (AGENTS.md §10).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { scmCommits, scmPullRequests, scmRepositories } from '../../core/db/schema';
import { withTenant } from '../../core/db/tenant';
import type { AnswererRegistry } from './answerers';
import { MAX_PERIOD_MS, checkEnvelope } from './envelope';
import type { QaApiCode } from './http';
import { QA_QUESTIONS_BY_ID, QA_REGISTRY_VERSION, openGapsOf } from './registry';
import {
  QA_KINDS, type QaAnswerContext, type QaDimension, type QaEnvelope, type QaKind, type QaQuestion,
  type QaQuestionId, type QaReason, type QaRole, type QaScope, type QaScopeLevel,
} from './types';

export const DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const DRILLDOWN_MAX_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

const ANSWER_PARAMS = ['kind', 'repository_id', 'pull_request_id', 'commit_sha', 'from', 'to', 'breakdown'] as const;
const DRILLDOWN_PARAMS = ['kind', 'repository_id', 'pull_request_id', 'commit_sha', 'from', 'to', 'limit', 'cursor'] as const;

/** A request the service refuses, with its problem code. */
export class QaProblem extends Error {
  constructor(readonly code: QaApiCode, readonly cause_?: string) {
    super(code);
    this.name = 'QaProblem';
  }
}

/** Tenant-bound existence checks for the scope ids (another tenant's id is simply not found). */
export interface QaScopeStore {
  repositoryExists(tenantId: string, repositoryId: string): Promise<boolean>;
  /** The pull request's repository, or null when it is not the tenant's. */
  pullRequestRepository(tenantId: string, pullRequestId: string): Promise<string | null>;
  commitExists(tenantId: string, repositoryId: string, sha: string): Promise<boolean>;
}

export const pgScopeStore: QaScopeStore = {
  async repositoryExists(tenantId, repositoryId) {
    const rows = await withTenant(db, tenantId).select(scmRepositories, eq(scmRepositories.id, repositoryId));
    return rows.length > 0;
  },
  async pullRequestRepository(tenantId, pullRequestId) {
    const rows = await withTenant(db, tenantId).select(scmPullRequests, eq(scmPullRequests.id, pullRequestId));
    return rows[0]?.repositoryId ?? null;
  },
  async commitExists(tenantId, repositoryId, sha) {
    const rows = await withTenant(db, tenantId).select(
      scmCommits, and(eq(scmCommits.repositoryId, repositoryId), eq(scmCommits.sha, sha)),
    );
    return rows.length > 0;
  },
};

export function findQuestion(id: string): QaQuestion {
  const question = QA_QUESTIONS_BY_ID.get(id);
  if (!question) throw new QaProblem('QA_QUESTION_NOT_FOUND');
  return question;
}

type Query = Record<string, unknown>;

/** One string value, or undefined; a repeated or non-string parameter is invalid. */
function single(query: Query, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new QaProblem('QA_SCOPE_INVALID', `${name}:shape`);
  return value;
}

function onlyKnown(query: Query, known: readonly string[]): void {
  for (const name of Object.keys(query)) {
    if (!known.includes(name)) throw new QaProblem('QA_SCOPE_INVALID', 'unknown_parameter');
  }
}

/** kind: present, a known word, offered by the question, allowed for the role (D2: no live for auditors). */
export function parseKind(query: Query, question: QaQuestion, role: QaRole): QaKind {
  const kind = single(query, 'kind');
  if (!kind || !(QA_KINDS as readonly string[]).includes(kind)) throw new QaProblem('QA_SCOPE_INVALID', 'kind');
  if (!question.kinds.some((offered) => offered.kind === kind)) throw new QaProblem('QA_KIND_NOT_OFFERED');
  if (kind === 'live' && role === 'tenant_auditor') throw new QaProblem('QA_KIND_NOT_ALLOWED');
  return kind as QaKind;
}

function parseTime(value: string, name: string): number {
  if (!RFC3339_RE.test(value)) throw new QaProblem('QA_SCOPE_INVALID', name);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new QaProblem('QA_SCOPE_INVALID', name);
  return ms;
}

export interface ParsedScope {
  level: QaScopeLevel;
  scope: QaScope;
}

/** The ids and the period; the scope level is the most specific id given. */
export function parseScope(query: Query, question: QaQuestion, now: Date): ParsedScope {
  const repositoryId = single(query, 'repository_id');
  const pullRequestId = single(query, 'pull_request_id');
  const commitSha = single(query, 'commit_sha');
  if (repositoryId !== undefined && !UUID_RE.test(repositoryId)) throw new QaProblem('QA_SCOPE_INVALID', 'repository_id');
  if (pullRequestId !== undefined && !UUID_RE.test(pullRequestId)) throw new QaProblem('QA_SCOPE_INVALID', 'pull_request_id');
  if (commitSha !== undefined && (!SHA_RE.test(commitSha) || repositoryId === undefined)) {
    throw new QaProblem('QA_SCOPE_INVALID', 'commit_sha');
  }
  const fromText = single(query, 'from');
  const toText = single(query, 'to');
  const to = toText === undefined ? now.getTime() : parseTime(toText, 'to');
  const from = fromText === undefined ? to - DEFAULT_PERIOD_MS : parseTime(fromText, 'from');
  if (from > to || to - from > MAX_PERIOD_MS) throw new QaProblem('QA_SCOPE_INVALID', 'period');
  const level: QaScopeLevel = commitSha !== undefined ? 'commit'
    : pullRequestId !== undefined ? 'pull_request'
      : repositoryId !== undefined ? 'repository' : 'tenant';
  if (!question.scopes.includes(level)) throw new QaProblem('QA_SCOPE_INVALID', 'scope_level');
  const scope: QaScope = {
    ...(repositoryId !== undefined ? { repository_id: repositoryId } : {}),
    ...(pullRequestId !== undefined ? { pull_request_id: pullRequestId } : {}),
    ...(commitSha !== undefined ? { commit_sha: commitSha } : {}),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
  return { level, scope };
}

export function parseBreakdown(query: Query, question: QaQuestion): QaDimension | null {
  const breakdown = single(query, 'breakdown');
  if (breakdown === undefined) return null;
  if (!(question.dimensions as readonly string[]).includes(breakdown)) throw new QaProblem('QA_SCOPE_INVALID', 'breakdown');
  return breakdown as QaDimension;
}

/** Another tenant's id is the same 404 as an unknown id, never 403. */
export async function checkScopeExists(store: QaScopeStore, tenantId: string, scope: QaScope): Promise<void> {
  try {
    if (scope.repository_id && !(await store.repositoryExists(tenantId, scope.repository_id))) {
      throw new QaProblem('QA_SCOPE_NOT_FOUND');
    }
    if (scope.pull_request_id) {
      const repositoryId = await store.pullRequestRepository(tenantId, scope.pull_request_id);
      if (repositoryId === null || (scope.repository_id && repositoryId !== scope.repository_id)) {
        throw new QaProblem('QA_SCOPE_NOT_FOUND');
      }
    }
    if (scope.commit_sha && scope.repository_id
      && !(await store.commitExists(tenantId, scope.repository_id, scope.commit_sha))) {
      throw new QaProblem('QA_SCOPE_NOT_FOUND');
    }
  } catch (err) {
    if (err instanceof QaProblem) throw err;
    throw new QaProblem('QA_UNAVAILABLE', 'scope_store');
  }
}

/** The previous period of the same length, ending 1 ms before this one starts. */
export function previousPeriod(scope: QaScope): { from: string; to: string } {
  const from = Date.parse(scope.from);
  const length = Date.parse(scope.to) - from;
  const to = from - 1;
  return { from: new Date(to - length).toISOString(), to: new Date(to).toISOString() };
}

/** The honest answer when no answerer is registered: unavailable, with why. */
export function notBuiltEnvelope(question: QaQuestion, ctx: QaAnswerContext): QaEnvelope {
  const reasons: QaReason[] = [
    { code: question.phase === 2 ? 'phase_2' : 'answer_not_built' },
    ...openGapsOf(question).map((gap): QaReason => ({ code: 'not_captured_yet', gap })),
  ];
  return {
    question_id: question.id,
    registry_version: QA_REGISTRY_VERSION,
    kind: ctx.kind,
    as_of: ctx.now,
    scope: ctx.scope,
    availability: 'unavailable',
    reasons,
    figures: [],
    ...(question.compare_previous ? { previous: { ...previousPeriod(ctx.scope), figures: [] } } : {}),
    wording: [...question.wording],
    drilldown: [],
  };
}

export interface AnswerRequest {
  tenantId: string;
  role: QaRole;
  questionId: string;
  query: Query;
  now: Date;
}

export interface QaServiceDeps {
  answerers: AnswererRegistry;
  scopes: QaScopeStore;
}

/** Checks the request in the documented order and returns a validated envelope. */
export async function answerQuestion(deps: QaServiceDeps, request: AnswerRequest): Promise<QaEnvelope> {
  const question = findQuestion(request.questionId);
  const kind = parseKind(request.query, question, request.role);
  onlyKnown(request.query, ANSWER_PARAMS);
  const { level, scope } = parseScope(request.query, question, request.now);
  const breakdown = parseBreakdown(request.query, question);
  await checkScopeExists(deps.scopes, request.tenantId, scope);
  const ctx: QaAnswerContext = {
    tenantId: request.tenantId,
    questionId: question.id as QaQuestionId,
    kind,
    role: request.role,
    scopeLevel: level,
    scope,
    breakdown,
    now: request.now.toISOString(),
  };
  const answerer = deps.answerers.get(ctx.questionId, kind);
  let envelope: unknown;
  if (answerer) {
    try {
      envelope = await answerer(ctx);
    } catch {
      throw new QaProblem('QA_UNAVAILABLE', 'answerer_threw');
    }
  } else {
    envelope = notBuiltEnvelope(question, ctx);
  }
  const check = checkEnvelope(envelope, { questionId: ctx.questionId, kind, scope, breakdown });
  if (!check.ok) throw new QaProblem('QA_ANSWER_INVALID', check.path ?? 'invalid');
  return envelope as QaEnvelope;
}

/** The drill-down's parameters are checked now; the route answers 501 until Task19b. */
export function checkDrilldownRequest(request: AnswerRequest): void {
  const question = findQuestion(request.questionId);
  parseKind(request.query, question, request.role);
  onlyKnown(request.query, DRILLDOWN_PARAMS);
  parseScope(request.query, question, request.now);
  const limit = single(request.query, 'limit');
  if (limit !== undefined && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > DRILLDOWN_MAX_LIMIT)) {
    throw new QaProblem('QA_SCOPE_INVALID', 'limit');
  }
  const cursor = single(request.query, 'cursor');
  if (cursor !== undefined && !CURSOR_RE.test(cursor)) throw new QaProblem('QA_SCOPE_INVALID', 'cursor');
}

/** GET /questions/{id}: the entry and, per kind, whether an answer is built and which gaps are open. */
export function describeQuestion(question: QaQuestion, answerers: AnswererRegistry) {
  return {
    registry_version: QA_REGISTRY_VERSION,
    question,
    answers: question.kinds.map((entry) => ({
      kind: entry.kind,
      builder: entry.builder,
      built: answerers.get(question.id as QaQuestionId, entry.kind) !== undefined,
      open_gaps: openGapsOf(question),
    })),
  };
}
