# adopt-agent-kit Handoff — agent-kit 0.1.0 working style

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `docs/adopt-agent-kit` (base: `main` at `336b337`).

Adopts agent-kit 0.1.0 for TrackAI: the rulebook, the review and orchestrator procedures, templates, the status board, the effort benchmark, worktree targets for both repositories, a throwaway-database wrapper and root npm gates. No product code, no dependency, CI or migration change. The session prompt was the founder's setup brief in the TrackAI-Orchestrator chat (stage 1 of three); the decisions are recorded in `docs/plan/KIT_ADOPTION.md`.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | `AGENTS.md`, `CLAUDE.md`, `docs/agents/`, `docs/templates/` (incl. the new Task primer), `docs/plan/{STATUS_BOARD,EFFORT_BENCHMARK,KIT_ADOPTION}.md`, roadmap pointer | ✅ |
| Scope | `Makefile` (`worktree`, `gitai-worktree`), `scripts/{worktree.mk,it-postgres.sh,it-db.sh}`, root `test` / `typecheck` / `check` scripts | ✅ |
| Quality | `npm run check`: 150/150 tests, both type checks, web lint, `drizzle-kit check`, web build | ✅ author sandbox and Codex review |
| Integration | `scripts/it-db.sh` with `verify:task5-schema` (author + Codex), `verify:task5-graph-live` and `verify:task6-route-live` (author only) | 🟡 agent-verified |
| Review | Codex cross-review: fix first, six findings, all fixed in the second commit | ✅ fixes committed; re-review pending |

## Implemented interfaces
```text
npm test | npm run typecheck | npm run lint | npm run check
scripts/it-db.sh <command>                 # throwaway PostgreSQL 16 + pgvector, migrations applied
make worktree M=<name>                     # ~/AIProjects/TrackAI-wt/<name> on task/<name>
make gitai-worktree M=<name>               # ~/AIProjects/TrackAI-wt/<name>-gitai in ~/AIProjects/git-ai
```

## Deviations from the kit
- Two repositories; GitAI worktrees share the TrackAI worktree root with a `-gitai` suffix.
- Added `docs/templates/TASK_PRIMER_TEMPLATE.md` and AGENTS.md §12.8 (Task primer, agent choice, Codex as lead): founder requests, candidates for the next kit version.
- Existing trackers keep their four-symbol legend; new documents use the kit's three.
- `CROSS_REVIEW_PROMPT.md` records a one-time bootstrap exception for this review.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Project slots in AGENTS.md (§2, §4, §9, §10) are drafts; Codex corrected them once, stage 2's project map refines them | Agents may still meet an ownership question; ask the orchestrator |
| 🟡 | No linter for `apps/api` | Lint gate covers the web app only |

## Integration test impact
> **FOUNDER:** non-blocking for this PR. Prerequisites: Docker. Expected: `schema_verification=passed`.
> ```bash
> cd ~/AIProjects/TrackAI-v1 && scripts/it-db.sh npm run verify:task5-schema -w apps/api
> ```

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.06× | about 0.06× | ~70 turns + one Codex review round | ~2.5 h | not measured |
