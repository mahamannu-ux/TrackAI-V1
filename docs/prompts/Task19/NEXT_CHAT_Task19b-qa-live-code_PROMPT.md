# Handoff prompt: Task19b-qa-live-code (live answers for the code questions), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge Task19a (`task/Task19a-qa-matrix-contract`), then the `docs/Task19-numbat-review` PR (this prompt), each after `scripts/pr-preflight.sh <branch>` says ok. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task19b-qa-live-code && cd ~/AIProjects/TrackAI-wt/Task19b-qa-live-code && npm ci && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 3. When it finishes, paste its review request to the **Task19 lead (Claude)**. Commit 2 (the Task2 move) also goes to **Codex** as Task2's owner, as soon as Codex is available. Push only after "ready to push".

---

You are **Muse**, building **Task19b-qa-live-code** (Task19 T19.3) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

Task19a froze the **Q&A contract**: a question registry, one answer envelope, and `/api/qa/*` routes that answer every question with an honest `unavailable` / `answer_not_built` until someone registers an **answerer**. This session registers **live answerers for ten code questions** and builds the **drill-down** route. It adds no table, no migration and no web page.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task19b-qa-live-code`, branch `task/Task19b-qa-live-code`.
- **Handoff:** `docs/handoffs/Task19b-qa-live-code_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full. In particular:
   - §1 rules 6–9 (raw content, honest states, Task2 owns lifecycle semantics, server authoritative);
   - §4;
   - §7 and §8;
   - §9 items 3 and 22–23;
   - §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`. Set `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` in this worktree. **Check:** `apps/api/src/features/qa/answerers.ts` and `apps/api/src/features/telemetry/task2-lifecycle-read.ts` exist; otherwise stop (Task19a is not merged).
3. `npm test` once as a baseline.
4. **Estimate** in one line against T6. The plan says **about 0.12×**.

## 1. Read before writing code
- `docs/contracts/qa/README.md`, `api.md`, `answer-v1.schema.json`, `questions.md` and `fixtures/`: the contract you build against. **It is frozen: never edit anything under `docs/contracts/`.**
- `docs/plan/TASK19.md` §3.1 "Answer sources": the tables and Task2 functions for every question, with `file:line`.
- `docs/handoffs/Task19a-qa-matrix-contract_HANDOFF.md`: "Implemented interfaces".
- **Code** (paths under `apps/api/src/`):
  - `features/qa/types.ts`: `QaEnvelope`, `QaFigure`, `QaValue`, `QaAnswerContext`.
  - `features/qa/answerers.ts`: `registerAnswerer`.
  - `features/qa/service.ts`:
    - `answerQuestion`, `notBuiltEnvelope`, `previousPeriod`, `checkDrilldownRequest`;
    - the drill-down stub that answers 501 `QA_DRILLDOWN_NOT_BUILT`.
  - `features/qa/qa.routes.ts`, `features/qa/qa-api.test.ts` (the in-process test harness to copy).
  - `features/telemetry/task2-lifecycle-read.ts` (`t2r`):
    - `loadContext` `:70`, `lifecycleForTenant` `:113`, `lifecycleForModel` `:285`;
    - `audited` `:53`, `contributesToCurrentCommittedState` `:66`.
  - `features/telemetry/lifecycle.ts` (`lc`): `LifecycleValue`, `LifecycleSummary` (`:22-46`); `calculateLifecycleSummary` `:102`; `calculateLifecycleScopeTotals` `:327` (returns `{sessions, commits, finalAiLines, finalHumanLines}`); `currentRetainedAiLines` `:279`.
  - `features/telemetry/read.routes.ts`: the `GET /pull-requests/:id/intelligence` handler (`rr:308-386`), which commit 2 moves.

## 2. Scope (every decision made by the lead)

### 2.1 Rules for every answerer
1. **Shape.** Each question gets one pure function `computeQn(context, ctx): QaEnvelope` plus a thin answerer `async (ctx) => computeQn(await loadContext(ctx.tenantId), ctx)`.
   - `context` is `loadContext`'s result, and `ctx` is `QaAnswerContext`.
   - Pure functions are what the unit tests drive, with synthetic contexts; they never touch the database.
2. **Lifecycle figures come only from Task2 functions** (rule 8):
   - `lifecycleForTenant(tenantId, {repositoryId?, pullRequestId?, from, to})`;
   - `lifecycleForModel(context, modelKey)`;
   - `calculateLifecycleSummary`;
   - and, after commit 2, `pullRequestIntelligence` (§2.2).

   To scope `lifecycleForModel` to the period, pass it a copy of `context` whose `modelLifecycleEvents` keep only rows with `occurredAt` inside `[from, to]`. That is input filtering, the same as `lifecycleForTenant` does with its `inTime` helper; it is not a new calculation. **Never re-implement a Task2 calculation.** If a figure needs one Task2 does not have, return that figure `unavailable` with reason `answer_not_built`, and list it in the handoff as an open issue for Task2.
3. **Task2 `LifecycleValue` → envelope figure:**
   - `availability` maps one to one;
   - `value` becomes `{type:'count', count: value}`, or `null` when Task2's value is `null`;
   - `reasons`: `[]` for `recorded`; for `partial` or `unavailable` caused by missing evidence, `[{code:'answer_not_built'}]` unless a more specific code applies (below).

   **Never turn `null` into `0`.**
4. **Allowed raw-table aggregates.** Q13 (commit counts and note presence) and Q18 (token and cost sums) are not lifecycle semantics. Compute them from `context` rows, always through `contributesToCurrentCommittedState` for commits.
5. **Shares are ratios** `{type:'ratio', numerator, denominator}`, never floats. Task2's `ratios` (floats) are never used. A ratio whose denominator is 0 or unavailable is `unavailable`.
6. **Envelope fields:**
   - `as_of = ctx.now`; `scope = ctx.scope`; `kind:'live'`; `registry_version` from the registry;
   - `wording` = exactly the question's registry wording;
   - top-level `availability` = the worst of the figures' (`unavailable` > `partial` > `recorded`), and `reasons` = the union of the figures' reasons without duplicates;
   - every open gap of the question appears as `{code:'not_captured_yet', gap}` on the figure it affects **and** at the top level.
7. **Breakdowns:** only when `ctx.breakdown` is set, and only on the figures named below. Bucket keys:
   - `model` → `modelKey`, or `unknown`;
   - `tool` → `tool`;
   - `repository` → the repository UUID.

   Never a person, a path or an email.
8. **`drilldown`** on the envelope: the first **20** items of the drill-down route's first page (§2.3), the same items.
9. **`signed_evidence`** (only Q1, Q3, Q9 and Q13, which offer `verifiable`): `{path:'/api/attesta/statements', query:{repository_id (when in scope), from, to}}`. No `kind` and no `subject_sha`.
10. **Content:** metadata only. PR labels are `#<number>`, or `PR` when the number is null. Commit labels are the first 12 hex characters of the SHA. Repository labels are the repository's `name` (`scm_repositories.name`; metadata, not content). **Never** a PR title, commit subject, session text, path, prompt or command.

### 2.2 Commit 2: one pure Task2 move (founder-approved exception, like Task19a's)
Move the body of the `GET /pull-requests/:id/intelligence` handler (`read.routes.ts:308-386`) **unchanged** into an exported function in `features/telemetry/task2-lifecycle-read.ts`:

```ts
export function pullRequestIntelligence(context: Awaited<ReturnType<typeof loadContext>>, pullRequestId: string)
```

It returns exactly the object the route sends today, or `null` when the PR is not found. The route keeps its 404 and calls the function.
- Only the `return`/`res.json` wrapping changes. Every computation line stays byte-identical, and any helpers it needs move with it.
- This commit contains nothing else. Task2's tests pass unmodified.
- If the move is not a pure cut-and-paste, stop and describe it.

### 2.3 The drill-down route
Replace the 501 stub with `GET /api/qa/questions/{id}/drilldown`. It keeps the same checks as the answer route (`checkDrilldownRequest`, authorization, `kind=live` refused to auditors) and returns `{items:[{scope,id,label}], next_cursor}`. It is the same for every question built here; for other questions it keeps answering 501.

| Request scope | Items | Order and cursor |
|---|---|---|
| `tenant` | repositories that have at least one commit in the period (`scope:'repository'`) | by `id` ascending; cursor = the last `id`, base64url |
| `repository` | pull requests of that repository merged or updated in the period (`scope:'pull_request'`) | same |
| `pull_request` | the PR's commits (memberships, as `pullRequestIntelligence` selects them; `scope:'commit'`, `id` = the commit row's UUID) | same |
| `commit` | none: `items: []`, `next_cursor: null` | — |

- `limit` is 1..100 (default 50). An invalid cursor is 400 `QA_SCOPE_INVALID`.
- Drill-down reads are not audited (Task19a decision).

### 2.4 The ten answerers (registered for kind `live`)

| Q | Scopes | Figures (key → source) | Breakdown | Notes |
|---|---|---|---|---|
| **Q3** | tenant, repository | `merged_ai_lines` → `lifecycleForTenant(...).summary.merged`; `ai_share_of_retained_lines` → ratio(`totals.finalAiLines`, `totals.finalAiLines + totals.finalHumanLines`) | `model`, `tool` on `merged_ai_lines` via period-filtered `lifecycleForModel(...).summary.merged` per model key (tool from the model's rows); `repository` via `lifecycleForTenant` per repository | A merged-only denominator does not exist in Task2: an open issue for Task2, reported in the handoff. Wording `unknown_model_explicit`: the bucket `unknown` stays |
| **Q1** | tenant, repository | `ai_share_of_changed_lines` → ratio(`totals.finalAiLines`, `finalAiLines + finalHumanLines`) for the period; `ai_share_of_repository` → `unavailable`, `not_captured_yet` G1 | `repository` | — |
| **Q4** | tenant, repository, commit | `models_in_production` → count of model keys whose period-filtered `lifecycleForModel(...).summary.production.value` > 0; `production_ai_lines` → `lifecycleForTenant(...).summary.production`; `approved_at_the_time` → `unavailable`, G2 | `model`, `tool` on `production_ai_lines` | Commit scope: models attributed to that commit (`commitModelAttributions`) whose code reached production |
| **Q13** | tenant, repository, commit | `commits` (retained, committed in the period); `commits_without_git_ai_note` (`authorshipNote` null); `unknown_lines` (sum of `observedUnknownLines`); `note_coverage` → ratio(commits with a note, commits) | `repository` | Period by `committedAt` |
| **Q9** | tenant, repository, pull_request | `production_ai_lines` → `summary.production`; `merged_not_deployed_proxy_lines` → `summary.mergedProxy` (its own figure, never added to production); `production_deployments` → `evidence.deployments` | `repository` | Wording `merged_not_deployed_proxy` |
| **Q14** | pull_request | from `pullRequestIntelligence`: `commits`, `sessions`, `final_ai_lines`, `final_human_lines`, `merged` (count 1 or 0 from `mergeResult`), `production_ai_lines` (`lifecycle.production`) | none | Drill-down items: commits as above. Sessions are counted, not listed. Wording `metadata_only` |
| **Q10** | tenant, repository, pull_request | `reworked_ai_lines` → `summary.reworked`; `reworked_by_ai`, `reworked_by_human`, `reworked_by_unknown` → `summary.reworkByActor` (a missing key is `0` only if `summary.reworked` is `recorded`; otherwise `unavailable`); `churned_ai_lines` → `unavailable`, reason `never_written` | `repository` on `reworked_ai_lines` | Wording `churned_unavailable` |
| **Q19** | tenant, repository, pull_request | `generated_lines` → `summary.generated` (keep Task2's `partial` and its reason); `committed_ai_lines` → `summary.committed`; `acceptance` → ratio(committed, generated), only when both are `recorded` | `model`, `tool`, `repository` on `committed_ai_lines` | — |
| **Q18** | tenant, repository, pull_request | `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens`; `cost_micro_<unit>` per cost unit (lowercase), as an integer count of millionths (`Math.round(amount × 1e6)` per row, then summed) | `model`, `tool`, `repository` on `output_tokens` | Sessions in scope = sessions linked (`commitSessions`) to retained commits in scope and period. Any usage row with null tokens, or any in-scope session without usage, makes that figure `partial` with `vendor_does_not_report`. No usage at all: `unavailable`, same reason. **Never 0 for missing** |
| **Q20** | tenant | `ai_committed_lines` → `totals.finalAiLines` for the period, **with `previous`** (`previousPeriod(ctx.scope)`, the same keys); `team` → `unavailable`, `answer_not_built` | `repository` (both periods) | No team entity exists: an open issue for the lead (TASK19.md §3.1) |

Not built here (they keep answering `answer_not_built` and their gaps):
- **Q5** (G3), **Q6** (G4; "who" is per person, and stays out until the lead decides), **Q12** (G2), **Q15** (G5);
- **Q11** (moved to Task19c: its security data changes with Task20 Numbat);
- **Q2** (Task19d).

### 2.5 Port from
None. These answers reuse Task2's functions inside TrackAI. AP-1 conventions are already in `features/qa/http.ts`, and the contract was written in Task19a. There is no SushiCorp module for this.

### 2.6 Pre-approved files
- `apps/api/src/features/qa/answers/` (new): `common.ts` (the mappings in §2.1), `q01.ts`, `q03.ts`, `q04.ts`, `q09.ts`, `q10.ts`, `q13.ts`, `q14.ts`, `q18.ts`, `q19.ts`, `q20.ts`, `register-code.ts` (registers the ten), `answers-code.test.ts`.
- `apps/api/src/features/qa/drilldown.ts` (new) and `drilldown.test.ts`; `apps/api/src/features/qa/service.ts` and `qa.routes.ts` (wire the drill-down; import `register-code.ts` once at module load in `qa.routes.ts`).
- `apps/api/src/features/qa/task19b-qa-live-verify.ts` (new).
- Commit 2 only: `apps/api/src/features/telemetry/task2-lifecycle-read.ts` and `apps/api/src/features/telemetry/read.routes.ts`.
- `apps/api/package.json`: register the two new test files in `test`; add `verify:task19b-qa-live` in alphabetical position.
- `docs/plan/TASK19.md` (§2 row T19.3 and the §6.1 Task19b row only); `docs/plan/STATUS_BOARD.md` (registry row IT-T19b-01, remaining-plan actual for 7i2); the handoff.

### 2.7 Never touch
- `docs/contracts/` (the Q&A contract is frozen: if it cannot express something, stop and describe it); `core/db/schema.ts`; migrations.
- `apps/web/`.
- Any Task2 calculation (commit 2 is a move, not a change).
- `features/security-findings/`.

## 3. Working rules
- **Commits** prefixed `Task19b-qa-live-code: …`:
  1. `common.ts` and the pure functions' signatures;
  2. the Task2 move, alone;
  3. one commit per two or three questions;
  4. the drill-down;
  5. registration and the live verify;
  6. the handoff.

  `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (no database):
  - every `computeQn` on a synthetic context covering `recorded`, `partial` and `unavailable`;
  - **null is never 0** (one assertion per question);
  - breakdown keys contain no `/`, `\` or `@`;
  - Q20 carries `previous` with the same keys;
  - Q18 rounding and partial cases;
  - every returned envelope passes the contract validator (`features/qa/envelope.ts`, through `answerQuestion` with a fake registry, as in `qa-api.test.ts`);
  - the drill-down paging (exact pages, cursor round trip, invalid cursor 400);
  - an auditor gets 403 on the drill-down;
  - Task2's existing tests pass unmodified after commit 2.
- **Integration, IT-T19b-01** (`scripts/it-db.sh npm run verify:task19b-qa-live -w apps/api`), through `createApp()` with the real JWT and tenant middleware on a throwaway database. Seed one repository for Company A: three commits (one without a Git AI note), one merged PR, one production deployment, two models; and one repository for Company B. Then:
  - (a) Q3, Q9, Q13 and Q19 as Company A admin are 200, valid, and their figure values equal the seeded data's expected values (written as constants in the script);
  - (b) Q13 `commits_without_git_ai_note` = 1;
  - (c) Q20 has `previous`;
  - (d) the drill-down from tenant to repository to PR to commit pages correctly;
  - (e) Company A sees none of Company B's repositories in any answer or drill-down;
  - (f) an auditor asking for `kind=live` gets 403.

  Run it once in your sandbox; it is blocking for the merge.
- **Review:** re-read the full diff as a reviewer before the handoff (AGENTS.md §12.3).

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 100 lines**. It names:
  - the ten answerers and their figure keys;
  - the open issues for Task2 (merged-only denominator; anything else found);
  - commit 2's SHA, for Codex;
  - **Effort**.
- `docs/plan/STATUS_BOARD.md`: the IT-T19b-01 row and the remaining-plan actual. Leave the Task19 status-board row to the lead.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape, with numbered founder steps. One bash block containing:
  1. `npm ci`, `npm test` and IT-T19b-01;
  2. under `# after the cross-agent review`:
     - `git push`;
     - `gh pr create --base main --head task/Task19b-qa-live-code --title "[Task19b] Live answers for code questions" --body-file docs/handoffs/Task19b-qa-live-code_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`;
     - `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task19b-qa-live-code`;
     - `gh pr merge task/Task19b-qa-live-code --merge --repo mahamannu-ux/TrackAI-V1`, only after the preflight says ok.

  Then the review request for the Task19 lead in a `text` block, naming commit 2 separately for Codex.

## Lessons so far
- **Task19a (Claude):** the contract's validator rejects any envelope that breaks a rule. Run every answer through `answerQuestion` in tests, not just the pure function.
- **Task16a–16f:** reviews converge fastest on must-fix items only. Number every founder step.
- **Task2 (rule 8):** a figure Task2 has no function for is an open issue for Task2, never a new query.
