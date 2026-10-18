# Task15op-attesta-security Handoff — Attesta security seals (part a) and the security report contract

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15op-attesta-security` (base: `main` at `c30c6ab`). Pattern: Task16e audit-seal / Task15i4 period-report (SushiCorp RP-1); no new SushiCorp port.

Task15op-a closes gap G6 for S1. A signed, chained `security_findings_seal` statement covers each contiguous window of a tenant's `security_findings` rows (both generations, by `received_at`), so a deleted, changed or late-inserted finding row is detectable. It also freezes the `security_period_report` contract, its ledger arm and its table (migration 0027). The report builder, its CLI and its route are **Task15op-b**. Not touched: ingest (Task20d), the Endpoint, case bundles (S25, phase 2), the console, Q&A.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | Seal document, statement, rules SS1–SS6 (`docs/contracts/attesta/security-findings-seal.md`, two schemas, `security-fixtures/`) | ✅ |
| Scope | Security report contract and schemas (`security-period-report.md`); builder deferred to 15op-b | 🟡 contract only |
| Scope | Migration 0027: chain guard and shape check extended to both types, two append-only tables, TRUNCATE refused on `security_findings` | ✅ |
| Scope | `attesta:security-seal` (dry run, `--confirm`, `--now`, `--tenant`), audited | ✅ |
| Scope | `GET /api/attesta/security-seals/verify` (missing / changed / late / links / orphans / unsealed tail); `/api/attesta/verify` and the offline verifier accept both types; packs carry seal and report statements | ✅ |
| Quality | `npm test` 1171 pass, 0 fail, 2 skipped (with `main` at `fbea993`, PR #85 merged in); type check, lint, `drizzle-kit check` clean | ✅ |
| Integration | IT-T15op-01 founder passed 2026-10-18; IT-T15d, IT-T15i4, IT-T16e, IT-T16e2 and IT-T20d re-run green on 0027 | ✅ |
| Review | Independent review subagent: 2 must-fix, 4 should-fix, all fixed; Codex round 1: one must-fix (SS3–SS4 not recomputed from the rows), fixed; re-review skipped by the founder (2026-10-18), tests run and merged | ✅ |

## Implemented interfaces
```ts
// ledger.ts
SECURITY_FINDINGS_SEAL_PREDICATE_TYPE = 'https://trackai.dev/attesta/security-findings-seal/v1'   // subject trackai:tenant/<t>/security-findings/<from>..<to>
SECURITY_PERIOD_REPORT_PREDICATE_TYPE = 'https://trackai.dev/attesta/security-period-report/v1'   // subject trackai:tenant/<t>[/repository/<r>]/security-period/<from>..<to>
// security-seal-service.ts
securityRowDigest(row) · buildSecuritySealDocument · buildSecuritySealStatement · planSecuritySealWindow · nextMicrosecond
parseSecuritySealDocument · checkSecuritySealRows · runSecuritySealPass · pgSecuritySealStore · readSecurityRows
verifySecuritySeals(deps, {tenantId, actorId, actorRole, requestId, query: {from, to}}) → {ok, seals_checked, breaks, breaks_truncated, unsealed_tail, chain}
```
- **Documents:** `https://trackai.dev/attesta/security-findings-seal-document/v1`, `…/security-period-report-document/v1`.
- **Tables:** `attesta_security_finding_seals`, `attesta_security_period_reports`.
- **Commands:**
  - `npm run attesta:security-seal -w apps/api [-- --tenant <uuid>] [--now] [--confirm]`
  - `npm run verify:t15op-security-live -w apps/api`
- **Audit actions:** `audit.trail.security_findings_sealed`, `audit.trail.security_findings_verified`.
- **Error codes:** `ATTESTA_SECURITY_SEAL_INSTANT_OVERFLOW`, `ATTESTA_SECURITY_PERIOD_NOT_SEALED`, `ATTESTA_SECURITY_SEAL_BROKEN`.
- **Verify break kinds:** the audit-seal names.

## Founder-approved decisions (checkpoint 1, 2026-10-18; the founder approved every recommendation)
1. **Split:** 15op-a (this branch) and 15op-b (the report builder, about 0.18×, no migration).
2. **Seals, not per-finding statements;** the window basis is `received_at`, so a late upload lands in a later window. The report shows `late_arrivals`.
3. **No worker loop:** `worker.ts` is not pre-approved. The founder schedules `attesta:security-seal --confirm` hourly.
4. **Evidence packs:** `reports` stays `[]` (frozen pack schema). Seal and report statements travel as ordinary statements; the documents need a separate, approved pack change.
5. **v2 platform in the report:** `partial` / `current_machine_state`, with the document listing `{machine_id, platform}` and no per-machine counts.
6. **TRUNCATE:** 0027 refuses TRUNCATE on `security_findings` (Task20's table, additive).

## Deviations from spec
- **Projection:** the row digest covers **every column except `tenant_id`, `title` and `tags`** (45 keys), a superset of the prompt's list. The review found that `confidence`, `detected_at` and others could otherwise be changed undetected.
- **Window size:** 8 000 rows per seal, so a document stays about 1 MiB. The statement is about 1 KB whatever the count; the signing limit bounds the statement, so the cap is on the document. One instant is never split: an instant with more than 8 000 rows is sealed alone, up to 50 000 rows.
- **Backlog:** rows left after a seal the row cap cut short are sealed in the same pass.
- **Settle margin:** 10 minutes (audit seals use 5).
- **Shared files touched beyond the pre-approved list:**
  - `core/audit/audit-contract.test.ts`: the new action list, fixtures and counts, as Task20f did.
  - `docs/contracts/audit/catalog.md`: regenerated; it is generated output.
  - `features/attesta/t15d-ledger-live-verify.ts`: its RLS role now gets grants on the two new tables, because `truncate attesta_records cascade` reaches them. Task16e did the same for its seal table.
- **Catalog version:** `AUDIT_CATALOG_VERSION` stays 3, as Task20f left it; the lead decides whether additions bump it.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ✅ | ~~**FOUNDER:** run IT-T15op-01~~ passed 2026-10-18 (PR #86 merged) | none |
| ✅ | ~~`features/security/signing.test.ts:99` failed on `main` after Task15op0 raised the signer cap~~ fixed by Task20f1 (PR #85, 2026-10-18), merged into this branch | none |
| 🟡 | A tenant pack holding a security seal always exits 2 offline (documents and rows are not in packs) | until an approved pack change carries seal documents |
| 🟡 | More than 50 000 rows at one millisecond stops that tenant's sealing (alertable log line; the rows stay `unsealed_tail`) | not reachable at today's 500-record upload limit without at least 100 uploads in the same millisecond |
| 🟡 | `ATTESTA_SECURITY_PERIOD_NOT_SEALED` and `ATTESTA_SECURITY_SEAL_BROKEN` are reserved for the 15op-b builder | n/a here |
| n/a | Case bundles (S25, Numbat `case build`) | phase 2 |

## Test coverage
- **`security-seal.test.ts` (14 tests, dev signer, in-memory store):**
  - an independent Python digest vector, and every column change detected;
  - the document and statement, and the ledger columns for both types;
  - a seal or report naming another tenant refused before any query;
  - the cadence: first, hourly, daily-empty, `--now`, backlog, chunking at 8 000, an instant sealed alone, the 50 000 ceiling;
  - each tamper class, a crafted seal (reordered rows, swapped generation counts, a false one-instant seal) as `statement_problem`, the pure verify report, the round trip for Company A and B, and a moving cutoff giving no extra seals;
  - fixtures.
- **`offline-verifier.test.ts`:** both types pass the statements check with reports not checkable (exit 2), and mismatched typed columns are a break.
- **`attesta-api.test.ts`:** the route sweep classifies the new route.
- **Not unit-tested:** SQL. IT-T15op-01 covers it.

## Integration test impact
> **FOUNDER:** blocking for this merge. Prerequisites: local PostgreSQL 16 with pgvector, or Docker. Expected: `IT-T15op-01=passed` in about 10 s.
> ```bash
> cd ~/AIProjects/TrackAI-v1 && scripts/it-db.sh npm run verify:t15op-security-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15op-01 | Company A: both generations sealed, not due again, an empty linked seal; verify ok and `/api/attesta/verify` ok; delete, change and late insert give exactly the three breaks; TRUNCATE, UPDATE, DELETE and a second first seal refused. Company B: an 8 001-row instant sealed alone, then 8 000 + 3, all linked; no cross-tenant leakage either way. Report ledger arm: tenant and repository scope stored; B's repository, B as tenant, an ignored `previous` and a mismatched row all refused | Blocking: Task15op-a merge | ✅ founder passed 2026-10-18 |

## Integration notes
- **Task15op-b:** build the report from `readSecurityRows` over covering seals after `checkSecuritySealRows` passes. Chain it with `chainStatement`; `previous` is enforced. Insert the row in the same transaction, using `attesta_security_period_reports` (the guards already exist). No migration.
- **Task19 (S1, S10–S12) and A16.13b:** cite `GET /api/attesta/security-seals/verify` for "not added, changed or removed since sealing". Rows in `unsealed_tail` are "not sealed yet", never "verified". A seal never means "blocked" (monitor-only).
- **Deployment:** schedule `npm run attesta:security-seal -w apps/api -- --confirm` hourly. Run it once with `--now` before building a report.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens |
|---|---|---|---|---|
| about 0.27× for part a (0.45× for both parts; the lead estimated 0.35×) | about 0.32× | ~110 turns + one review subagent | ~4 h | n/a |
Under 1.25×. The extra cost came from one review round (backlog and instant rules, the wider projection, report-arm live cases) and from regression runs of other Tasks' live verifies on the new guard.
