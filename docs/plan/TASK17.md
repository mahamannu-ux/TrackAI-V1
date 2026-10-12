# Task17 — GitAI Upstream Sync and Fork Hygiene

*Status: 🔴 not started; after Task9, before Task13 (founder decision 2026-10-12). The founder will go into details when the Task starts; the lead writes the primer then.*

**Why once.** Public Git AI (`git-ai-project/git-ai`) shows no commits after 1.7.6 on 2026-09-09, around its acquisition by OpenAI. TrackAI owns its fork; this is expected to be the first and last bulk catch-up. Afterwards upstream changes are cherry-picked only when a Task needs one.

**Inputs.** `docs/plan/GITAI_UPSTREAM_INVENTORY_2026-10-09.md` (302 upstream-only and 71 fork-only commits; dispositions P0–P3), `docs/plan/GITAI_UPSTREAM_COMMITS_2026-10-09.tsv`, `docs/plan/GITAI_FUTURE_TODO.md`.

**Scope.**
- Daemon and runtime reliability fixes (95 commits), triaged one by one and ported with focused tests.
- Attribution, rewrite and notes changes (59), as a regression review against Task2's metric meanings; never import changed meaning implicitly.
- Metrics, usage and telemetry fixes (40), preserving TrackAI's schema and privacy contracts.
- Agent and editor integrations (26), compared before Task13 freezes its coverage matrix.
- Configuration, upgrade and release paths (P2) only where Task9 or Task14 need them; CI and dependency changes (P3) only when an adopted fix requires them.
- GITAI_FUTURE_TODO G5 (merge hotspots) and G6 (inherited flaky tests). G1–G4 and G7 stay with their owning Tasks.
- **Not in scope:** the MDM login-start kit (Task9b already ports it).

**Roles.**
- **Codex leads:** sequencing, conflicts, tests, and what each port unblocks for Task13 and other Codex Tasks.
- **Claude reviews from the product and customer side:** which upstream changes matter to customers, which must never change metric meaning or customer claims; signs off each group before it is ported.
- **Muse ports** self-contained changes from prompts with every decision made.

**Exit.** Every inventory row has an adoption record (template in the inventory), and a Task2 Lifecycle Lab regression check passes before Task13 starts.
