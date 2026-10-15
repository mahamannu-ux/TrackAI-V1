# Handoff: Task16f-audit-console (auditor's Audit area)

## At a glance
New top-level **Audit** view (`audit-workspace.tsx`) for active admins/auditors: banner, filters, results table, event drawer. Stopped the dashboard's 15-second poll of audited `GET /api/admin/audit`, so an open dashboard writes no audit row until Search. No API change; `npm run check` green.

## Implemented
- `lib/api.ts`: `AuditApiError`, `auditFetch`, `AuditEvent/Catalog/Page/Filters`, `getAuditCatalog()`, `listAuditEvents()` (repeated `action`, empty values omitted). Deleted now-unused `getAdminAudit` + `AdminAuditResources`.
- `page.tsx`: `View audit` after administration (active membership only, side-label Trail); filter input and metric row hidden for `audit`; overview metric is now an "Audit trail / Open Audit" link; refresh no longer fetches audit.
- Workspace: calm slate banner (role-specific); From/To (To-after-From validated), severity segmented, emitted-actions multi-select grouped by owner (n of 20), actor/target type+id; Search/Reset (Reset re-runs the unfiltered search); skeleton, empty, error (title + Reference; 403 friendly; bad cursor restarts from page one); Load more appends.
- Drawer (uses the loaded row, no extra request): action + severity, owner, When/Who/acted-on, Details list (arrays comma-separated, objects indented, null "none"), collapsed Technical view, Copy event id, "Catalog version N". Escape/close, focus returns to the row.

## Removed from Administration
`page.tsx:189` `AdminResources.audit`; `:194` AdminSection `audit`; `:205` "Security audit" nav; `:554` "Recent audit events" metric (now the Audit-trail link); `:628` audit section; `:672` `getAdminAudit()` refresh call.

## Deviations / limitations
None from the design. UI-1 "URL is the state" deferred to Task10 (no per-view routing in this dashboard). Export + verify card is Task16f2.

## Test coverage
Web has no unit tests (none added). `npm run lint`, `typecheck`, `check` (web build) green in sandbox.

## Integration test impact — IT-T16f-01 (founder-live browser, blocking this merge; ⬜ pending)
Setup (all synthetic; same stack as the Task15k walkthrough). Run from this worktree; `DB` = `postgresql://postgres@127.0.0.1:55432/trackai`; `KEYS` = the disposable pair `MASTER_ENCRYPTION_KEY_ACTIVE_VERSION=local-v1 MASTER_ENCRYPTION_KEYS_JSON='{"local-v1":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}'` (never outside this DB):
- Disposable DB (once): `docker run --name trackai-task5-uat-pg -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=trackai -p 127.0.0.1:55432:5432 -d pgvector/pgvector:pg16` (later: `docker start trackai-task5-uat-pg`); then `DATABASE_URL=$DB npm run db:migrate -w apps/api`.
- Seed tenant + admin membership: `DATABASE_URL=$DB $KEYS TASK5_EPHEMERAL_DATABASE=1 TASK5_ACCEPTANCE_PERSIST=1 npm run verify:task5-corpus-live -w apps/api`.
- Seed auditor membership: `DATABASE_URL=$DB TASK6_EPHEMERAL_DATABASE=1 npm run seed:task6-acceptance -w apps/api`.
- Fake login server: `TASK5_EPHEMERAL_DATABASE=1 npm run serve:task5-acceptance-auth -w apps/api` (port 54321; this is what the web Supabase vars point at — no real Supabase, no `.env.local` needed).
- API: `DATABASE_URL=$DB $KEYS SUPABASE_URL=http://127.0.0.1:54321 FRONTEND_URL='http://localhost:3000,http://127.0.0.1:3000' npm run dev -w apps/api` (port 8080).
- Web: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=task5-local-public-placeholder NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev -w apps/web`; open `http://localhost:3000/login`.
- Logins: admin `admin@task5.acceptance.invalid` / `task5-acceptance-only`; auditor `auditor@task5.acceptance.invalid` / `task6-auditor-only`; developer `developer@task5.acceptance.invalid` / `task5-viewer-only`.
- Seeds write no audit rows, so first as admin register a machine in Administration (an audited action), then search in Audit.
1. Auditor: Audit view shows auditor banner, no write control; Search lists events; filter by severity and by action; Load more appends; row opens drawer with plain-words details; Escape closes.
2. Admin: same with admin banner; Administration has no Security audit section; overview has the Audit trail link.
3. Developer (no membership): no Audit nav item.
4. No polling: 60s on any view shows no `/api/admin/audit` or `/api/audit/events` in Network unless Search; each Search adds exactly one `audit.events.read` row (newest on next search).

## Integration notes
Needs seeded audit rows (any admin action, or Task16c's verify). Ported UI-1 rules only (replace, states, plain words, hidden writes); no code.

## Effort
Estimate 0.1× T6, actual about 0.1×. No API question arose; commit-per-chunk ordering kept each commit green.

## Founder walkthrough note (for the Task16 lead)
8g root-caused live: a page refresh writes no `audit.events.read` row (verified in psql); the row the founder saw came from opening the Audit view afterwards, whose auto-search records itself. Founder concern: read-receipt rows flood the trail and the volume overwhelms the view; asks for at least a setting to hide `audit.events.read` for now, and a broader data/volume/UX simplification as a new Task. Recommendation: keep recording every read (dropping them weakens the tamper-evident guarantee an auditor relies on) but default-filter `audit.events.read` in the console behind a visible toggle, no data loss. Lead decision needed before Task16f2.
