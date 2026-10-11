# Handoff prompt: Task9c2-release-state-correction (verified release authorization state), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge and verify the TrackAI Task9a2 PR first. Merge this prompt's docs PR. Then ensure GitAI fork `main` contains Task9c merge `cc155d692` and create a fresh GitAI worktree from current fork `main`.
> 2. Start a new Codex thread in that GitAI worktree and paste everything below the line.
> 3. Leave `/Users/manishmahajan/AIProjects/TrackAI-wt/Task9d-fleet-update-offboard-gitai` unchanged at `cc155d692`; it is not the Task9c2 worktree.
> 4. When it finishes, paste its review request to TrackAI-Orchestrator. Push only after `ready to push`.

---

You are **Codex**, building **Task9c2-release-state-correction** in the **GitAI fork**. TrackAI Task9a2 has frozen a backward-compatible schema-v2 configuration with separate client compatibility and immutable desired-release identity. Extend only Task9c's parser and verified state so later Task9d can request a reverified release execution authorization. Do not download, install, update, roll back, clean up or offboard anything in this session.

- **Repo:** `~/AIProjects/git-ai` fork `main` (`origin`, never public `upstream`). **Worktree:** `~/AIProjects/TrackAI-wt/Task9c2-release-state-correction-gitai`, branch `task/Task9c2-release-state-correction-gitai`.
- **Handoff:** write the GitAI session handoff in the location established by the repository/Task9 workflow; if GitAI has no TrackAI handoff directory, include the complete handoff in the final checkpoint and update TrackAI only in a later docs closeout—never mix repositories in this implementation PR.
- **Required base:** GitAI fork `main` containing merge `cc155d692`; record the exact TrackAI Task9a2 merge SHA and v2 envelope in the handoff.

## 0. Before anything else

1. Read GitAI `AGENTS.md` in full. Verify `pwd`, Git root, branch, HEAD and clean state; set worktree-local identity `mahamannu-ux <mahamannu@gmail.com>`.
2. Read TrackAI `docs/plan/TASK9_LIFECYCLE_CONTRACT_CORRECTION.md`, Task9a2 handoff and merged TrackAI v2 code. Code wins if prose and merged contract differ; stop rather than reinterpret.
3. Read current `src/fleet/mod.rs` and its tests, `src/metrics/delivery.rs`, `src/daemon/telemetry_worker.rs`, and the Task9c commit range `d8f98e8db..89ffeda50`. Read `src/commands/upgrade.rs`, `install.sh`, `install.ps1` and `.github/workflows/release.yml` read-only to confirm the exact-tag path.
4. Run the smallest existing fleet tests as baseline. Estimate one line against T6; target about **0.10×**, ceiling **0.15×**. Full Cargo tests run once at the stable checkpoint, not after each edit.

## 1. Parser correction

1. Preserve closed schema-v1 parsing and its exact current-client-version compatibility rule.
2. Add a closed schema-v2 variant with:
   - inclusive `clientCompatibility.minimumVersion` and `.maximumVersion`;
   - `desiredRelease.version`, `.releaseTag`, `.manifestUrl`, `.manifestSha256`;
   - unchanged ID/epoch/times/channel/ring/repository policies/security activation/verification.
3. Use real semantic-version comparison; reject invalid or reversed bounds. Compatibility is checked against the running `CARGO_PKG_VERSION` and is independent of `desiredRelease.version`.
4. Revalidate the frozen exact-tag URL locally: HTTPS GitHub, repository `mahamannu-ux/git-ai`, path `/releases/download/<releaseTag>/SHA256SUMS`, tag match, no credentials/query/fragment, encoded separator or traversal. Require 64 lowercase hexadecimal manifest SHA-256.
5. Schema v1 has no desired release and can never produce release execution authorization.

## 2. Verified persistent state and authorization seam

1. Keep the existing active N plus previous N-1 state model and exact retained rollback behavior.
2. Newly verified activations persist the exact UTF-8 configuration JSON together with the parsed envelope and its SHA-256, using the existing atomic/restrictive write. Stay within the existing 256 KiB bound.
3. Read legacy state without exact JSON without destroying its existing policy overlay. Legacy/missing exact bytes produce no release authorization.
4. Add one narrow typed function/method for later Task9d to request a desired-release authorization. It returns release metadata only after rechecking, at request time:
   - exact JSON exists and hashes to the stored digest;
   - closed parsing, time validity, compatibility and bootstrap repository binding still pass;
   - parsed envelope equals the stored envelope;
   - the injected verifier returns `Verified` for the exact bytes;
   - the envelope is schema v2 with a valid desired release.
5. `Rejected`, `Unavailable`, expiry, incompatibility, missing bytes, digest mismatch, parse/envelope mismatch or schema v1 returns a typed denial/no-authorization. It never changes active/previous state.
6. Production continues using `UnavailableVerifier`; therefore production yields no authorization and performs no execution until Task15 lands. Test fakes may prove verified/rejected paths only.

## 3. Scope boundaries

**Port from:** none. Reuse the existing Task9c state machine/verifier seam and the fork's exact-tag release/install contract. Public GitAI is not the source of this correction.

**Pre-approved:** `src/fleet/**` and focused colocated tests; minimal `Cargo.toml`/`Cargo.lock` only if making the already-locked semantic-version crate direct is necessary; minimal compile-only call-site adjustments in `src/metrics/delivery.rs` or telemetry-worker tests caused by the explicit v1/v2 type.

**Never touch:** `src/commands/upgrade.rs`; `install.sh`, `install.ps1`; `packaging/`; `mdm/`; `scripts/mdm/`; `.github/workflows/**`; daemon retry/login-start code; credential-store behavior; TrackAI; Task15 implementation; Task9d's stopped worktree.

If the merged Task9a2 envelope differs from this prompt, stop with the exact mismatch. Do not add download or installer behavior to compensate.

## 4. Tests

TDD must prove:

- existing schema-v1 acceptance/rejections and active policy overlay remain unchanged;
- v2 accepts inclusive compatibility bounds independent from desired release version;
- malformed/reversed semver, mutable/latest/channel URLs, wrong repo/tag, traversal/query/fragment and invalid digest fail before persistence;
- newly verified exact bytes round-trip; tampered bytes/digest/envelope cannot authorize;
- unavailable/rejected verifier, expired/incompatible state, legacy state and schema v1 cannot authorize;
- verified active N authorizes only N; verified retained rollback authorizes its exact N-1 tuple; arbitrary regression still fails;
- all denial paths preserve active/previous state and local work.

Run focused fleet tests, `task fmt`, `task lint`, `task build`, then exactly one full `task test` at the stable checkpoint. Report inherited Clippy/flaky failures separately and retry only the exact affected gate when justified.

## 5. Close-out

- Small TDD commits prefixed `Task9c2-release-state-correction:`; explicit staging; clean tree; no push/PR/merge.
- Final checkpoint names GitAI base/commits, TrackAI Task9a2 merge SHA, exact types/seam, focused/full gates, legacy-state behavior, Task15 blocker and the required Task9d recreation from corrected `main`.
- Final reply uses the established one-bash-block plus one-review-request shape. The review request must explicitly say no downloader, installer or lifecycle execution was added.

## Lessons to carry forward

- Persisted parsed metadata is not enough to re-prove a signature over exact bytes.
- Verification authorizes an exact immutable release tuple, never a channel.
- N and N-1 are complete verified configurations, not names looked up again later.
- Task15 unavailable means no production execution, even when every portable unit test passes.
