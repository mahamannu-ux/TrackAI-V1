# Handoff prompt: Task20d-security-ingest-v2 (store the seven security v2 record kinds), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task20d-security-ingest-v2 && cd ~/AIProjects/TrackAI-wt/Task20d-security-ingest-v2 && npm ci && opencode`. Pick Muse Spark, keep permission prompts on, paste everything below the line. Reply "continue" if it stops.
> 3. Run Muse sessions one at a time: start this one after Task20b's PR merged (order Task20b → Task20d → Task20c).
> 4. At the end it gives you one numbered bash block: unit tests, then `scripts/it-db.sh` runs. Paste back only failures and the summary lines.
> 5. Paste its review request to the **Task20 lead (Claude)**; Codex also reviews the migration as Task6.a's owner. Push only after "ready to push".

---

You are **Muse**, building **Task20d-security-ingest-v2** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task20 replaces Task6.a's three-rule detector with **Numbat**, run unchanged on developer machines. The TrackAI **Endpoint** uploads Numbat's records under the frozen **security v2 contract** (`docs/contracts/security-v2/`, merged in Task20a).

This session builds the server side of `POST /worker/security/v2/records` for all seven kinds, a migration that widens `security_findings` and adds tables for the other kinds, and the real `validateSecurityUploadV2` and `checkDataSettings`. It also adds a small **authority interface** for leases and data settings. That interface fails closed until Task20f supplies its database implementation.

It does **not** build lease, bundle or acknowledgement routes, signing, admin read APIs or UI (Task20f, Task20i), or any Endpoint code.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task20d-security-ingest-v2`, branch `task/Task20d-security-ingest-v2`.
- **Handoff:** `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md`.

## 0. Before anything else
1. **Read `AGENTS.md` in full**, especially:
   - §1 rules 1, 6, 7 and 9;
   - §2 "Names";
   - §6 and §7 (definition of done, migrations, Company A/B);
   - §9 items 3, 4, 5, 22 and 23;
   - §10 (AP-1: RFC 7807, `X-Request-ID`);
   - §12.4 and §8 Effort.
2. **Check location and identity:**
   - Run `pwd && git branch --show-current && git log --oneline -1`.
   - You must be in the worktree above, and the checkout must contain `docs/contracts/security-v2/README.md`; otherwise stop.
   - Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only.
3. **Baseline:** run `npm test` once.
4. **Estimate:** one line against T6. The plan says **about 0.30×**. Shared surfaces it touches: `schema.ts`, one migration, `package.json` scripts.

## 1. Read before writing
- The contract, all of it:
  - `docs/contracts/security-v2/README.md`, `api.md`, `errors.md`;
  - the six `*.schema.json` files;
  - `fixtures/manifest.json`;
  - `apps/api/src/features/security-findings/v2-contract.ts` and its test.
- `docs/plan/TASK20.md` §1, §3 and §5 (your row).
- Task6.a, which you widen and must not break:
  - `apps/api/src/core/db/schema.ts:474-570` (`security_findings`, its checks and unique keys);
  - `features/security-findings/{contract,storage-service,security-findings.routes,admin-read}.ts`;
  - `task6-route-live-verify.ts`.
- Other code that reads `security_findings`:
  - `apps/api/src/features/attesta/builder.ts:409-424` reads `rule_category`, `rule_severity`, `rule_pack_version`, `repository_id` and `session_id`. It is Task15's code; its results must not change for Task6.a rows.
  - The `features/qa/` answerers that read it.
- Patterns to reuse:
  - `apps/api/src/features/attesta/http.ts` (request id, problem body; copy the pattern, do not import Attesta codes);
  - `core/security/managed-machine-auth.ts` (how `req.tenantId`, `req.machineId` and `req.managedMachineCredential` are set);
  - `core/security/envelope-encryption.ts` (`encryptEnvelope`, `decryptEnvelope`), used for previews as `features/evidence/service.ts` uses it;
  - `core/db/tenant.ts` (`withTenant`).

## 2. Scope (approved by the founder)
### 2.1 Decisions (all made)
1. **Route:** add a `v2` router in `features/security-findings/v2.routes.ts` and mount it inside the existing router (`securityFindingsRouter.use('/v2', securityV2Router)` in `security-findings.routes.ts`), so `app.ts` does not change. This session builds only `POST /records`.
   - The route answers exactly as `api.md` "POST" and "Idempotency" say.
   - Every response sends `Cache-Control: no-store` and the `X-Request-ID` echo.
   - Errors use `errors.md`'s problem shape and fixed titles, with no detail.
   - The body limit is 4 MiB; apply it with `express.json({ limit })` on this router only.
2. **Validation:** implement `validateSecurityUploadV2` and `checkDataSettings` in `v2-contract.ts`. Keep the frozen signatures and `[CONTRACT - FROZEN]` types unchanged.
   - Validate with `ajv` against the contract's JSON Schemas, loaded once.
   - Map failures to `SECURITY_V2_INVALID_BODY`, `_UNKNOWN_FIELD` or `_UNSUPPORTED_SCHEMA`.
   - Recompute each `record_id` from the source key **only where the body carries the source key**. Today no kind carries it, so the server cannot recompute it; treat `record_id` as opaque, and say so in the handoff.
   - Replace the stub tests with real ones.
3. **Authority interface, new `features/security-findings/v2-authority.ts`:**
   ```ts
   export interface SecurityLeaseView { leaseId: string; issuedAt: Date; expiresAt: Date; }
   export interface SecurityV2Authority {
     currentLease(tenantId: string, machineId: string, now: Date): Promise<SecurityLeaseView | null>;
     leaseForMachine(tenantId: string, machineId: string, leaseId: string): Promise<SecurityLeaseView | null>;
     currentDataSettings(tenantId: string): Promise<SecurityDataSettingsV1 | null>;
   }
   export const unavailableSecurityV2Authority: SecurityV2Authority; // every method resolves null
   ```
   - Production uses `unavailableSecurityV2Authority` until Task20f replaces it. Every upload is then refused with `SECURITY_V2_LEASE_REQUIRED`, which is fail-closed (AGENTS.md §9 item 9).
   - `null` data settings means the conservative default: all five switches `false`.
   - The router factory takes the authority as a dependency, so tests and the live verify inject a fake.
4. **Admission order, per request:**
   1. managed machine credential present, else 403 `SECURITY_V2_LEASE_REQUIRED`; never 401 with details;
   2. body size and schema;
   3. `currentLease` is non-null, else 403 `SECURITY_V2_LEASE_REQUIRED` for the whole request.

   Then, per record, in request order:
   1. any record carrying `lease_id` (findings) must name a lease from `leaseForMachine`, and its activity time (`detected_at`) must lie in that lease's `[issuedAt, expiresAt)`, else rejected `SECURITY_V2_LEASE_MISMATCH`;
   2. `checkDataSettings` against `currentDataSettings`, else rejected `SECURITY_V2_FIELD_NOT_PERMITTED`. The server refuses; it never strips a field;
   3. `repository: {kind: "enrolled", id}` must be a repository with an active enrollment in this tenant, else rejected `SECURITY_V2_INVALID_BODY`. There is no repository grant check: monitoring is machine-wide (TASK20.md §1 item 5);
   4. write-once or upsert (item 7).

   One transaction per request through `withTenant()`. Results come back in request order.
5. **Migration, one file, generated with `drizzle-kit generate` on a fresh `main`:** the next free number (today `0025`). Hand-edit only to add what Drizzle cannot express. Put a comment block at its top.
   - **Widen `security_findings`:**
     - **Generation column:** add `record_generation text not null default 'task6a'`, with a check that it is `'task6a'` or `'v2'`. Existing rows stay `task6a`.
     - **Task6.a columns become nullable:** `repository_id`, `finding_id`, `delivery_id`, `session_id`, `source_event_id`, `route_id`, `agent_family`, `host_surface`, `host_mode`, `capture_channel`, `operating_system`, `timing`, `native_effect`, `activation`, `effect`, `phase`, `availability`, `completeness`, `result_category`, `client_version`.
       - Rewrite **every** existing Task6.a check as `record_generation <> 'task6a' or (<the old condition, unchanged>)`, so Task6.a rows keep exactly their old guarantees, non-null included.
       - Give it a new name ending `_task6a_check`.
     - **Uniqueness:** replace the unique keys `security_findings_tenant_delivery_key` and `_tenant_finding_key` with partial unique indexes over the same columns, `where record_generation = 'task6a'`.
     - **v2 columns**, all nullable at the column level:
       - `record_id`, `source_agent`, `source_type`, `model`, `model_provider`, `parent_session_id`, `sub_agent_id`, `confidence`, `title`;
       - `tags jsonb`, `found_at_rest boolean`, `detected_at timestamptz`;
       - `numbat_schema_version`, `bundle_digest`, `lease_id`, `repository_kind`.
     - **v2 check:** when `record_generation = 'v2'`, these are non-null:
       - `record_id`, `rule_id`, `rule_version`, `rule_severity`, `title`;
       - `source_agent`, `source_type`, `confidence`, `detected_at`;
       - `numbat_schema_version` (`= '0.5.0'`), `bundle_digest` (64 lowercase hex), `lease_id`, `found_at_rest`;
       - `repository_kind` (`'enrolled'` or `'not_enrolled'`), with `repository_id` non-null exactly when `repository_kind = 'enrolled'`.

       Also, `rule_severity` is one of the five Numbat severities, and the bounded lengths follow the contract's schema.
     - **v2 uniqueness:** a unique index on `(tenant_id, machine_id, record_id) where record_generation = 'v2'`.
     - **v2 rows fill the shared columns:**
       - `occurred_at` = `detected_at`;
       - `rule_category` = the `rule_id` text before its first `.`;
       - `rule_pack_version` = `'bundle:' + bundle_digest.slice(0, 16)`;
       - `rule_severity` = `severity`;
       - `effect` = `'monitor'`.

       The Attesta builder then keeps working unchanged.
   - **New tenant-owned tables:**
     - Each gets:
       - `id uuid` primary key;
       - `tenant_id` through `tenantIdColumn()` and `machine_id`, with a composite `(tenant_id, machine_id)` foreign key to `developer_machines`;
       - `record_id`, unique on `(tenant_id, machine_id, record_id)`;
       - `received_at`;
       - RLS enabled with no browser policies (AGENTS.md §9 item 3);
       - the contract's fields as typed columns, with lengths checked as in the schema.
     - The tables:
       - `security_enforcement_decisions`: decision, mode, `rule_ids text[]`, deny rule id and version, `finding_record_ids text[]`, tool name, tool call id, session, source agent, `occurred_at`;
       - `security_indicators`: type, value, count, first seen, last seen, source agent. Upserts follow item 7;
       - `security_scan_summaries`: status and the five counts;
       - `security_permission_events`: outcome, tool name, tool call id, session, source agent, `occurred_at`, join;
       - `security_status_snapshots`: `observed_at`, Numbat version, `wired_agents text[]`, active bundle digest, lease id, last record time, the four health columns;
       - `security_agent_inventory_snapshots`: `observed_at`, plus `agents jsonb` holding the contract's closed rows as validated;
       - `security_finding_previews`: `finding_id uuid` with a composite foreign key to `(tenant_id, id)` of `security_findings`, `field` (one of `observed_command`, `observed_file_path`, `observed_url`, `endpoint_hostname`, `endpoint_username`), and `value_encrypted jsonb` (an `EncryptedValue` from `encryptEnvelope`, with the context bound to tenant, finding and field). Unique on `(tenant_id, finding_id, field)`.
     - **Previews are stored only encrypted, never in plaintext columns.** They can be present only when the data settings allowed them (item 4).
   - Apply the migration once on a throwaway database through `scripts/it-db.sh`, and run `drizzle-kit check` clean.
6. **`schema.ts`:** edit only the `securityFindings` table (as item 5 describes) and add the seven new tables beside it, with exported row types.
7. **Idempotency, exactly as `api.md`:**
   - **Key:** `(tenant, machine, record_id)` for every kind.
   - **Write-once kinds:** an identical replay is `duplicate`. The same id with different content is rejected with `SECURITY_V2_RECORD_CONFLICT`. Compare a canonical projection of the stored row with the incoming record, as Task6.a's `canonicalFindingMatches` does.
   - **Indicators:**
     - if the submitted `count` is greater than the stored count, or the submitted `last_seen` is later than the stored one, the result is `accepted`, and each value is updated to the greater of the stored and submitted values;
     - if both are equal or lower, the result is `duplicate`;
     - a changed `first_seen`, `type`, `value` or `source_agent` is a conflict.
   - **Previews:** they belong to their finding's insert, in the same transaction.
8. **Results and logging:**
   - **Status codes:** a valid request returns 200 with `trackai.security-upload-result/2`. A whole-request failure returns one problem response. Storage failure returns 500 `SECURITY_V2_INTERNAL`.
   - **Logs:** the request id, record count and per-code counts only. Never a value, a record or an id.
9. **Task6.a stays as it is:** `/worker/security/findings`, `/worker/security/activation`, their contract and their tests behave exactly as before. Every existing Task6.a test, `verify:task6-route-live` and the Attesta builder tests must pass unchanged.

### 2.2 Port from
- None from SushiCorp (no equivalent ingest).
- Reuse TrackAI patterns as written above: Task6.a's storage transaction and canonical comparison, Attesta's request-id and problem helpers (copied pattern), and Task5's envelope encryption.
- No third-party code; the contract's Numbat provenance stays in the contract.

### 2.3 Pre-approved files
- `apps/api/src/core/db/schema.ts` (item 6 only).
- `apps/api/drizzle/<next>_*.sql` and its `meta/` snapshot and journal entries.
- In `apps/api/src/features/security-findings/`:
  - `v2-contract.ts` (implementations only) and `v2-contract.test.ts`;
  - new `v2-authority.ts`, `v2-storage.ts`, `v2.routes.ts`, `v2-ingest.test.ts`, `task20d-ingest-live-verify.ts`;
  - `security-findings.routes.ts` (the one `use('/v2', …)` line).
- `apps/api/package.json`: the test-script entry and `verify:task20d-ingest-live`, in alphabetical position.
- `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md`.
- Your own rows in `docs/plan/TASK20.md` (T20.7a and the Task20d session row) and `docs/plan/STATUS_BOARD.md` (row 9d and the IT-T20d-01 registry row).

### 2.4 Never touch
- `docs/contracts/**` (frozen; if the contract looks wrong, stop and describe it), merged migrations, `features/attesta/**`, `features/qa/**`, `features/fleet/**`, `app.ts`, `core/middleware/**`, `core/security/**` (use only), the web app, GitAI.

## 3. Working rules
- **Commits** `Task20d: …`, at each stage:
  1. `v2-authority.ts` and the router skeleton returning `LEASE_REQUIRED`;
  2. validation;
  3. schema, migration and dry-run;
  4. storage for each kind;
  5. tests;
  6. live verify;
  7. handoff.

  `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (`v2-ingest.test.ts`) drive the real router in-process with a fake authority and an in-memory store. They cover:
  - every `api.md` "Required isolation-negative cases" item that applies to records (1, 2, 7, 8);
  - every valid and invalid contract fixture through the route;
  - `LEASE_REQUIRED` with the unavailable authority;
  - `LEASE_MISMATCH`, both for a foreign lease and for out-of-window activity;
  - `FIELD_NOT_PERMITTED` for each of the five switches, and for indicators while `urls` is off;
  - duplicate, conflict and indicator max-merge;
  - result order;
  - the `no-store` and `X-Request-ID` headers;
  - problem bodies that carry no echoed values.
- **Integration (blocking for this merge): `IT-T20d-01`**, `task20d-ingest-live-verify.ts` on real PostgreSQL through `scripts/it-db.sh`. It covers:
  - every kind stored;
  - replay, conflict and indicator upsert;
  - Company A/B and machine X/Y isolation;
  - previews stored encrypted (no plaintext in any column) and only when allowed;
  - Task6.a rows inserted before the migration still readable through `admin-read.ts`;
  - the Attesta builder's findings query (`builder.ts:409-424`) returning the same groups for Task6.a rows, and including v2 rows of an enrolled repository and session.

  The verify uses an injected fake authority, because no lease table exists yet. Run it once, small, in your sandbox. The founder runs it fully.
- **Review:** one independent review (re-read the full diff as a reviewer) before the handoff, then the cross-agent review.

## 4. Close-out
- **The handoff**, from `docs/templates/HANDOFF_TEMPLATE.md`, **under 90 lines**. It names:
  - the migration and tables;
  - the authority interface Task20f must implement;
  - what Task20i reads;
  - the opaque-`record_id` limitation;
  - Integration test impact;
  - Effort.
- **Status board:** row 9d's actual and the IT-T20d-01 registry row. Leave the Task20 row to the lead.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape. One numbered bash block:
  1. `npm test`;
  2. `scripts/it-db.sh npm run verify:task20d-ingest-live -w apps/api` (expect "IT-T20d-01 passed");
  3. `IT_PG_DATABASES=trackai_task6_security_live IT_PG_EXPORTS=DATABASE_URL=trackai_task6_security_live scripts/it-db.sh npm run verify:task6-route-live -w apps/api` (Task6.a unchanged);
  4. under `# after the cross-agent review`:
     - push, then `gh pr create --base main --head task/Task20d-security-ingest-v2 --title "[Task20d] Security ingest v2" --body-file docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`;
     - `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task20d-security-ingest-v2`;
     - `gh pr merge … --merge` only after the preflight says ok.

  Then the review request in a `text` block.

## Lessons so far
- **Task6.a (Codex):** closed validation and the canonical-match replay worked; keep them.
- **Task20a (Codex):** the server must not trust a client-supplied identity. Tenant and machine come only from the credential, and a foreign resource answers like a missing one.
- **Task15d (Claude):** migrations are dry-run first, applied once through `scripts/it-db.sh`; never edit a merged migration.
