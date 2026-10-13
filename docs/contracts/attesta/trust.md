# Trust layer (A15.12): key hierarchy, signed key sets, rotation, revocation, the shared verifier

Status: **Frozen when merged** (additive changes only). Written 2026-10-13 by Claude (Task15l-trust-layer) from `docs/plan/TASK15.md` §2 decision 3, §3 A15.12 and §7 item 10, `TASK6_POLICY.md` §6–§7 and `docs/plan/TASK9.md` ("Verification"). Interface: `apps/api/src/features/attesta/trust-contract.ts`. Schema: `trust-document-v1.schema.json`. Codes: `errors.md` "Trust (A15.12)". Vectors: `apps/api/src/features/attesta/vectors/trust/`.

**What it answers:** for a signature on some bytes, *was this key trusted for this purpose, for this tenant (or the platform), at the time it signed?* Answer: `verified`, `rejected` or `unavailable`, with one code. **`unavailable` is never `verified`** (catalog TR-1; AGENTS.md §9 item 19).

## Hierarchy

| Level | Keys | Where they live | Signs |
|---|---|---|---|
| Platform root | 1..n `root` keys, threshold k (phase 1: one key, k = 1; 2-of-3 hardware keys before the first production customer) | offline, never on a server (a key file in development) | the **root document** |
| Platform online | one key per purpose: `anchor`, `activation_lease`, `fleet_config`, `policy_bundle`, `release`, `tenant_keyset` | TrackAI's own cloud KMS (A15.6 adapters), listed in the root document | anchors, leases, fleet configuration, policy bundles, releases; `tenant_keyset` signs **key sets** only |
| Tenant | `statement` keys | the tenant's own KMS (no custody, TASK15 §2 decision 3), registered by a tenant administrator | Attesta statements of that tenant only |

- Verifiers (GitAI, auditors, the offline verifier) **pin the root keyids** at install or enrollment. Production refuses to verify without a pin.
- Platform online keys are listed **in the root document itself**, so one stolen online key cannot authorize another key or another purpose. Changing a platform key needs a new root document, signed offline.
- A tenant's **key set** lists its statement keys with validity and status and is signed by the platform `tenant_keyset` key, so anyone can check offline "this key was registered for this tenant from then until then". A customer may instead **pin its own keys** (below); the pin overrides the key set.
- The credential name (KMS resource name) is never in a document: keys are named by keyid only (`envelope.md`).

## Documents

A trust document is a DSSE envelope (`dsse.ts`) whose payload is the RFC 8785 (JCS) bytes of a JSON object. `trust-document-v1.schema.json` is normative; the table summarizes it.

| | Root document | Key set |
|---|---|---|
| `payloadType` | `application/vnd.trackai.trust-root+json` | `application/vnd.trackai.keyset+json` |
| `_type` | `https://trackai.dev/attesta/trust-root/v1` | `https://trackai.dev/attesta/keyset/v1` |
| `scope` | `platform` | the tenant UUID (lowercase) |
| `threshold` | required, 1 ≤ k ≤ number of `active` root keys | absent |
| `keys[].purpose` | `root` (at least one active) and the platform online purposes | `statement` only |
| signed by | k `root` keys of the **previous** root document **and** k' of its own `root` keys (k' = its own threshold), each active and valid at `issued_at`; version 1 only by its own | one `tenant_keyset` key listed in the current root document, valid at `issued_at` |
| lifetime (`expires` − `issued_at`) | ≤ 366 days | ≤ 31 days |

Common fields: `version` (integer ≥ 1, strictly increasing per scope), `issued_at`, `expires` (RFC 3339 UTC with milliseconds), `previous` (`"sha256:" + hex(SHA-256(payload bytes of version − 1))`, or `null` at version 1), `keys`.

Each key entry: `keyid`, `purpose`, `spki_der_b64` (ECDSA P-256 SPKI DER, standard base64), `not_before` < `not_after`, `status`, and:

| `status` | `revoked_at` | `revocation_reason` | `compromised_since` |
|---|---|---|---|
| `active` | absent | absent | absent |
| `retired` | required: when it stopped signing | absent | absent |
| `revoked` | required | `superseded` or `compromised` | required iff `compromised`, ≤ `revoked_at` |

Document rules (a breach is `ATTESTA_TRUST_DOCUMENT_MALFORMED`, rejected):
1. Payload bytes are their own JCS form (`canonicalize(JSON.parse(p)) === p`); every object is closed; strings and numbers are bounded as in the schema.
2. `keyid` equals `"sha256:" + hex(SHA-256(base64-decoded spki_der_b64))`, recomputed by the verifier; the SPKI parses as P-256. A keyid appears once per document.
3. `issued_at` < `expires`, within the lifetime above (`issued_at` is the signer's own claim, so the bound caps how long a back-dated document from a retired key can live); `revoked_at` and `compromised_since` are not after `issued_at`.
4. Signatures: 1..16, each `{keyid, sig}` (DER ECDSA over the DSSE PAE). Unknown keyids are ignored; only distinct, verifying, authorized signers count.
5. Retired public keys are **kept forever**: a later document of the same scope lists every non-root key of the one before (rotation and audits depend on it).

**Key sets only move forward** (`ATTESTA_TRUST_KEYSET_REGRESSION`, rejected), checked between consecutive documents of a scope (for the root document: its non-root keys): a key never disappears; its `purpose`, `spki_der_b64` and `not_before` never change; `not_after` never grows; status order `active` < `retired` < `revoked` never goes back; `superseded` may become `compromised`, never the reverse; `revoked_at` and `compromised_since` never move later; `issued_at` never goes back. **Anchored at the last trusted document.** A verifier persists, per scope, the document it last accepted (`TrustVerdict.trusted` → `TrustState.lastTrusted`: version and digest). The next chain must start at exactly that document: a different document at its version is a fork (`DOCUMENT_CONFLICT`), nothing at or above it is a rollback (`ROLLBACK`), a later version that does not link back to it is a fork. Without an entry, a root chain starts at the pin and a **key-set chain must start at version 1** (full history). Together with forward-only, a stolen `tenant_keyset` key cannot un-revoke a compromised key, and a root key rotated out cannot fork the root for a verifier that has accepted the newer root.

**First-use limit (documented, as in TUF):** a verifier with no `lastTrusted` root and a pin to an old root key accepts a fork signed by that old key if the real newer roots are withheld. Enrollment, installers and evidence packs therefore pin the **current** root keyid, and long-lived verifiers persist `lastTrusted`.

## Verification

`verifyTrusted(input) → { status, code, keyid?, trusted? }` (types in `trust-contract.ts`) is pure: no database, no network, no clock (`state.now` is the clock), never throws. Order:

| # | Check | Failure → code (status) |
|---|---|---|
| 1 | Input bounded and well formed: `payload` ≤ 16 MiB equals the envelope's decoded payload, same `payloadType`, exactly one signature, `purpose` ∈ artifact purposes, `audience` = tenant UUID for `statement` and `platform` otherwise, timestamps valid, `timeEvidence` exactly `{kind, time, binds, digest}` with known values (`ledger_statement` only for `statement`) | `INPUT_INVALID` (rejected) |
| 1b | `now` is not more than the skew behind `trustedTimeFloor` (a rolled-back clock cannot revive expired documents while newer revocations are withheld) | `CLOCK_BEHIND` (unavailable) |
| 2 | Customer pins for `audience` (purpose `statement` only): use them as the key list, skip 3–5 | — |
| 3 | A root is pinned (production); outside production `allowUnpinnedRoot` trusts the lowest held root document | `ROOT_NOT_PINNED` (unavailable) |
| 4 | **Root chain**: every held root document parses (`DOCUMENT_MALFORMED`); no two differ at one version (`DOCUMENT_CONFLICT`); none is issued after `now` + skew (`DOCUMENT_FROM_FUTURE`). The **start** is the `lastTrusted.platform` document when there is one (see "Anchored at the last trusted document"); otherwise the lowest version whose active root keys include a pinned keyid (none → `DOCUMENT_UNAVAILABLE`), which needs valid signatures from ≥ max(its threshold, pin threshold) pinned keys (`THRESHOLD_NOT_MET`). Lower versions are ignored. Then versions climb by exactly one (gap → `DOCUMENT_UNAVAILABLE`) with `previous` = the digest of the one before (else `DOCUMENT_CONFLICT`), each signed by k root keys of the previous root and k' of its own, active and valid at its `issued_at` (`THRESHOLD_NOT_MET`), non-root keys forward-only (`KEYSET_REGRESSION`). The newest: `now` ≤ `expires` + skew (`DOCUMENT_EXPIRED`). No root document → `DOCUMENT_UNAVAILABLE` | as listed |
| 5 | **Key set** (purpose `statement`): none held for `audience` → `REVOCATION_UNKNOWN` (unavailable). Each parses with `scope` = `audience`, none conflicts or is from the future (as in 4); the chain starts at the `lastTrusted[audience]` document, or at version 1 when there is none (else `DOCUMENT_UNAVAILABLE`); versions contiguous (`DOCUMENT_UNAVAILABLE`) and linked (`DOCUMENT_CONFLICT`); forward-only; the **newest** is signed by a `tenant_keyset` key of the newest root that is valid at its `issued_at` by step 8's rules without time evidence (none → `DOCUMENT_SIGNATURE_INVALID`; a listed signer that is no longer valid → its step-8 code) and not expired. Older versions are authenticated by the `previous` digests from the newest, so history survives the retirement or compromise of the key that signed it | as listed |
| 6 | The key list: the newest root's online keys (platform purposes) or the newest key set (statement). The envelope's keyid is in it (`KEY_UNKNOWN`); a key found only in another tenant's key set → `AUDIENCE_MISMATCH`; listed for another purpose → `PURPOSE_MISMATCH` | rejected |
| 7 | The signature verifies over PAE(payloadType, payload) with the listed SPKI | `SIGNATURE_INVALID` (rejected) |
| 8 | `signedAt` ∈ [`not_before`, `not_after`] and ≤ `now` + skew (`KEY_NOT_VALID_AT`). `signedAt` is the caller's claim and **not covered by the signature**, so it is enough only while the key is `active` and `now` is inside its validity (± skew). Otherwise only **bound time evidence** (below) inside the key's validity saves the signature: `active` past `not_after` or `retired` → evidence before `revoked_at` (if any), else `KEY_NOT_VALID_AT`; `revoked`/`superseded` → evidence before `revoked_at`, else `KEY_REVOKED`; `revoked`/`compromised` → evidence before `compromised_since`, else `KEY_REVOKED` | rejected |
| 9 | All passed | `VERIFIED`, with `keyid`, `trusted` and `trustedTime` (only on `verified`) |

Status rule behind the codes: **evidence of tampering is `rejected`** (a forged or under-signed document, a rollback, a regression, a wrong key or signature); **absence of trust information is `unavailable`** (nothing pinned, a missing, expired or future-dated document, no key set for the tenant). Every code maps to exactly one status (`TRUST_CODE_STATUS`).

Time evidence (`timeEvidence`): an RFC 3161 `genTime` or Rekor `integratedTime` the caller has already verified. It counts only when bound (anything else, or a time after `now` + skew, counts as absent):

| `binds` | `digest` | Purposes | Why it proves the signature predates `time` |
|---|---|---|---|
| `signature` | SHA-256 of this envelope's DER signature bytes | all | only the key holder could produce those bytes |
| `ledger_statement` | SHA-256 of the payload | `statement` only | the caller verified that this statement is a record in the audience tenant's own Attesta ledger covered by that anchor; the builder signs before chaining, so TrackAI held a signed copy then, and a later re-signature of the same recorded statement adds no new claim. The verifier cannot see where the anchor came from: a timestamp over the payload alone, or another tenant's ledger anchor, must never be passed as `ledger_statement` |

A timestamp over the payload alone is never enough for other purposes: anyone can timestamp chosen bytes before stealing a key.

`trustedTime` = max(`trustedTimeFloor`, `now`): consumers persist it as the next floor.

`trusted`: the newest document accepted per scope in this call (`{"platform": {version, digest}, "<tenant>": {…}}`; empty with customer pins). Consumers persist it into `lastTrusted` once they accept the result.

**Bounds** (checked before any parsing or signature work): all held documents together ≤ 16 MiB of base64 payload, ≤ 256 tenant scopes, ≤ 1024 documents per scope; each document payload ≤ 256 KiB (about 700 keys), ≤ 1000 keys, ≤ 16 signatures; artifact payload ≤ 16 MiB. Clock skew default 5 minutes, at most 1 hour. Worst case inside the bounds: on the `KEY_UNKNOWN` path the verifier parses other tenants' key sets (no signature work) to pick `AUDIENCE_MISMATCH`, at most 16 MiB of documents (a few seconds).

## Customer pins (founder decision 2026-10-13)

`state.customerPins[tenant]` is a list of `statement` key entries the customer or auditor supplies (same fields, unsigned: local configuration is the trust). When present for the audience it **replaces** the platform key set and the root for that tenant: the evidence then does not depend on trusting TrackAI. Revocation is the customer's: they edit the pin. An empty list trusts nothing.

## Rotation and revocation procedures

| Action | Steps | Old signatures |
|---|---|---|
| Rotate a tenant statement key | register the new key (validity from now) → activate it → retire the old one (`revoked_at` = now) → `publish` a new key set | keep verifying for `signedAt` < `revoked_at` (rotation overlap) |
| Revoke, superseded | revoke `superseded` → `publish` | verify before `revoked_at` |
| Revoke, compromised | revoke `compromised --compromised-since <first suspect instant>` → `publish` | verify only with anchored time evidence before `compromised_since` |
| Rotate a platform online key | add the new key and retire or revoke the old one in a draft root → sign offline with the root keys → import | as above |
| `tenant_keyset` key compromised | new root document: revoke the key `compromised`, add a new `tenant_keyset` key (offline) → `publish` every tenant's next key set with the new key | earlier key sets stay valid through the `previous` chain from the new key set |
| Rotate the root | new root document: new root keys and threshold, same online keys, signed by k old and k' new root keys (offline) | earlier root documents stay in the chain; verifiers pinned to the old root walk forward |
| Key-set refresh | `publish` weekly; key sets expire after 30 days (hard limit 31), the root after 1 year (hard limit 366 days) | — |

Registration (15l2) requires **proof of possession** (the key signs a registration challenge) and refuses a keyid already registered for another tenant or purpose, so one tenant cannot list another's public key. Every applied action is dry-run first, prints its exact scope, needs `--confirm`, writes one audit event (AGENTS.md §9 item 10) and later feeds Task16 A16.11.

## Consumers

| Consumer | `purpose` | `audience` | `signedAt` / `timeEvidence` | On `rejected` | On `unavailable` |
|---|---|---|---|---|---|
| D6.1 activation lease (GitAI) | `activation_lease` | `platform` (tenant and machine binding are inside the lease) | the lease's issue time | stay off, report | stay off (fail closed), retry |
| Task9 fleet configuration (IT-M9-01) | `fleet_config` | `platform` | the configuration's issue time | keep last-known-good, alert | keep last-known-good, retry |
| Task6.b P6.8 policy bundles | `policy_bundle` | `platform` | the manifest's issue time | refuse the bundle | keep last-known-good |
| Task14 T14.7 releases | `release` | `platform` | the release time | refuse to install | refuse to install |
| Attesta statements, A15.9 packs, A15.10 | `statement` | the tenant UUID | `recorded_at`; the record's anchor time as `timeEvidence` (`binds: ledger_statement`) | report the break | report "not checkable" (exit 2) |

Evidence packs (A15.9) carry the root documents, the tenant's key sets **from version 1** and the anchoring key's root entry, so the offline verifier needs only the pinned root keyid (or a customer pin).

Every consumer:
- **hard-codes `production: true`** in shipped builds and never reads it, or `allowUnpinnedRoot`, from an environment variable or a file the user controls (Task15f lesson);
- **persists `trusted` into `lastTrusted` and `trustedTime` into `trustedTimeFloor`** after accepting a result (long-lived verifiers: GitAI, Task9, policy bundles);
- passes `timeEvidence` to grandfather signatures of retired, superseded, expired or compromised keys (for statements, the record's anchor time with `binds: ledger_statement`); `signedAt` alone only covers keys that are still usable;
- **checks the artifact's own freshness**: `signedAt` and a document's `issued_at` are the signer's own claims, so anyone holding a retired or superseded key can back-date within that key's validity. The lease expiry, the bundle epoch and the release version are the consumer's checks; the trust layer only bounds how long the documents themselves live.

## Vectors

`apps/api/src/features/attesta/vectors/trust/*.json`, generated by `generate.ts` in that folder from fixed test keys (deterministic RFC 6979 signatures, so the files reproduce byte for byte; the private test scalars are derived from public seed strings and are worthless). Each file: `{vector_version, name, description, input: {payload_type, payload_b64, envelope, purpose, audience, signed_at, time_evidence?, state: {pinned_root_keyids, pinned_root_threshold, root_documents, keyset_documents, customer_pins?, last_trusted, now, trusted_time_floor?, clock_skew_ms, production, allow_unpinned_root}}, expected: {status, code, keyid?, trusted_time?, trusted?}}`; `time_evidence` is `{kind, time, binds, digest}`. `keys.json` lists the test public keys by name. GitAI's Rust verifier must return the same `status` and `code` for every vector.

## Provenance

Ported from SushiCorp @ `0bd67a5` (catalog TR-1, SG-1): three states with REVOKED > CLEAN > UNKNOWN and UNKNOWN never CLEAN (`core/trust/revocation.py`; its failure cases, stale, future-dated, missing, garbage, forged, wrong issuer, are ported as tests); a public-only key inventory, retired public keys kept forever, rotation by overlap (`adapters/signing/inventory.py`, `MODULE_A1b_HANDOFF.md`). **New, with reasons:** key purposes (one key cannot sign for another consumer); signed key-set documents instead of X.509 trust lists (offline-checkable without a CA); TUF-style root rotation by threshold of old and new keys (rotating the root must not need a reinstall, and the new keys must prove possession); compromise bound to independent time evidence (a compromised key can back-date `signedAt`); forward-only key sets (a stolen online key cannot un-revoke).
