# Handoff prompt: Task17b-daemon-reliability (first GitAI integration wave), Codex

> **Founder setup (Codex: skip to “You are…”):**
> 1. Merge the Task17 planning PR containing this prompt, then update the TrackAI and GitAI fork main checkouts. Obtain the Task20 lead Claude's **daemon group accept/change/reject verdict** on the packet in `docs/handoffs/Task17-plan_HANDOFF.md` first; paste that verdict into the new chat. Do not start a code port without it.
> 2. From `~/AIProjects/TrackAI-v1`, run `make gitai-worktree M=Task17-upstream-sync` if the integration worktree does not already exist. Open `~/AIProjects/TrackAI-wt/Task17-upstream-sync-gitai` in a **new Codex chat** and paste everything below this line, followed by Claude's verdict. This is the shared sequential Task17 integration branch `task/Task17-upstream-sync-gitai`; later Task17c, Task17d and Task17f use new chats on this same worktree, one at a time.
> 3. The Task17 lead remains in its current chat. Return Task17b's handoff and review result there before starting the next wave. The founder alone pushes, opens the eventual single fork PR, and merges.

---

You are **Codex**, implementing **Task17b daemon reliability**, the first code wave of TrackAI's selective Git AI upstream sync. Port only the Task20-lead-approved daemon fixes into the GitAI fork, preserving TrackAI's existing Task4/Task20 durability, security and offboarding behavior. This session commits the daemon wave to the shared integration branch; it does **not** open a PR or proceed to telemetry, agent identity, attribution, package or TokenUsage work.

- **Repository:** GitAI fork `mahamannu-ux/git-ai`, never public `git-ai-project/git-ai` for writes.
- **Worktree:** `~/AIProjects/TrackAI-wt/Task17-upstream-sync-gitai`, branch `task/Task17-upstream-sync-gitai`. Do not create another code branch or worktree for this wave.
- **Lead documents (read-only from TrackAI main):** `docs/plan/TASK17.md`, `docs/plan/GITAI_UPSTREAM_LEDGER_2026-10.tsv`, `docs/plan/primers/Task17_PRIMER.md`, `docs/handoffs/Task17-plan_HANDOFF.md`.
- **Handoff:** return a concise wave handoff in the final reply for the founder to relay to the Task17 lead. The lead owns TrackAI tracker and status-board updates.

## 0. Before writing code

1. Read TrackAI `AGENTS.md` in full, especially §1, §3, §5a, §9 items 1, 2, 6, 7, 8, 14 and 22, and §12. Read GitAI `AGENTS.md` and `Taskfile.yml`. Confirm `pwd`, branch, clean status, fork `origin/main`, and Claude's exact daemon group verdict. If the group verdict or planning PR merge is missing, stop before editing.
2. Fetch fork `origin/main` and merge it into the integration branch if it advanced. Never merge `upstream/main`; public upstream is a read-only source of behavior. Record the exact starting fork SHA and source SHAs. Trial conflicts in the Task17 ledger are only a text screen.
3. State an effort estimate against the plan's **0.35× T6**. If the approved daemon set cannot fit about 0.4×, propose a bounded split to the Task17 lead before expanding scope. Run a focused daemon/test baseline before edits. Preserve the repository-pinned Rust toolchain; classify inherited Clippy findings separately.

## 1. Source and approved scope

Read the 44 `daemon-runtime` rows in the Task17 ledger, the Task20 lead's group verdict, and upstream source diffs and tests for the selected fixes. The leading candidates are `c40c82dca` (trace accept loop), `6a7d25a75` (drain self-heal), `648f8e92f` (unused Trace2 frames), `7e8713726` (family side effects), and `2b2920b944` (bounded causal fence). `d119b617f` and `04d87b7cd` are **local-only** daemon-health/status candidates. Adapt behavior to current fork code with upstream SHA provenance; do not cherry-pick the whole series. The Task20 lead may narrow or alter this set in its group verdict, which controls the actual wave.

Do **not** port synthetic reflog/untraced attribution (`33b1c701c` and follow-ups), the rejected lite rewrite series, the heartbeat health upload (`ce5c08ceb`, `8824a16b7`), TokenUsage v2, package code, or the wave 3 telemetry isolation port (`7b0eead75`). The latter is a **shared-worker invariant now** and a later telemetry candidate, not permission to change metric delivery in this wave.

**Pre-approved code areas, only as the approved wave requires:** GitAI `src/daemon.rs`, `src/daemon/**`, Trace2 ingress/normalizer code used by the selected fixes, `src/commands/daemon.rs` for local status shape, and focused tests in `tests/daemon_mode.rs`, `tests/async_mode.rs`, `tests/integration/**` and `tests/mdm_scripts.rs`. Treat `src/security/**`, `src/trust/**`, `packaging/**`, `mdm/**`, `.github/workflows/release.yml` and TrackAI code/contracts as outside this wave. If a necessary fix would change one of those, stop and ask the Task17 lead to obtain the required owner review; do not silently widen the diff.

## 2. Non-negotiable fork behavior

1. Trace2 remains the sole Git observation source. No Git wrapper, per-commit Git spawn, synthetic reflog attribution or unbounded ingestion work. Preserve observed/unknown distinctions and Task2 Generated/Committed meaning.
2. Keep Task4 durable metric delivery and Task20 lease-gated security delivery through offline/restart; do not drop batches under pressure. Preserve fail-closed security behavior.
3. `src/daemon/telemetry_worker.rs` starts `spawn_security_shipper_worker` (`:489` at planning). Its **two-second** tick must keep all six actions: policy refresh, security shipper poll, status queue, inventory queue, security flush, and day-one scan spawn. Keep their order and error isolation. Add a small, deterministic wiring test using injectable/test-only recording as needed; it must fail if any action is omitted. Do not use a real server or a two-second sleep for this test. Wave 3 reruns it.
4. `git-ai bg status --repo /` must retain the exact top-level JSON `"daemon_running": false` after shutdown. Task20h-a `mdm/macos/cleanup-endpoint.sh:100-101` greps that text and refuses to remove security state otherwise. Add a status fixture and an offboarding script **dry run**, plus an apply-path refusal fixture proving absent/true status leaves security state intact. Do not edit the cleanup script to accommodate a status change in this wave.
5. Local health may expose bounded counters without waiting on contended locks, logging secrets or changing fence state. No new health fields in uploaded heartbeats, no new TrackAI telemetry event/contract, and no raw customer content.

## 3. Tests and evidence

- Focused tests for each selected fix: trace accept under a busy worker; stalled drain recovery; unused-frame filtering; family side effects off ingest; causal fence order and grace cap. Record measured latency before/after where feasible, but do not claim the live Intel-Mac p95 gate from a local unit run.
- Security-worker tick wiring, `bg status` exact field, macOS offboarding dry run/refusal, and Task4 restart regression `tests/integration/commit_metric_metadata.rs:211` must pass on the wave branch. Run the affected Task20 security/contract suites and `cargo test --test mdm_scripts` if the status/offboarding fixture changes.
- Run `task build`, `task lint`, `cargo fmt --check`, full `cargo test`, `cargo test --lib security`, `cargo test --lib fleet`, and `cargo test --test security_v2_contract` on the combined branch before handoff if practical; state exact omissions and inherited findings. The Task17f integration chat repeats the entire suite.
- IT-T20e-01 and IT-M20-02 remain live Endpoint-to-server gates. After Task20j's protected week, Task17f reruns E20-01/02/06 and Intel hook latency p95 ≤ 50 ms. No Task17 PKG install on the founder's everyday account during the week; separate-account per-user debug checks require proving the daemon's database first. Do not mark live gates passed without evidence.

## 4. Review and close-out

Commit the bounded wave in small source-attributed commits on the integration branch. Each adopted behavior needs an adoption record for the Task17 lead: source SHA/PR, feature or bug it addresses, fork adaptation, tests, risk, and customer impact. Get an independent code review and the Task20 lead's **shared-code diff review** for daemon/security overlap before calling the wave ready. Do not push, open a PR, merge, install a package, or begin Task17c/d. Return the branch SHA, clean/dirty status, tested commands/results, remaining live gates, adoption records, review verdict, and a concise handoff to the Task17 lead. The next implementation wave begins in a new chat on this same integration worktree only after the lead records this wave's result.
