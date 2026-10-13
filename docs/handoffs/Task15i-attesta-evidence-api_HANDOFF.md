# Task15i-attesta-evidence-api Handoff — auditor-readable Attesta read routes and the audited verify (A15.9, part 1 of 2)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15i-attesta-evidence-api` (base: `main` at `52a1683`). The four `GET` routes of `api.md` at `/api/attesta`, for `tenant_admin` and `tenant_auditor`, with AP-1 conventions. No migration, no writes except one audit row per verify, no console.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 items 1–9: `attesta.read`, router and mount, conventions, four routes, `anchor_status`, verify with the `VerifyKeySource` seam and the one-per-tenant guard | ✅ |
| Quality | `npm test` 699 pass (baseline 668); typecheck, lint, `drizzle-kit check` clean | ✅ |
| Integration | IT-T15i-01…03 passed once in the agent sandbox (`scripts/it-db.sh`, local PostgreSQL 16) | 🟡 founder run pending |
| Review | Review subagent: no cross-tenant leak and no list/detail/subject field outside `api.md`. 1 must-fix fixed (a malformed `%`-encoding in the path gave a 500); should-fix: failed verifies are now audited, the sweep now checks middleware layers, a test proves the default router uses the real `requireAdminAction` | ✅ |

## Implemented interfaces (`apps/api/src/features/attesta/`)
Every response carries `X-Request-ID` (the caller's value if it matches `^[A-Za-z0-9._-]{1,64}$`, otherwise a fresh UUID) and `Cache-Control: no-store`. Errors are `application/problem+json` `{type, title, status, code, request_id}` with no other fields. The values below are synthetic.
```
GET /api/attesta/statements?repository_id=&kind=&subject_sha=&from=&to=&limit=&cursor=
 → {"statements":[{"statement_digest":"sha256:9f…","seq":41,"recorded_at":"2026-10-13T11:00:00.123000Z",
    "statement_kind":"pr_merged","predicate_type":"https://trackai.dev/attesta/ai-provenance/v1",
    "repository_id":"00000000-…-a1","subject_sha":"3f2a…9f0a","anchor_status":"anchored"}],"next_cursor":"eyJyIjoi…"}
GET /api/attesta/statements/sha256:9f…
 → {"record":{"seq":41,"prev_hash":"sha256:…","recorded_at":"…Z","record_hash":"sha256:…","canonical_record":"{…}"},
    "statement":{…parsed…},"envelope":{"payload":"…","payloadType":"application/vnd.in-toto+json","signatures":[{"keyid":"sha256:…","sig":"…"}]},
    "anchors":[{"anchor_type":"rekor","status":"anchored","inclusion_proof":{"version":1,…},"rekor_entry_uuid":"…",
    "tsa_token_b64":null,"error_code":null,"created_at":"…Z"}]}
GET /api/attesta/subjects/<repository_id>/<sha>
 → {"statements":[{…same item…,"previous":[]},{…,"previous":["sha256:9f…"]}]}   (seq order, at most 200; 404 when none)
GET /api/attesta/verify?from_seq=&to_seq=
 → verifyChain's ChainReport, version 2: {"report_version":2,"ok":false,"chain_intact":true,"checked":4,
    "breaks":[{"seq":0,"kind":"signatures_not_checked","detail_code":"ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED"}],
    "signatures":"not_checked","anchors":{"status":"checked","anchored":3,"pending":1,…},…}
```
- **Code:** `read-service.ts`: `parseListQuery`, `encodeCursor`/`decodeCursor` (base64url `{"r","s"}`; any cursor the service did not print is a 400), `anchorStatusOf`, `ANCHOR_WINDOW_MS` (= `DEFAULT_ANCHOR_WINDOW_MS`), `pgReadStore(executor)`, `verifyRange`, `anchorMaterialFromEnv`. `http.ts`: `attestaHttp`, `sendProblem`, `problemizeAuth`. `attesta.routes.ts`: `createAttestaRouter(deps)`, `attestaRouter`.
- **`anchor_status`** is a fact about the database rows, not a verification. It is `anchored` when the record has both an anchored `rekor` row and an anchored `tsa` row; `pending` inside the 1 h window; otherwise `missing`. Cryptographic checks happen only in `/verify`.
- **`VerifyKeySource` seam:** `(tenantId) => Promise<PublishedKey[] | null>`; the default returns `null`. Until Task15l's `publishedKeysFor` is wired in here (Task15i2), every non-empty report carries `ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED` and `ok` is false.
- **Anchor material:** `/verify` reads it from `anchorFromEnv(process.env).verify` when `ATTESTA_REKOR_URL` or `ATTESTA_TSA_URL` is set. With neither set, the report says anchors `not_checked`. If one is set but the configuration is broken, `/verify` answers 500; it never quietly skips anchors.
- **Verify audit:** one `security_audit_events` row per verify, failed ones included: `action: attesta.verify`, `target_type: attesta_chain`, `target_id: <from>-<to>`, details `{request_id, ok, checked, break_count[, failed]}`. List, detail and subject reads are not audited.

## Ported from
- SushiCorp AP-1 and AU-1 @ `0bd67a5`: `api/problems.py`, `api/security.py` and `api/rate_limit.py` (shape only), plus the tests `test_api_gaps.py`, `test_api_auditor.py` and `api_harness.py`. The tests were ported first, in `attesta-api.test.ts`. The route sweep compares the routes and the middleware layers against hand-kept lists, so a new route fails the test until it is classified. Deviations are listed in each file header.

## Deviations from spec
1. **401 and 503 have no code of their own.** `errors.md` has no unauthenticated or unavailable code, so the middleware's 401 maps to `ATTESTA_API_FORBIDDEN` with status 401, and its 503 maps to `ATTESTA_API_INTERNAL` with status 503. Proposed for the contract: `ATTESTA_API_UNAUTHENTICATED` and `ATTESTA_API_UNAVAILABLE`.
2. **`/verify` returns more than `api.md`'s `{checked, ok, breaks}`.** It returns the full version 2 report (§2.1.8): `range`, `head`, `signatures`, `warnings`, `anchors` and the rest. Proposed: the contract names report version 2.
3. **`sha` and `subject_sha` accept 64 hex as well as 40,** which is what the `attesta_records` check allows. Uppercase is refused, never normalized.
4. **`anchor_status` treats a record stamped more than 5 minutes ahead of the clock as `missing`,** the same rule as verifyChain.
5. **An open-ended `/verify` over a chain longer than 10 000 records answers 400,** rather than silently covering only part of it. The caller pages with `from_seq`/`to_seq`.
6. **An empty range is `ok: true` with `checked: 0`,** as verifyChain reports it ("never ok" holds for any range that has records).

## Known limitations
- The shared `/api` JWT and tenant middleware answer 401 and 403 before the Attesta router does, as plain JSON without `X-Request-ID` or `no-store`. That leaks nothing, but those responses are not problems. Fixing it would mean changing `core/middleware/`, which is out of scope.
- The verify guard (one verify per tenant at a time) works only within one process. Behind several replicas, each replica allows one; a shared limiter comes with Task11.
- In production, `/verify` with anchoring configured answers 500 until Task15l supplies the platform anchor key (`anchorSignerFromEnv` refuses there). Anchoring itself refuses to start in production for the same reason.

## Test coverage
`attesta-api.test.ts` (31 tests) covers:
- every route's success case, paging across a stable cursor, filters, and every invalid parameter or tampered cursor → 400, with nothing reaching the store;
- another tenant's digest → the same 404 as an unknown digest; the subject route's 404 cases;
- `X-Request-ID` echo and generation, `no-store` and the problem shape on every response;
- a generic 500 whose log line carries no secret; 429 with `Retry-After: 5`, other tenants not blocked, the guard released;
- the audit row on verify only (failed verifies included), and the keys and anchor material passed through;
- every pg query bound to the tenant and never selecting `credential_id`, checked on the rendered SQL;
- the AU-1 route sweep: 403, 401 and 503 problems on every route, and nothing written.

## Integration test impact
- **Tests added:** IT-T15i-01…03, all in `t15i-evidence-api-live-verify.ts`.
- **Command:** `scripts/it-db.sh npm run verify:task15i-evidence-api-live -w apps/api` (about 10 s).
- **Prerequisites:** none beyond `it-db.sh`.
- **What the tests run against:** the real JWT and tenant middleware (a local JWKS stands in for Supabase), the real `requireAdminAction`, the real builder and anchoring worker with dev signers and the Rekor and TSA fakes, and anchoring configured through the environment.
- **Blocking:** this merge and A15.11 (console).
- **Status:** 🟡 agent sandbox 2026-10-13. **FOUNDER:** run it once.

## Integration notes
- **Task15i2** adds the `POST` routes (`period-reports`, `evidence-packs`), `GET evidence-packs/{id}` and the anchor-resume action. It wires Task15l's `publishedKeysFor` into `VerifyKeySource` (`createAttestaRouter({ keys })`), and it must add each new route to `EXPECTED_ROUTES`/`EXPECTED_MUTATING`. Auditors get 403 on the writes, which means adding a write action to `admin-authorization.ts`, since `attesta.read` is auditor-allowed.
- **A15.11 (console) and A15.10 (offline verifier)** can build against these response shapes now.

## Effort (estimate vs actual)
Estimated 0.15–0.2× T6; actual about 0.15× T6, including one review round.
