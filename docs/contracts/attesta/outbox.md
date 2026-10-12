# Outbox: `attesta_subjects` (frozen; Codex implements the writes in A15.7)

Task2 tells Attesta "something happened, please attest it" by writing **one thin pointer row** in the **same transaction** as the observation. Attesta's worker later reads Task2's tables, builds the predicate, signs and chains it. The outbox carries only the kind of event and source IDs; adding a predicate field never changes it (`ATTESTA_QUESTIONS.md`, "The outbox stays a thin pointer").

Table: migration `apps/api/drizzle/0016_attesta_subjects.sql`, Drizzle `attestaSubjects` in `apps/api/src/core/db/schema.ts`. Writer: `enqueueAttestaSubject` in `apps/api/src/features/attesta/outbox.ts`.

## Columns

| Column | Type | Kinds | Meaning |
|---|---|---|---|
| `id` | uuid PK | all | |
| `tenant_id` | uuid NN | all | FK `sso_tenants`; `(tenant_id, id)` unique for later composite keys |
| `repository_id` | uuid NN | all | composite FK `(tenant_id, repository_id)` → `scm_repositories(tenant_id, id)` |
| `kind` | text NN | — | `commit_observed` · `pr_merged` · `deployed` |
| `metric_event_id` | uuid | commit_observed (required) | `telemetry_metric_events.id` of the Git AI commit-note event |
| `commit_id` | uuid | commit_observed (required) | `scm_commits.id` the note normalized into |
| `commit_sha` | text NN | all | the subject commit: observed sha · PR merge result sha · deployed sha (40 or 64 lowercase hex) |
| `provider` | text | pr_merged, deployed (required) | `github` today |
| `provider_delivery_id` | text | pr_merged (required), deployed (optional) | `provider_event_deliveries.delivery_id` |
| `pull_request_id` | uuid | pr_merged (required) | `scm_pull_requests.id` |
| `deployment_id` | uuid | deployed (required) | `scm_deployments.id` |
| `deployment_external_id` | text | deployed (required) | `scm_deployments.external_id` |
| `deployment_status` | text | deployed (required) | always `success` (only production successes are attested) |
| `event_at` | timestamptz NN | all | metric event time · `merged_at` · `deployed_at` |
| `not_before` | timestamptz NN | all | earliest build time (default `now()`) |
| `created_at` | timestamptz NN | all | default `now()` |
| `status` | text NN | worker | `pending` (default) · `claimed` · `done` · `failed` |
| `attempts` | integer NN | worker | default 0, ≥ 0 |
| `claimed_at`, `processed_at` | timestamptz | worker | `claimed` needs `claimed_at`; `done`/`failed` need `processed_at`; `pending` has none |
| `last_error_code` | text | worker | a code from `errors.md` (`^ATTESTA_[A-Z0-9_]{1,64}$`), never free text |

Checks: each kind's required columns are non-null and the other kinds' columns are null (`attesta_subjects_kind_shape_check`); sha, provider and ID bounds; status consistency. A trigger makes every column except the worker fields (`not_before`, `status`, `attempts`, `claimed_at`, `last_error_code`, `processed_at`) immutable. RLS is enabled with no policies (AGENTS.md §9 item 3).

## Idempotency keys (decision 4)

| Kind | Unique key (partial unique index) |
|---|---|
| `commit_observed` | `(tenant_id, kind, metric_event_id)` |
| `pr_merged` | `(tenant_id, kind, provider, provider_delivery_id)` |
| `deployed` | `(tenant_id, kind, provider, deployment_external_id, deployment_status)` |

`provider` is in the `pr_merged` key because delivery IDs are unique only per provider (the source ledger's key is tenant + provider + delivery ID). A merge that reaches TrackAI through two different deliveries (for example the GitHub App and a repository webhook) gives two rows; the builder links the second statement to the first through `previous`.

## The writer: `enqueueAttestaSubject(tx, input)`

```ts
enqueueAttestaSubject(tx: AttestaOutboxExecutor, input: EnqueueAttestaSubjectInput)
  : Promise<{ id: string; inserted: boolean }>

type EnqueueAttestaSubjectInput =
  | { kind: 'commit_observed'; tenantId; repositoryId; commitSha; eventAt: Date; notBefore?: Date;
      metricEventId; commitId }
  | { kind: 'pr_merged'; tenantId; repositoryId; commitSha /* merge_commit_sha */; eventAt /* merged_at */;
      notBefore?; provider; providerDeliveryId; pullRequestId }
  | { kind: 'deployed'; tenantId; repositoryId; commitSha /* deployed sha */; eventAt /* deployed_at */;
      notBefore?; provider; providerDeliveryId?: string | null; deploymentId; deploymentExternalId;
      deploymentStatus: 'success' }
```

- `tx` is the caller's open Drizzle transaction (anything with `execute(sql)`); the helper never opens or commits one.
- Input is validated once into a plain snapshot (lowercase UUIDs, hex sha, bounded IDs, no fields of another kind, no extra fields) → `ATTESTA_OUTBOX_INVALID_INPUT`.
- **Tenant binding:** a single `INSERT … SELECT … WHERE <sources exist> ON CONFLICT <kind key> DO NOTHING`. The sources must exist **in the same tenant** and agree with the pointer: the metric event, and the commit with this id, repository and sha (`commit_observed`); the delivery, and the PR with this id and repository whose `merge_commit_sha` is `commitSha` and `merged_at` is set (`pr_merged`); the deployment with this id, repository, provider, external ID, `status = 'success'`, `production = true` and `sha = commitSha`, and the delivery when given (`deployed`). Otherwise → `ATTESTA_OUTBOX_SOURCE_NOT_FOUND`.
- **Replay:** the existing row's ID comes back with `inserted: false`. If the stored pointer differs from the input in any identity column (including `event_at`), the call throws `ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT` and writes nothing.
- Concurrency: two transactions writing the same observation serialize on the unique index; one inserts, the other returns the same ID after the first commits.

**Why no source foreign keys.** `telemetry_metric_events`, `scm_commits`, `scm_pull_requests` and `scm_deployments` have no `(tenant_id, id)` key (adding one is a Task2 change), and Task2's reset (`task2-reset.ts`) and future retention delete those rows; a foreign key would block them. The tenant is bound by the insert itself, proven by IT-T15c-01. Once a statement is signed, the ledger keeps its own copy of the evidence; the outbox row is only a work item.

## Which transaction writes each kind (Codex's I8, for A15.7)

| Kind | Write it in | Notes |
|---|---|---|
| `commit_observed` | the transaction that completes Git AI commit-note normalization (`normalizeCommit`, `features/telemetry/service.ts:756–1004`), which A15.7 makes transaction-aware | `metricEventId` = the row being normalized; `commitId`/`commitSha` = the upserted commit; `eventAt` = the metric event time. A lifecycle rebuild re-normalizes the same event IDs, so it hits the key and adds nothing |
| `pr_merged` | the `projectProviderDelivery` callback (`features/scm/scm.routes.ts:222–395`), after the PR upsert (`:295–336`), when the delivery is `pr_closed` with `merged_at` and `merge_commit_sha` | `notBefore` = now + 5 minutes recommended, so lineage and API enrichment (`:416–470`) usually land first; the builder still tolerates lineage being `unavailable`. Never hold the webhook transaction open for GitHub API calls |
| `deployed` | one transaction around the deployment insert (`recordDeployment`, `features/scm/lifecycle-service.ts:433–446`) and the enqueue, only when `production` and `status = 'success'` | `deploymentId` = the stored row's ID (read it back after `insertDoNothing`) |

## Rules

1. **Nothing on the ingestion path waits for signing.** The writer only inserts; no network, no signer, no builder call.
2. **New kinds are additive:** a new `kind` value, its own nullable columns, its own partial unique index, in a new migration. Existing kinds, rows and keys never change.
3. The outbox never holds content: no titles, messages, paths, emails or payloads, only IDs, a sha and times.

## Worker protocol (built in A15.8; binding)

- Claim: `UPDATE … SET status = 'claimed', claimed_at = now(), attempts = attempts + 1 WHERE id IN (SELECT id FROM attesta_subjects WHERE status = 'pending' AND not_before <= now() ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED) RETURNING …`.
- Success: `status = 'done'`, `processed_at = now()`. Retryable failure (`SigningUnavailable`, builder source not ready): back to `pending`, `not_before` pushed out with backoff, `last_error_code` set. Terminal failure or `attempts` above the limit: `failed`, `processed_at = now()`, `last_error_code` set.
- A claim older than the lease (10 minutes) is returned to `pending` by the worker (crash recovery). The worker runs as a system job across tenants, and every read it makes is tenant-bound to the row's `tenant_id`.
