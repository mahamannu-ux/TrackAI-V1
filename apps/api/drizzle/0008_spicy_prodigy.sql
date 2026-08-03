CREATE TABLE "machine_delivery_health_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_retryable" integer NOT NULL,
	"waiting_retry" integer NOT NULL,
	"processing" integer NOT NULL,
	"quarantined" integer NOT NULL,
	"rows_with_errors" integer NOT NULL,
	"oldest_pending_at" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	CONSTRAINT "machine_delivery_health_reports_tenant_machine_key" UNIQUE("tenant_id","machine_id"),
	CONSTRAINT "machine_delivery_health_reports_schema_version_check" CHECK ("machine_delivery_health_reports"."schema_version" = 1),
	CONSTRAINT "machine_delivery_health_reports_count_check" CHECK (
    "machine_delivery_health_reports"."pending_retryable" between 0 and 1000000
    and "machine_delivery_health_reports"."waiting_retry" between 0 and 1000000
    and "machine_delivery_health_reports"."processing" between 0 and 1000000
    and "machine_delivery_health_reports"."quarantined" between 0 and 1000000
    and "machine_delivery_health_reports"."rows_with_errors" between 0 and 1000000
  ),
	CONSTRAINT "machine_delivery_health_reports_timestamp_check" CHECK (
    ("machine_delivery_health_reports"."oldest_pending_at" is null or "machine_delivery_health_reports"."oldest_pending_at" <= "machine_delivery_health_reports"."observed_at")
    and ("machine_delivery_health_reports"."last_delivered_at" is null or "machine_delivery_health_reports"."last_delivered_at" <= "machine_delivery_health_reports"."observed_at")
  )
);
--> statement-breakpoint
ALTER TABLE "machine_delivery_health_reports" ADD CONSTRAINT "machine_delivery_health_reports_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_delivery_health_reports" ADD CONSTRAINT "machine_delivery_health_reports_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_delivery_health_reports_tenant_received_idx" ON "machine_delivery_health_reports" USING btree ("tenant_id","received_at");
--> statement-breakpoint
-- This mutable latest-state table is reachable only through authenticated
-- machine reporting and protected tenant operations APIs. It contains counts
-- and timestamps only; no raw event, repository content, credential or error
-- reason crosses this boundary.
ALTER TABLE "machine_delivery_health_reports" ENABLE ROW LEVEL SECURITY;
