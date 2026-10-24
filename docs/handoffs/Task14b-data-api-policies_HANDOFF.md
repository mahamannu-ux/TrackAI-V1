# Task14b Handoff — Supabase Data API policy closure

> Status: 🟡 prepared locally; live change requires separate founder approval.

Branch `task/Task14b-data-api-policies` is rebased onto `origin/main` at
`df001a1`, the merge of Task14a
[PR #106](https://github.com/mahamannu-ux/TrackAI-V1/pull/106).
The Task14b diff contains only this session's changes. No live SQL,
project setting, or Auth setting was changed by Task14b.

## At a glance

| Item | Status |
|---|---|
| Policy closure | 🟡 New generated Drizzle migration 0029 removes the seven policies found live and the four that fresh 0000 can create. Live apply pending. |
| Login and API | 🟡 Disposable role probe preserved a synthetic anonymous `sso_tenants` lookup and privileged API read. No application code changed. |
| Live Data API | 🟡 Read-only zero-row requests to `public.sso_tenants` and `public.ai_sessions` both returned HTTP 200 with empty arrays on 2026-10-24. The founder chose local evidence only for now; the configured exposed-schema list and safe authenticated-account read are deferred. |
| Quality | 🟡 `drizzle-kit check`, `npm run typecheck`, `npm run lint`, 1,265 unit tests, web production build and disposable PostgreSQL 17 verification passed as separate commands. The first sandbox `npm run check` was interrupted. |
| Review | ✅ Independent read-only review found a test-order gap; revised test passed and re-review found no remaining actionable issue. |

## Implemented interfaces

- `apps/api/drizzle/0029_task14b_data_api_policy_closure.sql`: eleven exact
  `DROP POLICY IF EXISTS` statements, including the four absent on live.
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
prompt assigned a new forward migration to Task14b. There is **no** founder
approval yet to apply 0029 or alter any live setting.

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
| ⬜ **FOUNDER:** | When resuming live validation, confirm the dashboard Data API exposed-schema list and run a safe test-account pre/post 0029 read probe without copying a token or tenant data into logs/chat. | Deferred by founder for now; blocking: effective authenticated Data API closure claim. |
| ⬜ **FOUNDER:** | Review and approve the exact 0029 SQL separately before live apply; preserve `public` while pre-login `sso_tenants` routing uses it. | Blocking: live policy closure. |
| 🟡 | Policies are removed while existing `authenticated` table SELECT grants may remain. RLS with no replacement policy denies browser rows, but a later permissive policy could reopen them. | Review future policy additions and consider a separate grant cleanup only with a role/dependency audit. |
| 🟡 | Task17 owns the Task2/4/5/6 regression, and Task14b changes no API or web code. | Task17's regression remains a separate gate. |

## Test coverage

The PostgreSQL 17 disposable test passed: Drizzle migrated the fresh schema
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

## Integration test impact

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T14b-01 | Disposable migration and role/policy behavior | Blocking: Task14b merge and live apply consideration | 🟡 agent-verified on 2026-10-24; founder live authenticated probe pending |

Disposable command (it creates and removes its own database):

```bash
cd ~/AIProjects/TrackAI-wt/Task14b-data-api-policies
IT_PG_MODE=docker IT_PG_VERSION=17 IT_PG_IMAGE=pgvector/pgvector:pg17 IT_PG_DATABASES=trackai IT_PG_EXPORTS=DATABASE_URL=trackai scripts/it-postgres.sh bash docs/ops/task14b_verify_policy_closure.sh
```

## Integration notes

The live 0000 ledger hash is historical and must not be changed. Apply only
new migration 0029 after independent review and separate founder approval.
Before approval, inspect the live ledger at 0028, exact seven policy names,
RLS and `sso_tenants` login policy/privilege; compare 0029's SHA-256
`a3384a12198c126a66a05c266066cbd54d5f7fd4a21cf0f551a30f3cfbdff18b`.
After any separately approved live apply, confirm ledger 0029, zero legacy
policies, `sso_tenants` anonymous login lookup, authenticated direct-read
denial, and protected API dashboard behavior. Do not disable `public` Data API
exposure or alter Auth settings as part of this change.

## Effort (estimate vs actual)

Estimate about 0.10× T6; actual about 0.10× T6 plus pending live/founder
review. The local work stayed within one session.
