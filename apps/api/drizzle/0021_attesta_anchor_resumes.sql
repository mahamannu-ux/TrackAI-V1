CREATE TABLE "attesta_anchor_resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_anchor_resumes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_anchor_resumes_tenant_request_id_key" UNIQUE("tenant_id","request_id"),
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
-- (AGENTS.md §9 item 21), ERRCODE ATG01 for a guard breach. Append-only: no UPDATE,
-- DELETE or TRUNCATE.
CREATE TRIGGER attesta_anchor_resumes_append_only
  BEFORE UPDATE OR DELETE ON "attesta_anchor_resumes"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_resumes_no_truncate
  BEFORE TRUNCATE ON "attesta_anchor_resumes"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
-- 1. Visibility, as the caller (SECURITY INVOKER, so the caller's RLS applies): the batch
--    must be one the caller can see. It fires before the definer guard (triggers run in
--    name order, "a_visible" < "insert_guard") and before RLS WITH CHECK, so a role bound
--    to tenant A learns nothing about tenant B's batches: every foreign or unknown batch
--    gets the same refusal, and A never takes B's lock.
CREATE OR REPLACE FUNCTION attesta_anchor_resumes_visible_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.attesta_anchor_batches b WHERE b.tenant_id = NEW.tenant_id AND b.batch_id = NEW.batch_id) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: no such batch for this tenant' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_resumes_a_visible
  BEFORE INSERT ON "attesta_anchor_resumes"
  FOR EACH ROW EXECUTE FUNCTION attesta_anchor_resumes_visible_guard();
--> statement-breakpoint
-- 2. The stop rule, the same one the anchor worker applies (anchor-worker.ts
--    `stoppedBatch`): the batch is stopped while some terminal failure (errors.md
--    §Anchoring: LOG_REJECTED, LOG_KEY_NOT_PINNED) is newer than its latest resume.
--    A resume is accepted only for a stopped batch that is not anchored in both types
--    for every record, so it lifts exactly one stop (a second resume finds no terminal
--    failure newer than the first). created_at is the database's clock_timestamp(),
--    never the caller's: later than every failure this statement can see. A per-batch
--    advisory lock serializes concurrent resumes, and READ COMMITTED is required so the
--    checks read what committed before the lock (a REPEATABLE READ snapshot taken
--    earlier would let two concurrent resumes both pass).
CREATE OR REPLACE FUNCTION attesta_anchor_resumes_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  leaf integer;
  last_resume timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: a resume runs in a READ COMMITTED transaction' USING ERRCODE = 'ATG01';
  END IF;
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
  SELECT coalesce(max(r.created_at), '-infinity'::timestamptz) INTO last_resume
    FROM public.attesta_anchor_resumes r WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id;
  IF NOT EXISTS (
       SELECT 1 FROM public.attesta_anchors a
       WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id AND a.status = 'failed'
         AND a.error_code IN ('ATTESTA_ANCHOR_LOG_REJECTED', 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED')) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: the batch is not stopped by a terminal code' USING ERRCODE = 'ATG01';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.attesta_anchors a
       WHERE a.tenant_id = NEW.tenant_id AND a.batch_id = NEW.batch_id AND a.status = 'failed'
         AND a.error_code IN ('ATTESTA_ANCHOR_LOG_REJECTED', 'ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED')
         AND a.created_at > last_resume) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: this stop was already resumed' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_resumes_insert_guard
  BEFORE INSERT ON "attesta_anchor_resumes"
  FOR EACH ROW EXECUTE FUNCTION attesta_anchor_resumes_insert_guard();
--> statement-breakpoint
-- 3. Audited, always (AGENTS.md §9 item 10): at commit, every resume row has its
--    `attesta.anchor.resume` security_audit_events row for the same tenant, batch and
--    request_id. request_id is unique per tenant, so one audit row covers one resume;
--    a direct INSERT that skips the audit is refused at COMMIT.
CREATE OR REPLACE FUNCTION attesta_anchor_resumes_audit_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.security_audit_events e
       WHERE e.tenant_id = NEW.tenant_id AND e.action = 'attesta.anchor.resume'
         AND e.target_id = NEW.batch_id AND e.details->>'request_id' = NEW.request_id) THEN
    RAISE EXCEPTION 'attesta_anchor_resumes: a resume needs its attesta.anchor.resume audit row' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attesta_anchor_resumes_audit_check
  AFTER INSERT ON "attesta_anchor_resumes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attesta_anchor_resumes_audit_check();
