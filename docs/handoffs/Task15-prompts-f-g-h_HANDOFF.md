# Task15-prompts-f-g-h Handoff — prompts for Task15f (anchoring), Task15g (KMS), Task15h (builder)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/Task15-prompts-f-g-h` (base: `task/Task15d-attesta-ledger` at `a0e64e9`, merged as PR #33; contains the Task2 trigger, PR #32). Docs only, written in the Task15 lead chat.

Three prompts that can run in parallel (no shared files): Task15h-attesta-builder (Claude, A15.8), Task15f-attesta-anchoring (Claude, A15.5), Task15g-attesta-kms (Muse, A15.6). Also the additive `errors.md` codes the founder approved in Task15d.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | 15h follows `envelope.md` steps 1–7, `fields.md`, the `outbox.md` worker protocol; signer resolution as an interface | ✅ |
| Acceptance | 15f follows `tables.md` anchor tables; SushiCorp EV-2/TR-1 sources cited with line counts; checkpoint for anchoring key, TSA revocation, Rekor v2 | ✅ |
| Acceptance | 15g every decision made; both SDKs load under Node 20 in CommonJS (checked in the lead's sandbox) | ✅ |
| Contract | `errors.md`: `ATTESTA_LEDGER_INVALID_INPUT` and ten exact `ATTESTA_VERIFY_*` codes, additive (founder decision in Task15d) | ✅ |
| Scope | `TASK15.md` statuses (A15.3, A15.7 merged) and §5 links; status board row | ✅ |
| Review | cross-agent review | 🟡 requested |

## Founder-approved decisions
1. Pending (merging this PR approves): runtime dependencies `@aws-sdk/client-kms@3.1141.0` and `@google-cloud/kms@5.7.0` for Task15g (6.x needs Node ≥ 22; CI runs Node 20).

## Deviations from spec
- Estimates raised: 15h 0.1× → 0.2×, 15f 0.25× → 0.3×, 15g 0.08× → 0.1× (Task15c/15d ran over on similar scopes).
- `BREAK_DETAIL_CODES` switch to the new codes is assigned to 15f (it already edits `verify-chain.ts`), not 15h, so the parallel sessions share no file.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Task15l (trust layer, A15.12) is not started here | It supplies the production `SignerResolver`; start it after 15h merges |

## Test coverage
None: documentation only.

## Integration test impact
None here. The sessions add IT-T15h-01…04 and IT-T15f-01…04.

## Integration notes
After 15f, 15g and 15h merge, A15.9 (evidence API, `period_report`) and A15.12 (trust layer) can start.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| not estimated (lead planning) | about 0.02× | lead chat | ~45 min | n/a |
