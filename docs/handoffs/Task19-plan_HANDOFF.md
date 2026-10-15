# Task19-plan Handoff: customer and auditor Q&A delivery, session plan

> Status: 🟡 plan written; cross-agent review and merge remain. Symbols per AGENTS.md §11.

Branch `docs/Task19-plan` (base: `main` at `719595f`). Documentation only: no code, contract, migration or workflow changes.

This session records the founder's decisions on Task19 and adds the running-status column to the delivery matrix. It also splits Task19 into sessions, sets the order in which gaps are dispatched to their owning Tasks, and writes the first session prompt.

## At a glance

| | Item | Status |
|---|---|---|
| Decisions | `TASK19.md` §1 D1–D5 approved by the founder 2026-10-15, recorded in §1 and §7 | ✅ |
| Matrix | §3 gains a **Status (capture · live · auditor)** column, with its rules and a running total (0 of 37 answered, Q17 phase 2; capture 10 ✅, 20 🟡, 7 ⬜, 1 n/a) | ✅ (T19.1 confirms each symbol against the code) |
| Sessions | §6.1: Task19a–19e, lead work and the founder walkthrough, with agent, estimate, dependencies and files; about 0.46× against the 0.4× plan, Q2 not yet sized | ✅ |
| Gap dispatch | §6.2: ten gap sessions in the §4 order, each with owner, estimate and the rows it moves | ✅ |
| Prompt | `docs/prompts/Task19/NEXT_CHAT_Task19a-qa-matrix-contract_PROMPT.md` (T19.1 + T19.2, Claude, about 0.09×) | ✅ |
| Ownership | AGENTS.md §4 gains the Task19 row (`features/qa/`, `docs/contracts/qa/`, the Questions page) | ✅ |
| Ledgers | Status board: Task19 row, remaining-plan rows 7i–7i3; `CUSTOMER_AUDITOR_QA.md`: the hybrid is dropped (D2) | ✅ |
| Review | Cross-agent review of this plan | ⬜ |

## Implemented interfaces
None. Future sessions build on:
- `docs/plan/TASK19.md`: §3 matrix and status rules; §6.1 own sessions; §6.2 gap sessions;
- the Task19a prompt, which fixes the Q&A contract's shape (registry, envelope, `/api/qa/*`, `qa.read`).

## Decisions the plan makes (lead)
1. **Task19a includes a pure move of three Task2 functions** (an exception to D3; it needs the founder's yes, recorded as pending in `TASK19.md` §7 item 3).
   - `loadContext`, `lifecycleForTenant` and `lifecycleForModel` are private to `features/telemetry/read.routes.ts` (`:84`, `:464`, `:636`). The live answers must reuse Task2's semantics (rule 8), so Task19a moves them unchanged into a new Task2 file.
   - It is its own commit, and **Codex reviews Task19a** as Task2's owner.
2. **Auditors are refused live answers by the server** (`QA_KIND_NOT_ALLOWED`), not just by the UI (D2, rule 9).
3. **No person dimension anywhere in the contract,** enforced by a unit test (no-surveillance rule).
4. **The Task6.a acceptance walkthrough is not a separate session.** It already runs as Task15n gate 6.
5. **Muse prompts (Task19b/19c) are written only after Task19a merges,** so every decision can be stated upfront.

## Deviations
- The founder asked for "tick marks / color coding". The column uses AGENTS.md §11's three symbols, one per stage (capture · live · auditor), rather than a single overall symbol, so a row shows where it is stuck.

## Known limitations
- The status symbols come from `CUSTOMER_AUDITOR_QA.md` "Data today" and from merged work; T19.1 confirms them against the code.
- Gap-session estimates are the lead's; each owner confirms its own when the prompt is written.
- Q2 is not sized yet (T19.1 sizes it).

## Integration test impact
None: planning only. Task19a adds IT-T19a-01, which blocks its merge.

## Effort
Estimate about 0.02× T6; actual about 0.02×.
