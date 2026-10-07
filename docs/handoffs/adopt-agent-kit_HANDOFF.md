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
| Review | Codex cross-review: round 1 fix first (six findings, fixed in `8886375`); round 2 fix first (four findings: §4 duplicate table and file-level ownership, draft markers, this handoff, lessons evidence; fixed in `1da5351`); round 3 fix first (two findings: `repository-scope.ts` to Task2, this limitation row; fixed in the fourth commit) | 🟡 round 4 re-review pending |

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
| 🟡 | Project slots in AGENTS.md (§2, §4, §9, §10) are the Codex-confirmed baseline; stage 2's project map may extend them | A file not listed in §4 is decided by its `task<N>-*` prefix, tracker and history; ask the orchestrator if unclear |
| 🟡 | No linter for `apps/api` | Lint gate covers the web app only |

## Test coverage
No product code changed, so no unit tests were added. The new gates were exercised instead: `npm run check` (150/150 API tests, both type checks, web lint, `drizzle-kit check`, web build); `scripts/it-db.sh` in local mode with `verify:task5-schema`, `verify:task5-graph-live` and, with the database name override, `verify:task6-route-live`; `make worktree`, `make gitai-worktree` and their `-rm` targets against scratch repositories. Codex's review re-ran `npm ci`, `npm run check` and `verify:task5-schema`. Not tested: `scripts/it-db.sh` in Docker mode (the agent sandboxes have no Docker); the founder's first run covers it.

## Integration test impact
> **FOUNDER:** non-blocking for this PR. Prerequisites: Docker, or local PostgreSQL 16 binaries with the pgvector extension. Expected: `schema_verification=passed`.
> ```bash
> cd ~/AIProjects/TrackAI-v1 && scripts/it-db.sh npm run verify:task5-schema -w apps/api
> ```

## Integration notes
- Every later session reads `AGENTS.md` first; §4 ownership is by concern and file, and the mixed Task2/Task4 files need prompt pre-approval.
- New npm scripts at the root (`test`, `typecheck`, `check`) wrap the existing workspace commands; CI is unchanged and still runs its own steps.
- `scripts/it-db.sh` sets `TASK5_/TASK6_EPHEMERAL_DATABASE=1` only inside its throwaway run; verifiers that require a specific database name take `IT_PG_DATABASES` / `IT_PG_EXPORTS` (AGENTS.md §6).
- `make gitai-worktree` needs `~/AIProjects/git-ai` on the fork's `main` (done 2026-10-07).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.06× | about 0.07× | ~85 turns + three Codex review rounds | ~2.5 h | not measured |
