// Task16e (A16.4, A16.7): audit seals, the verify report's break finders and the signed
// audit export, all without a database (docs/contracts/attesta/audit-seal.md,
// docs/contracts/audit/export.md).
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  MAX_SEAL_ROWS, SEAL_EMPTY_INTERVAL_MS, SEAL_MIN_INTERVAL_MS, auditRowDigest, buildSealDocument, buildSealStatement,
  checkSealLinks, checkSealRows, parseSealDocument, planSealWindow, sealValidators, type StoredAuditRow,
} from './audit-seal-service';
import { canonicalize, sha256Prefixed } from './canonical';
import { pae } from './dsse';
import { AUDIT_SEAL_PREDICATE_TYPE, buildCanonicalRecord, deriveStatementColumns } from './ledger';
import { devSignerResolver } from './signer-resolver';
import {
  AUDIT_EXPORT_PAYLOAD_TYPE, buildAuditExport, coveredRange, exportSignaturePayload, parseExportRequest, signExport,
  type ExportSnapshot,
} from '../audit/export-service';
import { assembleVerifyReport, parseAuditVerifyQuery, type VerifySeal } from '../audit/verify-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `0b7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, at: string, details: Record<string, unknown> = { request_id: `r${n}` }): StoredAuditRow => ({
  id: id(n), action: 'audit.events.read', actor_type: 'tenant_auditor', actor_id: 'sub-1',
  target_type: 'security_audit_events', target_id: TENANT, details, occurred_at: at,
});
const W = { from: '2026-10-15T06:00:00.000000Z', to: '2026-10-15T07:00:00.000000Z' };
const BUILDER = '0.1.0+abcdef0';

test('T16e seal: the row digest vector (microsecond text, nested details, key order, unicode)', () => {
  const r: StoredAuditRow = {
    id: id(1), action: 'attesta.verify', actor_type: 'tenant_auditor', actor_id: 'sub-1', target_type: 'attesta_chain',
    target_id: '0-5', occurred_at: '2026-10-15T06:01:02.123456Z',
    details: { request_id: 'r1', ok: true, checked: 6, break_count: 0, nested: { z: [1, 2, { b: 'é', a: null }], a: 'x' } },
  };
  // Computed independently (Python json.dumps sort_keys, compact separators, UTF-8).
  assert.equal(auditRowDigest(r), 'sha256:b6d2676ae1f62fbe732a03c23906d4a8860b2bf7ce178e25172d30dd84f8efe2');
  // Derived fields and stray columns never change the digest.
  assert.equal(auditRowDigest({ ...r, severity: 'info', catalog_version: 2 } as StoredAuditRow), auditRowDigest(r));
  // One microsecond is a different row.
  assert.notEqual(auditRowDigest({ ...r, occurred_at: '2026-10-15T06:01:02.123457Z' }), auditRowDigest(r));
  assert.throws(() => auditRowDigest({ ...r, occurred_at: '2026-10-15T06:01:02.123Z' }), /microsecond/);
});

test('T16e seal: the document is deterministic and valid; the statement chains as an audit_seal', () => {
  const rows = [row(1, '2026-10-15T06:00:00.000000Z'), row(2, '2026-10-15T06:10:00.000001Z'), row(3, '2026-10-15T06:10:00.000001Z')];
  const a = buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows });
  const b = buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows: rows.map((r) => ({ ...r, details: { ...(r.details as Record<string, unknown>) } })) });
  assert.equal(a.text, b.text);
  assert.equal(a.digest, sha256Prefixed(a.text));
  assert.equal(a.document.count, 3);
  assert.ok(sealValidators().document(JSON.parse(a.text)));
  const empty = buildSealDocument({ tenantId: TENANT, window: W, previous: a.digest, rows: [] });
  assert.equal(empty.document.rows_root, sha256Prefixed(Buffer.alloc(0)), 'the empty list root');
  // Out of order, or outside the window, is refused.
  assert.throws(() => buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows: [rows[1], rows[0]] }), /order/);
  assert.throws(() => buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows: [row(9, W.to)] }), /outside/);

  const statement = buildSealStatement({ document: a.document, documentDigest: a.digest, asOf: '2026-10-15T07:10:00.000Z', builderVersion: BUILDER });
  const c = deriveStatementColumns(statement);
  assert.equal(c.predicateType, AUDIT_SEAL_PREDICATE_TYPE);
  assert.equal(c.repositoryId, null);
  assert.equal(c.subjectSha, null);
  assert.equal(c.tenantScope, TENANT);
  assert.equal(c.subjectName, `trackai:tenant/${TENANT}/audit/${W.from}..${W.to}`);
  // The record carries "repository_id":null (the 0023 guard rebuilds exactly these bytes).
  const record = buildCanonicalRecord({
    seq: 7, prev_hash: `sha256:${'0'.repeat(64)}`, recorded_at: '2026-10-15T07:10:00.000Z', tenant_id: TENANT,
    record_kind: 'statement', statement_digest: c.statementDigest, predicate_type: c.predicateType,
    statement_kind: null, repository_id: null, subject_sha: null, outbox_subject_id: null,
  });
  assert.match(record, /"repository_id":null,"seq":7,/);
  // A subject that names another window or tenant is refused by the ledger.
  const forged = JSON.parse(statement) as { subject: Array<{ name: string }> };
  forged.subject[0].name = `trackai:tenant/${TENANT}/audit/${W.from}..2026-10-15T08:00:00.000000Z`;
  assert.throws(() => deriveStatementColumns(canonicalize(forged)), /subject name/);
});

test('T16e seal: the cadence plans first, hourly, daily-empty and chunked windows', () => {
  const cutoff = '2026-10-15T09:00:00.000000Z';
  const rows = [row(1, '2026-10-15T06:30:00.000000Z'), row(2, '2026-10-15T08:00:00.000000Z')];
  // First seal: from the earliest row, everything before the cutoff.
  const first = planSealWindow({ cutoff, last: null, earliest: rows[0].occurred_at, rows });
  assert.deepEqual(first?.window, { from: rows[0].occurred_at, to: cutoff });
  assert.equal(first?.previous, null);
  assert.equal(first?.rows.length, 2);
  assert.equal(planSealWindow({ cutoff, last: null, earliest: null, rows: [] }), null, 'no rows, no first seal');
  const last = { windowTo: '2026-10-15T07:00:00.000000Z', digest: `sha256:${'c'.repeat(64)}` };
  // Rows, but the last seal is younger than an hour: not due.
  assert.equal(planSealWindow({ cutoff, last: { ...last, ageMs: SEAL_MIN_INTERVAL_MS - 1 }, earliest: null, rows }), null);
  const hourly = planSealWindow({ cutoff, last: { ...last, ageMs: SEAL_MIN_INTERVAL_MS }, earliest: null, rows });
  assert.deepEqual(hourly?.window, { from: last.windowTo, to: cutoff });
  assert.equal(hourly?.previous, last.digest);
  assert.deepEqual(hourly?.rows.map((r) => r.id), [id(2)]);
  // No rows: only once a day.
  assert.equal(planSealWindow({ cutoff, last: { ...last, ageMs: SEAL_EMPTY_INTERVAL_MS - 1 }, earliest: null, rows: [] }), null);
  assert.equal(planSealWindow({ cutoff, last: { ...last, ageMs: SEAL_EMPTY_INTERVAL_MS }, earliest: null, rows: [] })?.rows.length, 0);
  // A backlog beyond the bound: `to` is the first row that does not fit; ties stay together.
  const many: StoredAuditRow[] = [];
  for (let i = 0; i < MAX_SEAL_ROWS + 1; i += 1) {
    const us = String(Math.min(i, MAX_SEAL_ROWS - 2)).padStart(6, '0');
    many.push(row(i + 10, `2026-10-15T06:00:00.${us}Z`));
  }
  const chunk = planSealWindow({ cutoff, last: null, earliest: many[0].occurred_at, rows: many });
  assert.equal(chunk?.window.to, many[MAX_SEAL_ROWS].occurred_at);
  assert.equal(chunk?.rows.length, MAX_SEAL_ROWS - 2, 'the three rows sharing the boundary instant wait for the next seal');
});

test('T16e verify: every break kind is found from in-memory fixtures', () => {
  const rows = [row(1, '2026-10-15T06:00:00.000000Z'), row(2, '2026-10-15T06:10:00.000000Z'), row(3, '2026-10-15T06:20:00.000000Z')];
  const seal1 = buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows });
  const W2 = { from: W.to, to: '2026-10-15T08:00:00.000000Z' };
  const seal2 = buildSealDocument({ tenantId: TENANT, window: W2, previous: seal1.digest, rows: [] });
  const stored = (b: ReturnType<typeof buildSealDocument>, previous: string | null): VerifySeal => {
    const statement = buildSealStatement({ document: b.document, documentDigest: b.digest, asOf: '2026-10-15T08:10:00.000Z', builderVersion: BUILDER });
    return {
      tenantId: TENANT, windowFrom: b.document.window.from, windowTo: b.document.window.to, rowCount: b.document.count,
      previousDigest: previous, sealDocument: b.text, sealDigest: b.digest, seq: 1, statementCanonical: statement,
      statementDigest: sha256Prefixed(statement), recordStatementDigest: sha256Prefixed(statement),
    };
  };
  const s1 = stored(seal1, null);
  const s2 = stored(seal2, seal1.digest);
  const q = { from: W.from, to: W2.to };
  const clean = assembleVerifyReport(q, {
    seals: [s1, s2], predecessor: null, rowsBySeal: new Map([[s1.sealDigest, rows], [s2.sealDigest, []]]),
    tail: { from: W2.to, count: 4 }, orphans: [],
  }, { ok: true, checked: 2, problems: new Set() });
  assert.equal(clean.ok, true);
  assert.equal(clean.seals_checked, 2);
  assert.deepEqual(clean.unsealed_tail, { from: W2.to, count: 4 }, 'unsealed rows are reported, never verified, never a break');

  // Delete row 1, change row 2, insert a back-dated row: exactly three breaks.
  const tampered = [{ ...rows[1], details: { request_id: 'changed' } }, rows[2], row(99, '2026-10-15T06:30:00.000000Z')];
  assert.deepEqual(checkSealRows(seal1.document, seal1.digest, tampered).map((b) => [b.kind, b.row_id]), [
    ['missing_row', id(1)], ['changed_row', id(2)], ['unsealed_row_in_sealed_window', id(99)],
  ]);
  // A broken previous link, a gap, a missing predecessor, an orphaned (removed) seal.
  assert.deepEqual(checkSealLinks([s1, { ...s2, previousDigest: `sha256:${'d'.repeat(64)}` }], null).map((b) => b.kind), ['broken_previous']);
  assert.deepEqual(checkSealLinks([s1, { ...s2, windowFrom: '2026-10-15T07:00:00.000001Z' }], null).length, 1);
  assert.deepEqual(checkSealLinks([s2], undefined).map((b) => b.seal), [s2.sealDigest]);
  const orphaned = assembleVerifyReport(q, { seals: [s1], predecessor: null, rowsBySeal: new Map([[s1.sealDigest, rows]]),
    tail: { from: null, count: 0 }, orphans: [seal2.digest] }, { ok: true, checked: 1, problems: new Set() });
  assert.deepEqual(orphaned.breaks, [{ kind: 'broken_previous', seal: seal2.digest }]);
  // A rewritten document, a statement that names another digest, a chain problem.
  const rewritten = assembleVerifyReport(q, { seals: [{ ...s1, sealDocument: seal2.text }], predecessor: null,
    rowsBySeal: new Map(), tail: { from: null, count: 0 }, orphans: [] }, { ok: true, checked: 1, problems: new Set() });
  assert.deepEqual(rewritten.breaks.map((b) => b.kind), ['statement_problem']);
  const otherStatement = assembleVerifyReport(q, { seals: [{ ...s1, statementCanonical: s2.statementCanonical }], predecessor: null,
    rowsBySeal: new Map([[s1.sealDigest, rows]]), tail: { from: null, count: 0 }, orphans: [] }, { ok: true, checked: 1, problems: new Set() });
  assert.deepEqual(otherStatement.breaks.map((b) => b.kind), ['statement_problem']);
  const chainBroken = assembleVerifyReport(q, { seals: [s1], predecessor: null, rowsBySeal: new Map([[s1.sealDigest, rows]]),
    tail: { from: null, count: 0 }, orphans: [] }, { ok: false, checked: 1, problems: new Set([s1.sealDigest]) });
  assert.equal(chainBroken.ok, false);
  assert.deepEqual(chainBroken.breaks.map((b) => b.kind), ['statement_problem']);
  // The stored document is checked against its own columns.
  assert.equal(parseSealDocument({ ...s1, rowCount: 2 }), null);
  assert.ok(parseSealDocument(s1));
});

test('T16e verify: the query needs from < to within 31 days', () => {
  assert.deepEqual(parseAuditVerifyQuery({ from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' }),
    { from: '2026-10-01T00:00:00Z', to: '2026-10-15T00:00:00Z' });
  for (const bad of [{}, { from: '2026-10-15T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    { from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, { from: 'x', to: '2026-10-01T00:00:00Z' },
    { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', limit: '5' }]) {
    assert.throws(() => parseAuditVerifyQuery(bad), /AUDIT_FILTER_INVALID/);
  }
});

test('T16e export: request bounds, sections, counts and the signature against a test key', async () => {
  const now = new Date('2026-10-15T12:00:00.000Z');
  assert.deepEqual(parseExportRequest({ from: '2026-10-15T05:00:00+00:00', to: '2026-10-15T09:00:00Z' }, now),
    { from: '2026-10-15T05:00:00.000Z', to: '2026-10-15T09:00:00.000Z' });
  for (const bad of [{ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, { from: '2026-10-15T09:00:00Z', to: '2026-10-15T05:00:00Z' },
    { from: '2026-10-15T05:00:00Z', to: '2026-10-16T00:00:00Z' }, { from: '2026-10-15T05:00:00Z' }, null]) {
    assert.throws(() => parseExportRequest(bad, now), /invalid|before|year|future|exactly/);
  }

  const rows = [row(1, '2026-10-15T06:00:00.000000Z'), row(2, '2026-10-15T06:30:00.000000Z'), row(3, '2026-10-15T09:30:00.000000Z')];
  const seal = buildSealDocument({ tenantId: TENANT, window: W, previous: null, rows: rows.slice(0, 2) });
  const scope = { from: '2026-10-15T06:15:00.000Z', to: '2026-10-15T10:00:00.000Z' };
  // The scope widens to the seal's whole window, so the seal checks row by row.
  assert.deepEqual(coveredRange(scope, [{ windowFrom: W.from, windowTo: W.to }]), { from: W.from, to: '2026-10-15T10:00:00.000000Z' });
  const snapshot: ExportSnapshot = {
    generatedAt: '2026-10-15T11:00:00.000Z', events: rows,
    seals: [{ seq: 4, windowFrom: W.from, windowTo: W.to, sealDigest: seal.digest, sealDocument: seal.text, prevHash: `sha256:${'1'.repeat(64)}`,
      recordHash: `sha256:${'2'.repeat(64)}`, canonicalRecord: '{}', statementDigest: `sha256:${'3'.repeat(64)}`, statementCanonical: '{}',
      envelope: { payload: '', payloadType: 'application/vnd.in-toto+json', signatures: [] } }],
    anchors: [{ seq: 4, anchorType: 'tsa', batchId: `${TENANT}:0-4`, inclusionProof: {}, rekorEntryUuid: null, tsaTokenB64: 'AA==' },
      { seq: 9, anchorType: 'tsa', batchId: `${TENANT}:5-9`, inclusionProof: {}, rekorEntryUuid: null, tsaTokenB64: 'AA==' }],
    batches: [{ batchId: `${TENANT}:0-4`, seqFrom: 0, seqTo: 4, leafCount: 5, merkleRoot: `sha256:${'4'.repeat(64)}` },
      { batchId: `${TENANT}:5-9`, seqFrom: 5, seqTo: 9, leafCount: 5, merkleRoot: `sha256:${'5'.repeat(64)}` }],
  };
  const trust = { trust: { root_documents: [], keyset_documents: [], anchoring_keys: [], rekor_log_key_spki_b64: null,
    rekor_log_index_offsets: null, tsa_anchors_der_b64: [] }, pinnedRootKeyids: [] };
  const built = buildAuditExport({ exportId: id(500), tenantId: TENANT, scope, snapshot, trust });
  const again = buildAuditExport({ exportId: id(500), tenantId: TENANT, scope, snapshot, trust });
  assert.equal(built.text, again.text, 'deterministic');
  const parsed = JSON.parse(built.text) as Record<string, unknown> & { manifest: { sections: Record<string, string> } };
  assert.deepEqual(Object.keys(parsed).sort(), ['events', 'manifest', 'seal_evidence', 'seals']);
  for (const name of ['events', 'seals', 'seal_evidence']) {
    assert.equal(parsed.manifest.sections[name], sha256Prefixed(canonicalize(parsed[name])), `${name} digest`);
  }
  assert.deepEqual(built.counts, { events: 3, seals: 1, sealed_events: 2, unsealed_events: 1, anchored: 0, pending: 1 });
  const evidence = parsed.seal_evidence as { anchors: unknown[]; anchor_batches: Array<{ batch_id: string }> };
  assert.equal(evidence.anchors.length, 1, 'only the seal records\' anchors');
  assert.deepEqual(evidence.anchor_batches.map((b) => b.batch_id), [`${TENANT}:0-4`]);
  // The export's own JSON Schema accepts it.
  const Ajv = (await import('ajv')).default;
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../../docs/contracts/audit/export-v1.schema.json'), 'utf8'));
  const validate = new Ajv({ strict: true, allErrors: true, strictTypes: false }).compile(schema);
  assert.ok(validate(parsed), JSON.stringify(validate.errors));

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const envelope = await signExport(built, devSignerResolver({ sharedKeyPem: pem, env: {} }), TENANT, 'req-16e');
  assert.equal(envelope.payloadType, AUDIT_EXPORT_PAYLOAD_TYPE);
  const payload = Buffer.from(envelope.payload, 'base64');
  assert.ok(payload.equals(exportSignaturePayload(built.manifest, built.digest)));
  const pub = createPublicKey(privateKey);
  assert.equal(envelope.signatures[0].keyid, sha256Prefixed(pub.export({ format: 'der', type: 'spki' }) as Buffer));
  assert.ok(verify('sha256', pae(AUDIT_EXPORT_PAYLOAD_TYPE, payload), { key: pub, dsaEncoding: 'der' },
    Buffer.from(envelope.signatures[0].sig, 'base64')), 'the DSSE signature verifies with the test key');
  assert.equal(verify('sha256', pae('application/vnd.trackai.evidence-pack+json', payload), { key: pub, dsaEncoding: 'der' },
    Buffer.from(envelope.signatures[0].sig, 'base64')), false, 'and never as a pack signature');
});
