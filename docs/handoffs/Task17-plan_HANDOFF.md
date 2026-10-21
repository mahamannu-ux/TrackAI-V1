# Task17 planning handoff — checkpoint 2

*2026-10-22 · branch `docs/Task17-plan` · planning only. This handoff is a checkpoint request, not evidence that any GitAI code or native package has shipped.*

## Scope and founder decisions

Codex completed the 304-commit public Git AI inventory from imported base `a751efd64d12` to upstream `8a6184a3a8fc` against fork `980ef3ef31b0`. The [primer](../plan/primers/Task17_PRIMER.md) records the founder's checkpoint 1 marks. The [ledger](../plan/GITAI_UPSTREAM_LEDGER_2026-10.tsv) has a feature/fix, customer effect, risk, conflict/trial and proposed disposition per commit. The [tracker](../plan/TASK17.md) is the checkpoint 2 wave plan and affected-gates matrix.

T17.2 daemon reliability is first. T17.3 agent identity and T17.4 attribution/metrics follow; T17.5 package rows go to active Task9f for take/reject. T17.6 TokenUsage v2 is the Task13 checkpoint candidate **token and cost reporting**, with ccusage MIT provenance. Synthetic reflog attribution is rejected under the Trace2 evidence rule. Task14 retains release-trust workflow patterns and HTTP-notes defaults.

The 21 former `defer:Task2` rows are resolved as 14 named Task17d Lab decisions (L17-M1/M2 and L17-A1/A2/A3) and seven rejected lite-mode rows. No ledger row defers to finished Tasks 2, 4 or 9. Sixteen package/release rows (the original 14 plus payload permissions and uninstall alias) were offered to Task9f. Its read-only verdict is now in the ledger: four take/adapt concepts for a Task9f-owned follow-up, 11 rejects, one already satisfied. The two most immediate fixes are installer receipt version `acbac7ef86` and payload-root permissions `5b25b11a6`; published-release lifecycle `0cd8ede139` and byte-exact comparison `97074e6577` wait for eligible releases.

## Implementation order and gates

Task17a plan (0.40× T6), Task17e package triage (0.12×, may finish in parallel), Task17b daemon first (0.35×), Task17c agent/config (0.25×), Task17d attribution/metrics (0.38×), Task17f integration (0.30×): **about 1.80× T6 plus founder-live time**. The single GitAI branch is `task/Task17-upstream-sync-gitai`; the founder creates or authorizes its implementation worktree after checkpoint 2. No port has started.

The affected-gates matrix is `TASK17.md` §5. Always run the full GitAI `cargo test`, explicit Task20 security/contract suites, build/lint/format. Daemon and telemetry rerun the Task4 durable-queue restart at `tests/integration/commit_metric_metadata.rs:211`, IT-T20e-01 and IT-M20-02, then E20-01/02/06 and Intel hook latency after Task20j's week. Attribution/metrics use the migrated Task2 Lifecycle Lab after Task14a; evidence changes rerun Task5 evidence checks. Agent identity needs route fixtures and one separate-account live check per affected agent. Packaging/MDM/release changes need Task9 MDM tests and Task9f review. The Task20 lead reviews every group before its port, with extra shared-code review for daemon and telemetry.

## Evidence and limits

Phase 1 trial-applied the 242 non-merge upstream commits independently on a disposable fork worktree: 50 textual clean applications, 192 conflicts; 62 merge bookkeeping rows were not applied. These results are a conflict screen only. TrackAI `npm ci` passed. Full `npm test` did not finish because localhost tests hit sandbox `EPERM` and an Attesta test exceeded seven minutes; the focused app CORS test passed 2/2 when localhost binding was allowed. No GitAI product code, package, installer or live Task20/Task9 gate has been changed or run by Task17.

## Open review before checkpoint 2 closes

1. The Task20 lead is Claude and has no identified Codex chat in the local task list. The founder should relay the primer's per-group summaries and relevant ledger rows before each port, then return its verdict. This is a future pre-port gate, not a claimed completed review.
2. Founder checkpoint 2: approve or amend the wave order, Lab cases, and affected-gates table. Only then begin Task17b on the GitAI integration branch. Task14a's migrated database and Task20j's seven-day run remain later live-gate dependencies.

The founder, not this Task, pushes or merges the planning branch and later fork PR. A separate independent plan review is requested before push under `docs/agents/TASK_LEAD_PROCEDURE.md`.
