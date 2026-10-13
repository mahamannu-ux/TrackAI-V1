# Handoff prompt: Task15m-attesta-github-check (a "TrackAI Attesta" check on each pull request), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15m-attesta-github-check && cd ~/AIProjects/TrackAI-wt/Task15m-attesta-github-check && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; paste everything below the line. Reply "continue" if it stops. Start it after Muse finishes Task15k (one Muse session at a time). No shared files with Task15k or Claude's Task15i3/15i4.
> 3. **FOUNDER (before the live check at the end, not before starting):** in GitHub → Settings → Developer settings → GitHub Apps → your TrackAI app → Permissions, set **Checks: Read and write**, save, and accept the new permission on each installation (GitHub emails the installation owner). Nothing else changes in the App.
> 4. When it finishes, paste its review request to the Task15 lead Claude chat. Push only after "ready to push".

---

You are **Muse**, building **Task15m-attesta-github-check** (subtask A15.14) for **TrackAI**, an AI code provenance product.

Attesta signs one statement per commit, merged PR and production deployment, chains them per tenant and anchors them in public logs. This session makes that visible where developers already look: TrackAI's server posts a **GitHub check run named "TrackAI Attesta"** on each pull request through the GitHub App the customer already installed. In phase 1 the check is **informational**: its conclusion is always `neutral` (no policy decides pass or fail yet; that is Task6.b), so it never blocks a merge, and its text says how many of the PR's commits are attested and anchored.

**Every decision is made below (this is the lead's design note); do not redesign.** No new route, no migration, no webhook change, no console change.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15m-attesta-github-check`, branch `task/Task15m-attesta-github-check`.
- **Handoff:** `docs/handoffs/Task15m-attesta-github-check_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §4, §6, §7, §9 items 3, 13, §11, §12.4.
2. Check where you are: `pwd && git branch --show-current && git log --oneline -1` (the worktree above, branch `task/Task15m-attesta-github-check`; otherwise stop). Then `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. `npm test` once (baseline count).
4. Estimate in one line against T6. The plan says **about 0.05×**; with the live test, 0.07×.

## 1. Read (read-only)
- `apps/api/src/features/scm/github-app.ts` (all of it: `installationToken`, `githubGet`, the `fetch` headers), `apps/api/src/features/telemetry/repository-url.ts` (`normalizeRepositoryUrl`), `apps/api/src/core/db/schema.ts` (`scmRepositories` ~line 75, `scmPullRequests` ~line 809, `scmCommits`, `scmPullRequestCommitMemberships` ~line 1146).
- `apps/api/src/features/attesta/read-service.ts` (`anchorStatusOf`, `ANCHOR_WINDOW_MS`) and `docs/contracts/attesta/tables.md` (`attesta_records`, `attesta_anchors` columns).
- `apps/api/src/features/attesta/t15i-evidence-api-live-verify.ts` (`seedTenant`, `ingestCommit`, `observeAll`, `build`, `anchoringEnv`: the seeding you will copy for the live test).
- GitHub REST: create a check run `POST /repos/{owner}/{repo}/check-runs`, update `PATCH /repos/{owner}/{repo}/check-runs/{id}`, list `GET /repos/{owner}/{repo}/commits/{ref}/check-runs?check_name=…&filter=latest` (API version `2022-11-28`).

## 2. Scope (approved)
### 2.1 Decisions
1. **One GitHub write helper** in `github-app.ts` (the only change there): `export async function githubWrite<T>(method: 'POST' | 'PATCH', path: string, body: unknown, tenantId: string, owner: string): Promise<{ status: number; data: T | null }>`. It uses `installationToken(tenantId, owner)`; **no token → returns `{ status: 0, data: null }` without any request** (never public, never `GITHUB_ALLOW_PUBLIC_READ`). Same headers as `githubGet` plus `Content-Type: application/json`. It never throws on a 4xx/5xx: it returns the status and `data: null`; network errors return `{ status: -1, data: null }`. Also export `githubGetStatus<T>(path, tenantId, owner)` with the same no-throw contract for the list call (do not change `githubGet`).
2. **Which PRs, per pass** (`selectPullRequests(executor, tenantId, now)`): PRs of that tenant whose repository has `provider = 'github'`, and that are `state = 'open'` with a non-null `head_sha`, or merged (`merged_at` not null) within the last 7 days with a non-null `merge_commit_sha`; newest `updated_at` first; at most 200 per tenant per pass. Every query binds `tenant_id = $1` explicitly.
3. **Which sha the check is posted on:** open PR → `head_sha`; merged PR → `merge_commit_sha`. `external_id` = `trackai-attesta:<pr uuid>`. Owner and repository name come from `normalizeRepositoryUrl(repository.url)` (`github.com/<owner>/<name>`); a URL that does not parse, or a host that is not `github.com`, skips the PR (counted).
4. **What is counted** (`attestationFacts(executor, tenantId, pr, now)`, explicit tenant binding):
   - Open PR: the PR's commits = `scm_pull_request_commit_memberships` rows with `active = true` for that PR, joined to `scm_commits.sha`. For each sha, the `commit_observed` record in `attesta_records` (same tenant, the PR's `repository_id`, `subject_sha`), and its anchor rows in `attesta_anchors` (`status = 'anchored'`, per `anchor_type`). State per commit: `none` (no record), or `anchorStatusOf({rekor, tsa}, recorded_at, now)` → `anchored` / `pending` / `missing`.
   - Merged PR: the `pr_merged` record for `merge_commit_sha` in that repository, with the same state rule (it decides the title); the counts and the table still list the PR's `active = true` member commits, as for an open PR.
   - Never read titles, bodies, author names, emails, file paths, notes or statement contents. Only shas, kinds, times and anchor rows.
5. **The check run** (`checkRunPayload(facts)`, pure function):
   - `name: "TrackAI Attesta"`, `head_sha`, `external_id`, `status: "completed"`, **`conclusion: "neutral"` always**, `completed_at` = now, `details_url` = `${TRACKAI_CONSOLE_URL}/dashboard` when that env var is set (no IDs in the URL), else omitted.
   - `output.title` (exact): open PR → `"<A> of <N> commits attested · <K> anchored"`; merged PR with its statement → `"Merge attested · anchored"` / `"Merge attested · anchoring pending"` / `"Merge attested · anchor overdue"`; merged PR without → `"Merge not attested yet"`; open PR with N = 0 → `"No commits observed yet"`.
   - `output.summary` (exact first line): `"Informational: TrackAI records which commits it has signed and anchored. This check never blocks a merge."`, then a blank line, then counts: `"Attested: A · Anchored: K · Anchoring pending: P · Anchor overdue: O · Not attested yet: U"`.
   - `output.text`: a Markdown table `| Commit | State |` with the first 7 hex of each sha and one of `Signed · anchored` / `Signed · anchoring pending` / `Signed · anchor overdue` / `Not attested yet`, at most 50 rows, then `"… and <n> more"`. Order: by sha ascending (stable).
   - Bound: title ≤ 255 chars, summary and text ≤ 60 000 chars each.
6. **Idempotent post** (`postCheck(deps, tenantId, owner, repo, payload)`): list `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?check_name=TrackAI%20Attesta&filter=latest`; if a run with the same `external_id` exists and its `output.title` and `output.summary` equal the new ones, do nothing (`unchanged`); if it exists and differs, `PATCH` it (`updated`); else `POST` (`created`). Results: `created | updated | unchanged | skipped_no_installation (status 0) | permission_missing (403) | not_found (404) | failed (other or -1)`. A 403 or 404 never throws and never retries in the same pass.
7. **The pass** (`runGithubCheckPass(db, deps, { tenantId?, now?, limit = 200 })` in `apps/api/src/features/attesta/github-check.ts`): for each tenant (or the one given), select PRs, build facts and payload, post; returns counts per result plus `skipped_url`. `deps = { write: typeof githubWrite; getStatus: typeof githubGetStatus; env: NodeJS.ProcessEnv }` so tests inject fakes. Logs: one line per pass with the counts and tenant count; no shas, no repo names, no tokens.
8. **CLI** `npm run attesta:github-checks -w apps/api [-- --tenant <uuid>] [--limit 200]` runs one pass and prints the counts. Production scheduling (every 5 minutes, after the build and anchor passes) is Task14's; say so in the handoff.

### 2.2 Port from
None: SushiCorp has no SCM integration (catalog checked: WH-1 covers inbound webhooks only). The GitHub calls follow the existing `github-app.ts` conventions; say so in the file header.

### 2.3 Pre-approved files
`apps/api/src/features/scm/github-app.ts` (only the two new exported helpers), `apps/api/src/features/attesta/github-check.ts` (new) and `github-check.test.ts` (new), `apps/api/src/features/attesta/attesta-github-check-cli.ts` (new), `apps/api/src/features/attesta/t15m-github-check-live-verify.ts` (new), `apps/api/package.json` (the `test` registration, the `attesta:github-checks` and `verify:task15m-github-check-live` scripts only, in alphabetical position), `docs/handoffs/Task15m-attesta-github-check_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (its registry rows only), `docs/plan/TASK15.md` (A15.14 status only).

### 2.4 Never touch
`docs/contracts/`, every migration and `schema.ts`, the rest of `github-app.ts`, `scm.routes.ts` and every other `features/scm/` file, every other `features/attesta/` file (read and import only), `apps/web/`, `apps/api/src/app.ts`, `core/`, dependencies. If something seems to need one of these, stop and say so.

## 3. Working rules
- Commits `Task15m-attesta-github-check: …`: write helpers; facts and payload; post and pass; CLI; live test; handoff.
- **Unit tests (`github-check.test.ts`, no network, no database; memory executor and a fake fetch-like recorder):**
  1. Payload, open PR with commits `aaaaaaa…` anchored, `bbbbbbb…` pending, `ccccccc…` none → title `"2 of 3 commits attested · 1 anchored"`, conclusion `"neutral"`, summary counts `"Attested: 2 · Anchored: 1 · Anchoring pending: 1 · Anchor overdue: 0 · Not attested yet: 1"`, text rows in sha order with the right labels.
  2. Merged PR whose `pr_merged` record is anchored → `"Merge attested · anchored"`; without a record → `"Merge not attested yet"`; open PR with no commits → `"No commits observed yet"`.
  3. 120 commits → 50 table rows then `"… and 70 more"`; every limit respected.
  4. Post: no existing run → one `POST` with the payload; existing run with the same `external_id`, title and summary → no write (`unchanged`); same `external_id`, different summary → one `PATCH` to its id (`updated`); a run from another app or another `external_id` is ignored (creates its own).
  5. `githubWrite` with no installation token → `skipped_no_installation`, and the fake records **no** request; 403 → `permission_missing`; 404 → `not_found`; 500 and a thrown network error → `failed`; the pass continues to the next PR.
  6. Privacy: seed a PR titled `"SECRET-TITLE"` with author `"dev@example.com"` and a commit subject `"SECRET-SUBJECT"`; assert none of those strings appears in any request body, and that the only 40-hex sha in a body is its `head_sha` field.
  7. Tenant binding: every SQL text the executor receives contains the tenant parameter; tenant A's pass never selects tenant B's PRs (memory executor with both).
  8. Non-github repository URL and an unparsable URL → `skipped_url`, no request.
- **Live (`scripts/it-db.sh npm run verify:task15m-github-check-live -w apps/api`), with a fake GitHub (an in-process `fetch` stand-in passed through `deps`; no real GitHub):** `IT-T15m-01` seed a tenant through the real Task2 ingestion, builder and anchoring passes (copy `seedTenant`, `ingestCommit`, `observeAll`, `build`, `anchoringEnv` from `t15i-evidence-api-live-verify.ts`), add an open PR with three member commits of which two are built → the pass posts one check with title `"2 of 3 commits attested · …"`; a second pass is `unchanged`; after the anchoring pass it is `updated`. `IT-T15m-02` Company A/B: tenant B's pass posts nothing about A's PRs, and A's check counts only A's records. Run each once in your sandbox.
- **Founder-live `IT-T15m-03`** (after the App permission in setup step 3; non-blocking for this merge, blocking for calling the check "shipped"): with a real installation and a test PR, run `npm run attesta:github-checks -w apps/api -- --tenant <uuid>` and confirm the check appears on the PR as neutral with the expected title. Give the exact commands in your final reply.
- **Review:** re-read the full diff as a reviewer before the handoff (AGENTS.md §12.3), checking each title string against §2.1 item 5 and that no request body can contain anything but short shas, counts and fixed text.

## 4. Close-out
- Handoff (`docs/templates/HANDOFF_TEMPLATE.md`), under 60 lines: the check's wording, the result codes, the founder's App permission step, IT rows, Effort.
- Registry rows IT-T15m-01…03 (01–02 🟡 sandbox, ⬜ founder; 03 ⬜), inserted in ID order; `TASK15.md` A15.14 row 🟡. Leave the status board's Task15 row to the lead (AGENTS.md §9 item 23). Final bash block: preflight before merge (§9 item 22).
- Clean tree; do not push. Final reply in the AGENTS.md §12.4 shape, with the review request (for the Task15 lead Claude chat) in a `text` block.

## Lessons so far
- **Task15h (Claude):** read Task2's tables only through their stated columns and always bind the tenant; never select a column you do not need (emails, titles, notes).
- **Task15f2 (Claude):** persistent failures end in a visible count, never an endless retry.
- **Task9e (Muse):** keep new code in its own files; touch shared files only where the prompt says.
