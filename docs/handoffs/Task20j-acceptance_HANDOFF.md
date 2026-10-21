# Task20j-acceptance handoff — Checkpoint 1

> Status: 🟡 GitAI Stage 0 reviewed and open as PR #14; TrackAI runbook and week setup prepared; founder's seven-day run and sitting pending.

TrackAI branch `task/Task20j-acceptance` (fast-forwarded to `main` `12bd124`, which includes `TASK19_WALKTHROUGH.md`). Separate GitAI fork branch `task/Task20j-fixes-gitai` starts from fork `main` `8628a0b0f`; initial fix commit `e49a182da`, followed by review fix `cc6fc1355`. The Task20 lead marked the latter ready to push; [GitAI PR #14](https://github.com/mahamannu-ux/git-ai/pull/14) is open at that exact head. The preflight trial merge with `origin/main` passed; because the generic script did not discover the PR, its `main` base and head SHA were checked explicitly with `gh pr view --repo mahamannu-ux/git-ai`. The founder owns the merge. The untracked session prompt was read from the main TrackAI checkout and was not copied into either branch.

## At a glance

| Item | Status |
|---|---|
| GitAI Stage 0 | 🟡 60-second server-ahead lease tolerance with the placeholder pre-check review fix; persisted 24-attempt day-one scan cap and partial marker; sync wording; PR #14 open with lead review and preflight passed; founder merge pending |
| TrackAI Checkpoint 1 | 🟡 combined E20/T19.9 runbook, two-tenant week setup/auth, daily findings+Coverage command, forbidden-upload and A/B isolation probes written; founder review pending |
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
- The founder uses the everyday account for the week and sitting. The final offboard removes managed hooks machine-wide. E20-07 needs an additional offline interval after the seven-day monitor run because the server's signed lease lasts 72 hours and has no development shortening switch.
- The week API binds to `127.0.0.1`; turning off Wi-Fi does not disconnect the Endpoint from it. E20-06/07 therefore stop the saved local API process and verify `/health` is unreachable, then restart it against the same kept database.
- The GitAI skew fix preserves the applied bundle when a verified lease is up to 60 seconds ahead. Inventory, status, day-one scan and record uploads still use `lease_at(now)` and may begin up to 60 seconds later; historical record admission is unchanged.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Merge reviewed GitAI PR #14 after the required founder preflight, then build the exact debug package from GitAI `main`. Have the Task20 lead review the TrackAI checkpoint corrections. | E20-W and E20 sitting cannot start on the final build. |
| ⬜ **FOUNDER:** | Run the seven days and E20 sitting on the Intel Mac using the runbook, then send safe summary rows. | No monitored claim or Task20 close-out before the evidence. |
| ⬜ **FOUNDER:** | Run Task19's fifteen-step T19.9 separately in the same sitting; send its safe mismatches to the Task19 lead. | Task19 answer status remains open. |
| ⬜ | Production trust, signed/notarized PKG, Jamf and other platforms have separate Task15n/Task9 gates. | Debug/development E20 never proves a customer build. |

## Test coverage

- GitAI: 70 total security tests pass after review fix, including the new 30-second early-lease regression; `task build` and `cargo fmt --check` pass after the fix. Full `cargo clippy --lib -- -D warnings` previously reported 11 warnings in unchanged files; a scoped run allowing those five inherited lint categories passed with no warning in touched files before review fix.
- TrackAI: `npm run typecheck`, `npm run lint` and the unsandboxed `npm test` (1,265/1,265) passed at initial checkpoint; typecheck and lint passed again after the lead's five corrections. The two-tenant seed ran against a throwaway PostgreSQL 16 + pgvector database, and the local auth health endpoint started. The forbidden-upload and A/B probes have not been run against a live week stack. The first PostgreSQL attempt failed on sandbox `shmget`; the exact rerun outside the sandbox passed. The sandbox `npm test` had HTTP failures and an Attesta timeout, so it is not used as product evidence.
- No real Endpoint, agent, browser or seven-day assertion is claimed from these tests.

## Integration test impact

No new database integration-test ID was added. The registered IT sweep and E20 live checks are listed with commands, prerequisites and separate verdicts in `TASK20_ACCEPTANCE.md` and `TASK20.md` §7. E20-R/W and E20-01…12 block any Numbat “monitored” claim. IT-T20f-02 blocks the first production build. T19.9 has its own Task19 result ledger.

## Integration notes

- The kept database is named `trackai_task20h_founder` so existing GitAI founder setup checks can be reused where needed. The Task20j seed generates separate Company A/B domains, four users, one Company A machine and development trust files without printing credentials.
- A Task20j debug-package result does not update Task9 signed-package, Jamf, second-device or cross-platform rows.
- `AGENTS.md` §9 items 9/11 and the Task6.a superseded note describe the support boundary; update exact agent/OS wording only after E20 results exist.

## Effort (estimate vs actual)

| Estimate | Actual so far | Founder time pending |
|---|---|---|
| about 0.17× T6 | checkpoint still in progress | about three-hour sitting plus seven days of normal work |
