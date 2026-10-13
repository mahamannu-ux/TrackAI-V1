CREATE TABLE "attesta_evidence_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"scope" jsonb NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" text NOT NULL,
	"request_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"pack_digest" text,
	"storage_reference" text,
	"bytes" bigint,
	"counts" jsonb,
	"signature_envelope" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "attesta_evidence_packs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_evidence_packs_tenant_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "attesta_evidence_packs_shape_check" CHECK (
    "attesta_evidence_packs"."idempotency_key" ~ '^[A-Za-z0-9._-]{8,64}$'
    and "attesta_evidence_packs"."mode" in ('full', 'repository_only')
    and "attesta_evidence_packs"."status" in ('queued', 'running', 'ready', 'failed')
    and length("attesta_evidence_packs"."requested_by") between 1 and 256
    and length("attesta_evidence_packs"."request_id") between 1 and 128
    and "attesta_evidence_packs"."attempts" >= 0
    and jsonb_typeof("attesta_evidence_packs"."scope") = 'object'
    and ("attesta_evidence_packs"."status" = 'running') = ("attesta_evidence_packs"."lease_until" is not null)
    and ("attesta_evidence_packs"."status" = 'ready') = ("attesta_evidence_packs"."pack_digest" is not null)
    and ("attesta_evidence_packs"."status" = 'ready') = ("attesta_evidence_packs"."storage_reference" is not null)
    and ("attesta_evidence_packs"."status" = 'ready') = ("attesta_evidence_packs"."bytes" is not null)
    and ("attesta_evidence_packs"."status" = 'ready') = ("attesta_evidence_packs"."signature_envelope" is not null)
    and ("attesta_evidence_packs"."status" = 'ready') = ("attesta_evidence_packs"."counts" is not null)
    and ("attesta_evidence_packs"."status" = 'failed') = ("attesta_evidence_packs"."error_code" is not null)
    and ("attesta_evidence_packs"."status" in ('ready', 'failed')) = ("attesta_evidence_packs"."finished_at" is not null)
    and ("attesta_evidence_packs"."pack_digest" is null or "attesta_evidence_packs"."pack_digest" ~ '^sha256:[0-9a-f]{64}$')
    and ("attesta_evidence_packs"."error_code" is null or "attesta_evidence_packs"."error_code" ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
    and ("attesta_evidence_packs"."bytes" is null or "attesta_evidence_packs"."bytes" > 0)
    and ("attesta_evidence_packs"."storage_reference" is null or length("attesta_evidence_packs"."storage_reference") between 1 and 512)
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_evidence_packs" ADD CONSTRAINT "attesta_evidence_packs_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attesta_evidence_packs_tenant_status_idx" ON "attesta_evidence_packs" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "attesta_evidence_packs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Evidence-pack job guards (Task15i2, A15.9; docs/contracts/attesta/evidence-pack.md).
-- In the 0017-0019 style: SECURITY DEFINER with search_path = pg_catalog, pg_temp
-- (AGENTS.md §9 item 21), ERRCODE ATG01 for a guard breach. A job's identity never
-- changes; its status only moves forward (queued -> running -> ready | failed;
-- running -> running retakes an expired lease; queued -> failed when the job cannot
-- start); ready and failed rows are final. No DELETE or TRUNCATE in phase 1.
CREATE TRIGGER attesta_evidence_packs_no_delete
  BEFORE DELETE ON "attesta_evidence_packs"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_evidence_packs_no_truncate
  BEFORE TRUNCATE ON "attesta_evidence_packs"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_evidence_packs_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status <> 'queued' OR NEW.attempts <> 0 THEN
    RAISE EXCEPTION 'attesta_evidence_packs: a new job starts queued with no attempts' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_evidence_packs_insert_guard
  BEFORE INSERT ON "attesta_evidence_packs"
  FOR EACH ROW EXECUTE FUNCTION attesta_evidence_packs_insert_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attesta_evidence_packs_update_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attesta_evidence_packs: identity columns never change' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'attesta_evidence_packs: a finished job is final' USING ERRCODE = 'ATG01';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
       OR (OLD.status = 'running' AND NEW.status IN ('running', 'ready', 'failed'))) THEN
    RAISE EXCEPTION 'attesta_evidence_packs: status moves only forward' USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.attempts < OLD.attempts
     OR (NEW.status = 'running' AND NEW.attempts <> OLD.attempts + 1) THEN
    -- Every claim (and every retake of an expired lease) is one more attempt.
    RAISE EXCEPTION 'attesta_evidence_packs: a claim counts one attempt' USING ERRCODE = 'ATG01';
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'running' AND OLD.lease_until > now() THEN
    RAISE EXCEPTION 'attesta_evidence_packs: a live lease cannot be taken' USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_evidence_packs_update_guard
  BEFORE UPDATE ON "attesta_evidence_packs"
  FOR EACH ROW EXECUTE FUNCTION attesta_evidence_packs_update_guard();
