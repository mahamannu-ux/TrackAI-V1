# Handoff prompt: Task9-lead (MDM and managed developer fleet), Codex as lead

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. **Codex:** new thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`); paste everything below the line.
> 3. Checkpoints: Codex stops after the primer (checkpoint 1: mark every row keep / simplify / defer / reorder and answer its questions) and after the session plan (checkpoint 2: go-ahead). Then it asks for one Codex thread per session and writes Muse prompts when you ask "prompt for <name>".
> 4. Reviews: Codex reviews Muse's branches; Muse (or the orchestrator, if Claude is available) reviews Codex's. Push only after "ready to push".
> 5. Task13 may run in parallel in another Codex thread only if you agree and the two leads name no shared files (see §2.4).

---

You are **Codex**, **leading Task9 end to end** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Task9 lets an enterprise administrator deploy, configure, inventory, update and revoke TrackAI's GitAI client across managed macOS, Windows and Linux developer machines, managed from the TrackAI server. You built Task2–Task6 and know both repos.

- **Repos:** TrackAI `~/AIProjects/TrackAI-v1` and GitAI fork `~/AIProjects/git-ai` (both `main`, both read-only checkouts). **Worktrees:** under `~/AIProjects/TrackAI-wt/` (`make worktree M=<name>`, `make gitai-worktree M=<name>`).
- **Planning branch:** `docs/Task9-plan`. **Tracker (new):** `docs/plan/TASK9.md`. **Primer:** `docs/plan/primers/Task9_PRIMER.md`.

## 0. How you work
Follow **`docs/agents/TASK_LEAD_PROCEDURE.md`** phase by phase (primer and sub-task graph → checkpoint → tracker and session plan → checkpoint → sessions with Muse hand-offs → reviews → Task close). Read `AGENTS.md` in full first, especially §1, §4, §9, §12.4, §12.8.

## 1. Read before planning
- `ROUGH_ROADMAP.md` Task9 row and workstreams **T9.1–T9.10**, the "Task8 and Task9 identity boundary" section, and the dependency graph.
- `TASK4.md` (machine enrollment, `trk_v1` credentials, repository grants and policy files, offline queue, delivery health) and `docs/handoffs/TASK4_TO_TASK5.md`.
- `TASK14.md` T14.3 (endpoint secret-store contract) and T14.7 (signed artifacts); `prod-checklist-for-dummies.md` on signed installers.
- `docs/handoffs/TASK6_TO_TASK13_TASK14.md` and `TASK6_SECURITY.md` D6.1/D6.2 (activation must become signed and machine-bound; platforms beyond macOS).
- `docs/plan/GITAI_FUTURE_TODO.md` (G1 plain-JSON keyring, G2 unsigned lease, G3, G6) and `docs/plan/BUG_BACKLOG.md` (B9 legacy token).
- GitAI: `install.sh`, `install.ps1`, `packaging/`, `.github/workflows/release.yml` (Apple signing and notarization exist), `src/mdm/` (agent hook installers, despite the name), `src/metrics/delivery.rs` (policy and keyring files), `src/commands/upgrade.rs`, `src/config.rs`.

## 2. Scope and boundaries (approved by the founder)
### 2.1 Decisions already made
1. The primer covers all ten workstreams; the founder decides what is kept at checkpoint 1. Expect platform-native mechanisms first (macOS pkg + configuration profile, Windows MSI + registry/Intune, Linux packages + a config file), driven by vendor MDMs (Jamf, Intune, Kandji, etc.) rather than TrackAI becoming an MDM.
2. The server stays authoritative: managed configuration is something a device fetches with its machine credential and the server re-checks; nothing a device reports grants access by itself (roadmap "Task8 and Task9 identity boundary").
3. **Signing and keys are not Task9's to invent.** Package code signing uses the platforms' own schemes (Apple Developer ID, Windows Authenticode, Linux repository signing). Signed configuration/policy bundles, signed activation leases and the key hierarchy behind them belong to **Task15 Attesta** (the shared trust layer). Task9 leaves a typed seam (for example "verify bundle" behind an interface) and records the dependency.
4. Policy provisioning (T9.4) delivers what exists today (Task4 repository policy, Task6 monitor activation); Task6.b's policy engine is deferred, so do not design its format.
5. Secret storage on devices (T9.8): use the OS keychains (Keychain, DPAPI/Credential Manager, libsecret), following Task14 T14.3's contract; this closes GITAI_FUTURE_TODO G1.
6. Real-device verification is founder-live: say exactly which machines and MDM test accounts each gate needs, and ask the founder which he has before planning gates around them.

### 2.2 Port from
None catalogued: SushiCorp has no fleet or MDM component (`docs/plan/REUSE_MAP.md`). Record "none, because SushiCorp has no endpoint fleet" in the primer. Reuse inside TrackAI instead: Task4 enrollment, credentials, grants, delivery health and audit.

### 2.3 Pre-approved for the planning branch
`docs/plan/primers/Task9_PRIMER.md`, `docs/plan/TASK9.md`, `docs/plan/STATUS_BOARD.md`, `docs/plan/BUG_BACKLOG.md`, `docs/plan/GITAI_FUTURE_TODO.md`, `docs/handoffs/Task9-plan_HANDOFF.md`, `docs/prompts/Task9/NEXT_CHAT_Task9*_PROMPT.md`, the Task9 row of `ROUGH_ROADMAP.md`. Code files are pre-approved per session in each session's prompt.

### 2.4 Never touch
`docs/contracts/`, merged migrations, Task5/Task6 code, `AGENT_COVERAGE.md` and Task13's sessions' files. **Shared with Task13:** GitAI `src/mdm/` (agent hook installers), `src/config.rs`, `install.sh` / `install.ps1`, the GitAI daemon startup. If both Tasks need one of these at the same time, stop and ask the founder which Task goes first.

## 3. Estimate
The roadmap gives no size. Give the whole-Task estimate against T6 in the primer (expect well above 1.0×; split accordingly) and one line per session.

## 4. Lessons so far
- **adopt-agent-kit, stage2-project-map (Claude):** facts written without the code's author took several review rounds; state facts from the code and cite `file:line`.
- **Task2–Task6 (Codex):** keep your wave and evidence discipline, but inside short named sessions, each with its own handoff and estimate.
