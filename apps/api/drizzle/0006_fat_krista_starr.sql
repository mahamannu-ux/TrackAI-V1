CREATE TABLE "github_app_credential_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"encrypted_credential" jsonb NOT NULL,
	"master_key_version" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rotated_from_credential_id" uuid,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_credential_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "github_app_credential_versions_installation_fingerprint_key" UNIQUE("tenant_id","installation_id","credential_fingerprint"),
	CONSTRAINT "github_app_credential_versions_status_check" CHECK ("github_app_credential_versions"."status" in ('active', 'retiring', 'revoked')),
	CONSTRAINT "github_app_credential_versions_interval_check" CHECK ("github_app_credential_versions"."effective_until" is null or "github_app_credential_versions"."effective_until" > "github_app_credential_versions"."effective_from"),
	CONSTRAINT "github_app_credential_versions_fingerprint_check" CHECK ("github_app_credential_versions"."credential_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "github_app_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_host" text DEFAULT 'github.com' NOT NULL,
	"app_id" text NOT NULL,
	"installation_external_id" text NOT NULL,
	"account_login" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscribed_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_installations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "github_app_installations_provider_external_key" UNIQUE("provider_host","installation_external_id"),
	CONSTRAINT "github_app_installations_tenant_provider_account_key" UNIQUE("tenant_id","provider_host","account_login"),
	CONSTRAINT "github_app_installations_status_check" CHECK ("github_app_installations"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "tenant_admin_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "tenant_admin_memberships_tenant_subject_key" UNIQUE("tenant_id","subject"),
	CONSTRAINT "tenant_admin_memberships_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_admin_memberships_role_check" CHECK ("tenant_admin_memberships"."role" in ('tenant_admin', 'tenant_auditor')),
	CONSTRAINT "tenant_admin_memberships_status_check" CHECK ("tenant_admin_memberships"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "github_app_credential_versions" ADD CONSTRAINT "github_app_credential_versions_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_credential_versions" ADD CONSTRAINT "github_app_credential_versions_tenant_installation_fk" FOREIGN KEY ("tenant_id","installation_id") REFERENCES "public"."github_app_installations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_credential_versions" ADD CONSTRAINT "github_app_credential_versions_rotated_from_fk" FOREIGN KEY ("tenant_id","rotated_from_credential_id") REFERENCES "public"."github_app_credential_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_admin_memberships" ADD CONSTRAINT "tenant_admin_memberships_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_app_credential_versions_tenant_installation_status_idx" ON "github_app_credential_versions" USING btree ("tenant_id","installation_id","status","effective_from");--> statement-breakpoint
CREATE INDEX "github_app_installations_tenant_status_idx" ON "github_app_installations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "tenant_admin_memberships_tenant_role_status_idx" ON "tenant_admin_memberships" USING btree ("tenant_id","role","status");

-- Administration and provider credentials are server-only. Protected APIs are
-- the tenant access boundary; browser/database roles receive no direct policy.
ALTER TABLE "tenant_admin_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_app_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_app_credential_versions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "github_app_installations"
	ADD CONSTRAINT "github_app_installations_app_id_check"
	CHECK ("app_id" ~ '^[0-9]+$'),
	ADD CONSTRAINT "github_app_installations_external_id_check"
	CHECK ("installation_external_id" ~ '^[0-9]+$'),
	ADD CONSTRAINT "github_app_installations_provider_host_check"
	CHECK ("provider_host" = lower("provider_host") AND "provider_host" ~ '^[a-z0-9.-]+$'),
	ADD CONSTRAINT "github_app_installations_account_login_check"
	CHECK ("account_login" = lower("account_login") AND "account_login" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
	ADD CONSTRAINT "github_app_installations_permissions_check"
	CHECK (
		jsonb_typeof("permissions") = 'object'
		AND "permissions" ->> 'contents' = 'read'
		AND "permissions" ->> 'pull_requests' = 'read'
		AND NOT jsonb_path_exists("permissions", '$.* ? (@ != "read" && @ != "none")')
	),
	ADD CONSTRAINT "github_app_installations_events_check"
	CHECK (jsonb_typeof("subscribed_events") = 'array');

ALTER TABLE "github_app_credential_versions"
	ADD CONSTRAINT "github_app_credential_versions_envelope_check"
	CHECK (
		jsonb_typeof("encrypted_credential") = 'object'
		AND "encrypted_credential" ->> 'schemaVersion' = '1'
		AND "encrypted_credential" ->> 'algorithm' = 'aes-256-gcm'
		AND "encrypted_credential" ->> 'masterKeyVersion' = "master_key_version"
		AND "encrypted_credential" ?& ARRAY[
			'iv', 'ciphertext', 'authTag', 'wrappedDataKey'
		]
		AND ("encrypted_credential" - ARRAY[
			'schemaVersion', 'algorithm', 'masterKeyVersion', 'iv',
			'ciphertext', 'authTag', 'wrappedDataKey'
		]) = '{}'::jsonb
		AND jsonb_typeof("encrypted_credential" -> 'wrappedDataKey') = 'object'
		AND ("encrypted_credential" -> 'wrappedDataKey') ?& ARRAY[
			'iv', 'ciphertext', 'authTag'
		]
		AND (("encrypted_credential" -> 'wrappedDataKey') - ARRAY[
			'iv', 'ciphertext', 'authTag'
		]) = '{}'::jsonb
	);

-- Membership identity and original grant evidence are immutable. Status,
-- revocation and an administrative email label may change through audited APIs.
CREATE FUNCTION "prevent_tenant_admin_membership_scope_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'tenant_admin_memberships are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."subject", OLD."role", OLD."granted_by", OLD."granted_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."subject", NEW."role", NEW."granted_by", NEW."granted_at"
	) THEN
		RAISE EXCEPTION 'tenant_admin_membership scope is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tenant_admin_memberships_scope_immutable"
BEFORE UPDATE OR DELETE ON "tenant_admin_memberships"
FOR EACH ROW EXECUTE FUNCTION "prevent_tenant_admin_membership_scope_mutation"();

-- Installation identity is immutable. Permissions/events can be reduced or
-- updated only through audited services; revoked installations cannot reopen.
CREATE FUNCTION "prevent_github_app_installation_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'github_app_installations are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."provider_host", OLD."app_id",
		OLD."installation_external_id", OLD."account_login",
		OLD."created_by", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."provider_host", NEW."app_id",
		NEW."installation_external_id", NEW."account_login",
		NEW."created_by", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'github_app_installation identity is immutable';
	END IF;
	IF OLD."status" = 'revoked' AND NEW."status" <> 'revoked' THEN
		RAISE EXCEPTION 'revoked github_app_installation cannot be reactivated';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "github_app_installations_identity_immutable"
BEFORE UPDATE OR DELETE ON "github_app_installations"
FOR EACH ROW EXECUTE FUNCTION "prevent_github_app_installation_identity_mutation"();

-- Ciphertext, fingerprint, lineage and creation evidence are immutable.
-- Lifecycle fields may only advance through active -> retiring/revoked and
-- retiring -> revoked; a revoked credential can never become usable again.
CREATE FUNCTION "prevent_github_app_credential_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'github_app_credential_versions are retained for audit';
	END IF;
	IF ROW(
		OLD."tenant_id", OLD."installation_id", OLD."encrypted_credential",
		OLD."master_key_version", OLD."credential_fingerprint",
		OLD."rotated_from_credential_id", OLD."effective_from",
		OLD."created_by", OLD."created_at"
	) IS DISTINCT FROM ROW(
		NEW."tenant_id", NEW."installation_id", NEW."encrypted_credential",
		NEW."master_key_version", NEW."credential_fingerprint",
		NEW."rotated_from_credential_id", NEW."effective_from",
		NEW."created_by", NEW."created_at"
	) THEN
		RAISE EXCEPTION 'github_app_credential evidence is immutable';
	END IF;
	IF (OLD."status" = 'retiring' AND NEW."status" NOT IN ('retiring', 'revoked'))
		OR (OLD."status" = 'revoked' AND NEW."status" <> 'revoked') THEN
		RAISE EXCEPTION 'github_app_credential lifecycle cannot move backward';
	END IF;
	IF OLD."effective_until" IS NOT NULL
		AND (NEW."effective_until" IS NULL OR NEW."effective_until" > OLD."effective_until") THEN
		RAISE EXCEPTION 'github_app_credential overlap cannot be extended';
	END IF;
	IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
		RAISE EXCEPTION 'github_app_credential revocation is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "github_app_credential_versions_evidence_immutable"
BEFORE UPDATE OR DELETE ON "github_app_credential_versions"
FOR EACH ROW EXECUTE FUNCTION "prevent_github_app_credential_evidence_mutation"();
