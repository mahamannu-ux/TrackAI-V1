// Task15op-b (A15.16): the security period report: figures, rules SR1–SR9, the coverage checks,
// the build (idempotency, `previous`, the size refusal) and the offline verifier, all without a
// database (docs/contracts/attesta/security-period-report.md). Pattern: period-report-rules.test.ts.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, test } from 'node:test';
import { GENESIS_PREV_HASH, canonicalize, computeRecordHash, sha256Prefixed } from './canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from './dsse';
import { buildPack, signPack, type PackScope } from './evidence-pack-service';
import { AttestaLedgerError, LEDGER_RECORD_KIND, SECURITY_PERIOD_REPORT_PREDICATE_TYPE, buildCanonicalRecord, deriveStatementColumns } from './ledger';
import { verifyEvidencePack } from './offline-verifier';
import { digestsRoot } from './period-report-rules';
import {
  buildSecuritySealDocument, buildSecuritySealStatement, type SecurityFindingRow, type SecurityVerifySeal,
} from './security-seal-service';
import {
  DECISION_KEYS, MAX_SECURITY_REPORT_BUCKETS, buildSecurityReportStatement, checkSecurityReport, computeSecurityReportDocument,
  decisionDigest, reportRowOf, securityReportSubjectName, type DecisionRow, type ReportSealRef, type SecurityReportInputs,
  type SecurityReportScope,
} from './security-report-rules';
import {
  buildSecurityReport, checkCoveringSeal, coverageRefusal, parseSecurityReportScope, securityReportDocumentBody,
  securityReportStatusBody, type ChainSecurityReportInput, type SecurityReportSnapshot, type SecurityReportStore,
  type StoredSecurityReport,
} from './security-report-service';
import { devSignerResolver } from './signer-resolver';
import { A as PA, PACK_1, T0, MIN, at, segmentOf, trustWorld, type ChainRecord } from './testing/evidence-pack-fixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const M1 = '0a000000-0000-4000-8000-000000000001';
const M2 = '0a000000-0000-4000-8000-000000000002';
const REPO = '0c000000-0000-4000-8000-000000000001';
const id = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BUILDER = '0.1.0+abcdef0';
const AS_OF = '2026-10-18T08:20:00.000Z';
const W1 = { from: '2026-10-18T06:00:00.000000Z', to: '2026-10-18T07:00:00.000000Z' };
const W2 = { from: '2026-10-18T07:00:00.000000Z', to: '2026-10-18T08:00:00.000000Z' };
const SCOPE: SecurityReportScope = { tenant_id: A, repository_id: null, from: '2026-10-18T06:00:00.000Z', to: '2026-10-18T08:00:00.000Z', basis: 'received_at' };

function v2Row(n: number, receivedAt: string, over: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    id: id(n), record_generation: 'v2', machine_id: M1, repository_id: null, repository_kind: 'not_enrolled',
    rule_id: 'secrets.aws_key', rule_version: '1.2.0', rule_category: 'secrets', rule_severity: 'high', effect: 'monitor',
    agent_family: null, source_agent: 'claude-code', model: 'claude-x', session_id: 'sess-1', record_id: `sha256:${'a'.repeat(64)}`,
    occurred_at: '2026-10-18T06:01:02.123000Z', received_at: receivedAt, rule_pack_version: `bundle:${'b'.repeat(16)}`,
    bundle_digest: 'b'.repeat(64), lease_id: 'lease-1', found_at_rest: false, phase: null, timing: null, result_category: null,
    operating_system: null, source_type: 'hook', model_provider: null, parent_session_id: null, sub_agent_id: null,
    finding_id: null, delivery_id: null, source_event_id: null, correlation_id: null, detected_at: '2026-10-18T06:01:02.123000Z',
    numbat_schema_version: '0.5.0', confidence: 'high', route_id: null, host_surface: null, host_mode: null, capture_channel: null,
    native_effect: null, activation: null, availability: null, completeness: null, client_version: null, ...over,
  };
}
function task6aRow(n: number, receivedAt: string, over: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    ...v2Row(n, receivedAt), record_generation: 'task6a', repository_id: REPO, repository_kind: null,
    rule_id: 'trackai.exec.reverse_shell', rule_version: '1', rule_category: 'execution', rule_severity: 'critical',
    agent_family: 'opencode', source_agent: null, model: null, record_id: null, rule_pack_version: 'task6a-1',
    bundle_digest: null, lease_id: null, found_at_rest: null, phase: 'requested', timing: 'pre_action', result_category: 'not_observed',
    operating_system: 'macos', source_type: null, detected_at: null, numbat_schema_version: null, confidence: null,
    finding_id: `finding-${n}`, delivery_id: `delivery-${n}`, source_event_id: 'event-1', route_id: 'AC-CLI-03',
    host_surface: 'terminal', host_mode: 'cli', capture_channel: 'provider-plugin', native_effect: 'observe_only',
    activation: 'observed', availability: 'available', completeness: 'complete', client_version: '0.1.0', ...over,
  };
}
function decision(n: number, receivedAt: string, over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: `0d000000-0000-4000-8000-${String(n).padStart(12, '0')}`, machine_id: M1, record_id: `sha256:${String(n).repeat(64).slice(0, 64)}`,
    decision: 'deny', mode: 'enforce', rule_ids: ['secrets.aws_key'], deny_rule_id: 'secrets.aws_key', deny_rule_version: '1.2.0',
    finding_record_ids: [], tool_name: 'Bash', tool_call_id: 'call-1', session_id: 'sess-1', source_agent: 'claude-code',
    occurred_at: receivedAt, received_at: receivedAt, ...over,
  };
}

/** Two contiguous seals over the rows, as the sealer would store them. */
function sealsOver(tenantId: string, rows: SecurityFindingRow[]): Array<SecurityVerifySeal & { ref: ReportSealRef }> {
  const out: Array<SecurityVerifySeal & { ref: ReportSealRef }> = [];
  let previous: string | null = null;
  [W1, W2].forEach((window, i) => {
    const doc = buildSecuritySealDocument({ tenantId, window, previous, rows: rows.filter((r) => r.received_at >= window.from && r.received_at < window.to) });
    const statementCanonical = buildSecuritySealStatement({ document: doc.document, documentDigest: doc.digest, asOf: AS_OF, builderVersion: BUILDER });
    const statementDigest = sha256Prefixed(statementCanonical);
    out.push({
      tenantId, windowFrom: window.from, windowTo: window.to, rowCount: doc.document.count, task6aCount: doc.document.generations.task6a,
      v2Count: doc.document.generations.v2, previousDigest: previous, sealDocument: doc.text, sealDigest: doc.digest,
      seq: 3 + i, statementCanonical, recordStatementDigest: statementDigest, statementDigest,
      ref: { seq: 3 + i, statement_digest: statementDigest, seal_digest: doc.digest, window },
    });
    previous = doc.digest;
  });
  return out;
}

const ROWS = [
  task6aRow(1, '2026-10-18T06:10:00.000000Z', { occurred_at: '2026-10-18T05:59:00.000000Z' }),
  v2Row(2, '2026-10-18T06:20:00.000000Z'),
  v2Row(3, '2026-10-18T07:10:00.000000Z', { machine_id: M2, repository_id: REPO, repository_kind: 'enrolled', model: null }),
  v2Row(4, '2026-10-18T07:20:00.000000Z', { model: 'model with spaces' }),
];
const DECISIONS = [decision(1, '2026-10-18T06:30:00.000000Z'), decision(2, '2026-10-18T07:30:00.000000Z')];

function inputs(over: Partial<SecurityReportInputs> = {}): SecurityReportInputs {
  return {
    tenantId: A, scope: SCOPE, seals: sealsOver(A, ROWS).map((s) => s.ref), rows: ROWS.map(reportRowOf),
    decisions: DECISIONS, platforms: { [M1]: 'macos' }, ...over,
  };
}

function built(over: Partial<SecurityReportInputs> = {}, previous: string[] = []) {
  const i = inputs(over);
  const document = computeSecurityReportDocument(i);
  return { inputs: i, document, ...buildSecurityReportStatement({ document, asOf: AS_OF, builderVersion: BUILDER, previous, inputs: i }) };
}

describe('security report: figures', () => {
  test('both generations: buckets, the not_enrolled / unknown / unavailable buckets, a hashed model, late arrivals, deny requests', () => {
    const d = computeSecurityReportDocument(inputs());
    const f = d.figures;
    assert.deepEqual(f.findings, { availability: 'recorded', value: 4 });
    assert.deepEqual(f.by_generation.value, [{ key: 'task6a', count: 1 }, { key: 'v2', count: 3 }]);
    assert.deepEqual(f.by_repository.value, [{ key: REPO, count: 2 }, { key: 'not_enrolled', count: 2 }]);
    assert.deepEqual(f.by_agent.value, [{ key: 'claude-code', count: 3 }, { key: 'opencode', count: 1 }]);
    const hashed = sha256Prefixed(Buffer.from('model with spaces', 'utf8'));
    assert.deepEqual(f.by_model, { availability: 'partial', partial_reason: 'values_hashed_unrepresentable',
      value: [{ key: 'claude-x', count: 1 }, { key: hashed, count: 1 }, { key: 'unknown', count: 2 }].sort((x, y) => (x.key < y.key ? -1 : 1)) });
    assert.deepEqual(d.completeness.by_model, { rows: 4, recorded: 1, partial: 1, unavailable: 2 });
    assert.deepEqual(f.by_platform, { availability: 'partial', partial_reason: 'current_machine_state',
      value: [{ key: 'macos', count: 3 }, { key: 'unavailable', count: 1 }] });
    assert.deepEqual(d.machine_platforms, [{ machine_id: M1, platform: 'macos' }, { machine_id: M2, platform: 'unavailable' }]);
    assert.deepEqual(f.outcomes, { availability: 'recorded', value: [{ key: 'requested', count: 1 }, { key: 'v2_unclassified', count: 3 }] });
    assert.deepEqual(f.late_arrivals, { availability: 'recorded', value: 1 });
    assert.deepEqual(f.rule_pack_versions, { availability: 'recorded', value: 2 });
    assert.deepEqual(f.denied_by_request, { availability: 'partial', partial_reason: 'not_sealed', value: 2 });
    assert.deepEqual(d.completeness.denied_by_request, { rows: 2, recorded: 0, partial: 2, unavailable: 0 });
    assert.equal(d.rows_root, digestsRoot(ROWS.map((r) => reportRowOf(r).digest)));
    assert.deepEqual(d.decisions.map((x) => x.digest), DECISIONS.map(decisionDigest));
    assert.deepEqual(d.blocked, { availability: 'unavailable', reason: 'monitor_only_observed' });
    // Ids, digests and figures only: no session, title, tool or raw model name in the document.
    assert.doesNotMatch(canonicalize(d), /sess-1|Bash|call-1|model with spaces/);
  });

  test('no deny, no v2 rows: denied is a recorded 0, by_platform recorded, by_model and outcomes honest', () => {
    const rows = [task6aRow(1, '2026-10-18T06:10:00.000000Z')];
    const d = computeSecurityReportDocument(inputs({ seals: sealsOver(A, rows).map((s) => s.ref), rows: rows.map(reportRowOf), decisions: [], platforms: {} }));
    assert.deepEqual(d.figures.denied_by_request, { availability: 'recorded', value: 0 });
    assert.deepEqual(d.figures.by_platform, { availability: 'recorded', value: [{ key: 'macos', count: 1 }] });
    // Task6.a rows carry no model: the figure has no source (never "recorded unknown").
    assert.deepEqual(d.figures.by_model, { availability: 'unavailable', reason: 'source_missing' });
    assert.deepEqual(d.machine_platforms, []);
    const empty = computeSecurityReportDocument(inputs({ rows: [], decisions: [] }));
    assert.deepEqual(empty.figures.by_severity, { availability: 'recorded', value: [] });
    assert.equal(empty.rows_root, sha256Prefixed(Buffer.alloc(0)));
  });

  test('repository scope: only its rows; denied_by_request is not_applicable and refuses decisions', () => {
    const scope = { ...SCOPE, repository_id: REPO };
    const rows = ROWS.filter((r) => r.repository_id === REPO).map(reportRowOf);
    const d = computeSecurityReportDocument(inputs({ scope, rows, decisions: [] }));
    assert.equal(d.figures.findings.value, 2);
    assert.deepEqual(d.figures.denied_by_request, { availability: 'unavailable', reason: 'not_applicable' });
    assert.deepEqual(d.decisions, []);
    assert.throws(() => computeSecurityReportDocument(inputs({ scope, rows })), /decisions/);
    assert.throws(() => computeSecurityReportDocument(inputs({ scope, decisions: [] })), /another repository/);
    const st = buildSecurityReportStatement({ document: d, asOf: AS_OF, builderVersion: BUILDER, previous: [] });
    const c = deriveStatementColumns(st.statementCanonical);
    assert.equal(c.repositoryId, REPO);
    assert.equal(c.subjectName, securityReportSubjectName(scope));
  });

  test('the decision digest is over every column but tenant_id; a changed column changes it', () => {
    assert.equal(DECISION_KEYS.length, 15);
    const d = decision(1, '2026-10-18T06:30:00.000000Z');
    assert.equal(decisionDigest({ ...d, tenant_id: B } as DecisionRow), decisionDigest(d));
    for (const change of [{ mode: 'monitor' }, { rule_ids: ['x'] }, { tool_name: null }, { received_at: '2026-10-18T06:30:00.000001Z' }]) {
      assert.notEqual(decisionDigest({ ...d, ...change }), decisionDigest(d));
    }
    assert.throws(() => decisionDigest({ ...d, received_at: '2026-10-18T06:30:00Z' }), /microsecond/);
  });

  test('deterministic: the same inputs give the same bytes whatever the clock, builder or key order', () => {
    const a = built();
    const b = buildSecurityReportStatement({ document: computeSecurityReportDocument({ ...inputs(), platforms: { [M2]: null, [M1]: 'macos' } }),
      asOf: '2026-10-19T00:00:00.000Z', builderVersion: '9.9.9+fffffff', previous: [] });
    assert.equal(a.documentText, b.documentText);
    assert.equal(a.documentDigest, b.documentDigest);
    assert.notEqual(a.statementDigest, b.statementDigest);
  });

  test('inputs that break the snapshot rules are refused', () => {
    const rows = inputs().rows;
    assert.throws(() => computeSecurityReportDocument(inputs({ rows: [rows[1], rows[0]] })), /order/);
    assert.throws(() => computeSecurityReportDocument(inputs({ seals: inputs().seals.slice(0, 1) })), /no covering seal/);
    assert.throws(() => computeSecurityReportDocument(inputs({ tenantId: B })), /scope/, 'Company B cannot build over A\'s scope');
    assert.throws(() => computeSecurityReportDocument(inputs({ decisions: [decision(9, '2026-10-18T08:00:00.000000Z')] })), /deny in the period/);
    assert.throws(() => computeSecurityReportDocument(inputs({ decisions: [{ ...DECISIONS[0], decision: 'no_override' }] })), /deny/);
  });

  test(`more than ${MAX_SECURITY_REPORT_BUCKETS} buckets in one figure is ATTESTA_BUILDER_TOO_LARGE`, () => {
    const many = Array.from({ length: MAX_SECURITY_REPORT_BUCKETS + 1 }, (_, i) =>
      reportRowOf(v2Row(i + 1, `2026-10-18T06:${String(10 + Math.floor(i / 1000)).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}000Z`, { rule_id: `rule.${i}` })));
    assert.throws(() => computeSecurityReportDocument(inputs({ rows: many, decisions: [] })), (e: unknown) => (e as { code?: string }).code === 'ATTESTA_BUILDER_TOO_LARGE');
  });
});

describe('security report: rules SR1–SR9', () => {
  test('an honest report passes every rule, with and without its inputs', () => {
    const b = built();
    assert.deepEqual(checkSecurityReport({ statement: JSON.parse(b.statementCanonical), documentText: b.documentText, tenantId: A, inputs: b.inputs }), []);
    assert.deepEqual(checkSecurityReport({ statement: JSON.parse(b.statementCanonical), documentText: b.documentText }), []);
  });

  type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** A self-consistent forgery: the document re-hashed and the subject digest renamed, so SR1 holds. */
  function forge(mutate: (doc: Obj, predicate: Obj) => void, options: { withInputs?: boolean; tenantId?: string; asOf?: string } = {}) {
    const b = built();
    const doc = JSON.parse(b.documentText) as Obj;
    const st = JSON.parse(b.statementCanonical) as Obj;
    if (options.asOf) st.predicate.as_of = options.asOf;
    mutate(doc, st.predicate);
    const documentText = canonicalize(doc);
    st.subject[0].digest.sha256 = sha256Prefixed(documentText).slice(7);
    return checkSecurityReport({ statement: st, documentText, tenantId: options.tenantId ?? A, inputs: options.withInputs ? b.inputs : undefined });
  }

  test('each rule refuses its crafted violation', () => {
    assert.deepEqual(forge(() => undefined, { asOf: '2026-10-18T08:05:00.000Z' }), ['SR1'], 'to is not 10 minutes before as_of');
    assert.deepEqual(forge((_d, p) => { p.previous = [{ digest: `sha256:${'e'.repeat(64)}` }, { digest: `sha256:${'e'.repeat(64)}` }]; }), ['SR2']);
    assert.deepEqual(forge(() => undefined, { tenantId: B }), ['SR2'], 'Company B\'s record cannot carry A\'s report');
    assert.deepEqual(forge((d) => { d.seals.reverse(); }), ['SR3']);
    assert.deepEqual(forge((_d, p) => { p.inputs.seals_root = `sha256:${'e'.repeat(64)}`; }), ['SR3']);
    assert.deepEqual(forge((_d, p) => { p.inputs.rows_root = `sha256:${'e'.repeat(64)}`; }), ['SR4']);
    assert.deepEqual(forge((d, p) => { d.decisions.pop(); p.inputs.decision_count = 1; p.inputs.decisions_root = digestsRoot(d.decisions.map((x: Obj) => x.digest)); }), ['SR4', 'SR6'],
      'a dropped decision no longer matches denied_by_request');
    assert.deepEqual(forge((d, p) => { d.figures.by_severity.value[0].count += 1; p.figures.by_severity.value[0].count += 1; }), ['SR5']);
    assert.deepEqual(forge((d, p) => {
      for (const f of [d.figures.by_model, p.figures.by_model]) { f.availability = 'recorded'; delete f.partial_reason; }
    }), ['SR6']);
    assert.deepEqual(forge((d, p) => {
      for (const f of [d.figures.by_platform, p.figures.by_platform]) { f.availability = 'recorded'; delete f.partial_reason; }
    }), ['SR6'], 'a platform from the current machine state is never "recorded"');
    // SR7 is also frozen in the schemas: a "blocked" claim never gets past them.
    assert.deepEqual(forge((d) => { d.blocked = { availability: 'recorded', value: 1 }; }), ['SR_SCHEMA']);
    assert.deepEqual(forge((_d, p) => { p.figures.findings.value = 5; }), ['SR8']);
    assert.deepEqual(forge((d, p) => { d.figures.late_arrivals.value = 0; p.figures.late_arrivals.value = 0; }, { withInputs: true }), ['SR9']);
    assert.deepEqual(checkSecurityReport({ statement: {}, documentText: '{"a":1}' }), ['SR_SCHEMA']);
  });

  test('SR9: recomputing from inputs with one row, one decision or one platform changed gives other bytes', () => {
    const b = built();
    const st = JSON.parse(b.statementCanonical);
    const check = (i: SecurityReportInputs) => checkSecurityReport({ statement: st, documentText: b.documentText, tenantId: A, inputs: i });
    assert.deepEqual(check({ ...b.inputs, rows: b.inputs.rows.slice(1) }), ['SR9']);
    assert.deepEqual(check({ ...b.inputs, decisions: b.inputs.decisions.slice(1) }), ['SR9']);
    assert.deepEqual(check({ ...b.inputs, platforms: {} }), ['SR9']);
  });

  test('the builder refuses to sign a document that breaks a rule', () => {
    const document = computeSecurityReportDocument(inputs());
    document.figures.findings = { availability: 'recorded', value: 99 };
    assert.throws(() => buildSecurityReportStatement({ document, asOf: AS_OF, builderVersion: BUILDER, previous: [] }),
      (e: unknown) => (e as { code?: string }).code === 'ATTESTA_BUILDER_RULE_VIOLATION');
    assert.throws(() => buildSecurityReportStatement({ document: computeSecurityReportDocument(inputs()), asOf: '2026-10-18T08:05:00.000Z', builderVersion: BUILDER, previous: [] }),
      (e: unknown) => (e as { code?: string }).code === 'ATTESTA_BUILDER_RULE_VIOLATION');
    assert.throws(() => buildSecurityReportStatement({ document: computeSecurityReportDocument(inputs()), asOf: AS_OF, builderVersion: 'dev', previous: [] }),
      (e: unknown) => (e as { code?: string }).code === 'ATTESTA_BUILDER_SCHEMA_INVALID');
  });
});

describe('security report: coverage', () => {
  test('the request: ms UTC bounds, from < to, at most 366 days, lowercase UUIDs', () => {
    const ok = { tenantId: A, repositoryId: null, from: SCOPE.from, to: SCOPE.to };
    assert.deepEqual(parseSecurityReportScope(ok), SCOPE);
    for (const bad of [{ ...ok, from: '2026-10-18T06:00:00Z' }, { ...ok, to: ok.from }, { ...ok, from: '2025-10-01T00:00:00.000Z' },
      { ...ok, tenantId: 'AAAAAAAA-0000-4000-8000-00000000000A' }, { ...ok, repositoryId: 'repo' }, { ...ok, to: '2026-10-18T08:00:00.000+01:00' }]) {
      assert.throws(() => parseSecurityReportScope(bad), (e: unknown) => (e as { code?: string }).code === 'ATTESTA_API_INVALID_QUERY');
    }
  });

  test('not sealed through `to`, or no seal at all, is NOT_SEALED; a gap in the covering seals is BROKEN', () => {
    const seals = sealsOver(A, ROWS);
    const first = { windowFrom: W1.from, sealDigest: seals[0].sealDigest };
    const base = { scope: SCOPE, latestWindowTo: W2.to, firstSeal: first, seals };
    assert.equal(coverageRefusal(base), null);
    assert.equal(coverageRefusal({ ...base, latestWindowTo: null, firstSeal: null, seals: [] }), 'ATTESTA_SECURITY_PERIOD_NOT_SEALED');
    assert.equal(coverageRefusal({ ...base, latestWindowTo: '2026-10-18T07:59:59.999999Z' }), 'ATTESTA_SECURITY_PERIOD_NOT_SEALED');
    // The last covering seal stops short of `to` though a later seal exists: a removed seal.
    assert.equal(coverageRefusal({ ...base, latestWindowTo: '2026-10-18T09:00:00.000000Z', seals: seals.slice(0, 1) }), 'ATTESTA_SECURITY_SEAL_BROKEN');
    // No seal overlaps a sealed period after the first seal: a gap.
    assert.equal(coverageRefusal({ ...base, seals: [] }), 'ATTESTA_SECURITY_SEAL_BROKEN');
    // A period wholly before the first seal is covered by the before-first check.
    assert.equal(coverageRefusal({ ...base, firstSeal: { windowFrom: '2026-10-18T09:00:00.000000Z', sealDigest: first.sealDigest }, seals: [] }), null);
    // The first covering seal starts after `from` but has a predecessor: a gap.
    assert.equal(coverageRefusal({ ...base, seals: seals.slice(1) }), 'ATTESTA_SECURITY_SEAL_BROKEN');
  });

  test('a covering seal: intact passes; a changed, deleted or late row, a crafted document or a broken link is a break', () => {
    const seals = sealsOver(A, ROWS);
    const inW1 = ROWS.filter((r) => r.received_at < W1.to);
    assert.deepEqual(checkCoveringSeal(SCOPE, seals[0], null, inW1), []);
    assert.deepEqual(checkCoveringSeal(SCOPE, seals[1], { windowTo: W1.to, sealDigest: seals[0].sealDigest }, ROWS.slice(2)), []);
    const kinds = (b: Array<{ kind: string }>) => b.map((x) => x.kind).sort();
    assert.deepEqual(kinds(checkCoveringSeal(SCOPE, seals[0], null, [{ ...inW1[0], rule_severity: 'low' }, inW1[1]])), ['changed_row']);
    assert.deepEqual(kinds(checkCoveringSeal(SCOPE, seals[0], null, inW1.slice(1))), ['missing_row']);
    assert.deepEqual(kinds(checkCoveringSeal(SCOPE, seals[0], null, [...inW1, v2Row(9, '2026-10-18T06:50:00.000000Z')])), ['unsealed_row_in_sealed_window']);
    assert.deepEqual(kinds(checkCoveringSeal(SCOPE, seals[1], undefined, ROWS.slice(2))), ['broken_previous']);
    assert.deepEqual(kinds(checkCoveringSeal(SCOPE, { ...seals[0], recordStatementDigest: `sha256:${'e'.repeat(64)}` }, null, inW1)), ['statement_problem']);
    // Company A's seal read as Company B's: its document no longer parses there.
    assert.ok(checkCoveringSeal(SCOPE, { ...seals[0], tenantId: B }, null, inW1).some((x) => x.kind === 'statement_problem'));
  });
});

// ---------------------------------------------------------------------------
// The build over a memory store

class MemoryStore implements SecurityReportStore {
  statements: Array<{ name: string; digest: string; canonical: string }> = [];
  reports: StoredSecurityReport[] = [];
  chainCalls = 0;
  /** Chain a report for the scope from "another process" on the next chainReport. */
  raceOnce = false;
  refusal: Error | null = null;
  constructor(public inputs: SecurityReportInputs) {}

  async readSnapshot(scope: SecurityReportScope): Promise<SecurityReportSnapshot> {
    if (this.refusal) throw this.refusal;
    const name = securityReportSubjectName(scope);
    return {
      asOf: AS_OF, inputs: { ...this.inputs, scope },
      previous: this.statements.filter((s) => s.name === name).map((s) => s.digest),
      reports: this.reports.filter((r) => r.tenantId === scope.tenant_id && r.repositoryId === scope.repository_id && r.periodFrom === scope.from && r.periodTo === scope.to),
    };
  }

  async chainReport(input: ChainSecurityReportInput): Promise<{ reportId: string; seq: number }> {
    this.chainCalls += 1;
    const name = securityReportSubjectName(input.scope);
    if (this.raceOnce) {
      this.raceOnce = false;
      this.statements.push({ name, digest: `sha256:${'9'.repeat(64)}`, canonical: '{}' });
    }
    const current = this.statements.filter((s) => s.name === name).map((s) => s.digest);
    if (canonicalize(current) !== canonicalize(input.previousSeen)) throw new AttestaLedgerError('ATTESTA_LEDGER_PREVIOUS_STALE', 'stale');
    const columns = deriveStatementColumns(input.statementCanonical);
    assert.deepEqual(columns.previous, input.previousSeen);
    this.statements.push({ name, digest: columns.statementDigest, canonical: input.statementCanonical });
    const reportId = `33333333-0000-4000-8000-${String(this.reports.length + 1).padStart(12, '0')}`;
    this.reports.push({ id: reportId, tenantId: input.tenantId, repositoryId: input.scope.repository_id, periodFrom: input.scope.from,
      periodTo: input.scope.to, reportDigest: input.documentDigest, statementDigest: columns.statementDigest, createdAt: AS_OF });
    return { reportId, seq: this.statements.length };
  }
}

function deps(store: SecurityReportStore, resolver = devSignerResolver({ sharedKeyPem: KEY_PEM, env: {} })) {
  return { store, resolver, builderVersion: BUILDER, actor: { type: 'system_operator' as const, id: 'attesta:security-report:test' }, log: () => undefined };
}
const KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('security report: the build', () => {
  test('built once, then existing (nothing signed); a platform change chains a new report naming the first in previous', async () => {
    const store = new MemoryStore(inputs());
    const dry = await buildSecurityReport(deps(store), SCOPE, { dryRun: true });
    assert.deepEqual([dry.outcome, dry.sealCount, dry.rowCount, dry.decisionCount, dry.reportDigest], ['would_build', 2, 4, 2, undefined]);
    assert.equal(store.chainCalls, 0);
    const first = await buildSecurityReport(deps(store), SCOPE);
    assert.equal(first.outcome, 'built');
    const again = await buildSecurityReport(deps(store), SCOPE);
    assert.deepEqual([again.outcome, again.reportId, again.reportDigest], ['existing', first.reportId, first.reportDigest]);
    assert.equal(store.chainCalls, 1);
    store.inputs = { ...store.inputs, platforms: { [M1]: 'windows' } };
    const second = await buildSecurityReport(deps(store), SCOPE);
    assert.equal(second.outcome, 'built');
    assert.notEqual(second.reportDigest, first.reportDigest);
    const statement = JSON.parse(store.statements[1].canonical);
    assert.deepEqual(statement.predicate.previous, [{ digest: first.statementDigest }]);
    assert.equal(statement.predicateType, SECURITY_PERIOD_REPORT_PREDICATE_TYPE);
    // The statement verifies against the stored document (SR1–SR8 without the database).
    const doc = canonicalize(computeSecurityReportDocument({ ...store.inputs }));
    assert.deepEqual(checkSecurityReport({ statement, documentText: doc, tenantId: A }), []);
  });

  test('a report chained meanwhile (PREVIOUS_STALE) is rebuilt once from a fresh snapshot', async () => {
    const store = new MemoryStore(inputs());
    store.raceOnce = true;
    const r = await buildSecurityReport(deps(store), SCOPE);
    assert.equal(r.outcome, 'built');
    assert.equal(store.chainCalls, 2);
    assert.deepEqual(JSON.parse(store.statements[1].canonical).predicate.previous, [{ digest: `sha256:${'9'.repeat(64)}` }]);
  });

  test('refusals carry one safe code: not sealed, broken, no key, too large for the signer', async () => {
    const store = new MemoryStore(inputs());
    const { SecurityReportError } = await import('./security-report-rules');
    store.refusal = new SecurityReportError('ATTESTA_SECURITY_PERIOD_NOT_SEALED', 'x');
    assert.deepEqual(await buildSecurityReport(deps(store), SCOPE).then((r) => [r.outcome, r.code]), ['refused', 'ATTESTA_SECURITY_PERIOD_NOT_SEALED']);
    store.refusal = new SecurityReportError('ATTESTA_SECURITY_SEAL_BROKEN', 'x');
    assert.deepEqual(await buildSecurityReport(deps(store), SCOPE).then((r) => [r.outcome, r.code]), ['refused', 'ATTESTA_SECURITY_SEAL_BROKEN']);
    store.refusal = null;
    assert.equal((await buildSecurityReport(deps(store, { resolve: async () => null }), SCOPE)).code, 'ATTESTA_SIGNER_NO_CREDENTIAL');
    const real = devSignerResolver({ sharedKeyPem: KEY_PEM, env: {} });
    const small = {
      resolve: async (t: string) => {
        const s = await real.resolve(t);
        if (!s) return null;
        const adapter = new Proxy(s.adapter, { get(target, prop) {
          if (prop === 'capabilities') return () => ({ ...target.capabilities(), maxPayloadBytes: 1000 });
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } });
        return { ...s, adapter };
      },
    };
    assert.equal((await buildSecurityReport(deps(store, small), SCOPE)).code, 'ATTESTA_BUILDER_TOO_LARGE');
    assert.equal(store.chainCalls, 0);
  });

  test('the routes\' bodies: the status carries the scope and digests, the document must hash to its digest', () => {
    const b = built();
    const stored: StoredSecurityReport = { id: id(1), tenantId: A, repositoryId: null, periodFrom: SCOPE.from, periodTo: SCOPE.to,
      reportDigest: b.documentDigest, statementDigest: b.statementDigest, createdAt: AS_OF };
    assert.deepEqual(securityReportStatusBody(stored), { id: id(1), scope: SCOPE, report_digest: b.documentDigest, statement_digest: b.statementDigest, created_at: AS_OF });
    assert.equal(securityReportDocumentBody(stored, b.documentText), b.documentText);
    assert.throws(() => securityReportDocumentBody(stored, `${b.documentText} `), /digest/);
    assert.throws(() => securityReportDocumentBody(stored, null), /digest/);
  });
});

describe('security report: the offline verifier', () => {
  test('a built report statement passes the statements check in a tenant pack; its document is not checkable (exit 2)', async () => {
    const w = await trustWorld();
    // A one-record chain holding a report built by the builder, signed by A's statement key.
    const scope = { ...SCOPE, from: at(T0 - 120 * MIN), to: at(T0 - 60 * MIN) };
    const window = { from: `${scope.from.slice(0, 23)}000Z`, to: `${scope.to.slice(0, 23)}000Z` };
    const doc = computeSecurityReportDocument({ tenantId: PA, scope: { ...scope, tenant_id: PA }, seals: [{ seq: 0, statement_digest: `sha256:${'1'.repeat(64)}`,
      seal_digest: `sha256:${'2'.repeat(64)}`, window }], rows: [], decisions: [], platforms: {} });
    const b = buildSecurityReportStatement({ document: doc, asOf: at(T0 + 3 * MIN - 1000), builderVersion: BUILDER, previous: [] });
    const recordedAt = at(T0 + 3 * MIN);
    const canonicalRecord = buildCanonicalRecord({
      seq: 0, prev_hash: GENESIS_PREV_HASH, recorded_at: recordedAt, tenant_id: PA, record_kind: LEDGER_RECORD_KIND,
      statement_digest: b.statementDigest, predicate_type: SECURITY_PERIOD_REPORT_PREDICATE_TYPE, statement_kind: null,
      repository_id: null, subject_sha: null, outbox_subject_id: null,
    });
    const payload = Buffer.from(b.statementCanonical, 'utf8');
    const sig = cryptoSign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: w.k.a1.priv, dsaEncoding: 'der' });
    const envelope: DsseEnvelope = { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid: w.k.a1.keyid, sig: sig.toString('base64') }] };
    const record = { seq: 0, prevHash: GENESIS_PREV_HASH, recordHash: computeRecordHash(canonicalRecord, GENESIS_PREV_HASH), canonicalRecord, recordedAt,
      repositoryId: null, statementDigest: b.statementDigest, statementCanonical: b.statementCanonical, envelope,
      statementCanonicalAll: b.statementCanonical, envelopeAll: envelope } as unknown as ChainRecord;
    const packScope: PackScope = { repository_id: null, from: at(T0 + 2 * MIN), to: at(T0 + 8 * MIN) };
    const seg = segmentOf({ records: [record], anchors: [], batches: [] }, packScope, at(T0 + 20 * MIN));
    const pack = buildPack({ packId: PACK_1, tenantId: PA, scope: packScope, mode: 'full', segment: { ...seg, anchors: [], batches: [] }, trust: await w.material(PA) });
    const signature = await signPack(pack, w.resolver, PA, 'req-1');
    const download = JSON.parse(`{"pack":${pack.text},"signature":${JSON.stringify(signature)}}`);
    const report = verifyEvidencePack(download, { pinnedRootKeyids: [w.k.root.keyid], now: at(T0 + 25 * MIN), anchorWindowMs: 24 * 3600_000 });
    const check = (cid: string) => report.checks.find((c) => c.id === cid);
    assert.equal(check('statements')?.status, 'passed', JSON.stringify(check('statements')));
    assert.equal(check('chain')?.status, 'passed', JSON.stringify(check('chain')));
    assert.equal(check('reports')?.status, 'not_checkable');
    assert.equal(report.exit_code, 2);
  });
});
