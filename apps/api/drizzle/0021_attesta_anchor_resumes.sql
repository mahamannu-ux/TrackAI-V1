CREATE TABLE "attesta_anchor_resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_anchor_resumes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_anchor_resumes_shape_check" CHECK (
    length("attesta_anchor_resumes"."actor") between 1 and 128
    and length("attesta_anchor_resumes"."reason") between 1 and 256
    and length("attesta_anchor_resumes"."request_id") between 1 and 128
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_anchor_resumes" ADD CONSTRAINT "attesta_anchor_resumes_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_anchor_resumes" ADD CONSTRAINT "attesta_anchor_resumes_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."attesta_anchor_batches"("tenant_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attesta_anchor_resumes_tenant_batch_idx" ON "attesta_anchor_resumes" USING btree ("tenant_id","batch_id","created_at");--> statement-breakpoint
ALTER TABLE "attesta_anchor_resumes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Anchor resume guards (Task15i3; docs/contracts/attesta/tables.md "attesta_anchor_resumes").
-- In the 0017-0020 style: SECURITY DEFINER with search_path = pg_catalog, pg_temp
-- (AGENTS.md §9 item 21), so the checks also see rows an RLS-bound caller cannot;
-- ERRCODE ATG01 for a guard breach. Append-only: no UPDATE, DELETE or TRUNCATE.
CREATE TRIGGER attesta_anchor_resumes_append_only
  BEFORE UPDATE OR DELETE ON "attesta_anchor_resumes"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_resumes_no_truncate
  BEFORE TRUNCATE ON "attesta_anchor_resumes"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
-- A resume is accepted only for a stopped batch, once per stop:
--  1. the batch exists for this tenant and is not anchored in both types for every record;
--  2. its latest failed attempt (the newest failed rows) carries a terminal code
--     (errors.md §Anchoring: LOG_REJECTED, LOG_KEY_NOT_PINNED);
--  3. no resume row is newer than that attempt.
-- created_at is the database's clock_timestamp(), never the caller's: it is later
-- than every failure this statement can see, so "latest terminal failure newer than
-- latest resume" (the worker's stop rule) cannot be gamed with a back- or future-dated row.
-- A per-batch advisory lock serializes concurrent resumes of one batch.
CREATE OR REPLACE FUNCTION attesta_anchor_resumes_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  leaf integer;
  last_failed timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_anchor_resume:' || NEW.tenant_id::text || ':' || NEW.batch_id, 0));
  NEW.created_at := clock_timestamp();
  SELECT b.leaf_count INTO leaf
    FROM public.attesta_anchor_batches b WHERE b.tenant_id = NEW.tenant_id AND b.batch_id = NEW.batch_id;
  IF leaf IS NULL THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: no such batch for this tenant' USING ERRCODE = 'ATG01';
  END IF;
  IF (SELECT count(*) FROM public.attesta_anchors a WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id
        AND a.anchor_type = 'rekor' AND a.status = 'anchored') >= leaf
     AND (SELECT count(*) FROM public.attesta_anchors a WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id
        AND a.anchor_type = 'tsa' AND a.status = 'anchored') >= leaf THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: the batch is anchored' USING ERRCODE = 'ATG01';
  END IF;
  SELECT max(a.created_at) INTO last_failed
    FROM public.attesta_anchors a WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id AND a.status = 'failed';
  IF last_failed IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.attesta_anchors a
       WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id AND a.status = 'failed'
         AND a.created_at = last_failed
         AND a.error_code IN ('ATTESTA_ANCHOR_LOG_REJECTED', 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED')) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: the batch is not stopped by a terminal code' USING ERRCODE = 'ATG01';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attesta_anchor_resumes r
             WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id AND r.created_at > last_failed) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: this stop was already resumed' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_resumes_insert_guard
  BEFORE INSERT ON "attesta_anchor_resumes"
  FOR EACH ROW EXECUTE FUNCTION attesta_anchor_resumes_insert_guard();
