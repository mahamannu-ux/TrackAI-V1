# Task20a-security-v2-contract Handoff — frozen security v2 contract

> Status: ✅ done; Task20 lead cross-review remains before push.

Branch `task/Task20a-security-v2-contract` (base: `main` at `5d9a716`).

Freezes the TrackAI/Numbat security v2 wire contract, examples and TypeScript interfaces. It deliberately adds no route, storage, migration, signing or Endpoint implementation.

## At a glance
| | Item | Status |
|---|---|---|
| Acceptance | seven upload kinds, settings, bundle, lease, fleet v3, acknowledgements, routes and safe errors | ✅ |
| Scope | `docs/contracts/security-v2/**`, frozen TS interfaces/stubs and test entry | ✅ |
| Quality | 41 focused contract tests; 1,061 repository tests; full check, lint and typecheck | ✅ |
| Integration | none: this Task has no database, network or executable Numbat boundary | ✅ not needed |
| Review | independent review fixed five contract issues and two provenance issues | ✅ `ready to push` |

## Implemented interfaces
```text
POST /worker/security/v2/records
GET  /worker/security/v2/lease
GET  /worker/security/v2/bundles/{sha256}
POST /worker/security/v2/acknowledgements
validateSecurityUploadV2(value): SecurityUploadV2       // Task20d stub
checkDataSettings(record, settings): void               // Task20d stub
```

Schemas: `security-upload/2`, `security-data-settings/1`, `security-rule-bundle/1`, `security-activation-lease/2`, `fleet-configuration/3`, and `security-acknowledgement/1`. Upload limit: 500 records and 4 MiB; rule file limit: 256 KiB decoded; accepted Numbat schema: exactly 0.5.0.

## Founder-approved decisions
1. Record ID preimage is `"trackai.security-record/2" NUL kind NUL source-key...`; lowercase SHA-256. Server idempotency scope is `(tenant, machine, record_id)`.
2. Indicators update only by component-wise maxima of count and `last_seen`; identical/older is duplicate. Other kinds are write-once and conflict on changed content.
3. An unavailable permission join needs neither tool-call nor session ID; inventory uses explicit four-state fields and nullable version.
4. Bundle epoch is monotonic per tenant. Lease bundle digest must match the applied bundle. Both checks fail closed.
5. A refused acknowledgement uses the frozen refusal-code enum; future codes are additive only.

## Deviations from spec
1. Numbat testdata NDJSON contains the real `cat .env` artifact action but cannot contain hook-only enforcement. The paired finding/enforcement fixtures are deterministic privacy-reduced reconstructions of pinned `TestHookWritesFindingToFileSinkNotStdout`; exact source IDs and joins are reproduced and tested. `NOTICE.md` states this boundary.

## Known limitations
| Status | Limitation | Impact |
|---|---|---|
| 🟡 | Validation and settings checks are fail-closed stubs. | Task20d implements them with ingest, storage and routes. |
| 🟡 | Bundle and lease schemas define signed payloads, not signing or retrieval. | Task20f signs, publishes, retrieves and acknowledges them. |
| 🟡 | Numbat-to-contract projection and upload are not implemented. | Task20e minimizes, IDs, queues and uploads records. |
| 🟡 | Pinned-source assertions skip when the sibling Numbat checkout is absent. | CI still validates all contract schemas and fixtures; Task20b owns the executable pin. |

## Test coverage
Every valid/invalid manifest case is schema-checked; all object schemas are closed and bounded; forbidden fields have named negative cases; every upload kind has positive/negative coverage; record IDs, Numbat source IDs and enforcement joins are independently reproduced; bundle digest and exact base64 byte boundary are checked; both Task20d stubs throw. No dependency is mocked.

## Integration test impact
> No integration test added or needed. There is no database, network, route or binary execution in Task20a; future `IT-T20d-01`, `IT-T20f-01/02` and `IT-M20-02` exercise implementations of this contract.

| ID | What it proves | Gating | Status |
|---|---|---|---|
| none | Contract-only session | non-blocking | ✅ not applicable |

## Integration notes
Task20d must derive tenant/machine only from credentials, implement write-once versus indicator-upsert semantics, settings refusal, safe per-record results, reads and isolation. Task20e must preserve Numbat IDs before minimization and never queue disabled fields. Task20f must sign exact bytes, enforce tenant epoch and bundle digest, issue 72-hour leases refreshed hourly, expose credential-bound retrieval, persist acknowledgements and widen fleet configuration storage to v3.

## Effort (estimate vs actual)
| Estimate (× T6) | Actual (× T6) | Agent turns | Wall-clock |
|---|---|---|---|
| about 0.12× | about 0.16× | ~45 + review | ~3 h |

Over 1.25× because the fixture requirement combined artifact-stream data with hook-only enforcement and required three provenance review passes. A future prompt should provide a captured hook pair or explicitly authorize deterministic reconstruction from the pinned persistence test.
