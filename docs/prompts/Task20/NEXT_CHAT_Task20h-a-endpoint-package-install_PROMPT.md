# Handoff prompt: Task20h-a-endpoint-package-install (Numbat in the macOS package, managed hooks, health status, offboarding), Codex + founder-live

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge this prompt's docs PR. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only` (Task20b, Task20e and Task20g on the fork's `main`).
> 2. `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20h-a-endpoint-package-install`, open `~/AIProjects/TrackAI-wt/Task20h-a-endpoint-package-install-gitai` in Codex, paste everything below the line.
> 3. You will run the package on the Intel Mac (IT-T20h-01). Paste the review request to the **Task20 lead (Claude)**; push only after "ready to push". Task20h-b (agent inventory and the day-one scan, small) follows as its own session.

---

You are **Codex**, building **Task20h-a-endpoint-package-install** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. You own Task9's package, fleet and cleanup code, so you know this ground.

The Endpoint can now verify and apply signed rules (Task20g) and ship Numbat's records (Task20e), and Task20b builds a reproducible Numbat binary. Nothing yet **puts Numbat on a machine** or wires it into the agents. This session adds Numbat to the macOS package, installs **managed hooks** for the five phase-1 agents (Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI), reports the Endpoint's security health to the server, and removes everything on offboarding. Then it re-runs Task9's paused package checks.

- **Repository:** GitAI fork. **Worktree:** `~/AIProjects/TrackAI-wt/Task20h-a-endpoint-package-install-gitai`, branch `task/Task20h-a-endpoint-package-install-gitai`.
- **Handoff:** returned in your final reply (the Task20 lead copies it into TrackAI). **Estimate:** about 0.25× T6 plus the founder's Mac runs.
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. Read TrackAI's `AGENTS.md` (§1, §2 "Names", §9 items 6, 7, 9, 11, 14), `docs/plan/TASK20.md` (T20.10, §6 budgets, §7 IT rows), `docs/plan/primers/Task20_PRIMER.md` facts 1, 2, 3, 7 and 8, `docs/plan/TASK9.md` decision 10 (the paused package checks), and `docs/TASK6_SECURITY_NUMBAT_LICENSE_PLAN.md` (binary redistribution).
2. In GitAI: `packaging/numbat/README.md` (Task20b), `packaging/macos/` and `mdm/macos/` (yours, Task9), `src/security/{policy_apply,lease_state,shipper,tail}.rs` (Task20g, Task20e).
3. Numbat at the pin (`~/AIProjects/numbat`, read-only, `20a5a52`): `docs/cli.md` "hook install / status / uninstall", `docs/deployment.md` (managed scope, the four-layer health check, output durability), `docs/enforcement.md` (Copilot CLI denies when a hook crashes), `docs/rules.md` (rules-dir loading).
4. Estimate one line against T6, and say at the Stage 1 checkpoint if this should split further.

## 1. Decisions (made by the Task20 lead; the founder's rule: keep it simple, defer what gets stuck)
1. **Binary.** The PKG carries the Task20b `darwin` build (arm64 and amd64, or a universal binary if `lipo` is simpler) with its `LICENSE`, `THIRD_PARTY_LICENSES.txt` and `PROVENANCE.txt`, installed root-owned at one fixed admin path (choose it next to where the PKG puts other root-owned files; say which). The postinstall checks it against `SHA256SUMS` and refuses to install hooks on a mismatch. Change Task20g's `NumbatRulesChecker::installed()` to that path (pre-approved); remove the `~/.git-ai/bin/numbat` guess.
2. **Managed hooks** for the five agents, written by the root postinstall with `numbat hook install --agent <a> --managed --emit all --content preview --no-builtin-rules --rules-dir '$HOME/<internal dir>/security/rules/current/<source agent>' --output-file '$HOME/.numbat/records.ndjson'` (exact flags per `docs/cli.md`; the file must be the one `src/security/shipper.rs` tails). Monitor mode only: never `--enforce` (Task20k). Map Numbat's agent names to the bundle's source-agent folder names in one table in code.
3. **Never break an agent before the first bundle.** Before any bundle is applied, and whenever the lease is `off` or expired, `rules/current` points at a **placeholder** folder that passes `numbat rules check --no-builtin-rules` and enables no rule. Task20g's swap code switches to and from it (extend it, pre-approved). Prove with a real hook call per agent, **Copilot CLI first**, that a hook with the placeholder never denies an action. If no such placeholder exists in Numbat's rule loader, **stop and report** at the checkpoint.
4. **Off is not silent locally:** with `--emit all`, Numbat keeps writing previews of agent actions to the developer's own `records.ndjson` while TrackAI is off; the shipper drops them (Task20e). Phase 1 accepts this: say it in the handoff and in the package README in plain words. Bounding the file's size: if Task20e does not already truncate consumed records, record it as a known limitation, do not build rotation here.
5. **Health status upload.** Once an hour, and after every apply, the daemon builds the contract's Endpoint security status record (`docs/contracts/security-v2/`, the status kind: Numbat version, wired agents, active bundle digest, lease id, last record time and the four layers `hook_status`, `agent_effective_view`, `local_record`, `forwarder_ack` from Numbat's deployment guide) and queues it through Task20e's delivery. Use `numbat hook status --agent <a>` for the hook layer. Honest values only: a layer that cannot be checked is reported as such, never as healthy.
6. **Trust documents.** The PKG installs TrackAI's trust root and key-set documents into `<internal dir>/security/trust/` (Task20g's location) from a file the build is given; the release pin list stays empty until Task15n's production root exists, so a release build stays off (say so). The IT run uses a debug build with Task20g's dev pin file.
7. **Offboarding** (`mdm/macos/cleanup-endpoint.sh` and the Task9 offboard path): `numbat hook uninstall --managed` for each agent, then remove the binary, the security state folder and rules, and report what was removed. The developer's own `~/.numbat/` files are left, and the cleanup output says where they are.
8. **Not in this session:** agent inventory upload and the day-one scan (Task20h-b), Windows (D6.2), enforce mode, package signing and notarization beyond what Task9 already does (Task14).

## 2. Stages
1. **Checkpoint first (no code):** confirm item 3's placeholder works with a real Copilot CLI and Claude Code hook call, the exact admin binary path, and the exact `hook install` lines. Send that to the founder and wait.
2. Package and postinstall: binary, checksum, notices, managed hooks, trust documents.
3. Placeholder and the swap changes in `policy_apply.rs`; health status upload.
4. Offboarding.
5. Founder runs (below), then the Task9 rows.

## 3. Pre-approved files
- `packaging/macos/**`, `packaging/numbat/**` (wiring only), `mdm/macos/**`, `src/security/**` (new `health.rs` or similar; `policy_apply.rs` checker path and placeholder; `mod.rs`), the daemon's existing security tick, tests beside the code.
- TrackAI, separately: a small docs PR `docs/Task20h-task9-resume` updating Task9's tracker rows (you own Task9), as TASK20.md §5 says.
- Never touch `src/trust/**`, `docs/contracts/`, TrackAI code, workflows.

## 4. Tests
- Unit: the agent-name table, the hook command builder, the status record against the contract fixture, placeholder switching on off and expiry, cleanup listing.
- **IT-T20h-01 (founder, Intel Mac, blocking for the merge):** build the PKG with a debug Endpoint, install on a disposable account against a local TrackAI (`scripts/it-db.sh` with Task20f's dev signer), then: health green for each of the five agents that is installed; before the first bundle a Copilot CLI and a Claude Code action both run normally; publish settings and see the bundle applied and `applied` acknowledged; trigger one rule with a harmless command and see the finding in TrackAI; switch monitoring off and see uploads stop; offboard and see hooks, binary and state gone. Write the exact commands.
- **Task9 re-run (IT-T9-02 onward, founder):** the checks Task9 paused, with the new package. Record results in the Task9 docs PR.
- Hook latency against TASK20.md §6's budget, measured once on the Mac.

## 5. Close-out
- Gates: `task build`, `cargo test --lib security`, `cargo test --lib fleet`, `task lint`, `cargo fmt --check`; `git merge origin/main` and rerun them right before the review request.
- Final reply in the AGENTS.md §12.4 shape: effort, the handoff text (under 80 lines, with the admin binary path, the hook lines, the placeholder, the status fields, the off-mode local-file note, IT commands), one bash block, the review request to the Task20 lead.

## Lessons so far
- **Task20g:** a lease refused as `VERIFICATION_UNAVAILABLE` is not retried until the server issues a new lease (about an hour); install the trust documents before the first refresh.
- **Primer fact 8:** Copilot CLI turns a hook crash into a denied action. Every change to rules, binary or hooks is proven against Copilot CLI first.
