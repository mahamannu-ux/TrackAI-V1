# Task15a-attesta-primitives Handoff — Attesta primitives

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15a-attesta-primitives` (base: `main` at `d2c4a23`).

Three pure libraries every later Attesta session uses: RFC 8785 canonical JSON, RFC 6962 Merkle trees, DSSE envelopes. No database, routes, or UI.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | canonical, merkle, dsse libraries with ported vectors, `npm test` green | ✅ 106 new tests, 271 total pass |
| Scope | all 7 scope items in the prompt | ✅ |
| Quality | unit tests, typecheck, lint | ✅ |
| Integration | none needed (pure libraries, no services) | ✅ non-blocking |
| Review | self-review plus cross-agent review (fix first); all three fixes applied | 🟡 re-review requested |

## Implemented interfaces
```
canonical.ts: CanonicalizationError, canonicalize(value): string,
  HASH_PREFIX, GENESIS_PREV_HASH, sha256Prefixed(data): string,
  computeRecordHash(canonical, prevHash): string, hashBytes(prefixed): Buffer
merkle.ts: leafHash, nodeHash, merkleRoot, inclusionPath, rootFromPath,
  verifyInclusion (timingSafeEqual), InclusionProofJson, proofToJson, proofFromJson
dsse.ts: pae(type, body): Buffer, DsseEnvelope, SignFn,
  signEnvelope(type, body, sign), verifyEnvelope(env, keys), IN_TOTO_PAYLOAD_TYPE
```

## Ported from
SushiCorp `core/evidence/canonical.py`, `core/evidence/merkle.py` and tests @ `0bd67a5` (catalog EV-1, EV-2). DSSE is new. Deviations in file headers; the one that matters is below.

## Founder-approved decisions
1. `canonicalize@5.1.0` exact (pre-approved in TASK15 §7); no other dependency.

## Deviations from spec
- Unsafe-integer refusal narrowed: doubles with |n| >= 1e21 are accepted. The literal check broke the required corpus `values` vector (1E30 → "1e+30", verified against the source). Rationale: at/above 1e21 JCS emits exponent form identically in every implementation; below 1e21 integer literals may already have rounded and diverge across languages. 5 Appendix B patterns are asserted as refusals, 19 as exact text.
- `proofFromJson` also checks ranges (`leaf_index < tree_size`); `verifyInclusion` returns false (never throws) on any malformed input.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** | Approve raising the API `engines` floor to `>=20.19.0` in a later shared-surface change (not this branch: root `package.json` is outside this session's pre-approved files) | Later sessions inherit the floor; nothing in this session waits on it |
| 🟡 | Sandbox-verified only; needs cross-agent review before push | Task15d (ledger) builds against this |

## Test coverage
102 tests, no mocks: 6 vector pairs byte-for-byte, 24 Appendix B patterns, refusals, fixed point, known record hash; RFC 6962 roots 1–8, inclusion for sizes 1–33, negative/transfer cases; PAE answer, P-256 round trip, 6 failure modes. Not tested: cross-language verifiers (A15.10 covers the offline path).

## Integration test impact
None needed: no database, network, or routes. Later sessions consume these as pure functions.

## Integration notes
- `canonicalize` is ESM-only; imported via `esModuleInterop` default import (works in the CJS build).
- The API now needs Node ≥ 20.19 at runtime: the CJS build loads the ESM package through `require(esm)`, which fails with `ERR_REQUIRE_ESM` on Node ≤ 20.18. CI runs current Node 20, so it passes there.
- Test glob `src/features/attesta/*.test.ts` appended exactly; the Task15b session makes no further edit to that line.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.08× | about 0.08× | one session | ~1 h | n/a |
