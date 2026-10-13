# Ledger and anchor tables (design, binding; built in A15.3 ledger and A15.5 anchoring)

Ported from SushiCorp EV-1 and EV-2 @ `0bd67a5` (`db/migrations/versions/0001_initial_schema.py`; handoffs B3, A2b). Invariants are `TASK15.md` §6 and AGENTS.md §9 items 16–21. Column lists are the minimum; A15.3/A15.5 may add columns but not weaken an invariant. Every table: `tenant_id` via `tenantIdColumn()`, `(tenant_id, id)` unique, composite tenant foreign keys, RLS enabled with no browser policies, access through `withTenant()`, a Company A/B test.

## `chain_head`: one row per tenant

| Column | Notes |
|---|---|
| `tenant_id` | PK, FK `sso_tenants` |
| `next_seq` | bigint ≥ 0; the seq the next record must take |
| `head_hash` | `sha256:<64 hex>`; genesis `GENESIS_PREV_HASH` (`canonical.ts`) |
| `updated_at` | |

Guard trigger (`SECURITY DEFINER`, fixed `search_path`): a new head starts at seq 0 with the genesis hash; `next_seq` advances by exactly 1, only to the `record_hash` of the record at that seq; `tenant_id` is immutable; no DELETE or TRUNCATE.

## `attesta_records`: the hash chain (append-only)

| Column | Notes |
|---|---|
| `id`, `tenant_id` | |
| `seq` | bigint, gap-free per tenant, allocated from `chain_head` under `SELECT … FOR UPDATE`, never a sequence. `pg` returns bigint as a string: convert explicitly |
| `prev_hash` | `sha256:<hex>`, the previous record's `record_hash` (genesis for seq 0) |
| `recorded_at` | stamped inside the chain lock, `toISOString()` form, never earlier than the previous record's |
| `record_kind` | `statement` (v1); `period_report` statements are `statement` records too (their predicate type differs) |
| `statement_digest` | `sha256:<hex>` of `statement_canonical`; **unique per tenant** (the dedup key, `envelope.md`) |
| `predicate_type`, `statement_kind`, `repository_id`, `subject_sha` | typed copies for queries; a guard checks they agree with `statement_canonical`. `statement_kind` and `subject_sha` are null for a `period_report` (its subject is a report digest) |
| `statement_canonical` | the exact RFC 8785 statement bytes that were signed (text, UTF-8) |
| `canonical_record` | the exact RFC 8785 bytes of the ledger record `{seq, prev_hash, recorded_at, tenant_id, record_kind, statement_digest, predicate_type, statement_kind, repository_id, subject_sha, outbox_subject_id}` |
| `record_hash` | `computeRecordHash(canonical_record, prev_hash)` = `"sha256:" + hex(SHA-256(canonical_record ‖ prev_hash))` (EV-1 rule) |
| `outbox_subject_id` | `attesta_subjects.id` it came from (null for `period_report`); **unique per tenant where not null**, so one outbox row yields at most one chained statement however often it is retried |

The ledger transaction also marks the outbox row `done` against its claim and re-checks `previous` under the chain lock (`envelope.md` step 7).

Guards: insert only at `chain_head.next_seq` with `prev_hash = head_hash`; `record_hash` must match the stored bytes; `statement_digest` must match `statement_canonical`; a deferred constraint trigger refuses COMMIT if the head was not advanced past the record; UPDATE, DELETE and TRUNCATE raise. Verification reads the stored bytes and never re-serializes.

## `attesta_envelopes`: the signed DSSE envelope (append-only)

| Column | Notes |
|---|---|
| `id`, `tenant_id`, `record_id` | composite FK `(tenant_id, record_id)` → `attesta_records`; **one envelope per record** |
| `payload_type` | `application/vnd.in-toto+json` |
| `keyid` | `sha256:<hex>` of the signing key's SPKI DER |
| `credential_id` | the signer credential (internal; never published in the envelope) |
| `signature_der` | bytea |
| `envelope` | the JSON envelope as returned to auditors |

Guard: the decoded envelope payload equals the record's `statement_canonical` byte for byte. The envelope is stored in the same transaction as its record (no signing inside the lock: the signature is obtained first, `envelope.md` step 6).

## `attesta_anchor_batches` and `attesta_anchors` (append-only; A15.5)

| Table | Columns (minimum) |
|---|---|
| `attesta_anchor_batches` | `id`, `tenant_id`, `batch_id` = `"<tenant_id>:<seq_from>-<seq_to>"` (unique, deterministic so a retry re-forms the same root), `seq_from`, `seq_to`, `merkle_root` (`sha256:<hex>`), `leaf_count`, `created_at` |
| `attesta_anchors` | `id`, `tenant_id`, `batch_id` FK, `record_id` FK, `anchor_type` (`rekor` · `tsa`), `status` (`anchored` · `failed`), `inclusion_proof` (EV-2 v1 JSON: `{version: 1, merkle: {leaf_index, tree_size, path[hex]}, anchor: {type, ref, log_index, proof_b64, rekor_entry}}`), `rekor_entry_uuid`, `tsa_token_b64`, `error_code`, `created_at` |

Per-kind `inclusion_proof` shape (fixed; added 2026-10-13 from Task15f, additive): `rekor` → `anchor: {type, ref, log_index, proof_b64, rekor_entry}`; `tsa` → `anchor: {type, ref, log_index: null, proof_b64: null, rekor_entry: null, gen_time, serial_number, policy, revocation: {status, reason}}` with the token in `tsa_token_b64`. A missing required key, a key from the other kind or an extra key is `ATTESTA_VERIFY_ANCHOR_INVALID` (`anchor-dual.ts` `verifyStoredAnchor`). TSA revocation stored as `clean` is never re-asserted offline: offline it is `unknown` / `not_rechecked_offline`.

Rules: Merkle leaves are the **32 raw bytes** of each `record_hash` (RFC 6962, `merkle.ts`); only the root leaves the tenant. One row per attempt; no row means pending; a partial unique index allows one `anchored` row per record and anchor type; `anchored` requires a proof, `failed` an `error_code`. **Anchoring never changes `record_hash`** and never touches `attesta_records`. Plan (read) → submit (network, no transaction) → record (write). An unreachable log is never a pass; the Rekor log key is pinned in production; dual mode (Rekor + TSA) is all-or-nothing.

## `attesta_anchor_resumes`: operator resume of a stopped batch (append-only; Task15i3)

| Column | Notes |
|---|---|
| `id`, `tenant_id` | |
| `batch_id` | composite FK `(tenant_id, batch_id)` → `attesta_anchor_batches` |
| `actor` | the operator's name (1–128) |
| `reason` | 1–256 characters, why the stop is lifted |
| `request_id` | the CLI run's request ID, also in the `security_audit_events` row (`attesta.anchor.resume`); unique per tenant |
| `created_at` | set by the guard to the database's `clock_timestamp()`, so it is later than the failure it lifts |

Guards (ERRCODE `ATG01`): (1) as the caller (`SECURITY INVOKER`, so RLS applies), the batch must be visible, so a foreign batch is refused like an unknown one; (2) `SECURITY DEFINER`, fixed `search_path`, READ COMMITTED only, per-batch lock: the batch is stopped by the resume rule below (a terminal code of `errors.md` §Anchoring newer than its latest resume) and not anchored in both types for every record, so one resume lifts one stop; (3) at commit, the `attesta.anchor.resume` audit row with the same tenant, batch and `request_id` exists. No UPDATE, DELETE or TRUNCATE. RLS on, no browser policies.

**Resume rule (lead-approved 2026-10-13):** a batch is stopped only while its latest terminal failure is newer than its latest resume row. A resumed batch is retried with the normal backoff (failed attempts so far); a new terminal failure stops it again and needs a new resume. Applied by the audited CLI `attesta:anchor-resume` only (dry run by default; `--confirm=RESUME` writes the resume row and the audit row in one transaction); there is no route.

## Not in these tables

No raw content, no repository URL, no file path, no email. The statement bytes hold only what the predicate schema allows.
