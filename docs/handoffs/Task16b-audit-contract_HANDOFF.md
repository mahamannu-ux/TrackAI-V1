# Task16b-audit-contract Handoff — Audit contract (A16.3)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task16b-audit-contract` (base: `main` at `4a79c66`). Adds the audit contract: the v1 event schema, all 57 actions as code (47 emitted, 10 reserved), one validating emitter, and the generated `catalog.md`. Guards now carry their action, so the auditor sweep checks *which* action guards each route. It does not migrate any call site (Task16c), and adds no migration, route or web change.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Schema v1, catalog as code, `recordAuditEvent()`, generated + test-checked `catalog.md` (`docs/contracts/audit/`) | ✅ |
| Acceptance | Sweep asserts guard identity (per route and router-level), replacing the layer counts | ✅ swap proven on a throwaway router |
| Quality | `npm run check` (949/949 unit tests, typecheck, lint, drizzle check, web build) | ✅ |
| Integration | IT-T16b-01 (3 parts) | 🟡 agent-verified 2026-10-15 · ⬜ founder run |
| Review | Independent review subagent; Codex cross-review | 🟡 see Deviations for fixes · cross-review pending |

## Implemented interfaces
```ts
// apps/api/src/core/audit (index.ts)
AUDIT_CATALOG: readonly AuditCatalogEntry[]; AUDIT_CATALOG_VERSION = 1; AUDIT_ACTOR_TYPES; AUDIT_SEVERITIES
buildAuditRow(tenantId, event: AuditEvent): AuditRow            // pure; throws AuditContractError(code)
recordAuditEvent(executor: { execute(sql) }, tenantId, event): Promise<void>   // inside the caller's tx
AuditContractError.code: AUDIT_UNKNOWN_ACTION | AUDIT_RESERVED_ACTION | AUDIT_ACTOR_NOT_ALLOWED | AUDIT_TARGET_INVALID | AUDIT_DETAILS_INVALID
// apps/api/src/core/middleware/admin.ts
adminActionOf(handler): AdminAction | undefined; markAdminAction(handler, action)  // problemizeAuth copies it
// npm run audit:catalog -w apps/api   ·   npm run verify:task16b-audit-live -w apps/api
```

## Founder-approved decisions
1. 2026-10-15 checkpoint: severity table as proposed. Emitted actions: **27 high, 12 notice, 8 info**. Reserved: 4 high, 5 notice, 1 info.
2. 2026-10-15: **audit reads are audited.** `audit.events.read` (info) is reserved here and emitted by Task16c. It records the limit, the returned count and the filter names, never row contents.

## Ported from
None. SushiCorp `identity_audit_events` (`db/models.py:1180` @ `0bd67a5`) has TrackAI's free-form shape and no typed catalog, so the catalog is new. AU-1 was already ported in Task16a.

## Deviations from spec
- Four frozen v1 keys contain a forbidden word but are not content: `contentSha256` (a digest), `failureCode`, `code` and `terminal_code` (error codes). The scan exempts them by name, with a reason each. A new key can never be exempted.
- Extra detail types beyond the list: `sha256_digest` (`sha256:<hex>`, Attesta digests and keyids), `uuid[]`, `string_map` (GitHub `permissions`). Nested objects are declared shapes.
- Nullable keys: today's emitters write `null`, never omit (e.g. `effectiveUntil`, `reason` on enrolment), so entries mark them required + nullable.
- `artifact.signed` keeps the name the prompt reserves (two segments). T14.7 may rename it while it is still reserved.
- Types live in `catalog.ts`; no extra file. `markAdminAction` is exported so `problemizeAuth` can copy the action.

## Task16c migration list
Every site: replace the direct insert with `recordAuditEvent(<same executor or tx>, tenantId, {…same values})`. Contract-specific changes:
1. `features/evidence/service.ts:387` `evidence.raw.read`: actor is hardcoded `tenant_user` behind the `evidence.raw.read` guard. Pass `req.adminRole` from `evidence.routes.ts:269`. **Refused today** (`AUDIT_ACTOR_NOT_ALLOWED`; pinned in `KNOWN_TASK16C`).
2. Hardcoded `tenant_admin` behind a guard: take `req.adminRole` instead (same value today; README rule). Sites: `repository-security-service.ts:115,184,251,314,350,383,429`; `github-app-security-service.ts:114,192,227,263`; `machine-security-service.ts:74,117,158,199`; `retention-policy-service.ts:101`; `evidence-export-service.ts:367,399`; `evidence/service.ts:186,459,497,1159`; `fleet/service.ts:264,316,463`.
3. Raw SQL: `attesta/trust-inventory.ts:1063` (`insertAudit`), `attesta/worker.ts:371`, and `attesta/attesta-anchor-resume-cli.ts:279`. For the anchor resume, keep `target_id` = batch id and `request_id`: migration 0021's trigger reads both.
4. `attesta/evidence-pack-service.ts:793`, `period-report-service.ts:511`: keep the `ready` check before the download audit (`pack_digest`/`counts` and both report digests are required non-null).
5. `core/security/admin-security-service.ts:107` `revokeAdminMembership` has no caller (inventory observation 4): wire it or delete it.
6. Unchanged: `core/security/task4-wave1-live-verify.ts:217` probe row (action `created`, actor `verification`, rolled back) tests the table guard and stays a direct insert.
7. The read API (`admin-resource-service.ts:107` and Task16c's API) adds the derived `severity` and `catalog_version` (event-v1), and flips `audit.events.read` to emitted.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | No call site uses the emitter yet | Task16c migrates them; until then rows are unvalidated |
| 🟡 | Reserved shapes are proposals (lease, policy bundle, artifact, monitor, triage) | The owning Task finalizes the shape before its first row (README) |

## Test coverage
`audit-contract.test.ts` (11 tests), no database:
- one fixture per emitted action, built from its `file:line`;
- every error code, reserved actions refused, and no details value in any error message;
- the raw-content key-name scan, `catalog.md` in sync, parity with the inventory §1 table (47), and a schema round-trip.

`auditor-sweep.test.ts` (6 tests): guard identity on all four routers, a swap caught on a throwaway router (per route and through `problemizeAuth`), and `adminActionOf` for all 14 actions. Nothing mocked except a recording executor in one emitter test.

## Integration test impact
> **FOUNDER:** non-blocking for this merge (no caller yet); blocking for the Task16c merge. Prerequisites: Docker or local PostgreSQL 16 with pgvector. Expected: 3 ok lines plus "IT-T16b-01 passed", under a minute.
> ```bash
> scripts/it-db.sh npm run verify:task16b-audit-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T16b-01 | (a) recorded in a tx, A reads it, B cannot; (b) a contract error rolls back the tx's other write; (c) the row round-trips through event-v1 | Blocking: Task16c | 🟡 agent-verified 2026-10-15 · ⬜ founder run |

## Integration notes
- The emitter needs only `execute`, so a Drizzle db, a transaction and the narrow `WorkerDatabase`/`TrustDb` executors all work.
- Renaming an action or a details key is a breaking change (0021 trigger, verifiers, console). Use `aliases` and bump `AUDIT_CATALOG_VERSION`.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock |
|---|---|---|---|
| about 0.06× | about 0.07× | ~60 turns + one review | ~1.5 h |
