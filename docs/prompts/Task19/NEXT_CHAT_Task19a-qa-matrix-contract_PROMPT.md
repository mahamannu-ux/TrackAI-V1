# Handoff prompt: Task19a-qa-matrix-contract (delivery matrix confirmed against the code; the Q&A contract), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the `docs/Task19-plan` PR (this prompt). Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, and paste everything below the line.
> 3. Checkpoint: after T19.1 and the contract draft (step 2.2) it sends you a short summary and one question; answer in plain words.
> 4. When it finishes, paste its review request to **Codex**. Codex owns Task2, and this session moves three Task2 functions and adds an admin action. Push only after "ready to push".

---

You are **Claude**, building **Task19a-qa-matrix-contract** (Task19 T19.1 + T19.2) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

`docs/plan/CUSTOMER_AUDITOR_QA.md` ranks 38 questions customers and auditors ask: Q1–Q20 about code, S1–S18 about security and policy. No question has a working answer yet. `docs/plan/TASK19.md` §3 is the delivery matrix, with a running status per row (capture · live · auditor).

This session does two things:
- **T19.1:** confirm every matrix row against the code, with `file:line`, and record where each live answer will come from.
- **T19.2:** build the **Q&A contract** every surface shares: the question registry as code, one answer envelope, and the `/api/qa/*` routes with their guards. It is frozen under a new `docs/contracts/qa/`.

It answers **no** question itself: Task19b/19c (Muse) and Task16 A16.13 plug answers into this contract.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles go in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task19a-qa-matrix-contract`.
- **Handoff:** `docs/handoffs/Task19a-qa-matrix-contract_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 1, 6–9; §4, including the new Task19 row; §5; §7; §9 items 3, 22–23; §10 AP-1; §12.4) and `CLAUDE.md`.
2. Send the founder one request for folder access: `~/AIProjects`, plus `~/dev/agent-kit` read-only. Ask once for delete permission on `~/AIProjects`. Clone `main` from a bundle, run `npm ci` and `npm test` once, and install `postgresql-16-pgvector` for `scripts/it-db.sh`.
3. Estimate in one line against T6. The plan says **about 0.08×**: T19.1 about 0.02×, the contract about 0.06×, plus about 0.01× for the Task2 move (item 9). Above 0.11×, propose moving the routes (items 5–6) to a follow-up session and say so at the checkpoint.

## 1. Read before writing
- **Task19:** `docs/plan/TASK19.md` in full: §1 decisions D1–D5 (approved 2026-10-15), §3 matrix and its status rules, §4–§6.
- **Questions:** `docs/plan/CUSTOMER_AUDITOR_QA.md` in full. In particular:
  - "Three kinds of answer" (live, verifiable, signed; the hybrid is dropped);
  - both question tables;
  - "Gaps found" (G1–G13);
  - "Task6.a status";
  - "What this means for the design": predicate rule 1, availability `recorded` / `partial` / `unavailable`, is the vocabulary the envelope reuses.
- **Task16 (consumer of this contract):** `docs/plan/TASK16.md` A16.13 row and §5 decision 5; `docs/handoffs/Task16c-audit-emitters-api_HANDOFF.md` and `docs/handoffs/Task16f2-audit-export-ui_HANDOFF.md` ("Implemented interfaces").
- **Attesta contracts (read-only; verifiable answers will cite them):**
  - `docs/contracts/attesta/api.md`, the statements list and verify routes;
  - `docs/contracts/attesta/period-report.md`, the `inputs` and the `{count, seqs}`-style figure lists;
  - `docs/contracts/attesta/fields.md:40`, the session text join.
- **Code** (paths under `apps/api/src/`):
  - `app.ts:74-81`: the `/api` mounts (JWT and tenant middleware first).
  - `features/audit/http.ts` and `features/audit/audit.routes.ts:92-110`: the AP-1 pattern to copy (problem bodies, `X-Request-ID`, `no-store`, `problemizeAuth`, the actor check).
  - `core/security/admin-authorization.ts:1-66`: `ADMIN_ACTIONS` and `adminMembershipAllows` (which actions an auditor gets).
  - `core/middleware/admin.ts`: `requireAdminAction`, `adminActionOf`. `core/security/auditor-sweep.test.ts`: `ROUTE_ACTIONS`.
  - `features/telemetry/read.routes.ts`:
    - `loadContext` (`:84`), `lifecycleForTenant` (`:464`), `lifecycleForModel` (`:636`): Task2's lifecycle aggregation, private to the route file today;
    - `/metrics/lifecycle` (`:688`), `/telemetry/models` (`:705`), `/dashboard/summary` (`:739`).
  - `features/telemetry/lifecycle.ts`: Task2's metric functions.
  - `features/admin/admin.routes.ts:218` and `features/security-findings/`: the findings read.
  - `core/db/schema.ts`, the tables the answers read:
    - `security_findings` `:474`, `tenant_security_monitor_settings` `:291`, `fleet_machine_states` `:385`;
    - `scm_pull_requests` `:809`, `scm_commits` `:950`, `scm_commit_files` `:985`;
    - `ai_sessions` `:1002`, `ai_session_usage` `:1038`, `ai_commit_model_attributions` `:1075`;
    - `scm_merge_lineage` `:1163`, `scm_deployments` `:1179`;
    - `ai_code_lifecycle_events` `:1447`, `ai_model_lifecycle_events` `:1468`, `scm_contributors` `:1546`.

    When you inventory, grep both the Drizzle symbol and the raw SQL table name (Task16a lesson).
- **Catalog:** AP-1 and RP-1 in `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md`; CF-1's "generated and test-checked reference" pattern, as Task16b used it for `docs/contracts/audit/catalog.md`.

## 2. Scope
### 2.1 Lead decisions
**T19.1: the matrix, confirmed**

1. **For each of the 38 rows:**
   - Check the Capture cell and the status symbols in `TASK19.md` §3 against the code, and correct any that are wrong.
   - Name the tables and the existing functions the live answer will use, with `file:line`.
   - Write this in a new `TASK19.md` §3.1 "Answer sources": one row per question, with columns question, sources (`file:line`), Task2/Task6 function reused, open issue.
   - Put corrections in place in §3 and in the matching row of `CUSTOMER_AUDITOR_QA.md`, each with a one-line reason in the handoff.
   - Confirm each gap's owner in "Gaps found".
2. **Size Q2** (point-in-time line attribution: `attribution_ranges` plus the lineage walk) and pick its agent: Codex if it needs lineage internals, Muse if every decision can be written down. Put the result in the `Task19d-qa-line-walk` row of `TASK19.md` §6.1. Do the same for the Task19b/19c split if the inventory changes it.
3. **Live answers reuse Task2's semantics, never re-derive them** (rule 8). Where a live answer needs a lifecycle figure, §3.1 names the Task2 function. A figure that has no Task2 function is an open issue for Task2, not a new query.

**T19.2: the Q&A contract**

4. **Question registry as code** (`features/qa/registry.ts`):
   - `QA_REGISTRY_VERSION` (integer) and `QA_QUESTIONS`, one entry per row:
     - `id` (`Q1`…`Q20`, `S1`…`S18`), `family` (`code` / `security`), `rank` (per family, as in the catalogue);
     - `title`: the question in plain words, at most 200 characters, taken from the catalogue;
     - `auditor` (`yes` / `partly` / `no`);
     - `kinds`: the subset of `live` / `verifiable` / `signed` the matrix offers, each with its builder (`T19.3`, `T19.4`, `A16.13a`, `A16.13b`, `Task15i4`, `Task15p`);
     - `gaps`: G ids;
     - `scopes`: which of `tenant` / `repository` / `pull_request` / `commit` the question accepts;
     - `dimensions`: allowed breakdowns (`model`, `tool`, `repository`, `agent_family`, `operating_system`, `rule_category`, `severity`, `team`);
     - `wording`: required caveat codes.
   - `QA_GAPS`: G1–G13 with the owner and the questions each affects.
   - **No dimension or scope ever names a person** (`developer`, `contributor`, `author`, `committer`, `user`). A unit test refuses them: Task5's no-surveillance rule, and Q20/S17 stay at team, repository or machine level.
   - The registry bumps `QA_REGISTRY_VERSION` when an entry is added or changed. Ids are never reused.
5. **Answer envelope** (`docs/contracts/qa/answer-v1.schema.json`, Draft 7, closed objects; TypeScript types in `features/qa/types.ts`):
   - `question_id`, `registry_version`, `kind`.
   - `as_of` (RFC 3339 UTC, ms): the query time for `live`; the newest input statement's `recorded_at` for `verifiable`; the report's signed time for `signed`.
   - `scope`: `{repository_id?, pull_request_id?, commit_sha?, from, to}`. A period is at most 366 days.
   - `availability` (`recorded` / `partial` / `unavailable`) and `reasons[]`. Each reason is `{code, gap?}`, and the codes are a closed enum:
     - `not_captured_yet` (with gap), `not_monitored` (a platform outside D6.2);
     - `vendor_does_not_report` (Q18), `never_written` (Churned);
     - `partial_linkage` (session text join, G10);
     - `answer_not_built`, `phase_2`.
   - `figures[]`: each figure has `key`, `availability`, `reasons[]` and a `value`. The value is one of:
     - `{type: count, count}`;
     - `{type: ratio, numerator, denominator}`, so no floats ever (shares are computed for display only);
     - `{type: duration_ms, ms}`;
     - `null`, **only** when the figure is `unavailable`.

     All integers are within ±(2^53 − 1). A figure may also carry:
     - `breakdown[]` (`{dimension, key, value}`, the same value shapes);
     - `evidence` (verifiable/signed only): the statement digests and seqs behind the figure, with an RFC 6962 root, as in RP-1 and `period-report.md`.

     **A unit test proves an unavailable figure never serializes as `0`.**
   - `wording[]`: closed caveat codes the UI must render. Every security question carries `monitor_only_observed` (never "blocked" or "prevented"). Others: `unknown_model_explicit`, `merged_not_deployed_proxy`, `churned_unavailable`, `session_link_partial`, `requested_not_confirmed` (S11), `metadata_only`.
   - `drilldown`: the next scopes to open (`repository` / `pull_request` / `commit` / `file` / `session` / `finding` / `statement`, with id and label). Never a person.
   - `signed_evidence` (live only, optional): a filter for `GET /api/attesta/statements` that shows the statements behind the same scope ("see the signed evidence"). It is a link, never the statements: the hybrid is dropped (D2).
   - `signed` (signed only): `{statement_digest, predicate_type}`.
   - **Fixtures** (`docs/contracts/qa/fixtures/`): one valid envelope per kind × availability, plus invalid ones (a `0` for an unavailable figure, a float, a person dimension). The schema tests use them, and A16.13 builds against them.
6. **Routes** (`features/qa/qa.routes.ts`, thin; logic in `features/qa/service.ts`; mounted as `app.use('/api/qa', qaRouter)` beside the other `/api` mounts in `app.ts`). AP-1 conventions are copied from `features/audit/http.ts` into `features/qa/http.ts`, never imported across Task16's boundary: problem+json, `X-Request-ID` echoed, `Cache-Control: no-store`.
   - `GET /api/qa/questions` returns `{registry_version, items}`. It is unpaged: the registry is a fixed catalogue of at most 100 entries, not tenant data. `api.md` states this AP-1 exception.
   - `GET /api/qa/questions/{id}` returns one entry plus, per kind, whether an answer is built and which gaps are open.
   - `GET /api/qa/questions/{id}/answer?kind=&repository_id=&from=&to=&breakdown=` returns the envelope.
     - Answers come from an **answerer registry**: `registerAnswerer(questionId, kind, answerer)`, where `answerer(ctx) → Promise<Envelope>` and `ctx` carries the tenant, the validated scope and the role.
     - This session registers **none**. Every call returns 200 with `availability: unavailable` and reason `answer_not_built`, plus the question's open gaps as `not_captured_yet`.
     - The service validates every envelope an answerer returns against the schema, and answers 503 `QA_ANSWER_INVALID` when one is invalid. A bad answerer never reaches the client.
   - `GET /api/qa/questions/{id}/drilldown?kind=&scope…&limit=&cursor=`: keyset paging, `limit` 1..100, opaque cursor. Defined in `api.md` now; the route answers 501 `QA_DRILLDOWN_NOT_BUILT` until Task19b.
   - **Problems:**
     - `QA_UNAUTHENTICATED` 401, `QA_FORBIDDEN` 403;
     - `QA_QUESTION_NOT_FOUND` 404;
     - `QA_KIND_NOT_OFFERED` 400 (the question has no such kind);
     - `QA_KIND_NOT_ALLOWED` 403 (item 7);
     - `QA_SCOPE_INVALID` 400 (bad id, `from` > `to`, more than 366 days);
     - `QA_ANSWER_INVALID` 503, `QA_UNAVAILABLE` 503.

     A repository or PR id of another tenant gets the same 404 `QA_SCOPE_NOT_FOUND` as an unknown id, never 403.
7. **Authorization:**
   - One new admin action, `qa.read`, in `ADMIN_ACTIONS`, allowed for `tenant_admin` and `tenant_auditor`: one line in `adminMembershipAllows`. The router uses `problemizeAuth(requireAdminAction('qa.read'))`.
   - The server refuses `kind=live` for `tenant_auditor` with `QA_KIND_NOT_ALLOWED`. Auditors get verifiable and signed answers only (D2; rule 9, so it is not just hidden in the UI).
   - Developers get 403. Add the qa routes to `ROUTE_ACTIONS` in `auditor-sweep.test.ts`.
   - A16.13's answerers for `verifiable` and `signed` plug in through `registerAnswerer`. Where their files live is decided in A16.13's prompt.
8. **Contract files** (new `docs/contracts/qa/`, frozen once merged, additive changes only):
   - `README.md`: the rules in this section in plain words, including the honest-state rules and the no-person rule.
   - `api.md`: routes, parameters, problems.
   - `answer-v1.schema.json`.
   - `questions.md`: **generated** by `npm run qa:registry -w apps/api` from `registry.ts`, with a unit test that fails when it is stale.
   - `fixtures/`.
9. **Task2 move, pure.** If T19.1 confirms the live answers need them, move `loadContext`, `lifecycleForTenant` and `lifecycleForModel` (`read.routes.ts:84`, `:464`, `:636`) and their private helpers **unchanged** into a new Task2 file, `features/telemetry/task2-lifecycle-read.ts`, exported, and import them back in `read.routes.ts`.
   - No behaviour change; Task2's existing tests stay green unmodified.
   - Codex (Task2's owner) reviews it as part of the cross-review.
   - If the move is not a pure cut-and-paste (a helper that closes over route state, say), stop and describe it at the checkpoint instead.
10. **Tracker:** at close-out, set T19.1 and T19.2 in `TASK19.md` §2 and your §6.1 row. Leave §3's live and auditor symbols as they are (no answer ships here), and leave the status board's Task19 row to the lead.

### 2.2 Design checkpoint (stop once)
After T19.1 and a draft of `answer-v1.schema.json` and `api.md`, send the founder:
- the matrix corrections (one line each) and the Q2 size and agent;
- the estimate;
- **one question, with the recommendation:** should reading a Q&A answer be audited? Recommendation: **not for live answers**, which are aggregates like `/api/metrics/lifecycle` and the dashboards, which are not audited. A16.13 decides for verifiable answers, following the `attesta.verify` precedent.

Then build.

### 2.3 Port from
- **AP-1** (API conventions), already ported in Task16c as `features/audit/http.ts`. Copy that module's pattern into `features/qa/http.ts` with Q&A codes, and record the provenance: "pattern from Task16c `features/audit/http.ts`, catalog AP-1".
- **RP-1** (signed compliance reports): the per-figure `{count, seqs}` evidence shape, through `docs/contracts/attesta/period-report.md`.
- No SushiCorp module answers questions over its own data, so the registry and the envelope are new. Say so in the handoff.

### 2.4 Pre-approved files
- `docs/contracts/qa/` (new): `README.md`, `api.md`, `answer-v1.schema.json`, `questions.md` (generated), `fixtures/`.
- `apps/api/src/features/qa/` (new): `registry.ts`, `types.ts`, `envelope.ts` (validation), `service.ts`, `http.ts`, `qa.routes.ts`, `answerers.ts`, `generate-registry.ts`, `qa-contract.test.ts`, `qa-api.test.ts`, `task19a-qa-live-verify.ts`.
- `apps/api/src/app.ts`: the one mount line.
- `apps/api/src/core/security/admin-authorization.ts`: `qa.read` and its one auditor line.
- `apps/api/src/core/security/auditor-sweep.test.ts`: the qa rows.
- Item 9 only:
  - `apps/api/src/features/telemetry/read.routes.ts`: removing the moved functions and importing them;
  - `apps/api/src/features/telemetry/task2-lifecycle-read.ts` (new).
- `apps/api/package.json`:
  - register the two test files in `test`;
  - add `qa:registry` and `verify:task19a-qa-live` in alphabetical position;
  - no new dependency: validate with the `ajv` already in `apps/api/package.json`.
- `docs/plan/TASK19.md` (§2 rows T19.1/T19.2, §3 corrections, the new §3.1, your §6.1 row); `docs/plan/CUSTOMER_AUDITOR_QA.md` (row corrections and gap owners only).
- `docs/plan/STATUS_BOARD.md` (registry rows and the remaining-plan actual only); the handoff.

### 2.5 Never touch
- Other contracts under `docs/contracts/`; `core/db/schema.ts`; any migration (none in this session).
- `apps/web/`.
- Any Task2 metric function's behaviour (item 9 is a move, not a change).
- Task6, Task15 and Task16 code.
- Raw content: no envelope field may carry a prompt, command, code, path or diff. Task5's reveal stays the only path.

If the contract needs something outside this list, stop and describe it.

## 3. Working rules
- **Commits** prefixed `Task19a-qa-matrix-contract: …`, in this order:
  1. T19.1 docs;
  2. interfaces (types, schema, stubs that throw);
  3. registry and generator;
  4. envelope validation;
  5. routes;
  6. the Task2 move as its own commit, so Codex can review it alone;
  7. the handoff.

  `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (no database; through the real router in-process, with a fake membership like `audit-api.test.ts` uses):
  - the registry matches `CUSTOMER_AUDITOR_QA.md`: parse both tables, compare ids, ranks and auditor flags;
  - `questions.md` is in sync;
  - the no-person scan;
  - every security question carries `monitor_only_observed`;
  - every fixture validates or fails as named;
  - unavailable is never `0`;
  - each problem code is raised;
  - an auditor is refused `live` and allowed `verifiable`;
  - a developer is refused;
  - an answerer returning an invalid envelope gives 503;
  - `X-Request-ID` is echoed and `no-store` is set;
  - after item 9, Task2's existing tests pass unmodified.
- **Integration, IT-T19a-01** (`scripts/it-db.sh npm run verify:task19a-qa-live -w apps/api`), through the real JWT and tenant middleware and `createApp()` on a throwaway database:
  - (a) an admin of Company A gets the Q3 live envelope (`answer_not_built`), valid against the schema;
  - (b) an auditor gets 403 `QA_KIND_NOT_ALLOWED` for live, and 200 for verifiable;
  - (c) a developer gets 403;
  - (d) Company A asking with Company B's repository id gets 404 `QA_SCOPE_NOT_FOUND`;
  - (e) the request id is echoed.

  Run it once in your sandbox; it is blocking for the merge.
- **Review:** one independent review subagent before the handoff (AGENTS.md §12.3); then Codex's cross-review.

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 120 lines**. It names:
  - the contract files and the answerer interface (what Task19b/19c and A16.13 build against);
  - the matrix corrections;
  - the Q2 decision;
  - whether item 9 happened;
  - **Effort**.
- `docs/plan/STATUS_BOARD.md`: the IT-T19a-01 registry row and the remaining-plan actual (row 7i1).
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape:
  - the effort line;
  - one bash block with:
    1. the bundle fetch into a new worktree;
    2. `npm ci`;
    3. `npm test`;
    4. IT-T19a-01;
    5. under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task19a-qa-matrix-contract … --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task19a-qa-matrix-contract`; and `gh pr merge task/Task19a-qa-matrix-contract --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok (AGENTS.md §9 items 22–23);
  - then the review request for Codex in a `text` block.
- **Founder steps are numbered:** every bash block numbers its sections `# 1.`, `# 2.`, in run order, with the expected result after each.
- **Ledger lines (AGENTS.md §9 item 23):** edit only your own rows; add `package.json` scripts in alphabetical position.

## Lessons so far
From `docs/agents/MANAGER_PROMPT.md` and the Task19 lead prompt:
- **Task16a–16f:**
  - early catalogs missed raw-SQL sites, so grep both forms;
  - a fact without `file:line` costs a review round;
  - review rounds converged fastest with must-fix items only.
- **Task16b:** the catalog as code plus a generated, test-checked document is the shape to copy for the registry (`core/audit/catalog.ts`, `generate-catalog.ts`). Names freeze on day one: a rename later is a breaking change.
- **Task6.a:** Codex's report is the authority on why 48 rules were deferred. Do not reopen a deferral in this session.
