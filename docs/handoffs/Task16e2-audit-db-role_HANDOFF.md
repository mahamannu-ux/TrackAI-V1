# Task16e2-audit-db-role Handoff — Auditor database role
> Status: ✅ done · 🟡 waiting on founder run · ⬜ not done. **FOUNDER:** marks a founder to-do.
Branch `task/Task16e2-audit-db-role` (base: `main` at `3c49106`). Codex, Task16 A16.10. Request-path audit reads now use a tenant-bound, SELECT-only PostgreSQL role; application tenant predicates remain. Export/sealing and broader Attesta/security-findings reads stay unchanged (B20).

## At a glance
| | Item | Status |
|---|---|---|
| Migration/helper | 0024 role, two exact grants, two SELECT policies; `withAuditReader` always resets | ✅ |
| Read paths | `/api/audit` list/get, legacy admin list, audit verify event/seal reads | ✅ |
| Quality/review | 994 unit tests; lint, typecheck, check, Drizzle check; full-diff review fixed vacuous isolation assertions | ✅ |
| Integration | IT-T16e2-01 plus IT-T16c-01 and IT-T16e-01/02 regressions | 🟡 agent-passed; founder run pending |

## Implemented interfaces
```ts
withAuditReader<T>(tx, tenantId, fn): Promise<T>
```
`select set_config('trackai.tenant_id', tenantId, true)` → `SET LOCAL ROLE trackai_audit_reader` → select callback → `RESET ROLE` in `finally`; the caller then writes its read receipt in the same transaction.

## Ported from
SushiCorp ID2 @ `0bd67a5`, catalog AU-1. Kept NOLOGIN, transaction-local role and database write refusal. Deviations: TrackAI uses RLS keyed by `trackai.tenant_id`; grants only `security_audit_events` and `attesta_audit_seals`; audited writes occur after reset.

## Deviations and limitations
- None from the Task16e2 spec. Shared migration and package script were explicitly pre-approved.
- B20: export/sealing, Attesta ledger/anchor and security-findings reads still use the API role.
- Hosted Supabase: `CREATE ROLE` needs `CREATEROLE`, which hosted `postgres` has; confirm on the hosted project before production. No dashboard step.

## Integration test impact
> **FOUNDER:** blocking Task16e2 merge. Prerequisite: local PostgreSQL 16 + pgvector or Docker. Expected: four PASS lines, about 2 minutes.
> ```bash
> # 1. New role and request-path coverage
> scripts/it-db.sh npm run verify:task16e2-audit-db-role-live -w apps/api
> # 2. Read API regression
> scripts/it-db.sh npm run verify:task16c-audit-live -w apps/api
> # 3. Seal/verify/export regressions
> scripts/it-db.sh npm run verify:task16e-audit-tamper-live -w apps/api
> ```
IT-T16e2-01: eight writes denied with SQLSTATE 42501, other table denied, Company A/B isolated without predicates, empty/unset returns none, role reset and audit write proven. Agent passed 2026-10-15; founder pending.

## Effort
Estimate about 0.05× T6; actual about 0.07×. The mixed audit/Attesta verify snapshot needed a careful role split and one regression fix. A future prompt should call out that joined tables must be separated before `SET ROLE`.
