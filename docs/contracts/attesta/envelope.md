# Envelope: how a statement is signed (frozen)

Every Attesta statement travels in a **DSSE envelope** (`apps/api/src/features/attesta/dsse.ts`, Task15a), signed through the tenant-bound signer contract (`signer-contract.ts`, Task15b). This is what `cosign verify-attestation`, Rekor `dsse` entries and the offline verifier (A15.10) expect.

## The exact bytes

| Item | Value |
|---|---|
| `payloadType` | `application/vnd.in-toto+json` (`IN_TOTO_PAYLOAD_TYPE`) |
| payload | `Buffer.from(canonicalize(statement), 'utf8')`: the RFC 8785 bytes of the statement, nothing else (no trailing newline) |
| bytes signed | `pae(payloadType, payload)` = `"DSSEv1 " + len(type) + " " + type + " " + len(payload) + " " + payload` |
| signature | `signVerified(adapter, paeBytes, { credentialId, tenantId, requestId })`: ES256, DER, verified against the published key before use |
| `signatures[0].keyid` | `"sha256:" + hex(SHA-256(publicKeySpkiDer))` of the key that signed. The credential name is never published |
| envelope | `{ payload: base64(payload), payloadType, signatures: [{ keyid, sig: base64(DER) }] }`; exactly one signature in v1 |

## Statement digest: the identity

- **Statement digest** = `sha256Prefixed(canonicalize(statement))` = `"sha256:" + hex(SHA-256(payload))`.
- It is what `previous`, `merge_lineage[].source_statement_digest`, the ledger (`attesta_records.statement_digest`, unique per tenant) and the API use to name a statement.
- **Deduplicate on the statement digest, never on envelope bytes.** ECDSA signatures are randomized (and malleable), so signing the same statement twice gives two different envelopes. A second envelope for a digest that is already stored is discarded, not stored as a new statement.

## Builder steps (A15.8), in order

1. Open a read transaction; `as_of` = its `now()`. Build the statement object from Task2's tables for one claimed outbox row, filling each field only from its source column in `fields.md`. `previous` = the digests of every statement already chained about the same subject (tenant, repository, sha), oldest first.
2. `canonical = canonicalize(statement)`; if canonicalization refuses (unsafe number, NaN, sparse array), stop: `ATTESTA_BUILDER_NOT_CANONICAL`.
3. **Validate the snapshot, not the live object:** `snapshot = JSON.parse(canonical)`; validate `snapshot` against `statement-v1.schema.json` (`ATTESTA_BUILDER_SCHEMA_INVALID`) and `checkStatementRules(snapshot)` (`ATTESTA_BUILDER_RULE_VIOLATION`). From here on, only `canonical` is used, so a getter or proxy in the built object cannot change what was checked (Task15a lesson).
4. Size: if `pae(...)` would exceed `adapter.capabilities().maxPayloadBytes`, rebuild with fewer `files.entries` (flagged `partial` / `entries_truncated`, `omitted` counted) and return to step 2. Never sign a statement that does not fit, and never drop a field to make it fit.
5. Compute the statement digest. If the tenant's ledger already holds it, mark the outbox row done and stop (idempotent).
6. Sign the PAE bytes with `signVerified`. `SigningUnavailable` → retry later (`ATTESTA_SIGNER_UNAVAILABLE`); `SigningRejected` → terminal for this row (`ATTESTA_SIGNER_REJECTED`). Never store an envelope whose signature did not verify.
7. Chain the stored canonical bytes and the envelope in **one ledger transaction** (`tables.md`); no network call inside it. Under the chain lock, that transaction also:
   - re-reads the statements about the subject; if one was chained after the build read them, it aborts with `ATTESTA_LEDGER_PREVIOUS_STALE` and the row is rebuilt (so concurrent statements about one subject always link);
   - sets the outbox row to `done` **only if it is still claimed by this attempt** (`status = 'claimed'` and the same `claimed_at` and `attempts`), else aborts with `ATTESTA_LEDGER_CLAIM_LOST`;
   - relies on `attesta_records (tenant_id, outbox_subject_id)` being unique, so a crashed or expired attempt can never chain a second statement for the same row.

## Verifier steps (A15.10 and the API's verify report)

1. Decode `payload`; check `payloadType`; recompute PAE; verify the signature with the published key whose SHA-256 matches `keyid`.
2. Check the payload bytes are canonical: `canonicalize(JSON.parse(payload))` must equal `payload` byte for byte (`ATTESTA_VERIFY_NOT_CANONICAL`).
3. Validate against the schema of the predicate version it claims and run S1–S12.
4. Recompute the statement digest and compare with the ledger record, the chain and the anchors (`tables.md`).
