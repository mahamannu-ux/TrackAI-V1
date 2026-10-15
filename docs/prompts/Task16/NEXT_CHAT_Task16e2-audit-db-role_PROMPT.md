# Handoff prompt: Task16e2-audit-db-role (auditor reads under a read-only, tenant-bound database role), Codex

> **Founder setup (Codex: skip to "You are…"):**
> 1. Task16e (PR #66) and this prompt's docs PR are merged. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Codex:** start a new thread in **Worktree** mode in the TrackAI project and paste everything below the line. It can run alongside Muse's Task16f2: the only shared file is `features/audit/read-service.ts`, and the two touch different functions. The second to merge reruns `scripts/pr-preflight.sh`.
> 3. When it finishes, paste its review request to the **lead Claude chat** (tenant isolation, so security-critical). Push only after "ready to push".

---

You are **Codex**, building **Task16e2-audit-db-role** (Task16 A16.10, SushiCorp AU-1 layer 4) for **TrackAI**.

Auditor reads of the audit trail today run as the API's database role, which bypasses RLS (AGENTS.md §9 item 3). Tenant isolation rests on the application's `tenant_id` predicate alone. This session adds a database backstop: on the auditor read path, the database itself refuses any write and returns only the configured tenant's rows.

The design was settled in the Task16e handoff ("Known limitations", row A16.10) and is final below. **Every decision is made.**

- **Worktree:** your Codex worktree under `~/AIProjects/TrackAI-wt/`, branch `task/Task16e2-audit-db-role`. **Handoff:** `docs/handoffs/Task16e2-audit-db-role_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §7, §9 items 3, 4, 21–23, §12.4).
2. Check where you are: `pwd` must be under `~/AIProjects/TrackAI-wt/`. Run `git switch -c task/Task16e2-audit-db-role` if needed. Set the identity for this worktree only.
3. Run `npm test` once. Estimate in one line against T6. The plan says **about 0.05×**.

## 1. Read
- `docs/handoffs/Task16e-audit-tamper_HANDOFF.md` ("Known limitations", A16.10).
- `apps/api/src/features/audit/read-service.ts` (`pgAuditStore`: list and get, read then audit in one transaction), `verify-service.ts` (the verify report's reads), `core/security/admin-resource-service.ts` (the legacy `listSecurityAuditEvents`).
- `apps/api/drizzle/0023_*.sql` (the latest migration; `attesta_audit_seals`) and `0003_lean_prima.sql:103-118`.
- SushiCorp AU-1 layer 4 (read-only): `git -C ~/dev/sushicorp show 0bd67a5:db/session.py` and `0bd67a5:db/migrations/versions/0006_identity.py`.

## 2. Scope (approved)
1. **Migration `0024`** (verify the number):
   - Create the role with `CREATE ROLE trackai_audit_reader NOLOGIN`, guarded with `IF NOT EXISTS` through a `DO` block.
   - `GRANT SELECT ON security_audit_events, attesta_audit_seals TO trackai_audit_reader` (nothing else).
   - `GRANT trackai_audit_reader TO CURRENT_USER`, so the API role can `SET ROLE` to it.
   - Policies `FOR SELECT TO trackai_audit_reader USING (tenant_id = NULLIF(current_setting('trackai.tenant_id', true), '')::uuid)` on both tables. A pooled connection reads an empty string, not null; `NULLIF` makes that match nothing.
   - Generated with `drizzle-kit` (or a custom SQL migration, as 0021–0023 are), dry-run first (§9 item 4). Never edit a merged migration.
2. **Helper** `withAuditReader(tx, tenantId, fn)` in a new `apps/api/src/core/db/audit-reader.ts`. Inside the caller's transaction it runs:
   1. `select set_config('trackai.tenant_id', $1, true)`;
   2. `set local role trackai_audit_reader`;
   3. `await fn(tx)`;
   4. `reset role`, also in `finally`.

   It is used **only for selects**; the audit write that follows (`audit.events.read`, `audit.trail.verified`) runs after `reset role`, in the same transaction.
3. **Use it on the request-path reads:**
   - `pgAuditStore.listAndAudit`, `getAndAudit`;
   - `listSecurityAuditEvents`;
   - the verify report's reads of `security_audit_events` and `attesta_audit_seals`.

   Keep the application `tenant_id` predicates: the role is a second layer, not a replacement. The verify report's Attesta ledger reads (`attesta_records` and anchors), the export job and the sealing pass stay as they are; add one `docs/plan/BUG_BACKLOG.md` row for extending the role to those, and to the Attesta and security-findings reads.
4. **Hosted Supabase:** `CREATE ROLE` needs `CREATEROLE`, which hosted `postgres` has. State in the handoff: "confirm on the hosted project before production". No dashboard step.

## 3. Pre-approved files
- The new migration and its `meta/` snapshot.
- `core/db/audit-reader.ts` (new) and `core/db/audit-reader.test.ts` (new, unit: the statement order, and `reset role` on error, against a recording executor).
- `features/audit/read-service.ts` (`pgAuditStore` only), `features/audit/verify-service.ts` (reads only), `core/security/admin-resource-service.ts` (`listSecurityAuditEvents` only).
- New `features/audit/task16e2-audit-db-role-live-verify.ts`.
- `apps/api/package.json`: test registration and `verify:task16e2-audit-db-role-live`, in alphabetical position.
- `docs/plan/BUG_BACKLOG.md` (one row); `docs/plan/TASK16.md` (the A16.10 row and your session row only); `docs/plan/STATUS_BOARD.md` (your registry row and the remaining-plan actual only); the handoff.

Never touch: merged migrations, `docs/contracts/`, the web app, and any route's response.

## 4. Tests
**IT-T16e2-01** (`scripts/it-db.sh npm run verify:task16e2-audit-db-role-live -w apps/api`), on a throwaway database:
- (a) Under `trackai_audit_reader` with the setting at tenant A:
  - `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on both tables fail with a permission error;
  - a select on another table fails;
  - a select with **no** `tenant_id` predicate returns only A's rows.
- (b) With the setting empty or unset, the select returns no rows.
- (c) After `withAuditReader` returns, the same transaction writes the audit row, and the role is reset (`select current_user` is the API role).
- (d) IT-T16c-01 and IT-T16e-01/02 still pass. Name their commands as regressions.

Run once in your sandbox. `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` and `drizzle-kit check` must be clean. Do one independent review (`/review` or a fresh thread) before the handoff.

## 5. Close-out
- Handoff under 40 lines, with the IT block, the Supabase note and Effort.
- Do not push.
- **Final reply** in the AGENTS.md §12.4 shape. The bash block contains, in order:
  - tests, IT-T16e2-01 and the regressions;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16e2-audit-db-role --title "[Task16e2] Auditor read-only database role" --body-file docs/handoffs/Task16e2-audit-db-role_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; the preflight; and the merge only after the preflight says ok.

  Then the review request for the lead in a `text` block.

## Lessons so far
- **Task16e (Claude):** the design here was checked against pooled connections, where an unset setting reads as an empty string. Keep `NULLIF`.
- **Reviews:** the lead returns only must-fix items.
