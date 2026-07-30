# Task2 lifecycle implementation runbook

This checkout contains the first decision-complete Task2 lifecycle slice. The
migration is generated for review and is **not applied automatically**.

## 1. Review and apply the migration

Review `apps/api/drizzle/0001_abandoned_rhodey.sql` and the additive
`apps/api/drizzle/0002_hard_hellfire_club.sql`. They add append-only
generation, commit-lineage, PR-snapshot, merge-lineage, deployment and provider
identity tables plus per-model attribution/lifecycle projections. All new
evidence tables have RLS enabled and no direct browser policies.

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
`repositoryId`, `pullRequestId`, `contributorId`, `modelKey`, `from` and `to`
query filters.

Before Task2 closes, the Code Lifecycle dashboard must support five explicit
customer scopes: whole tenant, one repository, one pull request, one
contributor and one originating model. The UI must provide a visible scope selector and reuse the same
Generated -> Committed -> In PR -> Merged -> Production presentation for each
scope. Repository, PR and contributor rows/details must deep-link into their
corresponding lifecycle view. Scoped totals must be derived by the protected
API, preserve evidence/availability labels, and avoid double-counting sessions
or commits that participate in more than one downstream relationship.

Customer-facing `Generated LoC` means the complete aggregate of AI-produced
SLOC across the selected scope, including output later replaced or discarded.
Checkpoints, traces and transcripts are supporting evidence, not the headline
metric. If that evidence has incomplete coverage, the aggregate must display
`Unavailable`; partial observed SLOC may appear only in an explicitly labelled
drill-down and must never be presented as complete Generated LoC.

Run checks:

```bash
npm run test --workspace=apps/api
npm run build --workspace=apps/api
npm run build --workspace=apps/web
```

## 5. Model lifecycle rebuild (T2.23)

After applying migration `0002`, preview the E15 projection without writes:

```bash
npm run rebuild:model-lifecycle --workspace=apps/api -- \
  --tenant-domain=purpletealabs.net \
  --repository-url=https://github.com/mahamannu-ai/git-ai-teamz-lab
```

Review commit/model/rework totals, then apply by adding
`--confirm=REBUILD_MODEL_LIFECYCLE`. Model totals plus `Unknown model` must equal
the corresponding parent scope; missing evidence is never distributed.

## 6. Development OpenCode evidence flow (T2.24)

Set `TRACKAI_DEV_EVIDENCE_ENABLED=true` and
`TRACKAI_OPENCODE_DB_PATH=/absolute/path/to/opencode.db` only in the local API
environment. Restart API/web, open a known OpenCode commit, and click **Load
evidence**. The protected endpoint reads the provider DB on demand and is forced
off when `NODE_ENV=production`.

## 7. Controlled sequence

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

## Extended experiment matrix

### Batch 1: deterministic lab coverage

Complete these against `git-ai-teamz-lab` before increasing repository or change
size. Every case verifies the working checkpoint, commit Note, server commit,
session association, final attribution and lifecycle evidence independently.

1. Modify existing files using multiple agents and commit (completed by `9de9438`).
2. Add a new file, including attribution for every new line.
3. Delete AI-, human- and mixed-attribution lines and then delete an entire file.
4. Rename/move a file without changing content, then move and edit it together.
5. Apply `git reset --soft`, `--mixed` and, only on a disposable branch, `--hard`;
   retain historical commit evidence and update reachability without double counting.
6. Revert a commit and distinguish the revert from destructive history rewriting.
7. Push/replay idempotency, Git Notes synchronization and clean-clone recovery.
8. Open and update a PR; retain authoritative membership snapshots and removed commits.
9. Amend/force-push, review rework, merge, squash, rebase, deployment and rollback.

### Batch 2: realistic project simulation

After Batch 1 passes, use a medium-sized repository with a real test/build loop and
implement one cohesive feature spanning source, tests, configuration and docs.
Generate multiple commits with AI and manual edits, open a PR, respond to review,
rewrite at least one commit, merge, and emit deployment/revert evidence. Reconcile
Generated -> Committed -> In PR -> Merged -> Production LoC at each boundary and
verify repository-, PR- and contributor-level ratios against manually calculated
expected values.

### Agent and model compatibility matrix

Run the same small add/edit/delete scenario and token reconciliation contract with:

- OpenCode using at least two models and an in-session model switch.
- VS Code GitHub Copilot using transcript plus OTEL usage evidence.
- Codex using its transcript/token events.
- Antigravity with Gemini and Claude after implementing/verifying its project hook
  adapter and locating its provider transcript/usage evidence.

For every tool/model combination, verify external session identity, model identity,
token categories, cost unit, checkpoint attribution, commit Note linkage and server
idempotency. Missing evidence must display as unavailable/partial, never zero.

## GitHub App event delivery note

A GitHub App installation grants scoped API access but does not automatically send
events to a localhost server. Push delivery requires a configured GitHub App or
repository webhook URL reachable by GitHub (normally through a tunnel in local
development). The read-only App can still support a tunnel-free explicit/scheduled
reconciliation endpoint that polls PR metadata and commit lists; implement that as
a development/recovery path, while production uses webhooks plus periodic repair
reconciliation.
