# Task16e-audit-tamper Handoff — audit seals, verify report, signed audit export

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task16e-audit-tamper` (base: `main` at `05c8080`). Claude, Task16 A16.4 + A16.7. The audit trail is now sealed in contiguous windows by signed `audit_seal` statements chained in each tenant's Attesta ledger (no second chain or signer, D1–D2); `GET /api/audit/verify` recomputes every sealed row; `/api/audit/exports` gives a signed export an outsider can check. **A16.10 (the auditor database role) moved to its own session** (founder checkpoint 2026-10-15). No web change (console card: Task16f2).

## At a glance
| | Item | Status |
|---|---|---|
| A16.4 | `audit_seal` predicate (`https://trackai.dev/attesta/audit-seal/v1`), seal table, worker/CLI sealing, verify report with the five break kinds | 🟡 IT-T16e-01 agent-verified; ⬜ founder run |
| A16.7 | Signed export (`{export, signature}`, DSSE `application/vnd.trackai.audit-export+json`), job/lease/replay/sink as evidence packs | 🟡 IT-T16e-02 agent-verified; ⬜ founder run |
| TRUNCATE | `security_audit_events` refuses TRUNCATE (0023, SECURITY DEFINER, fixed search_path) | ✅ in IT-T16e-01 |
| A16.10 | `trackai_audit_reader` role | ⬜ moved out (B19) |
| Quality | `npm test` 981 pass; lint, typecheck, `npm run check`, `drizzle-kit check` clean | ✅ |
| Regressions | IT-T15d, IT-T15i2, IT-T15i4, IT-T16c-01 rerun in the sandbox | 🟡 passed in sandbox |
| Review | independent review subagent; Codex cross-review | see "Review" |

## Implemented interfaces
```text
Predicate   https://trackai.dev/attesta/audit-seal/v1 (docs/contracts/attesta/audit-seal.md + 2 schemas); ledger columns
            repository_id/statement_kind/subject_sha null ("repository_id":null in canonical_record)
Tables      attesta_audit_seals (append-only; insert guard: digest, document↔columns↔record, previous = latest seal)
            audit_exports (evidence-pack job guards); attesta_records.repository_id nullable for audit_seal only
Routes      GET  /api/audit/verify?from&to          → {ok, from, to, seals_checked, breaks[{kind, seal, row_id?}],
                                                       breaks_truncated, unsealed_tail{from, count}, chain{ok, checked}}
            POST /api/audit/exports {from,to} + Idempotency-Key → 202 {id, status, replayed}
            GET  /api/audit/exports/:id  ·  GET /api/audit/exports/:id/content → {export, signature}
CLI         npm run attesta:audit-seal -w apps/api [-- --tenant <uuid>] [--confirm]   (dry run by default)
            attesta:build -- --loop also runs one sealing pass per iteration (actor service attesta-worker)
Audit       catalog v2: audit.trail.sealed, audit.trail.verified, audit.export.requested, audit.export.downloaded
Codes       AUDIT_EXPORT_NOT_FOUND 404, AUDIT_EXPORT_CONFLICT 409, AUDIT_RATE_LIMITED 429 (audit/http.ts, additive);
            job error_code AUDIT_EXPORT_{TOO_LARGE,SIGNER_NO_CREDENTIAL,SIGNER_UNAVAILABLE,UNAVAILABLE,INTERNAL}
```

## Ported from
RP-1 (SushiCorp @ `0bd67a5`) as Task15i4 translated it: a small signed statement names a stored document's digest. EV-1 reused through `chainStatement`. AU-1 layer 4 not ported here (A16.10 moved).

## Founder-approved decisions (checkpoint 2026-10-15)
1. A tenant's first seal covers all its history, in back-to-back seals of at most 50 000 rows.
2. One export covers at most 366 days (400 otherwise); events beyond 200 000 fail the job (`AUDIT_EXPORT_TOO_LARGE`).
3. `attesta_records.repository_id` is nullable for `audit_seal` only; additive null handling in `attesta/read-service.ts`, `verify-chain.ts`, `evidence-pack-service.ts`, `offline-verifier.ts` (seal statements in whole-tenant packs are checked by schema and typed columns), `api.md`, `tables.md`.
4. New table `audit_exports` and a one-line sealing hook in `attesta-build-cli.ts`.
5. A16.10 moves to its own session. "Do not over-engineer; stay under 0.3×."

## Deviations from spec
- The seal table has no job/lease columns: a seal is written once, inside its ledger transaction (nothing is queued).
- Each seal record is checked by `verifyRange` on its own seq (not the whole seq range), so the report does not depend on unrelated records; the inner `attesta.verify` audit row is not written (`audit.trail.verified` covers the call).
- The export's `events` cover `manifest.covered`: the scope widened to the whole windows of the listed seals, so every listed seal checks row by row.
- Files outside §2.4 touched: `audit/http.ts` (3 additive codes), `attesta/read-service.ts`, `offline-verifier.ts`, `attesta-build-cli.ts` (approved at the checkpoint); test-only: `t15d-ledger-live-verify.ts` (grant on the new table, as Task15i4 did), `task16c-audit-api-live-verify.ts` (catalog version 2), `audit-api.test.ts`.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run the integration block in the final reply | Blocking: Task16e merge |
| ⬜ | A16.10 (B19): reads still run as the API role (RLS bypassed). Design for that session: `NOLOGIN` role, SELECT on `security_audit_events` and `attesta_audit_seals`, `GRANT … TO CURRENT_USER`, `SET LOCAL ROLE` after `set_config('trackai.tenant_id', …, true)`, policy `USING (tenant_id = NULLIF(current_setting('trackai.tenant_id', true), '')::uuid)` (a pooled connection reads an empty string, not null). **Supabase:** `CREATE ROLE` from a migration needs `CREATEROLE`, which the hosted `postgres` role has; no dashboard step, but confirm on the hosted project before relying on it | the next A16.10 session |
| 🟡 | Rows are hashed as JSON (JCS): a pre-contract row whose `details` holds an integer beyond ±(2^53−1) would stop that tenant's sealing (`ATTESTA_API_INTERNAL` in the pass log) | none known (the emitter refuses such values) |
| 🟡 | `occurred_at` is the writer's transaction start; a transaction open longer than the 5-minute settle margin can commit a row into a sealed window (reported as `unsealed_row_in_sealed_window`) | operational: no long audit transactions |
| 🟡 | Anchoring is not configured in IT-T16e (anchors are Attesta's path, covered by IT-T15f2/T15i2) | none |

## Test coverage
Unit (`attesta/audit-seal.test.ts`, no database): row digest vector (independently computed; microseconds, nested details, unicode), document determinism and schema, statement → ledger columns and `"repository_id":null`, cadence (first, hourly, daily-empty, chunk with ties), every break kind, query bounds, export sections/counts/schema and the DSSE signature against a test key (and not as a pack signature). Catalog additions, the only-writer test and the auditor sweep (new routes, POST in `AUDITOR_ALLOWED_WRITES`).

## Integration test impact
> **FOUNDER:** blocking for the Task16e merge. Prerequisites: Docker or local PostgreSQL 16 + pgvector. Expected: all pass, a few minutes.
> ```bash
> scripts/it-db.sh npm run verify:task16e-audit-tamper-live -w apps/api
> scripts/it-db.sh npm run verify:task15d-ledger-live -w apps/api
> scripts/it-db.sh npm run verify:task15i2-evidence-packs-live -w apps/api
> scripts/it-db.sh npm run verify:task15i4-period-report-live -w apps/api
> scripts/it-db.sh npm run verify:task16c-audit-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T16e-01 | Seal, contiguous empty seal, clean report, three tamper breaks, TRUNCATE/UPDATE/DELETE refused, insert guard | Blocking: merge | 🟡 agent-verified · ⬜ founder run |
| IT-T16e-02 | Export request/replay/409/400, ready, download, `verifyTrusted`, sections, seal rows, Company A/B 404, audits | Blocking: merge | 🟡 agent-verified · ⬜ founder run |
| Regressions | IT-T15d (guards byte for byte + new grant), IT-T15i2, IT-T15i4, IT-T16c-01 | Blocking: merge | 🟡 agent-verified · ⬜ founder run |

## Integration notes (Task16f2 inputs)
- **Offline verifier:** implement `docs/contracts/audit/export.md` "What a verifier checks" steps 1–7 (schemas: `audit/export-v1.schema.json`, `attesta/audit-seal-document-v1.schema.json`, `attesta/predicate-audit-seal-v1.schema.json`; reuse the pack verifier's trust and anchor steps).
- **Console card:** the verify report shape above; `unsealed_tail` is "not sealed yet", never "verified"; `chain.ok` false with no breaks means signatures or anchors could not be checked.
- **Deploy:** run `attesta:build -- --loop` (or schedule `attesta:audit-seal --confirm`); a tenant without an active statement key is skipped (`no_key`).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens |
|---|---|---|---|---|
| 0.2× (re-estimated 0.22× without A16.10) | about 0.24× | ~95 turns + review | ~2.5 h | n/a |
