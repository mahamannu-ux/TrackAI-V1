# Q&A API (Task19a, T19.2; frozen once merged, additive changes only)

Read-only routes over the question registry (`questions.md`) and the answer envelope (`answer-v1.schema.json`). Rules in plain words: `README.md`.

## Conventions

| Rule | Value |
|---|---|
| Mount | `/api/qa/*`, after `/api`'s Supabase JWT and tenant middleware (`apps/api/src/app.ts`) |
| Authorization | admin action `qa.read`: `tenant_admin` and `tenant_auditor`; everyone else 403 `QA_FORBIDDEN`. The server refuses `kind=live` to `tenant_auditor` (`QA_KIND_NOT_ALLOWED`): auditors get verifiable and signed answers only (TASK19.md D2) |
| Errors | RFC 7807 `application/problem+json`, exactly `{type, title, status, code, request_id}`, `type` = `https://trackai.dev/problems/<code>`, a fixed title per code; 5xx never carries a cause |
| Request ID | `X-Request-ID` accepted when it matches `^[A-Za-z0-9._-]{1,64}$`, otherwise replaced by a fresh UUID; echoed on every response, errors included, and in server log lines |
| Caching | `Cache-Control: no-store` on every response |
| Paging | keyset: `limit` 1..100 (default 50), opaque `cursor`, `next_cursor` or `null` (drill-down only) |
| Exception | `GET /api/qa/questions` is **unpaged**: the registry is a fixed catalogue of at most 100 entries, not tenant data (an AP-1 exception, stated here) |
| Audit | Reading an answer is not audited in v1 (decision in the Task19a handoff); A16.13 decides for verifiable answers |
| Content | metadata only: no envelope field carries a prompt, command, code, file path, diff or a session's text (AGENTS.md rule 6) |

Pattern from Task16c `features/audit/http.ts`, catalog AP-1 (copied into `features/qa/http.ts`, not imported).

## Routes

| Method and path | Returns |
|---|---|
| `GET /api/qa/questions` | `{registry_version, items}`: every registry entry (`questions.md`), rank order, code family first |
| `GET /api/qa/questions/{id}` | `{registry_version, question, answers}`: the entry, and per kind it offers `{kind, builder, built, open_gaps}` (`built` is whether an answerer is registered) |
| `GET /api/qa/questions/{id}/answer?kind=&repository_id=&pull_request_id=&commit_sha=&from=&to=&breakdown=` | One envelope (`answer-v1.schema.json`), 200 |
| `GET /api/qa/questions/{id}/drilldown?kind=&repository_id=&pull_request_id=&commit_sha=&from=&to=&limit=&cursor=` | Defined now, built in Task19b: 501 `QA_DRILLDOWN_NOT_BUILT` until then. When built: `{items: [{scope, id, label}], next_cursor}`, the same item shape as the envelope's `drilldown` |

### Answer parameters

| Parameter | Rule |
|---|---|
| `id` | `Q1`…`Q20`, `S1`…`S26`; anything else 404 `QA_QUESTION_NOT_FOUND` |
| `kind` | required: `live`, `verifiable` or `signed`. Missing or another word: 400 `QA_SCOPE_INVALID`. A kind the question does not offer: 400 `QA_KIND_NOT_OFFERED`. `live` asked by an auditor: 403 `QA_KIND_NOT_ALLOWED` |
| `repository_id`, `pull_request_id` | lowercase UUIDs; another tenant's id gets the same 404 `QA_SCOPE_NOT_FOUND` as an unknown id, never 403. A pull request that is not in the given repository: 404 |
| `commit_sha` | 40 or 64 lowercase hex, and requires `repository_id`; a commit not observed in that repository: 404 |
| scope level | the most specific id given: `commit_sha` → `commit`, `pull_request_id` → `pull_request`, `repository_id` → `repository`, none → `tenant`. A level the question does not accept (`questions.md`): 400 `QA_SCOPE_INVALID` |
| `from`, `to` | RFC 3339 with an explicit `Z` or offset; normalized to UTC milliseconds in the envelope. Defaults: `to` = the query time, `from` = `to` − 30 days. `from` > `to`, or more than 366 days apart: 400 `QA_SCOPE_INVALID` |
| `breakdown` | optional; one of the question's `dimensions`; otherwise 400 `QA_SCOPE_INVALID` |
| any other parameter, or one given twice | 400 `QA_SCOPE_INVALID` |

Checks run in this order: authorization, question, `kind`, kind offered, kind allowed for the role, parameters, scope existence, answer.

### Answers and answerers

An answer comes from the **answerer registry** (`apps/api/src/features/qa/answerers.ts`): `registerAnswerer(questionId, kind, answerer)`, where `answerer(ctx) → Promise<Envelope>` and `ctx` carries the tenant, the question and kind, the caller's role, the validated scope and scope level, the breakdown and the query time. One answerer per question and kind; registering a second, or for a kind the question does not offer, throws at start-up.

- **No answerer registered:** 200 with `availability: unavailable`, no figures, and the reasons `answer_not_built` (or `phase_2` for a phase 2 question) plus one `not_captured_yet` per open gap of the question; the question's required `wording` codes are present.
- **Every envelope an answerer returns is validated** against `answer-v1.schema.json` and the registry (same question, kind and registry version; the request's scope; required wording; `previous` exactly for `compare_previous` questions, with the same figure keys; breakdown dimensions allowed for the question). An invalid envelope never reaches the client: 503 `QA_ANSWER_INVALID`, logged with the request id and the first failing rule's path only.
- An answerer that throws: 503 `QA_UNAVAILABLE`.

## Problems

| Code | Status | When |
|---|---|---|
| `QA_UNAUTHENTICATED` | 401 | no tenant or subject |
| `QA_FORBIDDEN` | 403 | not a `tenant_admin` or `tenant_auditor` of the tenant (developers, revoked members) |
| `QA_QUESTION_NOT_FOUND` | 404 | unknown question id |
| `QA_KIND_NOT_OFFERED` | 400 | the question has no such kind |
| `QA_KIND_NOT_ALLOWED` | 403 | `kind=live` for `tenant_auditor` |
| `QA_SCOPE_INVALID` | 400 | a bad parameter (see above) |
| `QA_SCOPE_NOT_FOUND` | 404 | the repository, pull request or commit is not the tenant's |
| `QA_DRILLDOWN_NOT_BUILT` | 501 | the drill-down route, until Task19b |
| `QA_ANSWER_INVALID` | 503 | an answerer returned an envelope that fails validation |
| `QA_UNAVAILABLE` | 503 | the authorization store, the scope lookup or an answerer failed |
