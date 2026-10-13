# Task15l-trust-layer Handoff — Attesta shared trust layer, part 1 (A15.12)

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branches `task/Task15l-trust-contract` (contract PR, 4 commits) and `task/Task15l-trust-layer` (stacked on it), base `main` at `2261ba6`. Split at checkpoint 1 (founder, 2026-10-13): this session ships the contract, the pure verifier, the document library and the offline root tool. **Task15l2** ships the inventory migration, resolvers, online CLIs and live tests (scope below). No routes, no GitAI change, no UI.

## At a glance
| | Item | Status |
|---|---|---|
| Hierarchy | offline root (k-of-n) → root document listing root keys and one platform online key per purpose (`anchor`, `activation_lease`, `fleet_config`, `policy_bundle`, `release`, `tenant_keyset`) → per-tenant key sets of `statement` keys, signed by `tenant_keyset`; customer pins override key sets | ✅ |
| Contract | `docs/contracts/attesta/trust.md`, `trust-document-v1.schema.json`, `errors.md` "Trust (A15.12)" (19 codes, one status each), `trust-contract.ts` [FROZEN], 82 vectors + `generate.ts` | ✅ checkpoint-2 PR |
| Verifier | `verifyTrusted` → `verified` / `rejected` / `unavailable` (Task9's three states); UNKNOWN never verified | ✅ |
| Root tool | `npm run attesta:trust-root -w apps/api -- keyid|draft|sign` (offline, prints keyids and digests only) | ✅ |
| Inventory, resolvers, online CLIs, IT-T15l-01…04 | moved to Task15l2 | n/a here |
| Quality | 691 unit tests (33 new test groups), typecheck clean; vectors reproduce byte for byte; OpenSSL oracle | ✅ |
| Review | subagent round 1: 3 must-fix (rollback/fork, payload-only time evidence, old-root fork) + 5 should-fix, all fixed; round 2: 1 must-fix (key-set recovery after a `tenant_keyset` compromise) + coverage, fixed; no wrong `verified` left | ✅ · Codex round 1 "fix first": unsigned `signedAt` grandfathering, clock rollback floor, strict `timeEvidence`, root tool predecessor and forward-only checks — all fixed; re-review ⬜ |

## Implemented interfaces
```ts
// trust-contract.ts (frozen): types, constants, TRUST_CODE_STATUS
verifyTrusted({ payloadType, payload, envelope, purpose, audience, signedAt, timeEvidence?, state }): { status, code, keyid?, trusted?, trustedTime? }
TrustState = { pinnedRootKeyids, pinnedRootThreshold?, rootDocuments, keysetDocuments, customerPins?, lastTrusted, now, trustedTimeFloor?, clockSkewMs?, production, allowUnpinnedRoot? }
// verdict on verified: { keyid, trusted, trustedTime } → persist into lastTrusted / trustedTimeFloor
TimeEvidence = { kind: 'tsa_gen_time'|'rekor_integrated_time', time, binds: 'signature'|'ledger_statement', digest }
// trust-documents.ts: parseTrustDocument, signTrustDocument(body, signers), trustDocumentPayload, forwardOnlyViolation, keyValidityViolation
```

## Adversary table (each a test or vector)
| Attacker | Attempt | Result |
|---|---|---|
| network | withhold, replay, fork, garble documents | unavailable / rollback / conflict / malformed (vectors 13–35, 49–57) |
| stolen `tenant_keyset` key | un-revoke a key, fork a key set, lone forged version | conflict / regression / unavailable (31, 49–52); recovery with a new key keeps history valid (70–72) |
| stolen online key | sign for another purpose or tenant | purpose / audience mismatch (44–47) |
| old root key after rotation | fork the root | conflict when `lastTrusted` is set (55); first-use limit documented (56) |
| compromised key + public TSA | back-date or pre-timestamp a payload | key revoked unless evidence names this signature (38–41, 58–60, 73) |
| retired key | back-dated document living forever | lifetimes ≤ 31 days / 366 days (54, 74) |
| clock / `signedAt` | future or out-of-validity times; rewrite the unsigned `signedAt` to grandfather a retired, superseded or expired key; roll the clock back | not valid at / from future / revoked unless bound evidence (8, 9, 29, 76–79); clock behind the persisted floor (81–82) |

## Ported from
SushiCorp @ `0bd67a5` (catalog TR-1, SG-1): `core/trust/revocation.py` three states and its failure tests (ported first, `trust-verify.test.ts` part 1); inventory and rotation from `adapters/signing/inventory.py`, `MODULE_A1b_HANDOFF.md` (keep retired public keys forever). Deviation: a present-but-forged document is `rejected` (SushiCorp: UNKNOWN); neither verifies. New, with reasons in trust.md "Provenance": purposes, signed key sets, TUF root rotation, bound time evidence, forward-only key sets, last-trusted anchoring.

## Founder-approved decisions
1. 2026-10-13: the four checkpoint-1 answers (customer pin overrides; one offline root key, threshold 1; platform keys in TrackAI's KMS; 30 days / 1 year / 5 min).
2. 2026-10-13: split 15l / 15l2. Lead changes in the design note accepted (platform keys in the root; old + new root signatures; tamper = rejected; forward-only).

## Deviations from spec
- `TrustState.highestVersionSeen` became `lastTrusted` (version + digest) after review: a version number alone allowed forks and old-root forks.
- Time evidence binds the signature (or, for statements, the tenant's ledger statement), not the payload; `signedAt` alone grandfathers nothing (Codex review): non-active or expired keys need that evidence.
- `trustedTimeFloor` / `trustedTime` added (Codex review): a rolled-back clock gets `CLOCK_BEHIND`.
- `trust-contract.ts`: the main PR replaces only the `verifyTrusted` stub body (allowed by trust.md). Contract README file table not updated (not pre-approved): trust.md is self-describing.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | A15.13 root ceremony: on an offline machine, `attesta:trust-root draft` + `sign` with the root key; create one KMS key per platform purpose | real root and platform keys |
| 🟡 | First use without `lastTrusted` trusts what chains from the pin | enrollment and packs pin the current root; consumers persist `lastTrusted` |
| 🟡 | `ledger_statement` evidence is the caller's assertion | only verify-chain / A15.9 may pass it, from the tenant's own anchors |
| 🟡 | `signedAt` is an unsigned caller claim (trusted only while the key is active and valid at `now`; otherwise bound evidence is required); a document's `issued_at` is signed but still the signer's own claim, bounded by the document lifetime | consumers check artifact freshness (trust.md "Consumers") |

## Task15l2 scope (next prompt)
Migration 0019 after 0018: `attesta_platform_keys`, `attesta_tenant_keys` (RLS, composite tenant keys, `withTenant`), append-only `attesta_key_events` and `attesta_trust_documents` (version and `previous` guards, 0017 style), status transitions only forward with an event row. Registration needs **proof of possession** and refuses a keyid already used by another tenant or purpose (review finding 8). `inventorySignerResolver`, `platformSigner(db, adapters, purpose)` replacing `anchor-env.ts`'s production refusal, `publishedKeysFor`. CLIs `attesta:keys register|activate|retire|revoke|publish|export-root-draft|import-root` (dry-run, `--confirm`, `--expect`, one `security_audit_events` row; publish builds key sets from version 1 history). IT-T15l-01…04 as in the 15l prompt.

## Test coverage
`trust-verify.test.ts`: TR-1 port; all vectors through `verifyTrusted`; every boundary (validity, revoked_at, skew, expiry, lifetimes), compromise evidence, root k-of-n rotation, forward-only per field, purpose/tenant confusion, pins, bounds, never-throws, schema/validator parity. `trust-vectors.test.ts`: byte-for-byte reproduction, schema, OpenSSL verifies every signature of verified vectors and refuses the forged one. `attesta-trust-root-cli.test.ts`: draft → sign → verified; rotation needs old and new keys; no key material printed; refuses with `DATABASE_URL`. No mocks.

## Integration test impact
None in this session (pure code, no database or network). IT-T15l-01…04 move to Task15l2 (blocking its merge). **IT-M9-01 is unblocked for Task9** to build against `verifyTrusted` and the vectors once the contract PR merges (production still needs the A15.13 `fleet_config` key).

## Integration notes
Consumers hard-code `production: true`, pin the current root keyid, persist `trusted` → `lastTrusted`, and check their own artifact freshness. Evidence packs carry root documents and key sets from version 1. GitAI's Rust verifier must match all vectors (`GITAI_FUTURE_TODO.md` G8).

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens |
|---|---|---|---|---|
| 0.18× (15l half of 0.38×) | about 0.25× | ~90 turns + 2 review rounds | ~3 h (incl. a rate-limit pause) | ~0.5M |

Over 1.25×: two review rounds changed the frozen contract (lastTrusted, bound evidence, key-set recovery) before it merged. Next prompt: run the review subagent on the contract **before** sending the checkpoint-2 bundle.
