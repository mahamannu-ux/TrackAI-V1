# Task9a2-release-contract-correction Handoff — Schema-v2 immutable release contract

> Status: 🟡 implementation and agent gates pass; founder IT-T9-01 and cross-agent review remain.

Branch `task/Task9a2-release-contract-correction` (base: `main` at `75ac8c8`).

Task9a2 adds the smallest backward-compatible schema-v2 fleet configuration contract and storage correction. It preserves schema v1, Task9e's existing v1 creation request, assignment/offboarding/report behavior and Task15's unavailable production verifier; it does not modify Task9e, GitAI, Task9d or Task15.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | closed v1/v2 creation, admin response and worker envelope unions | ✅ 13 focused tests |
| Release identity | exact-tag URL plus pinned manifest SHA-256; channel remains metadata | ✅ |
| Storage | generated migration `0015_aromatic_blink.sql`; v1 preserved, partial/mixed v2 blocked | ✅ |
| Quality | 165 unit tests, typecheck, lint, Drizzle check and production web build | ✅ |
| Integration | extended IT-T9-01 on disposable PostgreSQL/pgvector | 🟡 agent-verified; founder run blocks merge |
| Review | full diff re-read; cross-agent review | ✅ self-review · ⬜ cross-agent |

## Implemented interfaces
```text
Create v1 (unchanged wire input; schemaVersion omitted):
  { targetClientVersion, channel, ring, validUntil, reason }

Create v2:
  { schemaVersion: 2, clientCompatibility: { minimumVersion, maximumVersion },
    desiredRelease: { version, releaseTag, manifestUrl, manifestSha256 },
    channel, ring, validUntil, reason }

Admin/worker output: closed schemaVersion 1 | 2 union.
V1 keeps targetClientVersion. V2 exposes clientCompatibility and desiredRelease only.
Verification remains exactly { required: true, state: 'unavailable' }.
```

Migration `0015_aromatic_blink.sql` adds nullable compatibility bounds, release tag, manifest URL and manifest SHA-256 columns, then constrains schema v1 to all-null new metadata and schema v2 to all-present metadata. The immutable trigger, RLS with zero browser policies, composite tenant keys and `withTenant()` access are unchanged.

## Founder-approved decisions
1. Reused physical `target_client_version` for schema-v2 `desiredRelease.version`; outward names remain separated.
2. Existing schema-v1 requests without `schemaVersion` create v1 rows and receive the original v1 worker shape.
3. Exact URLs are limited to `https://github.com/mahamannu-ux/git-ai/releases/download/<releaseTag>/SHA256SUMS`; credentials, query, fragment, traversal and encoded separators fail closed.

## Deviations from spec
None. Shared edits are limited to the prompt-approved schema, generated migration/meta, fleet feature and Task9/STATUS rows. No component was ported.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Task15 production verification remains unavailable | v2 can be fetched/staged later but cannot authorize execution |
| 🟡 | Task9e still submits and types v1 only | Narrow follow-up is required for the v2 form/type union and desired-release detail; current merged v1 flow remains valid |
| ⬜ **FOUNDER:** | Run IT-T9-01 and obtain `ready to push` review | Blocks push/PR/merge |

## Test coverage
Focused in-process tests cover unchanged v1 shape, v2 round-trip, machine-scoped snapshots, semantic-version bounds, tag and exact URL rules, mutable/latest/traversal/query/fragment negatives, lowercase 64-hex digest, masquerading/unknown fields, no-store responses and unavailable verification. Full unit tests use real Express routes; only database behavior uses the disposable integration harness.

## Integration test impact
> **FOUNDER:** Blocking for Task9a2 merge and later fleet-contract work. Prerequisite: Docker Desktop or PostgreSQL 16 with pgvector. Expected: `it_t9_01=passed`, about one minute.
> ```bash
> scripts/it-db.sh npm run verify:task9-fleet-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T9-01 | migrations 0014+0015 apply/rollback/fresh reapply; v1/v2 round-trip; partial/mixed v2 blocked; immutable tuple/audit; A/B isolation; RLS/no policies; rollback/offboard | Blocking: Task9a2 | 🟡 agent-verified 2026-10-11 · ⬜ founder run |

Task9c2 must wait for reviewed/merged Task9a2. Task9d remains stopped until both Task9a2 and Task9c2 merge.

## Integration notes
- Task9c2 must parse the exact tagged union and revalidate compatibility, release tag, exact URL and digest independently.
- Task9e PR #18 remains valid; only its configuration form/types and one compact desired-release detail need a narrow follow-up after v2 merges.
- Stable gates: focused 13/13; full 165/165; typecheck; lint; Drizzle check; production web build; IT-T9-01 passed. The first sandbox-only full run hit `listen EPERM`; the exact approved retry passed 165/165.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---|---|---|
| about 0.14× | about 0.14× | one Codex session | about 1 hour | unavailable |
