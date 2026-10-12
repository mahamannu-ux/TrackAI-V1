# Handoff: Task15e-attesta-fakes (subtask A15.4)

## At a glance
In-process fake Rekor (v1 `hashedrekord`) and fake RFC 3161 TSA with real
cryptography, as test specifications for A15.5. 34 new tests; `npm run check`
green (326 unit tests pass). Tree has 5 commits; do not push (re-review first).

## Implemented interfaces
- `attesta/testing/fetch-like.ts`: `FetchLike` the A15.5 adapters inject.
- `attesta/testing/fake-rekor.ts`: `FakeRekor` (POST/GET entries, log,
  publicKey; knobs `checkpointKey`/`setKey`/`tamper`/`omitLocation`/`down`/
  `failStatus`; constants `REKOR_TREE_ID[H EX|_DEC]`, `REKOR_HOST`,
  `REKOR_CLOCK_START`).
- `attesta/testing/fake-tsa.ts`: `FakeTsa.create()` (async), `fetch`,
  `respond()`, `token()`, `anchorsPem`; `makeCa()`, `makeTsaCert()`,
  `generateTsaKeyPair()`, `ensureTsaEngine()`; all source knobs in camelCase.
- `attesta/vectors/rekor/sigstage_hashedrekord.json`: byte-identical copy.
- Deps (exact, `dependencies`): `@noble/curves@2.4.0`, `pkijs@3.4.1`,
  `asn1js@3.0.10`.

## Deviations
Ported from SushiCorp `tests/unit/anchor/fake_rekor.py`, `fake_tsa.py`,
`rekor_vectors/sigstage_hashedrekord.json` @ `0bd67a5` (catalog EV-2).
Per-file headers list these; summary: FetchLike replaces MockTransport
(`down` rejects `TypeError('fetch failed')`); noble `p256.verify`
`{prehash:false,lowS:false,format:'der'}` replaces Prehashed (Node cannot
verify against a bare digest); `TREE_ID` is a bigint; `token()`/`respond()`
are async (WebCrypto); keys are WebCrypto pairs, certs pkijs Certificates.

## Known limitations
None functional. Fakes only; no adapters, DB, routes, or network.

## Test coverage
`fake-rekor.test.ts` (12): 201 + inclusion/checkpoint/SET verify, 409 ±
Location, high-S accepted, 400s, bytes body accepted, uncanonicalizable
entry is 400 (not a throw), GET/treeSize/publicKey, down/failStatus,
forged keys fail, tamper precision, independent MTH, vector shape + ID rule.
`fake-tsa.test.ts` (22): pkijs end-to-end verify (imprint, nonce, EKU,
chain) + one test per knob, each proving the defect in the bytes (crypto
knobs also fail pkijs verification); OpenSSL `ts -verify` passes for ESS v1
and v2; root/leaf defaults covered.

## Integration test impact
None: no integration tests (in-process only, no network/DB).

## Integration notes (for A15.5)
- Golden-path verify: `SignedData.verify({signer:0, data:message,
  checkChain:true, trustedCerts:[root]})` (pkijs hashes `data` itself).
- To sign a `hashedrekord` digest use noble `p256.sign(d, priv,
  {prehash:false,format:'der'})`; Node `sign(null,…)` is NOT raw ECDSA.
- TSA `directoryName` is EXPLICIT (`A4{SEQ{SET{…}}}`); pkijs rejects A4{SET{…}}.
- Dist check passed: ESM-only noble loads in the CommonJS build.

## Effort
Estimate about 0.1× T6; actual about 0.1×.
