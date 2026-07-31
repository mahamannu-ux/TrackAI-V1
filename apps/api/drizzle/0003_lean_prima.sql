CREATE TABLE "developer_machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "developer_machines_tenant_installation_key" UNIQUE("tenant_id","installation_id"),
	CONSTRAINT "developer_machines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "developer_machines_status_check" CHECK ("developer_machines"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "machine_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rotated_from_credential_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "machine_credentials_key_id_unique" UNIQUE("key_id"),
	CONSTRAINT "machine_credentials_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "machine_credentials_status_check" CHECK ("machine_credentials"."status" in ('active', 'revoked')),
	CONSTRAINT "machine_credentials_secret_hash_check" CHECK ("machine_credentials"."secret_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "machine_repository_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"branch_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"granted_by" text NOT NULL,
	"reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_repository_grants_status_check" CHECK ("machine_repository_grants"."status" in ('active', 'revoked')),
	CONSTRAINT "machine_repository_grants_interval_check" CHECK ("machine_repository_grants"."effective_until" is null or "machine_repository_grants"."effective_until" > "machine_repository_grants"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "repository_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"enrolled_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_enrollments_tenant_repository_key" UNIQUE("tenant_id","repository_id"),
	CONSTRAINT "repository_enrollments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "repository_enrollments_status_check" CHECK ("repository_enrollments"."status" in ('active', 'revoked')),
	CONSTRAINT "repository_enrollments_interval_check" CHECK ("repository_enrollments"."effective_until" is null or "repository_enrollments"."effective_until" > "repository_enrollments"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scm_repositories" ADD CONSTRAINT "scm_repositories_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "developer_machines" ADD CONSTRAINT "developer_machines_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_rotated_from_fk" FOREIGN KEY ("tenant_id","rotated_from_credential_id") REFERENCES "public"."machine_credentials"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_repository_grants" ADD CONSTRAINT "machine_repository_grants_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_repository_grants" ADD CONSTRAINT "machine_repository_grants_tenant_machine_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."developer_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_repository_grants" ADD CONSTRAINT "machine_repository_grants_tenant_enrollment_fk" FOREIGN KEY ("tenant_id","enrollment_id") REFERENCES "public"."repository_enrollments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_enrollments" ADD CONSTRAINT "repository_enrollments_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_enrollments" ADD CONSTRAINT "repository_enrollments_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_events" ADD CONSTRAINT "security_audit_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_credentials_tenant_machine_status_idx" ON "machine_credentials" USING btree ("tenant_id","machine_id","status");--> statement-breakpoint
CREATE INDEX "machine_repository_grants_tenant_machine_status_idx" ON "machine_repository_grants" USING btree ("tenant_id","machine_id","status");--> statement-breakpoint
CREATE INDEX "machine_repository_grants_tenant_enrollment_status_idx" ON "machine_repository_grants" USING btree ("tenant_id","enrollment_id","status");--> statement-breakpoint
CREATE INDEX "security_audit_events_tenant_occurred_at_idx" ON "security_audit_events" USING btree ("tenant_id","occurred_at");

-- Security administration tables are server-only. Browser roles receive no
-- direct policies; tenant-scoped application APIs are the access boundary.
ALTER TABLE "developer_machines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "machine_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "repository_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "machine_repository_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_audit_events" ENABLE ROW LEVEL SECURITY;

-- Audit observations are append-only. Corrections are represented by later
-- audit events rather than rewriting the original record.
CREATE FUNCTION "prevent_security_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'security_audit_events are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "security_audit_events_immutable"
BEFORE UPDATE OR DELETE ON "security_audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_security_audit_event_mutation"();
