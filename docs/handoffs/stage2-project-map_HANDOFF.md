# stage2-project-map Handoff — understanding TrackAI

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/stage2-project-map` (stacked on `docs/adopt-agent-kit` at `e1d7e37`; rebase onto `main` once PR #8 merges).

Stage 2 of the setup brief: the founder's vision as given, a project map for orienting agents, the SushiCorp reuse map with the Attesta starting point, and AGENTS.md §9 gotchas corrected and extended (including those carried over for ported components). Documents only. Read with four read-only research passes (Task2/Task4, Task5/Task6/Task13/Task14 and the console, the GitAI fork, SushiCorp and the catalog); key claims were re-checked in the code.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | `docs/founder/VISION.md` (verbatim, parts 1–3), `docs/plan/PROJECT_MAP.md`, `docs/plan/REUSE_MAP.md`, `docs/plan/BUG_BACKLOG.md`, `docs/plan/GITAI_FUTURE_TODO.md` | ✅ |
| Scope | Dry-run prompt `docs/prompts/NEXT_CHAT_dryrun-api-hygiene_PROMPT.md` (Codex leads, hands B14 to Muse) | ✅ |
| Scope | AGENTS.md §2 (plan files), §9 gotcha 3 corrected (0000's Supabase browser policies, composite keys from 0003), gotchas 13–14 (Task2–Task6 traps, GitAI noise), 16–21 (ported components) | ✅ |
| Quality | `kit-check --unfilled`; `git diff --check` | ✅ |
| Integration | none needed | n/a |
| Review | Codex cross-review | ⬜ |

## Implemented interfaces
None (documents only).

## Deviations from the brief
- Stage 2 ran before the dry runs (founder agreed 2026-10-07), so the dry runs can pick real housekeeping items from the map.
- The vision is saved unedited; the founder will extend it.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | The map was written from reading, not from running every flow; Codex knows the code best and should correct it | Wrong orientation for an agent until fixed |
| 🟡 | `AGENT_COVERAGE.md` (Task13) is stale since 2026-08-02; the map does not refresh it | Task13 planning needs a refresh first |

## Test coverage
No code changed. Claims re-checked directly: migration 0000's conditional `authenticated` policies, `churned` never written, JWT verification options, no admin writer for `tenant_security_monitor_settings`.

## Integration test impact
None.

## Integration notes
- New agents start from `docs/plan/PROJECT_MAP.md`; `REUSE_MAP.md` §3 is the input to the Task15 primer.
- AGENTS.md §9 numbering changed (old 13 is now 15).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.05× | about 0.05× | ~25 turns + 4 research subagents | ~1 h | not measured |
