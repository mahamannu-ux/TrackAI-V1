# Task20j-acceptance handoff — Checkpoint 1

## Checkpoint 2 — fixed build and local week stack (2026-11-17)

The founder merged local TrackAI `main` into this branch (`36a82d2`) and fast-forwarded GitAI fork `main` to `e6bfe77b6`, which includes the Task20j fixes. TrackAI typecheck and lint passed after the merge. The founder started the kept PostgreSQL database on loopback port 55432, applied migrations, seeded Company A/B with four roles and one Company A machine, and observed healthy local auth (54321), API (8080), web (3000), and running database. Private credentials and development signing keys remain in the local private directory and are not recorded here.

The founder built GitAI `1.6.19 (debug)` and Numbat `v0.2.0-trackai.1` with the pinned Go `1.26.9`. The exact unsigned development-trust package `trackai-endpoint-macos-x64-debug.pkg` has SHA-256 `34ccd4cd60f079d4d6e863d2a8de58f4214f859099aba7af3e7c159eadb69c74`; the Numbat binary has SHA-256 `b80672486b0e05b4eb13033b0546fddddde71c7792a6e1cceb9cd19240771667`. The package's `PackageInfo` receipt version is `1.6.19`, matching the built Endpoint. Installation, the installed receipt, signed monitor lease, E20-R/W and all live E20/T19.9 verdicts remain pending. Earlier Checkpoint 1 status below is historical.

The founder then installed that package in the everyday account. `pkgutil` reported installed receipt version `1.6.19`; installed Endpoint and Numbat versions matched the fixed build. Five managed hooks reported `installed`; the active pointer was `placeholder`; the seeded Company A bootstrap and credential installed, credential status was available, and the daemon reported running. This is an install baseline only: accepted lease, health layers, local record, upload and real-agent observations are still pending. No monitored claim is made.

The founder explicitly consented on 2026-11-17 to the day-one scan of real prior agent history. The pinned Numbat test suite passed (`numbat-tests: ok 17 packages`); compiled-bundle checks and eight live rule-group triggers remain pending for E20-R. The monitor lease and scan have not yet been published or run.

Subsequently, Company A's dry run was published with the 44-rule default bundle v1/epoch 1, digest `393ac27e8ac0799ccf20a59b484505e84c5213d1fc80a188d228e1249099c29f`. All five compiled folders passed `numbat rules check`; the Endpoint pointer selected that digest. Coverage reported a signed monitor lease with an `applied` acknowledgement, hook/local record `ok`, and forwarder acknowledgement `unavailable` in the first status. The day-one scan marker was pending; three findings had arrived but their provenance and triage were not yet checked. E20-01/09/W and the live E20-R groups remain open.

The first day-one scan attempt recorded one failure for Cursor (`failed_attempts=1`, `failed_agents=[cursor]`), with no done marker yet. It is scheduled to retry hourly. Cursor's local scan diagnostic, the other per-agent summary review, and the findings' severity/at-rest triage are the immediate follow-ups; no raw session content belongs in this handoff.

A separate local Cursor diagnostic reproduced exit 1 with `status=error`, zero artifacts/findings, and two diagnostic records: an informational parse notice and a no-artifacts error. The GitAI zero-artifact exception is narrower (one diagnostic and a different prefix), so it retries. Do not treat Cursor as scanned. This is a potential follow-up fix or explicit not-monitored boundary; keep the fixed package identity stable while the remaining agent/week evidence is assessed.

All three initial findings are confirmed `found_at_rest=true` (high/medium/low). The founder sees them but does not recall the underlying activity, so they are recorded as uncertain pending local context review, with the high finding first. No raw session content was shared.

The everyday-account Cursor `pwd` check is not yet proven: local record lines rose 108→113, but the trailing five inspected records were labelled Codex. Recheck with a `source_agent=cursor` count before and after the action; do not infer Cursor's hook execution from a global file count. Task20h-a's prior Cursor 1→6 guest-account result remains separate.

The corrected Cursor-filtered check then rose 5→9 around a harmless Cursor Agent action, proving local managed-hook records in the everyday account. Founder confirmation of normal action completion, a rule finding and accepted server upload are still separate E20 evidence; the at-rest scan mismatch is unchanged.

The four new Cursor records show `prompt.user` → `command.exec` → `command.result` → `message.assistant` at 10:51 UTC, consistent with a completed benign `pwd` action; the founder can check the visible Cursor tool card for its returned directory and absence of a hook error. A benign `pwd` is not expected to create a Security finding. The next daily Coverage status showed `forwarder_ack=ok` with an applied monitor lease, while the three at-rest findings stayed unchanged. Cursor day-one scan retried twice and still reported `failed_agents=[cursor]`; live rule trigger/upload remains unproved.

Founder reported that the older Administration → Security findings view crashed. Its rendering assumed every finding had a repository ID and phase, despite nullable columns; a focused web fix handles both, corrects stale Task6/OpenCode wording, and links to the current Security tab. Web TypeScript and lint passed; live browser confirmation is pending because browser control timed out. This web-only fix does not change the fixed Endpoint package.

Founder then refreshed the live console and confirmed Administration → Security findings renders the same three rows as Security → Findings. The local day-one scan subsequently wrote `day-one-scan-done` at 11:04 UTC with `partial=false` and `failed_agents=[]`; the prior attempts file still records two Cursor failures as retry history. Verify that the fifth scan summary reached the kept database before closing the day-one portion of E20-09. The later off/on no-repeat portion remains for the joint sitting.

The founder queried the kept database and reported five `security_scan_summaries`, all `complete`. Together with the non-partial done marker, this closes the day-one scan delivery observation for E20-09. The later off/on no-repeat check is still open, and individual agent live-hook/upload checks remain separate. No monitored claim follows from scan completion alone.

Task20 lead accepted the build, lease/bundle, five delivered summaries and uncertain dispositions. The lead classified the earlier Cursor zero-artifact scan failure as an **E20-09 mismatch** despite eventual delivery. A Cursor action at 10:51 UTC preceded the successful scan at 11:04 UTC, suggesting a newly created artifact; confirm from the fifth summary's `artifacts_scanned` count. The follow-up GitAI fix after the fixed-build run should handle the actual pair of zero-artifact diagnostics and add a fixture. E20-R's live rule-group triggers now run in working days 1–2, with `found_at_rest=false` and matching local/server record IDs for Claude Code, Codex and Cursor. Founder decision changed E20-W to five consecutive working days, 2026-11-17 through 2026-11-23, with real agent work, a lease renewal and a restart or reboot. The lead approved the web fix as a Task20j acceptance deviation; the Admin and Security wording now says “Not in an enrolled repository,” with a render regression for null repository and phase. This web fix does not change the Endpoint package.

The web render test, repository TypeScript check, web lint and `git diff --check` pass. A local `git add` was blocked because this session cannot write the parent checkout's worktree index; the founder must stage the eight explicit paths and commit locally. No push is requested at this checkpoint.

### Task20 lead product note — make findings understandable (deferred)

**Founder observation:** The three historical findings appear in Security, but a rule name, title, severity and the existing Occurred/Received times do not let the founder recognize the session or judge whether the action really happened. This is feature work after Task20j, not a change to the current E20 verdict. Keep the initial triage `uncertain` until evidence supports a disposition. Recommended mechanisms, in order:

| Priority | Mechanism | Evidence boundary / implementation note |
|---|---|---|
| 1 | Plain-language finding card: what behavior matched, why it matters, whether it came from a live hook or an at-rest scan, and whether the product observed a request or an outcome. Explain Occurred versus Received in place. | `found_at_rest`, timestamps, agent, model, rule and severity already reach the read API; the drawer currently omits the at-rest flag. Never call a monitor-mode observation “prevented” or infer execution from a scan match. |
| 1 | Session context panel: show the available session id, agent/model, repository and machine, with a link to the relevant session only when the join is exact and authorized. Otherwise say “session link unavailable” or label an approximate time-window match as partial. | `session_id` is nullable in the read API but absent from the drawer. Task19 Q11/S5 already treat the text join as partial (G10). A safe local deep link or separately authorized reveal needs design; do not copy raw session content into ordinary APIs. |
| 1 | Triage workflow: true positive, false positive, uncertain, owner, reason, action, and reviewed time; prioritize critical/high unresolved findings and show per-rule noise over the week. | Persist tenant-bound decisions with an audit trail. Keep “uncertain” distinct from false positive; a detector match alone cannot settle intent or outcome. |
| 2 | Bounded explanation of the match: rule version, category, severity rationale, source type, confidence when supplied, bundle digest, and a safe detector reason code or redacted matched-field class. | Some metadata is stored but not in the current drawer/read shape. Optional previews remain off by default and governed by the five tenant data settings. Any raw reveal must use Task5's existing approval and audit path. |
| 2 | Related-activity timeline and grouping: scan time, original event time, adjacent findings and permission decisions, duplicate count, and the rule-group narrative. | Mark exact record links separately from merely nearby events; the existing drawer labels nearby decisions/indicators as unlinked. Avoid a fabricated causal chain. |
| 3 | Investigator handoff and tuning loop: safe case summary, local original-session lookup instructions, retention/availability state, and feedback to a rule dry run before changing severity or enablement. | Export metadata only by default; respect tenant roles, `no-store`, retention and audit. Report unavailable context explicitly rather than showing a blank or zero. |

Task20 lead should split the first three into a future console/triage scope and decide ownership with Task19 for session linking; do not fold them into this fixed-build acceptance week. The immediate acceptance worksheet can record the three rows as `uncertain` with a follow-up action.

> Status: 🟡 GitAI Stage 0 reviewed and open as PR #14; TrackAI runbook and week setup prepared; founder's five-working-day run and sitting pending.

TrackAI branch `task/Task20j-acceptance` (fast-forwarded to `main` `12bd124`, which includes `TASK19_WALKTHROUGH.md`). Separate GitAI fork branch `task/Task20j-fixes-gitai` starts from fork `main` `8628a0b0f`; initial fix commit `e49a182da`, followed by review fix `cc6fc1355`. The Task20 lead marked the latter ready to push; [GitAI PR #14](https://github.com/mahamannu-ux/git-ai/pull/14) is open at that exact head. The preflight trial merge with `origin/main` passed; because the generic script did not discover the PR, its `main` base and head SHA were checked explicitly with `gh pr view --repo mahamannu-ux/git-ai`. The founder owns the merge. The untracked session prompt was read from the main TrackAI checkout and was not copied into either branch.

## At a glance

| Item | Status |
|---|---|
| GitAI Stage 0 | 🟡 60-second server-ahead lease tolerance with the placeholder pre-check review fix; persisted 24-attempt day-one scan cap and partial marker; sync wording; PR #14 open with lead review and preflight passed; founder merge pending |
| TrackAI Checkpoint 1 | 🟡 combined E20/T19.9 runbook, two-tenant week setup/auth, daily findings+Coverage command, forbidden-upload and A/B isolation probes written; Task20 lead's five final runbook corrections applied, ready for founder push after local verification |
| E20-R/W and E20-01…12 | ⬜ founder real-Mac week and sitting not run |
| T19.9 | ⬜ Task19 lead's separate fifteen-step walkthrough linked, not run |
| IT sweep | ⬜ founder runs pending; short scripts listed in runbook |
| Support claim | 🟡 every Numbat agent/platform remains “not monitored” in `TASK20.md` §8 |

## Implemented interfaces

```text
GitAI: src/security/policy_apply.rs; src/security/day_one_scan.rs; packaging/numbat/SYNC.md
TrackAI: docs/plan/TASK20_ACCEPTANCE.md
TrackAI: apps/api/src/features/security/testing/task20j-week-setup.ts seed|auth <private-directory>
TrackAI: apps/api/src/features/security/testing/task20j-daily-triage.ts <private-directory> YYYY-MM-DD
TrackAI: apps/api/src/features/security/testing/task20j-forbidden-upload.ts <private-directory>
TrackAI: apps/api/src/features/security/testing/task20j-isolation-probe.ts <private-directory>
```

## Deviations from spec

- The prompt names `trackai-endpoint-macos-x64-debug.pkg`; the runbook uses that name, but no new package is built before the GitAI fix merge. The exact debug build/version/SHA-256 remain blank.
- The week uses a proposed kept local Docker database, rather than `scripts/it-db.sh`, because the latter removes its database at exit. The short IT verifiers still use `scripts/it-db.sh`.
- The seed/auth helper lives on the TrackAI side, as the prompt permits. GitAI's existing `founder-live-setup.ts` creates only one tenant, so it could not establish Company A/B itself.
- The founder uses the everyday account for the week and sitting. E20-W observes real work; targeted E20 triggers are synthetic, and Endpoint records stay on this Mac's local stack. The founder consents before day-1 E20-09 scans real prior history. The final offboard removes managed hooks machine-wide. E20-07 is last, after the five-working-day run, joint sitting, T19.9 and IT sweep; its additional offline interval may last up to 72 hours because the server has no development shortening switch.
- E20-08 now overwrites one cached Copilot rule with invalid YAML, avoids agent actions until restart, and requires an original digest match and `applied` acknowledgement after refetch. A valid local edit is not prevented at each hook invocation; the phase-1 boundary is tamper-evident at the server, not tamper-resistant.
- The week API binds to `127.0.0.1`; turning off Wi-Fi does not disconnect the Endpoint from it. E20-06/07 therefore stop the saved local API process and verify `/health` is unreachable, then restart it against the same kept database.
- The GitAI skew fix preserves the applied bundle when a verified lease is up to 60 seconds ahead. Inventory, status, day-one scan and record uploads still use `lease_at(now)` and may begin up to 60 seconds later; historical record admission is unchanged.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Merge reviewed GitAI PR #14 after the required founder preflight, then build the exact debug package from GitAI `main`. Push the TrackAI checkpoint branch after verifying its final local commit; the Task20 lead said the five runbook text fixes need no further review. | E20-W and E20 sitting cannot start on the final build. |
| ⬜ **FOUNDER:** | Run the five consecutive working days and E20 sitting on the Intel Mac using the runbook, then send safe summary rows. | No monitored claim or Task20 close-out before the evidence. |
| ⬜ **FOUNDER:** | Run Task19's fifteen-step T19.9 separately in the same sitting; send its safe mismatches to the Task19 lead. | Task19 answer status remains open. |
| ⬜ | Production trust, signed/notarized PKG, Jamf and other platforms have separate Task15n/Task9 gates. | Debug/development E20 never proves a customer build. |

## Test coverage

- GitAI: 70 total security tests pass after review fix, including the new 30-second early-lease regression; `task build` and `cargo fmt --check` pass after the fix. Full `cargo clippy --lib -- -D warnings` previously reported 11 warnings in unchanged files; a scoped run allowing those five inherited lint categories passed with no warning in touched files before review fix.
- TrackAI: `npm run typecheck`, `npm run lint` and the unsandboxed `npm test` (1,265/1,265) passed at initial checkpoint; typecheck and lint passed again after the lead's five corrections. The two-tenant seed ran against a throwaway PostgreSQL 16 + pgvector database, and the local auth health endpoint started. The forbidden-upload and A/B probes have not been run against a live week stack. The first PostgreSQL attempt failed on sandbox `shmget`; the exact rerun outside the sandbox passed. The sandbox `npm test` had HTTP failures and an Attesta timeout, so it is not used as product evidence.
- No real Endpoint, agent, browser or five-working-day assertion is claimed from these tests.

## Integration test impact

No new database integration-test ID was added. The registered IT sweep and E20 live checks are listed with commands, prerequisites and separate verdicts in `TASK20_ACCEPTANCE.md` and `TASK20.md` §7. E20-R/W and E20-01…12 block any Numbat “monitored” claim. IT-T20f-02 blocks the first production build. T19.9 has its own Task19 result ledger.

## Integration notes

- The kept database is named `trackai_task20h_founder` so existing GitAI founder setup checks can be reused where needed. The Task20j seed generates separate Company A/B domains, four users, one Company A machine and development trust files without printing credentials.
- A Task20j debug-package result does not update Task9 signed-package, Jamf, second-device or cross-platform rows.
- `AGENTS.md` §9 items 9/11 and the Task6.a superseded note describe the support boundary; update exact agent/OS wording only after E20 results exist.

## Effort (estimate vs actual)

| Estimate | Actual so far | Founder time pending |
|---|---|---|
| about 0.17× T6 | checkpoint still in progress | about three-hour sitting plus five consecutive working days of normal work |
