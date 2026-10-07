# agent-kit adoption record

Adopted **agent-kit 0.1.0** (`~/dev/agent-kit` @ `a4e0b51`) on 2026-10-07, in PR `docs/adopt-agent-kit`. Founder-approved decisions from the orchestrator chat, recorded here so later chats need not ask again.

## Inventory (before adoption)
- **Agents:** Codex alone ran Task2–Task6.a, each Task as one long thread in a `~/Documents/Codex/<date>/<task>` folder with its own clones of TrackAI and GitAI. Those folders stay untouched; no new ones.
- **Repos:** TrackAI (`mahamannu-ux/TrackAI-V1`) and the GitAI fork (`mahamannu-ux/git-ai`, forked from `git-ai-project/git-ai` in July 2026, never synced downstream since).
- **Plan:** `ROUGH_ROADMAP.md` (portfolio) plus one tracker per Task with waves, subtasks (`T5.3`, `S6.4`), evidence gates (`E6-*`) and a four-symbol legend.
- **Gates that passed on `main` @ `336b337` (agent sandbox):** `npm test -w apps/api` 150/150; both type checks; `next lint`; `drizzle-kit check`; web build; `verify:task5-schema`, `verify:task5-graph-live`, `verify:task6-route-live` on throwaway databases.
- **Hazards:** fixed database ports in runbooks (55432, 54321); similarly named checkouts; GitAI review base confusion; no linter on the API.

## Decisions
1. Work root `~/AIProjects`; worktrees `~/AIProjects/TrackAI-wt/<name>` (GitAI `<name>-gitai`); branches `task/<name>`; bundles `~/AIProjects/_bundles`; `make worktree` / `make gitai-worktree`.
2. Existing root documents stay; new ones under `docs/{plan,prompts,agents,templates,founder}`.
3. `ROUGH_ROADMAP.md` stays the portfolio index; kit tables in `docs/plan/STATUS_BOARD.md`; new docs use the kit's three symbols.
4. Sessions `Task<N><letter>`; split above about 0.4× T6, at shared-surface boundaries, and always between repos. Task7–Task14 are split one by one when they start.
5. Benchmark T6 = Task6.a ≈ 4× S3 (`docs/plan/EFFORT_BENCHMARK.md`).
6. Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run check`; integration through `scripts/it-db.sh`; GitAI `task test|build|lint|fmt`.
7. Codex: project `~/AIProjects/TrackAI-v1`, worktree root `~/AIProjects/TrackAI-wt` (set 2026-10-07); prompts also tell Codex to check `pwd` and rename a detached or `codex/…` start to `task/<name>`.
8. Muse: OpenCode started inside a `make worktree` worktree, permission prompts on, every decision upfront.
9. This chat is TrackAI-Orchestrator (planning and manager); it restarts from `docs/agents/MANAGER_PROMPT.md`. FounderQA is the founder's own separate chat.
10. Review pairing: Codex or Muse review Claude; the orchestrator reviews Codex and Muse; a Codex lead reviews the Muse pieces it hands out.
11. Reuse first (AGENTS.md §5a) from `~/dev/sushicorp`.
12. Codex may lead a Task and hand bounded pieces to Muse when Claude is unavailable (AGENTS.md §12.8).
13. Every Task starts with a plain-language Task primer the founder marks up (AGENTS.md §12.8).
14. Agent choice: Muse by default for bounded, decided work; Codex for evidence-heavy back-and-forth; Claude for design, UI/UX, security-critical and integration work.

## Open follow-ups (not in this PR)
- ~~GitAI main checkout re-pointed at the fork~~ (2026-10-07): `main` = `origin/main` = `d26da8e` (fork), `upstream/main` at `6ab2adb` kept for the later sync.
- GitAI downstream sync from upstream (or cherry-picks): a future Task; size it after a diff of fork vs upstream.
- Numbat: pinned at `f0778c09`; per `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` no Numbat code or YAML was copied (three rules re-implemented in GitAI from the reviewed behaviour). Re-pinning is a Task6 follow-up.
- A linter for `apps/api` (new dev dependency; needs the founder's yes).
- Moving the root `TASK*.md` trackers into `docs/plan/` with links fixed (housekeeping candidate).
