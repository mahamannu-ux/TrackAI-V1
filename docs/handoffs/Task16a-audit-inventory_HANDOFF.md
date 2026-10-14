# Task16a-audit-inventory Handoff — Audit event catalog and auditor guard sweep

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task16a-audit-inventory` (base: `main` at `1dd2918`).

Facts for the audit contract (A16.3) plus one safety test. No product behaviour, migration, or UI changes.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | A16.1 catalog of every action written today + planned events | ✅ 47 actions, 36 sites, 13 observations in `docs/plan/AUDIT_EVENT_CATALOG.md` |
| Acceptance | A16.2 sweep proving mutating admin routes deny `tenant_auditor` | ✅ 4 tests, 42 tabled routes (35 admin/evidence + 5 fleet + 2 attesta writes) + 1 unguarded; 8 attesta GETs walked, untabled; no hole found |
| Scope | All three prompt items incl. test-script registration | ✅ |
| Quality | 936/936 unit tests, typecheck, lint, drizzle check, web build | ✅ (trust-verify "600 keys parse quickly" is a wall-clock assertion that failed 3 full-suite runs in one loaded window — incl. once without the new test file — and passes in isolation and in 3 green full runs; files untouched) |
| Integration | None needed (no DB behaviour changed; sweep is DB-free by design) | ✅ n/a |
| Review | Self-review of full diff; cross-agent review | 🟡 self done; cross-agent pending |

## Implemented interfaces
```
// apps/api/src/core/security/auditor-sweep.test.ts (in npm test)
ROUTE_ACTIONS: "METHOD /api/admin/..." -> AdminAction (40 routes: admin + evidence + fleet)
ATTESTA_WRITE_ACTIONS + AUDITOR_ALLOWED_WRITES: 2 attesta POSTs, auditor-reachable by design
ADMIN_ONLY_READS: 6 GET routes + reason each; UNGUARDED_ROUTES: GET /api/admin/context
// docs/plan/AUDIT_EVENT_CATALOG.md: §1 production events, §2 scripts, §3 planned, §4 observations
```

## Ported from
Ported from SushiCorp AU-1 route-table sweep `tests/unit/api/test_api_auditor.py` @ `0bd67a5` (catalog AU-1). Deviations: Express `router.stack` walk instead of FastAPI routes; action allow-list is a hand table (Express guards close over the action, unreadable at runtime) plus a guard-layer presence check; auditor-allowed set computed from `adminMembershipAllows` instead of hardcoded; fleet and attesta routers swept with a router-level-guard assertion (leading middleware layer) since their guards apply via `router.use`.

## Decisions made in session
1. Auditor reads six actions, not four (`attesta.read`, `attesta.export` added since the prompt); test computes the set.
2. Catalog covers Task9/Task15 emitters too (they write to the same table); raw-SQL sites found via the second grep.
3. The two attesta POSTs are pinned auditor-allowed (audited export-job creation); any new attesta mutation fails the sweep until classified.

## Deviations from spec
None in scope. Pre-approved files only; product sources read-only. No security hole found, so no failing-test stop.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Sweep pins guard presence, not guard identity: swapping one manage action for another on a route passes until the table is re-read | A16.3 note; reviewer re-reads ROUTE_ACTIONS against route files |
| 🟡 | `revokeAdminMembership` service has no callers; only the repair CLI writes `admin_membership.revoked` (catalog §4.4) | A16.3/A16.5 decide dead code vs unwired path |

## Test coverage
Sweep walks four router stacks (import needs no DB — verified empirically), asserts exact route parity, auditor-denied on all 28 non-GET routes except the 2 pinned attesta writes, GET restricted to auditor actions or explicit admin-only reasons. Nothing mocked.

## Integration test impact
> **FOUNDER:** non-blocking for everything. No new integration tests (unit-only session by design).

No founder run needed. A16.3 (contract) can start now; it consumes the catalog.

## Integration notes
`GET /api/admin/context` is unguarded (own-identity only, pinned); `GET /api/admin/operations/exports/:id/download` is GET-shaped but `export.manage` (auditor export comes in A16.7); `GET /api/admin/audit` reads are themselves unaudited (catalog §4.7).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.06× | about 0.06× | ~15 | ~1 h |
