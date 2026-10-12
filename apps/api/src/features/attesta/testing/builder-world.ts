/**
 * Test helpers for the Attesta builder and worker (Task15h): a fake read executor
 * that answers the builder's tagged queries from seeded rows, and seeds that are
 * the rows Task2 writes for the frozen `valid-*` fixtures. Synthetic data only.
 */
import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AttestaSubjectRow, BuilderReadExecutor } from '../builder';

export type SeedRows = Array<Record<string, unknown>>;
export type Seeds = Record<string, SeedRows | ((params: unknown[]) => SeedRows)>;

export interface FakeCall { tag: string; sql: string; params: unknown[] }

const dialect = new PgDialect();

/** Answers `/* builder:<tag> *\/` queries; refuses any query not bound to `tenantId`. */
export function fakeReader(seeds: Seeds, tenantId: string): BuilderReadExecutor & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    async execute(query: SQL) {
      const rendered = dialect.sqlToQuery(query);
      const tag = /\/\* builder:(\w+) \*\//.exec(rendered.sql)?.[1];
      if (!tag) throw new Error(`untagged builder query: ${rendered.sql.slice(0, 60)}`);
      calls.push({ tag, sql: rendered.sql, params: rendered.params });
      if (tag !== 'now' && !rendered.params.includes(tenantId)) {
        throw new Error(`builder query ${tag} is not bound to the tenant`);
      }
      const seed = seeds[tag];
      if (seed === undefined) throw new Error(`no seed for builder query ${tag}`);
      return { rows: typeof seed === 'function' ? seed(rendered.params) : seed };
    },
  };
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export const IDS = {
  tenant: '00000000-0000-4000-8000-0000000000f1',
  repository: '00000000-0000-4000-8000-000000000001',
  metricEvent: '00000000-0000-4000-8000-000000000010',
  commit: '00000000-0000-4000-8000-000000000011',
  resultCommit: '00000000-0000-4000-8000-000000000012',
  enrollment: '00000000-0000-4000-8000-000000000020',
  session: '00000000-0000-4000-8000-000000000030',
  contributor: '00000000-0000-4000-8000-000000000040',
  pullRequest: '00000000-0000-4000-8000-000000000050',
  identity: '00000000-0000-4000-8000-000000000060',
  deployment: '00000000-0000-4000-8000-000000000070',
  outboxCommit: '00000000-0000-4000-8000-000000000081',
  outboxPr: '00000000-0000-4000-8000-000000000082',
  outboxDeploy: '00000000-0000-4000-8000-000000000083',
};
export const SOURCE_SHA = '3f2a9c4e1b7d6a5f8e0c2b4d6f8a1c3e5b7d9f0a';
export const MERGE_SHA = '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c';
export const BUILDER_VERSION = '0.1.0+88301f7';

export const PATH_A = 'src/payments/charge.ts';
export const PATH_B = 'src/payments/refund.ts';

/** A Git AI note with two files: 400/4 and 32/15 AI/human lines, one session. */
export function sampleNote(model = 'claude-sonnet-4-5'): string {
  return [
    PATH_A,
    '  s_abc::t_1 1-400',
    '  h_dev 401-404',
    PATH_B,
    '  s_abc::t_1 1-32',
    '  h_dev 33-47',
    '---',
    JSON.stringify({ sessions: { s_abc: { agent_id: { tool: 'claude-code', id: 'ext-session-1', model } } } }),
  ].join('\n');
}

export function commitRow(over: Partial<AttestaSubjectRow> = {}): AttestaSubjectRow {
  return {
    id: IDS.outboxCommit, tenantId: IDS.tenant, repositoryId: IDS.repository, kind: 'commit_observed',
    metricEventId: IDS.metricEvent, commitId: IDS.commit, commitSha: SOURCE_SHA,
    provider: null, providerDeliveryId: null, pullRequestId: null, deploymentId: null, deploymentExternalId: null,
    eventAt: '2026-10-12T09:14:55.000Z', ...over,
  };
}

export function prRow(over: Partial<AttestaSubjectRow> = {}): AttestaSubjectRow {
  return {
    id: IDS.outboxPr, tenantId: IDS.tenant, repositoryId: IDS.repository, kind: 'pr_merged',
    metricEventId: null, commitId: null, commitSha: MERGE_SHA,
    provider: 'github', providerDeliveryId: '5f1c0a2e-8b4d-11f0-9a1b-0242ac120002', pullRequestId: IDS.pullRequest,
    deploymentId: null, deploymentExternalId: null, eventAt: '2026-10-12T11:02:30.000Z', ...over,
  };
}

export function deployRow(over: Partial<AttestaSubjectRow> = {}): AttestaSubjectRow {
  return {
    id: IDS.outboxDeploy, tenantId: IDS.tenant, repositoryId: IDS.repository, kind: 'deployed',
    metricEventId: null, commitId: null, commitSha: MERGE_SHA,
    provider: 'github', providerDeliveryId: '7a2d1b3c-8b5e-11f0-9a1b-0242ac120002', pullRequestId: null,
    deploymentId: IDS.deployment, deploymentExternalId: '1846203377', eventAt: '2026-10-12T13:40:00.000Z', ...over,
  };
}

const COMMON: Seeds = {
  repository: [{ id: IDS.repository, provider: 'github', url_sha256: '3'.repeat(64) }],
  enrollment: [{
    id: IDS.enrollment, status: 'active', effective_from: '2026-09-01T00:00:00.000Z',
    effective_until: null, commit_note_evidence_from: '2026-09-01T00:00:00.000Z',
  }],
  security_monitor: [{ mode: 'monitor', version: 3 }],
  sessions: [{ commit_id: IDS.commit, session_id: IDS.session, tool: 'claude-code', observed_ai_lines: 432 }],
  models: [{ commit_id: IDS.commit, tool: 'claude-code', model: 'claude-sonnet-4-5', session_id: IDS.session, observed_ai_lines: 432 }],
  findings: [],
  committer: [{ id: IDS.contributor }],
  previous: [],
  wait: [{ n: 0 }],
};

/** The rows Task2 writes for valid-commit-observed.json. */
export function commitSeeds(note = sampleNote()): Seeds {
  return structuredClone({
    ...COMMON,
    now: [{ as_of: '2026-10-12T09:15:02.481Z' }],
    commit: [{
      id: IDS.commit, operation_kind: 'commit', reachability: 'reachable',
      first_seen_at: '2026-10-12T09:14:30.112Z', authored_at: '2026-10-12T09:10:00.000Z',
      committed_at: '2026-10-12T09:14:20.000Z', diff_added_lines: 451, diff_deleted_lines: 12,
      observed_ai_lines: 432, observed_human_lines: 19, observed_unknown_lines: 0,
      source_event_id: null, note_sha256: sha256Hex(note), has_author: true,
      committed_lines: 432, git_ai_normalized: true,
    }],
    metric_event: [{
      id: IDS.metricEvent, event_fingerprint: '1'.repeat(64), event_at: '2026-10-12T09:14:55.000Z',
      evidence_family: 'commit_note', arrival_class: 'current', event_kind: 1, attr_sha: SOURCE_SHA, note,
    }],
  });
}

const RESULT_COMMIT = {
  id: IDS.resultCommit, operation_kind: 'squash_merge', reachability: 'reachable',
  first_seen_at: '2026-10-12T11:02:31.950Z', authored_at: '2026-10-12T11:02:30.000Z',
  committed_at: '2026-10-12T11:02:30.000Z', diff_added_lines: 0, diff_deleted_lines: 0,
  observed_ai_lines: 0, observed_human_lines: 0, observed_unknown_lines: 0,
  source_event_id: null, note_sha256: null, has_author: true, committed_lines: null, git_ai_normalized: false,
};
const LINEAGE = [{
  source_commit_id: IDS.commit, source_sha: SOURCE_SHA, result_sha: MERGE_SHA, merge_method: 'squash_merge',
  confidence: 95, source_normalized: true, source_statement_digest: `sha256:${'9'.repeat(64)}`,
}];
const PULL_REQUEST = {
  id: IDS.pullRequest, number: 42, external_id: '2873461190', state: 'merged', head_sha: SOURCE_SHA,
  merge_commit_sha: MERGE_SHA, merged_at: '2026-10-12T11:02:30.000Z', author_identity_id: IDS.identity,
};

/** The rows Task2 writes for valid-pr-merged.json (a squash merge with no note on the result). */
export function prSeeds(): Seeds {
  return structuredClone({
    ...COMMON,
    now: [{ as_of: '2026-10-12T11:02:40.007Z' }],
    commit: [RESULT_COMMIT],
    delivery: [{
      provider: 'github', delivery_id: '5f1c0a2e-8b4d-11f0-9a1b-0242ac120002',
      event_fingerprint: '8'.repeat(64), received_at: '2026-10-12T11:02:31.950Z',
    }],
    lineage: LINEAGE,
    pull_request: [PULL_REQUEST],
    lifecycle_merged: [{ n: '432' }],
  });
}

/** The rows Task2 writes for valid-deployed.json. */
export function deploySeeds(): Seeds {
  return structuredClone({
    ...COMMON,
    now: [{ as_of: '2026-10-12T13:40:12.300Z' }],
    commit: [RESULT_COMMIT],
    delivery: [{
      provider: 'github', delivery_id: '7a2d1b3c-8b5e-11f0-9a1b-0242ac120002',
      event_fingerprint: 'b'.repeat(64), received_at: '2026-10-12T13:40:05.001Z',
    }],
    lineage: LINEAGE,
    pull_request: [PULL_REQUEST],
    deployment: [{
      id: IDS.deployment, provider: 'github', external_id: '1846203377', environment: 'production',
      status: 'success', production: true, deployed_at: '2026-10-12T13:40:00.000Z', sha: MERGE_SHA,
    }],
    lifecycle_production: [{ n: '432' }],
    previous: [{ statement_digest: `sha256:${'a'.repeat(64)}`, statement_kind: 'pr_merged' }],
  });
}
