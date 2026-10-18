# Task19e-qa-questions-screen Handoff — customer and auditor Questions screen

> Status: 🟡 implementation, typecheck, lint, migration check and web build pass in the agent sandbox; one inherited API timing test flaked on the latest full-suite run. **FOUNDER:** runs the browser walkthrough before T19.9 is complete.

Branch `task/Task19e-qa-questions-screen` (base: `main` at `0ff424a`).

Task19e adds the Questions screen to the dashboard for active tenant administrators and auditors. It reads only the Q&A registry, question detail and answer endpoints; no API server route, contract, database or dependency changes were made. The UI keeps unavailable values unavailable, shows the signed/live kind and caveats, and keeps the Questions view and answer filters in the URL.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Questions are grouped and ranked, searchable, and selectable | 🟡 implemented; founder walkthrough pending |
| Acceptance | Active tenant admins and auditors can open Questions; auditors cannot request live answers | 🟡 implemented; founder walkthrough pending |
| Acceptance | Kind, period, scope and breakdown controls match the question; selections persist in query parameters | 🟡 implemented; founder walkthrough pending |
| Acceptance | Unavailable values are never rendered as zero or a chart; partial values and reasons remain visible | 🟡 implemented; founder walkthrough pending |
| Acceptance | Count, ratio and duration values, breakdowns, previous periods, wording, drill-down and answer references render from the envelope | 🟡 implemented; founder walkthrough pending |
| Scope | Web-only changes in the prompt's pre-approved files | 🟡 verified in the agent sandbox |
| Quality | API+web typecheck, lint, migration check and web build pass; latest full API suite had one inherited Attesta timing failure | 🟡 see Test coverage |
| Integration | No integration test added; founder UI walkthrough remains | 🟡 non-blocking for merge |
| Review | Independent review's Attestation-navigation finding fixed; rerun review before push | 🟡 |

## Implemented interfaces
```ts
// apps/web/src/lib/api.ts
getQaQuestions(): Promise<QaQuestionList>
getQaQuestion(id: QaQuestionId): Promise<QaQuestionDetail>
getQaAnswer(id: QaQuestionId, query: QaAnswerQuery): Promise<QaEnvelope>
getQaAnswer(id: QaQuestionId, query: QaAnswerQuery, drilldown: true): Promise<QaDrilldownPage>

// apps/web/src/app/dashboard/questions-workspace.tsx
QuestionsWorkspace({
  repositories,
  pullRequests,
  role,
}): JSX.Element
```

## Ported from
None. The UI follows the in-repository `FleetWorkspace` pattern as directed by the prompt; UI-1 supplies the accessibility and auditor-surface rules until Task10's design system exists.

## Founder-approved decisions
1. The dashboard's existing active-membership guard is used, narrowed to `tenant_admin` and `tenant_auditor` for Questions.
2. Live is visible but disabled for auditors. Unbuilt answer kinds are shown separately with their open gap IDs and are never requested.
3. Evidence references open the existing Attesta workspace directly inside Questions; the reference remains visible there.

## Deviations from spec
- `GET /api/qa/questions/{id}` returns `open_gaps` as gap IDs only; it does not return gap titles. The UI links IDs to a visible list of those references and states that titles are not part of the registry response. No title was guessed or fetched elsewhere.
- The frozen answer schema defines exactly three value forms: count, integer ratio, and duration in milliseconds. The UI renders those forms, including numerator and denominator for ratios.
- The existing Attesta workspace does not filter statements by digest or answer scope. Reference buttons open that workspace directly and keep the envelope reference visible; they do not fetch or enrich the answer.
- `apiFetch` now preserves RFC 7807 code, request ID and status in `ApiProblemError`, while retaining a readable message for existing callers.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 **FOUNDER:** | Run the browser walkthrough below with the normal local API environment | Non-blocking for merge; required to close T19.9 |
| 🟡 | The web app has no unit-test harness | Typecheck, lint and production build pass; role-specific live behavior still needs the founder walkthrough |
| 🟡 | The Q&A question detail response has no gap titles; the Attesta workspace cannot filter to an individual statement | UI shows only returned metadata and keeps the evidence reference visible beside the existing Attesta workspace |
| 🟡 | The latest full API suite run failed the inherited Attesta timing assertion "600 keys parse quickly" (1222 passed, 1 failed); that test file passes alone (19/19) | No Attesta files changed; machine-speed threshold is unrelated to this web change |

## Test coverage
- The web workspace has no unit tests. API+web typecheck, repository lint, migration check and web production build pass.
- `npm test` passed once earlier in the session. The latest full-suite run completed with 1222 passing and one inherited Attesta timing failure; `src/features/attesta/trust-verify.test.ts` passes alone (19/19).
- `apiFetch` error details are type-checked and build-checked; no API server behavior or route was changed.
- Browser role behavior and visual layout are left to the founder walkthrough.

## Integration test impact
No database integration test was added; this is a web-only change. The founder walkthrough is non-blocking for the Task19e merge and is the first step of T19.9. Prerequisites: Docker with the pgvector image available, or local PostgreSQL 16 with pgvector for the helper's fallback; no hosted Supabase project is needed for the synthetic walkthrough.

**FOUNDER:** The web client still requires Supabase-compatible Auth configuration even for local development. For a disposable walkthrough, use the repository's fake Auth server and `scripts/it-db.sh` (which starts a temporary PostgreSQL 16 + pgvector instance on a free port, applies migrations, and removes the database when the API stops). The fake Auth server is not the database, and the placeholder anon key below is only for this local test setup.

The Task6 acceptance seed was updated to avoid targeting a legacy uniqueness constraint removed by Task20 migration 0025. The disposable corpus-plus-auditor seed sequence below has been verified on a fresh database.

Start these in three terminals from the repository root:
```bash
# Terminal 1: local fake Supabase Auth (keep running)
TASK5_EPHEMERAL_DATABASE=1 npm run serve:task5-acceptance-auth -w apps/api

# Terminal 2: disposable Docker PostgreSQL, seed synthetic admin/auditor access, then start the API.
# Keep this terminal running; stopping it also removes the throwaway database.
scripts/it-db.sh sh -c 'TASK5_ACCEPTANCE_PERSIST=1 npm run verify:task5-corpus-live -w apps/api && npm run seed:task6-acceptance -w apps/api && SUPABASE_URL=http://127.0.0.1:54321 FRONTEND_URL="http://localhost:3000,http://127.0.0.1:3000" npm run dev:api'

# Terminal 3: web console, configured to use the local fake Auth server and API
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=task5-local-public-placeholder \
NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 npm run dev:web
```

Open `http://localhost:3000/login`, then sign in with the synthetic acceptance users:
- Admin: `admin@task5.acceptance.invalid` / `task5-acceptance-only`
- Auditor: `auditor@task5.acceptance.invalid` / `task6-auditor-only`

The local Auth URL and placeholder key fix the missing-environment-variable error; setting them does not configure the API database. The database is disposable and is removed when the API/`scripts/it-db.sh` process stops.

Then check:
- Admin, S7: partial answer shows its availability and reasons, plus any previous-period breakdown.
- Admin, S12: unavailable figure values stay unavailable; no zero or empty chart stands in for missing data.
- Admin, Q3, Q1 and Q4: the top three code questions appear in rank order and filters update the answer URL.
- Auditor, a question offering live: live is disabled with the administrator-only note and no live request is sent.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| T19.9 walkthrough | Admin and auditor Questions screen, partial/unavailable states, URL filters and disabled live option | Non-blocking for Task19e merge; required for T19.9 | ⬜ founder run |

Task19d and other independent work can proceed without this walkthrough; T19.9 remains open until the founder completes it.

## Integration notes
- The API response is the sole source of question and answer data. The page does not query other endpoints to enrich answers. An explicit evidence-reference click opens the existing Attesta workspace and displays the original reference.
- Answer URLs preserve the Questions view, question, kind, period, scope IDs, custom dates and breakdown. Drill-down uses the response's last item as the cursor and only appears when the answer contains drill-down items.
- All API errors retain the request ID for support, and known Q&A problem codes display plain-language messages.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.12× | about 0.13× | one session | about 30 minutes | not shown |
