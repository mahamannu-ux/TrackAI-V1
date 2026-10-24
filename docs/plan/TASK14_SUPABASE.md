# Task14a: Supabase and the localhost dashboard — Stage 1 plan

**Status, 2026-10-24:** Stage 1 and the Free-tier backup/rehearsal work were
approved. The live database reached 0028 on 2026-10-24. The founder separately authorized
a narrow correction to merged migration 0024 after a matching-image crash;
the corrected migration passed on restored local and disposable managed copies.
The founder supplied the Task20 lead's approval at `93805f8` for live-apply
consideration with conditions. Read-only live `version()` confirmed PostgreSQL
17.6 and the dashboard reported image `17.6.1.155`. An exact-tag local
full-copy migration rehearsal passed, and Task20 accepted it for condition 1;
no hosted 17.6 disposable is required. The Task16e2 lead was notified on
2026-10-24. The founder temporarily waived off-site archive and separate key
storage through 2026-10-31, with a weekly reminder. A fresh encrypted local
backup was taken and restored on the exact-tag image. The founder separately
approved the live apply at `4d2743e`; Drizzle exited zero in 79.3 s, and
postflight found five Auth users, 84 public tables and 29 ledger entries.
All three default live dry runs passed. API `/health` passed on 8081 against
the live 6543 transaction-pooler configuration. The founder reported that
Company A admin Audit, Task2 lifecycle, Questions and Security loaded after
a fresh incognito sign-in; a known Company B audit event returned HTTP 404.
An earlier normal-window data/navigation failure remains unexplained. Read-only
membership counts show no active auditor account, so auditor sign-in is untested.

## In plain words

Supabase signs people into the dashboard and hosts the PostgreSQL database used
by this checkout. TrackAI's API checks the sign-in token, decides the person's
tenant and permissions, and reads PostgreSQL. Drizzle SQL files, not the
`supabase/` stub, change TrackAI's schema. The localhost dashboard is a web
client of the API and Supabase Auth; it does not normally read tables directly.

The live database is **19 migrations behind** this branch (0010–0028). Applying
them is a database release, not a routine `db:push`. The proposed order is a
verified backup, restored local rehearsal, reviewed migration and backfill,
then a separate approval for the live apply. The rehearsal PostgreSQL will use
**127.0.0.1:55433**, and the Task14a API will use **127.0.0.1:8081**. Port
55432, the `trackai-task20j-pg` container, port 8080, and Task20j's files stay
untouched. Before either server starts, check that 55433 and 8081 are free.

## What the code and current configuration establish

| Concern | Finding |
| --- | --- |
| Human sign-in | `apps/web/src/lib/supabase.ts` uses `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `apps/web/src/lib/api.ts` sends the session JWT as a bearer token to the API. `apps/api/src/core/middleware/auth.ts` checks its signature against `SUPABASE_URL`'s JWKS; `SUPABASE_JWT_SECRET` is present in the main checkout's API environment but this middleware does not read it. |
| Database | `apps/api/src/core/db/index.ts` constructs a `pg.Pool` from `DATABASE_URL`. The main checkout's active URL was parsed without printing it: it targets Supabase's shared **transaction pooler on 6543**, not a direct 5432 connection. The login role is `postgres`; the server reported `CREATEROLE=true`, `SUPERUSER=false`. A separate non-owner API runtime role has not been demonstrated. |
| Migrations | `apps/api/drizzle.config.ts` reads `DATABASE_URL`; `npm run db:migrate -w apps/api` uses Drizzle Kit. `supabase/` is a linked-project stub. |
| Storage and functions | No TrackAI application use of Supabase Storage or Edge Functions was found in this checkout. |
| Local ports | `apps/api/src/index.ts:4` defaults to 8080; `apps/web/src/lib/api.ts:19` defaults to 8081. Set `PORT=8081` on the API and `NEXT_PUBLIC_API_URL=http://127.0.0.1:8081` on the web process explicitly. Set `FRONTEND_URL` to the actual local web origin for CORS. |

The current API pool is long-lived. Transaction pooling can work because
`audit-reader.ts:21-29` sets tenant state and role inside the caller's
transaction. The production code search found transaction-scoped advisory
locks (`pg_advisory_xact_lock`), and no `LISTEN`, session advisory lock, or
non-local `SET` in request code. The `pg`/Drizzle path does not explicitly
enable named prepared statements. Supabase says transaction mode does not
support prepared statements or session state; rehearse the actual API queries
through 6543 before treating this as verified. Migration and `pg_dump` should
use a direct or session-mode connection, to be obtained from Supabase's Connect
dialog; neither should be run through the API's transaction pooler by default.

## Live schema inventory (read-only SQL, 2026-10-23)

`drizzle.__drizzle_migrations` has **10 records**, with journal timestamps for
0000–0009; the record ID sequence has a gap, which does not imply a missing
migration. The repository journal has **29 entries**, 0000–0028. Pending:
0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021,
0022, 0023, 0024, 0025, 0026, 0027, 0028. The Task19g handoff independently
reported the same end point at 0009.

**Ledger drift:** the live hashes for 0000 and 0009 differ from the current
SQL files. The 0000 hash matches the original Git version, which created
**seven**, not 11, browser policies; the live seven match that version.
Migration 0009's current file only drops `public.items`, and that table is
absent live, although its hash did not match the local file history. Drizzle
orders pending migrations by timestamp and may not detect this drift. Do not
alter a merged migration or repair the ledger by hand. The 0000 policy
difference needs a reviewed disposition; 0009's intended schema effect is
present, but its historical SQL text remains unverified.

`pgcrypto` 1.3 is installed. `vector` is available at 0.8.2 but **not yet
installed**, consistent with pending 0011. The live `postgres` role can create
roles but is not a superuser; this supports, but does not prove, 0024's full
grant/policy sequence. There is no live `security_findings`, `attesta_records`,
or `fleet_configurations` table yet, so their later migrations cannot be
judged from live row counts until the local rehearsal reaches them.

**B5:** migration `0000_solid_annihilus.sql:248-263` specifies 11
`authenticated` SELECT policies. Seven exist. RLS is on for all 11 targets,
but policies are absent on `scm_repositories`, `scm_pull_requests`,
`scm_contributors`, and `scm_branches`. The frontend uses the protected API.
The Task20 lead's 2026-10-24 disposition is **not** to add the missing four:
the seven existing policies permit direct Data API reads based on a JWT email
domain and may expose tenant rows if Auth allows unverified sign-up. Task4
should separately remove those seven policies in a reviewed migration or
disable `public` exposure in Supabase Data API settings. On 2026-10-24, the
founder reported that live Auth had **Allow new users to sign up=on** and
**Confirm Email=off**. Later the same day the founder saved **Allow new users
to sign up=off** in the live dashboard. This stops new self-registration but
does not remove the seven direct-read policies or assess existing accounts.
Do not call the project secure until Task4 handles the underlying direct-read
policies. No policy change is part of Task14a's
migration plan.

## Pending migration risk and required follow-up

| SQL | Main risk or check |
| --- | --- |
| `0010_cooing_darkhawk.sql:108-125` | Evidence-table foreign keys and indexes; check existing rows and lock duration. |
| `0011_plain_xavin.sql:1,39-58` | Installs `vector`, updates every existing intention, then requires new NOT NULL columns and builds indexes. Check extension privileges and intention count; this is a likely table rewrite/long lock. |
| `0012_gray_warbird.sql:1-7` | Alters existing evidence tables; compare pre-existing constraints. |
| `0013_task6_security_storage.sql:93-107` and `0014_spotty_serpent_society.sql:92-126` | Security/audit tables and triggers; check old data against constraints and trigger creation on the restored copy. |
| `0015_aromatic_blink.sql:1-10` | Alters existing tables; inspect lock and validation time in rehearsal. |
| `0016_attesta_subjects.sql:59-89` through `0023_attesta_audit_seals.sql:71-277` | New Attesta tables, constraints, indexes and append-only triggers; test pgcrypto/`pg_catalog.sha256` support and pre-existing row compatibility. |
| `0024_audit_db_role.sql` | Creates `trackai_audit_reader`, grants two SELECT privileges and membership to the migration role, then adds tenant-bound policies. The original `GRANT ... TO CURRENT_USER` crashed a matching local Supabase image; the founder-authorized correction resolves `current_user` to a quoted identifier inside dynamic SQL and passed the full-copy rehearsal. The live migration role has `CREATEROLE` but is not superuser. A distinct API runtime role needs an additional reviewed `GRANT trackai_audit_reader TO <runtime role>`; otherwise audited reads return 503 (`audit-reader.ts:22`, Task16e2 handoff). Do not assume the `postgres` login is that distinct runtime role. |
| `0025_security_v2_ingest.sql:192-260,267-350` | Widens `security_findings` with many drops/adds and checks, and adds seven tenant tables. The first creation of `security_findings` in 0013 precedes this; measure lock time and validate rows on the restored copy before live apply. |
| `0026_security_settings_signing.sql:123-135` | Replaces fleet checks and adds signed-settings tables/triggers; check existing fleet rows. |
| `0027_attesta_security_seals.sql:55-104,305-436` | Replaces the `attesta_records` shape check, adds seal/report tables and guard triggers; validate old records and lock time. |
| `0028_friendly_mystique.sql:1-2` | Adds nullable merger fields. Afterward, run Task19g merger backfill in dry-run mode, review counts per tenant, then separately approve `--confirm`. |

After schema apply, also review whether `reconcile:task4-wave5-pending` has
stranded pending batches; its default dry run must precede any confirmed
repair. Task15op requires an initial `attesta:security-seal --now` dry run,
then a separately approved `--confirm --now` before security period reports.
These are data-writing operations and are not bundled into schema approval.

## Architecture choice for the founder

TrackAI uses Supabase-specific **Auth** (including JWT/JWKS), the hosted
`auth` schema and `authenticated` role, and its connection endpoints. Managed
backup, PITR, and network controls also depend on the chosen Supabase plan.
The data model and Drizzle migrations are PostgreSQL and mostly portable,
subject to available extensions, roles, trigger privileges, and an Auth
adapter. Task14's GCP SaaS mode can retain Supabase Auth while choosing a
private GCP PostgreSQL later; a customer VPC or self-hosted mode needs its
own Auth/JWKS issuer, PostgreSQL operations and backup contract. Task15n's
KMS/Rekor/TSA signing and trust decisions are separate from the database
provider; Supabase does not supply or validate those keys.

Recommended split: disposable local PostgreSQL and the Task20j local auth
stub for development; a separate Supabase project for the founder's persistent
dashboard; a future production project/database with its own access and
recovery policy. This costs another database/project and operational setup,
but prevents development resets and migration rehearsals from affecting
production data. No provider or plan-tier decision is made here. Supabase's
current documentation says paid Pro/Team/Enterprise projects have daily
backups with different retention; PITR is an add-on and restore interrupts
the project. Confirm the project's actual plan, entitlement, backup age,
network restrictions and price in its dashboard before scheduling a live
change. Sources: [connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[backups](https://supabase.com/docs/guides/platform/backups).

## Proposed Stage 2 sequence and approval gates

1. **Before backup:** record the project reference privately, backup tier,
   available restore point, direct/session connection method, current ledger
   and target Git SHA. Quiesce only the relevant writes during the live window.
   Verify that 8081 and 55433 are free. Never inspect or stop the Task20j
   container or bind 8080/55432.
2. **Backup (founder approval to create it):** take a Supabase backup/PITR
   point if the project supports one, and `pg_dump` a full logical copy via
   direct/session mode to a locally encrypted, owner-only file kept by the
   founder outside the repository. Include `public`, `drizzle`, and needed
   `auth` objects; verify the dump is readable without printing rows or
   secrets. A `pg_dump` is a snapshot, not a restore test.
3. **Rehearsal:** restore to a named isolated PostgreSQL 17 + pgvector
   container bound **only to 127.0.0.1:55433**. This copy must not be the
   `trackai-task20j-pg` container. Stop if Supabase-managed roles/extensions
   cannot be represented faithfully. Compare pre-0010 schema and ledger,
   including the two hash discrepancies and B5 policy set. Apply
   `npm run db:migrate -w apps/api` with `DATABASE_URL` pointed solely to
   55433; run `npm exec --workspace=apps/api -- drizzle-kit check`; capture
   migration duration and only names/counts. Rehearse the audit role grant
   if a separate runtime role exists. Dry-run each backfill/reconcile/seal
   command and inspect per-tenant counts.
4. **Checkpoint:** founder reviews the rehearsal evidence, backup restore
   result, lock timings, policy/hash findings, and exact live scope. Obtain
   explicit approval for the live migration. If schema drift or unbounded
   locks appear, revise the plan before approval; never edit merged SQL.
5. **Live apply:** use the approved direct/session database connection and
   `npm run db:migrate -w apps/api`. Confirm 29 journal entries, expected
   extensions/tables/policies and `drizzle-kit check`. Apply the reviewed
   runtime-role grant if needed. Run post-steps in dry-run mode; seek separate
   approval for each `--confirm` based on its actual counts.
6. **Smoke:** start this branch's API with `PORT=8081` and the live project
   URL, and the web app with `NEXT_PUBLIC_API_URL=http://127.0.0.1:8081`.
   Check `http://127.0.0.1:8081/health`, then founder browser sign-in for an
   admin and auditor; load Task2 lifecycle, Audit, Questions and Security.
   Verify a Company A user cannot see Company B data. Record status and
   counts only. Keep Task20j's API on 8080 unchanged.
7. **Rollback route:** stop this Task14a API and any writing jobs; use a
   confirmed provider restore point or the separately rehearsed CLI
   roles/schema/data recovery package in a matching Supabase environment,
   then reconnect the old application version and re-run the smoke. The raw
   encrypted `pg_dump` alone is not a proven full-project rollback. Database
   restore can overwrite post-backup writes and cause downtime, so it requires
   a separate explicit decision. **Recovery time is unknown until a timed
   restore rehearsal**; record the measured time and any data-loss window
   before live approval rather than promising an untested interval.

**Checkpoint 1:** the founder approved this backup and rehearsal plan on
2026-10-23. Live migration and each data backfill remain separate approval
gates.

## Stage 2 rehearsal result (2026-10-23)

The founder approved the backup and local rehearsal. The server reports
PostgreSQL **17.6**, so the named `trackai-task14a-rehearsal-pg` container uses
`pgvector/pgvector:pg17`, bound only to **127.0.0.1:55433**. Port 55432's
existing container was not stopped or changed. The API was briefly started
against the rehearsal copy with `PORT=8081`; `/health` returned **HTTP 200**,
and that API process was then stopped. Port 8080 was not used.

The live project was read through the session pooler on 5432 for a full
`pg_dump` archive. The archive was streamed directly into AES-256-GCM
encryption; no plaintext dump file was created. Its authenticated ciphertext
is at `/Users/manishmahajan/AIProjects/_task14a_backup_20261023/supabase_pre0010_full.dump.gcm`
and its owner-only 32-byte key is in the same private directory as
`backup.key`. Keep **both** files; neither is in this repository. The
encrypted archive is 17,087,395 bytes including its header and tag. The GCM authentication
check and `pg_restore` table-of-contents read both passed (781 entries).

The `public` and `drizzle` schemas restored from that archive in one local
transaction in **15.8 seconds**. A local `authenticated` role and an
`auth.jwt()` stub supplied only the dependency needed by the existing seven
browser policies; Supabase-managed Auth data/functions were not restored.
Before migration the copy matched the source's 10 ledger entries and seven
browser policies. Drizzle then applied 0010–0028 to this copy in **6.4
seconds**; the ledger has 29 entries. `drizzle-kit check` passed. Migration
0024 created the audit reader role; the local application role entered it in
a transaction and completed a SELECT. The three post-step dry runs passed:
Task19g merger backfill saw two tenants and zero candidate/skipped rows;
Task4 pending reconciliation selected/changed zero; the security-seal pass
found no tenant with findings due for a seal. No confirmed backfill ran.
The repository gates passed: typecheck, lint, Drizzle file check and 1,265
tests. The first sandbox test attempt encountered loopback failures and was
stopped; the same `npm test` command passed with command-scoped access.

**Recovery limitation:** this proves a restore of TrackAI's application
schemas, not a complete self-hosted Supabase recovery. The generic pgvector
image lacks `supabase_vault`, which is present in the full archive, and the
rehearsal did not restore the Supabase-managed `auth`, `storage`, `realtime`,
or other service schemas. The local image installed `vector` 0.8.7; the live
project currently offers 0.8.2. Supabase's [restore guide](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
explains why raw full `pg_dump` is not a complete portable platform restore.
For live rollback, confirm an accessible project backup/PITR point in the
Supabase dashboard, or rehearse a full restore with a matching Supabase image
and CLI procedure, before authorizing the live apply. The founder confirmed on
2026-10-24 that this is a Free-tier project with no usable dashboard restore
point. Supabase's current backup guidance recommends manual CLI exports for
Free projects. A prior raw dump dated 2026-10-14 was found locally, but it is
older than the encrypted 2026-10-23 snapshot and neither has passed a complete
Supabase Auth/platform restore. A fresh pre-apply export and a rehearsed manual
recovery route are required if remaining on Free; upgrading to a paid plan is
an optional founder decision, not an assumed prerequisite. Full-project
recovery time remains **unmeasured**. The 0000/0009 hash
differences and four missing B5 browser policies also remain open findings.

## Free-tier recovery rehearsal and migration correction (2026-10-24)

The founder confirmed that the live project is on the Free tier and has no
usable dashboard backup/PITR point. Supabase CLI 2.109.1 produced encrypted
roles, schema and data exports in the private directory
`/Users/manishmahajan/AIProjects/_task14a_backup_20261024/`. The plaintext
exports were removed after encryption and authenticated readback. Their
uncompressed sizes were 358, 107,545 and 64,060,005 bytes respectively. The
data export includes `auth.users`, `drizzle.__drizzle_migrations` and the
TrackAI `public` tables. The encrypted archive and key are currently on the
same machine. On 2026-10-24 the founder explicitly deferred off-site copying
and separate key storage for one week, until a new Mac, external drive or
cloud space is available. A reminder is set for 2026-10-31. This does not
remove the need for a fresh encrypted local backup just before live apply;
loss of this Mac before an off-site copy could lose the recovery material.

Before the live apply decision, `docs/ops/task14a_backup_live.py` used the
verified session pooler and Supabase CA to read-only check the live 0009
checkpoint (PostgreSQL 17.6; Auth users 5; public tables 42; ledger 10). It
wrote a fresh encrypted full custom-format dump to the private
`~/Documents/TrackAI-Task14a-backups/` folder and a new key to the existing
private `_task14a_backup_20261024` folder. Only encrypted bytes were saved;
the archive authenticated after writing. It restored in 11.3 s into a new
empty database on the exact `17.6.1.155` image at 55435 with Auth users 5,
identities 6, public tables 42 and ledger 10. An initial local migration
attempt failed before SQL because the new database had the wrong owner;
ledger remained 10. After matching the earlier rehearsal's `postgres`
ownership on this isolated copy, corrected 0010–0028 passed in 2.7 s and
reached ledger 29, Auth users 5, public tables 84 and both audit policies.
The three default post-step dry runs passed with no apply flags.

An isolated `supabase/postgres:17.6.1.136` container was started on
**127.0.0.1:55434**; its `vector` extension is 0.8.2, matching the live
available version. A direct CLI export restore into its initialized database
did not pass: the image lacked the hosted `auth.jwt()` helper, and after that
helper was copied read-only from live, its `auth.audit_log_entries` table
lacked the hosted `ip_address` column. This is a platform schema-version
mismatch, not a successful CLI recovery drill.

The authenticated October 23 full `pg_dump` did restore in one transaction
to a **new empty database** in the same Supabase PostgreSQL image in 12.4 s.
A second restore preserving original object ownership succeeded in 11.3 s
after creating the image's missing `supabase_realtime_admin` role. Counts
matched the live source at the checkpoint: five `auth.users`, six
`auth.identities`, zero `storage.objects`, 10 Drizzle ledger records, two
tenants, 15 repositories, 42 public tables, 27 Auth tables and one
`auth.jwt()` helper. This proves full **database-content** recovery locally;
it does not prove hosted Auth sign-in, Supabase service configuration, storage
objects, or a restore into an existing managed Free-tier project.

Applying 0010–0028 to the ownership-preserving full copy as the non-superuser
`postgres` role caused the local PostgreSQL backend to **segfault** during
`0024_audit_db_role.sql` at `GRANT trackai_audit_reader TO CURRENT_USER`.
The cluster restarted and recovered; the Drizzle ledger remained at 10, so
the migration transaction rolled back. Supabase has an [open PostgreSQL image
issue](https://github.com/supabase/postgres/issues/2348) for this exact
statement form, including a proposed explicit-role workaround. A synthetic
local transaction using `EXECUTE format('GRANT task14a_grant_probe TO %I',
current_user)` succeeded and was rolled back. The founder then explicitly
authorized an exception to the Task14a prompt's merged-migration freeze. Only
0024's direct role-membership grant was replaced with a dynamic `GRANT` using
`format('%I', current_user)`; its privileges and policies are otherwise
unchanged. On the ownership-preserving full copy, 0010–0028 then applied in
6.5 s as the non-superuser `postgres` role. The ledger reached 29; five Auth
users remained; `vector` was 0.8.2; the audit role membership and two
tenant-bound policies existed. A tenant-scoped audit read succeeded in a
rolled-back transaction. Task19g, Task4 and security-seal dry runs again
reported no data changes. Drizzle's local file check passed. This first image
run alone did not establish hosted revision or Auth behavior; the later
exact-tag and managed-project checks are recorded below.

The correction changes 0024's file hash for a fresh migration. This Drizzle
version chooses pending files using the latest ledger `created_at`, so a
project already beyond 0024 retains its original hash and is not replayed by
this change. The live project is now at 0028. The founder supplied the Task20
lead's approval for live-apply consideration at `93805f8` and acceptance of
the exact-tag rehearsal at `60a1b5c`; the two hashes and remaining conditions
are in `docs/ops/DATABASE_MIGRATION_RUNBOOK.md`. The Task16e2 lead was
notified of the one-statement exception on 2026-10-24. The Free-tier recovery
route and fresh encrypted local backup were rehearsed before the founder
separately approved and ran the live apply. The founder's one-week off-site
storage exception is recorded above. Ports 8080 and 55432 remained untouched.

## Disposable managed-project restore (2026-10-24)

The founder created a separate Supabase Free project for a recovery drill.
Its pre-restore SQL Editor result was PostgreSQL 17.11, zero Auth users, zero
public base tables and no Drizzle ledger. The first CLI restore attempt
stopped in a single transaction when the roles export tried to change the
provider-owned `supabase_admin` timeout setting. The restore helper now omits
exactly that setting from its in-memory stream; the encrypted archive itself
was not changed. The second run passed in **129.0 seconds** with no logged
ERROR or WARNING. It produced five Auth users, 42 public base tables and 10
Drizzle entries, matching the source checkpoint. This demonstrates a
database-content recovery path into a fresh managed project. The backup has
one email/password identity and four users with Okta identities. Auth service
sign-in was then tested through the Auth Admin and user APIs: after resetting
the one copied email account's password **in the disposable project**, Auth
issued a session that resolved to the restored user. The founder later saw both
custom providers enabled and one tenant routed to each. After adding the
disposable callback to the existing Okta app, `custom:okta` signed in an
existing restored user to the localhost dashboard; its API data calls errored
because the API was stopped. The second test tenant's provider sign-in was
deferred by the founder. The original email password and wider project
settings remain unverified. The export
contains two custom OAuth provider rows plus one each for SAML provider, SSO
provider and SSO domain; their database presence does not demonstrate a
working IdP callback or usable project-level secret. Thus the
measured 129.0 seconds is only the database restore portion of a recovery-time
estimate. Live 0010–0028 migration still awaits the Task20 review conditions,
a complete recovery decision and separate founder approval.
The original restore stream used encrypted TLS without checking the pooler's
certificate. An independent review identified this gap; the helper now pins
the disposable host and requires the downloaded CA and `verify-full` for
preflight, restore and postflight. The earlier restore result remains observed
but cannot be retroactively upgraded to a certificate-verified connection.

### Managed migration rehearsal (2026-10-24)

The disposable project then applied 0010–0028 in **77.8 seconds**. This
occurred during a diagnostic Node/Drizzle run that was incorrectly expected
to roll back: Drizzle's migrator committed its own transaction. The unsafe
probe was removed. Read-only follow-up verified PostgreSQL 17.11, five Auth
users, 84 public tables, 29 Drizzle ledger entries through 0028, audit-reader
role membership, both audit policies and vector 0.8.2. The first managed
`db:migrate` attempt had failed before SQL because node-postgres rejected the
pooler certificate chain. The successful run used the downloaded Supabase CA
with `sslmode=verify-full` and hostname verification. The three managed
post-step dry runs then passed: Task19g saw two tenants and zero merger
candidates; Task4 selected zero pending rows and reported
`database_changes=none`; security seal ran without signing or writes and
emitted no seal outcomes. The managed project stayed at 0028. Dashboard/API
smoke remains pending. No write was made to the original live project, which
remains at 0009.

### Exact live-tag local image rehearsal (2026-10-24)

The live dashboard reported PostgreSQL image `17.6.1.155`. The authenticated
October 23 full dump was restored into an empty database in an isolated
`supabase/postgres:17.6.1.155` container on **127.0.0.1:55435**. The bare
image required a local `supabase_realtime_admin NOLOGIN` role for restore;
`vector` 0.8.2 was installed in that isolated database. Before migration:
five Auth users, six identities, 42 public tables and 10 Drizzle entries.
The corrected 0010–0028 migrated as `postgres` in **5.0 seconds** and ended
with 29 ledger entries, five Auth users, 84 public tables, the corrected
0024 hash, audit role membership, RLS and two audit policies. Task19g, Task4
and security-seal default dry runs exited zero with no apply flags; the ledger
remained at 29. This local container runs x86_64, while the live server's
`version()` reports aarch64. It does not test hosted Auth, platform settings
or pooler behavior. The Task20 lead accepted this exact-tag local rehearsal
at `60a1b5c` as satisfying condition 1, with the architecture and hosted
service differences accepted. A tenant-scoped audit read through the live API
on the 6543 pooler and a Company A admin read of Company B audit data
returning zero remain mandatory immediately after the live apply.
