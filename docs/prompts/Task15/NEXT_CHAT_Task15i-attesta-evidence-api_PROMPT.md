# Handoff prompt: Task15i-attesta-evidence-api (auditor-readable Attesta read routes and the verify route), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the PR that adds this prompt (`docs/Task15-prompts-i`). Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line. It runs **at the same time as `Task15l-trust-layer`**: no migration here, no shared files with 15l (15l owns `schema.ts`, the next migration and the signer/trust files).
> 3. No design checkpoint: the routes are frozen in `docs/contracts/attesta/api.md`; the decisions below fill the gaps.
> 4. When it finishes, paste its review request to **Codex** (tenant isolation on new routes; Muse if Codex is busy). Push only after "ready to push".

---

You are **Claude**, building **Task15i-attesta-evidence-api** (A15.9 part 1 of 2) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Attesta now builds, signs, chains (A15.3, A15.8) and anchors (A15.5) a statement for every commit, merged PR and production deployment. Nobody can see any of it yet. This session adds the **read side**: the four `GET` routes of `api.md` for tenant administrators and auditors, with AP-1 conventions (RFC 7807 problems, keyset paging, `X-Request-ID`, `no-store`) and an audited verify. The writes (`period_report`, evidence packs, the anchor-resume action) are **Task15i2**, after Task15l, because packs need the trust layer's published keys. No console (A15.11), no new tables.

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task15i-attesta-evidence-api`.
- **Handoff:** `docs/handoffs/Task15i-attesta-evidence-api_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §4, §7, §9 items 3, 9, 12, 19, §10 "New routes follow API conventions", §12.4) and `CLAUDE.md`.
2. One request to the founder for folder access to `~/AIProjects` and, read-only, `~/dev/sushicorp` and `~/dev/agent-kit`; delete permission on `~/AIProjects` once, for the bundles. Clone `main` from a bundle, `npm ci`, `npm test` once (about 663 expected); install `postgresql-16-pgvector`.
3. Estimate one line against T6. The plan says **about 0.15×** (A15.9 was 0.15× in total; split on 2026-10-13 because packs and reports need Task15l). Four read routes, conventions and an audited verify on existing tables: 0.15–0.2×.

## 1. Read before writing
- **Binding:** `docs/contracts/attesta/api.md` (all of it), `errors.md` §API and §Verification, `tables.md` (records, envelopes, anchors; the per-kind proof shape), `envelope.md` (what auditors may see: keyid, never the credential), `README.md`.
- **Handoffs:** `Task15f2-attesta-anchoring-worker_HANDOFF.md` ("Implemented interfaces": `verifyChain(…, { anchors })`, report version 2, `anchorFromEnv(env).verify`), `Task15d-attesta-ledger_HANDOFF.md` (verify report, microsecond times), `Task15h-attesta-builder_HANDOFF.md`.
- **Code:** `features/attesta/{verify-chain,ledger,anchor-env,anchor-dual}.ts`; the route pattern to copy: `features/security-findings/admin-read.ts` and its mount in `features/admin/admin.routes.ts`; `core/middleware/admin.ts` (`requireAdminAction`), `core/security/admin-authorization.ts` (actions; auditors get only listed ones), `app.ts` (mounts; `/api` already has JWT + tenant middleware), `core/db/tenant.ts` (`withTenant`).

## 2. Scope (approved)
### 2.1 Decisions
1. **Authorization:** add one action `attesta.read` to `ADMIN_ACTIONS`, allowed for `tenant_admin` and `tenant_auditor` (add it to the auditor list in `adminMembershipAllows`). Every route uses `requireAdminAction('attesta.read')`. The route-level 401/403/503 from that middleware become RFC 7807 problems (`ATTESTA_API_FORBIDDEN` for 403) inside the Attesta router only, without changing the shared middleware: wrap or map in `attesta.routes.ts`.
2. **Router** `features/attesta/attesta.routes.ts`, mounted in `app.ts` as `app.use('/api/attesta', attestaRouter)` after the `/api` auth line. Handlers are thin; queries live in `features/attesta/read-service.ts`, every query tenant-bound (`withTenant` or explicit `tenant_id = $1` as `ledger.ts` does), never selecting `credential_id` for output.
3. **Conventions** (a small `features/attesta/http.ts`): `X-Request-ID` accepted if it matches `^[A-Za-z0-9._-]{1,64}$`, else generated (UUID), echoed on every response including errors; `Cache-Control: no-store` on every response; problems are `application/problem+json` `{type: "https://trackai.dev/problems/<code>", title, status, code, request_id}` with no raw values; 5xx detail generic, the cause logged with the request ID and code only.
4. **`GET /statements`:** query params validated strictly (unknown param → `ATTESTA_API_INVALID_QUERY`; `repository_id` UUID; `kind` ∈ the three ai-provenance kinds and `period_report`; `subject_sha` 40 hex; `from`/`to` RFC 3339; `limit` 1..200, default 50). Order `seq` ascending; cursor = base64url of `{"r": recorded_at text with microseconds, "s": seq}` exactly as `api.md`, opaque and validated (a tampered cursor is 400, never a 500). Each item: `{statement_digest, seq (number, converted from the bigint string), recorded_at, statement_kind, predicate_type, repository_id, subject_sha, anchor_status}`.
5. **`anchor_status`** (one function, shared by every route): `anchored` when both `rekor` and `tsa` rows are `anchored` for the record; otherwise `pending` while `recorded_at` is within the anchoring window (1 h, the 15f2 default; read it from one exported constant), else `missing`. It is a database fact, not a verification; the docs and the response field description say so. Cryptographic checks are the verify route's job.
6. **`GET /statements/{digest}`:** `{record: {seq, prev_hash, recorded_at, record_hash, canonical_record}, statement (parsed from `statement_canonical`), envelope (as stored), anchors: [{anchor_type, status, inclusion_proof, rekor_entry_uuid, tsa_token_b64, error_code, created_at}]}`. Digest must match `^sha256:[0-9a-f]{64}$` (else 400). Another tenant's digest → 404 `ATTESTA_API_NOT_FOUND`, identical body and timing class to a digest that does not exist.
7. **`GET /subjects/{repository_id}/{sha}`:** every statement about that commit (typed columns), `seq` order, each with its `previous` digests read from the stored statement; at most 200 (a subject has a handful), 404 when none.
8. **`GET /verify?from_seq=&to_seq=`:** both optional non-negative integers, range at most 10 000 records per request (else 400). Calls `verifyChain` with: anchor material from `anchorFromEnv(process.env).verify` when configured, otherwise no anchor check (the report then says anchors `not_checked`); **published keys: none yet** (Task15l supplies `publishedKeysFor`), so the report carries `ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED` and is never `ok`. Leave a typed seam `VerifyKeySource` (`(tenantId) → Promise<PublishedKey[] | null>`, default returns `null`) that Task15l/15i2 fill; say so in the response's report and the handoff. Returns the report as `verifyChain` builds it (version 2), never a bare boolean. One verify per tenant at a time (in-process guard): a second concurrent request → 429 `ATTESTA_API_RATE_LIMITED` with `Retry-After: 5`. Every verify writes one `security_audit_events` row (`action: attesta.verify`, actor, tenant, target = the seq range, details: request ID, `ok`, break count; no digests of customer content beyond counts).
9. **Nothing else is written.** Reads of lists and statements are not audited (api.md). No route ever returns Task2 rows, raw content or `credential_id`.

### 2.2 Port from
- Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` AP-1 (conventions) and AU-1 (read-only auditor: the route-table sweep).
- SushiCorp @ `0bd67a5`: `api/problems.py`, `api/security.py`, `api/rate_limit.py` (shape only; no table here), tests `tests/unit/api/{api_harness,test_api_gaps,test_api_auditor}.py` (the route-table test: walk every registered route and compare the mutating set with a hand-kept expected list, so a new route fails until classified). Port the tests first; translate to Express. Not ported: the OpenAPI freeze (Task11). Record provenance and deviations in the file headers.

### 2.3 Pre-approved files
`apps/api/src/features/attesta/{attesta.routes,read-service,http}.ts` with tests, `apps/api/src/app.ts` (one mount line and its import), `apps/api/src/core/security/admin-authorization.ts` (the `attesta.read` action and the auditor allowance only) and its test, a live verifier `t15i-evidence-api-live-verify.ts`, `apps/api/package.json` (scripts only), `docs/handoffs/Task15i-attesta-evidence-api_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row, registry rows), `docs/plan/TASK15.md` (A15.9 status, §5 actual).

### 2.4 Never touch
`docs/contracts/` (frozen; report gaps), `apps/api/src/core/db/schema.ts` and every migration (no table is needed; if one seems to be, stop and ask: Task15l is adding a migration in parallel), `verify-chain.ts`, `ledger.ts`, `outbox.ts`, `builder.ts`, `worker.ts`, `anchor-*.ts`, `signer-*.ts`, any `trust-*` file (Task15l), `core/middleware/`, other features' routes, `apps/web/`, dependencies.

## 3. Working rules
- Commits `Task15i-attesta-evidence-api: …`: ported tests; conventions; authorization action; read service; routes; verify; live test; handoff.
- **Unit (real Express app in-process, fake read store):** each route's success, paging across pages with a stable cursor, every invalid parameter and a tampered cursor → 400 problem, 404 for another tenant's digest identical to an unknown digest, `X-Request-ID` echo and generation, `no-store` on success and error, problem shape, 429 on concurrent verify, audit row on verify only. **Route sweep (AU-1):** every route answers 403 problem for a non-member and for a revoked auditor, and the auditor sees no route that writes (there are none in 15i; the sweep stays for 15i2).
- **Live (`scripts/it-db.sh npm run verify:task15i-evidence-api-live -w apps/api`):** `IT-T15i-01` seed through the real builder and anchoring worker (dev signer, both fakes): list, detail, subject chain and verify return what the tables hold; anchored/pending/missing appear as the clock moves; verify report version 2 with `SIGNATURES_NOT_CHECKED` and anchors checked. `IT-T15i-02` Company A/B: B's tokens see none of A's statements, digests, subjects or verify ranges (404 or empty, never 403 that leaks existence). `IT-T15i-03` auditor role reads everything, a revoked membership gets 403, a non-member 403; verify writes one audit row with the request ID. Run each once in the sandbox.
- **Review:** one review subagent before the handoff (give it this prompt, `api.md` and the diff); ask it first: "which request lets tenant B learn anything about tenant A (existence, count, timing class, error detail), or returns a field that is not in `api.md`?".

## 4. Close-out
- Handoff under 80 lines: routes with one example response each (synthetic values), the `VerifyKeySource` seam and who fills it, Integration test impact (IT-T15i-01…03 blocking this merge and A15.11), what 15i2 adds, Effort.
- `TASK15.md` A15.9 🟡 (part 1); status board and registry rows. Bundle; PR via `git show <branch>:<handoff> | gh pr create … --body-file -`. Final reply in the AGENTS.md §12.4 shape; review request for Codex in a `text` block.

## Lessons so far
- **Task15f2 (Claude):** the review round found a must-fix in env wiring that unit tests could not see; budget it inside the estimate, and test with the real env path once.
- **Task15h (Claude):** read microsecond times as text, never through `Date`; convert bigint `seq` explicitly.
- **Task15f (Claude):** look for every value one party supplies that another must agree with (here: cursors and path parameters against the tenant).
- **Task5 / Task6 (Codex):** sensitive responses send `no-store` and safe codes; reads that reveal more than metadata are audited.
