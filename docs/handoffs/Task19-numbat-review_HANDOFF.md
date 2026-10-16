# Task19-numbat-review Handoff: Numbat adoption review and vision update

> Status: 🟡 decisions recorded; cross-agent review remains. Symbols per AGENTS.md §11.

Branch `docs/Task19-numbat-review` (base: `main` at `67c903f`). Documentation only.

## At a glance
| | Item | Status |
|---|---|---|
| Vision | `docs/founder/VISION.md` §4: security through Numbat as a first-class subsystem, adopting Numbat as Git AI was adopted, a modular product | ✅ (founder's words, recorded at his request) |
| Primers | the founder's four Numbat primers committed unchanged under `docs/founder/` | ✅ |
| Review | `docs/plan/NUMBAT_ADOPTION_REVIEW.md`: Numbat verified against its code at `20a5a52`, primer corrections, Task6.a salvage, proposed architecture, new CISO questions S19–S26, effects on Tasks, ten decisions | 🟡 waiting on the founder's answers |
| Decisions | founder answers of 2026-10-16 recorded (review §13); glossary of policies and signing (§14) | ✅ |
| Round 2 | founder decisions of 2026-10-16 (review §15): Numbat pin confirmed, 44 rules, binary sizes, Task9 package validation paused; Task15n gate 6 removed (prompt edited) | ✅ |
| Prompt | `docs/prompts/Task19/NEXT_CHAT_Task19b-qa-live-code_PROMPT.md` (Muse, T19.3: ten code questions and the drill-down; Q11 moved to Task19c) | ✅ |
| Prompt | `docs/prompts/Task20/NEXT_CHAT_Task20-lead_PROMPT.md` (Task20 primer and plan in a fresh chat) | ✅ |

## Review
- Codex cross-review (2026-10-16), "fix first", both fixed:
  1. The Numbat pin is now the audited commit `20a5a52` (`v0.2.0-14-g20a5a52`, unreleased), not v0.2.0 (review §1, §11 item 1, §13 item 4; Task20 prompt §1 item 1). Founder to confirm.
  2. The rule bundle (`policy_bundle`) and the activation lease (`activation_lease`, D6.1) stay separately signed, with the trust contract's separate failure rules. The security data settings are inside the lease, and the server re-checks uploads (review §5, §14; Task20 prompt §1 item 5).

## Known limitations
- The TASK19.md tracker is not edited here, to avoid colliding with Task19a's open branch. The lead records the pauses (T19.4; gaps G7–G10) and the cancellation of G9 after Task19a merges.
- GitAI facts (security module sizes, agent presets) were read from the fork's `main` at `d1838619c`; Codex should confirm them in its review.

## Integration test impact
None: documentation only.

## Effort
About 0.03× T6 (reading Numbat's docs and rules, the primers and Task6.a).
