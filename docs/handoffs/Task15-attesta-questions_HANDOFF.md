# Task15-attesta-questions Handoff — Attesta question catalogue and Q&A subtasks

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/Task15-attesta-questions` (base: `main` at `bb617f6`). Docs only, written in the Task15 lead chat.

Works backwards from the customer and the auditor: 20 questions Attesta and attribution should answer, checked against Task2's data, with Codex's Task2 interview (I1–I8) and the decisions it implies for A15.0. Adds the Q&A surfaces as subtasks of Task10 (T10.9) and Task16 (A16.13). No code, no contract, no migration.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Question catalogue with auditor flags, data check, "answered by", gaps G1–G5 | ✅ |
| Acceptance | Codex's Task2 answers kept verbatim; A15.0 decisions derived from them | ✅ |
| Scope | T10.9 in `ROUGH_ROADMAP.md`; A16.13 row, graph edges, session and decision in `TASK16.md` | ✅ |
| Scope | `TASK15.md`: current-state paragraph corrected, A15.1/A15.2 merged, decisions 4–5; status board row and date | ✅ |
| Quality | Docs only; no gates affected | ✅ |
| Integration | None needed | ✅ non-blocking |
| Review | Cross-agent review round 1: fix first (5 items), all fixed | 🟡 re-review requested |

## Implemented interfaces
```
docs/plan/ATTESTA_QUESTIONS.md   question catalogue (living; founder adds Task5/6.a/6.b questions)
  Q1–Q20, gaps G1–G5, interview I1–I8, decisions for A15.0 (1–5)
Task10 T10.9   customer/admin Q&A (live queries)
Task16 A16.13  auditor Q&A (signed statements, verify, export)
```

## Founder-approved decisions
1. 2026-10-12: question-first approach; predicate versioning (additive minor versions, availability on every field, new facts as new statements); Q&A belongs to Task10 and Task16.
2. 2026-10-12: PR review capture (G3) and `merged_by` (G4) land before production.

## Deviations from spec
Shared trackers touched at the founder's request: `ROUGH_ROADMAP.md` (Task10 row), `docs/plan/TASK16.md`, `docs/plan/STATUS_BOARD.md`.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Question list incomplete (Task5, Task6.a, Task6.b questions to come) | T10.9 and A16.13 are sized when it is complete |
| ⬜ | Gap owners (G1–G5) proposed, not yet accepted by Task2, Task4, Task6.b | Predicate fields start `unavailable` until closed |

## Test coverage
None: documentation only.

## Integration test impact
None needed: no code, database or routes.

## Integration notes
`Task15c-attesta-contract` (A15.0) reads `docs/plan/ATTESTA_QUESTIONS.md` § "Decisions for A15.0" as input; Codex's `Task2-attesta-trigger` (A15.7) follows its outbox idempotency keys once A15.0 freezes them.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| not estimated (lead planning) | about 0.01× | lead chat, 2 review rounds | ~1 h | n/a |
