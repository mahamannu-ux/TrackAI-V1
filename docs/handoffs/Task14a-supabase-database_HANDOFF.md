# Task14a-supabase-database Handoff — Supabase schema recovery

> Status: 🟡 Founder-authorized 0024 correction passed on local and disposable
> managed Supabase copies. The founder supplied a Task20 lead approval for
> live-apply consideration with conditions. Live version parity, Task16e2
> notification, an off-site backup and separate live-apply approval remain. The
> live project remains at 0009.

Branch `task/Task14a-supabase-database`. Stage 1 was approved on 2026-10-23.
This session explains Supabase's Auth/database role, inventories the live
ledger, stores an encrypted backup and rehearses migrations 0010–0028 on a
restored application-schema copy. It has made **no live database write** and
has not started an API on 8080 or PostgreSQL on 55432.

## At a glance

| | Item | Status |
|---|---|---|
| Discovery | Live ledger: 10 records through 0009; 19 pending through 0028. Supabase transaction pooler on 6543; PostgreSQL 17.6. | ✅ |
| Backup | October 23 encrypted full `pg_dump`; October 24 encrypted Supabase CLI roles/schema/data exports under private `_task14a_backup_*` directories. The October 24 CLI exports restored to a disposable managed Supabase project in 129.0 s. | 🟡 managed database restore, recovered email sign-in after a disposable password reset, and one `custom:okta` sign-in passed; second provider and full recovery timing remain unproved |
| Rehearsal | `public` + `drizzle` restored on PostgreSQL 17 at 127.0.0.1:55433; migrations to 0028 in 6.4 s; 29 ledger records; Drizzle check and three post-step dry runs passed. | ✅ for application-schema scope |
| Matching Supabase image | Full raw dump restored to an empty database on `supabase/postgres:17.6.1.136` at 55434; Auth and TrackAI table counts matched live. Original 0024 crashed, then the founder-authorized correction applied 0010–0028 in 6.5 s; ledger reached 29 and dry runs passed. | 🟡 local pass; review and hosted recovery remain |
| Disposable managed project | Restored CLI roles/schema/data in 129.0 s; copied email user signed in after a disposable password reset. Migrations 0010–0028 committed in 77.8 s during a flawed Node probe; read-only inspection confirmed ledger 29, Auth users 5, public tables 84, audit role membership, two policies and vector 0.8.2. Three default post-step dry runs passed and ledger stayed at 29. The founder also completed `custom:okta` browser sign-in and saw the existing restored user's current sign-in time. | 🟡 managed database and two Auth routes passed; second custom provider and full dashboard remain pending |
| API | This branch's API used 8081 against the rehearsal copy; `/health` returned HTTP 200, then the process was stopped. The founder reached the disposable-project dashboard after Okta sign-in, with expected data errors because the API was stopped. | 🟡 complete dashboard views require an API against the intended database; live acceptance requires live migration |
| Quality | Typecheck, lint, Drizzle file check, and 1,265/1,265 tests passed. | ✅ |
| Review | Independent review found a helper TLS gap; commit `1a3e9db` pinned the host and requires CA/hostname verification for every database connection. The independent re-review found no further actionable issues. The founder supplied the Task20 lead's review of `93805f8`: approved for live-apply consideration with five conditions and no further 0024 edit. | 🟡 conditions and Task16e2 notification pending |

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
comprise one email/password account and four users with Okta identities. The
copied email account later passed an Auth-service sign-in after its password
was reset in this disposable project. The founder reported both custom OAuth
providers present and enabled. Read-only SQL showed one tenant routed through
`custom:okta` and one through `custom:okta-oidc-custb`; neither uses the SAML
fallback. After adding the disposable project's callback as a second URI in
the existing Okta app and allowing `http://localhost:3001/dashboard` in the
disposable Supabase URL configuration, the founder reached the local dashboard
through `custom:okta`. The existing restored user showed a current sign-in
time in the disposable Auth user list. This is founder-reported Auth evidence;
the founder elected to skip a second browser sign-in for the test-only tenant,
so `custom:okta-oidc-custb` and full dashboard data remain unverified. The
destination's PostgreSQL is 17.11; the source snapshot was 17.6.
The encrypted Auth export includes two custom OAuth provider rows, one SAML
provider row, one SSO provider row and one SSO domain row. Their presence in
the export does not prove that the new project's provider secrets, callbacks
and service settings can complete an Okta sign-in.

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
exit status, but no PostgreSQL error or failed-statement detail. The later
Node probe identified TLS certificate rejection before SQL as the cause. The
`--inspect` mode confirmed PostgreSQL 17.11, five Auth users, 42 public tables,
ten ledger records and the 0009 checkpoint after the failure. A `--probe`
mode first executed all 19 pending SQL files inside a transaction and rolled
back; every statement passed. The expanded probe also tested all Drizzle
ledger inserts and rolled back; it passed and left the destination at 0009.
The remaining difference was the Node/Drizzle execution path. An attempted
`--node-probe` first reproduced the failure before SQL: Node reported
`SELF_SIGNED_CERT_IN_CHAIN` for the pooler TLS connection. The helper was
changed to use the disposable project's Supabase CA certificate with
`sslmode=verify-full`; libpq verified its TLS certificate and hostname. A
second `--node-probe` then exited zero after 77.8 s, but its checkpoint check
reported a change. **The Node probe had a transaction design error:** Drizzle's
migrator starts and commits its own transaction, defeating the proposed outer
rollback. The command likely committed 0010–0028 despite printing a
`pass_rolled_back` marker. The subsequent read-only `--inspect` reported
PostgreSQL 17.11, five Auth users, 84 public tables, 29 ledger entries through
0028, audit membership true, both audit policies and vector 0.8.2. Therefore
the migration did commit. The unsafe Node probe has been removed. Do not run
`MIGRATE` or restore again. The helper's `--poststeps` mode now checks this
exact migrated checkpoint and runs the three default dry-run post-steps.
The founder ran it: Task19g reported two tenants and zero merger candidates;
Task4 reported zero selected rows and `database_changes=none`; security seal
reported dry-run mode with no signing or writes and no seal outcomes. All
three commands exited zero, and the destination remained at 0028. No apply
flag was used. The helper's Task4 summary parser was corrected to display
`none` rather than `?` for that value; the private log already showed `none`.
An independent review then found that the original restore helper and the
Python read-only checks used encrypted `sslmode=require` without authenticating
the pooler certificate, and accepted any pooler hostname. The helper now pins
the disposable host and uses the downloaded CA with `verify-full` for every
database connection, including the `psql` restore stream. This closes the
future-use gap; it does not retroactively authenticate the earlier restore.

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
  empty database with matching row/schema counts; at that stage Auth service
  sign-in and a managed Free-tier restore were not yet proved. Both later
  passed for the bounded cases described above.
- The matching-image migration first crashed at 0024's `GRANT ... TO
  CURRENT_USER`. The local cluster recovered and Drizzle stayed at 0009.
  Supabase's [image issue #2348](https://github.com/supabase/postgres/issues/2348)
  documents the same statement-form crash. After the founder's exception,
  the equivalent dynamic quoted-role grant passed on the full restored copy.
  The live project's image revision and Auth service behavior remain unproved.

## Known limitations

| Status | Limitation | Impact |
|---|---|---|
| ⬜ | The founder supplied the Task20 lead's approval of the 0024 correction at `93805f8`, conditional on a read-only live `version()` check and hosted-version rehearsal if different from 17.11, pooler audit/cross-tenant smoke after apply, a two-hash runbook, Task16e2 lead notification, and B5 disposition. The runbook and B5 disposition are recorded; live version and Task16e2 notification remain. | Blocking: live migration until pre-apply conditions are met. |
| ⬜ | The CLI roles/schema/data backup restored into a disposable managed project in 129.0 s with matching key counts; 0010–0028 and three default dry runs then passed. A copied email account signed in after a disposable password reset, and `custom:okta` reached the local dashboard for an existing restored user after an additive Okta callback. The second test tenant's `custom:okta-oidc-custb` sign-in was deferred by the founder; original-password sign-in also remains unproved. Document the callback and URL-configuration steps, then take a fresh encrypted off-site export before live apply. The 2026-10-14 raw dump is older than both new backups. | Blocking: complete Free-tier service recovery; full recovery time and lost-write window unmeasured. |
| ⬜ **FOUNDER:** | After the migration fix and recovery drill pass, review the new evidence and explicitly approve the exact 0010–0028 live apply; separately approve any confirmed backfill. | Blocking: live schema and dashboard acceptance. |
| 🟡 | Live 0000 and 0009 ledger hashes differ from current files. 0000 matches its original seven-policy Git version; 0009's sole drop-table effect is present, though its historical SQL text is unknown. The Task20 lead said not to add the four missing B5 policies; Task4 must separately remove the seven existing direct-read policies or disable `public` Data API exposure, and check live Auth sign-up/email confirmation before claiming security. | B5 disposition recorded; separate Task4 fix and Auth setting check remain. |
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
zero failures. These gates were rerun after local `git merge main` reported
already up to date; the sandbox-only unit run first hit loopback failures,
then the same suite passed with command-scoped loopback access. The later TLS
helper fix passed Python syntax, pinned-host/verified-TLS connection checks
and independent re-review. One copied Auth user signed in to the disposable project after
a password reset; browser roles and full Supabase Auth recovery remain unproved.

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
runs reported no data changes. The matching-image run added local owner/role
evidence beyond the generic PostgreSQL pass. Managed-project recovery and
migration were then checked separately as described above.

## Integration test impact

No new integration test was added. The existing migration and product smoke
gates remain blocking for the live deployment. The founder ran the managed
restore, copied-user sign-in, migration and post-step dry runs; they do not
certify the original live project's dashboard.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T14a-01 | Restored application schemas, 0010–0028, audit role, post-step dry runs and API `/health` on isolated ports | Blocking: live migration decision | 🟡 local image plus founder-run disposable managed restore/migration and post-step dry runs passed; owner review and full recovery decision remain |
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
| about 0.10× | about 0.30× | Full encrypted dump/restore, managed Free-tier recovery rehearsal, two migration failure investigations, TLS correction and sandbox test rerun. Live migration and founder browser checks are not included. |
