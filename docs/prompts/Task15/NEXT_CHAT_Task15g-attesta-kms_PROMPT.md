# Handoff prompt: Task15g-attesta-kms (AWS KMS and Google Cloud KMS signers), Muse

> **Founder setup (Muse: skip to "You are…"):**
> 1. Approve the two new dependencies below (`@aws-sdk/client-kms@3.1141.0`, `@google-cloud/kms@5.7.0`) by merging the PR that adds this prompt. Then:
>    `cd ~/AIProjects/TrackAI-v1 && git checkout main && git pull --ff-only && make worktree M=Task15g-attesta-kms && cd ~/AIProjects/TrackAI-wt/Task15g-attesta-kms && npm ci && opencode`
> 2. Pick Muse Spark; keep permission prompts on; allow reads of `~/dev/sushicorp` when asked (read-only); paste everything below the line. Reply "continue" if it stops. It runs alongside Task15f and Task15h (no shared files).
> 3. No cloud account is needed: everything is tested against fake KMS clients. Real AWS and Google Cloud signing is a later founder-live gate (A15.13).
> 4. When it finishes, paste its review request to the Task15 lead Claude chat. Push only after "ready to push".

---

You are **Muse**, building **Task15g-attesta-kms** (subtask A15.6) for **TrackAI**, an AI code provenance, security, attribution and engineering-productivity product. Attesta (Task15) signs provenance statements with **keys the customer holds in their own cloud KMS**; TrackAI never holds a customer's private key in production. The signer contract (`apps/api/src/features/attesta/signer-contract.ts`, frozen) and a local dev signer are merged. This session builds one KMS signer that implements that contract, with two providers: AWS KMS and Google Cloud KMS. **Every decision is made below; do not redesign.** No database, no routes, no network in tests.

- **Worktree (your whole world):** `~/AIProjects/TrackAI-wt/Task15g-attesta-kms`, branch `task/Task15g-attesta-kms`.
- **Handoff:** `docs/handoffs/Task15g-attesta-kms_HANDOFF.md`.

## 0. Before anything else
1. Read `AGENTS.md` in full, especially §1, §5a, §6, §9 items 10, 15, 19, §11, §12.4.
2. `pwd && git branch --show-current && git log --oneline -1`: you must be in the worktree above on `task/Task15g-attesta-kms`; otherwise stop. `git config user.name mahamannu-ux && git config user.email mahamannu@gmail.com` (this worktree only).
3. `npm test` once (444 expected, more if Task15f or 15h merged first).
4. Estimate one line against T6; the plan says **about 0.1×** (0.08× in the tracker, raised for two providers' error mapping).

## 1. Read
- TrackAI: `apps/api/src/features/attesta/signer-contract.ts` (the interface you implement; `signVerified` checks you), `signer-local-dev.ts` (style to match: tenant-bound `sign`, refusals, no private material in results), `signer.test.ts`; `docs/handoffs/Task15b-attesta-signer_HANDOFF.md`.
- SushiCorp @ `0bd67a5` (`git -C ~/dev/sushicorp show 0bd67a5:<path>`): `adapters/signing/kms.py` (213 lines), `kms_aws.py` (80), `kms_google.py` (53), `protocols.py`, `tests/unit/signing/test_signing_kms.py`, `docs/handoffs/MODULE_A1b_HANDOFF.md`, `docs/handoffs/MODULE_A1b_DEEP_DIVE.md`. Catalog `~/dev/agent-kit/reuse/COMPONENT_CATALOG.md` SG-1.

## 2. Scope (approved)
### 2.1 Decisions
1. **Files:** `apps/api/src/features/attesta/signer-kms.ts` (the `KmsSigner` and credential parsing), `signer-kms-aws.ts`, `signer-kms-google.ts` (providers), `signer-kms.test.ts`.
2. **Dependencies (founder-approved by merging this prompt; exact, `--save-exact -w apps/api`, in `dependencies`):** `@aws-sdk/client-kms@3.1141.0`, `@google-cloud/kms@5.7.0` (5.x because 6.x requires Node ≥ 22 and CI runs Node 20). No others.
3. **Provider interface** (in `signer-kms.ts`):
   ```ts
   export interface KmsProvider {
     readonly name: 'aws' | 'gcp';
     publicKeySpkiDer(keyReference: string): Promise<Buffer>; // DER SubjectPublicKeyInfo
     signDigest(keyReference: string, digest: Buffer, requestId: string): Promise<Buffer>; // DER ECDSA
     health(): Promise<boolean>;
   }
   ```
   - **AWS** (`AwsKmsProvider`, constructed with a `KMSClient` so tests inject a fake): `GetPublicKeyCommand` → `PublicKey` (DER SPKI); refuse unless `KeySpec === 'ECC_NIST_P256'` and `KeyUsage === 'SIGN_VERIFY'`. `SignCommand({ KeyId, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' })` → `Signature` (DER).
   - **Google Cloud** (`GcpKmsProvider`, constructed with a `KeyManagementServiceClient`): `getPublicKey({ name })` → PEM, refuse unless `algorithm === 'EC_SIGN_P256_SHA256'`; check its `pemCrc32c` against the PEM; `asymmetricSign({ name, digest: { sha256: digest }, digestCrc32c })` → refuse unless `verifiedDigestCrc32c === true`, the response `name` equals the request and `signatureCrc32c` matches the signature (implement CRC32C, Castagnoli, in the file with its known-answer test `crc32c('123456789') = 0xE3069283`; no dependency).
   - **Error mapping** (both): throttling, timeouts, network errors, 5xx, `KMSInternalException`, `DependencyTimeoutException`, gRPC `UNAVAILABLE`/`DEADLINE_EXCEEDED`/`RESOURCE_EXHAUSTED` → `SigningUnavailable`; access denied, not found, disabled or pending-deletion keys, invalid key usage or state, gRPC `PERMISSION_DENIED`/`NOT_FOUND`/`FAILED_PRECONDITION`/`INVALID_ARGUMENT` → `SigningRejected`; anything unrecognised → `SigningUnavailable`. Messages carry the error name or gRPC code only, never key material or full ARNs.
4. **`KmsSigner implements SigningAdapter`**, `new KmsSigner({ provider, credentials })`:
   - Credential (all required): `{ credentialId, tenantId, displayName, keyReference, publicKeySha256 }`, where `credentialId` starts with `aws-kms:` or `gcp-kms:` matching the provider, and `publicKeySha256` = `sha256:` + hex of the expected DER SPKI (**pinned** at configuration: a KMS that returns a different key is refused). IDs unique; parse from a JSON string helper `kmsCredentialsFromJson(text)` that rejects unknown or missing fields (as `_credentials_from_config` does).
   - `capabilities()`: `{ adapterName: 'kms-aws' | 'kms-gcp', algorithms: ['ES256'], maxPayloadBytes: 1_048_576, supportsCredentialListing: true }`.
   - `sign(payload, credentialId, { requestId, tenantId })`: unknown credential, other tenant, non-Buffer, empty or oversize payload → `SigningRejected` (same order and wording style as `LocalDevSigner`); fetch the public key, refuse unless its SHA-256 equals the pin and it is P-256; `digest = sha256(payload)`; `signDigest`; **verify the signature locally** against the pinned key over `payload` before returning (`crypto.verify('sha256', payload, { key, dsaEncoding: 'der' }, sig)`); a signature that does not verify → `SigningRejected`. Return `{ signature, algorithm: 'ES256', credentialId, publicKeySpkiDer }`.
   - `publicKey(credentialId)`: the provider's key, checked against the pin. `listCredentials(tenantId)`: only that tenant's credentials. `health()`: provider healthy and every credential's key matches its pin.
   - Cache public keys per credential for at most 5 minutes (bounded map, one entry per credential).
5. **Tests** (`signer-kms.test.ts`, in-process; fake clients that implement just the SDK calls used, backed by real P-256 keys from `node:crypto`):
   - AWS and GCP happy path: `signVerified(new KmsSigner(...), payload, { credentialId, tenantId, requestId })` succeeds and the signature verifies with the pinned key.
   - Pin mismatch (the KMS returns another key) → `SigningRejected`; wrong key spec / algorithm → `SigningRejected`; KMS returns a signature by another key → `SigningRejected`; non-DER garbage → `SigningRejected`.
   - GCP CRC32C: `verifiedDigestCrc32c: false`, a wrong `signatureCrc32c`, a wrong response `name`, a wrong `pemCrc32c` → each refused; CRC32C known answer.
   - Error mapping table: one test per row above for each provider.
   - Tenant: signing tenant B's credential for tenant A → `SigningRejected`; `listCredentials` scoped.
   - Credentials JSON: unknown field, missing field, duplicate ID, prefix not matching the provider → refused.
   - `JSON.stringify` of results and errors contains no `PRIVATE KEY` and no full key reference.
   - Cache: a second `sign` within 5 minutes fetches the key once; after 5 minutes (injected clock) fetches again.
6. **Register tests:** none needed (the `src/features/attesta/*.test.ts` glob runs the new file).
7. **Built-dist check:** both SDKs load in the CommonJS build: run `npx tsc -p apps/api/tsconfig.json` and `node -e "require('./apps/api/dist/features/attesta/signer-kms.js')"` once; record it in the handoff.

### 2.2 Port from
SushiCorp A1b `adapters/signing/{kms,kms_aws,kms_google,protocols}.py` and `tests/unit/signing/test_signing_kms.py` @ `0bd67a5` (catalog SG-1). Deviations to record: no certificate chain (a pinned SPKI hash instead, as in Task15b); async; tenant on the credential and checked at `sign`; GCP CRC32C integrity checks; P-256 only. Header comment `Ported from SushiCorp A1b … @ 0bd67a5 (catalog SG-1)` plus the deviations.

### 2.3 Pre-approved files
The four files in decision 1, `apps/api/package.json` and `package-lock.json` (the two dependencies only), `docs/handoffs/Task15g-attesta-kms_HANDOFF.md`, `docs/plan/STATUS_BOARD.md` (Task15 row), `docs/plan/TASK15.md` (A15.6 status only).

### 2.4 Never touch
`signer-contract.ts` (frozen), `signer-local-dev.ts`, every other Attesta file (Task15f and 15h are changing several), `docs/contracts/`, migrations, `core/`, `apps/web/`. No real cloud calls, no credentials or key material in fixtures, logs or docs (AGENTS.md rule 4). If something seems to need another file, stop and describe it.

## 3. Working rules
- Commits `Task15g-attesta-kms: …`, explicit `git add <path>`: dependencies; interface and `KmsSigner` with tests; AWS provider; GCP provider.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check` clean. Integration tests: none here (A15.13 is founder-live).
- For every check, ask "what could a misconfigured or hostile KMS answer that this would accept?" and add a test that proves it is refused.
- Re-read your full diff as a reviewer before the handoff.

## 4. Close-out
- Handoff from `docs/templates/HANDOFF_TEMPLATE.md`, under 70 lines: "Ported from", deviations, the error-mapping table, the built-dist check, test counts, and a **FOUNDER:** note for A15.13 (what an AWS and a GCP key need: P-256 sign/verify key, IAM permissions `kms:Sign`/`kms:GetPublicKey` or `cloudkms.cryptoKeyVersions.useToSign`/`viewPublicKey`), Effort.
- Status board row; `TASK15.md` A15.6 🟡. Clean tree; do not push.
- Final reply in the AGENTS.md §12.4 shape, with the review request in a `text` block naming branch and commit; PR command via `git show <branch>:<handoff> | gh pr create … --body-file -`.

## Lessons so far
- **Task15b (Muse):** check every claim a signer returns (key type, algorithm, credential, tenant); malformed output is terminal.
- **Task15a (Muse):** ESM-only or heavy packages must load in the CommonJS build; check `dist` once.
- **Task15e (Muse):** a test that mirrors the code can pass while both are wrong; use known answers (CRC32C, real keys) as the oracle.
