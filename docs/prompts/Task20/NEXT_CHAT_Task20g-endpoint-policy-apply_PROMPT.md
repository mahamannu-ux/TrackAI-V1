# Handoff prompt: Task20g-endpoint-policy-apply (verify and apply the signed lease and rule bundle on the Endpoint), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge this prompt's PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only` (Task20c and Task20e must be on the fork's `main`).
> 2. `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20g-endpoint-policy-apply`, then open `~/AIProjects/TrackAI-wt/Task20g-endpoint-policy-apply-gitai` in Codex and paste everything below the line.
> 3. Codex owns Task9's fleet code, so no separate Task9 review is needed. This is signing and activation, so paste the review request to the **Task20 lead (Claude)**. Push only after "ready to push".

---

You are **Codex**, building **Task20g-endpoint-policy-apply** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

The server (Task20f, merged) signs, per machine, an **activation lease** (`trackai.security-activation-lease/2`, 72 h, reissued when settings change and reused while under 1 h old) and, per tenant, a **rule bundle** (`trackai.security-rule-bundle/1`). The fleet configuration v3 points at the current lease. Task20c (merged) gave the Endpoint a Rust `verify_trusted`. Task20e (merged) gave it the shipper, which reads the lease through a `SecurityLeaseContext` trait; production still uses `UnavailableLeaseContext`, so today the Endpoint ships nothing.

This session makes the Endpoint **fetch, verify and apply** the lease and the bundle, keep a last-known-good copy, fall back to off when it must, acknowledge or refuse each lease, and replace `UnavailableLeaseContext` with the real one. Success: a tampered, expired, replayed, foreign or broken lease or bundle never activates, and a good one does, with the server recording `applied`.

It does **not** install Numbat, hooks or the package (Task20h), block anything (Task20k), add a server route, or change TrackAI.

- **Repository:** GitAI fork. **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task20g-endpoint-policy-apply-gitai`, branch `task/Task20g-endpoint-policy-apply-gitai`.
- **Handoff:** returned in your final reply (no TrackAI files in GitAI). The Task20 lead copies it into TrackAI.
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. Read TrackAI's `AGENTS.md` (`git -C ~/AIProjects/TrackAI-v1 show main:AGENTS.md`), especially §1, §2 "Names", §9 items 6, 7, 9, 14 and 19, §12.4. Then this repository's `AGENTS.md` and `Taskfile.yml`.
2. `pwd && git branch --show-current && git log --oneline -1`; identity `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only.
3. Baseline: `task build`, `cargo test --test trust_vectors`, `cargo test --lib security`, `cargo test --lib fleet`.
4. Estimate: one line against T6. The plan says **about 0.20×**.

## 1. Read before writing
From TrackAI `main` (`git -C ~/AIProjects/TrackAI-v1 show main:<path>`):
- `docs/handoffs/Task20f-security-settings-signing_HANDOFF.md`, section **"What Task20g must verify on the Endpoint"**: this is your checklist;
- `docs/contracts/security-v2/`: `README.md` (lease, bundle, acknowledgement), `api.md` (the three machine routes, cases 3–8), `errors.md`, `security-activation-lease-v2.schema.json`, `security-rule-bundle-v1.schema.json`, `security-acknowledgement-v1.schema.json` (the closed `refusal_code` set), `fleet-configuration-v3.schema.json`, and `fixtures/`;
- `docs/contracts/attesta/trust.md` "Consumers" and "Verification";
- `docs/plan/TASK20.md` §3 and the T20.9 row.

In this repository: `src/trust/` (Task20c), `src/security/` (Task20e: the `SecurityLeaseContext` trait, `LeaseSnapshot`, the shipper's use of `current()` and `issued()`), `src/fleet/mod.rs` (configuration parsing, the managed credential and HTTP client you reuse), and the current caller of the security refresh in the daemon.

Numbat at the pin (`~/AIProjects/numbat`, read-only, commit `20a5a52`): find the exact `rules check` command and flags, and how Numbat is pointed at a rules folder.

## 2. Scope (decisions made by the Task20 lead; the founder's rule: keep it simple, defer what gets stuck)
### 2.1 Decisions
1. **Fetch.** Refresh hourly and whenever a fleet configuration with a new `securityLease.leaseId` arrives: `GET /worker/security/v2/lease`, then `GET /worker/security/v2/bundles/{bundle_digest}` only when that digest is not already applied. Reuse the fleet HTTP client and the managed credential; never send a tenant or machine id. `404 SECURITY_V2_LEASE_NOT_ISSUED` means no lease: keep the current state until it expires. Network and 5xx errors: keep the current state and retry with backoff.
2. **Verify the lease** before parsing its payload: `verify_trusted` with purpose `activation_lease`, audience `platform`, `signed_at` = the payload's `issued_at`, and `production: true` hard-coded. Then check, in order, mapping each failure to the acknowledgement `refusal_code`:
   - `rejected` → `SIGNATURE_REJECTED`; `unavailable` → `VERIFICATION_UNAVAILABLE` (stay off, retry; trust.md);
   - unknown `schema_version` → `UNSUPPORTED_SCHEMA`;
   - `tenant_id` / `machine_id` differ from the enrolled identity → `TENANT_MISMATCH` / `MACHINE_MISMATCH`;
   - not `issued_at <= now < expires_at` → `LEASE_EXPIRED`;
   - **replay:** a lease whose `issued_at` is older than the newest accepted lease is ignored and not acknowledged (identical bytes from the 1 h reuse are a no-op, not a replay).
3. **Verify the bundle:** `verify_trusted` with purpose `policy_bundle`; SHA-256 of the decoded payload equals the lease's `bundle_digest` (`BUNDLE_DIGEST_MISMATCH`); `epoch` not below the last applied (`EPOCH_REGRESSION`); every file's `sha256` matches its decoded bytes and its `path` passes the schema pattern again (`BUNDLE_DIGEST_MISMATCH`); then `rules check` on the staged folder (`RULES_CHECK_FAILED`).
4. **Apply** atomically: write each agent's files to `<security state dir>/rules/<epoch>-<first 12 hex of digest>/<agent>/`, run the check, then switch a `current` symlink with a rename. Keep the previous folder as **last-known-good** and delete older ones. Task20h points Numbat's hooks at `<security state dir>/rules/current/<agent>/`; write that path into the handoff. Use the existing GitAI data directory for the state dir.
5. **Rules check behind a trait** (`RulesChecker`). The production implementation runs the Numbat binary from one resolver function that returns `None` until Task20h installs Numbat at its fixed path. **No binary means "not checkable"**: do not activate the new bundle, do not acknowledge, keep last-known-good, retry on the next refresh. Tests inject a fake checker.
6. **Fallback.** A refused new lease or bundle never replaces what is running: the previous accepted lease and its bundle stay in force **until that lease's own `expires_at`**, then the Endpoint is off. Nothing valid → off (`current()` returns `None`, so the shipper drops records, as built in Task20e). `mode: off` → off, applied and acknowledged. `monitor_and_pilot_block` is applied **as monitor**: nothing blocks in this session (Task20k); say so in the handoff.
7. **Acknowledge** every verified-or-refused lease once: `POST /worker/security/v2/acknowledgements` with `trackai.security-acknowledgement/1`, `applied` naming the lease's own digest, or `refused` with the code. Persist "acknowledged" so restarts do not resend; retry a failed POST with backoff. A refusal that can't be tied to a parsed lease (signature rejected before parsing) reports the `lease_id` and digest only if they are readable from the fleet `securityLease`; otherwise skip the acknowledgement and count it.
8. **Real `SecurityLeaseContext`:** `current()` returns the accepted lease while `now < expires_at` and mode is not off; `issued(lease_id)` returns any accepted lease from the last 7 days, so a record detected under the previous lease is still stamped with it (Task20e). Keep at most 20 entries.
9. **Persistence:** one JSON state file in the state dir, written atomically (temp file, fsync, rename): accepted leases (bytes as signed), applied epoch and digest, acknowledgement status, and the trust state's `last_trusted` and `trusted_time_floor`, persisted after every accepted result and never moved backwards (trust.md "Consumers"). A missing or corrupt file means off, never a guess.
10. **Trust documents (phase 1).** There is no server route for root and key-set documents yet. The Endpoint reads them from `<security state dir>/trust/` (root and key-set documents as JSON), which Task20h installs with the package. The pinned root key ids are a **compile-time constant**, empty in this session, so a release build is `unavailable` and stays off until Task15n's production root is pinned (Task20h/Task15n fill it). Debug builds (`cfg(debug_assertions)`) may also read a dev pin file in the state dir for IT-T20g-01; release builds never read it, nor an environment variable. Distributing new key sets without a reinstall is **phase 2** (record it as a gap in the handoff).
11. **Fleet v3.** Parse configuration schema version 3 and its `securityLease {leaseId, bundleDigest, expiresAt}` in `src/fleet/`; v1 and v2 keep working, and their `securityActivation` is treated as off (fail-closed). `securityLease` is only a hint for when to fetch; the signed lease decides.
12. **Logging:** codes, counts, epochs and digests only; never file contents, rules or raw records.

### 2.2 Port from
- None for new code beyond the TrackAI side: the checks mirror Task20f's `lease.test.ts` cases and `trust.md` "Consumers"; reuse `src/trust/`, the fleet client and Task20e's delivery backoff rather than writing new ones. Keep `src/trust/` untouched.

### 2.3 Pre-approved files
- new `src/security/policy_apply.rs` (fetch, verify, stage, check, swap, acknowledge) and `src/security/lease_state.rs` (persistence, the real `SecurityLeaseContext`); `src/security/mod.rs` and `activation.rs` (wiring, replacing `UnavailableLeaseContext` in production);
- `src/fleet/mod.rs` (v3 parsing; Task9-owned, same agent), and the daemon's existing security-refresh call site (one call swap);
- tests beside the code, plus `tests/fixtures/security_v2/` (copies of the contract fixtures, with a `SOURCE.md` naming the TrackAI commit).
- No new crates.

### 2.4 Never touch
- `src/trust/**`, packaging, `mdm/`, hooks, workflows, TrackAI. If the work needs one, stop and say so.

## 3. Tests (unit, no network)
Use a local in-process HTTP stub and keys generated in the test (the same way the TrackAI trust fixture does: a root, a `policy_bundle` key and an `activation_lease` key, the key sets signed by the root). Cover:
- happy path: lease and bundle verified, staged, checked, swapped, `applied` sent once, `current()` returns it, restart restores it from the state file;
- each refusal code in 2.1 items 2–3, each leaving the previous state running and sending `refused` with that code;
- replayed older lease ignored; identical reused lease a no-op; `mode: off`; lease expiry with no renewal → off;
- broken bundle (file hash wrong, path escaping the folder, epoch regression), checker fails, checker absent;
- verification unavailable (no trust documents, empty pin) → off, nothing applied;
- corrupt state file → off; `trusted_time_floor` never moves backwards;
- fleet v1, v2, v3 parsing; `issued()` finds the previous lease.

## 4. Integration test (founder-run, non-blocking for the merge, blocking for Task20h)
**IT-T20g-01:** a debug Endpoint build against a local TrackAI API (`scripts/it-db.sh` with Task20f's dev signer and settings CLI): enroll, publish settings, fetch, verify, apply, `applied` visible in `security_acknowledgements`; then publish a change and see the new epoch applied; then tamper with a stored bundle row and see `refused`. Write the exact founder commands in the handoff; the Numbat check uses the fake checker unless a local Numbat build is on `PATH` in debug builds.

## 5. Working rules
- Commits `Task20g: …`, one per stage: (1) state file and lease context with tests; (2) verify and refusal mapping; (3) stage, check, swap, last-known-good; (4) fetch loop, acknowledgements, fleet v3, wiring.
- Gates: `cargo test --lib security`, `cargo test --lib fleet`, `cargo test --test trust_vectors`, `task lint`, `cargo fmt --check`. Inherited Clippy and flaky `daemon_mode` noise is not yours (AGENTS.md §9 item 14).
- Independent review: a fresh thread or `/review` before the final reply.

## 6. Close-out
Final reply in the AGENTS.md §12.4 shape:
1. Effort against 0.20×.
2. The handoff text (under 80 lines): the rules path for Task20h, the state-dir layout, the trust-document location, the refusal mapping, every gap (key-set distribution, pin empty, `monitor_and_pilot_block` as monitor), IT-T20g-01 commands.
3. One bash block: cd to the worktree, the gates, then under `# after the cross-agent review`: push, `gh pr create --base main --head task/Task20g-endpoint-policy-apply-gitai --title "[Task20g] Endpoint policy apply" --body "<handoff text>" --repo mahamannu-ux/git-ai`, a trial merge of `origin/main`, `gh pr merge … --merge`.
4. The review request in a `text` block, addressed to the Task20 lead.
- Clean tree. Do not push, open a PR or merge.

## Lessons so far
- **Task20e:** a lease-bound record must keep the lease current at its detection time, not at upload time; that is why `issued()` keeps recent leases.
- **Task15l:** missing trust information is `unavailable`, tampering is `rejected`; never collapse the two, and never let `unavailable` activate anything.
- **Task20f / Task15op0:** two PRs that each passed alone broke `main` together (a cap raised in one, a test assuming the old cap in the other). Merge `origin/main` into your branch and rerun the gates right before the review request.
