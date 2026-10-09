# Task9c-prompt Handoff — Managed configuration and prompt organization

> Status: ✅ documentation complete · 🟡 Task9c implementation and native evidence remain future work.

Branch `docs/Task9c-prompt` (base: `main` at `21ad4e88494fd5784cc56aaa7dc2267ace33735f`, Task9a PR #16 merge).

This session adds the executable Task9c GitAI prompt, permits its disjoint Phase-A implementation while Task9b finishes long tests, and establishes Task-scoped prompt directories for active/future numbered Tasks. It changes no product code or runtime contract.

## At a glance

| | Item | Status |
|---|---|---|
| Acceptance | Task9c prompt consumes the exact merged Task9a worker envelope | ✅ |
| Acceptance | Task9c can start without touching Task9b's active files | ✅ phased implementation and merge gate |
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

1. 2026-10-09: Task9c may start while Task9b runs long Cargo tests, provided file ownership stays disjoint.
2. Task9c never edits Task9b's daemon command, async test, MDM, packaging or workflow files; it wires through the telemetry worker.
3. Task9c stops at a clean Phase-A checkpoint if Task9b is still unmerged, then rebases and completes Phase B after Task9b.
4. Numbered active/future Tasks keep lead and subtask prompts under `docs/prompts/Task<N>/`; generic and historical one-off prompts remain at the root.

## Deviations from spec

- Task9c now has an operational target of about 0.32× against the existing 0.40× ceiling, using one client state machine and existing GitAI primitives rather than a framework.
- The earlier diagram's strict Task9b-before-Task9c start is refined to a merge-order dependency: disjoint implementation may overlap, but Task9c rebases on and merges after Task9b.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Task9b has uncommitted work in `src/commands/daemon.rs` and `tests/async_mode.rs`. | Task9c must not touch those files and must re-check ownership before starting. |
| ⬜ | Task15 verifier implementation is unavailable. | Production candidate activation remains fail-closed; IT-M9-01 stays pending. |
| ⬜ | Native macOS/Windows secret-store and lifecycle evidence has not run. | Task9f/Task9g own support claims. |

## Test coverage

Documentation validation only: all moved prompt references resolve, the Task9c prompt names the exact Task9a contract and active Task9b exclusions, and `git diff --check` is clean. Product tests belong to the future GitAI Task9c branch.

## Integration test impact

> None for this documentation PR. Task9c must leave IT-M9-01, IT-T9-02 and IT-T9-05 pending until their owning implementation/conformance sessions.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-M9-01 | Task15-signed machine-bound configuration | Production blocker, not this docs PR | ⬜ waits for Task15 |
| IT-T9-02 | native Intel macOS lifecycle and Keychain | Blocking for supported macOS route | ⬜ Task9f |
| IT-T9-05 | native Windows lifecycle and Credential Manager/DPAPI | Blocking for native Windows claim | ⬜ Task9g/host |

## Integration notes

- Start Task9c from GitAI fork `main`, never public upstream.
- Focused delivery/activation tests are the baseline; the full Cargo suite runs once after the Task9b rebase.
- After Task9b merges, continue the same Task9c task, rebase, inspect the combined diff and rerun the bounded/full gates before review.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---:|---:|---|
| about 0.04× | about 0.04× | one prompt-design session | under one session | not shown |
