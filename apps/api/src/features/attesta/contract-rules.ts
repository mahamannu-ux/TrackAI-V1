/**
 * Cross-field rules of the Attesta statement contract (docs/contracts/attesta,
 * README "Cross-field rules S1-S12") that JSON Schema cannot express.
 *
 * Input must already be valid against statement-v1.schema.json; these rules
 * assume that shape. The builder (A15.8) runs the schema and these rules on the
 * same parsed snapshot of the canonical bytes it signs (never on a live object
 * that could change between the check and the signature).
 *
 * Returns the sorted IDs of the rules the statement breaks (empty = passes).
 */

export type ContractRuleId =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12';

type Wrapped<T> = { availability: 'recorded' | 'partial' | 'unavailable'; value?: T; partial_reason?: string };

interface StatementShape {
  subject: Array<{ name: string; digest: { gitCommit: string } }>;
  predicate: {
    statement_kind: 'commit_observed' | 'pr_merged' | 'deployed';
    as_of: string;
    previous: Array<{ digest: string }>;
    source_evidence: {
      metric_event: Wrapped<{ id: string }>;
      provider_delivery: Wrapped<{ provider: string; received_at: string }>;
      note_digest: Wrapped<{ source_event_id: string }>;
    };
    first_seen: Wrapped<{ at: string }>;
    repository: { id: string; provider: string };
    commit: { sha: string };
    lines: Wrapped<{ ai: number; human: number; unknown: number; added: number; deleted: number }>;
    files: Wrapped<{ total: number; omitted: number; entries: Array<{ path_sha256: string; ai_lines: number; human_lines: number }> }>;
    sessions: Wrapped<Array<{ session_id: string; tool: string }>>;
    models: Wrapped<Array<{ tool: string; model: string | null; model_key: string; session_id: string | null }>>;
    tools: Wrapped<string[]>;
    pull_request: Wrapped<{ provider: string; merge_commit_sha: string }>;
    merge_lineage: Wrapped<Array<{ source_sha: string; result_sha: string; merge_method: string }>>;
    deployment: Wrapped<{ provider: string; sha: string }>;
    security_findings_observed: Wrapped<{ total: number; by_category: Record<string, number>; by_severity: Record<string, number> }>;
  };
}

const SUBJECT_NAME = /^trackai:repository\/([0-9a-f-]{36})\/commit\/([0-9a-f]+)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Every string in the predicate that has timestamp form. */
function timestamps(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    if (TIMESTAMP.test(node)) found.push(node);
  } else if (Array.isArray(node)) {
    node.forEach((child) => timestamps(child, found));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((child) => timestamps(child, found));
  }
  return found;
}

/** Paths of wrapped fields that claim partial_reason entries_truncated. */
function truncatedPaths(node: unknown, path: string, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child, index) => truncatedPaths(child, `${path}[${index}]`, found));
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.partial_reason === 'entries_truncated') found.push(path);
    for (const [key, child] of Object.entries(record)) truncatedPaths(child, `${path}.${key}`, found);
  }
  return found;
}

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

  // S3: file accounting is exact, truncation is declared (and only on files),
  // paths are unique.
  if (p.files.value) {
    const { total, omitted, entries } = p.files.value;
    const truncatedFlag = p.files.availability === 'partial' && p.files.partial_reason === 'entries_truncated';
    if (total - entries.length !== omitted) broken.add('S3');
    if (omitted > 0 && !truncatedFlag) broken.add('S3');
    if (new Set(entries.map((e) => e.path_sha256)).size !== entries.length) broken.add('S3');
  }
  if (truncatedPaths(p, 'predicate').some((path) => path !== 'predicate.files')) broken.add('S3');

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

  // S5: every timestamp is a real instant, and nothing TrackAI itself observed
  // is later than as_of. (Commit, merge and deployment times come from other
  // clocks and are not compared.)
  for (const t of timestamps(p)) {
    const time = Date.parse(t);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== t) broken.add('S5');
  }
  const observed = [p.first_seen.value?.at, p.source_evidence.provider_delivery.value?.received_at];
  if (observed.some((t) => t !== undefined && t > p.as_of)) broken.add('S5');

  // S6: each earlier statement is listed once.
  if (new Set(p.previous.map((x) => x.digest)).size !== p.previous.length) broken.add('S6');

  // S7: the note digest comes from the same metric event as the observation.
  const metricId = p.source_evidence.metric_event.value?.id;
  const noteSource = p.source_evidence.note_digest.value?.source_event_id;
  if (noteSource !== undefined && noteSource !== metricId) broken.add('S7');

  // S8: model keys follow Task2's rule (tool::model, "unknown" for a missing
  // model, which is null, never the string "unknown"); each (model_key,
  // session) and each session is listed once; model rows name listed sessions.
  const sessions = p.sessions.value ?? [];
  const sessionIds = new Set(sessions.map((s) => s.session_id));
  if (sessionIds.size !== sessions.length) broken.add('S8');
  const modelRows = new Set<string>();
  for (const m of p.models.value ?? []) {
    if (m.model === 'unknown' || m.model_key !== `${m.tool}::${m.model ?? 'unknown'}`) broken.add('S8');
    const rowKey = `${m.model_key}\u0000${m.session_id ?? ''}`;
    if (modelRows.has(rowKey)) broken.add('S8');
    modelRows.add(rowKey);
    if (m.session_id !== null && p.sessions.value && !sessionIds.has(m.session_id)) broken.add('S8');
  }

  // S9: commit line totals agree with the file entries (Task2 sets them to the
  // file sums when the note has files, service.ts:770-773) and unknown is
  // max(0, added - ai - human) (service.ts:774).
  if (p.lines.value) {
    const { ai, human, unknown, added } = p.lines.value;
    if (unknown !== Math.max(0, added - ai - human)) broken.add('S9');
    if (p.files.value && p.files.value.entries.length > 0) {
      const fileAi = sum(p.files.value.entries.map((e) => e.ai_lines));
      const fileHuman = sum(p.files.value.entries.map((e) => e.human_lines));
      const complete = p.files.value.omitted === 0;
      if (complete ? fileAi !== ai || fileHuman !== human : fileAi > ai || fileHuman > human) broken.add('S9');
    }
  }

  // S10: finding totals agree with their breakdowns.
  if (p.security_findings_observed.value) {
    const { total, by_category: byCategory, by_severity: bySeverity } = p.security_findings_observed.value;
    if (sum(Object.values(byCategory)) !== total || sum(Object.values(bySeverity)) !== total) broken.add('S10');
  }

  // S11: merge lineage of a pr_merged statement ends at its subject (rebase
  // merges produce one new commit per source, so only they may differ), and
  // each source commit is listed once.
  if (p.merge_lineage.value) {
    const entries = p.merge_lineage.value;
    if (new Set(entries.map((e) => e.source_sha)).size !== entries.length) broken.add('S11');
    if (p.statement_kind === 'pr_merged'
      && entries.some((e) => e.merge_method !== 'rebase_merge' && e.result_sha !== p.commit.sha)) {
      broken.add('S11');
    }
  }

  // S12: one provider: every provider field equals repository.provider.
  const providers = [
    p.source_evidence.provider_delivery.value?.provider,
    p.pull_request.value?.provider,
    p.deployment.value?.provider,
  ];
  if (providers.some((value) => value !== undefined && value !== p.repository.provider)) broken.add('S12');

  return [...broken].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
