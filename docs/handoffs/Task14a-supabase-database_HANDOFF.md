# Task14a-supabase-database Handoff — Supabase schema recovery

> Status: 🟡 Founder-authorized 0024 correction passed on the full restored
> Supabase PostgreSQL copy. Owner review, a usable Free-tier recovery route
> and separate live-apply approval remain. The live project remains at 0009.

Branch `task/Task14a-supabase-database`. Stage 1 was approved on 2026-10-23.
This session explains Supabase's Auth/database role, inventories the live
ledger, stores an encrypted backup and rehearses migrations 0010–0028 on a
restored application-schema copy. It has made **no live database write** and
has not started an API on 8080 or PostgreSQL on 55432.

## At a glance

| | Item | Status |
|---|---|---|
| Discovery | Live ledger: 10 records through 0009; 19 pending through 0028. Supabase transaction pooler on 6543; PostgreSQL 17.6. | ✅ |
| Backup | October 23 encrypted full `pg_dump`; October 24 encrypted Supabase CLI roles/schema/data exports under private `_task14a_backup_*` directories. The October 24 CLI exports restored to a disposable managed Supabase project in 129.0 s. | 🟡 managed database restore and one recovered-user sign-in after a disposable password reset passed; original password and Okta settings unproved |
| Rehearsal | `public` + `drizzle` restored on PostgreSQL 17 at 127.0.0.1:55433; migrations to 0028 in 6.4 s; 29 ledger records; Drizzle check and three post-step dry runs passed. | ✅ for application-schema scope |
| Matching Supabase image | Full raw dump restored to an empty database on `supabase/postgres:17.6.1.136` at 55434; Auth and TrackAI table counts matched live. Original 0024 crashed, then the founder-authorized correction applied 0010–0028 in 6.5 s; ledger reached 29 and dry runs passed. | 🟡 local pass; review and hosted recovery remain |
| API | This branch's API used 8081 against the rehearsal copy; `/health` returned HTTP 200, then the process was stopped. | 🟡 browser sign-in and dashboard views require live migration/founder accounts |
| Quality | Typecheck, lint, Drizzle file check, and 1,265/1,265 tests passed. | ✅ |
| Review | Task20 lead security review and independent cross-agent review remain. | ⬜ |

The founder created disposable Supabase project `glwwxaobocwoczvjmrod` for a
managed recovery drill. Its SQL Editor read-only check reported PostgreSQL
17.11, zero Auth users, zero public tables and no Drizzle ledger. The local
`docs/ops/task14a_restore_disposable.py` helper authenticates the October 24
encrypted CLI exports, requires this exact destination project and a fresh
empty-database check, then streams roles/schema/data to `psql` in one
transaction. It was syntax-checked and its archive-only mode passed. The password is requested
only in the founder's interactive Terminal; no credential belongs in chat.

The first managed restore attempt exited at the roles export's
`ALTER ROLE "supabase_admin" SET "statement_timeout" TO '0'` with a reserved-role
permission error. It used `psql --single-transaction`; no post-restore state
was claimed. The helper now omits exactly that provider-owned timeout setting
from its in-memory restore stream, leaving the authenticated archive intact.
Its next run must recheck zero Auth users, zero public tables and no Drizzle
ledger before writing. The corrected managed restore passed on 2026-10-24:
`psql` exited zero in 129.0 s; the private diagnostics contain zero ERROR or
WARNING lines. Destination counts were five Auth users, 42 public tables and
10 Drizzle ledger entries. It is a database restore into a new managed
project, not a rollback of the original project. The exported identities
comprise one email/password account and four users with Okta identities;
Auth service sign-in and provider settings still need validation. The
destination's PostgreSQL is 17.11; the source snapshot was 17.6.

The founder does not know the original email/password account's password.
`docs/ops/task14a_verify_restored_auth.py` locates that one
copied account from the encrypted backup, asks locally for the destination's
publishable and secret keys and a new temporary password, resets only the
copied account through Supabase Auth Admin, then signs in and resolves its
session. It passed syntax, backup selection and non-interactive refusal checks.
The founder then ran it on the disposable project: Auth Admin found the
restored user, reset that copy's password, issued a sign-in session and
resolved the session to the same user. This proves the restored account is
usable after a password reset, not that its original password or Okta provider
settings work. No keys, email or password were printed or stored by the helper.

`docs/ops/task14a_migrate_disposable.py` hardcodes the disposable project
reference and session-pooler host, asks locally for that project's database
password, verifies the restored 0009 ledger and counts, then runs 0010–0028
and the three default dry-run post-steps. It captures command output only in
private owner-readable logs. Its first managed migration attempt exited 1 in
2.7 s on 2026-10-24. The log contains Drizzle's progress spinner and npm's
exit status, but no PostgreSQL error or failed-statement detail. Thus the
cause is unknown and no successful managed migration is claimed. The
`--inspect` mode confirmed PostgreSQL 17.11, five Auth users, 42 public tables,
ten ledger records and the 0009 checkpoint after the failure. A `--probe`
mode first executed all 19 pending SQL files inside a transaction and rolled
back; every statement passed. The probe now also tests Drizzle's ledger
inserts, the remaining untested write step, in the same rollback-only
transaction. Its expanded result is pending. Do not retry the committing
migration until the underlying error is understood.

## Implemented interfaces

No application code changed. With the founder's explicit exception to the
merged-migration freeze, 0024's role-membership grant now resolves
`current_user` as a quoted identifier in dynamic SQL. Operational documents:

- `docs/plan/TASK14_SUPABASE.md`: inventory, architecture choices, migration
  risks, exact port separation, approval gates and observed rehearsal.
- `docs/ops/DATABASE_MIGRATION_RUNBOOK.md`: future backup, rehearsal, apply,
  post-step, smoke and rollback sequence.

## Founder-approved decisions

1. On 2026-10-23 the founder approved **backup and local rehearsal only**.
2. Task14a uses API port **8081** and rehearsal PostgreSQL port **55433**;
   Task20j's API on 8080 and existing database on 55432 remain untouched.
3. On 2026-10-24 the founder authorized a narrow correction to merged 0024
   after its original role-specification grant crashed the matching image.

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
- The matching-image migration first crashed at 0024's `GRANT ... TO
  CURRENT_USER`. The local cluster recovered and Drizzle stayed at 0009.
  Supabase's [image issue #2348](https://github.com/supabase/postgres/issues/2348)
  documents the same statement-form crash. After the founder's exception,
  the equivalent dynamic quoted-role grant passed on the full restored copy.
  The live project's image revision and Auth service behavior remain unproved.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ | Task16e2/Task20 owners must review the founder-authorized 0024 correction and its changed file hash. The matching-image rehearsal passed, but independent security review has not. | Blocking: live migration. |
| ⬜ | The CLI roles/schema/data backup restored into a disposable managed project in 129.0 s with matching key counts. A copied email account signed in after a disposable password reset; original-password and Okta sign-in remain unproved. Decide the Okta configuration/recovery procedure, then take a fresh encrypted off-site export before live apply. The 2026-10-14 raw dump is older than both new backups. | Blocking: complete Free-tier service recovery; full recovery time and lost-write window unmeasured. |
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
The first migration attempt crashed the local backend at 0024; the cluster
recovered with 10 ledger entries. After the authorized correction, the full
copy migrated to 29 ledger entries in 6.5 s. Audit role membership, two
tenant-bound policies and a rolled-back tenant-scoped read passed; Auth users
remained five and `vector` was 0.8.2. Task19g, Task4 and security-seal dry
runs reported no data changes. This matching-image result is stronger than
the generic PostgreSQL pass, but does not prove managed-project recovery.

## Integration test impact

No new integration test was added. The existing migration and product smoke
gates remain blocking for the live deployment. The local rehearsal is
agent-verified only; it does not certify the founder's hosted project.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T14a-01 | Restored application schemas, 0010–0028, audit role, post-step dry runs and API `/health` on isolated ports | Blocking: live migration decision | 🟡 matching Supabase image passed after authorized 0024 correction; owner review and recovery gate remain |
| IT-T14a-02 | Admin/auditor dashboard and Company A/B isolation against migrated live project | Blocking: dashboard restored claim | ⬜ founder browser run |

## Integration notes

The live API configuration currently uses the transaction pooler on 6543.
Use direct/session mode 5432 for the eventual migration and backup. Migration
0024's original role-membership `GRANT ... TO CURRENT_USER` crashed the
matching local Supabase image. The founder-authorized dynamic quoted-role
replacement passed locally. Obtain Task16e2/Task20 review before applying it
live. Drizzle selects pending migrations by timestamp in this version; a
database already past 0024 keeps its recorded old hash, so review every
target's ledger before release. The live target is still at 0009.
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
