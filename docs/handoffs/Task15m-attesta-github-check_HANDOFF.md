# Task15m-attesta-github-check Handoff — Attesta GitHub check

> Status: 🟡 done in sandbox, waiting on founder runs. **FOUNDER:** two runs below.

Branch `task/Task15m-attesta-github-check` (base: `main` at `3c862ef`).

Posts one informational **TrackAI Attesta** check run per PR through the installed GitHub App; conclusion always `neutral`, so it never blocks a merge. No route, migration, webhook or console change; scheduling is Task14's.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | check posted, neutral, exact wording; idempotent; tenant-bound; privacy | 🟡 sandbox-verified, founder runs pending |
| Scope | §2.1 items 1–8 as specified | ✅ |
| Quality | 891 unit tests pass (10 new), `tsc` clean, `lint` clean | ✅ |
| Integration | IT-T15m-01/02 sandbox-passed; IT-T15m-03 founder-passed | ✅ blocking gates covered |
| Review | self re-read as reviewer (wording vs §2.1 item 5, body contents) | ✅ no findings beyond the noted deviation |

## Implemented interfaces
```
githubWrite<T>(method, path, body, tenantId, owner)      // {status, data}; 0 = no token, -1 = network
githubGetStatus<T>(path, tenantId, owner)                // same no-throw contract for the list call
selectPullRequests(executor, tenantId, now, limit)       // open + recently merged, github only
attestationFacts(executor, tenantId, pr, sha, now)       // per-commit anchored/pending/overdue/none
checkRunPayload(facts, env, now)                         // pure: the exact check-run body
postCheck(deps, tenantId, owner, repo, payload)          // created|updated|unchanged|skipped_no_installation|permission_missing|not_found|failed
runGithubCheckPass(db, deps, {tenantId?, now?, limit})   // counts per result plus skipped_url
npm run attesta:github-checks -w apps/api [-- --tenant <uuid>] [--limit 200]
```

## Deviations from spec
1. `githubWrite`/`githubGetStatus` map a throwing credential lookup to `{status: 0}` (skipped, no request) — the literal "no token → 0" rule, and it keeps the no-token path unit-testable with no DB. A real credential misconfiguration therefore surfaces as skipped counts, not failures; IT-T15m-03 covers the real path.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | set the App's **Checks: Read and write** permission, accept it on each installation, then run IT-T15m-03 below | blocking for calling the check "shipped"; non-blocking for this merge |
| 🟡 | owner/repo are lowercased by URL normalization; GitHub treats them case-insensitively | none expected; reported if a check ever misses |
| 🟡 | The persistent Supabase database has no Attesta tables (0016–0021) and no Drizzle migration journal. Migrating it (verified backup and restore drill, journal baseline for 0000–0015, apply 0016–0021, persistent and fresh-schema gates) is Task15n (A15.13) step 1, with Codex. Until then the pass must not be pointed at that database. | IT-T15m-03 runs on a throwaway; persistent migration waits for Task15n |

## Test coverage
Unit (`github-check.test.ts`, no network/DB): all 8 prompt groups — wording, merged/empty titles, 50-row cap, create/unchanged/update/foreign runs, status codes + pass-continues, real no-token → 0 with zero fetches, SECRET privacy strings absent (only `head_sha` is 40-hex), tenant binding, URL skips. Live: real ingestion/builder/anchor passes, fake GitHub through `deps`.

## Integration test impact
> **FOUNDER:** 01–02 gate this merge (re-run on your machine); 03 needs the App permission first and gates calling the check "shipped". Expected: minutes.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T15m-01 | open PR 3 commits/2 built → created "2 of 3 · 0 anchored", unchanged, updated after anchoring | Blocking: Task15m merge | 🟡 sandbox 2026-10-14 · ⬜ founder |
| IT-T15m-02 | B's pass sees nothing of A; A's counts are A's only | Blocking: Task15m merge | 🟡 sandbox 2026-10-14 · ⬜ founder |
| IT-T15m-03 | real GitHub App and PR, throwaway database; the persistent database is migrated in Task15n step 1 | Blocking "shipped" | ✅ founder-passed 2026-10-14 (`created=1`, neutral, listed back) |

## Integration notes
Pass reads Task2 PR/commit/membership tables and Attesta records/anchors; writes only GitHub check runs. Fail-closed per PR: 403/404/500/throw become result counts, never exceptions. One count-only log line per pass.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Turns | Wall-clock |
|---|---|---|---|
| about 0.07× | about 0.1× | ~60 | ~2 h |

Over 1.25× because the founder-live run surfaced three environment issues (paused Supabase project, stale 2026-07 App private key, unaccepted installation permission) plus the Supabase migration gap that sent IT-T15m-03 to the lead for an option-B reroute. Next time: state the live-test's database, key-freshness and permission-acceptance prerequisites in the prompt itself (now in Part J).
