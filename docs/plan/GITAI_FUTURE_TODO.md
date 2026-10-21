# GitAI fork: future to-dos

TrackAI owns its GitAI fork (`mahamannu-ux/git-ai`, `~/AIProjects/git-ai`). Founder decision 2026-10-08: **no routine downstream sync from upstream**; upstream changes are cherry-picked only when TrackAI needs one. (The upstream project's site says Git AI is now part of OpenAI.) Add rows as Tasks find client-side work; strike them through with the fixing PR.

| # | Found | To-do | Needed by | Status |
|---|---|---|---|---|
| G1 | 2026-10-07 | Machine credentials and delivery policy are plain JSON files (mode 0600), not the OS keychain | Task9, Task14 T14.3 | ⬜ |
| G2 | 2026-10-07 | Activation lease is unsigned; verify a signed, machine-bound lease locally (D6.1) | Task6.a with Task15 Attesta's trust layer | ⬜ |
| G3 | 2026-10-07 | Security evaluator runs only for OpenCode (`src/commands/checkpoint_agent/orchestrator.rs:456`); other agents and Linux/Windows/WSL need routes (D6.2) | Task13, Task9 | ⬜ |
| G4 | 2026-10-07 | No signing or integrity protection of authorship notes (`refs/notes/ai` can be rewritten); a digest or signature hook for Attesta | Task15 Attesta (second phase) | ⬜ |
| G5 | 2026-10-07 | Selective upstream adoption only. The 2026-09-19 merge commit `2d240fb9` imported upstream snapshot `a751efd6` (v1.6.19, dated 2026-07-30); the fork has diverged at known daemon/metrics hotspots. See the current [304-commit Task17 ledger](GITAI_UPSTREAM_LEDGER_2026-10.tsv) and [Task17 wave plan](TASK17.md) before any cherry-pick or port; the dated 302-commit inventory is historical. | any upstream adoption | inventory complete; adoption ⬜ |
| G6 | 2026-10-07 | Inherited flakes: `tests/daemon_mode.rs` under parallel runs; Clippy findings on newer Rust | GitAI hygiene | ⬜ |
| G7 | 2026-10-07 | Evidence collection is a manual CLI (`git-ai evidence sync-opencode`), not part of the daemon | Task5 / Task13 | ⬜ |
| G8 | 2026-10-13 | Rust trust verifier (`verifyTrusted`, `docs/contracts/attesta/trust.md`): must return the same status and code for every vector in `apps/api/src/features/attesta/vectors/trust/`; pin the current root keyid at install, hard-code production, persist `lastTrusted` | D6.1 (G2), Task9 IT-M9-01, Task6.b P6.8, T14.7 | ⬜ |

## G5 priority order: Task17 checkpoint 2 (supersedes the 2026-10-09 inventory)

The Task17 ledger covers all 304 upstream commits since the imported snapshot and records each fix or feature, its fork conflict, proposed owner and reason. The founder marked T17.2 daemon reliability as the first implementation wave. Task17d owns all prior Task2 deferrals: 14 named Lifecycle Lab decisions and seven reasoned lite-mode rejects. The active Task9f lead reviewed all 16 offered package candidates: four take/adapt for its follow-up, 11 reject, one already satisfied; no package row is parked with finished Task9. TokenUsage v2 is the Task13 product candidate **token and cost reporting** (source ccusage, MIT); HTTP-notes defaults and workflow release trust remain Task14. Synthetic reflog attribution is rejected under the Trace2 evidence rule. See `TASK17.md` §2–5 for the wave order and affected gates.

An upstream version number is not, by itself, a reason to sync. Each adopted change needs a TrackAI issue/task owner, conflict review, focused regression test and an explicit record of whether it was cherry-picked unchanged or ported with local adaptations.
