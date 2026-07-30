CREATE TABLE "ai_commit_model_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"commit_id" uuid NOT NULL,
	"session_id" uuid,
	"internal_session_id" text,
	"tool" text NOT NULL,
	"model" text,
	"model_key" text NOT NULL,
	"observed_ai_lines" integer DEFAULT 0 NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_commit_model_attributions_tenant_commit_model_key" UNIQUE("tenant_id","commit_id","model_key")
);
--> statement-breakpoint
CREATE TABLE "ai_model_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"session_id" uuid,
	"commit_id" uuid,
	"pull_request_id" uuid,
	"tool" text NOT NULL,
	"model" text,
	"model_key" text NOT NULL,
	"stage" text NOT NULL,
	"line_count" integer NOT NULL,
	"actor_kind" text,
	"actor_model_key" text,
	"evidence_type" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_lifecycle_events_tenant_stage_evidence_key" UNIQUE("tenant_id","stage","evidence_ref")
);
--> statement-breakpoint
ALTER TABLE "ai_commit_model_attributions" ADD CONSTRAINT "ai_commit_model_attributions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_commit_model_attributions" ADD CONSTRAINT "ai_commit_model_attributions_commit_id_scm_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_commit_model_attributions" ADD CONSTRAINT "ai_commit_model_attributions_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_lifecycle_events" ADD CONSTRAINT "ai_model_lifecycle_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_lifecycle_events" ADD CONSTRAINT "ai_model_lifecycle_events_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_lifecycle_events" ADD CONSTRAINT "ai_model_lifecycle_events_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_lifecycle_events" ADD CONSTRAINT "ai_model_lifecycle_events_commit_id_scm_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."scm_commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_lifecycle_events" ADD CONSTRAINT "ai_model_lifecycle_events_pull_request_id_scm_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."scm_pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_commit_model_attributions_tenant_model_idx" ON "ai_commit_model_attributions" USING btree ("tenant_id","model_key");--> statement-breakpoint
CREATE INDEX "ai_model_lifecycle_events_tenant_model_idx" ON "ai_model_lifecycle_events" USING btree ("tenant_id","model_key","occurred_at");

-- Model attribution is normalized server-side evidence. Browser clients read
-- it only through the protected tenant-scoped Express APIs.
ALTER TABLE "ai_commit_model_attributions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_model_lifecycle_events" ENABLE ROW LEVEL SECURITY;
