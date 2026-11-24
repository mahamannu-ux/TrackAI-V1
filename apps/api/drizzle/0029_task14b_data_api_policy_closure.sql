-- Task14b: application data is read through the protected TrackAI API.
-- Migration 0000 created these browser policies when Supabase roles existed.
-- Seven exist on the live project; the other four can exist on a fresh install.
-- Remove all eleven by exact name. Keep public.sso_tenants and its anonymous
-- login-routing policy/privilege untouched.
-- Plain PostgreSQL installs may have neither the role nor the policies.
DO $task14b_policy_closure$
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'ai_sessions', 'ai_session_repositories', 'ai_session_usage',
      'ai_commit_sessions', 'scm_commits', 'scm_commit_files',
      'scm_pull_request_commits', 'scm_repositories', 'scm_pull_requests',
      'scm_contributors', 'scm_branches'
    ] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
        table_name || '_tenant_select', table_name);
    END LOOP;
  END IF;
END $task14b_policy_closure$;
