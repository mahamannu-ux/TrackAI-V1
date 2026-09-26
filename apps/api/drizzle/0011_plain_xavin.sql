CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "evidence_intention_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intention_id" uuid NOT NULL,
	"content_fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"model_revision" text NOT NULL,
	"model_checksum" text NOT NULL,
	"dimensions" integer DEFAULT 384 NOT NULL,
	"embedding" vector(384) NOT NULL,
	"lexical_document" tsvector NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_intention_embeddings_tenant_intention_model_key" UNIQUE("tenant_id","intention_id","model_revision"),
	CONSTRAINT "evidence_intention_embeddings_dimensions_check" CHECK ("evidence_intention_embeddings"."dimensions" = 384)
);
--> statement-breakpoint
CREATE TABLE "evidence_semantic_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"intention_id" uuid NOT NULL,
	"content_fingerprint" text NOT NULL,
	"model_revision" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"safe_error_code" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_semantic_jobs_tenant_intention_fingerprint_model_key" UNIQUE("tenant_id","intention_id","content_fingerprint","model_revision"),
	CONSTRAINT "evidence_semantic_jobs_state_check" CHECK ("evidence_semantic_jobs"."state" in ('pending', 'processing', 'completed', 'failed', 'skipped')),
	CONSTRAINT "evidence_semantic_jobs_attempt_check" CHECK ("evidence_semantic_jobs"."attempt_count" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "lifecycle" text DEFAULT 'provisional' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "supersedes_intention_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD COLUMN "semantic_availability" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE "evidence_intentions"
SET "series_id" = "id",
	"content_fingerprint" = 'legacy:' || "id"::text,
	"semantic_availability" = 'unavailable';
--> statement-breakpoint
ALTER TABLE "evidence_intentions" ALTER COLUMN "series_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ALTER COLUMN "content_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_intention_embeddings" ADD CONSTRAINT "evidence_intention_embeddings_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_intention_embeddings" ADD CONSTRAINT "evidence_intention_embeddings_intention_id_evidence_intentions_id_fk" FOREIGN KEY ("intention_id") REFERENCES "public"."evidence_intentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_semantic_jobs" ADD CONSTRAINT "evidence_semantic_jobs_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_semantic_jobs" ADD CONSTRAINT "evidence_semantic_jobs_intention_id_evidence_intentions_id_fk" FOREIGN KEY ("intention_id") REFERENCES "public"."evidence_intentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_intention_embeddings_tenant_expiry_idx" ON "evidence_intention_embeddings" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "evidence_intention_embeddings_lexical_idx" ON "evidence_intention_embeddings" USING gin ("lexical_document");--> statement-breakpoint
CREATE INDEX "evidence_semantic_jobs_tenant_state_available_idx" ON "evidence_semantic_jobs" USING btree ("tenant_id","state","available_at");--> statement-breakpoint
CREATE INDEX "evidence_intentions_tenant_current_series_idx" ON "evidence_intentions" USING btree ("tenant_id","series_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_intentions_tenant_one_current_series_key"
	ON "evidence_intentions" ("tenant_id", "series_id") WHERE "is_current";--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_supersedes_tenant_fk"
	FOREIGN KEY ("tenant_id", "supersedes_intention_id")
	REFERENCES "evidence_intentions"("tenant_id", "id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_tenant_series_version_key" UNIQUE("tenant_id","series_id","version");--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_version_check" CHECK ("evidence_intentions"."version" >= 1);--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_lifecycle_check" CHECK ("evidence_intentions"."lifecycle" in ('provisional', 'finalized', 'abandoned'));--> statement-breakpoint
ALTER TABLE "evidence_intentions" ADD CONSTRAINT "evidence_intentions_semantic_availability_check" CHECK ("evidence_intentions"."semantic_availability" in ('pending', 'available', 'unavailable', 'expired'));--> statement-breakpoint

-- Task5 evidence is reachable only through authenticated server APIs. Browser
-- roles receive no direct policies. Service credentials retain the portable
-- application boundary while RLS provides deny-by-default defense in depth.
ALTER TABLE "tenant_evidence_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_event_contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_intentions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_semantic_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_intention_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_semantic_jobs" ENABLE ROW LEVEL SECURITY;
