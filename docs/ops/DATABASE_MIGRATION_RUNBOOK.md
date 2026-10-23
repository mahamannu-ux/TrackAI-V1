# TrackAI database migration runbook

**Status, 2026-10-23:** Task14a's local application-schema rehearsal passed;
no live 0010–0028 migration has run. Read
[`TASK14_SUPABASE.md`](../plan/TASK14_SUPABASE.md) for this project's current
ledger, risk register and recovery limitation.

**Update, 2026-10-24:** An ownership-preserving full raw restore on
`supabase/postgres:17.6.1.136` succeeded. The first `db:migrate` crashed at
0024's `GRANT ... TO CURRENT_USER`; the transaction rolled back. The founder
explicitly authorized a narrow exception to correct merged 0024. Its dynamic,
quoted-role grant passed 0010–0028 on the full restored copy in 6.5 s; the
ledger reached 29. Supabase's [image issue #2348](https://github.com/supabase/postgres/issues/2348)
documents the original statement-form crash. Do **not** follow section 4 for
the live project until Task16e2/Task20 owner review, a demonstrated Free-tier
recovery route including Auth sign-in, and separate founder approval. The
live project remains at 0009.

This runbook applies to every persistent TrackAI PostgreSQL project. Drizzle
is the schema migrator. Supabase is an Auth and hosted PostgreSQL provider,
not the migration ledger. Never use `db:push` on a persistent project and
never change an already merged SQL migration without an explicit founder
exception and owning-task review. Task14a's authorized 0024 correction is
pending that review.

## 1. Identify the exact target

Record privately: project reference, database name, server major version,
application role, migration role, target commit SHA, maintenance window and
who can authorize a restore. Read `drizzle.__drizzle_migrations` and compare
its timestamps and hashes with `apps/api/drizzle/meta/_journal.json` and the
SQL files. Inspect RLS policies, extensions and any previously manual grants.
Use read-only SQL and report names/counts, not rows or connection strings.
If the ledger or schema differs from the expected predecessor state, stop and
investigate before invoking Drizzle. A green `drizzle-kit check` checks local
migration files; it does not prove that a remote database matches them.

The API's `DATABASE_URL` may point to Supabase's transaction pooler on 6543.
Use a direct or session-mode connection for `pg_dump` and migrations, with a
short-lived environment variable supplied by the operator's secret store.
Do not paste it into a shell command, issue body, log or document. Confirm the
connection's project and role with read-only SQL before any write.

## 2. Back up and prove recovery

Confirm the project's actual Supabase backup/PITR entitlement and a usable
pre-change restore point in the dashboard. Record its time and expected
data-loss window. Take an additional encrypted logical dump retained by the
operator outside the repository; keep its decryption key separately protected.
For a Free project with no dashboard restore point, use Supabase's documented
CLI roles/schema/data export, including Auth data, and rehearse restoration
into an isolated matching Supabase environment before applying live migrations.
For a managed-project recovery rehearsal, create a disposable destination
project and follow Supabase's [CLI backup and restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Record the destination's project reference privately and never point the
rehearsal restore at the source project. Its Auth settings and API keys need
separate configuration; a database-only restore does not copy them.
Check extension compatibility, Auth user counts and sign-in, Drizzle ledger,
application table counts and storage-object requirements. A raw full
`pg_dump` or an application-schema-only restore does not satisfy this full
recovery gate. Take a fresh export immediately before the live apply and keep
an off-site encrypted copy with its key protected separately. Alternatively,
the operator may choose a paid provider backup route after verifying an actual
usable pre-change restore point; upgrading alone is not proof of one.
Validate archive authentication and its table of contents. A generic
`pg_dump` of all Supabase schemas contains provider internals and is not by
itself a complete self-hosted recovery package. Follow the provider's
[backup guidance](https://supabase.com/docs/guides/platform/backups) and
[platform restore guidance](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
for full-project recovery.

Restore the TrackAI application schemas and Drizzle ledger to an isolated
local PostgreSQL of the **same major version** and with required extensions.
Use a named container on a free loopback port. For Task14a the approved port
is **55433** for application-schema tests and **55434** for the matching
Supabase image; 55432 belongs to the ongoing Task20j/Task5 acceptance database.
Compare pre-migration ledger and policy counts with the source. Time the
restore. If full-project Auth recovery is needed, rehearse it in a matching
Supabase stack; do not call an application-only restore a full recovery drill.
No live apply proceeds without a demonstrated rollback route and an explicit
operator decision about its recovery time and possible lost writes.

## 3. Rehearse the exact migration

Point `DATABASE_URL` **only** at the restored copy. Run
`npm run db:migrate -w apps/api` and then
`npm exec --workspace=apps/api -- drizzle-kit check`. Verify the expected
ledger count, extension versions, roles, policies, constraints, triggers and
representative table counts. Measure migration and lock time; a fast run on
small data is not a bound for a larger production database. If a migration
fails, preserve the copy and error for diagnosis. Never edit its ledger to
skip the failure.

Inventory every accompanying data operation. Run its default dry-run mode
first and record only per-tenant counts and safe status codes. In the current
release these include `backfill:task19g-merged-by`,
`reconcile:task4-wave5-pending`, and `attesta:security-seal --now`. Each
`--confirm` or apply flag needs a separate approval with its exact scope.
Check whether the API runtime role differs from the migration role; if so,
migration 0024's `GRANT ... TO CURRENT_USER` does not supply the runtime role
with `trackai_audit_reader` membership. Rehearse a reviewed, narrow grant and
verify an auditor read before live use.

## 4. Approve and apply to the persistent project

Present the operator with: target identity and SHA, current/pending migration
names, drift findings, backup/restore evidence, rehearsal duration, lock and
row counts, post-step dry runs, smoke checklist, rollback route and estimated
recovery time. Obtain explicit approval for the schema apply. During the
window, stop or drain only relevant writers and use the approved direct or
session connection. Run `npm run db:migrate -w apps/api` once. Confirm the
ledger and schema immediately. Record start/end times and safe counts.

Run post-steps in dry-run mode against the newly migrated project. Seek a
separate approval for each confirmed backfill, reconcile or seal. Never set
`TASK5_EPHEMERAL_DATABASE` or `TASK6_EPHEMERAL_DATABASE` on this project.

## 5. Smoke and close out

Start the intended API build with its own port and the live database URL;
for Task14a use **`PORT=8081`** and set the web client's
`NEXT_PUBLIC_API_URL=http://127.0.0.1:8081`. Confirm the origin in
`FRONTEND_URL`. Keep the ongoing API on 8080 undisturbed. Check `/health`,
admin and auditor sign-in, Code Lifecycle/Task2, Audit, Questions, Security,
and Company A/B tenant isolation. Browser sign-in and cross-tenant checks
require the founder's accounts; an HTTP 200 from `/health` alone is not a
dashboard acceptance result. Record only status and counts in the handoff.

If smoke fails, stop the new API and writers, diagnose whether an application
rollback suffices, and obtain explicit approval before restoring a database
backup or PITR point. A restore may overwrite writes since that point and
interrupt Auth and the dashboard. Time the actual restore and smoke; revise
the recovery estimate from evidence. Preserve the failed-state evidence
without printing customer rows or secrets.
