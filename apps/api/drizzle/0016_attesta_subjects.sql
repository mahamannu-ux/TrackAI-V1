CREATE TABLE "attesta_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"metric_event_id" uuid,
	"commit_id" uuid,
	"commit_sha" text NOT NULL,
	"provider" text,
	"provider_delivery_id" text,
	"pull_request_id" uuid,
	"deployment_id" uuid,
	"deployment_external_id" text,
	"deployment_status" text,
	"event_at" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error_code" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "attesta_subjects_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_subjects_kind_check" CHECK ("attesta_subjects"."kind" in ('commit_observed', 'pr_merged', 'deployed')),
	CONSTRAINT "attesta_subjects_kind_shape_check" CHECK (
    ("attesta_subjects"."kind" = 'commit_observed'
      and "attesta_subjects"."metric_event_id" is not null and "attesta_subjects"."commit_id" is not null
      and "attesta_subjects"."provider" is null and "attesta_subjects"."provider_delivery_id" is null
      and "attesta_subjects"."pull_request_id" is null and "attesta_subjects"."deployment_id" is null
      and "attesta_subjects"."deployment_external_id" is null and "attesta_subjects"."deployment_status" is null)
    or ("attesta_subjects"."kind" = 'pr_merged'
      and "attesta_subjects"."provider" is not null and "attesta_subjects"."provider_delivery_id" is not null
      and "attesta_subjects"."pull_request_id" is not null
      and "attesta_subjects"."metric_event_id" is null and "attesta_subjects"."commit_id" is null
      and "attesta_subjects"."deployment_id" is null and "attesta_subjects"."deployment_external_id" is null
      and "attesta_subjects"."deployment_status" is null)
    or ("attesta_subjects"."kind" = 'deployed'
      and "attesta_subjects"."provider" is not null and "attesta_subjects"."deployment_id" is not null
      and "attesta_subjects"."deployment_external_id" is not null and "attesta_subjects"."deployment_status" = 'success'
      and "attesta_subjects"."metric_event_id" is null and "attesta_subjects"."commit_id" is null
      and "attesta_subjects"."pull_request_id" is null)
  ),
	CONSTRAINT "attesta_subjects_bounds_check" CHECK (
    "attesta_subjects"."commit_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    and ("attesta_subjects"."provider" is null or "attesta_subjects"."provider" ~ '^[a-z][a-z0-9_-]{0,31}$')
    and ("attesta_subjects"."provider_delivery_id" is null or length("attesta_subjects"."provider_delivery_id") between 1 and 128)
    and ("attesta_subjects"."deployment_external_id" is null or length("attesta_subjects"."deployment_external_id") between 1 and 128)
  ),
	CONSTRAINT "attesta_subjects_status_check" CHECK (
    "attesta_subjects"."status" in ('pending', 'claimed', 'done', 'failed')
    and "attesta_subjects"."attempts" >= 0
    and ("attesta_subjects"."status" <> 'claimed' or "attesta_subjects"."claimed_at" is not null)
    and ("attesta_subjects"."status" not in ('done', 'failed') or "attesta_subjects"."processed_at" is not null)
    and ("attesta_subjects"."status" <> 'pending' or "attesta_subjects"."processed_at" is null)
    and ("attesta_subjects"."last_error_code" is null or "attesta_subjects"."last_error_code" ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_subjects" ADD CONSTRAINT "attesta_subjects_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_subjects" ADD CONSTRAINT "attesta_subjects_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_subjects_commit_observed_key" ON "attesta_subjects" USING btree ("tenant_id","kind","metric_event_id") WHERE "attesta_subjects"."kind" = 'commit_observed';--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_subjects_pr_merged_key" ON "attesta_subjects" USING btree ("tenant_id","kind","provider","provider_delivery_id") WHERE "attesta_subjects"."kind" = 'pr_merged';--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_subjects_deployed_key" ON "attesta_subjects" USING btree ("tenant_id","kind","provider","deployment_external_id","deployment_status") WHERE "attesta_subjects"."kind" = 'deployed';--> statement-breakpoint
CREATE INDEX "attesta_subjects_status_not_before_idx" ON "attesta_subjects" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "attesta_subjects_tenant_kind_created_idx" ON "attesta_subjects" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "attesta_subjects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the worker fields may change after insert: the pointer a replay is
-- compared against (outbox.md) must stay exactly what Task2 wrote.
CREATE OR REPLACE FUNCTION attesta_subjects_identity_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.repository_id, NEW.kind, NEW.metric_event_id, NEW.commit_id,
      NEW.commit_sha, NEW.provider, NEW.provider_delivery_id, NEW.pull_request_id,
      NEW.deployment_id, NEW.deployment_external_id, NEW.deployment_status, NEW.event_at,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.repository_id, OLD.kind, OLD.metric_event_id, OLD.commit_id,
      OLD.commit_sha, OLD.provider, OLD.provider_delivery_id, OLD.pull_request_id,
      OLD.deployment_id, OLD.deployment_external_id, OLD.deployment_status, OLD.event_at,
      OLD.created_at) THEN
    RAISE EXCEPTION 'attesta_subjects: identity columns are immutable (row %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_subjects_identity_guard
  BEFORE UPDATE ON "attesta_subjects"
  FOR EACH ROW EXECUTE FUNCTION attesta_subjects_identity_guard();
