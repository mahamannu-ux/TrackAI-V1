# <name> Handoff — <Task name>

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/<name>` (base: `main` at `<sha>` | stacked on `<branch>`).

<One paragraph: what this Task does and what it deliberately does not do.>

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | <each acceptance criterion from the spec, one row each> | ✅/🟡/⬜ + note |
| Scope | <each scope item from the prompt> | ✅/🟡/⬜ |
| Quality | unit tests, lint, type check (numbers) | ✅ |
| Integration | <tests added, or "none needed"> | ✅/🟡/⬜, blocking or non-blocking |
| Review | independent review; cross-agent review | ✅ + what was fixed |

## Implemented interfaces
<Public signatures, routes, CLI commands and settings other Tasks can use. Code block, no prose padding.>

## Ported from (only if a catalogued component was ported)
<`ported from <source project> <unit> @ <commit>`; the catalog entry; every deviation from the source, with its reason (reuse/PORTING_GUIDE.md).>

## Founder-approved decisions
<Numbered, as built. Mark any made mid-session with the date.>

## Deviations from spec
<Anything done differently, and why. Shared files touched, and who approved them.>

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | <to-do with the exact command> | <what waits on it> |
| 🟡 | <limitation> | <who is affected, what follows up> |

## Test coverage
<What is tested, what is mocked and why, what is not tested.>

## Integration test impact
> **FOUNDER:** <blocking or non-blocking, and for what>. Prerequisites: <tools>. Expected: <N passed, about M minutes>.
> ```bash
> scripts/it-db.sh <command>
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-<ID>-01 | ... | Blocking: <what> / non-blocking | 🟡 agent-verified · ⬜ founder run |

<One line each: what can proceed without these runs; what must wait.>

## Integration notes
<Gotchas for the Tasks that consume this one, and for deployment.>

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.6× | about 0.8× | ~130 turns + review | ~2 h | ~1.2M tokens |

<If the actual is more than 1.25× the estimate: the top causes, one line each (for example "three review rounds", "re-ran the volume suite twice"), and what the next prompt should do differently.>
