# Handoff prompt: Task14a-supabase-database (understand Supabase's role, migrate the live project, restore the localhost dashboard), Codex + founder

> **Founder setup (Codex: skip to "You are…"):**
> 1. `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task14a-supabase-database`; open `~/AIProjects/TrackAI-wt/Task14a-supabase-database` in Codex; paste everything below the line.
> 2. Have ready: access to the Supabase dashboard for the live project, and `apps/api/.env` from the checkout you use for the localhost dashboard (Codex reads which variables exist, never their values).
> 3. Stage 1 ends with an explainer and a migration plan for you to question and approve. Nothing is written to the live database before that approval. Reviews: the Task20 lead (Claude) for the security migrations; push only after "ready to push".

---

You are **Codex**, running **Task14a-supabase-database** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. TrackAI uses **Supabase** for authentication and, very likely, as the hosted PostgreSQL behind the founder's localhost dashboard (Stage 1 confirms this from the configuration). Since the Task2 runbook, migrations `0003`…`0028` have merged (Tasks 4, 15, 16, 19, 20) and have not all reached that live project. The founder cannot repeat the Task2 runbook against the localhost dashboard until they do, and Task17's Task2 Lifecycle Lab regression needs exactly that. This session (1) explains what Supabase is and is not in TrackAI's architecture, (2) brings the live project to the current schema safely, and (3) proves the localhost dashboard works again.

- **Repository:** TrackAI only. **Branch:** `task/Task14a-supabase-database`. **Handoff:** `docs/handoffs/Task14a-supabase-database_HANDOFF.md`. **Estimate:** about 0.10× T6 plus founder time.
- **Task14 fit:** a first slice of T14.1 (reference architecture: the Supabase part) and T14.5 (migrations and recovery), in `TASK14.md`.

## 0. Before anything else
Read `AGENTS.md` in full (§1; §2 layout, which says Supabase is the hosted Auth provider and not the migration tool; §9 items 3, 10, 13), `TASK14.md`, `prod-checklist-for-dummies.md`, `TASK2_RUNBOOK.md` §1, `apps/api/src/core/db/{index,tenant,audit-reader}.ts`, `apps/api/drizzle/` (every migration and `meta/_journal.json`), `docs/plan/BUG_BACKLOG.md` B5, and the handoffs of the sessions that added migrations 0024–0028 (Task16e2, Task20d, Task20f, Task15op, Task19g).

## 1. Stage 1: read-only discovery and explainer (no writes anywhere)
Write `docs/plan/TASK14_SUPABASE.md`, in plain words first and detail after, answering:
1. **What Supabase does for TrackAI today**, from the code: Auth (how the API verifies Supabase JWTs, which variables), the database (is `DATABASE_URL` the live Supabase Postgres, direct connection or pooler, port 5432 or 6543), anything else (storage, edge functions: say "not used" where so).
2. **Which migrations the live project has**: read the Drizzle migrations table (`drizzle.__drizzle_migrations` or wherever `drizzle-kit migrate` records them) and compare with `meta/_journal.json`; list applied and pending. Read-only SQL only; print counts and names, never data.
3. **Each pending migration's risk on Supabase**, `file:line`: role creation and `GRANT … TO CURRENT_USER` in `0024_audit_db_role.sql` (Supabase's `postgres` role is not a superuser; check what it may do); extensions (`pgcrypto`, `vector`) present and their versions; table rewrites or long locks (for example the `security_findings` widening in `0025`); post-migration steps each session's handoff requires (the audit-reader grant to the API runtime role, `audit-reader.ts:22`; Task19g's dry-run-first merger backfill; any `reconcile:*` commands); B5's `authenticated` policies from `0000`.
4. **Connection pooling**: tenant isolation uses `set_config(…, true)` and `set local role` inside transactions (`tenant.ts:21`, `audit-reader.ts:23`), which is safe with a transaction pooler; confirm nothing else relies on session state (prepared statements, `SET` without `LOCAL`, advisory locks, `LISTEN`).
5. **Architecture impact of choosing Supabase**, for the founder's questions: what is Supabase-specific (Auth and its `auth` schema and JWTs, the `authenticated` role, the pooler, backups and point-in-time recovery by plan tier, network restrictions, key handling) and what stays portable (plain PostgreSQL plus Drizzle; the Auth adapter boundary); what this means for Task14's three modes (GCP SaaS, customer VPC, self-hosted) and for Task15n's KMS keys; a recommended environment split (for example: local development on a local PostgreSQL with the Task20j local auth stub; a separate Supabase project for the founder's live dashboard; a future production project or GCP database), with costs and trade-offs stated plainly, no decision taken for the founder.
6. **A migration plan**: backup first (Supabase backup or PITR point, plus a `pg_dump` of schema and data to an encrypted local file the founder keeps), a rehearsal on a restored copy (local PostgreSQL from that dump), the exact apply command, the post-migration steps in order, the smoke checks, and the rollback route (restore) with its expected time.

**Checkpoint 1:** send `TASK14_SUPABASE.md` to the founder. Answer their questions in the document. Wait for explicit approval of the plan.

## 2. Stage 2: rehearse, then migrate (founder approval required at each arrow)
backup taken and its restore tested locally → migrations applied to the local restored copy, `drizzle-kit check` clean, post-migration steps rehearsed (backfills in dry run) → **founder approves** → migrations applied to the live project → post-migration steps (dry run, review counts, then apply) → smoke checks.
Smoke checks: the API starts against the live project; `/health`; an admin and an auditor sign in to the localhost dashboard; the Task2 dashboard views, Audit, Questions and Security load without errors; a Company A user sees no Company B data. Record results in the handoff, with counts only.

## 3. Stage 3: write it down
- `docs/ops/DATABASE_MIGRATION_RUNBOOK.md`: the dry-run-first procedure for every future migration on this project (backup, rehearse, apply, post-steps, smoke, rollback), so the next migration is routine.
- `TASK14.md`: T14.1 and T14.5 rows to 🟡 with what this session proved; `docs/plan/STATUS_BOARD.md`: a Task14a row; `docs/plan/BUG_BACKLOG.md` B5 updated with what the live project actually has.

## 4. Rules
- Never `db:push` against the live project; never edit merged migrations; never disable RLS; never print or paste a connection string, key, password or row of data. Destructive or irreversible steps are dry-run first with the exact scope stated and an explicit founder confirmation (AGENTS.md §9 item 10).
- Task20j's seven-day run uses its own local Docker database (`trackai-task20j-pg`, port 55432). Do not touch it, its API on port 8080, or its private directory.
- No application code changes. If the live project needs a code change (for example a pooler setting), stop and report it as a finding for a separate session.

## 5. Close-out
Gates: `npm run typecheck`, `npm run lint`, `npm test`; `git merge main` and rerun before the review request. Final reply in the AGENTS.md §12.4 shape with one bash block (push, `gh pr create --base main --head task/Task14a-supabase-database --body-file docs/handoffs/Task14a-supabase-database_HANDOFF.md --repo mahamannu-ux/TrackAI-V1`, `scripts/pr-preflight.sh task/Task14a-supabase-database`, then `gh pr merge` after the review).

## Lessons so far
- **Task2 runbook:** "apply the SQL in Supabase or run the configured Drizzle migrator" left the live project's state implicit; this session makes it explicit and repeatable.
- **Task16e2:** the audit reader fails closed (503) until its role is granted to the API runtime role; a migration alone is not the whole deployment.
- **Task20j:** a local stack that must outlive a test needs a named database, fixed port and restart commands; reuse that pattern for the rehearsal copy.
