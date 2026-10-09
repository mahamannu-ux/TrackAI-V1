# codex-task-lead Handoff — Codex leads whole Tasks

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/codex-task-lead` (base: `main` at `2177237`). Prompt: `docs/prompts/NEXT_CHAT_codex-task-lead_PROMPT.md`.

Lets Codex run a whole roadmap Task with Muse: a procedure, two lead prompts, the primer template's agent column and sub-task graph, the review fallback, and roadmap rows for Task15 and Task16. Documents only.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | `docs/agents/TASK_LEAD_PROCEDURE.md` (phases, checkpoints, Muse hand-offs, reviews, close) | ✅ |
| Scope | `docs/prompts/Task9/NEXT_CHAT_Task9-lead_PROMPT.md`, `docs/prompts/Task13/NEXT_CHAT_Task13-lead_PROMPT.md` | ✅ |
| Scope | Primer template: "Who" column and Mermaid sub-task graph | ✅ |
| Scope | AGENTS.md §12.6 (Muse reviews Codex when Claude is unavailable; security-critical waits for the orchestrator), §12.8 pointer | ✅ |
| Scope | `ROUGH_ROADMAP.md` rows Task15 Attesta and Task16 Audit; status board rows | ✅ |
| Review | Cross-review by Codex | ⬜ |

## Founder-approved decisions
1. Codex and Muse take Task9 and Task13 over the next days; Claude takes Task15 Attesta and the audit Task (2026-10-08).
2. Attesta owns the shared trust layer; Task9 consumes it through a seam.

## Deviations
- The audit Task is numbered **Task16** (the founder said "Task15 for that"; Attesta already holds Task15, and he called audit a Task of its own). Renumber if he prefers one Task.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Task9 and Task13 share GitAI files (`src/mdm/`, `src/config.rs`, installers); running both leads at once needs the founder to sequence those sessions | Possible merge conflicts |

## Test coverage / Integration test impact
Documents only; `git diff --check`. None.

## Integration notes
Codex's lead threads start from the two prompts; every later session prompt and Muse prompt is written by the lead from the templates.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.03× | about 0.03× | ~12 turns | ~30 min | not measured |
