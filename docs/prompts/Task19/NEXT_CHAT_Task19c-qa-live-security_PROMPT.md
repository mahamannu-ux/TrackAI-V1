# Handoff prompt: Task19c-qa-live-security (live answers for the security questions), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`. `main` must contain Task19b (`features/qa/` code answerers) and Task20d (migration `0025`, the v2 security tables).
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task19c-qa-live-security && cd ~/AIProjects/TrackAI-wt/Task19c-qa-live-security && npm ci && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 3. When it finishes, paste its review request to the **Task20 lead (Claude)**, who reviews for the Task19 lead (founder, 2026-10-18). Push only after "ready to push".

---

You are **Muse**, building **Task19c-qa-live-security** (Task19 T19.4) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task19a froze the Q&A contract (`docs/contracts/qa/`). Task19b registered live answerers for ten code questions. Task20d added Numbat-backed security tables (the "v2" rows in `security_findings` and six new tables) beside Task6.a's older rows.

This session registers **live answerers for the security questions that have data**, reading both generations of findings, plus Q11. It changes no contract, no table, no ingest and no UI.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task19c-qa-live-security`, branch `task/Task19c-qa-live-security`.
- **Handoff:** `docs/handoffs/Task19c-qa-live-security_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1 rules 6–9 (raw content, honest states, server authoritative), §2 "Names", §4, §7, §8, §9 items 3 and 22–23, and §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/`. Set `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` in this worktree. Check that `apps/api/src/features/security-findings/v2-storage.ts` exists; otherwise stop.
3. Run `npm test` once as a baseline.
4. **Estimate** in one line against T6. The plan says **about 0.10×**.

## 1. Read before writing code
- **The contract, frozen** (never edit `docs/contracts/`): `docs/contracts/qa/README.md`, `api.md`, `answer-v1.schema.json`, `questions.md` (the S rows and Q11: wording, scopes, breakdowns, caveats), `fixtures/`.
- **How Task19b did it:** `docs/prompts/Task19/NEXT_CHAT_Task19b-qa-live-code_PROMPT.md` §2.1 ("Rules for every answerer"). **Every rule there applies here unchanged**: pure `computeX` functions, ratios not floats, `null` never `0`, worst availability at the top level, gaps as `not_captured_yet`, metadata only. Also read `docs/handoffs/Task19b-qa-live-code_HANDOFF.md` and the code in `apps/api/src/features/qa/`.
- **The data:**
  - `apps/api/src/core/db/schema.ts`:
    - `security_findings` (both generations: `record_generation` is `'task6a'` or `'v2'`);
    - `security_enforcement_decisions`, `security_permission_events`;
    - `security_status_snapshots`, `security_agent_inventory_snapshots`;
    - `fleet_machine_states` (`platform`), `developer_machines`;
    - `ai_sessions` (`external_session_id`);
  - `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md` (what v2 columns mean; v2 `rule_category` is the `rule_id` text before its first `.`; v2 `rule_pack_version` is `bundle:` plus 16 hex characters);
  - `docs/plan/TASK19.md` §3 rows S1–S18 and §3.1 (sources);
  - `docs/contracts/security-v2/README.md` "Record decisions".
- **Never read** `security_finding_previews` (encrypted command, path and URL previews). Live answers are metadata only.

## 2. Scope (every decision made by the lead)

### 2.1 Common rules
1. **One query module** `features/qa/security-read.ts`. It loads the tenant's findings in the period through `withTenant()`: both generations, metadata columns only. Each answerer is `computeSn(rows, ctx)`, pure, driven by synthetic rows in tests.
2. **The period** uses `occurred_at`, which is the detection time for v2 rows.
3. **Generation-neutral fields:**
   - `rule_id`, `rule_category`, `rule_severity` (v2 adds `info` and `low`), `repository_id` (null for v2 `not_enrolled`), `machine_id`, `session_id`, `occurred_at`;
   - the agent: Task6.a `agent_family`, or v2 `source_agent`;
   - the model: v2 `model`, or `null` for Task6.a.
4. **Repository** breakdowns put a v2 `not_enrolled` row in the bucket `not_enrolled`, never under a repository.
5. **Every security answer carries the caveat** `monitor_only_observed`. It never says "blocked" or "prevented" unless an enforcement `deny` exists, and even then the figure is "denied by request".
6. **Platforms:** take the machine's platform from `fleet_machine_states.platform` (latest per machine). A machine with none is `unavailable`. Platforms outside macOS are named `not_monitored` in the figure's reasons, not as zero.

### 2.2 Answerers (registered for kind `live`)

| Q | Scopes | Figures | Breakdown | Notes |
|---|---|---|---|---|
| **S7** | tenant | `findings` (count) with `previous` (`previousPeriod`) | `repository`, `rule_category`, `severity` | — |
| **S8** | tenant, repository | `findings` | `agent_family` (agent), `model` (v2 model or `unknown`) | Task6.a rows have model `unknown`; reason `unknown_model_explicit` |
| **S9** | tenant | `findings` | `operating_system` (from §2.1 item 6), `rule_category` | — |
| **S11** | tenant, repository | `requested` (Task6.a rows with phase `requested`), `observed_result` (Task6.a `observed_result`), `v2_unclassified` | `rule` | v2 Numbat findings carry no requested-or-observed phase: count them as `v2_unclassified`. Mark `requested_not_confirmed` and never claim "confirmed" |
| **S12** | tenant, repository | `denied_by_request` (v2 enforcement `deny` count), `blocked` = `unavailable` with reason `monitor_only_observed`, `policy_versions` (count of distinct `rule_pack_version`) | `repository` | Until the pilot (Task20k), `denied_by_request` is 0 when the enforcement table is reachable; that is a real 0 |
| **S17** | tenant, repository | `findings` | `machine` (machine UUID); `team` → `unavailable`, `answer_not_built` | No team entity exists |
| **S18** | tenant | `findings` | `rule` | Noisy = `unavailable`, `not_captured_yet` G13 |
| **S5** | tenant, repository | `findings_with_session` (count with a non-null `session_id`), `linked_sessions` (distinct sessions matching `ai_sessions.external_session_id`) | none | `session_link_partial`. The commit and PR chain stays `unavailable`, `not_captured_yet` G10 (Task13) |
| **S6** | tenant, repository | `high_or_critical_sessions_merged`: high/critical findings whose session matches an `ai_sessions` row linked to a merged PR | `repository`, `severity` | Text join, `session_link_partial`. Use Task19b's `pullRequestIntelligence` or the Task2 functions it uses; never a new lifecycle calculation |
| **S10** | tenant, repository | `rule_pack_versions_in_force` (distinct `rule_pack_version` in the period), `machines_reporting_status` (distinct machines with a `security_status_snapshots` row in the period) | `machine` | "Were machines up to date" is `unavailable`, G7 (Task20f/20i history) |
| **S15** | tenant | `audit_reads` → `unavailable`, `answer_not_built` | — | Link only: `signed_evidence` is unset; the envelope's `drilldown` is empty; the handoff points to Task16's Audit view |
| **Q11** | tenant, repository, pull_request, commit | `findings_in_linked_sessions` | `rule_category`, `severity`, `repository` | From Task19b's session link, joined to findings by `session_id` text: `session_link_partial` |

S1, S2, S3, S4, S13, S14 and S16 are **not** registered here. They keep `answer_not_built` until their gaps close; the lead updates TASK19.md.

### 2.3 Pre-approved files
- `apps/api/src/features/qa/`: new `security-read.ts`, `security-answerers.ts`, `security-answerers.test.ts`, and the one registration line where Task19b registers its answerers.
- A live verify `apps/api/src/features/qa/task19c-qa-live-verify.ts`, plus `apps/api/package.json` script `verify:task19c-qa-live` (alphabetical).
- The handoff; your own rows in `docs/plan/TASK19.md` (T19.4, Task19c) and `docs/plan/STATUS_BOARD.md` (row 7i2 actual, the IT-T19c-01 registry row).

### 2.4 Never touch
- `docs/contracts/**`, `schema.ts`, migrations, `features/security-findings/**`, `features/attesta/**`, `features/telemetry/**`, the web app.

If you need any of these, stop and describe it.

## 3. Working rules
- **Commits** `Task19c: …`: the read module, then each answerer with its tests, then the live verify, then the handoff. `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests:**
  - every answerer on synthetic rows of both generations;
  - `not_enrolled` buckets;
  - an unknown platform and model;
  - no preview field read (a test proves the query selects only named metadata columns);
  - Company A/B through the in-process route harness (`qa-api.test.ts`).
- **IT-T19c-01:** run through `scripts/it-db.sh` on real PostgreSQL, seeding Task6.a rows and v2 rows (insert v2 rows directly; the ingest needs a lease, which is Task20f's). It covers S7, S8, S9, S12 and Q11 envelopes schema-valid, plus Company A/B isolation. Run it once, small.
- **Review:** an independent re-read of the diff before the handoff.

## 4. Close-out
- **Handoff** under 80 lines, from the template. It names the registered questions, the reasons and caveats used, what stays unbuilt and why, Integration test impact, and Effort.
- Clean tree. Do not push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape. One numbered bash block:
  1. `npm test`;
  2. `scripts/it-db.sh npm run verify:task19c-qa-live -w apps/api`;
  3. under `# after the cross-agent review`:
     - push;
     - `gh pr create --base main --head task/Task19c-qa-live-security --title "[Task19c] Live security answers" --body-file docs/handoffs/Task19c-qa-live-security_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`;
     - the preflight;
     - the merge.

  Then the review request in a `text` block, addressed to the Task20 lead.

## Lessons so far
- **Task19b (Muse):** about 0.38× against 0.12×, from a schema edge case, a missing typecheck run and two review rounds. Run `npm run typecheck` (not piped) before every commit, and copy Task19b's harness rather than writing a new one.
- **Task20d (Muse):** v2 rows can have a null `repository_id` and null Task6.a columns. Never assume Task6.a's non-null fields on a v2 row.
