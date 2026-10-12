# Next chat prompt — Task9f macOS conformance and evidence

> Founder setup before starting Codex:
>
> 1. Merge this prompt's documentation PR. Task9d is already merged in GitAI fork PR #6 at `d1838619c5555a47ea0ffb77ecd6d1cc07cf4859`.
> 2. Update both main checkouts, then create the GitAI worktree:
>
>    ```bash
>    cd /Users/manishmahajan/AIProjects/TrackAI-v1
>    git checkout main
>    git pull --ff-only
>    git -C /Users/manishmahajan/AIProjects/git-ai checkout main
>    git -C /Users/manishmahajan/AIProjects/git-ai pull --ff-only
>    make gitai-worktree M=Task9f-macos-conformance
>    ```
>
> 3. Start a new Codex task attached to `/Users/manishmahajan/AIProjects/TrackAI-wt/Task9f-macos-conformance-gitai` and paste everything below this setup block. Do not ask Codex to create a second worktree.
> 4. Jamf is **not** required for the first phase. Continue arranging the Jamf Pro trial, APNs certificate and organization-controlled Apple Account separately. Never paste an Apple/Jamf credential, APNs material, TrackAI machine credential or signing secret into chat.
> 5. Codex may prepare exact founder commands for privileged PKG installation and native Keychain/Jamf checks, but it must not run `sudo`, enroll/unenroll the Mac, change the active APNs certificate or remove real user data without your explicit approval at that checkpoint.
> 6. When Codex finishes, paste its review request to TrackAI-Orchestrator. Push only after the reviewer says `ready to push`.

You are **Codex**, running **Task9f-macos-conformance** in the GitAI fork. Task9a–Task9e, the Task9a2/Task9c2 lifecycle correction and Task9d are merged. This is primarily a macOS conformance/evidence session: prove the existing Task9 implementation on the founder's 2019 Intel Mac, add the smallest repeatable test/runbook surface needed to preserve that evidence, and fix only defects demonstrated by a failing Task9-owned check. It is not a new fleet design session and must not widen product scope.

## Start gate

Before editing, print and verify:

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
git rev-parse HEAD
git log -1 --oneline
uname -m
sw_vers
```

Required values:

- root: `/Users/manishmahajan/AIProjects/TrackAI-wt/Task9f-macos-conformance-gitai`
- branch: `task/Task9f-macos-conformance-gitai`
- clean tree
- base: GitAI fork `origin/main` at `d1838619c5555a47ea0ffb77ecd6d1cc07cf4859` or a later founder-confirmed commit containing Task9d PR #6
- host architecture: `x86_64`; record the macOS version, but never record hardware serial numbers, Apple Account details or other device identifiers

If any repository value differs, stop before code. Read GitAI `AGENTS.md` in full. Give a one-line estimate before implementation. The plan's ceiling is about **0.30x T6**; target **0.18x T6** for local Intel-Mac engineering/evidence. Jamf live evidence may raise the actual toward **0.24x**, but must not cause a second implementation session unless a real product defect appears.

## Read before acting

Read these TrackAI inputs without editing them:

- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/plan/TASK9.md`, especially Wave 3, IT-T9-02, IT-T9-03, IT-T9-07 and the completion/deferral boundary
- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/plan/TASK9_LIFECYCLE_CONTRACT_CORRECTION.md`
- `/Users/manishmahajan/AIProjects/TrackAI-v1/docs/handoffs/Task9-lifecycle-contract-correction_HANDOFF.md`

Inspect the merged GitAI implementation and history rather than relying only on this prompt:

- Task9b merge `90ef132136adee09f5f7a32c4b93a50986beb69d`
- Task9c merge `cc155d692120e12f4a1ffbc01871bedd89e044db`
- Task9c2 merge `c4509ab8d32701572e02d1e6c8bba89de1ab3440`
- Task9d merge `d1838619c5555a47ea0ffb77ecd6d1cc07cf4859`
- `packaging/`, `mdm/`, `scripts/mdm/`, `.github/workflows/release.yml`, `.github/workflows/mdm-login-start.yml`
- `src/commands/fleet.rs`, `src/fleet/`, `src/auth/machine_credentials.rs`, `src/metrics/delivery.rs`, `src/daemon/telemetry_worker.rs`
- existing focused tests: `packaging/tests/contract.rs`, `tests/mdm_scripts.rs`, managed-update, cleanup and fleet integration tests

## Nature of this session

Treat this as approximately:

- **70–80% validation and evidence:** native Intel-Mac behavior, safe founder-assisted checks, support-claim classification and a reproducible runbook;
- **20–30% bounded implementation:** a small macOS conformance harness, focused regression tests, CI wiring only when clearly missing, and narrow fixes proven necessary by a failing check.

Do not redesign Task9a–Task9e, add a generic MDM framework, or create speculative abstractions. A missing external prerequisite becomes a named pending row, not replacement code.

## Required work

### 1. Freeze the evidence matrix before code

Create a concise Task9 macOS conformance document under `docs/` that separates these rows and never collapses them:

1. automated/static contract evidence;
2. current Intel-Mac local evidence (`IT-T9-02`);
3. signed/notarized artifact evidence;
4. Jamf-managed evidence (`IT-T9-03`);
5. second-Mac/Apple-Silicon evidence (`IT-T9-07`);
6. Task15-dependent signed configuration/update execution (`IT-M9-01`).

For each row record prerequisites, exact command or procedure, safe expected output, evidence captured, status (`passed`, `failed`, `pending prerequisite`, or `not applicable`) and the customer claim it permits. Never call a simulated, unsigned, dry-run, CI or single-device result a native signed/Jamf/two-device pass.

The evidence document must contain no hostname, username, serial number, Apple Account, tenant URL containing customer identity, machine credential, token, certificate, private key, raw configuration, raw telemetry or customer source content.

### 2. Add the smallest repeatable macOS conformance harness

Prefer one bounded script under `scripts/task9/` plus focused Rust/static tests where useful. Reuse existing package and MDM scripts instead of copying their logic.

The harness must:

- support a read-only/default planning mode;
- refuse non-macOS and record x86_64 honestly;
- use an explicitly supplied binary/package and an isolated test workspace where possible;
- never read or modify the founder's normal GitAI database, durable queue, login credentials or repositories;
- never discover or print secret values; accept no credential in argv or environment;
- collect only bounded, redacted pass/fail metadata into a gitignored temporary evidence directory;
- clean up only resources it created, even after failure;
- stop and print founder commands rather than invoking `sudo`, installing a PKG into the real user home, enrolling/unenrolling MDM or changing Keychain access-control state automatically;
- make reruns idempotent and distinguish product failure from missing tooling, sandbox denial and unavailable external infrastructure.

If existing scripts already cover a row completely, call them and document the evidence rather than creating another implementation.

### 3. Automated and unprivileged local gates

Run focused gates first and preserve their exact counts. At minimum cover:

- packaging contract and MDM script tests;
- Task9 fleet configuration/credential/update/cleanup unit tests;
- the existing macOS login-start lifecycle with a locally built binary only if it can be isolated from the founder's ordinary daemon and home;
- release workflow/static assertions for Intel PKG creation, signature/notarization gates and artifact checksums;
- secret-oriented diff/evidence searches using patterns, never actual secret values.

Do not repeatedly run the complete Cargo suite on this Intel Mac. Run it once only if the focused gates expose a cross-cutting risk and compilation is already warm; otherwise record it as skipped rather than passed. Existing inherited Clippy findings and daemon flakes must be classified separately from Task9f regressions.

### 4. Founder-assisted native Intel-Mac lifecycle (`IT-T9-02`)

Prepare one pasteable founder command block, staged in safe checkpoints. Do not execute privileged or destructive checkpoints yourself.

The intended local lifecycle is:

1. inspect an exact Intel or universal PKG and checksum;
2. if a genuinely signed/notarized artifact is available, verify with `pkgutil`, `codesign`, `spctl` and stapler before installation;
3. otherwise test an explicitly labelled unsigned development PKG for mechanics only and keep the signed/notarized row pending;
4. install post-login into the console user's per-user location and prove ownership, executable version, trace2 hook setup and absence of `/opt` or system-wide replacement paths;
5. register login-start, prove the daemon starts and survives launcher exit, then prove idempotent re-registration;
6. prove native Keychain machine-credential store status and store/load/delete behavior without printing the value and without a plaintext fallback;
7. install only a bounded non-secret bootstrap document through stdin and verify restrictive local state;
8. create synthetic, non-customer evidence while offline, then prove the durable queue survives daemon restart and update/rollback attempts;
9. while production uses `UnavailableVerifier`, prove managed release execution remains fail-closed with zero download/install side effects; do not claim successful managed update/rollback until Task15 supplies the real verifier;
10. run cleanup dry-run, inspect its exact scope, then explicitly apply; prove Keychain entry, managed state, staged update and login-start registration are removed while the durable evidence queue, authorship notes, repositories, normal user login and binary remain;
11. repeat cleanup to prove idempotency.

Use synthetic identifiers and a disposable TrackAI tenant/runtime if server interaction is available. Any one-time machine credential must be generated and entered by the founder directly through stdin; it must never appear in chat, shell history, an environment variable, a command argument, a fixture, a log or the evidence document.

If sandbox restrictions prevent a meaningful native assertion, give the founder the exact command and wait for only safe summary output. Do not weaken the product to accommodate the sandbox.

### 5. Jamf lane (`IT-T9-03`) — conditional in this same session

Do not block initial work on Jamf procurement. Prepare the Jamf section of the runbook now; execute it only after the founder confirms all three prerequisites:

- Jamf Pro trial tenant provisioned with the needed package/policy/inventory features;
- APNs certificate active, created with the founder's organization-controlled Apple Account;
- this Mac manually enrolled for the test.

Jamf phase 1 is post-login only. It does **not** include ADE, Automated Device Enrollment, OOBE, Apple Business Manager, wipe testing or production rollout.

The bounded Jamf procedure should prove:

1. upload the exact signed/notarized PKG when available; otherwise keep the production package row pending;
2. deploy package, login-start script and non-secret bootstrap policy to the enrolled test Mac without transporting a TrackAI credential;
3. enter the one-time TrackAI machine credential separately and locally through stdin;
4. observe safe inventory/policy results and compare only opaque MDM evidence—Jamf never grants TrackAI authority;
5. test update/rollback only after Task15 supplies production verification; before then prove the fail-closed result;
6. revoke server authority first, then explicitly deliver the cleanup wrapper and verify its separate result;
7. remove the test scope/device from Jamf without wiping the founder's Mac.

API automation is not required for one or two test devices. Prefer clear console steps plus exported/redacted result identifiers. Add Jamf API code only if a frozen Task9 requirement cannot be proven manually; stop for founder approval before doing so.

### 6. Defect policy

When a native or focused check fails:

1. reproduce it with the narrowest command;
2. classify product defect vs environment/prerequisite/sandbox issue;
3. for a product defect, write the failing regression test first and make the smallest fix in an already Task9-owned file;
4. stop before changing a cross-platform contract, wire schema, release identity, Task15 seam or TrackAI repository.

No speculative cleanup or refactor is allowed merely because the file is being inspected.

## Pre-approved files

- new Task9f macOS conformance document(s) under `docs/`
- new bounded harness under `scripts/task9/`
- focused tests under `tests/` or `packaging/tests/`
- `mdm/macos/**` and `packaging/macos/**` only for a demonstrated macOS defect
- Task9-owned Rust files under `src/fleet/`, `src/auth/machine_credentials.rs`, `src/commands/fleet.rs` and minimal daemon/delivery wiring only for a demonstrated defect
- `.github/workflows/mdm-login-start.yml` or the existing macOS PKG smoke in `.github/workflows/release.yml` only for a small missing conformance assertion; explain the cost before editing

Do not edit Cargo dependencies or lockfiles unless a demonstrated defect cannot be fixed with the standard library and existing crates. Stop and ask before any new dependency.

## Never touch

- TrackAI repository files, database contracts or migrations
- Task15 implementation or verifier semantics
- Task4/Task6 authorization, telemetry or policy semantics
- Windows, Linux, WSL, nightly or ARM64 implementation merely to support this Intel-Mac session
- upstream GitAI updates unrelated to the merged Task9 code
- raw evidence formats, queue schemas, authorship semantics or critical trace2 ingestion paths
- Apple/Jamf accounts, certificates or signing secrets in repository files, fixtures, logs or chat
- the founder's ordinary GitAI data or normal daemon without an explicit founder-approved native checkpoint

## Port from

None. This is conformance work over the fork's merged Task9 implementation. Reuse the existing PKG builder, release verification, login-start lifecycle, native machine-credential store, managed update and cleanup paths. Do not import a generic MDM harness or newer upstream code.

## Acceptance

Before closeout, prove or honestly defer:

1. the branch started from GitAI `d1838619c...` or a later confirmed descendant;
2. the repeatable harness defaults read-only, is isolated and emits no secrets/device identifiers;
3. focused Task9 package, MDM, configuration, credential, lifecycle and cleanup gates pass;
4. native Intel-Mac PKG/login-start/Keychain/bootstrap/offline-queue/cleanup results are recorded from founder-assisted execution;
5. unsigned development PKG evidence is never labelled signed/notarized;
6. `UnavailableVerifier` causes zero managed download/install side effects and keeps successful update/rollback pending on Task15;
7. Jamf, second-Mac and Apple-Silicon rows remain pending until actually run;
8. cleanup is explicit and preserves the queue, authorship, repositories, user login and binary;
9. no raw secret, certificate, customer content or machine identity enters git, logs or the handoff;
10. every support statement is no broader than its live evidence.

## Gates

Choose exact filters after inspecting the merged test names, but run at least:

```bash
task fmt
task lint
task test CARGO_TEST_ARGS="--test mdm_scripts"
task test CARGO_TEST_ARGS="--test packaging_contract"
task test CARGO_TEST_ARGS="--lib" TEST_FILTER="fleet::"
git diff --check d1838619c5555a47ea0ffb77ecd6d1cc07cf4859..HEAD
git status --short
```

Run the conformance harness in planning mode and each safe unprivileged mode. Record founder-run native/Jamf commands separately with their prerequisite and result. A skipped full suite, unavailable signing identity, missing Jamf tenant or missing Task15 verifier is not a pass.

## Commits and closeout

Prefer two or three small commits:

1. evidence matrix/runbook and read-only harness tests;
2. bounded conformance harness and focused assertions;
3. only if required, a demonstrated macOS fix plus regression test; then evidence/status closeout.

Do not push, open a PR or merge. Finish with:

- exact base, branch and commits;
- files and interfaces changed;
- automated gate counts and precise native commands run;
- a row-by-row result for IT-T9-02, IT-T9-03, IT-T9-07 and IT-M9-01;
- supported customer wording and every pending prerequisite;
- explicit confirmation that no secret/device identifier entered git or output;
- actual effort versus the `0.18x T6` operational target and `0.30x` ceiling;
- one founder bash block containing remaining safe native/Jamf commands, then push/PR commands under `# after cross-agent review`;
- one review request for **TrackAI-Orchestrator**, naming the branch, commits, worktree, base, changed paths, automated/native gates and all conditional rows, ending: `No push or PR yet; reply ready to push or list fixes.`
