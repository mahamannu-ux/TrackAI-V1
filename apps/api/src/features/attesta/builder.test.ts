import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAuthorshipNote } from '../telemetry/authorship-note';
import { AttestaBuilderError, buildStatement, DELAYED_BUILD_AFTER_MS, type AttestaSubjectRow } from './builder';
import { canonicalize, sha256Prefixed } from './canonical';
import { checkStatementRules } from './contract-rules';
import {
  BUILDER_VERSION, IDS, MERGE_SHA, PATH_A, PATH_B, SOURCE_SHA, commitRow, commitSeeds, deployRow, deploySeeds,
  fakeReader, prRow, prSeeds, sampleNote, sha256Hex, type Seeds,
} from './testing/builder-world';

const FIXTURES = join(__dirname, '../../../../../docs/contracts/attesta/fixtures');
const readFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, any>;
const OPTIONS = { builderVersion: BUILDER_VERSION, maxPayloadBytes: 1_048_576 };

async function build(row: AttestaSubjectRow, seeds: Seeds, options = OPTIONS) {
  const reader = fakeReader(seeds, row.tenantId);
  const built = await buildStatement(reader, row, options);
  return { built, p: built.statement.predicate as Record<string, any>, calls: reader.calls };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof AttestaBuilderError && err.code === code);
}

function rangesHash(note: string, path: string): string {
  const file = parseAuthorshipNote(note).files.find((f) => f.path === path)!;
  return sha256Hex(canonicalize(JSON.parse(JSON.stringify(file.ranges))));
}

/**
 * The fixtures carry placeholder digests ("2222…") that no input hashes to, so the
 * builder's real digests are mapped to them by name (contract finding F1); the
 * fixture fields the builder must source differently are adjusted by name (F3–F5).
 * Everything else must match byte for byte.
 */
function assertReproduces(fixtureName: string, canonical: string, subs: Array<[string, string]>,
  adjust: (f: Record<string, any>) => void) {
  let text = canonical;
  for (const [real, placeholder] of subs) {
    assert.ok(text.includes(real), `${fixtureName}: computed value ${placeholder.slice(0, 4)}… not in output`);
    text = text.split(real).join(placeholder);
  }
  const fixture = readFixture(fixtureName);
  adjust(fixture);
  assert.equal(text, canonicalize(fixture));
}

/** F3: fields.md says partial / linked_by_session_string_not_key; F4: zero findings have no rule pack. */
function adjustFindings(f: Record<string, any>) {
  const findings = f.predicate.security_findings_observed;
  f.predicate.security_findings_observed = { availability: 'partial', partial_reason: 'linked_by_session_string_not_key', value: findings.value };
  f.predicate.policy.rule_pack_versions.value = [];
}

function commitSubs(note: string): Array<[string, string]> {
  return [
    [sha256Hex(note), '2'.repeat(64)],
    [sha256Hex(PATH_A), '4'.repeat(64)],
    [rangesHash(note, PATH_A), '5'.repeat(64)],
    [sha256Hex(PATH_B), '6'.repeat(64)],
    [rangesHash(note, PATH_B), '7'.repeat(64)],
  ];
}

test('T15h builder: reproduces valid-commit-observed.json byte for byte', async () => {
  const note = sampleNote();
  const { built } = await build(commitRow(), commitSeeds(note));
  assertReproduces('valid-commit-observed.json', built.canonical, commitSubs(note), adjustFindings);
  assert.equal(built.digest, sha256Prefixed(built.canonical));
  assert.deepEqual(built.statement, JSON.parse(built.canonical));
  assert.deepEqual(built.previousSeen, []);
});

test('T15h builder: reproduces valid-hashed-model.json byte for byte', async () => {
  const note = sampleNote('Claude Sonnet 4.5');
  const seeds = commitSeeds(note);
  const raw = 'Claude Sonnet 4.5';
  seeds.models = [{ commit_id: IDS.commit, tool: 'claude-code', model: raw, session_id: IDS.session, observed_ai_lines: 432 }];
  const { built } = await build(commitRow(), seeds);
  assertReproduces('valid-hashed-model.json', built.canonical,
    [...commitSubs(note), [sha256Hex(raw), 'e'.repeat(64)]], adjustFindings);
});

test('T15h builder: reproduces valid-pr-merged.json byte for byte', async () => {
  const { built } = await build(prRow(), prSeeds());
  assertReproduces('valid-pr-merged.json', built.canonical, [], (f) => {
    adjustFindings(f);
    // F5: lineage is recorded and every source is normalized, so merged lines are recorded.
    f.predicate.lifecycle = { availability: 'recorded', value: f.predicate.lifecycle.value };
  });
});

test('T15h builder: reproduces valid-deployed.json byte for byte', async () => {
  const { built } = await build(deployRow(), deploySeeds());
  assertReproduces('valid-deployed.json', built.canonical, [], adjustFindings);
  assert.deepEqual(built.previousSeen, [`sha256:${'a'.repeat(64)}`]);
});

test('T15h builder: every query is tenant-bound and reads no URL, email or stored note text', async () => {
  for (const [row, seeds] of [[commitRow(), commitSeeds()], [prRow(), prSeeds()], [deployRow(), deploySeeds()]] as const) {
    const { calls } = await build(row, seeds);
    for (const call of calls) {
      if (call.tag !== 'now') assert.ok(call.params.includes(IDS.tenant), call.tag);
      // These columns are only hashed, null-tested or compared inside SQL, never selected.
      const outside = call.sql
        .replace(/convert_to\([\w.]+/g, '')
        .replace(/[\w.]+ is (not )?null/g, '')
        .replace(/lower\(trim\([\w.]+\)\)/g, '')
        // The only raw_event reads: the commit sha attribute and the note (fields.md, B1).
        .replace("e.raw_event -> 'a' ->> '3'", '').replace("e.raw_event -> 'v' -> '13'", '')
        // Task2's session fallback when the note names none (tool, external or internal session ID).
        .replace("e.raw_event -> 'a' ->> '20'", '').replace("e.raw_event -> 'a' ->> '23'", '').replace("e.raw_event -> 'a' ->> '24'", '');
      assert.doesNotMatch(outside, /\b(normalized_url|author_email|author_name|authorship_note|raw_event)\b/, call.tag);
    }
  }
});

// ---------------------------------------------------------------------------
// fields.md availability branches
// ---------------------------------------------------------------------------

test('T15h builder B2: a later note overwrote the projection: commit-level fields unavailable, files kept', async () => {
  const seeds = commitSeeds();
  (seeds.commit as any)[0].note_sha256 = 'f'.repeat(64);
  const { p, calls } = await build(commitRow(), seeds);
  for (const field of ['lines', 'sessions', 'models', 'tools', 'committer', 'lifecycle', 'security_findings_observed']) {
    assert.deepEqual(p[field], { availability: 'unavailable', reason: 'source_missing' }, field);
  }
  assert.deepEqual(p.policy.rule_pack_versions, { availability: 'unavailable', reason: 'source_missing' });
  assert.equal(p.files.availability, 'recorded');
  assert.equal(p.source_evidence.note_digest.availability, 'recorded');
  assert.equal(p.commit.operation_kind.availability, 'recorded');
  assert.ok(!calls.some((c) => ['sessions', 'models', 'committer', 'findings'].includes(c.tag)));
});

test('T15h builder: Git AI sent no note: note_digest and files not_reported_by_source', async () => {
  const seeds = commitSeeds();
  (seeds.metric_event as any)[0].note = '';
  (seeds.commit as any)[0].note_sha256 = null;
  const { p } = await build(commitRow(), seeds);
  assert.deepEqual(p.source_evidence.note_digest, { availability: 'unavailable', reason: 'not_reported_by_source' });
  assert.deepEqual(p.files, { availability: 'unavailable', reason: 'not_reported_by_source' });
  assert.equal(p.lines.availability, 'recorded'); // projections describe this (note-less) event
});

test('T15h builder: signed_late backfill and delayed_build', async () => {
  const seeds = commitSeeds();
  (seeds.metric_event as any)[0].arrival_class = 'backfill';
  assert.deepEqual((await build(commitRow(), seeds)).p.signed_late, { value: true, reason: 'backfill' });
  const late = commitSeeds();
  late.now = [{ as_of: new Date(Date.parse('2026-10-12T09:14:55.000Z') + DELAYED_BUILD_AFTER_MS + 1).toISOString() }];
  assert.deepEqual((await build(commitRow(), late)).p.signed_late, { value: true, reason: 'delayed_build' });
  const edge = commitSeeds();
  edge.now = [{ as_of: new Date(Date.parse('2026-10-12T09:14:55.000Z') + DELAYED_BUILD_AFTER_MS).toISOString() }];
  assert.deepEqual((await build(commitRow(), edge)).p.signed_late, { value: false, reason: 'none' });
});

test('T15h builder: missing optional sources are unavailable, never zero', async () => {
  const seeds = commitSeeds();
  seeds.repository = [{ id: IDS.repository, provider: 'github', url_sha256: null }];
  seeds.enrollment = [];
  seeds.security_monitor = [];
  seeds.committer = [];
  (seeds.commit as any)[0].committed_lines = null;
  (seeds.commit as any)[0].git_ai_normalized = false;
  const { p } = await build(commitRow(), seeds);
  assert.deepEqual(p.repository.url_sha256, { availability: 'unavailable', reason: 'source_missing' });
  assert.deepEqual(p.policy.repository_enrollment, { availability: 'unavailable', reason: 'source_missing' });
  assert.deepEqual(p.policy.security_monitor, { availability: 'unavailable', reason: 'source_missing' });
  assert.deepEqual(p.committer, { availability: 'unavailable', reason: 'source_missing' });
  assert.deepEqual(p.lifecycle, { availability: 'unavailable', reason: 'source_missing' });
});

test('T15h builder: a commit with no author is never matched to a contributor', async () => {
  const seeds = commitSeeds();
  (seeds.commit as any)[0].has_author = false;
  const { p, calls } = await build(commitRow(), seeds);
  assert.deepEqual(p.committer, { availability: 'unavailable', reason: 'source_missing' });
  assert.ok(!calls.some((c) => c.tag === 'committer'));
});

test('T15h builder: first_seen source is git_ai_note when Git AI created the commit row', async () => {
  const seeds = commitSeeds();
  (seeds.commit as any)[0].source_event_id = IDS.metricEvent;
  assert.equal((await build(commitRow(), seeds)).p.first_seen.value.source, 'git_ai_note');
});

test('T15h builder rules 1–3: normalize, hash what does not fit, derive model_key and tools', async () => {
  const seeds = commitSeeds();
  seeds.sessions = [{ commit_id: IDS.commit, session_id: IDS.session, tool: '  ', observed_ai_lines: 432 }];
  seeds.models = [
    { commit_id: IDS.commit, tool: ' ', model: ' unknown ', session_id: IDS.session, observed_ai_lines: 400 },
    { commit_id: IDS.commit, tool: 'my tool', model: 'm1', session_id: IDS.session, observed_ai_lines: 32 },
  ];
  const { p } = await build(commitRow(), seeds);
  const hashedTool = `sha256:${sha256Hex('my tool')}`;
  assert.deepEqual(p.sessions.value, [{ session_id: IDS.session, tool: 'unknown', ai_lines: 432 }]);
  assert.equal(p.sessions.availability, 'recorded');
  assert.deepEqual(p.models.value.map((m: any) => [m.tool, m.model, m.model_key]).sort(), [
    [hashedTool, 'm1', `${hashedTool}::m1`],
    ['unknown', null, 'unknown::unknown'],
  ].sort());
  assert.equal(p.models.partial_reason, 'values_hashed_unrepresentable');
  assert.deepEqual(p.tools.value, [hashedTool, 'unknown'].sort());
  assert.equal(p.tools.partial_reason, 'values_hashed_unrepresentable');
});

test('T15h builder: non-hex fingerprints and non-GUID delivery IDs are hashed and flagged', async () => {
  const seeds = commitSeeds();
  (seeds.metric_event as any)[0].event_fingerprint = 'not-a-hash';
  const { p } = await build(commitRow(), seeds);
  assert.equal(p.source_evidence.metric_event.availability, 'partial');
  assert.equal(p.source_evidence.metric_event.value.fingerprint, sha256Hex('not-a-hash'));
  const pr = prSeeds();
  (pr.delivery as any)[0].delivery_id = 'delivery with spaces';
  (pr.pull_request as any)[0].external_id = 'PR_kwDO';
  const built = await build(prRow({ providerDeliveryId: 'delivery with spaces' }), pr);
  assert.equal(built.p.source_evidence.provider_delivery.partial_reason, 'values_hashed_unrepresentable');
  assert.equal(built.p.source_evidence.provider_delivery.value.delivery_id, `sha256:${sha256Hex('delivery with spaces')}`);
  assert.equal(built.p.pull_request.value.external_id, `sha256:${sha256Hex('PR_kwDO')}`);
  assert.equal(built.p.pull_request.partial_reason, 'values_hashed_unrepresentable');
});

test('T15h builder: findings are counted by category and severity, rule packs listed', async () => {
  const seeds = commitSeeds();
  seeds.findings = [
    { rule_category: 'execution', rule_severity: 'high', rule_pack_version: '2026.9.29', n: 2 },
    { rule_category: 'execution', rule_severity: 'critical', rule_pack_version: 'weird pack', n: 1 },
  ];
  const { p } = await build(commitRow(), seeds);
  assert.deepEqual(p.security_findings_observed, {
    availability: 'partial', partial_reason: 'linked_by_session_string_not_key',
    value: { total: 3, by_category: { execution: 3 }, by_severity: { high: 2, critical: 1 } },
  });
  assert.deepEqual(p.policy.rule_pack_versions.value, ['2026.9.29', `sha256:${sha256Hex('weird pack')}`].sort());
});

test('T15h builder pr_merged: lineage not written yet: lineage, sessions and lifecycle source_missing', async () => {
  const seeds = prSeeds();
  seeds.lineage = [];
  const { p, calls } = await build(prRow(), seeds);
  for (const field of ['merge_lineage', 'sessions', 'models', 'tools', 'lifecycle', 'security_findings_observed']) {
    assert.deepEqual(p[field], { availability: 'unavailable', reason: 'source_missing' }, field);
  }
  assert.ok(!calls.some((c) => c.tag === 'lifecycle_merged'));
  assert.equal(p.pull_request.availability, 'recorded');
});

test('T15h builder pr_merged: a source Git AI never saw makes attribution partial', async () => {
  const seeds = prSeeds();
  seeds.lineage = [...(seeds.lineage as any[]), {
    source_commit_id: '00000000-0000-4000-8000-000000000013', source_sha: 'c'.repeat(40), result_sha: MERGE_SHA,
    merge_method: 'squash_merge', confidence: 95, source_normalized: false, source_statement_digest: null,
  }];
  const { p } = await build(prRow(), seeds);
  for (const field of ['sessions', 'models', 'tools', 'lifecycle']) {
    assert.equal(p[field].partial_reason, 'only_some_sources_reported', field);
  }
  assert.equal(p.merge_lineage.value.length, 2);
  assert.equal(p.merge_lineage.value[1].source_statement_digest, null);
  // A source whose statement is not chained yet: lineage still being enriched.
  assert.equal(p.merge_lineage.partial_reason, 'lineage_still_being_enriched');
});

test('T15h builder pr_merged: a Git AI-normalized result commit carries its own projections', async () => {
  const seeds = prSeeds();
  Object.assign((seeds.commit as any)[0], {
    git_ai_normalized: true, committed_lines: 0, diff_added_lines: 3, observed_human_lines: 3, observed_unknown_lines: 0,
  });
  const { p, calls } = await build(prRow(), seeds);
  assert.equal(p.lines.availability, 'recorded');
  assert.equal(p.commit.operation_kind.value, 'squash_merge');
  assert.equal(p.committer.availability, 'partial');
  assert.deepEqual(p.files, { availability: 'unavailable', reason: 'source_missing' });
  const sessionsCall = calls.find((c) => c.tag === 'sessions')!;
  assert.ok(sessionsCall.params.includes(IDS.resultCommit) && sessionsCall.params.includes(IDS.commit));
});

test('T15h builder pr_merged: optional PR fields', async () => {
  const seeds = prSeeds();
  (seeds.pull_request as any)[0] = { ...(seeds.pull_request as any)[0], head_sha: null, author_identity_id: null };
  const { p } = await build(prRow(), seeds);
  assert.equal(p.pull_request.partial_reason, 'optional_source_field_missing');
  assert.equal(p.pull_request.value.head_sha, null);
  assert.deepEqual(p.pull_request.value.author_identity_id, { availability: 'unavailable', reason: 'source_missing' });
});

test('T15h builder deployed: no single merged PR names the commit: pull_request source_missing', async () => {
  for (const prs of [[], [{}, {}]]) {
    const seeds = deploySeeds();
    seeds.pull_request = prs.map(() => (deploySeeds().pull_request as any)[0]);
    const { p } = await build(deployRow(), seeds);
    assert.deepEqual(p.pull_request, { availability: 'unavailable', reason: 'source_missing' });
  }
});

test('T15h builder: an earlier statement still queued about the subject is SOURCE_NOT_READY (retryable)', async () => {
  for (const [row, seeds] of [[prRow(), prSeeds()], [deployRow(), deploySeeds()]] as const) {
    const s = { ...seeds, wait: [{ n: 1 }] };
    const reader = fakeReader(s, IDS.tenant);
    await assert.rejects(buildStatement(reader, row, OPTIONS),
      (err: unknown) => err instanceof AttestaBuilderError && err.code === 'ATTESTA_BUILDER_SOURCE_NOT_READY' && err.retryable);
    const wait = reader.calls.find((c) => c.tag === 'wait')!;
    assert.ok(wait.params.includes(SOURCE_SHA), 'lineage source shas are waited on');
    assert.equal(wait.params.includes('pr_merged'), row.kind === 'deployed');
  }
});

test('T15h builder: sources gone or no longer matching the pointer are SOURCE_MISSING (terminal)', async () => {
  const cases: Array<[AttestaSubjectRow, Seeds]> = [];
  cases.push([commitRow(), { ...commitSeeds(), repository: [] }]);
  cases.push([commitRow(), { ...commitSeeds(), commit: [] }]);
  cases.push([commitRow(), { ...commitSeeds(), metric_event: [] }]);
  cases.push([commitRow({ commitId: IDS.resultCommit }), commitSeeds()]);
  const wrongSha = commitSeeds();
  (wrongSha.metric_event as any)[0].attr_sha = MERGE_SHA;
  cases.push([commitRow(), wrongSha]);
  const wrongKind = commitSeeds();
  (wrongKind.metric_event as any)[0].event_kind = 4;
  cases.push([commitRow(), wrongKind]);
  cases.push([prRow(), { ...prSeeds(), delivery: [] }]);
  cases.push([prRow(), { ...prSeeds(), pull_request: [] }]);
  cases.push([prRow(), { ...prSeeds(), pull_request: [{ ...(prSeeds().pull_request as any)[0], merge_commit_sha: SOURCE_SHA }] }]);
  cases.push([deployRow(), { ...deploySeeds(), deployment: [] }]);
  cases.push([deployRow(), { ...deploySeeds(), deployment: [{ ...(deploySeeds().deployment as any)[0], production: false }] }]);
  cases.push([commitRow({ tenantId: 'not-a-uuid' }), commitSeeds()]);
  for (const [row, seeds] of cases) {
    await assert.rejects(buildStatement(fakeReader(seeds, row.tenantId), row, OPTIONS),
      (err: unknown) => err instanceof AttestaBuilderError && err.code === 'ATTESTA_BUILDER_SOURCE_MISSING' && !err.retryable);
  }
});

test('T15h builder: the schema and S1–S12 are checked on the snapshot', async () => {
  // A commit_observed may list only commit_observed statements (schema).
  const prev = commitSeeds();
  prev.previous = [{ statement_digest: `sha256:${'a'.repeat(64)}`, statement_kind: 'pr_merged' }];
  await expectCode(build(commitRow(), prev), 'ATTESTA_BUILDER_SCHEMA_INVALID');
  // A model naming a session that is not listed breaks S8.
  const s8 = commitSeeds();
  (s8.models as any)[0].session_id = '00000000-0000-4000-8000-000000000031';
  await expectCode(build(commitRow(), s8), 'ATTESTA_BUILDER_RULE_VIOLATION');
  // An unsafe integer from the database is refused, never rounded.
  const big = commitSeeds();
  (big.commit as any)[0].diff_added_lines = '9007199254740993';
  await expectCode(build(commitRow(), big), 'ATTESTA_BUILDER_NOT_CANONICAL');
  // Options are checked before anything is read.
  await assert.rejects(build(commitRow(), commitSeeds(), { ...OPTIONS, builderVersion: '0.1.0' }), RangeError);
  await assert.rejects(build(commitRow(), commitSeeds(), { ...OPTIONS, maxPayloadBytes: 0 }), RangeError);
});

function bigNote(files: number): string {
  const lines: string[] = [];
  for (let i = 0; i < files; i += 1) lines.push(`src/file-${i}.ts`, '  s_abc::t_1 1-2');
  lines.push('---', JSON.stringify({ sessions: { s_abc: { agent_id: { tool: 'claude-code', id: 'x', model: 'm' } } } }));
  return lines.join('\n');
}

function seedsForNote(note: string, files: number): Seeds {
  const seeds = commitSeeds(note);
  Object.assign((seeds.commit as any)[0], {
    diff_added_lines: files * 2, observed_ai_lines: files * 2, observed_human_lines: 0, observed_unknown_lines: 0,
    committed_lines: files * 2,
  });
  seeds.sessions = [{ commit_id: IDS.commit, session_id: IDS.session, tool: 'claude-code', observed_ai_lines: files * 2 }];
  seeds.models = [{ commit_id: IDS.commit, tool: 'claude-code', model: 'm', session_id: IDS.session, observed_ai_lines: files * 2 }];
  return seeds;
}

test('T15h builder step 4: entries are dropped (flagged and counted) only to fit the signer', async () => {
  const note = bigNote(300);
  const full = await build(commitRow(), seedsForNote(note, 300));
  assert.equal(full.p.files.value.entries.length, 300);
  const limit = Math.floor(Buffer.byteLength(full.built.canonical) * 0.6);
  const { built, p } = await build(commitRow(), seedsForNote(note, 300), { ...OPTIONS, maxPayloadBytes: limit });
  assert.equal(p.files.availability, 'partial');
  assert.equal(p.files.partial_reason, 'entries_truncated');
  assert.equal(p.files.value.total, 300);
  assert.equal(p.files.value.omitted, 300 - p.files.value.entries.length);
  assert.ok(p.files.value.entries.length > 0 && p.files.value.entries.length < 300);
  assert.deepEqual(checkStatementRules(built.statement), []);
  const paeLen = (c: string) => Buffer.byteLength(c) + 'DSSEv1 28 application/vnd.in-toto+json  '.length + String(Buffer.byteLength(c)).length;
  assert.ok(paeLen(built.canonical) <= limit);
  // One more entry would not have fit: the most that fit are kept.
  const keep = p.files.value.entries.length;
  const oneMore = full.p.files.value.entries.slice(0, keep + 1);
  const bigger = JSON.parse(built.canonical);
  bigger.predicate.files.value.entries = oneMore;
  bigger.predicate.files.value.omitted = 300 - keep - 1;
  assert.ok(paeLen(canonicalize(bigger)) > limit);
  // Nothing else was dropped.
  assert.deepEqual(Object.keys(p).sort(), Object.keys(full.p).sort());
});

test('T15h builder step 4: more than 2000 files keeps 2000; too large even with none is TOO_LARGE', async () => {
  const note = bigNote(2001);
  const { p } = await build(commitRow(), seedsForNote(note, 2001));
  assert.equal(p.files.value.entries.length, 2000);
  assert.equal(p.files.value.omitted, 1);
  assert.equal(p.files.partial_reason, 'entries_truncated');
  await expectCode(build(commitRow(), commitSeeds(), { ...OPTIONS, maxPayloadBytes: 500 }), 'ATTESTA_BUILDER_TOO_LARGE');
});

test('T15h builder: a repeated path in a note keeps its last values, as Task2 upserts', async () => {
  const meta = JSON.stringify({ sessions: { s_abc: { agent_id: { tool: 'claude-code', id: 'x', model: 'm' } } } });
  const note = ['a.ts', '  s_abc::t_1 1-5', 'a.ts', '  s_abc::t_1 1-2', '---', meta].join('\n');
  const seeds = seedsForNote(note, 1);
  (seeds.commit as any)[0].observed_ai_lines = 2;
  (seeds.commit as any)[0].diff_added_lines = 2;
  const { p } = await build(commitRow(), seeds);
  assert.equal(p.files.value.total, 1);
  assert.equal(p.files.value.entries[0].ai_lines, 2);
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

test('T15h builder: commit_observed reports only the sessions and models its own note named', async () => {
  const { calls } = await build(commitRow(), commitSeeds());
  const sessions = calls.find((c) => c.tag === 'sessions')!;
  assert.match(sessions.sql, /\(s\.tool, s\.external_session_id\) in \(\(\$\d+, \$\d+\)\)/);
  assert.ok(sessions.params.includes('claude-code') && sessions.params.includes('ext-session-1'));
  const models = calls.find((c) => c.tag === 'models')!;
  assert.match(models.sql, /model_key in \(\$\d+\)/);
  assert.ok(models.params.includes('claude-code::claude-sonnet-4-5'));
  // Findings are linked through the sessions actually reported.
  const findings = calls.find((c) => c.tag === 'findings')!;
  assert.ok(findings.params.includes(IDS.session));
  // pr_merged / deployed: the lineage commits as Task2 attributed them (no note scope).
  const pr = await build(prRow(), prSeeds());
  assert.doesNotMatch(pr.calls.find((c) => c.tag === 'sessions')!.sql, /external_session_id\) in/);
});

test('T15h builder: a note naming no session falls back to the event attributes, as Task2 does', async () => {
  const note = [PATH_A, '  s_abc::t_1 1-4', '---', '{}'].join('\n');
  const seeds = seedsForNote(note, 2);
  Object.assign((seeds.metric_event as any)[0], { attr_tool: 'opencode', attr_session: 'attr-session-7' });
  const { calls } = await build(commitRow(), seeds);
  const sessions = calls.find((c) => c.tag === 'sessions')!;
  assert.ok(sessions.params.includes('opencode') && sessions.params.includes('attr-session-7'));
  // modelAttributionsFromNote: an unnamed session's lines go to unknown::unknown.
  assert.ok(calls.find((c) => c.tag === 'models')!.params.includes('unknown::unknown'));
  // No identity at all: nothing to report, and no query is made.
  const none = seedsForNote(note, 2);
  // Task2 stores the unnamed session's model row with no session (svc:1056–1059).
  none.models = [{ commit_id: IDS.commit, tool: 'unknown', model: null, session_id: null, observed_ai_lines: 4 }];
  const r = await build(commitRow(), none);
  assert.deepEqual(r.p.models.value, [{ tool: 'unknown', model: null, model_key: 'unknown::unknown', ai_lines: 4, session_id: null }]);
  assert.ok(!r.calls.some((c) => c.tag === 'sessions' || c.tag === 'findings'));
  assert.deepEqual(r.p.sessions.value, []);
});

test('T15h builder F2: an earlier kind the schema forbids in previous is refused by name', async () => {
  const seeds = commitSeeds();
  seeds.previous = [{ statement_digest: `sha256:${'a'.repeat(64)}`, statement_kind: 'deployed' }];
  await assert.rejects(build(commitRow(), seeds), (err: unknown) => err instanceof AttestaBuilderError
    && err.code === 'ATTESTA_BUILDER_SCHEMA_INVALID' && /F2/.test(err.message));
  const pr = prSeeds();
  pr.previous = [{ statement_digest: `sha256:${'a'.repeat(64)}`, statement_kind: 'deployed' }];
  await expectCode(build(prRow(), pr), 'ATTESTA_BUILDER_SCHEMA_INVALID');
  const ok = prSeeds();
  ok.previous = [{ statement_digest: `sha256:${'a'.repeat(64)}`, statement_kind: 'pr_merged' }];
  assert.equal((await build(prRow(), ok)).p.previous.length, 1);
});

test('T15h builder F7: a model_key too long for a token leaves that row out, flagged', async () => {
  const seeds = commitSeeds();
  seeds.models = [
    { commit_id: IDS.commit, tool: 'claude-code', model: 'claude-sonnet-4-5', session_id: IDS.session, observed_ai_lines: 400 },
    { commit_id: IDS.commit, tool: 'a tool with spaces', model: 'a model with spaces', session_id: IDS.session, observed_ai_lines: 32 },
  ];
  const { p } = await build(commitRow(), seeds);
  assert.equal(p.models.availability, 'partial');
  assert.equal(p.models.partial_reason, 'only_some_sources_reported');
  assert.deepEqual(p.models.value.map((m: any) => m.model_key), ['claude-code::claude-sonnet-4-5']);
  assert.deepEqual(p.tools.value, ['claude-code']);
});

test('T15h builder: an observation time ahead of the database clock waits (SOURCE_NOT_READY)', async () => {
  const seeds = commitSeeds();
  (seeds.commit as any)[0].first_seen_at = '2026-10-12T09:15:02.482Z';
  await assert.rejects(build(commitRow(), seeds), (err: unknown) => err instanceof AttestaBuilderError
    && err.code === 'ATTESTA_BUILDER_SOURCE_NOT_READY' && err.retryable && !err.wait);
  const pr = prSeeds();
  (pr.delivery as any)[0].received_at = '2026-10-12T11:02:40.008Z';
  await expectCode(build(prRow(), pr), 'ATTESTA_BUILDER_SOURCE_NOT_READY');
});

test('T15h builder: the monitor mode is the one in force (Task6 activation rule)', async () => {
  const { calls } = await build(commitRow(), commitSeeds());
  const mon = calls.find((c) => c.tag === 'security_monitor')!;
  assert.match(mon.sql, /revoked_at is null/);
  assert.match(mon.sql, /valid_until is null or valid_until > now\(\)/);
});

test('T15h builder: an ordering wait is marked as a wait', async () => {
  const s = { ...prSeeds(), wait: [{ n: 1 }] };
  await assert.rejects(build(prRow(), s), (err: unknown) => err instanceof AttestaBuilderError && err.wait);
});
