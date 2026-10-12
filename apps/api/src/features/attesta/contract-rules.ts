/**
 * Cross-field rules of the Attesta statement contract (docs/contracts/attesta,
 * README "Cross-field rules S1-S8") that JSON Schema cannot express.
 *
 * Input must already be valid against statement-v1.schema.json; these rules
 * assume that shape. The builder (A15.8) runs the schema and these rules on the
 * same parsed snapshot of the canonical bytes it signs (never on a live object
 * that could change between the check and the signature).
 *
 * Returns the sorted IDs of the rules the statement breaks (empty = passes).
 */

export type ContractRuleId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8';

type Wrapped<T> = { availability: 'recorded' | 'partial' | 'unavailable'; value?: T; partial_reason?: string };

interface StatementShape {
  subject: Array<{ name: string; digest: { gitCommit: string } }>;
  predicate: {
    statement_kind: 'commit_observed' | 'pr_merged' | 'deployed';
    as_of: string;
    previous: Array<{ digest: string }>;
    source_evidence: {
      metric_event: Wrapped<{ id: string }>;
      provider_delivery: Wrapped<{ received_at: string }>;
      note_digest: Wrapped<{ source_event_id: string }>;
    };
    first_seen: Wrapped<{ at: string }>;
    repository: { id: string };
    commit: { sha: string };
    files: Wrapped<{ total: number; omitted: number; entries: Array<{ path_sha256: string }> }>;
    sessions: Wrapped<Array<{ session_id: string; tool: string }>>;
    models: Wrapped<Array<{ tool: string; model: string | null; model_key: string }>>;
    tools: Wrapped<string[]>;
    pull_request: Wrapped<{ merge_commit_sha: string }>;
    deployment: Wrapped<{ sha: string }>;
  };
}

const SUBJECT_NAME = /^trackai:repository\/([0-9a-f-]{36})\/commit\/([0-9a-f]+)$/;

export function checkStatementRules(input: unknown): ContractRuleId[] {
  const statement = input as StatementShape;
  const p = statement.predicate;
  const broken = new Set<ContractRuleId>();
  const subject = statement.subject[0];
  const name = SUBJECT_NAME.exec(subject.name);

  // S1: one commit identity everywhere: subject name, subject digest,
  // predicate commit, and the kind's own anchor (merge result, deployed sha).
  const shas = [subject.digest.gitCommit, p.commit.sha];
  if (name) shas.push(name[2]);
  if (p.statement_kind === 'pr_merged' && p.pull_request.value) shas.push(p.pull_request.value.merge_commit_sha);
  if (p.statement_kind === 'deployed' && p.deployment.value) shas.push(p.deployment.value.sha);
  if (!name || new Set(shas).size !== 1) broken.add('S1');

  // S2: the subject's repository is the predicate's repository.
  if (!name || name[1] !== p.repository.id) broken.add('S2');

  // S3: file accounting is exact, truncation is declared, paths are unique.
  if (p.files.value) {
    const { total, omitted, entries } = p.files.value;
    const truncatedFlag = p.files.availability === 'partial' && p.files.partial_reason === 'entries_truncated';
    if (total - entries.length !== omitted) broken.add('S3');
    if (omitted > 0 && !truncatedFlag) broken.add('S3');
    if (new Set(entries.map((e) => e.path_sha256)).size !== entries.length) broken.add('S3');
  }

  // S4: tools is exactly the distinct tools named by sessions and models.
  if (p.tools.value) {
    const expected = new Set<string>([
      ...(p.sessions.value ?? []).map((s) => s.tool),
      ...(p.models.value ?? []).map((m) => m.tool),
    ]);
    const actual = new Set(p.tools.value);
    const sourcesKnown = Boolean(p.sessions.value || p.models.value);
    if (sourcesKnown && (actual.size !== expected.size || [...actual].some((t) => !expected.has(t)))) {
      broken.add('S4');
    }
  }

  // S5: nothing TrackAI itself observed is later than as_of. (Commit, merge and
  // deployment times come from other clocks and are not compared.)
  const observed = [p.first_seen.value?.at, p.source_evidence.provider_delivery.value?.received_at];
  if (observed.some((t) => t !== undefined && t > p.as_of)) broken.add('S5');

  // S6: each earlier statement is listed once.
  if (new Set(p.previous.map((x) => x.digest)).size !== p.previous.length) broken.add('S6');

  // S7: the note digest comes from the same metric event as the observation.
  const metricId = p.source_evidence.metric_event.value?.id;
  const noteSource = p.source_evidence.note_digest.value?.source_event_id;
  if (noteSource !== undefined && noteSource !== metricId) broken.add('S7');

  // S8: model keys follow Task2's rule (tool::model, "unknown" for a missing
  // model), and sessions are listed once.
  for (const m of p.models.value ?? []) {
    if (m.model_key !== `${m.tool}::${m.model ?? 'unknown'}`) broken.add('S8');
  }
  const sessions = p.sessions.value ?? [];
  if (new Set(sessions.map((s) => s.session_id)).size !== sessions.length) broken.add('S8');

  return [...broken].sort();
}
