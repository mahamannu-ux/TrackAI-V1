# Handoff prompt: Task9e-fleet-console (inventory, rollout, offboard and mismatch UI), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the TrackAI PR that adds this prompt. Task9a is already merged in TrackAI PR #16. Task9e may overlap Task9c because they use different repositories, but do not start another Muse session while Task9b still needs Muse attention.
> 2. Update the TrackAI read-only checkout, then create the worktree: `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task9e-fleet-console`.
> 3. Start Muse in `~/AIProjects/TrackAI-wt/Task9e-fleet-console`, branch `task/Task9e-fleet-console`. No Mac/Windows rental, Jamf, Intune, Docker or secret is needed for this UI session.
> 4. Keep this implementation small: one fleet workspace component, typed API bindings and minimal dashboard integration. Do not redesign the administration console or add a component framework.
> 5. Muse prepares commits and the review request but does not push, open a PR or merge. TrackAI-Orchestrator/Codex reviews first; founder pushes only after `ready to push`.

---

You are **Muse**, building **Task9e-fleet-console** in TrackAI. Task9a has already frozen and merged the tenant-bound fleet API. Add the smallest useful administrator workspace for fleet inventory, safe health, configuration creation/assignment, rollback selection, offboard preview/apply and honest reconciliation states. This is a web client of the existing API: it adds no database table, migration, server route, MDM connector or endpoint behavior.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`). **Worktree:** `~/AIProjects/TrackAI-wt/Task9e-fleet-console`, branch `task/Task9e-fleet-console`.
- **Frozen base:** TrackAI PR #16 merge `21ad4e88494fd5784cc56aaa7dc2267ace33735f` or a later descendant.
- **Handoff:** `docs/handoffs/Task9e-fleet-console_HANDOFF.md`, under 90 lines.

## 0. Before anything else

1. Read TrackAI `AGENTS.md` in full, then verify `pwd`, Git root, branch, HEAD and clean state. Set worktree-local identity to `mahamannu-ux <mahamannu@gmail.com>`.
2. Read `docs/plan/TASK9.md` T9.5–T9.7/T9.9, `docs/plan/primers/Task9_PRIMER.md`, and `docs/handoffs/Task9a-fleet-control-plane_HANDOFF.md`.
3. Read the exact contracts in `apps/api/src/features/fleet/{contract.ts,fleet.routes.ts,service.ts,fleet.test.ts}`. Code wins over prose. Do not change the route shapes or reinterpret unavailable values.
4. Read the existing administration flow in `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/lib/api.ts`, and `apps/web/src/app/dashboard/evidence-workspace.tsx`. Preserve Task4 machine/key controls and Task5 workspace behavior.
5. Baseline once with `npm run test:fleet -w apps/api`, `npm run typecheck` and `npm run build:web`. If dependencies are already present, do not run `npm ci` again.
6. Estimate one line against T6. Target **about 0.20×**, ceiling **0.25×**. If the frozen API cannot support a requested journey, document the exact gap instead of adding a route.

## 1. Exact API contract

Add typed client bindings for only these existing routes:

```text
GET  /api/admin/fleet/machines
POST /api/admin/fleet/configurations
POST /api/admin/fleet/assignments
POST /api/admin/fleet/machines/:id/offboard/preview
POST /api/admin/fleet/machines/:id/offboard
```

1. All routes remain behind the existing `machine.manage` administrator boundary. Browser state and disabled buttons never substitute for server authorization.
2. Inventory states are exactly `current`, `stale`, `unreported`, `unavailable`, `mismatch`, `revoked`. Keep them visually and textually distinct. Never turn `null` into zero, healthy or current.
3. Render only safe metadata already returned by Task9a: machine/display identifiers, desired configuration, acknowledgement/result, platform/OS/architecture/client version, service state, bounded queue counts, assignment evidence, reconciliation and Task4 delivery health. No raw prompts, responses, commands, repository content, credentials or secret material.
4. Configuration creation accepts only `targetClientVersion`, one frozen channel, optional ring, optional future `validUntil`, and a required reason. Explain that the server snapshots current grants and Task6 monitor state at creation.
5. Assignment accepts one configuration UUID, 1–100 unique active machine IDs and a reason. Reassigning an older immutable configuration is rollback; do not invent a separate rollback route.
6. The API has no fleet-configuration-history list route. The UI may offer configuration IDs visible in current machine desired state plus a configuration just created in this browser session, and may accept a validated UUID for an older retained configuration. Label this limitation honestly; do not imply a complete rollout history and do not add a server route.
7. Offboarding is always preview first. Show machine identity, active credential/grant counts, desired configuration and `localCleanup`. Apply only after a non-empty reason and an explicit confirmation; send exactly `{ apply: true, reason }`.
8. After apply, show server revocation, local cleanup and MDM cleanup as three separate results. `best_effort_not_requested_by_server` and `not_requested` are not success. Refresh inventory after successful mutations.
9. Reconciliation remains `unavailable` until the later MDM/Task8 integration. Do not infer assignment from names, email, browser identity or MDM-looking strings.

## 2. Product shape

1. Create `apps/web/src/app/dashboard/fleet-workspace.tsx` as a focused client component. Keep data loading, selection and mutation state inside it unless a tiny shared type/helper clearly belongs in `api.ts`.
2. Add one **Fleet** administration section in `dashboard/page.tsx`; do not replace Task4's **Machines & keys** section. Task4 manages identity and credentials; Task9 adds fleet desired/observed state and orchestration.
3. The workspace has four compact areas, not a new navigation system:
   - summary counts by honest state;
   - filterable machine inventory and a selected-machine detail panel;
   - create/assign configuration controls, including explicit rollback wording;
   - offboard preview and confirmed apply.
4. Use the existing visual vocabulary (`Badge`, cards, tables, error/loading states) or small local equivalents. No chart library, design-system dependency, polling framework, bulk campaign builder or general form framework.
5. Default to a manual Refresh button. Do not add background polling in this session.
6. Preserve responsive behavior and keyboard-readable labels. Mutations expose pending, success and safe error states; double submission is disabled.

## 3. Port from and reuse

No SushiCorp/catalog component matches this fleet console. Reuse TrackAI's existing administration patterns:

- Task4 administrator authorization, mutation/error handling and destructive-action confirmations in `dashboard/page.tsx`;
- Task5's extracted workspace pattern for keeping the dashboard integration small;
- Task9a's exact fleet types, states and routes.

Record this internal reuse in the handoff. Do not copy code from public GitAI; Task9e is TrackAI-only.

## 4. Pre-approved files

- new `apps/web/src/app/dashboard/fleet-workspace.tsx`;
- bounded additions to `apps/web/src/lib/api.ts` for exact fleet types and five API calls;
- minimal `apps/web/src/app/dashboard/page.tsx` integration;
- focused source/contract assertions in `apps/api/src/features/fleet/fleet.test.ts` only if needed to pin the UI route/state boundary;
- `docs/handoffs/Task9e-fleet-console_HANDOFF.md` and Task9e's own row in `docs/plan/STATUS_BOARD.md`.

Do not add a frontend test dependency solely for this session. Typecheck, the production web build, existing fleet route tests and narrow source assertions are sufficient for this bounded UI.

## 5. Never touch

- `apps/api/src/features/fleet/{contract.ts,fleet.routes.ts,service.ts}` or any server behavior;
- database schema, migrations, frozen contracts, authentication/authorization, Task4 revocation primitives or audit semantics;
- GitAI, Task9c/Task9d endpoint code, MDM/Jamf/Intune APIs, package/install/update behavior or native platform claims;
- Task4 machine credential display/issuance behavior, Task5 raw reveal, lifecycle metric semantics or Task6 monitor-only language;
- no global dashboard redesign, new route, configuration-history store, campaign engine, arbitrary telemetry or auto-remediation.

If the frozen API blocks a necessary acceptance criterion, stop and report the exact response field/route missing and the smallest follow-up. Do not work around it with browser persistence presented as durable server state.

## 6. TDD and acceptance gates

Use small commits prefixed `Task9e-fleet-console:` and stage explicit paths. Prove at minimum:

1. API bindings use the exact five paths and closed request/response unions.
2. All six fleet states render distinctly; null observed/queue/delivery fields render `Unavailable`, never `0` or healthy.
3. Inventory filtering and selection do not lose revoked/unreported machines.
4. Create validates version/channel/ring/date/reason before submission and retains the returned configuration for immediate assignment.
5. Assign validates UUID, deduplicates machine IDs, caps at 100 and labels older-configuration assignment as rollback.
6. Offboard apply cannot run before a successful preview, explicit confirmation and non-empty reason; preview itself never mutates.
7. Completion text keeps server revocation, local cleanup and MDM cleanup separate.
8. Auditor/non-admin behavior remains the existing read-only/no-access behavior; the fleet workspace does not bypass it.
9. No rendered or logged value contains a credential, raw customer content or tenant-crossing identifier supplied outside the authenticated API.

Run once at the stable checkpoint:

```bash
npm run test:fleet -w apps/api
npm run typecheck
npm run lint
npm run build:web
npm run check
git diff --check
```

If `npm run check` repeats a gate already completed, report it once rather than rerunning individual commands again. A network, npm exit-handler or sandbox listener failure is infrastructure-only only when the log supports that classification.

## 7. Close-out

- Clean tree; do not push, open a PR or merge.
- Handoff under 90 lines: exact files and API bindings, customer journeys, honest-state handling, configuration-history limitation, focused/full gates, screenshots/manual inspection if performed, integration-test impact and effort.
- IT-T9-01 remains the server-contract evidence. Task9e adds no live database verifier. IT-T9-03/04/06/07 and MDM/native support remain later-session evidence, not UI claims.
- Final reply provides commits, changed files, test counts, actual effort and any Task9d/Task10 follow-up.
- Provide exactly one founder `bash` block for review/push/PR after a `ready to push` verdict, and exactly one `text` review request to TrackAI-Orchestrator/Codex naming branch, commits, base and completed gates.

## Lessons to carry forward

- Task4's UI is extended, not replaced: identity/credentials stay in **Machines & keys**; fleet desired/observed state gets its own section.
- A mismatch is evidence to investigate, not proof of compromise. Reconciliation unavailable is not a match.
- Preview and explicit confirmation are part of the offboard security contract, not visual polish.
- The frozen API intentionally lacks configuration-history listing; do not hide that limitation with local-only state.
