# Evidence pack v1 (frozen when merged; additive changes only)

Written 2026-10-13 by Claude (Task15i2-attesta-evidence-packs, A15.9 part 2). Founder decisions 2026-10-13: both modes ship, `full` is the default, no per-repository Merkle commitment in phase 1. Schema: `evidence-pack-v1.schema.json` (normative for shapes; this file for rules). Built by `apps/api/src/features/attesta/evidence-pack-service.ts`; checked independently by the A15.10 offline verifier.

**What it is for:** an administrator or auditor exports one file that a third party (an acquirer's counsel, an external auditor) checks on a laptop with no TrackAI account: every statement in a period, the chain segment around it, the anchors that date it, the public keys and trust documents that authenticate it, and one signature saying who exported it and when.

## The two files of a download

`GET /api/attesta/evidence-packs/{id}/content` returns `{"pack": <pack>, "signature": <envelope>}`:

| Part | Bytes | Meaning |
|---|---|---|
| `pack` | the RFC 8785 (JCS) bytes stored in the export sink | everything below; `pack_digest` = `"sha256:" + hex(SHA-256(JCS(pack)))` (a verifier re-canonicalizes the parsed `pack`; JCS is idempotent) |
| `signature` | a DSSE envelope (`envelope.md` rules) | payload type `application/vnd.trackai.evidence-pack+json`, payload = JCS of `{"manifest": <the pack's manifest>, "pack_digest": <pack_digest>}`, signed with the tenant's **active `statement` key** (the key the latest published key set lists active) |

The pack signature is **not chained** and not anchored in phase 1: everything inside the pack is already chained and anchored; the signature says only *who* exported *what*, *when*. Its payload type differs from statements' (`application/vnd.in-toto+json`), so DSSE's PAE keeps a pack signature from ever passing as a statement and the reverse. A verifier checks it with the trust layer (`trust.md`): purpose `statement`, audience the pack's `tenant_id`, `signedAt` = `manifest.generated_at`, and the pack's own `trust` documents.

## The pack (top-level keys, all required, no others)

| Key | Content |
|---|---|
| `manifest` | below |
| `records` | the tenant's chain segment `chain_range.from_seq..to_seq`, seq ascending, every seq exactly once |
| `statements` | the in-scope statements, seq ascending: `{seq, statement_digest, statement_canonical, envelope, anchor_status}` |
| `anchors` | the stored `anchored` rows of in-scope records, ordered by (seq, anchor_type): `{seq, anchor_type, batch_id, inclusion_proof, rekor_entry_uuid, tsa_token_b64}` (`tables.md` EV-2 v1 shapes, unchanged) |
| `anchor_batches` | every batch an `anchors` row names, by `seq_from`: `{batch_id, seq_from, seq_to, leaf_count, merkle_root}` |
| `trust` | `{root_documents, keyset_documents, anchoring_keys, rekor_log_key_spki_b64, rekor_log_index_offsets, tsa_anchors_der_b64}`, all public (below) |
| `verification_hint` | `{pinned_root_keyids}`: the root keyids this deployment pins |
| `reports` | `[]` in v1 (reserved: Task15i3 adds the period-report documents a pack carries) |
| `verifier` | `null` in v1 (reserved for A15.10) |

### `manifest`

| Field | Meaning |
|---|---|
| `format` | `https://trackai.dev/attesta/evidence-pack/v1` |
| `pack_id` | the export job's UUID |
| `tenant_id` | the tenant whose chain this is (lowercase UUID) |
| `scope` | `{repository_id: <uuid> \| null, from, to, mode}`: `from`/`to` are RFC 3339 UTC with milliseconds and `Z`, inclusive, compared with each record's `recorded_at`; `mode` is `full` or `repository_only` |
| `chain_range` | `{from_seq, to_seq, prev_hash, head}`: `prev_hash` = `record_hash` of `from_seq − 1` (the genesis hash at `from_seq` 0); `head` = `{next_seq, head_hash}` of the tenant's `chain_head` when the segment reaches it, else `null`. An empty chain is `from_seq 0, to_seq −1` with no records |
| `generated_at` | the database clock at the start of the read transaction (RFC 3339 UTC, ms) |
| `completeness` | `provable` (mode `full`) or `not_provable` (mode `repository_only`) |
| `counts` | `{records, statements, redacted_records, anchored, pending, anchor_rows, anchor_batches}` (integers ≥ 0; `pending` = `statements − anchored`) |
| `sections` | `{records, statements, anchors, anchor_batches, trust, verification_hint, reports, verifier}`: each `"sha256:" + hex(SHA-256(JCS(section value)))` |

## Which records, and why that proves completeness

`recorded_at` never goes backwards along the chain (`tables.md`), so the records of a time window are one contiguous run of `seq`. The segment is that run **plus one boundary record on each side**:

- `from_seq` = the last seq whose `recorded_at` < `from`, or 0 when there is none;
- `to_seq` = the first seq whose `recorded_at` > `to`, or the head's last seq when there is none (then `chain_range.head` is set).

A record is **in the window** when `from ≤ recorded_at ≤ to`, and **in scope** when it is in the window and (`repository_id` is null or equals the record's `repository_id`). `statements` holds exactly the in-scope records.

`to` must be at least 5 minutes before `generated_at` (a writer stamps `recorded_at` with its own clock just before it commits; the margin covers that and clock skew). A request with a later `to` is refused (400).

### Modes (record redaction)

| Mode | In-scope records | Other records in the segment | `completeness` |
|---|---|---|---|
| `full` (default) | `{seq, prev_hash, record_hash, canonical_record}` | the same: their `canonical_record` shows repository UUIDs, subject shas, kinds and statement digests of other repositories (never their statements) | `provable` |
| `repository_only` | `{seq, prev_hash, record_hash, canonical_record}` | `{seq, prev_hash, record_hash}` only | `not_provable`: the links still verify, but nobody can tell a redacted record is not about the scoped repository; the verifier reports that claim as not checkable (exit 2), never as passed |

Use `full` for the tenant itself and its own auditors; `repository_only` for outsiders scoped to one repository. A per-repository proof would need a per-repository Merkle commitment inside each ledger record (a new record format); not in phase 1.

## Bounds and honesty

- At most **50 000 records** in the segment (so at most 50 000 statements); a larger request is 400 `ATTESTA_API_INVALID_QUERY`, checked at request time and again at build time.
- `anchor_status` per statement is `anchored` when the record had an `anchored` row of both types (rekor and tsa) when the pack was read, else `pending`. A pending record is never presented as anchored; `counts.pending` says how many. Whether a pending record is late (beyond the anchoring window, `ATTESTA_VERIFY_ANCHOR_MISSING`) is the verifier's judgement against `generated_at`.
- Built only from stored bytes and the database clock: the same scope and chain state give packs that differ only in `pack_id` and `generated_at` (and the section digests and signature that cover them).
- Never in a pack: raw content, repository URLs, paths, emails, names, `credential_id` or any credential reference, Task2 rows. Statements carry what the predicate allows (`README.md`).

## `trust` (all public)

| Field | Content |
|---|---|
| `root_documents` | every stored root document (DSSE envelopes, `trust.md`), version 1 first |
| `keyset_documents` | the tenant's key sets **from version 1**, so the full key history verifies (`trust.md` "Consumers") |
| `anchoring_keys` | `[{keyid, spki_der_b64, root_entry}]`: every anchoring key the verify material names; `root_entry` is that key's entry in the newest root document (status, validity, revocation), or `null` for a development key no root lists |
| `rekor_log_key_spki_b64` | the pinned Rekor log key (SPKI DER, base64), or `null` when anchoring is not configured |
| `rekor_log_index_offsets` | `{"<decimal tree id>": <offset>}` or `null` |
| `tsa_anchors_der_b64` | the TSA trust-anchor certificates (DER, base64); `[]` when not configured |

## `verification_hint` is not trust

`verification_hint.pinned_root_keyids` tells a verifier which root the exporter expected. It is **inside the pack and therefore attacker-controlled**: a forged pack would carry a forged hint and a forged root. A verifier **must take its pin from the user** (a value published out of band, or a customer pin, `trust.md` "Customer pins") and only report whether the hint agrees. The same holds for every unsigned claim in the pack: the manifest is covered by the signature, but the signature is only as good as the key the user's pin leads to.

## What a verifier checks (A15.10 copies this list)

1. `signature`: payload type; payload is the JCS of `{manifest, pack_digest}`; `manifest` equals the pack's; `pack_digest` equals the recomputed digest; the signature verifies with `verifyTrusted` (purpose `statement`, audience `tenant_id`, `signedAt` `generated_at`, root pinned **by the user**).
2. Every `sections` digest matches; top-level keys and `format` are exactly v1's.
3. `records`: seq contiguous `from_seq..to_seq`; the first `prev_hash` = `chain_range.prev_hash` (genesis at 0); each `prev_hash` = the previous `record_hash`; where `canonical_record` is present, `record_hash` = `"sha256:" + hex(SHA-256(canonical_record ‖ prev_hash))`, the bytes are their own JCS form, and its `seq`, `prev_hash` and `tenant_id` agree; with `head` set, `head.head_hash` = the last `record_hash` and `head.next_seq` = `to_seq + 1`.
4. Window (mode `full`): the first record is seq 0 or has `recorded_at` < `from`; the last has `recorded_at` > `to` or `head` is set; `to` ≤ `generated_at` − 5 min; `statements` lists exactly the in-scope records (by seq and `statement_digest`). Mode `repository_only`: report completeness not checkable.
5. Each statement: `statement_digest` = SHA-256 of `statement_canonical` and equals its record's; the envelope payload is those bytes; the envelope verifies with a key of the tenant's key sets via `verifyTrusted`, passing the record's anchor time as `timeEvidence` (`binds: ledger_statement`) for retired or revoked keys; then `envelope.md` "Verifier steps".
6. Anchors: each row's Merkle path from the 32 raw bytes of its record's `record_hash` (RFC 6962, `leaf_index = seq − seq_from`, `tree_size = leaf_count`) reaches its batch's `merkle_root`; the Rekor entry and TSA token verify offline with `trust` material (`anchor-dual.ts` `verifyStoredAnchor`); a Rekor anchor's `integratedTime` lies inside its anchoring key's window from `root_entry`.
7. Exit codes: 0 all checked and passed; 1 a break; 2 something not checkable (a pending anchor beyond the window is a break; inside it, a warning).

## Routes and jobs (`api.md`)

`POST /api/attesta/evidence-packs` (202, idempotent on `Idempotency-Key` + scope), `GET /api/attesta/evidence-packs/{id}`, `GET /api/attesta/evidence-packs/{id}/content`. A job moves `queued` → `running` → `ready` | `failed`, never back. A failed job is final: its `error_code` says whether a new request (with a new `Idempotency-Key`) can succeed as it is (`retryable: true`: `ATTESTA_SIGNER_UNAVAILABLE`, for example between a key's `activate` and the next `publish`; `ATTESTA_API_UNAVAILABLE`; `ATTESTA_API_INTERNAL`).

## Provenance

Ported from SushiCorp @ `0bd67a5` (catalog EV-2, RP-1): `services/anchoring/export.py` (records with their exact hashed bytes, the predecessor hash, the head when the range reaches it, per-batch anchor evidence) and `services/reporting/signing.py` (sign a small statement naming the digest, never the document). **Deviations:** one canonical JSON document instead of SushiCorp's export layout; DSSE instead of a JCS signature; the trust documents travel inside the pack (SushiCorp left keys to the auditor), with the pin still the user's; boundary records and two modes for per-repository completeness (SushiCorp exported whole ranges only).
