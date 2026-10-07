# task15-16-plan Handoff — Attesta and Audit plans

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/task15-16-plan` (base: `main` at `1911626`; it also carries the `codex-task-lead` commit, so one PR delivers both). Prompt: `docs/prompts/NEXT_CHAT_task15-16-plan_PROMPT.md`.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | `docs/founder/ATTESTA_BRIEF.md` (verbatim) | ✅ |
| Scope | `docs/plan/TASK15.md`: business review (R1–R11), architecture decisions, 15 subtasks, graph, sessions, invariants | ✅ |
| Scope | `docs/plan/TASK16.md`: decisions D1–D5, 12 subtasks, graph, sessions | ✅ |
| Scope | Lead prompts `NEXT_CHAT_Task15-lead`, `NEXT_CHAT_Task16-lead`; Muse prompts `Task15a-attesta-primitives`, `Task15b-attesta-signer`, `Task16a-audit-inventory` | ✅ |
| Scope | Roadmap links, status board rows | ✅ |
| Review | Cross-review | ⬜ |

## Founder decisions needed
| Status | Item | Blocks |
|---|---|---|
| ✅ | ~~Buy-in on `TASK15.md` §1 (R1–R11)~~ approved 2026-10-08 | — |
| ✅ | ~~New dependency `canonicalize` (Task15a)~~ approved 2026-10-08 | — |
| ✅ | ~~`TASK16.md` §1 (D1–D5)~~ approved 2026-10-08 | — |

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Regulatory reading in R4 is the orchestrator's, not legal advice | Counsel should confirm before marketing |
| 🟡 | Task15a and Task15b make the same one-line edit to `apps/api/package.json` | Identical edits merge cleanly; if not, keep one |

## Test coverage / Integration test impact
Documents only; `git diff --check`. None.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.05× | about 0.05× | ~15 turns | ~1 h | not measured |
