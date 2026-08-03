CREATE TABLE "evidence_archive_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"export_job_id" uuid NOT NULL,
	"evidence_family" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_archive_entries_export_evidence_key" UNIQUE("tenant_id","export_job_id","evidence_family","evidence_id"),
	CONSTRAINT "evidence_archive_entries_family_check" CHECK (
    "evidence_archive_entries"."evidence_family" in ('telemetry_metric_evidence', 'provider_delivery_evidence')
  ),
	CONSTRAINT "evidence_archive_entries_digest_check" CHECK ("evidence_archive_entries"."content_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evidence_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"archive_purpose" boolean DEFAULT false NOT NULL,
	"scope_from" timestamp with time zone,
	"scope_until" timestamp with time zone,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"record_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha256" text,
	"storage_reference" text,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_export_jobs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "evidence_export_jobs_status_check" CHECK (
    "evidence_export_jobs"."status" in ('planned', 'running', 'completed', 'failed')
  ),
	CONSTRAINT "evidence_export_jobs_scope_check" CHECK (
    ("evidence_export_jobs"."scope_from" is null and "evidence_export_jobs"."scope_until" is null)
    or ("evidence_export_jobs"."scope_from" is not null and "evidence_export_jobs"."scope_until" is not null
      and "evidence_export_jobs"."scope_until" > "evidence_export_jobs"."scope_from")
  ),
	CONSTRAINT "evidence_export_jobs_digest_check" CHECK (
    "evidence_export_jobs"."content_sha256" is null or "evidence_export_jobs"."content_sha256" ~ '^[a-f0-9]{64}$'
  ),
	CONSTRAINT "evidence_export_jobs_lifecycle_check" CHECK (
    ("evidence_export_jobs"."status" = 'planned' and "evidence_export_jobs"."started_at" is null and "evidence_export_jobs"."completed_at" is null)
    or ("evidence_export_jobs"."status" = 'running' and "evidence_export_jobs"."started_at" is not null and "evidence_export_jobs"."completed_at" is null)
    or ("evidence_export_jobs"."status" in ('completed', 'failed')
      and "evidence_export_jobs"."started_at" is not null and "evidence_export_jobs"."completed_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"archive_export_job_id" uuid,
	"mode" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"candidate_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"purged_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"failure_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_runs_mode_check" CHECK ("retention_runs"."mode" in ('dry_run', 'apply')),
	CONSTRAINT "retention_runs_status_check" CHECK (
    "retention_runs"."status" in ('planned', 'blocked', 'completed', 'failed')
  ),
	CONSTRAINT "retention_runs_apply_archive_check" CHECK (
    "retention_runs"."mode" = 'dry_run' or "retention_runs"."archive_export_job_id" is not null
  ),
	CONSTRAINT "retention_runs_completion_check" CHECK (
    ("retention_runs"."status" = 'planned' and "retention_runs"."completed_at" is null)
    or ("retention_runs"."status" in ('blocked', 'completed', 'failed') and "retention_runs"."completed_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "tenant_retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"retention_days" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_retention_policies_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_retention_policies_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "tenant_retention_policies_mode_check" CHECK ("tenant_retention_policies"."mode" in ('retain', 'archive_then_purge')),
	CONSTRAINT "tenant_retention_policies_status_check" CHECK ("tenant_retention_policies"."status" in ('active', 'superseded')),
	CONSTRAINT "tenant_retention_policies_configuration_check" CHECK (
    ("tenant_retention_policies"."mode" = 'retain' and "tenant_retention_policies"."retention_days" is null)
    or ("tenant_retention_policies"."mode" = 'archive_then_purge' and "tenant_retention_policies"."retention_days" between 1 and 3650)
  ),
	CONSTRAINT "tenant_retention_policies_lifecycle_check" CHECK (
    ("tenant_retention_policies"."status" = 'active' and "tenant_retention_policies"."superseded_at" is null)
    or ("tenant_retention_policies"."status" = 'superseded' and "tenant_retention_policies"."superseded_at" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "evidence_archive_entries" ADD CONSTRAINT "evidence_archive_entries_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_archive_entries" ADD CONSTRAINT "evidence_archive_entries_tenant_export_fk" FOREIGN KEY ("tenant_id","export_job_id") REFERENCES "public"."evidence_export_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_export_jobs" ADD CONSTRAINT "evidence_export_jobs_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_tenant_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."tenant_retention_policies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_tenant_archive_fk" FOREIGN KEY ("tenant_id","archive_export_job_id") REFERENCES "public"."evidence_export_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_retention_policies" ADD CONSTRAINT "tenant_retention_policies_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_archive_entries_tenant_evidence_idx" ON "evidence_archive_entries" USING btree ("tenant_id","evidence_family","evidence_id");--> statement-breakpoint
CREATE INDEX "evidence_export_jobs_tenant_status_created_idx" ON "evidence_export_jobs" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "retention_runs_tenant_status_created_idx" ON "retention_runs" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_retention_policies_one_active_idx" ON "tenant_retention_policies" USING btree ("tenant_id") WHERE "tenant_retention_policies"."status" = 'active';
--> statement-breakpoint

ALTER TABLE "tenant_retention_policies"
	ADD CONSTRAINT "tenant_retention_policies_version_check"
	CHECK ("version" > 0),
	ADD CONSTRAINT "tenant_retention_policies_actor_reason_check"
	CHECK (length(btrim("created_by")) > 0 AND length(btrim("reason")) > 0);

ALTER TABLE "evidence_export_jobs"
	ADD CONSTRAINT "evidence_export_jobs_format_check"
	CHECK ("format" = 'trackai-evidence-export/v1'),
	ADD CONSTRAINT "evidence_export_jobs_actor_reason_check"
	CHECK (length(btrim("requested_by")) > 0 AND length(btrim("reason")) > 0),
	ADD CONSTRAINT "evidence_export_jobs_counts_check"
	CHECK (jsonb_typeof("record_counts") = 'object'),
	ADD CONSTRAINT "evidence_export_jobs_result_check"
	CHECK (
		("status" IN ('planned', 'running')
			AND "content_sha256" IS NULL AND "storage_reference" IS NULL
			AND "failure_code" IS NULL)
		OR ("status" = 'completed'
			AND "content_sha256" IS NOT NULL AND length(btrim("storage_reference")) > 0
			AND "failure_code" IS NULL)
		OR ("status" = 'failed' AND length(btrim("failure_code")) > 0)
	);

ALTER TABLE "retention_runs"
	ADD CONSTRAINT "retention_runs_actor_reason_check"
	CHECK (length(btrim("requested_by")) > 0 AND length(btrim("reason")) > 0),
	ADD CONSTRAINT "retention_runs_counts_check"
	CHECK (
		jsonb_typeof("candidate_counts") = 'object'
		AND jsonb_typeof("purged_counts") = 'object'
	),
	ADD CONSTRAINT "retention_runs_result_check"
	CHECK (
		("status" IN ('planned', 'completed') AND "failure_code" IS NULL)
		OR ("status" IN ('blocked', 'failed') AND length(btrim("failure_code")) > 0)
	);

-- These tables are reachable only through protected server-side administration
-- APIs. Browser roles receive no direct policies; service credentials retain
-- the portable application-enforcement boundary used by earlier Task4 waves.
ALTER TABLE "tenant_retention_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_export_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_archive_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retention_runs" ENABLE ROW LEVEL SECURITY;

-- A policy version is immutable. Only active -> superseded may advance, and
-- the original policy row remains available for every retention-run audit.
CREATE FUNCTION "prevent_tenant_retention_policy_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'tenant_retention_policies are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."version", OLD."mode", OLD."retention_days",
		OLD."created_by", OLD."reason", OLD."effective_from", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."version", NEW."mode", NEW."retention_days",
		NEW."created_by", NEW."reason", NEW."effective_from", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'tenant_retention_policy evidence is immutable';
	END IF;
	IF OLD."status" = 'superseded' AND ROW(NEW."status", NEW."superseded_at")
		IS DISTINCT FROM ROW(OLD."status", OLD."superseded_at") THEN
		RAISE EXCEPTION 'superseded tenant_retention_policy is immutable';
	END IF;
	IF OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'superseded') THEN
		RAISE EXCEPTION 'tenant_retention_policy lifecycle cannot move backward';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_retention_policies_evidence_immutable"
BEFORE UPDATE OR DELETE ON "tenant_retention_policies"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_retention_policy_evidence_mutation"();

-- Export scope and request evidence are immutable. Result metadata may advance
-- planned -> running -> completed/failed, but terminal manifests never change.
CREATE FUNCTION "prevent_evidence_export_job_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'evidence_export_jobs are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."format", OLD."archive_purpose", OLD."scope_from",
		OLD."scope_until", OLD."requested_by", OLD."reason", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."format", NEW."archive_purpose", NEW."scope_from",
		NEW."scope_until", NEW."requested_by", NEW."reason", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'evidence_export_job scope is immutable';
	END IF;
	IF OLD."status" IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
		RAISE EXCEPTION 'terminal evidence_export_job is immutable';
	END IF;
	IF (OLD."status" = 'planned' AND NEW."status" NOT IN ('planned', 'running', 'failed'))
		OR (OLD."status" = 'running' AND NEW."status" NOT IN ('running', 'completed', 'failed')) THEN
		RAISE EXCEPTION 'evidence_export_job lifecycle cannot skip or move backward';
	END IF;
	IF OLD."started_at" IS NOT NULL AND NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
		RAISE EXCEPTION 'evidence_export_job start time is immutable';
	END IF;
	IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
		RAISE EXCEPTION 'evidence_export_job completion time is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_export_jobs_evidence_immutable"
BEFORE UPDATE OR DELETE ON "evidence_export_jobs"
FOR EACH ROW EXECUTE FUNCTION "prevent_evidence_export_job_evidence_mutation"();

-- Archive membership is append-only proof. It contains only IDs, occurrence
-- time and a digest; exported customer evidence remains outside PostgreSQL.
CREATE FUNCTION "prevent_evidence_archive_entry_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'evidence_archive_entries are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_archive_entries_append_only"
BEFORE UPDATE OR DELETE ON "evidence_archive_entries"
FOR EACH ROW EXECUTE FUNCTION "prevent_evidence_archive_entry_mutation"();

-- Retention scope is immutable and terminal results cannot be rewritten.
CREATE FUNCTION "prevent_retention_run_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'retention_runs are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."policy_id", OLD."archive_export_job_id", OLD."mode",
		OLD."cutoff_at", OLD."requested_by", OLD."reason", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."policy_id", NEW."archive_export_job_id", NEW."mode",
		NEW."cutoff_at", NEW."requested_by", NEW."reason", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'retention_run scope is immutable';
	END IF;
	IF OLD."status" <> 'planned' AND NEW IS DISTINCT FROM OLD THEN
		RAISE EXCEPTION 'terminal retention_run is immutable';
	END IF;
	IF OLD."status" = 'planned'
		AND NEW."status" NOT IN ('planned', 'blocked', 'completed', 'failed') THEN
		RAISE EXCEPTION 'retention_run lifecycle cannot move backward';
	END IF;
	IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
		RAISE EXCEPTION 'retention_run completion time is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "retention_runs_evidence_immutable"
BEFORE UPDATE OR DELETE ON "retention_runs"
FOR EACH ROW EXECUTE FUNCTION "prevent_retention_run_evidence_mutation"();
