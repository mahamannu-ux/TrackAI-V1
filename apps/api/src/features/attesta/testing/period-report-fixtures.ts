/**
 * Synthetic, schema-valid ai-provenance statements for the period-report tests (Task15i4).
 * Each starts from a frozen valid contract fixture and changes only the identity and the
 * fields a figure reads, keeping S1–S12 true (lines.unknown, tools, sessions). No customer data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, sha256Prefixed } from '../canonical';
import type { LineCounts, ReportInput } from '../period-report-rules';
import type { ReportAuditInput, ReportJob, ReportRequest, ReportSnapshot, ReportStore } from '../period-report-service';
import { storedScopeOf } from '../period-report-service';


const FIXTURES = join(__dirname, '../../../../../../docs/contracts/attesta/fixtures');
const base = (kind: string) => JSON.parse(readFileSync(join(FIXTURES, `valid-${kind.replace('_', '-')}.json`), 'utf8')) as Record<string, any>;

export type Avail<T> = { availability: 'recorded'; value: T } | { availability: 'partial'; value: T } | { availability: 'unavailable' };

export interface ReportStatementOptions {
  kind: 'commit_observed' | 'pr_merged' | 'deployed';
  repositoryId: string;
  sha: string;
  asOf: string;
  /** ai, human, added, deleted (unknown is computed as Task2 does, S9); or unavailable. */
  lines?: Omit<LineCounts, 'unknown'> | null;
  /** pr_merged: merged lifecycle ai_lines; null = unavailable. */
  mergedAiLines?: number | null;
  /** [tool, model|null, ai_lines] rows; null = unavailable. */
  models?: Array<[string, string | null, number]> | null;
  pullRequestId?: string;
  deploymentId?: string;
  previous?: Array<{ digest: string; statement_kind: string }>;
}

const SESSION = (i: number) => `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`;

/** The canonical bytes of one valid statement. */
export function reportStatement(o: ReportStatementOptions): string {
  const s = base(o.kind);
  const p = s.predicate;
  s.subject = [{ name: `trackai:repository/${o.repositoryId}/commit/${o.sha}`, digest: { gitCommit: o.sha } }];
  p.as_of = o.asOf;
  p.previous = o.previous ?? [];
  p.repository.id = o.repositoryId;
  p.commit.sha = o.sha;
  if (o.kind === 'commit_observed') {
    p.files = { availability: 'unavailable', reason: 'not_reported_by_source' };
    p.first_seen.value.at = o.asOf;
    p.source_evidence.metric_event.value.event_at = o.asOf;
  }
  if (o.lines === null) p.lines = { availability: 'unavailable', reason: 'source_missing' };
  else if (o.lines) {
    const l = o.lines;
    p.lines = { availability: 'recorded', value: { ...l, unknown: Math.max(0, l.added - l.ai - l.human) } };
  }
  if (o.models !== undefined) {
    if (o.models === null) {
      p.models = { availability: 'unavailable', reason: 'source_missing' };
      p.sessions = { availability: 'unavailable', reason: 'source_missing' };
      p.tools = { availability: 'unavailable', reason: 'source_missing' };
    } else {
      const tools = [...new Set(o.models.map(([t]) => t))].sort();
      const sessionOf = (t: string) => SESSION(tools.indexOf(t));
      p.sessions = { availability: 'recorded', value: tools.map((t) => ({
        session_id: sessionOf(t), tool: t, ai_lines: o.models!.filter(([x]) => x === t).reduce((n, [, , a]) => n + a, 0) })) };
      p.models = { availability: 'recorded', value: o.models.map(([tool, model, ai]) => ({
        tool, model, model_key: `${tool}::${model ?? 'unknown'}`, ai_lines: ai, session_id: sessionOf(tool) })) };
      p.tools = { availability: 'recorded', value: tools };
    }
  }
  if (o.kind !== 'commit_observed') {
    if (p.pull_request.availability !== 'unavailable') {
      p.pull_request.value.merge_commit_sha = o.sha;
      if (o.pullRequestId) p.pull_request.value.id = o.pullRequestId;
    }
    p.merge_lineage.value = p.merge_lineage.value.map((m: Record<string, unknown>) => ({ ...m, result_sha: o.sha }));
    p.first_seen.value.at = o.asOf;
    p.source_evidence.provider_delivery.value.received_at = o.asOf;
  }
  if (o.kind === 'pr_merged') {
    p.pull_request.value.merged_at = o.asOf;
    if (o.mergedAiLines === null) p.lifecycle = { availability: 'unavailable', reason: 'source_missing' };
    else if (o.mergedAiLines !== undefined) {
      p.lifecycle = { availability: 'recorded', value: { stage: 'merged', ai_lines: o.mergedAiLines,
        calculation_version: { availability: 'unavailable', reason: 'not_captured_yet' } } };
    }
  }
  if (o.kind === 'deployed') {
    p.deployment.value.sha = o.sha;
    p.deployment.value.deployed_at = o.asOf;
    if (o.deploymentId) p.deployment.value.id = o.deploymentId;
    p.pull_request = { availability: 'unavailable', reason: 'source_missing' };
  }
  return canonicalize(s);
}

/** A stored input at `seq`. */
export function input(seq: number, canonical: string): ReportInput {
  return { seq, digest: sha256Prefixed(canonical), canonical };
}

// ---------------------------------------------------------------------------
// A memory report store for the route tests (tenant-bound like the pg store).


export class MemoryReportStore implements ReportStore {
  jobs: ReportJob[] = [];
  documents = new Map<string, string>();
  audits: ReportAuditInput[] = [];
  /** tenant → repository ids */
  repositories = new Map<string, Set<string>>();
  inputs = 0;
  failAudit = false;
  private n = 0;
  async createOrGet(i: { tenantId: string; idempotencyKey: string; request: ReportRequest; requestedBy: string; requestId: string }) {
    const existing = this.jobs.find((j) => j.tenantId === i.tenantId && j.idempotencyKey === i.idempotencyKey);
    if (existing) return { job: { ...existing }, created: false };
    this.n += 1;
    const job: ReportJob = {
      id: `44444444-0000-4000-8000-${String(this.n).padStart(12, '0')}`, tenantId: i.tenantId, idempotencyKey: i.idempotencyKey,
      repositoryId: i.request.scope.repository_id, scope: storedScopeOf(i.request.scope), status: 'queued', requestedBy: i.requestedBy,
      requestId: i.requestId, attempts: 0, reportDigest: null, statementDigest: null, recordId: null, errorCode: null,
      createdAt: '2026-10-13T12:00:00.000Z', finishedAt: null,
    };
    this.jobs.push(job);
    return { job: { ...job }, created: true };
  }
  async get(tenantId: string, id: string) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.id === id);
    return j ? { ...j } : null;
  }
  async findByKey(tenantId: string, key: string) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.idempotencyKey === key);
    return j ? { ...j } : null;
  }
  async document(tenantId: string, id: string) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.id === id && x.status === 'ready');
    return j ? this.documents.get(id) ?? null : null;
  }
  async openCount(tenantId: string) { return this.jobs.filter((j) => j.tenantId === tenantId && (j.status === 'queued' || j.status === 'running')).length; }
  async repositoryExists(tenantId: string, repositoryId: string) { return this.repositories.get(tenantId)?.has(repositoryId) ?? false; }
  async inputCount() { return this.inputs; }
  async claim() { return null; }
  async readSnapshot(): Promise<ReportSnapshot> { throw new Error('not in the route tests'); }
  async chainReady() { return null; }
  async finishFailed() { return false; }
  async runnable() { return []; }
  async audit(i: ReportAuditInput) {
    if (this.failAudit) throw new Error('audit down');
    this.audits.push(i);
  }
  /** Marks a job ready with a document (what chainReady does in the database). */
  markReady(id: string, document: string) {
    const j = this.jobs.find((x) => x.id === id)!;
    Object.assign(j, { status: 'ready', reportDigest: sha256Prefixed(document), statementDigest: 'sha256:' + 'd'.repeat(64),
      recordId: '55555555-0000-4000-8000-000000000005', finishedAt: '2026-10-13T12:01:00.000Z' });
    this.documents.set(id, document);
  }
}
