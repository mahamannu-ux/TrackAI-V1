# Handoff prompt: Task13-lead (agent and surface coverage), Codex as lead

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. **Codex:** new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`); paste everything below the line.
> 3. Checkpoints: Codex stops after the primer (checkpoint 1: mark every row keep / simplify / defer / reorder and answer its questions) and after the session plan (checkpoint 2: go-ahead). Then it asks for one Codex thread per session and writes Muse prompts when you ask "prompt for <name>".
> 4. Reviews: Codex reviews Muse's branches; Muse (or the orchestrator, if Claude is available) reviews Codex's. Push only after "ready to push".
> 5. Task9 may run in parallel in another Codex thread only if you agree and the two leads name no shared files (see §2.4).

---

You are **Codex**, **leading Task13 end to end** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Task13 extends Task2's attribution to every way an AI agent can change code: every combination of model, IDE, CLI agent, desktop app (Claude desktop, the Codex desktop app), remote/cloud agent and operating system, without confusing model provider, agent family, host surface or capture channel. It also owns closing Task6's D6.2 route/platform gap. You built Task2–Task6 and wrote `AGENT_COVERAGE.md`.

- **Repos:** TrackAI `~/AIProjects/TrackAI-v1` and GitAI fork `~/AIProjects/git-ai` (both `main`, both read-only checkouts). **Worktrees:** under `~/AIProjects/TrackAI-wt/` (`make worktree M=<name>`, `make gitai-worktree M=<name>`).
- **Planning branch:** `docs/Task13-plan`. **Tracker:** `AGENT_COVERAGE.md` (stays at the root; refresh it, BUG_BACKLOG B15). **Primer:** `docs/plan/primers/Task13_PRIMER.md`.

## 0. How you work
Follow **`docs/agents/TASK_LEAD_PROCEDURE.md`** phase by phase (primer and sub-task graph → checkpoint → tracker and session plan → checkpoint → sessions with Muse hand-offs → reviews → Task close). Read `AGENTS.md` in full first, especially §1, §4, §9, §12.4, §12.8.

## 1. Read before planning
- `AGENT_COVERAGE.md` in full (29 routes AC-IDE/CLI/DESK/BG; workstreams **T13.1–T13.10**, only T13.1 implemented; the 13-step route conformance contract).
- `Task2.md` rows **T2.25–T2.29** and evidence gates **E21–E25** (Cursor, Xcode, Codex desktop, Claude Desktop, Windows/WSL/Linux): Task13 implements the routes; Task2's Lifecycle Lab keeps the bridge tests and independent acceptance.
- `docs/handoffs/TASK6_TO_TASK13_TASK14.md` and `TASK6_SECURITY.md` D6.2 (security monitoring beyond OpenCode TUI on macOS).
- `docs/TASK2_EVIDENCE_PROVIDER_BOUNDARY.md`, `TASK5.md` provider expansion notes, `docs/plan/GITAI_FUTURE_TODO.md` (G3, G7) and `docs/plan/BUG_BACKLOG.md` (B1 Churned, owned by Task2, not you).
- GitAI: `src/commands/checkpoint_agent/presets/` (one per agent), `src/mdm/agents/` (hook installers), `agent-support/` (IDE extensions, OpenCode plugin), `src/commands/checkpoint_agent/orchestrator.rs` (security hook is OpenCode-only at line 456), `src/evidence.rs`.

## 2. Scope and boundaries (approved by the founder)
### 2.1 Decisions already made
1. The primer covers all ten workstreams and the routes, ordered by customer value (the customer is primarily a CISO: breadth of honest coverage across vendors is the differentiator). The founder decides keep/defer at checkpoint 1.
2. **T13.2 first:** the normalized host/capture provenance contract (`agentFamily`, `hostSurface`, `hostMode`, `captureChannel`, host identity) is the interface everything else uses; land it as its own small PR before route sessions (AGENTS.md §5). It touches Task2 metric inputs, so Task2's invariants hold and the Lifecycle Lab's scenarios must still pass.
3. **Honest states only:** a route is claimed only after a live run on that host and OS; vendor documentation never substitutes for TrackAI acceptance. Keep installed / wired / observed / complete distinct (T13.10).
4. **T13.9 conformance harness:** one parameterized fixture set run per route and platform. Consider porting SushiCorp's shared contract-suite pattern (catalog SD-1: one `cases.json` driven by several clients) and say in the primer whether it fits.
5. Real hosts and accounts are founder-live: list exactly which apps, accounts and machines each route gate needs, and ask which the founder has before planning around them.
6. Security monitoring for new routes (D6.2) reuses Task6's monitor-only contract unchanged; no blocking, no new rules.

### 2.2 Port from
Candidate: SushiCorp SD-1 (shared contract suite) for T13.9 only; everything else is TrackAI/GitAI-specific. Record the decision and reason in the primer.

### 2.3 Pre-approved for the planning branch
`docs/plan/primers/Task13_PRIMER.md`, `AGENT_COVERAGE.md`, `docs/plan/STATUS_BOARD.md`, `docs/plan/BUG_BACKLOG.md`, `docs/plan/GITAI_FUTURE_TODO.md`, `docs/handoffs/Task13-plan_HANDOFF.md`, `docs/prompts/NEXT_CHAT_Task13*_PROMPT.md`, the Task13 row of `ROUGH_ROADMAP.md`. Code files are pre-approved per session in each session's prompt.

### 2.4 Never touch
`docs/contracts/` (a new route field set is a new contract version, decided at checkpoint 2), merged migrations, Task2 metric semantics without a Lifecycle Lab change, Task9's sessions' files. **Shared with Task9:** GitAI `src/mdm/` (agent hook installers), `src/config.rs`, `install.sh` / `install.ps1`, the GitAI daemon startup. If both Tasks need one of these at the same time, stop and ask the founder which Task goes first.

## 3. Estimate
The roadmap gives no size. Give the whole-Task estimate against T6 in the primer (expect well above 1.0×, mostly founder-live verification) and one line per session.

## 4. Lessons so far
- **adopt-agent-kit, stage2-project-map (Claude):** facts written without the code's author took several review rounds; state facts from the code and cite `file:line`.
- **Task2–Task6 (Codex):** keep your wave and evidence discipline, but inside short named sessions, each with its own handoff and estimate.
