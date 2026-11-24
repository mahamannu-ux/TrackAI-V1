#!/usr/bin/env bash
# Run only under scripts/it-postgres.sh against its disposable DATABASE_URL.
set -euo pipefail

: "${DATABASE_URL:?disposable DATABASE_URL required}"
case "$DATABASE_URL" in
  postgresql://app:dev@127.0.0.1:*/trackai) ;;
  *) echo 'Refusing a URL outside the throwaway it-postgres database' >&2; exit 2 ;;
esac

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
  AS $$ SELECT '{"email":"tester@example.test"}'::jsonb $$;
SQL

migration_copy="$(mktemp -d "$PWD/.task14b_migrations.XXXXXX")"
trap 'rm -rf "$migration_copy"' EXIT
cp -R apps/api/drizzle "$migration_copy/drizzle"
python3 - "$migration_copy/drizzle/meta/_journal.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding='utf-8') as source:
    journal = json.load(source)
assert journal['entries'][-1]['tag'] == '0029_task14b_data_api_policy_closure'
journal['entries'].pop()
with open(path, 'w', encoding='utf-8') as destination:
    json.dump(journal, destination)
PY
TASK14B_PRE_DIR="$migration_copy/drizzle" node - <<'NODE'
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
migrate(drizzle(pool), { migrationsFolder: process.env.TASK14B_PRE_DIR })
  .then(() => pool.end())
  .catch(async error => { await pool.end(); console.error(error.message); process.exitCode = 1; });
NODE

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND policyname LIKE '%_tenant_select'
      AND tablename IN (
        'ai_sessions', 'ai_session_repositories', 'ai_session_usage',
        'ai_commit_sessions', 'scm_commits', 'scm_commit_files',
        'scm_pull_request_commits', 'scm_repositories', 'scm_pull_requests',
        'scm_contributors', 'scm_branches'
      )
  ) <> 11 THEN RAISE EXCEPTION 'fresh 0000 did not create eleven policies'; END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (
        'ai_sessions', 'ai_session_repositories', 'ai_session_usage',
        'ai_commit_sessions', 'scm_commits', 'scm_commit_files',
        'scm_pull_request_commits', 'scm_repositories', 'scm_pull_requests',
        'scm_contributors', 'scm_branches'
      ) AND c.relrowsecurity) <> 11
  THEN RAISE EXCEPTION 'RLS disabled on a guarded table'; END IF;
END $$;
DROP POLICY scm_repositories_tenant_select ON public.scm_repositories;
DROP POLICY scm_pull_requests_tenant_select ON public.scm_pull_requests;
DROP POLICY scm_contributors_tenant_select ON public.scm_contributors;
DROP POLICY scm_branches_tenant_select ON public.scm_branches;

INSERT INTO public.sso_tenants (id, company_name, domain, supabase_provider_id)
VALUES ('11111111-1111-4111-8111-111111111111', 'Synthetic A', 'example.test', 'custom:test');
INSERT INTO public.scm_repositories
  (id, tenant_id, provider, external_id, name, url)
VALUES
  ('22222222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111',
   'github', 'synthetic-1', 'synthetic', 'https://example.test/synthetic');
INSERT INTO public.ai_sessions (id, tenant_id, external_session_id, tool)
VALUES ('33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111', 'synthetic-session', 'test');
CREATE ROLE anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.scm_repositories, public.ai_sessions,
  public.ai_session_repositories, public.ai_session_usage,
  public.ai_commit_sessions, public.scm_commits,
  public.scm_commit_files, public.scm_pull_request_commits
  TO authenticated;
GRANT SELECT (id, domain, supabase_provider_id) ON public.sso_tenants TO anon, authenticated;
CREATE POLICY sso_tenants_anon_select ON public.sso_tenants
  FOR SELECT TO anon, authenticated USING (true);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
      AND policyname LIKE '%_tenant_select') <> 7
  THEN RAISE EXCEPTION 'live-shaped seven-policy precondition failed'; END IF;
END $$;

SET ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.ai_sessions) <> 1
  THEN RAISE EXCEPTION 'live-shaped policy did not permit direct read'; END IF;
  IF (SELECT count(*) FROM public.scm_repositories) <> 0
  THEN RAISE EXCEPTION 'one of four absent policies unexpectedly permitted a read'; END IF;
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ BEGIN
  IF (SELECT supabase_provider_id FROM public.sso_tenants
      WHERE domain = 'example.test') <> 'custom:test'
  THEN RAISE EXCEPTION 'pre-login tenant lookup failed'; END IF;
END $$;
RESET ROLE;

DO $$ BEGIN
  IF (SELECT count(*) FROM public.scm_repositories) <> 1
  THEN RAISE EXCEPTION 'privileged API read failed'; END IF;
END $$;
SQL

# The login policy and grants exist before Drizzle applies 0029. Compare their
# catalog fingerprint afterward to catch any accidental change to routing.
login_before="$(psql "$DATABASE_URL" -X -tA -v ON_ERROR_STOP=1 -c \
  "SELECT md5(row_to_json(p)::text || has_column_privilege('anon', 'public.sso_tenants', 'domain', 'SELECT')::text || has_column_privilege('anon', 'public.sso_tenants', 'supabase_provider_id', 'SELECT')::text) FROM pg_policies p WHERE schemaname='public' AND tablename='sso_tenants' AND policyname='sso_tenants_anon_select'")"
test -n "$login_before"
npm run -s db:migrate -w apps/api >/dev/null
login_after="$(psql "$DATABASE_URL" -X -tA -v ON_ERROR_STOP=1 -c \
  "SELECT md5(row_to_json(p)::text || has_column_privilege('anon', 'public.sso_tenants', 'domain', 'SELECT')::text || has_column_privilege('anon', 'public.sso_tenants', 'supabase_provider_id', 'SELECT')::text) FROM pg_policies p WHERE schemaname='public' AND tablename='sso_tenants' AND policyname='sso_tenants_anon_select'")"
test "$login_before" = "$login_after"

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND policyname LIKE '%_tenant_select' AND tablename IN (
      'ai_sessions', 'ai_session_repositories', 'ai_session_usage',
      'ai_commit_sessions', 'scm_commits', 'scm_commit_files',
      'scm_pull_request_commits', 'scm_repositories', 'scm_pull_requests',
      'scm_contributors', 'scm_branches'))
  THEN RAISE EXCEPTION 'live-shaped policy survived removal'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'sso_tenants' AND policyname = 'sso_tenants_anon_select')
  THEN RAISE EXCEPTION 'login policy changed'; END IF;
END $$;
SET ROLE authenticated;
DO $$
DECLARE table_name text; row_count integer;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_sessions', 'ai_session_repositories', 'ai_session_usage',
    'ai_commit_sessions', 'scm_commits', 'scm_commit_files',
    'scm_pull_request_commits'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'authenticated direct read remained open on %', table_name;
    END IF;
  END LOOP;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  IF (SELECT supabase_provider_id FROM public.sso_tenants
      WHERE domain = 'example.test') <> 'custom:test'
  THEN RAISE EXCEPTION 'login lookup changed on retry'; END IF;
END $$;
RESET ROLE;
SQL

echo 'Task14b disposable role/policy verification passed'
