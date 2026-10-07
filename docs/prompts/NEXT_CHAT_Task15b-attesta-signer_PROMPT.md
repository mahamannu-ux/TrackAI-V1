# Handoff prompt: Task15b-attesta-signer (signer contract and local dev signer), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Merge the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15b-attesta-signer && cd ~/AIProjects/TrackAI-wt/Task15b-attesta-signer && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line. It can run at the same time as Task15a (different files; one identical line in `apps/api/package.json`).
> 3. When it finishes, paste its review request to the Task15 lead Claude chat (or Codex if Claude is busy). Push only after "ready to push".

---

You are **Muse**, building **Task15b-attesta-signer** for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product. Attesta (Task15, `docs/plan/TASK15.md`) signs provenance statements with tenant-controlled keys and **never holds a customer's private key in production**. This session defines the signer contract every signer implements and a local development signer. KMS signers come in a later session. **Every decision is made below; do not redesign.** No database, no routes, no new dependencies.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15b-attesta-signer`, branch `task/Task15b-attesta-signer`.
- **Handoff:** `docs/handoffs/Task15b-attesta-signer_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §5a, §6, §9, §11, §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`: you must be in the worktree above on `task/Task15b-attesta-signer`; otherwise stop. `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (150 pass expected).
4. Estimate one line against T6; the plan says **about 0.05×**.

## 1. Read (source of the port, read-only)
`git -C ~/dev/sushicorp show 0bd67a5:<path>` for `adapters/signing/base.py` (contract rev 1.1), `adapters/signing/local_dev.py`, `tests/unit/signing/test_signing_local_dev.py`, and `docs/handoffs/MODULE_A1_HANDOFF.md`. Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` SG-1.

## 2. Scope (approved)
### 2.1 Decisions
1. **Files:** `apps/api/src/features/attesta/signer-contract.ts`, `apps/api/src/features/attesta/signer-local-dev.ts`, `apps/api/src/features/attesta/signer.test.ts`.
2. **`signer-contract.ts`** (translate SushiCorp's rev 1.1; X.509 chains become optional):
   ```ts
   export class SigningError extends Error {}            // never thrown directly
   export class SigningUnavailable extends SigningError {} // retryable: network, timeout, rate limit, KMS down
   export class SigningRejected extends SigningError {}    // terminal: unknown/expired/revoked credential, bad payload, denied
   export type SigningAlgorithm = 'ES256';               // ECDSA P-256 + SHA-256, DER signatures
   export interface SigningCredential { credentialId: string; tenantId: string; displayName: string; algorithm: SigningAlgorithm; publicKeySpkiDer: Buffer; notBefore?: string; notAfter?: string /* RFC 3339 */ }
   export interface SigningCapabilities { adapterName: string; algorithms: readonly SigningAlgorithm[]; maxPayloadBytes: number; supportsCredentialListing: boolean }
   export interface SigningResult { signature: Buffer; algorithm: SigningAlgorithm; credentialId: string; publicKeySpkiDer: Buffer }
   export interface SigningAdapter {
     capabilities(): SigningCapabilities;
     sign(payload: Buffer, credentialId: string, opts: { requestId: string }): Promise<SigningResult>;
     listCredentials(tenantId: string): Promise<SigningCredential[]>;   // [] when listing is unsupported, never throws for that
     publicKey(credentialId: string): Promise<Buffer>;                  // SPKI DER; public only; SigningRejected if unknown
     health(): Promise<boolean>;                                        // never signs
   }
   export async function signVerified(adapter: SigningAdapter, payload: Buffer, credentialId: string, requestId: string): Promise<SigningResult>
   ```
   `signVerified` calls `sign`, then fetches `publicKey(credentialId)`; throws `SigningRejected` if the result's key differs from it (byte compare) or the signature does not verify over `payload` with that key (`crypto.verify('sha256', payload, {key, dsaEncoding: 'der'}, sig)`); re-throws `SigningUnavailable`/`SigningRejected` unchanged and wraps any other error as `SigningUnavailable`. The header says the contract is frozen once merged, and the "no custody" principle in one paragraph, plus `Ported from SushiCorp A1 adapters/signing/base.py rev 1.1 @ 0bd67a5 (catalog SG-1)` and the deviations (no certificate chain, async, ES256 only, tenant on the credential).
3. **`signer-local-dev.ts`:** `export class LocalDevSigner implements SigningAdapter`.
   - Constructor `new LocalDevSigner({ credentials: { credentialId: string; tenantId: string; displayName?: string; privateKeyPem: string }[], env?: NodeJS.ProcessEnv })`; throws `SigningRejected('LocalDevSigner refuses to run in production')` when `env.NODE_ENV === 'production'` (default `process.env`).
   - Credential IDs must start with `dev:`; keys must be P-256 (`crypto.createPrivateKey`, check `asymmetricKeyDetails.namedCurve === 'prime256v1'`), else throw `SigningRejected` at construction.
   - `capabilities()`: `{ adapterName: 'local-dev', algorithms: ['ES256'], maxPayloadBytes: 1_048_576, supportsCredentialListing: true }`.
   - `sign`: `SigningRejected` for unknown credential, empty payload, payload over the limit, or a non-Buffer payload; signature with `crypto.sign('sha256', payload, { key, dsaEncoding: 'der' })`; never logs payloads or keys; `SigningResult` contains no private material.
   - `listCredentials(tenantId)` returns only that tenant's credentials; `publicKey` returns SPKI DER; `health()` true when at least one credential loaded.
   - `export function generateDevCredential(credentialId: string, tenantId: string): { credentialId; tenantId; privateKeyPem }` for tests and local setup (P-256 via `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`).
4. **Tests** (node:test, in-process): signature verifies with the published public key; tampered payload fails; `signVerified` passes, and rejects a fake adapter that returns a signature from a different key and one that returns a mismatched public key; a fake adapter throwing a plain `Error` comes out as `SigningUnavailable`; unknown credential, empty and oversize payloads, non-Buffer payload are `SigningRejected`; non-`dev:` IDs and non-P-256 keys are refused at construction; production refusal; tenant scoping of `listCredentials` (tenant A never sees tenant B's credential); `JSON.stringify(result)` contains no `PRIVATE KEY`; capabilities as specified.
5. **Register tests:** append exactly ` src/features/attesta/*.test.ts` to the end of the `test` script in `apps/api/package.json` (Task15a makes the identical edit; git merges identical edits cleanly). If `main` already has it, leave the line alone.

### 2.2 Port from
SushiCorp A1 `adapters/signing/base.py` (rev 1.1) and `local_dev.py` with their tests @ `0bd67a5` (catalog SG-1). Deviations listed in decision 2. Record provenance in the headers and the handoff.

### 2.3 Pre-approved files
The three files in decision 1, `apps/api/package.json` (test-script edit only), `docs/handoffs/Task15b-attesta-signer_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (your row), `docs/plan/TASK15.md` (A15.2 status only).

### 2.4 Never touch
Everything else, including Task15a's files (`canonical.ts`, `merkle.ts`, `dsse.ts`), `core/`, migrations, `docs/contracts/`, `apps/web/`, `package-lock.json` (no dependency changes). If something seems to need another file, stop and describe it.

## 3. Working rules
- Commits `Task15b-attesta-signer: …`, explicit `git add <path>`: contract first, then tests, then the local signer.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean. Integration tests: none.
- Re-read your full diff as a reviewer before the handoff.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 60 lines, with "Ported from", test counts and Effort.
- Status board row; `TASK15.md` A15.2 status 🟡.
- Clean tree; do not push. Final reply in the AGENTS.md §12.4 shape with the review request in a `text` block.
