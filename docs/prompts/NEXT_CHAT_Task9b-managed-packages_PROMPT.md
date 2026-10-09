# Handoff prompt: Task9b-managed-packages (secret-free managed PKG/MSI foundation), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Update both read-only checkouts:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. From TrackAI, create the GitAI worktree: `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task9b-managed-packages && cd ~/AIProjects/TrackAI-wt/Task9b-managed-packages-gitai && opencode`.
> 3. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply `continue` if it stops. No Jamf, Intune, Windows rental, signing certificate or secret is needed now.
> 4. Task9b may run alongside Task9a. Before editing, confirm no active Task13 session is editing `.github/workflows/release.yml` or `packaging/`; if it is, stop and report the exact overlap.
> 5. When Muse finishes, paste its review request to the Task9 lead Codex thread. Push only after Codex returns `ready to push`.

---

You are **Muse**, building **Task9b-managed-packages** in the **GitAI fork** for TrackAI. Existing release CI already builds signed Windows MSI artifacts and signed/notarized macOS PKGs, including a Windows x64 install/uninstall smoke. This session makes that package layer safe for managed deployment by removing secret-bearing MSI configuration and documenting the small post-login Jamf/Intune boundary. **Every product decision is below; do not redesign.** Do not add fleet runtime behavior—that belongs to Task9c.

- **Repo:** `~/AIProjects/git-ai` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task9b-managed-packages-gitai`, branch `task/Task9b-managed-packages-gitai` (the TrackAI `make gitai-worktree` target appends `-gitai` to both path and branch).
- **Planning source, read-only:** `~/AIProjects/TrackAI-v1/docs/plan/TASK9.md`, `docs/plan/primers/Task9_PRIMER.md`, and `docs/handoffs/Task9-plan_HANDOFF.md`.
- **Session handoff:** return the complete GitAI checkpoint in your final reply; the Task9 lead records it in TrackAI after review. Do not add a TrackAI process-only handoff file to the GitAI product repository.

## 0. Before anything else

1. Read GitAI's `AGENTS.md` in full, especially the reuse, strict-TDD, cross-platform and human-review rules. Also read TrackAI's read-only `AGENTS.md` §§9, 11, 12.4 and 12.8 for status wording and founder handoff shape.
2. Verify identity and location: `pwd && git rev-parse --show-toplevel && git branch --show-current && git log --oneline -1`. You must be in `~/AIProjects/TrackAI-wt/Task9b-managed-packages-gitai` on `task/Task9b-managed-packages-gitai`; otherwise stop. Set worktree-local identity: `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. Record the GitAI base SHA. It must be `d26da8ea1b4b734dc2c1bc99759d87c75a187ee3` or a later descendant on the fork's `main`; otherwise update the read-only main checkout and recreate the worktree rather than rebasing hidden changes.
4. Run `task test` once as baseline. If the known daemon-mode parallel flake appears, retry only the exact affected test serially and report both outcomes; never hide a real failure.
5. Inspect active GitAI worktrees/branches for Task13 overlap. This prompt intentionally avoids `src/mdm/`, `src/config.rs`, `install.sh`, `install.ps1` and daemon startup. Stop only if another session is editing this prompt's `packaging/` or release-workflow lines.
6. Estimate one line against T6. The planning estimate was a conservative **0.25× ceiling**; this package-only slice targets **about 0.12×**. Stop before adding runtime code, dependencies or another workflow.

## 1. Read before editing

- TrackAI read-only: `docs/plan/TASK9.md` §§1–7 (T9.1a/T9.2a, Wave 1 and IT-T9-04), `docs/plan/primers/Task9_PRIMER.md` packaging/MDM sections, `docs/plan/GITAI_FUTURE_TODO.md` G1, and `TASK14.md` T14.3/T14.7.
- GitAI: `packaging/README.md`; `packaging/macos/{build-pkg.sh,scripts/preinstall,scripts/postinstall}`; `packaging/windows/{build-msi.ps1,git-ai.wxs}`.
- `.github/workflows/release.yml` package-msi, package-pkg, test-msi, test-pkg and release-note sections.
- `src/commands/install_hooks.rs` only to understand what the existing postinstall does. It is read-only in this session.
- `install.sh` and `install.ps1` only to confirm their nonce exchange is a different installer path. They are read-only.
- No SushiCorp/catalog port exists for endpoint packaging. Reuse the current GitAI release machinery instead.

## 2. Scope approved by the founder

### 2.1 Frozen behavior

1. A PKG/MSI installs **only the GitAI binary and existing per-user setup already proven by that package**. It never receives, exchanges, writes or logs a TrackAI machine credential. Task9c later owns managed configuration and OS secret-store bootstrap.
2. Remove the MSI's `API_KEY` and `API_BASE` properties, `ConfigureGitAi` property/custom action, and the command that invokes `install-hooks --api-key`. Do not replace them with another secret, token, nonce, registry value, environment variable, custom action or configuration file.
3. Keep the MSI per-user under `%USERPROFILE%\.git-ai\bin`, keep its user PATH behavior, and preserve clean uninstall. Do not add an all-users/System mode in Task9b.
4. Keep the macOS package's current post-login/active-console-user model and its existing `git-ai install-hooks` call. Do not make it pre-login, install a daemon, change ownership semantics or claim ADE support.
5. Keep current Apple signing/notarization and Windows signing paths. Do not add certificates, signing secrets or a second signing framework.
6. Windows x64 is the required hosted smoke. Do not add ARM64 validation. Leave the existing ARM64 build/package path alone unless a small shared edit is unavoidable; it remains build-only and is not a support claim.
7. Jamf and Intune are deployment systems, not TrackAI authorities. Documentation may show only:
   - Jamf: upload the signed/notarized PKG and run it as a post-login policy for an enrolled Mac.
   - Intune: upload the signed x64 MSI and use `msiexec /i <msi> /qn /norestart`; detection is the installed binary/version; uninstall uses the MSI product code.
   - Configuration/credential enrollment is explicitly **not yet performed by the package** and resumes in Task9c/Task9f/Task9g.
8. Do not claim a real Jamf/Intune, native Windows, Apple Silicon or OOBE/ADE/Autopilot pass in this session.

### 2.2 Tests first

1. Add one dependency-free packaging contract test under `packaging/tests/` using only tools already present on Ubuntu CI (prefer Python standard library or a small shell test; no new package/dependency). It must fail against the current MSI source because `API_KEY`/the secret-bearing custom action exists, then pass after the change.
2. The contract test must parse or inspect the package sources and prove:
   - no MSI property, command or custom action accepts `API_KEY`, `trk_v1`, `api-key` or another credential input;
   - the MSI remains `Scope="perUser"`, installs `git-ai.exe` and owns only its user PATH entry;
   - the macOS postinstall contains no credential/configuration argument and still rejects invalid console users;
   - managed-deployment documentation contains no example credential/token value and clearly says Task9c owns secure enrollment.
3. Register this fast static contract in an existing lightweight GitHub workflow only if one already runs packaging checks on ordinary PRs; otherwise add it as the first step of the existing release package jobs, not as a new workflow. Keep the workflow diff minimal.
4. Update the Windows x64 MSI smoke in `.github/workflows/release.yml`:
   - install with `/qn /norestart` and no API values;
   - verify the binary exists, runs `--version`, is not System-owned, and no retired system-wide runtime appears;
   - verify the package did not create or overwrite a credential/config file as an installation side effect;
   - uninstall and verify the installed binary is removed. Do not add an ARM64 install test.
5. Preserve the macOS PKG smoke. Add only a cheap assertion that the package did not create a machine credential/configuration as a package side effect if that assertion is stable on a clean hosted runner.

### 2.3 Documentation

Replace the insecure `API_KEY` MSI example in `packaging/README.md` with a short **Managed deployment (phase 1)** section:

- packages are secret-free;
- Jamf/Intune install commands at the level stated above;
- post-login enrolled-device boundary;
- package signature/notarization remains release-CI responsibility;
- secure machine enrollment/configuration is a separate Task9c step and must put the credential directly into Keychain or Credential Manager/DPAPI—never command line, MSI property, profile, log or checked-in file;
- hosted CI proves packaging mechanics, not a native or MDM support claim.

Keep this to operational facts; do not document speculative Task9c commands or APIs.

### 2.4 Port from

None: SushiCorp has no endpoint package/MDM component. Reuse GitAI's existing WiX, PKG and signed release workflow. State this in the final handoff.

### 2.5 Pre-approved files

- `packaging/README.md`.
- `packaging/windows/git-ai.wxs`.
- `packaging/tests/**` for the one contract test.
- `.github/workflows/release.yml`, limited to registering the contract check and tightening `test-msi`/the optional cheap `test-pkg` assertion.
- `packaging/windows/build-msi.ps1` or `packaging/macos/**` only if a failing contract test proves a small correction is necessary; explain it in the handoff.

### 2.6 Never touch

- `src/**`, `install.sh`, `install.ps1`, `Cargo.toml`, `Cargo.lock`, other workflows, version/changelog files, signing identities, release secrets, Task13 surfaces, or any TrackAI file.
- No Jamf/Intune API integration, no OS secret store, no credential exchange, no system service, no all-users installation, no new dependency, and no broad packaging refactor.
- If safe package behavior requires client runtime support, stop and hand the requirement to Task9c; do not smuggle runtime work into this session.

## 3. Working rules and evidence

1. Strict TDD: commit the failing package-contract test first, then the minimal source fix, workflow smoke update and documentation. Prefix commits `Task9b-managed-packages:` and explicitly stage named paths.
2. Run the packaging contract locally. Run `task fmt`, `task lint` and `task test`; classify inherited daemon-mode/Clippy noise exactly as GitAI's AGENTS says.
3. You cannot claim IT-T9-04 passed until the founder pushes and GitHub's Windows x64 package job completes. Locally, report the static contract and Rust gates separately from hosted Windows evidence.
4. Re-read the whole diff as a reviewer. Search the changed files for `API_KEY`, `trk_v1`, `api-key`, `token`, `secret` and confirm any remaining occurrence is a prohibition/test assertion rather than a delivery mechanism.
5. Keep the diff reviewable. The expected product change is deletion of the MSI configuration custom action, a compact contract test, a small x64 smoke adjustment and a short README section.

## 4. Close-out

- Clean tree; do not push, open a PR or merge.
- In the final reply, give exact commit(s), changed files, static/Rust gates, what hosted Windows CI must still prove, actual effort, and any Task9c dependency. Distinguish passed, pending and not run.
- Provide exactly one founder `bash` block in run order. After review it must push and open the GitAI PR with `--repo mahamannu-ux/git-ai`.
- Provide exactly one `text` review request for the Task9 lead Codex thread, naming branch, commit, worktree, base SHA and completed gates. The lead will record the final cross-repo handoff/status in TrackAI.

## Lessons to carry forward

- Existing release packaging is a foundation, not a support claim. Preserve it and remove only the unsafe credential path.
- GitHub Actions can prove build/install/uninstall mechanics; it cannot replace native Credential Manager, Intune, Jamf or real-device lifecycle evidence.
- Simple means no generic installer framework and no runtime edits. Accurate means the package never transports a credential and every unrun live gate stays pending.
