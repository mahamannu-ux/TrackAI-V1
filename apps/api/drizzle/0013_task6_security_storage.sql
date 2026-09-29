CREATE TABLE "security_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"finding_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"session_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"correlation_id" text,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"rule_category" text NOT NULL,
	"rule_severity" text NOT NULL,
	"route_id" text NOT NULL,
	"agent_family" text NOT NULL,
	"host_surface" text NOT NULL,
	"host_mode" text NOT NULL,
	"capture_channel" text NOT NULL,
	"operating_system" text NOT NULL,
	"timing" text NOT NULL,
	"native_effect" text NOT NULL,
	"activation" text NOT NULL,
	"effect" text NOT NULL,
	"phase" text NOT NULL,
	"availability" text NOT NULL,
	"completeness" text NOT NULL,
	"result_category" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"client_version" text NOT NULL,
	"rule_pack_version" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_findings_tenant_delivery_key" UNIQUE("tenant_id","delivery_id"),
	CONSTRAINT "security_findings_tenant_finding_key" UNIQUE("tenant_id","finding_id"),
	CONSTRAINT "security_findings_rule_id_check" CHECK ("security_findings"."rule_id" in (
    'trackai.exec.destructive_recursive_delete',
    'trackai.exec.download_pipe_shell',
    'trackai.exec.reverse_shell'
  )),
	CONSTRAINT "security_findings_rule_category_check" CHECK ("security_findings"."rule_category" = 'execution'),
	CONSTRAINT "security_findings_rule_severity_check" CHECK ("security_findings"."rule_severity" in ('high', 'critical')),
	CONSTRAINT "security_findings_route_check" CHECK (
    "security_findings"."route_id" = 'AC-CLI-03'
    and "security_findings"."agent_family" = 'opencode'
    and "security_findings"."host_surface" = 'terminal'
    and "security_findings"."host_mode" = 'cli'
    and "security_findings"."capture_channel" = 'provider-plugin'
    and "security_findings"."native_effect" = 'observe_only'
  ),
	CONSTRAINT "security_findings_operating_system_check" CHECK ("security_findings"."operating_system" in ('macos', 'linux', 'windows', 'wsl', 'unavailable')),
	CONSTRAINT "security_findings_timing_check" CHECK ("security_findings"."timing" in ('pre_action', 'post_action', 'at_rest', 'unavailable')),
	CONSTRAINT "security_findings_activation_check" CHECK ("security_findings"."activation" in ('configured', 'loaded', 'observed', 'unavailable')),
	CONSTRAINT "security_findings_effect_check" CHECK ("security_findings"."effect" = 'monitor'),
	CONSTRAINT "security_findings_phase_check" CHECK ("security_findings"."phase" in ('requested', 'observed_result', 'partial', 'unavailable')),
	CONSTRAINT "security_findings_availability_check" CHECK ("security_findings"."availability" in ('available', 'unavailable', 'redacted', 'expired')),
	CONSTRAINT "security_findings_completeness_check" CHECK ("security_findings"."completeness" in ('complete', 'partial')),
	CONSTRAINT "security_findings_result_category_check" CHECK (
    "security_findings"."result_category" in (
      'not_observed', 'success', 'failure', 'cancelled', 'unknown', 'unavailable'
    )
  ),
	CONSTRAINT "security_findings_bounded_metadata_check" CHECK (
    length("security_findings"."finding_id") between 1 and 128
    and length("security_findings"."delivery_id") between 1 and 128
    and length("security_findings"."session_id") between 1 and 128
    and length("security_findings"."source_event_id") between 1 and 128
    and ("security_findings"."correlation_id" is null or length("security_findings"."correlation_id") between 1 and 128)
    and length("security_findings"."rule_version") between 1 and 32
    and length("security_findings"."client_version") between 1 and 64
    and length("security_findings"."rule_pack_version") between 1 and 64
  )
);
--> statement-breakpoint
CREATE TABLE "tenant_security_monitor_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_security_monitor_settings_tenant_key" UNIQUE("tenant_id"),
	CONSTRAINT "tenant_security_monitor_settings_mode_check" CHECK ("tenant_security_monitor_settings"."mode" in ('off', 'monitor')),
	CONSTRAINT "tenant_security_monitor_settings_version_check" CHECK ("tenant_security_monitor_settings"."version" >= 1),
	CONSTRAINT "tenant_security_monitor_settings_interval_check" CHECK (
    ("tenant_security_monitor_settings"."valid_until" is null or "tenant_security_monitor_settings"."valid_until" > "tenant_security_monitor_settings"."created_at")
    and ("tenant_security_monitor_settings"."revoked_at" is null or "tenant_security_monitor_settings"."revoked_at" >= "tenant_security_monitor_settings"."created_at")
  )
);
--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_security_monitor_settings" ADD CONSTRAINT "tenant_security_monitor_settings_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_findings_tenant_repository_occurred_idx" ON "security_findings" USING btree ("tenant_id","repository_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_findings_tenant_machine_received_idx" ON "security_findings" USING btree ("tenant_id","machine_id","received_at");--> statement-breakpoint
ALTER TABLE "tenant_security_monitor_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "security_findings" ENABLE ROW LEVEL SECURITY;
