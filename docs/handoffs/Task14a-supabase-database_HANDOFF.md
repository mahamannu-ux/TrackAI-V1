# Task14a-supabase-database Handoff — Supabase schema recovery

> Status: 🔴 Live migration blocked by a crash at 0024 in a matching Supabase
> PostgreSQL image. The live project remains at 0009.

Branch `task/Task14a-supabase-database`. Stage 1 was approved on 2026-10-23.
This session explains Supabase's Auth/database role, inventories the live
ledger, stores an encrypted backup and rehearses migrations 0010–0028 on a
restored application-schema copy. It has made **no live database write** and
has not started an API on 8080 or PostgreSQL on 55432.

## At a glance

| | Item | Status |
|---|---|---|
| Discovery | Live ledger: 10 records through 0009; 19 pending through 0028. Supabase transaction pooler on 6543; PostgreSQL 17.6. | ✅ |
| Backup | October 23 encrypted full `pg_dump`; October 24 encrypted Supabase CLI roles/schema/data exports under private `_task14a_backup_*` directories. | 🟡 local database-content recovery passed; hosted service/Free-tier restore route unproved |
| Rehearsal | `public` + `drizzle` restored on PostgreSQL 17 at 127.0.0.1:55433; migrations to 0028 in 6.4 s; 29 ledger records; Drizzle check and three post-step dry runs passed. | ✅ for application-schema scope |
| Matching Supabase image | Full raw dump restored to an empty database on `supabase/postgres:17.6.1.136` at 55434; Auth and TrackAI table counts matched live. Applying 0010–0028 crashed the backend at 0024's `GRANT ... TO CURRENT_USER`; ledger remained 10. | 🔴 blocking live apply |
| API | This branch's API used 8081 against the rehearsal copy; `/health` returned HTTP 200, then the process was stopped. | 🟡 browser sign-in and dashboard views require live migration/founder accounts |
| Quality | Typecheck, lint, Drizzle file check, and 1,265/1,265 tests passed. | ✅ |
| Review | Task20 lead security review and independent cross-agent review remain. | ⬜ |

## Implemented interfaces

No application code or migrations changed. Operational documents:

- `docs/plan/TASK14_SUPABASE.md`: inventory, architecture choices, migration
  risks, exact port separation, approval gates and observed rehearsal.
- `docs/ops/DATABASE_MIGRATION_RUNBOOK.md`: future backup, rehearsal, apply,
  post-step, smoke and rollback sequence.

## Founder-approved decisions

1. On 2026-10-23 the founder approved **backup and local rehearsal only**.
2. Task14a uses API port **8081** and rehearsal PostgreSQL port **55433**;
   Task20j's API on 8080 and existing database on 55432 remain untouched.

## Deviations from spec

- The plan first proposed PostgreSQL 16; live metadata showed 17.6, so the
  rehearsal used `pgvector/pgvector:pg17`. This matches the server major.
- The full raw dump contains Supabase-managed schemas and `supabase_vault`.
  The generic PostgreSQL image cannot restore those provider internals, so
  the successful restore proves TrackAI's `public`/`drizzle` application
  schemas, with a local `auth.jwt()` dependency stub, not complete Supabase
  project recovery. This is explicitly carried into the live approval gate.
- The first `npm test` attempt in the sandbox had loopback failures and
  stalled; the exact suite passed with command-scoped access.
- Supabase CLI 2.109.1 roles/schema/data exports authenticated after local
  encryption. The CLI restore into the image's initialized database failed
  because its hosted Auth schema differs (`auth.jwt()` and then
  `auth.audit_log_entries.ip_address`). A raw full dump restored into a new
  empty database with matching row/schema counts; Auth service sign-in and a
  managed Free-tier restore were not proved.
- The matching-image migration crashed at 0024's `GRANT ... TO CURRENT_USER`.
  The local cluster recovered and Drizzle stayed at 0009. Supabase's
  [image issue #2348](https://github.com/supabase/postgres/issues/2348)
  documents the same statement-form crash. A synthetic dynamic explicit-role
  grant succeeded locally inside a rolled-back transaction; it is a candidate
  for owner review, not an applied migration fix. No merged SQL was changed.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| 🔴 | Task16e2/Task20 owners must review a safe way past 0024's `GRANT ... TO CURRENT_USER` and repeat the matching-image rehearsal. The Task14a prompt forbids editing merged migrations. | Blocking: live migration. |
| ⬜ | A full raw database restore worked locally, but CLI restore into an initialized Supabase image failed on Auth version drift. Prove a managed-project or matching-stack recovery route including Auth sign-in, then take a fresh encrypted off-site export before live apply. The 2026-10-14 raw dump is older than both new backups. | Blocking: reliable Free-tier rollback; service recovery time and lost-write window unmeasured. |
| ⬜ **FOUNDER:** | After the migration fix and recovery drill pass, review the new evidence and explicitly approve the exact 0010–0028 live apply; separately approve any confirmed backfill. | Blocking: live schema and dashboard acceptance. |
| 🟡 | Live 0000 and 0009 ledger hashes differ from current files. 0000 matches its original seven-policy Git version; 0009's sole drop-table effect is present, though its historical SQL text is unknown. | Task20 lead reviews the 0000 policy disposition; no merged SQL or live policy was changed. |
| ⬜ | Admin/auditor sign-in, Task2/Audit/Questions/Security views and Company A/B isolation have not run against migrated live data. | Blocking: localhost dashboard restored claim. |

## Test coverage

The encrypted archive authenticated and its 781-entry table of contents
opened. A single-transaction application-schema restore took 15.8 s and
matched the source's 10 ledger entries/seven policies before migration.
Local migrations took 6.4 s and produced 29 ledger entries. The audit reader
role could be entered in a transaction for a tenant-bound SELECT. Dry runs:
Task19g two tenants, zero candidate/skipped rows; Task4 pending reconciliation
zero selected/changed; security seal zero due tenants. `/health` was HTTP 200
on 8081. Local `vector` is 0.8.7; the live project currently offers 0.8.2.

`npm run typecheck`, `npm run lint`, `npm exec --workspace=apps/api --
drizzle-kit check`, and the command-scoped `npm test` passed; 1,265 tests,
zero failures. No browser, real user-role or full Supabase Auth recovery test
has passed yet.

The October 24 Free-tier rehearsal authenticated three CLI exports and
restored the October 23 full raw dump into an empty matching Supabase
PostgreSQL image on 55434 in 11.3 s with original owners. Live and restored
counts matched: Auth users 5, identities 6, storage objects 0, Drizzle
entries 10, tenants 2, repositories 15, public tables 42 and Auth tables 27.
The subsequent migration attempt crashed the local backend at 0024; the
cluster recovered with 10 ledger entries. This supersedes the generic
PostgreSQL migration pass as a live-readiness signal.

## Integration test impact

No new integration test was added. The existing migration and product smoke
gates remain blocking for the live deployment. The local rehearsal is
agent-verified only; it does not certify the founder's hosted project.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T14a-01 | Restored application schemas, 0010–0028, audit role, post-step dry runs and API `/health` on isolated ports | Blocking: live migration decision | 🔴 generic PostgreSQL pass; matching Supabase image crashed at 0024 |
| IT-T14a-02 | Admin/auditor dashboard and Company A/B isolation against migrated live project | Blocking: dashboard restored claim | ⬜ founder browser run |

## Integration notes

The live API configuration currently uses the transaction pooler on 6543.
Use direct/session mode 5432 for the eventual migration and backup. Migration
0024's role-membership `GRANT ... TO CURRENT_USER` crashed the matching local
Supabase image. Do not apply it unchanged to live; obtain a reviewed fix from
the owning security/database task without silently rewriting the merged SQL.
If deployment changes to a separate API runtime role, that role will also
need reviewed membership before auditor reads.
Do not run any command with `TASK5_EPHEMERAL_DATABASE=1` or
`TASK6_EPHEMERAL_DATABASE=1` against this persistent project. The local
rehearsal container remains named `trackai-task14a-rehearsal-pg` on 55433;
the matching-image `trackai-task14a-recovery-pg` is on 55434. Encryption keys
and archives are private local files, not Git artifacts.

## Effort (estimate vs actual)

| Estimate (× T6) | Actual so far (× T6) | Cause of difference |
|---|---|---|
| about 0.10× | about 0.13× | Full encrypted dump/restore, PostgreSQL-major correction and the sandbox test rerun. Live migration, founder browser checks and review are not included yet. |
