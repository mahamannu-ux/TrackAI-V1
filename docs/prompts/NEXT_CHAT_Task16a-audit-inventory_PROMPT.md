# Handoff prompt: Task16a-audit-inventory (audit event catalog and auditor guard sweep), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task16a-audit-inventory && cd ~/AIProjects/TrackAI-wt/Task16a-audit-inventory && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line.
> 3. When it finishes, paste its review request to the lead Claude chat (or Codex if Claude is busy). Push only after "ready to push".

---

You are **Muse**, building **Task16a-audit-inventory** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product. Task16 (`docs/plan/TASK16.md`) gives audit one home. This session produces the facts the audit contract will be built on and one safety test. **Every decision is made below.** No product behaviour changes, no migrations, no UI.

- **Worktree:** `~/AIProjects/TrackAI-wt/Task16a-audit-inventory`, branch `task/Task16a-audit-inventory`. **Handoff:** `docs/handoffs/Task16a-audit-inventory_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §4, §9, §11, §12.4.
2. `pwd && git branch --show-current`: you must be in the worktree above on `task/Task16a-audit-inventory`; otherwise stop. `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (150 pass expected). Estimate one line against T6; the plan says **about 0.06×**.

## 1. Read
- `apps/api/src/core/db/schema.ts` (`securityAuditEvents`), every non-test file that inserts into it (`grep -rn "securityAuditEvents" apps/api/src --include=*.ts`; about 24 insert sites in services such as `core/security/*-service.ts`, `core/operations/*`, `features/evidence/service.ts`, `features/security-findings/admin-read.ts`), `core/security/admin-authorization.ts` (`ADMIN_ACTIONS`, `adminMembershipAllows`), `core/middleware/admin.ts` (`requireAdminAction`), `features/admin/admin.routes.ts`, `features/evidence/evidence.routes.ts` (admin router).
- SushiCorp (read-only): `git -C ~/dev/sushicorp show 0bd67a5:tests/unit/api/test_api_auditor.py` (the route-table sweep) and catalog AU-1 in `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md`.

## 2. Scope (approved)
### 2.1 Decisions
1. **`docs/plan/AUDIT_EVENT_CATALOG.md`** (new): one table row per distinct `action` written today with columns: action, source Task (Task4 / Task5 / Task6.a), emitting file:line (every call site), actorType values, targetType, `details` keys (names only, never example values), triggered by (route or CLI script), and whether raw content could ever reach `details` (expected "no"; flag any doubt). Live-verify scripts (`*-live-verify.ts`, `task4-*` CLIs) are listed in a separate table "test and operator scripts". Then a third table **planned events** (no code yet), copied from `docs/plan/TASK16.md` A16.11: Attesta key create/rotate/revoke, statement signed, anchor succeeded/failed, verification run, evidence pack exported; D6.1 activation lease issued/refused; Task6.b bundle published/activated/acknowledged; T14.7 artifact signed. End with "Observations": inconsistent names, missing actor or target, events that should exist but do not (for example reads that are not audited), one line each with file:line. Do not fix them.
2. **Auditor guard sweep test** `apps/api/src/core/security/auditor-sweep.test.ts` (new):
   - Build the list of every route on the admin routers in-process by walking the Express router stacks (`router.stack` → `layer.route.path` and `layer.route.methods`) for `adminRouter` (`features/admin/admin.routes.ts`) and the evidence admin router (`features/evidence/evidence.routes.ts`). Importing them must not need a database; if it does, stop and describe the problem instead of mocking the database module.
   - Keep a hand-written table in the test, `ROUTE_ACTIONS: Record<string /* "POST /path" */, AdminAction>`, mapping every route to the action its `requireAdminAction` uses (read it from the route file).
   - Assert: (a) the table and the router stacks contain exactly the same routes (a new route fails the test until it is added); (b) for every non-GET route, `adminMembershipAllows` with a `tenant_auditor` membership returns false for its action; (c) for every GET route the action is one of the auditor's four read actions or is listed in an explicit `ADMIN_ONLY_READS` set in the test, with a one-line reason each.
   - Ported from SushiCorp AU-1 `tests/unit/api/test_api_auditor.py` @ `0bd67a5`; header comment says so.
3. **Register the test:** add ` src/core/security/auditor-sweep.test.ts` after `src/core/security/security.test.ts` in the `test` script of `apps/api/package.json`.

### 2.2 Port from
SushiCorp AU-1 route-table sweep @ `0bd67a5` (catalog AU-1). The catalog document is new.

### 2.3 Pre-approved files
`docs/plan/AUDIT_EVENT_CATALOG.md`, `apps/api/src/core/security/auditor-sweep.test.ts`, `apps/api/package.json` (the one test-script edit), `docs/handoffs/Task16a-audit-inventory_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (your row), `docs/plan/TASK16.md` (A16.1/A16.2 status only).

### 2.4 Never touch
Every product source file (read only), migrations, `docs/contracts/`, `apps/web/`. If the sweep finds a mutating route the auditor can reach, **do not fix it**: make the test fail with a clear message, mark it in the handoff as a security finding for the lead, and stop.

## 3. Working rules
Commits `Task16a-audit-inventory: …`, explicit `git add <path>`. `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean (unless the sweep found a real hole, as above). Re-read your full diff before the handoff.

## 4. Close-out
Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 60 lines, with counts (actions found, call sites, routes swept) and Effort; status board row; `TASK16.md` statuses 🟡; clean tree; do not push; final reply in the AGENTS.md §12.4 shape with the review request in a `text` block.
