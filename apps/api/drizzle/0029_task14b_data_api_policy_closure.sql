-- Task14b: application data is read through the protected TrackAI API.
-- Migration 0000 created these browser policies when Supabase roles existed.
-- Seven exist on the live project; the other four can exist on a fresh install.
-- Remove all eleven by exact name. Keep public.sso_tenants and its anonymous
-- login-routing policy/privilege untouched.
DROP POLICY IF EXISTS "ai_sessions_tenant_select" ON "public"."ai_sessions";
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_session_repositories_tenant_select" ON "public"."ai_session_repositories";
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_session_usage_tenant_select" ON "public"."ai_session_usage";
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_commit_sessions_tenant_select" ON "public"."ai_commit_sessions";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_commits_tenant_select" ON "public"."scm_commits";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_commit_files_tenant_select" ON "public"."scm_commit_files";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_pull_request_commits_tenant_select" ON "public"."scm_pull_request_commits";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_repositories_tenant_select" ON "public"."scm_repositories";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_pull_requests_tenant_select" ON "public"."scm_pull_requests";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_contributors_tenant_select" ON "public"."scm_contributors";
--> statement-breakpoint
DROP POLICY IF EXISTS "scm_branches_tenant_select" ON "public"."scm_branches";
