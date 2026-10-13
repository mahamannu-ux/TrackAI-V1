CREATE TABLE "attesta_key_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"key_id" uuid,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"document_version" bigint,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_key_events_shape_check" CHECK (
    "attesta_key_events"."action" in ('register', 'activate', 'retire', 'revoke', 'publish', 'import_root')
    and ("attesta_key_events"."action" in ('publish', 'import_root')) = ("attesta_key_events"."key_id" is null)
    and ("attesta_key_events"."action" in ('publish', 'import_root')) = ("attesta_key_events"."document_version" is not null)
    and ("attesta_key_events"."action" <> 'import_root' or "attesta_key_events"."tenant_id" is null)
    and ("attesta_key_events"."action" <> 'publish' or "attesta_key_events"."tenant_id" is not null)
    and length("attesta_key_events"."actor") between 1 and 128
    and ("attesta_key_events"."reason" is null or length("attesta_key_events"."reason") between 1 and 256)
    and length("attesta_key_events"."request_id") between 1 and 128
    and ("attesta_key_events"."document_version" is null or "attesta_key_events"."document_version" >= 1)
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_platform_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyid" text NOT NULL,
	"purpose" text NOT NULL,
	"adapter_name" text NOT NULL,
	"credential_ref" text NOT NULL,
	"spki_der" "bytea" NOT NULL,
	"not_before" timestamp (3) with time zone NOT NULL,
	"not_after" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"revocation_reason" text,
	"compromised_since" timestamp (3) with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pop_digest" text NOT NULL,
	CONSTRAINT "attesta_platform_keys_keyid_key" UNIQUE("keyid"),
	CONSTRAINT "attesta_platform_keys_shape_check" CHECK (
    "attesta_platform_keys"."purpose" in ('anchor', 'activation_lease', 'fleet_config', 'policy_bundle', 'release', 'tenant_keyset')
    and "attesta_platform_keys"."keyid" = 'sha256:' || encode(sha256("attesta_platform_keys"."spki_der"), 'hex')
    and length("attesta_platform_keys"."spki_der") = 91
    and "attesta_platform_keys"."adapter_name" ~ '^[a-z][a-z0-9-]{0,31}$'
    and length("attesta_platform_keys"."credential_ref") between 1 and 512
    and "attesta_platform_keys"."not_before" < "attesta_platform_keys"."not_after"
    and "attesta_platform_keys"."pop_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_platform_keys"."status" in ('registered', 'active', 'retired', 'revoked')
    and ("attesta_platform_keys"."status" in ('registered', 'active')) = ("attesta_platform_keys"."revoked_at" is null)
    and ("attesta_platform_keys"."status" = 'revoked') = ("attesta_platform_keys"."revocation_reason" is not null)
    and ("attesta_platform_keys"."revocation_reason" is null or "attesta_platform_keys"."revocation_reason" in ('superseded', 'compromised'))
    and ("attesta_platform_keys"."revocation_reason" = 'compromised') is not distinct from ("attesta_platform_keys"."compromised_since" is not null)
    and ("attesta_platform_keys"."compromised_since" is null or "attesta_platform_keys"."compromised_since" <= "attesta_platform_keys"."revoked_at")
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_tenant_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"keyid" text NOT NULL,
	"purpose" text NOT NULL,
	"adapter_name" text NOT NULL,
	"credential_ref" text NOT NULL,
	"spki_der" "bytea" NOT NULL,
	"not_before" timestamp (3) with time zone NOT NULL,
	"not_after" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"revocation_reason" text,
	"compromised_since" timestamp (3) with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pop_digest" text NOT NULL,
	CONSTRAINT "attesta_tenant_keys_keyid_key" UNIQUE("keyid"),
	CONSTRAINT "attesta_tenant_keys_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_tenant_keys_shape_check" CHECK (
    "attesta_tenant_keys"."purpose" = 'statement'
    and "attesta_tenant_keys"."keyid" = 'sha256:' || encode(sha256("attesta_tenant_keys"."spki_der"), 'hex')
    and length("attesta_tenant_keys"."spki_der") = 91
    and "attesta_tenant_keys"."adapter_name" ~ '^[a-z][a-z0-9-]{0,31}$'
    and length("attesta_tenant_keys"."credential_ref") between 1 and 512
    and "attesta_tenant_keys"."not_before" < "attesta_tenant_keys"."not_after"
    and "attesta_tenant_keys"."pop_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_tenant_keys"."status" in ('registered', 'active', 'retired', 'revoked')
    and ("attesta_tenant_keys"."status" in ('registered', 'active')) = ("attesta_tenant_keys"."revoked_at" is null)
    and ("attesta_tenant_keys"."status" = 'revoked') = ("attesta_tenant_keys"."revocation_reason" is not null)
    and ("attesta_tenant_keys"."revocation_reason" is null or "attesta_tenant_keys"."revocation_reason" in ('superseded', 'compromised'))
    and ("attesta_tenant_keys"."revocation_reason" = 'compromised') is not distinct from ("attesta_tenant_keys"."compromised_since" is not null)
    and ("attesta_tenant_keys"."compromised_since" is null or "attesta_tenant_keys"."compromised_since" <= "attesta_tenant_keys"."revoked_at")
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_trust_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"version" bigint NOT NULL,
	"digest" text NOT NULL,
	"payload_type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_trust_documents_scope_version_key" UNIQUE("scope","version"),
	CONSTRAINT "attesta_trust_documents_shape_check" CHECK (
    (("attesta_trust_documents"."kind" = 'root' and "attesta_trust_documents"."scope" = 'platform'
        and "attesta_trust_documents"."payload_type" = 'application/vnd.trackai.trust-root+json')
      or ("attesta_trust_documents"."kind" = 'keyset'
        and "attesta_trust_documents"."scope" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and "attesta_trust_documents"."payload_type" = 'application/vnd.trackai.keyset+json'))
    and "attesta_trust_documents"."version" >= 1
    and "attesta_trust_documents"."digest" ~ '^sha256:[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_key_events" ADD CONSTRAINT "attesta_key_events_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_tenant_keys" ADD CONSTRAINT "attesta_tenant_keys_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attesta_key_events_key_idx" ON "attesta_key_events" USING btree ("key_id","action");--> statement-breakpoint
CREATE INDEX "attesta_key_events_tenant_created_idx" ON "attesta_key_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_tenant_keys_one_active_key" ON "attesta_tenant_keys" USING btree ("tenant_id") WHERE "attesta_tenant_keys"."status" = 'active';--> statement-breakpoint
ALTER TABLE "attesta_platform_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_tenant_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_key_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_trust_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Trust inventory guards (Task15l2, A15.12; design docs/contracts/attesta/trust.md).
-- In the 0017/0018 style: SECURITY DEFINER with search_path = pg_catalog, pg_temp
-- (AGENTS.md §9 item 21), tables schema-qualified, ERRCODE ATG01 for a guard breach;
-- ATK01 = the keyid is already registered (for one tenant or the platform, any purpose).
-- Events and documents are append-only; key rows are never deleted (retired public
-- keys are kept forever, SushiCorp A1b "Rotation") and change only forward.
CREATE TRIGGER attesta_key_events_append_only
  BEFORE UPDATE OR DELETE ON "attesta_key_events"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_key_events_no_truncate
  BEFORE TRUNCATE ON "attesta_key_events"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_trust_documents_append_only
  BEFORE UPDATE OR DELETE ON "attesta_trust_documents"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_trust_documents_no_truncate
  BEFORE TRUNCATE ON "attesta_trust_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_platform_keys_no_delete
  BEFORE DELETE ON "attesta_platform_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_platform_keys_no_truncate
  BEFORE TRUNCATE ON "attesta_platform_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_tenant_keys_no_delete
  BEFORE DELETE ON "attesta_tenant_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_tenant_keys_no_truncate
  BEFORE TRUNCATE ON "attesta_tenant_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
-- A new key starts as `registered`, and its keyid was never registered before in
-- either table, for any tenant or purpose (trust.md "Registration": one tenant cannot
-- list another's public key). The advisory lock serializes concurrent registrations
-- of one keyid across both tables.
CREATE OR REPLACE FUNCTION attesta_trust_keys_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_trust_keyid:' || NEW.keyid, 0));
  IF NEW.status IS DISTINCT FROM 'registered' OR NEW.revoked_at IS NOT NULL
     OR NEW.revocation_reason IS NOT NULL OR NEW.compromised_since IS NOT NULL THEN
    RAISE EXCEPTION '%: a new key must start as registered', TG_TABLE_NAME USING ERRCODE = 'ATG01';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attesta_platform_keys p WHERE p.keyid = NEW.keyid)
     OR EXISTS (SELECT 1 FROM public.attesta_tenant_keys t WHERE t.keyid = NEW.keyid) THEN
    RAISE EXCEPTION '%: this keyid is already registered', TG_TABLE_NAME USING ERRCODE = 'ATK01';
  END IF;
  NEW.registered_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_platform_keys_insert_guard
  BEFORE INSERT ON "attesta_platform_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_insert_guard();
--> statement-breakpoint
CREATE TRIGGER attesta_tenant_keys_insert_guard
  BEFORE INSERT ON "attesta_tenant_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_insert_guard();
--> statement-breakpoint
-- Status moves only forward (registered → active → retired → revoked; registered or
-- active → revoked; revoked superseded → revoked compromised), revoked_at and
-- compromised_since never move later, not_after never grows, and the key material,
-- identity, credential and tenant never change. A platform key's status, validity
-- and revocation must equal what the latest stored root document lists for it: a
-- platform key becomes usable only through a signed root (trust.md "Hierarchy").
CREATE OR REPLACE FUNCTION attesta_trust_keys_update_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  old_rank integer := array_position(ARRAY['registered', 'active', 'retired', 'revoked'], OLD.status);
  new_rank integer := array_position(ARRAY['registered', 'active', 'retired', 'revoked'], NEW.status);
  root_payload jsonb;
  entry jsonb;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.keyid IS DISTINCT FROM OLD.keyid OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.spki_der IS DISTINCT FROM OLD.spki_der OR NEW.not_before IS DISTINCT FROM OLD.not_before
     OR NEW.adapter_name IS DISTINCT FROM OLD.adapter_name OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
     OR NEW.registered_at IS DISTINCT FROM OLD.registered_at OR NEW.pop_digest IS DISTINCT FROM OLD.pop_digest
     OR (TG_TABLE_NAME = 'attesta_tenant_keys' AND to_jsonb(NEW)->'tenant_id' IS DISTINCT FROM to_jsonb(OLD)->'tenant_id') THEN
    RAISE EXCEPTION '%: key identity, material, credential and not_before never change', TG_TABLE_NAME USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.not_after > OLD.not_after THEN
    RAISE EXCEPTION '%: not_after never grows', TG_TABLE_NAME USING ERRCODE = 'ATG01';
  END IF;
  IF new_rank < old_rank OR (OLD.status = 'registered' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION '%: status % cannot become %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = 'ATG01';
  END IF;
  IF (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at > OLD.revoked_at))
     OR (OLD.revocation_reason = 'compromised' AND NEW.revocation_reason IS DISTINCT FROM 'compromised')
     OR (OLD.compromised_since IS NOT NULL AND (NEW.compromised_since IS NULL OR NEW.compromised_since > OLD.compromised_since)) THEN
    RAISE EXCEPTION '%: revocation never moves back or later', TG_TABLE_NAME USING ERRCODE = 'ATG01';
  END IF;
  IF TG_TABLE_NAME = 'attesta_platform_keys' THEN
    SELECT convert_from(decode(d.envelope->>'payload', 'base64'), 'UTF8')::jsonb INTO root_payload
      FROM public.attesta_trust_documents d WHERE d.scope = 'platform' ORDER BY d.version DESC LIMIT 1;
    SELECT k INTO entry FROM jsonb_array_elements(root_payload->'keys') AS k WHERE k->>'keyid' = NEW.keyid;
    IF entry IS NULL
       OR entry->>'purpose' IS DISTINCT FROM NEW.purpose
       OR entry->>'status' IS DISTINCT FROM NEW.status
       OR (entry->>'not_before')::timestamptz IS DISTINCT FROM NEW.not_before
       OR (entry->>'not_after')::timestamptz IS DISTINCT FROM NEW.not_after
       OR (entry->>'revoked_at')::timestamptz IS DISTINCT FROM NEW.revoked_at
       OR entry->>'revocation_reason' IS DISTINCT FROM NEW.revocation_reason
       OR (entry->>'compromised_since')::timestamptz IS DISTINCT FROM NEW.compromised_since THEN
      RAISE EXCEPTION 'attesta_platform_keys: a platform key changes only to what the latest root document lists'
        USING ERRCODE = 'ATG01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_platform_keys_update_guard
  BEFORE UPDATE ON "attesta_platform_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_update_guard();
--> statement-breakpoint
CREATE TRIGGER attesta_tenant_keys_update_guard
  BEFORE UPDATE ON "attesta_tenant_keys"
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_update_guard();
--> statement-breakpoint
-- Every key UPDATE is audited in the same transaction (checked at commit): an
-- attesta_key_events row for this key and the matching action (activate, retire,
-- revoke) created in this transaction (the event guard pins created_at to now(),
-- the transaction's start time). A platform key additionally needs the import_root
-- event of this transaction: it changes only by importing a signed root document.
CREATE OR REPLACE FUNCTION attesta_trust_keys_event_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  expected text;
  key_tenant uuid := CASE WHEN TG_TABLE_NAME = 'attesta_tenant_keys' THEN (to_jsonb(NEW)->>'tenant_id')::uuid END;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    expected := CASE NEW.status WHEN 'active' THEN 'activate' WHEN 'retired' THEN 'retire' ELSE 'revoke' END;
  ELSIF NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.compromised_since IS DISTINCT FROM OLD.compromised_since THEN
    expected := 'revoke';
  END IF;
  IF expected IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.attesta_key_events e
       WHERE e.key_id = NEW.id AND e.action = expected AND e.created_at = now()
         AND e.tenant_id IS NOT DISTINCT FROM key_tenant) THEN
    RAISE EXCEPTION '%: % of key % without its attesta_key_events row in this transaction', TG_TABLE_NAME, expected, NEW.keyid
      USING ERRCODE = 'ATG01';
  END IF;
  IF expected IS NULL AND TG_TABLE_NAME = 'attesta_tenant_keys' THEN
    RAISE EXCEPTION 'attesta_tenant_keys: an update must change the key status or revocation (with its event)'
      USING ERRCODE = 'ATG01';
  END IF;
  IF TG_TABLE_NAME = 'attesta_platform_keys' AND NOT EXISTS (
       SELECT 1 FROM public.attesta_key_events e
       WHERE e.action = 'import_root' AND e.key_id IS NULL AND e.tenant_id IS NULL AND e.created_at = now()) THEN
    RAISE EXCEPTION 'attesta_platform_keys: key % changed outside a root document import', NEW.keyid USING ERRCODE = 'ATG01';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attesta_platform_keys_event_check
  AFTER UPDATE ON "attesta_platform_keys" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_event_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attesta_tenant_keys_event_check
  AFTER UPDATE ON "attesta_tenant_keys" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_keys_event_check();
--> statement-breakpoint
-- An event names an existing key of its own scope (platform events: a platform key;
-- tenant events: a key of that tenant), a document version that exists, and carries
-- the transaction's own time.
CREATE OR REPLACE FUNCTION attesta_key_events_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.created_at := now();
  IF NEW.key_id IS NOT NULL AND (
       (NEW.tenant_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.attesta_platform_keys p WHERE p.id = NEW.key_id))
    OR (NEW.tenant_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.attesta_tenant_keys t WHERE t.id = NEW.key_id AND t.tenant_id = NEW.tenant_id))) THEN
    RAISE EXCEPTION 'attesta_key_events: key % is not a key of this scope', NEW.key_id USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.document_version IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.attesta_trust_documents d
       WHERE d.scope = coalesce(NEW.tenant_id::text, 'platform') AND d.version = NEW.document_version) THEN
    RAISE EXCEPTION 'attesta_key_events: document version % does not exist in this scope', NEW.document_version
      USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_key_events_guard
  BEFORE INSERT ON "attesta_key_events"
  FOR EACH ROW EXECUTE FUNCTION attesta_key_events_guard();
--> statement-breakpoint
-- A document is the next version of its scope (version 1 first, then exactly
-- max + 1), its columns are read from the signed payload itself (scope, version,
-- type, payload type, digest), and its `previous` is the stored digest of version − 1
-- (null at version 1). A key-set scope is an existing tenant. Signatures are checked
-- by the service before it stores (trust-inventory.ts); the database keeps the chain
-- shape so a stored fork or gap is impossible.
CREATE OR REPLACE FUNCTION attesta_trust_documents_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  payload_bytes bytea;
  body jsonb;
  max_version bigint;
  prev_digest text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_trust_documents:' || NEW.scope, 0));
  NEW.created_at := now();
  IF NEW.kind = 'keyset' AND NOT EXISTS (SELECT 1 FROM public.sso_tenants s WHERE s.id::text = NEW.scope) THEN
    RAISE EXCEPTION 'attesta_trust_documents: key-set scope is not a tenant' USING ERRCODE = 'ATG01';
  END IF;
  IF jsonb_typeof(NEW.envelope) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.envelope->'payload') IS DISTINCT FROM 'string'
     OR NEW.envelope->>'payloadType' IS DISTINCT FROM NEW.payload_type
     OR jsonb_typeof(NEW.envelope->'signatures') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.envelope->'signatures') < 1 THEN
    RAISE EXCEPTION 'attesta_trust_documents: envelope shape' USING ERRCODE = 'ATG01';
  END IF;
  BEGIN
    payload_bytes := decode(NEW.envelope->>'payload', 'base64');
    body := convert_from(payload_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'attesta_trust_documents: payload is not base64 JSON' USING ERRCODE = 'ATG01';
  END;
  IF 'sha256:' || encode(sha256(payload_bytes), 'hex') IS DISTINCT FROM NEW.digest
     OR body->>'scope' IS DISTINCT FROM NEW.scope
     OR body->'version' IS DISTINCT FROM to_jsonb(NEW.version)
     OR body->>'_type' IS DISTINCT FROM (CASE NEW.kind WHEN 'root' THEN 'https://trackai.dev/attesta/trust-root/v1'
                                                        ELSE 'https://trackai.dev/attesta/keyset/v1' END) THEN
    RAISE EXCEPTION 'attesta_trust_documents: columns do not match the signed payload' USING ERRCODE = 'ATG01';
  END IF;
  SELECT max(d.version) INTO max_version FROM public.attesta_trust_documents d WHERE d.scope = NEW.scope;
  IF NEW.version IS DISTINCT FROM coalesce(max_version, 0) + 1 THEN
    RAISE EXCEPTION 'attesta_trust_documents: version must be % for this scope (got %)', coalesce(max_version, 0) + 1, NEW.version
      USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.version = 1 THEN
    IF body->'previous' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'attesta_trust_documents: version 1 has previous null' USING ERRCODE = 'ATG01';
    END IF;
  ELSE
    SELECT d.digest INTO prev_digest FROM public.attesta_trust_documents d
      WHERE d.scope = NEW.scope AND d.version = NEW.version - 1;
    IF body->'previous' IS DISTINCT FROM to_jsonb(prev_digest) THEN
      RAISE EXCEPTION 'attesta_trust_documents: previous is not the digest of version %', NEW.version - 1
        USING ERRCODE = 'ATG01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_trust_documents_guard
  BEFORE INSERT ON "attesta_trust_documents"
  FOR EACH ROW EXECUTE FUNCTION attesta_trust_documents_guard();
