# Task15i4-attesta-period-report Handoff — Attesta: the signed `period_report` statement

> Status: ✅ done · 🟡 partial or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do (AGENTS.md §11).

Branch `task/Task15i4-attesta-period-report` (base: `main` at `3c862ef`). This adds the founder's one signed figure: "what share of repository X was AI-assisted between `from` and `to`". A report document is computed only from the signed ai-provenance statements in the window. The document is signed as a `period_report` statement naming its digest, chained and anchored like any statement, and served by three routes. The session does not cover evidence packs carrying report documents (`reports` stays `[]`, deferred by the founder on 2026-10-14), console work, or per-developer figures.

## At a glance
| | Item | Status |
|---|---|---|
| Contract | `predicate-period-report-v1.schema.json` (whole statement at `#/definitions/statement`), `period-report-document-v1.schema.json`, `period-report.md` "Figures v1", rules P1–P10, jobs and routes. No new error codes | ✅ |
| Ledger | Migration 0022 replaces the 0017 shape check and chain guard (0017 untouched). `deriveStatementColumns` and `chainStatement` take both predicate types; `verify-chain.ts` needed no change | ✅ |
| Report | `period-report-rules.ts` (document, statement, P1–P10) and `period-report-service.ts` (job: snapshot → build → sign → one ledger transaction for record + document + ready) | ✅ |
| Table | `attesta_period_reports` (job, lease, idempotency, document, digest, record FK; RLS; guards) | ✅ |
| Routes | `POST /api/attesta/period-reports`, `GET …/{id}`, `GET …/{id}/document` under `attesta.export`, in the AU-1 sweep | ✅ |
| Packs | Item 6 deferred (founder). The offline verifier checks a report statement in a pack against its schema and record; `reports` → not checkable (exit 2) | ✅ |
| Quality | `npm test` 921 pass; `typecheck`, `lint` and `drizzle-kit check` clean | ✅ |
| Integration | IT-T15i4-01…03, plus regressions IT-T15d, IT-T15i2 and IT-T15i3, all pass in the agent sandbox | 🟡 ⬜ founder run |
| Review | Review subagent: 0 must-fix, 4 should-fix (3 fixed, 1 documented), 3 minor (2 fixed or documented, 1 left to Muse) | ✅ · cross-agent ⬜ |

## Implemented interfaces
```text
POST /api/attesta/period-reports   {repository_id, from, to} + Idempotency-Key → 202 {id, status, replayed}; 409 other scope; 429 >4 open
GET  /api/attesta/period-reports/{id}            {status, scope, report_digest, statement_digest, error_code, retryable, document_path}
GET  /api/attesta/period-reports/{id}/document   the stored RFC 8785 document bytes, no-store, audited (attesta.report.download)
npm run attesta:report -w apps/api -- --run-queued [--limit N]   recovery of queued or stranded jobs (as attesta:pack)
period-report-rules.ts: computeReportDocument, buildReportStatement, checkPeriodReport (P1–P10; P9 with inputs), reportValidators
period-report-service.ts: runPeriodReport, runQueuedReports, pgReportStore(db, {clock?}), parseReportRequest
ledger.ts: PERIOD_REPORT_PREDICATE_TYPE; StatementColumns.statementKind/subjectSha nullable, + subjectName
```

## Ported from
SushiCorp @ `0bd67a5`, catalog RP-1: `services/reporting/{models,signing}.py` and `tests/unit/reporting/test_reporting_integrity.py`, the first file committed. What was ported: regeneration is byte-identical, generation time is never in the body, a tampered report, record or figure is detected, and the signature covers a small statement naming the digest. Deviations: an in-toto statement in DSSE; basis points, never percentage strings; records named by digest and seq; no PDF; the document lives in the job row, not a sink, so it commits with its record.

## Founder-approved decisions (2026-10-14)
1. A commit seen in several statements counts once, by its latest statement in range. Lines come from `commit_observed` only and merged figures from `pr_merged` only.
2. Small `offline-verifier.ts` change. Without it, any pack whose window holds a report would fail with `SCHEMA_INVALID`.
3. "Reports in packs" (`buildPack`, pack schema, oracle) goes to a follow-up.

## Deviations from spec
- `schema.ts`: the `attesta_records` shape check had to change too, so the drizzle snapshot matches 0022.
- New files outside the list: `attesta-report-cli.ts` (recovery; review finding) and `testing/period-report-fixtures.ts` (test support). `package.json` gets `attesta:report`.
- `t15d-ledger-live-verify.ts`: one grant line. The RLS role now also gets TRUNCATE on `attesta_period_reports`, so `TRUNCATE … CASCADE` still reaches the guard (ATG01) instead of 42501. This is the same fix as Task15f2's.
- Not edited (outside the pre-approved list): `api.md` (still lists only the POST row; `period-report.md` documents all three routes), `tables.md` and the README file table. A lead docs pass should add the new table and schemas there.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T15i4-01…03 and the IT-T15d / IT-T15i2 / IT-T15i3 regressions (commands below) | Blocking: merge |
| 🟡 | A pack whose window holds a report exits 2: `reports` is not checkable until packs carry documents | Customer automation expecting exit 0 on such packs; follow-up: reports in packs, plus Muse's figure check in the offline verifier |
| 🟡 | `recorded_at` is stamped by the writer's clock, while settling is judged on the database clock (the pack assumption, `evidence-pack.md`) | An API host lagging more than 5 minutes could chain a statement into a reported window afterwards. P9 regeneration then differs, so it is detectable but not prevented. Operations: NTP |
| 🟡 | Without the document, the offline verifier checks only the report statement's schema and typed record. Document-free rules (P1, P3 counts, P6, P7, P10) are left to the reports follow-up | Muse, with item 6 |
| 🟡 | Job recovery is a CLI; nothing schedules it | Task14 |

## Test coverage
- **Unit tests** (no database): ported RP-1 integrity tests; every figure against an independent oracle and the checkpoint example (7619 bp); dedupe, partial, unavailable and zero inputs, basis points; tampering (document, both re-signed via P9, left-out statement, tampered input, ratio, completeness, scope, tenant, empty range); privacy scan, closed schemas; ledger derive and refusals; verify-chain with a report row; job runs (ready, stale rebuild, failure codes, recovery); routes (202, audit, no-store, 409, A/B 404s, 400s, 429, AU-1 sweep); offline verifier with an honest and a forged report record.
- **Mocked:** only the job store in the route and job unit tests; the live test uses the real stack.

## Integration test impact
> **FOUNDER:** blocking for the merge. Prerequisites: Docker or local `postgresql-16-pgvector`. Expected: every line `=passed`, about 6 minutes in total.
> ```bash
> scripts/it-db.sh npm run verify:task15i4-period-report-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15i4-01 | Builder statements → report job → chained (kind, sha and outbox null) and anchored (Rekor + TSA) → `/verify` ok with signatures and anchors. Document P1–P10 + P9 against the database. A pack over the window lists the report; inputs chosen from the pack recompute it; offline verifier: statements passed, reports not checkable, exit 2. Routed report: regenerated document byte-identical, `previous` names the first | Blocking: merge | 🟡 agent-verified 2026-10-14 · ⬜ founder run |
| IT-T15i4-02 | Company A/B: the same 404 for A's report and document as for an unknown id; B cannot report on A's repository; B's report sums none of A's statements | Blocking: merge | 🟡 agent-verified · ⬜ founder run |
| IT-T15i4-03 | Auditor POST, replay, 409, request and download audits. Ten 0022 job guards refused. Eight malformed period_report records refused by the replaced chain guard, as the API role and as an RLS-bound role; chain intact afterwards | Blocking: merge | 🟡 agent-verified · ⬜ founder run |
| IT-T15d, IT-T15i2, IT-T15i3 (regression) | The 0017 guards still refuse every ai-provenance attack; packs and key windows unchanged | Blocking: merge | 🟡 agent-verified 2026-10-14 · ⬜ founder run |

## Integration notes
- Reports follow-up: `checkPeriodReport` is pure (canonical, merkle, ajv), so the offline verifier can run P1–P10 once packs carry `{report_document, statement_digest}`. `read-service` already lists reports with `kind=period_report`; the console shows "Period report".

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.22× (0.3× with packs; packs deferred) | about 0.25× | ~90 turns + one review subagent | ~2.5 h | not shown |
