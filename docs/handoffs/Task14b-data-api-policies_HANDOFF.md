# Task14b Handoff — Supabase Data API policy closure

> Status: ✅ migration 0029 applied to the approved live project on 2026-11-21;
> database postflight and founder-reported Okta/dashboard smoke passed.

Branch `task/Task14b-data-api-policies` includes `origin/main` through
merged Task20 test fix [PR #110](https://github.com/mahamannu-ux/TrackAI-V1/pull/110).
PR #109 is merged. The founder separately approved the exact 0029 live apply.
No Auth setting or Data API exposed-schema setting was changed.

## At a glance

| Item | Status |
|---|---|
| Policy closure | ✅ Founder-approved 0029 applied live in 3.5 seconds. Ledger 30, zero legacy policies; RLS and anonymous login configuration unchanged. |
| Login and API | ✅ Founder completed fresh Company A Okta sign-in and reported dashboard data loading through the protected API after apply. No application code changed. |
| Live Data API | 🟡 Pre-apply zero-row probes confirmed `public` was reachable. Post-apply catalog check shows the eleven legacy policy names gone; a safe authenticated-account Data API probe and configured exposed-schema inspection remain deferred. |
| Quality | ✅ Revised 0029: Drizzle check, typecheck and lint passed. Founder ran both disposable database gates on November 21. After merging PR #110 into this branch, `npm test` passed 1,265/1,265 (100 suites, zero failures). |
| Review | ✅ Task20 lead reviewed `61c5527` as ready after the revised disposable gates; both passed. PR #109 merged before live apply. |

## Implemented interfaces

- `apps/api/drizzle/0029_task14b_data_api_policy_closure.sql`: eleven exact
  `DROP POLICY IF EXISTS` operations in a role-guarded block, including the four absent on live.
  Neither table privileges nor `sso_tenants` are changed.
- `docs/ops/task14b_verify_policy_closure.sh`: run under a throwaway
  `scripts/it-postgres.sh` database. It migrates through 0028, proves fresh
  0000 created eleven policies, removes the four absent live, sets up login
  policy/grants and synthetic rows, then applies 0029 through Drizzle. It
  proves direct read before, denial after, and unchanged login configuration.

## Ported from

None. This is a small, project-specific correction to migration 0000's
legacy policy names; no catalog component reduces its scope or risk.

## Founder-approved decisions

Task20 directed that the four absent live policies stay absent. Task14a's
prompt assigned a new forward migration to Task14b. On 2026-11-21 the founder
approved applying the exact reviewed 0029 SQL to the live project after a fresh
encrypted backup. The apply helper required a second typed confirmation.

## Deviations from spec

The change drops eleven names, although only seven exist live. Migration 0000
creates all eleven on a fresh Supabase installation, so this prevents a fresh
deployment from reopening the four missing live reads. The live Data API
schema configuration could not be read from this agent's available session;
the effective `public` endpoint was verified with zero-row requests instead.
No safe test account session/token was available, and the founder chose local
evidence only for now. The dedicated worktree was first created from the
Task14a commit; after PR #106 merged, its Task14b-only commits were rebased
onto the merge. Only Task14b's status row and registry row were edited.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOLLOW-UP:** | Confirm the dashboard Data API exposed-schema list and run a safe test-account post-0029 read probe without copying a token or tenant data into logs/chat. | Deferred by founder; catalog/RLS checks and protected API browser smoke passed, but hosted authenticated Data API behavior has not been directly probed. |
| 🟡 | Policies are removed while existing `authenticated` table SELECT grants may remain. RLS with no replacement policy denies browser rows, but a later permissive policy could reopen them. | Review future policy additions and consider a separate grant cleanup only with a role/dependency audit. |
| 🟡 | Task17 owns the Task2/4/5/6 regression, and Task14b changes no API or web code. | Task17's regression remains a separate gate. |
| ⬜ **FOLLOW-UP:** | `anon` has effective SELECT access to `public.sso_tenants`; a public anon key can enumerate tenant domains. The pre-login frontend lookup depends on this access. | Replace the broad table SELECT with a rate-limited first-party login lookup accepting one normalized domain and returning only whether SSO is enabled; handle provider-specific redirect server-side so provider IDs and the tenant list are not exposed. Then revoke `anon` SELECT and remove the broad policy in a separately reviewed change. Do not change this login path in Task14b. |

## Test coverage

The PostgreSQL 17 disposable test passed for the preceding 0029 revision: Drizzle migrated the fresh schema
through 0028, with all eleven legacy policies present and RLS on. After
removing the four missing live policies, the remaining seven permitted a
synthetic authenticated `ai_sessions` read. Drizzle then applied 0029; all
seven authenticated table reads returned zero rows, and the login policy and
column privileges had the same catalog fingerprint as before 0029. The
anonymous `sso_tenants` provider lookup and privileged application read
still worked. `drizzle-kit check`, typecheck and lint passed. The unit suite
passed 1,265/1,265 under command-scoped localhost access. The first sandbox
`npm run check` encountered localhost failures and a stalled Attesta test;
it was interrupted and is not counted as a green full check. The web
production build then passed separately with the check script's placeholder
public client configuration.
The test uses synthetic rows and a stub `auth.jwt()` function. It does not
exercise hosted PostgREST or a real Auth session.
The independent reviewer first found that the login policy was being created
after 0029 in the disposable test. The test now builds the live-shaped state
before Drizzle applies 0029, fingerprints the login policy and privileges
across the migration, and queries all seven formerly readable tables. The
re-review found no remaining actionable findings.
The November 21 role guard changes 0029 after that earlier review. `drizzle-kit check`,
typecheck and lint passed. The founder's Docker disposable role/policy gate passed
on throwaway port 54367, and `scripts/it-db.sh` applied the migrations on plain
PostgreSQL without `authenticated` on throwaway port 54394. Neither used the
Task20j or Task15n database. Task20 lead reviewed commit `61c5527` as ready
after those gates. The founder's `npm test` then passed 1,264/1,265; the one
failure was Task20i-a's fixed October 10 fixture outside the default rolling
30-day read window. Task20 fixed the test with an explicit fixture date range
in merged PR #110. After merging that fix into this branch, the founder reran
`npm test`: 1,265 tests passed, zero failed, in 36.2 seconds.

## Integration test impact

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T14b-01 | Disposable migration and role/policy behavior | Blocking: Task14b merge and live apply consideration | ✅ revised 0029 role/policy and plain-PostgreSQL gates founder-verified 2026-11-21; live authenticated probe deferred to post-apply checks |

Disposable command (it creates and removes its own database):

```bash
cd ~/AIProjects/TrackAI-wt/Task14b-data-api-policies
IT_PG_MODE=docker IT_PG_VERSION=17 IT_PG_IMAGE=pgvector/pgvector:pg17 IT_PG_DATABASES=trackai IT_PG_EXPORTS=DATABASE_URL=trackai scripts/it-postgres.sh bash docs/ops/task14b_verify_policy_closure.sh
scripts/it-db.sh sh -c 'test "$(psql "$DATABASE_URL" -X -tA -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_roles WHERE rolname = '\''authenticated'\''")" = 0'
```

## Integration notes

### Live apply, 2026-11-21

Read-only preflight found 29 ledger entries, exactly seven live legacy
policies, none of the four other names, RLS on all eleven tables, and both
anonymous `sso_tenants` login columns readable. The founder ran
`task14b_backup_live.py` after a preflight-query correction; it verified a
fresh encrypted full dump and authenticated readback. The archive SHA-256 is
`4fdd71ee3e246f890d0264a6c1b10755f99145f288a5763f6fd1e3eb657f71b5`.
The encrypted archive and key are private local files under
`~/AIProjects/_task14b_backup_20261121/`; they are currently on the same Mac
and should be copied to separate private storage for durable recovery.

After separate founder approval and typed project-specific confirmation,
`task14b_apply_live.py --apply` verified the reviewed 0029 SHA-256, backup,
0028 ledger, seven policies, RLS and login configuration. Drizzle exited 0 in
3.5 seconds. Read-only postflight found ledger 30, zero legacy policies, and
unchanged RLS and anonymous login configuration. The founder then completed
fresh Company A Okta login at the live web origin and reported dashboard data
loading through the protected API. An initial attempt on localhost:3000 hit
Task20j's synthetic Auth server; the live smoke ran separately on web 3002
and API 8082 using the live Supabase project and transaction pooler. No Task20j
or Task15n port/database was altered. Auth and Data API settings were not changed.

The live 0000 ledger hash is historical and must not be changed. Apply only
new migration 0029 after independent review and separate founder approval
(completed above). The reviewed 0029 SHA-256 was
`b3b9cb300c6c893d8491b26998f3151ec66a215177e66349406866c24c0055c1`.
Do not disable `public` Data API exposure until the anonymous login lookup is
redesigned. The hosted authenticated Data API denial remains a follow-up probe.

## Effort (estimate vs actual)

Estimate about 0.10× T6; actual about 0.15× T6 including live preflight,
encrypted backup, guarded apply, and browser smoke. The first backup helper
query failed before any dump or database write and was corrected before the
successful run.
