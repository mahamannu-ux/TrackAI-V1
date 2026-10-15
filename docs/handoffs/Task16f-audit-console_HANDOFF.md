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
Start web+API (`npm run dev -w apps/web`, API existing dev command), log in.
1. Auditor: Audit view shows auditor banner, no write control; Search lists events; filter by severity and by action; Load more appends; row opens drawer with plain-words details; Escape closes.
2. Admin: same with admin banner; Administration has no Security audit section; overview has the Audit trail link.
3. Developer (no membership): no Audit nav item.
4. No polling: 60s on any view shows no `/api/admin/audit` or `/api/audit/events` in Network unless Search; each Search adds exactly one `audit.events.read` row (newest on next search).

## Integration notes
Needs seeded audit rows (any admin action, or Task16c's verify). Ported UI-1 rules only (replace, states, plain words, hidden writes); no code.

## Effort
Estimate 0.1× T6, actual about 0.1×. No API question arose; commit-per-chunk ordering kept each commit green.
