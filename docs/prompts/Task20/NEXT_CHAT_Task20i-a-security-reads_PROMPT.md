# Handoff prompt: Task20i-a-security-reads (admin and auditor read API for v2 findings and Endpoint coverage), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR, then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. `make worktree M=Task20i-a-security-reads && cd ~/AIProjects/TrackAI-wt/Task20i-a-security-reads && opencode`. Pick Muse Spark (or DeepSeek), keep permission prompts on, paste everything below the line.
> 3. It can run alongside Task19e (that one is web-only; this one is API-only). Paste its review request to the **Task20 lead (Claude)**; push only after "ready to push".

---

You are **Muse**, building **Task20i-a-security-reads** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

Task20d stores Numbat security records from developer machines (findings, enforcement decisions, indicators, scan summaries, permission events, Endpoint status and agent inventory). Task20f stores the signed rule settings, bundles, per-machine leases and the machines' acknowledgements. Nobody can read any of it yet except through Task6.a's old `/api/admin/security-findings` list. This session builds the **read API** the security console (Task20i-b, next) will call: a findings list and a coverage view. **API only: no web code.**

- **Repository:** TrackAI. **Worktree:** `~/AIProjects/TrackAI-wt/Task20i-a-security-reads`, branch `task/Task20i-a-security-reads`.
- **Handoff:** `docs/handoffs/Task20i-a-security-reads_HANDOFF.md`. **Estimate:** about 0.15× T6.

## 0. Before anything else
1. Read `AGENTS.md` in full (rules 6, 7 and 9; §9 items 3 and 23; §10 "New routes follow API conventions"), `docs/plan/TASK20.md` (T20.7b, T20.11, T20.12 and §3), and the handoffs `docs/handoffs/Task20d-security-ingest-v2_HANDOFF.md` and `docs/handoffs/Task20f-security-settings-signing_HANDOFF.md`.
2. `pwd && git branch --show-current`; identity `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only. `npm ci`, then `npm test` once as the baseline.

## 1. Read before writing
- `apps/api/src/core/db/schema.ts`: `securityFindings` (both generations, `record_generation` `task6a` or `v2`), `securityEnforcementDecisions`, `securityIndicators`, `securityStatusSnapshots`, `securityAgentInventorySnapshots`, `securityActivationLeases`, `securityAcknowledgements`, `securityRuleBundles`, `fleetMachineStates`, `developerMachines`.
- `features/security-findings/admin-read.ts` (Task6.a's read: allowlisted columns, audit in the same transaction) and how `features/admin/admin.routes.ts` mounts it.
- `features/security/admin.routes.ts` (Task20f's admin settings router: authorization, problems, `no-store`, `X-Request-ID`). **Copy its pattern; it is the model for this session.**
- `features/qa/security-read.ts` (Task19c: a metadata-only read of the same tables).
- `core/security/admin-authorization.ts` (`security_findings.read`) and `core/audit/catalog.ts` around `security_findings.read`.

## 2. Scope (decisions made by the Task20 lead)
### 2.1 Decisions
1. **Routes,** in a new router `features/security-findings/v2-read.routes.ts` with its service `v2-read.ts`, mounted with one line in `app.ts` at `/api/admin/security/v2`, **before** the existing `/api/admin/security` mount (add a test that both routers still answer):
   - `GET /findings`: filters `from`, `to` (RFC 3339; default the last 30 days; at most 366 days), `severity`, `category`, `rule_id`, `agent`, `machine_id`, `repository_id` (a UUID, or `not_enrolled` for machine-wide rows), `generation` (`task6a` | `v2`); keyset paging `limit` 1..100 (default 50) and an opaque `cursor` over `(occurred_at desc, id desc)`; returns `{items, next_cursor}`.
   - `GET /findings/{id}`: one finding plus its indicators (domain and kind only, never a URL beyond what the indicator row stores as metadata) and the enforcement decisions with the same `session_id` and machine within ±5 minutes, labelled "nearby", never "caused by".
   - `GET /coverage`: one row per enrolled machine, keyset by machine id: platform (latest `fleet_machine_states`), the latest status snapshot (observed time and its health fields), the latest inventory snapshot (agents seen), the current lease (`mode`, `expires_at`, bundle `epoch`), and the latest acknowledgement (`result`, `refusal_code`, time). Each part that has no row is the literal state `unreported` / `no_lease` / `not_acknowledged`, never `0` and never omitted (AGENTS.md rule 7).
2. **Columns:** an explicit allowlist per route (a unit test pins each). Finding items carry the generation-neutral fields Task19c uses (`agent` = `agent_family` or `source_agent`, `model` only for v2) plus `rule_id`, `rule_version`, `rule_severity`, `rule_category`, `title`, `repository_id`, `repository_kind`, `machine_id`, `session_id`, `occurred_at`, `received_at`, `rule_pack_version`, `bundle_digest`, `lease_id`, `found_at_rest`, `phase`, `result_category`. `title` is Numbat's rule title from the pinned catalogue, not user content; check that in the Task20d handoff and drop it if it is not.
3. **Previews are deferred** (founder rule: keep it simple, phase 2 or when a customer asks). Never select from `security_finding_previews`, not even its `field` column. A source-scan test proves the table is not named (as Task19c did).
4. **Authorization:** the existing admin action `security_findings.read` (tenant administrator and auditor; everyone else 403). Every route is tenant-bound through `withTenant()`; the tenant comes only from the session, never from a parameter.
5. **Audit:** each call records `security_findings.read` in the same transaction as the read, with details `{route, filters: [names of the filters used], returned}` and never filter values. If `core/audit/catalog.ts` needs a new source line for the new call site, add only that line (pre-approved). If the frozen `docs/contracts/audit/` would need a change, **stop and report**.
6. **AP-1 conventions:** RFC 7807 problems, `X-Request-ID` echoed, `Cache-Control: no-store`, bounded pages. Problem codes `SECURITY_READ_INVALID_QUERY` (400), `SECURITY_READ_FORBIDDEN` (403), `SECURITY_READ_NOT_FOUND` (404, also for another tenant's finding id), `SECURITY_READ_UNAVAILABLE` (503); list them in the handoff for Task20i-b.
7. **Typed response shapes** exported from `v2-read.ts` (`SecurityFindingItem`, `SecurityFindingDetail`, `SecurityCoverageRow`, page types), so Task20i-b copies them into `apps/web/src/lib/api.ts`.

### 2.2 Port from
- None beyond this repository: copy the router pattern from `features/security/admin.routes.ts` and the allowlist and audit-in-transaction pattern from `admin-read.ts`. The AP-1 keyset cursor pattern is in `features/audit/http.ts` (Task16c); copy, don't import across Tasks.

### 2.3 Pre-approved files
- new `apps/api/src/features/security-findings/{v2-read.ts,v2-read.routes.ts,v2-read.test.ts,task20i-reads-live-verify.ts}`;
- `apps/api/src/app.ts` (one mount line); `apps/api/package.json` (the test entry and `verify:task20i-reads-live`, in alphabetical position);
- `core/audit/catalog.ts` (only the source line in 2.1 item 5);
- your handoff, your rows in `docs/plan/TASK20.md` (T20.7b) and the integration registry in `docs/plan/STATUS_BOARD.md`.

### 2.4 Never touch
- `docs/contracts/`, merged migrations, `schema.ts` (no new table or index; if a query needs an index, say so in the handoff), `apps/web/`, Task6.a's `admin-read.ts`, Task19's `features/qa/`.

## 3. Tests
- **Unit** (`v2-read.test.ts`, in-memory store like Task20f's): every filter; paging stability with equal timestamps; a bad cursor gives `SECURITY_READ_INVALID_QUERY`; `not_enrolled`; both generations; the coverage states `unreported` / `no_lease` / `not_acknowledged`; allowlists pinned; the preview table never named; administrator and auditor allowed, a member refused; problems, `no-store` and `X-Request-ID` through the real router.
- **IT-T20i-01** (`task20i-reads-live-verify.ts`, through `scripts/it-db.sh`): seed both tenants through the real v2 ingest service and Task20f's lease code, then check Company A sees only its rows, Company B gets 404 for A's finding id, paging over a few hundred rows, an audit row per call. Run it once yourself at small size: `IT_PG_DATABASES=trackai_task20i_reads_live IT_PG_EXPORTS=DATABASE_URL=trackai_task20i_reads_live scripts/it-db.sh npm run verify:task20i-reads-live -w apps/api`. It is blocking for this merge.

## 4. Close-out
- Gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run check`. One independent re-read of the full diff as a reviewer.
- Commits `Task20i-a: …` per stage (service and tests; routes and mount; live verify; handoff).
- Before the review request: `git merge main` and rerun the gates (Lessons below).
- Final reply in the AGENTS.md §12.4 shape, review request addressed to the Task20 lead. Do not push, open a PR or merge.

## Lessons so far
- **Task19c:** the frozen Q&A validator forced `not_enrolled` to bucket as `unknown` there. This API is not under that contract, so `not_enrolled` is its own value here.
- **Task20f / Task15op0:** two PRs that each passed alone broke `main` together. Merge `main` and rerun the gates right before the review request.
