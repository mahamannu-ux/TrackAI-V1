# Task19g handoff — merged-by, rejection audit, line walk

> Status: 🟡 built and founder-verified; Task19 lead review and deployment backfill planning remain.
> Branch `task/Task19g-merged-by-rejections-line-blame` (base `main` at `7c58af4`). Local only; no push or PR.

Task19g closes capture gaps G4 and G5 and builds Q2's GitHub line walk. The changes are grouped in A `fb8831f`, B `e729e60`, C `1ec8c53`, registry/plan `00d1130`, review fixes `4de9ff1`, and per-tenant backfill completion `f7d1ff1`.

## At a glance

| Part | Acceptance | Status |
|---|---|---|
| A, G4/Q6 | Migration `0028_friendly_mystique` adds only nullable `merged_by_provider_id/login`; closed merged webhook parses, stores, and upserts merger identity | ✅ |
| A, G4/Q6 | Retained-delivery backfill is dry-run-first, fills nulls only, emits one `scm.merged_by.backfilled` audit row per tenant on confirm; Q6 counts AI PRs by self/other/unknown merger and known commit author | ✅ |
| B, G5/Q15 | Audit catalog v5 adds `telemetry.upload.rejected` (Task4) and the backfill action (Task2); managed refusal records counts and URL digests before ingest, fails closed on audit write failure | ✅ |
| B, G5/Q15 | Q15 reads tenant-bound audit rows, returns unavailable/null figures when a period has no rejection rows, partial counts for periods spanning first capture, and counts uploads, events, four reasons, and distinct digests in covered periods | ✅ |
| C, Q2 | Additive file UUID and line scope, GitHub App GraphQL blame, lineage mapping, neutral file drill-down, Questions input, and Q2 live figures | ✅ founder-live App check passed 2026-10-20 |
| Quality | API workspace suite: 1,258/1,258; typecheck, lint, Drizzle check, and web build with placeholder public Supabase settings passed | ✅ |
| Integration | IT-T19g-01 steps 1–3 through real `createApp`, JWT/tenant/machine middleware and throwaway PostgreSQL passed; step 4 used a real App installation and the Q2 API | ✅ founder passed steps 1–4 on 2026-10-20 |
| Review | Independent Codex review completed; three correctness fixes applied, Q6 author-coverage definition retained per prompt; Task19 lead cross-review remains | 🟡 lead review pending |

## Interfaces and figures

```text
npm run backfill:task19g-merged-by -w apps/api [-- --confirm]
scripts/it-db.sh npm run verify:task19g-qa-live -w apps/api
TASK19G_Q2_SOURCE_ENV_FILE=<existing-API-env-path> TASK19G_Q2_APP_KEY_FILE=<local-App-PEM-path> scripts/it-db.sh npm run verify:task19g-qa-live -w apps/api
GET /api/qa/questions/Q2/answer?kind=live&repository_id=<uuid>&commit_sha=<sha>&file_id=<uuid>&line=<1..1000000>
GET /api/qa/questions/Q2/drilldown?kind=live&repository_id=<uuid>&commit_sha=<sha>
```

- Q6: `ai_assisted_merged_prs`, `merged_by_author`, `merged_by_someone_else`, `merger_unknown`, `committer_known`.
- Q15: `rejected_uploads`, `rejected_events`, `rejected_events_{repository_missing,repository_url_invalid,grant_inactive,before_watermark}`, `rejected_repositories`.
- Q2: `line_written_by_ai`, `originating_commit_known`, `file_ai_lines`, `file_human_lines`.
- QA registry v3 digest: `sha256:66acd3b8a5e8079ea076536b9a876a47245830ff68056656092bfb6eee5d1a5b`; G4/G5 are closed.

## Decisions and deviations

1. Missing merger identity remains unknown; backfill never overwrites a populated field. Q6's self/other figures are partial before the tenant's confirmed backfill audit marker and recorded afterward. No login enters its envelope.
2. Rejection audit details contain four reason counts and at most 20 SHA-256 digests of canonical HTTPS repository URLs. Q15 marks the repository figure partial when a row reaches that cap. A period with no rejection rows is unavailable/null; one spanning first capture with rows reports partial lower-bound counts. Legacy unmanaged uploads are outside Q15. Repository breakdown is unavailable because a digest is not a repository UUID.
3. Q2 accepts a server-owned `scm_commit_files.id`, never a path. Exact line attribution is reported only when blame names the requested commit. Older origins return file-level counts and session IDs as partial; unknown origins are unavailable.
4. The frozen QA reason schema requires a registered gap with `not_captured_yet`. Q2 has no gap, so missing installation uses `answer_not_built` and an unknown origin uses `partial_linkage`; this preserves schema validity without assigning a false gap. The Task19 lead should decide whether a future additive reason is warranted.
5. GitHub App credentials remain server-side. Blame uses one GraphQL request per uncached file, a ten-minute in-memory cache, and a ten-second abort. No path, code, URL, branch, or login enters the answer or drill-down.
6. The prompt defines Q6 `committer_known` as commits with non-null commit author data. The stored commit has no separate Git committer identity, so this is author coverage, not proof of the committer's identity.

## Test evidence and limits

- IT-T19g-01 agent run passed 2026-10-19: signed merged webhook stored merger; dry run left nulls unchanged; confirm filled the nulls and wrote one marker for each tenant, including zero updates; Q6 counted the AI PR; a managed ungranted upload wrote exactly one rejection; Q15 counted it; Company B saw neither; a forced audit insert failure returned 503 and ingested nothing.
- Founder reported `npm test` and `it-db.sh` passing on 2026-10-20. The founder ran the optional step-4 verifier that day: it used a read-only source connection to copy one existing lab commit's metadata into the disposable database, then called the real Q2 API using the installed GitHub App. It verified exact AI attribution at line 3 and no path in the answer. It read a local PEM file; neither the key nor the source file path was printed. The `dry_run:false` rows in the output were confined to the disposable integration database.
- After the frozen Q&A figure rule was restored and Q15's empty periods became unavailable/null, `npm run check` passed on 2026-10-20 with loopback access: API tests 1,259/1,259, typecheck, lint, Drizzle check, and web build. The focused Q&A contract and Task19g tests passed 22/22, including a regression that refuses partial/null figures.
- IT-T19g-01 steps 1–3 passed again on 2026-10-20 against throwaway PostgreSQL after its Company B assertion was updated to unavailable/null. The deliberate audit-write failure logs `Git AI metrics ingestion failed` and is a passing negative case.
- Q2 provider access is stubbed in unit tests and was exercised through the real API in founder step 4. The answer exposes session IDs via drill-down; agent/model and timestamps are reached through existing session and commit metadata, not duplicated into the Q2 numeric envelope.
- Founder-live provider preflight and full Q2 API step 4 passed on 2026-10-20: App ID `4377457`, installation `148568870`, and the supplied local PEM minted a token; GitHub GraphQL blame returned the selected lab line with the requested commit as its origin.
- The `TrackAI-v1` Supabase migration ledger ends at `0009`; migrations `0010`–`0028` are unapplied there. Leave that database unchanged until its separately planned migration work. The production backfill dry run waits for that work; the disposable step-4 verifier reads only existing lab metadata from Supabase.
- An origin whose file path changed across commits has no safe file-row match from GraphQL blame's SHA alone; Q2 returns unavailable rather than guessing its old path.
- Independent review found three correctness issues fixed in the follow-up: Q15 historical zeroes, capped digests, and cached blame after locally revoked credentials. It also flagged the Q6 key/author distinction above, which follows the requested figure definition.

## Founder and downstream gates

| Gate | Command or action | Status |
|---|---|---|
| IT-T19g-01 steps 1–3 | `scripts/it-db.sh npm run verify:task19g-qa-live -w apps/api` | ✅ founder reported pass 2026-10-20 |
| Backfill planning | `npm run backfill:task19g-merged-by -w apps/api` against deployment database after migration | ⬜ **FOUNDER:** inspect tenant counts; use `-- --confirm` only after approval |
| Q2 live | Founder ran optional step 4 with the installed App against a real lab commit, through a disposable database and the Q2 drill-down and answer APIs | ✅ founder passed 2026-10-20; branch release remains pending |
| Review and release | Independent review, Task19 lead cross-review, then founder push/PR/preflight/merge | ⬜ **FOUNDER:** do not merge before gates |

Task15 may add `merged_by` to the `pr_merged` predicate and managed rejection counts to a signed batch statement. This branch does not change Attesta predicates or statements.

## Effort

| Estimate | Actual | Main overrun |
|---|---|---|
| about 0.25× T6 | about 0.35× T6 | Q2 contract edge and real HTTP/database failure-path verification |
