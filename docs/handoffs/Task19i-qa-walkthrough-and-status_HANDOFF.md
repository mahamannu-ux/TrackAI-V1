# Task19i-qa-walkthrough-and-status Handoff — Task19 Customer and auditor Q&A delivery

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task19i-qa-walkthrough-and-status` (base: `main` at `0d4099c`).

Finishes T19.9: the founder's 15-step walkthrough (`docs/plan/TASK19_WALKTHROUGH.md`) now runs as one Playwright regression, **IT-T19i-01**, on a seeded throwaway stack (real API, real production web build, a local sign-in stub), including the steps the 2026-11-24/25 sitting deferred (1–7, 15, the Q3 half of 14). It also turns `docs/plan/CUSTOMER_AUDITOR_QA.md` into the founder's single status page. It changes no product code: the defects it found are recorded for the Task19 lead (§8 of `TASK19.md`).

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | One seed command: Company A (merged AI PR, model, production deployment, Endpoint findings/inventory/scans/permission decisions, Attesta statements anchored, period and security reports) and Company B | ✅ `task19i-walkthrough-seed.ts` |
| Acceptance | Local sign-in stub for four users, ephemeral-database guard kept | ✅ `task19i-walkthrough-auth.ts` |
| Acceptance | Playwright spec covering all 15 steps on screen, 403/404 through the API, the content check | ✅ founder run 17 of 17 (2026-11-25) |
| Acceptance | One founder command `npm run e2e:task19-walkthrough` | ✅ registered as IT-T19i-01 |
| Acceptance | Status page: summary, two ranked tables (Live / Verifiable / Signed, evidence, what is left, owner), Archive, sync rule; TASK19 §3 points to it | ✅ |
| Quality | `npm run check` (1 263 tests, typecheck, lint, drizzle check, web build); eslint on `e2e/` | ✅ |
| Integration | IT-T19i-01 | ✅ founder run 2026-11-25: 17 of 17; T19.9 steps 1–7, 15 and Q3-of-14 passed |
| Review | Independent review subagent; cross-agent review (Codex or Muse) | ✅ 1 must-fix and 12 should-fixes fixed · ✅ Codex: 3 minor fixes applied (Review below) |

## Implemented interfaces
```text
npm run e2e:task19-walkthrough            # root; = scripts/it-db.sh npm exec -w apps/web -- playwright test
apps/api/src/features/qa/testing/
  task19i-walkthrough-users.ts   WALKTHROUGH_USERS, WALKTHROUGH_COMPANIES, assertEphemeralDatabase()
  task19i-walkthrough-seed.ts    seedWalkthrough(workDir): WalkthroughManifest; CLI <manifest.json> <work dir>
  task19i-walkthrough-auth.ts    stub: TASK19I_AUTH_PORT, TASK19I_WEB_ORIGIN
apps/web/playwright.config.ts, apps/web/e2e/task19-walkthrough.{setup,spec}.ts
Manual mode: TASK19I_HOLD=1 npm run e2e:task19-walkthrough   # seeded stack stays up, prints sign-ins; Ctrl-C ends
Optional env: TASK19I_CHROMIUM (browser path), TASK19I_SHOW_LOGS=1, TASK19I_OUTPUT_DIR,
  TASK19I_SKIP_WEB_BUILD=1 with TASK19I_{AUTH,API,WEB}_PORT (re-run against an earlier build)
```

## Ported from
- Sign-in stub: TrackAI Task5 acceptance auth, `apps/api/src/features/evidence/task5-acceptance-auth.ts` @ `0d4099c`. Deviations: users from the shared list; port and web origin from the environment; prints no e-mail addresses; guard widened (also needs `TASK6_EPHEMERAL_DATABASE=1` and a local `DATABASE_URL`).
- Seed helpers copied (those files are runnable scripts with a `main`, so not importable): IT-T16h-01 (trust inventory by the `attesta:keys` CLI, statements through the ledger clock seam, period and security reports), IT-T15i4 (anchoring with the Rekor/TSA fakes), IT-T19g-01 (signed webhook), IT-T19f-01/IT-T19h-01 (Endpoint rows in the stored shape). No new insert paths for code data: commits go through `ingestMetricsBatch`, the PR and deployment through the real webhook route.

## Deviations from spec
1. **Fake GitHub REST API in the seed process.** The merged-PR webhook asks the GitHub App for the PR's commits; without that answer Task2 writes no Merged stage. The seed answers `https://api.github.com/repos/<org>/<repo>/…` GETs with synthetic commits (all other requests go to the real `fetch`), so Task2's own webhook code computes Merged. Nothing else is mocked.
2. The merged-PR Attesta pointer waits five minutes (`scm.routes.ts`); the seed sets `not_before = now()` on the seeded pending pointers.
3. `TASK19.md` §8 carries the Task20j sitting's rows **verbatim from `task/Task20j-acceptance`** (merged since, PR #114), because the status page cites them; three IT rows in `STATUS_BOARD.md` (IT-T19a/c/f-01) are copied verbatim from that branch too, as the prompt asks. Identical lines merge cleanly; if §3 or §8 conflicts, keep this branch's version.
4. Walkthrough step 13 corrected to what the screen does (lists S3 live under "Answers not built yet", sends no request).
5. The production build needs `apps/web/.next` (fixed by `next.config.mjs`, not a Task19 file): the setup moves an existing `.next` aside and restores it at teardown (also on Ctrl-C). Stop any `next start` serving from `.next` during a run; `next dev` (`.next-dev`) is untouched. Child processes get the caller's environment minus `SUPABASE_*`, `NEXT_PUBLIC_*`, `GITHUB_*`, `ATTESTA_*`, `TRACKAI_*`, `FRONTEND_URL`, `PORT`.
6. **Merge with Task20j (done, `55dcb74`):** `TASK19.md` conflicted in §3 and §8; this branch's side was kept (§3 without the status column, §8 a superset of Task20j's rows).
7. The status tables bold their question ids, so `qa-contract.test.ts` keeps reading the archived tables as the question catalogue.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | An interrupted run (killed before teardown) can leave `apps/web/.next-before-task19i-<pid>`; the next run stops and explains it (see Integration notes) | Manual recovery, never automatic |
| 🟡 | For the lead: Company B's Q3 `merged_ai_lines` with no merged PR says `answer_not_built` (`answers/common.ts:91`); registry still marks G6 and G9 open (`registry.ts:135,143,147,240`), so S1/S3 show stale gap pills. Both touch `docs/contracts/qa/`, so recorded, not fixed | Misleading reason text on screen |
| 🟡 | The seeded world is synthetic and small; it proves the screens and the wiring, not real Endpoint behaviour (S26's real approvals stay a Task20/Task13 gap) | Founder-live results stay separate in `TASK19.md` §8 |

## Test coverage
The spec signs in through the real login page and Supabase client, opens each question through the Questions screen's URL state, and asserts the badges, figures, unavailable states (never a number), reason text, caveats, evidence counts, the "Open Attestation" action, signed digests, the auditor's disabled live option and missing live kinds; the API for 403 `QA_KIND_NOT_ALLOWED`, 404 `QA_SCOPE_NOT_FOUND` (identical to an unknown id) and S3's `answer_not_built`; and that no answer body carries an e-mail, domain, repository URL, login or file path. Mocked: Supabase Auth (stub), the GitHub REST API (seed only), Rekor and TSA (Attesta's own fakes). The seed and sign-in stub have no unit tests (test scaffolding, exercised by the run).

## Integration test impact
> **FOUNDER:** blocking for marking T19.9 steps 1–7, 15 and the Q3 half of 14 passed; non-blocking for anything else. Prerequisites: Docker (or local PostgreSQL 16 + pgvector), `npm ci`, `npm exec -w apps/web -- playwright install chromium` once. Expected: 17 passed, about 4 minutes, most of it the web build.
> ```bash
> npm run e2e:task19-walkthrough
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T19i-01 | All 15 T19.9 steps on a seeded stack, screen plus API | Blocking: T19.9 steps 1–7, 15, Q3-of-14 | ✅ founder run 2026-11-25: 17 of 17 |

## Integration notes
- New Task19 answers: add a step to the spec and seed the data it needs in `seedWalkthrough`; keep figures relative to the seed's start so default windows always cover them.
- **Recovering an interrupted run:** if setup reports `apps/web/.next-before-task19i-<pid>`, that folder is the build you had before an interrupted run, and `apps/web/.next` (if present) is the walkthrough's. Check its date (`ls -ld apps/web/.next*`); to keep yours: `rm -rf apps/web/.next && mv apps/web/.next-before-task19i-<pid> apps/web/.next`. If there are several, keep the oldest; delete the others only once you know none is a build you want. The walkthrough never deletes them.
- Status page rule: a session that changes a question's status edits that row in `CUSTOMER_AUDITOR_QA.md` in the same PR; `TASK19.md` §3 no longer holds status.

## Review
Independent review subagent (no must-fix on safety or frozen paths). Fixed: `.next` moved aside and restored (must-fix); stronger assertions in steps 1, 7, 10, 13, 14; Q14 live ✅ → 🟡 (only its drill-down was founder-checked); Task20j-fix caveat on Q3/S7; "agent-passed" wording → "15 of 17 on `main`"; stale §3 pointers in TASK19 §8 and the walkthrough; lockfile trimmed to the three Playwright entries; inherited service variables dropped. Not changed: SIGKILL after 2 s for slow children (low risk). Codex cross-review (minor, no re-review): founder run recorded and Task20j-unmerged wording removed; the seed's fake GitHub API answers GET only; setup refuses to start when an orphaned `.next-before-task19i-*` exists and explains recovery. Found while fixing it: Ctrl-C in manual mode could exit before teardown (the likely source of the two orphaned builds in the founder's worktree) and left the stub and API running; the build is now restored synchronously on exit and children are stopped as process groups (re-tested: Ctrl-C restores the build and leaves no process).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.15× | about 0.16× | ~70 turns + review | ~2.5 h | not shown |
