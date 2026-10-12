# Task2-attesta-trigger Handoff — Task2 observation pointers for Attesta (A15.7)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task2-attesta-trigger` (base: `main` at `ea4364e`).

Task2 now writes one thin `attesta_subjects` pointer in the same transaction as each qualifying commit, merged-PR or successful production-deployment observation. It does not build, sign, chain or transmit statements, and it does not change lifecycle metric semantics.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Three atomic observation writers; replay-safe and fail-closed | ✅ code + unit coverage |
| Scope | Frozen `outbox.ts` only called; no contracts, migrations, schema, web or dependencies changed | ✅ |
| Quality | 395/395 tests, typecheck, lint, schema check, web production build | ✅ |
| Integration | IT-T2AT-01…04 plus IT-T15c-01 merge gate | ⬜ founder run; agent host lacks pgvector/Docker |
| Review | Independent Codex review | ✅ `ready to push` after two correction passes |

## Implemented interfaces
```text
service.ts:819-1137 normalizeCommit -> transaction(commit/file/session/model/lifecycle + commit_observed)
scm.routes.ts:79-175,407-415 PR upsert + pr_merged in provider projection transaction; notBefore +5m
lifecycle-service.ts:445-596 recordDeployment -> transaction(deployment/code+model lifecycle + deployed)
npm run verify:task2-attesta-trigger-live -w apps/api -> IT-T2AT-01…04
```

## Founder-approved decisions
1. Rebuild/retry idempotency conflict rolls back and surfaces `ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT`.
2. Metric-event normalization status remains outside the projection transaction: Attesta failures stay `pending` with only the safe code so reconciliation retries them; other normalization failures stay `failed`.
3. SCM Attesta errors log only their code; no identifiers or payloads.

## Deviations from spec
- None in product behavior. `apps/api/package.json` was pre-approved for the live-verifier script.
- Live latency values are not yet measured: the agent's PostgreSQL 18 lacks pgvector and Docker is unavailable. The verifier interleaves five baseline-shape (no enclosing transaction/outbox write) and five current commit-normalization samples and prints both medians.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Run IT-T15c-01 and IT-T2AT-01…04 | Both block this branch's merge |
| 🟡 | Reproducible before/current latency comparison awaits a pgvector-capable run | No latency claim is made yet |

## Test coverage
Unit tests prove each qualifying kind enqueues once, non-merged/non-production/failed/missing-commit cases enqueue none, writer errors propagate, and Attesta failures remain retryable. IT-T2AT-01…04 use real services/PostgreSQL for rollback, reconciliation, replay/rebuild, redelivery, code+model lifecycle equality and Company A/B isolation; an injected writer failure is used only to force each rollback boundary.

## Integration test impact
> **FOUNDER:** blocking A15.7 merge. Prerequisites: Docker Desktop or PostgreSQL 16 with pgvector. Expected: `IT-T15c-01=passed` and IT-T2AT-01…04 each `passed`, under two minutes total.
> ```bash
> scripts/it-db.sh npm run -s verify:task15c-outbox-live -w apps/api
> scripts/it-db.sh npm run -s verify:task2-attesta-trigger-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T2AT-01 | commit/outbox atomicity, replay and rebuild | Blocking: merge | ⬜ founder run |
| IT-T2AT-02 | merged PR delay and redelivery | Blocking: merge | ⬜ founder run |
| IT-T2AT-03 | deployment/lifecycle atomicity and redelivery | Blocking: merge | ⬜ founder run |
| IT-T2AT-04 | tenant isolation | Blocking: merge | ⬜ founder run |

## Integration notes
- A15.8 may build against the frozen outbox contract now; merge waits on the two founder commands.
- Commits: `f5b528b` commit, `5b8b07e` deployment, `fe21750` PR, `ded4f50` verifier, `c2775e2` retry/caller rollback, `3100984` model rollback.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.15× | about 0.15× | one session | ~3 h | n/a |
