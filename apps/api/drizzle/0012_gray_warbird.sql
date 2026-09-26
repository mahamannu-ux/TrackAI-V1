ALTER TABLE "evidence_intention_embeddings" DROP CONSTRAINT "evidence_intention_embeddings_intention_id_evidence_intentions_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_semantic_jobs" DROP CONSTRAINT "evidence_semantic_jobs_intention_id_evidence_intentions_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_intention_embeddings" ADD CONSTRAINT "evidence_intention_embeddings_tenant_intention_fk" FOREIGN KEY ("tenant_id","intention_id") REFERENCES "public"."evidence_intentions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_semantic_jobs" ADD CONSTRAINT "evidence_semantic_jobs_tenant_intention_fk" FOREIGN KEY ("tenant_id","intention_id") REFERENCES "public"."evidence_intentions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;