# Task9-plan Handoff — Task9 managed developer fleet planning

> Status: 🟡 planning complete; checkpoint-2 cross-agent review and founder go-ahead remain. Symbols per AGENTS.md §11.

Branch `docs/Task9-plan` (base: `main` at `6ffd754ebb52109ea9704474ba5ee1e2833fd241`).

This documentation-only session turns the approved Task9 primer into an authoritative scope, seven-session implementation sequence, ownership map and evidence registry. It does not implement product code, claim native/MDM validation or create the later session prompts.

## At a glance

| | Item | Status |
|---|---|---|
| Acceptance | Primer recommendations and founder answers recorded | ✅ |
| Acceptance | T9.1–T9.10 scope, deferrals, interfaces, waves and gates frozen in `docs/plan/TASK9.md` | ✅ |
| Acceptance | Seven descriptive Codex/Muse sessions fit the founder's fewer-than-eight-or-nine limit | ✅ |
| Acceptance | Status board and IT-T9/IT-M9 evidence rows updated | ✅ |
| Scope | Planning documentation only; no code, migration, contract or workflow edits | ✅ |
| Quality | `npm ci`; 152/152 tests; documentation diff/whitespace check | ✅ (diff check repeated at close-out) |
| Integration | No integration run is needed for a planning-only branch; future rows are designed, not passed | ✅ none needed now; live gates remain ⬜ |
| Review | Independent cross-agent review | ⬜ founder sends the close-out review request |

## Implemented interfaces

No product interface was implemented. The planning contracts future sessions consume are:

```text
docs/plan/TASK9.md
  §1 approved product and security boundaries
  §3 managed-configuration, fleet-evidence, rollout and offboarding semantics
  §5 seven sessions, dependencies and owned surfaces
  §6 IT-T9-01..07 and IT-M9-01 evidence registry
  §7 acceptance invariants
  §8 completion and deferral boundary
```

## Ported from

None. No SushiCorp component is suitable for an endpoint fleet; Task9 instead plans reuse of TrackAI Task4, Task6 Security, Task14 T14.3, Task15's future trust seam and GitAI's existing packaging/updater/hook machinery.

## Founder-approved decisions

1. On 2026-10-09, the founder approved all primer recommendations and the seven-session shape.
2. Linux packaging, deployment, secret-store and E2E support are deferred to a later wave.
3. Phase 1 proves post-login execution on an already-enrolled device; ADE, Autopilot and OOBE certification are later.
4. Jamf, Intune, a Windows host and a second Mac are best-effort procurement. Engineering proceeds and unavailable evidence stays pending.
5. Prefer Windows 11 Pro x64 with local administrator access. Without it, hosted Windows x64 build plus MSI install/uninstall is the minimum evidence and is not a native-support claim.
6. Do not add Windows ARM64 work; retain the existing quick build-only path only while cheap.
7. Task9 creates a typed verifier seam; Task15 remains the owner of signed configuration/activation trust.

## Deviations from spec

- None material. The primer's proposed seven sessions and sequence were retained.
- The founder clarified the phase-1 enrollment boundary and procurement fallback; both are now explicit in the primer and tracker.
- No session prompts were written yet because they must use the reviewed planning interfaces and current merged SHAs.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** send the review request below to TrackAI-Orchestrator, or Muse if the orchestrator is unavailable | The planning branch cannot be pushed until the reviewer returns `ready to push` | Blocks planning PR and implementation go-ahead |
| 🟡 | Windows/Intune, Jamf and second-Mac access are not guaranteed | Native/managed support rows remain pending if unavailable; portable engineering continues |
| 🟡 | Task13 may share GitAI packaging, MDM, config and startup files | Task9b–Task9d must be sequenced against any active Task13 work |
| 🟡 | Task15 trust implementation is not yet integrated | Production signed configuration/activation remains blocked on IT-M9-01, not Task9 engineering |

## Test coverage

- `npm ci` completed on the exact planning worktree.
- `npm test` passed all 152 tests. The first sandbox attempt produced two localhost `listen EPERM` failures; the exact rerun outside that network restriction passed, so those were infrastructure-only rather than source failures.
- `git diff --check` covers the final planning diff.
- No product behavior changed, so no new unit or integration test was added.

## Integration test impact

> **FOUNDER:** non-blocking for this planning PR. No integration command is required because the branch changes only Markdown. IT-T9-01–07 and IT-M9-01 are specifications for later implementation/conformance sessions and remain unverified.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T9-01–07 | Database, current-Mac, Jamf, hosted Windows, native Windows, Intune and second-Mac evidence | Blocking only for the support claim named in `docs/plan/TASK9.md` §6 | ⬜ designed or pending access |
| IT-M9-01 | Task15-signed configuration/activation trust integration | Production blocker shared with D6.1; not Task9 engineering | ⬜ waits for Task15 |

Implementation sessions may start after the planning PR merges and the founder gives the checkpoint-2 go-ahead. Customer support claims must wait for their exact native/MDM row.

## Integration notes

- Start Task9a and Task9b only after this plan merges; they are the one recommended parallel pair.
- Task9a freezes server-facing semantics before Task9c or Task9e consumes them. Task9d waits for Task9c.
- Run Task9f on the current Intel Mac before Task9g. Missing procurement narrows support wording; it does not convert a pending row into a pass.
- Do not run a Task9 implementation session concurrently with Task13 when their declared GitAI files overlap.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.05× | about 0.05× | one lead session across two founder checkpoints | not recorded | not shown |

The implementation plan remains about 2.2× T6 across seven sessions; the later Linux wave is about 0.3× T6 and is not an eighth placeholder session.
