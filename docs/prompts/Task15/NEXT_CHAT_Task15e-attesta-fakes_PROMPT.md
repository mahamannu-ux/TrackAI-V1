# Handoff prompt: Task15e-attesta-fakes (in-process fake Rekor and fake RFC 3161 TSA), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Approve the three new dependencies below (`@noble/curves`, `pkijs`, `asn1js`) by merging the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15e-attesta-fakes && cd ~/AIProjects/TrackAI-wt/Task15e-attesta-fakes && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line. Reply "continue" if it stops. It can run at the same time as Task15c (no shared files).
> 3. When it finishes, paste its review request to the Task15 lead Claude chat. Push only after "ready to push".

---

You are **Muse**, building **Task15e-attesta-fakes** (subtask A15.4) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product. Attesta (Task15, `docs/plan/TASK15.md`) anchors batches of signed statements in two external services: the Sigstore **Rekor** transparency log and an **RFC 3161 timestamp authority (TSA)**. A later session (A15.5) writes the real adapters and must prove they catch a log or TSA that lies. This session builds the two **fakes** those tests run against: in-process, real cryptography, with knobs that make each service misbehave in one specific way. They are **test specifications**, ported from SushiCorp. **Every decision is made below; do not redesign.** No adapters, no database, no routes, no network.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15e-attesta-fakes`, branch `task/Task15e-attesta-fakes`.
- **Handoff:** `docs/handoffs/Task15e-attesta-fakes_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §5a, §6, §9 items 15–21, §11, §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`: you must be in the worktree above on `task/Task15e-attesta-fakes`; otherwise stop. `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (292 pass expected, or more if Task15c merged first).
4. Estimate one line against T6; the plan says **about 0.1×** (0.08× raised for building ASN.1 by hand in TypeScript).

## 1. Read (source of the port, read-only)
`git -C ~/dev/sushicorp show 0bd67a5:<path>` for:
- `tests/unit/anchor/fake_rekor.py` (192 lines) and `tests/unit/anchor/fake_tsa.py` (246 lines): **the specification**. Port every behaviour and knob.
- `tests/unit/anchor/rekor_vectors/sigstage_hashedrekord.json`: a real `rekor.sigstage.dev` entry; copy it byte for byte.
- For context only (A15.5 ports these): `adapters/anchor/{base,rekor,tsa,rfc3161}.py`, `tests/unit/anchor/test_anchor_rekor.py`, `tests/unit/anchor/test_anchor_tsa.py`.
- Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` EV-2.
- TrackAI: `apps/api/src/features/attesta/{canonical,merkle}.ts` (reuse `canonicalize`, `leafHash`, `merkleRoot`, `inclusionPath`; do not reimplement them).

## 2. Scope (approved)
### 2.1 Decisions
1. **Files:**
   - `apps/api/src/features/attesta/testing/fetch-like.ts`: `export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>`. The A15.5 adapters will take an injectable `FetchLike`; the fakes provide one.
   - `apps/api/src/features/attesta/testing/fake-rekor.ts`, `apps/api/src/features/attesta/testing/fake-tsa.ts`.
   - Tests at the top level so the existing glob runs them: `apps/api/src/features/attesta/fake-rekor.test.ts`, `apps/api/src/features/attesta/fake-tsa.test.ts`.
   - `apps/api/src/features/attesta/vectors/rekor/sigstage_hashedrekord.json` (copied byte for byte).
2. **Dependencies (founder-approved by merging this prompt; exact versions, `--save-exact -w apps/api`, in `dependencies` because A15.5 uses them at runtime):** `@noble/curves@2.4.0`, `pkijs@3.4.1`, `asn1js@3.0.10`. No others. `@noble/curves` is needed because Node's `crypto.verify` cannot check an ECDSA signature against a precomputed digest (Rekor's `hashedrekord` gives only the digest).
3. **`FakeRekor`** (Rekor v1 API, `hashedrekord` only), constructor `new FakeRekor()`:
   - Constants as in the source: `TREE_ID = 0x1122334455667788n` (write the entry ID prefix as 16 lowercase hex digits), `HOST = 'rekor.local'`, clock starting at `1_790_000_000` and increasing by one per new entry.
   - Fields: `logKey` (P-256 `KeyObject` pair), `checkpointKey` and `setKey` (default to `logKey`; tests swap them to forge), `bodies: Buffer[]`, `integrated: number[]`, `posts`, `down`, `failStatus: number | null`, `tamper: ((entryId: string, entry: Record<string, unknown>) => void) | null`, `omitLocation`.
   - `readonly fetch: FetchLike` routes:
     - `POST /api/v1/log/entries`: verify the signature in `spec.signature.content` (base64 DER) with the public key in `spec.signature.publicKey.content` (base64 of a PEM) over the digest in `spec.data.hash.value` (hex), using `p256.verify(sig, digest, publicKeyRaw, { prehash: false, lowS: false, format: 'der' })` from `@noble/curves/nist.js` (`lowS: false` matters: OpenSSL signatures are not normalized to low-S). Any failure → 400 `{code: 400, message: 'validation: …'}`. Body bytes = `canonicalize(proposed)`; UUID = hex `leafHash(body)`; entry ID = 16-hex `TREE_ID` + UUID. A body already present → 409 with header `Location: /api/v1/log/entries/<entryId>` (absent when `omitLocation`) and the source's message. Otherwise append, advance the clock, 201 `{[entryId]: entry}`.
     - `GET /api/v1/log/entries/{uuid|entryId}` (case-insensitive) → 200 `{[entryId]: entry}` or 404.
     - `GET /api/v1/log` → `{treeSize}`; `GET /api/v1/log/publicKey` → PEM of the log key; anything else 404.
     - `down` → the returned promise rejects with `new TypeError('fetch failed')` (what Node's `fetch` throws when a host is unreachable). `failStatus` → that status with `{code, message: 'boom'}`.
   - Entry exactly as `_entry` in the source: `body` (base64 of the stored bytes), `integratedTime`, `logID` (hex SHA-256 of the log key's DER SPKI), `logIndex`; `verification.signedEntryTimestamp` = base64 of `setKey` signing `canonicalize({body, integratedTime, logID, logIndex})` (SHA-256, DER); `verification.inclusionProof` = `{checkpoint, hashes (hex, from inclusionPath), logIndex, rootHash (hex, merkleRoot over all bodies), treeSize}`; then `tamper(entryId, entry)` if set.
   - Checkpoint string exactly: `` `${HOST} - ${TREE_ID decimal}\n${size}\n${base64(root)}\nTimestamp: 1\n` `` + `\n` + `` `— ${HOST} ${base64(hint ‖ sig)}\n` `` where `hint` = first 4 bytes of SHA-256(DER SPKI of `checkpointKey`) and `sig` = `checkpointKey` signing the note text (SHA-256, DER). Note the em dash `—`.
   - Note: `merkleRoot`/`inclusionPath` hash leaf data themselves (they take bodies, not leaf hashes). Confirm the root equals the source's `mth([leaf_hash(b) …])` in a test.
4. **`FakeTsa`** (RFC 3161 over HTTP), constructor `await FakeTsa.create(options?)` (async because pkijs signing uses WebCrypto):
   - Set the pkijs engine once from Node's `crypto.webcrypto` (`pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }))`).
   - On creation: a self-signed root CA (P-256, `BasicConstraints ca=true` critical, valid −30 days … +3650 days) and a TSA certificate issued by it (P-256 by default, `BasicConstraints ca=false` critical, EKU `id-kp-timeStamping` (1.3.6.1.5.5.7.3.8) critical, valid −1 day … +365 days, CN `Fake TSA Unit 1`). Export `makeCa()` and `makeTsaCert(issuerKey, issuerCert, opts)` with the source's options (`key`, `eku` (empty array = no EKU), `ekuCritical`, `notBefore`, `notAfter`, `ca`, `cn`), and `anchorsPem` (the root as PEM).
   - Constants: `URL = 'http://tsa.test/tsr'`, `POLICY = '1.3.6.1.4.1.99999.1'`, serial starting at 1000 and increasing per token.
   - Knobs (same names in camelCase, same defaults): `chain` (extra certificates in the token), `down`, `httpStatus` (200), `contentType` (`application/timestamp-reply`), `status` (`'granted'`, otherwise a reply with only a `PKIStatusInfo` of that status), `includeCerts` (true), `essV1` (false: use ESS signing-certificate-v2 with SHA-256; true: v1 with SHA-1), `omitEss`, `genTime` (default now, whole seconds, UTC), `imprintOverride`, `nonceOffset`, `corruptSignature` (flip the last bit of the signature), `contentTypeAttr` (`'tst_info'`, i.e. OID 1.2.840.113549.1.9.16.1.4), `digestOverride`, `essCert` (name another certificate in the ESS attribute), `tamper((tstFields) => void)`, `posts`. Optional RSA key for the TSA certificate (`sha256WithRSAEncryption`), as in `test_ess_v1_rsa_and_intermediate_chain`.
   - `readonly fetch: FetchLike`: `GET` → 405; `POST` parses a DER `TimeStampReq` and replies with DER `TimeStampResp` (content type header from the knob); `down` and `httpStatus` as for Rekor.
   - `token(digest, algorithm = 'sha256', nonce?)`: CMS `SignedData` v3 over an encapsulated `TSTInfo` v1 (policy, message imprint, serial, genTime, `tsa` directory name, nonce + `nonceOffset` when the request had one), signed attributes content-type, message-digest (SHA-256 of the TSTInfo DER, or `digestOverride`) and ESS, signer identified by issuer and serial, signature over the DER `SET OF` signed attributes; certificates included unless `includeCerts` is false.
5. **Tests** (node:test, in-process, no network). They prove each fake does what A15.5's tests will rely on:
   - Rekor: a P-256 signature over a 32-byte Merkle root, submitted as `hashedrekord`, returns 201; its inclusion proof verifies with `verifyInclusion` against `rootHash`; the checkpoint signature verifies with the log key and its hint matches; the SET verifies over the canonical entry; resubmission → 409 with `Location` (and without, under `omitLocation`); a high-S signature is accepted (normalize one and check); a wrong digest or foreign key → 400; GET by UUID and by entry ID; `treeSize` grows; `publicKey` returns the PEM; `down` rejects with `TypeError`; `failStatus` returns that status; swapping `checkpointKey` / `setKey` produces signatures that do **not** verify with the log key; `tamper` changes exactly what it mutates. The sigstage vector loads, its `entry_id` equals the 16-hex tree prefix plus hex `leafHash(base64-decoded body)`, and the fake's entry has the same field names and types as the vector's entry.
   - TSA: a `TimeStampReq` for a SHA-256 digest with a nonce returns `granted`; pkijs parses the token; the TSTInfo imprint and nonce match; the signer certificate chains to the root and has the critical timeStamping EKU; the CMS signature verifies (pkijs `SignedData.verify` with the TSTInfo as data and the root as trusted certificate); then one test per knob proving it produces exactly its defect (`imprintOverride`, `nonceOffset`, `corruptSignature`, `contentTypeAttr`, `digestOverride`, `omitEss`, `essV1`, `essCert`, `includeCerts: false`, `status: 'rejection'`, `httpStatus`, `contentType`, `down`, `genTime`, `tamper`, an RSA TSA key, an extra intermediate in `chain`).
6. **Register tests:** none needed: `src/features/attesta/*.test.ts` already runs the two new top-level test files. Do not edit the `test` script.

### 2.2 Port from
SushiCorp `tests/unit/anchor/fake_rekor.py`, `tests/unit/anchor/fake_tsa.py` and `rekor_vectors/sigstage_hashedrekord.json` @ `0bd67a5` (catalog EV-2). Translate httpx `MockTransport` into a `FetchLike` and `asn1crypto`/`cryptography` into pkijs/asn1js/node:crypto/@noble/curves. Header comment in each file: `Ported from SushiCorp tests/unit/anchor/<file> @ 0bd67a5 (catalog EV-2)` plus one line per deviation. Behaviour, constants, string formats and knob semantics stay the same.

### 2.3 Pre-approved files
The files in decision 1, `apps/api/package.json` and `package-lock.json` (the three dependencies only), `docs/handoffs/Task15e-attesta-fakes_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row), `docs/plan/TASK15.md` (A15.4 status only).

### 2.4 Never touch
Everything else, including the merged Attesta files (`canonical.ts`, `merkle.ts`, `dsse.ts`, `signer-*.ts`: import, never edit), anything Task15c creates (`docs/contracts/attesta/`, `outbox.ts`, migrations, `schema.ts`), `core/`, `docs/contracts/`, `apps/web/`. If something seems to need another file, stop and describe it.

## 3. Working rules
- Commits `Task15e-attesta-fakes: …`, explicit `git add <path>`: vector and dependencies first, then Rekor (fake and tests), then TSA (fake and tests).
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean. Integration tests: none.
- These fakes exist to catch a lying log in A15.5: for every knob, ask "would a real verifier notice this?" and make the test prove the defect is really present in the bytes, not only that the knob was set.
- Re-read your full diff as a reviewer before the handoff (AGENTS.md §12.3).

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 70 lines, with "Ported from", every deviation, test counts and Effort.
- Status board row; `TASK15.md` A15.4 status 🟡 (merged makes it ✅).
- Clean tree; do not push.
- Final reply in the AGENTS.md §12.4 shape, with the review request in a `text` block naming branch and commit.

## Lessons so far
- **Task15a (Muse):** validate and use the same data (a getter or proxy can change between two reads); refuse sparse arrays explicitly; record every deviation in the header and the handoff.
- **Task15b (Muse):** check what a component returns, not only that it returned (key type, algorithm, identifiers); malformed output is a failure, never a pass.
- **Both:** ESM-only packages load through `require(esm)` in the CommonJS build (Node ≥ 20.19); check the built `dist` once if a new package is ESM-only.
