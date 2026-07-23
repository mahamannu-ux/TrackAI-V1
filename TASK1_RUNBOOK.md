# Task1 — Git AI Telemetry Integration Runbook

## Safety boundary

The migration was reviewed and manually applied to the initial TrackAI
Supabase project. Before merging Task1, that project must baseline the matching
hash/timestamp in `drizzle.__drizzle_migrations`; otherwise a later
`db:migrate` could attempt to apply migration `0000` again. The migration
alters existing SCM tables, creates telemetry tables and policies, and does not
recreate production tables.

## Configuration

Add this to the API environment, replacing both values:

```dotenv
TRACKAI_INGEST_TOKENS_JSON={"a-long-random-machine-secret":"company-a-tenant-uuid"}
```

Configure Git AI to upload to:

```text
API_BASE_URL=http://localhost:8080
API_BASE_KEY=a-long-random-machine-secret
```

The upload URL is `POST /worker/metrics/upload`. Tokens are SHA-256 compared,
never logged, and bound to exactly one existing tenant.

## Review and apply

1. Inspect the migration and confirm the existing SCM columns/table names.
2. Back up the Supabase database.
3. Apply through the controlled Drizzle migration workflow. If an environment
   was initialized manually, register the exact migration hash/timestamp once.
4. Never use `drizzle-kit push` against production.

## Seed Company A

Preview the idempotent seed (no database writes):

```bash
npm run seed:task1 --workspace=apps/api -- \
  --tenant-domain=purpletealabs.net --dry-run
```

After migration approval, remove `--dry-run` to import seven commits through
`117bbcf`, six shipped sessions, one abandoned token-consuming session,
provider-audited usage, and four correction overlays. Disposable B4 branches
and raw prompt text are excluded.

## Local start and native replay

```bash
npm run dev --workspace=apps/api
npm run dev --workspace=apps/web
```

Replay a captured native batch:

```bash
curl -i http://localhost:8080/worker/metrics/upload \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: a-long-random-machine-secret' \
  --data-binary @captured-git-ai-batch.json
```

Expected success is `200 {"errors":[]}`. Replaying the identical body is a
no-op. Malformed envelopes return 400, bad keys return 401, and transient
database failures return 503 so Git AI can retry.

## Verification matrix

| Check | Expected |
|---|---|
| API unit tests | Sparse decoding, unknown-kind retention, URL normalization, auth, Notes, PR precedence pass |
| API/web TypeScript | No errors |
| API/web production builds | Pass with normal Supabase environment values |
| Seed dry-run | 1 repo, 7 commits, 7 sessions, 6 shipped, 13 evidence rows, 4 corrections |
| Tenant isolation | Company A sees lab seed; Company B sees none of it |
| Retry | Identical batch adds no duplicate batch/event/normalized row |
| Live dashboard | New session/commit appears on the next 15-second poll |
| Missing OpenCode usage | Displays `Unavailable`, not zero |
| Cost | USD and Copilot credits remain separate units |

Database-backed isolation, RLS, replay and localhost UI checks must be run only
after the review migration is applied. Raw events, prompts, traces, checkpoints
and tool calls remain server-only in Task1.

## Remaining Task1 closeout

| ID | Item | Status |
|---|---|---|
| **T1.R1** | Company B protected-browser/API isolation login test | Verified: Company B remained isolated |
| **T1.R2** | One clean live AI agent session-to-commit relationship | Moved to Task2 T2.9; current native commit and session transport passed independently |
| **T1.R3** | Decide whether live B4/TrackAI backlog remains visible or is archived by an audited overlay | Closed: retain current evidence as-is |
| **T1.R4** | Restore temporary global Git AI config and retain/rotate the localhost test token | Git AI config restored; localhost token retained for controlled tests |
| **T1.R5** | Commit/review the isolated TrackAI-v1 implementation and merge it into the production repository | Pending user-approved Git workflow |
| **T1.R6** | Run final API/web builds and database-backed acceptance after the merge candidate is fixed | Pending T1.R5 |

The live test’s broader delivery and policy findings are tracked in Task2
(`outputs/Task2/Task2.md`) and Task4 Phase 5.6.
