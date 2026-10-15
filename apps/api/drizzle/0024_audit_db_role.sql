-- Task16e2 (A16.10; catalog AU-1): request-path audit reads enter a NOLOGIN
-- role that can select only the audit trail and its seals. The application
-- predicate remains in every query; these RLS policies are the database
-- backstop when that predicate is accidentally weakened or omitted.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trackai_audit_reader') THEN
		CREATE ROLE trackai_audit_reader NOLOGIN;
	END IF;
END $$;
--> statement-breakpoint
GRANT SELECT ON "security_audit_events", "attesta_audit_seals" TO trackai_audit_reader;
--> statement-breakpoint
GRANT trackai_audit_reader TO CURRENT_USER;
--> statement-breakpoint
CREATE POLICY "security_audit_events_audit_reader_select"
	ON "security_audit_events"
	FOR SELECT
	TO trackai_audit_reader
	USING (tenant_id = NULLIF(current_setting('trackai.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "attesta_audit_seals_audit_reader_select"
	ON "attesta_audit_seals"
	FOR SELECT
	TO trackai_audit_reader
	USING (tenant_id = NULLIF(current_setting('trackai.tenant_id', true), '')::uuid);
