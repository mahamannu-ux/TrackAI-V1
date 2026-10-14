# Handoff prompt: Task16c-audit-emitters-api (every audit write through `recordAuditEvent()`, plus the audit read API), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Task16b (audit contract) and this prompt's docs PR are merged. FOUNDER: run IT-T16b-01 first; it blocks this session's merge: `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/it-db.sh npm run verify:task16b-audit-live -w apps/api` (expect `IT-T16b-01 passed`).
> 2. `cd ~/AIProjects/TrackAI-v1 && make worktree M=Task16c-audit-emitters-api && cd ~/AIProjects/TrackAI-wt/Task16c-audit-emitters-api && npm ci && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 3. When it finishes, paste its review request to the **lead Claude chat** (Task16). Push only after "ready to push".

---

You are **Muse**, building **Task16c-audit-emitters-api** (Task16 A16.5 + A16.6) for **TrackAI**, an AI code provenance product built on a fork of Git AI.

Task16b merged the **audit contract** (`docs/contracts/audit/`). It has three parts:
- a catalog of every audit action as code (`apps/api/src/core/audit/catalog.ts`);
- a validating emitter, `recordAuditEvent()`;
- the v1 event schema.

Today no call site uses the emitter: 37 places still insert into `security_audit_events` by hand. This session does two things:
1. **Migrates every one of those sites** to `recordAuditEvent()`, and adds a test that keeps the emitter the only writer.
2. **Builds the audit read API:** filters, keyset paging, AP-1 problems, `no-store`, reachable by auditors, and every read itself audited.

**Every decision is made below.** No migration, no web change, no new dependency.

- **Worktree:** `~/AIProjects/TrackAI-wt/Task16c-audit-emitters-api`, branch `task/Task16c-audit-emitters-api`. **Handoff:** `docs/handoffs/Task16c-audit-emitters-api_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §6, §9 items 3, 22–23, §10 AP-1, §12.4).
2. Check where you are: `pwd && git branch --show-current`. You must be in the worktree above on `task/Task16c-audit-emitters-api`; otherwise stop. Then set your identity for this worktree only: `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com`.
3. Run `npm test` once (about 949 pass). Estimate in one line against T6. The plan says **about 0.12×**; say so if you see more than 0.16×.

## 1. Read
- `docs/handoffs/Task16b-audit-contract_HANDOFF.md`, especially "Task16c migration list" (items 1–7), which this prompt turns into decisions.
- `docs/contracts/audit/README.md`, `event-v1.schema.json`, `catalog.md`.
- `apps/api/src/core/audit/record.ts` (`recordAuditEvent(executor, tenantId, event)`, `buildAuditRow`, `AuditContractError`), `catalog.ts`, `audit-contract.test.ts` (`FIXTURES`, `KNOWN_TASK16C`).
- `apps/api/src/core/middleware/admin.ts` (`requireAdminAction`, `adminActionOf`, `copyAdminAction`).
- `apps/api/src/features/attesta/http.ts`, `attesta.routes.ts:110-200` and `attesta-api.test.ts`: the AP-1 pattern already used in TrackAI (problem responses, `X-Request-ID`, an in-process router test). Read them; **copy** the pattern, never import from `features/attesta/`.
- `apps/api/src/features/security-findings/admin-read.ts`: read-then-audit in one transaction (`readAndAudit`).
- `apps/api/src/core/security/auditor-sweep.test.ts`; `apps/api/src/app.ts:70-80` (mounts).

## 2. Scope (approved)
### 2.1 Emitter migration (A16.5)
Every site below replaces its direct insert with:

```ts
await recordAuditEvent(<executor>, tenantId, { actorType, actorId, action, targetType, targetId, details })
```

The `action`, `actorType`, `targetType`, `targetId` and `details` values stay **exactly** what the site writes today, unless a numbered rule below changes them.

**Executor rule:**
- Pass the transaction the insert ran in today (`transaction`, `tx`, or the `transaction` behind a `withTenant(transaction as unknown as typeof db, …)`).
- Where the site used `withTenant(db, …)` or `db` with no transaction, pass `db` (`core/db`).
- Never add or remove a transaction: atomicity stays as it is today.

| Owner | File: line(s) |
|---|---|
| Task4 | `core/security/repository-security-service.ts:115, 184, 251, 314, 350, 383, 429` |
| Task4 | `core/security/github-app-security-service.ts:114, 192, 227, 263` |
| Task4 | `core/security/machine-security-service.ts:74, 117, 158, 199` |
| Task4 | `core/security/admin-security-service.ts:73, 107` |
| Task4 | `core/operations/retention-policy-service.ts:101` |
| Task4 | `core/operations/evidence-export-service.ts:367, 399` |
| Task4 | `features/admin/task4-wave4-admin-placeholder-repair.ts:54` |
| Task4 | `features/operations/task4-wave5-pending-reconcile.ts:27` |
| Task5 | `features/evidence/service.ts:186, 387, 459, 497, 1159` |
| Task6.a | `features/security-findings/admin-read.ts:73` |
| Task9 | `features/fleet/service.ts:264, 316, 463` |
| Task15 | `features/attesta/read-service.ts:407` |
| Task15 | `features/attesta/evidence-pack-service.ts:793` |
| Task15 | `features/attesta/period-report-service.ts:511` |
| Task15 | `features/attesta/trust-inventory.ts:1063` (the database `insertAudit`; the in-memory store at :1154 stays) |
| Task15 | `features/attesta/worker.ts:371` |
| Task15 | `features/attesta/attesta-anchor-resume-cli.ts:279` |

Rules:
1. **Raw reveal** (`evidence/service.ts:387`, `evidence.raw.read`): the actor today is hardcoded `tenant_user`, which the catalog refuses. Add a required `actorRole: 'tenant_admin' | 'tenant_auditor'` to `readRawEvidence`'s input and write it as `actorType`. `evidence.routes.ts:275` passes `req.adminRole`; if the role is missing, answer 403 exactly as a refused guard does. Remove the `evidence.raw.read` entry from `KNOWN_TASK16C` in `audit-contract.test.ts`, and change that fixture to `tenant_auditor`.
2. **Every other admin-guarded site keeps `actorType: 'tenant_admin'` as a literal.** These are all mutations whose catalog entry allows only `tenant_admin` (`catalog.ts:142`, `ADMIN`). The auditor sweep proves their guards deny auditors, so `req.adminRole` can only hold `tenant_admin` there. Threading the role through about 25 service signatures would change no row. Record this interpretation in the README (item 5 of §2.3). Sites that already take the role from the request keep doing so (security findings, the Attesta reads, packs and reports).
3. **Export failure path** (`evidence-export-service.ts:396-409`): the `.catch(() => undefined)` stays for database errors. An `AuditContractError` must be rethrown, so a contract bug cannot be swallowed. Prove it with a unit test that forces a contract error on that path.
4. **Raw SQL sites** (`trust-inventory.ts:1063`, `worker.ts:371`, `attesta-anchor-resume-cli.ts:279`): pass the same `db` or `tx` they `execute` on. Actor `system_operator`. For the anchor resume, keep `target_id` = the batch id and `details.request_id` in the **same transaction** as the resume insert: migration 0021's commit trigger reads both.
5. **Pack and report audits** (`evidence-pack-service.ts:793`, `period-report-service.ts:511`): the hooks keep their order. The download routes check `ready` before auditing, so digests and counts are never null.
6. **`revokeAdminMembership`** (`admin-security-service.ts:86-107`) has no caller. Migrate it like the others and do not delete it; Task4 decides. Note it in the handoff.
7. **Bounds at the route** (`features/admin/admin.routes.ts`). These are values the routes accept today but the emitter would refuse, which would turn a bad request into a 500:
   - `dateValue` (`:86`) and so `optionalDateValue` refuse a year outside 1–9999, with `${name} is invalid`;
   - `stringArray` (`:78`) refuses any item longer than 512 characters, with `${name} must be a string array`.
   Both answer 400 through the existing `badRequest`. Add route tests for each.
8. **Stays a direct insert** (and is listed in the only-writer test's allow-list, below):
   - the rolled-back probe in `core/security/task4-wave1-live-verify.ts:217`;
   - the deliberate direct inserts in `features/attesta/t15i3-verify-keys-resume-live-verify.ts:413`, which test the 0021 trigger;
   - test files.
9. **The only-writer test**, new `apps/api/src/core/audit/only-writer.test.ts`, with no database:
   - It walks `apps/api/src/**/*.ts`, skipping `*.test.ts` and `core/audit/`.
   - It fails on `insert(securityAuditEvents)` (any spacing) or `insert into security_audit_events` (any case) outside the allow-list in item 8. Each allow-list entry is a path with a one-line reason.
   - It also fails on an allow-list entry whose file no longer matches.

### 2.2 Audit read API (A16.6)
New feature folder `apps/api/src/features/audit/` (Task16-owned): `http.ts`, `read-service.ts`, `audit.routes.ts`, `audit-api.test.ts`. Mount in `app.ts` as `app.use('/api/audit', auditRouter)`, right after the Attesta mount (`app.ts:74`), so `/api` JWT and tenant middleware run first.

1. **Guard:** the whole router uses `requireAdminAction('audit.read')` (admins and auditors), wrapped by a local `problemizeAuth` copy, so 401/403/503 become problems. The wrapper calls `copyAdminAction`, so the sweep can read the action.
2. **`http.ts`:** a local copy of the AP-1 helpers:
   - `X-Request-ID` (accept `^[A-Za-z0-9._-]{1,64}$` or generate a UUID; echo it on every response);
   - `application/problem+json` bodies `{type: 'https://trackai.dev/problems/<code>', title, status, code, request_id}`;
   - `Cache-Control: no-store` on every response.

   Codes:

   | Code | Status |
   |---|---|
   | `AUDIT_API_UNAUTHENTICATED` | 401 |
   | `AUDIT_API_FORBIDDEN` | 403 |
   | `AUDIT_FILTER_INVALID` | 400 |
   | `AUDIT_CURSOR_INVALID` | 400 |
   | `AUDIT_EVENT_NOT_FOUND` | 404 |
   | `AUDIT_API_UNAVAILABLE` | 503 |

   A 5xx body is generic. Log the code and request id, never details or SQL.
3. **`GET /api/audit/events`**. Query parameters, all optional:

   | Parameter | Meaning and validation |
   |---|---|
   | `action` | Repeatable, at most 20. Each must be an emitted or reserved catalog action, else `AUDIT_FILTER_INVALID` |
   | `severity` | `high` / `notice` / `info`; mapped to the catalog actions with that severity |
   | `actor_type` | One of the six actor types |
   | `actor_id` | 1–256 characters |
   | `target_type` | Matches `^[a-z][a-z0-9_]*$` |
   | `target_id` | 1–256 characters |
   | `from` (inclusive), `to` (exclusive) | RFC 3339 with a zone and a four-digit year; `from` < `to` |
   | `limit` | 1–200, default 50 |
   | `cursor` | An opaque cursor from a previous page |

   Unknown parameters get `AUDIT_FILTER_INVALID`. Response: `{events: AuditEventV1[], next_cursor: string | null, catalog_version: number}`.
4. **Row shape:** exactly `event-v1.schema.json`, in snake_case:
   - `occurred_at` is the **exact** stored value as text: `to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
   - `severity` and `catalog_version` come from the catalog when read;
   - a row whose action is not in the catalog is still returned, never hidden, with `severity: 'high'`. A unit test covers it.
5. **Keyset paging:**
   - Order by `occurred_at desc, id desc`.
   - The cursor is base64url of JSON `{o: <occurred_at text as above>, i: <id>, f: <first 16 hex of sha256 over the canonical filter string>}`.
   - The next page uses `(occurred_at, id) < ($o::timestamptz, $i::uuid)`.
   - **Never round-trip `occurred_at` through a JS `Date`.** It holds microseconds, and a `Date` keeps milliseconds, which would skip or repeat rows.
   - A cursor that does not decode, or whose `f` does not match the request's filters, gets `AUDIT_CURSOR_INVALID`.
   - Fetch `limit + 1` rows to decide whether there is a `next_cursor`.
6. **Tenant isolation:** the first condition of every query is `eq(securityAuditEvents.tenantId, tenantId)` (the tenant from `req.tenantId`). No other source of tenant is accepted.
7. **`GET /api/audit/events/:id`:**
   - The id must be a UUID, else `AUDIT_FILTER_INVALID`.
   - Response: `{event, catalog_version}`.
   - Another tenant's id and an unknown id get the same `AUDIT_EVENT_NOT_FOUND`.
8. **`GET /api/audit/catalog`:** `{catalog_version, actions: [{action, owner, severity, status, actor_types, target_type}]}` from `AUDIT_CATALOG`, for the console's filters (Task16f). It reads no events, so it writes no audit event.
9. **Every read is audited** (founder 2026-10-15). `GET /events` and `GET /events/:id` read and write in **one transaction**, `db.transaction(async tx => …)`:
   - Select first, then `recordAuditEvent(tx, tenantId, …)` with:
     - `action: 'audit.events.read'`;
     - `actorType: req.adminRole`;
     - `actorId: req.user.sub`;
     - `targetType: 'security_audit_events'`;
     - `targetId: tenantId`;
     - `details: {limit, returned, filters}`, where `filters` is the **names** of the filters used, e.g. `['action', 'from']`, or `['id']` for the single read; never their values; plus `request_id`.
   - If the audit write fails, answer `AUDIT_API_UNAVAILABLE` and return no rows (fail closed).
   - The read's own event is never in its own result, because it is selected first.
10. **Catalog flip:** in `catalog.ts`, change `audit.events.read` to `status: 'emitted'`, `owner` stays `Task16c`, and add `sources` pointing at the new route. Regenerate `docs/contracts/audit/catalog.md` with `npm run audit:catalog -w apps/api`. `AUDIT_CATALOG_VERSION` stays 1: no entry is added and no alias is recorded (README, "Severity").
11. **Existing `GET /api/admin/audit`** (`admin.routes.ts:163`, used by `apps/web/src/lib/api.ts:443`): keep its path, its query and its camelCase shape, and add two fields per row, `severity` and `catalogVersion`. It also writes one `audit.events.read` event per call (`filters: ['limit']`), in one transaction with its read (move the query from `admin-resource-service.ts:107` into a transaction, with the same rule as item 9).
12. **Auditor sweep:** add `auditRouter` to `SWEPT` in `auditor-sweep.test.ts`, with its router-level action `audit.read` and its three GET routes, all auditor-readable. The test must pass with the guard identity check.

### 2.3 Port from
SushiCorp catalog **AP-1** (API conventions: problems, keyset paging, `X-Request-ID`), as already translated in `features/attesta/http.ts` and `attesta-api.test.ts`. Port the pattern, not the file. The source for reference is `git -C ~/dev/sushicorp show 0bd67a5:api/problems.py` and `0bd67a5:tests/unit/api/api_harness.py` (read-only). Record `Ported from SushiCorp AP-1 @ 0bd67a5 (catalog AP-1), via features/attesta/http.ts` in the header of `features/audit/http.ts`.

### 2.4 Pre-approved files
- Every file and line in the §2.1 table, and `features/evidence/evidence.routes.ts` (rule 1 only).
- `features/admin/admin.routes.ts` (rule 7, and the `/audit` route of item 11).
- `core/security/admin-resource-service.ts` (item 11).
- The existing unit test files that assert those inserts (`security.test.ts`, `evidence.test.ts`, `fleet.test.ts`, `security-findings.test.ts`, `features/attesta/*.test.ts`): change only assertions about how the audit row is written.
- `features/evidence/task5-opencode-live-verify.ts`: one added assertion, that the auditor's `evidence.raw.read` row has `actor_type = 'tenant_auditor'`.
- New: `features/audit/` (four files), `core/audit/only-writer.test.ts`, `features/audit/task16c-audit-api-live-verify.ts`.
- `core/audit/catalog.ts` (item 10 only) and the regenerated `docs/contracts/audit/catalog.md`; `core/audit/audit-contract.test.ts` (rule 1 only).
- `docs/contracts/audit/README.md`: add **one** sentence under "Actor vocabulary" (additive): "Where an action's guard denies auditors (the auditor sweep proves it) and its catalog entry allows only `tenant_admin`, that is the only value `req.adminRole` can hold, so the service writes it directly."
- `core/security/auditor-sweep.test.ts` (item 12); `app.ts` (the one mount line and its import).
- `apps/api/package.json`: register `src/core/audit/only-writer.test.ts` and `src/features/audit/audit-api.test.ts` in `test`; add the script `verify:task16c-audit-live` in alphabetical position.
- `docs/handoffs/Task16c-audit-emitters-api_HANDOFF.md`; `docs/plan/TASK16.md` (A16.5 and A16.6 rows and your session row only); `docs/plan/STATUS_BOARD.md` (your registry row and the remaining-plan actual only).

### 2.5 Never touch
- Any migration; `core/db/schema.ts`; `apps/web/`.
- `docs/contracts/` except the two audit files above.
- Any action string or details key name (frozen).
- Any route's success behaviour beyond items 7 and 11.

If a site cannot go through the emitter without changing what it writes, **stop and write the question for the lead** (what, options, your recommendation). Do not change the row.

## 3. Working rules
- **Commits** `Task16c-audit-emitters-api: …`, staged with explicit `git add <path>`. Commit in this order:
  1. Task4 sites;
  2. Task5 and Task6 sites;
  3. Task9 and Task15 sites;
  4. the only-writer test;
  5. `http.ts` and the read service;
  6. the routes and sweep;
  7. the live verify;
  8. the handoff.
- `npm test`, `npm run lint`, `npm run typecheck` and `npm run check` must be clean.
- **Unit tests** (`audit-api.test.ts`, no database). Use an in-memory `AuditReadStore` whose rows are built with `buildAuditRow()`, so every test row passed the contract. Cover:
  - every filter, and each invalid filter (400);
  - limit bounds;
  - paging across three pages with rows that share an `occurred_at`, each returned exactly once;
  - a tampered cursor, and a cursor reused with other filters (400);
  - 404 for another tenant's id;
  - an unknown action returned with `high`;
  - a problem body for 401, 403 and 503, each with `X-Request-ID` echoed and `no-store`;
  - one `audit.events.read` per read with filter names only, and a failing audit giving 503 with no rows;
  - auditor allowed and developer refused, through `adminMembershipAllows` as in `attesta-api.test.ts`.
- **Integration, IT-T16c-01** (`scripts/it-db.sh npm run verify:task16c-audit-live -w apps/api`). Follow `features/attesta/t15i-evidence-api-live-verify.ts` for an in-process app with a test identity. On a throwaway database:
  - (a) a migrated mutation (`registerDeveloperMachine`) writes its row through `recordAuditEvent()`, and `GET /api/audit/events?action=machine.registered` returns it, valid against `event-v1.schema.json` (with `ajv`, as Task16b's verify does);
  - (b) 120 events written with `recordAuditEvent()` in one transaction (same `occurred_at`) page out at `limit=50` with each id exactly once;
  - (c) Company B sees none of Company A's rows, by list or by id;
  - (d) each read wrote exactly one `audit.events.read` row, carrying the auditor's role when the auditor reads;
  - (e) a raw reveal by an auditor records `actor_type = 'tenant_auditor'`.

  Run it once in your sandbox.
- **Regression (founder runs):** these verifiers read audit rows and must still pass. List them in the handoff with their commands:
  - `verify:task16b-audit-live`;
  - `verify:task4-machine-lifecycle-live`, `verify:task4-wave4-admin-lifecycle-live`, `verify:task4-wave4-github-live`, `verify:task4-wave5-export-live`;
  - `verify:task5-opencode-live`, `verify:task5-retention-live`;
  - `verify:task9-fleet-live`;
  - `verify:task15h-builder-live` (requeue audit), `verify:task15i-evidence-api-live`, `verify:task15i2-evidence-packs-live`, `verify:task15i3-verify-keys-resume-live` (anchor resume and its 0021 trigger), `verify:task15i4-period-report-live`, `verify:task15l2-trust-live`.
- **Review:** re-read your full diff as a reviewer before the handoff.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, **under 70 lines**. It must have:
  - the migrated-site count, matched against the only-writer test;
  - the read API's routes and codes;
  - the rule-2 interpretation and the `revokeAdminMembership` note;
  - Integration test impact (IT-T16c-01 plus the regression list, each blocking for this merge);
  - Effort.
- Clean tree. Do not push.
- **Final reply** in the AGENTS.md §12.4 shape. The bash block contains, in order:
  - `npm test`, then IT-T16c-01, then the regression commands;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16c-audit-emitters-api --title "[Task16c] Audit emitters and read API" --body-file docs/handoffs/Task16c-audit-emitters-api_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task16c-audit-emitters-api`; and `gh pr merge task/Task16c-audit-emitters-api --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok.

  Then the review request for the lead in a `text` block.

## Lessons so far
- **Task16a (Muse):** grep both `securityAuditEvents` and `security_audit_events`. Raw SQL sites are easy to miss, and the only-writer test now catches them.
- **Task16b (Claude):** names and keys are frozen, because a database trigger (0021) and the live verifiers read them. Upper-case UUIDs are valid input. The emitter needs only `execute`, so any Drizzle database or transaction works.
- Cite `file:line` for every fact in the handoff. Line numbers above are from `main` after Task16b; if a site moved, find it by its action string and say so.
