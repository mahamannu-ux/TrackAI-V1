/**
 * Task15i4 period report: determinism, figures, completeness, tampering (pure; no database).
 * Ported first from SushiCorp @ 0bd67a5 tests/unit/reporting/test_reporting_integrity.py
 * (catalog RP-1): regeneration is byte-identical, the generation time never enters the body,
 * a tampered report, statement or figure is detected. The independent oracle below sums the
 * signed fields with its own code, never with period-report-rules.ts.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize, sha256Prefixed } from './canonical';
import { statementValidator } from './builder';
import { checkStatementRules } from './contract-rules';
import {
  FIGURES, MAX_REPORT_STATEMENTS, PeriodReportError, basisPoints, buildReportStatement, checkPeriodReport,
  computeReportDocument, digestsRoot, reportSubjectName, reportValidators, type ReportInput, type ReportScope,
} from './period-report-rules';
import { input, reportStatement } from './testing/period-report-fixtures';

const T = 'aaaaaaaa-0000-4000-8000-00000000000a';
const R = 'cccccccc-0000-4000-8000-0000000000c1';
const OTHER = 'cccccccc-0000-4000-8000-0000000000c2';
const sha = (l: string) => createHash('sha1').update(l).digest('hex');
const SCOPE: ReportScope = { repository_id: R, from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z', basis: 'recorded_at' };
const AS_OF = '2026-10-14T08:00:00.000Z';
const VERSION = '0.1.0+3c862ef';
const RANGE = { from_seq: 0, to_seq: 9, to_record_hash: 'sha256:' + 'e'.repeat(64) };

/** The founder's checkpoint example, plus a deployment and noise. */
function exampleInputs(): ReportInput[] {
  const at = (d: number) => `2026-10-0${d}T10:00:00.000Z`;
  return [
    input(1, reportStatement({ kind: 'commit_observed', repositoryId: R, sha: sha('c1'), asOf: at(1), lines: { ai: 30, human: 10, added: 40, deleted: 5 } })),
    input(2, reportStatement({ kind: 'commit_observed', repositoryId: R, sha: sha('c2'), asOf: at(2), lines: null })),
    // c1 observed again from a newer note: the latest statement stands for c1.
    input(4, reportStatement({ kind: 'commit_observed', repositoryId: R, sha: sha('c1'), asOf: at(3), lines: { ai: 32, human: 10, added: 42, deleted: 5 } })),
    input(5, reportStatement({ kind: 'pr_merged', repositoryId: R, sha: sha('m7'), asOf: at(4), mergedAiLines: 32,
      lines: { ai: 32, human: 10, added: 42, deleted: 5 },
      models: [['claude-code', 'opus', 20], ['cursor', null, 12]], pullRequestId: '00000000-0000-4000-8000-000000000057' })),
    input(7, reportStatement({ kind: 'deployed', repositoryId: R, sha: sha('m7'), asOf: at(5), deploymentId: '00000000-0000-4000-8000-000000000077' })),
  ];
}

function built(inputs = exampleInputs(), previous: string[] = []) {
  const document = computeReportDocument({ tenantId: T, scope: SCOPE, inputs });
  return buildReportStatement({ document, chainRange: RANGE, asOf: AS_OF, builderVersion: VERSION, previous });
}

// ---------------------------------------------------------------- independent oracle

type Lines = { ai: number; human: number; unknown: number; added: number; deleted: number };
function oracle(inputs: ReportInput[]) {
  const parsed = inputs.map((i) => ({ seq: i.seq, s: JSON.parse(i.canonical) })).sort((a, b) => a.seq - b.seq);
  const latest = (kind: string, keyOf: (s: any) => string) => {
    const m: Record<string, { seq: number; s: any }> = {};
    for (const x of parsed) if (x.s.predicate.statement_kind === kind) m[keyOf(x.s)] = x; // ascending seq: last wins
    return Object.values(m);
  };
  const obs = latest('commit_observed', (s) => s.subject[0].digest.gitCommit);
  const merged = latest('pr_merged', (s) => s.subject[0].digest.gitCommit);
  const deps = latest('deployed', (s) => s.predicate.deployment.value.id);
  const sumLines = (xs: Array<{ s: any }>): Lines => xs.filter((x) => x.s.predicate.lines.availability !== 'unavailable')
    .reduce((t, x) => {
      const v = x.s.predicate.lines.value;
      return { ai: t.ai + v.ai, human: t.human + v.human, unknown: t.unknown + v.unknown, added: t.added + v.added, deleted: t.deleted + v.deleted };
    }, { ai: 0, human: 0, unknown: 0, added: 0, deleted: 0 });
  const byModel: Record<string, number> = {};
  for (const x of merged) {
    if (x.s.predicate.models.availability === 'unavailable') continue;
    for (const m of x.s.predicate.models.value) byModel[m.model_key] = (byModel[m.model_key] ?? 0) + m.ai_lines;
  }
  const changed = sumLines(obs);
  return {
    commits_observed: obs.length,
    lines_changed: changed,
    prs_merged: merged.length,
    merged_lines: sumLines(merged),
    merged_ai_lines: merged.filter((x) => x.s.predicate.lifecycle.availability !== 'unavailable')
      .reduce((n, x) => n + x.s.predicate.lifecycle.value.ai_lines, 0),
    by_model: byModel,
    production_deployments: deps.length,
    ai_share_changed: Math.floor((changed.ai * 10000) / (changed.ai + changed.human + changed.unknown)),
  };
}

// ---------------------------------------------------------------- determinism (ported first)

describe('T15i4 period report: determinism (RP-1)', () => {
  test('regeneration is byte-identical for the same statements, in any input order', () => {
    const a = built();
    const b = built([...exampleInputs()].reverse());
    assert.equal(a.documentText, b.documentText);
    assert.equal(a.documentDigest, sha256Prefixed(a.documentText));
    assert.equal(a.documentText, canonicalize(JSON.parse(a.documentText)));
  });

  test('the generation time, builder and chain head never enter the document', () => {
    const doc = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: exampleInputs() });
    const a = buildReportStatement({ document: doc, chainRange: RANGE, asOf: AS_OF, builderVersion: VERSION, previous: [] });
    const b = buildReportStatement({ document: doc, chainRange: { ...RANGE, to_seq: 12 }, asOf: '2027-11-14T08:00:00.000Z',
      builderVersion: '0.2.0+abcdef1', previous: [sha256Prefixed('earlier')] });
    assert.equal(a.documentDigest, b.documentDigest);
    assert.notEqual(a.statementDigest, b.statementDigest);
    assert.ok(!a.documentText.includes(AS_OF) && !a.documentText.includes('3c862ef'));
  });

  test('the statement names the document digest and the scope, and passes its schema and P1–P10', () => {
    const r = built();
    const s = r.statement as any;
    assert.equal(s.subject[0].name, reportSubjectName(SCOPE));
    assert.equal(`sha256:${s.subject[0].digest.sha256}`, r.documentDigest);
    assert.equal(reportValidators().statement(JSON.parse(r.statementCanonical)), true);
    assert.deepEqual(checkPeriodReport({ statement: JSON.parse(r.statementCanonical), documentText: r.documentText, tenantId: T, inputs: exampleInputs() }), []);
  });
});

// ---------------------------------------------------------------- figures

describe('T15i4 period report: figures', () => {
  test('the synthetic inputs are valid ai-provenance statements (schema and S1–S12)', () => {
    for (const i of exampleInputs()) {
      const s = JSON.parse(i.canonical);
      assert.equal(statementValidator()(s), true, JSON.stringify(statementValidator().errors?.slice(0, 2)));
      assert.deepEqual(checkStatementRules(s), []);
    }
  });

  test('each figure equals the independent oracle, and the example of the checkpoint', () => {
    const doc = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: exampleInputs() });
    const o = oracle(exampleInputs());
    const f = doc.figures;
    assert.equal(f.commits_observed.value, o.commits_observed);
    assert.deepEqual(f.lines_changed.value, o.lines_changed);
    assert.equal(f.prs_merged.value, o.prs_merged);
    assert.deepEqual(f.merged_lines.value, o.merged_lines);
    assert.equal(f.merged_ai_lines.value, o.merged_ai_lines);
    assert.deepEqual(Object.fromEntries((f.merged_ai_lines_by_model.value as any[]).map((m) => [m.model_key, m.ai_lines])), o.by_model);
    assert.equal(f.production_deployments.value, o.production_deployments);
    assert.equal(doc.ratios.ai_share_of_changed_lines_bp.value, o.ai_share_changed);
    // The checkpoint numbers.
    assert.equal(f.commits_observed.value, 2);
    assert.deepEqual(f.lines_changed.value, { ai: 32, human: 10, unknown: 0, added: 42, deleted: 5 });
    assert.equal(doc.ratios.ai_share_of_changed_lines_bp.value, 7619);
    assert.deepEqual(f.merged_ai_lines_by_model.value, [
      { tool: 'claude-code', model: 'opus', model_key: 'claude-code::opus', ai_lines: 20 },
      { tool: 'cursor', model: null, model_key: 'cursor::unknown', ai_lines: 12 },
    ]);
  });

  test('a commit seen twice counts once, by its latest statement in range (founder 2026-10-14)', () => {
    const doc = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: exampleInputs() });
    assert.deepEqual(doc.figures.lines_changed.contributions.records.map((r) => r.seq), [4]);
    assert.deepEqual(doc.figures.commits_observed.contributions.records.map((r) => r.seq), [2, 4]);
  });

  test('partial and unavailable inputs are counted in completeness and mark the figure', () => {
    const doc = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: exampleInputs() });
    assert.deepEqual(doc.completeness.lines_changed, { inputs: 2, recorded: 1, partial: 0, unavailable: 1 });
    assert.equal(doc.figures.lines_changed.availability, 'partial');
    assert.equal(doc.figures.lines_changed.partial_reason, 'only_some_sources_reported');
    assert.equal(doc.ratios.ai_share_of_changed_lines_bp.availability, 'partial');
    // Only unavailable inputs: the figure is unavailable, never a zero.
    const only = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [exampleInputs()[1]] });
    assert.deepEqual(only.figures.lines_changed, {
      availability: 'unavailable', reason: 'source_missing', statements_root: digestsRoot([]), contributions: { count: 0, records: [] },
    });
    assert.deepEqual(only.ratios.ai_share_of_changed_lines_bp, { availability: 'unavailable', reason: 'source_missing' });
    // No inputs at all: honest zeros, recorded; a ratio over nothing is not applicable.
    const none = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [] });
    assert.equal(none.figures.commits_observed.value, 0);
    assert.equal(none.figures.commits_observed.availability, 'recorded');
    assert.deepEqual(none.ratios.ai_share_of_merged_lines_bp, { availability: 'unavailable', reason: 'not_applicable' });
    assert.equal(none.repo_share.reason, 'not_captured_yet');
  });

  test('a partial input contributes and marks its record partial', () => {
    const pr = JSON.parse(reportStatement({ kind: 'pr_merged', repositoryId: R, sha: sha('p'), asOf: '2026-10-02T00:00:00.000Z' }));
    // the frozen pr fixture's lifecycle is partial / lineage_still_being_enriched
    const doc = computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [input(3, canonicalize(pr))] });
    assert.equal(doc.figures.merged_ai_lines.availability, 'partial');
    assert.deepEqual(doc.completeness.merged_ai_lines, { inputs: 1, recorded: 0, partial: 1, unavailable: 0 });
    assert.equal(doc.figures.merged_ai_lines.contributions.records[0].availability, 'partial');
  });

  test('basis points are integers, floored, and round-trip through the statement', () => {
    assert.equal(basisPoints(2, 3), 6666);
    assert.equal(basisPoints(1, 1), 10000);
    assert.equal(basisPoints(0, 7), 0);
    assert.equal(basisPoints(9007199254740991, 9007199254740991), 10000);
    const r = built();
    const back = JSON.parse(r.statementCanonical).predicate.ratios.ai_share_of_changed_lines_bp.value;
    assert.ok(Number.isInteger(back) && back === 7619);
    assert.ok(!/\d\.\d/.test(r.statementCanonical.replace(/"[^"]*"/g, '""')), 'no fractional number anywhere');
  });

  test('inputs about another repository, or listed twice, are refused', () => {
    const other = input(9, reportStatement({ kind: 'commit_observed', repositoryId: OTHER, sha: sha('x'), asOf: '2026-10-02T00:00:00.000Z', lines: { ai: 1, human: 0, added: 1, deleted: 0 } }));
    assert.throws(() => computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [other] }), PeriodReportError);
    const one = exampleInputs()[0];
    assert.throws(() => computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [one, { ...one, seq: 3 }] }), PeriodReportError);
    assert.throws(() => computeReportDocument({ tenantId: T, scope: SCOPE, inputs: [{ ...one, canonical: one.canonical + ' ' }] }), PeriodReportError);
    assert.equal(MAX_REPORT_STATEMENTS, 50_000);
  });
});

// ---------------------------------------------------------------- tampering (ported)

describe('T15i4 period report: tampering is detected', () => {
  const check = (statement: unknown, documentText: string, inputs?: ReportInput[]) =>
    checkPeriodReport({ statement, documentText, tenantId: T, inputs });

  test('a tampered document (a figure raised and re-canonicalized) breaks the digest and the sums', () => {
    const r = built();
    const doc = JSON.parse(r.documentText);
    doc.figures.lines_changed.value.ai = 42;
    const forged = canonicalize(doc);
    const broken = check(JSON.parse(r.statementCanonical), forged);
    assert.ok(broken.includes('P1') && broken.includes('P5') && broken.includes('P8'), broken.join());
  });

  test('a forged figure in both document and statement (re-signed) is caught by recomputing from the statements', () => {
    const r = built();
    const doc = JSON.parse(r.documentText);
    doc.figures.merged_ai_lines.value = 999;
    doc.figures.merged_ai_lines.contributions.records[0].contribution = 999;
    const forged = canonicalize(doc);
    const stmt = JSON.parse(r.statementCanonical);
    stmt.predicate.figures.merged_ai_lines.value = 999;
    stmt.subject[0].digest.sha256 = sha256Prefixed(forged).slice(7);
    assert.deepEqual(check(stmt, forged), [], 'consistent on its own: only the inputs reveal it');
    assert.deepEqual(check(stmt, forged, exampleInputs()), ['P9']);
  });

  test('a statement left out of the document is caught against the inputs', () => {
    const inputs = exampleInputs();
    const r = built(inputs.filter((i) => i.seq !== 2));
    assert.deepEqual(check(JSON.parse(r.statementCanonical), r.documentText, inputs), ['P9']);
  });

  test('a tampered input statement (its signed lines changed) no longer matches the document', () => {
    const r = built();
    const inputs = exampleInputs();
    const s = JSON.parse(inputs[2].canonical);
    s.predicate.lines.value.ai = 40;
    s.predicate.lines.value.added = 50;
    inputs[2] = input(4, canonicalize(s));
    assert.deepEqual(check(JSON.parse(r.statementCanonical), r.documentText, inputs), ['P9']);
  });

  test('a ratio, completeness or scope edited in the statement is detected', () => {
    const r = built();
    const s1 = JSON.parse(r.statementCanonical);
    s1.predicate.ratios.ai_share_of_changed_lines_bp.value = 9000;
    assert.deepEqual(check(s1, r.documentText), ['P8']);
    const s2 = JSON.parse(r.statementCanonical);
    s2.predicate.completeness.lines_changed = { inputs: 2, recorded: 2, partial: 0, unavailable: 0 };
    assert.deepEqual(check(s2, r.documentText), ['P8']);
    const s3 = JSON.parse(r.statementCanonical);
    s3.predicate.scope.to = '2026-10-08T00:00:00.000Z';
    assert.ok(check(s3, r.documentText).includes('P1'));
  });

  test('a document claiming more contributors than its statements, or another tenant, is refused', () => {
    const r = built();
    const doc = JSON.parse(r.documentText);
    doc.completeness.lines_changed.unavailable = 0;
    doc.completeness.lines_changed.recorded = 2;
    const forged = canonicalize(doc);
    const stmt = JSON.parse(r.statementCanonical);
    stmt.subject[0].digest.sha256 = sha256Prefixed(forged).slice(7);
    stmt.predicate.completeness = doc.completeness;
    assert.ok(check(stmt, forged).includes('P6'));
    assert.deepEqual(checkPeriodReport({ statement: JSON.parse(r.statementCanonical), documentText: r.documentText, tenantId: 'bbbbbbbb-0000-4000-8000-00000000000b' }), ['P2']);
  });

  test('a non-canonical or schema-invalid document is P_SCHEMA', () => {
    const r = built();
    assert.deepEqual(check(JSON.parse(r.statementCanonical), r.documentText + ' '), ['P_SCHEMA']);
    const doc = JSON.parse(r.documentText);
    doc.figures.lines_changed.value.ai = 1.5;
    assert.deepEqual(check(JSON.parse(r.statementCanonical), canonicalize(doc)), ['P_SCHEMA']);
  });

  test('previous lists each earlier report once', () => {
    const d = sha256Prefixed('earlier');
    assert.throws(() => built(exampleInputs(), [d, d]), PeriodReportError);
    assert.equal((built(exampleInputs(), [d]).statement as any).predicate.previous[0].digest, d);
  });
});

// ---------------------------------------------------------------- privacy

describe('T15i4 period report: no raw content, no per-developer figure', () => {
  test('no field names a person, a path, a URL or a message', () => {
    const r = built();
    const all = r.statementCanonical + r.documentText;
    for (const bad of ['committer', 'contributor', 'author', 'developer', 'email', 'login', 'user', 'path', 'url', 'message', 'title', 'session']) {
      assert.ok(!new RegExp(`"[a-z_]*${bad}[a-z_]*":`).test(all), bad);
    }
    assert.ok(!/@[A-Za-z0-9-]+\./.test(all), 'nothing email-like');
  });

  test('the schemas are closed and list exactly the v1 figures', () => {
    const v = reportValidators();
    const r = built();
    const s = JSON.parse(r.statementCanonical);
    s.predicate.figures.per_developer = s.predicate.figures.commits_observed;
    assert.equal(v.statement(s), false);
    const d = JSON.parse(r.documentText);
    d.figures.lines_changed.contributions.records[0].contributor_id = '00000000-0000-4000-8000-000000000040';
    assert.equal(v.document(d), false);
    assert.deepEqual(Object.keys(JSON.parse(r.statementCanonical).predicate.figures).sort(), [...FIGURES].sort());
  });
});
