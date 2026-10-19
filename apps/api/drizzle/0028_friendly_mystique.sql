ALTER TABLE "scm_pull_requests" ADD COLUMN "merged_by_provider_id" text;--> statement-breakpoint
ALTER TABLE "scm_pull_requests" ADD COLUMN "merged_by_login" text;