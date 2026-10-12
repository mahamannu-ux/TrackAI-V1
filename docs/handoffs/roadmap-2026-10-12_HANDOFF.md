# roadmap-2026-10-12 Handoff — portfolio re-plan

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/roadmap-2026-10-12` (base: `main` at `88301f7`). Prompt: `docs/prompts/NEXT_CHAT_roadmap-2026-10-12_PROMPT.md`. Decisions: `docs/plan/ROADMAP_REPLAN_2026-10-12.md`.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | New plan files: `TASK7.md`, `TASK8.md`, `TASK11.md`, `TASK12.md`, `TASK17.md`, `TASK18.md`, `ROADMAP_REPLAN_2026-10-12.md` | ✅ |
| Scope | `ROUGH_ROADMAP.md`: rows for Task7/8/11/12/13/14, new Task17/18 rows, workstreams, execution graph with lanes and pilot milestone, sequence | ✅ |
| Scope | `TASK15.md` A15.14 (+ graph node); `TASK16.md` A16.9 moved to Task8; AGENTS.md §10 AP-1 rule; BUG_BACKLOG B17, B18; status board rows | ✅ |
| Review | Codex-Orchestrator cross-review: round 1 fix first (A15.14 session and totals; A16.9 ownership leftovers; Task17 disposition wording; this handoff's sections), fixed in the second commit | 🟡 re-review pending |

## Implemented interfaces and artifacts
No code or interfaces. Documents: `ROUGH_ROADMAP.md`; `docs/plan/{TASK7,TASK8,TASK11,TASK12,TASK17,TASK18,ROADMAP_REPLAN_2026-10-12}.md` (new); `docs/plan/{TASK15,TASK16,BUG_BACKLOG,STATUS_BOARD}.md` and AGENTS.md §10 (edited).

## Founder-approved decisions
All nine decisions in `docs/plan/ROADMAP_REPLAN_2026-10-12.md` (founder, 2026-10-12).

## Deviations
None from the founder's decisions. The new AP-1 rule in AGENTS.md §10 applies to new routes only; existing routes are not migrated for it.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Provider-share statements in `TASK7.md` are the orchestrator's directional assessment, not fresh market research | Re-check when Task7 starts |
| 🟡 | Task8, Task17 and Task18 have scope notes, not primers; sizes come when each Task starts | Estimates absent from the remaining plan for them |

## Test coverage
Documents only; `git diff --check`.

## Integration test impact
None.

## Integration notes
- `TASK15.md` and `TASK16.md` are also edited by the Task15/16 lead chat; these are small appended rows. If a lead branch is open on them, merge this PR first and let the lead rebase.
- Task9's in-flight sessions are untouched.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.04× | about 0.04× | ~12 turns | ~1 h | not measured |
