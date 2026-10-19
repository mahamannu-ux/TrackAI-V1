/**
 * Task16h (A16.13a + A16.13b): the auditor's verifiable and signed answers, with no
 * database. The statements are real, schema-valid ai-provenance statements
 * (Task15i4's fixtures), the documents come from Attesta's own builders
 * (computeReportDocument, buildSecuritySealDocument, computeSecurityReportDocument),
 * and every envelope goes through Task19's validator (checkEnvelope). Only the
 * row reads are in-memory (the answerers' CodeSource / SealSource / SignedSource seams).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalize, sha256Prefixed } from '../../attesta/canonical';
import {
  AI_PROVENANCE_TYPE, computeReportDocument, digestsRoot, type ReportInput, type ReportScope,
} from '../../attesta/period-report-rules';
import { reportStatement, type ReportStatementOptions } from '../../attesta/testing/period-report-fixtures';
import {
  buildSecuritySealDocument, compareSecurityRows, type SecurityFindingRow,
} from '../../attesta/security-seal-service';
import { computeSecurityReportDocument, reportRowOf } from '../../attesta/security-report-rules';
import type { ChainReport } from '../../attesta/verify-chain';
import { createAnswererRegistry } from '../answerers';
import { checkEnvelope } from '../envelope';
import { QA_QUESTIONS_BY_ID } from '../registry';
import { QaProblem, answerQuestion, previousPeriod, type QaScopeStore } from '../service';
import { QA_PERSON_WORDS, type QaAnswerContext, type QaAnswerer, type QaDimension, type QaEnvelope, type QaKind, type QaQuestionId, type QaScope } from '../types';
import {
  codeVerifiableAnswerers, type CodeSource, type ReadWindow, type StoredStatement,
} from './code-verifiable';
import { MAX_EVIDENCE_RECORDS, evidenceOf } from './evidence';
import { AUDITOR_ANSWERERS, registerAuditorAnswerers } from './register-auditor';
import { securityVerifiableAnswerers, type AuditShape, type SealSource } from './security-verifiable';
import { signedAnswerers, type SignedSource, type StoredReport } from './signed';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const R1 = '0c000000-0000-4000-8000-000000000001';
const R2 = '0c000000-0000-4000-8000-000000000002';
const PR = '0d000000-0000-4000-8000-000000000001';
const sha = (n: number) => n.toString(16).padStart(40, 'a');

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-10-10T00:00:00.000Z';
const NOW = '2026-10-19T12:00:00.000Z';
const us = (ms: string) => `${ms.slice(0, 23)}000Z`;

function ctxOf(questionId: QaQuestionId, kind: QaKind, scope: Partial<QaScope> = {}, over: Partial<QaAnswerContext> = {}): QaAnswerContext {
  const full: QaScope = { from: FROM, to: TO, ...scope };
  const scopeLevel = full.commit_sha ? 'commit' : full.pull_request_id ? 'pull_request' : full.repository_id ? 'repository' : 'tenant';
  return { tenantId: A, questionId, kind, role: 'tenant_auditor', scopeLevel, scope: full, breakdown: null, now: NOW, ...over };
}

/** Task19's validator with the request's expectation, plus the evidence and honesty rules of item 1. */
function valid(envelope: QaEnvelope, ctx: QaAnswerContext): QaEnvelope {
  assert.deepEqual(checkEnvelope(envelope, { questionId: ctx.questionId, kind: ctx.kind, scope: ctx.scope, breakdown: ctx.breakdown }),
    { ok: true, path: null }, `${ctx.questionId}/${ctx.kind}`);
  const figures = [...envelope.figures, ...(envelope.previous?.figures ?? [])];
  for (const f of figures) {
    if (f.availability === 'unavailable') {
      assert.equal(f.value, null, `${f.key}: unavailable is null, never 0`);
      assert.equal(f.evidence, undefined);
    } else {
      assert.ok(f.evidence, `${f.key}: a recorded or partial figure carries evidence`);
      assert.equal(f.evidence.statements_root, digestsRoot(f.evidence.records.map((r) => r.digest)), `${f.key}: the root recomputes`);
      assert.equal(f.evidence.count, f.evidence.records.length);
      assert.ok(f.evidence.records.every((r, i) => i === 0 || f.evidence!.records[i - 1].seq < r.seq), `${f.key}: seq order`);
    }
    for (const word of QA_PERSON_WORDS) assert.ok(!f.key.includes(word), `${f.key}: no person`);
    for (const item of f.breakdown ?? []) for (const word of QA_PERSON_WORDS) assert.ok(!item.dimension.includes(word));
  }
  if (ctx.kind === 'verifiable') assert.equal(envelope.signed, undefined);
  return envelope;
}

const fig = (e: QaEnvelope, key: string) => {
  const f = e.figures.find((x) => x.key === key);
  assert.ok(f, key);
  return f;
};
const countOf = (e: QaEnvelope, key: string) => {
  const v = fig(e, key).value;
  return v?.type === 'count' ? v.count : null;
};

// ---------------------------------------------------------------------------
// An in-memory ledger behind the CodeSource seam (tenant-bound like the pg reads)

interface MemRecord extends StoredStatement { tenantId: string; predicateType: string }

class MemoryLedger implements CodeSource {
  records: MemRecord[] = [];
  merges = new Map<string, string>();
  private seq = 0;
  add(tenantId: string, recordedAtMs: string, o: ReportStatementOptions): MemRecord {
    const canonical = reportStatement(o);
    const rec: MemRecord = {
      tenantId, predicateType: AI_PROVENANCE_TYPE, seq: this.seq++, digest: sha256Prefixed(canonical), recordedAt: us(recordedAtMs),
      kind: o.kind, repositoryId: o.repositoryId, subjectSha: o.sha, canonical,
    };
    this.records.push(rec);
    return rec;
  }
  private inWindow(r: MemRecord, tenantId: string, from: string, to: string) {
    return r.tenantId === tenantId && r.recordedAt >= us(from) && r.recordedAt <= us(to);
  }
  private matches(r: MemRecord, w: ReadWindow) {
    return (!w.repositoryId || r.repositoryId === w.repositoryId)
      && (!w.subjectSha || w.subjectSha.includes(r.subjectSha ?? ''))
      && (!w.kind || r.kind === w.kind);
  }
  async reportInputs(tenantId: string, scope: ReportScope): Promise<ReportInput[]> {
    return this.records.filter((r) => this.inWindow(r, tenantId, scope.from, scope.to) && r.repositoryId === scope.repository_id)
      .map((r) => ({ seq: r.seq, digest: r.digest, canonical: r.canonical }));
  }
  async repositoriesWithStatements(tenantId: string, from: string, to: string, limit: number) {
    return [...new Set(this.records.filter((r) => this.inWindow(r, tenantId, from, to)).map((r) => r.repositoryId as string))].sort().slice(0, limit);
  }
  async mergeSha(tenantId: string, pullRequestId: string) { return tenantId === A ? this.merges.get(pullRequestId) ?? null : null; }
  async statements(tenantId: string, w: ReadWindow, from: string, to: string, limit: number) {
    return this.records.filter((r) => this.inWindow(r, tenantId, from, to) && this.matches(r, w)).slice(0, limit);
  }
  async newestRecordedAt(tenantId: string, w: ReadWindow, from: string, to: string) {
    const rows = this.records.filter((r) => this.inWindow(r, tenantId, from, to) && this.matches(r, w));
    return rows.length === 0 ? null : rows.map((r) => r.recordedAt).sort().at(-1) as string;
  }
  async seqRange(tenantId: string, from: string, to: string) {
    const seqs = this.records.filter((r) => this.inWindow(r, tenantId, from, to)).map((r) => r.seq);
    return seqs.length === 0 ? null : { fromSeq: Math.min(...seqs), toSeq: Math.max(...seqs) };
  }
  async seqRows(tenantId: string, fromSeq: number, toSeq: number) {
    return this.records.filter((r) => r.tenantId === tenantId && r.seq >= fromSeq && r.seq <= toSeq).map((r) => ({ seq: r.seq, digest: r.digest }));
  }
  breaks = 0;
  async verify(ctx: QaAnswerContext, fromSeq: number, toSeq: number): Promise<ChainReport> {
    const checked = this.records.filter((r) => r.tenantId === ctx.tenantId && r.seq >= fromSeq && r.seq <= toSeq).length;
    return {
      report_version: 1 as ChainReport['report_version'], tenant_id: ctx.tenantId, range: { from_seq: fromSeq, to_seq: toSeq },
      checked, ok: this.breaks === 0, chain_intact: this.breaks === 0,
      breaks: Array.from({ length: this.breaks }, (_, i) => ({ seq: fromSeq + i, kind: 'record_hash_mismatch' } as unknown as ChainReport['breaks'][number])),
      breaks_truncated: false, head: null, signatures: 'checked', warnings: [], anchors: { status: 'checked' } as unknown as ChainReport['anchors'],
    };
  }
}

/** Repository R1: one commit seen twice (the later statement supersedes), one merged PR, one deployment; R2: one commit. */
function codeWorld(): MemoryLedger {
  const m = new MemoryLedger();
  m.add(A, '2026-10-02T10:00:00.000Z', { kind: 'commit_observed', repositoryId: R1, sha: sha(1), asOf: '2026-10-02T10:00:00.000Z',
    lines: { ai: 50, human: 10, added: 70, deleted: 0 }, models: [['claude-code', 'claude-x', 50]] });
  m.add(A, '2026-10-03T10:00:00.000Z', { kind: 'commit_observed', repositoryId: R1, sha: sha(1), asOf: '2026-10-03T10:00:00.000Z',
    lines: { ai: 40, human: 20, added: 70, deleted: 0 }, models: [['claude-code', 'claude-x', 40]] });
  m.add(A, '2026-10-04T10:00:00.000Z', { kind: 'pr_merged', repositoryId: R1, sha: sha(2), asOf: '2026-10-04T10:00:00.000Z',
    pullRequestId: PR, mergedAiLines: 40, models: [['claude-code', 'claude-x', 30], ['cursor', null, 10]], lines: { ai: 40, human: 20, added: 70, deleted: 0 } });
  m.add(A, '2026-10-05T10:00:00.000Z', { kind: 'deployed', repositoryId: R1, sha: sha(2), asOf: '2026-10-05T10:00:00.000Z', deploymentId: 'deploy-1' });
  m.add(A, '2026-10-06T10:00:00.000Z', { kind: 'commit_observed', repositoryId: R2, sha: sha(3), asOf: '2026-10-06T10:00:00.000Z',
    lines: { ai: 5, human: 5, added: 10, deleted: 0 }, models: [['cursor', 'gpt-x', 5]] });
  m.merges.set(PR, sha(2));
  return m;
}

describe('Task16h verifiable code answers', () => {
  const m = codeWorld();
  const answers = codeVerifiableAnswerers(m);

  test('Q1, Q3, Q9, Q13 at repository scope equal the period report computation, with matching evidence', async () => {
    const scope: ReportScope = { repository_id: R1, from: FROM, to: TO, basis: 'recorded_at' };
    const doc = computeReportDocument({ tenantId: A, scope, inputs: await m.reportInputs(A, scope) });
    const q3 = valid(await answers.Q3(ctxOf('Q3', 'verifiable', { repository_id: R1 })), ctxOf('Q3', 'verifiable', { repository_id: R1 }));
    assert.equal(q3.availability, 'recorded');
    assert.equal(countOf(q3, 'prs_merged'), doc.figures.prs_merged.value);
    assert.equal(countOf(q3, 'merged_ai_lines'), doc.figures.merged_ai_lines.value);
    assert.equal(fig(q3, 'prs_merged').evidence?.statements_root, doc.figures.prs_merged.statements_root, 'the same root Attesta signs');
    const q1ctx = ctxOf('Q1', 'verifiable', { repository_id: R1 });
    const q1 = valid(await answers.Q1(q1ctx), q1ctx);
    // One statement per subject: the superseded 50-line statement is not counted.
    assert.equal(countOf(q1, 'ai_lines_changed'), (doc.figures.lines_changed.value as { ai: number }).ai);
    assert.equal(fig(q1, 'ai_share_of_repository').availability, 'unavailable');
    assert.deepEqual(fig(q1, 'ai_share_of_repository').reasons, [{ code: 'not_captured_yet', gap: 'G1' }]);
    for (const q of ['Q9', 'Q13'] as const) {
      const ctx = ctxOf(q, 'verifiable', { repository_id: R1 });
      valid(await answers[q](ctx), ctx);
    }
    assert.equal(q1.as_of, '2026-10-05T10:00:00.000Z', 'as_of is the newest input record');
  });

  test('Q3 model and tool breakdowns are the merged AI lines by model key and by tool', async () => {
    const ctx = ctxOf('Q3', 'verifiable', { repository_id: R1 }, { breakdown: 'tool' });
    const e = valid(await answers.Q3(ctx), ctx);
    assert.deepEqual(fig(e, 'merged_ai_lines').breakdown?.map((b) => [b.key, b.value]), [
      ['claude-code', { type: 'count', count: 30 }], ['cursor', { type: 'count', count: 10 }],
    ]);
  });

  test('tenant scope sums the repositories and unions their evidence', async () => {
    const ctx = ctxOf('Q1', 'verifiable');
    const e = valid(await answers.Q1(ctx), ctx);
    const r1 = await answers.Q1(ctxOf('Q1', 'verifiable', { repository_id: R1 }));
    const r2 = await answers.Q1(ctxOf('Q1', 'verifiable', { repository_id: R2 }));
    assert.equal(countOf(e, 'ai_lines_changed'), (countOf(r1, 'ai_lines_changed') ?? 0) + (countOf(r2, 'ai_lines_changed') ?? 0));
    assert.equal(fig(e, 'ai_lines_changed').evidence?.count,
      (fig(r1, 'ai_lines_changed').evidence?.count ?? 0) + (fig(r2, 'ai_lines_changed').evidence?.count ?? 0));
  });

  test('a period whose end is not settled counts the settled part (partial, not_sealed_yet); a wholly unsettled one is unavailable', async () => {
    const recent = ctxOf('Q3', 'verifiable', { repository_id: R1, from: FROM, to: NOW });
    const e = valid(await answers.Q3(recent), recent);
    assert.equal(e.availability, 'partial');
    assert.ok(fig(e, 'prs_merged').reasons.some((r) => r.code === 'not_sealed_yet'));
    const tiny = ctxOf('Q9', 'verifiable', { repository_id: R1, from: '2026-10-19T11:59:00.000Z', to: NOW });
    const u = valid(await answers.Q9(tiny), tiny);
    assert.equal(u.availability, 'unavailable');
    assert.deepEqual(u.reasons, [{ code: 'not_sealed_yet' }]);
  });

  test('no statement in the window: unavailable with null values, as_of is the query time', async () => {
    const empty = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };
    for (const q of ['Q1', 'Q3', 'Q4', 'Q7', 'Q9', 'Q11', 'Q13', 'Q16'] as const) {
      const ctx = ctxOf(q, 'verifiable', { repository_id: R1, ...empty });
      const e = valid(await answers[q](ctx), ctx);
      assert.ok(e.figures.every((f) => f.availability === 'unavailable'), q);
    }
  });

  test('the direct answers (Q4, Q7, Q8, Q11, Q14, Q16) validate and read stored statements only', async () => {
    const q4 = ctxOf('Q4', 'verifiable', { repository_id: R1 }, { breakdown: 'model' });
    const e4 = valid(await answers.Q4(q4), q4);
    assert.equal(countOf(e4, 'commits_by_model'), 1, 'one commit (the latest statement per subject)');
    assert.deepEqual(fig(e4, 'approved_at_the_time').reasons, [{ code: 'not_captured_yet', gap: 'G2' }]);
    const q7 = ctxOf('Q7', 'verifiable');
    const e7 = valid(await answers.Q7(q7), q7);
    assert.equal(countOf(e7, 'statements_checked'), 5);
    assert.equal(countOf(e7, 'breaks'), 0);
    const q8 = ctxOf('Q8', 'verifiable', { repository_id: R1, commit_sha: sha(1) });
    const e8 = valid(await answers.Q8(q8), q8);
    assert.equal(countOf(e8, 'statements'), 2);
    const q11 = ctxOf('Q11', 'verifiable', { repository_id: R1 });
    const e11 = valid(await answers.Q11(q11), q11);
    if (e11.figures[0].availability !== 'unavailable') assert.ok(e11.figures[0].reasons.some((r) => r.code === 'partial_linkage'));
    const q14 = ctxOf('Q14', 'verifiable', { repository_id: R1, pull_request_id: PR });
    const e14 = valid(await answers.Q14(q14), q14);
    assert.equal(countOf(e14, 'pr_merged_statements'), 1);
    const q16 = ctxOf('Q16', 'verifiable', { repository_id: R1 });
    assert.equal(countOf(valid(await answers.Q16(q16), q16), 'statements_in_scope'), 4);
  });

  test('Q7: breaks are the honest answer, still recorded', async () => {
    const broken = codeWorld();
    broken.breaks = 2;
    const ctx = ctxOf('Q7', 'verifiable');
    const e = valid(await codeVerifiableAnswerers(broken).Q7(ctx), ctx);
    assert.equal(countOf(e, 'breaks'), 2);
    assert.equal(fig(e, 'breaks').availability, 'recorded');
  });

  test('an unmerged pull request counts nothing of its repository', async () => {
    const ctx = ctxOf('Q11', 'verifiable', { repository_id: R1, pull_request_id: '0d000000-0000-4000-8000-0000000000ff' });
    const e = valid(await answers.Q11(ctx), ctx);
    assert.equal(e.availability, 'unavailable');
    const q9 = ctxOf('Q9', 'verifiable', { repository_id: R1, pull_request_id: '0d000000-0000-4000-8000-0000000000ff' });
    assert.equal(valid(await answers.Q9(q9), q9).availability, 'unavailable');
  });

  test('Company B sees none of Company A\'s statements', async () => {
    for (const q of ['Q1', 'Q3', 'Q16'] as const) {
      const ctx = ctxOf(q, 'verifiable', {}, { tenantId: B });
      const e = valid(await answers[q](ctx), ctx);
      assert.ok(e.figures.every((f) => f.availability === 'unavailable' && f.evidence === undefined), q);
    }
  });
});

// ---------------------------------------------------------------------------
// Security: real seal documents over in-memory rows

const MACHINE = '0a000000-0000-4000-8000-000000000001';
const rid = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const W1 = { from: '2026-10-01T00:00:00.000000Z', to: '2026-10-05T00:00:00.000000Z' };
const W2 = { from: '2026-10-05T00:00:00.000000Z', to: '2026-10-10T00:00:00.000000Z' };
const SEAL_DIGEST_SEQ = (n: number) => 1000 + n;

function row(n: number, receivedAt: string, over: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    id: rid(n), record_generation: 'task6a', machine_id: MACHINE, repository_id: R1, repository_kind: null,
    rule_id: 'trackai.exec.reverse_shell', rule_version: '1', rule_category: 'execution', rule_severity: 'critical', effect: 'monitor',
    agent_family: 'opencode', source_agent: null, source_type: null, model: null, model_provider: null, session_id: 'sess-1',
    parent_session_id: null, sub_agent_id: null, record_id: null, finding_id: `finding-${n}`, delivery_id: `delivery-${n}`,
    source_event_id: 'event-1', correlation_id: null, occurred_at: receivedAt, received_at: receivedAt, detected_at: null,
    rule_pack_version: 'task6a-1', bundle_digest: null, lease_id: null, numbat_schema_version: null, confidence: null,
    found_at_rest: null, route_id: 'AC-CLI-03', host_surface: 'terminal', host_mode: 'cli', capture_channel: 'provider-plugin',
    native_effect: 'observe_only', activation: 'observed', phase: 'requested', timing: 'pre_action', availability: 'available',
    completeness: 'complete', result_category: 'not_observed', operating_system: 'macos', client_version: '0.1.0', ...over,
  };
}

const ROWS = [
  row(1, '2026-10-02T01:00:00.000000Z'),
  row(2, '2026-10-03T01:00:00.000000Z', { rule_severity: 'low', phase: 'observed_result' }),
  row(3, '2026-10-06T01:00:00.000000Z', { rule_severity: 'high' }),
];

interface MemSeal { tenantId: string; window: { from: string; to: string }; text: string; digest: string; rowCount: number; task6a: number; v2: number; previous: string | null; seq: number; statementDigest: string }

class MemorySeals implements SealSource {
  rows: Array<SecurityFindingRow & { tenantId: string }> = [];
  seals: MemSeal[] = [];
  audit: AuditShape = { kind: 'no_seals', seals: [], rows: [], partial: false, truncated: false, newestAt: null };
  seal(tenantId: string, window: { from: string; to: string }) {
    const inside = this.rows.filter((r) => r.tenantId === tenantId && r.received_at >= window.from && r.received_at < window.to)
      .map(({ tenantId: _t, ...r }) => r).sort(compareSecurityRows);
    const previous = this.seals.filter((s) => s.tenantId === tenantId).at(-1)?.digest ?? null;
    const built = buildSecuritySealDocument({ tenantId, window, previous, rows: inside });
    const n = this.seals.length;
    this.seals.push({ tenantId, window, text: built.text, digest: built.digest, rowCount: built.document.count,
      task6a: built.document.generations.task6a, v2: built.document.generations.v2, previous,
      seq: SEAL_DIGEST_SEQ(n), statementDigest: sha256Prefixed(`seal-statement-${n}`) });
  }
  async findingSeals(tenantId: string, from: string, to: string, limit: number) {
    return this.seals.filter((s) => s.tenantId === tenantId && s.window.from < us(to) && s.window.to > us(from))
      .slice(0, limit).map((s) => ({
        window_from: s.window.from, window_to: s.window.to, row_count: s.rowCount, task6a_count: s.task6a, v2_count: s.v2,
        previous_digest: s.previous, seal_document: s.text, seal_digest: s.digest, statement_digest: s.statementDigest,
        record_id: rid(9000 + s.seq), seq: String(s.seq),
      }));
  }
  async findingRows(tenantId: string, windowFrom: string, windowTo: string, limit: number) {
    return this.rows.filter((r) => r.tenantId === tenantId && r.received_at >= windowFrom && r.received_at < windowTo)
      .map(({ tenantId: _t, ...r }) => r).sort(compareSecurityRows).slice(0, limit);
  }
  async auditPeriod() { return this.audit; }
}

function sealWorld(): MemorySeals {
  const m = new MemorySeals();
  m.rows.push(...ROWS.map((r) => ({ ...r, tenantId: A })));
  m.seal(A, W1);
  m.seal(A, W2);
  return m;
}

describe('Task16h verifiable security answers', () => {
  test('S1 counts the sealed high and critical findings, with the covering seals as evidence', async () => {
    const m = sealWorld();
    const ctx = ctxOf('S1', 'verifiable', {}, { breakdown: 'severity' });
    const e = valid(await securityVerifiableAnswerers(m).S1(ctx), ctx);
    assert.equal(countOf(e, 'high_or_critical_findings'), 2);
    assert.deepEqual(fig(e, 'high_or_critical_findings').evidence?.records.map((r) => r.seq), [SEAL_DIGEST_SEQ(0), SEAL_DIGEST_SEQ(1)]);
    assert.ok(e.wording.includes('monitor_only_observed'));
  });

  test('every registered security verifiable answer validates (S7 with its previous period, S8–S12, S15)', async () => {
    const m = sealWorld();
    m.audit = { kind: 'ok', seals: [{ recordId: rid(1), statementDigest: sha256Prefixed('audit-seal'), windowFrom: W1.from, windowTo: W2.to, seq: 7 }],
      rows: [], partial: false, truncated: false, newestAt: '2026-10-09T00:00:00.000000Z' };
    const s = securityVerifiableAnswerers(m);
    for (const q of ['S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S15'] as const) {
      const ctx = ctxOf(q, 'verifiable');
      const e = valid(await s[q](ctx), ctx);
      assert.notEqual(e.availability, 'unavailable', q);
    }
    const s12 = valid(await s.S12(ctxOf('S12', 'verifiable')), ctxOf('S12', 'verifiable'));
    assert.equal(fig(s12, 'blocked').value, null, 'never "blocked", never a zero from nothing');
    assert.equal(fig(s12, 'denied_by_request').value, null);
  });

  test('a tampered row (changed, deleted or added inside a sealed window) makes the whole answer evidence_broken', async () => {
    for (const tamper of ['change', 'delete', 'add'] as const) {
      const m = sealWorld();
      if (tamper === 'change') m.rows[0] = { ...m.rows[0], rule_severity: 'low' };
      if (tamper === 'delete') m.rows.splice(0, 1);
      if (tamper === 'add') m.rows.push({ ...row(9, '2026-10-02T05:00:00.000000Z'), tenantId: A });
      const ctx = ctxOf('S1', 'verifiable');
      const e = valid(await securityVerifiableAnswerers(m).S1(ctx), ctx);
      assert.equal(e.availability, 'unavailable', tamper);
      assert.deepEqual(e.reasons, [{ code: 'evidence_broken' }], tamper);
    }
  });

  test('a period past the last seal is partial with not_sealed_yet; a period with no seal is unavailable', async () => {
    const m = new MemorySeals();
    m.rows.push(...ROWS.map((r) => ({ ...r, tenantId: A })));
    m.seal(A, W1);
    const ctx = ctxOf('S8', 'verifiable');
    const e = valid(await securityVerifiableAnswerers(m).S8(ctx), ctx);
    assert.equal(e.availability, 'partial');
    assert.ok(fig(e, 'findings').reasons.some((r) => r.code === 'not_sealed_yet'));
    assert.equal(countOf(e, 'findings'), 2, 'only sealed rows count');
    const none = ctxOf('S8', 'verifiable', { from: '2026-09-01T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' });
    const u = valid(await securityVerifiableAnswerers(m).S8(none), none);
    assert.equal(u.availability, 'unavailable');
    assert.deepEqual(u.reasons, [{ code: 'not_sealed_yet' }]);
  });

  test('Company B sees none of Company A\'s seals or rows', async () => {
    const ctx = ctxOf('S1', 'verifiable', {}, { tenantId: B });
    const e = valid(await securityVerifiableAnswerers(sealWorld()).S1(ctx), ctx);
    assert.equal(e.availability, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Signed: stored documents from Attesta's builders

class MemoryReports implements SignedSource {
  code: Array<{ tenantId: string; repositoryId: string; from: string; to: string; stored: StoredReport }> = [];
  security: Array<{ tenantId: string; repositoryId: string | null; from: string; to: string; stored: StoredReport }> = [];
  async codeReport(tenantId: string, repositoryId: string, from: string, to: string) {
    return this.code.filter((r) => r.tenantId === tenantId && r.repositoryId === repositoryId && r.from === from && r.to === to).at(-1)?.stored ?? null;
  }
  async securityReport(tenantId: string, repositoryId: string | null, from: string, to: string) {
    return this.security.filter((r) => r.tenantId === tenantId && r.repositoryId === repositoryId && r.from === from && r.to === to).at(-1)?.stored ?? null;
  }
}

const storedOf = (doc: unknown, n: number): StoredReport => {
  const text = canonicalize(doc);
  return { document: text, documentDigest: sha256Prefixed(text), statementDigest: sha256Prefixed(`report-statement-${n}`), recordedAt: '2026-10-11T00:00:00.123456Z' };
};

function securityDoc(from: string, to: string) {
  const m = sealWorld();
  const seals = m.seals.filter((s) => s.window.from < us(to) && s.window.to > us(from))
    .map((s) => ({ seq: s.seq, statement_digest: s.statementDigest, seal_digest: s.digest, window: s.window }));
  const rows = ROWS.filter((r) => r.received_at >= us(from) && r.received_at < us(to)).map(reportRowOf);
  return computeSecurityReportDocument({
    tenantId: A, scope: { tenant_id: A, repository_id: null, from, to, basis: 'received_at' }, seals, rows, decisions: [], platforms: {},
  });
}

describe('Task16h signed answers', () => {
  test('code: the exact-scope report names its statement digest and maps its stored figures', async () => {
    const m = codeWorld();
    const scope: ReportScope = { repository_id: R1, from: FROM, to: TO, basis: 'recorded_at' };
    const doc = computeReportDocument({ tenantId: A, scope, inputs: await m.reportInputs(A, scope) });
    const reports = new MemoryReports();
    reports.code.push({ tenantId: A, repositoryId: R1, from: FROM, to: TO, stored: storedOf(doc, 1) });
    const signed = signedAnswerers(reports);
    const ctx = ctxOf('Q3', 'signed', { repository_id: R1 });
    const e = valid(await signed.code(ctx), ctx);
    assert.equal(e.signed?.statement_digest, sha256Prefixed('report-statement-1'));
    assert.equal(e.signed?.predicate_type, 'https://trackai.dev/attesta/period-report/v1');
    assert.equal(countOf(e, 'prs_merged'), doc.figures.prs_merged.value);
    assert.equal(fig(e, 'prs_merged').evidence?.statements_root, doc.figures.prs_merged.statements_root);
    assert.equal(e.as_of, '2026-10-11T00:00:00.123Z');
    for (const q of ['Q1', 'Q9', 'Q13'] as const) {
      const c = ctxOf(q, 'signed', { repository_id: R1 });
      valid(await signed.code(c), c);
    }
    // The verifiable answer over the same statements gives the same figures (item 3 = item 5 mapping).
    const v = await codeVerifiableAnswerers(m).Q3(ctxOf('Q3', 'verifiable', { repository_id: R1 }));
    assert.deepEqual(e.figures, v.figures);
  });

  test('code: another scope, the tenant scope, or another tenant gives report_not_built', async () => {
    const reports = new MemoryReports();
    const m = codeWorld();
    const scope: ReportScope = { repository_id: R1, from: FROM, to: TO, basis: 'recorded_at' };
    reports.code.push({ tenantId: A, repositoryId: R1, from: FROM, to: TO,
      stored: storedOf(computeReportDocument({ tenantId: A, scope, inputs: await m.reportInputs(A, scope) }), 1) });
    const signed = signedAnswerers(reports);
    for (const ctx of [
      ctxOf('Q3', 'signed', { repository_id: R1, from: '2026-10-02T00:00:00.000Z' }),
      ctxOf('Q3', 'signed'),
      ctxOf('Q3', 'signed', { repository_id: R1 }, { tenantId: B }),
    ]) {
      const e = valid(await signed.code(ctx), ctx);
      assert.equal(e.availability, 'unavailable');
      assert.deepEqual(e.reasons, [{ code: 'report_not_built' }]);
      assert.equal(e.signed, undefined);
    }
  });

  test('stored report bytes that no longer hash to their digest are evidence_broken', async () => {
    const reports = new MemoryReports();
    const doc = securityDoc(FROM, TO);
    const stored = storedOf(doc, 2);
    reports.security.push({ tenantId: A, repositoryId: null, from: FROM, to: TO, stored: { ...stored, document: stored.document.replace('"row_count":3', '"row_count":4') } });
    const ctx = ctxOf('S1', 'signed');
    const e = valid(await signedAnswerers(reports).security(ctx), ctx);
    assert.deepEqual(e.reasons, [{ code: 'evidence_broken' }]);
  });

  test('security: S1, S7 (with the previous period\'s own report), S8–S12 from the stored security report', async () => {
    const reports = new MemoryReports();
    reports.security.push({ tenantId: A, repositoryId: null, from: FROM, to: TO, stored: storedOf(securityDoc(FROM, TO), 2) });
    const signed = signedAnswerers(reports);
    const s1 = ctxOf('S1', 'signed');
    const e1 = valid(await signed.security(s1), s1);
    assert.equal(countOf(e1, 'high_or_critical_findings'), 2);
    assert.equal(e1.signed?.predicate_type, 'https://trackai.dev/attesta/security-period-report/v1');
    assert.deepEqual(fig(e1, 'high_or_critical_findings').evidence?.records.map((r) => r.seq), [SEAL_DIGEST_SEQ(0), SEAL_DIGEST_SEQ(1)]);
    const s7 = ctxOf('S7', 'signed', {}, { breakdown: 'severity' });
    const e7 = valid(await signed.security(s7), s7);
    assert.deepEqual(e7.previous?.figures[0].reasons, [{ code: 'report_not_built' }]);
    const prev = previousPeriod({ from: FROM, to: TO });
    reports.security.push({ tenantId: A, repositoryId: null, from: prev.from, to: prev.to, stored: storedOf(securityDoc(prev.from, prev.to), 3) });
    const again = valid(await signed.security(s7), s7);
    assert.equal(again.previous?.figures[0].availability, 'recorded');
    for (const q of ['S8', 'S9', 'S10', 'S11', 'S12'] as const) {
      const ctx = ctxOf(q, 'signed');
      valid(await signed.security(ctx), ctx);
    }
    const s11 = valid(await signed.security(ctxOf('S11', 'signed')), ctxOf('S11', 'signed'));
    assert.equal(countOf(s11, 'requested'), 2);
    assert.equal(countOf(s11, 'observed_result'), 1);
    const s12 = valid(await signed.security(ctxOf('S12', 'signed')), ctxOf('S12', 'signed'));
    assert.equal(fig(s12, 'blocked').value, null);
    assert.equal(countOf(s12, 'denied_by_request'), 0, 'a count of deny requests, from the report');
  });
});

// ---------------------------------------------------------------------------
// Registration and the service rules

describe('Task16h registration', () => {
  test('every auditor answerer registers once, for a verifiable or signed kind the registry offers, never live', () => {
    const registry = createAnswererRegistry();
    registerAuditorAnswerers(registry);
    for (const [q, kind] of AUDITOR_ANSWERERS) {
      assert.notEqual(kind, 'live');
      assert.ok(registry.get(q, kind), `${q}/${kind}`);
      assert.ok(QA_QUESTIONS_BY_ID.get(q)?.dimensions.every((d: QaDimension) => !QA_PERSON_WORDS.some((w) => d.includes(w))));
    }
    assert.equal(AUDITOR_ANSWERERS.filter(([, k]) => k === 'verifiable').length, 18);
    assert.equal(AUDITOR_ANSWERERS.filter(([, k]) => k === 'signed').length, 11);
    assert.throws(() => registerAuditorAnswerers(registry), /already has an answerer/);
  });

  test('kind=live is still refused to an auditor (403 QA_KIND_NOT_ALLOWED), whatever is registered', async () => {
    const registry = createAnswererRegistry();
    const fake: QaAnswerer = async () => { throw new Error('never called'); };
    registry.register('Q3', 'live', fake);
    const scopes: QaScopeStore = {
      repositoryExists: async () => true, pullRequestRepository: async () => R1, commitExists: async () => true,
    };
    await assert.rejects(
      answerQuestion({ answerers: registry, scopes }, { tenantId: A, role: 'tenant_auditor', questionId: 'Q3', query: { kind: 'live' }, now: new Date(NOW) }),
      (err: unknown) => err instanceof QaProblem && err.code === 'QA_KIND_NOT_ALLOWED',
    );
  });

  test('evidence above the cap is truncated to 50 000 records and still recomputes', () => {
    const records = Array.from({ length: MAX_EVIDENCE_RECORDS + 3 }, (_, i) => ({ seq: i, digest: sha256Prefixed(`r${i}`) }));
    const e = evidenceOf(records.reverse());
    assert.equal(e.count, MAX_EVIDENCE_RECORDS);
    assert.equal(e.records[0].seq, 0);
    assert.equal(e.statements_root, digestsRoot(e.records.map((r) => r.digest)));
  });
});
