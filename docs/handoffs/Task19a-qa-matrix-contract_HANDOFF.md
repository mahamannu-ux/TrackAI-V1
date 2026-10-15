# Task19a-qa-matrix-contract Handoff — Task19 Q&A matrix and contract (T19.1, T19.2)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task19a-qa-matrix-contract` (base: `main` at `67c903f`).

This session confirms the 38-row delivery matrix against the code (T19.1). It also freezes the **Q&A contract** that every answer surface shares (T19.2): the question registry as code, one answer envelope, and `/api/qa/*` with its guards. It answers **no** question. Every call returns an honest `unavailable` with `answer_not_built` until Task19b/19c/19d and A16.13 register answerers.

## At a glance
| | Item | Status |
|---|---|---|
| T19.1 | every row checked; `TASK19.md` §3 corrected; new §3.1 "Answer sources" (`file:line`, Task2 function, open issue per row); gap owners confirmed | ✅ |
| T19.1 | Q2 sized: Codex, about 0.12× (`TASK19.md` §6.1 row 4); Task19b/19c split unchanged | ✅ |
| T19.2 | registry (38 questions, 13 gaps), envelope schema and types, validation, routes, guards, contract files, fixtures | ✅ |
| Item 9 | Task2 move: `loadContext`, `lifecycleForTenant`, `lifecycleForModel` and helpers into `task2-lifecycle-read.ts`, unchanged | ✅ (Codex to review) |
| Quality | `npm test` 1018 pass (24 new); typecheck; `npm run check` | ✅ |
| Integration | IT-T19a-01 | 🟡 agent-verified · ⬜ founder run (blocking the merge) |
| Review | independent review subagent; Codex cross-review | see "Review" |

## Implemented interfaces
```text
docs/contracts/qa/README.md            the rules (honest states, no person, no raw content, auditor kinds)
docs/contracts/qa/api.md               routes, parameters, problems
docs/contracts/qa/answer-v1.schema.json  the envelope (Draft 7, closed objects)
docs/contracts/qa/questions.md         generated: npm run qa:registry -w apps/api (unit test fails when stale)
docs/contracts/qa/fixtures/            valid-<kind>-<availability>.json ×9; invalid-*.json ×8

GET /api/qa/questions                                  {registry_version, items}  (unpaged: fixed catalogue)
GET /api/qa/questions/{id}                             {registry_version, question, answers[{kind, builder, built, open_gaps}]}
GET /api/qa/questions/{id}/answer?kind=&repository_id=&pull_request_id=&commit_sha=&from=&to=&breakdown=
GET /api/qa/questions/{id}/drilldown?…&limit=&cursor=  501 QA_DRILLDOWN_NOT_BUILT until Task19b

// apps/api/src/features/qa/answerers.ts: what Task19b/19c/19d and A16.13 build against
registerAnswerer(questionId, kind, (ctx: QaAnswerContext) => Promise<QaEnvelope>)
// ctx: { tenantId, questionId, kind, role, scopeLevel, scope{repository_id?, pull_request_id?, commit_sha?, from, to}, breakdown, now }
// every returned envelope is checked (schema + registry + the request); invalid → 503 QA_ANSWER_INVALID

admin action 'qa.read' (tenant_admin, tenant_auditor); kind=live refused to tenant_auditor (QA_KIND_NOT_ALLOWED)
features/telemetry/task2-lifecycle-read.ts: loadContext, lifecycleForTenant, lifecycleForModel, audited, …
  (Task2-owned; features/qa/ may import it and lifecycle.ts only)
```

## Matrix corrections (T19.1)
1. **Q20, S17:** no team mapping exists (no team table or column), so by-team answers `unavailable`. Logged as an open issue in §3.1 with no new G id; the lead assigns an owner (nearest: Task2 T2.20).
2. **Q3, Q9, Q13:** the Task15i4 period report already signs their figures (`period-report.md:27`), so the registry offers `signed` (Task15i4) as well.
3. **Q2:** ranges are stored, but there is no line-offset history, so blame needs the provider's (GitHub GraphQL `blame`) mapped through merge lineage. Codex, about 0.12×.
4. **Q18:** cost is `numeric(20,6)`, and the envelope has no floats, so Task19b reports integer millionths per cost unit.
5. **Q14:** the chain logic is inline in the PR-intelligence handler (`read.routes.ts:308`), not a Task2 function. Open issue for Task2.
6. **Gaps:** G2 adds S13, G9 adds S1, G10 adds Q11 and S6 (the matrix already named them). All owners are confirmed as written.
7. **S3:** the monitor setting is also read in `storage-service.ts:212`, and still has no writer (G8 confirmed).

## Ported from
- **AP-1:** pattern from Task16c `features/audit/http.ts`, catalog AP-1, copied into `features/qa/http.ts` with Q&A codes. Not imported across Task16's boundary.
- **RP-1:** the per-figure `evidence` `{count, statements_root, records[{seq, digest}]}`, via `docs/contracts/attesta/period-report.md`.
- **CF-1:** registry as code, plus a generated, test-checked document (Task16b's catalog shape).
- The registry and the envelope themselves are new: no SushiCorp module answers questions over its own data.

## Founder-approved decisions
1. D1–D5 (`TASK19.md` §1). Item 9 under §7 item 3.
2. Checkpoint question (reading a Q&A answer audited?). Built on the recommendation: **not for live answers** (aggregates, like `/api/metrics/lifecycle`). A16.13 decides for verifiable answers. Pending the founder's word.

## Deviations from spec
- `core/security/security.test.ts`: one line, outside the pre-approved list. It pins the auditor's allowed actions, so adding `qa.read` (item 7) breaks it without this line.
- Lead's choices within scope:
  - `kind` is required; a missing or unknown kind is `QA_SCOPE_INVALID`.
  - The default period is the last 30 days.
  - `commit_sha` requires `repository_id`.
  - Unknown or repeated parameters are `QA_SCOPE_INVALID`.
  - `phase` is an extra registry field (Q17 = 2), and builder `null` means "not scheduled".
  - A signed answer that is `unavailable` may omit `signed`.
  - An unavailable figure carries no breakdown buckets.
  - Drill-down labels may not contain `/` or `\`.
- The registry version is pinned by a content digest in `qa-contract.test.ts`, so a change without a bump fails.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | run IT-T19a-01 (below) | blocks the merge |
| 🟡 | no answerer is registered: every answer is `unavailable` / `answer_not_built` | Task19b/19c/19d, A16.13 |
| 🟡 | the drill-down answers 501 | Task19b |
| 🟡 | team mapping, Q14 chain function, Q18 cost units: open issues in `TASK19.md` §3.1 | lead assigns owners |

## Test coverage
- `qa-contract.test.ts` (13):
  - the registry against both catalogue tables (ids, ranks, auditor flags) and the "Gaps found" table;
  - the version digest; `questions.md` in sync;
  - the no-person scan; `monitor_only_observed` on every security question;
  - every fixture valid or failing at its named path;
  - unavailable never 0 (six spellings); integer bounds; the registry rules; closed objects.
- `qa-api.test.ts` (11): the real router in-process.
  - Mocked: the membership lookup (decided by the real `adminMembershipAllows`) and the scope store.
  - Covered: every problem code, auditor refused live and allowed verifiable and signed, developer and revoked member refused, cross-tenant 404, invalid or throwing answerer gives 503 without leaking text, request id and `no-store` on success and on error, a not-built envelope valid for every question and kind.
- The auditor sweep covers the new router (`qa.read`, router-level).
- Task2's existing tests pass unmodified after the move.

## Integration test impact
> **FOUNDER:** blocking for the Task19a merge. Prerequisites: Docker or local PostgreSQL 16 with pgvector. Expected: `IT-T19a-01 passed` in under a minute.
> ```bash
> scripts/it-db.sh npm run verify:task19a-qa-live -w apps/api
> ```

| ID | What it proves | Gating | Status |
|---|---|---|---|
| IT-T19a-01 | (a) admin Q3 live envelope valid; (b) auditor live 403 / verifiable 200; (c) developer 403; (d) B's repository id 404 for A; (e) request id echoed, `no-store` | Blocking: Task19a merge | 🟡 agent-verified 2026-10-15 · ⬜ founder run |

## Integration notes
- **Answerers (Task19b/19c/19d):** register at import time in a module `app.ts` loads (A16.13's prompt decides where its files live). Read lifecycle figures only through `task2-lifecycle-read.ts` / `lifecycle.ts` (rule 8). Follow §3.1 per question.
- **A16.13:** build against `fixtures/valid-verifiable-*.json` and `valid-signed-*.json`. `evidence` follows RP-1. `as_of` is the newest input statement's `recorded_at`.
- **Bumping the registry:** after editing `registry.ts`, run `npm run qa:registry -w apps/api`, bump `QA_REGISTRY_VERSION`, and record the digest the test prints.

## Review
- Independent review subagent: see the session's final reply. Fixes were committed or explained.
- Codex cross-review: pending, and it includes the Task2 move commit on its own.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.09× | about 0.10× | ~90 turns + review | ~2.5 h | n/a |
