-- Task20d (T20.7a): security ingest v2 storage under the frozen contract
-- docs/contracts/security-v2 (Task20a). Generated with drizzle-kit generate,
-- then hand-edited only for what Drizzle cannot express:
--  1. RLS on the seven new tenant-owned tables, enabled with no browser
--     policies (AGENTS.md §9 item 3);
--  2. nothing else: every Task6.a check was already rewritten by the generator
--     as `record_generation <> 'task6a' or <the old condition>`, and the Task6.a
--     unique keys were replaced by partial unique indexes with the same columns.
CREATE TABLE "security_agent_inventory_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"agents" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_agent_inventory_snapshots_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_agent_inventory_snapshots_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_agent_inventory_snapshots_bounded_shape_check" CHECK (
    "security_agent_inventory_snapshots"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and jsonb_typeof("security_agent_inventory_snapshots"."agents") = 'array'
    and jsonb_array_length("security_agent_inventory_snapshots"."agents") between 1 and 64
  )
);
--> statement-breakpoint
CREATE TABLE "security_enforcement_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"decision" text NOT NULL,
	"mode" text NOT NULL,
	"rule_ids" text[] NOT NULL,
	"deny_rule_id" text,
	"deny_rule_version" text,
	"finding_record_ids" text[] NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"session_id" text,
	"source_agent" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_enforcement_decisions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_enforcement_decisions_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_enforcement_decisions_decision_check" CHECK (
    "security_enforcement_decisions"."decision" in ('deny', 'no_override') and "security_enforcement_decisions"."mode" in ('monitor', 'enforce')),
	CONSTRAINT "security_enforcement_decisions_deny_shape_check" CHECK (
    ("security_enforcement_decisions"."decision" = 'deny') = ("security_enforcement_decisions"."deny_rule_id" is not null)
    and ("security_enforcement_decisions"."decision" = 'deny') = ("security_enforcement_decisions"."deny_rule_version" is not null)
    and ("security_enforcement_decisions"."decision" <> 'deny' or "security_enforcement_decisions"."mode" = 'enforce')),
	CONSTRAINT "security_enforcement_decisions_bounded_shape_check" CHECK (
    "security_enforcement_decisions"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and array_length("security_enforcement_decisions"."rule_ids", 1) between 1 and 128
    and array_length("security_enforcement_decisions"."finding_record_ids", 1) between 0 and 128
    and ("security_enforcement_decisions"."tool_name" is null or (length("security_enforcement_decisions"."tool_name") between 1 and 128 and "security_enforcement_decisions"."tool_name" ~ '^[^[:space:]]+$'))
    and ("security_enforcement_decisions"."tool_call_id" is null or (length("security_enforcement_decisions"."tool_call_id") between 1 and 128 and "security_enforcement_decisions"."tool_call_id" ~ '^[^[:space:]]+$'))
    and ("security_enforcement_decisions"."session_id" is null or (length("security_enforcement_decisions"."session_id") between 1 and 128 and "security_enforcement_decisions"."session_id" ~ '^[^[:space:]]+$'))
    and length("security_enforcement_decisions"."source_agent") between 1 and 128
  )
);
--> statement-breakpoint
CREATE TABLE "security_finding_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value_encrypted" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_finding_previews_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_finding_previews_tenant_finding_field_key" UNIQUE("tenant_id","finding_id","field"),
	CONSTRAINT "security_finding_previews_field_check" CHECK (
    "security_finding_previews"."field" in ('observed_command', 'observed_file_path', 'observed_url', 'endpoint_hostname', 'endpoint_username')),
	CONSTRAINT "security_finding_previews_encrypted_shape_check" CHECK (
    jsonb_typeof("security_finding_previews"."value_encrypted") = 'object')
);
--> statement-breakpoint
CREATE TABLE "security_indicators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"count" bigint NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"source_agent" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_indicators_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_indicators_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_indicators_type_check" CHECK (
    "security_indicators"."type" in ('domain', 'ipv4', 'ipv6', 'url', 'email', 'md5', 'sha1', 'sha256')),
	CONSTRAINT "security_indicators_count_check" CHECK (
    "security_indicators"."count" between 1 and 9007199254740991),
	CONSTRAINT "security_indicators_window_check" CHECK (
    "security_indicators"."last_seen" >= "security_indicators"."first_seen"),
	CONSTRAINT "security_indicators_bounded_shape_check" CHECK (
    "security_indicators"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and length("security_indicators"."value") between 1 and 200
    and length("security_indicators"."source_agent") between 1 and 128
  )
);
--> statement-breakpoint
CREATE TABLE "security_permission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"outcome" text NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"session_id" text,
	"source_agent" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"join" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_permission_events_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_permission_events_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_permission_events_outcome_check" CHECK (
    "security_permission_events"."outcome" in ('requested', 'approved', 'denied')),
	CONSTRAINT "security_permission_events_join_check" CHECK (
    "security_permission_events"."join" in ('exact', 'same_session_window', 'unavailable')
    and ("security_permission_events"."join" <> 'exact' or "security_permission_events"."tool_call_id" is not null)
    and ("security_permission_events"."join" <> 'same_session_window' or "security_permission_events"."session_id" is not null)),
	CONSTRAINT "security_permission_events_bounded_shape_check" CHECK (
    "security_permission_events"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and ("security_permission_events"."tool_name" is null or (length("security_permission_events"."tool_name") between 1 and 128 and "security_permission_events"."tool_name" ~ '^[^[:space:]]+$'))
    and ("security_permission_events"."tool_call_id" is null or (length("security_permission_events"."tool_call_id") between 1 and 128 and "security_permission_events"."tool_call_id" ~ '^[^[:space:]]+$'))
    and ("security_permission_events"."session_id" is null or (length("security_permission_events"."session_id") between 1 and 128 and "security_permission_events"."session_id" ~ '^[^[:space:]]+$'))
    and length("security_permission_events"."source_agent") between 1 and 128
  )
);
--> statement-breakpoint
CREATE TABLE "security_scan_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"status" text NOT NULL,
	"artifacts_scanned" bigint NOT NULL,
	"events_emitted" bigint NOT NULL,
	"findings_emitted" bigint NOT NULL,
	"indicators_emitted" bigint NOT NULL,
	"diagnostics" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_scan_summaries_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_scan_summaries_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_scan_summaries_status_check" CHECK ("security_scan_summaries"."status" in ('complete', 'partial', 'error')),
	CONSTRAINT "security_scan_summaries_bounded_shape_check" CHECK (
    "security_scan_summaries"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and "security_scan_summaries"."artifacts_scanned" between 0 and 9007199254740991
    and "security_scan_summaries"."events_emitted" between 0 and 9007199254740991
    and "security_scan_summaries"."findings_emitted" between 0 and 9007199254740991
    and "security_scan_summaries"."indicators_emitted" between 0 and 9007199254740991
    and "security_scan_summaries"."diagnostics" between 0 and 9007199254740991
  )
);
--> statement-breakpoint
CREATE TABLE "security_status_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"numbat_version" text NOT NULL,
	"wired_agents" text[] NOT NULL,
	"active_bundle_digest" text,
	"lease_id" text,
	"last_record_at" timestamp with time zone,
	"hook_status" text NOT NULL,
	"agent_effective_view" text NOT NULL,
	"local_record" text NOT NULL,
	"forwarder_ack" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_status_snapshots_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "security_status_snapshots_tenant_machine_record_key" UNIQUE("tenant_id","machine_id","record_id"),
	CONSTRAINT "security_status_snapshots_health_check" CHECK (
    "security_status_snapshots"."hook_status" in ('ok', 'failed', 'unavailable')
    and "security_status_snapshots"."agent_effective_view" in ('ok', 'failed', 'unavailable')
    and "security_status_snapshots"."local_record" in ('ok', 'failed', 'unavailable')
    and "security_status_snapshots"."forwarder_ack" in ('ok', 'failed', 'unavailable')),
	CONSTRAINT "security_status_snapshots_bounded_shape_check" CHECK (
    "security_status_snapshots"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and length("security_status_snapshots"."numbat_version") between 1 and 64
    and array_length("security_status_snapshots"."wired_agents", 1) between 0 and 64
    and ("security_status_snapshots"."active_bundle_digest" is null or "security_status_snapshots"."active_bundle_digest" ~ '^[a-f0-9]{64}$')
    and ("security_status_snapshots"."lease_id" is null or (length("security_status_snapshots"."lease_id") between 1 and 128 and "security_status_snapshots"."lease_id" ~ '^[^[:space:]]+$'))
  )
);
--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_tenant_delivery_key";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_tenant_finding_key";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_rule_id_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_rule_category_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_rule_severity_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_route_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_operating_system_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_timing_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_activation_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_effect_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_phase_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_availability_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_completeness_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_result_category_check";--> statement-breakpoint
ALTER TABLE "security_findings" DROP CONSTRAINT "security_findings_bounded_metadata_check";--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "finding_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "delivery_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "source_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "route_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "agent_family" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "host_surface" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "host_mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "capture_channel" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "operating_system" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "timing" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "native_effect" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "activation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "effect" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "phase" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "availability" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "completeness" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "result_category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ALTER COLUMN "client_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "record_generation" text DEFAULT 'task6a' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "record_id" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "source_agent" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "parent_session_id" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "sub_agent_id" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "found_at_rest" boolean;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "numbat_schema_version" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "bundle_digest" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "lease_id" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "repository_kind" text;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "security_agent_inventory_snapshots" ADD CONSTRAINT "security_agent_inventory_snapshots_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_agent_inventory_snapshots" ADD CONSTRAINT "security_agent_inventory_snapshots_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_enforcement_decisions" ADD CONSTRAINT "security_enforcement_decisions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_enforcement_decisions" ADD CONSTRAINT "security_enforcement_decisions_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_previews" ADD CONSTRAINT "security_finding_previews_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_previews" ADD CONSTRAINT "security_finding_previews_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_previews" ADD CONSTRAINT "security_finding_previews_tenant_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."security_findings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_indicators" ADD CONSTRAINT "security_indicators_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_indicators" ADD CONSTRAINT "security_indicators_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_permission_events" ADD CONSTRAINT "security_permission_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_permission_events" ADD CONSTRAINT "security_permission_events_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scan_summaries" ADD CONSTRAINT "security_scan_summaries_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scan_summaries" ADD CONSTRAINT "security_scan_summaries_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_status_snapshots" ADD CONSTRAINT "security_status_snapshots_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_status_snapshots" ADD CONSTRAINT "security_status_snapshots_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_agent_inventory_snapshots_tenant_observed_idx" ON "security_agent_inventory_snapshots" USING btree ("tenant_id","observed_at");--> statement-breakpoint
CREATE INDEX "security_enforcement_decisions_tenant_occurred_idx" ON "security_enforcement_decisions" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_permission_events_tenant_occurred_idx" ON "security_permission_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_status_snapshots_tenant_observed_idx" ON "security_status_snapshots" USING btree ("tenant_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "security_findings_tenant_delivery_task6a_key" ON "security_findings" USING btree ("tenant_id","delivery_id") WHERE "security_findings"."record_generation" = 'task6a';--> statement-breakpoint
CREATE UNIQUE INDEX "security_findings_tenant_finding_task6a_key" ON "security_findings" USING btree ("tenant_id","finding_id") WHERE "security_findings"."record_generation" = 'task6a';--> statement-breakpoint
CREATE UNIQUE INDEX "security_findings_tenant_machine_record_v2_key" ON "security_findings" USING btree ("tenant_id","machine_id","record_id") WHERE "security_findings"."record_generation" = 'v2';--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_record_generation_check" CHECK ("security_findings"."record_generation" in ('task6a', 'v2'));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_rule_id_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."rule_id" is not null and "security_findings"."rule_id" in (
    'trackai.exec.destructive_recursive_delete',
    'trackai.exec.download_pipe_shell',
    'trackai.exec.reverse_shell'
  )));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_rule_category_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."rule_category" is not null and "security_findings"."rule_category" = 'execution'));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_rule_severity_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."rule_severity" is not null and "security_findings"."rule_severity" in ('high', 'critical')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_route_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or (
    "security_findings"."route_id" is not null and "security_findings"."route_id" = 'AC-CLI-03'
    and "security_findings"."agent_family" is not null and "security_findings"."agent_family" = 'opencode'
    and "security_findings"."host_surface" is not null and "security_findings"."host_surface" = 'terminal'
    and "security_findings"."host_mode" is not null and "security_findings"."host_mode" = 'cli'
    and "security_findings"."capture_channel" is not null and "security_findings"."capture_channel" = 'provider-plugin'
    and "security_findings"."native_effect" is not null and "security_findings"."native_effect" = 'observe_only'
  ));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_operating_system_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."operating_system" is not null and "security_findings"."operating_system" in ('macos', 'linux', 'windows', 'wsl', 'unavailable')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_timing_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."timing" is not null and "security_findings"."timing" in ('pre_action', 'post_action', 'at_rest', 'unavailable')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_activation_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."activation" is not null and "security_findings"."activation" in ('configured', 'loaded', 'observed', 'unavailable')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_effect_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."effect" is not null and "security_findings"."effect" = 'monitor'));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_phase_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."phase" is not null and "security_findings"."phase" in ('requested', 'observed_result', 'partial', 'unavailable')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_availability_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."availability" is not null and "security_findings"."availability" in ('available', 'unavailable', 'redacted', 'expired')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_completeness_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."completeness" is not null and "security_findings"."completeness" in ('complete', 'partial')));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_result_category_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or ("security_findings"."result_category" is not null and "security_findings"."result_category" in (
      'not_observed', 'success', 'failure', 'cancelled', 'unknown', 'unavailable'
    )));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_bounded_metadata_task6a_check" CHECK (
    "security_findings"."record_generation" <> 'task6a' or (
    "security_findings"."repository_id" is not null
    and "security_findings"."finding_id" is not null and length("security_findings"."finding_id") between 1 and 128
    and "security_findings"."delivery_id" is not null and length("security_findings"."delivery_id") between 1 and 128
    and "security_findings"."session_id" is not null and length("security_findings"."session_id") between 1 and 128
    and "security_findings"."source_event_id" is not null and length("security_findings"."source_event_id") between 1 and 128
    and ("security_findings"."correlation_id" is null or length("security_findings"."correlation_id") between 1 and 128)
    and "security_findings"."rule_version" is not null and length("security_findings"."rule_version") between 1 and 32
    and "security_findings"."client_version" is not null and length("security_findings"."client_version") between 1 and 64
    and "security_findings"."rule_pack_version" is not null and length("security_findings"."rule_pack_version") between 1 and 64
  ));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_v2_check" CHECK (
    "security_findings"."record_generation" <> 'v2' or (
    "security_findings"."record_id" is not null
    and "security_findings"."record_id" ~ '^sha256:[0-9a-f]{64}$'
    and "security_findings"."rule_id" is not null and length("security_findings"."rule_id") between 1 and 128
    and "security_findings"."rule_version" is not null and length("security_findings"."rule_version") between 1 and 64
    and "security_findings"."rule_severity" is not null and "security_findings"."rule_severity" in ('info', 'low', 'medium', 'high', 'critical')
    and "security_findings"."title" is not null and length("security_findings"."title") between 1 and 256
    and "security_findings"."source_agent" is not null and length("security_findings"."source_agent") between 1 and 128
    and "security_findings"."source_type" is not null and "security_findings"."source_type" in ('artifact', 'hook', 'otel')
    and "security_findings"."confidence" is not null and "security_findings"."confidence" in ('high', 'medium', 'low')
    and "security_findings"."detected_at" is not null
    and "security_findings"."occurred_at" = "security_findings"."detected_at"
    and "security_findings"."numbat_schema_version" is not null and "security_findings"."numbat_schema_version" = '0.5.0'
    and "security_findings"."bundle_digest" is not null and "security_findings"."bundle_digest" ~ '^[a-f0-9]{64}$'
    and "security_findings"."lease_id" is not null and length("security_findings"."lease_id") between 1 and 128
    and "security_findings"."lease_id" ~ '^[^[:space:]]+$'
    and "security_findings"."found_at_rest" is not null
    and "security_findings"."repository_kind" is not null and "security_findings"."repository_kind" in ('enrolled', 'not_enrolled')
    and (
      ("security_findings"."repository_kind" = 'enrolled' and "security_findings"."repository_id" is not null)
      or ("security_findings"."repository_kind" = 'not_enrolled' and "security_findings"."repository_id" is null)
    )
    and "security_findings"."rule_category" = split_part("security_findings"."rule_id", '.', 1)
    and "security_findings"."rule_pack_version" = 'bundle:' || substr("security_findings"."bundle_digest", 1, 16)
    and "security_findings"."effect" is not null and "security_findings"."effect" = 'monitor'
    and ("security_findings"."tags" is null or jsonb_typeof("security_findings"."tags") = 'array')
    and ("security_findings"."session_id" is null or (length("security_findings"."session_id") between 1 and 128 and "security_findings"."session_id" ~ '^[^[:space:]]+$'))
    and ("security_findings"."parent_session_id" is null or (length("security_findings"."parent_session_id") between 1 and 128 and "security_findings"."parent_session_id" ~ '^[^[:space:]]+$'))
    and ("security_findings"."sub_agent_id" is null or (length("security_findings"."sub_agent_id") between 1 and 128 and "security_findings"."sub_agent_id" ~ '^[^[:space:]]+$'))
    and ("security_findings"."model" is null or (length("security_findings"."model") between 1 and 128 and "security_findings"."model" ~ '^[^[:space:]]+$'))
    and ("security_findings"."model_provider" is null or (length("security_findings"."model_provider") between 1 and 128 and "security_findings"."model_provider" ~ '^[^[:space:]]+$'))
  ));--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_v2_source_agent_check" CHECK (
    "security_findings"."record_generation" <> 'v2' or "security_findings"."source_agent" in (
      'claude-code', 'cowork', 'codex', 'gemini-cli', 'cursor', 'windsurf', 'copilot',
      'vscode', 'opencode', 'openclaw', 'antigravity', 'factory', 'grok', 'devin-cli',
      'hermes', 'kimi-code', 'pi', 'qwen-code', 'cline', 'amp', 'auggie', 'kiro',
      'goose', 'kilo', 'openhands', 'crush', 'junie', 'unknown'
    ));

--> statement-breakpoint
-- Task20d: RLS on the new tenant-owned tables, no browser policies (AGENTS.md
-- §9 item 3). The application predicate lives in withTenant(); the API role
-- bypasses RLS, so these are the database backstop.
ALTER TABLE "security_agent_inventory_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_enforcement_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_finding_previews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_indicators" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_permission_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_scan_summaries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "security_status_snapshots" ENABLE ROW LEVEL SECURITY;
