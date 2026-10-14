# Task16b-audit-contract Handoff — Audit contract (A16.3)
> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task16b-audit-contract` (base: `main` at `4a79c66`). Adds the audit contract (`docs/contracts/audit/`): the v1 event schema, all 57 actions as code (47 emitted, 10 reserved), one validating emitter, and the generated `catalog.md`. Guards now carry their action, so the auditor sweep checks *which* action guards each route. No call site is migrated (that is Task16c), and there is no migration, no route change and no web change.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Schema v1, catalog as code, `recordAuditEvent()`, generated and test-checked `catalog.md` | ✅ |
| Acceptance | Sweep asserts each guard's action (per route, router-level, and the Attesta export guards), replacing the layer counts | ✅ (a swapped action is caught on a throwaway router) |
| Quality | `npm run check`: 949 unit tests, typecheck, lint, drizzle check, web build | ✅ |
| Integration | IT-T16b-01 (3 parts) | 🟡 agent-verified 2026-10-15 · ⬜ founder run |
| Review | Independent subagent: 1 must-fix and 5 should-fix, all addressed (below) · Codex cross-review | ✅ · 🟡 pending |

## Implemented interfaces
```ts
// apps/api/src/core/audit (index.ts)
AUDIT_CATALOG; AUDIT_CATALOG_VERSION = 1; AUDIT_ACTOR_TYPES; AUDIT_SEVERITIES; AuditContractError(code)
buildAuditRow(tenantId, event): AuditRow                                       // pure
recordAuditEvent(executor: { execute(sql) }, tenantId, event): Promise<void>  // runs in the caller's tx
// codes: AUDIT_UNKNOWN_ACTION | _RESERVED_ACTION | _ACTOR_NOT_ALLOWED | _TARGET_INVALID | _DETAILS_INVALID
// core/middleware/admin.ts: adminActionOf(handler); copyAdminAction(from, to) (used by problemizeAuth)
// npm run audit:catalog -w apps/api · npm run verify:task16b-audit-live -w apps/api
```

## Founder-approved decisions (2026-10-15 checkpoint)
1. The severity table was approved as proposed. Emitted actions: **27 high, 12 notice, 8 info**. Reserved actions: 4 high, 5 notice, 1 info.
2. **Audit reads are audited.** `audit.events.read` (info) is reserved here and emitted by Task16c. It records the limit, the returned count and the filter names, never row contents.

## Ported from
None. SushiCorp `identity_audit_events` (`db/models.py:1180` @ `0bd67a5`) has the same free-form shape as TrackAI's table and no typed catalog, so the catalog is new.

## Deviations from spec
- Four frozen v1 key names contain a forbidden word but carry no content: `contentSha256` (a digest), `failureCode`, `code` and `terminal_code` (error codes). The raw-content scan exempts them by name, each with a reason. A new key can never be exempted.
- Extra detail types: `sha256_digest`, `uuid[]` and `string_map`; nested objects are declared shapes. Keys that today's emitters write as `null` are marked required and nullable. A details object over 16 KB is refused (documented in the README).
- UUIDs are accepted in either letter case (review must-fix): the routes accept upper case and store it unchanged. `artifact.signed` keeps the name the prompt reserves (two segments). The types live in `catalog.ts`.

## Task16c migration list
Every site replaces its direct insert with `recordAuditEvent(<same executor or tx>, tenantId, {…})`. Site-specific changes:
1. `features/evidence/service.ts:387` (`evidence.raw.read`): the actor is hardcoded `tenant_user`. Use `req.adminRole`, passed from `evidence.routes.ts:269`. Today's value is **refused** (pinned in `KNOWN_TASK16C`).
2. Sites that hardcode `tenant_admin` behind a guard should take `req.adminRole` instead (the value is the same today): `repository-security-service.ts:115,184,251,314,350,383,429`; `github-app-security-service.ts:114,192,227,263`; `machine-security-service.ts:74,117,158,199`; `retention-policy-service.ts:101`; `evidence-export-service.ts:367,399`; `evidence/service.ts:186,459,497,1159`; `fleet/service.ts:264,316,463`.
3. `evidence-export-service.ts:396-409`: the failure-path audit is wrapped in `.catch(() => undefined)`, so a contract error there would be swallowed. Let it surface or log its code.
4. Raw SQL sites: `attesta/trust-inventory.ts:1063`; `attesta/worker.ts:371`; `attesta/attesta-anchor-resume-cli.ts:279`: keep `target_id` as the batch id and `request_id`, because migration 0021's trigger reads both.
5. Pack and report download audits (`evidence-pack-service.ts:793`, `period-report-service.ts:511`): keep the `ready` check first (digests and counts must be non-null).
6. `admin-security-service.ts:107` (`revokeAdminMembership`) has no caller: wire it or delete it. The rolled-back probe in `task4-wave1-live-verify.ts:217` stays a direct insert. Bound at the route what the emitter would refuse but routes accept today: dates beyond year 9999 (`admin.routes.ts:86`) and branch patterns over 512 characters (`admin.routes.ts:78`).
7. Read API (`admin-resource-service.ts:107` and the new API): add the derived `severity` and `catalog_version`, and change `audit.events.read` to emitted.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | No call site uses the emitter yet; the reserved shapes (lease, policy bundle, artifact, monitor, triage) are proposals | Rows stay unvalidated until Task16c; each owning Task finalizes its shape before its first row (README) |

## Test coverage
`audit-contract.test.ts` (11 tests, no database): one fixture per emitted action, built from its `file:line`; every error code, and reserved actions refused; error messages never carry a details value; the key-name scan, `catalog.md` in sync, parity with the 47 actions in the inventory, and a schema round-trip. `auditor-sweep.test.ts` (6 tests): exact guard actions on all four routers, and `adminActionOf` for all 14 actions, including through `problemizeAuth`. The only mock is a recording executor in one emitter test.

## Integration test impact
> **FOUNDER:** non-blocking for this merge (nothing calls the emitter yet); blocking for the Task16c merge. Needs Docker or a local PostgreSQL 16 with pgvector. Expected: three `ok` lines, then `IT-T16b-01 passed`, in under a minute: `scripts/it-db.sh npm run verify:task16b-audit-live -w apps/api`

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T16b-01 | (a) an event recorded in a transaction is read by Company A, not by B; (b) a contract error rolls back the transaction's other write; (c) the stored row round-trips through event-v1 | Blocking: Task16c | 🟡 agent-verified 2026-10-15 · ⬜ founder run |

## Integration notes
The emitter needs only `execute`, so a Drizzle database or transaction, `WorkerDatabase` and `TrustDb` all work as executors. Renaming an action or a details key breaks things; use `aliases` and bump the catalog version instead.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.06× | about 0.07× | ~70 + one review | ~1.5 h |
