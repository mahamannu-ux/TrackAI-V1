# Task15-prompts-c-e Handoff — prompts for Task15c (contract) and Task15e (fakes)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/Task15-prompts-c-e` (base: `docs/Task15-attesta-questions` at `04fce65`, merged as PR #25). Docs only, written in the Task15 lead chat.

Two session prompts that can run in parallel: Task15c-attesta-contract (Claude, A15.0 plus the outbox migration so Codex can start A15.7) and Task15e-attesta-fakes (Muse, A15.4).

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | 15c prompt: deliverables from `ATTESTA_QUESTIONS.md` decisions 1–5, design checkpoint, Codex as reviewer | ✅ |
| Acceptance | 15e prompt: every behaviour and knob of SushiCorp `fake_rekor.py` / `fake_tsa.py` @ `0bd67a5`, cited from source | ✅ |
| Scope | `TASK15.md` §3 statuses and §5 prompt links; status board row | ✅ |
| Quality | Docs only. `@noble/curves@2.4.0` prehash verify (`lowS: false`) and the pkijs engine setup were checked in the lead's sandbox | ✅ |
| Integration | None needed | ✅ non-blocking |
| Review | cross-agent review | 🟡 requested |

## Founder-approved decisions
1. Pending (merging this PR approves): runtime dependencies `@noble/curves@2.4.0`, `pkijs@3.4.1`, `asn1js@3.0.10` for Task15e and later A15.5.

## Deviations from spec
- Task15c also ships the `attesta_subjects` migration and insert helper (interfaces first, AGENTS.md §5); estimate raised to 0.08×.
- Task15e estimate raised to 0.1× (ASN.1 built by hand in TypeScript).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Validator dependency for the 15c contract fixtures is left to that session to propose | founder answers there |

## Test coverage
None: documentation only.

## Integration test impact
None needed. Task15c will register `IT-T15c-01`.

## Integration notes
Codex's `Task2-attesta-trigger` (A15.7) prompt follows once Task15c merges.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| not estimated (lead planning) | about 0.01× | lead chat | ~40 min | n/a |
