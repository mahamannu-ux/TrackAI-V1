# GitAI fork: future to-dos

TrackAI owns its GitAI fork (`mahamannu-ux/git-ai`, `~/AIProjects/git-ai`). Founder decision 2026-10-08: **no routine downstream sync from upstream**; upstream changes are cherry-picked only when TrackAI needs one. (The upstream project's site says Git AI is now part of OpenAI.) Add rows as Tasks find client-side work; strike them through with the fixing PR.

| # | Found | To-do | Needed by | Status |
|---|---|---|---|---|
| G1 | 2026-10-07 | Machine credentials and delivery policy are plain JSON files (mode 0600), not the OS keychain | Task9, Task14 T14.3 | ⬜ |
| G2 | 2026-10-07 | Activation lease is unsigned; verify a signed, machine-bound lease locally (D6.1) | Task6.a with Task15 Attesta's trust layer | ⬜ |
| G3 | 2026-10-07 | Security evaluator runs only for OpenCode (`src/commands/checkpoint_agent/orchestrator.rs:456`); other agents and Linux/Windows/WSL need routes (D6.2) | Task13, Task9 | ⬜ |
| G4 | 2026-10-07 | No signing or integrity protection of authorship notes (`refs/notes/ai` can be rewritten); a digest or signature hook for Attesta | Task15 Attesta (second phase) | ⬜ |
| G5 | 2026-10-07 | Selective upstream adoption only. The 2026-09-19 merge commit `2d240fb9` imported upstream snapshot `a751efd6` (v1.6.19, dated 2026-07-30); the fork has diverged at known daemon/metrics hotspots. See the dated [302-commit inventory](GITAI_UPSTREAM_INVENTORY_2026-10-09.md) before any cherry-pick or port. | any upstream adoption | inventory complete; adoption ⬜ |
| G6 | 2026-10-07 | Inherited flakes: `tests/daemon_mode.rs` under parallel runs; Clippy findings on newer Rust | GitAI hygiene | ⬜ |
| G7 | 2026-10-07 | Evidence collection is a manual CLI (`git-ai evidence sync-opencode`), not part of the daemon | Task5 / Task13 | ⬜ |

## G5 priority order from the 2026-10-09 inventory

The inventory covers every one of the 302 commits on public GitAI `main` after the fork's imported snapshot, not only commits whose subject mentions MDM. Categories overlap, so their counts are search aids rather than a sum.

1. **Now — Task9b MDM login-start and package correctness.** Port the final macOS/Windows behavior and tests with provenance; do not bulk cherry-pick the Linux route, upstream MSI credential properties, WSL defaults or unrelated installer refactors.
2. **Next relevant task — daemon reliability and agent/editor coverage.** Review targeted fixes against TrackAI's modified daemon for Tasks 4, 6 and 13. Never replay this high-conflict area as a series.
3. **Regression review for completed Tasks 2 and 5.** Compare attribution/rewrite, usage/metrics and evidence/OpenCode fixes against TrackAI's frozen semantics and privacy boundaries; adopt only demonstrated fixes.
4. **Task-driven later review.** Revisit configuration/auth for Tasks 9 and 14, and upgrade/release changes for Tasks 9 and 14. Treat CI/dependency/docs-only changes as low priority unless they close a security or reproducibility issue.

An upstream version number is not, by itself, a reason to sync. Each adopted change still needs a TrackAI issue/task owner, conflict review, focused regression test and an explicit record of whether it was cherry-picked unchanged or ported with local adaptations.
