# Handoff prompt: Task20c-endpoint-trust-verifier (Rust port of the trust verifier, proven by 82 vectors), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge this prompt's docs PR. Then `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only` and `cd ~/AIProjects/git-ai && git checkout main && git pull --ff-only`.
> 2. `cd ~/AIProjects/TrackAI-v1 && make gitai-worktree M=Task20c-endpoint-trust-verifier && cd ~/AIProjects/TrackAI-wt/Task20c-endpoint-trust-verifier-gitai && opencode`. Pick Muse Spark, keep permission prompts on, and paste everything below the line. Reply "continue" if it stops.
> 3. Run Muse sessions one at a time: start this one after Task20d's PR merged (order Task20b → Task20d → Task20c).
> 4. Paste its review request to **Codex** (GitAI owner). This is signing-related, so after Codex says "ready to push", also paste it to the **Task20 lead (Claude)**. Push only after both say "ready to push".

---

You are **Muse**, building **Task20c-endpoint-trust-verifier** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product built on a fork of Git AI.

The TrackAI server signs documents for developer machines with platform keys from Attesta's trust layer (Task15l). The TrackAI **Endpoint** must check them before it acts: a rule bundle (`policy_bundle`), an activation lease (`activation_lease`) and a fleet configuration (`fleet_config`). Today the Endpoint has no real verifier; production uses `UnavailableVerifier` (`src/fleet/mod.rs:221-230`).

This session ports TrackAI's TypeScript `verifyTrusted` to Rust as a **pure library**, `src/trust/`. Success is objective: for every one of the 82 cross-language vectors, it returns exactly the same `status` and `code`, and the same `keyid`, `trusted` and `trusted_time` where a vector states them.

It does **not** wire the verifier into the fleet, the daemon or security code, persist trust state, read a clock, or touch the network; Task20g does the wiring.

- **Repository:** GitAI fork. **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task20c-endpoint-trust-verifier-gitai`, branch `task/Task20c-endpoint-trust-verifier-gitai`.
- **Handoff:** returned in your final reply (no TrackAI files in GitAI).
- **Naming:** "the Endpoint" for what runs on a machine; "GitAI" only for this repository.

## 0. Before anything else
1. Read TrackAI's `AGENTS.md` (`git -C ~/AIProjects/TrackAI-v1 show main:AGENTS.md`), especially §1, §2 "Names", §5a, §9 items 14, 19 and 20, §12.1 and §12.4. Then read this repository's `AGENTS.md` and `Taskfile.yml`.
2. Check location and identity: `pwd && git branch --show-current && git log --oneline -1`. Set `mahamannu-ux` / `mahamannu@gmail.com` for this worktree only.
3. Baseline: `task build`, then `cargo test --lib fleet` once.
4. Estimate: one line against T6. The plan says **about 0.15×**.

## 1. Read before writing (all TrackAI files read-only, from `main`)
Read each with `git -C ~/AIProjects/TrackAI-v1 show main:<path>`:
- `docs/contracts/attesta/trust.md`: the whole of it, especially "Verification" (the numbered steps), "Time evidence", "Consumers" and "Vectors";
- `docs/contracts/attesta/trust-document-v1.schema.json`, `docs/contracts/attesta/envelope.md` (DSSE and PAE) and `docs/contracts/attesta/errors.md` §"Trust (A15.12)";
- the TypeScript you port, line by line:
  - `apps/api/src/features/attesta/trust-contract.ts` (types, codes, limits);
  - `trust-verify.ts` (393 lines);
  - `trust-documents.ts` (400 lines);
  - `canonical.ts` (RFC 8785);
  - `dsse.ts` (`pae`);
- the vectors: `apps/api/src/features/attesta/vectors/trust/*.json` (82 vector files plus `keys.json`; `generate.ts` shows how they were made, but do not port it).

## 2. Scope (approved by the founder)
### 2.1 Decisions (all made)
1. **Module layout:** `src/trust/mod.rs` (public types and `verify_trusted`), `src/trust/documents.rs` (parsing, signature checks, forward-only rules), `src/trust/verify.rs` (the numbered steps of trust.md "Verification", in order, with a comment naming each step), `src/trust/dsse.rs` (PAE, the envelope struct). Add `pub mod trust;` to `src/lib.rs` (or wherever modules are declared). Nothing else imports it in this session.
2. **Public API**, mirroring `trust-contract.ts` names in snake_case:
   ```rust
   pub fn verify_trusted(input: &VerifyTrustedInput) -> TrustVerdict;
   pub struct VerifyTrustedInput { pub payload_type: String, pub payload: Vec<u8>, pub envelope: DsseEnvelope,
       pub purpose: ArtifactPurpose, pub audience: String, pub signed_at: String,
       pub time_evidence: Option<TimeEvidence>, pub state: TrustState }
   pub struct TrustVerdict { pub status: TrustStatus, pub code: TrustCode, pub keyid: Option<String>,
       pub trusted: Option<BTreeMap<String, TrustedDocumentRef>>, pub trusted_time: Option<String> }
   ```
   - `TrustState`, `TrustedDocumentRef`, `TimeEvidence`, `CustomerPinnedKey`, `DsseEnvelope`, `TrustStatus`, `TrustCode` (all 20 codes, with the same status mapping as `TRUST_CODE_STATUS`), `ArtifactPurpose` and `KeyPurpose` derive `serde::{Serialize, Deserialize}`, so that Task20g can persist `last_trusted` and `trusted_time_floor` and the vectors deserialize directly.
   - Use the vectors' own snake_case field names for serde, and `rename_all` where the TypeScript names differ.
3. **Pure and total:**
   - `verify_trusted` never panics and never returns `Err`. Every malformed input maps to the same code the TypeScript returns.
   - No `unwrap`/`expect` outside tests; no clock (it uses `state.now`), no file, no network, no environment variable.
   - `production` comes only from `state.production`. The doc comment states that shipped consumers hard-code `true` (trust.md "Consumers").
4. **Crypto and encoding:** ECDSA P-256 over SHA-256, signatures in DER, public keys as SPKI DER in standard base64, exactly as `trust-documents.ts` does with Node's `crypto.verify`.
   - Add `p256 = { version = "0.13", default-features = false, features = ["ecdsa", "pkcs8", "std"] }`, plus `base64 = "0.22"` if it is not already a direct dependency (it is in `Cargo.lock`). Both are pre-approved; add nothing else.
   - Base64 decoding is **strict**, like `decodeBase64Strict`: canonical padding, and no whitespace or URL-safe alphabet.
   - If a vector shows a difference between Node's and `p256`'s signature acceptance (for example high-S signatures), **match the vector** and say so in the handoff. Never change a vector.
5. **Canonical JSON:** use the existing `serde_json_canonicalizer` dependency for RFC 8785. Refuse integers beyond ±(2^53 − 1), non-finite numbers and duplicate keys where the TypeScript refuses them (AGENTS.md §9 item 20). Digests are `sha256:` + lowercase hex of the exact bytes, never of a re-serialization.
6. **Time:** parse RFC 3339 UTC with `chrono`, as the TypeScript does, with the same strictness (it rejects what `Date.parse` would round). The clock skew default is 300 000 ms; `CLOCK_BEHIND` follows `trustedTimeFloor`.
7. **Vectors:** copy all 82 `NN-*.json` files and `keys.json` byte for byte into `tests/fixtures/trust/`. Add `tests/fixtures/trust/SOURCE.md` naming the TrackAI repository, path and commit (`git -C ~/AIProjects/TrackAI-v1 rev-parse main`). Then add `tests/trust_vectors.rs`, which:
   - loads every vector and fails if the count is not 82;
   - asserts `status`, `code` and, when `expected` has them, `keyid`, `trusted` and `trusted_time`;
   - prints the vector name on failure.
8. **Extra tests** in `src/trust/` (unit tests):
   - truncated or garbage envelopes, payloads over 16 MiB, unknown purposes and an empty signature list each return their documented code without panicking;
   - `verify_trusted` is deterministic: same input, same verdict.

### 2.2 Port from
- **Source:** TrackAI `apps/api/src/features/attesta/trust-{contract,verify,documents}.ts`, `canonical.ts`, `dsse.ts` at TrackAI `main` (record the commit). Those files were themselves ported from SushiCorp B4 `core/trust/{revocation,verdict}.py` @ `0bd67a5` (catalog TR-1), so keep their header provenance line.
- **Keep:** the step order of trust.md "Verification", every code and its status, the rule that UNKNOWN never becomes CLEAN (`unavailable` is never `verified`), forward-only key sets, and anchoring to `last_trusted`.
- **Translate:** Node `crypto` to `p256`, and `Buffer` to `Vec<u8>`.
- Put a header comment in each new file: `Ported from TrackAI <path> @ <commit> (Task15l, trust.md); behaviour fixed by tests/fixtures/trust vectors.`

### 2.3 Pre-approved files
- `src/trust/**`, `src/lib.rs` (one `pub mod trust;` line), `Cargo.toml` and `Cargo.lock` (the two crates above only), `tests/trust_vectors.rs`, `tests/fixtures/trust/**`

### 2.4 Never touch
- `src/fleet/**`, `src/security/**`, `src/daemon*`, packaging, workflows, TrackAI. If the port seems to need a change elsewhere, stop and describe it.

## 3. Working rules
- Commits `Task20c: …`, one per stage:
  1. the types and a `verify_trusted` that returns `INPUT_INVALID` for everything, plus the vector harness (it fails, as expected);
  2. documents and signatures;
  3. the verification steps until all 82 vectors pass;
  4. the extra tests.
- Gates: `cargo test --test trust_vectors`, `cargo test --lib trust`, `task lint`, `task fmt` (or `cargo fmt --check`). Inherited Clippy or flaky `daemon_mode` noise is not yours (AGENTS.md §9 item 14); say so if you see it.
- **Independent review:** re-read the full diff against `trust-verify.ts` step by step before the final reply.

## 4. Close-out
- **Final reply** in the AGENTS.md §12.4 shape:
  1. **Effort** against 0.15×.
  2. **The handoff text** (under 70 lines), naming:
     - the public API;
     - every vector you found hard and why;
     - any Node/`p256` difference you met;
     - "GitAI backlog row G8 closed by this PR" (the Task20 lead updates TrackAI's `GITAI_FUTURE_TODO.md`).
  3. **One numbered bash block:**
     - `# 1.` cd to the worktree;
     - `# 2.` `cargo test --test trust_vectors` (expect 1 test, 82 vectors);
     - `# 3.` `task lint`;
     - under `# after the cross-agent review`: push, `gh pr create --base main --head task/Task20c-endpoint-trust-verifier-gitai --title "[Task20c] Endpoint trust verifier" --body "<handoff text>" --repo mahamannu-ux/git-ai`, a trial merge of `origin/main`, and `gh pr merge … --merge`.
  4. **The review request** in a `text` block, addressed to Codex, then the Task20 lead.
- Clean tree. Do not push, open a PR or merge.

## Lessons so far
- **Task15j (Muse, offline verifier):** two review rounds came from re-deriving behaviour instead of following the TypeScript line by line. Port step by step, and let the vectors decide.
- **Task15l (Claude):** a missing piece of trust information is `unavailable`, and tampering is `rejected`; never collapse the two.
