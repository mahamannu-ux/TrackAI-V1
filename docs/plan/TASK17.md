# Task17 — selective GitAI upstream sync

*Planning checkpoint 2, 2026-10-22. Status: 🟡 plan approved with Task20 lead corrections; daemon group review is next. Founder checkpoint 1 is recorded in [the primer](primers/Task17_PRIMER.md); no upstream code has been ported.*

## 1. Boundary and decision rule

The imported common base is `a751efd64d12`; the reviewed public head is `8a6184a3a8fc` and fork head at inventory time is `980ef3ef31b0`. The [304-row ledger](GITAI_UPSTREAM_LEDGER_2026-10.tsv) records each upstream commit's feature or fix, fork collision, first-pass trial application, and proposed disposition. The 2026-10-09 inventory is historical; its 302 count and earlier priority order are superseded by this ledger. A row marked `adapt` is a candidate, never authorization to cherry-pick. A row marked `defer:Task17d` is an explicit Lab decision queued within this Task, not a deferral to finished Task2. Each row selected for code receives the adoption record in `GITAI_UPSTREAM_INVENTORY_2026-10-09.md` before porting.

Founder decisions: T17.1, T17.2, T17.3, T17.4, T17.5 and T17.7 kept; T17.2 is the first implementation wave; T17.4 absorbs all 21 former `defer:Task2` rows; T17.5 sends package candidates to active Task9f; T17.6 TokenUsage v2 is deferred to Task13 as the product candidate **token and cost reporting**. Record ccusage's MIT license alongside Git AI Apache-2.0 provenance if Task13 later selects it. Synthetic reflog attribution (`33b1c701c` series) is rejected: it would claim provenance from activity not observed by Trace2.

Task20 lead review of planning commit `6f67802` added three constraints before push. **Security worker:** `spawn_security_shipper_worker` in GitAI `src/daemon/telemetry_worker.rs:489` keeps its two-second tick and all six actions: policy refresh, shipper poll, status queue, inventory queue, security flush, and day-one scan spawn. **Health:** Task17 keeps daemon health local in `bg status`; the upload portions of `ce5c08ceb` and `8824a16b7` are rejected because they would change TrackAI's telemetry contract and privacy surface. A future upload would need a separately owned TrackAI contract session and privacy review before Endpoint adoption. **Offboarding:** `bg status` keeps the exact top-level JSON field `"daemon_running": false` after shutdown, which `mdm/macos/cleanup-endpoint.sh:100-101` requires before deleting security state.

## 2. Master matrix at checkpoint 2

These are planning dispositions, not shipped results. Counts include merge bookkeeping rows. Task9f returned a read-only take/reject review on 2026-10-22; its four accepted concepts remain Task9f-owned follow-up work, and no package port is authorized in Task17.

| Group | Rows and current disposition | Wave / owner | Main decision and evidence |
|---|---|---|---|
| Daemon/runtime | 20 adapt; 22 reject; 2 Task17b review | 1 / Codex | Trace accept, drain recovery, frame filtering and causal ordering; memory limits assessed with Task20 lead. Preserve no wrapper, no per-commit spawn and security lease behavior. |
| Agent/editor and config/auth | Agent 10 adapt, 12 Task13, 16 reject; config 6 adapt, 2 reject | 2 / Codex | Identity/model fixes and bounded config/path fixes; affected route fixtures and live checks. Task13 decides broader host coverage. |
| Metrics/telemetry | 5 adapt; 11 Task17d Lab; 6 reject | 3 / Codex | Durable, no-loss offloading and local health only. Reingest and agent-usage throttling need L17-M1/M2 before/after results; no heartbeat health upload. |
| Attribution/notes | 2 adapt; 3 Task17d Lab; 2 Task14; 8 reject | 4 / Codex | Known-human/AI and recovered edge semantics need L17-A1/A2/A3. HTTP-notes defaults stay Task14. |
| TokenUsage v2 | 92 Task13; 3 reject merge rows | Task13 checkpoint / Codex lead | New event, transcript reads, persistence, price and privacy contract; no Task17 port. |
| MDM login start | 15 reject | Already handled / Task9b | No second port of managed login start. |
| Packaging/release | 4 Task9f take/adapt; 17 reject/no-op | Task9f follow-up / Task9f lead | The original 14 Task9 rows plus payload permissions and uninstall alias received take/reject review. Task17 only consumes a merged Task9f result. |
| CI/deps/docs and other | 38 reject, 3 Task14; 5 other reject | Task14 or none | Workflow trust patterns remain Task14; upstream release/version churn has no automatic fork value. |

The former 21 Task2 rows are now **14 Task17d Lab decisions and 7 reasoned rejects** (the lite rewrite series lacks a demonstrated TrackAI need and would introduce a second notes/log handoff). There are zero `defer:Task2`, `defer:Task4` or `defer:Task9` rows. All 14 former Task9 rows were reviewed by active Task9f: four of the 16 offered rows were accepted as Task9f follow-up concepts, 11 rejected, and one already satisfied (recorded as `reject`/no-op).

Task9f accepted `acbac7ef86` (macOS receipt version) with `5b25b11a6` (payload root `0755`), and the adapted published-release lifecycle and byte-exact comparison ideas from `0cd8ede139` and `97074e6577`. The latter two wait for eligible releases. Task9f rejected the `install-hooks --env` and WSL chains, the asset-drift-as-warning change, and the misleading `uninstall` alias; `7901a3593e` is already satisfied. The Task9f lead suggested implementing the published-release checks in a Task17 package wave; the founder assigned package rows to Task9f, so this plan keeps ownership with Task9f and would integrate only a separately reviewed, merged follow-up.

## 3. Lab decision cases for Task17d

Run each case against the same fully migrated disposable database after Task14a. Save before/after counts and evidence pointers; an improvement in one number never licenses a change in Generated/Committed meaning. Task17d records adopt/adapt/reject for each of its 14 ledger rows and Claude signs off any semantic change before port.

| Case | Candidate rows | Before/after observations |
|---|---|---|
| L17-M1: usage throttle | `d0f864c570` | Burst of checkpoints within and across 150 seconds: agent-usage events, timestamps, tool/model/cost, and checkpoint latency. |
| L17-M2: reingest/replay | `6210ebff3b`, `0a1afdd26c`, `98c27b210d`, `2be4851036`, `e11298f8d0`, `0389b48c53`, `65e22252ab`, `28cc324c2f`, `898567e747`, `879a39233e` | Previously delivered plus pending metrics; offline/restart, reingest twice, then server reconciliation. Compare unique rows, event time, model, Generated/Committed, retention and delivered queue. Formatting/test rows follow the parent decision. |
| L17-A1: unknown line recovery | `1e400d552a` | Known human, AI and untraced edits next to each other: note labels, unknown share, Generated/Committed and evidence pointers. |
| L17-A2: range authorship | `4dc3b1ccf1` | Human additions and AI deletions across two commits: range totals, line labels and evidence pointers. |
| L17-A3: recovered edge metric | `120bcf25cf` | Known tool/model beside recovered edge and unknown neighbor: model attribution without inventing a session. |

The seven lite mode commits (`2cbdfd3b53`, `e30a908551`, `ff6889c9ba`, `4239896ff3`, `1b7bcc6f67`, `6f14d157c5`, `74969edebb`) are rejected for now, with row-level reasons in the ledger. Any later proposal must name a current owner and Lab scenarios for ref updates, rebase conflicts and working-log retention.

## 4. Sessions and waves

One GitAI integration branch: `task/Task17-upstream-sync-gitai`. Keep it current with fork `origin/main`, make small source-attributed commits by wave, and open one fork PR only after the gates below. Upstream is read-only. Founder approved the overall wave plan; **no session ports its group before Task20 lead Claude reviews that group's summary and ledger rows**. Daemon and telemetry waves additionally require the lead's code review of the shared Task20 security surface. The daemon packet is in `docs/handoffs/Task17-plan_HANDOFF.md`; if no direct Claude chat is available, the founder relays it and returns the verdict before the first port.

| Session / order | T17 pieces | Agent; estimate vs T6 | Dependencies | Planned files / boundary |
|---|---|---|---|---|
| Task17a-plan, locally complete; PR delivery pending | 1, 6 decision | Codex lead; 0.40× | Founder and Task20 lead approved plan with recorded corrections | TrackAI primer, ledger, tracker, board, handoff and next-session prompt. No GitAI product code. Close delivery when founder merges the plan PR. |
| Task17e-package-triage, complete within lead chat | 5 | Codex lead + Task9f lead; 0.12× | Task9f read-only take/reject review received | Sixteen package rows decided; four accepted concepts remain Task9f-owned. This triage needs no separate Task17 implementation chat. |
| Task17b-daemon-reliability, **first port in new chat** | 2; wave 1 | Codex; 0.35× | Plan PR merged; Claude daemon group verdict and shared-code review | GitAI `src/daemon*`, trace worker, daemon integration tests. Preserve security-worker wiring and `bg status` offboarding field; no new synthetic provenance. Prompt: `docs/prompts/Task17/NEXT_CHAT_Task17b-daemon-reliability_PROMPT.md`. |
| Task17c-agent-config, wave 2 | 3 plus selected config/auth | Codex; 0.25× | Wave 1 rebased; Claude group review | GitAI agent presets, streams/model extraction, config and route fixtures. No new supported-route claim. |
| Task17d-attribution-metrics, waves 3–4 | 4 and all former Task2 rows | Codex; 0.38× | Task14a migrated Lab database; earlier waves; Claude semantic and shared-code review | GitAI metrics, attribution, notes and telemetry worker; TrackAI Lab evidence only, no application/contract edits. Split a code slice if the 0.4× ceiling is exceeded. |
| Task17f-integration, final | 7 | Codex + founder-live; 0.30× | Waves reviewed; Task20j week ends for native package checks; Task9f follow-up ownership recorded | GitAI tests and one PR; TrackAI ledger, tracker and handoff evidence. |

**Estimate:** about 1.80× T6 plus founder-live time, increased from the primer's 1.65× because Task17d now owns the 21 former Task2 rows and config/auth is explicit. This is a planning estimate. TokenUsage implementation is excluded. The first port is Task17b; Task17e triage has already finished without changing code.

**Chat ownership:** this Task17 lead chat owns the ledger, wave sequencing, cross-Task coordination, review decisions and later session prompts. Task17b/c/d/f are separate implementation chats, started sequentially on the same GitAI integration worktree and branch. Each returns a handoff to this lead before the next chat starts. Task17e was decision-only triage completed here with the Task9f lead; Task9f owns any package implementation.

## 5. Affected gates — rerun on the integration branch

A gate's presence here does not mean it has passed. After each wave, run its affected focused tests. Before the single PR, run the full GitAI `cargo test` and the Task20 suites on the combined branch, even where a focused suite passed earlier. The Task20 lead reviews the exact diff of daemon and telemetry waves. Use the current Task20j acceptance runbook after its week, and preserve each test's own blocking status.

| Wave | Fork areas touched | Earlier tests and integration rows to rerun |
|---|---|---|
| **All code waves and final combination** | Cross-cutting fork Tasks 4, 5, 6, 9, 20 | `task build`; `task lint` with the repository-pinned Rust toolchain (classify inherited findings separately); `cargo fmt --check`; **full `cargo test`**; explicit `cargo test --lib security`, `cargo test --lib fleet`, `cargo test --test security_v2_contract`, `cargo test --test mdm_scripts`. This includes the earlier Task4/5/6/9/20 Rust tests but does not replace live IT. |
| 1 daemon reliability | Trace2 accept/drain, checkpoint ordering, `src/daemon*`, Task20 lease/security hooks if diff touches them | Daemon and Trace2 integration tests, Task4 durable-queue restart at `tests/integration/commit_metric_metadata.rs:211`; focused **security-worker tick-wiring test** proves the two-second tick still invokes policy refresh, shipper poll, status, inventory, flush and day-one scan spawn. `bg status` fixture preserves top-level `"daemon_running": false` after shutdown; **macOS offboarding dry run** plus an apply-path refusal fixture ensure absent/true status retains security state. **IT-T20e-01 and IT-M20-02** Endpoint shipper against real server. After Task20j's seven-day run, **E20-01, E20-02, E20-06** and Intel-Mac hook latency p95 ≤ 50 ms (`packaging/numbat/measure.sh`). Separate account/per-user debug binary before that; no everyday-account install during the week. |
| 2 agent identity and config | Agent presets, model extraction, route handling, config/auth/Unicode paths | Route fixtures and affected-agent integration tests; one live check **per affected agent** in a separate macOS account, with actual model/host/capture channel recorded. If package/config/`mdm`/release paths change, also Task9 MDM script tests, Task9f review and relevant IT-T9-02/03; no route-support claim from fixtures alone. |
| 3 telemetry | Metrics queue, checkpoint emission, `src/daemon/telemetry_worker.rs`, Task20 security delivery shared files if touched | Rerun the **security-worker tick-wiring test** and verify the unchanged two-second policy refresh, shipper poll, status, inventory, flush and day-one scan sequence. Keep daemon health local; assert no new health fields in the uploaded heartbeat. Task4 durable-queue restart `commit_metric_metadata.rs:211`; offline/restart/dedup and Task20 security/contract suites; **IT-T20e-01 and IT-M20-02**. After Task20j week, **E20-01/02/06** and hook latency. L17-M1/M2 before/after on migrated Lab database after Task14a for any metric-meaning change. |
| 4 attribution and notes | Authorship labels, notes transport, local stats/evidence paths | Task2 Lifecycle Lab L17-A1/A2/A3 on fully migrated database **after Task14a**; Task5 evidence path and `verify:task5-{graph-live,corpus,opencode,retention,analytics,semantic}-live` **if evidence code or server evidence behavior changes**. Check source pointers and privacy constraints. |
| Conditional Task9f package handoff | `packaging/**`, `mdm/**`, release workflow, installer payload/version metadata | Task9 MDM script tests (`cargo test --test mdm_scripts`), Task9f take/reject review and accepted follow-up, package flavour registry and native signed-package/IT-T9 gates appropriate to the accepted change. If Task17's integration branch imports such a diff, repeat these there. |

The founder's Intel Mac during Task20j's week is protected: no Task17 PKG on the everyday account. Live checks use a separate macOS account and per-user debug binary after proving which database the daemon opens. Package-built E20 and latency reruns occur only after the week. `E20-01/02/06` and `IT-T20e-01`/`IT-M20-02` need founder or task-owner evidence; a local unit pass cannot mark them green.

## 6. Review, evidence and completion boundary

- Before **each group** is ported, send its primer summary and ledger rows to Task20 lead Claude; record its accept/change/reject verdict and customer/metric reasoning. For daemon and telemetry, obtain shared-file code review too. The plan review is complete; no per-group port verdict is recorded yet.
- Each adopted/adapted SHA gets an adoption record: upstream SHA/PR and license, user benefit or bug, fork conflict, exact implementation commit, focused tests, changed contracts, native evidence and reviewer verdict. Reject/no-op rows retain the ledger reason.
- Task9f reviewed its 16 offered rows (four take/adapt, 11 reject, one already satisfied); Task14 keeps workflow release-trust patterns and HTTP-notes defaults. Task13 checkpoint decides token and cost reporting with ccusage MIT notice, privacy/server event and outage semantics. No deferrals to completed Tasks.
- Task17 is ✅ only when the 304 ledger rows have final dispositions, every selected port and affected gate has evidence, Claude group reviews are recorded, Task17f integration passes, and the one fork PR is merged by the founder. Until then this document reports 🟡 planning or execution status only.
