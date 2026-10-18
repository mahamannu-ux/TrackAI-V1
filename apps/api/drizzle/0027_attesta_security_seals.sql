CREATE TABLE "attesta_security_finding_seals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"window_from" text NOT NULL,
	"window_to" text NOT NULL,
	"row_count" integer NOT NULL,
	"task6a_count" integer NOT NULL,
	"v2_count" integer NOT NULL,
	"previous_digest" text,
	"seal_document" text NOT NULL,
	"seal_digest" text NOT NULL,
	"record_id" uuid NOT NULL,
	"statement_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_security_finding_seals_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_security_finding_seals_tenant_window_from_key" UNIQUE("tenant_id","window_from"),
	CONSTRAINT "attesta_security_finding_seals_tenant_seal_digest_key" UNIQUE("tenant_id","seal_digest"),
	CONSTRAINT "attesta_security_finding_seals_tenant_record_key" UNIQUE("tenant_id","record_id"),
	CONSTRAINT "attesta_security_finding_seals_shape_check" CHECK (
    "attesta_security_finding_seals"."window_from" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    and "attesta_security_finding_seals"."window_to" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    and "attesta_security_finding_seals"."window_from" < "attesta_security_finding_seals"."window_to"
    and "attesta_security_finding_seals"."row_count" between 0 and 8000
    and "attesta_security_finding_seals"."task6a_count" >= 0 and "attesta_security_finding_seals"."v2_count" >= 0
    and "attesta_security_finding_seals"."task6a_count" + "attesta_security_finding_seals"."v2_count" = "attesta_security_finding_seals"."row_count"
    and "attesta_security_finding_seals"."seal_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_security_finding_seals"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
    and ("attesta_security_finding_seals"."previous_digest" is null or "attesta_security_finding_seals"."previous_digest" ~ '^sha256:[0-9a-f]{64}$')
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_security_period_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repository_id" uuid,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"report_document" text NOT NULL,
	"report_digest" text NOT NULL,
	"record_id" uuid NOT NULL,
	"statement_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_security_period_reports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_security_period_reports_tenant_report_digest_key" UNIQUE("tenant_id","report_digest"),
	CONSTRAINT "attesta_security_period_reports_tenant_record_key" UNIQUE("tenant_id","record_id"),
	CONSTRAINT "attesta_security_period_reports_shape_check" CHECK (
    "attesta_security_period_reports"."period_from" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and "attesta_security_period_reports"."period_to" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and "attesta_security_period_reports"."period_from" < "attesta_security_period_reports"."period_to"
    and "attesta_security_period_reports"."report_digest" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_security_period_reports"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_records" DROP CONSTRAINT "attesta_records_shape_check";--> statement-breakpoint
ALTER TABLE "attesta_security_finding_seals" ADD CONSTRAINT "attesta_security_finding_seals_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_security_finding_seals" ADD CONSTRAINT "attesta_security_finding_seals_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_security_period_reports" ADD CONSTRAINT "attesta_security_period_reports_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_security_period_reports" ADD CONSTRAINT "attesta_security_period_reports_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_security_period_reports" ADD CONSTRAINT "attesta_security_period_reports_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_security_finding_seals_tenant_first_key" ON "attesta_security_finding_seals" USING btree ("tenant_id") WHERE "attesta_security_finding_seals"."previous_digest" is null;--> statement-breakpoint
CREATE INDEX "attesta_security_finding_seals_tenant_window_to_idx" ON "attesta_security_finding_seals" USING btree ("tenant_id","window_to");--> statement-breakpoint
CREATE INDEX "attesta_security_period_reports_tenant_period_idx" ON "attesta_security_period_reports" USING btree ("tenant_id","period_from","period_to");--> statement-breakpoint
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
      or
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/security-findings-seal/v1'
        and "attesta_records"."repository_id" is null
        and "attesta_records"."statement_kind" is null
        and "attesta_records"."subject_sha" is null
        and "attesta_records"."outbox_subject_id" is null)
      or
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/security-period-report/v1'
        and "attesta_records"."statement_kind" is null
        and "attesta_records"."subject_sha" is null
        and "attesta_records"."outbox_subject_id" is null)
    )
  );--> statement-breakpoint
ALTER TABLE "attesta_security_finding_seals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_security_period_reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Task15op (A15.15, A15.16; docs/contracts/attesta/security-findings-seal.md,
-- security-period-report.md): two more predicate types in the ledger. 0017, 0022 and 0023
-- are never edited: the chain guard is replaced here with CREATE OR REPLACE, keeping the
-- three earlier arms byte for byte and adding one arm per new type; the shape check above
-- was dropped and re-added with the two new arms. canonical_record is the 0023 expression
-- (JSON null for an empty repository_id), so earlier records are unaffected.
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
  -- the columns a period_report, an audit_seal, a security seal or a tenant-scoped security
  -- report leaves empty: the 0023 expression, unchanged.
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
    -- Task16e (0023), unchanged. jsonb_typeof checks come first in OR order, so ->> below only reads strings.
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
  ELSIF NEW.predicate_type = 'https://trackai.dev/attesta/security-findings-seal/v1' THEN
    -- Task15op: the audit_seal arm for a tenant's window of security-finding rows.
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
          to_jsonb('trackai:tenant/' || NEW.tenant_id::text || '/security-findings/'
            || (stmt->'predicate'->'window'->>'from') || '..' || (stmt->'predicate'->'window'->>'to')) THEN
      RAISE EXCEPTION 'attesta_records: typed columns disagree with statement_canonical at seq %', NEW.seq
        USING ERRCODE = 'ATG01';
    END IF;
  ELSIF NEW.predicate_type = 'https://trackai.dev/attesta/security-period-report/v1' THEN
    -- Task15op: tenant scope (repository_id null) or one repository; the subject names both.
    IF NEW.statement_kind IS NOT NULL OR NEW.subject_sha IS NOT NULL OR NEW.outbox_subject_id IS NOT NULL
       OR jsonb_typeof(stmt) <> 'object'
       OR jsonb_typeof(stmt->'subject') IS DISTINCT FROM 'array'
       OR jsonb_array_length(stmt->'subject') <> 1
       OR stmt->'predicateType' IS DISTINCT FROM to_jsonb(NEW.predicate_type)
       OR stmt->'predicate'->'statement_kind' IS NOT NULL
       OR stmt->'predicate'->'scope'->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
       OR stmt->'predicate'->'scope'->'repository_id' IS DISTINCT FROM
          coalesce(to_jsonb(NEW.repository_id::text), 'null'::jsonb)
       OR jsonb_typeof(stmt->'predicate'->'scope'->'from') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'predicate'->'scope'->'to') IS DISTINCT FROM 'string'
       OR jsonb_typeof(stmt->'subject'->0->'digest') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(stmt->'subject'->0->'digest') AS k)
          IS DISTINCT FROM ARRAY['sha256']::text[]
       OR jsonb_typeof(stmt->'subject'->0->'digest'->'sha256') IS DISTINCT FROM 'string'
       OR (stmt->'subject'->0->'digest'->>'sha256') !~ '^[0-9a-f]{64}$'
       OR stmt->'subject'->0->'name' IS DISTINCT FROM
          to_jsonb('trackai:tenant/' || NEW.tenant_id::text
            || CASE WHEN NEW.repository_id IS NULL THEN '' ELSE '/repository/' || NEW.repository_id::text END
            || '/security-period/'
            || (stmt->'predicate'->'scope'->>'from') || '..' || (stmt->'predicate'->'scope'->>'to')) THEN
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
-- security_findings refuses TRUNCATE too (0013 guards UPDATE and DELETE only; founder
-- checkpoint 2026-10-18, as 0023 did for the audit trail). A statement-level trigger.
CREATE OR REPLACE FUNCTION security_findings_reject_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'security_findings are append-only (TRUNCATE is not allowed)' USING ERRCODE = 'ATG01';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_findings_no_truncate
  BEFORE TRUNCATE ON "security_findings"
  FOR EACH STATEMENT EXECUTE FUNCTION security_findings_reject_truncate();
--> statement-breakpoint
-- Security-finding seals: append-only from their insert, in the ledger transaction that
-- chains the seal's statement. The insert guard checks the document against the columns,
-- the record against the document, and the previous link against the tenant's latest seal,
-- under a per-tenant lock, so windows stay contiguous and each is sealed once (0023 pattern).
CREATE TRIGGER attesta_security_finding_seals_append_only
  BEFORE UPDATE OR DELETE ON "attesta_security_finding_seals"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_security_finding_seals_no_truncate
  BEFORE TRUNCATE ON "attesta_security_finding_seals"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_security_finding_seals_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc jsonb;
  rec record;
  stmt jsonb;
  last_digest text;
  last_to text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_security_finding_seals:' || NEW.tenant_id::text, 0));
  IF NEW.seal_digest <> 'sha256:' || encode(sha256(convert_to(NEW.seal_document, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: seal_digest <> sha256(seal_document)' USING ERRCODE = 'ATG01';
  END IF;
  BEGIN
    doc := NEW.seal_document::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: seal_document is not JSON' USING ERRCODE = 'ATG01';
  END;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object'
     OR doc->'format' IS DISTINCT FROM to_jsonb('https://trackai.dev/attesta/security-findings-seal-document/v1'::text)
     OR doc->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
     OR doc->'window'->'from' IS DISTINCT FROM to_jsonb(NEW.window_from)
     OR doc->'window'->'to' IS DISTINCT FROM to_jsonb(NEW.window_to)
     OR doc->'count' IS DISTINCT FROM to_jsonb(NEW.row_count)
     OR doc->'generations'->'task6a' IS DISTINCT FROM to_jsonb(NEW.task6a_count)
     OR doc->'generations'->'v2' IS DISTINCT FROM to_jsonb(NEW.v2_count)
     OR jsonb_typeof(doc->'rows') IS DISTINCT FROM 'array'
     OR jsonb_array_length(doc->'rows') <> NEW.row_count
     OR doc->'previous' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_digest), 'null'::jsonb) THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: the columns disagree with seal_document' USING ERRCODE = 'ATG01';
  END IF;
  SELECT r.predicate_type, r.statement_digest, r.statement_canonical INTO rec
    FROM public.attesta_records r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  stmt := rec.statement_canonical::jsonb;
  IF rec.predicate_type <> 'https://trackai.dev/attesta/security-findings-seal/v1'
     OR rec.statement_digest <> NEW.statement_digest
     OR stmt->'subject'->0->'digest'->'sha256' IS DISTINCT FROM to_jsonb(substr(NEW.seal_digest, 8))
     OR stmt->'predicate'->'window' IS DISTINCT FROM doc->'window'
     OR stmt->'predicate'->'count' IS DISTINCT FROM doc->'count'
     OR stmt->'predicate'->'generations' IS DISTINCT FROM doc->'generations'
     OR stmt->'predicate'->'rows_root' IS DISTINCT FROM doc->'rows_root'
     OR stmt->'predicate'->'previous_seal' IS DISTINCT FROM doc->'previous' THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: the record is not this seal''s statement' USING ERRCODE = 'ATG01';
  END IF;
  SELECT s.seal_digest, s.window_to INTO last_digest, last_to FROM public.attesta_security_finding_seals s
    WHERE s.tenant_id = NEW.tenant_id ORDER BY s.window_to DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.previous_digest IS NOT NULL THEN
      RAISE EXCEPTION 'attesta_security_finding_seals: the first seal has no previous' USING ERRCODE = 'ATG01';
    END IF;
  ELSIF NEW.previous_digest IS DISTINCT FROM last_digest OR NEW.window_from <> last_to THEN
    RAISE EXCEPTION 'attesta_security_finding_seals: a seal must follow the tenant''s latest seal' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_security_finding_seals_insert_guard
  BEFORE INSERT ON "attesta_security_finding_seals"
  FOR EACH ROW EXECUTE FUNCTION attesta_security_finding_seals_insert_guard();
--> statement-breakpoint
-- Security period reports: append-only; the insert guard ties the row to its document and
-- to the chained statement that names it (the builder lands in Task15op-b).
CREATE TRIGGER attesta_security_period_reports_append_only
  BEFORE UPDATE OR DELETE ON "attesta_security_period_reports"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_security_period_reports_no_truncate
  BEFORE TRUNCATE ON "attesta_security_period_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_security_period_reports_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc jsonb;
  rec record;
  stmt jsonb;
BEGIN
  IF NEW.report_digest <> 'sha256:' || encode(sha256(convert_to(NEW.report_document, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'attesta_security_period_reports: report_digest <> sha256(report_document)' USING ERRCODE = 'ATG01';
  END IF;
  BEGIN
    doc := NEW.report_document::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'attesta_security_period_reports: report_document is not JSON' USING ERRCODE = 'ATG01';
  END;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object'
     OR doc->'format' IS DISTINCT FROM to_jsonb('https://trackai.dev/attesta/security-period-report-document/v1'::text)
     OR doc->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
     OR doc->'scope'->'tenant_id' IS DISTINCT FROM to_jsonb(NEW.tenant_id::text)
     OR doc->'scope'->'repository_id' IS DISTINCT FROM coalesce(to_jsonb(NEW.repository_id::text), 'null'::jsonb)
     OR doc->'scope'->'from' IS DISTINCT FROM to_jsonb(NEW.period_from)
     OR doc->'scope'->'to' IS DISTINCT FROM to_jsonb(NEW.period_to) THEN
    RAISE EXCEPTION 'attesta_security_period_reports: the columns disagree with report_document' USING ERRCODE = 'ATG01';
  END IF;
  SELECT r.predicate_type, r.statement_digest, r.statement_canonical, r.repository_id INTO rec
    FROM public.attesta_records r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_security_period_reports: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  stmt := rec.statement_canonical::jsonb;
  IF rec.predicate_type <> 'https://trackai.dev/attesta/security-period-report/v1'
     OR rec.statement_digest <> NEW.statement_digest
     OR rec.repository_id IS DISTINCT FROM NEW.repository_id
     OR stmt->'subject'->0->'digest'->'sha256' IS DISTINCT FROM to_jsonb(substr(NEW.report_digest, 8))
     OR stmt->'predicate'->'scope' IS DISTINCT FROM doc->'scope' THEN
    RAISE EXCEPTION 'attesta_security_period_reports: the record is not this report''s statement' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_security_period_reports_insert_guard
  BEFORE INSERT ON "attesta_security_period_reports"
  FOR EACH ROW EXECUTE FUNCTION attesta_security_period_reports_insert_guard();
