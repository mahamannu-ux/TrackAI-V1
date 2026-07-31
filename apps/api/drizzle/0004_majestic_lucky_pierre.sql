CREATE TABLE "provider_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_fingerprint" text NOT NULL,
	"provider_occurred_at" timestamp with time zone,
	"raw_event" jsonb NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"processing_started_at" timestamp with time zone,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "provider_event_deliveries_tenant_provider_delivery_key" UNIQUE("tenant_id","provider","delivery_id"),
	CONSTRAINT "provider_event_deliveries_status_check" CHECK ("provider_event_deliveries"."processing_status" in (
    'received', 'projected', 'applied', 'duplicate', 'stale', 'conflict', 'unsequenced', 'failed'
  ))
);
--> statement-breakpoint
CREATE TABLE "provider_projection_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"projection_type" text NOT NULL,
	"projection_key" text NOT NULL,
	"last_provider_occurred_at" timestamp with time zone,
	"last_event_fingerprint" text NOT NULL,
	"last_delivery_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_projection_cursors_tenant_provider_projection_key" UNIQUE("tenant_id","provider","projection_type","projection_key")
);
--> statement-breakpoint
ALTER TABLE "provider_event_deliveries" ADD CONSTRAINT "provider_event_deliveries_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_deliveries" ADD CONSTRAINT "provider_event_deliveries_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_projection_cursors" ADD CONSTRAINT "provider_projection_cursors_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_event_deliveries_tenant_received_at_idx" ON "provider_event_deliveries" USING btree ("tenant_id","received_at");
--> statement-breakpoint
CREATE INDEX "provider_event_deliveries_tenant_provider_fingerprint_idx" ON "provider_event_deliveries" USING btree ("tenant_id","provider","event_fingerprint");

-- Provider evidence and cursors are server-only. Application services enforce
-- tenant scope; browser roles receive no direct row policies.
ALTER TABLE "provider_event_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_projection_cursors" ENABLE ROW LEVEL SECURITY;

-- Processing outcome may advance, but observed provider evidence is immutable.
CREATE FUNCTION "prevent_provider_event_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'provider_event_deliveries evidence is immutable';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."repository_id", OLD."provider", OLD."delivery_id",
		OLD."event_type", OLD."event_fingerprint", OLD."provider_occurred_at",
		OLD."raw_event", OLD."received_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."repository_id", NEW."provider", NEW."delivery_id",
		NEW."event_type", NEW."event_fingerprint", NEW."provider_occurred_at",
		NEW."raw_event", NEW."received_at"
	) THEN
		RAISE EXCEPTION 'provider_event_deliveries evidence is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "provider_event_deliveries_evidence_immutable"
BEFORE UPDATE OR DELETE ON "provider_event_deliveries"
FOR EACH ROW EXECUTE FUNCTION "prevent_provider_event_evidence_mutation"();
