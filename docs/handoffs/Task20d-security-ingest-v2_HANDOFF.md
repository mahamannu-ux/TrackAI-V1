# Task20d-security-ingest-v2 Handoff — Security Ingest v2

> Status: 🟡 agent-verified, waiting on founder runs. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task20d-security-ingest-v2` (base: `main` at `217f5f7`).

Task20d delivers the server ingest side of the frozen security-v2 contract: migration 0025 widening `security_findings` to a two-generation table and creating the seven tenant-owned tables, the machine-authenticated `POST /worker/security/v2/records` endpoint with admission ordering, fail-closed `SecurityV2Authority` interface, Ajv-based closed schema validation, tenant data settings refusal, component-wise monotonic indicator merging, envelope-encrypted finding previews (never plaintext in columns or logs), and full Company A / Company B isolation. It deliberately does not include lease/bundle signing (Task20f) or console read views (Task20i).

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | All seven v2 record kinds validated against frozen schemas | ✅ |
| Acceptance | Migration 0025 widens `security_findings`, adds 7 tables, RLS enabled, applied dry-run | ✅ |
| Acceptance | Task6.a rows readable; Attesta builder query (`builder.ts:409-424`) unchanged | ✅ |
| Acceptance | Write-once replay returns `duplicate`; changed field returns `SECURITY_V2_RECORD_CONFLICT` | ✅ |
| Acceptance | Indicators merge monotonically on `count` and `last_seen`; identity change conflicts | ✅ |
| Acceptance | Finding previews envelope-encrypted (`encryptEnvelope`); plaintext absent from DB/logs | ✅ |
| Quality | 1,117 unit tests pass, type check and lint clean | ✅ |
| Integration | IT-T20d-01 (disposable DB live verify) passes; IT-T6-live and IT-T15h-live pass | 🟡 agent-verified · ⬜ founder run |
| Review | Self-review & review fix rounds complete; ready for Codex migration review and Claude session review | 🟡 |

## Implemented interfaces
```ts
// features/security-findings/v2-authority.ts
export interface SecurityLeaseView { leaseId: string; issuedAt: Date; expiresAt: Date; }
export interface SecurityV2Authority {
  currentLease(tenantId: string, machineId: string, now: Date): Promise<SecurityLeaseView | null>;
  leaseForMachine(tenantId: string, machineId: string, leaseId: string): Promise<SecurityLeaseView | null>;
  currentDataSettings(tenantId: string): Promise<SecurityDataSettingsV1 | null>;
}
export const unavailableSecurityV2Authority: SecurityV2Authority;

// features/security-findings/v2.routes.ts
export function createSecurityV2Router(dependencies?: Partial<SecurityV2RouterDependencies>): Router;
// POST /worker/security/v2/records (managed machine credential, 4 MiB limit, RFC 7807 problems)

// features/security-findings/v2-storage.ts
export async function persistSecurityV2Upload(input: {
  tenantId: string; machineId: string; upload: SecurityUploadV2;
  settings: SecurityDataSettingsV1 | null; authority: SecurityV2Authority; receivedAt: Date;
}): Promise<SecurityV2RecordResult[]>;

// features/security-findings/security-findings.routes.ts
export function createSecurityFindingsRouter(options?: { v2Dependencies?: Parameters<typeof createSecurityV2Router>[0] }): Router;
```

## Ported from
None (custom TrackAI ingest adhering to docs/contracts/security-v2).

## Founder-approved decisions
1. Router mounted at `/worker/security/v2` inside `security-findings.routes.ts` via factory `createSecurityFindingsRouter`, preserving `app.ts` immutability.
2. Ingest defaults to `unavailableSecurityV2Authority` (fail-closed, LEASE_REQUIRED) until Task20f supplies the database lease store.
3. Production currently uses the existing global 5 MiB parser before machine authentication; full-stack credential-before-body and exact 4 MiB enforcement are deferred to Task20f or a later founder-approved `app.ts` session.
4. Schema regexes in table checks are inlined as literals to prevent Drizzle unquoted SQL operator rendering.

## Deviations from spec
1. `apps/api/src/features/security-findings/storage-service.ts`: cast nullable columns in `rowToCanonicalFinding` for widened `security_findings` table.
2. `apps/api/src/features/security-findings/security-findings.test.ts`: updated metadata column count and index assertions to reflect the two-generation table structure.
3. Migration 0025: reordered the `security_findings_tenant_id_id_key` unique constraint before `security_finding_previews` foreign key reference to satisfy PostgreSQL DDL dependency order.

## Review findings addressed
1. **Finding 1 (Body parser & admission boundary):**
   - Production currently uses the existing global 5 MiB parser in `app.ts` before machine authentication.
   - The v2 router independently enforces 4 MiB and credential-before-body only when mounted without that global parser.
   - Full-stack credential-before-body and exact 4 MiB enforcement are deferred to Task20f or a later founder-approved `app.ts` session.
2. **Finding 2 (Authority lookup order):** In `v2.routes.ts`, `currentLease()` evaluates before `currentDataSettings()`. If no active lease exists or the lookup fails, the request immediately terminates with 403 `SECURITY_V2_LEASE_REQUIRED` without reaching settings lookup or database access.
3. **Finding 3 (Check constraint null rejection):** In `schema.ts` and migration `0025`, all remaining Task6a check constraints (`rule_id`, `rule_category`, `rule_severity`, `route_id`, `agent_family`, `host_surface`, `host_mode`, `capture_channel`, `native_effect`, `operating_system`, `timing`, `activation`, `effect`, `phase`, `availability`, `completeness`, `result_category`) and the v2 check on `effect` explicitly enforce `IS NOT NULL`, closing the PostgreSQL 3-valued logic check bypass.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T20d-01 live verification against disposable DB | Blocks Task20d merge |
| 🟡 | Ingest fails closed with `SECURITY_V2_LEASE_REQUIRED` in production | Expected until Task20f implements lease signing and storage |

## Test coverage
- 45 unit tests in `v2-contract.test.ts`: JSON schema validation against Draft-7 contracts, safe RFC 7807 error mappings, data settings checks.
- 12 unit tests in `v2-ingest.test.ts`: HTTP route behavior, admission phase 1 pre-transaction rejections, write-once replay, monotonic indicator merge, preview envelope round-trip.
- Integration test `task20d-ingest-live-verify.ts`: 12 scenarios covering real PostgreSQL, foreign keys, RLS, credential revocation, and Company A/B isolation.

## Integration test impact
> **FOUNDER:** Blocking for Task20d merge. Prerequisites: Docker running for throwaway PostgreSQL. Expected: 12 scenarios pass, ~30 seconds.
> ```bash
> IT_PG_DATABASES=trackai_task20d_ingest_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20d_ingest_live scripts/it-db.sh npm run verify:task20d-ingest-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T20d-01 | Ingest v2 on real PostgreSQL: seven kinds, data settings, monotonic indicators, encrypted previews, Company A/B | Blocking: Task20d merge | 🟡 agent-verified · ⬜ founder run |

## Integration notes
- Task20f will implement `SecurityV2Authority` backed by database queries and wire it to `createSecurityFindingsRouter({ v2Dependencies: { authority } })`.
- Task20i will consume `security_finding_previews`, decrypting envelopes only for auditor/admin roles with audited access.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.30× | about 0.35× | ~25 turns | ~1.5 h |

Actual ran slightly over due to PostgreSQL foreign key ordering in generated DDL and Drizzle check constraint regex formatting.
