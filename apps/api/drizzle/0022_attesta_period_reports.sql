CREATE TABLE "attesta_period_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" text NOT NULL,
	"request_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"report_document" text,
	"report_digest" text,
	"record_id" uuid,
	"statement_digest" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "attesta_period_reports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_period_reports_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "attesta_period_reports_tenant_record_key" UNIQUE("tenant_id","record_id"),
	CONSTRAINT "attesta_period_reports_shape_check" CHECK (
    "attesta_period_reports"."idempotency_key" ~ '^[A-Za-z0-9._-]{8,64}$'
    and "attesta_period_reports"."status" in ('queued', 'running', 'ready', 'failed')
    and length("attesta_period_reports"."requested_by") between 1 and 256
    and length("attesta_period_reports"."request_id") between 1 and 128
    and "attesta_period_reports"."attempts" >= 0
    and jsonb_typeof("attesta_period_reports"."scope") = 'object'
    and ("attesta_period_reports"."status" = 'running') = ("attesta_period_reports"."lease_until" is not null)
    and ("attesta_period_reports"."status" = 'ready') = ("attesta_period_reports"."report_document" is not null)
    and ("attesta_period_reports"."status" = 'ready') = ("attesta_period_reports"."report_digest" is not null)
    and ("attesta_period_reports"."status" = 'ready') = ("attesta_period_reports"."record_id" is not null)
    and ("attesta_period_reports"."status" = 'ready') = ("attesta_period_reports"."statement_digest" is not null)
    and ("attesta_period_reports"."status" = 'failed') = ("attesta_period_reports"."error_code" is not null)
    and ("attesta_period_reports"."status" in ('ready', 'failed')) = ("attesta_period_reports"."finished_at" is not null)
    and ("attesta_period_reports"."report_digest" is null or "attesta_period_reports"."report_digest" ~ '^sha256:[0-9a-f]{64}$')
    and ("attesta_period_reports"."statement_digest" is null or "attesta_period_reports"."statement_digest" ~ '^sha256:[0-9a-f]{64}$')
    and ("attesta_period_reports"."error_code" is null or "attesta_period_reports"."error_code" ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_records" DROP CONSTRAINT "attesta_records_shape_check";--> statement-breakpoint
ALTER TABLE "attesta_period_reports" ADD CONSTRAINT "attesta_period_reports_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_period_reports" ADD CONSTRAINT "attesta_period_reports_tenant_repository_fk" FOREIGN KEY ("tenant_id","repository_id") REFERENCES "public"."scm_repositories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_period_reports" ADD CONSTRAINT "attesta_period_reports_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attesta_period_reports_tenant_status_idx" ON "attesta_period_reports" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "attesta_records" ADD CONSTRAINT "attesta_records_shape_check" CHECK (
    "attesta_records"."seq" >= 0
    and "attesta_records"."record_kind" = 'statement'
    and "attesta_records"."prev_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."record_hash" ~ '^sha256:[0-9a-f]{64}$'
    and "attesta_records"."statement_digest" ~ '^sha256:[0-9a-f]{64}$'
    and (
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/ai-provenance/v1'
        and "attesta_records"."statement_kind" is not null
        and "attesta_records"."statement_kind" in ('commit_observed', 'pr_merged', 'deployed')
        and "attesta_records"."subject_sha" is not null
        and "attesta_records"."subject_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
      or
      ("attesta_records"."predicate_type" = 'https://trackai.dev/attesta/period-report/v1'
        and "attesta_records"."statement_kind" is null
        and "attesta_records"."subject_sha" is null
        and "attesta_records"."outbox_subject_id" is null)
    )
  );--> statement-breakpoint
ALTER TABLE "attesta_period_reports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Task15i4 (A15.9 part 3; docs/contracts/attesta/period-report.md): a second predicate
-- type in the ledger. 0017 is never edited: its chain guard is replaced here with
-- CREATE OR REPLACE, and the shape check above was dropped and re-added. For an
-- ai-provenance record every 0017 condition holds exactly as before (the IT-T15d
-- regression proves it); a period_report record has statement_kind, subject_sha and
-- outbox_subject_id null, and its typed columns must agree with its statement: one
-- subject named trackai:repository/<repository_id>/period/<from>..<to> after the
-- predicate's own scope, with a sha256 digest (the report document's).
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
  -- canonical_record = the RFC 8785 bytes of the typed columns (0017), with JSON null
  -- for the columns a period_report leaves empty. For an ai-provenance record (both
  -- columns NOT NULL by the shape check) this is the 0017 string exactly.
  expected := '{"outbox_subject_id":'
    || CASE WHEN NEW.outbox_subject_id IS NULL THEN 'null' ELSE '"' || NEW.outbox_subject_id::text || '"' END
    || ',"predicate_type":"' || NEW.predicate_type
    || '","prev_hash":"' || NEW.prev_hash
    || '","record_kind":"' || NEW.record_kind
    || '","recorded_at":"' || to_char(NEW.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    || '","repository_id":"' || NEW.repository_id::text
    || '","seq":' || NEW.seq::text
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
    -- jsonb_typeof checks come first in OR order, so ->> below only reads strings.
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
-- Period-report jobs (attesta_evidence_packs style, 0020). A job's identity never
-- changes; its status only moves forward; ready and failed rows are final; no DELETE or
-- TRUNCATE. A ready row's document hashes to its digest, and its record is the
-- tenant's period_report statement naming that digest, scope and repository.
CREATE TRIGGER attesta_period_reports_no_delete
  BEFORE DELETE ON "attesta_period_reports"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_period_reports_no_truncate
  BEFORE TRUNCATE ON "attesta_period_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_period_reports_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'attesta_period_reports: a new job starts queued with no attempts' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.scope->'repository_id' IS DISTINCT FROM to_jsonb(NEW.repository_id::text) THEN
    RAISE EXCEPTION 'attesta_period_reports: scope names another repository' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_period_reports_insert_guard
  BEFORE INSERT ON "attesta_period_reports"
  FOR EACH ROW EXECUTE FUNCTION attesta_period_reports_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_period_reports_update_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  rec record;
  stmt jsonb;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attesta_period_reports: identity columns never change' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'attesta_period_reports: a finished job is final' USING ERRCODE = 'ATG01';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status IN ('running', 'ready', 'failed'))) THEN
    RAISE EXCEPTION 'attesta_period_reports: status moves only forward' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.attempts < OLD.attempts
     OR (NEW.status = 'running' AND NEW.attempts <> OLD.attempts + 1) THEN
    RAISE EXCEPTION 'attesta_period_reports: a claim counts one attempt' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'running' AND OLD.lease_until > now() THEN
    RAISE EXCEPTION 'attesta_period_reports: a live lease cannot be taken' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.status = 'ready' THEN
    IF NEW.report_digest <> 'sha256:' || encode(sha256(convert_to(NEW.report_document, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'attesta_period_reports: report_digest <> sha256(report_document)' USING ERRCODE = 'ATG01';
    END IF;
    SELECT r.predicate_type, r.statement_digest, r.repository_id, r.statement_canonical INTO rec
      FROM public.attesta_records r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attesta_period_reports: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
    END IF;
    stmt := rec.statement_canonical::jsonb;
    IF rec.predicate_type <> 'https://trackai.dev/attesta/period-report/v1'
       OR rec.statement_digest <> NEW.statement_digest
       OR rec.repository_id <> NEW.repository_id
       OR stmt->'subject'->0->'digest'->'sha256' IS DISTINCT FROM to_jsonb(substr(NEW.report_digest, 8))
       OR stmt->'predicate'->'scope'->'from' IS DISTINCT FROM NEW.scope->'from'
       OR stmt->'predicate'->'scope'->'to' IS DISTINCT FROM NEW.scope->'to' THEN
      RAISE EXCEPTION 'attesta_period_reports: the record is not this report''s statement' USING ERRCODE = 'ATG01';
    END IF;
  ELSIF NEW.report_document IS NOT NULL OR NEW.record_id IS NOT NULL THEN
    RAISE EXCEPTION 'attesta_period_reports: only a ready job holds a document' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_period_reports_update_guard
  BEFORE UPDATE ON "attesta_period_reports"
  FOR EACH ROW EXECUTE FUNCTION attesta_period_reports_update_guard();
