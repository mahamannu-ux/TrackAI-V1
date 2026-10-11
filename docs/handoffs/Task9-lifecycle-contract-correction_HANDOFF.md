# Task9 lifecycle-contract-correction Handoff — Freeze before Task9d

> Status: ✅ design frozen · ⬜ Task9a2/Task9c2 implementation pending.

Branch `docs/Task9-lifecycle-contract-correction` (base: TrackAI PR #18 merge `b43d007`).

This documentation session freezes the smallest correction after Task9d correctly stopped before code. It changes no runtime contract and leaves the clean Task9d GitAI worktree at `cc155d692` untouched.

## At a glance

| | Item | Status |
|---|---|---|
| Contract | schema-v2 compatibility and immutable desired release | ✅ frozen |
| Integrity | exact-tag URL plus pinned `SHA256SUMS` SHA-256 | ✅ frozen |
| Authorization | persisted exact bytes must reverify before execution | ✅ frozen |
| Production | Task15 unavailable yields no activation/execution | ✅ frozen |
| Sequence | TrackAI Task9a2, then GitAI Task9c2, then recreated Task9d | ✅ frozen |
| Runtime | code/migration/client behavior | ⬜ future implementation sessions |

## Frozen interfaces

```text
schema v1 -> readable/assignable; no release execution authorization
schema v2 -> clientCompatibility + desiredRelease
release ID -> (version, tag, exact manifest URL, manifest SHA-256)
authorization -> exact bytes + digest + parse/time/compatibility/binding + verifier
production verifier unavailable -> no active candidate and no execution
```

## Founder-approved decisions

1. Preserve Task9e PR #18; its inventory/status/assignment/offboarding remain intact.
2. Keep v1 creation temporarily compatible so the merged form does not break.
3. Use the fork's proven exact-tag GitHub release path; never managed channel/latest paths.
4. Pin `SHA256SUMS`; it pins the installer/binary assets and makes replacement fail closed.
5. Keep TrackAI and GitAI implementation in separate reviewed/merged sessions.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ | Task9a2 not implemented | v2 is design only |
| ⬜ | Task9c2 not implemented | no verified release authorization seam |
| ⬜ | Task15 verifier unavailable | production activation and execution remain blocked |
| 🟡 | Task9e v2 form/types not yet assessed against merged code | only a narrow follow-up may be needed after Task9a2 |

## Test coverage

Documentation/source validation only: the design traces merged Task9a fields, Task9c state, the mutable updater endpoints, and exact-tag paths in the fork's release workflow/installers. `git diff --check` and prompt/path scans are the gates for this branch.

## Integration test impact

No runtime test is added here. Task9a2 must extend existing blocking IT-T9-01. Task9c2 uses focused/full Cargo gates. IT-M9-01 remains pending Task15 and blocks production verification/execution claims.

## Integration notes

- Run `NEXT_CHAT_Task9a2-release-contract-correction_PROMPT.md` first and merge it.
- Then run `NEXT_CHAT_Task9c2-release-state-correction_PROMPT.md` in a different repository/session and merge it.
- Only then recreate/rebase Task9d from corrected GitAI `main` and implement lifecycle behavior.

## Effort

| Estimate (× T6) | Actual (× T6) | Sessions | Note |
|---|---|---:|---|
| about 0.06× | about 0.06× | one design session | source-backed correction and two executable prompts |
