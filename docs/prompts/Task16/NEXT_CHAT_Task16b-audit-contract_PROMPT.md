# Handoff prompt: Task16b-audit-contract (audit event schema v1, catalog as code, one emitter), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Task16a (PR #58) and this prompt's docs PR are merged. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line.
> 3. Checkpoint: after its design note (step 2.2) it sends you a severity table and one question; answer in plain words.
> 4. When it finishes, paste its review request to **Codex** (it changes the admin authorization middleware, so the reviewer must not be Muse alone). Push only after "ready to push".

---

You are **Claude**, building **Task16b-audit-contract** (Task16 A16.3) for **TrackAI**, an AI code provenance product built on a fork of Git AI. Today 47 audit actions are written to one append-only table, `security_audit_events`, from 36 call sites in Task4, Task5, Task6.a, Task9 and Task15. Every site writes free-text `actor_type`, `target_type` and `details` by hand, some through Drizzle and some through raw SQL. Task16a inventoried them in `docs/plan/AUDIT_EVENT_CATALOG.md`.

This session adds the **audit contract**:
- a v1 event schema;
- the catalog of every action **as code**;
- one validating emitter, `recordAuditEvent()`;
- a generated, test-checked catalog document.

It also hardens the auditor sweep so it checks *which* action guards a route, not only that a guard exists.

It does **not** migrate the call sites (that is Task16c, Muse), add a migration, add routes, or touch the web app.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles go in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task16b-audit-contract`.
- **Handoff:** `docs/handoffs/Task16b-audit-contract_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1 rules 1, 6, 9; §4; §5; §7; §9 items 3, 10, 21–23; §10 AP-1; §12.4) and `CLAUDE.md`.
2. Send the founder one request for folder access: `~/AIProjects`, plus `~/dev/agent-kit` read-only. Ask once for delete permission on `~/AIProjects`. Clone `main` from a bundle, run `npm ci` and `npm test` once, and install `postgresql-16-pgvector` for `scripts/it-db.sh`.
3. Estimate in one line against T6. The plan says **about 0.05×**; the sweep hardening (item 7) adds about 0.01×. Above 0.09×, propose moving item 7 to Task16c.

## 1. Read before writing
- **Task16:** `docs/plan/TASK16.md` (§1 decisions D1–D5, A16.3, §5 decisions 3–4) and `docs/plan/AUDIT_EVENT_CATALOG.md`, the whole file: §1 rows are your input, and §4 observations 1–13 are the questions this contract answers.
- **Questions:** `docs/plan/ATTESTA_QUESTIONS.md` "Security and policy questions" (S1–S18, gaps G6–G13): the audit events those answers need (S3, S13–S16) are the reserved entries in item 7.
- **Handoff:** `docs/handoffs/Task16a-audit-inventory_HANDOFF.md` (Known limitations: the sweep pins guard presence, not identity).
- **Code** (paths under `apps/api/src/`):
  - `core/db/schema.ts:572-586`: `securityAuditEvents`, with free-text columns, `details` jsonb, no severity column and no request id.
  - `core/db/tenant.ts:25-52`: `withTenant(...).insert` stamps the tenant id.
  - `core/middleware/admin.ts`: `requireAdminAction` closes over its action.
  - `core/types/express.d.ts:14`: `req.adminRole`.
  - `core/security/admin-authorization.ts`: `ADMIN_ACTIONS`, `adminMembershipAllows`.
  - `features/attesta/http.ts:116`: `problemizeAuth` wraps the guard.
  - `core/security/auditor-sweep.test.ts`.
  - `core/security/admin-resource-service.ts:107`: today's audit list read.
  - Representative emitters, one per style:
    - `core/security/machine-security-service.ts:117` (Drizzle `transaction.insert`);
    - `features/evidence/service.ts:386` (`withTenant` insert);
    - `features/attesta/evidence-pack-service.ts:793` (role from the request);
    - `features/attesta/trust-inventory.ts:1063` and `features/attesta/worker.ts:371` (raw SQL in a Drizzle executor).
- **Database dependency on today's names:** `apps/api/drizzle/0021_attesta_anchor_resumes.sql:108-122`. A deferred trigger refuses a resume unless a row with `action = 'attesta.anchor.resume'` and `details->>'request_id'` exists. Renaming an action or a details key is therefore a breaking change, not a cosmetic one.
- **Catalog:** AU-1 (route-table sweep, already ported in Task16a) and AP-1 (`X-Request-ID`) in `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md`.

## 2. Scope
### 2.1 Lead decisions
1. **Names are frozen.** All 47 actions in the Task16a catalog keep their exact `action` strings and `details` key names in v1, including the mixed casing (catalog observations 9 and 12). Renames are breaking: `0021`'s trigger, the live verifiers and the Attesta console read them.
   - A catalog entry may carry `aliases: string[]` for a future rename; v1 has none.
   - **New actions** follow `<domain>.<object>.<past_verb>` (lower case, dot-separated, snake_case inside a segment, e.g. `fleet.lease.issued`), with snake_case details keys.
2. **Contract files** (new `docs/contracts/audit/`, frozen once merged, additive changes only):
   - `README.md`: the rules in this section in plain words.
   - `event-v1.schema.json`: Draft 7, a closed object describing one row as the read API (Task16c) will return it:
     - `id`, `action`, `actor_type`, `actor_id`, `target_type`, `target_id`, `details`, `occurred_at`;
     - plus the derived `severity` and `catalog_version`, which are **not** stored (item 4).
   - `catalog.md`: **generated** from code by `npm run audit:catalog -w apps/api`. One row per action: action, owning Task, severity, actor types, target type and target-id kind, details keys (required and optional, with type), status (`emitted` or `reserved`). A unit test fails when the file is out of date (the CF-1 "generated and test-checked" pattern).
3. **Actor vocabulary** (`actor_type`, a closed enum in the catalog):
   - `tenant_admin`, `tenant_auditor`: a human acting through an admin guard. The value comes from `req.adminRole`, never hardcoded, whenever a guard ran.
   - `tenant_user`: a signed-in human with no admin guard.
   - `system_operator`: CLIs and operator scripts.
   - `machine`: a developer machine on `/worker/*`; `actor_id` is the machine id.
   - `service`: an automated worker; `actor_id` is the service name.

   The last two exist for B17 (the API must not assume a human session) and for D6.1 leases. Each catalog entry lists the actor types allowed for its action. Catalog observation 1 (`evidence.raw.read` hardcodes `tenant_user` behind an admin guard) becomes a Task16c migration item: list it in the handoff for Task16c, do not fix it here.
4. **Severity** is derived from the catalog, not stored (no migration):
   - `high`: revocation, purge or deletion, raw-content reveal, credential/key/membership change, policy or activation change.
   - `notice`: any other state change.
   - `info`: reads, verifications, exports.
   
   `catalog_version` is an integer in `catalog.ts`. It goes up when an entry is added or an alias recorded, and never for a change that would alter an existing row's meaning (that is forbidden).
5. **Targets.** Every entry declares a `targetIdKind`:
   - `row`: the id of the row acted on;
   - `tenant`: collection or tenant-scope events; `target_id` is the tenant id (codifies observations 2 and 13);
   - `compound`: a documented format, e.g. `attesta.verify` `fromSeq-toSeq` and `attesta.keys.publish` `<tenant>:<version>`; the entry carries the format as a regex.

   The emitter checks `target_id` against the kind (UUID for `row`/`tenant` where the target table has UUID ids; the regex for `compound`). Where today's emitter writes a non-UUID row id (e.g. key ids), the entry says so.
6. **Details and raw content.** Every entry lists its details keys exactly as today's emitters write them, with `file:line` in a code comment. Each key is required or optional, with a type: `string` (max 512), `reason` (operator free text, max 1000), `integer`, `boolean`, `iso_timestamp`, `uuid`, `sha256_hex`, `string[]` (max 200 items), `enum[...]`, or a declared nested shape (`counts`, `changes[]`). Then:
   - The emitter refuses an unknown key, a missing required key, a wrong type or an oversize value.
   - `request_id` is a reserved optional key on every action (AP-1 `X-Request-ID`). Existing actions that already use `requestId` keep it (item 1).
   - A unit test refuses, across the whole catalog, key names that suggest raw content: `prompt`, `response`, `content`, `payload`, `command`, `diff`, `code`, `source`, `secret`, `token`, `password`, `private_key`, `pem`, `plaintext`. Matching is whole-word inside the key, so `credentialFingerprint` passes and `tokenValue` fails.
   - The emitter never logs a details value.
7. **The emitter** (new `core/audit/`):
   - `catalog.ts`: `AUDIT_CATALOG`, `AUDIT_CATALOG_VERSION`, types. All 47 actions with status `emitted`. Reserved (planned) entries for A16.11:
     - `attesta.keys.*` already exist;
     - `attesta.anchor.failed` (anchor success is recorded in Attesta's anchors table, not audited);
     - `fleet.lease.issued`, `fleet.lease.refused` (D6.1);
     - `policy.bundle.published`, `policy.bundle.activated`, `policy.bundle.acknowledged` (Task6.b);
     - `artifact.signed` (T14.7);
     - `security.monitor.changed` (Task6; the monitor setting has no API writer today, gap G8 in `docs/plan/ATTESTA_QUESTIONS.md`);
     - `security.finding.triaged` (Task6, gap G13).

     A signed Attesta statement is **not** an audit event: the ledger already records it, one per commit.
   - `record.ts`:
     - `buildAuditRow(tenantId, event): AuditRow` is pure: it validates and returns the row (including `tenantId`) or throws `AuditContractError` with a code (`AUDIT_UNKNOWN_ACTION`, `AUDIT_RESERVED_ACTION`, `AUDIT_ACTOR_NOT_ALLOWED`, `AUDIT_TARGET_INVALID`, `AUDIT_DETAILS_INVALID`).
     - `recordAuditEvent(executor, tenantId, event): Promise<void>`. `executor` is a Drizzle database or transaction: the same object today's sites call `.insert` / `.execute` on, raw-SQL sites included. It inserts the built row into `securityAuditEvents`, so it always runs inside the caller's transaction. A contract error throws before any write, so the caller's mutation rolls back with it: no audit, no change (fail closed).
     - A reserved action throws until its owning Task flips it to `emitted`.
   - `index.ts` exports only the above. No call site changes in this session.
8. **Guard identity (finishes the Task16a limitation):**
   - `requireAdminAction(action)` attaches its action to the returned middleware as a non-enumerable, read-only property, read through an exported `adminActionOf(handler): AdminAction | undefined`. Behaviour, status codes and messages are unchanged.
   - `problemizeAuth` copies the property onto its wrapper, and changes nothing else.
   - In `auditor-sweep.test.ts`, the per-route and router-level checks assert the guard's **action** equals the table's (`ROUTE_ACTIONS`, `ATTESTA_WRITE_ACTIONS`, the fleet and attesta router-level actions), replacing the layer-count and leading-middleware assertions.
9. **`AUDIT_EVENT_CATALOG.md`:** add one line at the top saying the contract (`docs/contracts/audit/catalog.md`, generated from `core/audit/catalog.ts`) is now the source of truth, and this file is the 2026-10-14 inventory. Change nothing else in it.

### 2.2 Design checkpoint (stop once)
Before writing `catalog.ts`, send the founder:
- **The severity table:** every action with its severity under item 4. Flag any that the rule leaves ambiguous, with your choice.
- **The estimate.**
- **One question, with the recommendation:** should reading the audit trail itself be audited? That covers today's `GET /api/admin/audit` and Task16c's read API (catalog observation 7). Recommendation: yes. Each query writes one `audit.events.read` event, `info` severity, with the filter summary and the returned count, never row contents. This matches the precedent of `security_findings.read` and `attesta.verify`. It is reserved here and emitted by Task16c.

Then build.

### 2.3 Port from
None beyond AU-1, which Task16a already ported. SushiCorp's `identity_audit_events` (`db/models.py:1180` @ `0bd67a5`) is the same free-form shape as TrackAI's table, with no typed catalog to port, so the catalog is new. Say so in the handoff.

### 2.4 Pre-approved files
- `docs/contracts/audit/` (new): `README.md`, `event-v1.schema.json`, `catalog.md` (generated).
- `apps/api/src/core/audit/` (new): `catalog.ts`, `record.ts`, `index.ts`, `generate-catalog.ts`, `audit-contract.test.ts`, `task16b-audit-live-verify.ts`.
- `apps/api/src/core/middleware/admin.ts` (item 8 only); `apps/api/src/features/attesta/http.ts` (`problemizeAuth` copies the property, nothing else); `apps/api/src/core/security/auditor-sweep.test.ts`.
- `apps/api/package.json`: register the new test file in `test`; add `audit:catalog` and `verify:task16b-audit-live` in alphabetical position.
- `docs/plan/AUDIT_EVENT_CATALOG.md` (item 9 line only); `docs/plan/TASK16.md` (A16.3 row and your session row only); `docs/plan/STATUS_BOARD.md` (registry rows and the remaining-plan actual only; the lead updates the Task16 row); the handoff.

### 2.5 Never touch
- Every emitter call site (Task16c).
- `core/db/schema.ts`; any migration (no migration in this session).
- `apps/web/`; other contracts under `docs/contracts/`.
- Any route's behaviour.

If the contract cannot describe an existing emitter's row without changing that emitter, record it as a Task16c migration item in the handoff; do not edit the emitter.

## 3. Working rules
- **Commits** prefixed `Task16b-audit-contract: …`: interfaces (types and stub functions that throw) first, then catalog, emitter, generator, sweep hardening, then the handoff. `npm run lint`, `npm run typecheck`, `npm run check` clean.
- **Unit tests** (no database):
  - every entry validates against a synthetic row shaped like today's emitter, one fixture per action, built from the entry's `file:line`;
  - each `AuditContractError` code is raised;
  - reserved actions refuse;
  - the forbidden-key-name scan;
  - `catalog.md` is in sync;
  - every action in `AUDIT_EVENT_CATALOG.md` §1 is in the catalog (parse the table) and vice versa;
  - `adminActionOf` returns each guard's action, including through `problemizeAuth`;
  - the sweep now fails when a route's guard action is swapped (prove it once with a local throwaway router in the test).
- **Integration, IT-T16b-01** (`scripts/it-db.sh npm run verify:task16b-audit-live -w apps/api`). On a throwaway database:
  - (a) a valid event recorded inside a transaction is readable with `withTenant` for Company A and invisible to Company B;
  - (b) a contract error inside a transaction rolls back the transaction's other write too;
  - (c) an emitted row round-trips through `event-v1.schema.json` with the derived fields.
  
  Run it once in your sandbox.
- **Review:** one independent review subagent before the handoff (AGENTS.md §12.3; give it this prompt, the Task16a catalog and the diff), then Codex's cross-review.

## 4. Close-out
- Handoff under 70 lines. It must name:
  - the exported interface;
  - the severity table's final counts;
  - the founder's answer to the checkpoint question;
  - the **Task16c migration list**: per call site, what must change to go through `recordAuditEvent()` (e.g. `evidence.raw.read` actor from `req.adminRole`), each with `file:line`;
  - Integration test impact;
  - **Effort**.
- `docs/plan/STATUS_BOARD.md`: the IT-T16b-01 registry row and the remaining-plan actual only.
- Clean tree. Do **not** push, open a PR or merge.
- **Final reply** in the AGENTS.md §12.4 shape: the effort line, then one bash block containing, in order:
  - fetch the bundle into a branch, `npm ci`, `npm test`, the IT-T16b-01 command;
  - under `# after the cross-agent review`: the push; `gh pr create --base main --head task/Task16b-audit-contract --title "[Task16b] Audit contract" --body-file docs/handoffs/Task16b-audit-contract_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`; `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && scripts/pr-preflight.sh task/Task16b-audit-contract`; and `gh pr merge task/Task16b-audit-contract --merge --repo mahamannu-ux/TrackAI-V1` only after the preflight says ok.

  Then the review request for Codex in a `text` block.

## Lessons so far
- **Task16a (Muse):** the first catalog missed seven Task15 actions written with raw SQL, because it grepped only the Drizzle symbol. Grep both `securityAuditEvents` and `security_audit_events`. Walking Express router stacks needs no database; the four swept routers build with default dependencies.
- **Task15 sessions (Claude):** facts not taken from the code cost review rounds, so cite `file:line` for every emitter shape you encode. Interfaces first; no network or logging of values inside a transaction.
