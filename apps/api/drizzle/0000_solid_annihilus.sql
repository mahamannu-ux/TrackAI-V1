-- Task1 review migration. The original Supabase environment already contained
-- the four registry/SCM tables below. CREATE TABLE IF NOT EXISTS preserves that
-- installation while also making the canonical migration chain capable of
-- bootstrapping an empty PostgreSQL database. Drizzle supplies the transaction
-- boundary. Existing databases have already journaled this migration and do
-- not reapply it when this portable baseline definition is added.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "sso_tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_name" text NOT NULL,
  "domain" text NOT NULL UNIQUE,
  "supabase_provider_id" text NOT NULL,
  "scm_org_identifier" text UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "scm_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_repositories_tenant_id_provider_external_id_key"
    UNIQUE("tenant_id", "provider", "external_id")
);

CREATE TABLE IF NOT EXISTS "scm_pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "repository_id" uuid NOT NULL REFERENCES "scm_repositories"("id"),
  "external_id" text NOT NULL,
  "title" text NOT NULL,
  "state" text NOT NULL,
  "author_email" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_pull_requests_tenant_id_repository_id_external_id_key"
    UNIQUE("tenant_id", "repository_id", "external_id")
);

CREATE TABLE IF NOT EXISTS "scm_contributors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "repository_id" uuid NOT NULL REFERENCES "scm_repositories"("id"),
  "name" text NOT NULL,
  "email" text NOT NULL,
  "machine_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_contributors_tenant_id_repository_id_email_key"
    UNIQUE("tenant_id", "repository_id", "email")
);

CREATE TABLE IF NOT EXISTS "scm_branches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "repository_id" uuid NOT NULL REFERENCES "scm_repositories"("id"),
  "name" text NOT NULL,
  "last_commit_sha" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_branches_tenant_id_repository_id_name_key"
    UNIQUE("tenant_id", "repository_id", "name")
);

ALTER TABLE "scm_repositories" ADD COLUMN IF NOT EXISTS "normalized_url" text;
ALTER TABLE "scm_pull_requests" ADD COLUMN IF NOT EXISTS "head_ref" text;
ALTER TABLE "scm_pull_requests" ADD COLUMN IF NOT EXISTS "base_ref" text;
ALTER TABLE "scm_pull_requests" ADD COLUMN IF NOT EXISTS "head_sha" text;
ALTER TABLE "scm_pull_requests" ADD COLUMN IF NOT EXISTS "merge_commit_sha" text;
ALTER TABLE "scm_repositories"
  ADD CONSTRAINT "scm_repositories_tenant_id_normalized_url_key"
  UNIQUE ("tenant_id", "normalized_url");

CREATE TABLE "telemetry_ingest_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "api_version" integer NOT NULL,
  "payload_hash" text NOT NULL,
  "event_count" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "telemetry_ingest_batches_tenant_id_payload_hash_key" UNIQUE("tenant_id", "payload_hash")
);

CREATE TABLE "telemetry_metric_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "batch_id" uuid NOT NULL REFERENCES "telemetry_ingest_batches"("id"),
  "event_index" integer NOT NULL,
  "event_fingerprint" text NOT NULL,
  "event_kind" integer NOT NULL,
  "event_timestamp" timestamp with time zone NOT NULL,
  "raw_event" jsonb NOT NULL,
  "normalization_status" text DEFAULT 'pending' NOT NULL,
  "normalization_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "telemetry_metric_events_tenant_id_event_fingerprint_key" UNIQUE("tenant_id", "event_fingerprint")
);

CREATE TABLE "scm_commits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "repository_id" uuid NOT NULL REFERENCES "scm_repositories"("id"),
  "sha" text NOT NULL,
  "branch" text,
  "author_name" text,
  "author_email" text,
  "subject" text NOT NULL,
  "body" text,
  "authored_at" timestamp with time zone,
  "committed_at" timestamp with time zone,
  "diff_added_lines" integer DEFAULT 0 NOT NULL,
  "diff_deleted_lines" integer DEFAULT 0 NOT NULL,
  "observed_ai_lines" integer DEFAULT 0 NOT NULL,
  "observed_human_lines" integer DEFAULT 0 NOT NULL,
  "observed_unknown_lines" integer DEFAULT 0 NOT NULL,
  "authorship_note" text,
  "source_event_id" uuid REFERENCES "telemetry_metric_events"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_commits_tenant_id_repository_id_sha_key" UNIQUE("tenant_id", "repository_id", "sha")
);

CREATE TABLE "scm_commit_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "commit_id" uuid NOT NULL REFERENCES "scm_commits"("id"),
  "path" text NOT NULL,
  "observed_ai_lines" integer DEFAULT 0 NOT NULL,
  "observed_human_lines" integer DEFAULT 0 NOT NULL,
  "observed_unknown_lines" integer DEFAULT 0 NOT NULL,
  "attribution_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_commit_files_tenant_id_commit_id_path_key" UNIQUE("tenant_id", "commit_id", "path")
);

CREATE TABLE "ai_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "external_session_id" text NOT NULL,
  "git_ai_session_id" text,
  "parent_session_id" text,
  "tool" text NOT NULL,
  "display_name" text,
  "observed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "human_author" text,
  "status" text DEFAULT 'active' NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_sessions_tenant_id_tool_external_session_id_key" UNIQUE("tenant_id", "tool", "external_session_id")
);

CREATE TABLE "ai_session_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "session_id" uuid NOT NULL REFERENCES "ai_sessions"("id"),
  "repository_id" uuid NOT NULL REFERENCES "scm_repositories"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_session_repositories_tenant_session_repository_key" UNIQUE("tenant_id", "session_id", "repository_id")
);

CREATE TABLE "ai_session_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "session_id" uuid NOT NULL REFERENCES "ai_sessions"("id"),
  "model" text,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "reasoning_tokens" bigint,
  "cache_read_tokens" bigint,
  "cache_write_tokens" bigint,
  "cost_amount" numeric(20, 6),
  "cost_unit" text,
  "availability" text DEFAULT 'unavailable' NOT NULL,
  "evidence_source" text NOT NULL,
  "source_event_id" uuid REFERENCES "telemetry_metric_events"("id"),
  "evidence_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_session_usage_tenant_id_evidence_key_key" UNIQUE("tenant_id", "evidence_key")
);

CREATE TABLE "ai_commit_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "commit_id" uuid NOT NULL REFERENCES "scm_commits"("id"),
  "session_id" uuid NOT NULL REFERENCES "ai_sessions"("id"),
  "observed_ai_lines" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_commit_sessions_tenant_commit_session_key" UNIQUE("tenant_id", "commit_id", "session_id")
);

CREATE TABLE "scm_pull_request_commits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "pull_request_id" uuid NOT NULL REFERENCES "scm_pull_requests"("id"),
  "commit_id" uuid NOT NULL REFERENCES "scm_commits"("id"),
  "match_method" text NOT NULL,
  "confidence" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scm_pull_request_commits_tenant_pull_request_commit_key" UNIQUE("tenant_id", "pull_request_id", "commit_id")
);

CREATE TABLE "telemetry_corrections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "sso_tenants"("id"),
  "target_type" text NOT NULL,
  "target_key" text NOT NULL,
  "field_name" text NOT NULL,
  "corrected_value" jsonb NOT NULL,
  "reason" text NOT NULL,
  "evidence_ref" text,
  "created_by" text DEFAULT 'system' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "telemetry_corrections_tenant_target_field_key" UNIQUE("tenant_id", "target_type", "target_key", "field_name")
);

CREATE INDEX "ai_sessions_tenant_git_ai_session_idx" ON "ai_sessions" ("tenant_id", "git_ai_session_id");
CREATE INDEX "scm_commits_tenant_committed_at_idx" ON "scm_commits" ("tenant_id", "committed_at");
CREATE INDEX "telemetry_metric_events_tenant_kind_timestamp_idx" ON "telemetry_metric_events" ("tenant_id", "event_kind", "event_timestamp");

-- The API's service role writes. Authenticated browser roles may only read
-- normalized tenant rows matching the domain in their JWT email claim.
ALTER TABLE "scm_commits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_commit_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_session_repositories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_session_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_commit_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_pull_request_commits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telemetry_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telemetry_ingest_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telemetry_metric_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sso_tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_repositories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_pull_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_contributors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_branches" ENABLE ROW LEVEL SECURITY;

DO $task1_rls$
DECLARE table_name text;
BEGIN
  -- Standard PostgreSQL/VPC installs authenticate through the protected API
  -- and may not have Supabase's browser role/function. Supabase installs keep
  -- the existing direct-read policy when both facilities are available.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
    AND to_regprocedure('auth.jwt()') IS NOT NULL THEN
    FOREACH table_name IN ARRAY ARRAY[
      'scm_repositories', 'scm_pull_requests',
      'scm_contributors', 'scm_branches',
      'scm_commits', 'scm_commit_files', 'ai_sessions',
      'ai_session_repositories', 'ai_session_usage', 'ai_commit_sessions',
      'scm_pull_request_commits'
    ] LOOP
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (tenant_id IN (SELECT id FROM sso_tenants WHERE lower(domain) = lower(split_part(auth.jwt()->>''email'', ''@'', 2))))',
        table_name || '_tenant_select', table_name
      );
    END LOOP;
  END IF;
END $task1_rls$;

-- Raw evidence and correction authoring intentionally have no browser policy.
-- With RLS enabled this denies anon/authenticated access while the service role
-- remains responsible for ingestion and protected API responses.
