# Task17 planning handoff — checkpoint 2

*2026-10-22 · branch `docs/Task17-plan` · planning only. Founder overall approval and Task20 lead plan review received, subject to the three corrections below; no GitAI code or native package has shipped.*

## Scope and founder decisions

Codex completed the 304-commit public Git AI inventory from imported base `a751efd64d12` to upstream `8a6184a3a8fc` against fork `980ef3ef31b0`. The [primer](../plan/primers/Task17_PRIMER.md) records the founder's checkpoint 1 marks. The [ledger](../plan/GITAI_UPSTREAM_LEDGER_2026-10.tsv) has a feature/fix, customer effect, risk, conflict/trial and proposed disposition per commit. The [tracker](../plan/TASK17.md) is the checkpoint 2 wave plan and affected-gates matrix.

T17.2 daemon reliability is first. T17.3 agent identity and T17.4 attribution/metrics follow; T17.5 package rows go to active Task9f for take/reject. T17.6 TokenUsage v2 is the Task13 checkpoint candidate **token and cost reporting**, with ccusage MIT provenance. Synthetic reflog attribution is rejected under the Trace2 evidence rule. Task14 retains release-trust workflow patterns and HTTP-notes defaults.

The 21 former `defer:Task2` rows are resolved as 14 named Task17d Lab decisions (L17-M1/M2 and L17-A1/A2/A3) and seven rejected lite-mode rows. No ledger row defers to finished Tasks 2, 4 or 9. Sixteen package/release rows (the original 14 plus payload permissions and uninstall alias) were offered to Task9f. Its read-only verdict is now in the ledger: four take/adapt concepts for a Task9f-owned follow-up, 11 rejects, one already satisfied. The two most immediate fixes are installer receipt version `acbac7ef86` and payload-root permissions `5b25b11a6`; published-release lifecycle `0cd8ede139` and byte-exact comparison `97074e6577` wait for eligible releases.

## Implementation order and gates

Task17a plan (0.40× T6, locally complete), Task17e package triage (0.12×, complete), Task17b daemon first (0.35×), Task17c agent/config (0.25×), Task17d attribution/metrics (0.38×), Task17f integration (0.30×): **about 1.80× T6 plus founder-live time**. The single GitAI branch is `task/Task17-upstream-sync-gitai`; the founder creates its implementation worktree after the planning PR merges and Claude returns the daemon group verdict. No port has started.

The affected-gates matrix is `TASK17.md` §5. Always run the full GitAI `cargo test`, explicit Task20 security/contract suites, build/lint/format. Daemon and telemetry rerun the Task4 durable-queue restart at `tests/integration/commit_metric_metadata.rs:211`, IT-T20e-01 and IT-M20-02, then E20-01/02/06 and Intel hook latency after Task20j's week. Attribution/metrics use the migrated Task2 Lifecycle Lab after Task14a; evidence changes rerun Task5 evidence checks. Agent identity needs route fixtures and one separate-account live check per affected agent. Packaging/MDM/release changes need Task9 MDM tests and Task9f review. The Task20 lead reviews every group before its port, with extra shared-code review for daemon and telemetry.

Task20 lead's review of `6f67802` required: (1) keep the two-second security worker's policy refresh, shipper poll, status, inventory, flush and day-one scan wiring intact and test it in waves 1 and 3; (2) keep daemon health local in Task17, rejecting `ce5c08ceb`/`8824a16b7` heartbeat upload; and (3) preserve the exact `"daemon_running": false` `bg status` field required by Task20h-a offboarding, adding a wave 1 offboarding dry run and refusal fixture. The tracker and ledger now state these choices. The lead said no plan re-review is needed after these changes; its **daemon group review** is still required before the first port.

The planning PR contains the [Task17b prompt](../prompts/Task17/NEXT_CHAT_Task17b-daemon-reliability_PROMPT.md). Task17a planning is complete locally and closes for delivery when the founder merges this PR. Task17e decision-only package triage is complete in the lead chat; the four accepted concepts belong to Task9f. Task17b begins in a **new Codex chat** on the GitAI integration worktree after the plan PR merges and the daemon group verdict arrives. This Task17 lead chat remains responsible for coordination, review records, the ledger and subsequent prompts.

## Evidence and limits

Phase 1 trial-applied the 242 non-merge upstream commits independently on a disposable fork worktree: 50 textual clean applications, 192 conflicts; 62 merge bookkeeping rows were not applied. These results are a conflict screen only. TrackAI `npm ci` passed. Full `npm test` did not finish because localhost tests hit sandbox `EPERM` and an Attesta test exceeded seven minutes; the focused app CORS test passed 2/2 when localhost binding was allowed. No GitAI product code, package, installer or live Task20/Task9 gate has been changed or run by Task17.

## Interfaces, deviations and integration test impact

**Implemented interfaces:** planning documents only: ledger row schema, Task17 wave ownership and the affected-gates map. No runtime API, package, database schema or contract changed.

**Deviations:** the initial primer's 1.65× estimate is 1.80× after the founder assigned 21 finished-Task deferrals to Task17d. Task9f accepted four concepts for its own follow-up; Task17 will integrate only its separately reviewed result. Task20 lead plan review is complete; group reviews remain.

**Integration test impact:** no new test was added or run by this planning branch. `TASK17.md` §5 names the existing Rust, Task2 Lab, Task5 evidence, Task9 MDM, Task20 shipper and E20 gates to rerun; status remains ⬜ until their owning runs produce evidence.

**Effort:** Task17a planning estimate 0.40× T6; actual planning effort is not yet measured against the T6 turn benchmark. Total remaining Task17 estimate is about 1.40× plus founder-live time, within the overall 1.80× estimate.

## Next gate before the first port

The Task20 lead is Claude and has no identified Codex chat in the local task list. The founder should relay the daemon group packet below and return its group verdict before Task17b ports anything. The founder's overall approval of the plan does not substitute for this per-group review. Task14a's migrated database and Task20j's seven-day run remain later live-gate dependencies.

## Daemon reliability group packet for the Task20 lead

**Request before Task17b ports:** review the 44 daemon/runtime ledger rows below as product and security dependencies. Recommend adapting the trace accept/drain, bounded causal fence and local health fixes; reject synthetic reflog attribution and the lite rewrite series. Do not treat any `adapt` row as a direct cherry-pick. `7b0eead75` is a wave 3 telemetry dependency that also touches this group’s worker.

**Top fixes and customer effect:** `c40c82dca` keeps the trace accept loop responsive under Git activity; `6a7d25a75` recovers a stuck drain; `648f8e92f` avoids processing unused Trace2 frames; `7e8713726` keeps family side effects off ingestion; `2b2920b944` bounds a causal fence. These reduce stalls and silent evidence gaps without changing the rule that unobserved activity remains unknown. `d119b617f`/`04d87b7cd` supply a local daemon health view, while `33b1c701c` and its reflog fixup series remain rejected.

**Invariants for review:** preserve the Task20 security worker’s two-second policy refresh → shipper poll → status → inventory → flush → day-one scan tick (`src/daemon/telemetry_worker.rs:489–542`) in both daemon and telemetry waves; add a focused wiring test. Preserve top-level `"daemon_running": false` after shutdown for `mdm/macos/cleanup-endpoint.sh:100–101`, plus an offboarding dry run/refusal fixture. Preserve the Task4 durable queue, fail-closed lease/security behavior, no-loss metric delivery, Trace2-only provenance and p95 hook latency ≤ 50 ms. Keep health local; no heartbeat health upload in Task17.

| SHA | Proposed disposition | Upstream change |
|---|---|---|
| `f24cee08d0` | `adapt` | fix(daemon): scope checkpoint receive timeout |
| `d6dc68df02` | `reject` | Merge pull request #2049 from git-ai-project/agent/scope-checkpoint-receive-timeout |
| `b5a2c825f6` | `adapt` | fix(daemon): reuse bounded Tokio runtimes |
| `ca28abf7c8` | `adapt` | perf(checkpoint): avoid duplicate working-log materialization |
| `39aec1822e` | `adapt` | fix(daemon): cap glibc allocator arena retention |
| `746f1d92de` | `reject` | Merge pull request #2056 from git-ai-project/fix/jul-30-repro |
| `f3bc913717` | `reject` | Merge pull request #2063 from git-ai-project/fix/checkpoint-working-log-materialization |
| `098f944d35` | `reject` | Merge pull request #2064 from git-ai-project/fix/daemon-allocator-policy |
| `52c908ef35` | `adapt` | perf(daemon): scope sync.family trace fence to requested family |
| `a6a2222325` | `adapt` | test(daemon): await idle control connection closure |
| `abb225a6be` | `reject` | Merge pull request #2068 from git-ai-project/fix/ci-flake-aug-2 |
| `cb748e61d2` | `reject` | Merge pull request #2030 from git-ai-project/fix/per-family-trace-fences |
| `61c607a3cb` | `defer:Task17b` | Add daemon memory limit configuration |
| `8dfef97cc5` | `defer:Task17b` | Enforce daemon peak memory limits |
| `4372b2aa87` | `reject` | Merge pull request #2054 from git-ai-project/feat/daemon-memory-config |
| `5d887410e6` | `reject` | Merge pull request #2055 from git-ai-project/feat/daemon-memory-watchdog |
| `e30a908551` | `reject` | fix: preserve working logs in lite mode |
| `ff6889c9ba` | `reject` | fix: scope lite working-log moves to HEAD |
| `4239896ff3` | `reject` | test: cover lite update-ref working-log handoff |
| `1b7bcc6f67` | `reject` | fix: bound lite working-log handoffs |
| `6f14d157c5` | `reject` | fix: handle multi-step lite ref updates |
| `74969edebb` | `reject` | fix: retain lite rebase conflict logs |
| `7df7e2069f` | `reject` | Merge pull request #2066 from git-ai-project/feat/lite-mode |
| `a2143846d9` | `adapt` | Synchronize wltrace checkpoint assertion |
| `c40c82dca3` | `adapt` | Make the trace accept loop accept-and-spawn only |
| `6a7d25a75f` | `adapt` | Add end-to-end trace drain self-healing to the daemon |
| `648f8e92ff` | `adapt` | Drop unconsumed trace2 frames at ingestion |
| `3c41054e83` | `reject` | Merge branch 'fix/2157-trace-frame-filter' |
| `bcefc3c7d3` | `adapt` | Demote periodic flush-skip log lines to debug |
| `55a1d728fb` | `reject` | Merge pull request #2202 from git-ai-project/fix/quiet-flush-skip-logs |
| `7e87137266` | `adapt` | fix(daemon): never run family side effects inline on the trace ingest worker |
| `4172f156cb` | `adapt` | feat(daemon): log checkpoint admission delayed behind trace ingestion |
| `44cc85b0ad` | `adapt` | test(daemon): fence later work on open trace roots, not sequencer placeholders |
| `88f6f2f6ff` | `adapt` | fix(daemon): replace PendingRoot placeholders with the trace-ingress fence |
| `15c048eade` | `adapt` | test(daemon): bound the family causal fence with a grace window |
| `2b2920b944` | `adapt` | fix(daemon): bound the family causal fence with a grace window |
| `d119b617fe` | `adapt` | test(daemon): expose a daemon health snapshot |
| `04d87b7cd1` | `adapt` | feat(daemon): status.daemon control request and bg status health snapshot |
| `33b1c701c0` | `reject` | feat(daemon): claim untraced commits from the worktree HEAD reflog |
| `fa4a1bb244` | `reject` | feat(daemon): untraced commit fixup pass and fixup.scan control request |
| `e8cf505cb2` | `reject` | feat(daemon): persist repo families and fixup cursors across restarts |
| `db46762000` | `reject` | feat(daemon): periodic untraced commit fixup worker |
| `412e3fd161` | `reject` | feat(daemon): keep temporary repositories out of the untraced fixup |
| `6adc1f2640` | `adapt` | perf(api): cache git author identity resolution with a 30-minute TTL |

**Cross-area rows sharing this worker:** `7b0eead75` adapt only with durable no-loss delivery and all six security tick calls intact; `ce5c08ceb` and `8824a16b7` reject the heartbeat upload (local health only). Their full feature/fix explanations and conflict assessments are in the [ledger](../plan/GITAI_UPSTREAM_LEDGER_2026-10.tsv). Wave 1 gates are in [Task17 §5](../plan/TASK17.md); the same security-worker test reruns in wave 3. Please return accept/change/reject for this group and flag any Task20 claim or gate that needs correction before the first port.

The founder, not this Task, pushes or merges the planning branch and later fork PR. A separate independent plan review is requested before push under `docs/agents/TASK_LEAD_PROCEDURE.md`.
