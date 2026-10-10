# Handoff prompt: Task9b-managed-packages (login-start + secret-free PKG/MSI), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this revised prompt. Update both read-only checkouts:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. From TrackAI, create the GitAI worktree: `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task9b-managed-packages && cd ~/AIProjects/TrackAI-wt/Task9b-managed-packages-gitai && opencode`.
> 3. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply `continue` if it stops. No Jamf, Intune, Windows rental, signing certificate or secret is needed now.
> 4. Task9b may run alongside Task9a. Do not start if Task13 or another GitAI session is editing `src/commands/daemon.rs`, `tests/async_mode.rs`, `packaging/`, `mdm/` or the same release-workflow lines.
> 5. When Muse finishes, paste its review request to the Task9 lead Codex thread. Push only after Codex returns `ready to push`.

---

You are **Muse**, building **Task9b-managed-packages** in the **GitAI fork** for TrackAI. Public GitAI added an MDM-oriented per-user login-start kit after TrackAI's imported v1.6.19 snapshot. This session selectively ports the final macOS/Windows behavior and tests, then makes the existing PKG/MSI layer secret-free. It is **not** a bulk upstream sync and it does not add fleet policy/configuration behavior owned by Task9c.

- **Repo:** `~/AIProjects/git-ai` (`main`). **Worktree:** `~/AIProjects/TrackAI-wt/Task9b-managed-packages-gitai`, branch `task/Task9b-managed-packages-gitai`.
- **Planning source, read-only:** TrackAI `docs/plan/TASK9.md`, `docs/plan/primers/Task9_PRIMER.md`, `docs/plan/GITAI_FUTURE_TODO.md`, `docs/plan/GITAI_UPSTREAM_INVENTORY_2026-10-09.md`, and `docs/handoffs/Task9-plan_HANDOFF.md`.
- **Public source, read-only:** `https://github.com/git-ai-project/git-ai`; compared snapshot `0670e7ef27590af0e8ff5409267f3f4b09b8fcb4`.
- **Session handoff:** return the complete GitAI checkpoint in the final reply. Do not add a TrackAI process-only handoff file to the GitAI product repository.

## 0. Before anything else

1. Read GitAI's `AGENTS.md` in full, especially reuse, strict-TDD, cross-platform and human-review rules. Also read TrackAI's read-only `AGENTS.md` §§9, 11, 12.4 and 12.8.
2. Verify `pwd`, Git root, branch and HEAD. You must be in the exact worktree/branch above. Set worktree-local identity to `mahamannu-ux <mahamannu@gmail.com>`.
3. Record the GitAI base SHA. It must be `d26da8ea1b4b734dc2c1bc99759d87c75a187ee3` or a later descendant on fork `main`; otherwise update the read-only checkout and recreate the worktree rather than rebasing hidden work.
4. Run `task test` once as baseline. If the known daemon-mode parallel flake appears, retry only the affected test serially and report both outcomes.
5. Inspect active GitAI worktrees/branches for the file overlap listed in founder setup step 4. Stop on actual overlap.
6. Estimate one line against T6. Operational target is **about 0.20×**, with the already-approved **0.25× ceiling**. If this bounded port cannot fit, finish a coherent tested subset and report the remainder; do not expand into Task9c or Linux.

## 1. Read and compare before editing

Read the fork's current versions and the public snapshot's final versions of:

- `mdm/{README.md,macos/install-login-start.sh,windows/install-login-start.ps1}`;
- `scripts/mdm/test-login-start.{sh,ps1}` and `tests/mdm_scripts.rs`;
- `.github/workflows/{mdm-login-start.yml,release.yml}`;
- `src/commands/daemon.rs` and `tests/async_mode.rs` only for the bounded `bg start --retry-secs` dependency;
- `packaging/README.md`, `packaging/macos/**` and `packaging/windows/**`.

Inspect, at minimum, upstream provenance commits `fb48f9530`, `42fc263c8`, `edbd6d80f`, `566db8d48`, `ad2f9eb46`, `76b30d6a0`, `805bdda44`, `c8cee8e37`, `cce3b6c55`, `376a99281`, `962141fd7`, `7e0dd3455`, `28ee79faa`, `7901a3593`, `5b25b11a6` and `a0a9bd8f7`.

Do **not** blindly cherry-pick the series. First use read-only `git show`, `git diff` and clean-applicability checks to understand dependencies. Cherry-pick only a self-contained commit whose complete behavior and files are approved unchanged. Otherwise implement the final behavior plus focused tests and cite all source SHAs in commit bodies and the handoff. TrackAI deliberately differs from upstream on Linux, WSL defaults and package credential transport.

Before copying or adapting source, verify the public snapshot's license/notice files and follow TrackAI's `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` third-party-source rules: retain required notices, pin the source revision and mark modified copies where the license plan requires it. This GitAI-to-GitAI-fork port still needs explicit provenance.

## 2. Founder-approved product boundary

### 2.1 Login-start behavior to port

1. Add an idempotent **macOS per-user LaunchAgent** installer and uninstaller. Preserve upstream's safe final semantics: direct `git-ai bg start --retry-secs`, `RunAtLoad`, no keep-alive supervision, safe environment and binary-path validation, `--no-start`, and cleanup on uninstall.
2. Add an idempotent **Windows per-user Scheduled Task** installer and uninstaller. Preserve upstream's safe final semantics: direct binary launch, bounded login-time retry, ignore concurrent starts, no execution-time limit, safe argument/path handling, `--no-start`, and cleanup on uninstall.
3. Add the corresponding dependency-free static/integration drivers and hosted per-PR macOS/Windows workflow. Adapt the upstream matrix to exclude Linux. Do not add the nightly published-release workflow in this session.
4. Publish the two login-start scripts as release assets using the existing release workflow and cover the asset list with the static Rust test.
5. Port the smallest `git-ai bg start --retry-secs` change and focused async tests needed by both launchers. Preserve existing daemon behavior when the option is absent. Retry only the login-time lock race; return failure after exhaustion.
6. The launchers start an already-installed client. They do not supervise it, enroll a device, fetch policy, transport a credential, prove MDM enrollment or grant TrackAI authority.

### 2.2 Package and credential behavior

1. A PKG/MSI installs only the GitAI binary and existing per-user setup. It never receives, exchanges, writes or logs a TrackAI machine credential. Task9c owns managed configuration and OS secret-store bootstrap.
2. Remove MSI `API_KEY` and `API_BASE` properties, the `ConfigureGitAi` property/custom action, and any `install-hooks --api-key` invocation. Do not replace them with another token, nonce, registry value, environment variable, command-line value, profile or file.
3. Keep the MSI per-user under `%USERPROFILE%\.git-ai\bin`, preserve its user PATH behavior and clean uninstall. Do not add all-users/System or WSL installation.
4. Keep the macOS package's active-console-user installation model, Apple signing/notarization path and existing hook setup. Apply the upstream package-permissions correction only if the fork still needs it and a focused test proves the problem.
5. Apply the upstream MSI version-smoke correction only if the current fork still has that defect. Preserve Windows x64 as the required hosted install/uninstall smoke. Do not add ARM64 installation validation.
6. Jamf and Intune remain delivery systems, not TrackAI authorities. Documentation may describe uploading the release PKG/MSI and post-login installation, but must say enrollment/configuration resumes in Task9c and live tenant evidence remains pending.

### 2.3 Explicit exclusions

- No Linux files, systemd unit or Linux support claim.
- No upstream `install-hooks --env` refactor, WSL default/credential-forwarding series or unattended-author-prompt feature.
- No nightly release-channel MDM workflow.
- No Jamf/Intune API, OS secret store, configuration fetch/activation, machine enrollment, all-users service or generic installer framework.
- No ADE, Autopilot/OOBE, native Windows, Apple Silicon or MDM pass claim from hosted CI.

## 3. Tests first and smallest-correct implementation

Use strict TDD and keep commits reviewable:

1. Add/adapt tests that fail on the fork before the behavior exists. Preserve upstream path-injection/CR rejection, idempotency, install/start/uninstall and retry-exhaustion coverage for macOS/Windows.
2. Add one dependency-free package contract test under `packaging/tests/`. It must initially fail because the MSI accepts secret-bearing properties/actions, then prove after the fix that:
   - no MSI property, command or custom action accepts `API_KEY`, `trk_v1`, `api-key` or credential input;
   - MSI remains per-user, installs `git-ai.exe`, owns only its user PATH entry and uninstalls cleanly;
   - macOS postinstall contains no credential/config argument and still rejects invalid console users;
   - managed-deployment docs contain no example secret and point secure enrollment to Task9c.
3. Adapt upstream `tests/mdm_scripts.rs` so it validates exactly the two shipped scripts, release assets and forbidden Linux drift. Reuse its safe parsing/contract ideas; do not add a dependency.
4. Port the minimal `--retry-secs` implementation and focused `tests/async_mode.rs` cases. Do not refactor the daemon.
5. Adapt upstream per-PR MDM workflow to macOS and Windows only. Update the existing release workflow for two script assets and the package contract. Keep changes to existing package jobs minimal.
6. Tighten the Windows x64 MSI smoke: quiet install without API values; verify binary/version and user ownership; verify no credential/config side effect; uninstall and verify removal. Preserve the macOS PKG smoke and add only a stable no-credential-side-effect assertion.
7. Update `mdm/README.md` and `packaging/README.md` with concise operational boundaries. Do not invent future Task9c commands or APIs.

## 4. File ownership

### Pre-approved

- new `mdm/README.md`, `mdm/macos/install-login-start.sh`, `mdm/windows/install-login-start.ps1`;
- new/adapted `scripts/mdm/test-login-start.sh`, `scripts/mdm/test-login-start.ps1`, `tests/mdm_scripts.rs`;
- new `.github/workflows/mdm-login-start.yml` and bounded `.github/workflows/release.yml` edits;
- bounded `src/commands/daemon.rs` and `tests/async_mode.rs` changes only for `bg start --retry-secs`;
- `packaging/README.md`, `packaging/windows/git-ai.wxs`, new `packaging/tests/**`;
- `packaging/windows/build-msi.ps1` and `packaging/macos/**` only if a failing focused test proves a small upstream correctness port is still required.

### Never touch

- `src/mdm/**`, `src/config.rs`, auth/credential code, `install.sh`, `install.ps1`, Cargo manifests/lockfile, unrelated workflows, version/changelog files, signing identities or release secrets;
- any TrackAI repository file;
- Task13 surfaces beyond the one bounded daemon option above.

If a required final upstream behavior needs a non-approved runtime refactor, stop and report the exact dependency instead of widening scope.

## 5. Verification and reporting

1. Run the focused MDM script tests, package contract and retry tests first. Then run `task fmt`, `task lint` and `task test`; classify inherited daemon/Clippy noise exactly.
2. Re-read the diff and search changed files for `API_KEY`, `trk_v1`, `api-key`, `token` and `secret`. Any occurrence must be a prohibition/test assertion, never transport.
3. Record provenance and divergence: upstream SHAs used; cherry-picked unchanged versus ported; Linux/nightly/WSL/credential behavior excluded; local adaptations and why.
4. Hosted jobs remain pending until the founder pushes. Per-PR GitHub macOS/Windows jobs prove script and package mechanics only; they do not replace a real Jamf, Intune or native-device lifecycle run.
5. Keep a clean tree. Do not push, open a PR or merge.

## 6. Close-out

In the final reply give exact commits, changed files, provenance mapping, focused/full gates, hosted evidence still pending, actual effort and any Task9c/Task13 dependency.

Provide exactly one founder `bash` block, in run order, that pushes and opens the GitAI PR with `--repo mahamannu-ux/git-ai` after lead approval. Provide exactly one `text` review request for the Task9 lead naming branch, commit(s), worktree, base SHA, provenance and completed gates.

## Lessons to carry forward

- Upstream code is evidence and reusable implementation, not automatic policy approval.
- Prefer a clean cherry-pick for a truly self-contained unchanged fix; prefer a provenance-recorded final-state port when the series contains excluded platforms or conflicts with TrackAI security decisions.
- Existing `src/mdm/` installs hooks/editors. The new top-level `mdm/` scripts only arrange per-user login start; neither grants fleet authority.
- GitHub Actions provide the Windows x64 floor when no rental exists, but cannot prove Credential Manager, Intune, Jamf or real-device lifecycle behavior.
