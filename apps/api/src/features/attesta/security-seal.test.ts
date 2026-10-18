// Task15op-a (A15.15, gap G6): security-finding seals, the cadence, the break finders, the
// verify report's pure part and the ledger's two new predicate types, all without a database
// (docs/contracts/attesta/security-findings-seal.md, security-period-report.md).
// Pattern: audit-seal.test.ts (Task16e).
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalize, sha256Prefixed } from './canonical';
import { digestsRoot } from './period-report-rules';
import { IN_TOTO_PAYLOAD_TYPE, pae } from './dsse';
import {
  ATTESTA_STATEMENT_MAX_SIGNED_BYTES, AttestaLedgerError, SECURITY_FINDINGS_SEAL_PREDICATE_TYPE, SECURITY_PERIOD_REPORT_PREDICATE_TYPE,
  buildCanonicalRecord, chainStatement, deriveStatementColumns, type LedgerExecutor,
} from './ledger';
import {
  MAX_SECURITY_INSTANT_ROWS, MAX_SECURITY_SEAL_ROWS, SECURITY_ROW_KEYS, SECURITY_SEAL_EMPTY_INTERVAL_MS, nextMicrosecond, SECURITY_SEAL_MIN_INTERVAL_MS, assembleSecurityVerifyReport,
  buildSecuritySealDocument, buildSecuritySealStatement, checkSecuritySealRows, parseSecurityVerifyQuery,
  parseSecuritySealDocument, planSecuritySealWindow, rowFromDb, runSecuritySealPass, sealSecurityTenant, securityRowDigest,
  securitySealValidators, type ChainSecuritySealInput, type SecurityFindingRow, type SecuritySealStore,
  type SecurityVerifySeal, type StoredSecuritySeal,
} from './security-seal-service';
import { devSignerResolver } from './signer-resolver';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const MACHINE = '0a000000-0000-4000-8000-000000000001';
const REPO = '0c000000-0000-4000-8000-000000000001';
const id = (n: number) => `0f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const W = { from: '2026-10-18T06:00:00.000000Z', to: '2026-10-18T07:00:00.000000Z' };
const BUILDER = '0.1.0+abcdef0';
const AS_OF = '2026-10-18T07:20:00.000Z';

function v2Row(n: number, receivedAt: string, over: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    id: id(n), record_generation: 'v2', machine_id: MACHINE, repository_id: null, repository_kind: 'not_enrolled',
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
function task6aRow(n: number, receivedAt: string): SecurityFindingRow {
  return {
    ...v2Row(n, receivedAt), record_generation: 'task6a', repository_id: REPO, repository_kind: null,
    rule_id: 'trackai.exec.reverse_shell', rule_version: '1', rule_category: 'execution', rule_severity: 'critical',
    agent_family: 'opencode', source_agent: null, model: null, record_id: null, rule_pack_version: 'task6a-1',
    bundle_digest: null, lease_id: null, found_at_rest: null, phase: 'requested', timing: 'pre_action', result_category: 'not_observed',
    operating_system: 'macos', source_type: null, detected_at: null, numbat_schema_version: null, confidence: null,
    finding_id: `finding-${n}`, delivery_id: `delivery-${n}`, source_event_id: 'event-1', route_id: 'AC-CLI-03',
    host_surface: 'terminal', host_mode: 'cli', capture_channel: 'provider-plugin', native_effect: 'observe_only',
    activation: 'observed', availability: 'available', completeness: 'complete', client_version: '0.1.0',
  };
}

test('T15op seal: the row digest vector; extra columns never reach it; one microsecond is a different row', () => {
  const r = v2Row(1, '2026-10-18T06:05:00.456789Z');
  // Computed independently (Python json.dumps sort_keys, compact separators, UTF-8).
  assert.equal(securityRowDigest(r), 'sha256:5786f0be7d89a4e9a9c06cbcdf62403ffab9a28e0aff4bffa9ff2f49f5e352c9');
  // A title, tags or a preview read by mistake never changes the digest (metadata projection only).
  assert.equal(securityRowDigest({ ...r, title: 'AWS key in .env', tags: ['x'] } as SecurityFindingRow), securityRowDigest(r));
  assert.notEqual(securityRowDigest({ ...r, received_at: '2026-10-18T06:05:00.456790Z' }), securityRowDigest(r));
  assert.notEqual(securityRowDigest({ ...r, rule_severity: 'low' }), securityRowDigest(r));
  assert.notEqual(securityRowDigest({ ...r, found_at_rest: null }), securityRowDigest(r));
  // Every column but tenant_id, title and tags is sealed (review finding): confidence and detected_at too.
  assert.notEqual(securityRowDigest({ ...r, confidence: 'low' }), securityRowDigest(r));
  assert.notEqual(securityRowDigest({ ...r, detected_at: '2026-10-18T06:01:02.123001Z' }), securityRowDigest(r));
  assert.equal(SECURITY_ROW_KEYS.length, 45);
  assert.throws(() => securityRowDigest({ ...r, received_at: '2026-10-18T06:05:00.456Z' }), /microsecond/);
  // rowFromDb keeps the projection exact (booleans, nulls).
  assert.deepEqual(rowFromDb({ ...r, found_at_rest: true, model: undefined }), { ...r, found_at_rest: true, model: null });
});

test('T15op seal: the document is deterministic, valid and counts both generations', () => {
  const rows = [task6aRow(1, '2026-10-18T06:00:00.000000Z'), v2Row(2, '2026-10-18T06:10:00.000001Z'), v2Row(3, '2026-10-18T06:10:00.000001Z')];
  const a = buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows });
  const b = buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: rows.map((r) => ({ ...r })) });
  assert.equal(a.text, b.text);
  assert.equal(a.digest, sha256Prefixed(a.text));
  assert.deepEqual(a.document.generations, { task6a: 1, v2: 2 });
  assert.equal(a.document.count, 3);
  assert.ok(securitySealValidators().document(JSON.parse(a.text)), JSON.stringify(securitySealValidators().document.errors));
  // No session, model or rule text in the document: ids and digests only.
  assert.doesNotMatch(a.text, /sess-1|claude-x|aws_key|reverse_shell/);
  const empty = buildSecuritySealDocument({ tenantId: A, window: W, previous: a.digest, rows: [] });
  assert.equal(empty.document.rows_root, sha256Prefixed(Buffer.alloc(0)), 'the empty list root');
  assert.throws(() => buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: [rows[1], rows[0]] }), /order/);
  assert.throws(() => buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: [v2Row(9, W.to)] }), /outside/);
  assert.throws(() => buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: [{ ...rows[0], record_generation: 'v3' }] }), /generation/);
});

test('T15op seal: the statement chains as a security_findings_seal, never as an audit seal of another tenant', () => {
  const built = buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: [v2Row(1, '2026-10-18T06:10:00.000000Z')] });
  const statement = buildSecuritySealStatement({ document: built.document, documentDigest: built.digest, asOf: AS_OF, builderVersion: BUILDER });
  const c = deriveStatementColumns(statement);
  assert.equal(c.predicateType, SECURITY_FINDINGS_SEAL_PREDICATE_TYPE);
  assert.equal(c.repositoryId, null);
  assert.equal(c.subjectSha, null);
  assert.equal(c.tenantScope, A);
  assert.equal(c.subjectName, `trackai:tenant/${A}/security-findings/${W.from}..${W.to}`);
  const record = buildCanonicalRecord({
    seq: 3, prev_hash: `sha256:${'0'.repeat(64)}`, recorded_at: '2026-10-18T07:20:00.000Z', tenant_id: A,
    record_kind: 'statement', statement_digest: c.statementDigest, predicate_type: c.predicateType,
    statement_kind: null, repository_id: null, subject_sha: null, outbox_subject_id: null,
  });
  assert.match(record, /"repository_id":null,"seq":3,/);
  const forged = JSON.parse(statement) as { subject: Array<{ name: string }>; predicate: { tenant_id: string } };
  forged.subject[0].name = `trackai:tenant/${A}/audit/${W.from}..${W.to}`;
  assert.throws(() => deriveStatementColumns(canonicalize(forged)), /subject name/);
  // The statement is small whatever the row count: the 8 000-row cap bounds the document, not the signature.
  const big = Array.from({ length: MAX_SECURITY_SEAL_ROWS }, (_, i) =>
    v2Row(i + 1, `2026-10-18T06:${String(10 + Math.floor(i / 1000)).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}000Z`));
  const full = buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: big });
  assert.ok(full.text.length <= 1_048_576 + 1024, `an 8 000-row document stays near 1 MiB (${full.text.length})`);
  const fullStatement = buildSecuritySealStatement({ document: full.document, documentDigest: full.digest, asOf: AS_OF, builderVersion: BUILDER });
  assert.ok(pae(IN_TOTO_PAYLOAD_TYPE, Buffer.from(fullStatement)).length < 4096);
  assert.ok(pae(IN_TOTO_PAYLOAD_TYPE, Buffer.from(fullStatement)).length < ATTESTA_STATEMENT_MAX_SIGNED_BYTES);
  assert.throws(() => buildSecuritySealDocument({ tenantId: A, window: W, previous: null, rows: [...big, v2Row(99_999, '2026-10-18T06:59:00.000000Z')] }), /too many/);
});

test('T15op ledger: a security period report derives its columns for tenant and repository scope', () => {
  const statement = (repositoryId: string | null, name?: string) => canonicalize({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: name ?? `trackai:tenant/${A}${repositoryId ? `/repository/${repositoryId}` : ''}/security-period/2026-10-01T00:00:00.000Z..2026-10-02T00:00:00.000Z`,
      digest: { sha256: 'c'.repeat(64) } }],
    predicateType: SECURITY_PERIOD_REPORT_PREDICATE_TYPE,
    predicate: { scope: { tenant_id: A, repository_id: repositoryId, from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', basis: 'received_at' }, previous: [] },
  });
  const tenant = deriveStatementColumns(statement(null));
  assert.equal(tenant.predicateType, SECURITY_PERIOD_REPORT_PREDICATE_TYPE);
  assert.equal(tenant.repositoryId, null);
  assert.equal(tenant.tenantScope, A);
  assert.equal(deriveStatementColumns(statement(REPO)).repositoryId, REPO);
  assert.throws(() => deriveStatementColumns(statement(REPO, `trackai:tenant/${A}/security-period/2026-10-01T00:00:00.000Z..2026-10-02T00:00:00.000Z`)), /subject name/);
});

test('T15op ledger: Company A cannot chain a seal or a report that names Company B', async () => {
  const built = buildSecuritySealDocument({ tenantId: B, window: W, previous: null, rows: [] });
  const statementCanonical = buildSecuritySealStatement({ document: built.document, documentDigest: built.digest, asOf: AS_OF, builderVersion: BUILDER });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  const { sign } = await import('node:crypto');
  const payload = Buffer.from(statementCanonical, 'utf8');
  const sig = sign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: privateKey, dsaEncoding: 'der' });
  const keyid = sha256Prefixed(spki);
  const tx: LedgerExecutor = { execute: async () => { throw new Error('no query may run'); } };
  await assert.rejects(chainStatement(tx, {
    tenantId: A, statementCanonical, credentialId: 'dev:a',
    envelope: { payload: payload.toString('base64'), payloadType: IN_TOTO_PAYLOAD_TYPE, signatures: [{ keyid, sig: sig.toString('base64') }] },
    keyid, signatureDer: sig, publicKeySpkiDer: spki, previousSeen: [],
  }), (err: unknown) => err instanceof AttestaLedgerError && /another tenant/.test(err.message));
});

test('T15op seal: the cadence plans first, hourly, daily-empty, --now and chunked windows', () => {
  const cutoff = '2026-10-18T09:00:00.000000Z';
  const rows = [v2Row(1, '2026-10-18T06:30:00.000000Z'), v2Row(2, '2026-10-18T08:30:00.000000Z')];
  const first = planSecuritySealWindow({ cutoff, last: null, earliest: rows[0].received_at, rows });
  assert.deepEqual(first?.window, { from: rows[0].received_at, to: cutoff });
  assert.equal(first?.rows.length, 2);
  assert.equal(planSecuritySealWindow({ cutoff, last: null, earliest: null, rows: [] }), null, 'no rows, no first seal');
  const last = { windowTo: '2026-10-18T08:00:00.000000Z', digest: `sha256:${'d'.repeat(64)}`, ageMs: 10 * 60_000 };
  assert.equal(planSecuritySealWindow({ cutoff, last, earliest: null, rows }), null, 'rows, but the last seal is recent');
  assert.equal(planSecuritySealWindow({ cutoff, last: { ...last, ageMs: SECURITY_SEAL_MIN_INTERVAL_MS }, earliest: null, rows })?.rows.length, 1);
  assert.equal(planSecuritySealWindow({ cutoff, last: { ...last, ageMs: SECURITY_SEAL_MIN_INTERVAL_MS }, earliest: null, rows: [] }), null);
  assert.equal(planSecuritySealWindow({ cutoff, last: { ...last, ageMs: SECURITY_SEAL_EMPTY_INTERVAL_MS }, earliest: null, rows: [] })?.rows.length, 0);
  // --now: rows at once; an empty window only when the last `to` is at least a minute behind.
  assert.equal(planSecuritySealWindow({ cutoff, last, earliest: null, rows, now: true })?.rows.length, 1);
  assert.equal(planSecuritySealWindow({ cutoff, last, earliest: null, rows: [], now: true })?.window.to, cutoff);
  assert.equal(planSecuritySealWindow({ cutoff, last: { ...last, windowTo: '2026-10-18T08:59:30.000000Z' }, earliest: null, rows: [], now: true }), null);
  // The rest of a backlog after a full chunk is due at once; never an empty window.
  assert.equal(planSecuritySealWindow({ cutoff, last, earliest: null, rows, backlog: true })?.rows.length, 1);
  assert.equal(planSecuritySealWindow({ cutoff, last, earliest: null, rows: [], backlog: true }), null);
  // More rows than a seal holds: `to` is the first row that does not fit, a backlog is always due.
  const many = Array.from({ length: MAX_SECURITY_SEAL_ROWS + 5 }, (_, i) => v2Row(i + 1, `2026-10-18T08:${String(10 + Math.floor(i / 1000)).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}000Z`));
  const chunk = planSecuritySealWindow({ cutoff, last, earliest: null, rows: many });
  assert.equal(chunk?.rows.length, MAX_SECURITY_SEAL_ROWS);
  assert.equal(chunk?.window.to, many[MAX_SECURITY_SEAL_ROWS].received_at);
  assert.equal(chunk?.chunked, true);
  assert.equal(first?.chunked, false);
  // Rows sharing one instant are never split: the planner names the instant, and given that
  // instant's rows it seals the instant alone, [from, instant + 1 µs), up to the hard ceiling.
  const instant = '2026-10-18T08:30:00.000000Z';
  const same = Array.from({ length: MAX_SECURITY_SEAL_ROWS + 1 }, (_, i) => v2Row(i + 1, instant));
  assert.throws(() => planSecuritySealWindow({ cutoff, last, earliest: null, rows: same }),
    (err: unknown) => (err as { code?: string; instant?: string }).code === 'ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW'
      && (err as { instant?: string }).instant === instant);
  const alone = planSecuritySealWindow({ cutoff, last: { ...last, windowTo: '2026-10-18T08:20:00.000000Z' }, earliest: null, rows: same,
    instantRows: [...same, v2Row(99_000, instant)] });
  assert.deepEqual(alone?.window, { from: '2026-10-18T08:20:00.000000Z', to: '2026-10-18T08:30:00.000001Z' });
  assert.equal(alone?.rows.length, MAX_SECURITY_SEAL_ROWS + 2);
  assert.equal(alone?.chunked, true);
  const tooMany = Array.from({ length: MAX_SECURITY_INSTANT_ROWS + 1 }, (_, i) => ({ ...same[0], id: id(i + 1) }));
  assert.throws(() => planSecuritySealWindow({ cutoff, last, earliest: null, rows: same, instantRows: tooMany }), /one instant/);
  assert.equal(nextMicrosecond('2026-10-18T08:30:00.999999Z'), '2026-10-18T08:30:01.000000Z');
  assert.equal(nextMicrosecond('2026-12-31T23:59:59.999999Z'), '2027-01-01T00:00:00.000000Z');
  assert.equal(nextMicrosecond('2026-10-18T08:30:00.000123Z'), '2026-10-18T08:30:00.000124Z');
});

function stored(tenantId: string, rows: SecurityFindingRow[], previous: string | null = null, window = W): StoredSecuritySeal & { doc: ReturnType<typeof buildSecuritySealDocument> } {
  const doc = buildSecuritySealDocument({ tenantId, window, previous, rows });
  return { tenantId, windowFrom: window.from, windowTo: window.to, rowCount: doc.document.count,
    task6aCount: doc.document.generations.task6a, v2Count: doc.document.generations.v2, previousDigest: previous,
    sealDocument: doc.text, sealDigest: doc.digest, doc };
}

test('T15op seal: every tamper class is found (missing, changed, late insert) and a tampered document is refused', () => {
  const rows = [task6aRow(1, '2026-10-18T06:00:00.000000Z'), v2Row(2, '2026-10-18T06:10:00.000000Z'), v2Row(3, '2026-10-18T06:20:00.000000Z')];
  const s = stored(A, rows);
  const doc = parseSecuritySealDocument(s);
  assert.ok(doc);
  assert.deepEqual(checkSecuritySealRows(doc, s.sealDigest, rows), []);
  const current = [rows[0], { ...rows[2], rule_severity: 'low' }, v2Row(4, '2026-10-18T06:30:00.000000Z')];
  assert.deepEqual(checkSecuritySealRows(doc, s.sealDigest, current), [
    { kind: 'missing_row', seal: s.sealDigest, row_id: id(2) },
    { kind: 'changed_row', seal: s.sealDigest, row_id: id(3) },
    { kind: 'unsealed_row_in_sealed_window', seal: s.sealDigest, row_id: id(4) },
  ]);
  // The stored document must hash to its digest and agree with its columns.
  assert.equal(parseSecuritySealDocument({ ...s, sealDocument: s.sealDocument.replace('"count":3', '"count":2') }), null);
  assert.equal(parseSecuritySealDocument({ ...s, v2Count: 1, task6aCount: 2 }), null);
  assert.equal(parseSecuritySealDocument({ ...s, tenantId: B }), null, 'a seal moved to Company B no longer parses there');
});

test('T15op seal: a crafted seal (reordered rows, swapped generation counts, a false one-instant seal) is a statement problem (Codex review)', () => {
  const rows = [task6aRow(1, '2026-10-18T06:00:00.000000Z'), v2Row(2, '2026-10-18T06:10:00.000000Z'), v2Row(3, '2026-10-18T06:20:00.000000Z')];
  const honest = stored(A, rows);
  // Re-sign-able forgeries: the document stays schema-valid and self-consistent (root recomputed).
  const forge = (mutate: (d: Record<string, any>) => void): ReturnType<typeof stored> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = JSON.parse(honest.sealDocument) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    mutate(d);
    d.rows_root = digestsRoot(d.rows.map((r: { digest: string }) => r.digest));
    const text = canonicalize(d);
    return { ...honest, sealDocument: text, sealDigest: sha256Prefixed(text), task6aCount: d.generations.task6a, v2Count: d.generations.v2,
      rowCount: d.count, windowTo: d.window.to, doc: { document: d as never, text, digest: sha256Prefixed(text) } };
  };
  const kinds = (s: ReturnType<typeof stored>, current: SecurityFindingRow[]) => {
    const doc = parseSecuritySealDocument(s);
    assert.ok(doc, 'the forged document parses: only the rows can expose it');
    return checkSecuritySealRows(doc, s.sealDigest, current).map((b) => b.kind);
  };
  assert.deepEqual(kinds(honest, rows), []);
  assert.deepEqual(kinds(forge((d) => { d.rows = [d.rows[1], d.rows[0], d.rows[2]]; }), rows), ['statement_problem'], 'rows out of (received_at, id) order');
  assert.deepEqual(kinds(forge((d) => { d.generations = { task6a: 2, v2: 1 }; }), rows), ['statement_problem'], 'generation counts that still sum');
  // More than 8 000 rows that do not share one instant, claimed as a one-instant seal.
  const many = Array.from({ length: MAX_SECURITY_SEAL_ROWS + 1 }, (_, i) => v2Row(i + 1, `2026-10-18T06:30:00.${String(i).padStart(6, '0')}Z`));
  const wide = { from: W.from, to: '2026-10-18T06:30:00.008001Z' };
  const wideDoc = (() => {
    const d = { format: 'https://trackai.dev/attesta/security-findings-seal-document/v1', tenant_id: A, window: wide, previous: null,
      count: many.length, generations: { task6a: 0, v2: many.length }, rows: many.map((r) => ({ id: r.id, digest: securityRowDigest(r) })),
      rows_root: digestsRoot(many.map((r) => securityRowDigest(r))) };
    const text = canonicalize(d);
    return { tenantId: A, windowFrom: wide.from, windowTo: wide.to, rowCount: many.length, task6aCount: 0, v2Count: many.length,
      previousDigest: null, sealDocument: text, sealDigest: sha256Prefixed(text) };
  })();
  const parsedWide = parseSecuritySealDocument(wideDoc);
  assert.ok(parsedWide);
  assert.deepEqual(checkSecuritySealRows(parsedWide, wideDoc.sealDigest, many).map((b) => b.kind), ['statement_problem'], 'over the cap, not one instant');
  // The honest one-instant seal passes.
  const instant = '2026-10-18T06:30:00.000000Z';
  const same = many.map((r) => ({ ...r, received_at: instant }));
  const alone = buildSecuritySealDocument({ tenantId: A, window: { from: W.from, to: nextMicrosecond(instant) }, previous: null, rows: same });
  assert.deepEqual(checkSecuritySealRows(alone.document, alone.digest, same), []);
  // In the report the forged seal is not ok, even with every row present and unchanged.
  const forged = forge((d) => { d.rows = [d.rows[1], d.rows[0], d.rows[2]]; });
  const statementCanonical = buildSecuritySealStatement({ document: forged.doc.document, documentDigest: forged.sealDigest, asOf: AS_OF, builderVersion: BUILDER });
  const report = assembleSecurityVerifyReport(parseSecurityVerifyQuery({ from: '2026-10-18T05:00:00Z', to: '2026-10-18T08:00:00Z' }), {
    seals: [{ ...forged, seq: 0, statementCanonical, recordStatementDigest: sha256Prefixed(statementCanonical), statementDigest: sha256Prefixed(statementCanonical) }],
    predecessor: null, rowsBySeal: new Map([[forged.sealDigest, rows]]), tail: { from: W.to, count: 0 }, orphans: [], beforeFirst: null,
  }, { ok: true, checked: 1, problems: new Set() });
  assert.equal(report.ok, false);
  assert.deepEqual(report.breaks.map((b) => b.kind), ['statement_problem']);
});

test('T15op verify: the pure report is ok on an honest snapshot and names links, orphans and back-dated rows', () => {
  const rows = [v2Row(1, '2026-10-18T06:10:00.000000Z')];
  const s1 = stored(A, rows);
  const W2 = { from: W.to, to: '2026-10-18T08:00:00.000000Z' };
  const s2 = stored(A, [], s1.sealDigest, W2);
  const statementOf = (s: ReturnType<typeof stored>) => buildSecuritySealStatement({ document: s.doc.document, documentDigest: s.sealDigest, asOf: AS_OF, builderVersion: BUILDER });
  const seal = (s: ReturnType<typeof stored>, seq: number): SecurityVerifySeal => {
    const statementCanonical = statementOf(s);
    return { ...s, seq, statementCanonical, recordStatementDigest: sha256Prefixed(statementCanonical), statementDigest: sha256Prefixed(statementCanonical) };
  };
  const q = parseSecurityVerifyQuery({ from: '2026-10-18T05:00:00Z', to: '2026-10-18T09:00:00Z' });
  const snap = {
    seals: [seal(s1, 0), seal(s2, 1)], predecessor: null, rowsBySeal: new Map([[s1.sealDigest, rows], [s2.sealDigest, []]]),
    tail: { from: W2.to, count: 2 }, orphans: [], beforeFirst: null,
  };
  const ok = assembleSecurityVerifyReport(q, snap, { ok: true, checked: 2, problems: new Set() });
  assert.equal(ok.ok, true, JSON.stringify(ok.breaks));
  assert.equal(ok.seals_checked, 2);
  assert.deepEqual(ok.unsealed_tail, { from: W2.to, count: 2 }, 'the tail is reported, never verified, never a break');
  // A seal whose statement is another seal's, a removed seal, a back-dated row, a broken link.
  const bad = assembleSecurityVerifyReport(q, {
    ...snap,
    seals: [seal(s1, 0), { ...seal(s2, 1), statementCanonical: statementOf(s1), recordStatementDigest: sha256Prefixed(statementOf(s1)), statementDigest: sha256Prefixed(statementOf(s1)) }],
    orphans: [`sha256:${'e'.repeat(64)}`], beforeFirst: { seal: s1.sealDigest, rowIds: [id(9)] },
  }, { ok: true, checked: 2, problems: new Set() });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.breaks.map((b) => b.kind).sort(), ['broken_previous', 'statement_problem', 'unsealed_row_in_sealed_window']);
  const unlinked = assembleSecurityVerifyReport(q, { ...snap, seals: [seal(s2, 1)] }, { ok: true, checked: 1, problems: new Set() });
  assert.deepEqual(unlinked.breaks.map((b) => b.kind), ['broken_previous'], 'a first listed seal with a previous needs its predecessor');
  // A chain problem on the seal's own record is a statement problem; an unchecked chain is never ok.
  assert.equal(assembleSecurityVerifyReport(q, snap, { ok: false, checked: 2, problems: new Set([s1.sealDigest]) }).breaks[0].kind, 'statement_problem');
  assert.equal(assembleSecurityVerifyReport(q, snap, { ok: false, checked: 2, problems: new Set() }).ok, false);
  assert.equal(assembleSecurityVerifyReport(q, { ...snap, rowsTruncated: true }, { ok: true, checked: 2, problems: new Set() }).breaks_truncated, true,
    'a window with more rows than one report reads says the list was cut');
  assert.throws(() => parseSecurityVerifyQuery({ from: '2026-10-18T05:00:00Z', to: '2026-12-18T05:00:00Z' }), /span/);
  assert.throws(() => parseSecurityVerifyQuery({ from: '2026-10-18T05:00:00Z', to: '2026-10-18T06:00:00Z', tenant: B }), /unknown/);
});

/** An in-memory store: one tenant's rows, the seal rows it chained, the audit events. */
function memoryStore(rowsByTenant: Map<string, SecurityFindingRow[]>, cutoffAt: string | (() => string)) {
  const cutoffOf = typeof cutoffAt === 'string' ? () => cutoffAt : cutoffAt;
  const seals = new Map<string, Array<ChainSecuritySealInput & { createdAtMs: number }>>();
  const store: SecuritySealStore = {
    tenantsWithFindings: async () => [...rowsByTenant.keys()].sort(),
    async readSnapshot(tenantId, options) {
      const mine = seals.get(tenantId) ?? [];
      const lastSeal = mine[mine.length - 1];
      const rows = (rowsByTenant.get(tenantId) ?? []).slice().sort((x, y) => (x.received_at < y.received_at ? -1 : x.received_at > y.received_at ? 1 : x.id < y.id ? -1 : 1));
      const from = lastSeal ? lastSeal.plan.window.to : rows[0]?.received_at ?? null;
      const cutoff = cutoffOf();
      const input = {
        cutoff,
        last: lastSeal ? { windowTo: lastSeal.plan.window.to, digest: lastSeal.documentDigest, ageMs: Date.now() - lastSeal.createdAtMs } : null,
        earliest: lastSeal ? null : from,
        rows: from === null ? [] : rows.filter((r) => r.received_at >= from && r.received_at < cutoff).slice(0, MAX_SECURITY_SEAL_ROWS + 1),
        now: options.now,
        backlog: options.backlog,
      };
      try {
        return { asOf: AS_OF, plan: planSecuritySealWindow(input) };
      } catch (err) {
        const instant = (err as { instant?: string }).instant;
        if (!instant) throw err;
        return { asOf: AS_OF, plan: planSecuritySealWindow({ ...input, instantRows: rows.filter((r) => r.received_at === instant) }) };
      }
    },
    async chainSeal(input) {
      const mine = seals.get(input.tenantId) ?? [];
      const lastSeal = mine[mine.length - 1];
      if ((lastSeal?.documentDigest ?? null) !== input.plan.previous) return 'stale';
      mine.push({ ...input, createdAtMs: Date.now() });
      seals.set(input.tenantId, mine);
      return { sealId: `seal-${mine.length}`, seq: mine.length - 1 };
    },
  };
  return { store, seals };
}

test('T15op seal: the round trip signs one verifiable statement per due window, per tenant, idempotently', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rowsA = [task6aRow(1, '2026-10-18T06:00:00.000000Z'), v2Row(2, '2026-10-18T06:10:00.000000Z')];
  const rowsB = [v2Row(3, '2026-10-18T06:20:00.000000Z')];
  const { store, seals } = memoryStore(new Map([[A, rowsA], [B, rowsB]]), '2026-10-18T07:00:00.000000Z');
  const deps = { store, resolver: devSignerResolver({ sharedKeyPem: pem, env: {} }), builderVersion: BUILDER,
    actor: { type: 'system_operator' as const, id: 'test' }, log: () => undefined };
  const dry = await runSecuritySealPass(deps, { dryRun: true });
  assert.deepEqual(dry.map((r) => r.outcome), ['would_seal', 'would_seal']);
  assert.equal(seals.size, 0, 'a dry run writes nothing');
  const done = await runSecuritySealPass(deps);
  assert.deepEqual(done.map((r) => [r.tenantId, r.outcome, r.count]), [[A, 'sealed', 2], [B, 'sealed', 1]]);
  assert.deepEqual(done[0].generations, { task6a: 1, v2: 1 });
  const again = await runSecuritySealPass(deps);
  assert.deepEqual(again.map((r) => r.outcome), ['not_due', 'not_due'], 'a second run is not due');
  for (const [tenantId, mine] of seals) {
    const s = mine[0];
    // The envelope signs exactly the statement; the statement names this tenant's document.
    assert.equal(Buffer.from(s.envelope.payload, 'base64').toString('utf8'), s.statementCanonical);
    assert.ok(verify('sha256', pae(IN_TOTO_PAYLOAD_TYPE, Buffer.from(s.statementCanonical)),
      { key: createPublicKey(privateKey), dsaEncoding: 'der' }, s.signatureDer));
    const columns = deriveStatementColumns(s.statementCanonical);
    assert.equal(columns.tenantScope, tenantId);
    assert.equal(JSON.parse(s.statementCanonical).subject[0].digest.sha256, s.documentDigest.slice(7));
    assert.equal(JSON.parse(s.documentText).tenant_id, tenantId);
    assert.ok(securitySealValidators().statement(JSON.parse(s.statementCanonical)));
  }
  // Company A's document holds only A's rows.
  assert.deepEqual(JSON.parse(seals.get(A)![0].documentText).rows.map((r: { id: string }) => r.id), [id(1), id(2)]);
});

test('T15op seal: a backlog over one seal is sealed back to back in one pass (8 000 + 3)', async () => {
  const many = Array.from({ length: MAX_SECURITY_SEAL_ROWS + 3 }, (_, i) =>
    v2Row(i + 1, `2026-10-18T06:${String(10 + Math.floor(i / 1000)).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}000Z`));
  const { store, seals } = memoryStore(new Map([[A, many]]), '2026-10-18T07:00:00.000000Z');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const resolver = devSignerResolver({ sharedKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), env: {} });
  const r = await runSecuritySealPass({ store, resolver, builderVersion: BUILDER, actor: { type: 'system_operator', id: 't' }, log: () => undefined });
  assert.deepEqual(r.map((x) => [x.outcome, x.count]), [['sealed', MAX_SECURITY_SEAL_ROWS], ['sealed', 3]]);
  const [first, second] = seals.get(A)!;
  assert.equal(second.plan.previous, first.documentDigest);
  assert.equal(second.plan.window.from, first.plan.window.to);
});

test('T15op seal: the pass continues only after a chunked seal, not on a moving cutoff (review finding)', async () => {
  const rows = [v2Row(1, '2026-10-18T06:10:00.000000Z')];
  let cutoffMs = Date.parse('2026-10-18T07:00:00.000Z');
  const store = memoryStore(new Map([[A, rows]]), () => {
    // Each read sees a later cutoff and one more row just before it, as on a busy tenant.
    const at = `${new Date(cutoffMs).toISOString().slice(0, 23)}000Z`;
    rows.push(v2Row(rows.length + 1, at));
    cutoffMs += 500;
    return `${new Date(cutoffMs).toISOString().slice(0, 23)}000Z`;
  });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const resolver = devSignerResolver({ sharedKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), env: {} });
  const r = await runSecuritySealPass({ store: store.store, resolver, builderVersion: BUILDER, actor: { type: 'system_operator', id: 't' }, log: () => undefined });
  assert.deepEqual(r.map((x) => x.outcome), ['sealed'], 'one seal per pass, no string of tiny windows');
  assert.equal(store.seals.get(A)?.length, 1);
});

test('T15op seal: no key, an over-limit signer and an instant overflow fail closed with their codes', async () => {
  const rows = [v2Row(1, '2026-10-18T06:00:00.000000Z')];
  const { store } = memoryStore(new Map([[A, rows]]), '2026-10-18T07:00:00.000000Z');
  const base = { store, builderVersion: BUILDER, actor: { type: 'system_operator' as const, id: 'test' }, log: () => undefined };
  assert.equal((await sealSecurityTenant({ ...base, resolver: { resolve: async () => null } }, A)).outcome, 'no_key');
  const tiny = { capabilities: () => ({ maxPayloadBytes: 64 }), sign: async () => { throw new Error('must not sign'); } };
  const r = await sealSecurityTenant({ ...base, resolver: { resolve: async () => ({ adapter: tiny, credentialId: 'tiny' }) } as never }, A);
  assert.deepEqual([r.outcome, r.code], ['failed', 'ATTESTA_BUILDER_TOO_LARGE']);
  const same = Array.from({ length: MAX_SECURITY_SEAL_ROWS + 1 }, (_, i) => v2Row(i + 1, '2026-10-18T06:30:00.000000Z'));
  const overflow = memoryStore(new Map([[A, same]]), '2026-10-18T07:00:00.000000Z');
  const o = await sealSecurityTenant({ ...base, store: overflow.store, resolver: { resolve: async () => null } }, A, { dryRun: true });
  assert.deepEqual([o.outcome, o.count, o.window?.to], ['would_seal', MAX_SECURITY_SEAL_ROWS + 1, '2026-10-18T06:30:00.000001Z'],
    'an instant over the cap is sealed alone, not refused');
  const lines: string[] = [];
  const failing = { ...base, log: (l: string) => lines.push(l), resolver: { resolve: async () => null },
    store: { ...overflow.store, readSnapshot: async () => { const e = new (await import('./security-seal-service')).SecuritySealError('ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW', 'x'); e.instant = '2026-10-18T06:30:00.000000Z'; throw e; } } };
  const f = await sealSecurityTenant(failing, A);
  assert.deepEqual([f.outcome, f.code], ['failed', 'ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW']);
  assert.match(lines[0], /instant=2026-10-18T06:30:00\.000000Z/, 'an alertable line names the instant, never row content');
});

test('T15op contract: the security fixtures meet their schemas and expectations', () => {
  const dir = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'contracts', 'attesta', 'security-fixtures');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { cases: Array<{ file: string; schema: 'document' | 'statement'; valid: boolean }> };
  assert.deepEqual(manifest.cases.map((c) => c.file).sort(), readdirSync(dir).filter((f) => f !== 'manifest.json').sort());
  const v = securitySealValidators();
  for (const c of manifest.cases) {
    const value = JSON.parse(readFileSync(join(dir, c.file), 'utf8')) as unknown;
    assert.equal(v[c.schema](value), c.valid, `${c.file}: ${JSON.stringify(v[c.schema].errors)}`);
  }
});
