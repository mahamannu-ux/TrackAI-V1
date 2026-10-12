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
| Integration | IT-T2AT-01…04 plus IT-T15c-01 merge gate | 🟡 founder passed 2026-10-12; `5fb2647` correction rerun pending |
| Review | Independent Codex review | 🟡 `5fb2647` correction re-review pending |

## Implemented interfaces
```text
service.ts:819-1137 normalizeCommit -> transaction(commit/file/session/model/lifecycle + commit_observed)
scm.routes.ts:79-175,407-415 PR upsert + pr_merged in provider projection transaction; notBefore +5m
lifecycle-service.ts:445-596 recordDeployment -> transaction(deployment/code+model lifecycle + deployed)
npm run verify:task2-attesta-trigger-live -w apps/api -> IT-T2AT-01…04
```

## Founder-approved decisions
1. Rebuild/retry idempotency conflict rolls back that event, records the safe code count and continues replaying later events; the CLI exits non-zero on any count.
2. Metric-event normalization status remains outside the projection transaction: all deterministic Attesta errors are terminal `failed` with only the safe code. None are classified transient; recovery after a fix is an explicit reset or rebuild, so failed rows cannot starve pending reconciliation.
3. SCM Attesta errors log only their code; no identifiers or payloads.

## Deviations from spec
- None in product behavior. `apps/api/package.json` was pre-approved for the live-verifier script.
- The founder's 2026-10-12 live run measured the five-sample baseline/current commit-normalization medians; the two numeric output values still need transcription into this handoff.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Rerun IT-T2AT-01…04 after `5fb2647` | Blocks this branch's merge; IT-T15c-01 does not need rerun |

## Test coverage
Unit tests prove each qualifying kind enqueues once, skips non-qualifying observations, and parks deterministic writer errors as terminal safe codes. IT-T2AT-01…04 use real services/PostgreSQL for rollback, failed-row starvation protection, rebuild continuation/counts, redelivery, code+model lifecycle equality and Company A/B isolation; an injected writer failure only forces each rollback boundary.

## Integration test impact
> **FOUNDER:** blocking A15.7 merge. Rerun only Task2 after `5fb2647`; IT-T15c-01 and the prior IT-T2AT-01…04 run passed on 2026-10-12.
> ```bash
> scripts/it-db.sh npm run -s verify:task2-attesta-trigger-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T2AT-01 | commit/outbox atomicity, failure quarantine, replay and rebuild continuation | Blocking: merge | 🟡 founder passed prior scope 2026-10-12; `5fb2647` correction rerun pending |
| IT-T2AT-02 | merged PR delay and redelivery | Blocking: merge | ✅ founder passed 2026-10-12 |
| IT-T2AT-03 | deployment/lifecycle atomicity and redelivery | Blocking: merge | ✅ founder passed 2026-10-12 |
| IT-T2AT-04 | tenant isolation | Blocking: merge | ✅ founder passed 2026-10-12 |

## Integration notes
- A15.8 may build against the frozen outbox contract now; merge waits on the Task2 correction rerun.
- Close-out: `e25cf2d` original handoff; corrections `c2775e2` caller rollback, `3100984` model rollback and `5fb2647` terminal errors/rebuild continuation.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost |
|---|---|---|---|---|
| about 0.15× | about 0.15× | one session | ~3 h | n/a |
