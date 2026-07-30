# Task2 — Lifecycle Metrics and SCM Correctness

**Authoritative Task2 tracker**
Last updated: **2026-07-30**

Cross-task tracker: [`TASK4.md`](TASK4.md)
Post-E13 handoff: [`docs/handoffs/TASK2_TO_TASK4.md`](docs/handoffs/TASK2_TO_TASK4.md)
Portfolio roadmap: [`ROUGH_ROADMAP.md`](ROUGH_ROADMAP.md)
Git AI patch inventory: [`docs/GIT_AI_TASK2_CHANGES.md`](docs/GIT_AI_TASK2_CHANGES.md)

Task3 is retired. Its completed dashboard/schema work belongs to Task1;
lifecycle correctness belongs here; delivery, security and policy belong to
Task4. `TASK2_RUNBOOK.md` contains commands and operational detail, while this
file is the single source of truth for scope and status.

## Status legend

| Symbol | Meaning |
|---|---|
| 🟢 ✅ | Complete for the stated scope and manually verified live |
| 🟡 ◐ | Partially complete, automated-test-only, or more scenarios remain |
| 🔴 ☐ | Not implemented or not yet tested |
| ⚪ — | Not applicable |

“Verified” means observed in the controlled dashboard/terminal experiment,
not merely covered by a unit test.

For the controlled test register, 🟢 means the **current implementation passed
acceptance**. 🟡 means the discovery run is complete but a post-fix acceptance
rerun or a known edge remains. A completed experiment is not automatically a
product pass.

## Master Task2 matrix

| ID | Deliverable | Implemented | Tested & verified | Test # | Current evidence / remaining work |
|---|---|---:|---:|---|---|
| **T2.6** | Normalize amend, rebase, cherry-pick, squash, reset and revert events with predecessors | 🟢 ✅ | 🟢 ✅ | E7, E8, E12, E15 | Core rewrite normalization is complete and live-verified for amend/force-push, squash, soft/mixed/hard reset-recommit and deletion-only revert. Immutable predecessor/successor evidence and `recommit_after_reset` inference reconcile without duplication. Git AI emits reset evidence when a successor is created rather than at reset time by design. Advanced local cherry-pick/rebase variants remain under T2.22/E16 and do not block this core contract. |
| **T2.7** | Safe customer-visible session naming without prompt text | 🟢 ✅ | 🟢 ✅ | E1–E4, E6, E15-B10 | Deterministic fallback names and external conversation identity display without raw prompts. E15 confirmed one external conversation can resume after a commit and contribute to later commits; the temporary `open/shipped` UI should eventually represent “has shipped work” rather than a terminal session state, then move into PR evidence drill-down. |
| **T2.8** | Reconcile repo-less usage/checkpoint events with later sessions, Notes and commits | 🟢 ✅ | 🟢 ✅ | E1–E4, E13, E15-B1 | Session, Note, model-segment and later-commit correlation works. E15 proved multiple model-specific Git AI sessions collapse into one external conversation without overwriting retained contributions (268 + 140 = 408). Antigravity independently confirmed three model-specific session events and five checkpoints. Operational delayed-delivery ordering belongs to Task4. |
| **T2.9** | Clean AI session → commit → upload → dashboard path | 🟢 ✅ | 🟢 ✅ | E4, E5, E11, E15 | Company A and Company B paths passed. After E11 exposed a global-key cross-tenant hazard, fail-closed enrolled-repository validation was implemented and live-verified: a Company B repository event carrying Company A's valid key was rejected before raw storage. The clean-slate E15 run then proved live edit → session → local commit → push → PR → dashboard. |
| **T2.10** | Preserve observed evidence while applying visible audited corrections/exclusions | 🟢 ✅ | 🟢 ✅ | Task1 seed, E4, E15 | Immutable observed rows, explicit correction overlays, availability labels and exclusion behavior are implemented. Seed corrections and live observed lifecycle values were verified without overwriting source evidence. Additional correction types use the same field-level overlay contract. |
| **T2.11a** | Fix stale model attribution after an in-session OpenCode model switch | 🟢 ✅ | 🟢 ✅ | E13a | Post-fix live verification passed in one external OpenCode conversation: DeepSeek and Nemotron retained distinct model-attribution segments, with one kind-2 session event, four kind-4 checkpoints and 20 kind-5 usage events. No stale model attribution was observed. |
| **T2.11b** | Fix Copilot multi-file and manually accepted AI lines falsely classified as human | 🟢 ✅ | 🟢 ✅ | E3, E4, E15-B2 | E15-B2 verified multi-file gross generation (145), accepted retention (141), full Discard generation (7 with no retained file), and a post-fix accepted `create_file` proposal (7 AI lines). Git AI reconstructs both replace-style and create-file proposals before persistence or Keep/Discard; focused Rust regressions and live checkpoints pass. Partial per-hunk acceptance remains an advanced compatibility case, not a blocker for this defect. |
| **T2.11c** | Fix missing OpenCode usage/transcript events | 🟢 ✅ | 🟢 ✅ | E1, E2 | External OpenCode session lookup fixed; 321K-token conversation evidence displayed live. |
| **T2.11d** | Capture complete-file deletions as actor-attributed checkpoints | 🟢 ✅ | 🟢 ✅ | E12a, E15-B10 | E15 verified live full-file AI deletion through OpenCode/bash (85 lines), a later human deletion of inherited AI lines (3 lines), and exact actor/file correlation. Git AI now retains deleted path identities; TrackAI walks parent lineage newest-first so unrelated intermediate commits cannot erase inherited ownership. Tenant totals reconciled to 738 Generated, 690 Committed, 133 Reworked and 598 Final AI while PR #3 remained isolated at 624/576/45/572. |
| **T2.11e** | Capture and correlate Copilot token usage across conversation/model restarts | 🔴 ☐ | 🟡 ◐ | E15-B2, E13 | E15 reproduced a clean evidence gap: the original `mai-code-1-flash` conversation has 16 usage rows and 1,403,494 tokens, while a new GPT-4.1 conversation emitted transcript/checkpoint and tool spans but no token-bearing `chat`/`invoke_agent` span. TrackAI correctly displays `Unavailable`; provider/stream capture and late-correlation behavior remain to implement and test across Copilot models. |
| **T2.11f** | Correct Git AI working-tree human/unknown status reporting | 🟢 ✅ | 🟢 ✅ | E15-B6, E19 | Git AI status gives `h_` KnownHuman working-tree ranges precedence over Unknown and marks both `Human` and `KnownHuman` checkpoints as human. Both focused integration regressions passed on the developer machine. Live manual addition and deletion produced zero Unknown lines and human checkpoints with `is_human: true`. |
| **T2.11g** | Capture Antigravity token, prompt and response evidence | 🔴 ☐ | 🟡 ◐ | E13c, E13d | Attribution/model discovery now works for Gemini, Claude and GPT-family Antigravity models, but the current readable transcript exposes no token counts and Git AI emits no kind-5 Antigravity usage events. Raw prompt/response ingestion is intentionally deferred to the privacy-gated Evidence Explorer work; exact token recovery remains a later provider-adapter task. |
| **T2.12** | Define Generated, Accepted, Committed, In-PR, Merged, Production, Reworked and Churned LoC | 🟢 ✅ | 🟢 ✅ | E7–E10, E12, E15 | The physical-LoC lifecycle contract is implemented and reconciled across tenant, repository, PR and contributor scopes. Generated, Accepted/retained, ever Committed, In-PR, Merged, Production, Reworked and current Final AI values were exercised through discard, review edits, close-without-merge, squash, deployment failure/success, deletion, reset and revert. Missing evidence remains `Unavailable`; advanced backport/rollback churn belongs to T2.22. |
| **T2.13** | Redacted evidence pipeline for complete gross AI Generated LoC | 🟢 ✅ | 🟢 ✅ | E12, E13, E15 | Stable event deduplication, per-commit completeness, controlled rebuild and the normal live path now produce complete gross Generated physical LoC without manual repair. E15 began from a clean telemetry slate and progressed through OpenCode, Copilot and Antigravity checkpoint evidence while preserving explicit availability on gaps. Production enrollment watermarks/backfill remain Task4 work. |
| **T2.14** | Compare Git AI stable release versus HEAD event compatibility | 🔴 ☐ | 🔴 ☐ | E14 | Stable-versus-HEAD comparison remains. Production export mechanics belong to Task4. |
| **T2.15** | Immutable commit lifecycle, reachability and predecessor/successor lineage | 🟢 ✅ | 🟢 ✅ | E7, E8, E11, E12, E15 | Amend, reset-recommit, revert and squash histories remain immutable and visibly connected. Discarded reset SHAs remain superseded, recovered successors become reachable, and revert commits do not incorrectly supersede their sources. Push enrichment backfills author/message/timestamps. Advanced cherry-pick/rebase topology remains T2.22/E16. |
| **T2.16** | Timestamped PR commit snapshots and membership intervals | 🟢 ✅ | 🟢 ✅ | E5–E8, E10 | Open, synchronize, amend/force-push, removed historical membership, merged and closed-without-merge states verified. |
| **T2.17** | Reconcile merge commit, squash merge and rebase merge results to source commits/sessions | 🟢 ✅ | 🟢 ✅ | E8, E15-B8, E20 | Squash, multi-commit rebase and divergent one-commit rewrite paths are implemented and live-verified. PR #4 mapped `77cf1ec… → a14936b…` and `7c940ad… → 32c3f1f…` as patch-equivalent `rebase_merge` lineage at confidence 95 while retaining 489/451/432/19/432 and one session without duplication. PR #5 mapped `ccb8cfa… → 1fe5ad0…` as the honest lower-confidence `rewritten_merge` classification at confidence 60 and retained 284/283/283 with one session/commit. |
| **T2.18** | Calculate pre-PR and during-PR rework with AI/human actor breakdown | 🟢 ✅ | 🟢 ✅ | E7, E12, E15-B6/B10 | Deletion checkpoints retain the deleting actor and enter Reworked only after commit evidence proves the removed lines were AI-authored. TrackAI inherits original provenance through predecessor file/range evidence and preserves unresolved deletions until reconciliation. E15 verified AI and human rework before and during PR history, including full-file deletion, with no unknown fallback and scope-correct totals. |
| **T2.19** | Track production deployments; keep default-branch merge as a labelled proxy | 🟢 ✅ | 🟢 ✅ | E9, E15-B9 | E15 failure preserved 572 as a labelled merged proxy without advancing Production; later success advanced exactly 572 to Production. Deployment evidence inherits unique PR lineage idempotently, so tenant/repository/PR scopes reconcile without duplication. |
| **T2.20** | Replace title/email simulation with tenant-scoped GitHub/TrackAI identity linking | 🟡 ◐ | 🟡 ◐ | E5–E8, E11 | Raw PR author (`mahamannu-ux`) and Git author (`Teamz Lab`) are correctly separate. Tenant identity-link administration remains. |
| **T2.21** | Repository/PR/contributor lifecycle APIs, ratios, trends and dashboard scopes | 🟡 ◐ | 🟡 ◐ | E1–E11, E15 | The lifecycle dashboard selects tenant, repository, PR or contributor scope. E15 reconciles tenant 738/690/133/598 and PR #3 624/576/45/572 without scope leakage. Summary cards now use the same rework-aware Final AI contract. Observed commit authors populate contributor scope separately from PR owners; full GitHub/SSO linking remains T2.20. Trends and deep links remain. |
| **T2.22** | Advanced SCM cases | 🔴 ☐ | 🔴 ☐ | E16 | Force-push basics passed; stacked/reopened/retargeted PRs, backports, merge queues, rollbacks and direct production pushes remain last. |
| **T2.23** | Lifecycle view scoped by originating tool/model | 🟢 ✅ | 🟢 ✅ | E17 | Schema, immutable per-commit model ranges, origin-model rework allocation, merge/deployment propagation, protected API and model selector are implemented. Migration `0002` and the E15 rebuild were applied and live-verified: model totals reconcile exactly to Generated 1,193, Committed 917, Merged/Production 572 and Reworked 135. Legacy uncertainty remains explicit rather than guessed: 16 retained downstream lines and 42 reworked lines appear under `Unknown model`; Antigravity uncommitted work correctly has Generated with no Committed value. |
| **T2.24** | Development prompt-to-commit evidence flow | 🟢 ✅ | 🟢 ✅ | E18 | OpenCode-first protected API and lazy commit-detail timeline are implemented and live-verified against a real OpenCode commit. The adapter reads the configured SQLite DB on demand, never persists raw content, presents prompts/responses/tool exchanges through a customer-facing sequence and omits provider-internal Git AI concepts. Production storage, semantic layers, tool-call cost/token insights, Copilot/Antigravity adapters and polished UX remain Task5/Task4 work. |

## Controlled test register

| Test | Scenario | Status | Main Task2 mapping | Result / next action |
|---|---|---:|---|---|
| **E1** | Live OpenCode edit creates session/checkpoint evidence before commit | 🟢 ✅ | T2.7–T2.9, T2.11c | Session appeared; attribution worked; token issue isolated. |
| **E2** | OpenCode transcript usage and token categories | 🟢 ✅ | T2.11c | 16 kind-5 events; 321K conversation tokens displayed. |
| **E3** | GitHub Copilot OTEL usage and token categories | 🟢 ✅ | T2.11b | Copilot usage displayed with native cost unit. |
| **E4** | Multi-agent ordinary commit, Git Note, upload and final attribution | 🟢 ✅ | T2.9–T2.13 | `9de9438…` proved mixed OpenCode/Copilot Notes; the clean-slate E15 rerun subsequently verified the post-fix normal path and physical-LoC reconciliation without manual backfill. |
| **E5** | Push, open PR, webhook ingestion and authoritative initial membership | 🟢 ✅ | T2.16, T2.20, T2.21 | PR #1, two sessions and commit linked; canonical repository convergence bug fixed. |
| **E6** | PR synchronize with new OpenCode session and rename/edit | 🟢 ✅ | T2.8, T2.16, T2.18 | Second active commit added; file rename/edit and new session preserved. |
| **E7** | Human rework, amend and force-push | 🟢 ✅ | T2.6, T2.15, T2.16, T2.18 | Old commit retained as superseded; new SHA active; one historical membership; author backfill fixed. |
| **E8** | GitHub squash merge and source-to-result lineage | 🟢 ✅ | T2.6, T2.15–T2.17 | Initial result `79d7c3a…` and E15 result `1cfdd504…` were stored as squash replacements; all source commits/sessions remained visible and retained AI lines transferred without double counting. |
| **E9** | Successful/failed production deployment and merged proxy | 🟢 ✅ | T2.19, T2.21 | Deployment `5593833613`: failure preserved with Production unavailable and merged proxy 37; success advanced Production to 37 while retaining both status observations. |
| **E10** | Close a PR **without merging** | 🟢 ✅ | T2.12, T2.16, T2.17, T2.21 | PR remained `closed`; no merge result or merged/production transition; 3 AI-attributed lines remain committed with session/membership history. Post-fix commit-linked generation scopes this PR to 3 Generated instead of the shared session’s 16. |
| **E11** | Small Company B scenario plus Company A/B isolation | 🟢 ✅ | T2.9, T2.15, T2.20, T2.21; Task4 5.6.1–5.6.3 | Company B telemetry, webhook routing, PR membership and both login directions passed. Reverse isolation initially exposed a delayed kind-1 event crossing tenants after a global key switch; exact contamination was removed with Company B evidence intact. Transitional server scope guard then rejected a live Company B repository event carrying the valid Company A key before raw storage (`Repository is not enrolled for this tenant`). |
| **E12a** | Delete AI/human/mixed lines and delete a complete file | 🟢 ✅ | T2.11d, T2.12, T2.13, T2.18 | E15-B10 verified an 85-line AI full-file deletion and a 3-line human deletion of inherited AI code. File-scoped checkpoint correlation and parent-lineage attribution produced exact tenant totals without changing the completed PR. Automated regressions and live acceptance pass. |
| **E12b** | `git reset --soft`, `--mixed`, disposable `--hard` | 🟢 ✅ | T2.6, T2.12, T2.15 | E15-B11 verified soft, mixed and hard reset/recommit. Discarded SHAs `d18ac39…`, `661dead…` and `bc380dc…` remain immutable and superseded; recovered `7de7ab30…` is reachable. Generated/Committed stayed 750/702 with no duplication, generation evidence transferred to each retained successor, and PR #3 remained unchanged. Reset detection occurs when replacement evidence arrives because Git AI emits no reset event at reset time. |
| **E12c** | Revert a commit | 🟢 ✅ | T2.6, T2.12, T2.15, T2.18 | Automated and live verification pass. Deletion-only revert `52bd689…` had no Git Note (correct for no surviving authored lines) but emitted kind-7 event `5807`, which TrackAI accepted and Git AI marked delivered. Source `7de7ab3…` remains reachable. Generated/Committed remain 750/702; delivered lifecycle evidence moves expected tenant Reworked 133→145 and Final AI 610→598 while PR #3 remains unchanged. |
| **E13a** | OpenCode live in-session model switch | 🟢 ✅ | T2.11a | One external OpenCode conversation remained stable while DeepSeek and Nemotron produced distinct correctly attributed edit segments. Live evidence: kind 2 ×1, kind 4 ×4 and kind 5 ×20; dashboard/session details reconciled. |
| **E13b** | Standalone Codex-agent compatibility | ⚪ — | T2.7–T2.13 | Superseded for the accepted Task2 scope by Antigravity GPT-family host verification. A native Codex-agent run may be added to the ongoing compatibility lab later; it is not represented as completed by GPT-OSS. |
| **E13c** | Antigravity Gemini/Claude/GPT attribution and model compatibility | 🟢 ✅ | T2.7–T2.13 | Live Antigravity adapter passed across Gemini 3.5 Flash, Claude Sonnet 4.6 and GPT-OSS 120B in one controlled branch: 250 AI additions, three kind-2 model sessions and five kind-4 checkpoints with correct per-model labels. |
| **E13d** | Antigravity token and raw prompt/response compatibility | 🔴 ☐ | T2.11g, T2.13 | Explicitly deferred. Current Antigravity transcripts provide edit/model evidence but no exposed token counts; Git AI emits no kind-5 usage. Raw content requires the privacy, encryption and authorization gates defined for Task4/Task5. |
| **E14** | Git AI stable release versus patched HEAD | 🔴 ☐ | T2.14 | Compare event schemas and regression behavior using the same fixture. |
| **E15** | Moderate-complexity E1–E12 confidence rerun | 🟢 ✅ | T2.6–T2.21 | B1–B12 passed from a clean telemetry slate: multi-model generation, Copilot Keep/Discard, local commit, push, PR review, squash lineage, deployment, actor-attributed deletion, soft/mixed/hard reset-recommit and deletion-only revert. Delivered lifecycle evidence reconciled tenant totals to 750 Generated, 702 ever Committed, 145 Reworked and 598 Final AI; PR #3 remained 624/576/45/572. |
| **E16** | Stacked/reopened/retargeted PRs, backports, merge queue and rollback | 🔴 ☐ | T2.22 | Run last after deterministic and realistic batches pass. |
| **E17** | E15 per-model lifecycle rebuild and reconciliation | 🟢 ✅ | T2.23 | Migration `0002` and the guarded rebuild were applied. SQL and dashboard verification confirmed that known models plus `Unknown model` equal every parent lifecycle total. Antigravity models show Generated with no Committed value. The Unknown rows retain auditable evidence references for 16 downstream and 42 reworked legacy lines. |
| **E18** | OpenCode prompt-to-commit development evidence flow | 🟢 ✅ | T2.24 | Live dashboard verification passed: a known OpenCode commit displayed its prompt, agent-response and tool-call sequence from the read-only local provider DB, with customer-facing terminology and no exposed Git AI internals. Task5 owns semantic enrichment, tool-call efficiency/token insights and production UX. |
| **E19** | KnownHuman working-tree status regression | 🟢 ✅ | T2.11f | Both focused integration tests passed with the local daemon. In an isolated worktree, live manual additions and deletion were classified entirely as human (`unknown_additions: 0`, `ai_additions: 0`) and both checkpoints reported `is_human: true`. |
| **E20** | Rebase and ambiguous rewritten-merge acceptance | 🟢 ✅ | T2.17 | Live acceptance passed. A two-commit GitHub rebase produced distinct patch-equivalent replacement SHAs and exact source mappings; a one-commit rebase onto a diverged base produced `rewritten_merge` at confidence 60 rather than a guessed squash/rebase label. Both PR scopes retained exact Generated/Committed/Merged/Reworked/Final AI and session/commit counts without duplication. |

## Task2 completion boundary

The core lifecycle-correctness milestone through E15 is complete: generation,
commit, PR, merge, deployment, rework, reset/recommit and revert semantics have
all passed automated and live acceptance from a clean telemetry slate.

Final checkpoint verification also corrected four integration regressions
found by the long Git AI suite: all eight commit-metadata recovery tests and
both Claude latest-checkpoint tests now pass, while known-to-known model switches
remain distinct.

Non-green rows are deliberately separated into two groups:

- **Known provider compatibility gaps:** T2.11e remains blocked on Copilot
  emitting correlatable token evidence across model/conversation changes.
  T2.11g remains blocked on Antigravity exposing token evidence; privacy-gated
  prompt/response production work belongs to Task4/Task5.
- **Explicitly deferred product/advanced scope:** T2.14 stable-versus-HEAD
  comparison may wait; T2.20 identity-link administration aligns with Task4;
  T2.21 trends/deep links align with the UX/API roadmap; T2.22/E16 remains the
  advanced SCM suite. None blocks Task4.

Moving a row to another task must preserve its ID and evidence link; it must not
be marked green merely because it was deferred.

## Remaining Task2 sequence

1. Keep T2.11e and T2.11g explicitly `Unavailable` until their providers expose
   sufficient evidence; do not synthesize token values.
2. Preserve T2.14, T2.20, the remaining T2.21 roadmap surface and T2.22/E16 as
   deferred work; they do not block Task4.
3. Run final builds, record exact TrackAI/Git AI checkpoint SHAs, and refresh the
   Task2→Task4 handoff before opening the independent Task4 worktrees.

## Metric invariants

- Customer-facing **Generated LoC** is the complete aggregate of AI-produced
  SLOC, including output later replaced or discarded.
- Checkpoints, traces and transcripts are evidence sources, not the headline
  metric. If coverage is incomplete, Generated LoC is `Unavailable`; a partial
  observed count may appear only in an explicitly labelled drill-down.
- Committed, In-PR, Merged and Production values represent retained code at
  distinct lifecycle boundaries.
- A merged PR and a closed-unmerged PR are different states. Closing without
  merging must never create merged or production evidence.
- Production requires successful production-deployment evidence. Default-branch
  reachability is a separately labelled merged proxy.
- Missing evidence is `Unavailable`, never zero.

## Local-to-remote lifecycle contract

TrackAI must not wait for GitHub to learn about enrolled-repository work. Git AI
records redacted generation/session evidence while editing and creates final
authorship Notes at commit time. The client durably enqueues these events and a
background uploader sends them without blocking the developer's commit. A local
commit can therefore be visible as `local_committed` before it is pushed.

SCM webhooks remain a separate authoritative channel. Push establishes remote
reachability and must materialize manual commits that had no Git AI client
evidence. PR, merge and deployment events advance later lifecycle stages. Both
channels converge idempotently on tenant + canonical repository + commit SHA.

The customer lifecycle therefore distinguishes:

`Generated -> Local committed -> Pushed/remote -> In PR -> Merged -> Production`

Generated code that is never committed remains valuable `Not committed`
productivity evidence. Commits that are never pushed remain valuable local
Committed evidence and are reported separately as `Not pushed`; they must not be
silently treated as remote, merged or abandoned. Amend/reset/rebase operations
retain immutable history and update reachability/lineage instead of deleting
evidence.

Only repositories enrolled for the tenant may upload. Durable offline queues,
retry/backfill, enrollment watermarks and policy administration remain Task4,
but Task2 owns the metric/state semantics above.

## Working directories

| Purpose | Directory |
|---|---|
| Task2 TrackAI API/web | `/Users/manishmahajan/Documents/Codex/2026-07-21/hi/outputs/Task1/TrackAI-v1-task1` |
| Patched Git AI OSS | `/Users/manishmahajan/Documents/Codex/2026-07-21/hi/outputs/Task2/git-ai-task2` |
| Active E15/E13 compatibility lab | `/Users/manishmahajan/Documents/Codex/2026-07-21/hi/outputs/e15-lifecycle-lab` |
| Active VS Code lab | `/Users/manishmahajan/Documents/Codex/2026-07-21/hi/outputs/git-ai-teamz-lab-vscode` |
| Merged TrackAI baseline; do not use for Task2 development | `/Users/manishmahajan/AIProjects/TrackAI-v1` |

## Delivery invariant moved to Task4

At-least-once local transport plus tenant-scoped idempotent materialization is
still required. Durable queues, partial acknowledgements, watermarks and policy
scope are tracked in Task4 5.4/5.6 so Task2 remains focused on metric truth.
