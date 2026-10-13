CREATE TABLE "attesta_anchor_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"seq_from" bigint NOT NULL,
	"seq_to" bigint NOT NULL,
	"merkle_root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_anchor_batches_batch_id_key" UNIQUE("batch_id"),
	CONSTRAINT "attesta_anchor_batches_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_anchor_batches_tenant_batch_id_key" UNIQUE("tenant_id","batch_id"),
	CONSTRAINT "attesta_anchor_batches_shape_check" CHECK (
    "attesta_anchor_batches"."seq_from" >= 0
    and "attesta_anchor_batches"."seq_from" <= "attesta_anchor_batches"."seq_to"
    and "attesta_anchor_batches"."leaf_count" = "attesta_anchor_batches"."seq_to" - "attesta_anchor_batches"."seq_from" + 1
    and "attesta_anchor_batches"."leaf_count" <= 4096
    and "attesta_anchor_batches"."batch_id" = "attesta_anchor_batches"."tenant_id"::text || ':' || "attesta_anchor_batches"."seq_from"::text || '-' || "attesta_anchor_batches"."seq_to"::text
    and "attesta_anchor_batches"."merkle_root" ~ '^sha256:[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
CREATE TABLE "attesta_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"anchor_type" text NOT NULL,
	"status" text NOT NULL,
	"inclusion_proof" jsonb,
	"rekor_entry_uuid" text,
	"tsa_token_b64" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attesta_anchors_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "attesta_anchors_shape_check" CHECK (
    "attesta_anchors"."anchor_type" in ('rekor', 'tsa')
    and "attesta_anchors"."status" in ('anchored', 'failed')
    and (
      ("attesta_anchors"."status" = 'anchored' and "attesta_anchors"."inclusion_proof" is not null and "attesta_anchors"."error_code" is null
        and (
          ("attesta_anchors"."anchor_type" = 'rekor' and "attesta_anchors"."rekor_entry_uuid" is not null and "attesta_anchors"."tsa_token_b64" is null)
          or ("attesta_anchors"."anchor_type" = 'tsa' and "attesta_anchors"."tsa_token_b64" is not null and "attesta_anchors"."rekor_entry_uuid" is null)))
      or ("attesta_anchors"."status" = 'failed' and "attesta_anchors"."error_code" is not null and "attesta_anchors"."inclusion_proof" is null
        and "attesta_anchors"."rekor_entry_uuid" is null and "attesta_anchors"."tsa_token_b64" is null)
    )
    and ("attesta_anchors"."error_code" is null or "attesta_anchors"."error_code" ~ '^ATTESTA_[A-Z0-9_]{1,64}$')
    and ("attesta_anchors"."rekor_entry_uuid" is null or "attesta_anchors"."rekor_entry_uuid" ~ '^([0-9a-f]{16})?[0-9a-f]{64}$')
    and ("attesta_anchors"."tsa_token_b64" is null or (length("attesta_anchors"."tsa_token_b64") between 4 and 131072
      and "attesta_anchors"."tsa_token_b64" ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'))
  )
);
--> statement-breakpoint
ALTER TABLE "attesta_anchor_batches" ADD CONSTRAINT "attesta_anchor_batches_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_anchors" ADD CONSTRAINT "attesta_anchors_tenant_id_sso_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."sso_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_anchors" ADD CONSTRAINT "attesta_anchors_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."attesta_anchor_batches"("tenant_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attesta_anchors" ADD CONSTRAINT "attesta_anchors_tenant_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."attesta_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attesta_anchor_batches_tenant_seq_to_idx" ON "attesta_anchor_batches" USING btree ("tenant_id","seq_to");--> statement-breakpoint
CREATE UNIQUE INDEX "attesta_anchors_anchored_key" ON "attesta_anchors" USING btree ("tenant_id","record_id","anchor_type") WHERE "attesta_anchors"."status" = 'anchored';--> statement-breakpoint
CREATE INDEX "attesta_anchors_tenant_batch_idx" ON "attesta_anchors" USING btree ("tenant_id","batch_id","anchor_type");--> statement-breakpoint
ALTER TABLE "attesta_anchor_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attesta_anchors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Anchoring guards (Task15f2, A15.5; design docs/contracts/attesta/tables.md).
-- Ported from SushiCorp EV-2 @ 0bd67a5, in the 0017 style: SECURITY DEFINER with
-- search_path = pg_catalog, pg_temp (AGENTS.md §9 item 21), tables schema-qualified.
-- Both tables are append-only; anchoring never touches attesta_records.
-- SQLSTATE ATA01 = the batch is not the tenant's next range (a concurrent worker
-- recorded another batch first: retry from a new plan); ATG01 = any other guard.
CREATE TRIGGER attesta_anchor_batches_append_only
  BEFORE UPDATE OR DELETE ON "attesta_anchor_batches"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_batches_no_truncate
  BEFORE TRUNCATE ON "attesta_anchor_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_anchors_append_only
  BEFORE UPDATE OR DELETE ON "attesta_anchors"
  FOR EACH ROW EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER attesta_anchors_no_truncate
  BEFORE TRUNCATE ON "attesta_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION attesta_ledger_reject_mutation();
--> statement-breakpoint
-- A batch is the tenant's next contiguous seq range (batches never overlap or leave
-- a hole), every seq in it is a record of that tenant, and merkle_root is the
-- RFC 6962 root over the 32 raw bytes of those records' record_hash, in seq order.
-- The root is rebuilt bottom-up, carrying an odd last node up unchanged, which is
-- the same tree as RFC 6962's largest-power-of-two split (merkle.ts).
CREATE OR REPLACE FUNCTION attesta_anchor_batches_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  expected_from bigint;
  leaves bytea[];
  next_level bytea[];
  found_count bigint;
  n integer;
  i integer;
BEGIN
  -- Serialize batch inserts per tenant, so two writers cannot both take the same range.
  PERFORM pg_advisory_xact_lock(hashtextextended('attesta_anchor_batches:' || NEW.tenant_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.attesta_anchor_batches b WHERE b.batch_id = NEW.batch_id) THEN
    RETURN NEW; -- the same batch again: the unique constraint (or ON CONFLICT) decides
  END IF;
  SELECT coalesce(max(b.seq_to) + 1, 0) INTO expected_from
    FROM public.attesta_anchor_batches b WHERE b.tenant_id = NEW.tenant_id;
  IF NEW.seq_from <> expected_from THEN
    RAISE EXCEPTION 'attesta_anchor_batches: batch must start at the tenant''s next unbatched seq % (got %)',
      expected_from, NEW.seq_from USING ERRCODE = 'ATA01';
  END IF;
  SELECT array_agg(sha256(decode('00', 'hex') || decode(substr(r.record_hash, 8), 'hex')) ORDER BY r.seq), count(*)
    INTO leaves, found_count
    FROM public.attesta_records r
    WHERE r.tenant_id = NEW.tenant_id AND r.seq BETWEEN NEW.seq_from AND NEW.seq_to;
  IF found_count <> NEW.leaf_count THEN
    RAISE EXCEPTION 'attesta_anchor_batches: seqs % to % are not all records of this tenant', NEW.seq_from, NEW.seq_to
      USING ERRCODE = 'ATG01';
  END IF;
  WHILE array_length(leaves, 1) > 1 LOOP
    next_level := ARRAY[]::bytea[];
    n := array_length(leaves, 1);
    i := 1;
    WHILE i <= n LOOP
      IF i < n THEN
        next_level := array_append(next_level, sha256(decode('01', 'hex') || leaves[i] || leaves[i + 1]));
        i := i + 2;
      ELSE
        next_level := array_append(next_level, leaves[i]);
        i := i + 1;
      END IF;
    END LOOP;
    leaves := next_level;
  END LOOP;
  IF 'sha256:' || encode(leaves[1], 'hex') IS DISTINCT FROM NEW.merkle_root THEN
    RAISE EXCEPTION 'attesta_anchor_batches: merkle_root is not the root of seqs % to %', NEW.seq_from, NEW.seq_to
      USING ERRCODE = 'ATG01';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_anchor_batches_guard
  BEFORE INSERT ON "attesta_anchor_batches"
  FOR EACH ROW EXECUTE FUNCTION attesta_anchor_batches_guard();
--> statement-breakpoint
-- An anchor names a record of its own tenant that lies inside its batch; an anchored
-- row's proof is bound to that position (leaf_index, tree_size), its path leads from
-- the record's leaf to the batch root (RFC 9162 §2.1.3.2, as merkle.ts rootFromPath),
-- and it is bound to its own anchor type and to its row columns (the Rekor entry ID,
-- or the hash of the TSA token). So a bogus anchored row can never take the one
-- anchored slot of a record and type.
CREATE OR REPLACE FUNCTION attesta_anchors_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  b_from bigint;
  b_to bigint;
  b_count integer;
  b_root text;
  r_seq bigint;
  r_hash text;
  proof jsonb;
  node bytea;
  sibling text;
  fn bigint;
  sn bigint;
BEGIN
  SELECT b.seq_from, b.seq_to, b.leaf_count, b.merkle_root INTO b_from, b_to, b_count, b_root
    FROM public.attesta_anchor_batches b WHERE b.tenant_id = NEW.tenant_id AND b.batch_id = NEW.batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_anchors: no batch % in this tenant', NEW.batch_id USING ERRCODE = 'ATG01';
  END IF;
  SELECT r.seq, r.record_hash INTO r_seq, r_hash
    FROM public.attesta_records r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attesta_anchors: no record % in this tenant', NEW.record_id USING ERRCODE = 'ATG01';
  END IF;
  IF r_seq < b_from OR r_seq > b_to THEN
    RAISE EXCEPTION 'attesta_anchors: record seq % lies outside batch %', r_seq, NEW.batch_id USING ERRCODE = 'ATG01';
  END IF;
  IF NEW.status = 'anchored' THEN
    proof := NEW.inclusion_proof;
    IF jsonb_typeof(proof) IS DISTINCT FROM 'object'
       OR proof->'version' IS DISTINCT FROM to_jsonb(1)
       OR jsonb_typeof(proof->'merkle') IS DISTINCT FROM 'object'
       OR proof->'merkle'->'leaf_index' IS DISTINCT FROM to_jsonb(r_seq - b_from)
       OR proof->'merkle'->'tree_size' IS DISTINCT FROM to_jsonb(b_count)
       OR jsonb_typeof(proof->'anchor') IS DISTINCT FROM 'object'
       OR proof->'anchor'->'type' IS DISTINCT FROM to_jsonb(NEW.anchor_type)
       OR (NEW.anchor_type = 'rekor' AND proof->'anchor'->'ref' IS DISTINCT FROM to_jsonb(NEW.rekor_entry_uuid))
       OR (NEW.anchor_type = 'tsa' AND proof->'anchor'->'ref' IS DISTINCT FROM
           to_jsonb('tsa:sha256:' || encode(sha256(decode(NEW.tsa_token_b64, 'base64')), 'hex'))) THEN
      RAISE EXCEPTION 'attesta_anchors: inclusion_proof is not bound to record seq % in batch % (%)',
        r_seq, NEW.batch_id, NEW.anchor_type USING ERRCODE = 'ATG01';
    END IF;
    IF jsonb_typeof(proof->'merkle'->'path') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'attesta_anchors: inclusion_proof has no Merkle path (seq %)', r_seq USING ERRCODE = 'ATG01';
    END IF;
    node := sha256(decode('00', 'hex') || decode(substr(r_hash, 8), 'hex'));
    fn := r_seq - b_from;
    sn := b_count - 1;
    FOR sibling IN SELECT e.value FROM jsonb_array_elements_text(proof->'merkle'->'path') WITH ORDINALITY AS e(value, i) ORDER BY e.i LOOP
      IF sn = 0 OR sibling !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'attesta_anchors: Merkle path is malformed or too long (seq %)', r_seq USING ERRCODE = 'ATG01';
      END IF;
      IF fn % 2 = 1 OR fn = sn THEN
        node := sha256(decode('01', 'hex') || decode(sibling, 'hex') || node);
        IF fn % 2 = 0 THEN
          WHILE fn <> 0 AND fn % 2 = 0 LOOP
            fn := fn / 2;
            sn := sn / 2;
          END LOOP;
        END IF;
      ELSE
        node := sha256(decode('01', 'hex') || node || decode(sibling, 'hex'));
      END IF;
      fn := fn / 2;
      sn := sn / 2;
    END LOOP;
    IF sn <> 0 OR 'sha256:' || encode(node, 'hex') IS DISTINCT FROM b_root THEN
      RAISE EXCEPTION 'attesta_anchors: Merkle path does not lead from record seq % to the root of batch %', r_seq, NEW.batch_id
        USING ERRCODE = 'ATG01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attesta_anchors_guard
  BEFORE INSERT ON "attesta_anchors"
  FOR EACH ROW EXECUTE FUNCTION attesta_anchors_guard();
