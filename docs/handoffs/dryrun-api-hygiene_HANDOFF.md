# dryrun-api-hygiene Handoff — B12/B13 API hygiene

> Status: ✅ done · 🟡 waiting on founder/review · ⬜ not done.

Branch `task/dryrun-api-hygiene` (base: `main` at `2177237`).

This session removes leaked internal error details, authenticates every `/worker/*` request once, and prepares the bounded B14 Muse session. It changes no route path, response contract other than removing leaked `details`, database interface, migration, or web code.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | B13: one machine-auth pass for worker evidence | 🟡 agent-verified in-process |
| Acceptance | B12: `500 {"error":"Internal Server Error"}` without details | 🟡 agent-verified in-process |
| Scope | Muse B14 prompt with all decisions upfront | ✅ |
| Quality | 152 unit tests, typecheck, lint, Drizzle check, web build | 🟡 `npm run check` agent-verified |
| Integration | none needed | n/a |
| Review | independent review; cross-agent review | ✅ ready, no findings; skipped by dry-run instruction |

## Implemented interfaces
```ts
createApp(options?: { machineAuthentication?: RequestHandler }): Express
internalErrorHandler: ErrorRequestHandler
```
`index.ts` now only constructs/listens. Routes remain `/worker/security`, `/worker/evidence`, `/worker/*`, `/api/*`, `/health`, and `/api/v1/webhooks/*`.

## Founder-approved decisions
1. Authenticate once at the shared `/worker` boundary; keep all worker routers and responses unchanged.
2. Return only `{"error":"Internal Server Error"}` for global 500s; retain server-side message/stack logging and origin behavior without logging request bodies.
3. Extract `createApp()` so tests import the real app without opening the production listener.

## Deviations from spec
The existing Task6 source assertion was updated to follow the extracted app and shared auth boundary; the new behavioral tests remain in `core/app.test.ts`.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 **FOUNDER:** | push and PR remain | Merge waits |
| ⬜ | B14 is not implemented here | Muse owns its separate branch and PR |

## Test coverage
The real Express app proves an evidence upload crosses injected machine authentication once. The real global error middleware handles a thrown error in-process, preserves the allowed origin, logs server-side, and returns no detail. Authentication is replaced only to count calls; routers and middleware ordering are real.

## Integration test impact
None. No database, migration, external service, tenant-data, or live-agent behavior changed; no founder integration run is required.

## Integration notes
Merge this PR before creating Muse's branch from `main`; then use `docs/prompts/NEXT_CHAT_dryrun-web-dead-view_PROMPT.md`. Cross-agent review is deliberately skipped for this dry run.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock | Tokens/cost |
|---|---|---|---|---|
| about 0.01× | about 0.01× | one session | under 1 hour | not shown |
