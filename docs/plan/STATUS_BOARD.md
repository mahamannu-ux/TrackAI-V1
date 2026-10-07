# TrackAI status board

The kit's three tables (agent-kit 0.1.0 `templates/STATUS_BOARD_TEMPLATE.md`). `ROUGH_ROADMAP.md` stays the portfolio index and each Task tracker stays its spec; this file holds the session-level state. Together with the handoffs it is the project's whole state. Symbols per AGENTS.md §11 (✅ = 🟢 ✅, 🟡 = 🟡 ◐, ⬜ = 🔴 ☐ in the older trackers).

---

## Task status board

*Last updated 2026-10-07 (kit adoption; rows for Task2–Task6 restated from `ROUGH_ROADMAP.md` and the Task trackers, not re-verified). Each agent updates its own row at close-out.*

| Task | Owner (agent) | Branch / PR | Code + unit tests | Integration (founder run) | Next founder action |
|---|---|---|---|---|---|
| Task2 Lifecycle metrics + Lifecycle Lab | Codex | `feature/task2-lifecycle-metrics` / PR #2 | ✅ merged | 🟡 Lab is permanent; see `Task2.md` | — |
| Task4 Robustness, security, admin, operations | Codex | `feature/task4-hardening` (merged with Task5) / PR #4 | ✅ merged | 🟡 later release gates in `TASK4.md` (manual revocation matrix) | — |
| Task5 Evidence Explorer | Codex | `feature/task5-evidence-explorer` / PR #4 | ✅ merged | 🟡 engineering gates pass in CI; product-owner sign-off E5-12 pending | Sign off E5-12 when ready (`TASK5.md`) |
| Task6.a Security (monitor-only) | Codex | `feature/task6-security` / PRs #5–#7; GitAI PR #2 | ✅ merged | 🟡 D6.1 signed activation and D6.2 platform coverage open | — (Task13/Task14 own D6.2) |
| Task6.b Policy | — | — | ⬜ deferred | n/a | — |
| Task7–Task12, Task14 | — | — | ⬜ | ⬜ | Primer when each starts |
| Task13 Agent and surface coverage | Codex | — | 🟡 matrix only (`AGENT_COVERAGE.md`) | ⬜ | — |
| Task15 Attesta (signed provenance; owns the shared trust layer) | Claude + Muse | — | ⬜ | ⬜ | Answer `docs/plan/TASK15.md` §1 and §7; start Muse on Task15a and Task15b |
| Task16 Audit and auditor experience | Claude + Muse | — | ⬜ | ⬜ | Answer `docs/plan/TASK16.md` §1; start Muse on Task16a |
| Kit adoption | Claude | `docs/adopt-agent-kit` / PR #8 (merged 2026-10-08) | ✅ docs, scripts, npm gates | 🟡 `npm run check` and `verify:task5-schema` via `scripts/it-db.sh` re-run by Codex's review; graph and Task6 route verifies agent sandbox only | — |
| Dry run: API hygiene (B12, B13) | Codex | `task/dryrun-api-hygiene` | 🟡 152 unit tests and `npm run check` pass; independent review ready | n/a: none needed | Founder pushes and opens PR |
| Dry run: web dead view (B14) | Muse | `task/dryrun-web-dead-view` | ⬜ not started | n/a: none needed | Founder starts Muse from Codex's prompt after API PR merges |

Rules: symbols per AGENTS.md §11; "n/a: none needed" when a Task has no integration tests; the founder's run, never the sandbox, makes integration ✅.

---

## Remaining plan

Effort is relative to **T6** = all of Task6.a Security = 1.0× (about 4× SushiCorp's S3; see `docs/plan/EFFORT_BENCHMARK.md`). At most one session per agent runs at a time, each in its own worktree.

| # | Session | Agent | Estimate | Actual | Starts when | Prompt |
|---|---|---|---|---|---|---|
| 1 | docs/adopt-agent-kit: AGENTS.md, CLAUDE.md, procedures, templates, status board, benchmark, npm gates, worktree and integration scripts | Claude | about 0.06× | about 0.07× (by turns) | now | (setup brief) |
| 2 | dryrun-api-hygiene: B12, B13; Codex leads and writes Muse's prompt | Codex | about 0.01× | about 0.01× | #5 merged | `docs/prompts/NEXT_CHAT_dryrun-api-hygiene_PROMPT.md` |
| 3 | dryrun-web-dead-view: B14, handed out by Codex | Muse | about 0.01× | | #2's prompt written | written by Codex in #2 |
| 4 | ~~Dry run, Claude~~ dropped by the founder 2026-10-08 (Claude usage) | — | — | — | — | — |
| 5 | stage2-project-map: vision, project map, reuse map, AGENTS.md §9 gotchas (stage 2, moved before the dry runs) | Claude (orchestrator) | about 0.05× | about 0.05× (by turns) | #1 merged | (setup brief) |
| 6 | Task15 Attesta, phase 1 (sessions in `docs/plan/TASK15.md` §5) | Claude + Muse + Codex | about 1.5× | | founder buy-in on TASK15 §1 | `docs/prompts/NEXT_CHAT_Task15-lead_PROMPT.md` |
| 6b | Task16 Audit (sessions in `docs/plan/TASK16.md` §4) | Claude + Muse + Codex | about 0.6× | | founder answers TASK16 §1 | `docs/prompts/NEXT_CHAT_Task16-lead_PROMPT.md` |
| 7 | Task9-lead: primer, plan, sessions (Codex leads, Muse helps) | Codex + Muse | (primer decides) | | this prompt's PR merged | `docs/prompts/NEXT_CHAT_Task9-lead_PROMPT.md` |
| 8 | Task13-lead: primer, plan, sessions (Codex leads, Muse helps) | Codex + Muse | (primer decides) | | this prompt's PR merged | `docs/prompts/NEXT_CHAT_Task13-lead_PROMPT.md` |

**Actuals:** adopt-agent-kit ran slightly over (0.07× against 0.06×): three cross-review fix rounds on draft project slots that did not match the code.

---

## Integration test registry

Integration tests prove what only real infrastructure can. They are founder-owned and agent-assisted: an agent proposes tests for its own Task (`IT-<ID>-NN`); tests across Tasks (`IT-M<n>-NN`) are listed as ⬜ with a short design until their Tasks exist. Every database run goes through `scripts/it-db.sh` (AGENTS.md §6). Codex's pre-kit `verify:*` scripts and `E<N>-*` gates keep their names.

| ID | Task(s) | What it proves | File | Gating | Status |
|---|---|---|---|---|---|
| verify:task5-schema | Task5 | pgvector, semantic tables, RLS on, no browser policies, no plaintext columns | `apps/api/src/features/evidence/task5-schema-verify.ts` | Blocking: any migration | 🟡 agent-verified 2026-10-07 via `scripts/it-db.sh` · CI on every PR |
| verify:task5-graph-live | Task5 | Lossless graph paging, exact and missing line attribution, tenant isolation | `…/evidence/task5-graph-live-verify.ts` | Blocking: evidence or telemetry changes | 🟡 agent-verified 2026-10-07 · CI |
| verify:task5-{corpus,opencode,retention,analytics,semantic}-live | Task5 | Ingestion, retention deletion, analytics, semantic retrieval | `…/evidence/task5-*-live-verify.ts` | Blocking: evidence changes | CI on every PR (`.github/workflows/task5-verification.yml`) |
| verify:task6-route-live | Task6.a | Finding upload auth, revoked credential blocked, no raw content, tenant A/B isolation | `…/security-findings/task6-route-live-verify.ts` (needs database `trackai_task6_security_live`) | Blocking: security-findings changes | 🟡 agent-verified 2026-10-07 via `scripts/it-db.sh` |
| verify:task4-* (about 30 scripts) | Task4 | Wave 1–6 live checks: envelope encryption, machine lifecycle, SCM provider, watermark, admin lifecycle, export/restore, retention, monitoring | `apps/api/src/core/security/`, `apps/api/src/features/{scm,telemetry,admin,operations}/task4-*` | Per `TASK4.md` | Founder-run; many need live GitHub App credentials or a persistent database |
| E6-1…E6-10 | Task6.a | Real OpenCode route on macOS: monitor, off, offline, expiry, restart | GitAI + `TASK6_SECURITY.md` | Production: blocked on D6.1/D6.2 | ✅ founder-verified (per `docs/handoffs/TASK6_RELEASE_HANDOFF.md`) |

Gating means "must pass on the founder's machine before the named merge or milestone". It does not stop other agents developing against the unit-tested code in parallel.
