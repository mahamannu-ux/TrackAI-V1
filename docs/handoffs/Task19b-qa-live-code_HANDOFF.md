# Task19b-qa-live-code Handoff — live answers for code questions (T19.3)

Branch `task/Task19b-qa-live-code`. Ten live answerers registered, drill-down built, no table, no migration, no web page.

## At a glance
- Q1 changed-lines share + G1 repository share; Q3 merged lines + retained share; Q4 production models + G2 approval; Q9 production + proxy + deployments; Q13 commits/notes/unknown/coverage; Q14 PR chain from Task2 intelligence; Q10 rework by actor + never-written churn; Q19 generated/committed/acceptance; Q18 tokens + micro-costs; Q20 committed lines + previous, team unavailable.
- Commit 2 moves PR intelligence unchanged into `pullRequestIntelligence` (`e4b8c4b`, for Codex as Task2 owner).
- `npm test` 1052 pass (32 new); typecheck and lint clean; IT-T19b-01 agent-passed, founder run blocks the merge.

## Implemented interfaces
- `features/qa/answers/common.ts`: LifecycleValue mapping, ratio shares, envelope assembly, `loadScopeFacts` (Task2 functions only), thin `liveAnswer`/`rawAnswer`.
- `features/qa/answers/q01|q03|q04|q09|q10|q13|q14|q18|q19|q20.ts`: `computeQn` pure + `live` answerer; `register-code.ts` registers all ten.
- `features/qa/drilldown.ts`: tenant→repositories, repository→PRs, PR→commits, commit→none; cursor = last id base64url. `GET /api/qa/questions/{id}/drilldown` returns `{items, next_cursor}`; other questions keep 501.
- `verify:task19b-qa-live` (IT-T19b-01): seeds A (3 commits, 1 noteless, merged PR, deployment, 2 models, 2 sessions) and B, checks Q3/Q9/Q13/Q19 constants, Q20 previous, drill-down paging, A/B isolation, auditor 403.

## Deviations
- Top-level `unavailable` means every figure is unavailable (frozen schema), so mixed envelopes top out at `partial`, not the literal worst. Reasons still name every gap.
- Q20 previous equals current when only time differs: scope totals are all-time, so a time-only previous cannot change them.
- At commit scope Q4's production figure is the repository's; Q9's PR-scope deployment count is the repository's (Task2 scopes no finer).
- Q18 sessions with anything but one linked repository bucket as `unknown`, never double-counted. Cost units with no reported amount emit no figure.
- `qa-api.test.ts` drill-down test now expects 200 for built questions (plus a router `contextLoader` seam); Q5 still 501s.
- Prompt says T19.3 builds Q4 and moves Q11 to Task19c, but `TASK19.md` §6.1 row 2 still lists Q11: followed the prompt.

## Open issues for Task2 (rule 8)
- Merged-only denominator for Q3's share does not exist; reported over retained lines instead.
- Task2's free-text partial reasons have no envelope code; mapped to `answer_not_built`.
- Extra actor kinds fold into `reworked_by_unknown` so the buckets partition rework.

## Known limitations
- Founder run of IT-T19b-01 blocks the merge (below).
- Codex reviews commit 2 (`e4b8c4b`) as Task2 owner; lead reviews the rest.

## Test coverage
- `answers-code.test.ts` (21): recorded/partial/unavailable per question, null-never-0 sweep, key hygiene, Q20 previous keys, Q18 rounding/partial, full validator sweep via `answerQuestion`.
- `drilldown.test.ts` (11): exact pages, cursor round trip, invalid cursor 400, auditor 403, envelope/route item sameness.

## Integration test impact
- IT-T19b-01 `scripts/it-db.sh npm run verify:task19b-qa-live -w apps/api`: blocking for this merge. Agent-passed 2026-10-16 (Docker daemon was down; started Docker Desktop, throwaway pgvector DB, all six checks passed). Founder re-run required.
- No other integration impact; no migration; Task2 tests pass unmodified.

## Effort
- Estimate about 0.12× T6; actual about 0.30×. Over for three reasons: the frozen schema forced the top-level availability deviation (found by reading the schema, not the prompt); Docker was down and local Postgres has no pgvector (diagnosed to `CREATE EXTENSION vector`, started Docker Desktop); one type error slipped through a piped tsc. Next prompt: keep the estimate when the schema pre-check and Docker state are confirmed upfront.
