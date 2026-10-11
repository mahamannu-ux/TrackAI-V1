# Task15b-attesta-signer Handoff — signer contract and local dev signer

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15b-attesta-signer` (base: `main` at `c2e2c22`, the Task15a merge).

Attesta (Task15) signs provenance with tenant-controlled keys and never holds a customer private key in production. This session defines the frozen signer contract every signer implements plus a dev-only signer; KMS adapters come later. No database, routes, or dependencies.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | Contract, `signVerified`, dev signer, error split, tests per spec | ✅ |
| Scope | `signer-contract.ts`, `signer-local-dev.ts`, `signer.test.ts`; package.json untouched (glob already present from Task15a) | ✅ |
| Quality | 286 unit tests pass (15 new); lint, typecheck, check clean | ✅ |
| Integration | None needed (no DB, network, or routes) | ✅ non-blocking |
| Review | Self-review of full diff; one finding fixed (fake-adapter spread) | ✅ cross-agent review pending |

## Implemented interfaces
```
signer-contract.ts (FROZEN once merged): SigningError (never direct),
SigningUnavailable (retryable), SigningRejected (terminal),
SigningAlgorithm='ES256', SigningCredential{tenantId,...}, SigningCapabilities,
SigningResult{signature DER,...}, SigningAdapter{sign/listCredentials/
publicKey/health}, signVerified(adapter,payload,credentialId,requestId)
signer-local-dev.ts: LocalDevSigner({credentials:[{credentialId `dev:*`,
tenantId,displayName?,privateKeyPem}],env?}) — refuses production;
generateDevCredential(id,tenantId) — in-memory P-256, nothing on disk
```

## Ported from
Ported from SushiCorp A1 `adapters/signing/base.py` rev 1.1 + `local_dev.py` @ `0bd67a5` (catalog SG-1). Deviations: no X.509 chain (raw SPKI key instead), async methods, ES256-only DER signatures, tenant on the credential, credentials passed in at construction (nothing on disk), production guard on NODE_ENV.

## Founder-approved decisions
1. Spec decisions built exactly as written; no redesign.
2. Two small extras: duplicate credential ids and non-`dev:` ids in `generateDevCredential` are `SigningRejected`, consistent with the `dev:` rule.

## Deviations from spec
None, except the `package.json` test-script edit was a no-op (Task15a already added the identical glob).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | KMS adapters (AWS/GCP) are a later session (A15.6); only local-dev exists | A15.8 builder uses the contract, not this signer, in production |

## Test coverage
15 node:test cases in-process, no mocks except fake adapters for `signVerified` negative paths: verify/tamper, `signVerified` pass + 3 rejections + plain-Error wrap, 4 payload rejections, construction refusals (prefix, P-256, garbage), production refusal, tenant scoping, no-private-material JSON check, capabilities.

## Integration test impact
None needed: pure crypto, no database or network.
> No founder run required for this session.

## Integration notes
Consumers (A15.6 KMS, A15.8 builder): implement `SigningAdapter`, call `signVerified` before use. Contract file is frozen — do not edit.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.05× | about 0.05× | ~15 turns + review | ~30 min | n/a |
