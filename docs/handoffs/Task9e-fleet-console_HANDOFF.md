# Task9e-fleet-console Handoff — Fleet administration workspace

Branch `task/Task9e-fleet-console` (base: `main` past Task9a PR #16). TrackAI-only UI client of the frozen Task9a API; no table, migration, route, or endpoint change.

## At a glance

New `apps/web/src/app/dashboard/fleet-workspace.tsx` plus typed bindings in `apps/web/src/lib/api.ts` and one **Fleet** section in `dashboard/page.tsx` (Task4 **Machines & keys** untouched). Four compact areas: honest-state counts, filterable inventory with detail panel, create/assign with rollback wording, preview-then-apply offboard.

## Implemented interfaces

- Bindings for exactly the five routes: `GET /api/admin/fleet/machines`, `POST /api/admin/fleet/configurations`, `POST /api/admin/fleet/assignments`, `POST /api/admin/fleet/machines/:id/offboard/preview`, `POST .../offboard`; closed unions for the six states, four channels, preview/apply literals; apply sends exactly `{ apply: true, reason }`.
- Journeys: Refresh-backed inventory; create validates version/channel/ring/future-date/reason and retains the returned config for immediate assignment (datalist); assign validates UUID, dedupes, caps 100, labels older-epoch assignment as rollback; offboard requires preview match, non-empty reason, explicit confirmation, then shows revocation vs local vs MDM cleanup separately.
- Honest states: all six render in distinct tones; null observed/queue/delivery fields render `Unavailable`, never `0`; mismatch panel says investigate, not compromise; reconciliation labeled `unavailable` until MDM/Task8.

## Deviations

None from the prompt. Review-driven fixes (fix-first verdict): added a sixth local badge tone so `unreported` and `stale` are visually distinct; Fleet nav and workspace render only for `tenant_admin` (auditors keep existing read-only behavior with an explanatory note); revoked machines are not selectable for assignment and offboard preview is disabled once revoked; client response types now use the frozen closed unions (platform, architecture, service state, report result, assignment source) instead of `string`.

## Known limitations

- No configuration-history list route exists by design; the UI offers IDs visible in inventory plus session-created configs and accepts a validated UUID, labeled honestly.
- Reconciliation stays `unavailable`; MDM evidence is display-only and never authority. Auditors see no Fleet nav or controls (the fleet routes 403 for auditors server-side); revoked machines cannot be assigned or re-offboarded from the UI.

## Test coverage

Full unit suite 162/162 (fleet 10/10 unchanged — no server file touched, so no new API test needed); `typecheck`, `lint`, production `build:web`, `drizzle-kit check`, `git diff --check` all clean. No frontend test dependency added per prompt. Manual browser inspection not performed (no live tenant in sandbox).

## Integration test impact

None added. IT-T9-01 remains the server-contract evidence (non-blocking for this UI session; founder run still pending for Task9a). IT-T9-03/04/06/07 and MDM/native support remain later-session evidence, not UI claims.

## Integration notes

- Reuse: Task4 admin mutation/confirmation patterns, Task5 extracted-workspace pattern, Task9a exact types/states/routes. No SushiCorp component (none exists); nothing copied from public GitAI.
- FOUNDER (non-blocking): after `ready to push`, run the review/push/PR block in the session close-out reply.

## Effort

Estimate about 0.20× T6; actual about 0.15× — frozen API needed no clarification round and baselines passed on first run except the known Supabase-env build prerequisite.
