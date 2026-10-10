# Handoff prompt: Task9c-managed-config-secrets (verified client configuration + OS credential stores), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the TrackAI PR that adds this prompt and merge GitAI Task9b PR #3. Task9a is already merged in TrackAI PR #16. Do not start Task9c from pre-Task9b GitAI `main`.
> 2. Update both read-only checkouts: `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`. Confirm GitAI `main` contains Task9b head `3a4dceb3921a5e17d310303100706f922031e672`.
> 3. Create the GitAI worktree from TrackAI: `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task9c-managed-config-secrets`. Start a new Codex task in that exact worktree: `~/AIProjects/TrackAI-wt/Task9c-managed-config-secrets-gitai`, branch `task/Task9c-managed-config-secrets-gitai`.
> 4. No Jamf, Intune, Windows rental, signing key or real credential is needed. Never paste a credential or secret into chat. Native Keychain/Credential Manager evidence remains Task9f/Task9g.
> 5. Task9c uses the telemetry worker for bounded background wiring. Task9b's daemon-command, async-mode, MDM, packaging and workflow surfaces are now frozen inputs, not extension points. Send the final review request to TrackAI-Orchestrator (or Muse if unavailable). Push only after `ready to push`.

---

You are **Codex**, building **Task9c-managed-config-secrets** in the **GitAI fork** for TrackAI. Task9a has frozen the machine-authenticated server envelope and report routes, and Task9b has landed the secret-free PKG/MSI plus per-user login-start contract. This session adds the smallest fail-closed client: parse/fetch/stage/verify/atomically activate configuration, preserve one last-known-good version, store TrackAI machine credentials in macOS Keychain or Windows Credential Manager/DPAPI, and report safe state. It does not implement signing, update/rollback binaries, offboarding, MDM APIs, UI or Linux.

- **Repo:** `~/AIProjects/git-ai` (`main`). **Worktree:** `~/AIProjects/TrackAI-wt/Task9c-managed-config-secrets-gitai`, branch `task/Task9c-managed-config-secrets-gitai`.
- **GitAI handoff:** return the complete checkpoint in the final reply; do not add a TrackAI process-only handoff file to the GitAI repository.
- **Frozen TrackAI source, read-only:** `~/AIProjects/TrackAI-v1` at or after PR #16 merge `21ad4e88494fd5784cc56aaa7dc2267ace33735f`.

## 0. Before anything else

1. Read GitAI `AGENTS.md` in full. Also read TrackAI `AGENTS.md` §§1, 5, 5a, 6, 8, 9, 11, 12.3, 12.4 and 12.8 from the read-only checkout.
2. Verify `pwd`, Git root, branch, HEAD and clean state. You must be in the exact Task9c GitAI worktree/branch above. Set worktree-local identity to `mahamannu-ux <mahamannu@gmail.com>`.
3. GitAI base must be fork `main` containing Task9b head `3a4dceb3921a5e17d310303100706f922031e672`. Record the actual Task9b merge SHA. Never base on public `upstream/main`.
4. Inspect `git worktree list` and verify the new branch is clean and based on that fork-main descendant. If `src/fleet/**`, machine-credential files, `src/metrics/delivery.rs`, `src/security/activation.rs` or `src/daemon/telemetry_worker.rs` already contain unrelated active work, stop and report the exact overlap.
5. Do **not** spend an initial cycle on the full Cargo suite. Baseline only the existing affected modules with `cargo test --lib metrics::delivery` and `cargo test --lib security::activation`; if either command's filter matches no tests, correct the filter before proceeding. Use focused tests while developing, then run each full gate exactly once at the stable final checkpoint. Classify the known parallel `daemon_mode` flake and newer-Rust Clippy findings honestly.
6. Estimate one line against T6. Operational target is **about 0.32×**, with the plan's **0.40× ceiling**. Stop before adding a generic policy engine, new server route, update mechanism or third platform.

## 1. Read before writing code

### TrackAI, read-only

- `docs/plan/TASK9.md` §§1–7, especially T9.4, T9.8, Wave 2 and acceptance invariants.
- `docs/plan/primers/Task9_PRIMER.md` managed configuration, secrets and Task4 comparison.
- `docs/handoffs/Task9a-fleet-control-plane_HANDOFF.md` Implemented interfaces, Known limitations and Integration notes.
- `apps/api/src/features/fleet/contract.ts` and the worker portion of `fleet.routes.ts`. These are the exact wire contract; do not infer fields from the prose.
- `TASK4.md` 5.5.3 plus `apps/api/src/features/admin/task4-wave4-machine-keyring-install.ts` for the existing credential syntax/stdin safety invariant; do not port its plaintext file storage.
- `TASK14.md` T14.3 and Endpoint secret-store boundary.

### GitAI

- `src/metrics/delivery.rs`, especially `MetricDeliveryRuntime`, policy binding and current JSON credential keyring.
- `src/security/activation.rs` and `src/security/delivery*.rs`.
- `src/auth/{credential_backend,credentials,mod}.rs`; distinguish human OAuth credentials from TrackAI machine credentials.
- `src/api/client.rs`, `src/daemon/telemetry_worker.rs`, `src/config.rs`, `src/lib.rs`, command dispatch files and `Cargo.toml`.
- Task9b's merged `src/commands/daemon.rs`, login-start scripts, packaging contracts and focused tests, read-only. Login-start retry is separate from fleet refresh.

## 2. Frozen contracts and decisions

### 2.1 Exact server contract

1. Fetch `GET /worker/fleet/configuration` with the existing TrackAI machine credential. `204` means no desired configuration; retain the current verified active configuration and report no new acknowledgement. Network/5xx/parse failures also retain it.
2. A `200` envelope accepts only Task9a's closed schema-v1 fields: configuration ID/epoch/times, exact target client version, one of the four existing update channels, optional ring, repository-policy references, Task6 `off|monitor`, and `verification: { required: true, state: 'unavailable' }`. Deny unknown fields, unsafe bounds, duplicate repository/grant references and invalid times.
3. Post only Task9a's closed report to `/worker/fleet/report`. Tenant and machine never appear as client-chosen fields. MDM references are `null` and assignment source is `unavailable` in Task9c; Jamf/Intune evidence belongs to conformance sessions.
4. Use Task9a's safe acknowledgement results exactly: `applied`, `rejected_invalid`, `rejected_expired`, `rejected_incompatible`, `verification_unavailable`, `verification_rejected`, `activation_failed`, `unavailable`.

### 2.2 Verification and activation

1. Define a narrow verifier trait in `src/fleet/` whose result is `verified`, `rejected` or `unavailable`. It receives the exact downloaded bytes plus the closed verification metadata; it does not own network fetching or storage.
2. Production's Task15 adapter is currently unavailable. Because Task9a returns `required: true, state: unavailable`, production must stage but **must not activate** the candidate and must report `verification_unavailable`. Unit tests may inject a deterministic fake verifier to exercise verified/rejected paths. Do not invent a signing key, accept unsigned success or weaken `required`.
3. Validate in order before activation: closed parse and size bound, exact client-version compatibility (`CARGO_PKG_VERSION`), validity window, verifier result, repository-policy consistency, then storage. A failure never changes active state.
4. Store only metadata/configuration—not a credential—under a dedicated `~/.git-ai/fleet/` state directory. Use write-to-new-file, flush/sync where supported, atomic rename and restrictive permissions. Retain exactly current active plus one previously verified last-known-good configuration; remove abandoned staging files safely.
5. Normal forward activation accepts a newer epoch. Reassignment to an older epoch is accepted only when configuration ID and content digest exactly match the retained verified last-known-good; that is Task9a's rollback primitive. Reject an unknown or changed epoch regression.
6. Apply one whole verified configuration: repository policy and Task6 mode change together or neither changes. Never partially activate a repository subset.

### 2.3 Repository and security projection

1. Keep `trackai-delivery-policy.json` as non-secret bootstrap routing: repository URL/ID, tenant, API base URL and credential key ID. The managed envelope does not contain enough routing data to replace it.
2. Add a bounded `git-ai fleet bootstrap install` stdin command for that existing schema. It accepts at most one closed, size-bounded non-secret JSON document, validates HTTPS (with the existing debug-loopback exception), repository normalization/uniqueness and credential key IDs, then writes it atomically with restrictive permissions. It prints only a safe success code/count, not repository URLs or customer metadata. MDM may deliver this non-secret document later; Task9c does not call Jamf/Intune.
3. Require exactly one unique `(tenant, API base, credential key ID)` health binding for managed-fleet fetch/report. Multiple bindings remain valid for legacy delivery but make fleet management `unavailable`; never choose one silently.
4. Match every managed repository reference to an existing bootstrap `repository_id`; reject missing, duplicate or cross-binding references. The verified overlay supplies grant/enrollment IDs, branch patterns and effective times. Existing server-side machine authentication and grant checks remain authoritative on every upload.
5. Extend delivery binding minimally so the active verified overlay restricts repository/branch use. No active verified overlay means existing Task4 delivery behavior remains unchanged; an invalid candidate cannot broaden it.
6. Feed verified `securityActivation.mode/version` through a small managed source in `src/security/activation.rs`. Managed verified state takes precedence for its repositories. Preserve legacy behavior when no managed configuration is active, but do not describe legacy unsigned activation as production-safe.

### 2.4 Machine credential store

1. Add a dedicated machine-credential interface; do not reuse or change the human OAuth `CredentialStore` contract. Operations: validate/store by embedded 16-character key ID, load by key ID, delete by key ID, and report only safe availability/backend codes.
2. macOS uses the current-user Keychain and Windows uses Credential Manager protected by the current Windows account/machine DPAPI context through the existing Rust `keyring` dependency or the smallest safe target-native wrapper. Use a TrackAI-specific service name and key ID as the account. Never put the credential in a process argument, environment variable, log, debug output or config file.
3. Supported macOS/Windows routes fail closed when the store is unavailable, locked, wrong-user/wrong-machine, corrupt or missing. There is **no file fallback** for managed machine credentials. Existing JSON credential files remain an explicit legacy/test input only; default managed loading must not silently select them.
4. Add one bounded command such as `git-ai fleet credential install` that reads at most 1 KiB from non-TTY stdin, validates the complete `trk_v1.<key-id>.<secret>` value, stores it directly, prints only the key ID and a safe success code, and zeroes/drops the in-memory input as soon as practical. Add `status` and `delete --key-id` only if needed for lifecycle/tests; neither reveals a value. No credential argument flag.
5. Refactor `MetricDeliveryRuntime` to resolve a key ID through the injected machine-credential store. Keep a fake/in-memory store for unit tests and an explicit legacy file adapter for existing test fixtures. Avoid spreading credential clones; never implement `Debug` for secret-bearing values.
6. If enabling the existing optional `keyring` dependency in release builds needs a minimal Cargo feature/default adjustment, it is approved. Do not add a second secret-store library. Linux adapters and claims remain deferred even if dependency code compiles there.

### 2.5 Background refresh and report

1. Add a bounded fleet refresh/report call in `src/daemon/telemetry_worker.rs`, outside the latency-sensitive ingestion path. Reuse its existing periodic/background structure; do not add a second daemon, service or unbounded worker.
2. Fetch/stage/verify/activate first, then send safe posture and the result. Queue fields reuse existing bounded counts. Platform, architecture, GitAI version and service state must be honest; unavailable data stays unavailable rather than zero/healthy.
3. Credential/store/network/configuration failure must not stop local Git work, corrupt the queue or erase last-known-good. Log only safe category codes and retry on the existing bounded cadence.
4. Do not edit `src/commands/daemon.rs` or `tests/async_mode.rs`; Task9b froze their retry contract and Task9c does not need them.

## 3. Port from and reuse

No SushiCorp/catalog component matches endpoint configuration or OS credential storage. Reuse, rather than replace:

- Task9a's exact wire contract at TrackAI PR #16;
- Task4's credential grammar, machine authentication, routing policy, delivery binding and server recheck;
- Task6's activation registry and fail-closed monitor semantics;
- Task14 T14.3's platform secret-store contract;
- GitAI's existing `keyring`, `ApiContext`, telemetry worker and atomic/restrictive-file patterns.

Record these sources and deviations in the GitAI commit bodies and final checkpoint. Public GitAI upstream is not the source for this Task9c design.

## 4. Pre-approved files

- new `src/fleet/**` and module export in `src/lib.rs`;
- new `src/auth/machine_credentials.rs`, plus minimal `src/auth/mod.rs` and `src/auth/credential_backend.rs` changes if shared target-native primitives genuinely reduce duplication;
- bounded `src/metrics/delivery.rs` changes for injected credential resolution and verified policy overlay;
- bounded `src/security/activation.rs` changes for the verified managed source;
- bounded `src/daemon/telemetry_worker.rs` wiring and its colocated tests;
- new `src/commands/fleet.rs`, plus minimal `src/commands/mod.rs`, `src/commands/git_ai_handlers.rs` and help text for non-secret bootstrap installation and stdin credential installation/status/delete;
- `src/config.rs` only if a non-secret fleet-state path/cadence setting is necessary; prefer fixed safe defaults;
- `Cargo.toml`/`Cargo.lock` only for enabling the existing `keyring` dependency or a zeroization helper already in the dependency graph. No unrelated upgrades;
- focused tests under existing GitAI test locations. Add no workflow or packaging edit in Task9c.

## 5. Never touch

- Task9b-owned `src/commands/daemon.rs`, `tests/async_mode.rs`, top-level `mdm/`, `scripts/mdm/`, `packaging/`, or `.github/workflows/**`;
- TrackAI code, APIs, migrations or frozen contracts; Task13 surfaces; update/upgrade/uninstall behavior; Task15 implementation; Linux secret stores/services;
- human OAuth semantics, raw evidence, metric meanings, queue schema, repository URL normalization or server authorization behavior except through the narrow pre-approved adapters;
- no new server endpoint, MDM connector, policy language, generic plugin framework or live support claim.

If Task9a's envelope cannot satisfy an invariant, stop with the exact missing field and smallest proposed follow-up. Do not silently reinterpret it.

## 6. Work plan and tests

### Implementation

1. TDD commits prefixed `Task9c-managed-config-secrets:`: closed wire types/verifier seam; atomic state machine; credential store/CLI; delivery/security projection; telemetry refresh/report. Explicitly stage named paths.
2. Focused tests must prove:
   - exact Task9a 200/204 parsing, unknown/oversized/expired/incompatible rejection and no-store behavior;
   - unavailable/rejected verifier never activates; verified fake activates atomically; write/rename failure preserves active and last-known-good;
   - newer activation and exact retained rollback succeed; arbitrary epoch regression/digest mismatch fail;
   - repository/grant overlay cannot broaden bootstrap routing or cross bindings;
   - bootstrap stdin install rejects unknown/oversized/insecure/duplicate routing, writes atomically and never prints customer routing metadata;
   - Keychain/Credential Manager abstraction has no managed file fallback; missing/locked/wrong-context/load/store/delete failures are safe;
   - stdin installer rejects TTY, oversized/malformed input and never prints the secret;
   - report contains only the closed metadata fields and safe result codes;
   - refresh failures preserve local work, queue and active configuration.
3. Run focused tests during development. Run `task fmt`, `task lint` and the smallest relevant Cargo test filters once the implementation is coherent.

### Final integration

1. Fetch fork `main`, verify the recorded Task9b merge SHA is still an ancestor, rebase if needed and inspect the complete daemon/CLI diff. Resolve no behavior by guessing; Task9b's login-start/retry contract remains intact.
2. Run focused Task9c tests, Task9b's focused daemon/login-start tests, then exactly one full `task fmt`, `task lint`, `task test` and `task build`. Retry only a specifically identified inherited flake.
3. Search the diff and test output for `trk_v1`, `api_key`, `credential`, `secret` and confirm every occurrence is type/validation/prohibition logic or synthetic fixture—not a real value, transport path or log.
4. Re-read the complete diff as an independent reviewer. No native Keychain/Windows success claim comes from mocks or compilation.

## 7. Close-out

- Clean tree; do not push, open a PR or merge.
- Final checkpoint names base and Task9b merge SHAs, commits, exact files/interfaces, focused/full gates, static versus native evidence, actual effort, Task9d inputs and Task15/native-platform limitations.
- Report IT-M9-01 as pending Task15 and IT-T9-02/05 as pending Task9f/Task9g. Task9c engineering may be complete while those claims remain blocked.
- Provide exactly one founder `bash` block that reruns the required focused/full gates, then under `# after the cross-agent review` pushes and opens the GitAI PR with `--repo mahamannu-ux/git-ai`.
- Provide exactly one `text` review request for TrackAI-Orchestrator (or Muse), naming branch, commit(s), worktree, fork-main base, Task9a/Task9b SHAs, completed gates and every remaining native/Task15 gate.

## Lessons to carry forward

- Task4 machine credentials and human OAuth tokens are separate security domains; do not merge their stores or lifecycle.
- Last-known-good protects availability only after verification; it never turns an unsigned candidate into trusted configuration.
- A hosted compile/test proves portable mechanics. macOS Keychain and Windows Credential Manager/DPAPI claims require the later native-host sessions.
- Long Cargo tests should run once at stable checkpoints, not after every small edit.
