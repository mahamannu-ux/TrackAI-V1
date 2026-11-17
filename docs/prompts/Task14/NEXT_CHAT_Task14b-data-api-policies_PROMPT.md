# Task14b — close legacy direct Data API read policies

Task14a migrated the live Supabase project to Drizzle 0028. Task20 reviewed
the B5/B7 finding and directed that the four absent browser policies **not** be
added. Task4 is merged; Task17 will run its Task2/4/5/6 regression. This is a
new Supabase security follow-up, not a Task4 redo or a Task17 regression task.

On 2026-10-24, a read-only live query found seven `public` policies granting
`SELECT TO authenticated`, with effective schema and table SELECT privileges:

- `ai_sessions_tenant_select`
- `ai_session_repositories_tenant_select`
- `ai_session_usage_tenant_select`
- `ai_commit_sessions_tenant_select`
- `scm_commits_tenant_select`
- `scm_commit_files_tenant_select`
- `scm_pull_request_commits_tenant_select`

Each uses `tenant_id` matched to `sso_tenants.domain` through the JWT email
domain. The frontend normally reads application data through the protected
API. Live self-sign-up was turned off by the founder; the seven policies and
any previously created accounts remain. The four absent policies on
`scm_repositories`, `scm_pull_requests`, `scm_contributors` and `scm_branches`
must stay absent.

Investigate the live Data API exposed-schema setting and verify the effective
Data API behavior with a safe test account, without printing tokens or tenant
data. The frontend login currently queries `public.sso_tenants` before sign-in
(`apps/web/src/app/login/page.tsx`), and a live read-only query found its
public SELECT policy and `anon` privilege. Disabling `public` wholesale would
break this login route unless it is redesigned first.

Prepare a narrow, new forward migration or an equally precise reviewed
configuration change that closes the seven direct reads while retaining the
protected API, login routing and Task17's Task2/4/5/6 regression. Do not edit
merged 0000 or its ledger. Rehearse on a disposable copy, add meaningful
security tests, and request independent review. Do not change the live
project, apply a migration, or alter Auth settings without the founder's
separate approval for the exact change. Record the result in a Task14b handoff
and the status board.

Task14a evidence and the Task20 disposition are in
`docs/handoffs/Task14a-supabase-database_HANDOFF.md` and
`docs/plan/TASK14_SUPABASE.md` §B5.
