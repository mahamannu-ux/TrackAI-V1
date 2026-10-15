CREATE TABLE "attesta_audit_seals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"row_count" integer NOT NULL,
	"previous_digest" text,
	"seal_document" text NOT NULL,
	"seal_digest" text NOT NULL,
	"record_id" uuid NOT NULL,
	"statement_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_audit_seals_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_audit_seals_tenant_window_from_key" UNIQUE("tenant_id","window_from"),
	CONSTRAINT "attesta_audit_seals_tenant_seal_digest_key" UNIQUE("tenant_id","seal_digest"),
	CONSTRAINT "attesta_audit_seals_tenant_record_key" UNIQUE("tenant_id","record_id"),
	CONSTRAINT "attesta_audit_seals_shape_check" CHECK (
    "attesta_audit_seals"."window_from" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    and "attesta_audit_seals"."window_to" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    and "attesta_audit_seals"."window_from" < "attesta_audit_seals"."window_to"
    and "attesta_audit_seals"."row_count" between 0 and 50000
    and "attesta_audit_seals"."seal_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_audit_seals"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
    and ("attesta_audit_seals"."previous_digest" is null or "attesta_audit_seals"."previous_digest" ~ '^sha256:[0-9a-f]{64}$')
  )
);
--> statement-breakpoint
CREATE TABLE "audit_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" text NOT NULL,
	"request_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"export_digest" text,
	"storage_reference" text,
	"bytes" bigint,
	"counts" jsonb,
	"signature_envelope" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "audit_exports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "audit_exports_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "audit_exports_shape_check" CHECK (
    "audit_exports"."idempotency_key" ~ '^[A-Za-z0-9._-]{8,64}$'
    and "audit_exports"."status" in ('queued', 'running', 'ready', 'failed')
    and length("audit_exports"."requested_by") between 1 and 256
    and length("audit_exports"."request_id") between 1 and 128
    and "audit_exports"."attempts" >= 0
    and jsonb_typeof("audit_exports"."scope") = 'object'
    and ("audit_exports"."status" = 'running') = ("audit_exports"."lease_until" is not null)
    and ("audit_exports"."status" = 'ready') = ("audit_exports"."export_digest" is not null)
    and ("audit_exports"."status" = 'ready') = ("audit_exports"."storage_reference" is not null)
    and ("audit_exports"."status" = 'ready') = ("audit_exports"."bytes" is not null)
    and ("audit_exports"."status" = 'ready') = ("audit_exports"."signature_envelope" is not null)
    and ("audit_exports"."status" = 'ready') = ("audit_exports"."counts" is not null)
    and ("audit_exports"."status" = 'failed') = ("audit_exports"."error_code" is not null)
    and ("audit_exports"."status" in ('ready', 'failed')) = ("audit_exports"."finished_at" is not null)
    and ("audit_exports"."export_digest" is null or "audit_exports"."export_digest" ~ '^sha256:[0-9a-f]{64}$')
    and ("audit_exports"."error_code" is null or "audit_exports"."error_code" ~ '^AUDIT_[A-Z0-9_]{1,64}$')
    and ("audit_exports"."bytes" is null or "audit_exports"."bytes" > 0)
    and ("audit_exports"."storage_reference" is null or length("audit_exports"."storage_reference") between 1 and 512)
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_records" DROP CONSTRAINT "attesta_records_shape_check";--> statement-breakpoint
ALTER TABLE "attesta_records" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attesta_audit_seals" ADD CONSTRAINT "attesta_audit_seals_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_audit_seals" ADD CONSTRAINT "attesta_audit_seals_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_exports" ADD CONSTRAINT "audit_exports_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_audit_seals_tenant_first_key" ON "attesta_audit_seals" USING btree ("tenant_id") WHERE "attesta_audit_seals"."previous_digest" is null;--> statement-breakpoint
CREATE INDEX "attesta_audit_seals_tenant_window_to_idx" ON "attesta_audit_seals" USING btree ("tenant_id","window_to");--> statement-breakpoint
CREATE INDEX "audit_exports_tenant_status_idx" ON "audit_exports" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "attesta_records" ADD CONSTRAINT "attesta_records_shape_check" CHECK (
    "attesta_records"."seq" >= 0
    and "attesta_records"."record_kind" = 'statement'
    and "attesta_records"."prev_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."record_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
    and (
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/ai-provenance/v1'
        and "attesta_records"."repository_id" is not null
        and "attesta_records"."statement_kind" is not null
        and "attesta_records"."statement_kind" in ('commit_observed', 'pr_merged', 'deployed')
        and "attesta_records"."subject_sha" is not null
        and "attesta_records"."subject_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
      or
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/period-report/v1'
        and "attesta_records"."repository_id" is not null
        and "attesta_records"."statement_kind" is null
        and "attesta_records"."subject_sha" is null
        and "attesta_records"."outbox_subject_id" is null)
      or
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/audit-seal/v1'
        and "attesta_records"."repository_id" is null
        and "attesta_records"."statement_kind" is null
        and "attesta_records"."subject_sha" is null
        and "attesta_records"."outbox_subject_id" is null)
    )
  );--> statement-breakpoint
ALTER TABLE "attesta_audit_seals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_exports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Task16e (A16.4; docs/contracts/attesta/audit-seal.md): a third predicate type in the
-- ledger, whose subject is a tenant's audit window, so it names no repository. 0017 and
-- 0022 are never edited: the chain guard is replaced here with CREATE OR REPLACE, and the
-- shape check above was dropped and re-added with repository_id required for the two
-- earlier types (the column is nullable only for audit_seal). For ai-provenance and
-- period_report records every 0022 condition holds byte for byte: their repository_id is
-- NOT NULL by the shape check, so the canonical_record string below is the 0022 string
-- (the IT-T15d and IT-T15i4 regressions prove it). An audit_seal record has repository_id,
-- statement_kind, subject_sha and outbox_subject_id null, and one subject named
-- trackai:tenant/<tenant_id>/audit/<from>..<to> after its predicate's tenant and window,
-- with a sha256 digest (the seal document's).
-- SECURITY DEFINER, search_path pg_catalog, pg_temp, tables schema-qualified, ERRCODE
-- ATH01 (head moved) / ATG01 (any other guard), as in 0017 (AGENTS.md §9 item 21).
CREATE OR REPLACE FUNCTION attesta_records_chain_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head_next bigint;
  head_hash text;
  prev_recorded timestamptz;
  expected text;
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
  IF date_trunc('milliseconds', NEW.recorded_at) <> NEW.recorded_at THEN
    RAISE EXCEPTION 'attesta_records: recorded_at must have millisecond precision (seq %)', NEW.seq
      USING ERRCODE = 'ATG01';
  END IF;
  -- canonical_record = the RFC 8785 bytes of the typed columns (0017), with JSON null for
  -- the columns a period_report or an audit_seal leaves empty. For a record with a
  -- repository (the shape check requires one for both earlier types) this is the 0022 string.
  expected := '{"outbox_subject_id":'
    || CASE WHEN NEW.outbox_subject_id IS NULL THEN 'null' ELSE '"' || NEW.outbox_subject_id::text || '"' END
    || ',"predicate_type":"' || NEW.predicate_type
    || '","prev_hash":"' || NEW.prev_hash
    || '","record_kind":"' || NEW.record_kind
    || '","recorded_at":"' || to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    || '","repository_id":' || CASE WHEN NEW.repository_id IS NULL THEN 'null' ELSE '"' || NEW.repository_id::text || '"' END
    || ',"seq":' || NEW.seq::text
    || ',"statement_digest":"' || NEW.statement_digest
    || '","statement_kind":' || CASE WHEN NEW.statement_kind IS NULL THEN 'null' ELSE '"' || NEW.statement_kind || '"' END
    || ',"subject_sha":' || CASE WHEN NEW.subject_sha IS NULL THEN 'null' ELSE '"' || NEW.subject_sha || '"' END
    || ',"tenant_id":"' || NEW.tenant_id::text || '"}';
  IF expected IS NULL OR NEW.canonical_record IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'attesta_records: canonical_record is not the canonical form of the typed columns at seq %', NEW.seq
      USING ERRCODE = 'ATG01';
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
    stmt := NEW.statement_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'attesta_records: statement_canonical is not JSON at seq %', NEW.seq USING ERRCODE = 'ATG01';
  END;
  IF NEW.predicate_type = 'https://trackai.dev/attesta/ai-provenance/v1' THEN
    -- 0017, unchanged.
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
  ELSIF NEW.predicate_type = 'https://trackai.dev/attesta/period-report/v1' THEN
    -- 0022, unchanged.
    IF NEW.statement_kind IS NOT NULL OR NEW.subject_sha IS NOT NULL OR NEW.outbox_subject_id IS NOT NULL
       OR jsonb_typeof(stmt) <> 'object'
       OR jsonb_typeof(stmt->'subject') IS DISTINCT FROM 'array'
       OR jsonb_array_length(stmt->'subject') <> 1
       OR stmt->'predicateType' IS DISTINCT FROM to_jsonb(NEW.predicate_type)
       OR stmt->'predicate'->'statement_kind' IS NOT NULL
       OR stmt->'predicate'->'scope'->'repository_id' IS DISTINCT FROM to_jsonb(NEW.repository_id::text)
       OR jsonb_typeof(stmt->'predicate'->'scope'->'from') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'predicate'->'scope'->'to') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'subject'->0->'digest') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(stmt->'subject'->0->'digest') AS k)
          IS DISTINCT FROM ARRAY['sha256']::text[]
       OR jsonb_typeof(stmt->'subject'->0->'digest'->'sha256') IS DISTINCT FROM 'string'
       OR (stmt->'subject'->0->'digest'->>'sha256') !~ '^[0-9a-f]{64}$'
       OR stmt->'subject'->0->'name' IS DISTINCT FROM
          to_jsonb('trackai:repository/' || NEW.repository_id::text || '/period/'
            || (stmt->'predicate'->'scope'->>'from') || '..' || (stmt->'predicate'->'scope'->>'to')) THEN
      RAISE EXCEPTION 'attesta_records: typed columns disagree with statement_canonical at seq %', NEW.seq
        USING ERRCODE = 'ATG01';
    END IF;
  ELSIF NEW.predicate_type = 'https://trackai.dev/attesta/audit-seal/v1' THEN
    -- Task16e. jsonb_typeof checks come first in OR order, so ->> below only reads strings.
    IF NEW.repository_id IS NOT NULL OR NEW.statement_kind IS NOT NULL OR NEW.subject_sha IS NOT NULL
       OR NEW.outbox_subject_id IS NOT NULL
       OR jsonb_typeof(stmt) <> 'object'
       OR jsonb_typeof(stmt->'subject') IS DISTINCT FROM 'array'
       OR jsonb_array_length(stmt->'subject') <> 1
       OR stmt->'predicateType' IS DISTINCT FROM to_jsonb(NEW.predicate_type)
       OR stmt->'predicate'->'statement_kind' IS NOT NULL
       OR stmt->'predicate'->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
       OR jsonb_typeof(stmt->'predicate'->'window'->'from') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'predicate'->'window'->'to') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'subject'->0->'digest') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(stmt->'subject'->0->'digest') AS k)
          IS DISTINCT FROM ARRAY['sha256']::text[]
       OR jsonb_typeof(stmt->'subject'->0->'digest'->'sha256') IS DISTINCT FROM 'string'
       OR (stmt->'subject'->0->'digest'->>'sha256') !~ '^[0-9a-f]{64}$'
       OR stmt->'subject'->0->'name' IS DISTINCT FROM
          to_jsonb('trackai:tenant/' || NEW.tenant_id::text || '/audit/'
            || (stmt->'predicate'->'window'->>'from') || '..' || (stmt->'predicate'->'window'->>'to')) THEN
      RAISE EXCEPTION 'attesta_records: typed columns disagree with statement_canonical at seq %', NEW.seq
        USING ERRCODE = 'ATG01';
    END IF;
  ELSE
    RAISE EXCEPTION 'attesta_records: unknown predicate type at seq %', NEW.seq USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.outbox_subject_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.attesta_subjects o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outbox_subject_id
  ) THEN
    RAISE EXCEPTION 'attesta_records: outbox subject is not in this tenant (seq %)', NEW.seq USING ERRCODE = 'ATG01';
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
-- The audit trail refuses TRUNCATE too (0003 guards UPDATE and DELETE only; AGENTS.md §9
-- item 21). A statement-level trigger cannot be bypassed by a row-level policy.
CREATE OR REPLACE FUNCTION security_audit_events_reject_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_events are append-only (TRUNCATE is not allowed)' USING ERRCODE = 'ATG01';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_audit_events_no_truncate
  BEFORE TRUNCATE ON "security_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION security_audit_events_reject_truncate();
--> statement-breakpoint
-- Audit seals: append-only from their insert, which happens in the ledger transaction that
-- chains the seal's statement. The insert guard checks the document against the columns,
-- the record against the document, and the previous link against the tenant's latest seal,
-- under a per-tenant lock, so windows stay contiguous and each is sealed once.
CREATE TRIGGER attesta_audit_seals_append_only
  BEFORE UPDATE OR DELETE ON "attesta_audit_seals"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_audit_seals_no_truncate
  BEFORE TRUNCATE ON "attesta_audit_seals"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_audit_seals_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc jsonb;
  rec record;
  stmt jsonb;
  last_digest text;
  last_to text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_audit_seals:' || NEW.tenant_id::text, 0));
  IF NEW.seal_digest <> 'sha256:' || encode(sha256(convert_to(NEW.seal_document, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'attesta_audit_seals: seal_digest <> sha256(seal_document)' USING ERRCODE = 'ATG01';
  END IF;
  BEGIN
    doc := NEW.seal_document::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'attesta_audit_seals: seal_document is not JSON' USING ERRCODE = 'ATG01';
  END;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object'
     OR doc->'format' IS DISTINCT FROM to_jsonb('https://trackai.dev/attesta/audit-seal-document/v1'::text)
     OR doc->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
     OR doc->'window'->'from' IS DISTINCT FROM to_jsonb(NEW.window_from)
     OR doc->'window'->'to' IS DISTINCT FROM to_jsonb(NEW.window_to)
     OR doc->'count' IS DISTINCT FROM to_jsonb(NEW.row_count)
     OR jsonb_typeof(doc->'rows') IS DISTINCT FROM 'array'
     OR jsonb_array_length(doc->'rows') <> NEW.row_count
     OR doc->'previous' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_digest), 'null'::jsonb) THEN
    RAISE EXCEPTION 'attesta_audit_seals: the columns disagree with seal_document' USING ERRCODE = 'ATG01';
  END IF;
  SELECT r.predicate_type, r.statement_digest, r.statement_canonical INTO rec
    FROM public.attesta_records r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_audit_seals: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  stmt := rec.statement_canonical::jsonb;
  IF rec.predicate_type <> 'https://trackai.dev/attesta/audit-seal/v1'
     OR rec.statement_digest <> NEW.statement_digest
     OR stmt->'subject'->0->'digest'->'sha256' IS DISTINCT FROM to_jsonb(substr(NEW.seal_digest, 8))
     OR stmt->'predicate'->'window' IS DISTINCT FROM doc->'window'
     OR stmt->'predicate'->'previous_seal' IS DISTINCT FROM doc->'previous' THEN
    RAISE EXCEPTION 'attesta_audit_seals: the record is not this seal''s statement' USING ERRCODE = 'ATG01';
  END IF;
  SELECT s.seal_digest, s.window_to INTO last_digest, last_to FROM public.attesta_audit_seals s
    WHERE s.tenant_id = NEW.tenant_id ORDER BY s.window_to DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.previous_digest IS NOT NULL THEN
      RAISE EXCEPTION 'attesta_audit_seals: the first seal has no previous' USING ERRCODE = 'ATG01';
    END IF;
  ELSIF NEW.previous_digest IS DISTINCT FROM last_digest OR NEW.window_from <> last_to THEN
    RAISE EXCEPTION 'attesta_audit_seals: a seal must follow the tenant''s latest seal' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_audit_seals_insert_guard
  BEFORE INSERT ON "attesta_audit_seals"
  FOR EACH ROW EXECUTE FUNCTION attesta_audit_seals_insert_guard();
--> statement-breakpoint
-- Audit export jobs (A16.7; docs/contracts/audit/export.md): the 0020 evidence-pack job
-- guards, for this table.
CREATE TRIGGER audit_exports_no_delete
  BEFORE DELETE ON "audit_exports"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_exports_no_truncate
  BEFORE TRUNCATE ON "audit_exports"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_exports_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'audit_exports: a new job starts queued with no attempts' USING ERRCODE = 'ATG01';
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW.scope) AS k) IS DISTINCT FROM ARRAY['from', 'to']::text[]
     OR jsonb_typeof(NEW.scope->'from') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.scope->'to') IS DISTINCT FROM 'string'
     OR (NEW.scope->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     OR (NEW.scope->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     OR (NEW.scope->>'from') >= (NEW.scope->>'to') THEN
    RAISE EXCEPTION 'audit_exports: scope must be {from, to} with ms UTC bounds, from < to' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_exports_insert_guard
  BEFORE INSERT ON "audit_exports"
  FOR EACH ROW EXECUTE FUNCTION audit_exports_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_exports_update_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'audit_exports: identity columns never change' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'audit_exports: a finished job is final' USING ERRCODE = 'ATG01';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status IN ('running', 'ready', 'failed'))) THEN
    RAISE EXCEPTION 'audit_exports: status moves only forward' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.attempts < OLD.attempts
     OR (NEW.status = 'running' AND NEW.attempts <> OLD.attempts + 1) THEN
    RAISE EXCEPTION 'audit_exports: a claim counts one attempt' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'running' AND OLD.lease_until > now() THEN
    RAISE EXCEPTION 'audit_exports: a live lease cannot be taken' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_exports_update_guard
  BEFORE UPDATE ON "audit_exports"
  FOR EACH ROW EXECUTE FUNCTION audit_exports_update_guard();
