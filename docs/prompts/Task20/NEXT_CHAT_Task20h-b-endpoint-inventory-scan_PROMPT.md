# Handoff prompt: Task20h-b-endpoint-inventory-scan (agent inventory S19, day-one scan S20), Copilot

> **Founder setup (Copilot: skip to "You are…"):**
> 1. Merge this prompt's docs PR. `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20h-b-endpoint-inventory-scan`, open `~/AIProjects/TrackAI-wt/Task20h-b-endpoint-inventory-scan-gitai` in VS Code with Copilot (agent mode), paste everything below the line.
> 3. Task20h-a is merged (GitAI PR #11). Paste the review request to the **Task20 lead (Claude)**; push only after "ready to push".

---

You are **GitHub Copilot**, building **Task20h-b-endpoint-inventory-scan** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

The Endpoint (everything TrackAI installs on a developer machine; its code is in this GitAI repository) now installs Numbat with managed hooks, applies signed rule bundles and uploads findings and a health status (Task20e, Task20g, Task20h-a). This session adds two small uploads the server already stores (Task20d) and the contract already defines (`docs/contracts/security-v2/` in TrackAI): the **agent inventory** (S19: which AI agents are on this machine) and the **day-one scan** (S20: findings from agent sessions that happened before TrackAI arrived, opt-in per tenant).

- **Repository:** GitAI fork. **Worktree:** `~/AIProjects/TrackAI-wt/Task20h-b-endpoint-inventory-scan-gitai`, branch `task/Task20h-b-endpoint-inventory-scan-gitai`.
- **Handoff:** returned in your final reply (the Task20 lead copies it into TrackAI). **Estimate:** about 0.10× T6 (T6 = all of Task6.a).
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. `pwd && git branch --show-current`, and confirm `git log --oneline -1 origin/main` contains Task20h-a (merge of PR #11). You build on its `NUMBAT_ADMIN_BINARY`, `MANAGED_AGENT_MAP`, `SecurityRecordQueue::enqueue_generated` and the security tick in `src/daemon/telemetry_worker.rs`.
2. Read TrackAI's `AGENTS.md` (§1 rules 6, 7, 9; §2 "Names"; §9 items 7 and 11) and `docs/plan/TASK20.md` (T20.12, T20.13), at `~/AIProjects/TrackAI-v1`.
3. Read in TrackAI `docs/contracts/security-v2/`: `security-upload-v2.schema.json` (`agentInventory`, `agentInventoryRow`, `scanSummary`, `finding.found_at_rest`), the fixtures `valid-agent-inventory.json`, `invalid-agent-inventory-content-preview.json`, `valid-scan-summary.json`, `invalid-scan-summary-project-path.json`, and `security-activation-lease-v2.schema.json` (`day_one_scan`).
4. In GitAI: `src/security/records.rs` (`project_agent_inventory`, `project_numbat_record` with `found_at_rest`, `project_scan_summary`, `minimize_queued`), `src/security/health.rs` (the pattern to copy: build, project, `enqueue_generated`), `src/security/policy_apply.rs` (`ensure_placeholder_current`, how `rules/current` names the applied bundle; bundles are **compact**: they ship only rules that differ from upstream and rely on Numbat's built-in catalogue, so never pass `--no-builtin-rules`), `packaging/macos/TASK20H_A_HANDOFF.md`, `src/security/activation.rs` (`lease_at`).
5. Numbat at the pin (`~/AIProjects/numbat`, read-only, `20a5a52`): `docs/cli.md` "agents" and "scan", `cmd/numbat/agents.go` (the JSON row type, about lines 385-410), `cmd/numbat/scan.go` (every scan ends with one `scan_summary` record). Cite `numbat@20a5a52:path:line` for every Numbat fact you rely on.

## 1. Decisions (made by the Task20 lead; the founder's rule: keep it simple, defer what gets stuck)
1. **Only under an active monitor lease.** Both uploads run only when `lease_at(now)` is `Some` (monitor, not expired). Off or expired: nothing runs and nothing is queued (`trust.md` "Consumers": off means nothing uploaded).
2. **Inventory (S19).**
   - Run `"$NUMBAT_ADMIN_BINARY" agents --all --format json` once after the first active lease, then once every 24 hours (an in-memory "last run" like `health.rs`, plus a small durable timestamp file under the security state folder so a restart does not re-send at once).
   - Map each Numbat row to the contract's `agentInventoryRow` in **one table in code**: `agent` (Numbat's agent name mapped through `MANAGED_AGENT_MAP` to the bundle's source-agent name where one exists, else Numbat's name), `config`, `artifacts`, `wired` from Numbat's fields, every value Numbat does not give or you cannot map → `"unavailable"`, never a guess.
   - `version` is always `null`: Numbat's `agents` output has no version field (check `agents.go`; if it does have one, use it). Say so in the handoff; do not build version detection.
   - Never copy `setup_hint` or any path: the contract forbids it (`additionalProperties: false`), and the invalid fixture proves it.
   - Project with `project_agent_inventory`, queue with `enqueue_generated`.
3. **Day-one scan (S20).**
   - Runs once per machine and tenant, when the active lease has `day_one_scan: true` **and** `rules/current` points at an applied bundle (not `placeholder`). A durable marker `security/day-one-scan-done` (holding tenant id, machine id, bundle digest, time) is written only after every record is queued; with the marker present for this tenant and machine, never run again. Offboarding already removes the security folder, so re-enrolment scans again.
   - One scan per agent in `MANAGED_AGENT_MAP` that Numbat's `scan --agent` accepts: `"$NUMBAT_ADMIN_BINARY" scan --agent <numbat name> --emit findings --rules-dir <security>/rules/current/<source agent> --output file --output-file <security>/scan-tmp/<agent>.ndjson`. Findings only (Q5): no `--emit events` or `indicators`. Default `--content preview`; the projection minimizes under the lease's data settings as for live records.
   - Read each output file, project each `finding` with `found_at_rest = true` and the `scan_summary` with `project_scan_summary`, queue with the existing queue (record ids are deterministic from Numbat's ids, so a retry after a crash does not duplicate), then remove the temp file.
   - Run it off the security tick's critical path: in its own `spawn_blocking`, at most one at a time, with a 15-minute limit per agent; a timeout or non-zero exit queues nothing for that agent and leaves the marker unwritten so it retries next hour. If the lease turns off or expires mid-scan, discard what is not yet queued.
   - If the projection drops every finding (data settings), the scan summary still uploads.
4. **S22 note.** Numbat's inventory has no MCP configuration. Do not add MCP capture; state in the handoff that S22 can be answered only from findings (e.g. `config.mcp` rules) for now.
5. **Not in this session:** version detection, MCP capture, indicators or events from the scan, any server or TrackAI change, enforce mode, Windows.

## 2. Pre-approved files
- new `src/security/inventory.rs` and `src/security/day_one_scan.rs`, `src/security/mod.rs` (two `pub mod` lines), and two calls in the existing security tick in `src/daemon/telemetry_worker.rs`, tests beside the code.
- If you must change `records.rs` or `delivery_queue.rs`, stop and say why at your first checkpoint.
- Never touch `src/trust/**`, `policy_apply.rs`, `health.rs`, `packaging/**`, `mdm/**`, workflows, or any TrackAI file.

## 3. Stages
1. **Checkpoint first (no code):** paste the real `agents --all --format json` output from the pinned binary (any machine; redact your home path), your mapping table, and the exact `scan` command line per agent. Send that to the Task20 lead and wait.
2. Inventory module and tests.
3. Day-one scan module and tests.
4. Wiring, gates, handoff.

## 4. Tests
- Unit: the mapping table on a captured `agents` JSON fixture (put it under `tests/fixtures/numbat/`, with the Apache-2.0 notice from `docs/contracts/security-v2/fixtures/NOTICE.md` if it is copied from Numbat); every projected inventory and scan record validates against the contract schema (reuse `tests/security_v2_schema.rs`); no inventory row carries `setup_hint` or a path; nothing runs under no lease, an off lease or an expired lease; the scan does not run on `placeholder`; the marker stops a second run and is written only after queueing; a failed or timed-out agent leaves the marker unwritten; findings from the scan carry `found_at_rest: true`.
- **IT-T20h-02 (founder, Intel Mac, blocking for the merge):** with a debug PKG built as in `packaging/macos/FOUNDER_WALKTHROUGH.md`, on a disposable account, with monitoring on, check that an `agent_inventory` record reaches TrackAI; then turn the tenant's day-one scan on and see `found_at_rest` findings and one scan summary per scanned agent, and that turning it off and on again does not scan twice. Write the exact commands.

## 5. Close-out
- Gates: `task build`, `cargo test --lib security`, `cargo test --test security_v2_contract`, `cargo fmt --check`, scoped Clippy on your files (`task lint` has 12 inherited warnings on `main`; do not fix them); `git merge origin/main` and rerun right before the review request.
- Final reply in TrackAI's AGENTS.md §12.4 shape: effort, the handoff text (under 60 lines: mapping table, scan command, marker rule, S22 note, version null note, IT commands), one bash block, the review request to the Task20 lead.

## Lessons so far
- **Task20h-a:** a status layer that cannot be checked is `unavailable`, never healthy; the same honesty applies to every inventory value.
- **Primer fact 8:** Copilot CLI denies an action when a hook crashes; this session does not touch hooks or rules, and must not.
- **Task20g:** `rules/current` can point at `placeholder`; check it before trusting it.
- **Task20h-a:** the placeholder disables all 51 built-ins with same-id overrides, and a monitor bundle overrides only what differs; scanning with `--no-builtin-rules` would silently run almost no rules.
