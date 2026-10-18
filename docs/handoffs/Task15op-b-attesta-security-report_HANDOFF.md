# Task15op-b-attesta-security-report Handoff — Attesta security period report (A15.16)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15op-b-attesta-security-report` (base: `origin/task/Task15op-attesta-security` at `bac0906` = `main` `43431fe` + the Task15op close-out and this prompt).

One signed set of security figures per tenant (or repository) and period, computed **only from sealed, verified finding rows** (Task15op-a seals), for questions S7, S8, S9, S11 and S12. The CLI builds and chains it; two routes read it. No migration, no POST job, no evidence-pack change (`reports: []` stays).

## At a glance
| | Item | Status |
|---|---|---|
| Scope | builder: request, coverage (NOT_SEALED / SEAL_BROKEN), counted rows, figures, document/statement, SR1–SR9, sign then chain in one ledger transaction, idempotent `existing`, `previous` | ✅ |
| Scope | `npm run attesta:security-report` (dry run default), `GET /api/attesta/security-period-reports/:id` and `/:id/document` | ✅ |
| Scope | contract detail (SR1–SR9, decision projection, audit actions) in `security-period-report.md`; audit catalog v4 | ✅ |
| Quality | `npm test` 1194 tests, 1192 pass, 2 skipped (as on `main`); `tsc` clean; `security-report.test.ts` 19 tests | ✅ |
| Integration | IT-T15op-02 (new); IT-T15op-01 and IT-T15i4-03 re-run once | 🟡 agent-verified; ⬜ founder run, blocking this merge |
| Review | independent review subagent; cross-agent review (Codex) | 🟡 see "Review" below; ⬜ Codex |

## Implemented interfaces
```text
npm run attesta:security-report -w apps/api -- --tenant <uuid> --from <ms> --to <ms> [--repository <uuid>] [--confirm]
  outcome=would_build|built|existing|refused  seals= rows= decisions=  [report_id= report_digest= statement_digest=]  [code=]
GET /api/attesta/security-period-reports/:id           attesta.export, no-store → {id, scope, report_digest, statement_digest, created_at}
GET /api/attesta/security-period-reports/:id/document  attesta.export, no-store attachment; digest mismatch = 500; audited
audit: attesta.security_report.built {scope_from, scope_to, repository_id|null, report_digest, statement_digest, row_count, seal_count, request_id}
       attesta.security_report.downloaded {report_digest, statement_digest, request_id}
security-report-rules.ts: computeSecurityReportDocument, buildSecurityReportStatement, checkSecurityReport (SR1–SR9), decisionDigest, reportRowOf
security-report-service.ts: parseSecurityReportScope, buildSecurityReport, checkCoveringSeal, coverageRefusal, pgSecurityReportStore
```
Refusal codes: `ATTESTA_API_INVALID_QUERY`, `ATTESTA_SECURITY_PERIOD_NOT_SEALED`, `ATTESTA_SECURITY_SEAL_BROKEN`, `ATTESTA_BUILDER_TOO_LARGE`, `ATTESTA_BUILDER_SCHEMA_INVALID`, `ATTESTA_BUILDER_RULE_VIOLATION`, `ATTESTA_SIGNER_NO_CREDENTIAL`, ledger codes. No new error code.

**SR1–SR9** (full table in `security-period-report.md`): SR1 subject and bounds; SR2 one scope, the record's tenant, `previous` unique; SR3 covering seals ordered, contiguous, unique, reaching `to`, `seals_root`; SR4 roots and counts; SR5 bucket sums = findings; SR6 completeness and availability; SR7 `blocked`/`coverage` fixed; SR8 predicate = document figures; SR9 recompute gives the same bytes.

**For Task19 (S7–S12 answers) and A16.13b:** cite the report's statement digest and its document (`/document`); `findings`, `by_severity`, `by_category`, `by_rule`, `by_repository`, `by_agent`, `by_model`, `by_platform`, `outcomes`, `late_arrivals` are sealed-row figures; `denied_by_request` is `partial`/`not_sealed` (a request count, never "blocked"); `blocked` and `coverage` are always `unavailable`.

## Ported from
Pattern only: Task15i4 period report (SushiCorp RP-1 @ 0bd67a5, catalog RP-1), through `period-report-rules.ts`. The seal checks are Task15op-a's own functions (`assembleSecurityVerifyReport` one seal at a time, `readSecurityRows`), not copies.

## Decisions made in this session
1. **Every bucket figure keeps every row** (fixed `unknown` / `unavailable` / `not_enrolled` / `v2_unclassified` buckets), so SR5 sums always hold; a figure with rows but no value at all is `unavailable`/`source_missing` (e.g. `by_model` for a Task6.a-only period). An "unknown" bucket alone never makes a figure partial (the schema has no such reason); completeness shows it.
2. **The token/`sha256:` fallback applies to every bucket key**, not only `model` (the schema's key pattern binds all of them).
3. **A gap between covering seals is BROKEN** even when no link inside the period shows it (a removed seal); rows before the first seal in the period are BROKEN.
4. **Idempotency is by document digest across all stored reports of the scope**: inputs that return to an earlier state return that earlier report (the `(tenant_id, report_digest)` key allows nothing else).
5. **Audit catalog version 3 → 4** (README: "goes up when an entry is added"; Task15op-a added two entries without a bump).
6. Limits: at most 20 000 covering seals and 500 000 counted rows per report (`ATTESTA_BUILDER_TOO_LARGE`; split the period).

## Deviations from spec
- `core/security/auditor-sweep.test.ts` (not pre-approved): two additive rows classifying the new routes as `attesta.export` reads. The sweep fails without them; test-only.
- The live verify copies IT-T15op-01's world helpers instead of importing them (that file runs `main()` on import and is not pre-approved).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | run IT-T15op-02 (command below) | blocks this merge |
| 🟡 | v2 platform is the machine's **current** state (no history until G7) | `by_platform` is `partial`/`current_machine_state`; a platform change gives a new report |
| 🟡 | enforcement decisions are **not sealed** | `denied_by_request` is `partial`/`not_sealed`; a changed decision changes the next report's digest only |
| 🟡 | evidence packs carry no report documents (`reports: []`) | the offline verifier passes the statement, reports SR1–SR9 as not checkable (exit 2) |
| 🟡 | one report holds its counted rows in memory (≤ 500 000) and reads one query per covering seal | a very large year needs shorter periods |

## Test coverage
`security-report.test.ts` (no database, dev signer): figures from both generations; `not_enrolled`, `unknown`, `unavailable` buckets; a hashed model; `late_arrivals`; `denied_by_request` tenant and repository; each SR rule refusing a crafted, re-hashed violation (SR7 through the schema); deterministic bytes; >10 000 buckets and a statement over the signer limit (`TOO_LARGE`); `existing`, `previous`, the stale-retry; NOT_SEALED, gaps and broken seals (changed, missing, late row, crafted statement, broken link); Company A/B; the offline verifier on a built statement (exit 2). `attesta-api.test.ts`: both routes in the sweep, no-store, attachment, audit, digest mismatch 500, B's 404, bad ids 400. Not unit-tested: the pg queries (IT-T15op-02 covers them).

## Integration test impact
> **FOUNDER:** blocking for this merge. Prerequisites: Docker or local PostgreSQL 16 with pgvector. Expected: `IT-T15op-02=passed`, about 1 minute.
> ```bash
> scripts/it-db.sh npm run verify:t15op-b-security-report-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15op-02 | the report on real PostgreSQL: NOT_SEALED, seal, CLI dry run, tenant + repository reports chained, `/api/attesta/verify` ok, both routes, B's 404, `existing`, platform change → `previous`, tampered row → SEAL_BROKEN, audit events, B isolation | Blocking: Task15op-b merge | 🟡 agent-verified 2026-10-18 · ⬜ founder run |
| IT-T15op-01, IT-T15i4-03 | regression (shared ledger arm and seal service) | non-blocking | 🟡 agent re-run passed 2026-10-18 |

## Integration notes
- Seal before reporting: `npm run attesta:security-seal -w apps/api -- --tenant <t> --now --confirm`, then the report with `to` ≤ the seal's cutoff.
- A report over a period with any break anywhere in its covering seals is refused for every scope; investigate with `GET /api/attesta/security-seals/verify`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.18× | about 0.20× | ~70 turns + review | ~2.5 h | ~0.5M tokens |
