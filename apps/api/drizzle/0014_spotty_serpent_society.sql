CREATE TABLE "fleet_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" text NOT NULL,
	"valid_until" timestamp with time zone,
	"target_client_version" text NOT NULL,
	"channel" text NOT NULL,
	"ring" text,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "fleet_configurations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fleet_configurations_tenant_epoch_key" UNIQUE("tenant_id","epoch"),
	CONSTRAINT "fleet_configurations_epoch_check" CHECK ("fleet_configurations"."epoch" >= 1),
	CONSTRAINT "fleet_configurations_schema_version_check" CHECK ("fleet_configurations"."schema_version" = 1),
	CONSTRAINT "fleet_configurations_channel_check" CHECK (
    "fleet_configurations"."channel" in ('latest', 'next', 'enterprise-latest', 'enterprise-next')
  ),
	CONSTRAINT "fleet_configurations_bounded_metadata_check" CHECK (
    length("fleet_configurations"."generated_by") between 1 and 255
    and length("fleet_configurations"."target_client_version") between 1 and 64
    and ("fleet_configurations"."ring" is null or length("fleet_configurations"."ring") between 1 and 64)
    and ("fleet_configurations"."valid_until" is null or "fleet_configurations"."valid_until" > "fleet_configurations"."generated_at")
    and jsonb_typeof("fleet_configurations"."snapshot") = 'object'
    and octet_length("fleet_configurations"."snapshot"::text) <= 65536
  )
);
--> statement-breakpoint
CREATE TABLE "fleet_machine_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"desired_configuration_id" uuid,
	"acknowledged_configuration_id" uuid,
	"acknowledged_epoch" integer,
	"acknowledgement_result" text,
	"platform" text,
	"os_version" text,
	"architecture" text,
	"gitai_version" text,
	"service_state" text,
	"pending_retryable" integer,
	"waiting_retry" integer,
	"processing" integer,
	"quarantined" integer,
	"rows_with_errors" integer,
	"mdm_device_reference" text,
	"mdm_user_reference" text,
	"assignment_source" text,
	"assignment_observed_at" timestamp with time zone,
	"last_report_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_machine_states_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "fleet_machine_states_tenant_machine_key" UNIQUE("tenant_id","machine_id"),
	CONSTRAINT "fleet_machine_states_acknowledgement_check" CHECK (
    ("fleet_machine_states"."acknowledged_configuration_id" is null
      and "fleet_machine_states"."acknowledged_epoch" is null
      and "fleet_machine_states"."acknowledgement_result" is null)
    or ("fleet_machine_states"."acknowledged_configuration_id" is not null
      and "fleet_machine_states"."acknowledged_epoch" >= 1
      and "fleet_machine_states"."acknowledgement_result" in (
        'applied', 'rejected_invalid', 'rejected_expired', 'rejected_incompatible',
        'verification_unavailable', 'verification_rejected', 'activation_failed', 'unavailable'
      ))
  ),
	CONSTRAINT "fleet_machine_states_posture_check" CHECK (
    ("fleet_machine_states"."platform" is null or "fleet_machine_states"."platform" in ('macos', 'windows'))
    and ("fleet_machine_states"."architecture" is null or "fleet_machine_states"."architecture" in ('x86_64', 'aarch64'))
    and ("fleet_machine_states"."service_state" is null or "fleet_machine_states"."service_state" in ('running', 'stopped', 'degraded', 'unavailable'))
    and ("fleet_machine_states"."assignment_source" is null or "fleet_machine_states"."assignment_source" in ('jamf', 'intune', 'manual', 'unavailable'))
  ),
	CONSTRAINT "fleet_machine_states_count_check" CHECK (
    ("fleet_machine_states"."pending_retryable" is null or "fleet_machine_states"."pending_retryable" between 0 and 1000000)
    and ("fleet_machine_states"."waiting_retry" is null or "fleet_machine_states"."waiting_retry" between 0 and 1000000)
    and ("fleet_machine_states"."processing" is null or "fleet_machine_states"."processing" between 0 and 1000000)
    and ("fleet_machine_states"."quarantined" is null or "fleet_machine_states"."quarantined" between 0 and 1000000)
    and ("fleet_machine_states"."rows_with_errors" is null or "fleet_machine_states"."rows_with_errors" between 0 and 1000000)
  ),
	CONSTRAINT "fleet_machine_states_bounded_metadata_check" CHECK (
    ("fleet_machine_states"."os_version" is null or length("fleet_machine_states"."os_version") between 1 and 128)
    and ("fleet_machine_states"."gitai_version" is null or length("fleet_machine_states"."gitai_version") between 1 and 64)
    and ("fleet_machine_states"."mdm_device_reference" is null or length("fleet_machine_states"."mdm_device_reference") between 1 and 255)
    and ("fleet_machine_states"."mdm_user_reference" is null or length("fleet_machine_states"."mdm_user_reference") between 1 and 255)
  ),
	CONSTRAINT "fleet_machine_states_assignment_evidence_check" CHECK (
    ("fleet_machine_states"."assignment_source" is null and "fleet_machine_states"."assignment_observed_at" is null)
    or ("fleet_machine_states"."assignment_source" is not null and "fleet_machine_states"."assignment_observed_at" is not null)
  )
);
--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_machine_states" ADD CONSTRAINT "fleet_machine_states_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_machine_states" ADD CONSTRAINT "fleet_machine_states_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_machine_states" ADD CONSTRAINT "fleet_machine_states_tenant_desired_configuration_fk" FOREIGN KEY ("tenant_id","desired_configuration_id") REFERENCES "public"."fleet_configurations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_machine_states" ADD CONSTRAINT "fleet_machine_states_tenant_acknowledged_configuration_fk" FOREIGN KEY ("tenant_id","acknowledged_configuration_id") REFERENCES "public"."fleet_configurations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fleet_configurations_tenant_generated_idx" ON "fleet_configurations" USING btree ("tenant_id","generated_at");--> statement-breakpoint
CREATE INDEX "fleet_machine_states_tenant_desired_idx" ON "fleet_machine_states" USING btree ("tenant_id","desired_configuration_id");--> statement-breakpoint
CREATE INDEX "fleet_machine_states_tenant_report_idx" ON "fleet_machine_states" USING btree ("tenant_id","last_report_at");
--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_snapshot_shape_check" CHECK (
  "snapshot" ? 'repositoryPolicies'
  and "snapshot" ? 'securityActivation'
  and "snapshot" - ARRAY['repositoryPolicies', 'securityActivation']::text[] = '{}'::jsonb
  and jsonb_typeof("snapshot"->'repositoryPolicies') = 'array'
  and jsonb_array_length("snapshot"->'repositoryPolicies') <= 1000
  and jsonb_typeof("snapshot"->'securityActivation') = 'object'
  and ("snapshot"->'securityActivation') ? 'mode'
  and ("snapshot"->'securityActivation') ? 'version'
  and ("snapshot"->'securityActivation') - ARRAY['mode', 'version']::text[] = '{}'::jsonb
  and "snapshot"#>>'{securityActivation,mode}' in ('off', 'monitor')
  and jsonb_typeof("snapshot"#>'{securityActivation,version}') = 'number'
);
--> statement-breakpoint
ALTER TABLE "fleet_configurations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fleet_machine_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_fleet_configuration_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fleet configurations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fleet_configurations_immutable
BEFORE UPDATE OR DELETE ON "fleet_configurations"
FOR EACH ROW EXECUTE FUNCTION reject_fleet_configuration_mutation();
