ALTER TABLE "fleet_configurations" DROP CONSTRAINT "fleet_configurations_schema_version_check";--> statement-breakpoint
ALTER TABLE "fleet_configurations" DROP CONSTRAINT "fleet_configurations_bounded_metadata_check";--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD COLUMN "client_minimum_version" text;--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD COLUMN "client_maximum_version" text;--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD COLUMN "release_tag" text;--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD COLUMN "manifest_url" text;--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD COLUMN "manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_release_contract_check" CHECK (
    ("fleet_configurations"."schema_version" = 1
      and "fleet_configurations"."client_minimum_version" is null
      and "fleet_configurations"."client_maximum_version" is null
      and "fleet_configurations"."release_tag" is null
      and "fleet_configurations"."manifest_url" is null
      and "fleet_configurations"."manifest_sha256" is null)
    or ("fleet_configurations"."schema_version" = 2
      and "fleet_configurations"."client_minimum_version" is not null
      and "fleet_configurations"."client_maximum_version" is not null
      and "fleet_configurations"."release_tag" is not null
      and "fleet_configurations"."manifest_url" is not null
      and "fleet_configurations"."manifest_sha256" is not null)
  );--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_schema_version_check" CHECK ("fleet_configurations"."schema_version" in (1, 2));--> statement-breakpoint
ALTER TABLE "fleet_configurations" ADD CONSTRAINT "fleet_configurations_bounded_metadata_check" CHECK (
    length("fleet_configurations"."generated_by") between 1 and 255
    and length("fleet_configurations"."target_client_version") between 1 and 64
    and ("fleet_configurations"."client_minimum_version" is null or length("fleet_configurations"."client_minimum_version") between 1 and 64)
    and ("fleet_configurations"."client_maximum_version" is null or length("fleet_configurations"."client_maximum_version") between 1 and 64)
    and ("fleet_configurations"."release_tag" is null or length("fleet_configurations"."release_tag") between 1 and 128)
    and ("fleet_configurations"."manifest_url" is null or length("fleet_configurations"."manifest_url") between 1 and 512)
    and ("fleet_configurations"."manifest_sha256" is null or "fleet_configurations"."manifest_sha256" ~ '^[0-9a-f]{64}$')
    and ("fleet_configurations"."ring" is null or length("fleet_configurations"."ring") between 1 and 64)
    and ("fleet_configurations"."valid_until" is null or "fleet_configurations"."valid_until" > "fleet_configurations"."generated_at")
    and jsonb_typeof("fleet_configurations"."snapshot") = 'object'
    and octet_length("fleet_configurations"."snapshot"::text) <= 65536
  );