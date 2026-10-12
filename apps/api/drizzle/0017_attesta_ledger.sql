CREATE TABLE "attesta_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"payload_type" text NOT NULL,
	"keyid" text NOT NULL,
	"credential_id" text NOT NULL,
	"signature_der" "bytea" NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "attesta_envelopes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_envelopes_tenant_record_key" UNIQUE("tenant_id","record_id"),
	CONSTRAINT "attesta_envelopes_shape_check" CHECK (
    "attesta_envelopes"."payload_type" = 'application/vnd.in-toto+json'
    and "attesta_envelopes"."keyid" ~ '^sha256:[0-9a-f]{64}$'
    and length("attesta_envelopes"."credential_id") between 1 and 256
    and octet_length("attesta_envelopes"."signature_der") between 8 and 128
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"record_kind" text NOT NULL,
	"statement_digest" text NOT NULL,
	"predicate_type" text NOT NULL,
	"statement_kind" text,
	"repository_id" uuid NOT NULL,
	"subject_sha" text,
	"statement_canonical" text NOT NULL,
	"canonical_record" text NOT NULL,
	"record_hash" text NOT NULL,
	"outbox_subject_id" uuid,
	CONSTRAINT "attesta_records_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_records_tenant_seq_key" UNIQUE("tenant_id","seq"),
	CONSTRAINT "attesta_records_tenant_statement_digest_key" UNIQUE("tenant_id","statement_digest"),
	CONSTRAINT "attesta_records_shape_check" CHECK (
    "attesta_records"."seq" >= 0
    and "attesta_records"."record_kind" = 'statement'
    and "attesta_records"."prev_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."record_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."predicate_type" = 'https://trackai.dev/attesta/ai-provenance/v1'
    and "attesta_records"."statement_kind" in ('commit_observed', 'pr_merged', 'deployed')
    and "attesta_records"."subject_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
  )
);
--> statement-breakpoint
CREATE TABLE "chain_head" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"next_seq" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_head_next_seq_check" CHECK ("chain_head"."next_seq" >= 0),
	CONSTRAINT "chain_head_head_hash_check" CHECK ("chain_head"."head_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "attesta_envelopes" ADD CONSTRAINT "attesta_envelopes_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_envelopes" ADD CONSTRAINT "attesta_envelopes_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_records" ADD CONSTRAINT "attesta_records_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_records" ADD CONSTRAINT "attesta_records_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_head" ADD CONSTRAINT "chain_head_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_records_tenant_outbox_subject_key" ON "attesta_records" USING btree ("tenant_id","outbox_subject_id") WHERE "attesta_records"."outbox_subject_id" is not null;--> statement-breakpoint
CREATE INDEX "attesta_records_tenant_subject_idx" ON "attesta_records" USING btree ("tenant_id","repository_id","subject_sha","seq");--> statement-breakpoint
ALTER TABLE "chain_head" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_envelopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Ledger guards (Task15d; design docs/contracts/attesta/tables.md). Ported from
-- SushiCorp EV-1 @ 0bd67a5 (db/migrations/versions/0001_initial_schema.py).
-- Every function is SECURITY DEFINER with a fixed search_path (AGENTS.md §9 item
-- 21): under RLS a trigger runs as the calling role and would see no chain_head
-- row; as definer it reads as the migration role. Tables are schema-qualified.
-- SQLSTATE ATH01 = the head moved (retryable, ATTESTA_LEDGER_HEAD_CONFLICT);
-- ATG01 = any other guard (terminal, ATTESTA_LEDGER_GUARD_VIOLATION).
-- Hashes use the built-in pg_catalog.sha256() (PostgreSQL 11+), not pgcrypto,
-- whose functions live outside pg_catalog on hosted PostgreSQL (Supabase).
CREATE OR REPLACE FUNCTION attesta_ledger_reject_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'attesta ledger: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'ATG01';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_records_append_only
  BEFORE UPDATE OR DELETE ON "attesta_records"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_records_no_truncate
  BEFORE TRUNCATE ON "attesta_records"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_envelopes_append_only
  BEFORE UPDATE OR DELETE ON "attesta_envelopes"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_envelopes_no_truncate
  BEFORE TRUNCATE ON "attesta_envelopes"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER chain_head_no_delete
  BEFORE DELETE ON "chain_head"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER chain_head_no_truncate
  BEFORE TRUNCATE ON "chain_head"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
-- A chain starts at seq 0 with the genesis hash and advances by exactly one,
-- only to the record_hash of the record stored at the old next_seq.
CREATE OR REPLACE FUNCTION chain_head_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_seq <> 0 OR NEW.head_hash <> 'sha256:' || repeat('0', 64) THEN
      RAISE EXCEPTION 'chain_head: a new chain must start at seq 0 with the genesis hash'
        USING ERRCODE = 'ATG01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'chain_head: tenant_id is immutable' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.next_seq IS DISTINCT FROM OLD.next_seq + 1 THEN
    RAISE EXCEPTION 'chain_head: next_seq may only advance by exactly 1 (% -> %)', OLD.next_seq, NEW.next_seq
      USING ERRCODE = 'ATG01';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.attesta_records r
    WHERE r.tenant_id = OLD.tenant_id AND r.seq = OLD.next_seq AND r.record_hash = NEW.head_hash
  ) THEN
    RAISE EXCEPTION 'chain_head: head_hash must be the record_hash of the record at seq %', OLD.next_seq
      USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chain_head_guard
  BEFORE INSERT OR UPDATE ON "chain_head"
  FOR EACH ROW EXECUTE FUNCTION chain_head_guard();
--> statement-breakpoint
-- Chain contiguity and hash integrity on every record insert. chainStatement
-- already holds the chain_head row lock; re-locking here is a no-op for it and
-- serializes any writer that bypassed it. The typed copies are compared with
-- the stored bytes parsed as jsonb; nothing is re-serialized.
CREATE OR REPLACE FUNCTION attesta_records_chain_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  head_next bigint;
  head_hash text;
  prev_recorded timestamptz;
  canon jsonb;
  stmt jsonb;
BEGIN
  SELECT h.next_seq, h.head_hash INTO head_next, head_hash
    FROM public.chain_head h WHERE h.tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_records: tenant has no chain_head row' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.seq <> head_next OR NEW.prev_hash <> head_hash THEN
    RAISE EXCEPTION 'attesta_records: seq % / prev_hash is not the chain head (next seq %)', NEW.seq, head_next
      USING ERRCODE = 'ATH01';
  END IF;
  IF NEW.record_hash <> 'sha256:' || encode(
       sha256(convert_to(NEW.canonical_record, 'UTF8') || convert_to(NEW.prev_hash, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'attesta_records: record_hash <> sha256(canonical_record || prev_hash) at seq %', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.statement_digest <> 'sha256:' || encode(sha256(convert_to(NEW.statement_canonical, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'attesta_records: statement_digest <> sha256(statement_canonical) at seq %', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  BEGIN
    canon := NEW.canonical_record::jsonb;
    stmt := NEW.statement_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'attesta_records: stored bytes are not JSON at seq %', NEW.seq USING ERRCODE = 'ATG01';
  END;
  IF jsonb_typeof(canon) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(canon) AS k) IS DISTINCT FROM ARRAY[
       'outbox_subject_id', 'predicate_type', 'prev_hash', 'record_kind', 'recorded_at', 'repository_id',
       'seq', 'statement_digest', 'statement_kind', 'subject_sha', 'tenant_id']::text[] THEN
    RAISE EXCEPTION 'attesta_records: canonical_record has the wrong fields at seq %', NEW.seq USING ERRCODE = 'ATG01';
  END IF;
  -- Millisecond precision only, so the column and the stored text are the same instant.
  IF date_trunc('milliseconds', NEW.recorded_at) <> NEW.recorded_at
     OR canon->'seq' IS DISTINCT FROM to_jsonb(NEW.seq)
     OR canon->'prev_hash' IS DISTINCT FROM to_jsonb(NEW.prev_hash)
     OR canon->'recorded_at' IS DISTINCT FROM
        to_jsonb(to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     OR canon->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
     OR canon->'record_kind' IS DISTINCT FROM to_jsonb(NEW.record_kind)
     OR canon->'statement_digest' IS DISTINCT FROM to_jsonb(NEW.statement_digest)
     OR canon->'predicate_type' IS DISTINCT FROM to_jsonb(NEW.predicate_type)
     OR canon->'statement_kind' IS DISTINCT FROM coalesce(to_jsonb(NEW.statement_kind), 'null'::jsonb)
     OR canon->'repository_id' IS DISTINCT FROM to_jsonb(NEW.repository_id::text)
     OR canon->'subject_sha' IS DISTINCT FROM coalesce(to_jsonb(NEW.subject_sha), 'null'::jsonb)
     OR canon->'outbox_subject_id' IS DISTINCT FROM coalesce(to_jsonb(NEW.outbox_subject_id::text), 'null'::jsonb) THEN
    RAISE EXCEPTION 'attesta_records: typed columns disagree with canonical_record at seq %', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  -- The typed copies must also be what the signed statement says (ai-provenance v1:
  -- one git-commit subject named after its repository).
  IF jsonb_typeof(stmt) <> 'object'
     OR jsonb_typeof(stmt->'subject') IS DISTINCT FROM 'array'
     OR jsonb_array_length(stmt->'subject') <> 1
     OR stmt->'predicateType' IS DISTINCT FROM to_jsonb(NEW.predicate_type)
     OR stmt->'predicate'->'statement_kind' IS DISTINCT FROM to_jsonb(NEW.statement_kind)
     OR stmt->'predicate'->'repository'->'id' IS DISTINCT FROM to_jsonb(NEW.repository_id::text)
     OR stmt->'subject'->0->'digest'->'gitCommit' IS DISTINCT FROM to_jsonb(NEW.subject_sha)
     OR stmt->'subject'->0->'name' IS DISTINCT FROM
        to_jsonb('trackai:repository/' || NEW.repository_id::text || '/commit/' || NEW.subject_sha) THEN
    RAISE EXCEPTION 'attesta_records: typed columns disagree with statement_canonical at seq %', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.seq > 0 THEN
    SELECT r.recorded_at INTO prev_recorded FROM public.attesta_records r
      WHERE r.tenant_id = NEW.tenant_id AND r.seq = NEW.seq - 1;
    IF NOT FOUND OR NEW.recorded_at < prev_recorded THEN
      RAISE EXCEPTION 'attesta_records: recorded_at goes backwards at seq %', NEW.seq USING ERRCODE = 'ATG01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_records_chain_guard
  BEFORE INSERT ON "attesta_records"
  FOR EACH ROW EXECUTE FUNCTION attesta_records_chain_guard();
--> statement-breakpoint
-- At COMMIT: the head was advanced past the record, and the record has its envelope.
CREATE OR REPLACE FUNCTION attesta_records_commit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chain_head h WHERE h.tenant_id = NEW.tenant_id AND h.next_seq > NEW.seq
  ) THEN
    RAISE EXCEPTION 'attesta_records: chain_head not advanced past seq % at commit', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.attesta_envelopes e WHERE e.tenant_id = NEW.tenant_id AND e.record_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'attesta_records: record at seq % has no envelope at commit', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attesta_records_commit_guard
  AFTER INSERT ON "attesta_records"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attesta_records_commit_guard();
--> statement-breakpoint
-- The envelope signs exactly the record's statement bytes, with the stored keyid
-- and signature, in the one shape auditors receive.
CREATE OR REPLACE FUNCTION attesta_envelopes_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  stmt text;
  sig jsonb;
BEGIN
  SELECT r.statement_canonical INTO stmt FROM public.attesta_records r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_envelopes: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  sig := NEW.envelope->'signatures'->0;
  IF jsonb_typeof(NEW.envelope) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW.envelope) AS k)
        IS DISTINCT FROM ARRAY['payload', 'payloadType', 'signatures']::text[]
     OR NEW.envelope->'payloadType' IS DISTINCT FROM to_jsonb(NEW.payload_type)
     OR jsonb_typeof(NEW.envelope->'payload') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.envelope->'signatures') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.envelope->'signatures') <> 1
     OR jsonb_typeof(sig) IS DISTINCT FROM 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(sig) AS k) IS DISTINCT FROM ARRAY['keyid', 'sig']::text[]
     OR sig->'keyid' IS DISTINCT FROM to_jsonb(NEW.keyid)
     OR jsonb_typeof(sig->'sig') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'attesta_envelopes: malformed envelope for record %', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  -- Strict base64 (PostgreSQL's decode() tolerates whitespace; verifiers do not).
  IF NEW.envelope->>'payload' !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
     OR sig->>'sig' !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
     OR decode(sig->>'sig', 'base64') <> NEW.signature_der
     OR decode(NEW.envelope->>'payload', 'base64') <> convert_to(stmt, 'UTF8') THEN
    RAISE EXCEPTION 'attesta_envelopes: envelope does not carry the record''s statement and signature (record %)', NEW.record_id
      USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_envelopes_guard
  BEFORE INSERT ON "attesta_envelopes"
  FOR EACH ROW EXECUTE FUNCTION attesta_envelopes_guard();
