-- Remove the unused pre-product sample table from upgraded databases. Fresh
-- databases never create it. Intentionally omit CASCADE so any unexpected
-- dependency blocks the migration instead of being deleted.
DROP TABLE IF EXISTS "public"."items";
