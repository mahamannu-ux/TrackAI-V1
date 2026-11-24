# Handoff prompt: Task20j-acceptance (E20 walkthrough with Task19 T19.9, the week-long rule run, Task20 close-out), Codex + founder-live

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge this prompt's docs PR. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`; `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task20j-acceptance`, open `~/AIProjects/TrackAI-wt/Task20j-acceptance` in Codex, paste everything below the line.
> 3. Paste every checkpoint and the review request to the **Task20 lead (Claude)**. The T19.9 section is reviewed by the **Task19 lead**. Push only after "ready to push".

---

You are **Codex**, running **Task20j-acceptance** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Task20 (Numbat security) has merged every build session (Task20a–20i, 20h-a, 20h-b). This session turns that code into claims TrackAI may make: it prepares one combined founder walkthrough (Task20's E20 rows **and** Task19's T19.9), runs a week of the first-wave rules on real work, and closes Task20's docs.

- **Repositories:** this one chat does both, as separate branches and PRs: first the small GitAI fix branch (§3, Stage 0), then TrackAI (runbook, trackers, AGENTS.md). **Worktree:** `~/AIProjects/TrackAI-wt/Task20j-acceptance`, branch `task/Task20j-acceptance`.
- **Handoff:** `docs/handoffs/Task20j-acceptance_HANDOFF.md`. **Estimate:** about 0.17× T6 plus founder time (one walkthrough sitting of about 3 hours, and the week).

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 6, 7, 9; §3 "Two repositories"; §9 items 9, 11, 22, 23; §12), `docs/plan/TASK20.md` (all; §6–§8 are yours), `docs/plan/TASK19.md` (T19.9 and the ranked table), `docs/plan/TASK9.md` decisions 10–12.
2. Read the evidence so far: GitAI `packaging/macos/{TASK20H_A_HANDOFF.md,IT_T20H01_EVIDENCE.md,FOUNDER_WALKTHROUGH.md,README.md}`, the Task20h-b handoff, GitAI `docs/task9-endpoint-package-flavours.md` (package names; authoritative for names only).
3. GitAI changes go only to the fork: remote `origin` = `mahamannu-ux/git-ai`. Every `gh` command for GitAI passes `--repo mahamannu-ux/git-ai` (a fork's `gh pr create` otherwise defaults to the upstream parent). Never push or open anything on `git-ai-project/git-ai`.

## 1. What is decided (Task20 lead; the founder's rule: keep it simple, defer what gets stuck)
1. **One sitting, separate verdicts.** One runbook `docs/plan/TASK20_ACCEPTANCE.md` orders the whole session. Task19 owns its section: the Task19 lead supplies `docs/plan/TASK19_WALKTHROUGH.md` (T19.9: its question set, roles, expected answers, Company A/B), and the runbook links it at the right point rather than copying it. E20 results go to `TASK20.md` §7/§8 only; T19.9 results to `TASK19.md` only (AGENTS.md §9 item 23).
2. **Build under test.** The exact `trackai-endpoint-macos-x64-debug.pkg` built from GitAI `main` after `Task20j-fixes-gitai` merges, with development trust pins, on the founder's Intel Mac. Record its version and SHA-256. Every E20 verdict says "debug package, development trust". It is **not** a Task9 signed-package, Jamf or multi-device result and must not be promoted into Task9 rows (Task9f note). Production trust (Task15n) and the signed package are re-checked later in Task9f item 4 with IT-T20f-02; that is not this session.
3. **A server that lasts the week.** The Endpoint must upload to a TrackAI API for all seven days. `scripts/it-db.sh` databases are disposable, so propose at Checkpoint 1 a local database kept for the week (named, not torn down, with the exact start and restart commands after a reboot), and the local API pointed at it. Records queue on the Mac while the API is down. The live Supabase project is not used: its migrations are a separate deployment session.
4. **Two tenants.** Company A (the Mac enrolled, a test repository) and Company B (seeded), on the week's local stack (item 3: the kept database plus the API and console), extending GitAI's `packaging/macos/founder-live-setup.ts` or a TrackAI-side seed script you write. Task19 confirms whether its code questions need the GitHub App on a test repository in Company A.
5. **The E20 rows** (each passed, failed, or explicitly "not monitored", with evidence). Agents: Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI; **Copilot CLI first** for any step that changes rules, binary or hooks.
   - E20-01 Install and health: five managed hooks `installed`; `hook_status`, `local_record`, `forwarder_ack` `ok`; the effective view checked by hand per agent (Claude Code and Cursor: "runs, not listed in the view" is the accepted result).
   - E20-02 Monitor, per agent: one harmless trigger each; the finding shows the right `source_agent`, model, rule id and version, bundle digest. **Codex CLI must be installed** this time.
   - E20-03 Rule change: change one rule's severity and turn one noisy rule on; dry run, apply, new bundle applied and acknowledged; the next finding carries the new severity.
   - E20-04 Data settings: command previews on, then off; the stored finding has, then lacks, the preview; an upload carrying a field the tenant has off is refused.
   - E20-05 Off: placeholder restored, uploads stop, local records continue (wording in the README).
   - E20-06 Offline and restart: network off, actions, daemon restart, network on; each record arrives once.
   - E20-07 Lease expiry and renewal: offline past expiry → off; back online → same-digest renewal restores the bundle (Task20h-a repair).
   - E20-08 Tamper: corrupt a cached rule file, and replay an old lease; neither activates, last good kept or refetched, refusal visible in Coverage.
   - E20-09 Day-one scan: opt in, `found_at_rest` findings and one summary per agent, a zero-artifact agent reads "no session files found", no second scan after off and on.
   - E20-10 Inventory: rows arrive; the unmanaged agents on the Mac are visible (S19).
   - E20-11 Console (T20.11): Findings filters, drawer labels, Coverage words ("Not checked by the Endpoint", "Failed"), Settings dry run, apply with reason, two-tab conflict message, auditor read-only, no "blocked" or "prevented" anywhere.
   - E20-12 Company A/B: A sees none of B in the console, the Q&A answers and the machine routes.
   - E20-R Rule proof (all 51, without triggering each by hand): (a) Numbat's own rule tests at the pin pass (`packaging/numbat/test-pin.sh`; the `rules/*_test.go` suites carry positive and negative cases per rule); (b) `numbat rules check` passes on the compiled default bundle for each agent; (c) one harmless live trigger per rule group on the Mac (about eight: secrets, exfil, exec, persistence, integrity, impact, chains, tamper), each producing the expected finding. Record which rules were live-triggered and which rely on (a).
6. **The week (E20-W).** 44 first-wave rules in monitor mode on the founder's normal work, in the founder's everyday account, for seven days, on one fixed build. It proves noise and stability, not detection (E20-R proves detection): false positives per rule, no agent broken or slowed, daily file rotation, about 24 lease renewals a day, delivery over sleep and network changes. Zero findings in a week is a valid result if the health layers stayed `ok`. Findings are triaged in a table (rule, count, true or false positive, action); no critical false positive may stay untriaged. **Task13 is not installed on that account during the week.**
7. **Pending founder IT runs, swept in the same sitting** (script runs, about 5 minutes each, results into their own trackers): IT-T19a-01, IT-T19c-01, IT-T19f-01, IT-T20d-01, IT-T20g-01, IT-M20-02; IT-M20-01 if Task15o's signer runs on the dev stack. List each with its exact command in the runbook.
8. **Close-out docs (Stage 5):** `TASK20.md` §2 rows to current truth, §6 budgets (founder-approved 2026-10-21: each hook p95 ≤ 50 ms on the Intel Mac; record the stripped release sizes of both binaries from the release workflow's artifacts, since the 69 MB Git AI figure was an unstripped build), §7, §8 completion table with a per-agent, per-platform **monitored / not monitored** claim; `AGENTS.md` §9 items 9 and 11 rewritten to match the evidence; `TASK6_SECURITY.md` superseded note; `STATUS_BOARD.md` Task20 rows; `docs/plan/GITAI_FUTURE_TODO.md` row G8 closed (Task20c). Apple Silicon, Windows and Linux stay "not monitored" unless a run proves otherwise.

## 2. Stages
0. **Stage 0, `Task20j-fixes-gitai` (§3):** build, test, PR to the fork, Task20 lead review; the founder merges it before Stage 2.
1. **Checkpoint 1 (no founder time):** add an "In plain words" column to `TASK20.md` §7 (one sentence per row a non-engineer understands, e.g. IT-T20d-01: "the server stores every kind of security record correctly, in a real database, and keeps companies apart"); then the runbook skeleton with every step's exact command, the seed script, the list of IT sweep commands, and the link point for `TASK19_WALKTHROUGH.md`. Send to the Task20 lead; the founder sends the Task19 link point to the Task19 lead.
2. Wait for `Task20j-fixes-gitai` (§3) to merge; build the debug package; record its digest.
3. **The week** (E20-W): the founder installs on their everyday account (founder, 2026-10-21) and keeps working there for seven days; Codex supplies a daily triage command (counts by rule and agent from the console API) and the triage table.
4. **The sitting** (during or after the week): E20-01…E20-12, then T19.9 by the runbook link, then the IT sweep. Record results as they happen.
5. Close-out docs (§1 item 8) and the handoff.

## 3. `Task20j-fixes-gitai` (GitAI, Codex, about 0.03×, Stage 0 of this chat)
Small fixes the Task20 lead collected in reviews, so the walkthrough tests the final build. Branch `task/Task20j-fixes-gitai`, worktree `make gitai-worktree M=Task20j-fixes`, PR with `--repo mahamannu-ux/git-ai`, reviewed by the Task20 lead:
1. **Lease clock skew:** accept a lease whose `issued_at` is up to 60 seconds ahead of the machine clock (today a fresh lease from a server slightly ahead is refused, then waits about an hour). Test both sides of the bound.
2. **Day-one scan retry cap:** after 24 failed attempts for the same tenant and machine, write the marker with `partial: true` and the failed agents; never retry after that.
3. **SYNC.md:** add the day-one no-artifacts diagnostic wording (`day_one_scan.rs`) to the list re-checked at each Numbat sync.

## 4. Pre-approved files
- TrackAI: new `docs/plan/TASK20_ACCEPTANCE.md`, a seed script under `apps/api/src/features/security/testing/` or `scripts/` (name it in Checkpoint 1), `docs/plan/TASK20.md`, `AGENTS.md` §9 items 9 and 11 only, `docs/TASK6_SECURITY.md` (superseded note), `docs/plan/STATUS_BOARD.md` (Task20 rows and the IT rows you sweep), `docs/plan/GITAI_FUTURE_TODO.md` (G8), your handoff.
- `TASK19.md` and `TASK19_WALKTHROUGH.md` are the Task19 lead's; IT results of Task19 rows go into `STATUS_BOARD.md` IT rows only.
- GitAI: only through `Task20j-fixes-gitai` (§3 files: `src/security/policy_apply.rs` or `lease_state.rs` for the skew, `src/security/day_one_scan.rs`, `packaging/numbat/SYNC.md`, tests beside them).
- Never touch `docs/contracts/`, merged migrations, Task9 rows or Task9's tracker.

## 5. Close-out
- Gates (TrackAI): `npm run typecheck`, `npm run lint`, `npm test`; `git merge main` and rerun right before the review request. GitAI fix session: `task build`, `cargo test --lib security`, `cargo fmt --check`, scoped Clippy.
- Process, both repositories: commits per stage; final reply in the AGENTS.md §12.4 shape with **one bash block**: push, `gh pr create --base main --head <branch> --body-file <handoff> --repo <repo>`, `scripts/pr-preflight.sh <branch>`, then `gh pr merge` under "after the cross-agent review". Paste the review request to the Task20 lead; push only after "ready to push"; the founder merges.

## Lessons so far
- **Task20h-a:** bundles are compact (they rely on Numbat's built-ins); never pass `--no-builtin-rules`. BSD `mv` needs `-h` to replace a symlink to a directory.
- **Task20h-a run:** the installer wires the account at the console; log into the test account first. Claude Code and Cursor do not list managed Numbat hooks in their views.
- **Task20h-b:** a zero-artifact scan uploads `status: error`; say "no session files found" to people.
- Honest wording everywhere: "observed", "requested", "denied by request", never "prevented"; `Unavailable` is never zero; an agent or platform without a passed row is "not monitored".
