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

## Anchoring (A15.5)

| Code | When | Retry |
|---|---|---|
| `ATTESTA_ANCHOR_LOG_UNAVAILABLE` | Rekor unreachable or timed out (never a pass) | retry |
| `ATTESTA_ANCHOR_LOG_PROOF_INVALID` | inclusion proof, checkpoint, SET or entry binding does not verify | retry, then alert |
| `ATTESTA_ANCHOR_TSA_UNAVAILABLE` | TSA unreachable | retry |
| `ATTESTA_ANCHOR_TSA_TOKEN_INVALID` | imprint, nonce, ESS, signature, chain or EKU fails | retry, then alert |
| `ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED` | production without a pinned log key | terminal (configuration) |

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

## API (A15.9)

| Code | HTTP |
|---|---|
| `ATTESTA_API_FORBIDDEN` | 403 (role) |
| `ATTESTA_API_NOT_FOUND` | 404 (also for another tenant's digest) |
| `ATTESTA_API_INVALID_QUERY` | 400 |
| `ATTESTA_API_RATE_LIMITED` | 429 with `Retry-After` |
| `ATTESTA_API_INTERNAL` | 500 (generic detail) |
