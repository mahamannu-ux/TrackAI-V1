# Leading a whole Task (Codex as lead, Muse as helper)

How an agent, normally **Codex**, takes one roadmap Task from nothing to merged, end to end, under `AGENTS.md`, handing bounded pieces to **Muse**. It is used when the founder starts a Task directly with Codex (AGENTS.md §12.8). TrackAI-Orchestrator (Claude) follows the same procedure when it leads; when it is available it also reviews, but nothing here waits for it.

The Task's own prompt (`docs/prompts/NEXT_CHAT_<TaskN>-lead_PROMPT.md`) says what the Task is and what it must not touch; this file says how to run it. The lead works in **phases with founder checkpoints**: stop at each checkpoint and wait.

---

## Phase 0. Set up (one planning worktree)
1. Read `AGENTS.md` in full, `docs/plan/PROJECT_MAP.md`, `docs/plan/STATUS_BOARD.md`, `docs/plan/BUG_BACKLOG.md`, `docs/plan/GITAI_FUTURE_TODO.md`, `docs/plan/REUSE_MAP.md`, the Task's row and workstreams in `ROUGH_ROADMAP.md`, its tracker if one exists, and every handoff the prompt names.
2. Your thread runs in a worktree under `~/AIProjects/TrackAI-wt/` (check `pwd`; stop if not). Name the planning branch `docs/<TaskN>-plan` (`git switch -c docs/<TaskN>-plan` if you started detached or on `codex/…`). Identity `mahamannu-ux <mahamannu@gmail.com>`, per worktree.
3. Baseline: `npm ci && npm test` in TrackAI; in GitAI, read its `AGENTS.md` and `Taskfile.yml` (do not build yet).
4. One-line message to the founder: what you read, any blocker, and that the primer comes next.

## Phase 1. Primer and sub-task graph → founder checkpoint 1
Write `docs/plan/primers/<TaskN>_PRIMER.md` from `docs/templates/TASK_PRIMER_TEMPLATE.md`:
- plain words, a customer story (the customer is primarily a CISO, then engineering leaders), a "words you will see" table;
- **one row per subtask** (use the roadmap's workstream IDs, `T9.1`, `T9.2`…, splitting any that are too large into `T9.1a`…), each with an example, value, size against T6, the cheaper or deferrable option, and **who does it**: Codex, Muse, or *founder-live* (needs a real machine, account, tenant or browser);
- the **sub-task graph**: a Mermaid `flowchart` with one node per subtask, arrows for "must finish before", and lanes (`subgraph`) for Codex, Muse and founder-live, so it shows what runs in sequence and what in parallel; then two lines naming the critical path and the first things that can start at once;
- what is reused (SushiCorp catalog, other Tasks' code), risks, and the questions only the founder can answer, each with your recommendation.

Commit on `docs/<TaskN>-plan`. **Stop.** Reply with a short summary, the questions, and the primer path. The founder marks each row keep / simplify / defer / reorder and answers the questions (he may ask FounderQA or the orchestrator first).

## Phase 2. Tracker and session plan → founder checkpoint 2
After his marks:
1. Record his decisions in the primer's "Founder decisions" section.
2. Create or update the Task tracker: an existing root tracker stays where it is (`AGENT_COVERAGE.md` for Task13); a new one goes in `docs/plan/<TaskN>.md`, in the style of `TASK6_SECURITY.md` (master matrix, waves with exit gates, evidence gates, completion boundary) and with AGENTS.md §11 symbols.
3. Split the kept subtasks into **sessions** (`<TaskN>a`, `b`, …): at most about 0.4× T6 each; split at a migration + contract + UI boundary; TrackAI and GitAI work in separate sessions; Muse sessions only where every decision can be written down upfront (AGENTS.md §12.8). Give each session an agent, an estimate (apply about 1.3× to your own Muse estimates until there is data), its dependencies and its files.
4. Add the sessions to the remaining-plan table and the Task's row to the status board in `docs/plan/STATUS_BOARD.md`.
5. Write a planning handoff `docs/handoffs/<TaskN>-plan_HANDOFF.md` and end with the §12.4 reply (bash block to push `docs/<TaskN>-plan` and open its PR; a review request). **Stop** for the founder's go-ahead and the review of the plan (§Reviews).

## Phase 3. Execute sessions
For each session, in graph order:
- **Your sessions (Codex):** the founder starts a new Codex thread in Worktree mode for each one, with a short prompt you write as `docs/prompts/NEXT_CHAT_<name>_PROMPT.md` (from `docs/templates/NEXT_CHAT_PROMPT_TEMPLATE.md`). One session per thread, branch `task/<name>` (GitAI: `task/<name>-gitai` in a `make gitai-worktree` worktree). Interfaces first (AGENTS.md §5) when a Muse session depends on them; land those as a small PR before Muse starts.
- **Muse sessions:** when the founder asks ("prompt for <name>"), write `docs/prompts/NEXT_CHAT_<name>_PROMPT.md` from the template with **every decision made**: exact files and functions, data shapes, error codes, test cases, pre-approved files, never-touch list, gates, estimate, the "Port from" section, and the founder setup (`cd ~/AIProjects/TrackAI-v1 && make worktree M=<name> && cd ~/AIProjects/TrackAI-wt/<name> && npm ci && opencode`). Commit it on your current branch and give it to the founder as a **"Paste to Muse:"** block. Answer Muse's questions when the founder relays them.
- **Founder-live steps:** give exact commands in one bash block, safe output only, and what to paste back. Never ask for a secret.
- Parallel work: at most one session per agent at a time, each in its own worktree. Two Codex threads may run only when the founder agrees and their files do not overlap (name the shared files that forbid it).
- Each session closes with its own handoff, status-board row, Effort line and §12.4 reply with a review request.

## Reviews
- **Muse's branches:** you (the lead) review them with `docs/agents/CROSS_REVIEW_PROMPT.md` in a fresh Codex thread (Local mode).
- **Your branches (plan and code):** TrackAI-Orchestrator when the founder has Claude available; otherwise **Muse** reviews them (a review worktree, read-only, `CROSS_REVIEW_PROMPT.md`). The founder pushes only after "ready to push".
- Security-critical changes (credentials, signing, activation, tenant isolation) wait for the orchestrator's review even if Muse said "ready to push"; say so in the review request.

## Phase 4. Close the Task
- Tracker and roadmap row updated (roadmap stays a summary); status board rows and remaining-plan actuals filled; integration test registry rows added.
- A Task handoff `docs/handoffs/<TaskN>_HANDOFF.md`: what shipped, what was deferred (with the trigger to resume), open items, evidence, and the Task's total Effort against its primer estimate.
- New problems found outside the Task go to `docs/plan/BUG_BACKLOG.md` or `docs/plan/GITAI_FUTURE_TODO.md`, not into the Task.
- Lessons rows for each session in `docs/agents/MANAGER_PROMPT.md` (what went well, what needed fixing, what to fold into the next prompt).

## Things the lead never does
Push, merge or open PRs; touch another Task's in-flight files; change `docs/contracts/` or merged migrations; decide a shared surface without the founder; describe monitor-only or unverified routes as protection or support; widen raw-content access; build its own signing or key hierarchy (Task15 Attesta owns the shared trust layer: consume its interface, or leave a typed seam and a backlog row).
