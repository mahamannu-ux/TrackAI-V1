# Task9c/Task9e prompt Handoff — Managed configuration and fleet console

> Status: ✅ documentation complete · 🟡 Task9c/Task9e implementation and native evidence remain future work.

Branch `docs/Task9c-prompt` (base: `main` at `21ad4e88494fd5784cc56aaa7dc2267ace33735f`, Task9a PR #16 merge).

This documentation session adds executable Task9c and Task9e prompts and establishes Task-scoped prompt directories for active/future numbered Tasks. The updated sequence now starts Task9c from GitAI `main` only after reviewed Task9b PR #3 merges; Task9e may overlap from TrackAI because it consumes the already-merged Task9a contract. It changes no product code or runtime contract.

## At a glance

| | Item | Status |
|---|---|---|
| Acceptance | Task9c prompt consumes the exact merged Task9a worker envelope | ✅ |
| Acceptance | Task9c starts from the reviewed Task9b merge and treats its surfaces as frozen | ✅ clean sequence |
| Acceptance | Task9e consumes only Task9a's five frozen admin routes | ✅ bounded UI prompt |
| Acceptance | Task9, Task13, Task15 and Task16 prompts grouped by Task | ✅ links updated |
| Scope | fail-closed verification, atomic last-known-good, macOS/Windows secret stores and safe reporting are fully bounded | ✅ prompt only |
| Quality | path/reference scan and whitespace validation | ✅ |
| Integration | no product code or infrastructure changed | ✅ none needed |
| Review | full documentation diff re-read; cross-agent review | 🟡 pending |

## Implemented interfaces

No product interface was implemented. The prompt freezes the intended client boundaries:

```text
GET  /worker/fleet/configuration -> closed schema-v1 candidate
verify -> verified | rejected | unavailable
activate -> atomic current + one verified last-known-good
POST /worker/fleet/report -> closed metadata and safe result code
machine credential -> Keychain or Credential Manager/DPAPI, never managed file fallback
```

## Ported from

None. The prompt reuses merged TrackAI Task9a PR #16, Task4 machine/delivery contracts, Task6 activation semantics, Task14 T14.3, and existing GitAI primitives. It expressly avoids a public-upstream or SushiCorp port.

## Founder-approved decisions

1. 2026-10-10: Task9b is reviewed and open as GitAI PR #3; Task9c starts only after that PR merges, avoiding a needless mid-session rebase.
2. Task9c never edits Task9b's daemon command, async test, MDM, packaging or workflow files; it wires through the telemetry worker.
3. Task9e extends the existing Task4 administration UI with a separate fleet workspace and adds no server route or configuration-history fiction.
4. Numbered active/future Tasks keep lead and subtask prompts under `docs/prompts/Task<N>/`; generic and historical one-off prompts remain at the root.

## Deviations from spec

- Task9c now has an operational target of about 0.32× against the existing 0.40× ceiling, using one client state machine and existing GitAI primitives rather than a framework.
- Task9c now follows the simpler strict Task9b-before-Task9c sequence because Task9b is at PR review rather than long-running implementation.
- Task9e explicitly exposes the frozen API's lack of a complete configuration-history listing instead of expanding Task9a during a UI session.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| 🟡 | GitAI Task9b PR #3 still needs hosted macOS/Windows and package smoke evidence. | Merge it only after required CI; Task9c starts afterward. |
| ⬜ | Task15 verifier implementation is unavailable. | Production candidate activation remains fail-closed; IT-M9-01 stays pending. |
| ⬜ | Native macOS/Windows secret-store and lifecycle evidence has not run. | Task9f/Task9g own support claims. |

## Test coverage

Documentation validation only: all moved prompt references resolve, Task9c names the exact Task9a/Task9b inputs, Task9e names the exact Task9a admin routes and honest states, and `git diff --check` is clean. Product tests belong to the future implementation branches.

## Integration test impact

> None for this documentation PR. Task9c must leave IT-M9-01, IT-T9-02 and IT-T9-05 pending until their owning implementation/conformance sessions.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-M9-01 | Task15-signed machine-bound configuration | Production blocker, not this docs PR | ⬜ waits for Task15 |
| IT-T9-02 | native Intel macOS lifecycle and Keychain | Blocking for supported macOS route | ⬜ Task9f |
| IT-T9-05 | native Windows lifecycle and Credential Manager/DPAPI | Blocking for native Windows claim | ⬜ Task9g/host |

## Integration notes

- Start Task9c from GitAI fork `main`, never public upstream.
- Focused delivery/activation tests are the Task9c baseline; the full Cargo suite runs once at its stable final checkpoint.
- Task9e can run in parallel with Task9c after Muse is free because it uses the TrackAI repository and frozen Task9a routes.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---:|---:|---|
| about 0.06× | about 0.06× | one prompt-design session plus update | under one session | not shown |
