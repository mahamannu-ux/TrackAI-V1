# TrackAI status board

The kit's three tables (agent-kit 0.1.0 `templates/STATUS_BOARD_TEMPLATE.md`). `ROUGH_ROADMAP.md` stays the portfolio index and each Task tracker stays its spec; this file holds the session-level state. Together with the handoffs it is the project's whole state. Symbols per AGENTS.md §11 (✅ = 🟢 ✅, 🟡 = 🟡 ◐, ⬜ = 🔴 ☐ in the older trackers).

---

## Task status board

*Last updated 2026-10-12 (Task2 Attesta trigger implementation; Task15c Attesta contract and outbox; portfolio re-plan: Task7/11/12 deferred, Task8 re-scoped, Task17/18 added, see `docs/plan/ROADMAP_REPLAN_2026-10-12.md`; Task15 question catalogue and Q&A subtasks; earlier: 2026-10-09 Task9a fleet control plane; rows for Task2–Task6 restated from `ROUGH_ROADMAP.md` and the Task trackers, not re-verified). Each agent updates its own row at close-out.*

| Task | Owner (agent) | Branch / PR | Code + unit tests | Integration (founder run) | Next founder action |
|---|---|---|---|---|---|
| Task2 Lifecycle metrics + Lifecycle Lab | Codex | `feature/task2-lifecycle-metrics` / PR #2 | ✅ merged | 🟡 Lab is permanent; see `Task2.md` | — |
| Task4 Robustness, security, admin, operations | Codex | `feature/task4-hardening` (merged with Task5) / PR #4 | ✅ merged | 🟡 later release gates in `TASK4.md` (manual revocation matrix) | — |
| Task5 Evidence Explorer | Codex | `feature/task5-evidence-explorer` / PR #4 | ✅ merged | 🟡 engineering gates pass in CI; product-owner sign-off E5-12 pending | Sign off E5-12 when ready (`TASK5.md`) |
| Task6.a Security (monitor-only) | Codex | `feature/task6-security` / PRs #5–#7; GitAI PR #2 | ✅ merged | 🟡 D6.1 signed activation and D6.2 platform coverage open | — (Task13/Task14 own D6.2) |
| Task6.b Policy | — | — | ⬜ deferred | n/a | — |
| Task7 SCM and CI/CD (deferred to pilot) | — | — | ⬜ | ⬜ | Pulled in if a pilot needs GitLab/Azure DevOps (`docs/plan/TASK7.md`) |
| Task8 Pilot readiness: identity and onboarding | — | — | ⬜ | ⬜ | After Task10 (`docs/plan/TASK8.md`) |
| Task10 UX/UI | — | — | ⬜ | ⬜ | After Task13 and Task16, with Task5/Task6.a clean-up |
| Task11 API/SDK | — | — | n/a deferred until a customer asks | n/a | Triggers in `docs/plan/TASK11.md` |
| Task12 Trust center and buyer content | — | — | ⬜ | ⬜ | After Task14 (`docs/plan/TASK12.md`) |
| Task14 Production readiness | — | — | ⬜ | ⬜ | T14.1 pilot hosting before Task18; rest after the pilot milestone |
| Task17 GitAI upstream sync | Codex + Claude + Muse | — | ⬜ | ⬜ | After Task9 (`docs/plan/TASK17.md`) |
| Task18 Real-world validation | Codex + Muse | — | ⬜ | ⬜ | After Task8 and T14.1 (`docs/plan/TASK18.md`) |
| Task9 Managed developer fleet | Codex + Muse | Task9a PR #16, Task9e PR #18 and Task9a2 PR #21 merged; GitAI Task9b PR #3, Task9c PR #4 and Task9c2 PR #5 merged | 🟡 lifecycle correction merged; Task15 verification remains unavailable | 🟡 IT-T9-01 reverified for v1/v2 on 2026-10-11; founder run and IT-T9-02–07/IT-M9-01 pending | Start Task9d from corrected GitAI `main` at `c4509ab8d` |
| Task13 Agent and surface coverage | Codex | — | 🟡 matrix only (`AGENT_COVERAGE.md`) | ⬜ | — |
| Task15 Attesta (signed provenance; owns the shared trust layer) | Claude + Muse + Codex | `task/Task2-attesta-trigger` (A15.7; correction review pending) | 🟡 Task15a/b/c/e merged; A15.7 code and 395 unit tests complete | ✅ founder passed IT-T15c-01 and IT-T2AT-01…04 on 2026-10-12; `5fb2647` Task2 rerun pending | Rerun only IT-T2AT-01…04, complete review, then push/open the A15.7 PR |
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
| 6 | Task15 Attesta, phase 1 (sessions in `docs/plan/TASK15.md` §5, incl. A15.14) | Claude + Muse + Codex | about 1.55× | | founder buy-in on TASK15 §1 | `docs/prompts/Task15/NEXT_CHAT_Task15-lead_PROMPT.md` |
| 6a | Task2-attesta-trigger: atomic Task2 observation pointers for A15.7 | Codex | about 0.15× | about 0.15× | A15.0 merged | `docs/prompts/Task15/NEXT_CHAT_Task2-attesta-trigger_PROMPT.md` |
| 6b | Task16 Audit (sessions in `docs/plan/TASK16.md` §4; auditor invitations moved to Task8 T8.12) | Claude + Muse | about 0.5× | | founder answers TASK16 §1 | `docs/prompts/Task16/NEXT_CHAT_Task16-lead_PROMPT.md` |
| 7 | Task9-lead: primer, plan, sessions (Codex leads, Muse helps) | Codex | about 0.05× | about 0.05× (by turns) | complete | `docs/prompts/Task9/NEXT_CHAT_Task9-lead_PROMPT.md` |
| 7a | Task9a-fleet-control-plane: server contract, inventory, rollout/offboard records and reconciliation | Codex | about 0.24× target; 0.38× ceiling | about 0.24× | merged in PR #16 | `docs/prompts/Task9/NEXT_CHAT_Task9a-fleet-control-plane_PROMPT.md` |
| 7a2 | Task9a2-release-contract-correction: schema-v2 compatibility and immutable release descriptor | Codex | about 0.14× target; 0.20× ceiling | about 0.14× | merged in TrackAI PR #21 (`d2c4a23`) | `docs/prompts/Task9/NEXT_CHAT_Task9a2-release-contract-correction_PROMPT.md` |
| 7b | Task9b-managed-packages: upstream-derived macOS/Windows login-start plus secret-free PKG/MSI hardening | Muse | about 0.20× target; 0.25× ceiling | | merged in GitAI PR #3; hosted macOS/Windows and package smokes pending | `docs/prompts/Task9/NEXT_CHAT_Task9b-managed-packages_PROMPT.md` |
| 7c | Task9c-managed-config-secrets: client activation and macOS/Windows secret stores | Codex | about 0.32× target; 0.40× ceiling | | merged in GitAI PR #4 (`cc155d692`) | `docs/prompts/Task9/NEXT_CHAT_Task9c-managed-config-secrets_PROMPT.md` |
| 7c2 | Task9c2-release-state-correction: schema-v2 parser, exact bytes and reverified execution authorization | Codex | about 0.10× target; 0.15× ceiling | | merged in GitAI PR #5 (`c4509ab8d`) | `docs/prompts/Task9/NEXT_CHAT_Task9c2-release-state-correction_PROMPT.md` |
| 7d | Task9d-fleet-update-offboard: endpoint update, rollback and cleanup | Muse | about 0.20× target; 0.30× ceiling | | Task9a2 and Task9c2 merged; fast-forward the clean stopped worktree to `c4509ab8d` and begin | `docs/prompts/Task9/NEXT_CHAT_Task9d-fleet-update-offboard_PROMPT.md` |
| 7e | Task9e-fleet-console: inventory, rollout, offboard and mismatch UI | Muse | about 0.20× target; 0.25× ceiling | about 0.17× | merged in TrackAI PR #18 (`b43d007`); only a narrow v2 form/type assessment may follow | `docs/prompts/Task9/NEXT_CHAT_Task9e-fleet-console_PROMPT.md` |
| 7f | Task9f-macos-conformance: current Intel Mac lifecycle plus best-effort Jamf/second-Mac gates | Codex | about 0.30× | | Task9a2, Task9c2 and resumed Task9d merged | written after implementation sessions |
| 7g | Task9g-windows-conformance: Windows x64 CI floor plus best-effort native/Intune gates | Codex | about 0.35× | | corrected implementation sessions and Task9f merged; host/tenant if available | written after macOS conformance |
| 7h | Task17-lead: GitAI upstream sync (Codex leads; Claude product review; Muse ports) | Codex + Claude + Muse | (primer decides) | | Task9 done | to write from `docs/agents/TASK_LEAD_PROCEDURE.md` |
| 7i | Task2-lab-regression: Lifecycle Lab regression check after Task9 and Task17 | Codex | about 0.1× | | Task17 done | to write |
| 8 | Task13-lead: primer, plan, sessions (Codex leads, Muse helps) | Codex + Muse | (primer decides) | | this prompt's PR merged | `docs/prompts/Task13/NEXT_CHAT_Task13-lead_PROMPT.md` |

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
| IT-T15c-01 | Task15c | Disposable PostgreSQL: `attesta_subjects` outbox replay returns the same row, same-tenant source mismatches (event/commit, delivery/PR, delivery/deployment) and a stale stored pointer refused, second success delivery is the same observation, `event_at` from the source, rollback leaves no row, concurrent writers produce one row, Company A/B isolation, immutable identity columns, kind shape check, RLS on with no policies | `apps/api/src/features/attesta/t15c-outbox-live-verify.ts` (`npm run verify:task15c-outbox-live -w apps/api`) | Blocking: A15.7 (Task2 trigger) merge and any change to migration 0016 or `outbox.ts` | ✅ founder-verified 2026-10-12 |
| IT-T2AT-01 | Task2 / Task15 | Commit/outbox atomicity, terminal failure quarantine, pending-row progress, replay and rebuild continuation/counts | `apps/api/src/features/telemetry/task2-attesta-trigger-live-verify.ts` | Blocking: A15.7 merge | ✅ founder-verified 2026-10-12 at `e25cf2d`; rerun `5fb2647` correction |
| IT-T2AT-02 | Task2 / Task15 | Merged PR writes one delayed pointer; redelivery and closed-unmerged events add none | `apps/api/src/features/telemetry/task2-attesta-trigger-live-verify.ts` | Blocking: A15.7 merge | ✅ founder-verified 2026-10-12 |
| IT-T2AT-03 | Task2 / Task15 | Successful production deployment and lifecycle writes share one transaction; failures add none and success redelivery reuses the row | `apps/api/src/features/telemetry/task2-attesta-trigger-live-verify.ts` | Blocking: A15.7 merge | ✅ founder-verified 2026-10-12 |
| IT-T2AT-04 | Task2 / Task15 | Company A/B observations produce only tenant-owned outbox rows | `apps/api/src/features/telemetry/task2-attesta-trigger-live-verify.ts` | Blocking: A15.7 merge | ✅ founder-verified 2026-10-12 |
| IT-T9-01 | Task9a / Task9a2 | Disposable PostgreSQL: v1/v2 configuration round-trip, partial/mixed-v2 rejection, immutable release tuple, fleet posture, rollout/offboard records, immutable audit and Company A/B isolation | `apps/api/src/features/fleet/task9-fleet-live-verify.ts` | Blocking: Task9a and later TrackAI fleet contract changes | 🟡 agent-reverified 2026-10-11 via `scripts/it-db.sh`; founder run pending |
| IT-T9-02 | Task9f | Current Intel Mac full local lifecycle: signed PKG, Keychain, managed config, offline queue, update/rollback, rotation, revoke and cleanup | Planned in `docs/plan/TASK9.md` §6 | Blocking: supported macOS local route | ⬜ designed |
| IT-T9-03 | Task9f | Jamf post-login deployment, inventory, update/rollback and offboarding | Planned in `docs/plan/TASK9.md` §6 | Blocking only for Jamf-managed claim | ⬜ pending tenant |
| IT-T9-04 | Task9b, Task9g | Hosted Windows x64 MSI build plus install/uninstall smoke without plaintext output | Existing GitAI release workflow; Task9 assertion to be added | Minimum Windows evidence without a rental | ⬜ Task9 rerun pending |
| IT-T9-05 | Task9g | Native Windows x64 MSI, Credential Manager/DPAPI, restart, update/rollback and revoke | Planned in `docs/plan/TASK9.md` §6 | Blocking only for native Windows claim | ⬜ pending host |
| IT-T9-06 | Task9g | Intune post-login deployment, reconciliation, rollback and retire/offboard | Planned in `docs/plan/TASK9.md` §6 | Blocking only for Intune-managed claim | ⬜ pending host and tenant |
| IT-T9-07 | Task9f | Two-device macOS rollout ring and reconciliation; optional Apple Silicon evidence | Planned in `docs/plan/TASK9.md` §6 | Blocking only for two-device/Apple-Silicon claim | ⬜ best-effort host |
| IT-M9-01 | Task9, Task15 | Signed machine-bound configuration rejects tamper/replay/revocation and preserves last-known-good | Planned in `docs/plan/TASK9.md` §6 | Production blocker shared with D6.1, not Task9 engineering | ⬜ waits for Task15 |

Gating means "must pass on the founder's machine before the named merge or milestone". It does not stop other agents developing against the unit-tested code in parallel.
