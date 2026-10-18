# Task20i-a-security-reads Handoff — Admin and auditor read API for v2 findings and Endpoint coverage

> Status: 🟡 agent-verified, waiting on founder run and cross-agent review. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task20i-a-security-reads` (base: `main` at `fb73c3c`).

Task20i-a builds the read API the security console (Task20i-b) will call: a findings list and detail over both finding generations plus a per-machine coverage view, mounted at `/api/admin/security/v2`. API only: no web code, no preview reads, no new tables, no migration.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | `GET /findings` with every prompt filter, keyset paging over `(occurred_at desc, id desc)`, `{items, next_cursor}` | ✅ |
| Acceptance | `GET /findings/{id}` with indicators (kind and value only) and nearby (±5 min, same session and machine) enforcement labelled nearby | ✅ |
| Acceptance | `GET /coverage` with literal `unreported` / `no_lease` / `not_acknowledged` states | ✅ |
| Scope | Explicit allowlist per route, pinned by unit test; preview table never named (source-scan test) | ✅ |
| Scope | `security_findings.read` auth (admin and auditor), tenant-bound through `withTenant()`, audited in the same transaction | ✅ |
| Scope | AP-1: RFC 7807 problems, `X-Request-ID` echo, `no-store`, bounded pages; the four prompt problem codes | ✅ |
| Scope | Typed shapes (`SecurityFindingItem`, `SecurityFindingDetail`, `SecurityCoverageRow`, page types) for Task20i-b | ✅ |
| Quality | 9 new unit tests; full suite 1,223 pass; typecheck and lint clean | ✅ |
| Integration | IT-T20i-01 passes in the sandbox (182 rows over 4 pages, both generations, A/B, audit rows) | 🟡 agent-verified · ⬜ founder run (blocking for this merge) |
| Review | Self re-read of the full diff done (two real fixes); cross-agent review by the Task20 lead pending | 🟡 |

## Implemented interfaces
```ts
// features/security-findings/v2-read.ts
export function parseFindingsQuery(query, now?): ParsedFindingsQuery; // every filter; 30-day default; at most 366 days
export function parseFindingId(value: unknown): string;
export function parseCoverageQuery(query): ParsedCoverageQuery; // keyset by machine id
export function encodeFindingsCursor(o, i, filterHash): string;
export function encodeCoverageCursor(machineId): string;
export function toFindingItem(row): SecurityFindingItem;
export const SECURITY_READ_FINDING_COLUMNS; // pinned allowlist (21 keys)
export interface SecurityFindingItem; // generation-neutral; agent = agent_family|source_agent; model v2-only
export interface SecurityFindingDetail; // {finding, indicators: [{type, value}], nearby_enforcement: [...]}
export interface SecurityCoverageRow; // platform | 'unreported'; status | 'unreported'; inventory | 'unreported'; lease | 'no_lease'; acknowledgement | 'not_acknowledged'
export interface SecurityV2ReadStore; // {listFindingsAndAudit, getFindingAndAudit, listCoverageAndAudit}
export const pgSecurityV2ReadStore: SecurityV2ReadStore;

// features/security-findings/v2-read.routes.ts
export function createSecurityV2ReadRouter(deps?: {authorize?, store?, log?}): Router;
export const securityV2ReadAdminRouter; // mounted in app.ts at /api/admin/security/v2, before /api/admin/security
// GET /findings -> {items, next_cursor}; GET /findings/:id -> SecurityFindingDetail;
// GET /coverage -> {rows, next_cursor}; codes SECURITY_READ_{INVALID_QUERY,FORBIDDEN,NOT_FOUND,UNAVAILABLE}
```

## Ported from
None beyond this repository: router pattern copied from `features/security/admin.routes.ts`, allowlist and audit-in-transaction pattern from `features/security-findings/admin-read.ts`, keyset cursor pattern from `features/audit/http.ts` (copied, not imported).

## Founder-approved decisions
1. Audit follows the Task20 lead answer (2026-10-18): every call records `security_findings.read` with exactly the frozen details `{limit, returned}` — list and coverage use the page size and page length; detail uses limit 1 and returned 1 (or 0 for a miss, audited before the 404). The richer `{route, filters, returned}` shape is a Task16 follow-up, not this session.
2. Coverage rows come from `developer_machines` with `status = 'active'`, keyset by machine id ascending.
3. Indicators on the detail route share the finding's machine (latest 100 by `last_seen`), returning only `{type, value}`; nearby enforcement shares machine and session within ±5 minutes.
4. The cursor binds explicit filters only, not the defaulted 30-day window (a request-time `now` in the hash expired every cursor after one page; found by the unit tests).

## Deviations from spec
1. Prompt §2.1 item 5 (audit details `{route, filters, returned}`) superseded by the Task20 lead answer: the frozen `docs/contracts/audit/catalog.md` fixes the details to `{limit, returned}`, and the emitter refuses unknown keys. Only the pre-approved source line was added to `core/audit/catalog.ts` (`features/security-findings/v2-read.ts:460`); nothing under `docs/contracts/` changed.
2. `problemizeAuth` maps a missing identity (401 from the guard) to `SECURITY_READ_FORBIDDEN`, keeping the enumerated four codes with no 401 code.
3. `apps/api/src/app.ts`: one import line plus one mount line (the mount is the pre-approved line).
4. `apps/api/package.json`: the test entry and `verify:task20i-reads-live`, both in alphabetical position.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T20i-01 (blocking for this merge): `IT_PG_DATABASES=trackai_task20i_reads_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20i_reads_live scripts/it-db.sh npm run verify:task20i-reads-live -w apps/api` (about a minute; expect nine `…=` summary lines ending `summary=IT-T20i-01_passes`) | Blocks the Task20i-a merge |
| 🟡 | Audit details carry no route or filter names; richer details need a Task16 audit-contract PR (phase 2, or when a customer asks). Tracked by the Task20 lead; do not open that PR here. | Task20i-b shows no per-route audit trail beyond the frozen shape |
| 🟡 | The auditor sweep (`core/security/auditor-sweep.test.ts`) does not walk the new router yet; all three routes carry `security_findings.read` (pinned by unit test), which is auditor-allowed. | A sweep-table entry for `/api/admin/security/v2/*` is a small follow-up for the sweep owner |
| 🟡 | No index was added; the findings list filters on `occurred_at` and equality columns. If the findings table grows hot, consider a `(tenant_id, occurred_at desc, id desc)` covering shape. | None today; flagged for the founder |

## Test coverage
- **Unit** (`v2-read.test.ts`, 9 tests, in-memory store + real router over HTTP): every filter; paging stability with equal timestamps (7 rows, limit 2, each id once); bad cursor and filter-bound cursor refused; `not_enrolled`; both generations; coverage states `unreported` / `no_lease` / `not_acknowledged` and machine keyset; allowlists pinned (item 21 keys, indicator `{type,value}`, nearby keys); preview table never named in code (comment lines stripped, Task19c pattern); admin and auditor allowed, member refused; problems, `no-store`, `X-Request-ID` echo/mint; the default router guards all three routes with `security_findings.read`; both the v2 and settings routers answer on one app.
- **Mocked:** storage in unit tests (in-memory store mirrors the SQL; the live verify proves parity); the JWT layer in the live verify (header authorizer).
- **Not tested:** volume (hundreds, not thousands, of rows); web console (Task20i-b).

## Integration test impact
> **FOUNDER:** Blocking for the Task20i-a merge. Prerequisites: Docker (or local PostgreSQL 16 + pgvector) for the throwaway database. Expected: nine `…=` summary lines ending `summary=IT-T20i-01_passes`, under a minute.
> ```bash
> IT_PG_DATABASES=trackai_task20i_reads_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20i_reads_live scripts/it-db.sh npm run verify:task20i-reads-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T20i-01 | Reads on real PostgreSQL seeded through the real v2 ingest and Task20f lease code: 182 rows page over 4 pages (both generations), every filter selects, detail indicators + nearby enforcement, B gets 404 for A's id, coverage honest states, problems/headers/auth, one frozen-details audit row per call | Blocking: Task20i-a merge | 🟡 agent-verified 2026-10-18 · ⬜ founder run |

Task20d, Task20f and Task19c suites are untouched and still pass (`npm test`: 1,223 tests).

## Integration notes
- **Task20i-b** copies `SecurityFindingItem`, `SecurityFindingDetail`, `SecurityCoverageRow` and the page types from `v2-read.ts` into `apps/web/src/lib/api.ts`; problem codes are `SECURITY_READ_INVALID_QUERY` (400), `SECURITY_READ_FORBIDDEN` (403), `SECURITY_READ_NOT_FOUND` (404, also for another tenant's id), `SECURITY_READ_UNAVAILABLE` (503). Every response carries `no-store` and an `X-Request-ID` echo.
- Honest states: missing status/inventory/platform read as the string `unreported`, missing lease as `no_lease`, missing acknowledgement as `not_acknowledged`; `repository_id` is null for machine-wide (`not_enrolled`) rows, filterable via `repository_id=not_enrolled`.
- Seeding gotcha found here: `persistSecurityV2Upload` checks the enrollment against `receivedAt`, so a frozen script timestamp older than the enrollment's `effectiveFrom` rejects enrolled findings — pass a fresh `new Date()` as `receivedAt`.
- Cursor gotcha found here: hashing the resolved default window binds request-time `now` into the cursor and every second page 400s — the cursor binds explicit filters only.

## Effort
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.15× | about 0.15× | ~30 turns | ~2 h |

On plan: the Task20d/Task20f handoffs and the frozen contract README answered the title and audit questions without extra rounds; the two live-verify failures were both seeding/time-boundary issues, not design rework.
