# Task15f-attesta-anchoring Handoff — Rekor and RFC 3161 anchoring adapters (A15.5, part 1 of 2)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)
Branch `task/Task15f-attesta-anchoring` (base: `main` at `c5cf7cb`). Founder approved the split at the checkpoint (2026-10-12): this session ships the adapters; **Task15f2** ships the migration, worker, CLI, verify-report anchor checks, the exact `BREAK_DETAIL_CODES` switch and IT-T15f-01…04.

## At a glance
| | Item | Status |
|---|---|---|
| Scope | §2.1 items 1–4: Rekor adapter, TSA adapter, dual mode, anchoring key; plus the EV-2 v1 proof JSON and an offline stored-proof check for 15f2 to call | ✅ |
| Scope | §2.1 items 5–7 (migration 0018, worker, verify report, codes) | ⬜ Task15f2 |
| Quality | `npm test` 542 pass (95 new, 0 skipped with OpenSSL 3.0.13), typecheck clean; mutation checks on every verifier branch | ✅ |
| Oracle | `openssl ts -verify` agrees with the adapter on 2 good and 7 corrupted tokens (skips without OpenSSL) | ✅ |
| Review | review subagent: 1 must-fix (offline check re-asserted a stored "clean" revocation), 12 should-fix; all fixed except #10 (question below) | ✅ · cross-agent review ⬜ |

## Implemented interfaces (`apps/api/src/features/attesta/`)
```
anchor-contract.ts  AnchorError(code, retryable) · AnchorInputError · ATTESTA_PLATFORM_TENANT_ID (nil UUID)
  AnchorSigner { publicKeySpkiDer(), sign(root) } · anchorSignerFromAdapter(SigningAdapter, credentialId) · BoundedCache · readCapped
anchor-rekor.ts  new RekorAnchor({ url, signer, logPublicKeyPem?, fetch?, production?, allowTrustOnFirstUse?, timeoutMs?, cacheSize?, maxClockSkewMs?, now? })
  .anchor(root32, batchId) → { type:'rekor', entryId, uuid, logIndex, integratedTime, anchoredAt, entry }
  .verifyInclusion(entryId, root) → boolean (throws LOG_UNAVAILABLE when the log can't be asked) · .health() · .logKey()
  verifyRekorEntry(entryId, entry, { logKey, artifact?, anchorKeySpkiDer? }) · verifyCheckpoint · verifySignedEntryTimestamp · loadLogPublicKey · logIdOf · proposedEntry
anchor-tsa.ts  new TsaAnchor({ url, trustAnchorsPem, fetch?, revocation?, maxClockSkewMs?, hashAlgorithm?, timeoutMs?, cacheSize?, now? })
  .anchor(root32, batchId) → { type:'tsa', ref, tokenDer, anchoredAt, serialNumber, policy, revocation:{status,reason} }
  .verifyToken(token, root, window?) · verifyTimestampToken(token, root, anchors, { nonce?, genTimeNotBefore?, genTimeNotAfter? })
  TsaRevocationChecker { check(signerDer, issuerDer, at) → revoked|clean|unknown } · checkTsaRevocation · buildTimeStampReq · tokenFromResponse
anchor-dual.ts  new DualAnchor(rekor, tsa).anchor(root, batchId) → { complete, rekor, tsa } (each anchored | failed{code,retryable} | skipped)
  anchorProofJson(merkleProof, result) → EV-2 v1 inclusion_proof · verifyStoredAnchor(row, { rekorLogKey, anchorKeysSpkiDer[], tsaAnchors }) → valid | invalid{MERKLE_PROOF_INVALID|ANCHOR_INVALID} | not_checkable
```

## Checkpoint decisions (founder "go", 2026-10-12)
1. **Anchoring key:** one platform credential, never a tenant key, through the frozen `SigningAdapter` with the reserved tenant `00000000-0000-0000-0000-000000000000` (`ATTESTA_ANCHOR_CREDENTIAL_ID` in 15f2); local dev signer in dev. KMS signs with random nonces, so a crash between submit and record can log a root twice in Rekor; the database (one `anchored` row per record and type) is the idempotency on `batch_id`.
2. **Defaults for 15f2:** batch up to 256 records; anchor a partial batch once its oldest record waited 10 min; anchoring window 1 h (`ANCHOR_MISSING`); a pass every 5 min.
3. **TSA revocation, phase 1:** no OCSP/CRL source → `unknown` / `no_source_configured` in the proof. Offline it is always `unknown` (`not_rechecked_offline`), with the stored value beside it, unverified. Unknown does not make the report not-`ok`; it shows as a warning.
4. **Rekor v2 (tiles):** deferred; v1 only. Pinned log key required in production; TOFU only with `allowTrustOnFirstUse` outside production.

## Ported from
SushiCorp EV-2 (+ TR-1 revocation states) @ `0bd67a5`: `adapters/anchor/{rekor,tsa,rfc3161,dual,keys,base}.py`, the proof JSON from `core/evidence/anchoring.py`, tests `test_anchor_rekor.py`, `test_anchor_tsa.py`. Kept every check and lying-log case. Closed: genTime bound, bounded caches and reads, three-state revocation. Deviations, with reasons, are in each file's header. In short: errors.md codes instead of two exception types; a signer contract instead of a key file; one row per anchor type, so no `rekor+tsa` type; added checks:
- TSA: tree-ID/origin binding, integratedTime window, DER lengths, signer not a CA, key usage, pathLen, outer/inner algorithm, unknown critical extensions, RSA ≥ 2048.
- Proof JSON: additive TSA keys (`gen_time`, `serial_number`, `policy`, `revocation`, `rekor_entry: null`).

## Adversary table (each a unit test; failures are errors.md codes, never a pass)
| Lie | Code |
|---|---|
| Log down, 5xx, 409 that can't be fetched | LOG_UNAVAILABLE (retry) |
| Foreign checkpoint key, forged SET, tampered proof, body, logID or time, wrong entry on GET, malformed payload, oversized reply, integratedTime outside the window | LOG_PROOF_INVALID |
| Someone else's entry for our root, impostor key, body swap (in `verifyInclusion`) | false |
| Sigstage vector: 12 tampers, wrong key, wrong ID | RekorVerificationError |
| TSA down, HTTP error, wrong content type, rejection or waiting status | TSA_UNAVAILABLE |
| Imprint, nonce, corrupt signature, digest, content type, missing or foreign ESS, no certs, EKU (×4), validity, untrusted or same-name root, non-CA intermediate, keyCertSign, pathLen, depth, two signers, SHA-1, repeated attribute, BER lengths, CA signer, critical extension, RSA 1024, genTime ±1 h, revoked, oversized | TSA_TOKEN_INVALID |
| Stored row: hash, root, path, index, size, entry, log_index, proof_b64, uuid column, type, version, token, gen_time, policy, forged "clean" | MERKLE_PROOF_INVALID / ANCHOR_INVALID / revocation stays unknown |

## Known limitations
- No consistency proofs or witnesses (Rekor v1): a log operator holding the pinned key could show us a view it never published. n/a until Rekor v2 / witnesses.
- Revocation of intermediate TSA CAs is not checked (only the TSA certificate goes to the source). The SKI form of the signer ID and RSA-PSS are implemented but not exercised: neither fake produces them.
- A TSA token's `ref` is per byte string: we refuse BER length forms, but other non-DER encodings inside signed parts would hash differently. Harmless: verification covers the bytes as stored.

## Question for the founder
- The log refusing a submission (HTTP 400/422) has no errors.md code; it is `ATTESTA_ANCHOR_LOG_UNAVAILABLE` with `retryable: false`. Recommendation: an additive `ATTESTA_ANCHOR_LOG_REJECTED` (terminal) in the orchestrator's next contract PR, adopted by 15f2.

## Integration test impact
None in this session: the adapters touch no database, and every test runs in `npm test` against the in-process fakes and the real sigstage vector. IT-T15f-01…04 move to Task15f2 (blocking its merge). Real rekor.sigstage.dev and FreeTSA runs stay at A15.13 (founder-live, blocking production).

## Integration notes (for Task15f2)
- Plan → submit → record: call `DualAnchor.anchor` outside any transaction. Write anchored rows only when `complete`. Write a `failed` row per `failed` type, using its `code`. `skipped` writes nothing. An `AnchorInputError` is a worker bug.
- Store `anchorProofJson(proofToJson(i, n, inclusionPath(leaves, i)), result)` per record and type. `rekor_entry_uuid` = `entryId`; `tsa_token_b64` = `tokenDer.toString('base64')`.
- Verify with `verifyStoredAnchor`. Keep retired anchoring public keys in `anchorKeysSpkiDer`.
- Tests: set `FakeRekor.clock` to now, because a new entry's integratedTime must fall in the request window.

## Effort
Estimate about 0.2× T6 for this half (0.4× for the whole of A15.5 at the checkpoint, split in two). Actual about 0.25×. The review round, with its 30 new tests, cost about a fifth of the session, as Task15d predicted.
