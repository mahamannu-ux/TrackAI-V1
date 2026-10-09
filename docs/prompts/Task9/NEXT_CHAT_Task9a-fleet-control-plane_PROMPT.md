# Handoff prompt: Task9a-fleet-control-plane (minimal managed-fleet server contract), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. Start a new Codex thread in **Worktree** mode in the TrackAI project (worktree root `~/AIProjects/TrackAI-wt`) and paste everything below the line.
> 3. No Jamf, Intune or rented machine is needed in this session. Do not provide a secret in chat.
> 4. Task9a may run at the same time as Task9b because they use different repositories. Do not start Task9c or Task9e until Task9a's interface is merged.
> 5. When it finishes, paste its review request to TrackAI-Orchestrator, or Muse if the orchestrator is unavailable. Push only after `ready to push`.

---

You are **Codex**, building **Task9a-fleet-control-plane** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Task4 already owns machines, one-time credentials, repository grants, health, rotation and authoritative revocation. This session adds the smallest server-side desired-state and observed-state contract that later GitAI and UI sessions can consume. It does **not** replace the Task4 UI, build a general workflow engine, connect to Jamf/Intune, implement Task15 signing or add frontend code.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task9a-fleet-control-plane`, branch `task/Task9a-fleet-control-plane`.
- **Handoff:** `docs/handoffs/Task9a-fleet-control-plane_HANDOFF.md`.

## 0. Before anything else

1. Read `AGENTS.md` in full, especially §1, §5, §6, §7, §8, §9, §11, §12.3 and §12.4.
2. Verify the exact child worktree: `pwd && git rev-parse --show-toplevel && git branch --show-current && git log --oneline -1`. You must be under `~/AIProjects/TrackAI-wt/Task9a-fleet-control-plane`; if not, stop. If Codex created a detached or `codex/...` branch, run `git switch -c task/Task9a-fleet-control-plane`. Set worktree-local identity: `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. Confirm `docs/plan/TASK9.md` exists and `main` contains the merged Task9 planning PR. Run `npm ci`, then `npm test` once as the baseline.
4. Check `git -C ~/AIProjects/TrackAI-v1 worktree list` for active Task13 branches. Task9a does not need GitAI files, so it may proceed even when Task13 is active.
5. Estimate one line against T6. The planning estimate was a conservative **0.38× ceiling**; this simplified prompt targets **about 0.24×**. Stop and report before widening beyond the files or two-table model below.

## 1. Read before writing code

- `docs/plan/TASK9.md` §§1–8, especially §3, Wave 1, IT-T9-01 and the acceptance invariants; `docs/plan/primers/Task9_PRIMER.md`; `docs/handoffs/Task9-plan_HANDOFF.md`.
- `TASK4.md` machine lifecycle/policy/health sections and `docs/handoffs/TASK4_TO_TASK5.md` Implemented interfaces and security invariants.
- `apps/api/src/app.ts`; `apps/api/src/core/types/express.d.ts`; `apps/api/src/core/middleware/machine-auth.ts`; `apps/api/src/core/middleware/admin.ts`.
- `apps/api/src/core/db/{schema,tenant}.ts`; migration `0013_task6_security_storage.sql` and `apps/api/drizzle/meta/_journal.json` only as read-only examples.
- `apps/api/src/core/security/{admin-authorization,admin-resource-service,machine-security-service,repository-security-service}.ts`.
- `apps/api/src/features/admin/admin.routes.ts`; `apps/api/src/features/security-findings/{activation,security-findings.routes,security-findings.test}.ts`; `apps/api/src/core/app.test.ts`.
- `apps/api/src/features/operations/task4-wave5-client-health-migration-dry-run.ts` and the nearest schema/live verifiers for test shape, not for copy-paste expansion.
- Reuse catalog: `docs/plan/REUSE_MAP.md` and `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md`; expect no endpoint-fleet port.

## 2. Scope approved by the founder

### 2.1 Minimum architecture — do not redesign into a platform

1. Add one isolated feature directory, `apps/api/src/features/fleet/`. Keep the public contract in `contract.ts`, persistence/business behavior in `service.ts`, route adapters in `fleet.routes.ts`, and focused tests in `fleet.test.ts`. Small additional files inside this directory are allowed only when they make review simpler.
2. Add exactly **two tenant-owned tables**:
   - `fleet_configurations`: immutable configuration versions. Required meaning: tenant, opaque ID, monotonically increasing tenant epoch, schema version `1`, generated-at/by, optional validity end, target client version, update channel, optional bounded ring label, and one validated metadata-only JSON snapshot containing current Task4 repository/grant references plus current Task6 `off|monitor` activation. It contains no credential, secret, prompt, code or raw MDM payload.
   - `fleet_machine_states`: one current row per tenant/machine. It holds desired configuration ID; last acknowledged configuration ID/epoch and safe result code; closed posture fields (platform, OS version, architecture, GitAI version, service state, bounded queue counts); optional opaque MDM device/user references; assignment evidence source/time; and last report time. Keep desired and observed values distinct.
3. Do **not** add a rollout-campaign table, job queue, provider abstraction, webhook, directory sync, SCIM logic or arbitrary policy language. Assigning a configuration to explicit machines is the phase-1 rollout record; immutable audit events record who changed it. A later session may layer campaigns on this stable primitive.
4. Use existing `machine.manage` for all admin writes/reads in this session. Do not add an admin action or edit `admin-authorization.ts` unless an existing invariant makes reuse impossible; if so, stop and ask.
5. Every table uses `tenantIdColumn()`, a composite `(tenant_id, id)` key where referenced, composite tenant foreign keys, bounded checks/indexes, RLS enabled with no browser policy, and `withTenant()` for application reads/writes. Company A cannot reference, assign, report or read Company B's rows.

### 2.2 Frozen HTTP behavior

Implement the following under the existing authentication boundaries. Exact TypeScript type names may improve, but route paths and semantics are frozen for Task9c/Task9e.

1. **Machine route:** `GET /worker/fleet/configuration`.
   - Requires `req.managedMachineCredential === true`, `req.tenantId` and `req.machineId`; legacy ingest tokens get `403`.
   - Returns `204` when no desired configuration is assigned.
   - Otherwise returns one configuration envelope with: `schemaVersion`, `configurationId`, `epoch`, `issuedAt`, `validUntil`, `targetClientVersion`, `channel`, `ring`, the closed Task4 repository-policy references, Task6 activation `off|monitor`, and `verification: { required: true, state: 'unavailable' }`.
   - The verification object is the typed Task15 seam. Do not sign, invent a key, or return `verified`. Task9c must fail closed when production verification is required.
   - `Cache-Control: no-store`; no credential or secret ever appears.
2. **Machine route:** `POST /worker/fleet/report`.
   - Same managed-machine requirement; tenant and machine come only from authentication, never the body.
   - Accept one closed, size-bounded schema-v1 report. Allow only the state fields in §2.1. Reject unknown keys, negative/oversized queue counts, timestamps too far in the future, unsupported enum values and any string over its explicit bound.
   - Upsert the current state, update acknowledgement fields, and return `{ ok: true }`. A report is evidence only and cannot grant access or mark a configuration authoritative.
3. **Admin route:** `GET /api/admin/fleet/machines` using `machine.manage`.
   - Return all Task4 machines for the caller's tenant joined to the two fleet tables and existing delivery health. Preserve honest states: `current`, `stale`, `unreported`, `unavailable`, `mismatch`, `revoked`; never turn missing data into zero or healthy.
   - MDM user/device data is evidence only. Until Task8 exposes an authoritative custodian interface, reconciliation is `unavailable`; do not invent or infer identity matching.
4. **Admin route:** `POST /api/admin/fleet/configurations` using `machine.manage`.
   - Input is only `targetClientVersion`, `channel`, optional `ring`, optional `validUntil` and `reason`.
   - The server snapshots current active Task4 repository/grant references and current Task6 `off|monitor` setting; callers cannot submit arbitrary policy JSON, credential IDs as secrets, or Task6.b rules.
   - Create an immutable next epoch and an audit event; respond `201` with metadata, never raw secrets.
5. **Admin route:** `POST /api/admin/fleet/assignments` using `machine.manage`.
   - Input: one `configurationId`, 1–100 explicit `machineIds`, and `reason`. All must belong to the tenant and be active.
   - Set desired configuration atomically for all listed machines and write metadata-only audit. Reassigning a previously issued configuration is the rollback primitive; do not rotate/revoke credentials.
6. **Admin routes:** `POST /api/admin/fleet/machines/:id/offboard/preview` and `POST /api/admin/fleet/machines/:id/offboard`.
   - Preview is read-only and returns the machine, active credential/grant counts, desired configuration, and `localCleanup: 'best_effort_not_requested_by_server'`.
   - Apply requires `{ apply: true, reason }`, repeats the authoritative lookup in the same service boundary, invokes existing Task4 `revokeDeveloperMachine`, clears desired configuration, records a metadata-only audit event, and returns server revocation separately from local/MDM cleanup status. Never claim an offline device was cleaned.

### 2.3 Error and privacy contract

- JSON errors are stable, safe categories with `400` invalid input, `401` missing/invalid authentication from existing middleware, `403` wrong credential class/authorization, `404` tenant-scoped resource absent, and `409` stale epoch/state conflict. Do not expose SQL, stack traces, tenant existence or internal exception text.
- No raw prompt, response, command, file content, code, tool payload, credential/hash, arbitrary MDM payload or client-chosen tenant/machine ID is stored or returned.
- Keep request parsing pure and dependency-injected where practical so route tests use the real Express app without listening on a port.

### 2.4 Port from

None: SushiCorp has no endpoint-fleet component. Reuse TrackAI Task4 machine credentials, repository grants, delivery health, audit, `revokeDeveloperMachine`, `withTenant()` and Task6 activation settings. Record that in the handoff.

### 2.5 Pre-approved files

- `apps/api/src/features/fleet/**`.
- `apps/api/src/core/db/schema.ts` only for the two tables/types above.
- One newly generated `apps/api/drizzle/0014_*` migration, its generated `meta/0014_snapshot.json`, and `meta/_journal.json`. Never edit migrations `0000`–`0013` or their snapshots.
- `apps/api/src/app.ts` only to mount the machine and admin fleet routers under the existing authentication middleware.
- `apps/api/package.json` only to register the fleet test and IT-T9-01 verifier scripts; root `package.json` only if `npm run check` cannot discover the test without one minimal script change.
- `docs/handoffs/Task9a-fleet-control-plane_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` Task9a/IT-T9-01 rows, and Task9 status cells only.
- Existing Task4 security services are read-only except a tiny exported query/helper needed to compose the preview/configuration. Prefer a new fleet-side query over modifying stable Task4 behavior.

### 2.6 Never touch

- `docs/contracts/`, migrations/snapshots `0000`–`0013`, `apps/web/**`, Task5/Task6 route semantics, GitAI, Task15 files, Task13 files, dependencies, auth middleware, or the existing Task4 dashboard UI.
- Do not add Jamf/Intune SDKs or network calls. Do not create a signing implementation, key table, secret store or generic policy engine.
- If the two-table model cannot meet an invariant, stop with the exact conflict and smallest proposed change; do not silently add a third table or generic abstraction.

## 3. Work and evidence

1. TDD in small commits prefixed `Task9a-fleet-control-plane:`: contract/validation tests, schema/migration, service, routes, IT verifier, handoff. Explicitly stage only named paths.
2. Unit/in-process route tests must prove: managed credential required; configuration/no-content behavior; closed report validation; server-derived tenant/machine; configuration snapshot excludes secrets; assignment/rollback primitive; preview versus apply; safe error bodies; stale/unreported/unavailable distinction; Company A/B negatives; auditor/non-admin cannot manage.
3. Add IT-T9-01 as one bounded verifier under `apps/api/src/features/fleet/` and a package script. Through `scripts/it-db.sh`, prove migration/schema/RLS shape, next-epoch uniqueness, tenant-bound foreign keys, configuration fetch/report, cross-tenant rejection, offboard revocation, immutable audit, and no plaintext-like credential columns/values. Use disposable data only.
4. Generate the migration with `npm run db:generate -w apps/api`, inspect it, add only the required RLS statements/checks if the generator cannot, and run it only through the disposable wrapper. Prove apply, rollback and fresh re-apply against disposable databases using the established Task4 migration-verifier pattern; never roll back a shared database. Run `npm exec --workspace=apps/api -- drizzle-kit check`.
5. Gates: focused fleet test first; `npm test`; `npm run typecheck`; `npm run lint`; IT-T9-01 once through `scripts/it-db.sh`; then `npm run check`. If localhost tests hit sandbox `listen EPERM`, classify it as infrastructure and retry only the exact affected command with narrow permission.
6. Re-read the complete diff as an independent reviewer before the handoff. Keep the implementation boring: no new dependency, no framework, no speculative provider abstraction.

## 4. Close-out

- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 90 lines. List the exact route/type/table contract, migration, test counts, IT-T9-01 result, privacy review, Task9c/Task9e integration notes, limitations and Effort.
- Update only Task9a and IT-T9-01 on the status board and record actual effort. Do not mark founder-live or later sessions passed.
- Clean tree; no push, PR or merge. Final reply exactly follows AGENTS.md §12.4, including one founder command block and one review request naming branch and commit.

## Lessons to carry forward

- Task2–Task6: keep numbered waves, one exit gate each, dry-run-first migrations and real Company A/B negatives, but avoid another multi-day mega-session.
- Dry-run API hygiene: test Express in-process; do not open a localhost listener merely to test a route; internal exception details remain server-side.
- Task9 planning: MDM facts and client acknowledgements are evidence, never authority; unavailable infrastructure narrows support claims rather than becoming a pass.
