# Task15op0-signer-payload-cap Handoff — signer cap for 4 MiB rule bundles

> Status: 🟡 built and unit-tested in the lead's cloud workspace; cross-agent review pending. Symbols per AGENTS.md §11.

Branch `task/Task15op0-signer-payload-cap` (base: `main` at `67af037`). Unblocks the Task20f merge (its handoff, Known limitations, first row). Written by the Task20 lead (Claude) at the founder's request, as the first, separately merged piece of the Task15o/15p work.

## At a glance
| | Item | Status |
|---|---|---|
| Cap | `KMS_MAX_PAYLOAD_BYTES` and `LOCAL_DEV_MAX_PAYLOAD_BYTES` raised from 1 MiB to 4 MiB + 1 KiB (a 4 MiB security-v2 rule bundle plus its PAE prefix, which is under 200 bytes) | ✅ |
| Attesta statements | Kept at 1 MiB: new `ATTESTA_STATEMENT_MAX_SIGNED_BYTES` and `statementSigningLimit(cap)` = `min(cap, 1 MiB)` in `ledger.ts`, applied before signing on **all three statement paths**: the builder worker (`worker.ts`), the period-report job (`period-report-service.ts`) and the audit sealer (`audit-seal-service.ts`, refused with `ATTESTA_BUILDER_RULE_VIOLATION` before the signer is called; Codex review round 1) | ✅ |
| Other signatures | Evidence-pack signatures, audit-export signatures, anchor signatures and key-registration signatures are not statements and follow the signer cap. Their payloads were already well under 1 MiB in practice; a larger one that used to fail now signs | 🟡 noted |
| KMS | The KMS adapter hashes locally (`signer-kms.ts`, `createHash('sha256').update(payload)` before `signDigest`), so the cap is the adapter's own; AWS and Google KMS receive a 32-byte digest | ✅ |
| Tests | the two pinned-value tests updated (`signer.test.ts`, `signer-kms.test.ts`), the oversize case moved to the new cap, one test for the statement bound, one proving an oversized seal statement never reaches the signer (`audit-seal.test.ts`); 1117 tests pass, typecheck and lint clean | ✅ |
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
