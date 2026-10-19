# Handoff prompt: Task19g-merged-by-rejections-line-blame (gaps G4 and G5, and Q2's line walk), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge this prompt's docs PR after `scripts/pr-preflight.sh docs/Task19-gap-prompts-g4-g5-q2` says ok. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Codex:** start a new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`), and paste everything below the line.
> 3. Q2 needs a real GitHub repository with the TrackAI GitHub App installed, for one live check (step 4 of its integration test). Codex gives you the commands; never paste a token into the chat.
> 4. When it finishes, paste its review request to the **Task19 lead (Claude)**. Claude is also the Task16 owner for the one audit catalog entry. Push only after "ready to push".

---

You are **Codex**, building **Task19g-merged-by-rejections-line-blame** for **TrackAI**, an AI code provenance and coding-agent security product built on a fork of Git AI. You own Task2 and Task4, and this one session closes three open rows of the customer and auditor Q&A (`docs/plan/CUSTOMER_AUDITOR_QA.md`):

| Part | Gap | Owner | Question it answers |
|---|---|---|---|
| A | **G4**: who merged a pull request (`merged_by` is in GitHub's webhook but never parsed or stored) | Task2 | **Q6** "Who committed, and who merged, each AI-assisted change?" (answered without naming people: §2.1 item 4) |
| B | **G5**: refused uploads leave no record (rejected events are dropped before storage) | Task4 | **Q15** "Did any AI-assisted code come from a machine or repository without a valid grant, and was it rejected?" |
| C | **Q2's line walk** (the old `Task19d-qa-line-walk`) | Task19 | **Q2** "For one line of a file at a commit: was it written by AI, by which agent, model and session, and when?" |

Build them **in this order, A → B → C**, each in its own commits. **Stop point:** if the session passes about 0.3× T6 after part B, stop, close out A and B, and describe what C needs in the handoff. The lead will write C as its own session.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). Your worktree is under `~/AIProjects/TrackAI-wt/`; branch `task/Task19g-merged-by-rejections-line-blame`.
- **Handoff:** `docs/handoffs/Task19g-merged-by-rejections-line-blame_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full. In particular:
   - §1 rules 1, 6–9;
   - §4;
   - §7 (migrations, Company A/B);
   - §9 items 3, 4, 10 and 22–23;
   - §10 AP-1;
   - §12.4.
2. `pwd`: you must be under `~/AIProjects/TrackAI-wt/`. If you are detached or on `codex/…`, run `git switch -c task/Task19g-merged-by-rejections-line-blame`. Identity `mahamannu-ux` / `mahamannu@gmail.com`, per worktree.
3. `npm ci && npm test` as a baseline.
4. **Estimate** in one line: the plan says **about 0.25×** (A about 0.06×, B about 0.07×, C about 0.12×).

## 1. Read before writing code
- **The Q&A contract:** `docs/contracts/qa/README.md`, `api.md`, `answer-v1.schema.json`, `questions.md`. It is frozen except for **additive** changes (Task16h and Task19f set the precedent), and every addition must land in both `answer-v1.schema.json` and `apps/api/src/features/qa/answer-schema.ts`.
- **Registry and answerers:**
  - `features/qa/registry.ts` (Q2 `:99`, Q6 `:103`, Q15 `:110`; G4 `:211`, G5 `:212`; `QA_REGISTRY_VERSION`);
  - `features/qa/qa-contract.test.ts` (`REGISTRY_DIGESTS`);
  - `features/qa/answers/` (Task19b's pattern: `common.ts`, a pure `computeQn`, `register-code.ts`);
  - `features/qa/answers/answers-code.test.ts`.
- **Task2 read functions:** `features/telemetry/task2-lifecycle-read.ts` (`loadContext` `:70`, `pullRequestIntelligence` `:343`).
- **Part A:**
  - `features/scm/parser.ts:173-226` (the `pull_request` branch);
  - `features/scm/scm.routes.ts:88-172` and `:424` (projection and identity);
  - `core/db/schema.ts` `scmPullRequests` (`:1148-1172`);
  - `provider_event_deliveries.raw_event` (retained webhooks).
- **Part B:**
  - `features/telemetry/ingest.routes.ts:39-77` (`POST /worker/metrics/upload`);
  - `features/telemetry/repository-enforcement.ts:86-200`, whose four error messages are listed in §2.2;
  - `core/audit/catalog.ts` (`AUDIT_CATALOG_VERSION` 4; machine-actor entries `:760-800`), `core/audit/record.ts` (`recordAuditEvent`), and `docs/contracts/audit/catalog.md` (generated).
- **Part C:**
  - `features/scm/github-app.ts` (installation tokens `:58`, `:96`; REST helpers `:114-190`);
  - `scm_commit_files` (`path`, `attribution_ranges`);
  - `scm_commit_lineage`, `scm_merge_lineage`;
  - `features/telemetry/decoder.ts:147` (how ranges are read).
- `docs/plan/TASK19.md` §3.1, the rows for Q2, Q6 and Q15.

## 2. Scope (lead decisions)

### 2.1 Part A: G4, merged-by (Task2)
1. **Migration (the next number after `0027`, generated with `drizzle-kit generate`):** add `merged_by_provider_id text` and `merged_by_login text`, both nullable, to `scm_pull_requests`. Nothing else in that migration.
2. **Parser and projection:**
   - For `pull_request` `closed` with `merged_at`, read `pull_request.merged_by.id` and `.login`. Absent stays null; never invent one. Carry them through `parser.ts` and `scm.routes.ts` exactly like the author fields, idempotently.
   - Upsert the merger into `scm_provider_identities` the way the author is (`scm.routes.ts:424`).
3. **Backfill:** `npm run backfill:task19g-merged-by -w apps/api` re-parses retained GitHub `pull_request` closed-and-merged deliveries.
   - **Dry-run by default** (prints the tenant and PR counts it would set); `--confirm` applies.
   - It only fills null fields, never overwrites a value, and writes one `scm.merged_by.backfilled` audit event per tenant with the count (AGENTS.md §9 item 10). That is a new catalog entry: owner Task2, severity `notice`, actor `system_operator`, details `{updated: integer, skipped: integer}`.
4. **Q6 live answer** (`features/qa/answers/q06.ts`). Scopes: repository and pull_request, as in the registry. It never names a person; logins stay in the database. Figures:
   - `ai_assisted_merged_prs`: PRs merged in the period whose `pullRequestIntelligence(...).finalAiLines > 0`;
   - `merged_by_author`: merger provider id equals author provider id;
   - `merged_by_someone_else`;
   - `merger_unknown`: a null merger (pre-backfill, or not supplied). If it is greater than 0, the other two are `partial` with `not_captured_yet` G4 until the backfill has run; afterwards `recorded`;
   - `committer_known`: commits of those PRs with a non-null commit author, counted not named.
   
   Breakdown `repository`. G4 becomes `open: false`.

### 2.2 Part B: G5, the rejection audit event (Task4, plus one Task16 catalog entry)
1. **Catalog entry `telemetry.upload.rejected`** in `core/audit/catalog.ts`:
   - owner Task4, severity `notice`, actor `machine`, target `tenant`, status `emitted`;
   - details `{event_count: integer, reason_counts: counts, repository_digests: string[] (≤ 20, sha256_hex of the canonical https URL), request_id?: string}`;
   - `reason_counts` keys are exactly `repository_missing`, `repository_url_invalid`, `grant_inactive`, `before_watermark`, mapped from the four messages in `repository-enforcement.ts`.

   Bump `AUDIT_CATALOG_VERSION` and regenerate `docs/contracts/audit/catalog.md`. **No URL, path, branch name or event content in details.**
2. **Emit** in `ingest.routes.ts`, after `validateBatchIngestionPolicy` and before `ingestMetricsBatch`, **only when** `policy.errors.length > 0` **and** the request is from a managed machine (`req.machineId`). Write one event per upload request.
   - **Fail closed:** if the audit write fails, answer 503 and ingest nothing, so the client retries and no rejection goes unrecorded.
   - Unmanaged legacy uploads are not counted; the handoff says so.
3. **Q15 live answer** (`features/qa/answers/q15.ts`), read from `security_audit_events` with `action = 'telemetry.upload.rejected'` in the period, through `withTenant`. Figures:
   - `rejected_uploads` (rows);
   - `rejected_events` (sum of `event_count`);
   - one `rejected_events_<reason>` per reason key;
   - `rejected_repositories` (distinct digests).

   Breakdown `machine` (key = machine UUID; actor id). The `repository` breakdown answers `answer_not_built` (digests are not repository ids). The figures are `recorded` from the deploy date on. Before the first event of this action exists for the tenant, every figure is `partial` with `not_captured_yet` G5, never 0. G5 becomes `open: false`.

### 2.3 Part C: Q2, the line walk (Task19)
1. **Request.** These are additive contract changes:
   - `api.md`: two answer parameters, `file_id` (a `scm_commit_files` row UUID, required for Q2 and refused for every other question with `QA_SCOPE_INVALID`) and `line` (integer 1..1 000 000, required with `file_id`). A file of another tenant, or one not in the given commit, is 404 `QA_SCOPE_NOT_FOUND`.
   - `scope` in `answer-v1.schema.json` and `answer-schema.ts` gains the optional `file_id` and `line`.
   - The commit drill-down (`features/qa/drilldown.ts`) now lists the commit's files (`scope:'file'`, `id` = row UUID, label `file <n>`, never the path).
   - The path stays server-side; it never enters a request, an envelope or a log.
2. **Blame.** A GitHub App read helper `features/scm/github-blame.ts` calls GraphQL `repository(owner,name){object(oid){... on Commit{blame(path){ranges{startingLine endingLine commit{oid}}}}}}`.
   - It uses the repository's installation token, times out after 10 seconds, and has no retry inside a request.
   - Results are cached in memory for 10 minutes per `(tenant, repository, commit, file)`; there is no table.
   - A non-GitHub repository, no installation, or a provider error makes the figures `unavailable` (`not_captured_yet` for missing installation permissions, `answer_not_built` for non-GitHub). A thrown error becomes 503 `QA_UNAVAILABLE` through the service. Never a guess.
3. **Mapping:** the blame range covering `line` gives the originating commit SHA. Find that commit among the tenant's `scm_commits` in the repository, following `scm_commit_lineage` / `scm_merge_lineage` when the SHA was rewritten.
   - **Exact:** the originating commit is the requested commit. Its `attribution_ranges` for the file give the line's author kind and session, and from there the agent, model and session ids.
   - **Partial:** otherwise. Blame gives no original line number, so report that commit's file-level AI and human lines, its sessions and models, with `partial_linkage`.
   - **Unavailable:** the commit is unknown to TrackAI (no Git AI note), with `not_captured_yet`.
4. **Q2 live answer** (`features/qa/answers/q02.ts`). Figures:
   - `line_written_by_ai` (count 1 or 0, only when exact);
   - `originating_commit_known` (1 or 0);
   - `file_ai_lines` and `file_human_lines` at the originating commit.

   Drill-down: the originating commit (`scope:'commit'`, label 12-hex SHA) and its sessions (`scope:'session'`, id only). Wording `metadata_only`. The registry builder for Q2 is `Task19d`; keep it (it names the work, not the session).
5. **Rate limits:** one GraphQL call per uncached request. Log the request id and status only, never the path or response body.

### 2.4 Registry and catalogue (Task19)
- `QA_REGISTRY_VERSION` is bumped once (to the next number after main's) with G4 and G5 closed. Record the new digest. `questions.md` is regenerated.
- `docs/plan/CUSTOMER_AUDITOR_QA.md`: the Q2, Q6 and Q15 rows and G4/G5 in "Gaps found" say what is now answered.
- `docs/plan/TASK19.md`: the Q2, Q6 and Q15 matrix rows (status symbols), the §6.1 rows for Task19d (marked "merged into Task19g") and your own new row.

### 2.5 Port from
None. Part A follows the PR author fields already in TrackAI, part B follows Task16b's catalog-and-emitter pattern, and part C uses the GitHub App client TrackAI already has. No SushiCorp module applies.

### 2.6 Pre-approved files
- **Part A:** the new migration and its `meta/` snapshot; `core/db/schema.ts` (the two columns only); `features/scm/parser.ts`, `features/scm/scm.routes.ts` (merger fields only); `features/scm/task19g-merged-by-backfill.ts` (new).
- **Part B:** `core/audit/catalog.ts` (two new entries: this one and `scm.merged_by.backfilled`), `docs/contracts/audit/catalog.md` (regenerated); `features/telemetry/ingest.routes.ts` (the emit only).
- **Part C:** `features/scm/github-blame.ts` (new); `features/qa/drilldown.ts` (commit → files); `features/qa/service.ts` (the two parameters).
- **Q&A:**
  - `features/qa/answers/q02.ts`, `q06.ts`, `q15.ts`, `register-code.ts`, tests;
  - `features/qa/registry.ts`, `qa-contract.test.ts`;
  - `features/qa/answer-schema.ts`, `docs/contracts/qa/answer-v1.schema.json`, `api.md`, `questions.md`, `README.md` (additive lines);
  - `features/qa/task19g-qa-live-verify.ts` (new).
- `apps/web/src/lib/api.ts` and `apps/web/src/app/dashboard/questions-workspace.tsx`: only what the Questions screen needs to pass `file_id` and `line` for Q2 from the file drill-down (a line-number input), with no new screen.
- `apps/api/package.json`: the backfill and `verify:task19g-qa-live` scripts in alphabetical position, plus the test files.
- `docs/plan/TASK19.md`, `CUSTOMER_AUDITOR_QA.md`, `STATUS_BOARD.md` (your registry rows and remaining-plan row), the handoff.

### 2.7 Never touch
- Other contracts (`docs/contracts/attesta/`, `security-v2/`, `task6/`) and merged migrations.
- Task2 lifecycle calculations.
- `features/security-findings/`.
- Raw content: no path, code, diff, URL, branch or login leaves the server in any envelope or log.

## 3. Working rules
- **Commits** prefixed `Task19g-merged-by-rejections-line-blame: …`, grouped per part:
  - A: migration, parser and projection, backfill, Q6;
  - B: catalog, emit, Q15;
  - C: contract additions, blame helper, mapping, Q2, UI input;
  - then the registry and catalogue updates, and the handoff.

  `npm run lint`, `npm run typecheck`, `npm run check` and `npm run build -w apps/web` must be clean; `drizzle-kit check` too.
- **Unit tests:**
  - **A:** parser merged / not merged / missing `merged_by`; projection idempotency; backfill dry-run changes nothing and `--confirm` fills only nulls; Q6 self-merge vs other vs unknown, with no login anywhere in the envelope.
  - **B:** the four reasons map exactly; the details contain no URL; audit failure gives 503 and nothing ingested; Q15 partial before the first event, then recorded.
  - **C:** Q2 exact / partial / unknown commit; a non-GitHub repository; a blame timeout gives 503; the path is absent from envelope, logs and drill-down labels; `file_id` is refused on other questions; another tenant's file gives 404.
  - Every envelope goes through `answerQuestion` with the real validator.
  - Company A/B isolation for each new read.
- **Integration, IT-T19g-01** (`scripts/it-db.sh npm run verify:task19g-qa-live -w apps/api`), through `createApp()` and the real middleware on a throwaway database:
  1. a replayed GitHub merged-PR webhook stores the merger, and Q6 counts it;
  2. a managed-machine upload with an ungranted repository writes one `telemetry.upload.rejected` event, and Q15 counts it;
  3. Company B sees neither;
  4. **founder-live:** Q2 on one real line of a real GitHub repository with the App installed. Q2 is answered through a stub blame helper in the database test; this step is the founder's run, with commands in your final reply.

  Steps 1–3 are blocking for the merge; step 4 is blocking for marking Q2 answered.
- **Review:** one independent review before the handoff (AGENTS.md §12.3), then the Task19 lead's cross-review.

## 4. Close-out
- The handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 120 lines**, per part. It names:
  - the migration number;
  - the catalog version;
  - the registry version and digest;
  - the figure keys;
  - what Attesta could now add (`merged_by` in the `pr_merged` predicate; rejection counts in a batch statement), as notes for the Task15 lead;
  - **Effort**.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape, with numbered founder steps. One bash block with:
  1. tests and IT-T19g-01 steps 1–3;
  2. the dry-run backfill;
  3. the step 4 commands;
  4. under `# after the cross-agent review`: push, `gh pr create --base main --head task/Task19g-merged-by-rejections-line-blame --title "[Task19g] Merged-by, rejection audit and line walk (G4, G5, Q2)" --body-file docs/handoffs/Task19g-merged-by-rejections-line-blame_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`, the preflight, then the merge only after the preflight says ok.

  Then the review request for the Task19 lead in a `text` block.

## Lessons so far
- **Task19b and Task19f:** both overran mostly on contract edges. Add every enum value to both schema copies first, and validate envelopes through `answerQuestion` from the first commit.
- **Task16b:** catalog names freeze on merge. Choose `telemetry.upload.rejected` and the details keys once.
- **Q&A rule:** no person and no path ever reach an envelope. Logins and file paths stay in the database.
