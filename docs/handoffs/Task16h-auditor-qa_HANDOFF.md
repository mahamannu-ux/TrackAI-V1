# Task16h-auditor-qa Handoff — the auditor's verifiable and signed answers (A16.13a + A16.13b)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task16h-auditor-qa` (base: `main` at `d87b732`). Started by Muse (commits 1–4), finished by Claude in the same worktree. Registers 18 verifiable and 11 signed answerers on Task19's Q&A contract; the auditor no longer gets `answer_not_built` for them. No migration, no web change, no change to Attesta's signing, statements or reports.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Verifiable code answers from the period-report computation and stored statements; security answers from seal-checked rows; signed answers from the exact-scope stored report; every recorded/partial figure carries evidence whose root recomputes | ✅ unit + 🟡 IT-T16h-01 agent-verified |
| Scope | §2.1 files; one import line in `qa.routes.ts`; contract addition (4 reason codes, 2 fixtures) | ✅ |
| Quality | `npm test` 1244 tests, 1242 pass, 2 skipped, 0 fail; `npm run typecheck`, `npm run lint` clean | ✅ |
| Integration | IT-T16h-01 (a)–(g) passed once in the sandbox; regressions IT-T19a/b/c-01, IT-T15i4, IT-T15op-01/02 passed | 🟡 ⬜ founder run, blocking the merge |
| Review | review subagent: findings fixed (see Deviations) · cross-agent review | ✅ · ⬜ |

## Implemented interfaces
`apps/api/src/features/qa/auditor/`: `evidenceOf` (cap 50 000), `registerAuditorAnswerers(registry = defaultAnswerers)` + `AUDITOR_ANSWERERS`, the answerers, `reportFigures`, and the data-source seams `CodeSource` / `SealSource` / `SignedSource` (pg defaults).

| Kind | Questions | Figures |
|---|---|---|
| verifiable | Q1 Q3 Q9 Q13 (report path) | as §2.2 item 3; Q1 `ai_share_of_repository` G1; tenant = sum over ≤ 200 repositories |
| verifiable | Q4 Q7 Q8 Q11 Q14 Q16 (stored statements) | as item 3; Q7 runs Attesta's verify with no audit row |
| verifiable | S1 S7 S8 S9 S10 S11 S12 | Task19c conventions over seal-checked rows; evidence = covering seal records |
| verifiable | S15 | `security_findings_reads`, `raw_evidence_reveals` over seal-checked audit rows (`withAuditReader`) |
| signed | Q1 Q3 Q9 Q13 / S1 S7–S12 | stored Task15i4 / Task15op-b report for exactly the scope, named by statement digest |
**Not built** (default stays `answer_not_built` + gaps): verifiable Q5, Q6, Q12, Q15 (gaps G2–G5, no field in the statements), S2, S3, S4, S5, S6, S13, S14, S16 (S6 needs the session-text join, G10); signed S2 (coverage is always unavailable in the report).

## Founder-approved decisions
1. Contract addition (35a861a): `not_sealed_yet`, `evidence_broken`, `report_not_built`, `evidence_truncated`; `QA_REGISTRY_VERSION` unchanged.
2. `qa/types.ts` mirrors the four codes in `QA_REASON_CODES` (f076ec3) — **approved by the lead 2026-10-19**.
3. Reading a verifiable or signed answer writes **no** audit row (item 6); Q7's verify uses a no-op audit sink.

## Deviations from spec
- **Unsettled `to`** (Q1/Q3/Q9/Q13): `readSnapshot` refuses a `to` inside the 5-minute settle margin, and the service's default `to` is now; the answer counts the settled part and is `partial` + `not_sealed_yet` (the code's README meaning) instead of a 503. Wholly unsettled → `unavailable` + `not_sealed_yet`.
- **Lead note, one place:** report reasons with no Q&A code map to `vendor_does_not_report` (`source_missing`, `only_some_sources_reported`); Q7 with signatures or anchors not checked is `partial` + `partial_linkage`; security report `current_machine_state` / hashed values → `partial_linkage`, `not_sealed` decisions → `not_sealed_yet`.
- S15 has no `actor_type` breakdown: the frozen registry declares no dimension for S15.
- Verifiable S10 `machines_reporting_status`, S12 `denied_by_request` and S12 `blocked` are `unavailable` + `answer_not_built` (no seal covers status snapshots or decisions); signed S12 `denied_by_request` is the report's request count. Signed S1 gives only the severity breakdown (the report's rule/category/repository buckets count every severity).
- Testability: the answerers read through the three data-source seams (same SQL; in-memory in unit tests). Commit f2732b9 keeps its `wip:` message.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T16h-01 and the regressions (bash block in the final reply) | blocks the merge |
| 🟡 | Report-path answers give no `repository` breakdown (Q1, Q3, Q9, Q13 offer it) | the screen shows totals only for that breakdown |
| 🟡 | Q14 counts source commits whose `commit_observed` statement is in the period | a commit observed before `from` is not counted |
| 🟡 | A bucket key with `/` or `@` outside model/tool (a rule id) fails the envelope check → 503 | none seen; same as Task19c |

## Test coverage
`auditor-answers.test.ts` (21 tests, no database): real statements (Task15i4 fixtures), seal documents (`buildSecuritySealDocument`) and report documents (`computeReportDocument`, `computeSecurityReportDocument`); only row reads are in-memory. Covers every registered answerer through `checkEnvelope`, roots recompute, unavailable = null, tampered/deleted/added row → `evidence_broken`, past the last seal → `partial`, no seal → `unavailable`, no exact report → `report_not_built`, tampered stored report → `evidence_broken`, one statement per subject, tenant sums, unsettled `to`, Company A/B, auditor `kind=live` 403, no person dimension, 50 000 cap.

## Integration test impact
> **FOUNDER:** blocking for the merge. Prerequisites: Docker or local PostgreSQL 16 + pgvector. Expected: `IT-T16h-01 passed`, about 1 minute; regressions as before.
> ```bash
> scripts/it-db.sh npm run verify:task16h-auditor-qa-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T16h-01 | (a) Q1/Q3 verifiable = the period-report computation, roots match; (b) Q3 signed names the report's statement digest, figures = verifiable, other scope `report_not_built`; (c) S7 verifiable = the signed security report, unsealed tail `partial`; (d) deleted sealed row → S1 `evidence_broken`; (e) S15 counts sealed `security_findings.read`; (f) Company B 404 and none of A's evidence; (g) auditor live 403 | Blocking: Task16h merge | 🟡 agent-verified 2026-10-19 · ⬜ founder run |

Regressions passed 2026-10-19 in the sandbox: `verify:task19a-qa-live`, `verify:task19b-qa-live`, `verify:task19c-qa-live`, `verify:task15i4-period-report-live`, `verify:t15op-security-live`, `verify:t15op-b-security-report-live` (each through `scripts/it-db.sh … -w apps/api`).
## Integration notes
Port from: none new (composes RP-1 via Task15i4/Task15op-b, the Task16e and Task15op-a seal checks, Task19c's conventions). Seal `window_from`/`window_to` are **text** columns. The Questions screen needs no change.

## Effort (estimate vs actual)
| Estimate | Actual | Turns | Wall-clock |
|---|---|---|---|
| about 0.2× | about 0.32× (Muse commits 1–4 about 0.17×, Claude about 0.15×) | Muse session + ~90 Claude turns + review | ~1 day elapsed |

Over 1.25×: (1) commits 3–4 were never run against a database, and the review and live verify found five defects (unsettled `to` 503, wrong error class for the 50 000 cap, unmerged PR read the whole repository, text window columns, Q3 null share marked recorded); (2) a handover mid-session; (3) data-source seams added so the unit tests could run without a database. Next prompt: require the live verify skeleton before the answerers, and name the column types of every table read.
