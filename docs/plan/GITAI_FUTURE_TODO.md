# GitAI fork: future to-dos

TrackAI owns its GitAI fork (`mahamannu-ux/git-ai`, `~/AIProjects/git-ai`). Founder decision 2026-10-08: **no routine downstream sync from upstream**; upstream changes are cherry-picked only when TrackAI needs one. (The upstream project's site says Git AI is now part of OpenAI.) Add rows as Tasks find client-side work; strike them through with the fixing PR.

| # | Found | To-do | Needed by | Status |
|---|---|---|---|---|
| G1 | 2026-10-07 | Machine credentials and delivery policy are plain JSON files (mode 0600), not the OS keychain | Task9, Task14 T14.3 | ⬜ |
| G2 | 2026-10-07 | Activation lease is unsigned; verify a signed, machine-bound lease locally (D6.1) | Task6.a with Task15 Attesta's trust layer | ⬜ |
| G3 | 2026-10-07 | Security evaluator runs only for OpenCode (`src/commands/checkpoint_agent/orchestrator.rs:456`); other agents and Linux/Windows/WSL need routes (D6.2) | Task13, Task9 | ⬜ |
| G4 | 2026-10-07 | No signing or integrity protection of authorship notes (`refs/notes/ai` can be rewritten); a digest or signature hook for Attesta | Task15 Attesta (second phase) | ⬜ |
| G5 | 2026-10-07 | Merge hotspots if an upstream fix is ever wanted: `src/metrics/db.rs` (schema v9), `src/daemon/telemetry_worker.rs`, `src/daemon.rs`, `src/daemon/checkpoint.rs`, `src/daemon/stream_worker.rs`; last upstream merge `2d240fb9` (v1.6.19, 2026-09-19) | any cherry-pick | n/a |
| G6 | 2026-10-07 | Inherited flakes: `tests/daemon_mode.rs` under parallel runs; Clippy findings on newer Rust | GitAI hygiene | ⬜ |
| G7 | 2026-10-07 | Evidence collection is a manual CLI (`git-ai evidence sync-opencode`), not part of the daemon | Task5 / Task13 | ⬜ |
