/**
 * The Q&A contract's types (Task19a, T19.2). The wire shape is frozen in
 * docs/contracts/qa/answer-v1.schema.json; these types mirror it and every
 * envelope an answerer returns is validated against that schema (envelope.ts).
 *
 * Names freeze on merge: a rename later is a breaking change (docs/contracts/qa/README.md).
 */

export const QA_KINDS = ['live', 'verifiable', 'signed'] as const;
export type QaKind = typeof QA_KINDS[number];

export const QA_FAMILIES = ['code', 'security'] as const;
export type QaFamily = typeof QA_FAMILIES[number];

export const QA_AUDITOR_FLAGS = ['yes', 'partly', 'no'] as const;
export type QaAuditorFlag = typeof QA_AUDITOR_FLAGS[number];

/** Who builds each kind of answer (TASK19.md §3; null = not scheduled). */
export const QA_BUILDERS = ['T19.3', 'T19.4', 'Task19d', 'A16.13a', 'A16.13b', 'Task15i4', 'Task15p'] as const;
export type QaBuilder = typeof QA_BUILDERS[number];

export const QA_SCOPES = ['tenant', 'repository', 'pull_request', 'commit'] as const;
export type QaScopeLevel = typeof QA_SCOPES[number];

/** Allowed breakdowns. Never a person (README "No person"): a unit test refuses one. */
export const QA_DIMENSIONS = [
  'model', 'tool', 'repository', 'agent_family', 'operating_system',
  'rule', 'rule_category', 'severity', 'machine', 'team',
] as const;
export type QaDimension = typeof QA_DIMENSIONS[number];

/** Words that may never name a scope or a dimension (Task5's no-surveillance rule). */
export const QA_PERSON_WORDS = ['developer', 'contributor', 'author', 'committer', 'user', 'person', 'reviewer', 'merger'] as const;

export const QA_AVAILABILITIES = ['recorded', 'partial', 'unavailable'] as const;
export type QaAvailability = typeof QA_AVAILABILITIES[number];

export const QA_REASON_CODES = [
  'not_captured_yet', // with gap
  'not_monitored', // a platform outside D6.2
  'vendor_does_not_report', // Q18
  'never_written', // Churned
  'partial_linkage', // the session text join (G10)
  'answer_not_built',
  'phase_2',
  'not_sealed_yet', // A16.13: the seal lag, only the sealed part is counted
  'evidence_broken', // A16.13: a seal or chain break; the answer is unavailable
  'report_not_built', // A16.13: no signed report for exactly this scope
  'evidence_truncated', // A16.13: more than 50 000 statements; the figure is partial
  'data_setting_off', // security URL data remains on the developer machine
  'zero_denominator', // a ratio cannot be computed from zero decisions
] as const;
export type QaReasonCode = typeof QA_REASON_CODES[number];

export const QA_GAP_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'G17'] as const;
export type QaGapId = typeof QA_GAP_IDS[number];

export const QA_WORDING_CODES = [
  'monitor_only_observed',
  'unknown_model_explicit',
  'merged_not_deployed_proxy',
  'churned_unavailable',
  'session_link_partial',
  'requested_not_confirmed',
  'metadata_only',
] as const;
export type QaWordingCode = typeof QA_WORDING_CODES[number];

export const QA_DRILLDOWN_SCOPES = ['repository', 'pull_request', 'commit', 'file', 'session', 'finding', 'statement'] as const;
export type QaDrilldownScope = typeof QA_DRILLDOWN_SCOPES[number];

export type QaQuestionId = `Q${number}` | `S${number}`;

export interface QaReason {
  code: QaReasonCode;
  /** Required for not_captured_yet, absent otherwise. */
  gap?: QaGapId;
}

/** Integers only, within ±(2^53 − 1); a share is a ratio, computed for display only. */
export type QaValue =
  | { type: 'count'; count: number }
  | { type: 'ratio'; numerator: number; denominator: number }
  | { type: 'duration_ms'; ms: number };

export interface QaBreakdownItem {
  dimension: QaDimension;
  /** The bucket: a model key, a repository id, a rule id, `unknown`… never a person. */
  key: string;
  value: QaValue;
}

/** RP-1 per-figure evidence (docs/contracts/attesta/period-report.md): verifiable and signed only. */
export interface QaEvidence {
  count: number;
  /** RFC 6962 root over the record digests in seq order. */
  statements_root: string;
  records: Array<{ seq: number; digest: string }>;
}

export interface QaFigure {
  key: string;
  availability: QaAvailability;
  reasons: QaReason[];
  /** null exactly when availability is `unavailable`; never 0 in its place. */
  value: QaValue | null;
  breakdown?: QaBreakdownItem[];
  evidence?: QaEvidence;
}

export interface QaScope {
  repository_id?: string;
  pull_request_id?: string;
  commit_sha?: string;
  /** RFC 3339 UTC with milliseconds; at most 366 days apart. */
  from: string;
  to: string;
}

export interface QaPrevious {
  from: string;
  to: string;
  figures: QaFigure[];
}

export interface QaDrilldown {
  scope: QaDrilldownScope;
  id: string;
  /** Display text: never a path, a session's text or raw content. */
  label: string;
}

/** "See the signed evidence": a filter for GET /api/attesta/statements (live only; a link, never the statements). */
export interface QaSignedEvidenceLink {
  path: '/api/attesta/statements';
  query: {
    repository_id?: string;
    kind?: string;
    subject_sha?: string;
    from: string;
    to: string;
  };
}

export interface QaEnvelope {
  question_id: QaQuestionId;
  registry_version: number;
  kind: QaKind;
  as_of: string;
  scope: QaScope;
  availability: QaAvailability;
  reasons: QaReason[];
  figures: QaFigure[];
  previous?: QaPrevious;
  wording: QaWordingCode[];
  drilldown: QaDrilldown[];
  signed_evidence?: QaSignedEvidenceLink;
  signed?: { statement_digest: string; predicate_type: string };
}

export type QaRole = 'tenant_admin' | 'tenant_auditor';

/** What an answerer is given: the tenant, the validated scope and the caller's role. */
export interface QaAnswerContext {
  tenantId: string;
  questionId: QaQuestionId;
  kind: QaKind;
  role: QaRole;
  scopeLevel: QaScopeLevel;
  scope: QaScope;
  breakdown: QaDimension | null;
  /** The query time (RFC 3339 UTC ms); a live answer's as_of. */
  now: string;
}

export type QaAnswerer = (ctx: QaAnswerContext) => Promise<QaEnvelope>;

/** One kind of answer a question offers, and who builds it (null: not scheduled). */
export interface QaQuestionKind {
  kind: QaKind;
  builder: QaBuilder | null;
}

/** One registry entry (docs/contracts/qa/questions.md). */
export interface QaQuestion {
  id: QaQuestionId;
  family: QaFamily;
  /** Rank within the family, 1 = asked first (CUSTOMER_AUDITOR_QA.md). */
  rank: number;
  /** Phase 2 questions answer `phase_2` until they are scheduled. */
  phase: 1 | 2;
  /** The question in plain words, at most 200 characters. */
  title: string;
  auditor: QaAuditorFlag;
  kinds: readonly QaQuestionKind[];
  gaps: readonly QaGapId[];
  scopes: readonly QaScopeLevel[];
  dimensions: readonly QaDimension[];
  /** The envelope then carries `previous` with the same figure keys. */
  compare_previous: boolean;
  /** Caveat codes every answer must carry. */
  wording: readonly QaWordingCode[];
}

/** One capture gap (CUSTOMER_AUDITOR_QA.md "Gaps found"). */
export interface QaGap {
  id: QaGapId;
  title: string;
  owner: string;
  open: boolean;
  questions: readonly QaQuestionId[];
}
