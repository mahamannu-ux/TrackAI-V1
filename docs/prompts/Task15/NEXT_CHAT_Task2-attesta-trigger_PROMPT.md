# Handoff prompt: Task2-attesta-trigger (write Attesta outbox rows from Task2's observations), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. Run the Task15c outbox gate once on your Mac (blocking for this session's merge, not for its start):
>    `cd ~/AIProjects/TrackAI-v1 && scripts/it-db.sh npm run -s verify:task15c-outbox-live -w apps/api` (expect `IT-T15c-01=passed`).
> 3. **Codex:** start a new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`) and paste everything below the line. It can run at the same time as Claude's `Task15d-attesta-ledger` (no shared files).
> 4. When it finishes, paste its review request to the **Task15 lead Claude chat**. Push only after "ready to push".

---

You are **Codex**, building **Task2-attesta-trigger** (Task15 subtask A15.7) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. You own Task2's lifecycle code. Attesta (Task15) will sign provenance statements about what Task2 observes; it needs Task2 to say "this happened, please attest it" by writing one thin `attesta_subjects` outbox row **in the same transaction as the observation**. The table, its writer and the exact rules are frozen and merged (Task15c, PR #30). You answered the design questions yourself (I1–I8 in `docs/plan/ATTESTA_QUESTIONS.md`); this session implements your I8 answer. It does not build the statement builder, signing or anything else in Attesta, and it changes no metric semantics.

- **Repo:** `~/AIProjects/TrackAI-v1`. **Worktree:** under `~/AIProjects/TrackAI-wt/`, branch `task/Task2-attesta-trigger`.
- **Handoff:** `docs/handoffs/Task2-attesta-trigger_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §6, §9 items 3, 7, 8, 13, §12.1, §12.4).
2. `pwd && git branch --show-current && git log --oneline -1`: you must be under `~/AIProjects/TrackAI-wt/`; if detached or on `codex/…`, `git switch -c task/Task2-attesta-trigger`. Identity `mahamannu-ux` / `mahamannu@gmail.com` for this worktree. `main` must contain `apps/api/src/features/attesta/outbox.ts` and migration `0016_attesta_subjects.sql`; otherwise stop.
3. `npm ci && npm test` (392 expected).
4. Estimate one line against T6. The plan says **about 0.15×** (0.1× in the tracker, raised because `normalizeCommit` and `recordDeployment` must become transaction-aware).

## 1. Read before writing
- **The interface (frozen, read-only):** `docs/contracts/attesta/outbox.md` in full, above all "The writer", "Source binding" and "Which transaction writes each kind"; `apps/api/src/features/attesta/outbox.ts` (`enqueueAttestaSubject(tx, input)`, `AttestaOutboxError` codes); `docs/handoffs/Task15c-attesta-contract_HANDOFF.md` ("Implemented interfaces", "Integration notes").
- **Your own answers:** `docs/plan/ATTESTA_QUESTIONS.md` I1, I7, I8 and "Decisions for A15.0" 1 and 4.
- **Code you change:** `apps/api/src/features/telemetry/service.ts` (`normalizeCommit` at `:756`, its callers including `ingestMetricsBatch` `:1424`, `rebuildCommitLifecycle` `:1286`, `reconcilePendingMetricEvents` `:1361`), `apps/api/src/features/scm/scm.routes.ts` (`projectProviderDelivery` callback `:222–395`, PR upsert `:295–336`, post-projection enrichment `:416–470`, `recordDeployment` call `:473–480`), `apps/api/src/features/scm/lifecycle-service.ts` (`recordDeployment` `:433–536`). Re-check these line numbers on `main`; they are from 2026-10-12.

## 2. Scope (approved)
### 2.1 Decisions
1. **`commit_observed`:** make commit-note normalization transaction-aware (take an optional transaction, or run its writes in one `withTenant(...).transaction`) so the commit, file, session, model and lifecycle projections and the outbox row commit or roll back together. Enqueue with `metricEventId` = the event being normalized, `commitId`/`commitSha` = the upserted commit, after the commit row exists, for `event_kind` 1 and 7 only (the source binding refuses anything else). Normalization that ends without a commit row writes no outbox row.
   - A lifecycle rebuild or a reconciler retry re-normalizes the same event IDs: the call hits the idempotency key and returns `inserted: false`. That is success, not an error. An `ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT` there means the rebuild relinked the event to a different commit: decide with the founder whether that rolls the normalization back or logs and continues, and record the decision (recommendation: roll back and surface the code, so Attesta never silently diverges from Task2).
   - The normalization-status update stays where it is unless moving it inside the transaction is needed for correctness; say which you did and why.
2. **`pr_merged`:** inside the `projectProviderDelivery` transaction, after the PR upsert, when the delivery is `pr_closed` with `merged_at` and `merge_commit_sha` set. `commitSha` = `merge_commit_sha`, `provider` = `github`, `providerDeliveryId` = the delivery being projected, `pullRequestId` = the upserted PR, `notBefore` = now + 5 minutes. **Never hold this transaction open for GitHub API calls**; the post-projection enrichment stays outside it.
3. **`deployed`:** wrap the complete deployment observation in one transaction: the deployment insert, every production lifecycle write after it (including the `ai_code_lifecycle_events` and `ai_model_lifecycle_events` upserts) and the enqueue. Enqueue only when `production` and `status = 'success'`; `deploymentId` = the stored row's ID (read it back after `insertDoNothing`), `providerDeliveryId` = the `deployment_status` delivery being processed, `deploymentStatus: 'success'`.
4. **Errors:** `ATTESTA_OUTBOX_INVALID_INPUT` and `ATTESTA_OUTBOX_SOURCE_NOT_FOUND` mean Task2 called the writer wrongly: roll the observation back so the delivery or event is retried and the bug is visible; never swallow them. Log only the code, never IDs or payloads.
5. **Nothing waits for signing:** no network, signer or builder call is added to these paths (`outbox.md` rule 1). Measure ingestion latency before and after on the existing test fixtures and report it (AGENTS.md §9 item 7 applies to GitAI; this is the server-side equivalent).
6. **Metric semantics are unchanged** (AGENTS.md rule 8): every lifecycle number before and after this change is identical on the existing fixtures and live verifiers.

### 2.2 Port from
None: SushiCorp has no outbox (Task15c records this). Follow the frozen `outbox.md`.

### 2.3 Pre-approved files
`apps/api/src/features/telemetry/service.ts`, `apps/api/src/features/scm/scm.routes.ts`, `apps/api/src/features/scm/lifecycle-service.ts`, their existing tests, a new live verifier `apps/api/src/features/telemetry/task2-attesta-trigger-live-verify.ts` with its `apps/api/package.json` script `verify:task2-attesta-trigger-live`, `docs/handoffs/Task2-attesta-trigger_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row and the integration test registry), `docs/plan/TASK15.md` (A15.7 status only), `Task2.md` (one row pointing to this work).

### 2.4 Never touch
`docs/contracts/` (frozen; if `outbox.md` looks wrong, stop and report it to the Task15 lead), migration `0016` and every merged migration, `apps/api/src/features/attesta/**` (call `enqueueAttestaSubject`, never edit it), `apps/api/src/core/db/schema.ts`, `apps/web/`, dependencies. No new migration is needed; if one seems to be, stop and ask.

## 3. Working rules
- Commits `Task2-attesta-trigger: …`, one per kind, then tests, then the handoff. Explicit staging.
- **Unit tests** (in-process, through the real services with a fake executor where the database is needed): each kind enqueues exactly once on the happy path; nothing is enqueued for a non-merged close, a non-production or failed deployment, or a note without a commit; a writer error rolls the observation back.
- **Integration (live, `scripts/it-db.sh`):** `IT-T2AT-01` one commit note → one `commit_observed` row in the same transaction (kill between projection and commit: neither exists); replay and lifecycle rebuild add nothing. `IT-T2AT-02` a merged-PR delivery → one `pr_merged` row with `not_before` about five minutes ahead; a redelivery adds nothing; a closed-unmerged PR adds none. `IT-T2AT-03` a successful production deployment → one `deployed` row with the deployment and lifecycle writes; a failure status adds none; a second success delivery for the same deployment returns the same row. `IT-T2AT-04` Company A/B: each tenant's observations produce only its own rows. Run each once in your sandbox; the founder runs the set.
- Re-run the existing Task2 and Task4 live verifiers that exercise `normalizeCommit`, PR projection and `recordDeployment` (you know which); report numbers before and after.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean. One independent review (a fresh thread or `/review`) before the handoff.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 70 lines: which transaction writes each kind (`file:line`), the rebuild/conflict decision, latency before and after, Integration test impact (IT-T2AT-01…04 with the exact command; IT-T15c-01 founder run as a merge gate), Effort.
- Status board row and integration test registry rows; `TASK15.md` A15.7 🟡.
- Clean tree; do not push. Final reply in the AGENTS.md §12.4 shape; for the PR body use `git show task/Task2-attesta-trigger:docs/handoffs/Task2-attesta-trigger_HANDOFF.md | gh pr create … --body-file -` (the founder runs from the main checkout). Review request in a `text` block for the Task15 lead Claude chat.

## After this session (not in scope)
Gaps G4 (`merged_by`) and G3 (PR review and approval capture) land before production as their own Task2 sessions; the Task15 lead writes those prompts when the founder asks.

## Lessons so far
- **Task15c (Claude) and your review of it:** source binding and replay are where the bugs were; test replay and rebuild paths as carefully as the happy path.
- **Task2–Task6 (Codex):** small numbered waves with one exit gate each, dry-run first, honest status wording; keep that style here.
