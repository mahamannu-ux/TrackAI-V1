# Task15op0-signer-payload-cap Handoff — signer cap for 4 MiB rule bundles

> Status: 🟡 built and unit-tested in the lead's cloud workspace; cross-agent review pending. Symbols per AGENTS.md §11.

Branch `task/Task15op0-signer-payload-cap` (base: `main` at `67af037`). Unblocks the Task20f merge (its handoff, Known limitations, first row). Written by the Task20 lead (Claude) at the founder's request, as the first, separately merged piece of the Task15o/15p work.

## At a glance
| | Item | Status |
|---|---|---|
| Cap | `KMS_MAX_PAYLOAD_BYTES` and `LOCAL_DEV_MAX_PAYLOAD_BYTES` raised from 1 MiB to 4 MiB + 1 KiB (a 4 MiB security-v2 rule bundle plus its PAE prefix, which is under 200 bytes) | ✅ |
| Attesta statements | Kept at 1 MiB: new `ATTESTA_STATEMENT_MAX_SIGNED_BYTES` in `ledger.ts`; the builder worker and the period-report job sign at most `min(signer cap, 1 MiB)`, so statement, evidence-pack and offline-verifier sizes do not change | ✅ |
| KMS | The KMS adapter hashes locally (`signer-kms.ts`, `createHash('sha256').update(payload)` before `signDigest`), so the cap is the adapter's own; AWS and Google KMS receive a 32-byte digest | ✅ |
| Tests | the two pinned-value tests updated (`signer.test.ts`, `signer-kms.test.ts`), the oversize case moved to the new cap, one new test for the statement bound; 1116 tests pass, typecheck and lint clean | ✅ |
| Integration | none: no database, route or network change | ✅ n/a |

## Decisions
1. Statements stay at 1 MiB (option "keep Attesta at 1 MiB with its own builder bound" from the Task20f note). Raising statement size is a separate Task15 decision.
2. `signer-contract.ts` (frozen) is unchanged; the bound lives in `ledger.ts` next to `MAX_STATEMENT_BYTES`.

## Integration test impact
> None. Task20f's IT-T20f-01 (founder run) follows this merge.

## Effort
| Estimate (× T6) | Actual (× T6) |
|---|---|
| about 0.01× | about 0.01× (by turns) |
