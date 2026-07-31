CREATE TABLE "repository_backfill_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"evidence_family" text NOT NULL,
	"occurred_from" timestamp with time zone NOT NULL,
	"occurred_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"authorized_by" text NOT NULL,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_backfill_authorizations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "repository_backfill_authorizations_family_check" CHECK ("repository_backfill_authorizations"."evidence_family" in ('generation_session', 'commit_note')),
	CONSTRAINT "repository_backfill_authorizations_status_check" CHECK ("repository_backfill_authorizations"."status" in ('active', 'revoked')),
	CONSTRAINT "repository_backfill_authorizations_interval_check" CHECK ("repository_backfill_authorizations"."occurred_until" >= "repository_backfill_authorizations"."occurred_from")
);
--> statement-breakpoint
ALTER TABLE "repository_enrollments" ADD COLUMN "generation_session_evidence_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_enrollments" ADD COLUMN "commit_note_evidence_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD COLUMN "evidence_family" text DEFAULT 'legacy_unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD COLUMN "arrival_class" text DEFAULT 'legacy_unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD COLUMN "backfill_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "repository_backfill_authorizations" ADD CONSTRAINT "repository_backfill_authorizations_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_backfill_authorizations" ADD CONSTRAINT "repository_backfill_authorizations_tenant_enrollment_fk" FOREIGN KEY ("tenant_id","enrollment_id") REFERENCES "public"."repository_enrollments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_backfill_authorizations_tenant_enrollment_status_idx" ON "repository_backfill_authorizations" USING btree ("tenant_id","enrollment_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD CONSTRAINT "telemetry_metric_events_tenant_enrollment_fk" FOREIGN KEY ("tenant_id","enrollment_id") REFERENCES "public"."repository_enrollments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD CONSTRAINT "telemetry_metric_events_tenant_backfill_authorization_fk" FOREIGN KEY ("tenant_id","backfill_authorization_id") REFERENCES "public"."repository_backfill_authorizations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD CONSTRAINT "telemetry_metric_events_evidence_family_check" CHECK ("telemetry_metric_events"."evidence_family" in (
      'generation_session', 'commit_note', 'operational', 'legacy_unclassified'
    ));--> statement-breakpoint
ALTER TABLE "telemetry_metric_events" ADD CONSTRAINT "telemetry_metric_events_arrival_class_check" CHECK ("telemetry_metric_events"."arrival_class" in (
      'current', 'delayed', 'backfill', 'legacy_unclassified'
    ));--> statement-breakpoint

ALTER TABLE "repository_backfill_authorizations"
  ADD CONSTRAINT "repository_backfill_authorizations_bounded_window_check"
  CHECK ("occurred_until" - "occurred_from" <= interval '31 days'),
  ADD CONSTRAINT "repository_backfill_authorizations_expiry_check"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "repository_backfill_authorizations_reason_check"
  CHECK (length(btrim("reason")) > 0);

-- Backfill approvals are server-only tenant policy. Browser roles receive no
-- direct policies; protected tenant-admin APIs are the access boundary.
ALTER TABLE "repository_backfill_authorizations" ENABLE ROW LEVEL SECURITY;

-- Authorization scope is immutable. Revocation may advance only the status
-- and revoked_at overlay; a changed scope requires a new audited approval.
CREATE FUNCTION "prevent_repository_backfill_authorization_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'repository_backfill_authorizations are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."enrollment_id", OLD."evidence_family",
		OLD."occurred_from", OLD."occurred_until", OLD."expires_at",
		OLD."authorized_by", OLD."reason", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."enrollment_id", NEW."evidence_family",
		NEW."occurred_from", NEW."occurred_until", NEW."expires_at",
		NEW."authorized_by", NEW."reason", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'repository_backfill_authorization scope is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "repository_backfill_authorizations_evidence_immutable"
BEFORE UPDATE OR DELETE ON "repository_backfill_authorizations"
FOR EACH ROW EXECUTE FUNCTION "prevent_repository_backfill_authorization_evidence_mutation"();

-- Raw telemetry and its enrollment-time classification are immutable.
-- Normalization status/error remain operational fields and may advance.
CREATE FUNCTION "prevent_telemetry_metric_event_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'telemetry_metric_events evidence is immutable';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."batch_id", OLD."event_index", OLD."event_fingerprint",
		OLD."event_kind", OLD."event_timestamp", OLD."raw_event", OLD."enrollment_id",
		OLD."evidence_family", OLD."arrival_class", OLD."backfill_authorization_id",
		OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."batch_id", NEW."event_index", NEW."event_fingerprint",
		NEW."event_kind", NEW."event_timestamp", NEW."raw_event", NEW."enrollment_id",
		NEW."evidence_family", NEW."arrival_class", NEW."backfill_authorization_id",
		NEW."created_at"
	) THEN
		RAISE EXCEPTION 'telemetry_metric_events evidence is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "telemetry_metric_events_evidence_immutable"
BEFORE UPDATE OR DELETE ON "telemetry_metric_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_telemetry_metric_event_evidence_mutation"();
