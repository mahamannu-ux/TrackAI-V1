CREATE TABLE "security_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"bundle_digest" text NOT NULL,
	"result" text NOT NULL,
	"refusal_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_acknowledgements_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_acknowledgements_result_check" CHECK (
    "security_acknowledgements"."bundle_digest" ~ '^[a-f0-9]{64}$'
    and (("security_acknowledgements"."result" = 'applied' and "security_acknowledgements"."refusal_code" is null)
      or ("security_acknowledgements"."result" = 'refused' and "security_acknowledgements"."refusal_code" in (
        'SIGNATURE_REJECTED', 'VERIFICATION_UNAVAILABLE', 'LEASE_EXPIRED', 'MACHINE_MISMATCH',
        'TENANT_MISMATCH', 'EPOCH_REGRESSION', 'BUNDLE_DIGEST_MISMATCH', 'RULES_CHECK_FAILED',
        'UNSUPPORTED_SCHEMA')))
  )
);
--> statement-breakpoint
CREATE TABLE "security_activation_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"data_settings_version" integer NOT NULL,
	"envelope" "bytea" NOT NULL,
	"keyid" text NOT NULL,
	CONSTRAINT "security_activation_leases_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_activation_leases_tenant_machine_id_key" UNIQUE("tenant_id","machine_id","id"),
	CONSTRAINT "security_activation_leases_bounded_check" CHECK (
    "security_activation_leases"."expires_at" > "security_activation_leases"."issued_at"
    and "security_activation_leases"."mode" in ('off', 'monitor', 'monitor_and_pilot_block')
    and "security_activation_leases"."data_settings_version" >= 0
    and "security_activation_leases"."keyid" ~ '^sha256:[a-f0-9]{64}$'
    and octet_length("security_activation_leases"."envelope") between 1 and 65536
  )
);
--> statement-breakpoint
CREATE TABLE "security_data_settings_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"command_previews" boolean NOT NULL,
	"file_paths" boolean NOT NULL,
	"urls" boolean NOT NULL,
	"host_identity" boolean NOT NULL,
	"user_identity" boolean NOT NULL,
	"agents" text[] NOT NULL,
	"day_one_scan" boolean NOT NULL,
	"monitor_mode" text NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_data_settings_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_data_settings_versions_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "security_data_settings_versions_bounded_check" CHECK (
    "security_data_settings_versions"."version" >= 1
    and array_length("security_data_settings_versions"."agents", 1) between 1 and 5
    and "security_data_settings_versions"."agents" <@ array['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot']::text[]
    and "security_data_settings_versions"."monitor_mode" in ('off', 'monitor')
    and length("security_data_settings_versions"."created_by") between 1 and 255
    and length("security_data_settings_versions"."reason") between 1 and 1000
  )
);
--> statement-breakpoint
CREATE TABLE "security_rule_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bundle_version" integer NOT NULL,
	"epoch" integer NOT NULL,
	"rule_settings_version" integer NOT NULL,
	"digest" text NOT NULL,
	"envelope" "bytea" NOT NULL,
	"keyid" text NOT NULL,
	"compiler_version" text NOT NULL,
	"numbat_pin" text NOT NULL,
	"enabled_rule_count" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "security_rule_bundles_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_rule_bundles_tenant_epoch_key" UNIQUE("tenant_id","epoch"),
	CONSTRAINT "security_rule_bundles_tenant_digest_key" UNIQUE("tenant_id","digest"),
	CONSTRAINT "security_rule_bundles_bounded_check" CHECK (
    "security_rule_bundles"."bundle_version" >= 1
    and "security_rule_bundles"."epoch" >= 1
    and "security_rule_bundles"."rule_settings_version" >= 1
    and "security_rule_bundles"."bundle_version" = "security_rule_bundles"."rule_settings_version"
    and "security_rule_bundles"."enabled_rule_count" between 0 and 1024
    and "security_rule_bundles"."digest" ~ '^[a-f0-9]{64}$'
    and "security_rule_bundles"."keyid" ~ '^sha256:[a-f0-9]{64}$'
    and "security_rule_bundles"."numbat_pin" = '20a5a52'
    and length("security_rule_bundles"."compiler_version") between 1 and 64
    and octet_length("security_rule_bundles"."envelope") between 1 and 6291456
    and length("security_rule_bundles"."created_by") between 1 and 255
  )
);
--> statement-breakpoint
CREATE TABLE "security_rule_settings_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"numbat_pin" text NOT NULL,
	"created_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_rule_settings_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_rule_settings_versions_tenant_version_key" UNIQUE("tenant_id","version"),
	CONSTRAINT "security_rule_settings_versions_bounded_check" CHECK (
    "security_rule_settings_versions"."version" >= 1
    and "security_rule_settings_versions"."numbat_pin" = '20a5a52'
    and jsonb_typeof("security_rule_settings_versions"."rules") = 'object'
    and octet_length("security_rule_settings_versions"."rules"::text) <= 65536
    and length("security_rule_settings_versions"."created_by") between 1 and 255
    and length("security_rule_settings_versions"."reason") between 1 and 1000
  )
);
--> statement-breakpoint
ALTER TABLE "fleet_configurations" DROP CONSTRAINT "fleet_configurations_schema_version_check";--> statement-breakpoint
ALTER TABLE "fleet_configurations" DROP CONSTRAINT "fleet_configurations_release_contract_check";--> statement-breakpoint
ALTER TABLE "security_acknowledgements" ADD CONSTRAINT "security_acknowledgements_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_acknowledgements" ADD CONSTRAINT "security_acknowledgements_tenant_machine_lease_fk" FOREIGN KEY ("tenant_id","machine_id","lease_id") REFERENCES "public"."security_activation_leases"("tenant_id","machine_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_activation_leases" ADD CONSTRAINT "security_activation_leases_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_activation_leases" ADD CONSTRAINT "security_activation_leases_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_activation_leases" ADD CONSTRAINT "security_activation_leases_tenant_bundle_fk" FOREIGN KEY ("tenant_id","bundle_digest") REFERENCES "public"."security_rule_bundles"("tenant_id","digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_data_settings_versions" ADD CONSTRAINT "security_data_settings_versions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_rule_bundles" ADD CONSTRAINT "security_rule_bundles_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_rule_bundles" ADD CONSTRAINT "security_rule_bundles_tenant_rule_settings_fk" FOREIGN KEY ("tenant_id","rule_settings_version") REFERENCES "public"."security_rule_settings_versions"("tenant_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_rule_settings_versions" ADD CONSTRAINT "security_rule_settings_versions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_acknowledgements_tenant_lease_idx" ON "security_acknowledgements" USING btree ("tenant_id","lease_id");--> statement-breakpoint
CREATE INDEX "security_activation_leases_tenant_machine_issued_idx" ON "security_activation_leases" USING btree ("tenant_id","machine_id","issued_at");--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_schema_version_check" CHECK ("fleet_configurations"."schema_version" in (1, 2, 3));--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_release_contract_check" CHECK (
    ("fleet_configurations"."schema_version" = 1
      and "fleet_configurations"."client_minimum_version" is null
      and "fleet_configurations"."client_maximum_version" is null
      and "fleet_configurations"."release_tag" is null
      and "fleet_configurations"."manifest_url" is null
      and "fleet_configurations"."manifest_sha256" is null)
    or ("fleet_configurations"."schema_version" in (2, 3)
      and "fleet_configurations"."client_minimum_version" is not null
      and "fleet_configurations"."client_maximum_version" is not null
      and "fleet_configurations"."release_tag" is not null
      and "fleet_configurations"."manifest_url" is not null
      and "fleet_configurations"."manifest_sha256" is not null)
  );--> statement-breakpoint
-- Task20f: append-only history. Settings versions, bundles, leases and acknowledgements
-- are provenance (a finding names the lease it ran under), so no row is ever changed or
-- removed. SECURITY DEFINER with a fixed search_path (AGENTS.md §9 item 21).
CREATE OR REPLACE FUNCTION security_settings_reject_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'security settings history: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'ATG01';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_rule_settings_versions_append_only
  BEFORE UPDATE OR DELETE ON "security_rule_settings_versions"
  FOR EACH ROW EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_rule_settings_versions_no_truncate
  BEFORE TRUNCATE ON "security_rule_settings_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_data_settings_versions_append_only
  BEFORE UPDATE OR DELETE ON "security_data_settings_versions"
  FOR EACH ROW EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_data_settings_versions_no_truncate
  BEFORE TRUNCATE ON "security_data_settings_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_rule_bundles_append_only
  BEFORE UPDATE OR DELETE ON "security_rule_bundles"
  FOR EACH ROW EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_rule_bundles_no_truncate
  BEFORE TRUNCATE ON "security_rule_bundles"
  FOR EACH STATEMENT EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_activation_leases_append_only
  BEFORE UPDATE OR DELETE ON "security_activation_leases"
  FOR EACH ROW EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_activation_leases_no_truncate
  BEFORE TRUNCATE ON "security_activation_leases"
  FOR EACH STATEMENT EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_acknowledgements_append_only
  BEFORE UPDATE OR DELETE ON "security_acknowledgements"
  FOR EACH ROW EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_acknowledgements_no_truncate
  BEFORE TRUNCATE ON "security_acknowledgements"
  FOR EACH STATEMENT EXECUTE FUNCTION security_settings_reject_mutation();
--> statement-breakpoint
-- Task20f: RLS on the new tenant-owned tables, no browser policies (AGENTS.md §9 item 3).
ALTER TABLE "security_rule_settings_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_data_settings_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_rule_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_activation_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_acknowledgements" ENABLE ROW LEVEL SECURITY;
