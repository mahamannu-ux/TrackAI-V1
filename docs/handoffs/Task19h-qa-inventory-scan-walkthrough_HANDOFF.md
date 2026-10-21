# Task19h-qa-inventory-scan-walkthrough Handoff — S19, S20 and the T19.9 walkthrough

Branch `task/Task19h-qa-inventory-scan-walkthrough` (base: `989ec96`, Task19g's last commit, merged to `main` in #101; registry v3 → v4).

## At a glance
| Item | Status |
|---|---|
| S19 live answer (AI agents on machines) | 🟡 unit and agent integration verified |
| S20 live answer (day-one scan) | 🟡 unit and agent integration verified |
| Registry v4 (S19 gaps G14 + G2; G14 closed) | 🟡 digest pinned; `questions.md` regenerated |
| Q15 fix (lead review of Task19g, merged in #101): a period after capture began with no rejections is a recorded 0, not "not captured yet" | 🟡 unit verified |
| T19.9 walkthrough (`docs/plan/TASK19_WALKTHROUGH.md`) | ✅ written; ⬜ the sitting itself |
| IT-T19h-01 | 🟡 agent-passed 2026-10-21; ⬜ founder run, blocking merge |
| Cross-agent review | ⬜ Codex or Muse |

## Implemented interfaces
- `security-read.ts`: `InventorySnapshotRow`, `ScanSummaryRow`, `AtRestFindingRow`; `latestInventory(rows)` keeps each machine's newest snapshot and projects only `agent`, `config`, `artifacts` and `wired` (versions are dropped). The loader reads:
  - inventory snapshots observed in the period;
  - scan summaries received in the period;
  - v2 findings with `found_at_rest = true` received in the period.
- `security-answerers.ts`: `computeS19` and `computeS20`, registered for `live`.
  - **S19:**
    - `machines_reporting`, by operating system;
    - `agents_detected`, `agents_wired`, `agents_detected_not_wired` and `agents_wiring_unknown`, by agent family or machine;
    - `agent_versions`: unavailable, `vendor_does_not_report`;
    - `agents_not_on_approved_list`: unavailable, `not_captured_yet` G2.
  - **S20:**
    - `machines_scanned`, `scans_complete` and `scans_partial`;
    - `scans_no_session_files` (status `error`, nothing scanned);
    - `scans_failed` (status `error`, something scanned);
    - `artifacts_scanned`;
    - `findings_at_rest`, by rule category or severity.
  - Both answers with no data are unavailable `not_monitored`, never zero.
- `answers/q15.ts` (Task19g's answer, fixed by the lead): "no rejection rows" is unavailable only before the first recorded capture; afterwards it is a recorded 0. New test in `task19g.test.ts`.
- `questions-presentation.tsx`: `QA_FIGURE_LABELS`, so `scans_no_session_files` reads "scans with no session files found for this agent".

## Deviations
- S20's period is the time the server **received** the scan or at-rest finding, not the old session's time. An at-rest finding's `occurred_at` is the old session's time, often months before TrackAI arrived.
- A "no session files" scan cannot name its agent: `security_scan_summaries` has no agent column. Showing the agent needs an additive Task20 field.

## Known limitations
- S19 and S20 are live only (no auditor kind), so auditors get 403, as for S26, S23 and S21.
- `agents_not_on_approved_list` waits for G2 (`customerPolicyForDataAccess`, shelved).

## Test coverage
`security-answerers.test.ts` adds five tests for S19 and S20 (26 in the file); `task19g.test.ts` adds one for Q15's recorded zero. Root `npm test`: 1,263 passing. Typecheck, lint and the web build are clean.

## Integration test impact
- **IT-T19h-01** (`scripts/it-db.sh npm run verify:task19h-qa-live -w apps/api`). It covers:
  - real PostgreSQL, JWT and `createApp()`;
  - S19 counts only the latest snapshot; S20 counts complete, no-session-files and failed scans, and an at-rest finding whose `occurred_at` is 200 days old;
  - Company B sees only its own inventory and gets S20 unavailable;
  - the auditor gets 403 on live.

  Blocking: Task19h merge. 🟡 agent-passed 2026-10-21 · ⬜ founder run.
- **T19.9** runs in the Task20j sitting from `docs/plan/TASK19_WALKTHROUGH.md`; results go in `TASK19.md` §8.

## Integration notes
- Task19g is already on `main`; v4's digest is pinned in `qa-contract.test.ts`. S19's operating-system breakdown labels a machine with no platform in the period `unavailable`, as S9 does.
- `TASK19.md` gains decision 5 and a §8 results table; `STATUS_BOARD.md` gains rows 7i7 and IT-T19h-01.

## Effort
Estimate about 0.04× T6; actual about 0.05×. The walkthrough needed every registered answer and its exact wording checked against the screen.
