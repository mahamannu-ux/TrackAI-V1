# Signed audit export, version 1 (A16.7; frozen when merged, additive changes only)

Written 2026-10-15 by Claude (Task16e-audit-tamper). Schema: `export-v1.schema.json` (normative for shapes; this file for rules). Built by `apps/api/src/features/audit/export-service.ts`. The offline verifier for this format is Task16f2: the steps below are what it implements.

**What it is for:** an auditor takes one file away that proves, with no TrackAI account, which audit events a tenant recorded in a period, that none was removed or changed after it was sealed, and who exported it and when.

## Routes (`/api/audit`, guard `audit.read`: admins and auditors)

| Route | Answer |
|---|---|
| `POST /exports` (body `{from, to}`, RFC 3339; `Idempotency-Key` header `^[A-Za-z0-9._-]{8,64}$` required) | 202 `{id, status, replayed}`. The same key with the same scope replays the job; with another scope it is 409 `AUDIT_EXPORT_CONFLICT`. `from` < `to` ≤ now, at most **366 days** apart (founder 2026-10-15), else 400 `AUDIT_FILTER_INVALID`. At most 4 open jobs per tenant (429 `AUDIT_RATE_LIMITED`). Audited: `audit.export.requested` |
| `GET /exports/{id}` | the job: `{id, status, scope, counts, export_digest, error_code, created_at, finished_at, content_path}` |
| `GET /exports/{id}/content` | `{"export": <stored bytes>, "signature": <DSSE envelope>}` as an attachment, `no-store`. Audited: `audit.export.downloaded` |

Another tenant's id and an unknown id give the same 404 `AUDIT_EXPORT_NOT_FOUND`. A job moves `queued` → `running` → `ready` | `failed` (table `audit_exports`, migration 0023, the evidence-pack job pattern and the Task4 export sink). A failed job's `error_code` is one of `AUDIT_EXPORT_TOO_LARGE` (more than 200 000 events), `AUDIT_EXPORT_SIGNER_NO_CREDENTIAL`, `AUDIT_EXPORT_SIGNER_UNAVAILABLE` (retryable), `AUDIT_EXPORT_UNAVAILABLE` (sink or trust material; retryable), `AUDIT_EXPORT_INTERNAL` (retryable).

## The export (RFC 8785 bytes; top-level keys exactly these)

| Key | Content |
|---|---|
| `manifest` | below |
| `events` | every row of the tenant with `covered.from` ≤ `occurred_at` < `covered.to` (below), in (`occurred_at`, `id`) order, as stored: `{id, action, actor_type, actor_id, target_type, target_id, details, occurred_at}` (`occurred_at` the exact microsecond text; no derived fields) |
| `seals` | every audit seal whose window overlaps `[from, to)`, in window order: `{seq, seal_digest, document}`, `document` = the exact stored seal document text (`attesta/audit-seal.md`) |
| `seal_evidence` | `{records, statements, anchors, anchor_batches, trust}` for the seal records only, each entry in the exact `evidence-pack-v1` section shape: `records` `{seq, prev_hash, record_hash, canonical_record}`; `statements` `{seq, statement_digest, statement_canonical, envelope, anchor_status}`; `anchors`, `anchor_batches` and `trust` as in a pack |

### `manifest`

| Field | Meaning |
|---|---|
| `format` | `https://trackai.dev/audit/export/v1` |
| `export_id` | the job's UUID |
| `tenant_id` | the tenant |
| `scope` | `{from, to}`: RFC 3339 UTC with milliseconds, half-open, as requested |
| `covered` | `{from, to}`: the exact microsecond text of `scope` widened to the whole windows of the listed seals (the earlier `from`, the later `to`), so every listed seal can be checked row by row |
| `generated_at` | the database clock at the start of the read (RFC 3339 UTC, ms) |
| `catalog_version` | `AUDIT_CATALOG_VERSION` of the exporter |
| `counts` | `{events, seals, sealed_events, unsealed_events, anchored, pending}`: `sealed_events` are events inside some listed seal's window, `unsealed_events` the rest (not sealed yet: never "verified"); `anchored`/`pending` count the seal statements |
| `sections` | `{events, seals, seal_evidence}`: each `"sha256:" + hex(SHA-256(JCS(section value)))` |

`export_digest` = `"sha256:" + hex(SHA-256(JCS(export)))`.

## The signature

A DSSE envelope (`attesta/envelope.md` rules), payload type `application/vnd.trackai.audit-export+json` (distinct from statements and evidence packs, so PAE keeps one from passing as another), payload = JCS of `{"manifest": <manifest>, "export_digest": <export_digest>}`, signed with the tenant's **active `statement` key** (the newest key set's). Not chained and not anchored: every seal inside is already chained and anchored; the signature says only who exported what, when (the evidence-pack rule).

## Completeness

Completeness comes from the seals, not from the whole chain: seals are contiguous (each `previous` is the prior seal's digest and its `window.from` the prior `window.to`), so a verifier can tell that every event in a sealed window is present and unchanged. Events after the last listed seal's `to` are counted as `unsealed_events` and are never presented as verified.

## What a verifier checks (Task16f2 implements this list)

1. **Trust:** root documents from the **user's** pin, the tenant's key sets from version 1 (`attesta/trust.md`, `evidence-pack.md` step 1), using `seal_evidence.trust`.
2. **Signature:** payload type exact; the payload is the JCS of `{manifest, export_digest}`; its `manifest` equals the export's; `export_digest` equals the recomputed digest; the envelope verifies with `verifyTrusted` (purpose `statement`, audience `tenant_id`, `signedAt` `generated_at`).
3. **Shape:** top-level keys and `format` exactly v1; each `sections` digest matches; `counts` recompute from the content; events sorted by (`occurred_at`, `id`) with unique ids; `covered` contains `scope` and equals it widened to the listed seals' windows.
4. **Seals:** for each seal, SHA-256 of `document` = `seal_digest`; the document validates against `attesta/audit-seal-document-v1.schema.json`, its `tenant_id` is the manifest's and its `rows_root` and `count` recompute; seals in window order with no overlap; each seal after the first has `previous` = the prior listed seal's digest and `window.from` = its `window.to`.
5. **Seal evidence:** each seal has exactly one statement and record with that `seq`; the statement is an `audit_seal` statement valid against `attesta/predicate-audit-seal-v1.schema.json` whose subject digest is the seal digest and whose predicate matches the document (`audit-seal.md` AS1–AS2); `statement_digest` hashes `statement_canonical`; the record's `canonical_record` hashes with its `prev_hash` to `record_hash` and names that `statement_digest`, `seq` and `tenant_id`, with `repository_id`, `statement_kind`, `subject_sha` null; the envelope verifies like a pack statement (`evidence-pack.md` step 6, the record's anchor time as `timeEvidence`); anchors as `evidence-pack.md` step 7. The records are **not** a contiguous chain segment, so links between them are not checked (their own Merkle paths are).
6. **Events against seals:** every event lies in `covered`; for every listed seal, the events inside its window are exactly its `rows` (same ids, in order) and each `"sha256:" + hex(SHA-256(JCS(event)))` equals that id's digest. A difference is a break: `missing_row`, `changed_row` or `unsealed_row_in_sealed_window` (the verify report's kinds).
7. **Exit codes:** 0 all checked and passed; 1 a break; 2 something not checkable (for example a pending anchor). Unsealed events are reported, never a pass and never a break.
