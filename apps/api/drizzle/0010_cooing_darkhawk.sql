CREATE TABLE "evidence_event_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"redaction_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_event_contents_tenant_event_key" UNIQUE("tenant_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"repository_id" uuid,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"trace_id" text,
	"model" text,
	"tool_name" text,
	"evidence_state" text DEFAULT 'observed' NOT NULL,
	"availability" text DEFAULT 'available' NOT NULL,
	"source_version" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha256" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_events_tenant_provider_event_key" UNIQUE("tenant_id","provider","provider_event_id"),
	CONSTRAINT "evidence_events_state_check" CHECK ("evidence_events"."evidence_state" in ('observed', 'inferred', 'corrected')),
	CONSTRAINT "evidence_events_availability_check" CHECK ("evidence_events"."availability" in ('available', 'unavailable', 'redacted', 'expired')),
	CONSTRAINT "evidence_events_type_check" CHECK ("evidence_events"."event_type" in
    ('prompt', 'reasoning', 'response', 'tool_call', 'tool_result'))
);
--> statement-breakpoint
CREATE TABLE "evidence_intentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid,
	"source_event_id" uuid,
	"encrypted_value" jsonb NOT NULL,
	"evidence_state" text NOT NULL,
	"confidence" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_intentions_state_check" CHECK ("evidence_intentions"."evidence_state" in ('observed', 'inferred', 'corrected')),
	CONSTRAINT "evidence_intentions_confidence_check" CHECK ("evidence_intentions"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"relationship" text NOT NULL,
	"evidence_state" text NOT NULL,
	"confidence" integer NOT NULL,
	"basis" text NOT NULL,
	"corrected_from_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_links_tenant_edge_key" UNIQUE("tenant_id","from_type","from_id","to_type","to_id","relationship"),
	CONSTRAINT "evidence_links_state_check" CHECK ("evidence_links"."evidence_state" in ('observed', 'inferred', 'corrected')),
	CONSTRAINT "evidence_links_confidence_check" CHECK ("evidence_links"."confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "evidence_semantic_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intention_id" uuid NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"model" text DEFAULT 'trackai-token-set-v1' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_semantic_documents_tenant_intention_key" UNIQUE("tenant_id","intention_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"root_type" text NOT NULL,
	"root_id" text NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"source_fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_summaries_tenant_root_fingerprint_key" UNIQUE("tenant_id","root_type","root_id","source_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "tenant_evidence_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"raw_collection_enabled" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'opencode' NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"consented_by" text,
	"consented_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_evidence_settings_tenant_provider_key" UNIQUE("tenant_id","provider"),
	CONSTRAINT "tenant_evidence_settings_retention_check" CHECK ("tenant_evidence_settings"."retention_days" = 30),
	CONSTRAINT "tenant_evidence_settings_provider_check" CHECK ("tenant_evidence_settings"."provider" = 'opencode')
);
--> statement-breakpoint
ALTER TABLE "evidence_event_contents" ADD CONSTRAINT "evidence_event_contents_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_event_contents" ADD CONSTRAINT "evidence_event_contents_event_id_evidence_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."evidence_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_events" ADD CONSTRAINT "evidence_events_repository_id_scm_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."scm_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_source_event_id_evidence_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."evidence_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_semantic_documents" ADD CONSTRAINT "evidence_semantic_documents_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_semantic_documents" ADD CONSTRAINT "evidence_semantic_documents_intention_id_evidence_intentions_id_fk" FOREIGN KEY ("intention_id") REFERENCES "public"."evidence_intentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_summaries" ADD CONSTRAINT "evidence_summaries_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_evidence_settings" ADD CONSTRAINT "tenant_evidence_settings_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_event_contents_tenant_expiry_idx" ON "evidence_event_contents" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "evidence_events_tenant_session_time_idx" ON "evidence_events" USING btree ("tenant_id","session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "evidence_intentions_tenant_session_idx" ON "evidence_intentions" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "evidence_links_tenant_from_idx" ON "evidence_links" USING btree ("tenant_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX "evidence_links_tenant_to_idx" ON "evidence_links" USING btree ("tenant_id","to_type","to_id");