CREATE TABLE "ai_code_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"session_id" uuid,
	"commit_id" uuid,
	"pull_request_id" uuid,
	"stage" text NOT NULL,
	"line_count" integer NOT NULL,
	"actor_kind" text,
	"evidence_type" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_code_lifecycle_events_tenant_stage_evidence_key" UNIQUE("tenant_id","stage","evidence_ref")
);
--> statement-breakpoint
CREATE TABLE "ai_generation_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid,
	"repository_id" uuid,
	"source_event_id" uuid NOT NULL,
	"trace_id" text,
	"model" text,
	"file_path" text,
	"generated_lines" integer NOT NULL,
	"accepted_lines" integer,
	"generated_at" timestamp with time zone NOT NULL,
	"evidence_source" text NOT NULL,
	CONSTRAINT "ai_generation_observations_tenant_source_event_key" UNIQUE("tenant_id","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "scm_commit_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"predecessor_commit_id" uuid,
	"predecessor_sha" text NOT NULL,
	"successor_commit_id" uuid,
	"successor_sha" text NOT NULL,
	"operation_kind" text NOT NULL,
	"evidence_source" text NOT NULL,
	"confidence" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_commit_lineage_tenant_repo_predecessor_successor_operation_key" UNIQUE("tenant_id","repository_id","predecessor_sha","successor_sha","operation_kind")
);
--> statement-breakpoint
CREATE TABLE "scm_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"environment" text NOT NULL,
	"ref" text,
	"sha" text NOT NULL,
	"status" text NOT NULL,
	"production" boolean DEFAULT false NOT NULL,
	"deployed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_deployments_tenant_provider_external_id_status_key" UNIQUE("tenant_id","provider","external_id","status")
);
--> statement-breakpoint
CREATE TABLE "scm_merge_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"source_commit_id" uuid NOT NULL,
	"result_commit_id" uuid,
	"result_sha" text NOT NULL,
	"merge_method" text NOT NULL,
	"confidence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_merge_lineage_tenant_pr_source_result_key" UNIQUE("tenant_id","pull_request_id","source_commit_id","result_sha")
);
--> statement-breakpoint
CREATE TABLE "scm_provider_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_provider_identities_tenant_provider_user_key" UNIQUE("tenant_id","provider","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "scm_pull_request_commit_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"commit_id" uuid NOT NULL,
	"first_seen_snapshot_id" uuid NOT NULL,
	"last_seen_snapshot_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "scm_pr_commit_memberships_tenant_pr_commit_key" UNIQUE("tenant_id","pull_request_id","commit_id")
);
--> statement-breakpoint
CREATE TABLE "scm_pull_request_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"head_sha" text,
	"snapshot_key" text NOT NULL,
	"commit_shas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scm_pr_snapshots_tenant_pr_snapshot_key" UNIQUE("tenant_id","pull_request_id","snapshot_key")
);
--> statement-breakpoint
CREATE TABLE "tenant_identity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_identity_id" uuid NOT NULL,
	"sso_subject" text,
	"sso_email" text,
	"status" text DEFAULT 'unlinked' NOT NULL,
	"linked_by" text,
	"linked_at" timestamp with time zone,
	CONSTRAINT "tenant_identity_links_tenant_provider_identity_key" UNIQUE("tenant_id","provider_identity_id")
);
--> statement-breakpoint
ALTER TABLE "scm_contributors" DROP CONSTRAINT "scm_contributors_tenant_id_repository_id_email_key";--> statement-breakpoint
ALTER TABLE "scm_contributors" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ALTER COLUMN "author_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_commits" ADD COLUMN "operation_kind" text DEFAULT 'commit' NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_commits" ADD COLUMN "patch_id" text;--> statement-breakpoint
ALTER TABLE "scm_commits" ADD COLUMN "reachability" text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_commits" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_commits" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_contributors" ADD COLUMN "provider_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ADD COLUMN "author_provider_id" text;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ADD COLUMN "author_login" text;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_code_lifecycle_events" ADD CONSTRAINT "ai_code_lifecycle_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_code_lifecycle_events" ADD CONSTRAINT "ai_code_lifecycle_events_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_code_lifecycle_events" ADD CONSTRAINT "ai_code_lifecycle_events_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_code_lifecycle_events" ADD CONSTRAINT "ai_code_lifecycle_events_commit_id_scm_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_code_lifecycle_events" ADD CONSTRAINT "ai_code_lifecycle_events_pull_request_id_scm_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."scm_pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation_observations" ADD CONSTRAINT "ai_generation_observations_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation_observations" ADD CONSTRAINT "ai_generation_observations_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation_observations" ADD CONSTRAINT "ai_generation_observations_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation_observations" ADD CONSTRAINT "ai_generation_observations_source_event_id_telemetry_metric_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."telemetry_metric_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_commit_lineage" ADD CONSTRAINT "scm_commit_lineage_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_commit_lineage" ADD CONSTRAINT "scm_commit_lineage_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_commit_lineage" ADD CONSTRAINT "scm_commit_lineage_predecessor_commit_id_scm_commits_id_fk" FOREIGN KEY ("predecessor_commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_commit_lineage" ADD CONSTRAINT "scm_commit_lineage_successor_commit_id_scm_commits_id_fk" FOREIGN KEY ("successor_commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_deployments" ADD CONSTRAINT "scm_deployments_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_deployments" ADD CONSTRAINT "scm_deployments_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_merge_lineage" ADD CONSTRAINT "scm_merge_lineage_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_merge_lineage" ADD CONSTRAINT "scm_merge_lineage_pull_request_id_scm_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."scm_pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_merge_lineage" ADD CONSTRAINT "scm_merge_lineage_source_commit_id_scm_commits_id_fk" FOREIGN KEY ("source_commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_merge_lineage" ADD CONSTRAINT "scm_merge_lineage_result_commit_id_scm_commits_id_fk" FOREIGN KEY ("result_commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_provider_identities" ADD CONSTRAINT "scm_provider_identities_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_commit_memberships" ADD CONSTRAINT "scm_pull_request_commit_memberships_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_commit_memberships" ADD CONSTRAINT "scm_pull_request_commit_memberships_pull_request_id_scm_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."scm_pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_commit_memberships" ADD CONSTRAINT "scm_pull_request_commit_memberships_commit_id_scm_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_commit_memberships" ADD CONSTRAINT "scm_pull_request_commit_memberships_first_seen_snapshot_id_scm_pull_request_snapshots_id_fk" FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "public"."scm_pull_request_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_commit_memberships" ADD CONSTRAINT "scm_pull_request_commit_memberships_last_seen_snapshot_id_scm_pull_request_snapshots_id_fk" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "public"."scm_pull_request_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_snapshots" ADD CONSTRAINT "scm_pull_request_snapshots_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_pull_request_snapshots" ADD CONSTRAINT "scm_pull_request_snapshots_pull_request_id_scm_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."scm_pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_identity_links" ADD CONSTRAINT "tenant_identity_links_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_identity_links" ADD CONSTRAINT "tenant_identity_links_provider_identity_id_scm_provider_identities_id_fk" FOREIGN KEY ("provider_identity_id") REFERENCES "public"."scm_provider_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scm_pr_snapshots_tenant_pr_captured_idx" ON "scm_pull_request_snapshots" USING btree ("tenant_id","pull_request_id","captured_at");--> statement-breakpoint
ALTER TABLE "scm_contributors" ADD CONSTRAINT "scm_contributors_provider_identity_id_scm_provider_identities_id_fk" FOREIGN KEY ("provider_identity_id") REFERENCES "public"."scm_provider_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_contributors" ADD CONSTRAINT "scm_contributors_tenant_id_repository_id_provider_identity_key" UNIQUE("tenant_id","repository_id","provider_identity_id");

-- Task2 lifecycle evidence is server-only. Enabling RLS without anon/authenticated
-- policies prevents direct browser access while the protected Express API uses
-- the database service role and applies withTenant() to every query.
ALTER TABLE "ai_code_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_generation_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_commit_lineage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_deployments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_merge_lineage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_provider_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_pull_request_commit_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scm_pull_request_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_identity_links" ENABLE ROW LEVEL SECURITY;
