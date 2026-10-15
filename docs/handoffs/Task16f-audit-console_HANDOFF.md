# Handoff: Task16f-audit-console (auditor's Audit area)

## At a glance
New top-level **Audit** view (`audit-workspace.tsx`) for active admins/auditors: banner, filters, results table, event drawer. Stopped the dashboard's 15-second poll of audited `GET /api/admin/audit`, so an open dashboard writes no audit row until Search. No API change; `npm run check` green. No deviation from the design; UI-1 "URL is the state" deferred to Task10; export + verify card is Task16f2.

## Console field guide (what each thing means)
Banner: slate note. Auditor: "Read-only auditor access. Each search you run here is itself recorded in the audit trail." Admin: the second sentence only. No write control anywhere in this view.
| Filter | Meaning |
| From / To | Local date-time pickers, sent as UTC (`Z`). Search is refused with an inline message unless To is after From. |
| Severity | All, High, Notice, Info. Badges: High rose, Notice amber, Info slate. |
| Actions | Emitted catalog actions grouped by owning team, at most 20 ("n of 20"). Empty means all actions. |
| Actor | Type select (Any, admin, auditor, signed-in user, operator, machine, service) plus an id text box. |
| Target | Type select (Any plus the catalog's target types) plus an id text box. |
| Search / Reset | Search sends the one audited request (opening the view auto-runs one unfiltered search). Reset clears the form and re-runs the unfiltered search. |
| Table | Time (local; hover shows exact UTC), Severity badge, Action (monospace), Actor and Target (plain label + id truncated to 12, hover shows full). Click a row for the drawer. Load more appends the next page while more rows exist. |
| States | Skeleton while loading; "No audit events match these filters." when empty; the problem's title plus "Reference: \<request_id\>" on error (403 reads "Audit access needs an administrator or auditor membership."; an expired page restarts from the latest with a note). |
| Drawer | Action + severity; "Recorded by \<owner\>"; When (local + UTC); Who (label + full id); What it acted on (type + full id); Details in plain words (lists comma-separated, nested objects indented, null is "none"); collapsed Technical view (raw JSON); Copy event id; footer "Catalog version N". Escape or Close dismisses; focus returns to the row. |

## Implemented
- `lib/api.ts`: `AuditApiError`, `auditFetch`, `AuditEvent/Catalog/Page/Filters`, `getAuditCatalog()`, `listAuditEvents()` (repeated `action`, empty values omitted). Deleted now-unused `getAdminAudit` + `AdminAuditResources`.
- `page.tsx`: `View audit` after administration (active membership only, side-label Trail); filter input and metric row hidden for `audit`; overview metric is now an "Audit trail / Open Audit" link; refresh no longer fetches audit.
- Workspace: filters, table, states and drawer as above; requests only on Search/Load more because every search is itself audited.
- Drawer uses the already-loaded row, so opening an event writes no extra audit row.

## Removed from Administration
`page.tsx:189` `AdminResources.audit`; `:194` AdminSection `audit`; `:205` "Security audit" nav; `:554` "Recent audit events" metric (now the Audit-trail link); `:628` audit section; `:672` `getAdminAudit()` refresh call.

## Test coverage
Web has no unit tests (none added). `npm run lint`, `typecheck`, `check` (web build) green in sandbox. Needs seeded audit rows (any admin action, or Task16c's verify). Ported UI-1 rules only (replace, states, plain words, hidden writes); no code.

## Integration test impact — IT-T16f-01 (founder-live browser, blocking this merge; ✅ passed 2026-10-15)
Setup (all synthetic; Task15k stack). `DB` = `postgresql://postgres@127.0.0.1:55432/trackai`; disposable `KEYS` = `MASTER_ENCRYPTION_KEY_ACTIVE_VERSION=local-v1 MASTER_ENCRYPTION_KEYS_JSON='{"local-v1":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}'` (never outside this DB). DB once: `docker run --name trackai-task5-uat-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=trackai -p 127.0.0.1:55432:5432 -d pgvector/pgvector:pg16` (later `docker start ...`) + `DATABASE_URL=$DB npm run db:migrate -w apps/api`. Seeds: `DATABASE_URL=$DB $KEYS TASK5_EPHEMERAL_DATABASE=1 TASK5_ACCEPTANCE_PERSIST=1 npm run verify:task5-corpus-live -w apps/api` (tenant + admin) and `DATABASE_URL=$DB TASK6_EPHEMERAL_DATABASE=1 npm run seed:task6-acceptance -w apps/api` (auditor). Terminals: fake login `TASK5_EPHEMERAL_DATABASE=1 npm run serve:task5-acceptance-auth -w apps/api` (:54321, what the web Supabase vars point at); API `DATABASE_URL=$DB $KEYS SUPABASE_URL=http://127.0.0.1:54321 FRONTEND_URL='http://localhost:3000,http://127.0.0.1:3000' npm run dev -w apps/api` (:8080); web `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=task5-local-public-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev -w apps/web` → `http://localhost:3000/login`. Logins: admin `admin@task5.acceptance.invalid` / `task5-acceptance-only`; auditor `auditor@task5.acceptance.invalid` / `task6-auditor-only`; developer `developer@task5.acceptance.invalid` / `task5-viewer-only`. Seeds write no audit rows: as admin first register a machine, then search in Audit.
1. Auditor: auditor banner, no write control; Search lists events; severity and action filters narrow; Load more appends; drawer shows plain-words details; Escape closes.
2. Admin: same with admin banner; Administration has no Security audit section; overview has the Audit trail link.
3. Developer (no membership): no Audit nav item; Administration reports no access.
4. No polling: 60s idle shows no `/api/admin/audit` or `/api/audit/events` in Network; each Search adds exactly one `audit.events.read` row (visible from the next search); refresh writes none (all root-caused live in psql).

## Effort
Estimate 0.1× T6, actual about 0.1×. No API question arose; commit-per-chunk ordering kept each commit green.

## Founder walkthrough note (for the Task16 lead)
Founder concern: read-receipt rows flood the trail and the volume overwhelms the view; asks for at least a setting to hide `audit.events.read` for now, and a broader data/volume/UX simplification as a new Task. Recommendation: keep recording every read (dropping them weakens the tamper-evident guarantee an auditor relies on) but default-filter `audit.events.read` in the console behind a visible toggle, no data loss. 8h2 verified live: as auditor, Machines/Repository/History/GitHub sections are empty, Operations is read-only, Findings match admin, no admin write control is reachable (server guards backstop). Placement follow-ups: auditors arguably should not see Administration at all (sidebar already labels it Audit for them); Attestation verify + export are valid auditor capabilities but belong under the Audit nav, not Administration — natural fit for Task16f2's export/verify card work.
