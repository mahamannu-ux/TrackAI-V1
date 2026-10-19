# Task19f-qa-numbat-questions Handoff — Numbat Q&A

Branch `task/Task19f-qa-numbat-questions` (base: `main` at `5c9c98f`).

## At a glance
| Item | Status |
|---|---|
| S19–S26 registry, contract additions and catalogue | 🟡 built; founder run pending |
| S26, S23 and S21 live answers | 🟡 unit and agent integration verified |
| IT-T19f-01 | 🟡 agent-passed 2026-10-19; ⬜ founder run, blocking Task19f merge |
| Cross-agent review | ⬜ Task19 lead review pending |

## Implemented interfaces
- Q&A registry version **2**, 46 questions and 17 gaps. Digest: `sha256:319b894e4f80b8bfa1e22161c8c75b964c8f5ce6e09c64b59d1993bde9116618`.
- Additive reasons: `data_setting_off`; founder-approved `zero_denominator` for a rate with no decisions. Additive gaps: G14–G17. Both schema copies, web types, message text and generated question list agree.
- `computeS26`: `permission_requested`, `permission_approved`, `permission_denied`, `approval_rate`, `sessions_with_finding_and_approval`. The last figure is always partial (`partial_linkage`); it is a same-session association.
- `computeS23`: `distinct_domains`, `distinct_urls`, `distinct_ip_addresses`, `indicator_observations`. URL data settings determine recorded, partial or unavailable; unavailable values are null. Indicator values never enter envelopes.
- `computeS21`: `guardrails_off_findings`, `guardrails_off_sessions`, and unavailable `bypass_flag_launches` (G16). Answer is partial.
- Loader: `loadSecurityContext` reads permission events, indicators and settings history through `withTenant`, alongside existing findings.
- S19/S20 await Task20h-b (G14); S22 awaits MCP identity (G15); S24 awaits the opt-in enforcement pilot (G17); S25 is phase 2, awaiting Task15 case-bundle work.

## Deviations from spec
- With the founder's 2026-10-19 approval, added `zero_denominator` to the closed reason enum because the contract requires a reason for an unavailable approval rate.
- Existing v1 fixture files remain unchanged; the contract test supplies the current registry version when checking their envelope shapes.
- Per-worktree `git config` was blocked by permissions on the shared Git config; commits use command-scoped identity.

## Known limitations
- S19's approved-list comparison and agent versions remain unavailable; Numbat inventory reports no versions.
- S23 counts metadata only when the tenant enables URL data upload. No values or drill-down leave the Security console.
- No auditor kind is built for the new phase-1 questions; live answers remain admin-only.

## Test coverage
- Unit tests: registry/catalogue ranks and digest, schema copies, fixture, S26 counts and zero denominator, S23 settings and value privacy, S21 G16, unbuilt answers, real envelope validator.
- `npm run check` passed: 1,252/1,252 unit tests, typecheck, lint, Drizzle check and web build. The focused Q&A suite passed 36/36 after the final breakdown assertions.
- The sandbox blocked local listener tests and PostgreSQL shared memory; IT-T19f-01 passed with command-scoped escalation on a disposable database.

## Integration test impact
- **IT-T19f-01:** `scripts/it-db.sh npm run verify:task19f-qa-live -w apps/api`. Blocking Task19f merge. Requires local PostgreSQL 16 with pgvector or Docker via `it-db.sh`.
- 🟡 Agent-passed 2026-10-19: seeded Company A/B figures, S23 URLs-off, isolation, auditor 403 and 46 questions. ⬜ Founder run.

## Integration notes
- Register version 2 before deployment. Run the new live verifier on the founder machine before merge.
- The `data_setting_off` state is based on settings versions in force from the start through the end of the period; absent history is treated as off.

## Effort
- Estimate: about 0.10× T6. Actual: about 0.17× T6. The added zero-denominator contract decision, historical fixture validation, and disposable database verifier account for the overrun. A follow-up prompt should name the zero-denominator reason and the versioned-fixture rule upfront.
