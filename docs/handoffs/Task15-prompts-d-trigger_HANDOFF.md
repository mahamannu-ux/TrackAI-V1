# Task15-prompts-d-trigger Handoff — prompts for Task15d (ledger) and Task2-attesta-trigger

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/Task15-prompts-d-trigger` (base: `task/Task15c-attesta-contract` at `b9a613a`, merged as PR #30). Docs only, written in the Task15 lead chat.

Two prompts that can run in parallel (no shared files): Task15d-attesta-ledger (Claude, A15.3) and Task2-attesta-trigger (Codex, A15.7).

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | 15d prompt builds exactly `docs/contracts/attesta/tables.md` (records, envelopes, head) and `envelope.md` step 7; SushiCorp EV-1 sources and tests cited with line counts | ✅ |
| Acceptance | Codex prompt implements `outbox.md` "Which transaction writes each kind"; line references checked on `b9a613a` | ✅ |
| Scope | `TASK15.md` §3 statuses (A15.0 and A15.4 merged) and §5 prompt links; status board row | ✅ |
| Integration | None here. 15d adds IT-T15d-01…04; the Codex session adds IT-T2AT-01…04 | ✅ non-blocking |
| Review | cross-agent review | 🟡 requested |

## Deviations from spec
- Estimates raised: Task15d 0.2× → 0.25× (migration + guards + logic + verify report); Task2-attesta-trigger 0.1× → 0.15× (normalization and deployment become transaction-aware).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T15c-01: `cd ~/AIProjects/TrackAI-v1 && scripts/it-db.sh npm run -s verify:task15c-outbox-live -w apps/api` | Blocks the Task2-attesta-trigger merge, not its start |
| 🟡 | The rebuild/idempotency-conflict decision in the Codex prompt is a recommendation | Codex confirms with the founder in-session |

## Test coverage
None: documentation only.

## Integration test impact
None here.

## Integration notes
The builder (Task15h, A15.8) follows both: it needs `chainStatement` (15d) and rows from the trigger.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| not estimated (lead planning) | about 0.01× | lead chat | ~30 min | n/a |
