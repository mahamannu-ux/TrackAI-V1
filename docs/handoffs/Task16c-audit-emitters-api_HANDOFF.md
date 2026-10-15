# Task16c-audit-emitters-api Handoff — Audit emitters and read API (A16.5 + A16.6)

Branch `task/Task16c-audit-emitters-api` (base: `main` at `d8d9101`). All 37 audit writes go through `recordAuditEvent()`; new auditor read API `GET /api/audit/events`, `/events/:id`, `/catalog`; every read writes one `audit.events.read` in the same transaction. No migration, no web change, no new dependency.

## At a glance
| | Item | Status |
|---|---|---|
| A16.5 | 37 sites migrated (Task4: 22, Task5: 5, Task6: 1, Task9: 3, Task15: 6); only-writer test | 🟡 sandbox green, founder regression runs pending |
| A16.6 | Read API + `audit.events.read` flipped to emitted, catalog regenerated (v1, 48 emitted + 9 reserved) | 🟡 IT-T16c-01 agent-verified, founder run blocks merge |
| Quality | `npm run check`: 968 unit tests, typecheck, lint, drizzle check, web build | 🟡 sandbox green |

## Implemented interfaces
- `GET /api/audit/events` (filters `action`×20, `severity`, `actor_type/id`, `target_type/id`, `from/to`, `limit` 1–200 default 50, opaque keyset cursor over exact `occurred_at` text + filter hash) → `{events: AuditEventV1[], next_cursor, catalog_version}`; `GET /events/:id` → `{event, catalog_version}` (cross-tenant and unknown share one 404); `GET /catalog` → `{catalog_version, actions[]}` (no audit write). Codes: `AUDIT_API_UNAUTHENTICATED/FORBIDDEN/FILTER_INVALID/CURSOR_INVALID/EVENT_NOT_FOUND/API_UNAVAILABLE`; `X-Request-ID` + `no-store` everywhere.
- Legacy `GET /api/admin/audit` keeps path/query/camelCase, adds `severity` + `catalogVersion`, writes one `audit.events.read` (`filters: ['limit']`) in-transaction. Admin `dateValue` refuses years outside 1–9999, `stringArray` refuses items over 512 chars (both 400 via `badRequest`).

## Deviations (spec-mandated, no alternative)
- `audit.events.read` flip forced contract-test updates (fixture, 47→48, info 8→9, reserved list, inventory parity) and `admin.routes.test.ts` (rule 7 needs route tests; not in the "New:" list). `security.test.ts` gained the rule-3 classifier test; `worker.test.ts` fake accepts emitter SQL.

## Rule-2 interpretation and `revokeAdminMembership`
- Admin-guarded mutations keep literal `tenant_admin` (README "Actor vocabulary" sentence added): the sweep proves guards deny auditors, so `req.adminRole` can only hold it; threading the role through ~25 signatures would change no row. Role-taking sites (findings, Attesta, raw reveal) unchanged in behavior.
- `revokeAdminMembership` (`admin-security-service.ts:86`) migrated as-is, not deleted; Task4 decides (no caller).

## Test coverage
968 unit tests (was 949): `only-writer.test.ts` (emitter is the sole writer; allow-list: wave1 probe, t15i3 trigger test), `audit-api.test.ts` (15: every filter + invalid, 3-page same-instant paging, tampered/rebound cursor, cross-tenant 404, unknown action → high, 401/403/503 problems, one read-event per read with names only, auditor in/developer out), `admin.routes.test.ts` (year/item bounds), export classifier test.

## Integration test impact (all blocking for this merge, ⬜ founder run)
- `scripts/it-db.sh npm run verify:task16c-audit-live -w apps/api` → `IT-T16c-01 passed` (🟡 agent-verified 2026-10-15).
- Regressions (rows read, must still pass): `verify:task16b-audit-live`; `verify:task4-machine-lifecycle-live`, `verify:task4-wave4-admin-lifecycle-live`, `verify:task4-wave4-github-live`, `verify:task4-wave5-export-live`; `verify:task5-opencode-live` (+ new `raw_read_audit_actor_type_failed` assertion), `verify:task5-retention-live`; `verify:task9-fleet-live`; `verify:task15h-builder-live`, `verify:task15i-evidence-api-live`, `verify:task15i2-evidence-packs-live`, `verify:task15i3-verify-keys-resume-live`, `verify:task15i4-period-report-live`, `verify:task15l2-trust-live`.

## Integration notes
Emitter needs only `execute`, so Drizzle tx/db, `WorkerDatabase`/`TrustDb` all work; atomicity unchanged everywhere (anchor resume keeps batch + `request_id` in one tx for the 0021 trigger). `AUDIT_CATALOG_VERSION` stays 1.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Wall-clock |
|---|---|---|
| about 0.12× | about 0.13× | one session |
Slight over: the flaky first baseline run and the `worker.test.ts` FakeDb fallout (emitter SQL has no `/* worker: */` tag). Next prompt: nothing structural; the read-API/store split worked.
