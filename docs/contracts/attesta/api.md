# Evidence API (design, binding; built in A15.9)

Read-only routes for administrators and auditors. Conventions from SushiCorp AP-1 (catalog). Everything here is tenant-bound on the server (AGENTS.md rule 9); a client filter never replaces it.

## Conventions

| Rule | Value |
|---|---|
| Mount | `/api/attesta/*` (Supabase JWT + tenant middleware) |
| Roles | `tenant_admin`, `tenant_auditor` (the Task4 roles used by `security-findings/admin-read.ts`); everyone else 403 |
| Errors | RFC 7807 `application/problem+json` with a stable `code` from `errors.md`; 5xx details generic, the cause logged without raw values |
| Paging | keyset: `limit` 1..200 (default 50), opaque `cursor` (base64url of the last `(recorded_at, seq)`), `next_cursor` or `null`; one page per request |
| Request ID | `X-Request-ID` accepted (bounded token) or generated, echoed on every response, written to the audit log |
| Caching | `Cache-Control: no-store` on every response |
| Audit | every evidence-pack export and every verify is recorded (actor, tenant, scope, request ID); reads of the list are not |
| Content | statements as signed (the predicate already excludes raw content); never Task2 rows, never raw reveal |

## Routes

| Method and path | Returns |
|---|---|
| `GET /api/attesta/statements?repository_id=&kind=&subject_sha=&from=&to=&limit=&cursor=` | Pages of `{statement_digest, seq, recorded_at, statement_kind, predicate_type, repository_id, subject_sha, anchor_status}`. `from`/`to` filter `recorded_at`; `kind` ∈ the predicate kinds and `period_report` |
| `GET /api/attesta/statements/{statement_digest}` | `{record, statement (parsed), envelope, anchors[]}` for one statement; 404 `ATTESTA_API_NOT_FOUND` across tenants (never 403, so existence does not leak) |
| `GET /api/attesta/subjects/{repository_id}/{sha}` | Every statement about that commit, oldest first, with their `previous` links: the chain behind Q14 |
| `GET /api/attesta/verify?from_seq=&to_seq=` | The structured verify report, **version 2** (`verify-chain.ts` `ChainReport`): `{report_version: 2, ok, chain_intact, checked, breaks: [{seq, kind, detail_code}], signatures, anchors, …}` with the break kinds of `errors.md` (`ATTESTA_VERIFY_*`); never a bare boolean. Signatures are checked with the tenant's published keys and anchors with the trust-verified anchoring keys (Task15i2) |
| `POST /api/attesta/evidence-packs` (body: `{repository_id?, from, to, mode?}`; `mode` `full` (default) or `repository_only`; `Idempotency-Key` header `^[A-Za-z0-9._-]{8,64}$` required) | 202 with a job ID; the pack (statements, envelopes, chain segment with `canonical_record`s, Merkle proofs, anchors, public keys and the anchoring key, the verifier) is written to Task4's export sink and signed with the RP-1 pattern (a small statement naming the pack digest); format and rules in `evidence-pack.md` |
| `GET /api/attesta/evidence-packs/{id}` | Job status (`queued` · `running` · `ready` · `failed`), scope, counts, `pack_digest`, `error_code` and `retryable`, and when ready `content_path` |
| `GET /api/attesta/evidence-packs/{id}/content` | The pack and its signature as one `application/json` attachment `{pack, signature}` (`evidence-pack.md`), `no-store`, audited; 404 until ready and for another tenant's id |
| `POST /api/attesta/period-reports` (body: `{repository_id, from, to}`) | 202; builds and signs a `period_report` statement (`period-report.md`) |

`POST` routes are the only writes; they are idempotent on `(tenant, scope, Idempotency-Key header)`. A `period_report` or pack for a range whose records are not yet anchored is still produced and says so (`anchor_status: pending` per record); it is never presented as fully anchored.

*Added 2026-10-13 (Task15i2): the content route, `mode`, report version 2. Evidence-pack routes need the `attesta.export` action (`tenant_admin`, `tenant_auditor`). The same `Idempotency-Key` with the same scope and mode returns the same job (202); with another scope or mode it is 409 `ATTESTA_API_CONFLICT`.*
