# TrackAI status board

The kit's three tables (agent-kit 0.1.0 `templates/STATUS_BOARD_TEMPLATE.md`). `ROUGH_ROADMAP.md` stays the portfolio index and each Task tracker stays its spec; this file holds the session-level state. Together with the handoffs it is the project's whole state. Symbols per AGENTS.md §11 (✅ = 🟢 ✅, 🟡 = 🟡 ◐, ⬜ = 🔴 ☐ in the older trackers).

---

## Task status board

*Last updated 2026-10-09 (Task9 Wave-1 prompts; rows for Task2–Task6 restated from `ROUGH_ROADMAP.md` and the Task trackers, not re-verified). Each agent updates its own row at close-out.*

| Task | Owner (agent) | Branch / PR | Code + unit tests | Integration (founder run) | Next founder action |
|---|---|---|---|---|---|
| Task2 Lifecycle metrics + Lifecycle Lab | Codex | `feature/task2-lifecycle-metrics` / PR #2 | ✅ merged | 🟡 Lab is permanent; see `Task2.md` | — |
| Task4 Robustness, security, admin, operations | Codex | `feature/task4-hardening` (merged with Task5) / PR #4 | ✅ merged | 🟡 later release gates in `TASK4.md` (manual revocation matrix) | — |
| Task5 Evidence Explorer | Codex | `feature/task5-evidence-explorer` / PR #4 | ✅ merged | 🟡 engineering gates pass in CI; product-owner sign-off E5-12 pending | Sign off E5-12 when ready (`TASK5.md`) |
| Task6.a Security (monitor-only) | Codex | `feature/task6-security` / PRs #5–#7; GitAI PR #2 | ✅ merged | 🟡 D6.1 signed activation and D6.2 platform coverage open | — (Task13/Task14 own D6.2) |
| Task6.b Policy | — | — | ⬜ deferred | n/a | — |
| Task7, Task8, Task10–Task12, Task14 | — | — | ⬜ | ⬜ | Primer when each starts |
| Task9 Managed developer fleet | Codex + Muse | planning PR #13 and Wave-1 prompt PR #14 merged; upstream-audit prompt revision next | 🟡 Task9a ready; Task9b revision pending | ⬜ IT-T9-01–07 and IT-M9-01 designed | Start Task9a; merge the revised Task9b prompt before starting Task9b |
| Task13 Agent and surface coverage | Codex | — | 🟡 matrix only (`AGENT_COVERAGE.md`) | ⬜ | — |
| Task15 Attesta (signed provenance; owns the shared trust layer) | Claude + Muse | — | ⬜ | ⬜ | Start Muse on Task15a and Task15b; then the Task15 lead chat |
| Task16 Audit and auditor experience | Claude + Muse | — | ⬜ | ⬜ | Start Muse on Task16a |
| Kit adoption | Claude | `docs/adopt-agent-kit` / PR #8 (merged 2026-10-08) | ✅ docs, scripts, npm gates | 🟡 `npm run check` and `verify:task5-schema` via `scripts/it-db.sh` re-run by Codex's review; graph and Task6 route verifies agent sandbox only | — |
| Dry run: API hygiene (B12, B13) | Codex | `task/dryrun-api-hygiene` | 🟡 152 unit tests and `npm run check` pass; independent review ready | n/a: none needed | Founder pushes and opens PR |
| Dry run: web dead view (B14) | Muse | `task/dryrun-web-dead-view` | ✅ deletion + `npm run check` green | n/a: none needed | Founder pushes and opens PR |

Rules: symbols per AGENTS.md §11; "n/a: none needed" when a Task has no integration tests; the founder's run, never the sandbox, makes integration ✅.

---

## Remaining plan

Effort is relative to **T6** = all of Task6.a Security = 1.0× (about 4× SushiCorp's S3; see `docs/plan/EFFORT_BENCHMARK.md`). At most one session per agent runs at a time, each in its own worktree.

| # | Session | Agent | Estimate | Actual | Starts when | Prompt |
|---|---|---|---|---|---|---|
| 1 | docs/adopt-agent-kit: AGENTS.md, CLAUDE.md, procedures, templates, status board, benchmark, npm gates, worktree and integration scripts | Claude | about 0.06× | about 0.07× (by turns) | now | (setup brief) |
| 2 | dryrun-api-hygiene: B12, B13; Codex leads and writes Muse's prompt | Codex | about 0.01× | about 0.01× | #5 merged | `docs/prompts/NEXT_CHAT_dryrun-api-hygiene_PROMPT.md` |
| 3 | dryrun-web-dead-view: B14, handed out by Codex | Muse | about 0.01× | about 0.01× | #2's prompt written | written by Codex in #2 |
| 4 | ~~Dry run, Claude~~ dropped by the founder 2026-10-08 (Claude usage) | — | — | — | — | — |
| 5 | stage2-project-map: vision, project map, reuse map, AGENTS.md §9 gotchas (stage 2, moved before the dry runs) | Claude (orchestrator) | about 0.05× | about 0.05× (by turns) | #1 merged | (setup brief) |
| 6 | Task15 Attesta, phase 1 (sessions in `docs/plan/TASK15.md` §5) | Claude + Muse + Codex | about 1.5× | | founder buy-in on TASK15 §1 | `docs/prompts/NEXT_CHAT_Task15-lead_PROMPT.md` |
| 6b | Task16 Audit (sessions in `docs/plan/TASK16.md` §4) | Claude + Muse + Codex | about 0.6× | | founder answers TASK16 §1 | `docs/prompts/NEXT_CHAT_Task16-lead_PROMPT.md` |
| 7 | Task9-lead: primer, plan, sessions (Codex leads, Muse helps) | Codex | about 0.05× | about 0.05× (by turns) | complete; checkpoint-2 review next | `docs/prompts/NEXT_CHAT_Task9-lead_PROMPT.md` |
| 7a | Task9a-fleet-control-plane: server contract, inventory, rollout/offboard records and reconciliation | Codex | about 0.24× target; 0.38× ceiling | | ready after this prompt PR merges | `docs/prompts/NEXT_CHAT_Task9a-fleet-control-plane_PROMPT.md` |
| 7b | Task9b-managed-packages: upstream-derived macOS/Windows login-start plus secret-free PKG/MSI hardening | Muse | about 0.20× target; 0.25× ceiling | | revised prompt PR must merge; no Task13 daemon/MDM/packaging overlap | `docs/prompts/NEXT_CHAT_Task9b-managed-packages_PROMPT.md` |
| 7c | Task9c-managed-config-secrets: client activation and macOS/Windows secret stores | Codex | about 0.40× | | Task9a merged; preferably Task9b merged | written after Task9a freezes interfaces |
| 7d | Task9d-fleet-update-offboard: endpoint update, rollback and cleanup | Muse | about 0.30× | | Task9a and Task9c merged | written after Task9c |
| 7e | Task9e-fleet-console: inventory, rollout, offboard and mismatch UI | Muse | about 0.25× | | Task9a merged; Muse free after Task9b | written after Task9a freezes interfaces |
| 7f | Task9f-macos-conformance: current Intel Mac lifecycle plus best-effort Jamf/second-Mac gates | Codex | about 0.30× | | Task9a–Task9e merged | written after implementation sessions |
| 7g | Task9g-windows-conformance: Windows x64 CI floor plus best-effort native/Intune gates | Codex | about 0.35× | | Task9a–Task9e and Task9f merged; host/tenant if available | written after macOS conformance |
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
| IT-T9-01 | Task9a | Disposable PostgreSQL: tenant-bound configuration, fleet posture, rollout/offboard records, immutable audit and Company A/B isolation | Planned in `docs/plan/TASK9.md` §6 | Blocking: Task9a and later TrackAI fleet contract changes | ⬜ designed |
| IT-T9-02 | Task9f | Current Intel Mac full local lifecycle: signed PKG, Keychain, managed config, offline queue, update/rollback, rotation, revoke and cleanup | Planned in `docs/plan/TASK9.md` §6 | Blocking: supported macOS local route | ⬜ designed |
| IT-T9-03 | Task9f | Jamf post-login deployment, inventory, update/rollback and offboarding | Planned in `docs/plan/TASK9.md` §6 | Blocking only for Jamf-managed claim | ⬜ pending tenant |
| IT-T9-04 | Task9b, Task9g | Hosted Windows x64 MSI build plus install/uninstall smoke without plaintext output | Existing GitAI release workflow; Task9 assertion to be added | Minimum Windows evidence without a rental | ⬜ Task9 rerun pending |
| IT-T9-05 | Task9g | Native Windows x64 MSI, Credential Manager/DPAPI, restart, update/rollback and revoke | Planned in `docs/plan/TASK9.md` §6 | Blocking only for native Windows claim | ⬜ pending host |
| IT-T9-06 | Task9g | Intune post-login deployment, reconciliation, rollback and retire/offboard | Planned in `docs/plan/TASK9.md` §6 | Blocking only for Intune-managed claim | ⬜ pending host and tenant |
| IT-T9-07 | Task9f | Two-device macOS rollout ring and reconciliation; optional Apple Silicon evidence | Planned in `docs/plan/TASK9.md` §6 | Blocking only for two-device/Apple-Silicon claim | ⬜ best-effort host |
| IT-M9-01 | Task9, Task15 | Signed machine-bound configuration rejects tamper/replay/revocation and preserves last-known-good | Planned in `docs/plan/TASK9.md` §6 | Production blocker shared with D6.1, not Task9 engineering | ⬜ waits for Task15 |

Gating means "must pass on the founder's machine before the named merge or milestone". It does not stop other agents developing against the unit-tested code in parallel.
