# Task15g-attesta-kms Handoff — AWS and Google Cloud KMS signers

> Status: ✅ done · 🟡 partial, or waiting on a founder run · ⬜ not done. **FOUNDER:** marks a founder to-do. (AGENTS.md §11)

Branch `task/Task15g-attesta-kms` (base: `main` at `c5cf7cb`).

Attesta signs with customer-held KMS keys; TrackAI never holds a private key. This session adds one KMS signer over AWS KMS and Google Cloud KMS behind the frozen contract. No database, routes, or network in tests; real-cloud signing stays a founder-live gate (A15.13).

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | KmsSigner + AWS/GCP providers, error mapping, tests per spec | ✅ |
| Scope | 4 new files + 2 pinned deps; pre-approved files only | ✅ |
| Quality | 484 unit tests pass (37 new); typecheck, lint clean; `tsc` + `require(dist)` loads both SDKs | ✅ |
| Integration | None here (A15.13 is founder-live) | ✅ non-blocking |
| Review | Self-review + review round 1 fixes applied | 🟡 re-review pending |

## Implemented interfaces
```
signer-kms.ts: KmsProvider{name,publicKeySpkiDer,signDigest,health},
KmsSigner({provider,credentials,clock?}): SigningAdapter ('kms-aws'/'kms-gcp',
1 MiB max, pinned-key + locally-verified sign, 5-min key cache),
kmsCredentialsFromJson(text), KMS_PUBLIC_KEY_CACHE_MS
signer-kms-aws.ts: AwsKmsProvider(client: KMSClient)
signer-kms-google.ts: GcpKmsProvider(client), crc32c(data)
```

## Ported from
Ported from SushiCorp A1b `adapters/signing/{kms,kms_aws,kms_google,protocols}.py` @ `0bd67a5` (catalog SG-1). Deviations: pinned SPKI hash, no cert chain (Task15b); async; tenant on the credential, checked at sign; GCP CRC32C checks; P-256 only; 5-min key cache.

## Error mapping
| Source | SigningRejected (terminal) | SigningUnavailable (retryable) |
|---|---|---|
| AWS (by error name) | AccessDenied, NotFound, Disabled, KMSInvalidState, InvalidKeyUsage, Validation | throttling, timeouts, network, 5xx, KMSInternal, DependencyTimeout, anything else |
| GCP (by gRPC code) | 3, 5, 7, 9, plus every integrity failure (CRC, name, unverified digest) | 4, 8, 14 and anything else |
Messages carry the name/code only, never ARNs, references or detail text.

## Deviations from spec
`clock?: () => number` option (the 5-min cache test needs it). Review round 1 (lead decision, amends §2.1): absent GCP checksums refused like mismatches; AWS health performs no call (least-privilege policies grant only Sign + GetPublicKey).

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| ⬜ **FOUNDER:** A15.13 live gate: P-256 sign/verify key in AWS (IAM `kms:Sign`, `kms:GetPublicKey`) and GCP (`useToSign`, `viewPublicKey`), then sign + health against each | Real-cloud signing unproven until then; fakes only |
| 🟡 | Cross-agent review pending | Push after "ready to push" |

## Test coverage
37 in-process tests, no network: happy paths via `signVerified` (both providers, incl. numeric GCP enum); pin/spec/algorithm/signature refusals; 6 GCP integrity negatives (wrong + missing CRCs, name, unverified digest); full error-mapping tables; tenant scoping; credential-JSON refusals; no-secret stringify; cache with injected clock; health. Fakes sign raw ECDSA via @noble/curves `p256.sign` (prehash false, DER, as in Task15e) with real P-256 keys; oracles: Node verify, static OpenSSL vector, CRC32C known answer.

## Integration test impact
None: pure crypto, no database or network. A15.13 founder-live covers real clouds.
> No founder run required for this session.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns or prompts | Wall-clock | Tokens or cost, if the tool shows it |
|---|---|---|---|---|
| about 0.1× | about 0.1× | ~45 turns, no review round yet | ~1 h | n/a |
