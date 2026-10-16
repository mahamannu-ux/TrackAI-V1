# Task20-plan Handoff: coding-agent security with Numbat (primer, tracker, session plan)

> Status: 🟡 plan written; waiting on the founder's go-ahead at checkpoint 2 and on the cross-agent review. Symbols per AGENTS.md §11.

Branch `docs/Task20-plan` (base: `main` at `6b6156c`). Documentation only. Written by the Task20 lead (Claude), following `docs/agents/TASK_LEAD_PROCEDURE.md` Phases 0–2.

## At a glance
| | Item | Status |
|---|---|---|
| Primer | `docs/plan/primers/Task20_PRIMER.md`: 20 pieces in four waves, ten facts from the code, Q1–Q10, the session graph | ✅ approved 2026-10-16 (checkpoint 1) |
| Founder decisions | Q1–Q10 as recommended, with the simplicity rule and a fallback per question; the TrackAI Endpoint name; session graphs; Task20 lead updates TASK19.md | ✅ recorded (primer, `TASK20.md` §9) |
| Tracker | `docs/plan/TASK20.md`: boundaries, master matrix, interfaces to freeze first, waves and exit gates, 12 sessions with files, session graph, budgets, evidence registry, completion boundary | ✅ |
| Task19 | `docs/plan/TASK19.md` updated for the Numbat decision: T19.7 done, Task19a merged, T19.4/Task19c wait for Task20d, gaps G7/G8/G10 (model)/G11 moved into Task20, G9 cancelled, G2/G12 shelved, §5 superseded, §6 gap table and session graph | ✅ |
| Shared docs | AGENTS.md §2 (naming: GitAI, Git AI, TrackAI Endpoint) and §4 (a Task20 row; Task6 Security marked superseded); `docs/templates/TASK_PRIMER_TEMPLATE.md` and `docs/agents/TASK_LEAD_PROCEDURE.md` (session graph instead of sub-task graph) | ✅ founder-requested |
| Licence | `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md`: section for binary redistribution at the pin `20a5a52` | 🟡 needs the founder's or counsel's confirmation before the first customer build |
| Status board | Task20 row; Task19 and Task9 rows refreshed; remaining-plan rows 9–9k; IT-T20 and E20 rows | ✅ |
| Review | independent review subagent on the primer (6 must-fix, 9 should-fix, all fixed before checkpoint 1); plan review subagent; Codex cross-review round 1 "fix first": (1) Task20f now owns the server half of the fleet lease reference, (2) Task20a freezes the machine-authenticated lease and bundle retrieval routes, (3) `TASK9.md` decision 10 and the status board record the pause and the resume point, (4) `git diff --check` clean | 🟡 round 2 pending |

## Decisions the next sessions build on
1. Endpoint vocabulary: "the Endpoint" for anything on or delivered to a machine; "GitAI" only for the repository.
2. Monitoring is machine-wide; activation is fail-closed and tenant/machine-bound (AGENTS.md §9 item 9 is rewritten in Task20j).
3. Two separately signed documents (bundle, lease) on Task15's trust layer; Task20 builds the Rust verifier (GitAI backlog row G8).
4. Phase 1 is tamper-evident at the server, not tamper-resistant; a root helper precedes any blocking.
5. Task20d (ingest) goes to Muse so Codex's lane (Task20c → 20e → 20g → 20h → 20j) stays the only long serial chain.
6. A new crate for ECDSA P-256 in GitAI (Task20c) is pre-approved by merging this plan.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Create the Numbat mirror fork under `mahamannu-ux` and push the tag `v0.2.0-trackai.1` at `20a5a52` (commands in the plan reply: `gh repo fork perplexityai/numbat --clone=false`, then tag and push from `~/AIProjects/numbat`) | Task20b waits for it |
| ⬜ **FOUNDER:** | Rank S19–S26 with the Task19 lead (T20.18) | Task19c's scope |
| 🟡 | `docs/plan/TASK15.md` §5 still lists six Task15n gates; gate 6 was removed on 2026-10-16 (review §15 item 4) | The Task15 lead updates its own tracker |
| 🟡 | The audit event `security.enforce_mode.changed` is not in the frozen audit catalogue yet | Task20f adds it through a Task16 contract PR |
| 🟡 | Migration numbers are taken at generation time; Task20d, Task20f and Task20i each add one | Each generates on a fresh `main` |

## Test coverage
Documentation only; no code changed. `npm test` on the base: 1020 passed, 0 failed (cloud workspace, 2026-10-16).

## Integration test impact
> **FOUNDER:** non-blocking for this plan PR. No command needed: the branch changes only Markdown.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T20b-01 … IT-T20h-01, E20-01…E20-12, IT-M20-01, IT-M20-02 | planned in `docs/plan/TASK20.md` §7 and the status board | per session | ⬜ planned |

## Integration notes
- Task19c, Task15o and Task4-entitlements wait for Task20d; Task9 resumes its paused package checks after Task20h; Task13 is revisited after Task20j.
- Task20 reuses Task6.a's frozen `docs/contracts/task6/` only as history; new shapes go in `docs/contracts/security-v2/` (Task20a).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.08× (lead's own work, plan phase) | about 0.06× (by turns) | 3 founder turns, about 70 tool calls, 2 review subagents | about 3 h | not shown |
