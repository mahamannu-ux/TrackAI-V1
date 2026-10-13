# Error codes (frozen; additive)

Stable codes for logs, `attesta_subjects.last_error_code`, verify reports and RFC 7807 `code`. Format `^ATTESTA_[A-Z0-9_]{1,64}$`. A code is never renamed or reused; new codes are added here first. Messages never contain raw values (AGENTS.md §10).

"Retry" means the worker returns the outbox row to `pending` with backoff; "terminal" means `failed`.

## Outbox writer (`outbox.ts`, Task15c)

| Code | When | Retry |
|---|---|---|
| `ATTESTA_OUTBOX_INVALID_INPUT` | input fails validation (bad UUID or sha, wrong-kind or extra field, non-success deployment) | caller bug: terminal |
| `ATTESTA_OUTBOX_SOURCE_NOT_FOUND` | a source row is missing in this tenant or disagrees with the pointer | caller bug or cross-tenant attempt: terminal |
| `ATTESTA_OUTBOX_IDEMPOTENCY_CONFLICT` | the key exists with a different pointer | terminal; investigate |

## Builder (A15.8)

| Code | When | Retry |
|---|---|---|
| `ATTESTA_BUILDER_SOURCE_NOT_READY` | a source row the kind needs is not visible yet | retry |
| `ATTESTA_BUILDER_SOURCE_MISSING` | a source row is gone (reset, retention) | terminal |
| `ATTESTA_BUILDER_NOT_CANONICAL` | `canonicalize()` refused the statement (unsafe number, NaN, sparse array) | terminal (builder bug) |
| `ATTESTA_BUILDER_SCHEMA_INVALID` | the snapshot fails the schema | terminal (builder bug) |
| `ATTESTA_BUILDER_RULE_VIOLATION` | the snapshot breaks S1–S12 | terminal (builder bug or inconsistent sources) |
| `ATTESTA_BUILDER_TOO_LARGE` | does not fit the signer's payload limit even with no file entries | terminal |

## Signer (Task15b contract mapping)

| Code | From | Retry |
|---|---|---|
| `ATTESTA_SIGNER_UNAVAILABLE` | `SigningUnavailable` (network, timeout, rate limit, KMS down, adapter contract violation) | retry |
| `ATTESTA_SIGNER_REJECTED` | `SigningRejected` (unknown, expired, revoked or other-tenant credential; malformed payload; an answer that does not verify) | terminal; never retried with the same credential |
| `ATTESTA_SIGNER_NO_CREDENTIAL` | the tenant has no active signing credential | terminal until configured |

## Ledger (A15.3)

| Code | When | Retry |
|---|---|---|
| `ATTESTA_LEDGER_DUPLICATE_STATEMENT` | the statement digest is already chained (the row is marked `done`, not an error to the customer) | n/a |
| `ATTESTA_LEDGER_HEAD_CONFLICT` | a guard refused the insert (head moved) | retry |
| `ATTESTA_LEDGER_PREVIOUS_STALE` | a statement about the same subject was chained after the build read `previous` | retry (rebuild) |
| `ATTESTA_LEDGER_CLAIM_LOST` | the outbox row is no longer claimed by this attempt (lease expired, another worker took it) | stop; the current claimant continues |
| `ATTESTA_LEDGER_GUARD_VIOLATION` | any other chain guard (hash mismatch, mutation attempt) | terminal; alert |
| `ATTESTA_LEDGER_INVALID_INPUT` | `chainStatement` input fails validation (non-canonical bytes, envelope over other bytes, keyid not matching the key, typed values not derived from the statement) | terminal (builder bug) |  <!-- added 2026-10-12, founder decision in Task15d -->

## Anchoring (A15.5)

| Code | When | Retry |
|---|---|---|
| `ATTESTA_ANCHOR_LOG_UNAVAILABLE` | Rekor unreachable or timed out (never a pass) | retry |
| `ATTESTA_ANCHOR_LOG_PROOF_INVALID` | inclusion proof, checkpoint, SET or entry binding does not verify | retry, then alert |
| `ATTESTA_ANCHOR_TSA_UNAVAILABLE` | TSA unreachable | retry |
| `ATTESTA_ANCHOR_TSA_TOKEN_INVALID` | imprint, nonce, ESS, signature, chain or EKU fails | retry, then alert |
| `ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED` | production without a pinned log key | terminal (configuration) |
| `ATTESTA_ANCHOR_LOG_REJECTED` | the log refused the submission (HTTP 400/422): a malformed entry, never a network fault | terminal; alert |  <!-- added 2026-10-13, founder decision in Task15f -->

## Verification (verify report break kinds; A15.3, A15.9, A15.10)

| Code | Break |
|---|---|
| `ATTESTA_VERIFY_SEQ_GAP` | a missing `seq` |
| `ATTESTA_VERIFY_PREV_HASH_MISMATCH` | `prev_hash` is not the previous `record_hash` |
| `ATTESTA_VERIFY_RECORD_HASH_MISMATCH` | `record_hash` does not match the stored bytes |
| `ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH` | statement digest does not match the stored statement bytes |
| `ATTESTA_VERIFY_NOT_CANONICAL` | payload bytes are not their own RFC 8785 form |
| `ATTESTA_VERIFY_SIGNATURE_INVALID` | DSSE signature does not verify with the key named by `keyid` |
| `ATTESTA_VERIFY_KEY_UNKNOWN` | no published key matches `keyid` |
| `ATTESTA_VERIFY_SCHEMA_INVALID` | statement fails its predicate version's schema |
| `ATTESTA_VERIFY_RULE_VIOLATION` | statement breaks S1–S12 |
| `ATTESTA_VERIFY_MERKLE_PROOF_INVALID` | inclusion path does not reach the batch root |
| `ATTESTA_VERIFY_ANCHOR_MISSING` | a record older than the anchoring window has no anchor |
| `ATTESTA_VERIFY_ANCHOR_INVALID` | Rekor entry or TSA token does not verify offline |
| `ATTESTA_VERIFY_NOT_CHECKABLE` | the material needed is absent (verifier exit code 2, never 0) |
| `ATTESTA_VERIFY_SEQ_MISMATCH` | a record's `seq` differs from the `seq` in its hashed record bytes |
| `ATTESTA_VERIFY_FIELD_MISMATCH` | a typed column differs from its hashed record bytes |
| `ATTESTA_VERIFY_TENANT_MISMATCH` | a record names another tenant |
| `ATTESTA_VERIFY_OUT_OF_ORDER` | `recorded_at` goes backwards |
| `ATTESTA_VERIFY_DUPLICATE_SEQ` | two records share one `seq` |
| `ATTESTA_VERIFY_HEAD_MISMATCH` | `chain_head` does not point at the last record |
| `ATTESTA_VERIFY_BEYOND_HEAD` | a record exists at or past `chain_head.next_seq` |
| `ATTESTA_VERIFY_ENVELOPE_MISSING` | a record has no envelope |
| `ATTESTA_VERIFY_ENVELOPE_PAYLOAD_MISMATCH` | the envelope payload is not the record's statement bytes |
| `ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED` | no published keys were supplied, so signatures were not checked (the report is never `ok`) |
| `ATTESTA_VERIFY_KEY_NOT_VALID_AT` | the signature verifies, but its key was not valid for this record (`trust.md` step 8): `recorded_at` outside `[not_before, not_after]`, or the key retired, revoked or past `not_after` and no verified anchor of the record inside the key's validity and before `revoked_at` (`compromised_since` for a compromised key) |  <!-- added 2026-10-13, Task15i3 -->

*Added 2026-10-12 (founder decision in Task15d): one exact code per break kind of `verify-chain.ts`; earlier codes are unchanged. Task15f switches `BREAK_DETAIL_CODES` to these.*

*Added 2026-10-13 (Task15i3, lead-approved): `ATTESTA_VERIFY_KEY_NOT_VALID_AT` (break kind `key_not_valid_at`). When a key's window cannot be checked (no anchor material, or only anchors the verifier cannot check), the report carries the warning `key_windows_not_checked` instead and is never `ok`.*

## Trust (A15.12)

`verifyTrusted` (`trust.md`, `trust-contract.ts`) returns exactly one of these codes; each maps to exactly one status. Evidence of tampering is `rejected`; absent trust information is `unavailable`, never `verified`.

| Code | Status | When |
|---|---|---|
| `ATTESTA_TRUST_VERIFIED` | verified | every check passed (not an error) |
| `ATTESTA_TRUST_ROOT_NOT_PINNED` | unavailable | no pinned root keyid (production), and outside production no `allowUnpinnedRoot` |
| `ATTESTA_TRUST_DOCUMENT_UNAVAILABLE` | unavailable | no root document held, none of them lists the pinned keys, the last trusted document is not held, a key-set chain without a last trusted document does not start at version 1, or a gap in the versions |
| `ATTESTA_TRUST_DOCUMENT_EXPIRED` | unavailable | the newest root document or key set is past `expires` + skew |
| `ATTESTA_TRUST_DOCUMENT_FROM_FUTURE` | unavailable | a document's `issued_at` is after `now` + skew |
| `ATTESTA_TRUST_REVOCATION_UNKNOWN` | unavailable | no key set held for the tenant, so its keys' status is unknown |
| `ATTESTA_TRUST_CLOCK_BEHIND` | unavailable | `now` is more than the skew behind the persisted `trustedTimeFloor` |
| `ATTESTA_TRUST_DOCUMENT_MALFORMED` | rejected | a document breaks the schema or trust.md's document rules (including its maximum lifetime), or exceeds a bound |
| `ATTESTA_TRUST_DOCUMENT_SIGNATURE_INVALID` | rejected | a key set is not signed by a valid `tenant_keyset` key of the current root |
| `ATTESTA_TRUST_THRESHOLD_NOT_MET` | rejected | a root document lacks k valid signatures of the previous root or of its own root keys, or the start document lists the pinned keys but lacks their signatures |
| `ATTESTA_TRUST_DOCUMENT_CONFLICT` | rejected | two different documents claim one scope and version (including the last trusted one), or a document's `previous` is not the one before it |
| `ATTESTA_TRUST_ROLLBACK` | rejected | every held document of the scope is older than the last trusted one |
| `ATTESTA_TRUST_KEYSET_REGRESSION` | rejected | a newer document drops a key or moves a key's status, validity or revocation backwards |
| `ATTESTA_TRUST_KEY_UNKNOWN` | rejected | the signing keyid is not listed (or not pinned) for the audience |
| `ATTESTA_TRUST_PURPOSE_MISMATCH` | rejected | the key is listed for another purpose |
| `ATTESTA_TRUST_AUDIENCE_MISMATCH` | rejected | the key belongs to another tenant |
| `ATTESTA_TRUST_KEY_NOT_VALID_AT` | rejected | `signedAt` outside `[not_before, not_after]` or after `now` + skew; a retired key, or an active key outside its validity at `now`, without bound time evidence inside its validity (and before a retired key's `revoked_at`) |
| `ATTESTA_TRUST_KEY_REVOKED` | rejected | revoked `superseded` without bound time evidence before `revoked_at`; revoked `compromised` without bound time evidence before `compromised_since` |
| `ATTESTA_TRUST_SIGNATURE_INVALID` | rejected | the artifact signature does not verify with the listed key |
| `ATTESTA_TRUST_INPUT_INVALID` | rejected | the call itself is malformed (payload not the envelope's, signature count, purpose, audience, timestamps, `timeEvidence` shape, bounds) |

*Added 2026-10-13 (lead-approved contract PR, Task15l checkpoint 2).*

## API (A15.9)

| Code | HTTP |
|---|---|
| `ATTESTA_API_FORBIDDEN` | 403 (role) |
| `ATTESTA_API_NOT_FOUND` | 404 (also for another tenant's digest) |
| `ATTESTA_API_INVALID_QUERY` | 400 |
| `ATTESTA_API_RATE_LIMITED` | 429 with `Retry-After` |
| `ATTESTA_API_INTERNAL` | 500 (generic detail) |
| `ATTESTA_API_UNAUTHENTICATED` | 401 (no authenticated administrator identity) |
| `ATTESTA_API_UNAVAILABLE` | 503 (authorization lookup or a required dependency, such as the export sink or the trust inventory, temporarily unavailable) |
| `ATTESTA_API_CONFLICT` | 409 (an `Idempotency-Key` reused with another scope or mode) |

*Added 2026-10-13 (Task15i2, lead-approved; proposed in the Task15i handoff). Evidence-pack jobs that fail record one of the codes above or `ATTESTA_SIGNER_*` as their `error_code` (`evidence-pack.md`).*
