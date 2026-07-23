# Task2 lifecycle implementation runbook

This checkout contains the first decision-complete Task2 lifecycle slice. The
migration is generated for review and is **not applied automatically**.

## 1. Review and apply the migration

Review `apps/api/drizzle/0001_abandoned_rhodey.sql`. It adds append-only
generation, commit-lineage, PR-snapshot, merge-lineage, deployment and provider
identity tables. All new evidence tables have RLS enabled and no direct browser
policies.

After backup and review, apply the SQL in Supabase or run the configured Drizzle
migrator. Do not use `db:push` against production.

## 2. Configure GitHub read access

Create a GitHub App with read-only Repository metadata, Contents and Pull
requests permissions, then install it on the controlled Company A/B repositories.
Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATIONS_JSON` and
`GITHUB_APP_PRIVATE_KEY` in `apps/api/.env`. The JSON maps normalized GitHub
owners to installation IDs, keeping Company A and B access distinct. Task2 exchanges the signed app JWT
for a short-lived installation token and never returns it to the browser.

For a short local public-repository test only, set
`GITHUB_ALLOW_PUBLIC_READ=true`. Do not use this as the production design.

## 3. Inspect the selective reset

The default command is dry-run only:

```bash
npm run reset:task2 --workspace=apps/api -- \
  --tenant-domain=purpletealabs.net
```

It preserves tenants, authentication, repositories and pull-request records.
After reviewing the counts, execute the same command with:

```bash
--confirm=RESET_TASK2
```

Repeat separately for the Company B domain only if its controlled evidence
should also be cleared.

## 4. Start and verify

```bash
npm run dev:api
npm run dev:web
```

The dashboard adds **Code Lifecycle** and continues polling every 15 seconds.
The protected lifecycle API is `GET /api/metrics/lifecycle`, with optional
`repositoryId`, `pullRequestId`, `contributorId`, `from` and `to` query filters.

Run checks:

```bash
npm run test --workspace=apps/api
npm run build --workspace=apps/api
npm run build --workspace=apps/web
```

## 5. Controlled sequence

1. AI checkpoint and ordinary commit.
2. Open a PR and verify an authoritative commit snapshot.
3. Amend/force-push and confirm old membership is retained as inactive.
4. Squash merge and verify every source commit maps to the result SHA.
5. Send a successful `deployment_status` for `production` and verify explicit
   production evidence replaces the labelled default-branch proxy.
6. Repeat a small Company B scenario and confirm cross-tenant APIs return no
   Company A evidence.

## Known verification boundary

The Git AI branch includes focused fixes/tests for OpenCode model switching and
nested usage messages. The synced Git AI HEAD already contains the Copilot
multi-file KnownHuman suppression fix and regression tests. Rust execution in
this sandbox requires downloading crates that are not cached, so those Rust
tests must be run on the developer machine with normal Cargo network access.
