# Handoff prompt: Task15f-attesta-anchoring (Rekor + RFC 3161 anchoring of ledger batches), Claude

> **Founder setup (Claude: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only`.
> 2. **Claude:** open a new chat in the TrackAI Claude project, link it to this Mac, paste everything below the line. It can run at the same time as `Task15h-attesta-builder` (Claude) and `Task15g-attesta-kms` (Muse): no shared files.
> 3. Checkpoint: after its design summary (step 2.2) it stops for your "go".
> 4. When it finishes, paste its review request to **Codex** (security-critical verification; Muse if Codex is busy). Push only after "ready to push". The real Rekor staging and FreeTSA runs are later founder-live gates (A15.13), not this session.

---

You are **Claude**, building **Task15f-attesta-anchoring** (subtask A15.5) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI. Attesta's ledger (A15.3) makes tampering *inside* TrackAI detectable; anchoring makes it detectable by *anyone*: each batch of ledger records becomes an RFC 6962 Merkle root, timestamped by an RFC 3161 authority and logged in Sigstore's public Rekor log, so even TrackAI could not later rewrite history unnoticed. **Only the 32-byte root ever leaves the tenant.** The Merkle primitives (A15.1) and the lying fakes of Rekor and a TSA (A15.4) are merged. This session builds the two adapters, the batching worker and the anchor tables, and extends `verifyChain` with anchor checks. No routes (A15.9), no real network (A15.13).

- **Repo:** `~/AIProjects/TrackAI-v1` (`main`, read-only). Work in a clone in the cloud workspace; bundles in `~/AIProjects/_bundles` (`CLAUDE.md`). Branch `task/Task15f-attesta-anchoring`.
- **Handoff:** `docs/handoffs/Task15f-attesta-anchoring_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full (§1, §5a, §7, §9 items 3, 4, 16–21, §12.4) and `CLAUDE.md`.
2. One request to the founder for folder access to `~/AIProjects/TrackAI-v1`, `~/AIProjects/_bundles` and, read-only, `~/dev/sushicorp`, `~/dev/agent-kit` (plus delete permission on `_bundles`). Clone `main`, `npm ci`, `npm test` once (444 expected); install `postgresql-16-pgvector`.
3. Estimate one line against T6. The plan says **about 0.3×** (0.25× in the tracker; Task15d ran 0.3× for a migration + guards + logic). If you expect more than 0.35×, propose a split at the checkpoint (adapters first, worker and tables second).

## 1. Read before writing
- **Binding:** `docs/contracts/attesta/tables.md` §`attesta_anchor_batches` and `attesta_anchors` (columns, `batch_id` form, EV-2 v1 proof JSON, one `anchored` row per record and type, plan → submit → record), `errors.md` §Anchoring and §Verification (including the codes added 2026-10-12), `README.md`; `TASK15.md` §2 decision 5 and §6.
- **Merged code:** `features/attesta/{merkle,canonical,signer-contract,signer-local-dev,ledger,verify-chain}.ts`; `features/attesta/testing/{fetch-like,fake-rekor,fake-tsa}.ts` and their tests (the knobs are your adversary list); `vectors/rekor/sigstage_hashedrekord.json`.
- **Handoffs:** `Task15d-attesta-ledger_HANDOFF.md`, `Task15e-attesta-fakes_HANDOFF.md`.

## 2. Scope (approved)
### 2.1 Deliverables
1. **Rekor adapter** `anchor-rekor.ts` (v1 API, `hashedrekord`, injectable `FetchLike`): submit a signed root (idempotent on `batch_id`: a 409 resolves to the existing entry, with or without `Location`); verify every answer before storing it: entry body binds our digest, signature and key; SET over the canonical entry; inclusion proof up to `rootHash` (`rootFromPath`); checkpoint signature with the **pinned log key** (production refuses to run without one: `ATTESTA_ANCHOR_LOG_KEY_NOT_PINNED`; trust-on-first-use only outside production); unreachable or 5xx → `ATTESTA_ANCHOR_LOG_UNAVAILABLE`, **never a pass**. Verify the real sigstage vector and each tamper of it offline.
2. **TSA adapter** `anchor-tsa.ts` (RFC 3161 over HTTP, pkijs/asn1js): request with a random nonce and `certReq`; check status, imprint, nonce, TSTInfo version, CMS signature, signed attributes (content type, message digest), ESS v1/v2 naming the signer, chain to pinned anchors, critical timeStamping EKU, certificate validity **at genTime**, and **genTime bounded** to the request window (a SushiCorp gap to close). Revocation of the TSA certificate follows TR-1's three states: REVOKED / CLEAN / UNKNOWN, and **UNKNOWN is never CLEAN** (AGENTS.md §9 item 19); if no revocation source is configured, record UNKNOWN and say so in the proof, never "valid". Bounded caches.
3. **Dual mode:** both anchors or none (all-or-nothing per batch); a partial result is recorded as `failed` for the missing type and retried.
4. **Anchoring key:** the Rekor entry must be signed by a key. Recommendation for the checkpoint: one **platform anchoring credential** (not a tenant key, so Rekor never reveals which tenant anchored), through the `SigningAdapter` contract with a reserved platform tenant ID, `LocalDevSigner` in dev; record the decision.
5. **Migration** (next free number, `0018` at the time of writing) for `attesta_anchor_batches` and `attesta_anchors` exactly as `tables.md`, append-only guards in the 0017 style (`SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`), partial unique index for one `anchored` row per record and type, checks (`anchored` needs a proof, `failed` an `error_code`), RLS on with no policies, composite tenant keys, Company A/B.
6. **Worker** `anchor-worker.ts`: `runAnchorPass(db, deps, { now, maxBatch, windowMs })` per tenant: **plan** (read: unanchored records → deterministic `batch_id` and root over the 32 raw bytes of each `record_hash`) → **submit** (network, no transaction, no chain lock; AGENTS.md §9 item 18) → **record** (write batch, per-record proofs, anchors). Retries are idempotent on `batch_id`. Anchoring never touches `attesta_records` and never changes `record_hash`. CLI `npm run attesta:anchor -w apps/api` for one pass.
7. **Verify report:** extend `verify-chain.ts` with the anchor checks (`ATTESTA_VERIFY_MERKLE_PROOF_INVALID`, `ANCHOR_INVALID`, `ANCHOR_MISSING` for a record older than the window) offline from stored proofs, and switch `BREAK_DETAIL_CODES` to the exact codes added to `errors.md` on 2026-10-12 (seq, field, tenant, order, head, envelope, signatures-not-checked).

### 2.2 Design checkpoint (stop once)
Send the founder: the anchoring key decision (item 4), batch size and window defaults, the TSA revocation approach for phase 1 (likely UNKNOWN with no OCSP/CRL source, shown honestly), and whether Rekor v2 (tile-based) is deferred (recommendation: defer, record it). Wait for "go".

### 2.3 Port from
- Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` EV-2 and TR-1.
- SushiCorp @ `0bd67a5`: `adapters/anchor/{base,rekor,tsa,rfc3161,dual,keys,registry,rfc6962}.py` (73/464/159/428/87/159/89/49 lines), `core/evidence/anchoring.py` (529), `services/anchoring/{service,verifier,export}.py` (255/61/103), `core/trust/{revocation,verdict,trust_list,resolver}.py`; tests `tests/unit/anchor/{test_anchor_rekor,test_anchor_tsa,test_anchor_keys_registry}.py`, `tests/unit/anchoring/test_anchoring_service.py`, `tests/unit/evidence/test_evidence_anchoring.py`, `tests/integration/anchor/{test_it_a2_rekor,test_it_a2b}.py`; handoffs `MODULE_A2_HANDOFF.md`, `MODULE_A2b_HANDOFF.md`. Port the tests first (lesson from adopt-agent-kit), against the TrackAI fakes.
- Keep: every check the source makes, the lying-log cases, idempotency on `batch_id`, plan/submit/record. Close while porting: genTime bound, bounded caches, TSA revocation as three-state. Record provenance and every deviation.

### 2.4 Pre-approved files
`apps/api/src/core/db/schema.ts` (the two anchor tables only), one new migration with its `meta/` snapshot, `apps/api/src/features/attesta/{anchor-rekor,anchor-tsa,anchor-dual,anchor-worker}.ts` with tests, `verify-chain.ts` and its test (anchor checks and the code switch), a CLI and a live verifier `t15f-anchoring-live-verify.ts`, `apps/api/package.json` (scripts only), `docs/handoffs/Task15f-attesta-anchoring_HANDOFF.md`, `docs/plan/STATUS_BOARD.md`, `docs/plan/TASK15.md` (A15.5 status).

### 2.5 Never touch
`docs/contracts/` (frozen), merged migrations (`0016`, `0017`), `ledger.ts`, `outbox.ts`, the fakes under `testing/` (import, never edit; if one is wrong, report it), the builder and worker files Task15h creates (`builder.ts`, `worker.ts`, `signer-resolver.ts`), Task2/Task4 files, `apps/web/`, dependencies (`pkijs`, `asn1js`, `@noble/curves` are already there).

## 3. Working rules
- Commits `Task15f-attesta-anchoring: …`: ported tests; Rekor adapter; TSA adapter; dual; migration and guards; worker; verify report.
- **Unit:** every fake knob from `fake-rekor.ts` and `fake-tsa.ts` makes the adapter fail with the right code (lying log, foreign checkpoint key, forged SET, tampered body, wrong imprint, nonce, ESS, EKU, untrusted chain, corrupt signature, down, 5xx, rejection status); the sigstage vector verifies and its tampers fail; an unreachable log is never a pass.
- **Independent oracle (Task15e lesson):** where OpenSSL is on PATH, `openssl ts -verify` must agree with the TSA adapter on a good token and on corrupted ones (skip when absent).
- **Live (`scripts/it-db.sh`):** `IT-T15f-01` a chain of N records anchors in one pass with both fakes; proofs stored; `verifyChain` reports anchored and `ok`; a second pass adds nothing. `IT-T15f-02` the fake log lies (one knob per case) → `failed` with the right code, record untouched, retried later. `IT-T15f-03` guards on the anchor tables as the API role; one `anchored` row per record and type. `IT-T15f-04` Company A/B: a batch never mixes tenants; each tenant's verify is clean.
- One **review subagent** before the handoff, attacking the verification code first (what answer from a malicious log or TSA would this accept?).

## 4. Close-out
- Handoff under 80 lines: interfaces, the checkpoint decisions, the adversary table with tests, Integration test impact, the founder-live steps that remain for A15.13, Effort.
- `TASK15.md` A15.5 🟡; status board and registry rows. Bundle; PR via `git show <branch>:<handoff> | gh pr create … --body-file -`. Final reply in the AGENTS.md §12.4 shape; review request for Codex in a `text` block.

## Lessons so far
- **Task15e (Muse):** a fake mirrored by its own test passed while wrong; OpenSSL caught it. Verify against an independent oracle.
- **Task15d (Claude):** a definer function with `public` in its `search_path` can be hijacked; use `pg_catalog, pg_temp`. The review round cost a fifth of the session; budget for it.
- **Task15b (Muse):** check every claim the other side returns; malformed output is a failure, never a pass.
