# Handoff prompt: Task20e-endpoint-shipper (tail Numbat's records, minimize, queue, upload v2), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only` (GitAI `main` must contain Task20b's `packaging/numbat/`).
> 2. **Codex:** start a new thread in **Worktree** mode on the GitAI repository after `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20e-endpoint-shipper`. The worktree is `~/AIProjects/TrackAI-wt/Task20e-endpoint-shipper-gitai`. Paste everything below the line.
> 3. Go 1.26.9 must be installed (from Task20b), for the real-binary integration test.
> 4. Checkpoint: after stage 1 (the design note in §3), Codex sends you a short summary. Paste it to the Task20 lead (Claude) and paste the answer back.
> 5. When it finishes, paste its review request to the **Task20 lead (Claude)**. Push only after "ready to push".

---

You are **Codex**, building **Task20e-endpoint-shipper** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task20 runs **Numbat** unchanged on developer machines. Numbat's hooks append NDJSON records to a file in the developer's profile. The **TrackAI Endpoint** daemon (your code in GitAI) must take them off the machine safely:
- tail the file with a checkpoint;
- keep only the security v2 kinds;
- strip everything the current activation lease's data settings do not allow;
- swap host and user identity for nothing (the server knows the machine from the credential);
- map the project to an enrolled repository or `not_enrolled`;
- queue durably;
- upload to `POST /worker/security/v2/records`.

You also **retire Task6.a's Rust evaluator** and its three rules.

Out of scope for this session:
- verifying or applying leases and bundles (Task20g); this session reads the current lease through an interface;
- installing Numbat or its hooks (Task20h);
- running `numbat scan` or `numbat agents` (Task20h); you write their projections only;
- any TrackAI server change.

- **Repository:** GitAI fork. **Worktree:** `~/AIProjects/TrackAI-wt/Task20e-endpoint-shipper-gitai`, branch `task/Task20e-endpoint-shipper-gitai`.
- **Handoff:** returned in your final reply; the Task20 lead copies it into TrackAI.
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. Read TrackAI's `AGENTS.md` (`git -C ~/AIProjects/TrackAI-v1 show main:AGENTS.md`) in full, especially §1 rules 6, 7 and 9; §2 "Names"; §5a (third-party sources); §9 items 6, 7, 9 and 14; §12. Then read GitAI's `AGENTS.md` and `Taskfile.yml`.
2. Check location, branch and identity. If the branch is detached or `codex/...`, run `git switch -c task/Task20e-endpoint-shipper-gitai`. Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only.
3. Baseline: `task build`, then `cargo test --lib security` once.
4. Estimate: one line against T6. The plan says **about 0.32×**. If it looks over 0.4×, propose a split at the checkpoint (read side, then send side) instead of growing.

## 1. Read before writing
- **TrackAI, read-only, from `main`:**
  - the frozen contract `docs/contracts/security-v2/` (README, `api.md`, `errors.md`, the schemas, `fixtures/`);
  - `docs/plan/TASK20.md` §1, §3, §5;
  - the primer's facts 1, 3, 5, 6, 7 and 8 (`docs/plan/primers/Task20_PRIMER.md`);
  - Task20d's server behaviour: `apps/api/src/features/security-findings/v2.routes.ts`, `v2-storage.ts`, and `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md`.
- **Numbat, read-only, at `~/AIProjects/numbat` (`20a5a52`):**
  - `docs/cli.md:274-324` (the record stream) and `:481-560` (`ship`: checkpoint after acknowledgement, at-least-once, rotation; the behaviour contract you rewrite);
  - `docs/live-capture.md:105-150` (output files; Numbat does not rotate them);
  - `docs/schema/v0.5.0/`;
  - `cmd/numbat/ship*.go` (how `ship` keeps its state across rotation);
  - where `project_path_hash` is computed (find it in `internal/` and cite it).
- **GitAI:**
  - `src/security/{mod,activation,delivery,delivery_queue}.rs`;
  - `src/daemon/telemetry_worker.rs`, and `src/daemon.rs` around the security calls;
  - `src/commands/checkpoint_agent/orchestrator.rs:460`;
  - `src/metrics/delivery.rs` (Task4 credential and binding);
  - `packaging/numbat/` (Task20b).

## 2. Scope (approved by the founder)
### 2.1 Decisions
1. **Input file.** The path is configurable, defaulting to `$HOME/.numbat/records.ndjson`, the default when hooks emit events (`numbat@20a5a52:docs/live-capture.md:107-110`). Task20h fixes the installed path.
   - Read with no-follow semantics (refuse a symlink).
   - Never write to the file except for item 3's rename.
2. **Tailing and checkpoint.**
   - **Where it lives:** a small state record in the daemon's existing SQLite database, holding device and inode, byte offset, and the length of a held partial line.
   - **When it advances:** only after the records up to that point are **queued**, not uploaded (the queue is the durable step).
   - **Truncation and replacement:** truncation or a new inode resets the offset to 0 for the new file.
   - **Partial lines** wait for their newline; a line over 4 MiB is skipped with a counter.
   - **Polling:** every 2 seconds in the telemetry worker. Nothing runs on the agent's hook path (AGENTS.md §9 item 7).
3. **Rotation and retention (Q7).**
   - When the file passes 64 MiB, or at the first poll after local midnight, rename it to `records.ndjson.<UTC date>.<n>`. Rename only after the checkpoint has reached its end.
   - Hooks open the file per invocation with `O_APPEND`, so a rename is safe (`numbat@20a5a52:internal/output/filesink_nofollow.go:18-25`).
   - Delete rotated files older than 7 days.
   - Never rotate a file you have not finished reading.
4. **Parsing.**
   - Accept only lines whose `schema_version` is `0.5.0`. Any other version is counted per version and skipped.
   - `record_type` maps to the contract kinds as follows:
     - `finding` → `finding`;
     - `enforcement` → `enforcement`;
     - `indicator` → `indicator`;
     - `scan_summary` → `scan_summary`;
     - `event` with `event_type` `permission.requested`, `.approved` or `.denied` → `permission_event`.
   - Every other event is dropped **before** anything is stored.
   - `diagnostic` lines are counted, never uploaded.
5. **Projection.**
   - Build each kind exactly as the contract README "Record decisions and field provenance" says.
   - Compute `record_id` with the exact preimage `trackai.security-record/2 NUL kind NUL source-key…`, lowercase SHA-256, `sha256:` prefix.
   - Map enforcement `finding_ids` to the findings' `record_id`s.
   - Set `join` for permission events:
     - `exact` only when a finding or enforcement in the same session carries the same `tool_call_id`;
     - `same_session_window` when only the session matches within the previous 5 minutes;
     - `unavailable` otherwise.
   - Write projection functions for `security_status` and `agent_inventory` too (Task20h calls them).
   - Test every projection against the contract's JSON Schemas, copied into `tests/fixtures/security_v2/` with their source commit recorded.
6. **Lease context (interface; Task20g implements it).**
   ```rust
   pub trait SecurityLeaseContext: Send + Sync {
       fn current(&self) -> Option<LeaseSnapshot>; // lease_id, bundle_digest, issued_at, expires_at, data_settings
       fn issued(&self, lease_id: &str) -> Option<LeaseSnapshot>;
   }
   pub struct UnavailableLeaseContext; // always None
   ```
   - **No current lease:** records are read, counted, and **dropped without queueing**. The checkpoint still advances. This is the off state (AGENTS.md §9 item 9). Production uses `UnavailableLeaseContext` until Task20g.
   - **Lease stamping:** each finding gets the `lease_id` and `bundle_digest` of the lease current at its `detected_at`.
7. **Minimization.**
   - Optional fields (`observed_command`, `observed_file_path`, `observed_url`, `endpoint.hostname`, `endpoint.username`) are copied only when the lease's data settings allow them.
   - Indicators are queued only when `urls` is on.
   - Fields the contract never allows are never read into the projection: `tool_input`, `tool_result`, `content`, `evidence_refs`, `project_path*`, `uid`, `device_id`.
8. **Repository mapping.**
   - Compute Numbat's `project_path_hash` (same algorithm, cited) for each repository root the Endpoint already knows with an active Task4 binding (its repository id).
   - On a match: `{kind: "enrolled", id}`. Otherwise: `{kind: "not_enrolled"}`.
   - The hash itself never leaves the machine.
9. **Queue.** Generalize `delivery_queue.rs` to v2 records, one row per record:
   - `kind`, `record_id`, the projection JSON, `lease_id`, and the enqueue-time Task4 delivery binding;
   - the existing retry and backoff behaviour.

   Queued Task6.a rows are dropped once at upgrade, with a counted log line. They were monitor-only, and the route that would accept them is being retired.
10. **Upload.**
    - **Request:** `POST /worker/security/v2/records`, at most 500 records and under 4 MiB per batch, with the existing machine credential. No Numbat HTTP secrets are ever used.
    - **Results:**
      - `accepted` or `duplicate`: delete the row;
      - `rejected` with `SECURITY_V2_FIELD_NOT_PERMITTED`: project the record again under the **current** lease's settings (drop the now-disallowed optional fields; drop indicators if `urls` is off) and resend with the same `record_id`;
      - `SECURITY_V2_LEASE_MISMATCH`, `_RECORD_CONFLICT`, `_INVALID_BODY` or `_UNKNOWN_FIELD`: a terminal drop, with a counter per code;
      - whole-request `SECURITY_V2_LEASE_REQUIRED` or 5xx: retry with backoff;
      - 429: retry after `Retry-After`.
    - **Logging:** never log a record, value or id; counts and codes only.
11. **Retire Task6.a.** Remove:
    - `evaluate_command` and the three `trackai.exec.*` rules from `src/security/mod.rs`;
    - the `submit_activated_command` call in `orchestrator.rs`;
    - Task6.a's repository-bound activation refresh and the `/worker/security/findings` upload path.

    Keep what the shipper reuses. `activation.rs` shrinks to the lease-context interface. Every remaining test still passes, and removed tests are listed in the handoff.

### 2.2 Port from
- Numbat `ship` (`numbat@20a5a52:docs/cli.md:481-560`, `cmd/numbat/ship*.go`), Apache-2.0: rewrite its checkpoint and rotation **behaviour** in Rust; copy no code. Record "behaviour from perplexityai/numbat@20a5a52 ship" in the module header.
- Copied contract schemas and Numbat test records in `tests/fixtures/` carry a `NOTICE.md` (source, commit, Apache-2.0).
- SushiCorp: none (no endpoint shipper).

### 2.3 Pre-approved files
- `src/security/**`: new tail, records, project and minimize modules; `delivery.rs` and `delivery_queue.rs` generalized; `mod.rs` and `activation.rs` reduced.
- `src/daemon.rs` and `src/daemon/telemetry_worker.rs`: wiring only.
- `src/commands/checkpoint_agent/orchestrator.rs`: removal only.
- Tests under `tests/` and `tests/fixtures/security_v2/`.
- `Cargo.toml` and `Cargo.lock`: no new crate unless needed for NDJSON tailing; ask at the checkpoint first.

### 2.4 Never touch
- `src/fleet/**`, `src/trust/**` (Task20c, in flight), `packaging/**`, `mdm/**`, workflows, TrackAI, the Numbat checkout. Stop and describe it if needed.

## 3. Working rules
- **Stage 1: design note**, in the handoff draft, sent at the checkpoint. It covers:
  - the state record;
  - the rotation and inode rules;
  - the queue migration;
  - the join window;
  - the repository-hash citation;
  - what you remove.
- **Stages 2 onward:** read side → projection and minimization → queue and upload → retirement → tests. Commit `Task20e: …` at each stage.
- **Unit tests** cover:
  - every projection against the copied schemas, for every valid and invalid contract fixture;
  - truncation, inode change, partial lines, an oversized line, restart mid-file, and rotation;
  - lease absent (nothing queued);
  - each data-settings switch;
  - the result handling for each code;
  - no forbidden field ever reaching the queue (scan the stored JSON).
- **IT-T20e-01** (blocking for this merge):
  - build Numbat with `packaging/numbat/build.sh`;
  - drive `numbat hook PreToolUse --agent claude` with Task20b's two fixtures, writing to a temporary records file;
  - run the shipper against a **local receiver** that validates every body against the contract schemas and answers per `api.md`;
  - prove restart and rotation lose nothing and duplicate nothing.

  Use an isolated `HOME`, never the developer's daemon or database (AGENTS.md §9 item 6). The run against the real Task20d route is IT-M20-02, at Task20h.
- **Gates:** `task test` for the security modules, `task lint`, `task fmt`. Inherited `daemon_mode` flakiness and Clippy noise go in the handoff.
- **Independent review:** `/review` or a fresh thread, before the final reply.

## 4. Close-out
- **Final reply** in the AGENTS.md §12.4 shape: effort against 0.32×; the handoff text (under 90 lines, from TrackAI's `docs/templates/HANDOFF_TEMPLATE.md`); then one numbered bash block:
  1. the unit tests;
  2. IT-T20e-01;
  3. under `# after the cross-agent review`:
     - `git push -u origin task/Task20e-endpoint-shipper-gitai`;
     - `gh pr create --base main --head task/Task20e-endpoint-shipper-gitai --title "[Task20e] Endpoint shipper" --body "<handoff>" --repo mahamannu-ux/git-ai`;
     - a trial merge of `origin/main`;
     - `gh pr merge … --merge`.

  Then the review request for the Task20 lead in a `text` block.
- Clean tree. Do not push, open a PR or merge.

## Lessons so far
- **Task20a (Codex):** the contract freezes the projection; when in doubt, the README's field table decides.
- **Task20d (Muse):** the server refuses any field the settings do not allow, and a foreign or out-of-window lease is a per-record `LEASE_MISMATCH`. Your re-projection rule exists for that.
- **Task9c/9d (Codex):** keep the delivery binding captured at enqueue time; never re-derive it at upload.
