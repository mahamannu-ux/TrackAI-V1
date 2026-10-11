# Next chat prompt — Task9d fleet update, rollback and endpoint cleanup

> Founder setup before starting Muse:
>
> 1. Use the existing GitAI worktree at `/Users/manishmahajan/AIProjects/TrackAI-wt/Task9d-fleet-update-offboard-gitai` only after fast-forwarding its clean branch from the old stop point `cc155d692` to GitAI fork `origin/main` at `c4509ab8d` (PR #5). If it is not clean or cannot fast-forward exactly, stop and report; do not reset, cherry-pick or recreate history yourself.
> 2. Work only in the GitAI fork. Do not edit TrackAI in this session.
> 3. Do not push or open a PR. End with a review request for the Task9 lead (Codex).

You are **Muse**, implementing **Task9d-fleet-update-offboard** in the GitAI fork. Task9a2 and Task9c2 are merged. Build the smallest managed-client lifecycle consumer for the corrected schema-v2 release authorization, plus an explicit, dry-run-first local endpoint cleanup. Keep the existing manual channel-based `git-ai upgrade` behavior separate and unchanged.

## Start gate

Before editing, print and verify:

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
git rev-parse HEAD
git log -1 --oneline
```

Required values:

- root: `/Users/manishmahajan/AIProjects/TrackAI-wt/Task9d-fleet-update-offboard-gitai`
- branch: `task/Task9d-fleet-update-offboard-gitai`
- clean tree
- HEAD: `c4509ab8d32701572e02d1e6c8bba89de1ab3440` or a later founder-confirmed GitAI `main` containing that merge

If any value differs, stop before code. Read `AGENTS.md` in full, then inspect the files named below. Give a one-line estimate before implementation. Operational target: about **0.20x T6**; split only if a real contract or cross-platform conflict appears.

## Frozen inputs

Read these from the TrackAI repository as read-only design inputs:

- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/plan/TASK9.md`
- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/plan/TASK9_LIFECYCLE_CONTRACT_CORRECTION.md`
- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/handoffs/Task9a2-release-contract-correction_HANDOFF.md`

Inspect these merged GitAI inputs:

- Task9b managed packages/login start: merge `90ef13213` and descendants through `3a4dceb39`
- Task9c managed configuration/secrets: merge `cc155d692`
- Task9c2 corrected release state: merge `c4509ab8d`, commits `e56494272` and `9850c32f3`
- `src/fleet/mod.rs`, especially `authorize_desired_release`, `DesiredReleaseAuthorization`, retained active/previous state and `UnavailableVerifier`
- `src/commands/upgrade.rs`
- `src/commands/fleet.rs`
- `src/daemon/telemetry_worker.rs`
- `install.sh`, `install.ps1`
- `mdm/`, `scripts/mdm/` and `packaging/`

The frozen release identity is:

```text
(desiredRelease.version, desiredRelease.releaseTag,
 desiredRelease.manifestUrl, desiredRelease.manifestSha256)
```

`clientCompatibility` decides whether the running client may consume the configuration. It never selects a release. `channel` is rollout/audit metadata and must never select a managed download.

## Required implementation

Use strict TDD and keep the diff small.

### 1. Managed exact-release execution

Add a narrow lifecycle module under `src/fleet/` and minimally wire it to the existing managed refresh/daemon lifecycle.

- Execution starts only with a successful `authorize_desired_release(...)` result for the exact retained configuration ID and epoch.
- Fetch `SHA256SUMS` only from the authorization's exact `manifest_url`.
- Hash the exact downloaded manifest bytes and require equality with `manifest_sha256` before parsing or using it.
- Fetch the platform install script/assets only from `https://github.com/mahamannu-ux/git-ai/releases/download/<releaseTag>/...`; never use `/worker/releases`, a channel endpoint or `/releases/latest/` for managed execution.
- Verify every downloaded executable/script against the pinned manifest before execution. Reuse and generalize existing checksum and installer helpers rather than building a second updater.
- Pass the exact authorized tag to the installer. Do not pass credentials or configuration in arguments, environment variables, files or logs.
- A desired release equal to the running version is a no-op. A different authorized version may move forward or backward; rollback is the same exact-release mechanism applied to the retained N-1 configuration, not a mutable-channel lookup.
- Preserve the durable evidence queue, enqueue-time bindings, user authentication and repository data across update and rollback.
- Stop/restart the daemon using the existing bounded lifecycle. A failed download, digest, install or restart keeps local evidence and authorization state intact, reports a safe failure, and remains retryable.

Do not silently replace the existing interactive/manual `git-ai upgrade` contract. The managed path must be a separate typed entry point that consumes `DesiredReleaseAuthorization`; share lower-level verified-install helpers where that reduces code.

### 2. Production fail-closed boundary

Production still uses `UnavailableVerifier` until Task15 supplies the real verifier.

- With `UnavailableVerifier`, no manifest, installer or binary is downloaded or executed.
- V1, legacy state without exact JSON, missing state, digest mismatch, expiry, compatibility failure, envelope mismatch, verification rejection and verification unavailability all perform zero lifecycle side effects.
- Unit tests may inject deterministic fake verifiers/downloaders/runners. They are engineering evidence only and must not be described as production verification.
- Do not implement Task15 signing, trust, rotation or revocation here.

### 3. Explicit local endpoint cleanup

TrackAI offboarding revokes server authority first and deliberately returns `localCleanup: best_effort_not_requested_by_server`. Therefore:

- Do **not** infer offboarding from a 401, 403, network error, missing configuration or transient service failure.
- Add one explicit, idempotent, dry-run-first local cleanup entry point suitable for Jamf/Intune or a local administrator. Reuse the existing `fleet` command surface rather than adding a new top-level command unless the current dispatch makes that impossible.
- Dry-run prints only bounded safe metadata: planned actions, paths and credential key ID where already non-secret. It performs no mutation.
- Apply requires an explicit flag/confirmation and may remove only the TrackAI machine credential, managed bootstrap/configuration state and login-start registration owned by Task9.
- Preserve the durable evidence queue, authorship notes, repositories, user login credentials and ordinary GitAI data. Do not erase `~/.git-ai` wholesale and do not uninstall the GitAI binary as part of endpoint cleanup.
- Missing items are successful idempotent outcomes. Partial cleanup reports safe per-step results without secrets.
- Keep macOS and Windows per-user semantics. MDM transports the explicit cleanup command/script; MDM state itself is not authority.

If removing login-start registration cannot be done safely from the Rust command without duplicating platform logic, add the smallest bounded uninstall/cleanup wrappers beside the existing `mdm/macos` and `mdm/windows` scripts and test their shared contract. Do not add Linux support.

## Pre-approved files

- `src/fleet/**`
- `src/commands/upgrade.rs`
- `src/commands/fleet.rs`
- the minimal existing command/daemon wiring needed to invoke the managed lifecycle
- `install.sh`, `install.ps1` only for a narrowly required exact-tag/checksum seam
- `mdm/macos/**`, `mdm/windows/**`, `scripts/mdm/**`
- `packaging/**` only for bounded uninstall/cleanup contract support
- focused Rust tests and existing Task9 workflow tests
- `Cargo.toml` / `Cargo.lock` only if unavoidable; prefer existing dependencies

Before touching `.github/workflows/**`, stop and ask the Task9 lead. Hosted platform smoke expansion belongs to Task9f/Task9g unless a tiny change is essential to keep an existing Task9d test runnable.

## Never touch

- TrackAI repository files or contracts
- Task15 implementation
- Task6 policy/security semantics
- credential value formats or secret-store fallbacks
- telemetry queue schema, authorship notes or evidence payload semantics
- unrelated upgrade UX, release-channel selection or background notice behavior
- Linux/nightly/WSL/Windows ARM64 support
- Jamf/Intune vendor APIs, ADE, Autopilot or OOBE
- upstream GitAI code not already in the fork merely because it is newer

## Port from

No external component port. Reuse the fork's existing verified upgrade/install, daemon restart, machine-credential deletion and login-start uninstall behavior. The corrected managed contract is TrackAI-specific and already merged. If any upstream code is copied, pin its commit, preserve Apache-2.0 provenance and explain why reuse was smaller than adapting the fork's current helpers.

## Test-first acceptance cases

At minimum, prove:

1. no authorization means zero network, installer and restart calls;
2. production `UnavailableVerifier` means zero lifecycle side effects;
3. V1 and legacy persisted state cannot execute a release;
4. exact authorized N verifies pinned manifest bytes and exact-tag assets before execution;
5. manifest digest mismatch, missing asset checksum, asset mismatch, wrong tag/URL and download failure fail closed;
6. reassignment to retained N-1 uses N-1's own tuple and can install an older version;
7. failed update/rollback preserves queue/state and is retryable;
8. successful install uses the existing bounded daemon restart behavior without a restart loop;
9. cleanup dry-run mutates nothing;
10. cleanup apply deletes only Task9-owned endpoint state, is idempotent and preserves queue/authorship/user login data;
11. 401/403/unavailable configuration never triggers cleanup;
12. no secret appears in argv, logs, fixtures, snapshots or handoff output.

Prefer dependency-injected, network-free unit tests for the lifecycle state machine and focused script contract tests. Native Jamf/Intune/Windows claims are not part of this session.

## Gates

Run focused tests first, then:

```bash
task fmt
task lint
task test CARGO_TEST_ARGS="--lib"
task test CARGO_TEST_ARGS="--test mdm_scripts"
task test CARGO_TEST_ARGS="--test packaging_contract"
git diff --check c4509ab8d..HEAD
git status --short
```

Run the full `task test` only once after focused gates if practical. On the founder's Intel Mac, do not repeat a long full compile merely for ceremony: report the exact focused/full gates run, inherited Clippy findings separately, and leave native macOS/Windows/MDM lifecycle evidence to Task9f/Task9g. A skipped full suite is not a pass.

Also run a secret-oriented diff search using patterns, never real secret values. Findings that are only prohibitions or synthetic assertions are acceptable when explained.

## Commits and closeout

Use small commits, for example:

1. lifecycle tests and exact-release executor;
2. managed wiring and rollback/restart behavior;
3. dry-run-first endpoint cleanup and script contracts;
4. formatting or handoff-only correction if needed.

Do not push. Finish with:

- branch, exact base `c4509ab8d` and commit list;
- changed files and the precise managed lifecycle/cleanup interfaces;
- focused and full gate results, including counts;
- explicit confirmation that production verification is still unavailable and executed no managed release;
- explicit confirmation that cleanup is locally invoked, never inferred from HTTP/auth failures;
- native platform/MDM gates deferred to Task9f/Task9g;
- actual effort versus the about `0.20x T6` target;
- a concise review request for the **Task9 lead (Codex)** ending in: `No push or PR yet; reply ready to push or list fixes.`
